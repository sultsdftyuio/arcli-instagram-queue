// End-to-end test of crosspost.mjs against a local mock of Threads, Google/YouTube, TikTok and LinkedIn.
//   node test/crosspost-mock.mjs
// Copies the scripts into a temp folder with a fake posted Reel, runs crosspost.mjs there, and checks
// that each platform got the right calls, that the queue records the results, and that the video
// file is deleted only after every platform is done.
import { createServer } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const calls = [];
let videoBytes = 0;
let tiktokRotated = false;

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  calls.push(`${req.method} ${path}`);
  const json = (obj, headers = {}) => {
    res.writeHead(200, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(obj));
  };
  const base = `http://127.0.0.1:${server.address().port}`;
  // Threads
  if (path === "/v1.0/42/threads" && req.method === "POST") {
    const form = new URLSearchParams(body.toString());
    assert.equal(form.get("media_type"), "VIDEO");
    assert.match(form.get("video_url"), /media\/test-reel\.mp4$/);
    return json({ id: "c1" });
  }
  if (path === "/v1.0/c1") return json({ status: "FINISHED" });
  if (path === "/v1.0/42/threads_publish") return json({ id: "t1" });
  if (path === "/v1.0/t1") return json({ permalink: "https://threads.net/@arcli/post/t1" });
  // Google token and YouTube resumable upload
  if (path === "/token") return json({ access_token: "ya29.mock" });
  if (path === "/upload/youtube/v3/videos" && req.method === "POST") {
    const meta = JSON.parse(body.toString());
    assert.equal(meta.status.privacyStatus, "public");
    assert.match(meta.snippet.description, /#Shorts/);
    assert.ok(meta.snippet.tags.includes("founders"));
    res.writeHead(200, { Location: `${base}/yt-session` });
    return res.end();
  }
  if (path === "/yt-session") {
    videoBytes = body.length;
    return json({ id: "yt123", status: { privacyStatus: "private" } });
  }
  // TikTok
  if (path === "/v2/oauth/token/") {
    tiktokRotated = true;
    return json({ access_token: "act.mock", refresh_token: "rft.new" });
  }
  if (path === "/v2/post/publish/inbox/video/init/") {
    const b = JSON.parse(body.toString());
    assert.equal(b.source_info.source, "FILE_UPLOAD");
    assert.equal(b.source_info.total_chunk_count, 1);
    return json({ data: { publish_id: "p1", upload_url: `${base}/tt-upload` }, error: { code: "ok" } });
  }
  if (path === "/tt-upload") {
    assert.match(req.headers["content-range"], /^bytes 0-\d+\/\d+$/);
    res.writeHead(201);
    return res.end();
  }
  if (path === "/v2/post/publish/status/fetch/") return json({ data: { status: "SEND_TO_USER_INBOX" }, error: { code: "ok" } });
  // LinkedIn
  if (path === "/rest/videos" && url.searchParams.get("action") === "initializeUpload") {
    assert.equal(req.headers["linkedin-version"], "202609");
    return json({ value: { video: "urn:li:video:v1", uploadToken: "", uploadInstructions: [{ uploadUrl: `${base}/li-part`, firstByte: 0, lastByte: videoBytes - 1 }] } });
  }
  if (path === "/li-part") {
    res.writeHead(200, { etag: "etag-1" });
    return res.end();
  }
  if (path === "/rest/videos" && url.searchParams.get("action") === "finalizeUpload") {
    assert.deepEqual(JSON.parse(body.toString()).finalizeUploadRequest.uploadedPartIds, ["etag-1"]);
    return json({});
  }
  if (path.startsWith("/rest/videos/")) return json({ status: "AVAILABLE" });
  if (path === "/rest/posts") {
    const p = JSON.parse(body.toString());
    assert.equal(p.author, "urn:li:person:abc");
    assert.match(p.commentary, /\{hashtag\|\\#\|founders\}/);
    assert.match(p.commentary, /\\\(/);
    res.writeHead(201, { "x-restli-id": "urn:li:share:9" });
    return res.end();
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: `no mock for ${req.method} ${path}` } }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const dir = mkdtempSync(join(tmpdir(), "crosspost-"));
cpSync(join(repo, "scripts"), join(dir, "scripts"), { recursive: true });
cpSync(join(repo, "config.json"), join(dir, "config.json"));
mkdirSync(join(dir, "media"));
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=navy:s=360x640:d=3", "-f", "lavfi", "-i", "sine=d=3", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(dir, "media", "test-reel.mp4")]);
const caption = "we've all paid for a \"94% SURE\" card (a test)\n\narcli.tech\n\n#founders #smallbusiness";
writeFileSync(join(dir, "queue.json"), JSON.stringify({
  posts: [
    { id: "test-reel", file: "test-reel.mp4", caption, publishAt: "2026-01-01T00:00:00Z", status: "posted", cross: { threads: "pending", youtube: "pending", tiktok: "pending", linkedin: "pending" } },
    { id: "old-reel", file: "old.mp4", caption, publishAt: "2025-01-01T00:00:00Z", status: "posted" },
  ],
}));

const env = {
  ...process.env,
  CROSS_POLL_MS: "10",
  THREADS_API_BASE: base, THREADS_ACCESS_TOKEN: "th", THREADS_USER_ID: "42",
  YT_OAUTH_BASE: base, YT_UPLOAD_BASE: base, YT_CLIENT_ID: "id", YT_CLIENT_SECRET: "s", YT_REFRESH_TOKEN: "r",
  TIKTOK_API_BASE: base, TIKTOK_CLIENT_KEY: "k", TIKTOK_CLIENT_SECRET: "s", TIKTOK_REFRESH_TOKEN: "rft.old",
  LINKEDIN_API_BASE: base, LINKEDIN_ACCESS_TOKEN: "li", LINKEDIN_AUTHOR: "urn:li:person:abc",
  GH_TOKEN: "", GITHUB_REPOSITORY: "",
};
// async, so this process can keep answering as the mock server
const { stdout: out } = await run("node", ["scripts/crosspost.mjs"], { cwd: dir, env });
console.log(out.trim());
const q = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
const post = q.posts[0];
assert.deepEqual(post.cross, { threads: "posted", youtube: "posted", tiktok: "drafted", linkedin: "posted" });
assert.equal(post.crossUrl.youtube, "https://www.youtube.com/shorts/yt123");
assert.equal(post.crossUrl.linkedin, "https://www.linkedin.com/feed/update/urn:li:share:9/");
assert.match(post.crossNote.youtube, /private/);
assert.ok(tiktokRotated);
assert.ok(videoBytes > 1000);
assert.ok(!existsSync(join(dir, "media", "test-reel.mp4")), "video should be deleted once every platform is done");
assert.equal(q.posts[1].cross, undefined, "posts from before cross-posting are left alone");

// a platform that is not connected is skipped, and a second run sends nothing again
q.posts[0].cross = { threads: "posted", youtube: "pending" };
writeFileSync(join(dir, "queue.json"), JSON.stringify(q));
calls.length = 0;
await run("node", ["scripts/crosspost.mjs"], { cwd: dir, env: { ...env, YT_REFRESH_TOKEN: "" } });
const q2 = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
assert.equal(q2.posts[0].cross.youtube, "skipped");
assert.equal(calls.length, 0);
server.close();
console.log("crosspost mock test: all checks passed");
