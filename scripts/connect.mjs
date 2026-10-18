// One-time sign-in for each platform. Run it yourself in a terminal:
//   node scripts/connect.mjs threads | youtube | tiktok | linkedin
// It asks for the app's id and secret (from the platform's developer site), prints a sign-in link,
// and after you approve, asks for the code shown on the callback page. It then writes the values
// to .secrets/<platform>.txt (git-ignored) as NAME=value lines, to paste into the repository's
// GitHub secrets (Settings > Secrets and variables > Actions). Nothing is printed to the terminal.
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { root, config } from "./lib.mjs";

const REDIRECT = `${config.mediaBaseUrl.replace(/\/$/, "")}/callback.html`;
const rl = createInterface({ input: stdin, output: stdout });
const ask = async (q) => (await rl.question(q)).trim();
const state = Math.random().toString(36).slice(2);

async function post(url, form) {
  const res = await fetch(url, { method: "POST", body: new URLSearchParams(form) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error_description || data.error?.message || data.error || `HTTP ${res.status}`);
  return data;
}
async function get(url, headers = {}) {
  const res = await fetch(url, { headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error?.message || `HTTP ${res.status}`);
  return data;
}

const flows = {
  async threads() {
    const id = await ask("Threads app ID: ");
    const secret = await ask("Threads app secret: ");
    console.log(`\nOpen this link, approve, then copy the code:\nhttps://threads.net/oauth/authorize?client_id=${id}&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=threads_basic,threads_content_publish&response_type=code&state=${state}\n`);
    const code = await ask("Code: ");
    const short = await post("https://graph.threads.net/oauth/access_token", { client_id: id, client_secret: secret, grant_type: "authorization_code", redirect_uri: REDIRECT, code });
    const long = await get(`https://graph.threads.net/access_token?grant_type=th_exchange_token&client_secret=${secret}&access_token=${short.access_token}`);
    return { THREADS_ACCESS_TOKEN: long.access_token, THREADS_USER_ID: String(short.user_id) };
  },
  async youtube() {
    const id = await ask("Google OAuth client ID: ");
    const secret = await ask("Google OAuth client secret: ");
    const scope = encodeURIComponent("https://www.googleapis.com/auth/youtube.upload");
    console.log(`\nOpen this link, pick the channel's Google account, approve, then copy the code:\nhttps://accounts.google.com/o/oauth2/v2/auth?client_id=${id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&scope=${scope}&access_type=offline&prompt=consent&state=${state}\n`);
    const code = await ask("Code: ");
    const tok = await post("https://oauth2.googleapis.com/token", { client_id: id, client_secret: secret, code, grant_type: "authorization_code", redirect_uri: REDIRECT });
    if (!tok.refresh_token) throw new Error("Google returned no refresh token; remove the app's access at myaccount.google.com/permissions and try again.");
    return { YT_CLIENT_ID: id, YT_CLIENT_SECRET: secret, YT_REFRESH_TOKEN: tok.refresh_token };
  },
  async tiktok() {
    const key = await ask("TikTok client key: ");
    const secret = await ask("TikTok client secret: ");
    console.log(`\nOpen this link, approve, then copy the code:\nhttps://www.tiktok.com/v2/auth/authorize/?client_key=${key}&scope=user.info.basic,video.upload&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT)}&state=${state}\n`);
    const code = await ask("Code: ");
    const tok = await post("https://open.tiktokapis.com/v2/oauth/token/", { client_key: key, client_secret: secret, code: decodeURIComponent(code), grant_type: "authorization_code", redirect_uri: REDIRECT });
    return { TIKTOK_CLIENT_KEY: key, TIKTOK_CLIENT_SECRET: secret, TIKTOK_REFRESH_TOKEN: tok.refresh_token };
  },
  async linkedin() {
    const id = await ask("LinkedIn client ID: ");
    const secret = await ask("LinkedIn client secret: ");
    console.log(`\nOpen this link, approve, then copy the code:\nhttps://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${id}&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=${encodeURIComponent("openid profile w_member_social")}&state=${state}\n`);
    const code = await ask("Code: ");
    const tok = await post("https://www.linkedin.com/oauth/v2/accessToken", { grant_type: "authorization_code", code, client_id: id, client_secret: secret, redirect_uri: REDIRECT });
    const me = await get("https://api.linkedin.com/v2/userinfo", { Authorization: `Bearer ${tok.access_token}` });
    const days = Math.round((tok.expires_in ?? 0) / 86_400);
    console.log(`LinkedIn token lasts ${days} days; run this again before then.`);
    return { LINKEDIN_ACCESS_TOKEN: tok.access_token, LINKEDIN_AUTHOR: `urn:li:person:${me.sub}` };
  },
};

const name = process.argv[2];
if (!flows[name]) {
  console.error("Usage: node scripts/connect.mjs threads | youtube | tiktok | linkedin");
  process.exit(1);
}
try {
  const values = await flows[name]();
  mkdirSync(new URL(".secrets/", root), { recursive: true });
  const out = new URL(`.secrets/${name}.txt`, root);
  writeFileSync(out, Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  console.log(`\nSaved ${Object.keys(values).join(", ")} to .secrets/${name}.txt.`);
  console.log(`Add each as a repository secret, then add "${name}" to "crossPost" in config.json.`);
} catch (err) {
  console.error(`Sign-in failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  rl.close();
}
