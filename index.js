require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const { connectDB } = require("./lib/db");
const { isDbReady } = require("./lib/requireDb");

// Optional Sentry (set SENTRY_DSN)
if (process.env.SENTRY_DSN) {
  try {
    const Sentry = require("@sentry/node");
    Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 });
  } catch (err) {
    console.warn("Sentry init skipped:", err.message);
  }
}

const app = express();
// Vercel's edge sets X-Forwarded-For to the real client IP (and strips any
// client-supplied value). Without this, req.ip is the proxy address and every
// visitor shares one rate-limit bucket.
app.set("trust proxy", 1);
const log = require("./lib/log");
const { requestIdMiddleware } = require("./lib/requestId");
const { getIceConfig } = require("./lib/ice");
const { regionMiddleware, regionSnapshot } = require("./lib/region");

app.use(requestIdMiddleware);
app.use(regionMiddleware);

const allowedOrigins = [
  "https://meet.quantumlogicslimited.com",
  "https://www.meet.quantumlogicslimited.com",
  "https://quantum-meet-frontend.vercel.app",
  "http://localhost:3000",
  "http://localhost:5001",
  // Extra origins (e.g. a custom domain) can be added without a redeploy.
  ...[process.env.CLIENT_URL, ...(process.env.EXTRA_ALLOWED_ORIGINS || "").split(",")]
    .map((o) => (o || "").trim().replace(/\/+$/, ""))
    .filter(Boolean),
];

// Vercel gives every preview/branch deploy its own subdomain
// (quantum-meet-frontend-<hash>-<team>.vercel.app) — match those too so
// preview deployments aren't blocked by CORS.
const allowedOriginPattern = /^https:\/\/quantum-meet-frontend(-[a-z0-9-]+)?\.vercel\.app$/;

// ── Security headers ──────────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: false,
  }),
);

// Unknown origins get no CORS headers (the browser blocks them) instead of a
// thrown error, which Express would turn into a 500 HTML page.
app.use(
  cors({
    origin: (origin, callback) => {
      callback(
        null,
        !origin ||
          allowedOrigins.includes(origin) ||
          allowedOriginPattern.test(origin),
      );
    },
    credentials: true,
  }),
);

app.use(express.json({ limit: "1mb" }));

// ── DB connection (E-111: fail closed for stateful APIs) ──────────────────────
const DB_REQUIRED_PREFIXES = [
  "/api/rooms",
  "/api/secret",
  "/api/classrooms",
  "/api/auth",
  "/api/growth",
  "/api/cron",
  "/api/partner",
];

const DB_OPTIONAL_EXACT = new Set([
  "/api/growth/features",
  "/api/growth/cost/mau",
]);

app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.warn("⚠️  DB unavailable:", err.message);
    log.error("db_connect_failed", {
      err: err.message,
      requestId: req.requestId,
      path: req.path,
    });
    const needsDb =
      DB_REQUIRED_PREFIXES.some((p) => req.path.startsWith(p)) &&
      !DB_OPTIONAL_EXACT.has(req.path);
    if (needsDb) {
      return res.status(503).json({
        error: "Database unavailable",
        code: "DB_UNAVAILABLE",
        requestId: req.requestId,
      });
    }
    next();
  }
});

// ── Auth routes (public — no JWT required) ────────────────────────────────────
const authRouter = require("./routes/authRoutes");
app.use("/api/auth", authRouter);

// ── Classroom API (JWT protected — see classroom.js) ─────────────────────────
const classroomRouter = require("./classroom");
app.use("/api/classrooms", classroomRouter);

// ── Meeting rooms (login-free) ────────────────────────────────────────────────
const roomRealtimeRouter = require("./roomRealtime");
app.use("/api/rooms", roomRealtimeRouter);

// ── SecretMeet random pairing ─────────────────────────────────────────────────
const secretMeetRouter = require("./secretMeet");
app.use("/api/secret", secretMeetRouter);

// ── Growth APIs (scheduling, orgs, webhooks) ──────────────────────────────────
const growthRouter = require("./growth");
app.use("/api/growth", growthRouter);

// ── LTI 1.3 stub ──────────────────────────────────────────────────────────────
app.use("/api/lti", require("./lti"));

// ── SFU stub ──────────────────────────────────────────────────────────────────
app.use("/api/sfu", require("./sfu"));

// ── Partner API keys ──────────────────────────────────────────────────────────
app.use("/api/partner", require("./partnerApi"));

// ── Call quality metrics (client beacons) ─────────────────────────────────────
app.use("/api/metrics", require("./callQuality"));

// ── Cron (scheduled classroom posts) ──────────────────────────────────────────
const cronRouter = require("./cron");
app.use("/api/cron", cronRouter);

// ICE config for clients (no DB — TURN creds stay server-side)
app.get("/api/ice", (_req, res) => {
  const cfg = getIceConfig();
  res.json({
    iceServers: cfg.iceServers,
    hasTurn: cfg.hasTurn,
  });
});

// Server clock for realtime cursors — event timestamps are server time, so
// clients must not start their `since` cursor from their own (skewed) clock.
app.get("/api/time", (_req, res) => {
  res.json({ serverTime: new Date().toISOString() });
});

// Health check — reports DB state (never fail-closed; used by probes)
app.get("/api/health", async (req, res) => {
  let db = "disconnected";
  try {
    if (!isDbReady()) await connectDB();
    db = isDbReady() ? "connected" : "disconnected";
  } catch {
    db = "disconnected";
  }
  const ice = getIceConfig();
  const region = regionSnapshot();
  res.status(db === "connected" ? 200 : 503).json({
    status: db === "connected" ? "ok" : "degraded",
    db,
    time: new Date(),
    requestId: req.requestId,
    region,
    ice: { hasTurn: ice.hasTurn },
    metrics: require("./lib/metrics").snapshot(),
    features: {
      longPoll: require("./lib/featureFlags").longPollEnabled(),
      media: "mesh",
      deploy: "vercel-serverless",
    },
  });
});

// JSON 404 / error responses — the client parses every API reply as JSON.
app.use("/api", (req, res) => {
  res.status(404).json({ error: "Not found", path: req.path });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  log.error("unhandled_error", {
    err: err.message,
    requestId: req.requestId,
    path: req.path,
  });
  res.status(status).json({
    error: status === 500 ? "Internal server error" : err.message,
    requestId: req.requestId,
  });
});

// ─── Start (local dev only — Vercel imports `app` as the request handler) ────
if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  const listen = () => {
    app.listen(PORT, () => console.log(`🚀 Server on http://localhost:${PORT}`));
  };
  connectDB()
    .then(() => {
      console.log("✅ MongoDB connected");
      listen();
    })
    .catch((err) => {
      if (process.env.CI_ALLOW_NO_DB === "1") {
        console.warn("⚠️  CI_ALLOW_NO_DB: starting without Mongo:", err.message);
        listen();
        return;
      }
      console.error("❌ MongoDB required for meetings — refusing to start:", err.message);
      process.exit(1);
    });
}

module.exports = app;
