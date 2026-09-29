const express = require("express");
const { Readable } = require("stream");
const { handleUpload } = require("@vercel/blob/client");
const { del } = require("@vercel/blob");
const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const auth = require("./middleware/auth");
const validate = require("./middleware/validate");
const schemas = require("./schemas/classroom");

const router = express.Router();

// ── All classroom routes require a valid JWT ──────────────────────────────────
// Meeting rooms stay login-free. Only the classroom surface is protected.
router.use(auth);

// ── Uploads ───────────────────────────────────────────────────────────────────
// Files never pass through this server: the client uploads straight to Vercel
// Blob (client-upload flow) since serverless functions cap request bodies at
// ~4.5MB, far under the 50MB limit this app allows. This route only issues the
// signed, scoped upload token — see POST /:classroomId/blob-upload below.
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/wav",
  "application/zip",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
]);

router.post("/:classroomId/blob-upload", async (req, res) => {
  try {
    const { classroomId } = req.params;
    const userId = req.user.id;
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: [...ALLOWED_MIME_TYPES],
        maximumSizeInBytes: 50 * 1024 * 1024,
        addRandomSuffix: true,
        tokenPayload: JSON.stringify({ classroomId, userId }),
      }),
      onUploadCompleted: async () => {},
    });
    res.json(jsonResponse);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Schemas ───────────────────────────────────────────────────────────────────
const classroomSchema = new mongoose.Schema({
  classroomId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  description: { type: String, default: "" },
  subject: { type: String, default: "" },
  section: { type: String, default: "" },
  room: { type: String, default: "" },
  creatorId: { type: String, required: true },
  creatorName: { type: String, required: true },
  inviteCode: { type: String, required: true, unique: true },
  members: [
    {
      userId: String,
      userName: String,
      role: { type: String, default: "student" },
      joinedAt: { type: Date, default: Date.now },
    },
  ],
  createdAt: { type: Date, default: Date.now },
  theme: { type: String, default: "cyan" },
  archived: { type: Boolean, default: false },
});

const postSchema = new mongoose.Schema({
  postId: { type: String, required: true, unique: true },
  classroomId: { type: String, required: true, index: true },
  type: {
    type: String,
    enum: [
      "announcement",
      "assignment",
      "material",
      "question",
      "quiz",
      "poll",
    ],
    default: "announcement",
  },
  title: { type: String, default: "" },
  body: { type: String, default: "" },
  authorId: { type: String, required: true },
  authorName: { type: String, required: true },
  attachments: [
    { name: String, url: String, pathname: String, size: Number, mime: String },
  ],
  dueDate: { type: Date },
  points: { type: Number },
  topic: { type: String, default: "" },
  /** When false, overdue submissions are rejected (default allows late). */
  allowLateSubmissions: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  pinned: { type: Boolean, default: false },
  quizQuestions: [
    {
      text: String,
      question: String,
      options: [String],
      correct: Number,
      points: Number,
    },
  ],
  pollOptions: [{ text: String, votes: [String] }],
  pollClosed: { type: Boolean, default: false },
});

const submissionSchema = new mongoose.Schema({
  submissionId: { type: String, required: true, unique: true },
  postId: { type: String, required: true, index: true },
  classroomId: { type: String, required: true },
  studentId: { type: String, required: true },
  studentName: { type: String, required: true },
  comment: { type: String, default: "" },
  attachments: [
    { name: String, url: String, pathname: String, size: Number, mime: String },
  ],
  grade: { type: Number },
  feedback: { type: String, default: "" },
  privateNote: { type: String, default: "" },
  status: {
    type: String,
    enum: ["submitted", "graded", "returned", "late", "missing"],
    default: "submitted",
  },
  submittedAt: { type: Date, default: Date.now },
  gradedAt: { type: Date },
  quizAnswers: [Number],
  annotation: { type: String, default: "" },
  quizScore: { type: Number },
});

