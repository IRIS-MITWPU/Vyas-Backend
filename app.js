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
  "REDIS_URL",
  "DB_USER",
  "DB_PASSWORD",
  "DB_HOST",
  "DB_NAME",
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
const { default: buildingRoutes } = await import("./routes/buildings.js");
const { default: userRoutes }     = await import("./routes/users.js");
const { default: bookingRoutes }  = await import("./routes/booking.js");
const { default: initSockets }    = await import("./sockets/index.js");
const { default: pool }           = await import("./database/db.js");

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// Core middleware
// ============================================================
app.use(morgan("combined"));
app.use(express.json());
app.use(cookieParser());
app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN || "http://localhost:5173",
    credentials: true,
  })
);

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
app.use("/building", buildingRoutes);
app.use("/user", userRoutes);
app.use("/booking", bookingRoutes);

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
});
