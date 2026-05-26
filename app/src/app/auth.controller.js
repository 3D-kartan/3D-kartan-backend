// src/app/auth.controller.js
//
// Request handlers for the admin authentication endpoints:
//   POST /api/auth/login   – validate credentials and issue a session cookie
//   POST /api/auth/logout  – destroy the session and clear the cookie
//   GET  /api/auth/me      – return the currently authenticated user
import bcrypt from "bcrypt";
import config from "./config.js";
import { ValidationError, AppError } from "./errors.js";
import { createSession, destroySession, getSession } from "./sessionStore.js";

// Resolved once at module load; avoids repeated config lookups per request.
const USER = config.adminBasicAuthUser;
const PASS_HASH = config.adminBasicAuthPassHash;

// POST /api/auth/login
// Validates the submitted username and bcrypt-hashed password against the
// values configured via environment variables. On success, creates a session
// and sets an HttpOnly 'sid' cookie. Responds 401 for any credential mismatch
// using a deliberately generic message to avoid username enumeration.
export async function loginHandler(req, res, next) {
  try {
    const { username, password } = req.body ?? {};

    if (!username || !password) {
      throw new ValidationError("username and password are required");
    }

    const usernameOk = username === USER;
    const passwordOk = await bcrypt.compare(password, PASS_HASH);

    if (!usernameOk || !passwordOk) {
      // Intentionally generic message to prevent username enumeration.
      throw new AppError("Invalid credentials", {
        statusCode: 401,
        code: "INVALID_CREDENTIALS",
        expose: true
      });
    }

    const session = createSession(username);

    // Set an HttpOnly session cookie. No maxAge means it is a session cookie
    // and will be cleared when the browser is closed.
    res.cookie("sid", session.id, {
      httpOnly: true,
      secure: config.nodeEnv === "production",
      sameSite: "strict"
    });

    res.status(200).json({ ok: true });
  } catch (error) {
    next(error);
  }
}

// POST /api/auth/logout
// Destroys the server-side session (if one exists) and clears the 'sid' cookie.
// Always responds 200 regardless of whether a valid session was present.
export async function logoutHandler(req, res, next) {
  try {
    const sid = req.cookies?.sid;

    if (sid) {
      destroySession(sid);
    }

    res.clearCookie("sid");
    res.status(200).json({ ok: true });
  } catch (error) {
    next(error);
  }
}

// GET /api/auth/me
// Returns the username of the currently authenticated user.
// Used by admin UI pages to verify session validity and display the logged-in user.
// Responds 401 if no cookie is present or the session has expired.
export async function meHandler(req, res, next) {
  try {
    const sid = req.cookies?.sid;
    if (!sid) {
      return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not logged in" } });
    }

    const session = getSession(sid);
    if (!session) {
      res.clearCookie("sid");
      return res.status(401).json({ error: { code: "SESSION_EXPIRED", message: "Session expired" } });
    }

    res.status(200).json({
      user: {
        username: session.username
      }
    });
  } catch (error) {
    next(error);
  }
}