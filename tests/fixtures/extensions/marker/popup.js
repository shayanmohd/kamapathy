// Shows the URL of the tab the popup belongs to.
chrome.tabs.query({ active: true, currentWindow: true }).then(
  (tabs) => {
    document.getElementById("shown").textContent =
      (tabs[0] && tabs[0].url) || "none";
  },
  (error) => {
    document.getElementById("shown").textContent = error.message;
  },
);
