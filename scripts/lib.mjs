import { readFileSync, writeFileSync } from "node:fs";

export const root = new URL("../", import.meta.url);
export const config = JSON.parse(readFileSync(new URL("config.json", root), "utf8"));

const queuePath = new URL("queue.json", root);
export const queue = JSON.parse(readFileSync(queuePath, "utf8"));
export const saveQueue = () => writeFileSync(queuePath, JSON.stringify(queue, null, 2) + "\n");

// IG_API_BASE exists so the flow can be tested against a local mock.
const host = process.env.IG_API_BASE || "https://graph.instagram.com";
export const account = process.env.IG_USER_ID || "me";

export function requireToken() {
  if (!process.env.IG_ACCESS_TOKEN) {
    console.error("IG_ACCESS_TOKEN is not set.");
    process.exit(1);
  }
  return process.env.IG_ACCESS_TOKEN;
}

// The token goes in a header for normal calls so it never lands in a logged URL.
export async function ig(method, path, params = {}, { versioned = true, tokenInQuery = false } = {}) {
  const token = requireToken();
  const url = new URL(`${host}/${versioned ? config.apiVersion + "/" : ""}${path}`);
  const options = { method, headers: {} };
  if (tokenInQuery) params = { ...params, access_token: token };
  else options.headers.Authorization = `Bearer ${token}`;
  if (method === "GET") for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  else options.body = new URLSearchParams(params);

  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const err = new Error(body.error?.message || `HTTP ${res.status} from ${path}`);
    err.code = body.error?.code;
    throw err;
  }
  return body;
}

export const mediaUrl = (file) => `${config.mediaBaseUrl.replace(/\/$/, "")}/media/${file}`;
