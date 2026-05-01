# open-transcribe — Complete Step-by-Step Setup Guide

A Chrome extension + FastAPI backend offering two tools that share the same auth and infrastructure:

1. **Video transcription** — `📥 MP3` / `📝 Text` buttons next to every video on x.com, twitter.com, and youtube.com (watch pages, Shorts, and feed thumbnails). Click MP3 to download the audio; click Text for an instant Whisper transcript.
2. **X bookmarks → second-brain archive** — one-click export of `x.com/i/bookmarks` to a folder of Obsidian/Notion-ready Markdown with full article bodies, threads, top-20 comments, YAML frontmatter, and a CSV index. Auto-syncs ongoing bookmarks. Phases 1–14 cover transcription. **Phase 15** covers the bookmarks setup.

Multi-user via Google sign-in. Per-user transcript history.

This guide reproduces everything that was set up. Follow it from top to bottom; nothing is skipped. Wherever a value is sensitive, a placeholder like `<YOUR_GROQ_KEY>` is used.

---

## What You'll End Up With

```
                   ┌─────────────────────────────────────┐
                   │        Chrome on x.com / yt          │
                   │           (the extension)            │
                   └───────┬─────────────────┬───────────┘
                           │                 │
                  transcribe                bookmarks
                  (videos)                  (own data)
                           │                 │
                           ▼                 ▼
                   ┌────────────────┐   ┌─────────────────────┐
                   │  ngrok HTTPS   │   │  Local folder via   │
                   │     tunnel     │   │ File System Access  │
                   └────────┬───────┘   │  API (no server     │
                            │           │  round-trip for     │
                            ▼           │  the .md files)     │
                   ┌────────────────┐   └─────────────────────┘
                   │ FastAPI : 8765 │
                   └────────┬───────┘
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
       yt-dlp          Groq Whisper      SQLite
       + ffmpeg        (audio→text)     (users + history)
       (video→MP3)
            │
            ▼ (YouTube only)
       deno + EJS solver  +  cookies.txt
```

The bookmarks export does **not** round-trip the .md writes through the backend — it's all in-browser writing to a user-picked folder via the File System Access API. The backend's `/api/x/tweet` endpoint is only used as an optional fallback when X fails to render a tweet (geo-block, soft rate-limit).

---

## Prerequisites — Accounts and Hardware

### Hardware

- **A Linux VPS** (Ubuntu 22.04+ recommended). Used for: running FastAPI, yt-dlp, ngrok agent. Any cheap VPS works — even 1 vCPU / 1 GB RAM is enough because Whisper runs in Groq's cloud, not on your VPS.
- **A Windows / Mac / Linux desktop** with Chrome installed. The extension runs here.

### Accounts (all free)

| Account | Used for | Sign-up URL |
|---|---|---|
| Google (Gmail) | OAuth sign-in for the extension | already have one |
| Google Cloud Console | Create the OAuth client ID | https://console.cloud.google.com/ |
| Groq | Whisper API (free tier is plenty) | https://console.groq.com/ |
| ngrok | HTTPS tunnel to your VPS during development | https://dashboard.ngrok.com/signup |

### Software you'll need on the VPS

