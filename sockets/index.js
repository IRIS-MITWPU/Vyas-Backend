// sockets/index.js
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import IORedis from "ioredis";
import { v4 as uuidv4 } from "uuid";
import jwt from "jsonwebtoken";
import cookie from "cookie";
import pool from "../database/db.js";

// Non-breaking minimum pending an owner decision on whether room calendars
// are intentionally institution-wide visible (see FINDINGS.md, sec-3):
// validate the id is well-formed and exists before joining, and cap distinct
// joins per socket to blunt a "join every room id in sequence" harvesting
// pattern. Not a department-scoped restriction — `rooms`/`buildings` have no
// department relation (only a free-text `profiles.department` column).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_JOINS_PER_SOCKET = 20;

// // Redis key helpers (commented out - see Phase 4)
// const ROOM_LOCK_KEY = (roomId) => `room:${roomId}:lock`;
// const SOCKET_LOCK_SET = (socketId) => `socket:${socketId}:locks`;

// /**
//  * Acquire a room lock.
//  * - Uses SET NX PX
//  * - Tracks ownership per socket
//  * NOTE: Deprecated - PostgreSQL exclusion constraints now handle concurrency (Phase 2)
//  */
// async function acquireLock(redis, roomId, socket, ttlMs = 120000) {
//   const token = uuidv4();
//
//   const lockValue = JSON.stringify({
//     token,
//     ownerUserId: socket.user.id,
//     ownerSocketId: socket.id,
//     createdAt: Date.now(),
//     ttl: ttlMs,
//   });

//   const result = await redis.set(
//     ROOM_LOCK_KEY(roomId),
//     lockValue,
//     { NX: true, PX: ttlMs }
//   );

//   if (result === "OK") {
//     // Track ownership
//     await redis.sAdd(SOCKET_LOCK_SET(socket.id), roomId);

//     return {
//       ok: true,
//       token,
//       expiresAt: Date.now() + ttlMs,
//     };
//   }

//   const existing = await redis.get(ROOM_LOCK_KEY(roomId));
//   return {
//     ok: false,
//     reason: "already_locked",
//     existing: existing ? JSON.parse(existing) : null,
//   };
// }

// /**
//  * Release a room lock safely
//  * NOTE: Deprecated - PostgreSQL exclusion constraints now handle concurrency (Phase 2)
//  */
// async function releaseLock(redis, roomId, socket, token) {
//   const raw = await redis.get(ROOM_LOCK_KEY(roomId));
//   if (!raw) return false;

//   let parsed;
//   try {
//     parsed = JSON.parse(raw);
//   } catch {
//     await redis.del(ROOM_LOCK_KEY(roomId));
//     await redis.sRem(SOCKET_LOCK_SET(socket.id), roomId);
//     return true;
//   }

//   // Ownership verification
//   if (
//     parsed.token !== token ||
//     parsed.ownerSocketId !== socket.id ||
//     parsed.ownerUserId !== socket.user.id
//   ) {
//     return false;
//   }

//   await redis.del(ROOM_LOCK_KEY(roomId));
//   await redis.sRem(SOCKET_LOCK_SET(socket.id), roomId);
//   return true;
// }

