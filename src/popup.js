chrome.storage.local.get("xppSettings").then(({ xppSettings }) => {
  const DEFAULTS = {
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
  };
  const s = { ...DEFAULTS, ...(xppSettings || {}) };

  const ids = [
    "batchMin",
    "batchMax",
    "cooldownMinMin",
    "cooldownMaxMin",
    "stepMinMs",
    "stepMaxMs",
    "engine",
    "mode",
    "maxTotal",
    "includeReposts",
    "dryRun",
    "source",
    "deleteQueryId",
  ];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = !!s[id];
    else el.value = s[id];
  }

  function readSettings() {
    const get = (id) => document.getElementById(id);
    const num = (id) => Number(get(id).value);
    return {
      batchMin: num("batchMin"),
      batchMax: num("batchMax"),
      cooldownMinMin: num("cooldownMinMin"),
      cooldownMaxMin: num("cooldownMaxMin"),
      stepMinMs: num("stepMinMs"),
      stepMaxMs: num("stepMaxMs"),
      engine: get("engine").value,
      maxTotal: num("maxTotal"),
      includeReposts: get("includeReposts").checked,
      dryRun: get("dryRun").checked,
      source: get("source").value,
      deleteQueryId: (get("deleteQueryId").value || "").trim() || null,
      confirmEachWave: true,
    };
  }

  document.getElementById("save").addEventListener("click", async () => {
    const settings = readSettings();
    await chrome.storage.local.set({ xppSettings: settings });
    flash("Saved");
  });

  // Show/hide archive controls with the source picker.
  function syncSource() {
    const archive = document.getElementById("source").value === "archive";
    document.body.classList.toggle("archive", archive);
    // Archive ids cannot be clicked, so force the API engine.
    if (archive) document.getElementById("engine").value = "graphql";
  }
  document.getElementById("source").addEventListener("change", syncSource);

  // Load one or more tweets.js shards, parse, and send the queue.
  document.getElementById("loadArchive").addEventListener("click", async () => {
    const input = document.getElementById("archiveFile");
    const info = document.getElementById("archiveInfo");
    if (!input.files || input.files.length === 0) {
      info.textContent = "Pick your tweets.js (and any tweets-part*.js) first.";
      return;
    }
    const tab = await activeTab();
    if (!tab) {
      info.textContent = "Open x.com in this tab first.";
      return;
    }

    try {
      const lists = [];
      const problems = [];
      for (const file of input.files) {
        const text = await file.text();
        try {
          lists.push(XPP_ARCHIVE.normalise(XPP_ARCHIVE.parseArchive(text)));
        } catch (err) {
          problems.push(`${file.name}: ${err.message}`);
        }
      }

      if (!lists.length) {
        info.innerHTML = `<b>Could not read any of those files.</b><br>${problems.join("<br>")}`;
        return;
      }

      const merged = XPP_ARCHIVE.mergeArchives(lists);
      const settings = readSettings();
      if (!settings.includeReposts) {
        // keep reposts in the queue but they are skipped by the content script
      }

      const res = await sendToTab(tab.id, {
        type: "XPP_LOAD_ARCHIVE",
        items: merged,
        deleteQueryId: settings.deleteQueryId,
      });

      if (!res?.ok) {
        info.textContent = `Load failed: ${res?.error || "content script not ready — reload x.com"}`;
        return;
      }

      const replies = merged.filter((m) => m.inReplyTo).length;
      const rts = merged.filter((m) => m.isRetweet).length;
      info.innerHTML =
        `Queued <b>${res.count}</b> posts ` +
        `(${rts} retweets, ${replies} replies).` +
        (problems.length ? `<br>${problems.join("<br>")}` : "");
    } catch (err) {
      info.textContent = `Error: ${err.message}`;
    }
  });

  document.getElementById("start").addEventListener("click", async () => {
    // Starting a run means the activity feed is wanted again.
    updateLog._pinned = false;
    updateLog._stamp = null;
    const settings = readSettings();
    await chrome.storage.local.set({ xppSettings: settings });
    const tab = await activeTab();
    if (!tab) return flash("Open x.com in a tab first");
    const res = await sendToTab(tab.id, { type: "XPP_START", settings });
    if (!res?.ok) flash("Content script not ready — reload x.com");
  });

  document.getElementById("stop").addEventListener("click", async () => {
    const tab = await activeTab();
    if (!tab) return;
    await sendToTab(tab.id, { type: "XPP_STOP" });
  });

  // Copy the dry-run match list as JSON so it can be reviewed offline.
  document.getElementById("copyList").addEventListener("click", async () => {
    const tab = await activeTab();
    if (!tab) return flash("Open x.com first");
    const res = await sendToTab(tab.id, { type: "XPP_EXPORT" });
    const items = res?.items || [];
    if (!items.length) return flash("Nothing matched yet");
    await navigator.clipboard.writeText(res.json);
    const bad = items.filter((i) => i.clickable === false).length;
    flash(bad ? `Copied ${items.length} (${bad} unclickable)` : `Copied ${items.length} matches`);
  });

  async function activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https:\/\/(x|twitter)\.com\//.test(tab.url || "")) return null;
    return tab;
  }

  async function sendToTab(id, msg) {
    try {
      return await chrome.tabs.sendMessage(id, msg);
    } catch {
      return null;
    }
  }

  // Reflect the dry-run choice immediately, even before a run starts, so the
  // warning styling is never a surprise after pressing Start.
  function syncDryPreview() {
    const ticked = document.getElementById("dryRun").checked;
    const live = document.body.dataset.liveDry === "1";
    const dry = live || ticked;
    document.body.classList.toggle("dry", dry);
    document.getElementById("st-total-label").textContent = dry ? "matched" : "deleted";
    document.getElementById("start").textContent = dry ? "Start dry run" : "Start";
  }

  document.getElementById("dryRun").addEventListener("change", syncDryPreview);

  function flash(text) {
    const el = document.getElementById("saved");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(flash._t);
    flash._t = setTimeout(() => el.classList.remove("show"), 1800);
  }

  // Poll state for the status panel.
  async function updateStatus() {
    const tab = await activeTab();
    let st = null;
    if (tab) st = await sendToTab(tab.id, { type: "XPP_QUERY" });
    if (!st) {
      const { xppStatus } = await chrome.storage.local.get("xppStatus");
      st = xppStatus;
    }
    if (!st) {
      // No tab and no cached status: still show the operator's intent.
      document.body.dataset.liveDry = "0";
      syncDryPreview();
      return;
    }
    document.body.classList.toggle("running", !!st.running);
    document.getElementById("st-running").textContent = st.running ? "running" : "idle";
    document.getElementById("st-wave").textContent = st.wave
      ? `${st.wave} · ${st.deletedThisWave ?? 0}/${st.waveTarget ?? "?"}`
      : "—";
    document.getElementById("st-total").textContent = String(st.deletedTotal ?? 0);
    document.getElementById("st-failed").textContent = String(st.failed ?? 0);
    const dry = !!st.dryRun;
    document.body.dataset.liveDry = dry ? "1" : "0";
    syncDryPreview();
    document.getElementById("copyList").style.display = dry ? "" : "none";
    document.getElementById("st-queue").textContent = String(st.queueLeft ?? 0);
    document.getElementById("st-source").textContent =
      st.source === "archive" ? "archive" : "timeline";
    const cd = st.cooldownUntil && st.cooldownUntil > Date.now()
      ? `cooling down ${Math.ceil((st.cooldownUntil - Date.now()) / 1000)}s`
      : "";
    const badge = st.engineNote || "";
    const note = document.getElementById("st-note");
    note.textContent = [badge, cd].filter(Boolean).join(" · ");

  }

  async function updateLog() {
    // A pinned view (e.g. the diagnostic report) must survive log polling,
    // otherwise the next refresh wipes it and the panel looks empty.
    if (updateLog._pinned) return;
    const { xppLog } = await chrome.storage.local.get("xppLog");
    const el = document.getElementById("log");
    const rows = (xppLog || []).slice(-60);

    // Only rebuild when something actually changed, so the box does not
    // flicker or fight the user's scroll position on every poll.
    const stamp = rows.length + "|" + (rows[rows.length - 1]?.line || "");
    if (stamp === updateLog._stamp) return;
    updateLog._stamp = stamp;

    el.replaceChildren(
      ...rows.map((l) => {
        const line = document.createElement("div");
        line.textContent = l.line;
        if (l.level === "warn") line.className = "log-warn";
        else if (l.level === "error") line.className = "log-error";
        return line;
      }),
    );
    el.scrollTop = el.scrollHeight;
  }

  document.getElementById("clearLog").addEventListener("click", async () => {
    await chrome.storage.local.set({ xppLog: [] });
    await chrome.runtime.sendMessage({ type: "XPP_CLEAR_LOG" }).catch(() => {});
    updateLog._stamp = null;
    updateLog._pinned = false;
    const el = document.getElementById("log");
    el.replaceChildren();
    flash("Cleared");
  });

  updateStatus();
  updateLog();
  syncDryPreview();
  setInterval(updateStatus, 700);
  setInterval(updateLog, 1200);
});