- Python 3.10+ (3.12 used here)
- `ffmpeg`
- `yt-dlp`
- `deno` (JS runtime needed by yt-dlp to solve YouTube's n-parameter challenge — installed in Phase 7.6)
- A user account with `sudo` access (for the apt installs)

### What you don't need

- An open inbound firewall port. ngrok works over outbound 443 only.
- A domain name. Optional later; ngrok URL is enough to start.
- A GPU. Whisper runs on Groq's servers, not yours.
- Chrome Web Store developer account. The extension is loaded "unpacked" for personal use.

---

## Phase 1 — VPS: Install System Tools

SSH into the VPS as your normal user (not root):

```bash
ssh vijay@<YOUR_VPS_IP>
```

Install the OS-level packages:

```bash
sudo apt update
sudo apt install -y ffmpeg python3-venv python3-pip
```

Verify:

```bash
ffmpeg -version | head -1
python3 --version
```

Install yt-dlp (pip is fine; the apt version is usually too old):

```bash
sudo pip3 install -U yt-dlp || pip3 install --user -U yt-dlp
which yt-dlp
```

---

## Phase 2 — VPS: Create the Project Layout

```bash
sudo mkdir -p /opt/transcribe
sudo chown $USER:$USER /opt/transcribe
cd /opt/transcribe
mkdir -p backend/routers backend/tmp_audio extension/icons
```

You should now have:

```
/opt/transcribe/
├── backend/
│   └── routers/   tmp_audio/
└── extension/
    └── icons/
```

---

## Phase 3 — VPS: Backend Source Files

Place all the backend source files under `/opt/transcribe/backend/`. The full file tree:

```
backend/
├── main.py             # FastAPI app entry, scheduler, dev zip endpoint
├── config.py           # pydantic-settings, reads .env
├── db.py               # SQLAlchemy engine + session
├── models.py           # User, Transcript ORM tables
├── schemas.py          # Pydantic request/response models
├── auth.py             # Google id_token verify + our JWT issue/verify
├── ytdl.py             # yt-dlp wrapper: extract_audio()
├── transcribe.py       # Groq Whisper wrapper
├── requirements.txt
├── .env.example
└── routers/
    ├── __init__.py
    ├── auth.py         # /api/auth/google, /api/me, /api/logout
    ├── transcribe.py   # /api/transcribe (with cache logic)
    └── history.py      # /api/history list / get / delete + /api/audio/{token}
```

The actual code for these files is in this repo. Copy them in place before continuing.

---

## Phase 4 — VPS: Python Venv + Dependencies

```bash
cd /opt/transcribe/backend
python3 -m venv venv
./venv/bin/pip install -U pip
./venv/bin/pip install -r requirements.txt
```

`requirements.txt` should pin (these are the working versions):

```
fastapi==0.115.0
uvicorn[standard]==0.30.6
sqlalchemy==2.0.30
pydantic[email]==2.7.4
pydantic-settings==2.5.2
python-dotenv==1.0.1
google-auth==2.48.0
requests==2.32.3
PyJWT==2.9.0
groq>=0.13.0
yt-dlp>=2024.10.0
python-multipart==0.0.9
apscheduler==3.10.4
```

> **Why `groq>=0.13.0`?** Older `groq` versions (0.11 and below) pass a `proxies` keyword to httpx that newer httpx (0.28+) removed. You'll get `TypeError: Client.__init__() got an unexpected keyword argument 'proxies'` if the SDK is too old.

> **Why `requests` is in there?** It's a transitive dependency of `google-auth`'s HTTP transport. Installing google-auth alone does *not* pull it in.

---

## Phase 5 — Google Cloud: Create the OAuth Client

This is what lets users sign in to the extension with their Google account.

> **Note**: If you let Claude drive your browser, this whole phase can be automated via the Claude-in-Chrome extension. Manual steps below either way.

### 5.1 Create a project

1. Open https://console.cloud.google.com/projectcreate
2. **Project name**: `Transcribe`
3. (You can leave Billing account on whatever default — OAuth client creation has zero cost. No billing or credit card is required for sign-in to work.)
4. Click **Create** and wait ~10 sec.

### 5.2 Configure the Auth Platform (consent screen)

1. From the project, go to **APIs & Services → OAuth consent screen** (newer console: **Google Auth Platform → Branding**).
2. Click **Get started**.
3. **Step 1 — App Information**:
   - App name: `Transcribe`
   - User support email: your Gmail
   - Click **Next**
4. **Step 2 — Audience**: Select **External**. Click **Next**.
5. **Step 3 — Contact Information**: Add your Gmail. Click **Next**.
6. **Step 4 — Finish**: Tick "I agree to the Google API Services: User Data Policy" → click **Continue** → **Create**.

### 5.3 Add yourself as a test user

While the app is in Testing mode (it stays there until you submit for verification, which is unnecessary for personal use), only test users can sign in.

1. Left sidebar → **Audience**.
2. Under **Test users**, click **+ Add users**.
3. Enter `your-gmail@gmail.com` (the one you'll sign in with). Add your wife's, friends', etc., if they should also be able to use the extension. Up to 100 test users.
4. Click **Save**.

### 5.4 Create the OAuth Web Application client

1. Left sidebar → **Clients** → **+ Create client**.
2. **Application type**: **Web application** (NOT "Chrome Extension" — yes, this is counter-intuitive but the chromiumapp.org redirect requires Web app type).
3. **Name**: `Transcribe Chrome Extension`.
4. **Leave Authorized redirect URIs empty for now.** You'll fill it in Phase 9, after you have the extension ID.
5. Click **Create**.
6. A popup shows your **Client ID** like `123456789-abc...xyz.apps.googleusercontent.com`. Copy and save it.
7. Click **OK** to close the popup.

You don't need the Client Secret. The extension uses the implicit OAuth flow which only requires the Client ID.

---

## Phase 6 — Groq: Get Your API Key

1. Sign in at https://console.groq.com (use the same Gmail).
2. Left sidebar → **API Keys** → **Create API Key** → name it `transcribe-vps`.
3. Copy the key (starts with `gsk_...`). It will only be shown once.
4. **Stay on the Free tier.** It includes Whisper API access. Free-tier rate limit for Whisper Large V3 Turbo is roughly 7,200 audio-seconds (2 hours) of transcription per hour, which you will not approach in personal use.

---

## Phase 7 — VPS: Configure `.env`

```bash
cd /opt/transcribe/backend
cp .env.example .env
chmod 600 .env
```

Edit `.env`:

```dotenv
# --- Google OAuth ---
GOOGLE_CLIENT_ID=<paste your Client ID from Phase 5.4>

# --- Groq Whisper ---
GROQ_API_KEY=<paste your gsk_... key from Phase 6>
GROQ_MODEL=whisper-large-v3-turbo

# --- Our session JWT ---
JWT_SECRET=<run `openssl rand -hex 32` and paste the output>
JWT_EXPIRE_DAYS=30

# --- Storage ---
DB_PATH=/opt/transcribe/backend/transcribe.db
TMP_AUDIO_DIR=/opt/transcribe/backend/tmp_audio
AUDIO_URL_TTL_SECONDS=3600
AUDIO_RETENTION_HOURS=24

# --- HTTP ---
ALLOWED_ORIGINS=chrome-extension://*
HOST=0.0.0.0
PORT=8765

# --- YouTube cookies (optional) ---
# Path to a yt-dlp cookies.txt for age-gated and members-only YouTube videos.
# Leave blank to skip. See Phase 8.5.
YTDL_COOKIES_PATH=
```

Generate the JWT secret:

```bash
openssl rand -hex 32
```

Paste it into the `.env` (replacing the placeholder).

---

## Phase 7.5 — VPS: YouTube cookies (required for most YouTube videos)

YouTube serves a "Sign in to confirm you're not a bot" challenge to yt-dlp running on a VPS — even on public videos. Authenticated cookies bypass it. **You will need this for ~all YouTube videos**, not just age-gated ones.

> ⚠ **Use a burner Google account, not your main one.** A `cookies.txt` is a full session token — anyone holding the file can impersonate that account on any Google service.

> ⚠ **The export procedure is non-obvious and easy to get wrong.** If you keep using YouTube in the same browser session even for a few seconds after clicking Export, YouTube rotates the tokens server-side and your exported file becomes a dead session. Steps 1, 2, and 5 below are the strict version that works.

### 7.5.1 Export cookies on your desktop

1. **Quit Chrome entirely first** — no tab anywhere should be on YouTube. (If even one tab is logged into YouTube and active, the rotation can affect the cookies you're about to export.)
2. Open a **fresh Incognito window**.
3. Sign in to YouTube with the **burner account**.
4. Open *one* YouTube tab and confirm a video plays. Don't navigate further.
5. Install the [**Get cookies.txt LOCALLY**](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc) Chrome extension. (The older `Get cookies.txt` without "LOCALLY" was forked due to spyware in some versions — use this one.)
6. Click the extension icon → URL filter set to `youtube.com` → format **Netscape** → click **Export**. You'll get `youtube.com_cookies.txt` in your Downloads.
7. **Within seconds**: close the *entire* Incognito window (not just the tab). Use Ctrl+Shift+W or click the window's X.

If transcription later fails with the bot message even after cookies are in place, the most likely cause is that step 7 wasn't fast enough or the same Chrome profile kept browsing YouTube — re-export.

### 7.5.2 Place the file on the VPS

```bash
# On your desktop:
scp ~/Downloads/youtube.com_cookies.txt vijay@<YOUR_VPS_IP>:/tmp/cookies.txt

# On the VPS:
mkdir -p /opt/transcribe/backend/data
mv /tmp/cookies.txt /opt/transcribe/backend/data/cookies.txt
chmod 600 /opt/transcribe/backend/data/cookies.txt
```

### 7.5.3 Wire it into `.env`

Edit `/opt/transcribe/backend/.env` and set:

```dotenv
YTDL_COOKIES_PATH=/opt/transcribe/backend/data/cookies.txt
```

Restart the backend (Phase 9). The next transcription attempt on YouTube uses the cookies.

### 7.5.4 When cookies expire

YouTube auth cookies live a few weeks. When transcription starts failing on YouTube with `Sign in to confirm you're not a bot…` or similar, repeat 7.5.1–7.5.2 — the file path stays the same.

### 7.5.5 Verify with yt-dlp directly

Before declaring the cookies setup done, sanity-check from the VPS shell:

```bash
cd /opt/transcribe/backend
./venv/bin/yt-dlp --cookies /opt/transcribe/backend/data/cookies.txt \
  --simulate --print "OK title: %(title)s" \
  "https://www.youtube.com/watch?v=<ANY_VIDEO_ID>"
```

If it prints the title cleanly: cookies work. If you see *"cookies are no longer valid"* or *"Sign in to confirm…"*: cookies were rotated, re-export. If you see *"Requested format is not available"* or *"n challenge solving failed"*: cookies are fine but you need Phase 7.6 (deno).

---

## Phase 7.6 — VPS: Install deno (required for YouTube)

Even with valid cookies, YouTube uses an "n parameter" JavaScript challenge to obfuscate the audio format URL. yt-dlp needs a JavaScript runtime to evaluate that challenge. Without it, yt-dlp can extract metadata but only thumbnail images, and you'll see *"Requested format is not available"* when trying to actually download audio.

yt-dlp's default JS runtime is `deno`. Install it system-wide:

```bash
curl -fsSL https://deno.land/install.sh | sudo DENO_INSTALL=/usr/local sh
deno --version  # should print "deno X.Y.Z (...)"
```

The backend (`backend/ytdl.py`) already passes `remote_components=["ejs:github"]` in its yt-dlp options, which downloads the matching challenge-solver script from yt-dlp's GitHub on first use and caches it. No additional config required.

> **Why not use the existing `node` if you have one?** yt-dlp only auto-detects `deno`. To use node you have to explicitly pass `--js-runtimes node:/usr/bin/node` per call. Installing deno is simpler and is what yt-dlp recommends.

---

## Phase 8 — VPS: Install + Authenticate ngrok

### 8.1 Install

```bash
curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null
echo "deb https://ngrok-agent.s3.amazonaws.com buster main" | sudo tee /etc/apt/sources.list.d/ngrok.list >/dev/null
sudo apt update
sudo apt install -y ngrok
ngrok version
```

### 8.2 Authenticate

1. On your desktop, sign in at https://dashboard.ngrok.com.
2. Go to **Your Authtoken** → copy the token.
3. On the VPS:

   ```bash
   ngrok config add-authtoken <YOUR_NGROK_AUTHTOKEN>
   ```

---

## Phase 9 — Start Backend + Tunnel

### 9.1 Start the backend (foreground in tmux/screen, or background)

```bash
cd /opt/transcribe/backend
./venv/bin/uvicorn main:app --host 0.0.0.0 --port 8765 --log-level info
```

> ⚠ **Do NOT use `--reload`.** uvicorn's reload mode watches the SQLite DB file, which is written on every request, which causes the app to restart mid-request and kill long-running operations like yt-dlp. The bug is silent — the request just times out.

In another terminal, verify:

```bash
curl http://127.0.0.1:8765/health
# {"ok":true}
```

### 9.2 Start the ngrok tunnel (separate terminal)

```bash
ngrok http 8765 --log=stdout
```

ngrok will print the public HTTPS URL like `https://abc123.ngrok-free.app`. Copy it. **You'll re-paste this every time ngrok restarts** — the URL changes on each restart on the free tier.

You can also fetch the URL programmatically:

```bash
curl -s http://127.0.0.1:4040/api/tunnels \
  | python3 -c "import json,sys; print(next(t['public_url'] for t in json.load(sys.stdin)['tunnels'] if t['proto']=='https'))"
```

---

## Phase 10 — Get the Extension Files to Your Desktop

The extension folder must live on your local machine (not the VPS) because Chrome loads it from disk.

### Option A — Clone the repo locally (simplest)

```bash
git clone https://github.com/contactkvijay/open-transcribe.git
```

The extension is in `open-transcribe/extension/`. Note the absolute path — you'll need it in Phase 11.

### Option B — SCP from your VPS (Windows PowerShell, Mac, Linux)

If you've already cloned the repo onto the VPS and want to copy the extension folder over:

```powershell
scp -r <USER>@<YOUR_VPS_IP>:/path/to/open-transcribe/extension C:\path\to\local\extension
```

---

## Phase 11 — Load the Extension in Chrome

1. Open `chrome://extensions/`.
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked** → navigate to `C:\AI\transcribe\transcribe-extension` → **Select Folder**.
4. The extension card appears with a name like "Transcribe (X video → text/MP3)".
5. **Copy the Extension ID** — it's a 32-character lowercase string shown on the card. Save it.

---

## Phase 12 — Wire the OAuth Redirect URI

Now that you have the extension ID, finish the OAuth client:

1. Back in Google Cloud Console → **Clients** → click on **Transcribe Chrome Extension**.
2. Under **Authorized redirect URIs**, click **+ Add URI**.
3. Paste:

   ```
   https://<YOUR_EXTENSION_ID>.chromiumapp.org/
   ```

   (Substitute your actual extension ID — keep the trailing slash.)
4. Click **Save**.

> Google says "It may take 5 minutes to a few hours for settings to take effect." In practice it's instant.

---

## Phase 13 — Configure the Extension

1. In Chrome, open the extension's options page. Either:
   - Right-click the extension's icon in the toolbar → **Options**, or
   - On `chrome://extensions/`, click **Details** on the Transcribe card → scroll → **Extension options**, or
   - Type `chrome-extension://<YOUR_EXTENSION_ID>/options.html` directly into the address bar.

2. Fill in:
   - **Backend URL**: your current ngrok URL, e.g. `https://abc123.ngrok-free.app`
   - **Google OAuth Client ID**: the one from Phase 5.4

3. Click **Save**.

---

## Phase 14 — Sign In and Smoke-Test

### 14.1 Sign in

1. Click the extension icon in Chrome's toolbar → popup opens.
2. Click **Sign in with Google**.
3. The OAuth flow opens; pick your Gmail (must be in the Test Users list from Phase 5.3).
4. Grant permission. Popup closes. The extension popup now shows your name + email + an empty "Recent" list.

### 14.2 Try transcription on a real X or YouTube video

**On X / Twitter**:
1. Go to any post on x.com that has a video.
2. Two pill buttons appear in the bottom-left of the video: **📥 MP3** and **📝 Text**.

**On YouTube**:
1. Open any YouTube watch page. **📥 MP3** and **📝 Text** chips appear in the action row alongside Like / Share / Save.
2. Or open a Short — the chips show in the right-side action stack.
3. Or hover any thumbnail on the home / search / channel pages — a small chip appears in the corner.

Then for either platform:

3. Click **📝 Text** — wait ~5–30 sec depending on video length. A modal appears with:
   - The transcript
   - **Copy** — copies to clipboard
   - **Save .txt** — downloads as a text file
   - **Close**
4. Click **📥 MP3** — the audio file downloads to your default Downloads folder.
5. Open the extension popup → "Recent" lists your transcript. Click any entry to re-open it without re-running anything (cache hit).

---

## Phase 15 — Bookmarks Archive Setup (X Bookmarks → Folder of .md)

The same extension also exports your X bookmarks (`x.com/i/bookmarks`) to a folder of Obsidian/Notion-ready Markdown files. Setup is light because the .md writes happen entirely in the browser via the **File System Access API**; no backend round-trip.

### 15.1 Open `/i/bookmarks` and find the toolbar

Visit `https://x.com/i/bookmarks`. The extension injects a toolbar row directly below X's sticky header with:

| Control | Purpose |
|---|---|
| `[next 50 / 100 / 200 / all ▼]` | Batch size for one export run |
| `📥 Export` | Run deep export with the selected batch size |
| `🔍 Check` | Folder integrity check — find orphan files / orphan CSV rows |
| `📚 N captured` | Live count from the CSV in your archive folder |

### 15.2 First-time export

1. Pick a batch size from the dropdown. For your first run on 700+ bookmarks, **start with `next 50`** to verify everything works without burning a rate-limit window. You can re-run for the next 50 / 100 / etc.
2. Click **📥 Export**.
3. Native OS folder picker opens. Pick (or create) the folder where you want your archive to live — e.g. `C:\AI\xbookmarks\` or `~/X-archive/`. The extension persists the directory handle in IndexedDB; you only do this once per browser session.
4. **Phase 1** (collecting URLs): tab auto-scrolls the bookmarks list. Overlay shows `Phase 1 — collecting URLs: N`. Takes ~3 min for 700 bookmarks.
5. **Phase 1.5** (smart resume): scans your folder for already-good captures and drops those URLs from the queue.
6. **Phase 2** (per-URL navigation): tab navigates through each remaining URL one at a time, scrolls the page to load comments, captures full content. Overlay shows ETA + per-step delays + cooldown markers.
7. When done, an overlay summary appears with counts. A `_deep-export-summary.md` file is written into the folder.

> ⚠ **Don't use the tab during Phase 2.** Don't navigate, don't refresh, don't switch tabs to other x.com tabs. You CAN switch to other apps or other browser tabs to non-x.com sites — just leave THIS tab alone. ~5–10 sec per tweet, batches up to ~80 min for 700 tweets.

### 15.3 Going forward: auto-sync

After the first export, the extension monitors x.com globally:

- Click 🔖 to bookmark any tweet anywhere → a toast confirms `📁 Saved …` and the .md / CSV row appear in your folder seconds later.
- Click 🔖 again to un-bookmark → toast confirms `🗑 Removed … from CSV (.md kept)`. The .md file stays as archive; the CSV row is removed.
- Visit any previously-captured tweet's detail page → if a fuller capture is now possible, the .md is silently upgraded (with a `.before-upgrade.md` backup written first).

### 15.4 Files in your archive folder

```
C:\AI\xbookmarks\
├── 2026-04-30_authorhandle_1234567890.md       ← one per bookmark
├── 2026-04-30_authorhandle_1234567890.before-upgrade.md   (only if upgraded)
├── bookmarks.csv                                ← index, 15 columns
├── bookmarks.2026-05-01-18-30-00.csv            ← rolling backups (last 5)
├── _search.json                                 ← flat array of every capture
├── _health.csv                                  ← per-navigation timeline
└── _deep-export-summary.md                      ← latest run's stats
```

Each `.md` opens with YAML frontmatter so Obsidian / Notion treat fields as queryable properties:

```yaml
---
title: "@handle — first 60 chars of tweet…"
author: "Author Name"
handle: "handle"
posted: "2026-04-30T10:45:00.000Z"
posted_date: 2026-04-30
tweet_id: "1234567890"
permalink: "https://x.com/handle/status/1234567890"
type: tweet           # or "article" for long-form X Articles
source: x.com
bookmarked_at: "2026-05-01T18:30:00.000Z"
has_video: false
image_count: 2
has_thread: true
subpost_count: 18
thread_count: 4       ← author's continuations in replies
comment_count: 14     ← others' replies
parent_count: 0
tags: [bookmark, thread]
---
```

### 15.5 Re-running and troubleshooting bookmarks

- **Re-run after a stop**: just click **📥 Export** again. Phase 1.5 will skip everything already captured cleanly; only the truncated / missing URLs go into Phase 2. For a folder with 600/700 already complete, a re-run touches just 100 URLs.
- **X soft-rate-limited me**: extension auto-pauses 15 min on detection. If you also got a top-level "Oops" in normal browsing, the rate-limit is at X's account level; wait 30–60 min before retrying.
- **A few URLs failed**: summary panel shows `Retry N failed via backend` button on completion. Click → backend's `/api/x/tweet` endpoint hits X's syndication API and recovers what it can. Useful for geo-blocked or login-walled tweets.
- **Folder out of sync**: click **🔍 Check** in the toolbar. Modal shows orphan .md files (no CSV row) and orphan CSV rows (no .md). One-click fixers re-add or remove rows accordingly.
- **A captured .md is wrong / hand-edited and got upgraded**: look for `*.before-upgrade.md` next to it — that's the file as it was before the upgrade. Diff or restore as needed.

> ⚠ **Don't run the bookmarks export at the same time as a YouTube transcribe job.** Both make outbound requests; running them in parallel can trip the same anti-bot heuristics. Sequence them.

---

## Phase 16 — How the Cache Works (No User Action Needed)

When you click the same video's button a second time, the backend looks for an existing transcript with the same `(user_id, source_url)`:

- **Text mode**: if a saved transcript exists, returns it in **~25 ms** with no yt-dlp / Groq call.
- **MP3 mode**: if the audio file is still on disk (within `AUDIO_RETENTION_HOURS`, default 24 hr), returns the existing audio URL.
- **MP3 mode after audio expired**: re-extracts.
- **Different mode than before** (e.g. you got Text earlier and now want MP3): re-extracts since the original Text run discarded the MP3.

A background job (`apscheduler`) purges audio files older than `AUDIO_RETENTION_HOURS` once per hour and clears their DB pointer.

---

## Troubleshooting / Things That Tripped Us Up

These are the issues you might hit, in the order we hit them.

### "Backend rejected sign-in: 404 <!DOCTYPE html>" — ngrok interstitial leaked into the API call

**Cause**: ngrok's free tier shows a one-time browser warning page on first visit per session. If your extension's API calls don't include the bypass header, those calls also receive the warning page (an HTML response with status 404 for non-GET methods).

**Fix** (already applied in `extension/background.js`): every fetch sets

```js
"ngrok-skip-browser-warning": "true"
```

If you ever rebuild the extension and skip this header, you'll see the issue again.

### Backend keeps restarting; transcribe hangs and times out

**Cause**: started uvicorn with `--reload`. Watchfiles sees SQLite write activity on every API call and triggers a reload mid-request. Long-running calls (yt-dlp + Groq for a 20+ min video) get killed.

**Fix**: don't pass `--reload` to uvicorn in any deployment use. It's only safe if you watch a separate source-code-only directory.

### `TypeError: Client.__init__() got an unexpected keyword argument 'proxies'`

**Cause**: `groq` SDK version 0.11.x calls httpx with `proxies=...`. httpx 0.28 renamed it to `proxy=...`. The SDK doesn't know.

**Fix**: pin `groq>=0.13.0` in `requirements.txt` and `pip install -U groq`.

### "Failed to load extension. Manifest file is missing or unreadable"

**Cause**: the extracted folder is nested one level too deep — Windows's right-click → Extract All creates `transcribe-extension\transcribe-extension\manifest.json`.

**Fix**: extract via `tar -xf` from the command line, OR point Chrome at the inner folder.

### Extension ID changed after I removed and re-added the unpacked extension

**Cause**: unpacked extensions get a new ID if you remove + re-add. The chromiumapp.org redirect URI is bound to the old ID.

**Fix**: copy the new extension ID, then update **Authorized redirect URIs** in the Google OAuth client to `https://<NEW_EXT_ID>.chromiumapp.org/`. Keep the old one too if you want.

### ngrok URL changed after restart

**Cause**: free-tier ngrok URLs are random per restart.

**Fix**: paste the new URL into the extension's **Backend URL** option. The chromiumapp.org redirect URI does **not** change because it's the extension ID, not the ngrok URL.

### YouTube transcribes fail with "Sign in to confirm you're not a bot"

**Cause**: YouTube's anti-bot heuristics flag yt-dlp running on a VPS without a logged-in session. Hits even on public videos in many regions.

**Fix**: follow Phase 7.5 — export a `cookies.txt` from a logged-in (burner) account in Incognito, drop it on the VPS at `/opt/transcribe/backend/data/cookies.txt`, set `YTDL_COOKIES_PATH=` in `.env`, restart the backend.

When the cookies later expire (a few weeks), repeat the export — the file path stays the same.

### Cookies were exported but yt-dlp still says they're invalid

`yt-dlp` warning: *"The provided YouTube account cookies are no longer valid. They have likely been rotated in the browser as a security measure."*

**Cause**: the browser session you exported from kept browsing YouTube even for a few seconds after the export. YouTube rotates auth tokens server-side when it detects activity, which retroactively invalidates the cookies in your saved file.

**Fix**: re-export following Phase 7.5.1 strictly — Incognito window, *one* YouTube tab, click **Export**, then close the entire Incognito window within seconds. Don't refresh, don't open another video, don't switch tabs.

### YouTube fails with "Requested format is not available" or "n challenge solving failed"

**Cause**: cookies are fine, but no JavaScript runtime is installed on the VPS. YouTube uses an "n parameter" JS challenge to obfuscate the audio format URL; without a runtime, yt-dlp can only see image (thumbnail) formats and refuses to download audio.

**Fix**: install `deno` per Phase 7.6, then restart the backend. Verify with the direct yt-dlp command at the end of Phase 7.5.5.

### "Remote components challenge solver script (deno) and NPM package (deno) were skipped"

**Cause**: deno is installed but yt-dlp wasn't told it's allowed to download the challenge-solver script.

**Fix**: this is already handled by the backend (`backend/ytdl.py` passes `remote_components=["ejs:github"]`). If you see this when running `yt-dlp` directly from the shell for verification, add `--remote-components ejs:github` to the command line.

### "App is blocked: not allowed to sign in"

**Cause**: your Gmail isn't in the Test Users list while the app is in Testing mode.

**Fix**: Phase 5.3 — add the Gmail to **Audience → Test users**.

---

## Future Enhancements (Not Done in This Build)

Track these for later — none are required to use the tool.

### Infrastructure / ops
1. **systemd auto-start** for backend + ngrok so a VPS reboot doesn't take the system down. A `transcribe-backend.service` + `transcribe-ngrok.service` pair, both `WantedBy=multi-user.target`.
2. **Real domain + Caddy** to replace ngrok. Then the Backend URL becomes stable, the ngrok account is no longer needed, and you can publish the extension to Chrome Web Store.
3. **Per-user usage quota / rate limiting** — currently a single user could in theory transcribe enough video to exhaust your Groq free-tier quota.
4. **Chrome Web Store publishing** — currently loaded "unpacked" for personal use. Publishing needs a $5 developer account, Privacy Policy, and a different OAuth client type.

### Transcription
5. **Long-video chunking** — Groq has a ~25 MB upload limit, fits ~50 min of MP3 at 64 kbps. For longer videos, chunk audio with ffmpeg and concatenate transcripts.
6. **Audio chunked streaming** for instant feedback while transcription is in progress.
7. **More platforms** — x.com, twitter.com, and youtube.com are built in. yt-dlp also supports Instagram, TikTok, Reddit, etc.; adding them is whitelisting more domains in `manifest.json` and writing a small per-platform adapter in `extension/content.js` modeled on `xPlatform` / `ytPlatform`.

### Bookmarks archive
8. **AI auto-categorize / tag bookmarks** — use Groq's chat models (Llama 3 / Mixtral on free tier) to read each captured `.md` and assign tags + a top-level category, written into the YAML frontmatter. Cheap (~$0.0001/tweet) and friction-free.
9. **Local image download** — `pbs.twimg.com/media/...` URLs can rot if X reorganizes its CDN. Optionally download images into a `_media/` subfolder and rewrite `.md` links to relative paths.
10. **Walk parent chain upward** — currently captures the immediately-visible parents on a status detail page; deeper ancestors (replies-of-replies-of-replies) require clicking "Show more". Auto-click + recapture would extend the conversation context.
11. **Reply-thread expansion** — same idea for replies: virtualization gives us ~20 visible; clicking "Show more replies" + scroll could capture the full thread for high-engagement bookmarks.
12. **Search UI in the extension popup** — read `_search.json` and offer full-text search over the user's archive without opening Obsidian.
13. **Multi-user bookmark folders** — currently the IndexedDB folder handle is single-tenant per browser profile. Multi-user vault sharing would need per-user storage paths.

---

## Quick Reference — Files and Their Roles

| File | Purpose |
|---|---|
| `backend/main.py` | FastAPI app entry, mounts routers, CORS, periodic audio cleanup, `/health` |
| `backend/config.py` | Loads `.env` via pydantic-settings |
| `backend/db.py` | SQLAlchemy engine + session factory |
| `backend/models.py` | `User`, `Transcript` ORM tables |
| `backend/schemas.py` | Pydantic request/response models |
| `backend/auth.py` | Verifies Google `id_token`, mints/verifies our JWT, signs short-lived audio download tokens |
| `backend/ytdl.py` | yt-dlp wrapper that returns an MP3 path + metadata |
| `backend/transcribe.py` | Groq Whisper client wrapper |
| `backend/routers/auth.py` | `POST /api/auth/google`, `GET /api/me`, `POST /api/logout` |
| `backend/routers/transcribe.py` | `POST /api/transcribe` (with cache), `GET /api/audio/{token}` |
| `backend/routers/history.py` | `GET /api/history`, `GET /api/history/{id}`, `DELETE /api/history/{id}` |
| `backend/routers/x_tweet.py` | `GET /api/x/tweet?url=...` — syndication-API fallback for failed bookmarks; computes X's per-tweet token via a `node` subprocess to stay byte-identical with X's embed widget |
| `extension/manifest.json` | MV3 manifest, host_permissions for x.com, youtube.com + ngrok wildcards |
| `extension/background.js` | Service worker: Google OAuth via `chrome.identity.launchWebAuthFlow`, API calls (with `ngrok-skip-browser-warning` header), `fetchTweetViaBackend` handler |
| `extension/content.js` | Per-platform scanners: x.com `<video>` overlay, YouTube watch / Shorts / thumbnails. Injects buttons + shows modal. |
| `extension/content.css` | Button + modal styling |
| `extension/bookmarks.js` | `/i/bookmarks` toolbar + auto-sync + deep export pipeline (URL collection → smart-resume filter → per-tweet navigate-and-capture → retry queue → 429 auto-pause). Writes to a user-picked folder via the File System Access API. ~2000 LOC. |
| `extension/bookmarks.css` | Bookmarks toolbar, deep-export overlay, integrity-check modal, toast |
| `extension/popup.html/js/css` | Sign-in popup, recent transcripts list |
| `extension/options.html/js` | Settings page (Backend URL, Google Client ID) |

---

## A Note on the Setup Process Itself

The original setup was driven through a Claude Code session that mixed:

- **Bash on the VPS** — installing apt packages, writing files, restarting the backend, reading logs, querying SQLite directly via Python.
- **The Claude-in-Chrome browser extension** — driving Google Cloud Console pages: creating the project, configuring the OAuth consent screen, adding test users, creating the OAuth client, adding the redirect URI. This is *much* faster than clicking by hand once it's connected.
- **Computer-use on the local Windows machine** — driving File Explorer, the Run dialog, and tar to extract the downloaded zip into the extension folder. Pure GUI work where SSH alone wasn't enough.
- **The user (you)** — anything that touched browser-internal pages (`chrome://extensions/`, the Chrome OAuth popup), accepting Google's User Data Policy, copying the extension ID. These can't be automated by Claude tools because Chrome blocks programmatic interaction with `chrome://*` and OAuth popups for security reasons.

If you reproduce this without Claude tooling, the manual steps in Phases 5, 11, 12, 13, 14 take about **15 minutes total**. The VPS-side setup (Phases 1–4, 7, 8, 9) is another **15–20 minutes** if you copy-paste commands.
