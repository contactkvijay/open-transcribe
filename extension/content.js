// Watches x.com for video elements and injects [MP3] [Text] buttons next to each.

const PROCESSED = new WeakSet();

function tweetUrlFromVideo(videoEl) {
  // Walk up to the article, find the timestamp link (<a> wrapping <time>) which
  // is reliably the post's permalink.
  let el = videoEl;
  while (el && el.tagName !== "ARTICLE") el = el.parentElement;
  if (!el) return null;
  const timeLink = el.querySelector('a[href*="/status/"] time');
  if (timeLink && timeLink.parentElement && timeLink.parentElement.href) {
    return timeLink.parentElement.href;
  }
  // fallback: first /status/ link in the article
  const anyLink = el.querySelector('a[href*="/status/"]');
  return anyLink ? anyLink.href : null;
}

function ensureToolbar(videoEl) {
  if (PROCESSED.has(videoEl)) return;
  // Find the closest video container that wraps the controls; X uses several
  // nested divs. We'll target the immediate parent of the <video>.
  const wrapper = videoEl.closest('div[data-testid="videoComponent"]')
    || videoEl.parentElement;
  if (!wrapper) return;

  // Make sure wrapper can position children.
  const cs = getComputedStyle(wrapper);
  if (cs.position === "static") wrapper.style.position = "relative";

  const bar = document.createElement("div");
  bar.className = "xtx-bar";
  bar.innerHTML = `
    <button class="xtx-btn" data-mode="audio" title="Download MP3">📥 MP3</button>
    <button class="xtx-btn" data-mode="text"  title="Get transcript">📝 Text</button>
  `;
  bar.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    const btn = e.target.closest(".xtx-btn");
    if (!btn) return;
    const url = tweetUrlFromVideo(videoEl);
    if (!url) {
      showModal({ error: "Couldn't find tweet URL for this video." });
      return;
    }
    onClickAction(btn.dataset.mode, url, btn);
  });
  wrapper.appendChild(bar);
  PROCESSED.add(videoEl);
}

function scan() {
  document.querySelectorAll("video").forEach(ensureToolbar);
}

const observer = new MutationObserver(() => scan());
observer.observe(document.body, { childList: true, subtree: true });
scan();

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