const commentSchema = new mongoose.Schema({
  commentId: { type: String, required: true, unique: true },
  postId: { type: String, required: true, index: true },
  classroomId: { type: String, required: true },
  authorId: { type: String, required: true },
  authorName: { type: String, required: true },
  text: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

const sessionLogSchema = new mongoose.Schema({
  classroomId: { type: String, required: true, index: true },
  roomId: { type: String },
  startedAt: { type: Date, default: Date.now },
  endedAt: { type: Date },
  hostName: { type: String },
  attendees: [
    { userId: String, userName: String, joinedAt: Date, leftAt: Date },
  ],
  chatLog: [{ userName: String, message: String, timestamp: Date }],
  summary: { type: String, default: "" },
});

const topicSchema = new mongoose.Schema({
  topicId: { type: String, required: true, unique: true },
  classroomId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  order: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

const attendanceSchema = new mongoose.Schema(
  {
    classroomId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true },
    date: { type: Date, required: true },
    records: [
      {
        studentId: String,
        studentName: String,
        status: {
          type: String,
          enum: ["present", "absent", "late", "excused"],
          default: "absent",
        },
        joinTime: Date,
        leaveTime: Date,
      },
    ],
  },
  { timestamps: true },
);

const scheduledPostSchema = new mongoose.Schema(
  {
    classroomId: { type: String, required: true },
    type: { type: String, default: "announcement" },
    title: { type: String },
    body: { type: String, default: "" },
    authorId: { type: String, required: true },
    authorName: { type: String, required: true },
    scheduledFor: { type: Date, required: true },
    published: { type: Boolean, default: false },
    attachments: [
      { name: String, url: String, pathname: String, size: Number, mime: String },
    ],
    dueDate: { type: Date },
    points: { type: Number },
    topic: { type: String, default: "" },
  },
  { timestamps: true },
);

let Classroom,
  Post,
  Submission,
  Comment,
  SessionLog,
  Topic,
  Attendance,
  ScheduledPost;
try {
  Classroom = mongoose.model("Classroom");
} catch {
  Classroom = mongoose.model("Classroom", classroomSchema);
}
try {
  Post = mongoose.model("Post");
} catch {
  Post = mongoose.model("Post", postSchema);
}
try {
  Submission = mongoose.model("Submission");
} catch {
  Submission = mongoose.model("Submission", submissionSchema);
}
try {
  Comment = mongoose.model("Comment");
} catch {
  Comment = mongoose.model("Comment", commentSchema);
}
try {
  SessionLog = mongoose.model("SessionLog");
} catch {
  SessionLog = mongoose.model("SessionLog", sessionLogSchema);
}
try {
  Topic = mongoose.model("Topic");
} catch {
  Topic = mongoose.model("Topic", topicSchema);
}
try {
  Attendance = mongoose.model("Attendance");
} catch {
  Attendance = mongoose.model("Attendance", attendanceSchema);
}
try {
  ScheduledPost = mongoose.model("ScheduledPost");
} catch {
  ScheduledPost = mongoose.model("ScheduledPost", scheduledPostSchema);
}

const mkId = () => uuidv4();
const mkInvite = () => Math.random().toString(36).slice(2, 8).toUpperCase();

// FIX: safe divisor — never divide by zero in grade calculations
const safePts = (pts) => (pts != null && pts > 0 ? pts : 100);

// ═════════════════════════════════════════════════════════════════════════════
// CLASSROOM CRUD
// ═════════════════════════════════════════════════════════════════════════════

router.post("/", validate(schemas.createClassroom), async (req, res) => {
  try {
    const { name, description, subject, section, room, theme } = req.body;
    // FIX: creatorId and creatorName come from the verified JWT token,
    // never from req.body — prevents impersonation
    const creatorId = req.user.id;
    const creatorName = req.user.name;

    const doc = await Classroom.create({
      classroomId: mkId(),
      name,
      description,
      subject,
      section,
      room,
      creatorId,
      creatorName,
      inviteCode: mkInvite(),
      theme,
      members: [{ userId: creatorId, userName: creatorName, role: "teacher" }],
    });
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get all classrooms for the current user (from token)
router.get("/mine", async (req, res) => {
  try {
    const docs = await Classroom.find({ "members.userId": req.user.id }).sort({
      createdAt: -1,
    });
    res.json(docs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Keep legacy /user/:userId route for backwards compatibility
// but use the token's userId instead of the URL param to prevent enumeration
router.get("/user/:userId", async (req, res) => {
  try {
    // Ignore req.params.userId — always use the authenticated user's id
    const docs = await Classroom.find({ "members.userId": req.user.id }).sort({
      createdAt: -1,
    });
    res.json(docs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/:classroomId", async (req, res) => {
  try {
    const doc = await Classroom.findOne({
      classroomId: req.params.classroomId,
    });
    if (!doc) return res.status(404).json({ error: "Not found" });
    // Only members can view the classroom
    const isMember =
      doc.members.some((m) => m.userId === req.user.id) ||
      doc.creatorId === req.user.id;
    if (!isMember)
      return res.status(403).json({ error: "Not a member of this classroom" });
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/join", validate(schemas.joinClassroom), async (req, res) => {
  try {
    const { inviteCode } = req.body;
    // FIX: userId and userName come from the token
    const userId = req.user.id;
    const userName = req.user.name;

    const doc = await Classroom.findOne({
      inviteCode: inviteCode.toUpperCase(),
    });
    if (!doc) return res.status(404).json({ error: "Invalid invite code" });
    if (!doc.members.find((m) => m.userId === userId)) {
      doc.members.push({ userId, userName, role: "student" });
      await doc.save();
      try {
        const { audit } = require("./lib/audit");
        await audit({
          action: "classroom-join",
          classroomId: doc.classroomId,
          actorId: userId,
          meta: { inviteCode: inviteCode.toUpperCase(), userName },
        });
      } catch {
        /* non-fatal */
      }
    }
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch(
  "/:classroomId",
  validate(schemas.updateClassroom),
  async (req, res) => {
    try {
      const doc = await Classroom.findOne({
        classroomId: req.params.classroomId,
      });
      if (!doc) return res.status(404).json({ error: "Not found" });
      // FIX: authorization check uses req.user.id from token
      if (doc.creatorId !== req.user.id)
        return res.status(403).json({ error: "Not authorized" });

      const { name, description, subject, section, room, theme, archived } =
        req.body;
      if (name !== undefined) doc.name = name;
      if (description !== undefined) doc.description = description;
      if (subject !== undefined) doc.subject = subject;
      if (section !== undefined) doc.section = section;
      if (room !== undefined) doc.room = room;
      if (theme !== undefined) doc.theme = theme;
      if (archived !== undefined) doc.archived = archived;
      await doc.save();
      res.json(doc);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

router.post("/:classroomId/regenerate-code", async (req, res) => {
  try {
    const doc = await Classroom.findOne({
      classroomId: req.params.classroomId,
    });
    if (!doc || doc.creatorId !== req.user.id)
      return res.status(403).json({ error: "Not authorized" });
    doc.inviteCode = mkInvite();
    await doc.save();
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/:classroomId/members/:memberId/role", async (req, res) => {
  try {
    const { role } = req.body;
    const doc = await Classroom.findOne({
      classroomId: req.params.classroomId,
    });
    if (!doc || doc.creatorId !== req.user.id)
      return res.status(403).json({ error: "Not authorized" });
    const m = doc.members.find((m) => m.userId === req.params.memberId);
    if (m) {
      m.role = role;
      await doc.save();
    }
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/:classroomId/members/:memberId", async (req, res) => {
  try {
    const doc = await Classroom.findOne({
      classroomId: req.params.classroomId,
    });
    if (!doc || doc.creatorId !== req.user.id)
      return res.status(403).json({ error: "Not authorized" });
    doc.members = doc.members.filter((m) => m.userId !== req.params.memberId);
    await doc.save();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// CLASSROOM TEMPLATES (E-802 light)
// ═════════════════════════════════════════════════════════════════════════════

router.get("/meta/templates", (_req, res) => {
  res.json([
    {
      id: "stem-lab",
      name: "STEM Lab",
      description: "Assignments + materials + weekly quiz",
      theme: "cyan",
      starterPosts: [
        { type: "announcement", title: "Welcome", body: "Syllabus and lab safety." },
        { type: "assignment", title: "Lab 1", body: "Submit your write-up.", points: 100 },
      ],
    },
    {
      id: "language-seminar",
      name: "Language Seminar",
      description: "Discussion-heavy with attendance",
      theme: "violet",
      starterPosts: [
        { type: "announcement", title: "Seminar norms", body: "Cameras optional; participation counted." },
        { type: "material", title: "Reading pack", body: "Week 1 texts." },
      ],
    },
    {
      id: "exam-prep",
      name: "Exam Prep",
      description: "Quiz-forward classroom",
      theme: "amber",
      starterPosts: [
        { type: "quiz", title: "Practice quiz", body: "Ungraded practice." },
      ],
    },
  ]);
});

// ═════════════════════════════════════════════════════════════════════════════
// TOPICS
// ═════════════════════════════════════════════════════════════════════════════

router.get("/:classroomId/topics", async (req, res) => {
  try {
    const docs = await Topic.find({ classroomId: req.params.classroomId }).sort(
      { order: 1 },
    );
    res.json(docs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post(
  "/:classroomId/topics",
  validate(schemas.createTopic),
  async (req, res) => {
    try {
      const { name } = req.body;
      const count = await Topic.countDocuments({
        classroomId: req.params.classroomId,
      });
      const doc = await Topic.create({
        topicId: mkId(),
        classroomId: req.params.classroomId,
        name,
        order: count,
      });
      res.json(doc);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

router.delete("/:classroomId/topics/:topicId", async (req, res) => {
  try {
    await Topic.deleteOne({ topicId: req.params.topicId });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POSTS
// ═════════════════════════════════════════════════════════════════════════════

router.get("/:classroomId/posts", async (req, res) => {
  try {
    // The cron only runs daily on Vercel Hobby — publish anything due now.
    const { publishDueScheduledPosts } = require("./lib/scheduledPosts");
    await publishDueScheduledPosts({
      classroomId: req.params.classroomId,
      limit: 20,
    }).catch(() => {});
    const posts = await Post.find({ classroomId: req.params.classroomId }).sort(
      { pinned: -1, createdAt: -1 },
    );
    res.json(posts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// `attachments` arrives as JSON — files were already uploaded client-side to
// Vercel Blob via the /blob-upload token endpoint before this call is made.
const parseMaybeJSON = (v) => {
  if (v == null) return v;
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

router.post("/:classroomId/posts", async (req, res) => {
  try {
    const {
      type,
      title,
      body,
      dueDate,
      points,
      topic,
      quizQuestions,
      pollOptions,
      attachments,
      allowLateSubmissions,
    } = req.body;

    // FIX: authorId and authorName from token
    const data = {
      postId: mkId(),
      classroomId: req.params.classroomId,
      type: type || "announcement",
      title: title || "",
      body: body || "",
      authorId: req.user.id,
      authorName: req.user.name,
      attachments: parseMaybeJSON(attachments) || [],
      topic: topic || "",
      dueDate: dueDate ? new Date(dueDate) : undefined,
      points: points ? Number(points) : undefined,
      allowLateSubmissions:
        allowLateSubmissions === undefined
          ? true
          : Boolean(allowLateSubmissions),
    };

    const parsedQuiz = parseMaybeJSON(quizQuestions);
    if (parsedQuiz) data.quizQuestions = parsedQuiz;

    const parsedPolls = parseMaybeJSON(pollOptions);
    if (parsedPolls) {
      data.pollOptions = parsedPolls.map((t) => ({ text: t, votes: [] }));
    }

    const doc = await Post.create(data);
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/:classroomId/posts/:postId", async (req, res) => {
  try {
    const { title, body, dueDate, points, topic, attachments } = req.body;
    const doc = await Post.findOne({ postId: req.params.postId });
    if (!doc) return res.status(404).json({ error: "Not found" });
    // Only the author or classroom creator can edit
    if (doc.authorId !== req.user.id) {
      const classroom = await Classroom.findOne({
        classroomId: req.params.classroomId,
      });
      if (!classroom || classroom.creatorId !== req.user.id)
        return res.status(403).json({ error: "Not authorized" });
    }
    if (title !== undefined) doc.title = title;
    if (body !== undefined) doc.body = body;
    if (topic !== undefined) doc.topic = topic;
    if (dueDate !== undefined)
      doc.dueDate = dueDate ? new Date(dueDate) : null;
    if (points !== undefined) doc.points = points ? Number(points) : null;
    const newAtts = parseMaybeJSON(attachments);
    if (newAtts?.length) {
      doc.attachments = [...(doc.attachments || []), ...newAtts];
    }
    await doc.save();
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/:classroomId/posts/:postId/pin", async (req, res) => {
  try {
    const doc = await Classroom.findOne({
      classroomId: req.params.classroomId,
    });
    if (!doc || doc.creatorId !== req.user.id)
      return res.status(403).json({ error: "Not authorized" });
    const post = await Post.findOne({ postId: req.params.postId });
    if (!post) return res.status(404).json({ error: "Not found" });
    post.pinned = !post.pinned;
    await post.save();
    res.json(post);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/:classroomId/posts/:postId", async (req, res) => {
  try {
    const doc = await Post.findOne({ postId: req.params.postId });
    if (!doc) return res.status(404).json({ error: "Not found" });
    if (doc.authorId !== req.user.id) {
      const classroom = await Classroom.findOne({
        classroomId: req.params.classroomId,
      });
      if (!classroom || classroom.creatorId !== req.user.id)
        return res.status(403).json({ error: "Not authorized" });
    }
    await Promise.all(
      doc.attachments.map((a) => del(a.url).catch(() => {})),
    );
    await Post.deleteOne({ postId: req.params.postId });
    await Comment.deleteMany({ postId: req.params.postId });
    await Submission.deleteMany({ postId: req.params.postId });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:classroomId/posts/:postId/vote", async (req, res) => {
  try {
    const { optionIndex } = req.body;
    const userId = req.user.id; // FIX: from token
    const doc = await Post.findOne({ postId: req.params.postId });
    if (!doc || doc.type !== "poll")
      return res.status(404).json({ error: "Not found" });
    if (doc.pollClosed)
      return res.status(400).json({ error: "Poll is closed" });
    doc.pollOptions.forEach((o) => {
      o.votes = o.votes.filter((v) => v !== userId);
    });
    if (optionIndex >= 0 && optionIndex < doc.pollOptions.length)
      doc.pollOptions[optionIndex].votes.push(userId);
    await doc.save();
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/:classroomId/posts/:postId/close-poll", async (req, res) => {
  try {
    const classroom = await Classroom.findOne({
      classroomId: req.params.classroomId,
    });
    if (!classroom || classroom.creatorId !== req.user.id)
      return res.status(403).json({ error: "Not authorized" });
    const doc = await Post.findOne({ postId: req.params.postId });
    if (!doc) return res.status(404).json({ error: "Not found" });
    doc.pollClosed = true;
    await doc.save();
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// COMMENTS
// ═════════════════════════════════════════════════════════════════════════════

router.get("/:classroomId/posts/:postId/comments", async (req, res) => {
  try {
    res.json(
      await Comment.find({ postId: req.params.postId }).sort({ createdAt: 1 }),
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post(
  "/:classroomId/posts/:postId/comments",
  validate(schemas.createComment),
  async (req, res) => {
    try {
      const { text } = req.body;
      // FIX: authorId and authorName from token
      const doc = await Comment.create({
        commentId: mkId(),
        postId: req.params.postId,
        classroomId: req.params.classroomId,
        authorId: req.user.id,
        authorName: req.user.name,
        text: text.trim(),
      });
      res.json(doc);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

router.delete(
  "/:classroomId/posts/:postId/comments/:commentId",
  async (req, res) => {
    try {
      const comment = await Comment.findOne({
        commentId: req.params.commentId,
      });
      if (!comment) return res.status(404).json({ error: "Not found" });
      // Only the author or classroom teacher can delete
      if (comment.authorId !== req.user.id) {
        const classroom = await Classroom.findOne({
          classroomId: req.params.classroomId,
        });
        if (!classroom || classroom.creatorId !== req.user.id)
          return res.status(403).json({ error: "Not authorized" });
      }
      await Comment.deleteOne({ commentId: req.params.commentId });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// SUBMISSIONS
// ═════════════════════════════════════════════════════════════════════════════

router.get("/:classroomId/posts/:postId/submissions", async (req, res) => {
  try {
    const classroom = await Classroom.findOne({
      classroomId: req.params.classroomId,
    });
    const isTeacher =
      classroom &&
      (classroom.creatorId === req.user.id ||
        classroom.members.some(
          (m) => m.userId === req.user.id && m.role === "teacher",
        ));
    // FIX: students can only see their own submission; teachers see all
    const filter = { postId: req.params.postId };
    if (!isTeacher) filter.studentId = req.user.id;
    res.json(await Submission.find(filter).sort({ submittedAt: -1 }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/:classroomId/gradebook", async (req, res) => {
  try {
    const posts = await Post.find({
      classroomId: req.params.classroomId,
      type: { $in: ["assignment", "quiz"] },
    }).sort({ createdAt: 1 });
    const submissions = await Submission.find({
      classroomId: req.params.classroomId,
    });
    const classroom = await Classroom.findOne({
      classroomId: req.params.classroomId,
    });
    res.json({
      posts,
      submissions,
      members: classroom?.members?.filter((m) => m.role === "student") || [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:classroomId/posts/:postId/submissions", async (req, res) => {
  try {
    const { comment, quizAnswers, attachments } = req.body;
    const parsedAttachments = parseMaybeJSON(attachments) || [];

    // FIX: studentId and studentName from token
    const studentId = req.user.id;
    const studentName = req.user.name;

    const old = await Submission.findOne({
      postId: req.params.postId,
      studentId,
    });
    if (old) {
      await Promise.all(
        old.attachments.map((a) => del(a.url).catch(() => {})),
      );
      await Submission.deleteOne({ submissionId: old.submissionId });
    }

    let quizScore;
    const parsedAnswers = parseMaybeJSON(quizAnswers);
    if (parsedAnswers) {
      const post = await Post.findOne({ postId: req.params.postId });
      if (post?.quizQuestions?.length) {
        // Server-authoritative grading — ignore client quizScore/grade
        let correct = 0;
        parsedAnswers.forEach((ans, i) => {
          if (ans === post.quizQuestions[i]?.correct) correct++;
        });
        quizScore = Math.round(
          (correct / post.quizQuestions.length) * (post.points || 100),
        );
      }
    }

    const post = await Post.findOne({ postId: req.params.postId });
    const isLate = post?.dueDate && new Date() > new Date(post.dueDate);
    if (isLate && post.allowLateSubmissions === false) {
      return res.status(403).json({
        error: "Late submissions are closed for this assignment",
        code: "LATE_CLOSED",
      });
    }

    const doc = await Submission.create({
      submissionId: mkId(),
      postId: req.params.postId,
      classroomId: req.params.classroomId,
      studentId,
      studentName,
      comment: comment || "",
      attachments: parsedAttachments,
      status: isLate ? "late" : "submitted",
      quizAnswers: parsedAnswers,
      quizScore,
      grade: quizScore,
    });
    if (quizScore !== undefined) {
      doc.status = "graded";
      doc.gradedAt = new Date();
      await doc.save();
    }
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch(
  "/:classroomId/posts/:postId/submissions/:submissionId/grade",
  validate(schemas.gradeSubmission),
  async (req, res) => {
    try {
      // Only teacher can grade
      const classroom = await Classroom.findOne({
        classroomId: req.params.classroomId,
      });
      const isTeacher =
        classroom &&
        (classroom.creatorId === req.user.id ||
          classroom.members.some(
            (m) => m.userId === req.user.id && m.role === "teacher",
          ));
      if (!isTeacher) return res.status(403).json({ error: "Not authorized" });

      const { grade, feedback, privateNote } = req.body;
      const doc = await Submission.findOne({
        submissionId: req.params.submissionId,
      });
      if (!doc) return res.status(404).json({ error: "Not found" });
      doc.grade = Number(grade);
      doc.feedback = feedback || "";
      doc.privateNote = privateNote || "";
      doc.status = "graded";
      doc.gradedAt = new Date();
      await doc.save();
      res.json(doc);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

router.patch(
  "/:classroomId/posts/:postId/submissions/bulk-grade",
  validate(schemas.bulkGrade),
  async (req, res) => {
    try {
      const { grades } = req.body;
      const results = await Promise.all(
        grades.map(async ({ submissionId, grade, feedback }) => {
          const doc = await Submission.findOne({ submissionId });
          if (!doc) return null;
          doc.grade = Number(grade);
          doc.feedback = feedback || "";
          doc.status = "graded";
          doc.gradedAt = new Date();
          await doc.save();
          return doc;
        }),
      );
      res.json(results.filter(Boolean));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

router.patch(
  "/:classroomId/posts/:postId/submissions/:submissionId/return",
  async (req, res) => {
    try {
      const doc = await Submission.findOne({
        submissionId: req.params.submissionId,
      });
      if (!doc) return res.status(404).json({ error: "Not found" });
      doc.status = "returned";
      await doc.save();
      res.json(doc);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

router.patch(
  "/:classroomId/posts/:postId/submissions/:submissionId/annotate",
  async (req, res) => {
    try {
      const { annotation } = req.body;
      const doc = await Submission.findOne({
        submissionId: req.params.submissionId,
      });
      if (!doc) return res.status(404).json({ error: "Not found" });
      doc.annotation = annotation;
      await doc.save();
      res.json(doc);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// FILE DOWNLOAD
// ═════════════════════════════════════════════════════════════════════════════

// Files live in Vercel Blob (public-URL-only storage — no built-in private
// URLs), so access control is enforced here instead: only proxy a URL that is
// actually attached to a post/submission in a classroom the caller belongs to.
router.get("/:classroomId/download", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "url required" });

    const classroom = await Classroom.findOne({
      classroomId: req.params.classroomId,
    });
    if (!classroom) return res.status(404).json({ error: "Not found" });
    const isMember =
      classroom.members.some((m) => m.userId === req.user.id) ||
      classroom.creatorId === req.user.id;
    if (!isMember)
      return res.status(403).json({ error: "Not a member of this classroom" });

    const [post, submission] = await Promise.all([
      Post.findOne({ classroomId: req.params.classroomId, "attachments.url": url }),
      Submission.findOne({
        classroomId: req.params.classroomId,
        "attachments.url": url,
      }),
    ]);
    if (!post && !submission)
      return res.status(404).json({ error: "File not found" });

    const blobRes = await fetch(url);
    if (!blobRes.ok || !blobRes.body)
      return res.status(404).json({ error: "File not found" });
    res.setHeader(
      "Content-Type",
      blobRes.headers.get("content-type") || "application/octet-stream",
    );
    Readable.fromWeb(blobRes.body).pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// SESSIONS
// ═════════════════════════════════════════════════════════════════════════════

router.get("/:classroomId/sessions", async (req, res) => {
  try {
    res.json(
      await SessionLog.find({ classroomId: req.params.classroomId }).sort({
        startedAt: -1,
      }),
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post(
  "/:classroomId/sessions",
  validate(schemas.createSession),
  async (req, res) => {
    try {
      const { roomId } = req.body;
      // FIX: hostName from token
      res.json(
        await SessionLog.create({
          classroomId: req.params.classroomId,
          roomId,
          hostName: req.user.name,
        }),
      );
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

router.patch("/:classroomId/sessions/:sessionId", async (req, res) => {
  try {
    const { endedAt, attendees, chatLog, summary } = req.body;
    const doc = await SessionLog.findById(req.params.sessionId);
    if (!doc) return res.status(404).json({ error: "Not found" });
    if (endedAt) doc.endedAt = new Date(endedAt);
    if (attendees) doc.attendees = attendees;
    if (chatLog) doc.chatLog = chatLog;
    if (summary) doc.summary = summary;
    await doc.save();
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ANALYTICS
// ═════════════════════════════════════════════════════════════════════════════

router.get("/:classroomId/analytics", async (req, res) => {
  const { classroomId } = req.params;
  try {
    const classroom = await Classroom.findOne({ classroomId }).lean();
    const posts = await Post.find({ classroomId }).lean();
    const submissions = await Submission.find({ classroomId }).lean();
    const sessions = await SessionLog.find({ classroomId }).lean();

    const students =
      classroom?.members?.filter((m) => m.role === "student") || [];
    // FIX: only include assignments with points > 0 to prevent division by zero
    const assignments = posts.filter(
      (p) => p.type === "assignment" && p.points != null && p.points > 0,
    );

    const studentStats = students.map((s) => {
      const mySubs = submissions.filter((sub) => sub.studentId === s.userId);
      const graded = mySubs.filter((sub) => sub.grade != null);
      const avgGrade = graded.length
        ? graded.reduce((a, sub) => {
            const p = posts.find((x) => x.postId === sub.postId);
            const pct = (sub.grade / safePts(p?.points)) * 100;
            return a + (isFinite(pct) ? pct : 0);
          }, 0) / graded.length
        : null;
      return {
        userId: s.userId,
        userName: s.userName,
        avgGrade,
        submitted: mySubs.length,
        missing: assignments.filter(
          (a) => !mySubs.find((sub) => sub.postId === a.postId),
        ).length,
        late: mySubs.filter((sub) => sub.status === "late").length,
        graded: graded.length,
      };
    });

    const assignmentStats = assignments.map((a) => {
      const subs = submissions.filter((sub) => sub.postId === a.postId);
      const graded = subs.filter((sub) => sub.grade != null);
      const avgGrade = graded.length
        ? graded.reduce(
            (acc, s) => acc + (s.grade / safePts(a.points)) * 100,
            0,
          ) / graded.length
        : null;
      const submissionRate = students.length
        ? Math.round((subs.length / students.length) * 100)
        : 0;
      return {
        postId: a.postId,
        title: a.title,
        totalStudents: students.length,
        submitted: subs.length,
        graded: graded.length,
        avgGrade,
        points: a.points,
        submissionRate,
      };
    });

    const sessionStats = sessions.map((s) => ({
      sessionId: s.sessionId || s._id,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      attendeeCount: s.attendees?.length || 0,
      duration:
        s.startedAt && s.endedAt
          ? Math.round((new Date(s.endedAt) - new Date(s.startedAt)) / 60000)
          : null,
    }));

    const allGrades = submissions
      .filter((s) => s.grade != null)
      .map((s) => {
        const post = posts.find((p) => p.postId === s.postId);
        return (s.grade / safePts(post?.points)) * 100;
      })
      .filter((g) => isFinite(g) && !isNaN(g));

    const distribution = { A: 0, B: 0, C: 0, D: 0, F: 0 };
    allGrades.forEach((g) => {
      if (g >= 90) distribution.A++;
      else if (g >= 80) distribution.B++;
      else if (g >= 70) distribution.C++;
      else if (g >= 60) distribution.D++;
      else distribution.F++;
    });

    const expectedSubs = students.length * assignments.length;
    const submissionRate = expectedSubs
      ? Math.round((submissions.length / expectedSubs) * 100)
      : 0;
    const classAvg = allGrades.length
      ? Number(
          (allGrades.reduce((a, b) => a + b, 0) / allGrades.length).toFixed(1),
        )
      : null;

    const byAssignment = {};
    for (const a of assignmentStats) {
      byAssignment[a.postId] = {
        submissionRate: a.submissionRate,
        avgGrade: a.avgGrade,
        submitted: a.submitted,
      };
    }

    const atRisk = studentStats
      .filter(
        (s) =>
          (s.avgGrade != null && s.avgGrade < 60) ||
          s.missing >= Math.max(1, Math.floor(assignments.length / 2)),
      )
      .map((s) => ({
        userId: s.userId,
        userName: s.userName,
        avgGrade: s.avgGrade,
        missing: s.missing,
      }));

    res.json({
      studentStats,
      assignmentStats,
      sessionStats,
      distribution,
      gradeDistribution: {
        "A (90-100)": distribution.A,
        "B (80-89)": distribution.B,
        "C (70-79)": distribution.C,
        "D (60-69)": distribution.D,
        "F (<60)": distribution.F,
      },
      byAssignment,
      submissionRate,
      averageGrade: classAvg,
      totalStudents: students.length,
      totalSessions: sessions.length,
      classAvg,
      atRisk,
      attendanceTrend: sessionStats.map((s) => ({
        sessionId: s.sessionId,
        attendeeCount: s.attendeeCount,
        startedAt: s.startedAt,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ATTENDANCE
// ═════════════════════════════════════════════════════════════════════════════

router.get("/:classroomId/attendance", async (req, res) => {
  try {
    const records = await Attendance.find({
      classroomId: req.params.classroomId,
    })
      .lean()
      .sort({ date: -1 });
    res.json(records);
  } catch {
    res.json([]);
  }
});

router.post("/:classroomId/attendance", async (req, res) => {
  const { sessionId, date, records } = req.body;
  try {
    const existing = await Attendance.findOne({
      classroomId: req.params.classroomId,
      sessionId,
    });
    if (existing) {
      existing.records = records;
      await existing.save();
      res.json(existing);
    } else {
      const a = new Attendance({
        classroomId: req.params.classroomId,
        sessionId: sessionId || uuidv4(),
        date: new Date(date),
        records,
      });
      await a.save();
      res.json(a);
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Auto-mark present from live room presence (Y1 H2). */
router.post("/:classroomId/attendance/from-presence", async (req, res) => {
  try {
    const { roomId, sessionId } = req.body;
    const { listPresence } = require("./lib/events");
    const members = await listPresence(roomId);
    const classroom = await Classroom.findOne({
      classroomId: req.params.classroomId,
    }).lean();
    const students =
      classroom?.members?.filter((m) => m.role === "student") || [];
    const presentIds = new Set(members.map((m) => m.userId));
    const records = students.map((s) => ({
      studentId: s.userId,
      studentName: s.userName,
      status: presentIds.has(s.userId) ? "present" : "absent",
      joinTime: presentIds.has(s.userId) ? new Date() : null,
    }));
    // Also mark guests in presence who aren't rostered
    for (const m of members) {
      if (!records.find((r) => r.studentId === m.userId)) {
        records.push({
          studentId: m.userId,
          studentName: m.userName,
          status: "present",
          joinTime: new Date(),
        });
      }
    }
    const existing = await Attendance.findOne({
      classroomId: req.params.classroomId,
      sessionId,
    });
    if (existing) {
      const byId = new Map(existing.records.map((r) => [r.studentId, r]));
      for (const r of records) byId.set(r.studentId, r);
      existing.records = [...byId.values()];
      await existing.save();
      return res.json(existing);
    }
    const a = await Attendance.create({
      classroomId: req.params.classroomId,
      sessionId: sessionId || uuidv4(),
      date: new Date(),
      records,
    });
    res.json(a);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Attendance accuracy study vs roster (KR3.6 light). */
router.get("/:classroomId/attendance/accuracy", async (req, res) => {
  try {
    const classroom = await Classroom.findOne({
      classroomId: req.params.classroomId,
    }).lean();
    const students =
      classroom?.members?.filter((m) => m.role === "student") || [];
    const roster = students.length;
    const rows = await Attendance.find({
      classroomId: req.params.classroomId,
    })
      .lean()
      .sort({ date: -1 })
      .limit(50);
    const sessions = rows.map((row) => {
      const present = (row.records || []).filter((r) => r.status === "present");
      const rosterPresent = present.filter((r) =>
        students.some((s) => s.userId === r.studentId),
      ).length;
      const coverage = roster
        ? Number(((rosterPresent / roster) * 100).toFixed(1))
        : null;
      return {
        sessionId: row.sessionId,
        date: row.date,
        roster,
        presentCount: present.length,
        rosterPresent,
        coveragePct: coverage,
      };
    });
    const withCov = sessions.filter((s) => s.coveragePct != null);
    const avgCoverage = withCov.length
      ? Number(
          (
            withCov.reduce((a, s) => a + s.coveragePct, 0) / withCov.length
          ).toFixed(1),
        )
      : null;
    res.json({
      classroomId: req.params.classroomId,
      rosterSize: roster,
      sessionsStudied: sessions.length,
      avgRosterCoveragePct: avgCoverage,
      targetPct: Number(process.env.ATTENDANCE_ACCURACY_TARGET || 90),
      meetsTarget:
        avgCoverage == null
          ? null
          : avgCoverage >= Number(process.env.ATTENDANCE_ACCURACY_TARGET || 90),
      sessions,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// SCHEDULED POSTS
// ═════════════════════════════════════════════════════════════════════════════

router.get("/:classroomId/scheduled", async (req, res) => {
  try {
    const posts = await ScheduledPost.find({
      classroomId: req.params.classroomId,
      published: false,
    })
      .lean()
      .sort({ scheduledFor: 1 });
    res.json(posts);
  } catch {
    res.json([]);
  }
});

router.post("/:classroomId/scheduled", async (req, res) => {
  const {
    body,
    title,
    type,
    scheduledFor,
    attachments,
    dueDate,
    points,
    topic,
  } = req.body;
  if (!scheduledFor) {
    return res.status(400).json({ error: "scheduledFor required" });
  }
  try {
    const sp = new ScheduledPost({
      classroomId: req.params.classroomId,
      body: body || "",
      title: title || "",
      type: type || "announcement",
      scheduledFor: new Date(scheduledFor),
      attachments: parseMaybeJSON(attachments) || [],
      dueDate: dueDate ? new Date(dueDate) : undefined,
      points: points ? Number(points) : undefined,
      topic: topic || "",
      authorId: req.user.id,
      authorName: req.user.name,
    });
    await sp.save();
    res.json(sp);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/:classroomId/scheduled/:id", async (req, res) => {
  try {
    await ScheduledPost.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch {
    res.json({ ok: false });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// STUDENT PROGRESS
// ═════════════════════════════════════════════════════════════════════════════

router.get("/:classroomId/students/:studentId/progress", async (req, res) => {
  const { classroomId, studentId } = req.params;
  try {
    const posts = await Post.find({
      classroomId,
      type: { $in: ["assignment", "quiz"] },
    }).lean();
    const subs = await Submission.find({ classroomId, studentId }).lean();
    const items = posts.map((p) => {
      const sub = subs.find((s) => s.postId === p.postId);
      return {
        postId: p.postId,
        title: p.title,
        type: p.type,
        dueDate: p.dueDate,
        points: p.points,
        sub: sub
          ? {
              grade: sub.grade,
              status: sub.status,
              submittedAt: sub.submittedAt,
              feedback: sub.feedback,
            }
          : null,
      };
    });
    const graded = items.filter((i) => i.sub?.grade != null);
    const avg = graded.length
      ? (
          graded.reduce(
            (a, i) => a + (i.sub.grade / safePts(i.points)) * 100,
            0,
          ) / graded.length
        ).toFixed(1)
      : null;
    res.json({
      items,
      avg,
      submitted: subs.length,
      missing: posts.length - subs.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
