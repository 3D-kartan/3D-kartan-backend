// src/app/session.middleware.js
//
// Express middleware that enforces session authentication on admin routes.
// Reads the 'sid' cookie, validates it against the in-memory session store,
// and either populates req.user or responds with a 401 error.
import { getSession } from "./sessionStore.js";

// Protects a route by requiring a valid, non-expired session cookie.
// On success, attaches req.user = { username } and calls next().
// On failure, responds 401 and clears any stale 'sid' cookie.
export function requireSession(req, res, next) {
  const sid = req.cookies?.sid;

  if (!sid) {
    return res.status(401).json({
      error: {
        code: "UNAUTHORIZED",
        message: "Authentication required"
      }
    });
  }

  const session = getSession(sid);

  if (!session) {
    // Session not found or has exceeded the idle timeout.
    res.clearCookie("sid");
    return res.status(401).json({
      error: {
        code: "SESSION_EXPIRED",
        message: "Session expired"
      }
    });
  }

  // Attach the authenticated user's identity for downstream handlers.
  req.user = { username: session.username };

  return next();
}