const {
  RoomEvent,
  SecretInbox,
  Presence,
  LeaveClaim,
} = require("../models/realtime");
const metrics = require("./metrics");

// Presence rows older than this are treated as left (missed heartbeats).
const PRESENCE_STALE_MS = 45_000;
const MAX_LIST = 100;
const MAX_PAYLOAD_BYTES = 120_000;
const LONG_POLL_MAX_MS = 7_000;

function staleCutoff() {
  return new Date(Date.now() - PRESENCE_STALE_MS);
}

async function claimUserLeftFanout(roomId, userId) {
  try {
    await LeaveClaim.create({ roomId, userId });
    return true;
  } catch (err) {
    if (err && (err.code === 11000 || err.code === "E11000")) return false;
    return true;
  }
}

async function clearLeaveClaim(roomId, userId) {
  try {
    await LeaveClaim.deleteOne({ roomId, userId });
  } catch {
    /* ignore */
  }
}

function payloadTooLarge(payload) {
  try {
    return JSON.stringify(payload || {}).length > MAX_PAYLOAD_BYTES;
  } catch {
    return true;
  }
}

async function publish(roomId, event, payload = {}, opts = {}) {
  if (payloadTooLarge(payload)) {
    metrics.inc("eventsRejected");
    const err = new Error("payload_too_large");
    err.code = "PAYLOAD_TOO_LARGE";
    throw err;
  }
  const to = opts.to ?? payload?.to ?? null;
  const from = opts.from ?? null;
  const doc = await RoomEvent.create({
    roomId,
    event,
    payload,
    to: to || null,
    from: from || null,
  });
  metrics.inc("eventsPublished");
  if (event === "wb-draw") {
    metrics.inc("wbDrawEvents");
    const segs = Array.isArray(payload?.segments) ? payload.segments.length : 1;
    metrics.inc("wbDrawSegments", segs);
  }
  return doc;
}

async function publishSecret(userId, event, payload = {}) {
  return SecretInbox.create({ userId, event, payload });
}

function parseSince(since) {
  const d = since ? new Date(since) : null;
  return d && !Number.isNaN(d.getTime()) ? d : new Date(Date.now() - 60_000);
}

async function listEvents(roomId, since, userId) {
  const sinceDate = parseSince(since);
  const query = {
    roomId,
    createdAt: { $gt: sinceDate },
    $and: [
      { $or: [{ to: null }, { to: userId }] },
      { $or: [{ from: null }, { from: { $ne: userId } }] },
    ],
  };
  const docs = await RoomEvent.find(query)
    .sort({ createdAt: 1 })
    .limit(MAX_LIST)
    .select("event payload createdAt")
    .lean();
  metrics.inc("eventsListed", docs.length);
  return docs.map((d) => ({
    id: String(d._id),
    event: d.event,
    payload: d.payload,
    createdAt: new Date(d.createdAt).toISOString(),
  }));
}

/**
 * Long-poll helper: wait up to waitMs for new events. Capped at 7s so a
 * request (plus cold start / DB connect) finishes inside Vercel's 10s
 * default function timeout.
 */
async function listEventsWait(roomId, since, userId, waitMs = 0) {
  const cap = Math.min(Math.max(Number(waitMs) || 0, 0), LONG_POLL_MAX_MS);
  let events = await listEvents(roomId, since, userId);
  if (events.length || cap <= 0) return events;

  const deadline = Date.now() + cap;
  while (Date.now() < deadline) {
    await new Promise((r) =>
      setTimeout(r, Math.min(700, Math.max(0, deadline - Date.now()))),
    );
    events = await listEvents(roomId, since, userId);
    if (events.length) return events;
  }
  return events;
}

async function listSecretInbox(userId, since) {
  const sinceDate = parseSince(since);
  const docs = await SecretInbox.find({
    userId,
    createdAt: { $gt: sinceDate },
  })
    .sort({ createdAt: 1 })
    .limit(50);
  return docs.map((d) => ({
    id: d._id.toString(),
    event: d.event,
    payload: d.payload,
    createdAt: d.createdAt.toISOString(),
  }));
}

