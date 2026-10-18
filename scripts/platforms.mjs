// Publishers for the platforms that follow Instagram: Threads, YouTube Shorts, TikTok (drafts) and LinkedIn.
// Each takes a queue post and the local video path, and returns { status, url?, note? }.
// Every API host can be pointed at a local mock through an environment variable (see test/crosspost-mock.mjs).
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { config, mediaUrl } from "./lib.mjs";

const env = process.env;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pollMs = Number(env.CROSS_POLL_MS || 10_000);

async function call(method, url, { headers = {}, json, form, body } = {}) {
  const options = { method, headers: { ...headers } };
  if (json) {
    options.body = JSON.stringify(json);
    options.headers["Content-Type"] = "application/json";
  } else if (form) options.body = new URLSearchParams(form);
  else if (body) options.body = body;
  const res = await fetch(url, options);
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  const apiError = data.error && (typeof data.error === "string" || data.error.message || (data.error.code && data.error.code !== "ok"));
  if (!res.ok || apiError) {
    const message = data.error?.message || data.error_description || data.message || (typeof data.error === "string" ? data.error : "") || `HTTP ${res.status}`;
    const err = new Error(`${method} ${new URL(url).pathname}: ${message}`);
    err.status = res.status;
    throw err;
  }
  return { data, headers: res.headers };
}

// GitHub Actions can update a secret (a rotated token) when GH_TOKEN is the GH_PAT secret.
export function storeSecret(name, value) {
  if (!env.GH_TOKEN || !env.GITHUB_REPOSITORY) {
    console.log(`(could not store ${name}: GH_TOKEN or GITHUB_REPOSITORY missing)`);
    return;
  }
  console.log(`::add-mask::${value}`);
  execFileSync("gh", ["secret", "set", name, "--repo", env.GITHUB_REPOSITORY], { input: value, stdio: ["pipe", "inherit", "inherit"] });
}

const firstLine = (caption) => caption.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
const hashtags = (caption) => (caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((tag) => tag.slice(1));

// ---------------- Threads: same pattern as Instagram, the video is fetched from the Pages URL
const THREADS = env.THREADS_API_BASE || "https://graph.threads.net";

export const threads = {
  name: "Threads",
  ready: () => Boolean(env.THREADS_ACCESS_TOKEN),
  async publish(post) {
    const auth = { Authorization: `Bearer ${env.THREADS_ACCESS_TOKEN}` };
    const user = env.THREADS_USER_ID || "me";
    const text = post.caption.length > 500 ? post.caption.slice(0, 497) + "..." : post.caption;
    const { data: container } = await call("POST", `${THREADS}/v1.0/${user}/threads`, {
      headers: auth,
      form: { media_type: "VIDEO", video_url: mediaUrl(post.file), text },
    });
    let state;
    for (let i = 0; i < 40; i++) {
      await sleep(pollMs);
      ({ data: state } = await call("GET", `${THREADS}/v1.0/${container.id}?fields=status,error_message`, { headers: auth }));
      if (state.status !== "IN_PROGRESS") break;
    }
    if (state.status !== "FINISHED") throw new Error(`Threads could not process the video: ${state.status} ${state.error_message ?? ""}`.trim());
    const { data: published } = await call("POST", `${THREADS}/v1.0/${user}/threads_publish`, { headers: auth, form: { creation_id: container.id } });
    const { data: media } = await call("GET", `${THREADS}/v1.0/${published.id}?fields=permalink`, { headers: auth }).catch(() => ({ data: {} }));
    return { status: "posted", url: media.permalink };
  },
};

// ---------------- YouTube Shorts: a resumable upload with a fresh access token from the refresh token
const GOOGLE_OAUTH = env.YT_OAUTH_BASE || "https://oauth2.googleapis.com";
const YT_UPLOAD = env.YT_UPLOAD_BASE || "https://www.googleapis.com";

export const youtube = {
  name: "YouTube Shorts",
  ready: () => Boolean(env.YT_CLIENT_ID && env.YT_CLIENT_SECRET && env.YT_REFRESH_TOKEN),
  async publish(post, file) {
    const { data: tok } = await call("POST", `${GOOGLE_OAUTH}/token`, {
      form: { client_id: env.YT_CLIENT_ID, client_secret: env.YT_CLIENT_SECRET, refresh_token: env.YT_REFRESH_TOKEN, grant_type: "refresh_token" },
    });
    const auth = { Authorization: `Bearer ${tok.access_token}` };
    const size = statSync(file).size;
    let title = firstLine(post.caption).replace(/[<>]/g, "");
    if (title.length > 90) title = title.slice(0, 87) + "...";
    const description = `${post.caption}\n\n#Shorts`;
    const { headers } = await call("POST", `${YT_UPLOAD}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, {
      headers: { ...auth, "X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": String(size) },
      json: {
        snippet: { title, description, tags: hashtags(post.caption).slice(0, 15), categoryId: "22" },
        status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
      },
    });
    const { data: video } = await call("PUT", headers.get("location"), {
      headers: { ...auth, "Content-Type": "video/mp4", "Content-Length": String(size) },
      body: readFileSync(file),
    });
    const privacy = video.status?.privacyStatus;
    return {
      status: "posted",
      url: `https://www.youtube.com/shorts/${video.id}`,
      note: privacy && privacy !== "public" ? `YouTube set it to ${privacy} (the app has not passed Google's audit yet)` : undefined,
    };
  },
};

// ---------------- TikTok: sent to the creator's drafts (inbox) until the app passes TikTok's review
const TIKTOK = env.TIKTOK_API_BASE || "https://open.tiktokapis.com";

export const tiktok = {
  name: "TikTok",
  ready: () => Boolean(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET && env.TIKTOK_REFRESH_TOKEN),
  async publish(post, file) {
    const { data: tok } = await call("POST", `${TIKTOK}/v2/oauth/token/`, {
      form: { client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: env.TIKTOK_REFRESH_TOKEN },
    });
    // TikTok may hand back a new refresh token; keep it, or the next run would fail.
    if (tok.refresh_token && tok.refresh_token !== env.TIKTOK_REFRESH_TOKEN) {
      storeSecret("TIKTOK_REFRESH_TOKEN", tok.refresh_token);
      env.TIKTOK_REFRESH_TOKEN = tok.refresh_token;
    }
    const auth = { Authorization: `Bearer ${tok.access_token}` };
    const size = statSync(file).size;
    if (size > 64 * 1024 * 1024) throw new Error("video is over 64 MB, which needs a chunked TikTok upload");
    const { data: init } = await call("POST", `${TIKTOK}/v2/post/publish/inbox/video/init/`, {
      headers: auth,
      json: { source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: size, total_chunk_count: 1 } },
    });
    await call("PUT", init.data.upload_url, {
      headers: { "Content-Type": "video/mp4", "Content-Length": String(size), "Content-Range": `bytes 0-${size - 1}/${size}` },
      body: readFileSync(file),
    });
    let status;
    for (let i = 0; i < 30; i++) {
      await sleep(pollMs);
      const { data } = await call("POST", `${TIKTOK}/v2/post/publish/status/fetch/`, { headers: auth, json: { publish_id: init.data.publish_id } });
      status = data.data?.status;
      if (status && !["PROCESSING_UPLOAD", "PROCESSING_DOWNLOAD"].includes(status)) break;
    }
    if (status === "FAILED") throw new Error("TikTok could not process the video");
    return { status: "drafted", note: "in your TikTok inbox: open the notification, add the caption and post it" };
  },
};

