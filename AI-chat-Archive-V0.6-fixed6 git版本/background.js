async function blobToDataURL(blob) {
  return await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result || null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

async function fetchImageAsDataURL(url, token) {
  try {
    const headers = new Headers();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const resp = await fetch(url, { method: "GET", credentials: "include", cache: "no-store", headers });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const dataUrl = await blobToDataURL(blob);
    if (dataUrl) return dataUrl;
  } catch (e) {}

  try {
    const resp2 = await fetch(url, { method: "GET", credentials: "include", cache: "no-store" });
    if (!resp2.ok) throw new Error(`HTTP ${resp2.status}`);
    const blob2 = await resp2.blob();
    const dataUrl2 = await blobToDataURL(blob2);
    if (dataUrl2) return dataUrl2;
  } catch (e) {}

  try {
    const resp3 = await fetch(url, { method: "GET", cache: "no-store" });
    if (!resp3.ok) throw new Error(`HTTP ${resp3.status}`);
    const blob3 = await resp3.blob();
    const dataUrl3 = await blobToDataURL(blob3);
    if (dataUrl3) return dataUrl3;
  } catch (e) {}

  return null;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request && request.type === "platformToggle") {
    chrome.storage.local.get('zh_platform_settings', (result) => {
      const settings = result.zh_platform_settings || {};
      settings[request.platform] = request.enabled;
      chrome.storage.local.set({ zh_platform_settings: settings });
    });
    return;
  }

  if (!request || request.action !== "fetchImageBase64") return;

  (async () => {
    try {
      const url = String(request.url || "");
      if (!url) return sendResponse({ error: "empty url" });
      if (url.startsWith("blob:")) {
        return sendResponse({ error: "blob url not supported in background" });
      }
      const token = request.token ? String(request.token) : null;
      const dataUrl = await fetchImageAsDataURL(url, token);
      if (!dataUrl) return sendResponse({ error: "convert failed" });
      sendResponse({ base64: dataUrl });
    } catch (err) {
      console.error("后台强转图片失败:", err);
      sendResponse({ error: String(err) });
    }
  })();

  return true;
});
