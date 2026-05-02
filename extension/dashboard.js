// Bookmarks Command Center — dashboard logic.
//
// Loads the user's existing sync folder via the FileSystemDirectoryHandle
// stored in IndexedDB by bookmarks.js (same DB, same key). Reads the two
// CSVs that the extension produces (bookmarks.csv = captured tweets,
// _phase1-urls.csv = full Phase-1 inventory + Phase-2 status), joins them
// by tweet_id, and renders a filterable / sortable / bulk-actionable
// table.
//
// Per-row + bulk actions go through chrome.runtime messages to background.js,
// which opens an x.com tab with a magic ?txAction=... query param. The
// content script in bookmarks.js sees the param on load, runs the action
// (recapture / unbookmark / rebookmark), and the dashboard refreshes when
// the user hits Reload.

const DB_NAME = "tx-bookmarks";
const STORE = "handles";
const HANDLE_KEY = "bookmarks-folder";

const STATUS_FILTERS = [
  { id: "all", label: "All", exclusive: true },
  { id: "captured", label: "Captured" },
  { id: "failed", label: "Failed" },
  { id: "pending", label: "Pending" },
  { id: "deferred", label: "Deferred" },
  { id: "skipped", label: "Skipped" },
];
const TRAIT_FILTERS = [
  { id: "incomplete", label: "Incomplete" },
  { id: "partial", label: "Partial" },
  { id: "has_video", label: "Has video" },
  { id: "is_article", label: "Article" },
  { id: "has_thread", label: "Thread" },
];

const state = {
  dirHandle: null,
  rows: [],            // joined merged rows
  filteredRows: [],
  selectedIds: new Set(),
  sort: { col: "bookmarked_at", dir: "desc" },
  filters: {
    status: "all",
    traits: new Set(),
    search: "",
  },
  runStatus: null,
};

// ---------- IndexedDB handle ----------

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
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

async function saveHandle(h) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(h, HANDLE_KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function ensurePermission(handle) {
  const opts = { mode: "readwrite" };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  if ((await handle.requestPermission(opts)) === "granted") return true;
  return false;
}

// ---------- CSV parsing ----------
//
// Tolerates double-quoted fields with embedded commas, doubled quotes for
// escaping, and CRLF line endings. Returns array of objects keyed by header.
function parseCsv(text) {
  if (!text) return [];
  const rows = [];
  let i = 0;
  let field = "";
  let row = [];
  let inQuotes = false;
  const len = text.length;
  while (i < len) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\n" || c === "\r") {
      row.push(field);
      field = "";
      // Skip CRLF as a single newline
      if (c === "\r" && text[i + 1] === "\n") i += 2;
      else i++;
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      continue;
    }
    field += c;
    i++;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => {
    const obj = {};
    for (let k = 0; k < header.length; k++) obj[header[k]] = r[k] != null ? r[k] : "";
    return obj;
  });
}

async function readFileText(dirHandle, name) {
  try {
    const fh = await dirHandle.getFileHandle(name);
    return await (await fh.getFile()).text();
  } catch {
    return null;
  }
}

// ---------- Data load + join ----------

