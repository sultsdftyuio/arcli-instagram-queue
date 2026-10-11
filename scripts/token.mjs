// node scripts/token.mjs check     shows which account the token belongs to
// node scripts/token.mjs refresh   swaps the token for a fresh 60-day one and
//                                  stores it as the IG_ACCESS_TOKEN repo secret
import { execFileSync } from "node:child_process";
import { ig, account } from "./lib.mjs";

const [command] = process.argv.slice(2);

if (command === "check") {
  const me = await ig("GET", "me", { fields: "user_id,username" });
  console.log(`Token works for @${me.username}.`);
  const limit = await ig("GET", `${account}/content_publishing_limit`, { fields: "quota_usage,config" }).catch(() => null);
  const usage = limit?.data?.[0];
  if (usage) console.log(`API posts in the last 24h: ${usage.quota_usage} of ${usage.config?.quota_total ?? "?"}.`);
} else if (command === "refresh") {
  // Without somewhere to store it, a refreshed token would be thrown away.
  if (!process.env.GH_TOKEN || !process.env.GITHUB_REPOSITORY) {
    console.error("GH_TOKEN (the GH_PAT secret) and GITHUB_REPOSITORY are needed to store the refreshed token.");
    process.exit(1);
  }
  const fresh = await ig("GET", "refresh_access_token", { grant_type: "ig_refresh_token" }, { versioned: false, tokenInQuery: true });
  console.log(`::add-mask::${fresh.access_token}`);
  execFileSync("gh", ["secret", "set", "IG_ACCESS_TOKEN", "--repo", process.env.GITHUB_REPOSITORY], {
    input: fresh.access_token,
    stdio: ["pipe", "inherit", "inherit"],
  });
  console.log(`Token refreshed, valid for ${Math.round(fresh.expires_in / 86_400)} more days.`);
} else {
  console.error("Commands: check, refresh");
  process.exit(1);
}
