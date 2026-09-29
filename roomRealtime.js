const express = require("express");
const { v4: uuidv4 } = require("uuid");

const Room = require("./models/room");
const {
  publish,
  listEvents,
  listEventsWait,
  enterPresence,
  heartbeatPresence,
  leavePresence,
  listPresence,
  countPresence,
  activePublicRoomIds,
  removeUserFromRoom,
} = require("./lib/events");
const { signRoomToken, isHostTokenAsync, rotateHostToken, revokeToken } = require("./lib/roomAuth");
const {
  eventsPostLimiter,
  presenceLimiter,
  chatLimiter,
} = require("./lib/rateLimiters");
const { audit } = require("./lib/audit");
const flags = require("./lib/featureFlags");
const {
  Message,
  Poll,
  Question,
  BreakoutSession,
  KnockRequest,
} = require("./models/realtime");

const router = express.Router();

// Host actions require a host-scoped room JWT (issued at create / claim-host).
async function requireHost(req, res) {
  const roomId = req.params.roomId;
  const userId = req.body?.userId || req.query?.userId;
  const token =
    req.body?.roomToken ||
    req.query?.roomToken ||
    (req.headers["x-room-token"] || "").toString() ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!(await isHostTokenAsync(roomId, userId, token))) {
    res.status(403).json({ error: "Host room token required" });
    return false;
  }
  return true;
}

// ─── Rooms ────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const { userId, hostName, isPublic = true, title = "" } = req.body;
    const roomId =
      uuidv4().slice(0, 3) + "-" + uuidv4().slice(0, 4) + "-" + uuidv4().slice(0, 3);

    try {
      await Room.create({
        roomId,
        host: userId,
        hostName,
        isPublic,
        title,
        participantCount: 0,
        classroomId: req.body.classroomId || undefined,
        accountUserId: req.body.accountUserId || undefined,
      });
    } catch (dbErr) {
      return res.status(503).json({
        error: "Failed to persist room",
        code: "DB_UNAVAILABLE",
        detail: dbErr.message,
      });
    }
    const hostToken = userId
      ? signRoomToken({ roomId, userId, role: "host" })
      : null;
    res.json({
      roomId,
      isPublic,
      hostToken,
      link: `${process.env.CLIENT_URL || "http://localhost:3000"}/room/${roomId}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/", async (req, res) => {
  try {
    let activeRoomIds = [];
    try {
      activeRoomIds = await activePublicRoomIds();
    } catch {}

    const dbRooms = await Room.find({
      roomId: { $in: activeRoomIds },
      isPublic: true,
    }).catch(() => []);

    const publicRooms = await Promise.all(
      dbRooms.map(async (r) => {
        let count = 0;
        try {
          count = await countPresence(r.roomId);
        } catch {}
        return {
          roomId: r.roomId,
          title: r.title || `${r.hostName}'s Meeting`,
          hostName: r.hostName,
          isPublic: r.isPublic,
          participantCount: count,
          createdAt: r.createdAt,
        };
      }),
    );
    res.json(publicRooms);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mesh / SFU policy for clients (Y2 scale path)
router.get("/config/realtime", (_req, res) => {
  res.json({
    meshSoftCap: flags.meshSoftCap(),
    longPollEnabled: flags.longPollEnabled(),
    mediaPolicy: "mesh_only",
    deploy: "vercel-serverless",
  });
});

