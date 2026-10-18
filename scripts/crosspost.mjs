// Sends every Reel that is live on Instagram to the other platforms listed in its `cross` field.
// Run by .github/workflows/publish.yml after publish.mjs; pass --dry-run to see what would go out.
//
// post.cross looks like { threads: "pending", youtube: "posted", ... } and is set by queue.mjs from
// config.crossPost when the post is added. A platform whose secrets are not set is marked "skipped",
// so the video file is not kept forever. Final states: posted, drafted, failed, skipped.
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { root, config, queue, saveQueue } from "./lib.mjs";
import { platforms } from "./platforms.mjs";

const dryRun = process.argv.includes("--dry-run");
const FINAL = new Set(["posted", "drafted", "failed", "skipped"]);
const maxTries = 3;

let failed = false;
for (const post of queue.posts) {
  if (post.status !== "posted" || !post.cross) continue;
  const file = fileURLToPath(new URL(`media/${post.file}`, root));
  for (const [key, state] of Object.entries(post.cross)) {
    if (FINAL.has(state)) continue;
    const platform = platforms[key];
    if (!platform) {
      post.cross[key] = "skipped";
      continue;
    }
    if (!platform.ready()) {
      post.cross[key] = "skipped";
      console.log(`${post.id}: ${platform.name} is not connected yet, skipped`);
      continue;
    }
    if (!existsSync(file)) {
      post.cross[key] = "failed";
      post.crossError = { ...post.crossError, [key]: "video file is gone" };
      continue;
    }
    if (dryRun) {
      console.log(`[dry run] ${post.id}: would send to ${platform.name}`);
      continue;
    }
    try {
      const result = await platform.publish(post, file);
      post.cross[key] = result.status;
      if (result.url) post.crossUrl = { ...post.crossUrl, [key]: result.url };
      if (result.note) post.crossNote = { ...post.crossNote, [key]: result.note };
      console.log(`${post.id}: ${platform.name} ${result.status} ${result.url ?? ""} ${result.note ?? ""}`.trim());
    } catch (err) {
      const tries = (post.crossTries?.[key] ?? 0) + 1;
      post.crossTries = { ...post.crossTries, [key]: tries };
      post.crossError = { ...post.crossError, [key]: err.message };
      if (tries >= maxTries) post.cross[key] = "failed";
      failed = true;
      console.error(`${post.id}: ${platform.name} attempt ${tries} failed, ${err.message}`);
    }
    saveQueue();
  }
  // Instagram kept the file for these; once every platform is done it can go.
  if (config.deleteMediaAfterPost && Object.values(post.cross).every((state) => FINAL.has(state))) {
    for (const name of [post.file, post.cover]) if (name) rmSync(new URL(`media/${name}`, root), { force: true });
  }
  saveQueue();
}
process.exit(failed ? 1 : 0);
