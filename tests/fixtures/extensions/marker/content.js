// Marks the page and adds the extension's frame, then relays the page's
// requests to open or change tabs to the worker.
const marker = document.createElement("div");
marker.id = "kamapathy-marker";
marker.textContent = "Marker from the extension";
const frame = document.createElement("iframe");
frame.id = "kamapathy-marker-frame";
frame.title = "Marker frame";
frame.src = chrome.runtime.getURL("frame.html");
frame.style.width = "320px";
frame.style.height = "120px";
(document.body || document.documentElement).append(marker, frame);

window.addEventListener("message", (event) => {
  const data = event.data;
  if (
    event.source !== window ||
    event.origin !== location.origin ||
    !data ||
    (data.kamapathyMarker !== "create" && data.kamapathyMarker !== "update") ||
    typeof data.url !== "string"
  )
    return;
  const show = (text) => {
    const result = document.getElementById("kamapathy-marker-result");
    if (result) result.textContent = text;
  };
  chrome.runtime
    .sendMessage({ kamapathyMarker: data.kamapathyMarker, url: data.url })
    .then(
      (reply) =>
        show(
          reply && reply.ok
            ? `opened ${reply.windowId}`
            : String((reply && reply.error) || "No reply"),
        ),
      (error) => show(error.message),
    );
});
