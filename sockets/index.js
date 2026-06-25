// sockets/index.js
import { Server } from "socket.io";
// import { createAdapter } from "@socket.io/redis-adapter"; // TODO: Uncomment when Redis is needed
import { v4 as uuidv4 } from "uuid";
import jwt from "jsonwebtoken";
import cookie from "cookie";

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

  // // Dedicated pub/sub clients for the Socket.IO Redis adapter
  // // NOTE: Disabled - using in-memory adapter only. Uncomment when Redis is needed for horizontal scaling
  // const pubClient = redis.duplicate();
  // const subClient = redis.duplicate();
  // await pubClient.connect();
  // await subClient.connect();

  // io.adapter(createAdapter(pubClient, subClient));

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

    socket.on("join:building", (name) => {
      if (name) socket.join(`building:${name}`);
    });

    socket.on("join:room", (roomId) => {
      if (roomId) socket.join(`room:${roomId}`);
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
