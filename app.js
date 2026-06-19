// Vyas-Backend\app.js
import express from "express";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import cors from "cors";
import morgan from "morgan";
import http from "http";

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
const { default: buildingRoutes }  = await import("./routes/buildings.js");
const { default: userRoutes }      = await import("./routes/users.js");
const { default: bookingRoutes }   = await import("./routes/booking.js");
const { default: timetableRoutes } = await import("./routes/timetable.js");
const { default: initSockets }     = await import("./sockets/index.js");
const { default: pool }            = await import("./database/db.js");

// Email queue + Bull Board dashboard
const { emailQueue }         = await import("./services/emailQueue.js");
const { startEmailWorker }   = await import("./workers/emailWorker.js");
const { createBullBoard }    = await import("@bull-board/api");
const { BullMQAdapter }      = await import("@bull-board/api/bullMQAdapter");
const { ExpressAdapter }     = await import("@bull-board/express");
const { protect, adminOnly } = await import("./middlewares/authMiddleware.js");

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// Core middleware
// ============================================================
app.use(morgan("combined"));
app.use(express.json());
app.use(cookieParser());
const allowedOrigins = [
  process.env.FRONTEND_ORIGIN,
  "http://localhost:5173",
  "http://localhost:8080",
].filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      // Allow requests with no origin (e.g. curl, Postman)
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
  })
);

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
app.use("/booking", bookingRoutes);
app.use("/", timetableRoutes);        // /room/:id/timetable + /timetable/:id

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
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

// ============================================================
// HTTP server + Socket.IO
// ============================================================
const httpServer = http.createServer(app);
const { io } = await initSockets(httpServer);
app.set("io", io);

httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  startEmailWorker();
});
