// The badge shows that the worker started and reached chrome.action.
chrome.action.setBadgeText({ text: "on" });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const kind = message && message.kamapathyMarker;
  if (kind !== "create" && kind !== "update") return false;
  (async () => {
    const tab =
      kind === "create"
        ? await chrome.tabs.create({ url: message.url, active: false })
        : await chrome.tabs.update(sender.tab.id, { url: message.url });
    return { ok: true, windowId: tab.windowId };
  })().then(sendResponse, (error) =>
    sendResponse({ ok: false, error: error.message }),
  );
  return true;
});
