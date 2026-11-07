// Service worker: keeps the last status + log lines so the popup can render
// state even when it opens mid-run.

const MAX_LOG = 200;
const state = {
  status: { running: false, deletedTotal: 0 },
  log: [],
  tabId: null,
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "XPP_LOG") {
    state.log.push({ t: Date.now(), line: msg.line, level: msg.level || "info" });
    if (state.log.length > MAX_LOG) state.log.shift();
    chrome.storage.local.set({ xppLog: state.log });
    return false;
  }
  if (msg?.type === "XPP_STATUS") {
    state.status = msg.payload;
    if (sender.tab?.id != null) state.tabId = sender.tab.id;
    chrome.storage.local.set({ xppStatus: state.status });
    // Update badge with the session delete count.
    const n = msg.payload.deletedTotal || 0;
    chrome.action.setBadgeText({ text: n ? String(n) : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#e0245e" });
    return false;
  }
  if (msg?.type === "XPP_GET_STATE") {
    sendResponse({ status: state.status, log: state.log });
    return false;
  }
  if (msg?.type === "XPP_CLEAR_LOG") {
    state.log = [];
    chrome.storage.local.set({ xppLog: [] });
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get("xppSettings").then(({ xppSettings }) => {
    if (!xppSettings) {
      chrome.storage.local.set({
        xppSettings: {
          batchMin: 50,
          batchMax: 70,
          cooldownMinMin: 3,
          cooldownMaxMin: 5,
          stepMinMs: 2500,
          stepMaxMs: 6000,
          engine: "dom",
          mode: "posts",
          includeReposts: false,
          maxTotal: 0,
          confirmEachWave: true,
          dryRun: false,
        },
      });
    }
  });
});
