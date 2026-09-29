const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const { MongoRateLimitStore } = require("./mongoRateLimitStore");

/**
 * Per-participant key: a whole classroom behind one school NAT shares an IP,
 * so meeting limiters bucket by IP + userId instead of IP alone.
 */
function participantKey(req) {
  const ip = ipKeyGenerator(req.ip || "");
  const uid = req.body?.from || req.body?.userId || req.query?.userId || "";
  return uid ? `${ip}|${String(uid).slice(0, 64)}` : ip;
}

/**
 * Shared rate limiters (E-107).
 * Uses Mongo store by default so limits apply across Vercel instances.
 * Set RATE_LIMIT_STORE=memory to force in-memory (local unit tests).
 */
function createLimiter({ windowMs, max, message, perParticipant = false }) {
  const useMemory = process.env.RATE_LIMIT_STORE === "memory";
  const opts = {
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message || "Too many requests" },
  };
  if (perParticipant) opts.keyGenerator = participantKey;
  if (!useMemory) {
    opts.store = new MongoRateLimitStore(windowMs);
  }
  return rateLimit(opts);
}

const loginLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many login attempts. Try again in 15 minutes.",
});

// Whiteboard strokes + cursors share this bus with WebRTC signaling; a low cap
// lets drawing starve offers/ICE. This is an abuse guard, not a UX throttle.
const eventsPostLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 1200,
  message: "Too many signaling events. Slow down.",
  perParticipant: true,
});

const presenceLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: "Too many presence updates.",
  perParticipant: true,
});

const chatLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: "Too many chat messages.",
  perParticipant: true,
});

const secretJoinLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 10,
  message: "Too many SecretMeet join attempts.",
});

module.exports = {
  createLimiter,
  loginLimiter,
  eventsPostLimiter,
  presenceLimiter,
  chatLimiter,
  secretJoinLimiter,
};
