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

  // Cap on captured sub-posts (replies + author thread continuations) per
  // bookmark. X often has hundreds of replies on a popular tweet; we keep
  // the top N as they appear in the rendered DOM (X's own ranking).
  const SUBPOST_LIMIT = 20;

  // On a status detail page, capture the surrounding conversation. Articles
  // BEFORE the bookmarked one in document order = conversation parents
  // (the chain that leads up to this bookmark). Articles AFTER = sub-posts.
  //
  // Sub-posts are flagged isAuthor=true when posted by the same handle as
  // the bookmarked tweet -- those are "thread continuations" (the post
  // continued in the comments). Other sub-posts are regular replies.
  // Both kinds rendered separately in the .md so the second-brain notes
  // show the author's own continuation as a coherent thread, distinct
  // from random replies.
  function extractTweetWithThread(article) {
    const main = extractTweet(article);
    if (!main) return null;
    main.parentChain = [];
    if (!isStatusDetailPage()) return main;

    const mainEl = document.querySelector("main") || document.body;
    const all = Array.from(mainEl.querySelectorAll("article"));
    const mainIndex = all.indexOf(article);
    const seenIds = new Set([main.id]);

    let subCount = 0;
    for (let i = 0; i < all.length; i++) {
      const a = all[i];
      if (a === article) continue;
      if (a.closest("aside")) continue;
      const t = extractTweet(a);
      if (!t || seenIds.has(t.id)) continue;
      seenIds.add(t.id);
      t.subPosts = [];
      t.parentChain = [];
      t.isAuthor = (t.author.handle || "").toLowerCase() === (main.author.handle || "").toLowerCase();
      if (i < mainIndex) {
        main.parentChain.push(t);
      } else {
        if (subCount >= SUBPOST_LIMIT) continue;
        main.subPosts.push(t);
        subCount++;
      }
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

  // Escape a string for safe inclusion as a YAML scalar value. We always
  // double-quote so colons/special chars don't trip the parser.
  function yamlString(s) {
    if (s == null) return '""';
    return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ") + '"';
  }
  function yamlList(arr) {
    if (!arr || arr.length === 0) return "[]";
    return "[" + arr.map(yamlString).join(", ") + "]";
  }

  function tweetFrontmatter(tweet) {
    const postedDate = (tweet.timestamp || "").slice(0, 10);
    const exportedAt = new Date().toISOString();
    const lines = ["---"];
    lines.push(`title: ${yamlString(`@${tweet.author.handle} — ${(tweet.text || "").slice(0, 60).replace(/\s+/g, " ").trim()}`)}`);
    lines.push(`author: ${yamlString(tweet.author.name)}`);
    lines.push(`handle: ${yamlString(tweet.author.handle)}`);
    lines.push(`posted: ${yamlString(tweet.timestamp || "")}`);
    if (postedDate) lines.push(`posted_date: ${postedDate}`);
    lines.push(`tweet_id: ${yamlString(tweet.id)}`);
    lines.push(`permalink: ${yamlString(tweet.permalink)}`);
    lines.push(`type: ${tweet.isArticle ? "article" : "tweet"}`);
    lines.push(`source: x.com`);
    lines.push(`bookmarked_at: ${yamlString(exportedAt)}`);
    lines.push(`has_video: ${tweet.hasVideo ? "true" : "false"}`);
    lines.push(`image_count: ${(tweet.images || []).length}`);
    const subPosts = tweet.subPosts || [];
    const continuations = subPosts.filter((s) => s.isAuthor).length;
    const replies = subPosts.length - continuations;
    lines.push(`has_thread: ${subPosts.length > 0 ? "true" : "false"}`);
    lines.push(`subpost_count: ${subPosts.length}`);
    lines.push(`thread_count: ${continuations}`);
    lines.push(`comment_count: ${replies}`);
    lines.push(`parent_count: ${(tweet.parentChain || []).length}`);
    lines.push(`tags: [bookmark${tweet.isArticle ? ", article" : ""}${tweet.hasVideo ? ", video" : ""}${continuations > 0 ? ", thread" : ""}]`);
    lines.push("---");
    return lines.join("\n");
  }

  // Returns a wikilink to the parent's .md if we know its filename pattern,
  // otherwise a plain permalink. Caller decides whether the parent is on
  // disk by passing the captured-id set.
  function parentLinkLine(parent, capturedIds) {
    const fname = bookmarkFilename(parent).replace(/\.md$/, "");
    if (capturedIds && capturedIds.has(parent.id)) {
      return `[[${fname}|@${parent.author.handle}: ${(parent.text || "").slice(0, 80).replace(/\s+/g, " ").trim()}]]`;
    }
    return `[@${parent.author.handle}](${parent.permalink}): ${(parent.text || "").slice(0, 80).replace(/\s+/g, " ").trim()}`;
  }

  function tweetToMarkdown(tweet, opts = {}) {
    const capturedIds = opts.capturedIds || new Set();
    const exportedAt = formatLocalDate(new Date().toISOString());
    const kind = tweet.isArticle ? "Article" : "Tweet";
    const lines = [];
    lines.push(tweetFrontmatter(tweet));
    lines.push("");
    lines.push(`# ${kind} by ${tweet.author.name} (@${tweet.author.handle})`);
    lines.push("");
    lines.push(`- **Posted**: ${formatLocalDate(tweet.timestamp)}`);
    lines.push(`- **Permalink**: ${tweet.permalink}`);
    lines.push(`- **Exported**: ${exportedAt}`);
    if (tweet.isArticle) lines.push(`- **Type**: long-form Article`);
    lines.push("");
    if ((tweet.parentChain || []).length > 0) {
      lines.push("## Conversation parents");
      lines.push("");
      lines.push("_(this bookmark is a reply / part of a thread; parents shown oldest first)_");
      lines.push("");
      for (const p of tweet.parentChain) {
        lines.push(`- ${parentLinkLine(p, capturedIds)}`);
      }
      lines.push("");
    }
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
    const subs = tweet.subPosts || [];
    if (subs.length > 0) {
      const continuations = subs.filter((s) => s.isAuthor);
      const replies = subs.filter((s) => !s.isAuthor);

      const renderSub = (sub) => {
        lines.push(`### ${sub.author.name} (@${sub.author.handle}) — ${formatLocalDate(sub.timestamp)}`);
        lines.push("");
        if (sub.text) { lines.push(sub.text); lines.push(""); }
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
      };

      if (continuations.length > 0) {
        lines.push("---");
        lines.push("");
        lines.push(`## Thread continuations by @${tweet.author.handle}`);
        lines.push("");
        lines.push(`_(${continuations.length} post${continuations.length === 1 ? "" : "s"} where the author continues this bookmark in the replies)_`);
        lines.push("");
        for (const sub of continuations) renderSub(sub);
      }

      if (replies.length > 0) {
        lines.push("---");
        lines.push("");
        lines.push(`## Top comments (${replies.length})`);
        lines.push("");
        lines.push(`_(top ${replies.length} replies as ranked by X at capture time, max ${SUBPOST_LIMIT} total sub-posts)_`);
        lines.push("");
        for (const sub of replies) renderSub(sub);
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
    "tweet_id,author_name,author_handle,posted_at,bookmarked_at,permalink,has_video,image_count,is_article,has_thread,subpost_count,thread_count,comment_count,text_preview,md_filename";

  function tweetToCsvRow(tweet, exportedAt) {
    const preview = (tweet.text || "").replace(/\s+/g, " ").slice(0, 120);
    const subs = tweet.subPosts || [];
    const continuations = subs.filter((s) => s.isAuthor).length;
    const replies = subs.length - continuations;
    return [
      tweet.id,
      tweet.author.name,
      tweet.author.handle,
      tweet.timestamp,
      exportedAt,
      tweet.permalink,
      tweet.hasVideo ? "yes" : "no",
      tweet.images.length,
      tweet.isArticle ? "yes" : "no",
      subs.length > 0 ? "yes" : "no",
      subs.length,
      continuations,
      replies,
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

  // Cache of captured tweet IDs in the folder; used for Obsidian-style
  // wikilinks. Built lazily, kept in sync as we write new files.
  let CAPTURED_IDS = null;
  async function getCapturedIds(dirHandle) {
    if (CAPTURED_IDS) return CAPTURED_IDS;
    const set = new Set();
    try {
      for await (const [name, h] of dirHandle.entries()) {
        if (h.kind !== "file" || !name.endsWith(".md")) continue;
        const m = name.match(/_(\d+)\.md$/);
        if (m) set.add(m[1]);
      }
    } catch (e) {
      console.warn("[Bookmarks] capturedIds scan failed", e);
    }
    CAPTURED_IDS = set;
    return set;
  }

  // _search.json maintains a flat array of every captured tweet's lookup
  // info -- handy for external tools, Obsidian Dataview, or a future
  // search UI. Auto-updated on every write.
  async function readSearchIndex(dirHandle) {
    const text = await readFileText(dirHandle, "_search.json");
    if (!text) return [];
    try { return JSON.parse(text); } catch { return []; }
  }
  async function writeSearchIndex(dirHandle, entries) {
    const fh = await dirHandle.getFileHandle("_search.json", { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(entries, null, 1));
    await w.close();
  }
  let searchQueue = Promise.resolve();
  async function upsertSearchEntry(dirHandle, tweet) {
    searchQueue = searchQueue.then(async () => {
      const entries = await readSearchIndex(dirHandle);
      const idx = entries.findIndex((e) => e.id === tweet.id);
      const entry = {
        id: tweet.id,
        handle: tweet.author.handle,
        name: tweet.author.name,
        type: tweet.isArticle ? "article" : "tweet",
        permalink: tweet.permalink,
        filename: bookmarkFilename(tweet),
        text: (tweet.text || "").slice(0, 500),
        has_video: tweet.hasVideo,
        image_count: (tweet.images || []).length,
        posted: tweet.timestamp,
      };
      if (idx >= 0) entries[idx] = entry;
      else entries.push(entry);
      await writeSearchIndex(dirHandle, entries);
    }).catch((e) => console.warn("[Bookmarks] search index update failed", e));
    return searchQueue;
  }

  // Returns a status: "created" if newly written, "upgraded" if overwritten
  // with a meaningfully better capture, "skipped" if existing content is
  // already at least as good. The upgrade path lets a re-bookmark from the
  // article-detail page replace a previously-truncated bulk-export file.
  async function writeBookmarkFile(dirHandle, tweet) {
    const filename = bookmarkFilename(tweet);
    const capturedIds = await getCapturedIds(dirHandle);
    const newContent = tweetToMarkdown(tweet, { capturedIds });
    const existing = await readFileText(dirHandle, filename);
    if (existing != null) {
      const newIsArticle = tweet.isArticle === true;
      const existingIsArticle = /\*\*Type\*\*: long-form Article/.test(existing) || /^type:\s*article/m.test(existing);
      const isUpgrade =
        (newIsArticle && !existingIsArticle) ||
        newContent.length > existing.length + 200;
      if (!isUpgrade) return "skipped";
    }
    const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(newContent);
    await writable.close();
    capturedIds.add(tweet.id);
    upsertSearchEntry(dirHandle, tweet).catch(() => {});
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

  // Snapshot bookmarks.csv to bookmarks.YYYY-MM-DD-HHMMSS.csv before any
  // destructive export operation. Keeps last 5 rolling backups.
  async function rotateCsvBackup(dirHandle) {
    try {
      const text = await readFileText(dirHandle, "bookmarks.csv");
      if (!text || text.trim() === CSV_HEADER) return;
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const name = `bookmarks.${ts}.csv`;
      const fh = await dirHandle.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(text);
      await w.close();
      // Cleanup older backups beyond the last 5
      const backups = [];
      for await (const [n, h] of dirHandle.entries()) {
        if (h.kind !== "file") continue;
        if (/^bookmarks\.\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.csv$/.test(n)) backups.push(n);
      }
      backups.sort();
      while (backups.length > 5) {
        const oldest = backups.shift();
        try { await dirHandle.removeEntry(oldest); } catch {}
      }
    } catch (e) {
      console.warn("[Bookmarks] CSV backup rotation failed", e);
    }
  }

  // Append a single row to _health.csv after each tweet processed during
  // deep export. Lets the user / future debugging see the raw timeline of
  // navigations: when, where, ok/fail, how long, what kind of failure.
  const HEALTH_HEADER = "timestamp,phase,url,status,duration_ms,kind";
  async function appendHealthRow(dirHandle, row) {
    try {
      let existing = "";
      try {
        existing = await (await (await dirHandle.getFileHandle("_health.csv")).getFile()).text();
      } catch {}
      const lines = existing ? existing.replace(/\n+$/, "").split("\n").filter(Boolean) : [];
      if (lines[0] !== HEALTH_HEADER) lines.unshift(HEALTH_HEADER);
      lines.push(row);
      const fh = await dirHandle.getFileHandle("_health.csv", { create: true });
      const w = await fh.createWritable();
      await w.write(lines.join("\n") + "\n");
      await w.close();
    } catch (e) {
      console.warn("[Bookmarks] health log append failed", e);
    }
  }

  // Write a human-readable summary at the end of a deep export run.
  // Overwrites previous summary (one current snapshot per folder).
  async function writeDeepExportSummary(dirHandle, state) {
    try {
      const lines = [];
      const dur = state.finishedAt && state.startedAt
        ? Math.round((state.finishedAt - state.startedAt) / 1000)
        : null;
      lines.push("# Deep export summary");
      lines.push("");
      lines.push(`- **Started**: ${formatLocalDate(new Date(state.startedAt).toISOString())}`);
      if (state.finishedAt) lines.push(`- **Finished**: ${formatLocalDate(new Date(state.finishedAt).toISOString())}`);
      if (dur !== null) {
        const m = Math.floor(dur / 60);
        const s = dur % 60;
        lines.push(`- **Total time**: ${m}m ${s}s`);
      }
      lines.push(`- **Status**: ${state.status}`);
      lines.push(`- **URLs found in bookmarks list**: ${state.totalFound || state.queue.length}`);
      lines.push(`- **Already-captured (skipped)**: ${state.alreadyCaptured || 0}`);
      lines.push(`- **Truncated (re-processed)**: ${state.reprocessing || 0}`);
      if (state.batchTrimmed) lines.push(`- **Deferred (batch limit)**: ${state.batchTrimmed}`);
      lines.push(`- **Successfully captured**: ${state.completed || 0}`);
      lines.push(`- **Failed**: ${(state.failed || []).length}`);
      lines.push(`- **Retried via retry queue**: ${(state.retryQueue || []).length}`);
      lines.push("");
      lines.push("## Settings used");
      lines.push("");
      lines.push(`- Per-bookmark delay: ${DEEP_DELAY_MIN / 1000}-${DEEP_DELAY_MAX / 1000}s`);
      lines.push(`- Cooldown every ${COOLDOWN_EVERY} bookmarks: ${COOLDOWN_MS / 1000}s`);
      lines.push(`- Max retries per URL: ${MAX_RETRIES}`);
      lines.push(`- Rate-limit pause: ${RATE_LIMIT_PAUSE_MS / 60000} min`);
      lines.push("");
      if ((state.failed || []).length > 0) {
        lines.push("## Failed URLs");
        lines.push("");
        lines.push("| Kind | URL | Reason |");
        lines.push("|---|---|---|");
        for (const f of state.failed) {
          const reason = (f.reason || "").replace(/\|/g, "\\|");
          lines.push(`| ${f.kind || "—"} | ${f.url} | ${reason} |`);
        }
        lines.push("");
      }
      const fh = await dirHandle.getFileHandle("_deep-export-summary.md", { create: true });
      const w = await fh.createWritable();
      await w.write(lines.join("\n"));
      await w.close();
    } catch (e) {
      console.warn("[Bookmarks] failed to write summary", e);
    }
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
      document.getElementById("tx-bm-toolbar")?.remove();
      return;
    }
    if (document.getElementById("tx-bm-toolbar")) return;

    const header = findHeader();
    const parent = header && header.parentElement;
    if (!parent) return;

    const toolbar = document.createElement("div");
    toolbar.id = "tx-bm-toolbar";
    toolbar.className = "tx-bm-toolbar";

    // Quick export
    const quick = document.createElement("button");
    quick.id = "tx-bm-trigger";
    quick.className = "tx-bm-trigger";
    quick.textContent = "📁 Quick";
    quick.title = "Fast scroll-and-capture from the bookmarks list. Articles come out truncated; use Deep export for full content.";
    quick.addEventListener("click", startExport);
    toolbar.appendChild(quick);

    // Deep export with batch dropdown (joined as one pill)
    const deepWrap = document.createElement("span");
    deepWrap.id = "tx-bm-deep-wrapper";
    deepWrap.className = "tx-bm-deep-wrapper";

    const select = document.createElement("select");
    select.id = "tx-bm-deep-batch";
    select.className = "tx-bm-deep-batch";
    select.title = "How many bookmarks to process in this run";
    [
      ["50", "next 50"],
      ["100", "next 100"],
      ["200", "next 200"],
      ["0", "all"],
    ].forEach(([value, label]) => {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      if (value === "0") opt.selected = true;
      select.appendChild(opt);
    });

    const deep = document.createElement("button");
    deep.id = "tx-bm-deep-trigger";
    deep.className = "tx-bm-trigger tx-bm-trigger--deep";
    deep.textContent = "🌊 Deep";
    deep.title = "Slow but complete: opens every bookmarked tweet's detail page and captures the full article + thread + top 20 sub-posts.";
    deep.addEventListener("click", () => {
      const limit = parseInt(select.value, 10) || 0;
      startDeepExport({ batchLimit: limit });
    });
    deepWrap.appendChild(select);
    deepWrap.appendChild(deep);
    toolbar.appendChild(deepWrap);

    // Integrity check
    const integrity = document.createElement("button");
    integrity.id = "tx-bm-integrity-trigger";
    integrity.className = "tx-bm-trigger tx-bm-trigger--integrity";
    integrity.textContent = "🔍 Check";
    integrity.title = "Scan folder for orphan .md files or orphan CSV rows";
    integrity.addEventListener("click", runIntegrityCheck);
    toolbar.appendChild(integrity);

    // Count badge
    const badge = document.createElement("span");
    badge.id = "tx-bm-count";
    badge.className = "tx-bm-count";
    badge.textContent = "📚 …";
    toolbar.appendChild(badge);

    // Insert as a row right after X's sticky header so we never overlap
    // the search input or fight the header for horizontal space.
    if (header.nextSibling) {
      parent.insertBefore(toolbar, header.nextSibling);
    } else {
      parent.appendChild(toolbar);
    }
    refreshBookmarkCount();
  }

  // ---------- Server-side fallback (X syndication API via FastAPI) ----------

  async function fetchTweetViaBackend(url) {
    try {
      const res = await chrome.runtime.sendMessage({ type: "fetchTweetViaBackend", url });
      if (!res || !res.ok) return null;
      return res.data;
    } catch (e) {
      console.warn("[Bookmarks] backend fetch failed", url, e);
      return null;
    }
  }

  function backendResponseToTweet(d) {
    if (!d || !d.id) return null;
    return {
      id: String(d.id),
      author: { name: d.author_name || d.author_handle || "", handle: d.author_handle || "" },
      timestamp: d.timestamp || new Date().toISOString(),
      text: d.text || "",
      images: Array.isArray(d.image_urls) ? d.image_urls : [],
      hasVideo: !!d.has_video,
      permalink: d.permalink || "",
      quoted: null,
      isArticle: false,        // syndication doesn't expose article body
      truncated: false,
      subPosts: [],
      parentChain: [],
    };
  }

  async function retryFailedViaBackend(state) {
    const handle = await getSyncHandle();
    if (!handle) return { recovered: 0, stillFailed: 0 };
    const fails = state.failed || [];
    let recovered = 0;
    let stillFailed = 0;
    for (const f of fails) {
      // Skip permanent failures (deleted, unavailable) — not worth retrying.
      if (f.kind === "deleted" || f.kind === "unavailable") {
        stillFailed++;
        continue;
      }
      const data = await fetchTweetViaBackend(f.url);
      const tweet = backendResponseToTweet(data);
      if (!tweet || !tweet.id) {
        stillFailed++;
        continue;
      }
      try {
        await writeBookmarkFile(handle, tweet);
        await appendCsvRow(handle, tweet);
        recovered++;
      } catch (e) {
        console.warn("[Bookmarks] backend-recovered write failed", f.url, e);
        stillFailed++;
      }
    }
    refreshBookmarkCount().catch(() => {});
    return { recovered, stillFailed };
  }

  // ---------- Folder integrity check ----------

  async function runIntegrityCheck() {
    const handle = await getSyncHandle();
    if (!handle) {
      alert('No folder set yet. Click "Quick export" or "Deep export" first to choose one.');
      return;
    }
    // Collect .md files keyed by tweet id
    const mdById = new Map();
    try {
      for await (const [name, h] of handle.entries()) {
        if (h.kind !== "file" || !name.endsWith(".md")) continue;
        const m = name.match(/_(\d+)\.md$/);
        if (m) mdById.set(m[1], name);
      }
    } catch (e) {
      alert("Couldn't read folder: " + (e.message || e));
      return;
    }
    // Collect CSV row ids
    const csvIds = new Set();
    try {
      const text = await readCsvText(handle);
      const lines = text.replace(/\n+$/, "").split("\n").filter(Boolean);
      for (let i = 1; i < lines.length; i++) csvIds.add(csvFirstColumn(lines[i]));
    } catch {}

    const orphanFiles = [];
    for (const [id, name] of mdById) {
      if (!csvIds.has(id)) orphanFiles.push({ id, name });
    }
    const orphanRows = [];
    for (const id of csvIds) {
      if (!mdById.has(id)) orphanRows.push(id);
    }

    showIntegrityModal({
      handle,
      orphanFiles,
      orphanRows,
      totalMd: mdById.size,
      totalCsv: csvIds.size,
    });
  }

  function showIntegrityModal({ handle, orphanFiles, orphanRows, totalMd, totalCsv }) {
    const dlg = document.createElement("dialog");
    dlg.id = "tx-bm-integrity-modal";
    dlg.className = "tx-bm-integrity-modal";
    const filesList = orphanFiles.length === 0
      ? "<em>None — every .md is in the CSV.</em>"
      : `<ul>${orphanFiles.slice(0, 20).map(f => `<li>${f.name}</li>`).join("")}${orphanFiles.length > 20 ? `<li>… +${orphanFiles.length - 20} more</li>` : ""}</ul>`;
    const rowsList = orphanRows.length === 0
      ? "<em>None — every CSV row has its .md file.</em>"
      : `<ul>${orphanRows.slice(0, 20).map(id => `<li>tweet_id ${id}</li>`).join("")}${orphanRows.length > 20 ? `<li>… +${orphanRows.length - 20} more</li>` : ""}</ul>`;
    dlg.innerHTML = `
      <div class="tx-bm-integrity-inner">
        <button class="tx-bm-integrity-close" aria-label="Close">×</button>
        <h2>🔍 Folder integrity check</h2>
        <p>Scanned <b>${totalMd}</b> .md files and <b>${totalCsv}</b> CSV rows.</p>
        <h3>Orphan .md files (${orphanFiles.length})</h3>
        <p class="tx-bm-integrity-help">.md files on disk that don't have a row in bookmarks.csv. Usually leftover from un-bookmarking, or from before the CSV was created.</p>
        ${filesList}
        ${orphanFiles.length > 0 ? '<button class="tx-bm-integrity-fix-rows">Add ' + orphanFiles.length + ' rows to CSV</button>' : ""}
        <h3>Orphan CSV rows (${orphanRows.length})</h3>
        <p class="tx-bm-integrity-help">Rows in bookmarks.csv whose .md file is missing on disk. Usually deleted manually.</p>
        ${rowsList}
        ${orphanRows.length > 0 ? '<button class="tx-bm-integrity-fix-files">Remove ' + orphanRows.length + ' orphan rows from CSV</button>' : ""}
      </div>
    `;
    document.body.appendChild(dlg);
    dlg.showModal();
    dlg.querySelector(".tx-bm-integrity-close").addEventListener("click", () => { dlg.close(); dlg.remove(); });

    const addRowsBtn = dlg.querySelector(".tx-bm-integrity-fix-rows");
    if (addRowsBtn) {
      addRowsBtn.addEventListener("click", async () => {
        addRowsBtn.disabled = true;
        addRowsBtn.textContent = "Reading orphan files…";
        let added = 0;
        for (const { name } of orphanFiles) {
          try {
            const fh = await handle.getFileHandle(name);
            const text = await (await fh.getFile()).text();
            const tweet = parseMarkdownToTweet(text, name);
            if (tweet) {
              await appendCsvRow(handle, tweet);
              added++;
            }
          } catch (e) {
            console.warn("[Integrity] couldn't reconstruct row from", name, e);
          }
        }
        addRowsBtn.textContent = `Added ${added} of ${orphanFiles.length}`;
        await refreshBookmarkCount();
      });
    }

    const removeRowsBtn = dlg.querySelector(".tx-bm-integrity-fix-files");
    if (removeRowsBtn) {
      removeRowsBtn.addEventListener("click", async () => {
        removeRowsBtn.disabled = true;
        removeRowsBtn.textContent = "Removing rows…";
        for (const id of orphanRows) {
          try { await removeCsvRow(handle, id); } catch {}
        }
        removeRowsBtn.textContent = `Removed ${orphanRows.length} rows`;
        await refreshBookmarkCount();
      });
    }
  }

  // Best-effort reconstruction of a tweet object from a saved .md file,
  // used by integrity-check when adding orphan files back to the CSV.
  function parseMarkdownToTweet(md, filename) {
    const m = filename.match(/_(\d+)\.md$/);
    const id = m && m[1];
    if (!id) return null;
    const headerMatch = md.match(/^# (?:Tweet|Article) by (.+?) \(@([^)]+)\)/m);
    const postedMatch = md.match(/\*\*Posted\*\*: (\S+ \S+)/);
    const linkMatch = md.match(/\*\*Permalink\*\*: (\S+)/);
    const isArticle = /\*\*Type\*\*:\s*long-form Article/.test(md);
    const handle = headerMatch ? headerMatch[2] : "";
    const name = headerMatch ? headerMatch[1] : handle;
    const permalink = linkMatch ? linkMatch[1] : `https://x.com/${handle}/status/${id}`;
    const timestamp = postedMatch ? postedMatch[1].replace(" ", "T") + ":00.000Z" : new Date().toISOString();
    // Extract a short preview from the body (first line after the --- separator)
    const bodyMatch = md.split(/\n---\n+/)[1] || "";
    const previewLine = bodyMatch.split("\n").find((l) => l.trim() && !l.startsWith("##") && !l.startsWith("!["));
    return {
      id,
      author: { name, handle },
      timestamp,
      text: (previewLine || "").trim(),
      images: [],
      hasVideo: /## Video/.test(md),
      permalink,
      quoted: null,
      isArticle,
      subPosts: [],
    };
  }

  // Counts based on the folder's bookmarks.csv -- reflects what we've
  // captured locally, not your actual X total. Updates when buttons
  // re-render and after auto-sync writes.
  async function refreshBookmarkCount() {
    const badge = document.getElementById("tx-bm-count");
    if (!badge) return;
    const handle = await getSyncHandle();
    if (!handle) {
      badge.textContent = "📚 folder not set";
      return;
    }
    try {
      const text = await readCsvText(handle);
      const lines = text.replace(/\n+$/, "").split("\n").filter(Boolean);
      const n = Math.max(0, lines.length - 1); // minus header
      // Count truncated entries by scanning .md filename column for
      // currently truncated markers via a lightweight pass: read CSV's
      // text_preview column for the truncated marker. Cheap heuristic.
      let truncated = 0;
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].includes("[truncated")) truncated++;
      }
      badge.textContent = truncated > 0
        ? `📚 ${n} captured · ${truncated} need upgrade`
        : `📚 ${n} captured`;
    } catch {
      badge.textContent = "📚 (error reading CSV)";
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

    // Snapshot existing CSV before this run rewrites it.
    await rotateCsvBackup(dirHandle);

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
      refreshBookmarkCount().catch(() => {});
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
      refreshBookmarkCount().catch(() => {});
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
  const DEEP_DELAY_MIN = 5000;     // base jittered delay between URL navigations
  const DEEP_DELAY_MAX = 10000;
  const COOLDOWN_EVERY = 50;       // tweets between long cooldowns
  const COOLDOWN_MS = 30000;       // 30s pause every COOLDOWN_EVERY tweets
  const RATE_LIMIT_PAUSE_MS = 15 * 60 * 1000; // pause 15 min on 429 detection
  const MAX_RETRIES = 2;           // retry attempts per failed URL in retry queue
  const BACKOFF_BASE_MS = 5000;
  const BACKOFF_CAP_MS = 5 * 60 * 1000; // 5 min ceiling

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

  // Scan the folder for existing captures and classify each by quality.
  // - "good": file already has the full article body (long-form Article) or is
  //   a regular tweet whose preview-text is the full content. Skip during
  //   deep export -- no need to navigate.
  // - "truncated": file came from the bulk Quick export (had a "Show more"
  //   marker), or is suspiciously short, or empty. Re-process during deep
  //   export to upgrade it.
  async function detectExistingCaptures(dirHandle) {
    const map = new Map(); // tweetId -> "good" | "truncated"
    try {
      for await (const [name, h] of dirHandle.entries()) {
        if (h.kind !== "file") continue;
        if (!name.endsWith(".md")) continue;
        const m = name.match(/_(\d+)\.md$/);
        if (!m) continue;
        const tweetId = m[1];
        try {
          const text = await (await h.getFile()).text();
          const isArticle = /\*\*Type\*\*:\s*long-form Article/.test(text);
          const isTruncated = /\[truncated — see permalink for full text\]/.test(text);
          const tooShort = text.length < 250;
          if (isArticle) map.set(tweetId, "good");
          else if (isTruncated || tooShort) map.set(tweetId, "truncated");
          else map.set(tweetId, "good");
        } catch {}
      }
    } catch (e) {
      console.error("[Deep export] folder scan failed", e);
    }
    return map;
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

  // Classify why a page didn't yield an article. Distinguishes rate-limit
  // (need long pause) from a deleted tweet (skip permanently) from a
  // login wall (need user action).
  function classifyPageFailure() {
    const text = (document.body && document.body.innerText) || "";
    if (/rate.?limit|too many requests|try again later/i.test(text)) return "rate-limit";
    if (/this (post|tweet) (was|has been) (deleted|removed)/i.test(text)) return "deleted";
    if (/(post|tweet) is unavailable|account (suspended|doesn['']t exist)/i.test(text)) return "unavailable";
    if (/log in to (twitter|x)/i.test(text) || /sign in to (twitter|x)/i.test(text)) return "logged-out";
    return "unknown";
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

    // Phase 1.5: scan the folder for already-captured tweets and drop the
    // "good" ones from the queue so we don't navigate to URLs we already
    // have full content for. "Truncated" entries stay -- they need re-capture.
    updateDeepPanel(state, `Phase 1.5 — scanning existing files (${state.queue.length} URLs)…`);
    const dirHandle = await getSyncHandle();
    let alreadyGood = 0;
    let toReprocess = 0;
    let filteredQueue = state.queue;
    if (dirHandle) {
      const captures = await detectExistingCaptures(dirHandle);
      filteredQueue = [];
      for (const url of state.queue) {
        const m = url.match(/\/status\/(\d+)/);
        const id = m && m[1];
        const q = id && captures.get(id);
        if (q === "good") alreadyGood++;
        else {
          if (q === "truncated") toReprocess++;
          filteredQueue.push(url);
        }
      }
    }

    // Apply optional batch limit -- caps how many of the still-needing-work
    // URLs we process this run. Lets the user space exports across days.
    const batchLimit = state.batchLimit || 0;
    let limitedQueue = filteredQueue;
    let batchTrimmed = 0;
    if (batchLimit > 0 && filteredQueue.length > batchLimit) {
      limitedQueue = filteredQueue.slice(0, batchLimit);
      batchTrimmed = filteredQueue.length - batchLimit;
    }

    // Transition to Phase B
    const after = await patchDeepState({
      phase: "processing",
      cursor: 0,
      totalFound: state.queue.length,
      alreadyCaptured: alreadyGood,
      reprocessing: toReprocess,
      batchTrimmed,
      queue: limitedQueue,
      totalAtStart: limitedQueue.length,
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
  // navigate to the next URL. Handles rate-limit auto-pause, retry queue,
  // periodic cooldowns, and exponential backoff on consecutive failures.
  async function deepProcessCurrent(state) {
    // Re-read state at entry; user may have hit Cancel while page was loading.
    const entry = await getDeepState();
    if (!entry || entry.status !== "running") {
      if (entry) updateDeepPanel(entry);
      return;
    }
    state = entry;

    // If we're inside a rate-limit pause window, idle until it expires.
    if (state.pausedUntil && Date.now() < state.pausedUntil) {
      const remainMs = state.pausedUntil - Date.now();
      updateDeepPanel(state, `⏸ Rate-limit pause — resumes in ${Math.ceil(remainMs / 60000)} min`);
      // Sleep in chunks so cancel is responsive
      const checkInterval = 5000;
      while (Date.now() < state.pausedUntil) {
        await sleep(checkInterval);
        const fresh = await getDeepState();
        if (!fresh || fresh.status !== "running") return;
      }
      // Resume: navigate to current URL fresh
      location.href = state.queue[state.cursor];
      return;
    }

    updateDeepPanel(state);

    // Pick which queue we're working from -- main first, then retry queue
    const onRetry = state.phase === "retrying";
    const queue = onRetry ? state.retryQueue : state.queue;
    const expected = queue[state.cursor];
    const tStart = Date.now();
    const article = await waitForArticleStable(15000);

    // Coax X into rendering more replies into DOM before extraction so we
    // can capture the top ~20 comments + author thread continuations. X
    // virtualizes its reply list; without scrolling, only the first few
    // are present.
    if (article) {
      try {
        for (let i = 0; i < 2; i++) {
          window.scrollBy(0, window.innerHeight);
          await sleep(1200);
        }
        // Brief return to top so the bookmarked article is the one we
        // pick up first when extractTweetWithThread queries.
        window.scrollTo(0, 0);
        await sleep(400);
      } catch {}
    }

    let completedDelta = 0;
    let newFailure = null;
    let kind = "ok";

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
            kind = "no-folder";
          }
        } else {
          newFailure = { url: expected, reason: "extractTweet returned null" };
          kind = "extract-null";
        }
      } catch (e) {
        console.error("[Deep export] extraction failed", expected, e);
        newFailure = { url: expected, reason: e.message || String(e) };
        kind = "extract-error";
      }
    } else {
      kind = classifyPageFailure();
      newFailure = { url: expected, reason: `article didn't render (${kind})` };
    }

    // Append health-log row for this tweet (best effort, non-blocking).
    const handleForLog = await getSyncHandle();
    if (handleForLog) {
      const status = completedDelta ? "ok" : (newFailure ? "fail" : "skip");
      const row = [
        new Date().toISOString(),
        onRetry ? "retry" : "phase2",
        expected,
        status,
        Date.now() - tStart,
        kind,
      ].map(csvEscape).join(",");
      appendHealthRow(handleForLog, row).catch(() => {});
    }

    // Build state updates
    const updates = { cursor: state.cursor + 1, lastTickAt: Date.now() };
    let triggerPause = false;

    if (completedDelta) {
      updates.completed = (state.completed || 0) + completedDelta;
      updates.consecutiveFailures = 0;
      // Track per-tweet timing for ETA
      const dur = Date.now() - tStart;
      const recent = state.recentDurations || [];
      updates.recentDurations = [...recent.slice(-9), dur];
    } else {
      updates.consecutiveFailures = (state.consecutiveFailures || 0) + 1;
    }

    if (newFailure) {
      updates.failed = [...state.failed, { ...newFailure, kind, retryCount: state.failedAttempts?.[expected] || 0 }];
      // Move "rate-limit" or "unknown timeout" failures into retry queue (worth re-trying).
      // "deleted", "unavailable", "logged-out" are permanent skips.
      if (!onRetry && (kind === "rate-limit" || kind === "unknown")) {
        const attempts = (state.failedAttempts && state.failedAttempts[expected]) || 0;
        if (attempts < MAX_RETRIES) {
          updates.retryQueue = [...(state.retryQueue || []), expected];
          updates.failedAttempts = { ...(state.failedAttempts || {}), [expected]: attempts + 1 };
        }
      }
      if (kind === "rate-limit") triggerPause = true;
    }

    if (triggerPause) {
      updates.pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
      updates.cursor = state.cursor; // hold on this URL; retry after pause
    }

    const after = await patchDeepState(updates);
    if (!after || after.status !== "running") {
      if (after) updateDeepPanel(after);
      return;
    }

    if (triggerPause) {
      updateDeepPanel(after, `⏸ Rate-limit detected — pausing 15 min before retrying`);
      await sleep(RATE_LIMIT_PAUSE_MS);
      const fresh = await getDeepState();
      if (!fresh || fresh.status !== "running") return;
      location.href = after.queue[after.cursor];
      return;
    }

    // Did we finish the current queue?
    if (after.cursor >= queue.length) {
      // Main queue done -> switch to retry queue if any
      if (!onRetry && (after.retryQueue || []).length > 0) {
        const next = await patchDeepState({ phase: "retrying", cursor: 0 });
        if (!next || next.status !== "running") return;
        updateDeepPanel(next, `Retry pass — ${next.retryQueue.length} URLs to retry`);
        await sleep(5000); // breather before retry pass
        location.href = next.retryQueue[0];
        return;
      }
      await deepFinish(after, "done");
      return;
    }

    // Compute next-step delay. Base jitter + exponential backoff on
    // consecutive failures + periodic cooldown every COOLDOWN_EVERY.
    const baseDelay = DEEP_DELAY_MIN + Math.random() * (DEEP_DELAY_MAX - DEEP_DELAY_MIN);
    const failures = after.consecutiveFailures || 0;
    const backoff = failures > 0
      ? Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, failures - 1))
      : 0;
    const cooldown = (after.completed > 0 && after.completed % COOLDOWN_EVERY === 0) ? COOLDOWN_MS : 0;
    const delay = baseDelay + backoff + cooldown;

    let label = `Phase ${onRetry ? "Retry" : "2"} — ${after.cursor}/${queue.length}`;
    if (cooldown) label += ` · cooldown ${Math.round(cooldown / 1000)}s`;
    if (backoff) label += ` · backoff ${Math.round(backoff / 1000)}s`;
    label += ` · next in ${Math.round(delay / 1000)}s`;
    updateDeepPanel(after, label);
    await sleep(delay);

    // Final pre-nav cancel check so we never navigate after Cancel.
    const final = await getDeepState();
    if (!final || final.status !== "running") {
      if (final) updateDeepPanel(final);
      return;
    }
    const finalQueue = (final.phase === "retrying") ? final.retryQueue : final.queue;
    location.href = finalQueue[final.cursor];
  }

  async function deepFinish(state, status) {
    const final = await patchDeepState({ status, finishedAt: Date.now() });
    const stateOut = final || { ...state, status, finishedAt: Date.now() };
    // Best-effort summary file write
    try {
      const handle = await getSyncHandle();
      if (handle) await writeDeepExportSummary(handle, stateOut);
    } catch (e) {
      console.warn("[Bookmarks] summary write skipped", e);
    }
    if (location.pathname !== "/i/bookmarks") {
      location.href = "https://x.com/i/bookmarks";
    } else {
      updateDeepPanel(stateOut);
    }
  }

  async function startDeepExport(opts = {}) {
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
      retryQueue: [],
      failedAttempts: {},
      cursor: 0,
      completed: 0,
      failed: [],
      consecutiveFailures: 0,
      recentDurations: [],
      pausedUntil: 0,
      startedAt: Date.now(),
      lastTickAt: Date.now(),
      batchLimit: opts.batchLimit || 0, // 0 = no limit
      userConfirmedResume: true,        // fresh start = confirmed
    };
    await setDeepState(state);
    // Snapshot CSV before this deep export starts mutating it via upserts.
    await rotateCsvBackup(dirHandle);
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

    // Resume confirmation: if the last tick was more than 60s ago, the
    // user probably closed the browser or took a long break. Surface a
    // dialog before silently re-driving navigations -- otherwise a casual
    // x.com visit can re-trigger an old export they thought was done.
    const STALE_TICK_MS = 60 * 1000;
    const lastTick = state.lastTickAt || state.startedAt || 0;
    const isStale = Date.now() - lastTick > STALE_TICK_MS;
    if (isStale && !state.userConfirmedResume) {
      showResumeConfirmation(state);
      return true;
    }
    // Refresh lastTickAt so subsequent reloads within the run are recognized as fresh.
    await patchDeepState({ lastTickAt: Date.now() });

    if (state.phase === "collecting") {
      if (location.pathname === "/i/bookmarks") {
        await deepCollectURLs(state);
      } else {
        updateDeepPanel(state, "⏸ Paused — return to x.com/i/bookmarks to resume");
      }
      return true;
    }

    if (state.phase === "processing" || state.phase === "retrying") {
      const queue = state.phase === "retrying" ? state.retryQueue : state.queue;
      if (state.cursor >= queue.length) {
        // Main done -> kick into retrying if there are URLs to retry
        if (state.phase === "processing" && (state.retryQueue || []).length > 0) {
          const next = await patchDeepState({ phase: "retrying", cursor: 0 });
          if (next && next.status === "running" && next.retryQueue.length > 0) {
            location.href = next.retryQueue[0];
            return true;
          }
        }
        await deepFinish(state, "done");
        return true;
      }
      const expected = queue[state.cursor];
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

  // Surface a confirmation panel so a stale running state doesn't auto-resume
  // when the user just casually opens x.com.
  function showResumeConfirmation(state) {
    if (deepPanel) deepPanel.remove();
    deepPanel = document.createElement("div");
    deepPanel.id = "tx-bm-deep-overlay";
    deepPanel.className = "tx-bm-deep";
    const remaining = ((state.phase === "retrying" ? state.retryQueue : state.queue) || []).length - (state.cursor || 0);
    deepPanel.innerHTML = `
      <div class="tx-bm-title">⏸ Deep export was paused</div>
      <div class="tx-bm-counter">${state.completed || 0} done · ${remaining} remaining · ${(state.failed || []).length} failed</div>
      <div class="tx-bm-actions">
        <button class="tx-bm-resume">Resume</button>
        <button class="tx-bm-discard">Discard</button>
      </div>
    `;
    document.body.appendChild(deepPanel);
    deepPanel.querySelector(".tx-bm-resume").addEventListener("click", async () => {
      const after = await patchDeepState({ userConfirmedResume: true, lastTickAt: Date.now() });
      if (after) {
        showDeepPanel(after);
        // Re-trigger resume flow so it actually advances the queue.
        maybeResumeDeepExport().catch((e) => console.error("[Deep export] resume failed", e));
      }
    });
    deepPanel.querySelector(".tx-bm-discard").addEventListener("click", async () => {
      await clearDeepState();
      if (deepPanel) {
        deepPanel.remove();
        deepPanel = null;
      }
    });
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
      if (after) {
        updateDeepPanel(after);
        // Best-effort summary write so the user can see what happened.
        try {
          const h = await getSyncHandle();
          if (h) await writeDeepExportSummary(h, after);
        } catch {}
      }
      if (location.pathname !== "/i/bookmarks") {
        setTimeout(() => { location.href = "https://x.com/i/bookmarks"; }, 200);
      }
    });
  }

  function computeEta(state) {
    const durations = state.recentDurations || [];
    if (durations.length === 0) return null;
    const avgMs = durations.reduce((a, b) => a + b, 0) / durations.length;
    const queue = state.phase === "retrying" ? state.retryQueue : state.queue;
    const remaining = (queue || []).length - (state.cursor || 0);
    if (remaining <= 0) return null;
    // Add average per-bookmark inter-step delay (~7.5s base + cooldown amortized).
    const interMs = 7500 + (COOLDOWN_MS / COOLDOWN_EVERY);
    const etaMs = remaining * (avgMs + interMs);
    if (etaMs < 60_000) return `${Math.round(etaMs / 1000)}s`;
    if (etaMs < 60 * 60_000) return `${Math.round(etaMs / 60_000)}m`;
    return `${(etaMs / 3_600_000).toFixed(1)}h`;
  }

  function updateDeepPanel(state, customMsg) {
    if (!deepPanel) return;
    const counter = deepPanel.querySelector(".tx-bm-counter");
    const actions = deepPanel.querySelector(".tx-bm-actions");
    const skipNote = state.alreadyCaptured > 0 ? ` · ${state.alreadyCaptured} already-captured skipped` : "";
    const trimNote = state.batchTrimmed > 0 ? ` · ${state.batchTrimmed} deferred (batch limit)` : "";
    const eta = computeEta(state);
    const etaSuffix = eta ? ` · ETA ~${eta}` : "";
    if (state.status === "cancelled" || state.status === "done") {
      const verb = state.status === "cancelled" ? "⛔ Cancelled" : "✅ Done";
      const remaining = state.status === "cancelled"
        ? `, ${(state.queue || []).length - (state.cursor || 0)} remaining`
        : "";
      counter.textContent = `${verb} — ${state.completed || 0} captured, ${(state.failed || []).length} failed${remaining}${skipNote}${trimNote}`;
      const failedRetryable = (state.failed || []).filter(
        (f) => f.kind !== "deleted" && f.kind !== "unavailable"
      ).length;
      const retryBtn = (failedRetryable > 0 && !state.backendRetryDone)
        ? `<button class="tx-bm-retry-backend">Retry ${failedRetryable} failed via backend</button>`
        : "";
      actions.innerHTML = retryBtn + '<button class="tx-bm-close">Close</button>';
      const rb = actions.querySelector(".tx-bm-retry-backend");
      if (rb) {
        rb.addEventListener("click", async () => {
          rb.disabled = true;
          rb.textContent = "Retrying via backend…";
          const fresh = await getDeepState();
          const result = await retryFailedViaBackend(fresh || state);
          await patchDeepState({ backendRetryDone: true, backendRecovered: result.recovered });
          rb.textContent = `✅ ${result.recovered} recovered, ${result.stillFailed} still failed`;
        });
      }
    } else if (state.phase === "collecting") {
      counter.textContent = customMsg || `Phase 1 — collecting URLs: ${state.queue.length}`;
    } else if (state.phase === "processing" || state.phase === "retrying") {
      const queue = state.phase === "retrying" ? state.retryQueue : state.queue;
      const phaseLabel = state.phase === "retrying" ? "Retry pass" : "Phase 2";
      counter.textContent = customMsg ||
        `${phaseLabel} — ${state.cursor}/${(queue || []).length} (${state.completed} done, ${state.failed.length} failed${skipNote}${trimNote}${etaSuffix})`;
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

  // ---------- Auto-upgrade on view ----------

  // When the user opens any status detail page for a tweet that already
  // has a .md in their folder, transparently re-extract (now with the
  // article-body walker active) and overwrite the file IF the new capture
  // is meaningfully better. Restricted to tweets that already exist on
  // disk so casual browsing doesn't capture every random tweet they read.
  let autoUpgradeRanForUrl = null;
  async function tryAutoUpgradeOnView() {
    if (!isStatusDetailPage()) return;
    if (autoUpgradeRanForUrl === location.href) return;
    autoUpgradeRanForUrl = location.href;

    // Skip if a deep export is mid-flight; that loop is already doing this work.
    const deep = await getDeepState();
    if (deep && deep.status === "running") return;

    const article = await waitForArticleStable(10000);
    if (!article) return;

    const tweet = extractTweetWithThread(article);
    if (!tweet) return;

    const handle = await getSyncHandle();
    if (!handle) return;

    // Only act on tweets we've previously captured (file exists in folder).
    const filename = bookmarkFilename(tweet);
    const existing = await readFileText(handle, filename);
    if (existing == null) return;

    const status = await writeBookmarkFile(handle, tweet);
    if (status !== "upgraded") return;

    // CSV gets the refreshed text_preview only if the tweet is currently
    // bookmarked (otherwise the file is just an archive of a former
    // bookmark and shouldn't appear in the CSV).
    const isBookmarked = !!article.querySelector('[data-testid="removeBookmark"]');
    if (isBookmarked) await appendCsvRow(handle, tweet);

    showToast(`📁 Auto-upgraded @${tweet.author.handle}/${tweet.id.slice(-6)}`);
  }

  // ---------- Boot ----------

  // The header isn't always present at document_idle; SPA navigation also
  // doesn't reload the script, so we observe DOM changes and (re)inject
  // whenever the user is on the bookmarks page. Same observer also retries
  // the auto-upgrade-on-view if the URL changes via SPA navigation.
  const observer = new MutationObserver(() => {
    injectExportButton();
    if (location.href !== autoUpgradeRanForUrl) {
      tryAutoUpgradeOnView().catch((e) => console.error("[Auto-upgrade] failed", e));
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  injectExportButton();
  tryAutoUpgradeOnView().catch((e) => console.error("[Auto-upgrade] failed", e));

  // If a deep export is in progress (or just finished) the script needs
  // to either resume the queue or show the summary panel.
  maybeResumeDeepExport().catch((e) => console.error("[Deep export] resume failed", e));
})();
