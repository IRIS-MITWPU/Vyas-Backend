// middlewares/originCheck.js
// CSRF defense-in-depth for cookie sessions. The API (api.vyas.iris-club.in)
// and the frontend (vyas.iris-club.in) are the *same site*, so SameSite=Lax
// does not stop a request from any other *.iris-club.in page. For
// state-changing methods:
//   - an Origin header must be an allowed origin, or the API's own origin
//     (a cross-site attacker can't be same-origin with the API);
//   - no Origin at all is only allowed when no session cookie is sent — i.e.
//     non-browser clients using a Bearer header, which a page can't attach.
import { allowedOrigins } from "../config/origins.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function originCheck(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.get("origin");
  if (origin) {
    const self = `${req.protocol}://${req.get("host")}`;
    if (origin === self || allowedOrigins.includes(origin)) return next();
    return res.status(403).json({ error: "Origin not allowed" });
  }
  if (req.cookies?.token) {
    return res.status(403).json({ error: "Origin header required" });
  }
  next();
}
