import "dotenv/config";
import path from "node:path";
import express from "express";
import { rateLimit } from "express-rate-limit";
import morgan from "morgan";
import cors from "cors";
import helmet from "helmet";
import config from "./src/app/config.js";
import { AppError, isAppError, NotFoundError, ValidationError } from "./src/app/errors.js";
import storage from "./src/storage/index.js";
import createPublicFormsRouter from "./src/routes/forms.public.routes.js";
import createAdminFormsRouter from "./src/routes/forms.admin.routes.js";
import cookieParser from "cookie-parser";
import { loginHandler, logoutHandler, meHandler } from "./src/app/auth.controller.js";
import { requireSession } from "./src/app/session.middleware.js";
import { getPool } from "./src/db/pool.js";

function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.set("query parser", "simple");

  // Helmet sets secure HTTP response headers including Content-Security-Policy,
  // X-Content-Type-Options, X-Frame-Options, Referrer-Policy, and more.
  // HSTS is handled separately below so it can be restricted to prod+HTTPS.
  app.use(
    helmet({
      hsts: false,
      hidePoweredBy: false, // already disabled via app.disable()
      referrerPolicy: { policy: "no-referrer" },
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc:  ["'self'", "'unsafe-eval'"], // 'unsafe-eval' required by Form.io template engine (lodash new Function); inline scripts still blocked
          styleSrc:   ["'self'", "'unsafe-inline'"], // Form.io injects inline styles
          imgSrc:     ["'self'", "data:", "blob:"],
          connectSrc: ["'self'"],
          fontSrc:    ["'self'", "data:"],
          objectSrc:  ["'none'"],
          frameAncestors: ["'none'"],
          baseUri:    ["'self'"],
        }
      }
    })
  );

  // Permissions-Policy and conditional HSTS (prod + HTTPS only).
  app.use((req, res, next) => {
    res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");

    const forwardedProto = req.headers["x-forwarded-proto"];
    const isHttps =
      req.secure ||
      forwardedProto === "https" ||
      (Array.isArray(forwardedProto) && forwardedProto.includes("https"));

    if (config.nodeEnv === "production" && isHttps) {
      res.setHeader(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains"
      );
    }

    next();
  });
    // CORS – only allow the configured frontend origin
  if (config.corsOrigin) {
    app.use(
      cors({
        origin: config.corsOrigin,
        methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type"],
        credentials: false
      })
    );
  }
  
  // Request logging
  app.use(morgan(config.nodeEnv === "production" ? "combined" : "dev"));

  app.use(
    express.json({
      limit: "256kb",
      strict: true,
      type: ["application/json", "application/*+json"]
    })
  );
  // Cookie parser – for session cookies
  app.use(cookieParser());

  // Rate limiting – applied globally; tighten per-route where needed
  const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: "draft-7",
    legacyHeaders: false
  });

  const publicSubmissionLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 60,
    standardHeaders: "draft-7",
    legacyHeaders: false
  });

  // Strict brute-force protection on login
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skipSuccessfulRequests: true
  });

  app.use(globalLimiter);

  // Stricter limit on public form submissions
  app.use("/3d-kartan/backend/public/forms/:formId/submissions", publicSubmissionLimiter);

  // Auth endpoints
  app.post("/3d-kartan/backend/auth/login", loginLimiter, loginHandler);
  app.post("/3d-kartan/backend/auth/logout", logoutHandler);
  app.get("/3d-kartan/backend/auth/me", meHandler);

  // --- Address search against db ---
  let pool = null;
  if (config.storageDriver === "pg") {
    // If initStorage succeeded in startServer(), the database + schema + PostGIS exist
    pool = getPool();

    app.get("/3d-kartan/backend/addresses", async (req, res, next) => {
      const { q } = req.query;

      if (typeof q !== "string") {
        return res
          .status(400)
          .json({ error: "Sökparametern måste vara en sträng." });
      }

      const term = q.trim();
      if (term.length < 1 || term.length > 100) {
        return res
          .status(400)
          .json({ error: "Söksträngen måste vara 1–100 tecken lång." });
      }
      // table setup
      try {
        const result = await pool.query(
          `
          SELECT
            td_adress,
            td_kommund,
            ST_AsGeoJSON(geom) AS geometry
          FROM addresses.addresses_p
          WHERE td_adress ILIKE $1
             OR td_kommund ILIKE $1
          LIMIT 50;
          `,
          [`%${term}%`]
        );

        const geojson = {
          type: "FeatureCollection",
          features: result.rows.map((row) => ({
            type: "Feature",
            geometry: JSON.parse(row.geometry),
            properties: {
              td_adress: row.td_adress,
              td_kommund: row.td_kommund
            }
          }))
        };

        res.json(geojson);
      } catch (err) {
        next(err);
      }
    });
  }


  // Serve admin UI static files
  app.use(
    "/admin",
    express.static(path.join(process.cwd(), "public-admin"), {
      index: "forms.html",
      dotfiles: "deny"
    })
  );

  app.get("/healthz", async (req, res, next) => {
    try {
      await storage.initStorage();
      res.status(200).json({
        ok: true,
        time: new Date().toISOString()
      });
    } catch (error) {
      next(error);
    }
  });

  //CONSOLE LOGGING
  if (config.nodeEnv !== "production") {
    app.use((req, res, next) => {
      console.log("INCOMING", req.method, req.url);
      next();
    });
  }

  app.use("/3d-kartan/backend/public", createPublicFormsRouter());
  app.use("/3d-kartan/backend/admin", requireSession, createAdminFormsRouter());

  app.use((req, res, next) => {
    next(new NotFoundError("Route not found"));
  });

  app.use((error, req, res, next) => {
    if (config.nodeEnv !== "production") {
      console.error("ERROR handler:", {
        name: error.name,
        code: error.code,
        message: error.message,
        stack: error.stack
      });
    }
    if (res.headersSent) {
      return next(error);
    }

    if (
      error instanceof SyntaxError &&
      error.status === 400 &&
      Object.prototype.hasOwnProperty.call(error, "body")
    ) {
      error = new ValidationError("Malformed JSON body");
    }

    const appError = isAppError(error)
      ? error
      : new AppError("Internal server error", {
          statusCode: 500,
          code: "INTERNAL_SERVER_ERROR",
          expose: false
        });

    if (appError.statusCode >= 500) {
      console.error("[request-error]", {
        method: req.method,
        path: req.originalUrl,
        code: appError.code,
        message: error?.message ?? appError.message
      });
    }

    const body = {
      error: {
        code: appError.code,
        message: appError.expose ? appError.message : "Internal server error"
      }
    };

    if (appError.expose && appError.details !== null && appError.details !== undefined) {
      body.error.details = appError.details;
    }

    res.status(appError.statusCode).json(body);
  });

  return app;
}

async function startServer() {
  await storage.initStorage();

  const app = createApp();

  const server = app.listen(config.port, () => {
    console.log(
      `[server] listening on port ${config.port} (${config.nodeEnv}, storage=${config.storageDriver})`
    );
  });

  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`[server] received ${signal}, shutting down`);

    const forceCloseTimer = setTimeout(() => {
      console.error("[server] forced shutdown after timeout");
      process.exit(1);
    }, 10000);

    forceCloseTimer.unref?.();

    try {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });

      await storage.closeStorage();

      clearTimeout(forceCloseTimer);
      console.log("[server] shutdown complete");
      process.exit(0);
    } catch (error) {
      clearTimeout(forceCloseTimer);
      console.error("[server] shutdown error", error);
      process.exit(1);
    }
  }

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  process.on("unhandledRejection", (reason) => {
    console.error("[process] unhandledRejection", reason);
  });

  process.on("uncaughtException", (error) => {
    console.error("[process] uncaughtException", error);
    void shutdown("uncaughtException");
  });
}

startServer().catch((error) => {
  console.error("[startup-error]", error);
  process.exit(1);
});