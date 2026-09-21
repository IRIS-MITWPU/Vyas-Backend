// Vyas-Backend\app.js
import express from "express";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import cors from "cors";
import morgan from "morgan";
import helmet from "helmet";
import http from "http";
import passport from "passport";
import { sendError } from "./utils/errorResponse.js";

dotenv.config();

// ============================================================
// Startup env validation — fail fast with a clear message.
// Uses dynamic imports below so this check runs before any
// module that needs these vars (redis, pg) is loaded.
// ============================================================
const REQUIRED_ENV = [
  "JWT_SECRET",
  "DB_USER",
  "DB_PASSWORD",
  "DB_HOST",
  "DB_NAME",
  "REDIS_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_CALLBACK_URL",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
  "S3_BUCKET",
  "AWS_REGION",
  "GEMINI_API_KEY",
];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error("❌ Missing required environment variables:", missing.join(", "));
  process.exit(1);
}
if (process.env.JWT_SECRET.length < 32) {
  console.error("❌ JWT_SECRET must be at least 32 characters");
  process.exit(1);
}

// Dynamic imports run after dotenv + validation, so env vars are guaranteed present.
const { default: buildingRoutes }        = await import("./routes/buildings.js");
const { default: userRoutes }            = await import("./routes/users.js");
const { default: oauthRoutes }           = await import("./routes/oauth.js");
const { default: bookingRoutes }         = await import("./routes/booking.js");
const { default: timetableRoutes }       = await import("./routes/timetable.js");
const { default: timetableImportRoutes } = await import("./routes/timetable-import.js");
const { default: initSockets }           = await import("./sockets/index.js");
const { default: pool }                  = await import("./database/db.js");

// Email queue + Bull Board dashboard
const { emailQueue }              = await import("./services/emailQueue.js");
// Background jobs run in-process by default (dev). In production set
// RUN_WORKERS=false and run `node worker.js` as its own service — the
// PDF/XLSX/OCR libraries are then never even loaded in the API process.
const RUN_WORKERS = process.env.RUN_WORKERS !== "false";
const { createBullBoard }    = await import("@bull-board/api");
const { BullMQAdapter }      = await import("@bull-board/api/bullMQAdapter");
const { ExpressAdapter }     = await import("@bull-board/express");
const { protect, adminOnly } = await import("./middlewares/authMiddleware.js");
const { generalLimiter } = await import("./middlewares/rateLimiter.js");
const { allowedOrigins }  = await import("./config/origins.js");
const { originCheck }     = await import("./middlewares/originCheck.js");

const app = express();
const PORT = process.env.PORT || 3000;

// Trust the hosting platform's reverse proxy (Render/Railway/etc.) for one
// hop, so express-rate-limit and req.ip see the real client IP instead of
// the proxy's.
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

// ============================================================
// Core middleware
// ============================================================
// crossOriginResourcePolicy defaults to "same-origin", which fights the
// CORS setup below — this API is meant to be consumed from FRONTEND_ORIGIN
// (a different origin/port), so it needs "cross-origin" instead.
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(morgan("combined"));
app.use(express.json());
app.use(cookieParser());
app.use(passport.initialize()); // no passport.session() — JWT-cookie sessions only, session:false everywhere
app.use(originCheck); // CSRF: allowed Origin required on cookie-authenticated writes

app.use(
  cors({
    // Unlisted origins get no CORS headers (the browser won't expose the
    // response) rather than an error: same-origin callers such as Bull Board
    // also send an Origin, and writes from a bad origin are already refused
    // with a 403 by originCheck above.
    origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)),
    credentials: true,
  })
);

// Baseline rate limit for all routes — loginLimiter/authLimiter (routes/users.js)
// apply tighter limits on top of this for the auth endpoints specifically.
app.use(generalLimiter);

// ============================================================
// Bull Board — email queue dashboard (admin only)
// ============================================================
const bullBoardAdapter = new ExpressAdapter();
bullBoardAdapter.setBasePath("/admin/queues");
createBullBoard({ queues: [new BullMQAdapter(emailQueue)], serverAdapter: bullBoardAdapter });
app.use("/admin/queues", protect, adminOnly, bullBoardAdapter.getRouter());

// ============================================================
// Health check
// ============================================================
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", timestamp: new Date().toISOString(), db: "connected" });
  } catch {
    res.status(503).json({ status: "error", db: "disconnected" });
  }
});

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Vyas Backend is running" });
});

// ============================================================
// Routes
// ============================================================
app.use("/buildings", buildingRoutes);
app.use("/user", userRoutes);
app.use("/auth", oauthRoutes);
app.use("/booking", bookingRoutes);
app.use("/", timetableRoutes);        // /room/:id/timetable + /timetable/:id
app.use("/timetable-import", timetableImportRoutes);

// ============================================================
// 404 handler
// ============================================================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

// ============================================================
// Global error handler (must be last middleware)
// ============================================================
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  sendError(res, err.status || 500, "Internal server error", err);
});

// ============================================================
// HTTP server + Socket.IO
// ============================================================
const httpServer = http.createServer(app);
const { io } = await initSockets(httpServer);
app.set("io", io);

let emailWorker;
let importWorker;

httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  if (!RUN_WORKERS) return console.log("Background workers disabled (RUN_WORKERS=false) — run worker.js");
  Promise.all([
    import("./workers/emailWorker.js"),
    import("./workers/importPipelineWorker.js"),
    import("./services/otpCleanup.js"),
  ]).then(([email, imp, otp]) => {
    emailWorker = email.startEmailWorker();
    importWorker = imp.startImportPipelineWorker();
    otp.startOtpCleanupSweep();
  }).catch((err) => { console.error("❌ Failed to start background workers:", err); process.exit(1); });
});

// ============================================================
// Graceful shutdown — let in-flight requests/jobs finish instead of
// being hard-killed. Hosting platforms (Render/Railway/Fly) send SIGTERM
// on every redeploy, so this runs on every normal deploy, not just incidents.
// ============================================================
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received — shutting down gracefully...`);

  const forceExit = setTimeout(() => {
    console.error("⚠️ Graceful shutdown timed out — forcing exit");
    process.exit(1);
  }, 10000);
  forceExit.unref();

  // io.close() disconnects all sockets and closes the underlying HTTP
  // server once existing requests/connections finish.
  io.close(async () => {
    console.log("✅ HTTP + Socket.IO server closed");
    try {
      if (emailWorker) await emailWorker.close();
      if (importWorker) await importWorker.close();
      await pool.end();
      console.log("✅ Shutdown complete");
      process.exit(0);
    } catch (err) {
      console.error("❌ Error during shutdown:", err);
      process.exit(1);
    }
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught exception:", err);
  process.exit(1);
});