async function loadAllData() {
  if (!state.dirHandle) return;
  const [bookmarksText, phase1Text, healthText] = await Promise.all([
    readFileText(state.dirHandle, "bookmarks.csv"),
    readFileText(state.dirHandle, "_phase1-urls.csv"),
    readFileText(state.dirHandle, "_health.csv"),
  ]);

  const captures = parseCsv(bookmarksText || "");
  const phase1 = parseCsv(phase1Text || "");

  // Index captures by tweet_id for join
  const capById = new Map();
  for (const c of captures) capById.set(c.tweet_id, c);

  // Start from phase1 rows so we get every URL Phase 1 found, even
  // those not in bookmarks.csv (failed / pending / deferred / skipped).
  // Then merge in capture details where present.
  const merged = [];
  const seen = new Set();
  for (const p of phase1) {
    const cap = capById.get(p.tweet_id);
    seen.add(p.tweet_id);
    merged.push({
      tweet_id: p.tweet_id,
      permalink: p.permalink || (cap && cap.permalink) || "",
      phase2_status: p.phase2_status || "",
      phase2_kind: p.phase2_kind || "",
      phase2_at: p.phase2_at || "",
      phase1_at: p.phase1_at || "",
      // Capture details (may be empty for non-captured rows)
      author_name: (cap && cap.author_name) || "",
      author_handle: (cap && cap.author_handle) || "",
      posted_at: (cap && cap.posted_at) || "",
      bookmarked_at: (cap && cap.bookmarked_at) || "",
      has_video: (cap && cap.has_video) === "yes",
      image_count: cap ? Number(cap.image_count || 0) : 0,
      is_article: (cap && cap.is_article) === "yes",
      has_thread: (cap && cap.has_thread) === "yes",
      subpost_count: cap ? Number(cap.subpost_count || 0) : 0,
      thread_count: cap ? Number(cap.thread_count || 0) : 0,
      comment_count: cap ? Number(cap.comment_count || 0) : 0,
      text_preview: (cap && cap.text_preview) || "",
      md_filename: (cap && cap.md_filename) || "",
      capture_complete: (cap && cap.capture_complete) || (p.phase2_status === "captured" ? "true" : "unknown"),
      capture_warnings: cap && cap.capture_warnings ? cap.capture_warnings.split(";").filter(Boolean) : [],
    });
  }
  // Captures not in phase1 (e.g. captured before phase1 csv existed) — show
  // them anyway so the table reflects everything in bookmarks.csv.
  for (const c of captures) {
    if (seen.has(c.tweet_id)) continue;
    merged.push({
      tweet_id: c.tweet_id,
      permalink: c.permalink,
      phase2_status: "captured",
      phase2_kind: "",
      phase2_at: c.bookmarked_at || "",
      phase1_at: "",
      author_name: c.author_name || "",
      author_handle: c.author_handle || "",
      posted_at: c.posted_at || "",
      bookmarked_at: c.bookmarked_at || "",
      has_video: c.has_video === "yes",
      image_count: Number(c.image_count || 0),
      is_article: c.is_article === "yes",
      has_thread: c.has_thread === "yes",
      subpost_count: Number(c.subpost_count || 0),
      thread_count: Number(c.thread_count || 0),
      comment_count: Number(c.comment_count || 0),
      text_preview: c.text_preview || "",
      md_filename: c.md_filename || "",
      capture_complete: c.capture_complete || "true",
      capture_warnings: c.capture_warnings ? c.capture_warnings.split(";").filter(Boolean) : [],
    });
  }

  state.rows = merged;
  state.healthText = healthText || "";
  applyFilters();
  renderStats();
  renderHealthLog();
  renderFailedBreakdown();
  renderRunStatus();
}

// ---------- Filtering + sorting ----------

