# Transcribe — Complete Step-by-Step Setup Guide

A Chrome extension + FastAPI backend that adds **📥 MP3** and **📝 Text** buttons next to every video on x.com (and twitter.com). Click MP3 to download the audio. Click Text to get an instant Whisper transcript. Multi-user via Google sign-in. Per-user transcript history.

This guide reproduces everything that was set up. Follow it from top to bottom; nothing is skipped. Wherever a value is sensitive, a placeholder like `<YOUR_GROQ_KEY>` is used.

---

## What You'll End Up With

```
┌──────────────────┐     ┌────────────────────┐     ┌──────────────────┐
│  Chrome on x.com │ ──▶ │   ngrok HTTPS URL  │ ──▶ │ FastAPI on VPS   │
│  (extension)     │     │   (free tunnel)    │     │ port 8765        │
└──────────────────┘     └────────────────────┘     └────────┬─────────┘
                                                             │
                                              ┌──────────────┼──────────────┐
                                              ▼              ▼              ▼
                                        yt-dlp ─▶ ffmpeg   Groq Whisper   SQLite
                                        (MP4→MP3 audio)    (audio→text)   (users + history)
```

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
```

Generate the JWT secret:

```bash
openssl rand -hex 32
```

Paste it into the `.env` (replacing the placeholder).

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

### Option A — SCP (Windows PowerShell, Mac, Linux)

```powershell
scp -r vijay@<YOUR_VPS_IP>:/opt/transcribe/extension C:\AI\transcribe\transcribe-extension
```

### Option B — Download a zip from the dev endpoint

The backend exposes a one-shot dev endpoint that zips the extension folder:

```
https://<YOUR_NGROK_URL>/_dev/extension.zip
```

1. Open that URL in Chrome.
2. ngrok shows an interstitial the first time per browser session — click **Visit Site**.
3. The zip downloads. Extract it to `C:\AI\transcribe\transcribe-extension` (Windows):

   ```cmd
   cmd /c tar -xf %USERPROFILE%\Downloads\transcribe-extension.zip -C C:\AI\transcribe\transcribe-extension
   ```

   ⚠ Don't use the Windows right-click → Extract All; it nests the files inside an extra folder, and Chrome won't find `manifest.json`.

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

### 14.2 Try it on a real X video

1. Go to any post on x.com that has a video.
2. Two pill buttons appear in the bottom-left of the video: **📥 MP3** and **📝 Text**.
3. Click **📝 Text** — wait ~5–30 sec depending on video length. A modal appears with:
   - The transcript
   - **Copy** — copies to clipboard
   - **Save .txt** — downloads as a text file
   - **Close**
4. Click **📥 MP3** — the audio file downloads to your default Downloads folder.
5. Open the extension popup → "Recent" lists your transcript. Click any entry to re-open it without re-running anything (cache hit).

---

## Phase 15 — How the Cache Works (No User Action Needed)

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

### "App is blocked: not allowed to sign in"

**Cause**: your Gmail isn't in the Test Users list while the app is in Testing mode.

**Fix**: Phase 5.3 — add the Gmail to **Audience → Test users**.

---

## Future Enhancements (Not Done in This Build)

Track these for later — none are required to use the tool.

1. **systemd auto-start** for backend + ngrok so the VPS reboot doesn't take the system down. A `transcribe-backend.service` + `transcribe-ngrok.service` pair, both `WantedBy=multi-user.target`.
2. **Real domain + Caddy** to replace ngrok. Then the Backend URL becomes stable, the ngrok account is no longer needed, and you can publish the extension to Chrome Web Store. Migration is just changing the **Backend URL** in extension options + adding the new redirect URI to Google.
3. **Per-user usage quota / rate limiting** — currently a single user could in theory transcribe enough video to exhaust your Groq free-tier quota.
4. **Long-video chunking** — Groq has a ~25 MB upload limit, ~30 min of MP3 at 64 kbps. For videos longer than that, chunk audio with ffmpeg and concatenate transcripts.
5. **Chrome Web Store publishing** — currently the extension is loaded "unpacked" for personal use. Publishing requires a $5 developer account, a Privacy Policy, and a different OAuth client type ("Chrome Extension").
6. **Other platforms** — yt-dlp already supports YouTube, Instagram, TikTok, Reddit, etc. Adding them is just whitelisting more domains in `manifest.json`'s `host_permissions` and `content_scripts.matches`.
7. **Audio chunked streaming** for instant feedback while transcription is in progress, instead of waiting for the full result.

---

## Quick Reference — Files and Their Roles

| File | Purpose |
|---|---|
| `backend/main.py` | FastAPI app entry, mounts routers, CORS, periodic audio cleanup, `/health`, `/_dev/extension.zip` |
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
| `extension/manifest.json` | MV3 manifest, host_permissions for x.com + ngrok wildcards |
| `extension/background.js` | Service worker: Google OAuth via `chrome.identity.launchWebAuthFlow`, API calls (with `ngrok-skip-browser-warning` header) |
| `extension/content.js` | MutationObserver finds `<video>` elements on x.com, injects buttons, shows modal |
| `extension/content.css` | Button + modal styling |
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
