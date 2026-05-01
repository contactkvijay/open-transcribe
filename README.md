# open-transcribe

Two tools sharing the same Chrome extension + self-hosted FastAPI backend:

1. **Video transcription** — `📥 MP3` and `📝 Text` buttons next to videos on **x.com**, **twitter.com**, and **youtube.com** (watch pages, Shorts, and feed thumbnails). Click to download the audio or get an instant Whisper transcript.
2. **X bookmarks → second-brain archive** — one-click export of your `x.com/i/bookmarks` to a folder of Obsidian/Notion-ready Markdown files with full article bodies, conversation threads, top-20 comments, YAML frontmatter, and a CSV index. Auto-syncs each new bookmark you make going forward.

Multi-user via Google sign-in. Per-user transcript history. Built as a personal-utility weekend project. Open-sourced under MIT — fork it, run it, change the platforms, do whatever.

## Demo (transcription)

![Demo: clicking the MP3 and Text buttons on an X.com video](./Demo.gif)

<sub>(Higher quality with audio: [open the MP4 directly](./Demo.mp4).)</sub>

## Architecture

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
                   └────────┬───────┘   │      API (no        │
                            │           │   server round-trip │
                            ▼           │   for the .md files)│
                   ┌────────────────┐   └─────────────────────┘
                   │ FastAPI : 8765 │
                   └────────┬───────┘
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
       yt-dlp          Groq Whisper      SQLite
       + ffmpeg        (audio→text)     (users +
       (video→MP3)                       transcript history)
            │
            ▼ (YouTube only)
       deno + EJS solver  +  cookies.txt
```

The bookmarks feature does NOT round-trip through the backend for the .md writes — it's all in-browser, writing to a folder you pick once via the **File System Access API**. The backend is only used as an optional fallback when X fails to render a tweet (geo-block, soft rate-limit) — `/api/x/tweet` then fetches it via X's syndication endpoint.

## Highlights

- **Self-host with your own keys.** No central service. You provide a Groq key (free tier is plenty), you run the backend, your transcripts and bookmarks stay on your machines.
- **Multi-user.** Google sign-in lets you share the transcribe service with family/team without sharing API keys.
- **Cached.** Re-clicking on a previously transcribed video returns the saved transcript in ~25 ms — no re-download, no Groq call.
- **Multi-platform.** Built-in: x.com, twitter.com, youtube.com. yt-dlp supports 1000+ sites — adding more is whitelisting domains in `extension/manifest.json` and writing a small per-platform adapter in `extension/content.js`.
- **Tiny footprint.** Runs on a 1 vCPU / 1 GB RAM VPS. No GPU. Whisper happens in Groq's cloud.
- **Second-brain ready.** Bookmark exports drop straight into an Obsidian vault or Notion import — YAML frontmatter, parent-tweet wikilinks, the lot.

## Quick start

For the full step-by-step setup with Google OAuth screens and ngrok wiring, see [SETUP.md](./SETUP.md). The short version:

```bash
# On your VPS
sudo apt install -y ffmpeg
git clone https://github.com/contactkvijay/open-transcribe.git
cd open-transcribe/backend
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
cp .env.example .env
# edit .env: GOOGLE_CLIENT_ID, GROQ_API_KEY, JWT_SECRET (openssl rand -hex 32)
./venv/bin/uvicorn main:app --host 0.0.0.0 --port 8765
```

Then in another terminal:

```bash
ngrok http 8765
```

For YouTube transcription, you'll also need to install **deno** and drop a YouTube `cookies.txt` on the VPS (see [YouTube setup](#youtube-setup-required-for-most-videos) below).

On your desktop:

1. `chrome://extensions/` → Developer mode → **Load unpacked** → select the `extension/` folder.
2. Copy the extension ID, paste it into your Google OAuth client's authorized redirect URIs as `https://<EXT_ID>.chromiumapp.org/`.
3. Open the extension's options page → paste your ngrok URL and Google Client ID → Save.
4. Click the extension icon → Sign in with Google.
5. **For transcription**: visit any tweet/short with a video → click `📥 MP3` or `📝 Text`.
6. **For bookmarks export**: visit `x.com/i/bookmarks` → click `📥 Export` (a folder picker opens; pick your archive folder).

## The bookmarks-archive feature

### Workflow

1. Open `x.com/i/bookmarks` and click **📥 Export** in the toolbar that the extension injects below the X header. Pick a batch size from the dropdown (`next 50` / `next 100` / `next 200` / `all`).
2. Pick a folder via the OS folder picker. The extension persists the directory handle in IndexedDB so you only do this once.
3. Phase 1: extension auto-scrolls the bookmarks list and collects every permalink (~3 min for 700 bookmarks).
4. Phase 1.5: scans the folder for already-good captures and drops those URLs from the queue.
5. Phase 2: for each remaining URL, navigates the tab to the tweet's detail page, scrolls to load comments, captures full content, writes the `.md`. ~5–10 sec per tweet.
6. Concurrent auto-sync: every bookmark / un-bookmark click anywhere on x.com appends/removes a row in `bookmarks.csv` and writes/keeps a `.md` immediately.
7. Auto-upgrade-on-view: just visiting a previously-captured tweet's detail page (Obsidian → permalink) silently upgrades the `.md` if a fuller capture is now possible.