export default async function initSockets(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: process.env.FRONTEND_ORIGIN || "http://localhost:5173",
      credentials: true,
    },
  });

  // Redis adapter so booking broadcasts reach sockets connected to any
  // instance, not just the one that handled the write. Falls back to
  // Socket.IO's default in-memory adapter (single-instance only) if
  // REDIS_URL isn't set, rather than crashing local dev.
  if (process.env.REDIS_URL) {
    const pubClient = new IORedis(process.env.REDIS_URL);
    const subClient = pubClient.duplicate();
    pubClient.on("error", (err) => console.error("Socket.IO Redis pub client error:", err));
    subClient.on("error", (err) => console.error("Socket.IO Redis sub client error:", err));
    io.adapter(createAdapter(pubClient, subClient));
    console.log("✅ Socket.IO using Redis adapter (horizontal scaling enabled)");
  } else {
    console.warn("⚠️  REDIS_URL not set — Socket.IO using in-memory adapter (single-instance only)");
  }

  // Socket auth middleware — reads the httpOnly "token" cookie set by
  // userController.js, the same way `protect` does for REST requests.
  io.use((socket, next) => {
    try {
      const cookies = cookie.parse(socket.handshake.headers?.cookie || "");
      const token = cookies.token;

      if (!token) return next(new Error("Auth token missing"));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = { id: decoded.id };
      next();
    } catch {
      next(new Error("Authentication failed"));
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.user.id;
    console.log(`🔌 Socket connected: ${socket.id} user=${userId}`);

    // Reserved synchronously (before the DB await) so concurrent join
    // events — e.g. a burst of join:room calls fired in the same tick —
    // can't all race past the cap check before any socket.join() resolves.
    const reservedChannels = new Set();

    socket.on("join:building", async (name) => {
      if (typeof name !== "string" || !name.trim()) {
        console.warn(`[socket] join:building rejected (malformed payload) user=${userId} socket=${socket.id}`);
        return;
      }
      const channel = `building:${name}`;
      if (!reservedChannels.has(channel) && reservedChannels.size >= MAX_JOINS_PER_SOCKET) {
        console.warn(`[socket] join:building rejected (join cap reached) user=${userId} socket=${socket.id}`);
        return;
      }
      reservedChannels.add(channel);
      try {
        const result = await pool.query("SELECT 1 FROM buildings WHERE name = $1", [name]);
        if (!result.rows.length) {
          reservedChannels.delete(channel);
          console.warn(`[socket] join:building rejected (unknown building "${name}") user=${userId} socket=${socket.id}`);
          return;
        }
        socket.join(channel);
      } catch (err) {
        reservedChannels.delete(channel);
        console.error("join:building error", err);
      }
    });

    socket.on("join:room", async (roomId) => {
      if (typeof roomId !== "string" || !UUID_RE.test(roomId)) {
        console.warn(`[socket] join:room rejected (malformed payload) user=${userId} socket=${socket.id}`);
        return;
      }
      const channel = `room:${roomId}`;
      if (!reservedChannels.has(channel) && reservedChannels.size >= MAX_JOINS_PER_SOCKET) {
        console.warn(`[socket] join:room rejected (join cap reached) user=${userId} socket=${socket.id}`);
        return;
      }
      reservedChannels.add(channel);
      try {
        const result = await pool.query("SELECT 1 FROM rooms WHERE id = $1", [roomId]);
        if (!result.rows.length) {
          reservedChannels.delete(channel);
          console.warn(`[socket] join:room rejected (unknown room ${roomId}) user=${userId} socket=${socket.id}`);
          return;
        }
        socket.join(channel);
      } catch (err) {
        reservedChannels.delete(channel);
        console.error("join:room error", err);
      }
    });

    // // ==========================
    // // LOCK REQUEST
    // // ==========================
    // // NOTE: Deprecated - PostgreSQL exclusion constraints handle concurrency (Phase 2)
    // socket.on("lock:request", async ({ roomId, ttlMs = 120000 }, cb) => {
    //   try {
    //     const result = await acquireLock(redis, roomId, socket, ttlMs);

    //     if (result.ok) {
    //       io.to(`room:${roomId}`).emit("room:locked", {
    //         roomId,
    //         byUserId: userId,
    //         expiresAt: result.expiresAt,
    //       });
    //     }

    //     cb?.(result);
    //   } catch (err) {
    //     console.error("lock:request error", err);
    //     cb?.({ ok: false, reason: "server_error" });
    //   }
    // });

    // // ==========================
    // // LOCK RELEASE
    // // ==========================
    // // NOTE: Deprecated - PostgreSQL exclusion constraints handle concurrency (Phase 2)
    // socket.on("lock:release", async ({ roomId, token }, cb) => {
    //   try {
    //     const success = await releaseLock(redis, roomId, socket, token);

    //     if (success) {
    //       io.to(`room:${roomId}`).emit("room:unlocked", { roomId });
    //     }

    //     cb?.({ success });
    //   } catch (err) {
    //     console.error("lock:release error", err);
    //     cb?.({ success: false });
    //   }
    // });

    // // ==========================
    // // DISCONNECT CLEANUP (NO SCAN)
    // // ==========================
    // // NOTE: Deprecated - Redis locking removed (Phase 2)
    // socket.on("disconnect", async () => {
    //   console.log(`❌ Socket disconnected: ${socket.id}`);

    //   try {
    //     const rooms = await redis.sMembers(SOCKET_LOCK_SET(socket.id));

    //     for (const roomId of rooms) {
    //       const raw = await redis.get(ROOM_LOCK_KEY(roomId));
    //       if (!raw) continue;

    //       const parsed = JSON.parse(raw);
    //       if (parsed.ownerSocketId === socket.id) {
    //         await redis.del(ROOM_LOCK_KEY(roomId));
    //         io.to(`room:${roomId}`).emit("room:unlocked", { roomId });
    //       }
    //     }

    //     await redis.del(SOCKET_LOCK_SET(socket.id));
    //   } catch (err) {
    //     console.error("disconnect cleanup error", err);
    //   }
    // });

    socket.on("disconnect", () => {
      console.log(`❌ Socket disconnected: ${socket.id}`);
    });
  });

  return { io };
}
