const KEYS = { backendUrl: "tx_backend_url", googleClientId: "tx_google_client_id" };

async function load() {
  const out = await chrome.storage.local.get([KEYS.backendUrl, KEYS.googleClientId]);
  document.getElementById("backendUrl").value = out[KEYS.backendUrl] || "";
  document.getElementById("googleClientId").value = out[KEYS.googleClientId] || "";
}

async function save() {
  const backendUrl = document.getElementById("backendUrl").value.trim().replace(/\/+$/, "");
  const googleClientId = document.getElementById("googleClientId").value.trim();
  await chrome.storage.local.set({
    [KEYS.backendUrl]: backendUrl,
    [KEYS.googleClientId]: googleClientId,
  });
  const s = document.getElementById("status");
  s.textContent = "Saved";
  setTimeout(() => (s.textContent = ""), 1500);
}

document.getElementById("save").addEventListener("click", save);
load();
