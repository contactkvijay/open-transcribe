// Phase 1: bulk-export the user's X bookmarks to a folder of .md files
// + a bookmarks.csv index. Self-gates on /i/bookmarks; auto-scrolls and
// captures each tweet via MutationObserver before X's virtualized list
// unmounts it. Folder handle is persisted in IndexedDB so future
// auto-sync (bookmark a tweet -> append .md + CSV row) can reuse it.

(function () {
  if (typeof window.showDirectoryPicker !== "function") {
    console.warn("[Bookmarks] File System Access API not available — bookmarks export disabled in this browser.");
    return;
  }

  const STATE = {
    dirHandle: null,
    captured: new Map(), // tweetId -> tweet
    cancelled: false,
    inProgress: false,
  };

  // ---------- IndexedDB: persist directory handle ----------

  const DB_NAME = "tx-bookmarks";
  const STORE = "handles";
  const HANDLE_KEY = "bookmarks-folder";

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveHandle(handle) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(handle, HANDLE_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async function loadHandle() {
    try {
      const db = await openDB();
      return await new Promise((resolve) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(HANDLE_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  async function ensurePermission(handle) {
    const opts = { mode: "readwrite" };
    if ((await handle.queryPermission(opts)) === "granted") return true;
    if ((await handle.requestPermission(opts)) === "granted") return true;
    return false;
  }

  // ---------- Tweet extraction from article DOM ----------

  function extractTweetTextNode(textEl) {
    if (!textEl) return "";
    const clone = textEl.cloneNode(true);
    // Emoji and other inline images carry their character in alt; preserve it.
    clone.querySelectorAll("img[alt]").forEach((img) => {
      img.replaceWith(document.createTextNode(img.alt));
    });
    return clone.innerText.trim();
  }

  function isTweetMediaImage(src) {
    if (!src) return false;
    return (
      src.includes("pbs.twimg.com/media/") ||
      src.includes("pbs.twimg.com/amplify_video_thumb/") ||
      src.includes("pbs.twimg.com/ext_tw_video_thumb/")
    );
  }

  function isStatusDetailPage() {
    return /^\/[^/]+\/status\/\d+\/?$/.test(location.pathname);
  }

  // X Articles (long-form posts) are rendered as structured HTML inside the
  // tweet's <article>: h1/h2/h3 headings, paragraphs, lists, code blocks,
  // and images. The standard tweetText extractor only grabs the preview, so
  // when we're on the article-detail page we walk the full content tree.
  function extractArticleBody(article) {
    const out = [];
    const claimed = new Set();

    // Action row buttons (replies / retweets / likes / bookmark / share)
    // form a [role="group"] we don't want to scrape text from.
    const actionGroups = article.querySelectorAll('[role="group"]');

    function isInsideUserNameOrAction(el) {
      if (el.closest('[data-testid="User-Name"]')) return true;
      for (const g of actionGroups) if (g.contains(el)) return true;
      return false;
    }

    function alreadyClaimedAncestor(el) {
      let p = el.parentElement;
      while (p && p !== article) {
        if (claimed.has(p)) return true;
        p = p.parentElement;
      }
      return false;
    }

    for (const el of article.querySelectorAll(
      "h1, h2, h3, h4, p, ul, ol, blockquote, pre, img"
    )) {
      if (isInsideUserNameOrAction(el)) continue;
      if (alreadyClaimedAncestor(el)) continue;

      let md = null;
      const tag = el.tagName;

      if (/^H[1-4]$/.test(tag)) {
        const txt = el.textContent.trim();
        if (txt) md = "#".repeat(parseInt(tag[1])) + " " + txt;
      } else if (tag === "P") {
        const txt = extractTweetTextNode(el);
        if (txt && txt.length > 0) md = txt;
      } else if (tag === "UL" || tag === "OL") {
        const lis = Array.from(el.querySelectorAll(":scope > li"));
        if (lis.length) {
          md = lis
            .map((li, i) => {
              const prefix = tag === "OL" ? `${i + 1}. ` : "- ";
              return prefix + extractTweetTextNode(li);
            })
            .join("\n");
          lis.forEach((li) => claimed.add(li));
        }
      } else if (tag === "BLOCKQUOTE") {
        md = extractTweetTextNode(el)
          .split("\n")
          .map((l) => "> " + l)
          .join("\n");
      } else if (tag === "PRE") {
        md = "```\n" + el.textContent.trim() + "\n```";
      } else if (tag === "IMG") {
        if (isTweetMediaImage(el.src)) {
          md = `![${el.alt || ""}](${el.src})`;
        }
      }

      if (md) {
        out.push(md);
        claimed.add(el);
      }
    }

    if (out.length < 3) return null; // not enough content to look like an article body
    return out.join("\n\n");
  }

  function extractTweet(article) {
    const timeEl = article.querySelector("time");
    const timeLink = timeEl && timeEl.closest("a");
    if (!timeEl || !timeLink) return null;

    const href = timeLink.getAttribute("href") || "";
    const m = href.match(/^\/([^/]+)\/status\/(\d+)/);
    if (!m) return null;

    const handle = m[1];
    const tweetId = m[2];
    const permalink = `https://x.com${href.split("?")[0]}`;

    // Display name
    let authorName = handle;
    const userNameContainer = article.querySelector('[data-testid="User-Name"]');
    if (userNameContainer) {
      for (const span of userNameContainer.querySelectorAll("span")) {
        const t = span.textContent.trim();
        if (t && !t.startsWith("@") && t !== "·") {
          authorName = t;
          break;
        }
      }
    }

    // Body text — try the article walker first when we're on a status detail
    // page (only place where the full long-form body is in the DOM).
    let text = "";
    let isArticle = false;
    if (isStatusDetailPage()) {
      const articleBody = extractArticleBody(article);
      if (articleBody) {
        text = articleBody;
        isArticle = true;
      }
    }
    if (!text) {
      const textEl = article.querySelector('[data-testid="tweetText"]');
      text = extractTweetTextNode(textEl);
    }

    // "Show more" indicates the rendered text is truncated. Only flag this
    // if we didn't already capture the full article body.
    const truncated =
      !isArticle &&
      Array.from(article.querySelectorAll("button, a, span")).some(
        (el) => el.textContent.trim() === "Show more"
      );
    if (truncated) text += "\n\n[truncated — see permalink for full text]";

    // Tweet-level images (filter out profile pics)
    const images = Array.from(article.querySelectorAll("img"))
      .map((img) => img.src)
      .filter(isTweetMediaImage);
    // Dedupe
    const uniqueImages = [...new Set(images)];

    const hasVideo =
      !!article.querySelector("video") ||
      !!article.querySelector('[data-testid="videoComponent"]');

    // Quoted tweet detection: nested role="link" container with its own
    // tweetText / time. We only capture one level (no recursion).
    let quoted = null;
    const innerLinkContainer = article.querySelector('div[role="link"][tabindex="0"]');
    if (innerLinkContainer && innerLinkContainer !== article) {
      const qTimeEl = innerLinkContainer.querySelector("time");
      const qTextEl = innerLinkContainer.querySelector('[data-testid="tweetText"]');
      if (qTimeEl || qTextEl) {
        const qTimeLink = qTimeEl && qTimeEl.closest("a");
        const qHref = qTimeLink && qTimeLink.getAttribute("href");
        const qm = qHref && qHref.match(/^\/([^/]+)\/status\/(\d+)/);
        quoted = {
          handle: qm ? qm[1] : null,
          text: extractTweetTextNode(qTextEl),
          permalink: qm ? `https://x.com${qHref.split("?")[0]}` : null,
        };
      }
    }

    return {
      id: tweetId,
      author: { name: authorName, handle },
      timestamp: timeEl.getAttribute("datetime"),
      text,
      images: uniqueImages,
      hasVideo,
      permalink,
      quoted,
      truncated,
      isArticle,
      subPosts: [],
    };
  }

  // On a status detail page, also capture all the other <article> elements
  // visible on the page — these are the thread continuations from the same
  // author plus replies. "Sub-posts." Filter out anything inside <aside>
  // (right sidebar / trends / recommendations) and anything that doesn't
  // resolve to a /handle/status/id permalink.
  function extractTweetWithThread(article) {
    const main = extractTweet(article);
    if (!main) return null;
    if (!isStatusDetailPage()) return main;

    const mainEl = document.querySelector("main") || document.body;
    const seenIds = new Set([main.id]);
    for (const a of mainEl.querySelectorAll("article")) {
      if (a === article) continue;
      if (a.closest("aside")) continue;
      const sub = extractTweet(a);
      if (!sub || seenIds.has(sub.id)) continue;
      seenIds.add(sub.id);
      // Sub-posts shouldn't recurse into their own threads.
      sub.subPosts = [];
      main.subPosts.push(sub);
    }
    return main;
  }

  // ---------- Markdown + CSV formatters ----------

  function formatLocalDate(iso) {
    if (!iso) return "";
    return iso.slice(0, 16).replace("T", " ");
  }

  function bookmarkFilename(tweet) {
    const datePart = (tweet.timestamp || new Date().toISOString()).slice(0, 10);
    const safeHandle = (tweet.author.handle || "unknown").replace(/[^A-Za-z0-9_]/g, "_");
    return `${datePart}_${safeHandle}_${tweet.id}.md`;
  }

  function tweetToMarkdown(tweet) {
    const exportedAt = formatLocalDate(new Date().toISOString());
    const kind = tweet.isArticle ? "Article" : "Tweet";
    const lines = [];
    lines.push(`# ${kind} by ${tweet.author.name} (@${tweet.author.handle})`);
    lines.push("");
    lines.push(`- **Posted**: ${formatLocalDate(tweet.timestamp)}`);
    lines.push(`- **Permalink**: ${tweet.permalink}`);
    lines.push(`- **Exported**: ${exportedAt}`);
    if (tweet.isArticle) lines.push(`- **Type**: long-form Article`);
    lines.push("");
    lines.push("---");
    lines.push("");
    if (tweet.text) {
      lines.push(tweet.text);
      lines.push("");
    }
    if (tweet.images.length > 0) {
      lines.push("## Images");
      lines.push("");
      tweet.images.forEach((url, i) => lines.push(`![image ${i + 1}](${url})`));
      lines.push("");
    }
    if (tweet.hasVideo) {
      lines.push("## Video");
      lines.push("");
      lines.push(`🎥 [Open video on X](${tweet.permalink})`);
      lines.push("");
    }
    if (tweet.quoted) {
      lines.push("## Quoted tweet");
      lines.push("");
      const qText = (tweet.quoted.text || "").split("\n");
      qText.forEach((l) => lines.push(`> ${l}`));
      if (tweet.quoted.permalink) {
        lines.push(">");
        lines.push(`> — @${tweet.quoted.handle || "unknown"}, [permalink](${tweet.quoted.permalink})`);
      }
      lines.push("");
    }
    if (tweet.subPosts && tweet.subPosts.length > 0) {
      lines.push("---");
      lines.push("");
      lines.push("## Thread / sub-posts");
      lines.push("");
      for (const sub of tweet.subPosts) {
        lines.push(`### ${sub.author.name} (@${sub.author.handle}) — ${formatLocalDate(sub.timestamp)}`);
        lines.push("");
        if (sub.text) {
          lines.push(sub.text);
          lines.push("");
        }
        if (sub.images.length > 0) {
          sub.images.forEach((url, i) => lines.push(`![sub-image ${i + 1}](${url})`));
          lines.push("");
        }
        if (sub.hasVideo) {
          lines.push(`🎥 [Open video on X](${sub.permalink})`);
          lines.push("");
        }
        if (sub.quoted) {
          const qText = (sub.quoted.text || "").split("\n");
          qText.forEach((l) => lines.push(`> ${l}`));
          if (sub.quoted.permalink) {
            lines.push(`> — @${sub.quoted.handle || "unknown"}, [permalink](${sub.quoted.permalink})`);
          }
          lines.push("");
        }
        lines.push(`[Permalink](${sub.permalink})`);
        lines.push("");
      }
    }
    return lines.join("\n");
  }

  function csvEscape(value) {
    if (value == null) return "";
    const s = String(value);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  const CSV_HEADER =
    "tweet_id,author_name,author_handle,posted_at,bookmarked_at,permalink,has_video,image_count,text_preview,md_filename";

  function tweetToCsvRow(tweet, exportedAt) {
    const preview = (tweet.text || "").replace(/\s+/g, " ").slice(0, 120);
    return [
      tweet.id,
      tweet.author.name,
      tweet.author.handle,
      tweet.timestamp,
      exportedAt,
      tweet.permalink,
      tweet.hasVideo ? "yes" : "no",
      tweet.images.length,
      preview,
      bookmarkFilename(tweet),
    ]
      .map(csvEscape)
      .join(",");
  }

  // ---------- File-system writes ----------

  async function readFileText(dirHandle, name) {
    try {
      const fh = await dirHandle.getFileHandle(name);
      return await (await fh.getFile()).text();
    } catch {
      return null;
    }
  }

  // Returns a status: "created" if newly written, "upgraded" if overwritten
  // with a meaningfully better capture, "skipped" if existing content is
  // already at least as good. The upgrade path lets a re-bookmark from the
  // article-detail page replace a previously-truncated bulk-export file.
  async function writeBookmarkFile(dirHandle, tweet) {
    const filename = bookmarkFilename(tweet);
    const newContent = tweetToMarkdown(tweet);
    const existing = await readFileText(dirHandle, filename);
    if (existing != null) {
      const newIsArticle = tweet.isArticle === true;
      const existingIsArticle = /\*\*Type\*\*: long-form Article/.test(existing);
      const isUpgrade =
        (newIsArticle && !existingIsArticle) ||
        newContent.length > existing.length + 200; // meaningful gain in body
      if (!isUpgrade) return "skipped";
    }
    const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(newContent);
    await writable.close();
    return existing == null ? "created" : "upgraded";
  }

  async function writeCsvIndex(dirHandle, tweets) {
    const exportedAt = new Date().toISOString();
    const rows = [CSV_HEADER, ...tweets.map((t) => tweetToCsvRow(t, exportedAt))];
    const fileHandle = await dirHandle.getFileHandle("bookmarks.csv", { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(rows.join("\n") + "\n");
    await writable.close();
  }

  // ---------- Capture loop ----------

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function captureTimelineSweep() {
    document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
      const tweet = extractTweet(article);
      if (tweet && !STATE.captured.has(tweet.id)) {
        STATE.captured.set(tweet.id, tweet);
      }
    });
  }

  async function flushNewToDisk() {
    let written = 0;
    for (const tweet of STATE.captured.values()) {
      if (tweet._written) continue;
      try {
        await writeBookmarkFile(STATE.dirHandle, tweet);
        tweet._written = true;
        written++;
      } catch (e) {
        console.error("[Bookmarks] write failed", tweet.id, e);
      }
    }
    return written;
  }

  async function exportLoop() {
    let lastCount = 0;
    let stableTicks = 0;
    let backoffMs = 0;
    while (!STATE.cancelled && stableTicks < 5) {
      captureTimelineSweep();
      await flushNewToDisk();
      updateProgress(STATE.captured.size);

      if (STATE.captured.size === lastCount) {
        stableTicks++;
        // X may have soft-rate-limited us; back off progressively.
        backoffMs = Math.min(4000, backoffMs + 800);
      } else {
        stableTicks = 0;
        backoffMs = 0;
        lastCount = STATE.captured.size;
      }

      window.scrollBy(0, window.innerHeight * 0.85);
      await sleep(700 + Math.random() * 300 + backoffMs);
    }
    captureTimelineSweep();
    await flushNewToDisk();
    await writeCsvIndex(STATE.dirHandle, [...STATE.captured.values()]);
    return STATE.captured.size;
  }

  // ---------- Progress overlay UI ----------

  let panel = null;

  function showOverlay() {
    if (panel) panel.remove();
    panel = document.createElement("div");
    panel.id = "tx-bm-overlay";
    panel.innerHTML = `
      <div class="tx-bm-title">📁 Exporting bookmarks…</div>
      <div class="tx-bm-counter">Captured 0</div>
      <div class="tx-bm-actions">
        <button class="tx-bm-cancel">Cancel</button>
      </div>
    `;
    document.body.appendChild(panel);
    panel.querySelector(".tx-bm-cancel").addEventListener("click", () => {
      STATE.cancelled = true;
    });
  }

  function updateProgress(n) {
    if (!panel) return;
    panel.querySelector(".tx-bm-counter").textContent = `Captured ${n}`;
  }

  function finishOverlay(total, cancelled) {
    if (!panel) return;
    panel.querySelector(".tx-bm-title").textContent = cancelled
      ? "⛔ Export cancelled"
      : "✅ Export complete";
    panel.querySelector(".tx-bm-counter").textContent = `${total} bookmark${total === 1 ? "" : "s"} written`;
    const actions = panel.querySelector(".tx-bm-actions");
    actions.innerHTML = '<button class="tx-bm-close">Close</button>';
    actions.querySelector(".tx-bm-close").addEventListener("click", () => {
      panel.remove();
      panel = null;
    });
  }

  // ---------- Trigger button ----------

  function findHeader() {
    // Primary timeline header on /i/bookmarks ("Bookmarks" h2 with sticky parent)
    const h2 = Array.from(document.querySelectorAll('h2[role="heading"]'))
      .find((h) => /bookmark/i.test(h.textContent.trim()));
    if (!h2) return null;
    // Walk up until we find the sticky header bar (it has multiple flex children).
    let el = h2;
    for (let i = 0; i < 6 && el; i++) {
      el = el.parentElement;
      if (el && getComputedStyle(el).position === "sticky") return el;
    }
    return h2.parentElement;
  }

  function injectExportButton() {
    if (location.pathname !== "/i/bookmarks") {
      const existing = document.getElementById("tx-bm-trigger");
      if (existing) existing.remove();
      const existingDeep = document.getElementById("tx-bm-deep-trigger");
      if (existingDeep) existingDeep.remove();
      return;
    }
    const target = findHeader();
    if (!target) return;

    if (!document.getElementById("tx-bm-trigger")) {
      const btn = document.createElement("button");
      btn.id = "tx-bm-trigger";
      btn.className = "tx-bm-trigger";
      btn.textContent = "📁 Quick export";
      btn.title = "Fast: scrolls the bookmarks list and saves each tweet's preview to a .md file. Articles come out truncated.";
      btn.addEventListener("click", startExport);
      target.appendChild(btn);
    }
    if (!document.getElementById("tx-bm-deep-trigger")) {
      const btn = document.createElement("button");
      btn.id = "tx-bm-deep-trigger";
      btn.className = "tx-bm-trigger tx-bm-trigger--deep";
      btn.textContent = "🌊 Deep export";
      btn.title = "Slow but complete: opens every bookmarked tweet's detail page in turn and captures the full article body, thread, and sub-posts.";
      btn.addEventListener("click", startDeepExport);
      target.appendChild(btn);
    }
  }

  async function startExport() {
    if (STATE.inProgress) return;
    STATE.inProgress = true;

    let dirHandle = await loadHandle();
    if (dirHandle) {
      const ok = await ensurePermission(dirHandle);
      if (!ok) dirHandle = null;
    }
    if (!dirHandle) {
      try {
        dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
        await saveHandle(dirHandle);
      } catch {
        STATE.inProgress = false;
        return;
      }
    }

    STATE.dirHandle = dirHandle;
    STATE.captured.clear();
    STATE.cancelled = false;

    showOverlay();
    try {
      const total = await exportLoop();
      finishOverlay(total, STATE.cancelled);
    } catch (e) {
      console.error("[Bookmarks] export error", e);
      if (panel) {
        panel.querySelector(".tx-bm-title").textContent = "⚠ Export error";
        panel.querySelector(".tx-bm-counter").textContent = e.message || String(e);
      }
    } finally {
      STATE.inProgress = false;
    }
  }

  // ---------- Auto-sync: live bookmark/unbookmark -> folder + CSV ----------

  // Serialize CSV ops so concurrent clicks don't read-modify-write race.
  let csvQueue = Promise.resolve();
  function csvLock(fn) {
    csvQueue = csvQueue.then(fn).catch((e) => console.error("[Bookmarks] CSV op failed", e));
    return csvQueue;
  }

  async function readCsvText(dirHandle) {
    try {
      const fh = await dirHandle.getFileHandle("bookmarks.csv");
      return await (await fh.getFile()).text();
    } catch {
      return CSV_HEADER + "\n";
    }
  }

  async function writeCsvText(dirHandle, content) {
    const fh = await dirHandle.getFileHandle("bookmarks.csv", { create: true });
    const writable = await fh.createWritable();
    await writable.write(content);
    await writable.close();
  }

  function csvFirstColumn(line) {
    // First column may be quoted ("123") or bare (123). Strip wrapping quotes.
    const raw = line.split(",")[0] || "";
    return raw.replace(/^"|"$/g, "").replace(/""/g, '"');
  }

  // Upsert: if a row for this tweet_id already exists, replace it (so an
  // upgraded capture — e.g. truncated preview -> full article body —
  // refreshes the CSV's text_preview alongside the .md file).
  async function appendCsvRow(dirHandle, tweet) {
    await csvLock(async () => {
      const current = await readCsvText(dirHandle);
      const lines = current.replace(/\n+$/, "").split("\n").filter(Boolean);
      if (lines[0] !== CSV_HEADER) lines.unshift(CSV_HEADER);
      const kept = [lines[0]];
      for (let i = 1; i < lines.length; i++) {
        if (csvFirstColumn(lines[i]) !== tweet.id) kept.push(lines[i]);
      }
      kept.push(tweetToCsvRow(tweet, new Date().toISOString()));
      await writeCsvText(dirHandle, kept.join("\n") + "\n");
    });
  }

  async function removeCsvRow(dirHandle, tweetId) {
    await csvLock(async () => {
      const current = await readCsvText(dirHandle);
      const lines = current.replace(/\n+$/, "").split("\n").filter(Boolean);
      if (lines.length < 2) return;
      const filtered = [lines[0]];
      let removed = false;
      for (let i = 1; i < lines.length; i++) {
        if (csvFirstColumn(lines[i]) === tweetId) {
          removed = true;
          continue;
        }
        filtered.push(lines[i]);
      }
      if (!removed) return;
      await writeCsvText(dirHandle, filtered.join("\n") + "\n");
    });
  }

  // Toast for non-blocking feedback on auto-sync events.
  function showToast(message, ms = 1800) {
    let toast = document.getElementById("tx-bm-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "tx-bm-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add("tx-bm-toast--visible");
    clearTimeout(toast._dismissTimer);
    toast._dismissTimer = setTimeout(() => {
      toast.classList.remove("tx-bm-toast--visible");
    }, ms);
  }

  // Cache the directory handle + permission to avoid re-prompting on every
  // click. Permission is rechecked lazily.
  const SYNC = {
    dirHandle: null,
    warnedNoFolder: false,
  };

  async function getSyncHandle() {
    if (SYNC.dirHandle) {
      const opts = { mode: "readwrite" };
      if ((await SYNC.dirHandle.queryPermission(opts)) === "granted") return SYNC.dirHandle;
    }
    const handle = await loadHandle();
    if (!handle) return null;
    if (!(await ensurePermission(handle))) return null;
    SYNC.dirHandle = handle;
    return handle;
  }

  async function onBookmarkAdded(article) {
    const tweet = extractTweetWithThread(article);
    if (!tweet) return;
    const handle = await getSyncHandle();
    if (!handle) {
      if (!SYNC.warnedNoFolder) {
        SYNC.warnedNoFolder = true;
        showToast('Auto-sync off — open x.com/i/bookmarks and click "Export bookmarks" once to choose a folder.', 5000);
      }
      return;
    }
    try {
      const status = await writeBookmarkFile(handle, tweet);
      await appendCsvRow(handle, tweet);
      const subCount = (tweet.subPosts && tweet.subPosts.length) || 0;
      const subSuffix = subCount > 0 ? ` + ${subCount} sub-post${subCount === 1 ? "" : "s"}` : "";
      const verb =
        status === "created" ? "📁 Saved" :
        status === "upgraded" ? "📁 Upgraded" :
        "📁 Already saved";
      showToast(`${verb} @${tweet.author.handle}/${tweet.id.slice(-6)}${subSuffix}`);
    } catch (e) {
      console.error("[Bookmarks] sync-add failed", tweet.id, e);
      showToast(`⚠ Auto-sync failed: ${e.message || e}`, 4000);
    }
  }

  async function onBookmarkRemoved(article) {
    const tweet = extractTweet(article);
    if (!tweet) return;
    const handle = await getSyncHandle();
    if (!handle) return;
    try {
      await removeCsvRow(handle, tweet.id);
      showToast(`🗑 Removed @${tweet.author.handle}/${tweet.id.slice(-6)} from CSV (.md kept)`);
    } catch (e) {
      console.error("[Bookmarks] sync-remove failed", tweet.id, e);
    }
  }

  // Single delegated click listener for the entire X page. Cheap on
  // non-bookmark clicks (one closest() call returning null).
  document.addEventListener(
    "click",
    (e) => {
      const addBtn = e.target.closest('[data-testid="bookmark"]');
      const removeBtn = e.target.closest('[data-testid="removeBookmark"]');
      if (!addBtn && !removeBtn) return;
      const article = (addBtn || removeBtn).closest("article");
      if (!article) return;
      // Fire-and-forget; don't block the click. X handles its own bookmark
      // API call independently.
      if (addBtn) onBookmarkAdded(article);
      else onBookmarkRemoved(article);
    },
    true // capture phase, runs before X's own handlers reach the button
  );

  // ---------- Deep export: navigate every bookmark URL, capture full content ----------

  // The deep export drives the tab through every bookmark URL one by one
  // so each tweet's status detail page is rendered (= full article body +
  // thread/sub-posts available in DOM). State lives in chrome.storage.local
  // so the queue survives page reloads. Folder handle stays in IndexedDB
  // (same origin, accessible from every x.com page).

  const DEEP_KEY = "tx-bookmarks-deep-export";
  const DEEP_DELAY_MIN = 1000; // polite jittered delay (1-3s) between URL navigations
  const DEEP_DELAY_MAX = 3000;

  async function getDeepState() {
    const r = await chrome.storage.local.get(DEEP_KEY);
    return r[DEEP_KEY] || null;
  }
  async function setDeepState(s) {
    await chrome.storage.local.set({ [DEEP_KEY]: s });
  }
  async function clearDeepState() {
    await chrome.storage.local.remove(DEEP_KEY);
  }
  // Atomic read-modify-write that protects user intent: once status is
  // "cancelled" or "done", a stale write from the loop CAN'T revive it
  // back to "running". This kills the cancel-vs-loop race that was
  // causing the queue to keep navigating after the user clicked Cancel.
  async function patchDeepState(updates) {
    const current = await getDeepState();
    if (!current) return null;
    if ((current.status === "cancelled" || current.status === "done") &&
        updates.status === undefined) {
      // Loop trying to write progress, but user already terminated. Don't.
      return current;
    }
    const merged = { ...current, ...updates };
    await setDeepState(merged);
    return merged;
  }

  function permalinkFromArticle(article) {
    const t = article.querySelector("time");
    const a = t && t.closest("a");
    const href = a && a.getAttribute("href");
    const m = href && href.match(/^\/([^/]+)\/status\/(\d+)/);
    return m ? `https://x.com${href.split("?")[0]}` : null;
  }

  async function waitForArticleStable(timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const arts = document.querySelectorAll("article");
      for (const a of arts) {
        if (a.querySelector("time") && a.querySelector('[data-testid="tweetText"], h1, h2')) {
          // Give X another beat to finish hydrating sub-posts/replies
          await sleep(800);
          return a;
        }
      }
      await sleep(200);
    }
    return null;
  }

  // Phase A: auto-scroll the bookmarks list, collect every permalink.
  async function deepCollectURLs(state) {
    const seen = new Set(state.queue);
    let lastCount = seen.size;
    let stableTicks = 0;
    while (stableTicks < 5) {
      const fresh = await getDeepState();
      if (!fresh || fresh.status !== "running") return;
      state = fresh;
      seen.clear();
      for (const u of state.queue) seen.add(u);

      let added = 0;
      document.querySelectorAll('article[data-testid="tweet"]').forEach((art) => {
        const url = permalinkFromArticle(art);
        if (url && !seen.has(url)) {
          seen.add(url);
          state.queue.push(url);
          added++;
        }
      });

      updateDeepPanel(state, `Phase 1 — collecting URLs: ${seen.size}`);

      if (seen.size === lastCount) stableTicks++;
      else { stableTicks = 0; lastCount = seen.size; }

      window.scrollBy(0, window.innerHeight * 0.85);
      await sleep(700 + Math.random() * 300);
      // Persist via atomic patch -> won't revive a cancelled run.
      const after = await patchDeepState({ queue: state.queue });
      if (!after || after.status !== "running") return;
    }

    // Transition to Phase B
    const after = await patchDeepState({
      phase: "processing",
      cursor: 0,
      totalAtStart: state.queue.length,
    });
    if (!after || after.status !== "running") return;
    updateDeepPanel(after);

    if (after.queue.length === 0) {
      await deepFinish(after, "done");
      return;
    }
    await sleep(1000);
    location.href = after.queue[0];
  }

  // Phase B (per page): on a status detail page, extract everything and
  // navigate to the next URL.
  async function deepProcessCurrent(state) {
    // Re-read state at entry; user may have hit Cancel while page was loading.
    const entry = await getDeepState();
    if (!entry || entry.status !== "running") {
      if (entry) updateDeepPanel(entry);
      return;
    }
    state = entry;
    updateDeepPanel(state);

    const expected = state.queue[state.cursor];
    const article = await waitForArticleStable(15000);

    let completedDelta = 0;
    let newFailure = null;

    if (article) {
      try {
        const tweet = extractTweetWithThread(article);
        if (tweet) {
          const handle = await getSyncHandle();
          if (handle) {
            await writeBookmarkFile(handle, tweet);
            await appendCsvRow(handle, tweet);
            completedDelta = 1;
          } else {
            newFailure = { url: expected, reason: "no folder handle" };
          }
        } else {
          newFailure = { url: expected, reason: "extractTweet returned null" };
        }
      } catch (e) {
        console.error("[Deep export] extraction failed", expected, e);
        newFailure = { url: expected, reason: e.message || String(e) };
      }
    } else {
      newFailure = { url: expected, reason: "article never appeared (deleted, rate-limited, or blocked)" };
    }

    // Persist atomically; will be a no-op if user cancelled during work.
    const updates = { cursor: state.cursor + 1 };
    if (completedDelta) updates.completed = (state.completed || 0) + completedDelta;
    if (newFailure) updates.failed = [...state.failed, newFailure];
    const after = await patchDeepState(updates);

    if (!after || after.status !== "running") {
      if (after) updateDeepPanel(after);
      return;
    }

    if (after.cursor >= after.queue.length) {
      await deepFinish(after, "done");
      return;
    }

    const delay = DEEP_DELAY_MIN + Math.random() * (DEEP_DELAY_MAX - DEEP_DELAY_MIN);
    updateDeepPanel(after, `Phase 2 — ${after.cursor}/${after.queue.length} (next in ${Math.round(delay)}ms)`);
    await sleep(delay);

    // Final pre-nav cancel check so we never navigate after Cancel.
    const final = await getDeepState();
    if (!final || final.status !== "running") {
      if (final) updateDeepPanel(final);
      return;
    }
    location.href = after.queue[after.cursor];
  }

  async function deepFinish(state, status) {
    state.status = status;
    state.finishedAt = Date.now();
    await setDeepState(state);
    // Bring user back to bookmarks page so they can see the summary panel
    if (location.pathname !== "/i/bookmarks") {
      location.href = "https://x.com/i/bookmarks";
    } else {
      updateDeepPanel(state);
    }
  }

  async function startDeepExport() {
    let dirHandle = await loadHandle();
    if (dirHandle) {
      const ok = await ensurePermission(dirHandle);
      if (!ok) dirHandle = null;
    }
    if (!dirHandle) {
      try {
        dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
        await saveHandle(dirHandle);
      } catch {
        return;
      }
    }
    const state = {
      status: "running",
      phase: "collecting",
      queue: [],
      cursor: 0,
      completed: 0,
      failed: [],
      startedAt: Date.now(),
    };
    await setDeepState(state);
    showDeepPanel(state);
    await deepCollectURLs(state);
  }

  // Boot-time resume: if the user reloads or navigates away mid-export,
  // re-running the script picks up where it left off.
  async function maybeResumeDeepExport() {
    const state = await getDeepState();
    if (!state) return false;

    showDeepPanel(state);

    if (state.status === "done" || state.status === "cancelled") {
      updateDeepPanel(state);
      return true;
    }
    if (state.status !== "running") return false;

    if (state.phase === "collecting") {
      if (location.pathname === "/i/bookmarks") {
        await deepCollectURLs(state);
      } else {
        updateDeepPanel(state, "⏸ Paused — return to x.com/i/bookmarks to resume");
      }
      return true;
    }

    if (state.phase === "processing") {
      if (state.cursor >= state.queue.length) {
        await deepFinish(state, "done");
        return true;
      }
      const expected = state.queue[state.cursor];
      const expectedPath = expected.replace(/^https?:\/\/[^/]+/, "");
      if (location.pathname + location.search === expectedPath || location.pathname === expectedPath.split("?")[0]) {
        await deepProcessCurrent(state);
      } else if (isStatusDetailPage()) {
        // We're on some status page; assume X redirected (e.g. canonical URL).
        // Process it anyway.
        await deepProcessCurrent(state);
      } else {
        // Wrong page — drive ourselves back to the queue
        location.href = expected;
      }
      return true;
    }
    return false;
  }

  // Deep-export overlay (uses same CSS classes as the regular export overlay).
  let deepPanel = null;

  function showDeepPanel(state) {
    if (deepPanel) deepPanel.remove();
    deepPanel = document.createElement("div");
    deepPanel.id = "tx-bm-deep-overlay";
    deepPanel.className = "tx-bm-deep";
    deepPanel.innerHTML = `
      <div class="tx-bm-title">🌊 Deep export</div>
      <div class="tx-bm-counter">Starting…</div>
      <div class="tx-bm-actions">
        <button class="tx-bm-cancel">Cancel</button>
      </div>
    `;
    document.body.appendChild(deepPanel);
    deepPanel.querySelector(".tx-bm-cancel").addEventListener("click", async () => {
      const after = await patchDeepState({ status: "cancelled", finishedAt: Date.now() });
      if (after) updateDeepPanel(after);
      // If we're stuck on a status detail page (page may not have finished
      // loading), bounce back to bookmarks so X is usable again immediately.
      if (location.pathname !== "/i/bookmarks") {
        setTimeout(() => { location.href = "https://x.com/i/bookmarks"; }, 200);
      }
    });
  }

  function updateDeepPanel(state, customMsg) {
    if (!deepPanel) return;
    const counter = deepPanel.querySelector(".tx-bm-counter");
    const actions = deepPanel.querySelector(".tx-bm-actions");
    if (state.status === "cancelled") {
      counter.textContent = `⛔ Cancelled — ${state.completed || 0} done, ${state.queue.length - state.cursor} remaining`;
      actions.innerHTML = '<button class="tx-bm-close">Close</button>';
    } else if (state.status === "done") {
      counter.textContent = `✅ Done — ${state.completed} captured, ${state.failed.length} failed`;
      actions.innerHTML = '<button class="tx-bm-close">Close</button>';
    } else if (state.phase === "collecting") {
      counter.textContent = customMsg || `Phase 1 — collecting URLs: ${state.queue.length}`;
    } else if (state.phase === "processing") {
      counter.textContent = customMsg || `Phase 2 — ${state.cursor}/${state.queue.length} (${state.completed} done, ${state.failed.length} failed)`;
    }
    const closeBtn = actions.querySelector(".tx-bm-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", async () => {
        await clearDeepState();
        if (deepPanel) {
          deepPanel.remove();
          deepPanel = null;
        }
      });
    }
  }

  // ---------- Boot ----------

  // The header isn't always present at document_idle; SPA navigation also
  // doesn't reload the script, so we observe DOM changes and (re)inject
  // whenever the user is on the bookmarks page.
  const observer = new MutationObserver(() => injectExportButton());
  observer.observe(document.body, { childList: true, subtree: true });
  injectExportButton();

  // If a deep export is in progress (or just finished) the script needs
  // to either resume the queue or show the summary panel.
  maybeResumeDeepExport().catch((e) => console.error("[Deep export] resume failed", e));
})();
