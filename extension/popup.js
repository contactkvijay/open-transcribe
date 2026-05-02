const $ = (id) => document.getElementById(id);

async function send(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  if (!res?.ok) throw new Error(res?.error || "Unknown error");
  return res;
}

function fmtDuration(s) {
  if (!s) return "";
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function fmtDate(d) {
  try {
    return new Date(d).toLocaleString();
  } catch { return d; }
}

async function refresh() {
  const auth = await send({ type: "getAuth" });
  if (!auth.backendUrl) {
    $("status").textContent = "Set Backend URL in options";
    $("signin-section").hidden = false;
    const anon = $("anon-dashboard-section"); if (anon) anon.hidden = false;
    return;
  }
  if (!auth.hasJwt) {
    $("signin-section").hidden = false;
    $("signedin-section").hidden = true;
    const anon = $("anon-dashboard-section"); if (anon) anon.hidden = false;
    return;
  }
  $("signin-section").hidden = true;
  $("signedin-section").hidden = false;
  // Hide anon dashboard prompt when signed-in section is showing the same button.
  const anon = $("anon-dashboard-section"); if (anon) anon.hidden = true;

  const u = auth.user || {};
  if (u.picture) $("avatar").src = u.picture;
  $("username").textContent = u.name || "(unknown)";
  $("email").textContent = u.email || "";

  try {
    const { data } = await send({ type: "history" });
    renderHistory(data || []);
  } catch (e) {
    $("history").innerHTML = `<li class="muted">${e.message}</li>`;
  }
}

function renderHistory(items) {
  const ul = $("history");
  ul.innerHTML = "";
  if (!items.length) {
    ul.innerHTML = `<li class="muted">No transcripts yet.</li>`;
    return;
  }
  for (const it of items) {
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="title">${escapeHtml(it.title || it.source_url)}</div>
      <div class="meta">${fmtDate(it.created_at)} ${it.duration_seconds ? "· " + fmtDuration(it.duration_seconds) : ""} ${it.language ? "· " + it.language : ""} ${it.has_audio ? "· 🎵" : ""}</div>
    `;
    li.addEventListener("click", () => openDetail(it.id));
    ul.appendChild(li);
  }
}

async function openDetail(id) {
  let data;
  try {
    const res = await send({ type: "historyItem", id });
    data = res.data;
  } catch (e) {
    alert(e.message);
    return;
  }
  const overlay = document.createElement("div");
  overlay.className = "detail";
  overlay.innerHTML = `
    <div class="detail-inner">
      <div class="row">
        <strong>${escapeHtml(data.title || "Untitled")}</strong>
      </div>
      <div class="muted">${fmtDate(data.created_at)} · <a href="${escapeHtml(data.source_url)}" target="_blank">source</a></div>
      <textarea readonly>${escapeHtml(data.transcript || "(no transcript)")}</textarea>
      <div class="row">
        <button class="primary" data-act="copy">Copy</button>
        ${data.audio_url ? '<button class="primary" data-act="mp3">Download MP3</button>' : ""}
        <button class="ghost" data-act="delete">Delete</button>
        <button class="ghost" data-act="close" style="margin-left:auto">Close</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "close") overlay.remove();
    else if (act === "copy") {
      await navigator.clipboard.writeText(data.transcript || "");
      b.textContent = "Copied!";
      setTimeout(() => (b.textContent = "Copy"), 1200);
    } else if (act === "mp3") {
      await send({
        type: "downloadAudio",
        audioUrl: data.audio_url,
        filename: ((data.title || `transcribe-${data.id}`).replace(/[\\/:*?"<>|]+/g, "_").slice(0,80)) + ".mp3",
      });
    } else if (act === "delete") {
      if (!confirm("Delete this transcript?")) return;
      await send({ type: "deleteHistory", id: data.id });
      overlay.remove();
      refresh();
    }
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

$("signin-btn").addEventListener("click", async () => {
  $("signin-btn").disabled = true;
  $("signin-btn").textContent = "Signing in...";
  try {
    await send({ type: "signIn" });
    refresh();
  } catch (e) {
    alert(e.message);
  } finally {
    $("signin-btn").disabled = false;
    $("signin-btn").textContent = "Sign in with Google";
  }
});

$("signout-btn").addEventListener("click", async () => {
  await send({ type: "signOut" });
  refresh();
});

document.querySelectorAll("#open-options, #open-options-2").forEach(a => {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
});

// Bookmarks dashboard — works regardless of sign-in state.
document.querySelectorAll("#open-dashboard-btn, #open-dashboard-btn-anon").forEach((btn) => {
  if (!btn) return;
  btn.addEventListener("click", async () => {
    try { await send({ type: "openDashboard" }); window.close(); }
    catch (e) { alert(e.message); }
  });
});

refresh();
