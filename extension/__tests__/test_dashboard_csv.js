// Standalone test for dashboard.js's parseCsv() — uses inputs structured
// exactly the way bookmarks.js writes them (same csvEscape rules) so we
// catch any incompatibility before the user reloads the extension.
//
// Run: node extension/__tests__/test_dashboard_csv.js
//
// We re-implement parseCsv inline (matches dashboard.js verbatim) so this
// runs in plain Node without bundling.

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

// Mirrors csvEscape from bookmarks.js
function csvEscape(value) {
  if (value == null) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

let pass = 0;
let fail = 0;

function expect(name, actual, expected) {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  if (match) { pass++; return; }
  fail++;
  console.error(`FAIL ${name}`);
  console.error("  expected:", JSON.stringify(expected));
  console.error("  actual:  ", JSON.stringify(actual));
}

// ---------- TESTS ----------

// 1. Plain headers + simple data
{
  const csv = "tweet_id,handle\n123,foo\n456,bar\n";
  const out = parseCsv(csv);
  expect("plain rows", out, [{ tweet_id: "123", handle: "foo" }, { tweet_id: "456", handle: "bar" }]);
}

// 2. Field with comma — quoted
{
  const csv = "id,text\n1," + csvEscape("hello, world") + "\n";
  const out = parseCsv(csv);
  expect("comma in field", out, [{ id: "1", text: "hello, world" }]);
}

// 3. Field with double-quote — escaped as ""
{
  const csv = "id,text\n1," + csvEscape('she said "hi"') + "\n";
  const out = parseCsv(csv);
  expect("quote in field", out, [{ id: "1", text: 'she said "hi"' }]);
}

// 4. Field with newline — quoted, embedded \n
{
  const csv = "id,text\n1," + csvEscape("line1\nline2") + "\n";
  const out = parseCsv(csv);
  expect("newline in field", out, [{ id: "1", text: "line1\nline2" }]);
}

// 5. CRLF line endings (Windows-y)
{
  const csv = "id,handle\r\n1,foo\r\n2,bar\r\n";
  const out = parseCsv(csv);
  expect("crlf lines", out, [{ id: "1", handle: "foo" }, { id: "2", handle: "bar" }]);
}

// 6. Bookmarks.csv-shaped row (17 cols, full extension format)
{
  const header = "tweet_id,author_name,author_handle,posted_at,bookmarked_at,permalink,has_video,image_count,is_article,has_thread,subpost_count,thread_count,comment_count,text_preview,md_filename,capture_complete,capture_warnings";
  const row = [
    "1234567890",
    csvEscape("Jane, Doe"),
    "janedoe",
    "2026-04-30T10:15:00.000Z",
    "2026-05-01T08:00:00.000Z",
    "https://x.com/janedoe/status/1234567890",
    "no",
    "2",
    "no",
    "yes",
    "20",
    "1",
    "19",
    csvEscape('Look at this — "wow", commas, etc.'),
    "2026-04-30_janedoe_1234567890.md",
    "partial",
    "replies_truncated;video_subtitles_only",
  ].join(",");
  const out = parseCsv(header + "\n" + row + "\n");
  expect("bookmarks.csv-shaped row preserves all 17 fields", out.length, 1);
  const r = out[0];
  expect("tweet_id parsed", r.tweet_id, "1234567890");
  expect("author_name with comma parsed", r.author_name, "Jane, Doe");
  expect("text_preview with quotes+commas parsed", r.text_preview, 'Look at this — "wow", commas, etc.');
  expect("capture_complete parsed", r.capture_complete, "partial");
  expect("capture_warnings parsed", r.capture_warnings, "replies_truncated;video_subtitles_only");
}

// 7. _phase1-urls.csv-shaped data
{
  const header = "tweet_id,permalink,phase1_at,phase2_status,phase2_kind,phase2_at";
  const lines = [
    header,
    "111,https://x.com/u/status/111,2026-05-01T00:00:00.000Z,captured,,2026-05-01T01:00:00.000Z",
    "222,https://x.com/u/status/222,2026-05-01T00:00:00.000Z,failed,rate-limit,2026-05-01T01:00:00.000Z",
    "333,https://x.com/u/status/333,2026-05-01T00:00:00.000Z,deferred,batch-limit,2026-05-01T00:00:00.000Z",
    "444,https://x.com/u/status/444,2026-05-01T00:00:00.000Z,pending,,",
    "555,https://x.com/u/status/555,2026-05-01T00:00:00.000Z,skipped,already-good,2026-05-01T00:00:00.000Z",
  ];
  const out = parseCsv(lines.join("\n") + "\n");
  expect("phase1 rows count", out.length, 5);
  expect("captured row", out[0].phase2_status, "captured");
  expect("failed kind", out[1].phase2_kind, "rate-limit");
  expect("pending phase2_at empty", out[3].phase2_at, "");
}

// 8. Trailing whitespace / empty trailing row tolerated
{
  const csv = "a,b\n1,2\n\n";
  const out = parseCsv(csv);
  expect("empty trailing line ignored", out, [{ a: "1", b: "2" }]);
}

// 9. Empty input -> empty array
{
  expect("empty string", parseCsv(""), []);
  expect("null", parseCsv(null), []);
}

// 10. Unicode in fields (emoji, accents)
{
  const csv = "id,t\n1," + csvEscape("héllo 🎥 ✨") + "\n";
  const out = parseCsv(csv);
  expect("unicode preserved", out[0].t, "héllo 🎥 ✨");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