### What you get per bookmark

```markdown
---
title: "@authorhandle — first 60 chars of tweet text…"
author: "Author Display Name"
handle: "authorhandle"
posted: "2026-04-30T10:45:00.000Z"
posted_date: 2026-04-30
tweet_id: "1234567890"
permalink: "https://x.com/authorhandle/status/1234567890"
type: tweet               # or "article" for long-form X Articles
source: x.com
bookmarked_at: "2026-05-01T18:30:00.000Z"
has_video: false
image_count: 2
has_thread: true
subpost_count: 18
thread_count: 4           # author's continuations in the replies
comment_count: 14         # other users' replies
parent_count: 0
tags: [bookmark, thread]
---

# Tweet by Author (@authorhandle)
...main body, with article H1/H2/H3, lists, code blocks if present...

## Conversation parents
- [[YYYY-MM-DD_parenthandle_id|@parenthandle: parent text…]]   ← Obsidian wikilink

## Thread continuations by @authorhandle
### Author (@authorhandle) — 2026-04-30 10:46
[next part of thread]

## Top comments (14)
### SomeUser (@someuser) — 2026-04-30 11:02
[reply text]
```

### Files written into your archive folder

| File | Purpose |
|---|---|
| `YYYY-MM-DD_handle_tweetid.md` | One per bookmark. Hand-edit safe — `.before-upgrade.md` backups are written before any overwrite. |
| `bookmarks.csv` | Index. Columns: `tweet_id, author_name, author_handle, posted_at, bookmarked_at, permalink, has_video, image_count, is_article, has_thread, subpost_count, thread_count, comment_count, text_preview, md_filename`. |
| `bookmarks.YYYY-MM-DD-HH-MM-SS.csv` | Rolling backup snapshot of the CSV before any export run. Last 5 kept. |
| `_search.json` | Flat array of every captured tweet for external search / Dataview. |
| `_health.csv` | Per-navigation timeline during deep export: timestamp, phase, url, status, duration_ms, kind. Useful for debugging rate-limit patterns. |
| `_deep-export-summary.md` | Stats from the most recent run: counts, settings, failed-URL table by failure kind. |

### Safety features baked in

- **5–10 sec random delay** per bookmark + 30 sec cooldown every 50 → respects X soft rate-limits.
- **Auto-pause on 429** for 15 minutes.
- **Retry queue** with exponential backoff for transient failures.
- **Smart resume**: re-running deep export skips files that are already complete; only re-processes truncated ones.
- **Resume-from-cancel**: state in `chrome.storage` survives browser restart; resume confirmation dialog if you re-open after >60 sec idle.
- **Folder integrity check** button: detects orphan `.md` files (no CSV row) or orphan rows (no .md), with one-click fixers.
- **CSV `bookmarked_at` preserved** across upserts — re-runs never overwrite the original timestamp.
- **`.before-upgrade.md` backups** written before any overwrite, so hand-edits in Obsidian are recoverable.

### Server-side fallback

When X serves a tweet that the user's browser can't render (geo-block, login wall, 429), the deep-export summary panel shows a **"Retry N failed via backend"** button. Click → backend's `/api/x/tweet` endpoint hits X's public syndication API (signed with a token computed via a node subprocess for byte-exact JS-compatibility), returns the tweet, and the extension writes a recovered `.md`.

## Project layout

```
open-transcribe/
├── backend/                     FastAPI app
│   ├── main.py                  entry, health, scheduler
│   ├── auth.py                  Google id_token verify + JWT
│   ├── ytdl.py                  yt-dlp wrapper (video → MP3)
│   ├── transcribe.py            Groq Whisper wrapper
│   ├── routers/
│   │   ├── auth.py              /api/auth/google, /api/me, /api/logout
│   │   ├── transcribe.py        /api/transcribe (with cache logic)
│   │   ├── history.py           /api/history list / get / delete
│   │   └── x_tweet.py           /api/x/tweet — syndication fallback
│   ├── models.py                User + Transcript ORM
│   └── .env.example
├── extension/                   Chrome MV3 (load unpacked)
│   ├── manifest.json
│   ├── background.js            service worker, OAuth, API calls
│   ├── content.js               x.com / youtube.com transcribe-button injection
│   ├── content.css
│   ├── bookmarks.js             /i/bookmarks export + auto-sync (~2000 LOC)
│   ├── bookmarks.css
│   ├── popup.*                  sign-in + history list
│   └── options.*                backend URL + client ID
├── LICENSE                      MIT
├── README.md                    you are here
└── SETUP.md                     full setup walkthrough
```