// ---------------- LinkedIn: upload through the Videos API, then a post on the member's feed
const LINKEDIN = env.LINKEDIN_API_BASE || "https://api.linkedin.com";
// LinkedIn's "little text": these characters must be escaped, and hashtags written as templates.
function littleText(caption) {
  const tags = [];
  const marked = caption.replace(/#([\p{L}\p{N}_]+)/gu, (_, tag) => `\u0000${tags.push(tag) - 1}\u0000`);
  const escaped = marked.replace(/[\\|{}@[\]()<>#*_~]/g, (ch) => `\\${ch}`);
  return escaped.replace(/\u0000(\d+)\u0000/g, (_, i) => `{hashtag|\\#|${tags[i]}}`);
}

export const linkedin = {
  name: "LinkedIn",
  ready: () => Boolean(env.LINKEDIN_ACCESS_TOKEN && env.LINKEDIN_AUTHOR),
  async publish(post, file) {
    const headers = {
      Authorization: `Bearer ${env.LINKEDIN_ACCESS_TOKEN}`,
      "LinkedIn-Version": config.linkedinVersion || "202609",
      "X-Restli-Protocol-Version": "2.0.0",
    };
    const bytes = readFileSync(file);
    const { data: init } = await call("POST", `${LINKEDIN}/rest/videos?action=initializeUpload`, {
      headers,
      json: { initializeUploadRequest: { owner: env.LINKEDIN_AUTHOR, fileSizeBytes: bytes.length, uploadCaptions: false, uploadThumbnail: false } },
    });
    const { video, uploadInstructions, uploadToken } = init.value;
    const etags = [];
    for (const part of uploadInstructions) {
      const res = await fetch(part.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: bytes.subarray(part.firstByte, part.lastByte + 1),
      });
      if (!res.ok) throw new Error(`LinkedIn part upload failed: HTTP ${res.status}`);
      etags.push(res.headers.get("etag"));
    }
    await call("POST", `${LINKEDIN}/rest/videos?action=finalizeUpload`, {
      headers,
      json: { finalizeUploadRequest: { video, uploadToken: uploadToken ?? "", uploadedPartIds: etags } },
    });
    for (let i = 0; i < 30; i++) {
      const { data } = await call("GET", `${LINKEDIN}/rest/videos/${encodeURIComponent(video)}`, { headers });
      if (data.status === "AVAILABLE") break;
      if (data.status === "PROCESSING_FAILED") throw new Error(`LinkedIn could not process the video: ${data.processingFailureReason ?? ""}`);
      await sleep(pollMs);
    }
    const { headers: postHeaders } = await call("POST", `${LINKEDIN}/rest/posts`, {
      headers,
      json: {
        author: env.LINKEDIN_AUTHOR,
        commentary: littleText(post.caption),
        visibility: "PUBLIC",
        distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
        content: { media: { title: firstLine(post.caption).slice(0, 200), id: video } },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      },
    });
    const urn = postHeaders.get("x-restli-id");
    return { status: "posted", url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : undefined };
  },
};

export const platforms = { threads, youtube, tiktok, linkedin };
export { littleText };
