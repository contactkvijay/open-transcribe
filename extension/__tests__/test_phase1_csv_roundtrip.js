// End-to-end test: feed a realistic deep-export state into writePhase1Csv,
// capture the CSV text it would write, then parse it back through the
// dashboard's parseCsv and verify every row has the expected fields.
//
// We re-implement writePhase1Csv inline (must stay byte-identical with the
// version in bookmarks.js) so we can test without loading the whole
// content-script bundle.

// ---------- Helpers (must match bookmarks.js) ----------

function csvEscape(value) {
  if (value == null) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function tweetIdFromUrl(url) {
  const m = (url || "").match(/\/status\/(\d+)/);
  return m ? m[1] : "";
}

const PHASE1_HEADER = "tweet_id,permalink,phase1_at,phase2_status,phase2_kind,phase2_at";

async function writePhase1Csv(dirHandle, state) {
  try {
    const lines = [PHASE1_HEADER];
    const allFound = state.allFoundUrls || [];
    if (allFound.length === 0) return;
    const alreadyGood = new Set(state.alreadyGoodUrls || []);
    const deferred = new Set(state.deferredUrls || []);
    const failedMap = new Map();
    for (const f of (state.failed || [])) failedMap.set(f.url, f);

    const phase1At = state.phase1FinishedAt
      ? new Date(state.phase1FinishedAt).toISOString()
      : "";
    const finishedAt = state.finishedAt
      ? new Date(state.finishedAt).toISOString()
      : "";

    const queue = state.queue || [];
    const cursor = Math.min(state.cursor || 0, queue.length);
    const reached = new Set();
    for (let i = 0; i < cursor; i++) reached.add(queue[i]);

    for (const item of allFound) {
      const url = item.url || "";
      const tweetId = item.tweetId || tweetIdFromUrl(url);
      let status = "pending";
      let kind = "";
      let at = "";
      if (alreadyGood.has(url)) {
        status = "skipped";
        kind = "already-good";
        at = phase1At;
      } else if (deferred.has(url)) {
        status = "deferred";
        kind = "batch-limit";
        at = phase1At;
      } else if (failedMap.has(url)) {
        const f = failedMap.get(url);
        status = "failed";
        kind = f.kind || "";
        at = finishedAt;
      } else if (reached.has(url)) {
        status = "captured";
        at = finishedAt;
      }
      lines.push(
        [tweetId, url, phase1At, status, kind, at].map(csvEscape).join(",")
      );
    }

    const fh = await dirHandle.getFileHandle("phase1.csv", { create: true });
    const w = await fh.createWritable();
    await w.write(lines.join("\n") + "\n");
    await w.close();
  } catch (e) {
    console.warn("write fail", e);
  }
}

// Inline parseCsv (matches dashboard.js)
function parseCsv(text) {
  if (!text) return [];
  const rows = [];
  let i = 0, field = "", row = [], inQuotes = false;
  const len = text.length;
  while (i < len) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\n" || c === "\r") {
      row.push(field); field = "";
      if (c === "\r" && text[i + 1] === "\n") i += 2; else i++;
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = []; continue;
    }
    field += c; i++;
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

// ---------- Mock FileSystemDirectoryHandle ----------

function mockDirHandle() {
  const written = {};
  return {
    written,
    async getFileHandle(name, opts) {
      return {
        async createWritable() {
          let buf = "";
          return {
            async write(s) { buf += s; },
            async close() { written[name] = buf; },
          };
        },
      };
    },
  };
}

// ---------- Run ----------

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; } else { fail++; console.error("FAIL", name); } }

(async () => {
  // Realistic state: 1000 URLs found in Phase 1; 100 already good, 50
  // deferred (batch limit), Phase 2 reached 80 of remaining 850, 10 failed
  const state = {
    phase1FinishedAt: Date.parse("2026-05-01T08:00:00Z"),
    finishedAt: Date.parse("2026-05-01T11:00:00Z"),
    allFoundUrls: [],
    alreadyGoodUrls: [],
    deferredUrls: [],
    queue: [],
    cursor: 80,
    failed: [],
  };
  for (let i = 1; i <= 1000; i++) {
    const url = `https://x.com/u/status/${i}`;
    state.allFoundUrls.push({ url, tweetId: String(i) });
  }
  // First 100: already good
  for (let i = 1; i <= 100; i++) state.alreadyGoodUrls.push(`https://x.com/u/status/${i}`);
  // Next 850 are queued for Phase 2
  for (let i = 101; i <= 950; i++) state.queue.push(`https://x.com/u/status/${i}`);
  // Last 50 deferred
  for (let i = 951; i <= 1000; i++) state.deferredUrls.push(`https://x.com/u/status/${i}`);
  // Phase 2 reached cursor=80; tweets 101..180 attempted. 10 of them failed.
  for (let i = 171; i <= 180; i++) {
    state.failed.push({ url: `https://x.com/u/status/${i}`, kind: "rate-limit" });
  }

  const handle = mockDirHandle();
  await writePhase1Csv(handle, state);

  const text = handle.written["phase1.csv"];
  check("CSV produced", typeof text === "string" && text.length > 0);

  const rows = parseCsv(text);
  check("1000 rows parsed back", rows.length === 1000);

  // Categorize
  const counts = {};
  for (const r of rows) counts[r.phase2_status] = (counts[r.phase2_status] || 0) + 1;
  check("100 skipped", counts.skipped === 100);
  check("50 deferred", counts.deferred === 50);
  check("10 failed", counts.failed === 10);
  // cursor=80 means 80 URLs in queue were reached. 10 of those are in failed
  // (171..180) so reached - failed = captured-or-not? Actually my logic: if
  // url is in failedMap, status=failed; else if in reached set, status=captured.
  // Cursor=80, queue starts at index 0 = url 101. So reached=URLs 101..180.
  // Of those, 171..180 are in failed (10), so 70 captured + 10 failed.
  check("70 captured", counts.captured === 70);
  // Pending = remaining queue not reached: 181..950 = 770
  check("770 pending", counts.pending === 770);

  // Verify a sample row
  const r1 = rows.find((r) => r.tweet_id === "1");
  check("row tweet 1 is skipped", r1 && r1.phase2_status === "skipped" && r1.phase2_kind === "already-good");
  const r150 = rows.find((r) => r.tweet_id === "150");
  check("row tweet 150 is captured", r150 && r150.phase2_status === "captured");
  const r175 = rows.find((r) => r.tweet_id === "175");
  check("row tweet 175 is failed/rate-limit", r175 && r175.phase2_status === "failed" && r175.phase2_kind === "rate-limit");
  const r500 = rows.find((r) => r.tweet_id === "500");
  check("row tweet 500 is pending", r500 && r500.phase2_status === "pending");
  const r975 = rows.find((r) => r.tweet_id === "975");
  check("row tweet 975 is deferred", r975 && r975.phase2_status === "deferred" && r975.phase2_kind === "batch-limit");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
