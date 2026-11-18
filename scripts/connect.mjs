// One-time sign-in for each platform. Run it yourself in a terminal:
//   node scripts/connect.mjs threads | youtube | tiktok | linkedin | facebook
// It asks for the app's id and secret (from the platform's developer site), prints a sign-in link,
// and after you approve, asks for the code shown on the callback page. It then writes the values
// to .secrets/<platform>.txt (git-ignored) as NAME=value lines, to paste into the repository's
// GitHub secrets (Settings > Secrets and variables > Actions). Nothing is printed to the terminal.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { root, config } from "./lib.mjs";

const REDIRECT = `${config.mediaBaseUrl.replace(/\/$/, "")}/callback.html`;
const rl = createInterface({ input: stdin, output: stdout });
const ask = async (q) => (await rl.question(q)).trim();
const state = Math.random().toString(36).slice(2);

async function post(url, form) {
  // A URLSearchParams body makes fetch add ";charset=UTF-8", which TikTok rejects as malformed.
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const message = data.error_description || data.error?.message || data.error || `HTTP ${res.status}`;
    throw new Error(data.log_id ? `${message} (log_id ${data.log_id}, for the platform's support)` : message);
  }
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
    // TikTok can refuse the token exchange without PKCE, and wants the challenge as hex rather than base64url.
    const verifier = randomBytes(32).toString("hex");
    const challenge = createHash("sha256").update(verifier).digest("hex");
    console.log(`\nOpen this link, approve, then copy the code:\nhttps://www.tiktok.com/v2/auth/authorize/?client_key=${key}&scope=user.info.basic,video.upload&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT)}&state=${state}&code_challenge=${challenge}&code_challenge_method=S256\n`);
    const code = await ask("Code: ");
    const tok = await post("https://open.tiktokapis.com/v2/oauth/token/", { client_key: key, client_secret: secret, code: decodeURIComponent(code), grant_type: "authorization_code", redirect_uri: REDIRECT, code_verifier: verifier });
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
  async facebook() {
    const id = await ask("Meta app ID: ");
    const secret = await ask("Meta app secret: ");
    const configId = await ask("Facebook Login for Business configuration ID (press Enter if the app uses plain Facebook Login): ");
    const v = config.apiVersion || "v25.0";
    // Facebook Login for Business takes a configuration instead of a scope list.
    const login = configId
      ? `config_id=${encodeURIComponent(configId)}&response_type=code&override_default_response_type=true`
      : "scope=pages_show_list,pages_read_engagement,pages_manage_posts&response_type=code";
    console.log(`\nOpen this link, sign in as an admin of the game's Facebook Page, allow everything and tick the Page, then copy the code:\nhttps://www.facebook.com/${v}/dialog/oauth?client_id=${id}&redirect_uri=${encodeURIComponent(REDIRECT)}&${login}&state=${state}\n`);
    const code = await ask("Code: ");
    const graph = `https://graph.facebook.com/${v}`;
    const short = await get(`${graph}/oauth/access_token?client_id=${id}&client_secret=${secret}&redirect_uri=${encodeURIComponent(REDIRECT)}&code=${encodeURIComponent(code)}`);
    // A Page token taken from a long-lived user token does not expire.
    const long = await get(`${graph}/oauth/access_token?grant_type=fb_exchange_token&client_id=${id}&client_secret=${secret}&fb_exchange_token=${short.access_token}`);
    const { data: pages = [] } = await get(`${graph}/me/accounts?fields=id,name,access_token,tasks&access_token=${long.access_token}`);
    const usable = pages.filter((page) => page.access_token && (page.tasks ?? []).includes("CREATE_CONTENT"));
    if (!usable.length) throw new Error("no Page came back that this account can post to; tick the Page when approving, and check you are its admin");
    let page = usable[0];
    if (usable.length > 1) {
      usable.forEach((p, i) => console.log(`${i + 1}. ${p.name}`));
      page = usable[Number(await ask("Which Page should get the Reels? Number: ")) - 1];
      if (!page) throw new Error("no Page with that number");
    }
    console.log(`Reels will go to the Page "${page.name}".`);
    return { FB_PAGE_ID: page.id, FB_PAGE_TOKEN: page.access_token };
  },
};

const name = process.argv[2];
if (!flows[name]) {
  console.error("Usage: node scripts/connect.mjs threads | youtube | tiktok | linkedin | facebook");
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
