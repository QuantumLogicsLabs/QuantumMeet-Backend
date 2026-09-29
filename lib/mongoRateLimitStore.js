const mongoose = require("mongoose");

/**
 * express-rate-limit store backed by Mongo (E-107).
 * Shared across serverless instances when they share the same Atlas cluster.
 * Falls back gracefully if DB is down (allows request — fail open for limits only).
 */
class MongoRateLimitStore {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.Model = null;
  }

  _model() {
    if (this.Model) return this.Model;
    const schema = new mongoose.Schema(
      {
        key: { type: String, required: true },
        points: { type: Number, default: 0 },
        expiresAt: { type: Date, required: true },
      },
      { collection: "rate_limit_hits" },
    );
    schema.index({ key: 1 }, { unique: true });
    // TTL only — a second plain index on the same key blocks this one from
    // being created, and rows would never expire.
    schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    try {
      this.Model = mongoose.model("RateLimitHit");
    } catch {
      this.Model = mongoose.model("RateLimitHit", schema);
    }
    return this.Model;
  }

  async increment(key) {
    if (mongoose.connection.readyState !== 1) {
      return { totalHits: 1, resetTime: new Date(Date.now() + this.windowMs) };
    }
    const Model = this._model();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.windowMs);
    // Single atomic upsert: count within a live window, or start a fresh one
    // when the stored window has expired. (The TTL monitor only sweeps every
    // ~60s, so an expired row can linger — it must not keep counting.)
    const live = { $gt: ["$expiresAt", now] };
    const update = [
      {
        $set: {
          points: { $cond: [live, { $add: ["$points", 1] }, 1] },
          expiresAt: { $cond: [live, "$expiresAt", expiresAt] },
        },
      },
    ];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const doc = await Model.findOneAndUpdate({ key }, update, {
          upsert: true,
          new: true,
        });
        return { totalHits: doc.points, resetTime: doc.expiresAt };
      } catch (err) {
        // Concurrent first-hit upserts race on the unique key — retry once.
        if (err?.code !== 11000) break;
      }
    }
    return { totalHits: 1, resetTime: expiresAt };
  }

  async decrement(key) {
    if (mongoose.connection.readyState !== 1) return;
    const Model = this._model();
    await Model.updateOne({ key }, { $inc: { points: -1 } }).catch(() => {});
  }

  async resetKey(key) {
    if (mongoose.connection.readyState !== 1) return;
    const Model = this._model();
    await Model.deleteOne({ key }).catch(() => {});
  }
}

module.exports = { MongoRateLimitStore };
