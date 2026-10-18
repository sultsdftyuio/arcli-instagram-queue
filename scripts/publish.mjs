// Publishes every approved post in queue.json whose publishAt has passed.
// Run by .github/workflows/publish.yml; pass --dry-run to see what would go out.
import { rmSync } from "node:fs";
import { root, config, queue, saveQueue, ig, account, mediaUrl, requireToken } from "./lib.mjs";

const dryRun = process.argv.includes("--dry-run");
const pollMs = Number(process.env.IG_POLL_MS || 10_000);
const mediaWaitMs = Number(process.env.IG_MEDIA_WAIT_MS ?? 300_000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let recentMedia;
// A post can be live without the queue knowing (publish succeeded, saving the
// queue did not). Matching on caption and time stops it going out twice.
async function findLive(post) {
  recentMedia ??= (await ig("GET", `${account}/media`, { fields: "id,caption,timestamp,permalink", limit: "10" })).data ?? [];
  const earliest = Date.parse(post.publishAt) - 3_600_000;
  return recentMedia.find(
    (media) => (media.caption ?? "").trim() === post.caption.trim() && Date.parse(media.timestamp) >= earliest,
  );
}

function markPosted(post, media = {}) {
  post.status = "posted";
  post.postedAt = new Date().toISOString();
  if (media.id) post.mediaId = media.id;
  if (media.permalink) post.permalink = media.permalink;
  delete post.containerId;
  delete post.error;
  // crosspost.mjs deletes the file instead once the other platforms have it
  if (config.deleteMediaAfterPost && !post.cross) {
    for (const file of [post.file, post.cover]) if (file) rmSync(new URL(`media/${file}`, root), { force: true });
  }
  console.log(`${post.id}: posted ${post.permalink ?? ""}`);
}

async function publish(post) {
  const lateHours = (Date.now() - Date.parse(post.publishAt)) / 3_600_000;
  if (lateHours > config.maxLateHours && !post.containerId) {
    post.status = "missed";
    console.log(`${post.id}: ${lateHours.toFixed(1)}h late, marked missed instead of posting`);
    return;
  }
  if (dryRun) {
    console.log(`[dry run] ${post.id}: would publish ${mediaUrl(post.file)}`);
    return;
  }

  if (!post.containerId) {
    const live = await findLive(post);
    if (live) return markPosted(post, live);

    // A post pushed moments ago may not be served yet: GitHub Pages takes a minute or two.
    let head = await fetch(mediaUrl(post.file), { method: "HEAD" });
    for (const until = Date.now() + mediaWaitMs; !head.ok && Date.now() < until; ) {
      await sleep(15_000);
      head = await fetch(mediaUrl(post.file), { method: "HEAD" });
    }
    if (!head.ok) {
      console.log(`${post.id}: ${mediaUrl(post.file)} returned ${head.status}, will retry next run`);
      return;
    }
    const params = {
      media_type: "REELS",
      video_url: mediaUrl(post.file),
      caption: post.caption,
      share_to_feed: String(post.shareToFeed ?? true),
    };
    if (post.cover) params.cover_url = mediaUrl(post.cover);
    else if (post.thumbOffsetMs) params.thumb_offset = String(post.thumbOffsetMs);
    post.containerId = (await ig("POST", `${account}/media`, params)).id;
    saveQueue();
  }

  let container;
  for (let attempt = 0; attempt < 30; attempt++) {
    container = await ig("GET", post.containerId, { fields: "status_code,status" });
    if (container.status_code !== "IN_PROGRESS") break;
    await sleep(pollMs);
  }
  if (container.status_code === "IN_PROGRESS") {
    console.log(`${post.id}: Instagram is still processing the video, will retry next run`);
    return;
  }
  if (container.status_code === "PUBLISHED") return markPosted(post, (await findLive(post)) ?? {});
  if (container.status_code !== "FINISHED") {
    delete post.containerId;
    throw new Error(`Instagram rejected the video: ${container.status_code} ${container.status ?? ""}`.trim());
  }

  const { id } = await ig("POST", `${account}/media_publish`, { creation_id: post.containerId });
  const media = await ig("GET", id, { fields: "id,permalink" }).catch(() => ({ id }));
  markPosted(post, media);
}

if (!config.mediaBaseUrl) {
  console.error("config.json has no mediaBaseUrl yet.");
  process.exit(1);
}
if (!dryRun) requireToken();

const due = queue.posts.filter((post) => post.status === "approved" && Date.parse(post.publishAt) <= Date.now());
if (!due.length) console.log("Nothing due.");

let failed = false;
for (const post of due) {
  try {
    await publish(post);
  } catch (err) {
    // 190 is an expired or revoked token: every post would fail the same way,
    // so stop and leave the queue untouched.
    if (err.code === 190) {
      saveQueue();
      console.error(`Access token rejected: ${err.message}`);
      process.exit(1);
    }
    post.status = "failed";
    post.error = err.message;
    failed = true;
    console.error(`${post.id}: failed, ${err.message}`);
  }
  saveQueue();
}
process.exit(failed ? 1 : 0);
