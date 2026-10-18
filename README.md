# Arcli Instagram queue

Posts approved Reels to the Arcli Instagram account at scheduled times, using the official Instagram API (Instagram Login) and GitHub Actions. Nothing here needs the laptop to be on.

- `queue.json`: every post, its caption, time and status (`draft`, `approved`, `posted`, `failed`, `missed`).
- `media/`: the video for each queued post. Deleted automatically once posted; originals stay in `../videos`.
- `captions/`: the caption text each post was added with.
- `config.json`: post times (`slots`, in the `utcOffset` time zone), API version, and the public address of `media/`.
- `.github/workflows/publish.yml`: runs every 15 minutes and publishes whatever is approved and due.
- `.github/workflows/token.yml`: renews the 60-day access token twice a month.
- `.github/workflows/insights.yml`: once a day, saves each recent post's views, reach, saves, shares and watch time to `insights/posts.json`, most-viewed first. The repository is public, so these numbers are too. Needs the `instagram_business_manage_insights` permission on the token.

Only `approved` posts are ever published. A post more than `maxLateHours` late is marked `missed` instead of going out at the wrong time.

## One-time setup

Steps 1 and 2 involve sign-ins and secrets, so they are yours to do. The Meta dashboard labels below were right in mid-2026 and may have been renamed.

### 1. GitHub

1. Create a **public** repository named `arcli-instagram-queue` (no README, no licence). It has to be public: Instagram downloads each video from a public address, and GitHub Pages provides that for free. This means a queued video can be seen by anyone who finds the repository before it is posted.
2. Tell Claude the repository address. Claude sets `mediaBaseUrl`, commits this folder and pushes it.
3. In the repository: **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)` → Save**.
4. Create a fine-grained personal access token: **GitHub profile → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**. Repository access: only `arcli-instagram-queue`. Repository permissions: **Secrets: Read and write**. Longest expiry offered.
5. In the repository: **Settings → Secrets and variables → Actions → New repository secret**. Name `GH_PAT`, value the token from step 4.

### 2. Meta

1. Go to developers.facebook.com, register as a developer if asked, then **My Apps → Create App**.
2. Use case: **Manage messaging and content on Instagram**. Finish the wizard; no business verification or app review is needed for posting to your own account.
3. In the app's left menu: **Instagram → API setup with Instagram business login** (on some dashboards this is reached through **Use cases → Customize**). Check that the permissions `instagram_business_basic` and `instagram_business_content_publish` are added.
4. In the access-token section of that page, add the Arcli Instagram account if it is not listed, click **Generate token** next to it, sign in to Instagram, and copy the token. It is valid for 60 days.

   Only if Instagram refuses the account at this point: in the left menu open **App roles → Roles → Add People**, choose **Instagram Tester**, enter the Arcli username, then accept the invitation in Instagram (**Settings → Apps and websites → Tester invites**) and generate the token again. If the token is generated without this, skip it.
5. In the GitHub repository, add a second secret: name `IG_ACCESS_TOKEN`, value the token. Do not paste the token anywhere else, including chat.

### 3. Check

In the repository's **Actions** tab:

1. **Instagram token → Run workflow → check**. The log should say `Token works for @<account>`.
2. **Publish due posts → Run workflow → dry_run ticked**. The log lists what would be published.

## Everyday use

Run from this folder.

```bash
node scripts/queue.mjs add ../videos/<film>/renders/<film>.mp4 --caption-file captions/<film>.txt
```

Adds the film as a `draft` in the next free slot (`--at 2026-10-14T19:00` picks a time, `--cover cover.jpg` sets a cover, `--approve` skips the draft stage). The video is checked against Instagram's Reel requirements first.

```bash
node scripts/queue.mjs approve <id>
```

```bash
node scripts/queue.mjs list
```

A change only takes effect once it is committed and pushed. Pull first, because the publish workflow commits status updates to `queue.json`.

## Limits

- Audio must be part of the video. Instagram's music library and trending sounds are not available through the API.
- GitHub's timer can run 5 to 30 minutes late at busy times.
- If a run fails (rejected video, expired token), GitHub emails the repository owner and the post is marked `failed` with the reason.
- Each posted video stays in the repository's git history (about 15 MB each). At two posts a day that is roughly 1 GB a month, so the storage needs revisiting after a few months.

## Other platforms (Threads, YouTube Shorts, TikTok, LinkedIn)

Once a Reel is live on Instagram, the same publish run sends it to each platform listed in
`crossPost` in `config.json` (`scripts/crosspost.mjs`, code in `scripts/platforms.mjs`). The queue
records each one under the post's `cross` field: `posted`, `drafted` (TikTok), `failed` after three
tries, or `skipped` when that platform is not connected. The video file is deleted only when every
platform is done. `queue.mjs add ... --only instagram` posts a Reel to Instagram alone.

To connect a platform:
1. Create a developer app (steps below) with this redirect URL:
   `https://sultsdftyuio.github.io/arcli-instagram-queue/callback.html`
2. Run `node scripts/connect.mjs <threads|youtube|tiktok|linkedin>` and follow it. It writes
   the values to `.secrets/<platform>.txt` (git-ignored); nothing is printed.
3. Add each line of that file as a repository secret (Settings > Secrets and variables > Actions).
4. Add the platform's name to `crossPost` in `config.json`, commit and push.

| Platform | Developer app | What to know |
|---|---|---|
| Threads | developers.facebook.com: create an app with the Threads use case; permissions `threads_basic`, `threads_content_publish`; add the Threads account as a tester | Token lasts 60 days; the token workflow renews it with the Instagram one. Caption is cut to 500 characters. |
| YouTube Shorts | console.cloud.google.com: a project with the YouTube Data API v3, OAuth consent screen (External, then **Publish app** so the refresh token does not expire after 7 days), an OAuth client of type Web application | Until the project passes Google's API audit (a free form), uploads are forced to private; the queue notes this. About 6 uploads a day on the default quota. |
| TikTok | developers.tiktok.com: an app with Login Kit and Content Posting API, scopes `user.info.basic`, `video.upload` | Before TikTok's review the Reel goes to your TikTok inbox as a draft: open the notification, add the caption and post. The refresh token rotates and is saved back automatically (needs `GH_PAT`). |
| LinkedIn | linkedin.com/developers: an app with the products "Sign In with LinkedIn using OpenID Connect" and "Share on LinkedIn" | Posts as you (a company page needs separate approval). The token lasts 60 days with no automatic renewal: run `connect.mjs linkedin` again before it runs out. |

`node test/crosspost-mock.mjs` runs the whole flow against a local mock of all four APIs.
