// src/app/sessionStore.js
//
// In-memory session store for admin authentication.
// Sessions are keyed by a 64-character hex token (32 random bytes) and expire
// after SESSION_IDLE_TIMEOUT_MS of inactivity. A background timer periodically
// purges stale entries, and an LRU eviction policy prevents unbounded growth.
import crypto from "node:crypto";

// Active sessions keyed by session ID.
const SESSIONS = new Map();

// A session is invalidated after this many milliseconds of inactivity. 30 min
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

// Max concurrent sessions – prevents unbounded memory growth / DoS
const MAX_SESSIONS = 500;

// Purge expired sessions every 10 minutes
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

// Removes all sessions whose idle time has exceeded SESSION_IDLE_TIMEOUT_MS.
// Called automatically on a fixed interval and before every createSession call.
function purgeExpired() {
  const now = Date.now();
  for (const [id, session] of SESSIONS) {
    if (now - session.lastSeenAt > SESSION_IDLE_TIMEOUT_MS) {
      SESSIONS.delete(id);
    }
  }
}

// Start the background cleanup timer. unref() lets the Node.js event loop
// exit normally even if this interval is still pending.
const _cleanupTimer = setInterval(purgeExpired, CLEANUP_INTERVAL_MS);
// Allow the process to exit cleanly even if this timer is active
_cleanupTimer.unref?.();

// Creates a new session for the given username and returns it.
// Before inserting, expired sessions are purged. If the store is still at
// capacity (MAX_SESSIONS), the least-recently-seen session is evicted (LRU).
// Returns the new session object { id, username, createdAt, lastSeenAt }.
export function createSession(username) {
  // Evict expired sessions first, then enforce the cap
  purgeExpired();

  if (SESSIONS.size >= MAX_SESSIONS) {
    // Evict the oldest session by lastSeenAt
    let oldestId = null;
    let oldestTime = Infinity;
    for (const [id, session] of SESSIONS) {
      if (session.lastSeenAt < oldestTime) {
        oldestTime = session.lastSeenAt;
        oldestId = id;
      }
    }
    if (oldestId) {
      SESSIONS.delete(oldestId);
    }
  }

  const id = crypto.randomBytes(32).toString("hex");
  const now = Date.now();

  const session = {
    id,
    username,
    createdAt: now,
    lastSeenAt: now
  };

  SESSIONS.set(id, session);
  return session;
}

// Looks up a session by ID. Returns null if the session does not exist or has
// exceeded the idle timeout (and removes it in that case).
// On a valid hit, refreshes lastSeenAt to extend the idle window.
export function getSession(id) {
  const session = SESSIONS.get(id);
  if (!session) return null;

  const now = Date.now();
  const idleTime = now - session.lastSeenAt;

  if (idleTime > SESSION_IDLE_TIMEOUT_MS) {
    // Session has been idle too long – remove it and deny access.
    SESSIONS.delete(id);
    return null;
  }

  // Refresh the last-seen timestamp to keep the session alive.
  session.lastSeenAt = now;
  return session;
}

// Immediately removes a session from the store. Used on explicit logout.
// Safe to call with an ID that does not exist.
export function destroySession(id) {
  SESSIONS.delete(id);
}