router.get("/:roomId", async (req, res) => {
  try {
    const roomData = await Room.findOne({ roomId: req.params.roomId }).catch(
      () => null,
    );
    let liveCount = 0;
    try {
      liveCount = await countPresence(req.params.roomId);
    } catch {}
    if (roomData)
      return res.json({ ...roomData.toObject(), participantCount: liveCount });
    if (liveCount > 0) {
      return res.json({
        roomId: req.params.roomId,
        isPublic: false,
        participantCount: liveCount,
      });
    }
    res.status(404).json({ error: "Room not found" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Event bus (signaling + ephemeral fan-out) ────────────────────────────
router.post("/:roomId/events", eventsPostLimiter, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { event, payload = {}, from, to } = req.body;
    if (!event || !from)
      return res.status(400).json({ error: "event and from required" });

    const doc = await publish(roomId, event, payload, {
      from,
      to: to ?? payload?.to ?? null,
    });
    res.json({
      id: doc._id.toString(),
      createdAt: doc.createdAt.toISOString(),
    });
  } catch (err) {
    if (err.code === "PAYLOAD_TOO_LARGE") {
      require("./lib/log").warn("event_payload_too_large", {
        roomId: req.params.roomId,
        event: req.body?.event,
        requestId: req.requestId,
      });
      return res.status(413).json({ error: "Event payload too large" });
    }
    require("./lib/log").error("event_publish_failed", {
      roomId: req.params.roomId,
      err: err.message,
      requestId: req.requestId,
    });
    res.status(500).json({ error: err.message });
  }
});

router.get("/:roomId/events", async (req, res) => {
  try {
    const { since, userId, wait } = req.query;
    if (!userId) return res.status(400).json({ error: "userId required" });
    const waitMs =
      flags.longPollEnabled() && wait != null ? Number(wait) : 0;
    const events = waitMs
      ? await listEventsWait(req.params.roomId, since, userId, waitMs)
      : await listEvents(req.params.roomId, since, userId);
    res.json({
      events,
      serverTime: new Date().toISOString(),
      // Lets clients tell a real long-poll from an immediate reply (flag off /
      // older API) so they back off instead of re-polling every few ms.
      longPoll: waitMs > 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Issue / refresh tokens
router.post("/:roomId/token", async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId, roomToken } = req.body;
    if (!userId) return res.status(400).json({ error: "userId required" });
    if (await isHostTokenAsync(roomId, userId, roomToken)) {
      return res.json({
        role: "host",
        roomToken: signRoomToken({ roomId, userId, role: "host" }),
      });
    }
    res.json({
      role: "participant",
      roomToken: signRoomToken({ roomId, userId, role: "participant" }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** E-103: rotate host token (revokes previous jti). */
router.post("/:roomId/token/rotate", async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId, roomToken } = req.body;
    const result = await rotateHostToken({
      roomId,
      userId,
      oldToken: roomToken,
    });
    if (!result.ok) return res.status(403).json({ error: result.error });
    res.json({ role: "host", roomToken: result.roomToken, jti: result.jti });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** E-103: revoke a room token (host or self). */
router.post("/:roomId/token/revoke", async (req, res) => {
  try {
    const { roomToken } = req.body;
    const result = await revokeToken(roomToken, "explicit");
    if (!result.ok) return res.status(400).json({ error: result.error });
    await audit({
      action: "token-revoke",
      roomId: req.params.roomId,
      actorId: req.body.userId || "unknown",
      meta: { jti: result.jti },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Claim host with classroom/account JWT (identity bridge)
router.post("/:roomId/claim-host", async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId, accountUserId, userName } = req.body;
    const authHeader = req.headers.authorization || "";
    const jwtToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;
    if (!jwtToken || !accountUserId) {
      return res.status(401).json({ error: "Account JWT required to claim host" });
    }
    const jwt = require("jsonwebtoken");
    let claims;
    try {
      claims = jwt.verify(jwtToken, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: "Invalid account token" });
    }
    if (claims.id !== accountUserId) {
      return res.status(403).json({ error: "Token user mismatch" });
    }
    const room = await Room.findOne({ roomId });
    if (!room) return res.status(404).json({ error: "Room not found" });
    // Allow claim if already host userId, or room has no account binding, or matches
    if (
      room.accountUserId &&
      room.accountUserId !== accountUserId &&
      room.host !== userId
    ) {
      return res.status(403).json({ error: "Host already claimed by another account" });
    }
    room.host = userId;
    room.hostName = userName || room.hostName;
    room.accountUserId = accountUserId;
    await room.save();
    const hostToken = signRoomToken({ roomId, userId, role: "host" });
    await audit({
      action: "claim-host",
      roomId,
      actorId: accountUserId,
      meta: { userId },
    });
    res.json({ hostToken, role: "host" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Presence ─────────────────────────────────────────────────────────────
router.post("/:roomId/presence", presenceLimiter, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId, userName, connectionId, heartbeat } = req.body;
    if (!userId || !connectionId)
      return res.status(400).json({ error: "userId and connectionId required" });

    // Captured before entering so the joiner's event cursor starts here (server
    // clock) — anything peers publish after this point is delivered.
    const since = new Date().toISOString();
    if (heartbeat) {
      await heartbeatPresence({ roomId, userId, userName, connectionId });
    } else {
      await enterPresence({ roomId, userId, userName, connectionId });
    }
    const members = await listPresence(roomId);
    res.json({ members, since });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/:roomId/presence", async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId, userName, connectionId } = req.body;
    if (!userId) return res.status(400).json({ error: "userId required" });
    await leavePresence({ roomId, userId, userName, connectionId });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/:roomId/presence", async (req, res) => {
  try {
    res.json(await listPresence(req.params.roomId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Knock / admit / reject / kick ───────────────────────────────────────
router.post("/:roomId/knock", async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId, userName } = req.body;
    const room = await Room.findOne({ roomId });

    if (room && room.host === userId) {
      return res.json({ status: "accepted" });
    }

    await KnockRequest.findOneAndUpdate(
      { roomId, userId },
      { roomId, userId, userName },
      { upsert: true },
    );

    if (room?.host) {
      await publish(
        roomId,
        "knock-request",
        { userId, userName, socketId: userId, to: room.host },
        { to: room.host },
      );
      return res.json({ status: "pending" });
    }
    res.json({ status: "waiting" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Guest cancels their own knock (leave waiting room). */
router.delete("/:roomId/knock", async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId } = req.body || {};
    const uid = userId || req.query.userId;
    if (!uid) return res.status(400).json({ error: "userId required" });
    await KnockRequest.deleteOne({ roomId, userId: uid });
    const room = await Room.findOne({ roomId });
    if (room?.host) {
      await publish(
        roomId,
        "knock-cancelled",
        { userId: uid, socketId: uid, to: room.host },
        { to: room.host },
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/:roomId/knocks", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!(await requireHost(req, res))) return;
    res.json(await KnockRequest.find({ roomId: req.params.roomId }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:roomId/admit", async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId, targetUserId } = req.body;
    if (!(await requireHost(req, res))) return;

    await KnockRequest.deleteOne({ roomId, userId: targetUserId });
    await publish(roomId, "knock-accepted", { to: targetUserId }, { to: targetUserId });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:roomId/reject", async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId, targetUserId } = req.body;
    if (!(await requireHost(req, res))) return;

    await KnockRequest.deleteOne({ roomId, userId: targetUserId });
    await publish(roomId, "knock-rejected", { to: targetUserId }, { to: targetUserId });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:roomId/kick", async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId, targetUserId, targetUserName } = req.body;
    if (!(await requireHost(req, res))) return;

    await removeUserFromRoom(roomId, targetUserId);
    await publish(roomId, "kicked", { to: targetUserId }, { to: targetUserId });
    await publish(roomId, "user-left", {
      userId: targetUserId,
      userName: targetUserName,
      socketId: targetUserId,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Host controls (mute/unmute/mute-all/stop-video/wb/hands/transcribe) ──
const HOST_ACTIONS = {
  "mute-user": "force-mute",
  "unmute-user": "force-unmute",
  "stop-video": "force-stop-video",
  "mute-all": "force-mute",
  "lower-all-hands": "lower-hand",
};

router.post("/:roomId/host-action", async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId, action, targetUserId, allowed } = req.body;
    if (!(await requireHost(req, res))) return;

    if (action === "wb-permission") {
      await publish(
        roomId,
        "wb-permission",
        { to: targetUserId, allowed },
        { to: targetUserId },
      );
    } else if (action === "grant-transcribe") {
      await publish(
        roomId,
        "transcribe-permission",
        { to: targetUserId, allowed },
        { to: targetUserId },
      );
    } else if (action === "mute-all" || action === "lower-all-hands") {
      await publish(roomId, HOST_ACTIONS[action], {});
    } else if (HOST_ACTIONS[action]) {
      await publish(
        roomId,
        HOST_ACTIONS[action],
        { to: targetUserId },
        { to: targetUserId },
      );
    } else {
      return res.status(400).json({ error: "Unknown action" });
    }
    await audit({
      action: "host:" + action,
      roomId,
      actorId: userId,
      targetId: targetUserId,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Chat ─────────────────────────────────────────────────────────────────
router.get("/:roomId/chat", async (req, res) => {
  try {
    const messages = await Message.find({ roomId: req.params.roomId })
      .sort({ createdAt: 1 })
      .limit(200);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:roomId/chat", chatLimiter, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { message, userName, userId } = req.body;
    if (!message?.trim() || message.length > 2000)
      return res.status(400).json({ error: "Invalid message" });

    const doc = await Message.create({
      roomId,
      message: message.trim(),
      userName,
      userId,
    });

    const count = await Message.countDocuments({ roomId });
    if (count > 200) {
      const stale = await Message.find({ roomId })
        .sort({ createdAt: 1 })
        .limit(count - 200);
      await Message.deleteMany({ _id: { $in: stale.map((m) => m._id) } });
    }

    await publish(roomId, "chat-message", doc.toObject ? doc.toObject() : doc);
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Polls ────────────────────────────────────────────────────────────────
router.get("/:roomId/polls", async (req, res) => {
  try {
    res.json(await Poll.find({ roomId: req.params.roomId }).sort({ createdAt: 1 }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:roomId/polls", async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId, question, options, createdBy } = req.body;
    if (!(await requireHost(req, res))) return;

    const poll = await Poll.create({
      roomId,
      question,
      createdBy,
      options: options.map((text) => ({ text, votes: [] })),
    });
    await publish(roomId, "poll-new", poll.toObject ? poll.toObject() : poll);
    res.json(poll);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:roomId/polls/:pollId/vote", async (req, res) => {
  try {
    const { roomId, pollId } = req.params;
    const { userId, optionIndex } = req.body;
    const poll = await Poll.findById(pollId);
    if (!poll || !poll.active || poll.roomId !== roomId)
      return res.status(404).json({ error: "Not found" });

    poll.options.forEach((o) => {
      o.votes = o.votes.filter((v) => v !== userId);
    });
    if (optionIndex >= 0 && optionIndex < poll.options.length)
      poll.options[optionIndex].votes.push(userId);
    await poll.save();

    await publish(roomId, "poll-updated", poll.toObject ? poll.toObject() : poll);
    res.json(poll);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:roomId/polls/:pollId/end", async (req, res) => {
  try {
    const { roomId, pollId } = req.params;
    const { userId } = req.body;
    if (!(await requireHost(req, res))) return;

    const poll = await Poll.findById(pollId);
    if (!poll || poll.roomId !== roomId)
      return res.status(404).json({ error: "Not found" });
    poll.active = false;
    await poll.save();

    await publish(roomId, "poll-updated", poll.toObject ? poll.toObject() : poll);
    res.json(poll);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Q&A ──────────────────────────────────────────────────────────────────
router.get("/:roomId/qna", async (req, res) => {
  try {
    res.json(await Question.find({ roomId: req.params.roomId }).sort({ createdAt: 1 }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:roomId/qna", async (req, res) => {
  try {
    const { roomId } = req.params;
    const { text, askerId, askerName, anonymous } = req.body;
    const q = await Question.create({
      roomId,
      text,
      askerId,
      askerName: anonymous ? "Anonymous" : askerName,
      anonymous: !!anonymous,
    });
    await publish(roomId, "qna-new", q.toObject ? q.toObject() : q);
    res.json(q);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:roomId/qna/:qId/upvote", async (req, res) => {
  try {
    const { roomId, qId } = req.params;
    const { userId } = req.body;
    const q = await Question.findOne({ _id: qId, roomId });
    if (!q) return res.status(404).json({ error: "Not found" });
    if (q.upvotes.includes(userId))
      q.upvotes = q.upvotes.filter((v) => v !== userId);
    else q.upvotes.push(userId);
    await q.save();
    await publish(roomId, "qna-updated", q.toObject ? q.toObject() : q);
    res.json(q);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/:roomId/qna/:qId/answered", async (req, res) => {
  try {
    const { roomId, qId } = req.params;
    const { userId } = req.body;
    if (!(await requireHost(req, res))) return;
    const q = await Question.findOne({ _id: qId, roomId });
    if (!q) return res.status(404).json({ error: "Not found" });
    q.answered = !q.answered;
    await q.save();
    await publish(roomId, "qna-updated", q.toObject ? q.toObject() : q);
    res.json(q);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/:roomId/qna/:qId/pin", async (req, res) => {
  try {
    const { roomId, qId } = req.params;
    const { userId } = req.body;
    if (!(await requireHost(req, res))) return;

    await Question.updateMany({ roomId }, { pinned: false });
    const q = await Question.findOne({ _id: qId, roomId });
    if (!q) return res.status(404).json({ error: "Not found" });
    q.pinned = true;
    await q.save();

    const all = await Question.find({ roomId }).sort({ createdAt: 1 });
    await publish(roomId, "qna-all", all);
    res.json(all);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/:roomId/qna/:qId", async (req, res) => {
  try {
    const { roomId, qId } = req.params;
    const { userId } = req.body;
    if (!(await requireHost(req, res))) return;

    await Question.deleteOne({ _id: qId, roomId });
    const all = await Question.find({ roomId }).sort({ createdAt: 1 });
    await publish(roomId, "qna-all", all);
    res.json(all);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Breakout rooms ───────────────────────────────────────────────────────
router.get("/:roomId/breakout", async (req, res) => {
  try {
    res.json(await BreakoutSession.findOne({ roomId: req.params.roomId }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:roomId/breakout", async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId, breakoutRooms } = req.body;
    if (!(await requireHost(req, res))) return;

    const session = await BreakoutSession.findOneAndUpdate(
      { roomId },
      { roomId, rooms: breakoutRooms, active: true },
      { upsert: true, new: true },
    );
    await publish(roomId, "breakout-started", { breakoutRooms });
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:roomId/breakout/assign", async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId, targetUserId, breakoutRoomId } = req.body;
    if (!(await requireHost(req, res))) return;

    await publish(
      roomId,
      "breakout-assigned",
      { to: targetUserId, breakoutRoomId },
      { to: targetUserId },
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/:roomId/breakout", async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId } = req.body;
    if (!(await requireHost(req, res))) return;

    await BreakoutSession.deleteOne({ roomId });
    await publish(roomId, "breakout-ended", {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:roomId/breakout/broadcast", async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId, message } = req.body;
    if (!(await requireHost(req, res))) return;

    await publish(roomId, "breakout-broadcast-msg", {
      message,
      from: "Host",
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:roomId/breakout/callback", async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId } = req.body;
    if (!(await requireHost(req, res))) return;

    await publish(roomId, "breakout-callback", {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GDPR-style purge of room ephemeral data (Y2 compliance). */
router.delete("/:roomId/retention", async (req, res) => {
  try {
    if (!(await requireHost(req, res))) return;
    const { roomId } = req.params;
    const { RoomEvent, Message, KnockRequest, Presence } = require("./models/realtime");
    await Promise.all([
      RoomEvent.deleteMany({ roomId }),
      Message.deleteMany({ roomId }),
      KnockRequest.deleteMany({ roomId }),
      Presence.deleteMany({ roomId }),
    ]);
    await audit({
      action: "retention-purge",
      roomId,
      actorId: req.body.userId,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Recording upload: client records locally then uploads to Blob via classroom
 * blob-upload token when classroomId is set. Persists metadata for retention.
 */
router.post("/:roomId/recordings", async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId, blobUrl, durationSec, classroomId } = req.body;
    const { v4: uuidv4 } = require("uuid");
    const { Recording } = require("./models/platform");
    const recordingId = uuidv4();
    await Recording.create({
      recordingId,
      roomId,
      classroomId,
      actorId: userId,
      blobUrl,
      durationSec,
    });
    await audit({
      action: "recording-saved",
      roomId,
      classroomId,
      actorId: userId,
      meta: { blobUrl, durationSec, recordingId },
    });
    res.json({ ok: true, recordingId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
