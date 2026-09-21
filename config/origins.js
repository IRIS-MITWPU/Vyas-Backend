// config/origins.js
// The browser origins allowed to call this API with credentials — shared by
// the Express CORS setup, the Socket.IO CORS option and the CSRF origin check,
// so the three can't drift. The localhost dev origins are only allowed outside
// production: with credentials enabled, allowing them in production would let
// any page served from a user's localhost act as the logged-in user.
export const allowedOrigins = [
  process.env.FRONTEND_ORIGIN || "https://vyas-web-app.vercel.app",
  ...(process.env.NODE_ENV === "production"
    ? []
    : ["http://localhost:5173", "http://localhost:8080"]),
];
