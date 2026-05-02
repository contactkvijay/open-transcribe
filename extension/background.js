// Service worker: handles auth flow + API calls to the backend.
// content.js + popup.js + options.js all talk to the backend through here.

const STORAGE_KEYS = {
  jwt: "tx_jwt",
  user: "tx_user",
  backendUrl: "tx_backend_url",
  googleClientId: "tx_google_client_id",
};

async function getSettings() {
  const out = await chrome.storage.local.get([
    STORAGE_KEYS.backendUrl,
    STORAGE_KEYS.googleClientId,
    STORAGE_KEYS.jwt,
    STORAGE_KEYS.user,
  ]);
  return {
    backendUrl: (out[STORAGE_KEYS.backendUrl] || "").replace(/\/+$/, ""),
    googleClientId: out[STORAGE_KEYS.googleClientId] || "",
    jwt: out[STORAGE_KEYS.jwt] || "",
    user: out[STORAGE_KEYS.user] || null,
  };
}

async function setAuth(jwt, user) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.jwt]: jwt,
    [STORAGE_KEYS.user]: user,
  });
}

async function clearAuth() {
  await chrome.storage.local.remove([STORAGE_KEYS.jwt, STORAGE_KEYS.user]);
}

function randomNonce() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, "0")).join("");
}

async function googleSignIn() {
  const { googleClientId } = await getSettings();
  if (!googleClientId) {
    throw new Error("Set Google Client ID in extension options first.");
  }
  const redirectUri = chrome.identity.getRedirectURL();
  const nonce = randomNonce();
  const params = new URLSearchParams({
    client_id: googleClientId,
    response_type: "id_token",
    scope: "openid email profile",
    redirect_uri: redirectUri,
    nonce,
    prompt: "select_account",
  });
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl,
    interactive: true,
  });
  if (!responseUrl) throw new Error("Sign-in cancelled.");

  // The id_token comes back as URL fragment.
  const fragment = responseUrl.split("#")[1] || "";
  const parsed = new URLSearchParams(fragment);
  const idToken = parsed.get("id_token");
  if (!idToken) throw new Error("No id_token returned from Google.");

  const { backendUrl } = await getSettings();
  if (!backendUrl) throw new Error("Set Backend URL in extension options first.");
  const res = await fetch(`${backendUrl}/api/auth/google`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ngrok-skip-browser-warning": "true",
    },
    body: JSON.stringify({ id_token: idToken }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Backend rejected sign-in: ${res.status} ${txt}`);
  }
  const data = await res.json();
  await setAuth(data.access_token, data.user);
  return data.user;
}

async function api(path, opts = {}) {
  const { backendUrl, jwt } = await getSettings();
  if (!backendUrl) throw new Error("Backend URL not set.");
  if (!jwt) throw new Error("Not signed in.");
  const headers = Object.assign(
    {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
      "ngrok-skip-browser-warning": "true",
    },
    opts.headers || {}
  );
  const res = await fetch(`${backendUrl}${path}`, { ...opts, headers });
  if (res.status === 401) {
    await clearAuth();
    throw new Error("Session expired. Please sign in again.");
  }
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`API ${path} failed: ${res.status} ${txt}`);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

async function transcribeUrl({ url, mode }) {
  return api("/api/transcribe", {
    method: "POST",
    body: JSON.stringify({ url, mode }),
  });
}

async function listHistory() {
  return api("/api/history?limit=25");
}

async function getHistoryItem(id) {
  return api(`/api/history/${id}`);
}

async function deleteHistoryItem(id) {
  return api(`/api/history/${id}`, { method: "DELETE" });
}

async function downloadAudioFromUrl(audioUrl, filename) {
  const { backendUrl } = await getSettings();
  const fullUrl = audioUrl.startsWith("http") ? audioUrl : `${backendUrl}${audioUrl}`;
  return chrome.downloads.download({ url: fullUrl, filename });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "ping":
          sendResponse({ ok: true });
          return;
        case "getAuth": {
          const s = await getSettings();
          sendResponse({ ok: true, user: s.user, hasJwt: !!s.jwt, backendUrl: s.backendUrl });
          return;
        }
        case "signIn": {
          const user = await googleSignIn();
          sendResponse({ ok: true, user });
          return;
        }
        case "signOut": {
          await clearAuth();
          sendResponse({ ok: true });
          return;
        }
        case "transcribe": {
          const data = await transcribeUrl({ url: msg.url, mode: msg.mode });
          sendResponse({ ok: true, data });
          return;
        }
        case "fetchTweetViaBackend": {
          const data = await api(`/api/x/tweet?url=${encodeURIComponent(msg.url)}`);
          sendResponse({ ok: true, data });
          return;
        }
        case "history": {
          const data = await listHistory();
          sendResponse({ ok: true, data });
          return;
        }
        case "historyItem": {
          const data = await getHistoryItem(msg.id);
          sendResponse({ ok: true, data });
          return;
        }
        case "deleteHistory": {
          await deleteHistoryItem(msg.id);
          sendResponse({ ok: true });
          return;
        }
        case "downloadAudio": {
          const id = await downloadAudioFromUrl(msg.audioUrl, msg.filename || "audio.mp3");
          sendResponse({ ok: true, id });
          return;
        }
        case "openInTab": {
          // Used by dashboard.html to spawn x.com tabs for re-capture /
          // un-bookmark / re-bookmark / new deep export. Magic query
          // params on the URL are picked up by bookmarks.js content
          // script when the page loads.
          const tab = await chrome.tabs.create({ url: msg.url, active: !!msg.active });
          sendResponse({ ok: true, tabId: tab.id });
          return;
        }
        case "openDashboard": {
          const url = chrome.runtime.getURL("dashboard.html");
          // Reuse an existing dashboard tab if one is already open so we
          // don't accumulate duplicates each click.
          const existing = await chrome.tabs.query({ url });
          if (existing.length > 0) {
            await chrome.tabs.update(existing[0].id, { active: true });
            sendResponse({ ok: true, tabId: existing[0].id });
          } else {
            const tab = await chrome.tabs.create({ url });
            sendResponse({ ok: true, tabId: tab.id });
          }
          return;
        }
        case "bookmarks-cancel-run": {
          // Clear deep-export state across all x.com tabs by writing
          // status=cancelled. The content script polls this and aborts.
          const r = await chrome.storage.local.get("tx-bookmarks-deep-export");
          const cur = r["tx-bookmarks-deep-export"];
          if (cur) {
            await chrome.storage.local.set({
              "tx-bookmarks-deep-export": { ...cur, status: "cancelled", finishedAt: Date.now() },
            });
          }
          sendResponse({ ok: true });
          return;
        }
        default:
          sendResponse({ ok: false, error: `Unknown message: ${msg.type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true; // keep channel open for async response
});
