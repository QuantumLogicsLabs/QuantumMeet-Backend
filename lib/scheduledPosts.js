const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * Publish due ScheduledPost rows into the classroom Post feed.
 * Requires classroom models already registered (index mounts classroom.js first).
 *
 * Runs from the daily cron (Vercel Hobby only allows daily crons) and lazily
 * whenever a classroom feed is read, so each row is claimed atomically —
 * concurrent callers can never publish the same post twice.
 *
 * @param {{ classroomId?: string, limit?: number }} [opts]
 */
async function publishDueScheduledPosts({ classroomId, limit = 100 } = {}) {
  const ScheduledPost = mongoose.model("ScheduledPost");
  const Post = mongoose.model("Post");

  const filter = { published: false, scheduledFor: { $lte: new Date() } };
  if (classroomId) filter.classroomId = classroomId;

  const published = [];
  for (let i = 0; i < limit; i += 1) {
    const sp = await ScheduledPost.findOneAndUpdate(
      filter,
      { $set: { published: true } },
      { sort: { scheduledFor: 1 }, new: true },
    );
    if (!sp) break;
    try {
      await Post.create({
        postId: uuidv4(),
        classroomId: sp.classroomId,
        type: sp.type || "announcement",
        title: sp.title || "",
        body: sp.body || "",
        authorId: sp.authorId,
        authorName: sp.authorName,
        attachments: sp.attachments || [],
        dueDate: sp.dueDate,
        points: sp.points,
        topic: sp.topic || "",
      });
    } catch (err) {
      // Release the claim so the next run retries this row.
      await ScheduledPost.updateOne(
        { _id: sp._id },
        { $set: { published: false } },
      ).catch(() => {});
      throw err;
    }
    published.push(sp._id.toString());
  }
  return { count: published.length, ids: published };
}

module.exports = { publishDueScheduledPosts };