function applyFilters() {
  const q = state.filters.search.trim().toLowerCase();
  const statusFilter = state.filters.status;
  const traits = state.filters.traits;
  state.filteredRows = state.rows.filter((r) => {
    if (statusFilter !== "all" && r.phase2_status !== statusFilter) return false;
    if (traits.has("has_video") && !r.has_video) return false;
    if (traits.has("is_article") && !r.is_article) return false;
    if (traits.has("has_thread") && !r.has_thread) return false;
    if (traits.has("incomplete") && r.capture_complete !== "false") return false;
    if (traits.has("partial") && r.capture_complete !== "partial") return false;
    if (q) {
      const hay = `${r.author_handle} ${r.author_name} ${r.text_preview} ${r.tweet_id}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  sortRows();
  renderRows();
}

function sortRows() {
  const { col, dir } = state.sort;
  const factor = dir === "asc" ? 1 : -1;
  state.filteredRows.sort((a, b) => {
    const av = a[col];
    const bv = b[col];
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * factor;
    return String(av || "").localeCompare(String(bv || "")) * factor;
  });
}

// ---------- Rendering ----------

function renderStats() {
  const total = state.rows.length;
  const byStatus = {};
  let complete = 0, partial = 0, incomplete = 0;
  for (const r of state.rows) {
    byStatus[r.phase2_status] = (byStatus[r.phase2_status] || 0) + 1;
    if (r.capture_complete === "true") complete++;
    else if (r.capture_complete === "partial") partial++;
    else if (r.capture_complete === "false") incomplete++;
  }
  const cards = [
    { label: "Found", value: total, sub: "in last Phase 1" },
    { label: "Captured", value: byStatus.captured || 0, klass: "green" },
    { label: "Failed", value: byStatus.failed || 0, klass: "red" },
    { label: "Pending", value: byStatus.pending || 0, klass: "yellow", sub: "Phase 2 not reached" },
    { label: "Deferred", value: byStatus.deferred || 0, sub: "batch limit" },
    { label: "Skipped", value: byStatus.skipped || 0, sub: "already good" },
    { label: "Complete", value: complete, klass: "green" },
    { label: "Partial", value: partial, klass: "partial" },
    { label: "Incomplete", value: incomplete, klass: "red" },
  ];
  document.getElementById("stats").innerHTML = cards.map((c) =>
    `<div class="stat-card ${c.klass || ""}">
      <div class="stat-label">${c.label}</div>
      <div class="stat-value">${c.value.toLocaleString()}</div>
      ${c.sub ? `<div class="stat-sub">${c.sub}</div>` : ""}
    </div>`
  ).join("");
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(s) {
  if (!s) return "";
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})[T ]?(\d{2}:\d{2})?/);
  return m ? `${m[1]}${m[2] ? " " + m[2] : ""}` : String(s).slice(0, 16);
}

function renderRows() {
  const tbody = document.getElementById("rows-body");
  document.getElementById("empty-state").style.display = state.filteredRows.length ? "none" : "block";
  if (state.filteredRows.length === 0) {
    tbody.innerHTML = "";
    return;
  }
  const html = state.filteredRows.map((r) => {
    const checked = state.selectedIds.has(r.tweet_id) ? "checked" : "";
    const handle = r.author_handle ? `@${escapeHtml(r.author_handle)}` : `<span class="muted">(uncaptured)</span>`;
    const warnings = (r.capture_warnings || [])
      .map((w) => `<span class="warning-tag" title="${escapeHtml(w)}">${escapeHtml(w)}</span>`)
      .join("");
    const statusKind = r.phase2_kind ? ` (${escapeHtml(r.phase2_kind)})` : "";
    const completePill = r.capture_complete
      ? `<span class="pill pill-${escapeHtml(r.capture_complete)}">${escapeHtml(r.capture_complete)}</span>`
      : `<span class="pill pill-unknown">—</span>`;
    return `<tr data-id="${escapeHtml(r.tweet_id)}">
      <td class="col-check"><input type="checkbox" class="row-check" ${checked} /></td>
      <td><span class="pill pill-${escapeHtml(r.phase2_status || "unknown")}">${escapeHtml(r.phase2_status || "—")}</span><span class="muted">${statusKind}</span></td>
      <td>${completePill}</td>
      <td class="handle">${handle}</td>
      <td class="preview"><div class="preview-text">${escapeHtml(r.text_preview || "")}</div></td>
      <td>${escapeHtml(fmtDate(r.bookmarked_at))}</td>
      <td>${escapeHtml(fmtDate(r.posted_at))}</td>
      <td>${r.has_video ? "🎥" : ""}</td>
      <td>${r.image_count || ""}</td>
      <td>${r.is_article ? "📄" : ""}</td>
      <td>${r.subpost_count || ""}</td>
      <td>${r.comment_count || ""}</td>
      <td>${r.thread_count || ""}</td>
      <td><div class="warnings">${warnings}</div></td>
      <td><div class="row-actions">
        <button class="btn btn-small" data-act="open">🔗</button>
        <button class="btn btn-small" data-act="recapture">📥</button>
        <button class="btn btn-small" data-act="unbookmark">🔖</button>
        <button class="btn btn-small" data-act="rebookmark">🔁</button>
        <button class="btn btn-small" data-act="open-md" ${r.md_filename ? "" : "disabled"}>📄</button>
        <button class="btn btn-small btn-danger" data-act="delete-md" ${r.md_filename ? "" : "disabled"}>🗑</button>
      </div></td>
    </tr>`;
  }).join("");
  tbody.innerHTML = html;
  document.getElementById("selected-count").textContent = `${state.selectedIds.size} selected`;
  const anySelected = state.selectedIds.size > 0;
  document.getElementById("bulk-recapture").disabled = !anySelected;
  document.getElementById("bulk-unbookmark").disabled = !anySelected;
  document.getElementById("bulk-delete-md").disabled = !anySelected;
}

function renderFilterChips() {
  const sBox = document.getElementById("status-chips");
  sBox.innerHTML = STATUS_FILTERS.map((f) =>
    `<button class="chip exclusive ${state.filters.status === f.id ? "active" : ""}" data-status="${f.id}">${f.label}</button>`
  ).join("");
  const tBox = document.getElementById("trait-chips");
  tBox.innerHTML = TRAIT_FILTERS.map((f) =>
    `<button class="chip ${state.filters.traits.has(f.id) ? "active" : ""}" data-trait="${f.id}">${f.label}</button>`
  ).join("");
}

function renderRunStatus() {
  const el = document.getElementById("run-status");
  if (!state.runStatus) { el.textContent = "idle"; return; }
  const s = state.runStatus;
  const phaseLabel = {
    collecting: "Phase 1: collecting URLs",
    processing: "Phase 2: capturing tweets",
    retrying: "Phase 2 retry pass",
  }[s.phase] || s.phase || "—";
  const queue = s.phase === "retrying" ? (s.retryQueue || []) : (s.queue || []);
  const cur = s.cursor || 0;
  const total = queue.length || s.totalAtStart || 0;
  el.textContent = `${s.status} · ${phaseLabel} · ${cur}/${total} · done=${s.completed || 0} fail=${(s.failed || []).length}`;
  document.getElementById("run-cancel").disabled = s.status !== "running";
}

function renderHealthLog() {
  if (!state.healthText) {
    document.getElementById("health-log").textContent = "(no _health.csv yet)";
    return;
  }
  const lines = state.healthText.replace(/\n+$/, "").split("\n");
  const tail = lines.slice(-50);
  document.getElementById("health-log").textContent = tail.join("\n");
}

function renderFailedBreakdown() {
  const counts = {};
  for (const r of state.rows) {
    if (r.phase2_status !== "failed") continue;
    const k = r.phase2_kind || "unknown";
    counts[k] = (counts[k] || 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    document.getElementById("failed-breakdown").innerHTML = `<div class="muted">No failures.</div>`;
    return;
  }
  document.getElementById("failed-breakdown").innerHTML = entries.map(([k, c]) =>
    `<div class="failed-kind">
      <div class="failed-kind-name">${escapeHtml(k)}</div>
      <div class="failed-kind-count">${c}</div>
    </div>`
  ).join("");
}

// ---------- Actions ----------

function toast(msg, ms = 2200) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("visible");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("visible"), ms);
}

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (res) => resolve(res || { ok: false, error: chrome.runtime.lastError?.message }));
  });
}

async function actionOpenOnX(row) {
  if (!row.permalink) return toast("No permalink on this row");
  await send({ type: "openInTab", url: row.permalink });
  toast(`Opened @${row.author_handle || row.tweet_id} on x.com`);
}

async function actionRecapture(row) {
  if (!row.permalink) return toast("No permalink on this row");
  const url = row.permalink + (row.permalink.includes("?") ? "&" : "?") + "txAction=recapture";
  await send({ type: "openInTab", url });
  toast(`Recapture queued for @${row.author_handle || row.tweet_id}`);
}

async function actionUnbookmark(row) {
  if (!row.permalink) return toast("No permalink on this row");
  const url = row.permalink + (row.permalink.includes("?") ? "&" : "?") + "txAction=unbookmark";
  await send({ type: "openInTab", url });
  toast(`Un-bookmark queued for @${row.author_handle || row.tweet_id}`);
}

async function actionRebookmark(row) {
  if (!row.permalink) return toast("No permalink on this row");
  const url = row.permalink + (row.permalink.includes("?") ? "&" : "?") + "txAction=rebookmark";
  await send({ type: "openInTab", url });
  toast(`Re-bookmark queued for @${row.author_handle || row.tweet_id}`);
}

async function actionOpenMd(row) {
  if (!row.md_filename || !state.dirHandle) return toast("No .md file");
  try {
    const fh = await state.dirHandle.getFileHandle(row.md_filename);
    const file = await fh.getFile();
    const url = URL.createObjectURL(file);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    toast(`Couldn't open: ${e.message || e}`);
  }
}

async function actionDeleteMd(row) {
  if (!row.md_filename || !state.dirHandle) return toast("No .md file");
  if (!confirm(`Permanently delete ${row.md_filename} from the sync folder?`)) return;
  try {
    await state.dirHandle.removeEntry(row.md_filename);
    toast(`Deleted ${row.md_filename}`);
    await loadAllData();
  } catch (e) {
    toast(`Delete failed: ${e.message || e}`);
  }
}

// ---------- Event wiring ----------

function wireEvents() {
  // Folder picker
  document.getElementById("pick-folder").addEventListener("click", async () => {
    try {
      const h = await window.showDirectoryPicker({ mode: "readwrite" });
      await saveHandle(h);
      state.dirHandle = h;
      document.getElementById("folder-label").textContent = h.name || "(picked)";
      await loadAllData();
      toast("Folder set");
    } catch {}
  });
  document.getElementById("reload-data").addEventListener("click", async () => {
    await loadAllData();
    toast("Reloaded");
  });

  // Search
  let searchTimer;
  document.getElementById("search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filters.search = e.target.value;
      applyFilters();
    }, 120);
  });

  // Status chips (exclusive)
  document.getElementById("status-chips").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-status]");
    if (!btn) return;
    state.filters.status = btn.dataset.status;
    renderFilterChips();
    applyFilters();
  });

  // Trait chips (multi)
  document.getElementById("trait-chips").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-trait]");
    if (!btn) return;
    const id = btn.dataset.trait;
    if (state.filters.traits.has(id)) state.filters.traits.delete(id);
    else state.filters.traits.add(id);
    renderFilterChips();
    applyFilters();
  });

  // Sort headers
  document.querySelectorAll("#rows th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.sort;
      if (state.sort.col === col) state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
      else { state.sort.col = col; state.sort.dir = "asc"; }
      document.querySelectorAll("#rows th").forEach((t) => t.classList.remove("sort-asc", "sort-desc"));
      th.classList.add(state.sort.dir === "asc" ? "sort-asc" : "sort-desc");
      sortRows();
      renderRows();
    });
  });

  // Row checkboxes + per-row actions (event delegation)
  document.getElementById("rows-body").addEventListener("change", (e) => {
    const cb = e.target.closest(".row-check");
    if (!cb) return;
    const id = cb.closest("tr").dataset.id;
    if (cb.checked) state.selectedIds.add(id);
    else state.selectedIds.delete(id);
    document.getElementById("selected-count").textContent = `${state.selectedIds.size} selected`;
    const any = state.selectedIds.size > 0;
    document.getElementById("bulk-recapture").disabled = !any;
    document.getElementById("bulk-unbookmark").disabled = !any;
    document.getElementById("bulk-delete-md").disabled = !any;
  });
  document.getElementById("rows-body").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const tr = btn.closest("tr");
    const id = tr.dataset.id;
    const row = state.rows.find((r) => r.tweet_id === id);
    if (!row) return;
    const act = btn.dataset.act;
    if (act === "open") return actionOpenOnX(row);
    if (act === "recapture") return actionRecapture(row);
    if (act === "unbookmark") return actionUnbookmark(row);
    if (act === "rebookmark") return actionRebookmark(row);
    if (act === "open-md") return actionOpenMd(row);
    if (act === "delete-md") return actionDeleteMd(row);
  });

  // Select all
  document.getElementById("select-all").addEventListener("change", (e) => {
    if (e.target.checked) {
      state.filteredRows.forEach((r) => state.selectedIds.add(r.tweet_id));
    } else {
      state.filteredRows.forEach((r) => state.selectedIds.delete(r.tweet_id));
    }
    renderRows();
  });

  // Bulk actions
  document.getElementById("bulk-recapture").addEventListener("click", async () => {
    const ids = [...state.selectedIds];
    if (!ids.length) return;
    if (!confirm(`Re-capture ${ids.length} tweets? This opens one tab per tweet sequentially.`)) return;
    for (const id of ids) {
      const row = state.rows.find((r) => r.tweet_id === id);
      if (row) await actionRecapture(row);
      await new Promise((r) => setTimeout(r, 500));
    }
    toast(`Queued ${ids.length} recaptures`);
  });
  document.getElementById("bulk-unbookmark").addEventListener("click", async () => {
    const ids = [...state.selectedIds];
    if (!ids.length) return;
    if (!confirm(`Un-bookmark ${ids.length} tweets on x.com? This cannot be undone via the dashboard.`)) return;
    for (const id of ids) {
      const row = state.rows.find((r) => r.tweet_id === id);
      if (row) await actionUnbookmark(row);
      await new Promise((r) => setTimeout(r, 500));
    }
  });
  document.getElementById("bulk-delete-md").addEventListener("click", async () => {
    const ids = [...state.selectedIds];
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} local .md files? Cannot be undone.`)) return;
    for (const id of ids) {
      const row = state.rows.find((r) => r.tweet_id === id);
      if (row && row.md_filename) {
        try { await state.dirHandle.removeEntry(row.md_filename); } catch {}
      }
    }
    state.selectedIds.clear();
    await loadAllData();
    toast(`Deleted ${ids.length} files`);
  });

  // Run controls
  document.getElementById("run-export").addEventListener("click", async () => {
    const limit = parseInt(document.getElementById("run-batch").value, 10) || 0;
    await send({ type: "openInTab", url: `https://x.com/i/bookmarks?txRun=deep&txBatch=${limit}` });
    toast("Deep export run triggered");
  });
  document.getElementById("run-resume-failed").addEventListener("click", async () => {
    const failed = state.rows.filter((r) => r.phase2_status === "failed");
    if (!failed.length) return toast("No failed rows");
    if (!confirm(`Re-capture all ${failed.length} failed URLs? Sequential, slow.`)) return;
    for (const r of failed) { await actionRecapture(r); await new Promise((res) => setTimeout(res, 500)); }
    toast(`Queued ${failed.length} retries`);
  });
  document.getElementById("run-resume-deferred").addEventListener("click", async () => {
    const deferred = state.rows.filter((r) => r.phase2_status === "deferred");
    if (!deferred.length) return toast("No deferred rows");
    if (!confirm(`Run a fresh deep export for the ${deferred.length} deferred URLs? Easier route: just run a new full export with batch=all.`)) return;
    await send({ type: "openInTab", url: "https://x.com/i/bookmarks?txRun=deep&txBatch=0" });
  });
  document.getElementById("run-cancel").addEventListener("click", async () => {
    await send({ type: "bookmarks-cancel-run" });
    toast("Cancel signal sent");
  });

  // Integrity
  document.getElementById("run-integrity").addEventListener("click", async () => {
    if (!state.dirHandle) return toast("Pick a folder first");
    const mdById = new Map();
    for await (const [name, h] of state.dirHandle.entries()) {
      if (h.kind !== "file" || !name.endsWith(".md")) continue;
      const m = name.match(/_(\d+)\.md$/);
      if (m) mdById.set(m[1], name);
    }
    const csvIds = new Set(state.rows.filter((r) => r.phase2_status === "captured").map((r) => r.tweet_id));
    const orphanFiles = [...mdById].filter(([id]) => !csvIds.has(id));
    const orphanRows = [...csvIds].filter((id) => !mdById.has(id));
    document.getElementById("integrity").innerHTML = `
      <p><b>${mdById.size}</b> .md files · <b>${csvIds.size}</b> captured CSV rows</p>
      <p>Orphan files (no CSV row): <b>${orphanFiles.length}</b></p>
      <p>Orphan rows (no .md file): <b>${orphanRows.length}</b></p>
    `;
  });
}

// ---------- Run-state polling ----------

async function pollRunStatus() {
  try {
    const r = await chrome.storage.local.get("tx-bookmarks-deep-export");
    state.runStatus = r["tx-bookmarks-deep-export"] || null;
    renderRunStatus();
  } catch {}
}

// ---------- Boot ----------

async function init() {
  renderFilterChips();
  wireEvents();
  const handle = await loadHandle();
  if (handle) {
    if (await ensurePermission(handle)) {
      state.dirHandle = handle;
      document.getElementById("folder-label").textContent = handle.name || "(persisted folder)";
      await loadAllData();
    } else {
      document.getElementById("folder-label").textContent = "Permission needed — click Change folder";
    }
  } else {
    document.getElementById("folder-label").textContent = "No folder picked yet — click Change folder";
  }
  pollRunStatus();
  setInterval(pollRunStatus, 3000);
}

init().catch((e) => {
  console.error("[Dashboard] init failed", e);
  toast(`Init failed: ${e.message || e}`);
});
