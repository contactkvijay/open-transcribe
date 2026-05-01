// Watches video sites (x.com, youtube.com) for places to inject [MP3] [Text]
// buttons and dispatches clicks to the backend transcription pipeline.

// ---------- shared helpers ----------

function createBar({ barClass, getUrl }) {
  const bar = document.createElement("div");
  bar.className = barClass;
  bar.innerHTML = `
    <button class="xtx-btn" data-mode="audio" title="Download MP3">📥 MP3</button>
    <button class="xtx-btn" data-mode="text"  title="Get transcript">📝 Text</button>
  `;
  bar.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    const btn = e.target.closest(".xtx-btn");
    if (!btn) return;
    const url = getUrl();
    if (!url) {
      showModal({ error: "Couldn't find video URL on this page." });
      return;
    }
    onClickAction(btn.dataset.mode, url, btn);
  });
  return bar;
}

// ---------- platform: x.com ----------

function tweetUrlFromVideo(videoEl) {
  let el = videoEl;
  while (el && el.tagName !== "ARTICLE") el = el.parentElement;
  if (!el) return null;
  const timeLink = el.querySelector('a[href*="/status/"] time');
  if (timeLink && timeLink.parentElement && timeLink.parentElement.href) {
    return timeLink.parentElement.href;
  }
  const anyLink = el.querySelector('a[href*="/status/"]');
  return anyLink ? anyLink.href : null;
}

const xPlatform = {
  matches: (host) => host === "x.com" || host === "twitter.com",
  PROCESSED: new WeakSet(),
  scan() {
    document.querySelectorAll("video").forEach((videoEl) => {
      if (this.PROCESSED.has(videoEl)) return;
      const wrapper = videoEl.closest('div[data-testid="videoComponent"]')
        || videoEl.parentElement;
      if (!wrapper) return;
      const cs = getComputedStyle(wrapper);
      if (cs.position === "static") wrapper.style.position = "relative";
      const bar = createBar({
        barClass: "xtx-bar",
        getUrl: () => tweetUrlFromVideo(videoEl),
      });
      wrapper.appendChild(bar);
      this.PROCESSED.add(videoEl);
    });
  },
};

// ---------- platform: youtube.com ----------

function ytWatchUrl() {
  const v = new URLSearchParams(location.search).get("v");
  return v ? `https://www.youtube.com/watch?v=${v}` : null;
}

function ytShortUrl() {
  const m = location.pathname.match(/^\/shorts\/([^/?#]+)/);
  return m ? `https://www.youtube.com/shorts/${m[1]}` : null;
}

const ytPlatform = {
  matches: (host) => host.endsWith("youtube.com"),
  PROCESSED: new WeakSet(),
  _thumbObserver: null,
  scan() {
    if (location.pathname === "/watch") this.scanWatch();
    if (location.pathname.startsWith("/shorts/")) this.scanShorts();
    this.scanThumbnails();
  },
  scanWatch() {
    // Dedup by the bar's existence anywhere on the page rather than by
    // a remembered target element: YouTube can swap which selector wins
    // across mutations, so a per-element WeakSet was double-injecting.
    if (document.querySelector(".xtx-bar--inline")) return;
    // YouTube has renamed the action-row container across redesigns; try
    // each known selector in order from most-specific to broadest.
    const candidates = [
      "ytd-watch-metadata #top-level-buttons-computed",
      "ytd-watch-metadata yt-flexible-actions-view-model",
      "ytd-watch-metadata #actions-inner",
      "ytd-watch-metadata #actions",
      "#above-the-fold #actions",
    ];
    let target = null;
    for (const sel of candidates) {
      target = document.querySelector(sel);
      if (target) break;
    }
    if (!target) {
      console.debug("[Transcribe] scanWatch: no action-row target yet");
      return;
    }
    const bar = createBar({
      barClass: "xtx-bar xtx-bar--inline",
      getUrl: ytWatchUrl,
    });
    target.appendChild(bar);
    console.log("[Transcribe] watch bar injected into", target);
  },
  scanShorts() {
    // Find the active reel's action stack. YouTube has shipped several
    // names for these containers; try them in order. Active-reel marker
    // also varies: [is-active], .is-active class, [active], or fallback
    // to whichever reel has visibility.
    const activeReelSelectors = [
      "ytd-reel-video-renderer[is-active]",
      "ytd-reel-video-renderer.is-active",
      "ytd-reel-video-renderer[active]",
      "ytd-shorts-player[is-active]",
    ];
    let activeReel = null;
    for (const sel of activeReelSelectors) {
      activeReel = document.querySelector(sel);
      if (activeReel) break;
    }
    // Last-resort fallback: no [is-active] match, take the reel whose
    // <video> isn't paused (only the visible one plays).
    if (!activeReel) {
      const reels = document.querySelectorAll("ytd-reel-video-renderer");
      for (const r of reels) {
        const v = r.querySelector("video");
        if (v && !v.paused) { activeReel = r; break; }
      }
    }
    if (!activeReel) {
      console.debug("[Transcribe] scanShorts: no active reel container");
      return;
    }
    // Within the active reel, find the action button stack.
    const actionSelectors = [
      "#actions",
      "#menu",
      "ytd-reel-player-overlay-renderer #actions",
      ".action-container",
    ];
    let target = null;
    for (const sel of actionSelectors) {
      target = activeReel.querySelector(sel);
      if (target) break;
    }
    if (!target) {
      console.debug("[Transcribe] scanShorts: active reel found but no action stack inside", activeReel);
      return;
    }
    if (this.PROCESSED.has(target)) return;
    const bar = createBar({
      barClass: "xtx-bar xtx-bar--reel",
      getUrl: ytShortUrl,
    });
    target.appendChild(bar);
    this.PROCESSED.add(target);
    console.log("[Transcribe] shorts bar injected into", target);
  },
  scanThumbnails() {
    // IntersectionObserver: only inject buttons on cards that scroll into
    // view, so off-screen cards on long feeds don't pay the cost.
    if (!this._thumbObserver) {
      this._thumbObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          this.injectThumbBar(entry.target);
          this._thumbObserver.unobserve(entry.target);
        }
      }, { rootMargin: "200px" });
    }
    document.querySelectorAll('a#thumbnail[href*="/watch?v="]').forEach((anchor) => {
      if (this.PROCESSED.has(anchor)) return;
      this.PROCESSED.add(anchor);
      this._thumbObserver.observe(anchor);
    });
  },
  injectThumbBar(anchor) {
    // Sanity: anchor must currently link to a watch URL. If not, skip
    // (we'll re-evaluate next mutation tick).
    const initialMatch = (anchor.getAttribute("href") || "").match(/[?&]v=([^&]+)/);
    if (!initialMatch) return;
    const cs = getComputedStyle(anchor);
    if (cs.position === "static") anchor.style.position = "relative";
    const bar = createBar({
      barClass: "xtx-bar xtx-bar--thumb",
      // Read the href LAZILY at click time. YouTube recycles a#thumbnail
      // elements across virtualized feeds and updates href in place; if we
      // captured the URL eagerly we'd transcribe the previously-shown
      // video when the user clicks the chip on a later card.
      getUrl: () => {
        const m = (anchor.getAttribute("href") || "").match(/[?&]v=([^&]+)/);
        return m ? `https://www.youtube.com/watch?v=${m[1]}` : null;
      },
    });
    anchor.appendChild(bar);
  },
};

