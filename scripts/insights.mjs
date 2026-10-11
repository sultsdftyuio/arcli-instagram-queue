// Pulls performance numbers for the account's recent posts into insights/posts.json,
// most-viewed first, and prints them as a table.
//   node scripts/insights.mjs [how many recent posts, default 50]
import { mkdirSync, writeFileSync } from "node:fs";
import { root, ig, account } from "./lib.mjs";

// Some Reel metrics are refused for photos and older posts, so fall back to the common ones.
const REEL_METRICS = ["views", "reach", "likes", "comments", "shares", "saved", "total_interactions", "ig_reels_avg_watch_time", "reels_skip_rate"];
const COMMON_METRICS = ["views", "reach", "likes", "comments", "shares", "saved"];
const limit = Number(process.argv[2] || 50);

async function listMedia() {
  const media = [];
  let after;
  while (media.length < limit) {
    const page = await ig("GET", `${account}/media`, {
      fields: "id,caption,media_type,timestamp,permalink",
      limit: "50",
      ...(after && { after }),
    });
    media.push(...(page.data ?? []));
    after = page.paging?.cursors?.after;
    if (!after || !page.paging?.next) break;
  }
  return media.slice(0, limit);
}

async function metricsFor(id) {
  let lastError;
  for (const metrics of [REEL_METRICS, COMMON_METRICS]) {
    try {
      const { data = [] } = await ig("GET", `${id}/insights`, { metric: metrics.join(",") });
      return Object.fromEntries(data.map((metric) => [metric.name, metric.values?.[0]?.value ?? metric.total_value?.value ?? null]));
    } catch (err) {
      if (err.code === 190) throw err;
      lastError = err;
    }
  }
  return { error: lastError.message };
}

const posts = [];
for (const media of await listMedia()) {
  posts.push({
    id: media.id,
    type: media.media_type,
    postedAt: media.timestamp,
    permalink: media.permalink,
    caption: (media.caption ?? "").split("\n")[0].slice(0, 80),
    ...(await metricsFor(media.id)),
  });
}

if (posts.length && posts.every((post) => post.error)) {
  console.error(`Instagram returned no numbers for any post: ${posts[0].error}`);
  console.error("If this is a permission error, add instagram_business_manage_insights to the app and generate a new token.");
  process.exit(1);
}

posts.sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
mkdirSync(new URL("insights/", root), { recursive: true });
writeFileSync(new URL("insights/posts.json", root), JSON.stringify({ fetchedAt: new Date().toISOString(), posts }, null, 2) + "\n");

const cell = (value, width) => String(value ?? "-").padStart(width);
console.log(`${"views".padStart(8)}${"reach".padStart(8)}${"saves".padStart(7)}${"shares".padStart(7)}${"watch".padStart(7)}  posted      caption`);
for (const post of posts) {
  const watch = post.ig_reels_avg_watch_time ? `${(post.ig_reels_avg_watch_time / 1000).toFixed(1)}s` : "-";
  console.log(`${cell(post.views, 8)}${cell(post.reach, 8)}${cell(post.saved, 7)}${cell(post.shares, 7)}${cell(watch, 7)}  ${post.postedAt.slice(0, 10)}  ${post.error ? `(${post.error})` : post.caption}`);
}
