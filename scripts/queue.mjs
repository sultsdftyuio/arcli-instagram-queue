// Manage queue.json.
//   node scripts/queue.mjs add <video> --caption-file <txt> [--id slug] [--at 2026-10-12T19:00] [--cover image.jpg] [--approve]
//   node scripts/queue.mjs approve <id> [<id>...]
//   node scripts/queue.mjs remove <id>
//   node scripts/queue.mjs list
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { root, config, queue, saveQueue } from "./lib.mjs";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "caption-file": { type: "string" },
    id: { type: "string" },
    at: { type: "string" },
    cover: { type: "string" },
    approve: { type: "boolean", default: false },
  },
});
const [command, ...args] = positionals;
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const find = (id) => queue.posts.find((post) => post.id === id) ?? fail(`No post with id "${id}".`);

// Instagram's Reel requirements, from the IG User media reference.
function checkVideo(path) {
  const probe = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], { encoding: "utf8" }),
  );
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  const problems = [];
  if (!video) return ["no video stream"];
  const [num, den] = video.avg_frame_rate.split("/").map(Number);
  const fps = num / (den || 1);
  const duration = Number(probe.format.duration);
  if (!["h264", "hevc"].includes(video.codec_name)) problems.push(`video codec is ${video.codec_name}, needs H.264 or HEVC`);
  if (video.pix_fmt !== "yuv420p") problems.push(`pixel format is ${video.pix_fmt}, needs yuv420p`);
  if (fps < 23 || fps > 60) problems.push(`frame rate is ${fps.toFixed(2)}, needs 23 to 60`);
  if (video.width > 1920) problems.push(`width is ${video.width}px, maximum is 1920`);
  if (duration < 3 || duration > 900) problems.push(`duration is ${duration.toFixed(1)}s, needs 3s to 15min`);
  if (Number(probe.format.bit_rate) > 25_000_000) problems.push("bitrate is over 25 Mbps");
  if (statSync(path).size > 300 * 1024 * 1024) problems.push("file is over 300 MB");
  if (audio) {
    if (audio.codec_name !== "aac") problems.push(`audio codec is ${audio.codec_name}, needs AAC`);
    if (Number(audio.sample_rate) > 48000) problems.push(`audio sample rate is ${audio.sample_rate}, maximum is 48000`);
    if (audio.channels > 2) problems.push(`audio has ${audio.channels} channels, maximum is 2`);
  }
  return problems;
}

function checkCaption(caption) {
  const problems = [];
  if (!caption) problems.push("caption is empty");
  if (caption.length > 2200) problems.push(`caption is ${caption.length} characters, maximum is 2200`);
  if ((caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).length > 30) problems.push("more than 30 hashtags");
  if ((caption.match(/@[\w.]+/g) ?? []).length > 20) problems.push("more than 20 mentions");
  return problems;
}

const isTaken = (publishAt) =>
  queue.posts.some(
    (post) => !["missed", "failed"].includes(post.status) && Date.parse(post.publishAt) === Date.parse(publishAt),
  );

// First configured slot that is free and far enough ahead for the upload to be live.
function nextSlot() {
  const sign = config.utcOffset.startsWith("-") ? -1 : 1;
  const [hours, minutes] = config.utcOffset.slice(1).split(":").map(Number);
  const offsetMs = sign * (hours * 60 + minutes) * 60_000;
  const earliest = Date.now() + 30 * 60_000;
  for (let day = 0; day < 365; day++) {
    const date = new Date(Date.now() + offsetMs + day * 86_400_000).toISOString().slice(0, 10);
    for (const slot of [...config.slots].sort()) {
      const publishAt = `${date}T${slot}:00${config.utcOffset}`;
      if (Date.parse(publishAt) > earliest && !isTaken(publishAt)) return publishAt;
    }
  }
}

if (command === "add") {
  const [video] = args;
  if (!video || !values["caption-file"]) fail("Usage: queue.mjs add <video> --caption-file <txt> [--id] [--at] [--cover] [--approve]");
  const id = values.id ?? basename(video, extname(video));
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) fail(`Id "${id}" must be lowercase letters, digits and dashes (it becomes part of a URL).`);
  if (queue.posts.some((post) => post.id === id)) fail(`A post with id "${id}" already exists.`);

  const caption = readFileSync(values["caption-file"], "utf8").replace(/\r\n/g, "\n").trim();
  const problems = [...checkVideo(video), ...checkCaption(caption)];
  if (problems.length) fail(`Not added:\n- ${problems.join("\n- ")}`);

  let publishAt = values.at ?? nextSlot();
  if (!/(Z|[+-]\d\d:\d\d)$/.test(publishAt)) publishAt += (publishAt.length === 16 ? ":00" : "") + config.utcOffset;
  if (Number.isNaN(Date.parse(publishAt))) fail(`Cannot read the time "${values.at}".`);
  if (Date.parse(publishAt) <= Date.now()) fail(`${publishAt} is in the past.`);
  if (isTaken(publishAt)) fail(`Another post is already scheduled for ${publishAt}.`);

  mkdirSync(new URL("media/", root), { recursive: true });
  const post = { id, file: `${id}.mp4`, caption, publishAt, status: values.approve ? "approved" : "draft" };
  // Remux only: Instagram needs the moov atom at the front of the file.
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", video, "-c", "copy", "-movflags", "+faststart", fileURLToPath(new URL(`media/${post.file}`, root))]);
  if (values.cover) {
    if (!/\.jpe?g$/i.test(values.cover)) fail("Cover must be a JPEG.");
    post.cover = `${id}.jpg`;
    copyFileSync(values.cover, new URL(`media/${post.cover}`, root));
  }
  queue.posts.push(post);
  queue.posts.sort((a, b) => Date.parse(a.publishAt) - Date.parse(b.publishAt));
  saveQueue();
  console.log(`Added ${id} as ${post.status} for ${publishAt}.`);
} else if (command === "approve") {
  if (!args.length) fail("Usage: queue.mjs approve <id> [<id>...]");
  for (const id of args) {
    const post = find(id);
    if (!["draft", "failed", "missed"].includes(post.status)) fail(`${id} is ${post.status}, not approving.`);
    if (Date.parse(post.publishAt) <= Date.now()) fail(`${id} is scheduled for ${post.publishAt}, which has passed. Remove it and add it again.`);
    post.status = "approved";
    delete post.error;
    delete post.containerId;
    console.log(`Approved ${id} for ${post.publishAt}.`);
  }
  saveQueue();
} else if (command === "remove") {
  const post = find(args[0]);
  if (post.status === "posted") fail(`${post.id} is already posted; removing it here would not take it off Instagram.`);
  for (const file of [post.file, post.cover]) if (file) rmSync(new URL(`media/${file}`, root), { force: true });
  queue.posts.splice(queue.posts.indexOf(post), 1);
  saveQueue();
  console.log(`Removed ${post.id}.`);
} else if (command === "list") {
  if (!queue.posts.length) console.log("Queue is empty.");
  for (const post of queue.posts) {
    console.log(`${post.status.padEnd(9)} ${post.publishAt}  ${post.id}${post.error ? `  (${post.error})` : ""}${post.permalink ? `  ${post.permalink}` : ""}`);
  }
} else {
  fail("Commands: add, approve, remove, list");
}