// ---------- platform dispatch ----------

const platform = [xPlatform, ytPlatform].find((p) => p.matches(location.hostname));

console.log("[Transcribe] content script loaded on", location.hostname,
  "→ platform:", platform ? (platform === xPlatform ? "x" : "youtube") : "none");

if (platform) {
  // YouTube mutates the DOM aggressively; debounce so a burst of mutations
  // collapses into a single scan.
  let scanTimer = 0;
  const scan = () => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => platform.scan(), 100);
  };
  const observer = new MutationObserver(scan);
  observer.observe(document.body, { childList: true, subtree: true });
  platform.scan();
}

// ---------- click handler ----------

async function onClickAction(mode, url, btn) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = mode === "audio" ? "⏳ MP3..." : "⏳ Text...";
  try {
    const res = await chrome.runtime.sendMessage({ type: "transcribe", url, mode });
    if (!res || !res.ok) throw new Error(res?.error || "Failed");
    const { data } = res;
    if (mode === "audio") {
      const filename = (data.title || `transcribe-${data.history_id}`)
        .replace(/[\\/:*?"<>|]+/g, "_")
        .slice(0, 80) + ".mp3";
      await chrome.runtime.sendMessage({
        type: "downloadAudio",
        audioUrl: data.audio_url,
        filename,
      });
      showModal({ kind: "audio", data });
    } else {
      showModal({ kind: "text", data });
    }
  } catch (e) {
    showModal({ error: e.message || String(e) });
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

// ---------- modal ----------

function showModal({ kind, data, error }) {
  const existing = document.getElementById("xtx-modal");
  if (existing) existing.remove();

  const dlg = document.createElement("dialog");
  dlg.id = "xtx-modal";
  dlg.className = "xtx-modal";

  let body = `<button class="xtx-close" data-act="close" aria-label="Close">×</button>`;
  if (error) {
    body += `
      <div class="xtx-error">${escapeHtml(error)}</div>
      <div class="xtx-actions">
        <button class="xtx-btn" data-act="close">Close</button>
      </div>`;
  } else if (kind === "text") {
    body = `
      <div class="xtx-modal-meta">${data.title ? escapeHtml(data.title) : ""} ${data.language ? "· " + data.language : ""}</div>
      <textarea class="xtx-transcript" readonly>${escapeHtml(data.transcript || "")}</textarea>
      <div class="xtx-actions">
        <button class="xtx-btn" data-act="copy">📋 Copy</button>
        <button class="xtx-btn" data-act="save-txt">💾 Save .txt</button>
        <button class="xtx-btn" data-act="close">Close</button>
      </div>`;
  } else if (kind === "audio") {
    body = `
      <div class="xtx-modal-meta">MP3 download started.</div>
      <div class="xtx-actions">
        <button class="xtx-btn" data-act="close">Close</button>
      </div>`;
  }

  dlg.innerHTML = `<div class="xtx-modal-inner">${body}</div>`;
  document.body.appendChild(dlg);
  dlg.showModal();

  dlg.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === "close") {
      dlg.close();
      dlg.remove();
    } else if (act === "copy") {
      try {
        await navigator.clipboard.writeText(data.transcript || "");
        btn.textContent = "✓ Copied";
        setTimeout(() => (btn.textContent = "📋 Copy"), 1500);
      } catch {}
    } else if (act === "save-txt") {
      const blob = new Blob([data.transcript || ""], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = ((data.title || `transcribe-${data.history_id}`)
        .replace(/[\\/:*?"<>|]+/g, "_")
        .slice(0, 80)) + ".txt";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