async function enterPresence({ roomId, userId, userName, connectionId }) {
  const now = new Date();
  const prior = await Presence.find({
    roomId,
    userId,
    lastSeen: { $gte: staleCutoff() },
  });
  const hadOther = prior.some((p) => p.connectionId !== connectionId);

  await Presence.findOneAndUpdate(
    { roomId, userId, connectionId },
    { roomId, userId, userName, connectionId, lastSeen: now },
    { upsert: true, new: true },
  );
  await clearLeaveClaim(roomId, userId);

  await publish(
    roomId,
    hadOther || prior.length > 0 ? "user-rejoined" : "user-joined",
    { socketId: userId, userId, userName },
    { from: userId },
  );
}

async function heartbeatPresence({ roomId, userId, userName, connectionId }) {
  const now = new Date();
  await Presence.findOneAndUpdate(
    { roomId, userId, connectionId },
    { roomId, userId, userName, connectionId, lastSeen: now },
    { upsert: true, new: true },
  );
}

async function fanoutUserLeftIfAlone(roomId, userId, userName) {
  const remaining = await Presence.countDocuments({
    roomId,
    userId,
    lastSeen: { $gte: staleCutoff() },
  });
  if (remaining > 0) return false;
  const claimed = await claimUserLeftFanout(roomId, userId);
  if (!claimed) return false;
  await publish(
    roomId,
    "user-left",
    { socketId: userId, userId, userName },
    { from: userId },
  );
  return true;
}

async function leavePresence({ roomId, userId, userName, connectionId }) {
  if (connectionId) {
    const removed = await Presence.findOneAndDelete({
      roomId,
      userId,
      connectionId,
    });
    if (!removed) return;
  } else {
    await Presence.deleteMany({ roomId, userId });
  }
  await fanoutUserLeftIfAlone(roomId, userId, userName);
}

/**
 * Delete stale presence rows and fan out user-left for users fully gone.
 * Safe under multi-tab races via LeaveClaim.
 */
async function gcStalePresence({ roomId = null, limit = 200 } = {}) {
  const cutoff = staleCutoff();
  const filter = roomId
    ? { roomId, lastSeen: { $lt: cutoff } }
    : { lastSeen: { $lt: cutoff } };
  const stale = await Presence.find(filter).limit(limit).lean();
  if (!stale.length) return { deleted: 0, left: 0 };

  const byKey = new Map();
  for (const row of stale) {
    const key = `${row.roomId}::${row.userId}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        roomId: row.roomId,
        userId: row.userId,
        userName: row.userName,
      });
    }
  }

  const ids = stale.map((r) => r._id);
  await Presence.deleteMany({ _id: { $in: ids } });

  let left = 0;
  for (const { roomId: r, userId, userName } of byKey.values()) {
    const still = await Presence.countDocuments({
      roomId: r,
      userId,
      lastSeen: { $gte: cutoff },
    });
    if (still > 0) continue;
    if (await fanoutUserLeftIfAlone(r, userId, userName)) left += 1;
  }
  metrics.inc("presenceGcDeleted", ids.length);
  if (left) metrics.inc("presenceGcLeft", left);
  return { deleted: ids.length, left };
}

async function listPresence(roomId) {
  await gcStalePresence({ roomId, limit: 100 });
  const rows = await Presence.find({
    roomId,
    lastSeen: { $gte: staleCutoff() },
  });
  // One entry per userId (multi-tab → same peer id for WebRTC)
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.userId)) {
      byUser.set(r.userId, {
        socketId: r.userId,
        userId: r.userId,
        userName: r.userName,
        connectionId: r.connectionId,
      });
    }
  }
  return [...byUser.values()];
}

async function countPresence(roomId) {
  await gcStalePresence({ roomId, limit: 100 });
  const rows = await Presence.find({
    roomId,
    lastSeen: { $gte: staleCutoff() },
  }).select("userId");
  return new Set(rows.map((r) => r.userId)).size;
}

async function activePublicRoomIds() {
  await gcStalePresence({ limit: 200 });
  return Presence.distinct("roomId", {
    lastSeen: { $gte: staleCutoff() },
  });
}

async function removeUserFromRoom(roomId, userId) {
  await Presence.deleteMany({ roomId, userId });
  await clearLeaveClaim(roomId, userId);
}

module.exports = {
  publish,
  publishSecret,
  listEvents,
  listEventsWait,
  listSecretInbox,
  enterPresence,
  heartbeatPresence,
  leavePresence,
  listPresence,
  countPresence,
  activePublicRoomIds,
  removeUserFromRoom,
  gcStalePresence,
  PRESENCE_STALE_MS,
};