## Endpoints

| Method | Path | Auth | Used for |
|---|---|---|---|
| `POST` | `/api/auth/google` (body `{id_token}`) | none | exchange Google token for our JWT |
| `GET` | `/api/me` | bearer | logged-in user info |
| `POST` | `/api/transcribe` (body `{url, mode}`) | bearer | transcribe a tweet/video URL |
| `GET` | `/api/history?limit=&offset=` | bearer | list saved transcripts |
| `GET` | `/api/history/{id}` | bearer | one transcript |
| `DELETE` | `/api/history/{id}` | bearer | delete a transcript |
| `GET` | `/api/audio/{token}` | none — token is auth | HMAC short-lived MP3 download |
| `GET` | `/api/x/tweet?url=...` | bearer | syndication-API fallback for failed bookmarks |
| `GET` | `/health` | none | liveness probe |

## Configuration

All config lives in `backend/.env` (copy from `.env.example`).

| Var | What it does |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth Web Application client ID (see SETUP.md Phase 5) |
| `GROQ_API_KEY` | Groq Whisper key — free tier works fine |
| `GROQ_MODEL` | Default `whisper-large-v3-turbo`. Other Groq Whisper models also supported. |
| `JWT_SECRET` | Random 32-byte hex (`openssl rand -hex 32`). Used for session JWTs and signed audio URLs. |
| `AUDIO_RETENTION_HOURS` | How long downloaded MP3s stay on disk before the cleanup job purges them. Default 24. |
| `ALLOWED_ORIGINS` | CORS allowlist. `chrome-extension://*` lets any unpacked extension hit it. |
| `YTDL_COOKIES_PATH` | Optional absolute path to a yt-dlp `cookies.txt`. Required for YouTube. |

## YouTube setup (required for most videos)

YouTube transcription needs **three** things stacked. The backend handles #3 automatically; you set up #1 and #2 once.

### 1. Cookies (`cookies.txt`)

YouTube's anti-bot heuristics flag yt-dlp running on a VPS even on public videos, returning *"Sign in to confirm you're not a bot"*. Authenticated cookies bypass that. **Use a burner Google account** — a `cookies.txt` is a full session token.

The export procedure has to be followed strictly or YouTube rotates the tokens and invalidates the file you just saved:

1. Quit Chrome entirely first. No tab, anywhere, on YouTube.
2. Open a **fresh Incognito window** and sign in to YouTube with the burner account.
3. Open *one* YouTube tab, confirm a video plays. Don't navigate further.
4. Install [**Get cookies.txt LOCALLY**](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc) → click the extension → URL filter `youtube.com` → format **Netscape** → **Export**.
5. **Within seconds**: close the *entire* Incognito window (not just the tab).
6. SCP the file to the VPS:
   ```bash
   scp youtube.com_cookies.txt vijay@vps:/opt/transcribe/backend/data/cookies.txt
   chmod 600 /opt/transcribe/backend/data/cookies.txt
   ```
7. In `backend/.env`:
   ```
   YTDL_COOKIES_PATH=/opt/transcribe/backend/data/cookies.txt
   ```
8. Restart FastAPI.

Cookies expire in a few weeks; when transcription fails again with the bot message, repeat the export.

### 2. Deno (JS runtime)

YouTube uses an "n parameter" challenge that needs JS evaluation to decrypt the audio format URL. Without it, yt-dlp can extract metadata but only thumbnail images.

```bash
curl -fsSL https://deno.land/install.sh | sudo DENO_INSTALL=/usr/local sh
deno --version
```

Note: deno (or node) is also used by the `/api/x/tweet` syndication fallback to compute X's per-tweet token byte-identical to the JS reference.

### 3. EJS solver script (handled by the backend)

`backend/ytdl.py` passes `remote_components=["ejs:github"]`, which downloads the n-challenge solver from yt-dlp's GitHub on first use and caches it. No user action needed.

## Disclaimer

This is a **personal-use, self-hosted tool** — you run the backend, you provide your own API keys, your transcripts and bookmarks stay on your servers and machines. Nothing is hosted by the maintainer.

Users are responsible for complying with the Terms of Service of any site they extract content from. The bookmarks export specifically reads only your **own** bookmarked tweets via the same browser session you'd use to browse them yourself; do not redistribute downloaded videos or scraped content. Don't run this as a public service for other people without checking the relevant legalities for your jurisdiction.

## License

MIT — see [LICENSE](./LICENSE). Use it however you want; don't sue me if it breaks.

## Credits

Built on the shoulders of [yt-dlp](https://github.com/yt-dlp/yt-dlp), [Groq Whisper](https://groq.com/), [FastAPI](https://fastapi.tiangolo.com/), [Deno](https://deno.com/), and Chrome's [`identity.launchWebAuthFlow`](https://developer.chrome.com/docs/extensions/reference/api/identity) + [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API).
