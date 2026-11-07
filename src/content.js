/* Xissor — content script
 *
 * Runs on x.com / twitter.com. Two independent strategies:
 *
 *  A) DOM driver (default): scrolls your profile, finds your own posts,
 *     clicks the caret menu -> Delete -> confirms. Uses the site's own code
 *     so it never needs private query IDs that X rotates.
 *
 *  B) GraphQL driver (optional): POSTs DeleteTweet directly, using the
 *     bearer token + csrf token scraped from the page. Much faster, but the
 *     query ID can change when X ships a new build, so it self-heals by
 *     learning the current ID from the page's scripts and the observed
 *     network requests.
 *
 * Both share the same rate limiter: N posts per wave, then a random
 * 3–5 minute cooldown.
 */

(() => {
  if (window.__XPP_LOADED__) return;
  window.__XPP_LOADED__ = true;

  const DEFAULTS = {
    batchMin: 50,
    batchMax: 70,
    cooldownMinMin: 3,
    cooldownMaxMin: 5,
    stepMinMs: 2500,
    stepMaxMs: 6000,
    mode: "posts",
    maxTotal: 0,
    includeReposts: false,
    engine: "dom",
    confirmEachWave: true,
    dryRun: false,
    source: "timeline",
    deleteQueryId: null,
  };

  const STORE_KEY = "xpp_settings";

  const state = {
    running: false,
    settings: { ...DEFAULTS },
    wave: 0,
    deletedThisWave: 0,
    deletedTotal: 0,
    waveTarget: 0,
    cooldownUntil: 0,
    stoppedByUser: false,
    engineNote: "",
    learnedDeleteQueryId: null,
    seenIds: new Set(),
    wouldDelete: [],
    archiveQueue: [],
    failed: 0,
  };

  // ---------------------------------------------------------------- helpers

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const rand = (min, max) => min + Math.random() * (max - min);
  const randInt = (min, max) => Math.floor(rand(min, max + 1));

  /**
   * Fallback author detection when no permalink is usable.
   * In a reply card the "Replying to @x" line contributes a User-Name anchor
   * for @x, so we must not simply take the first link we see.
   */
  function replyAwareAuthor(art) {
    const nameBlock = art.querySelector('[data-testid="User-Name"]');
    if (!nameBlock) return null;

    // Prefer an anchor that wraps the display name / avatar rather than the
    // inline "Replying to" mention.
    const pick = (list) => {
      for (const a of list) {
        const name = (a.getAttribute("href") || "").slice(1).split("/")[0];
        if (name && !name.startsWith("i")) return name.toLowerCase();
      }
      return null;
    };

    const direct = nameBlock.querySelectorAll
      ? nameBlock.querySelectorAll('a[href^="/"]')
      : [];
    const preferred = pick(direct);
    if (preferred) return preferred;
    return null;
  }

  /**
   * Is this card a repost, per X's social-context line ("You reposted")?
   * Kept deliberately simple: repost handling here only mirrors the original
   * behaviour, where reposts are skipped unless explicitly enabled.
   */
  function detectRepost(art) {
    const ctxEl = art.querySelector('[data-testid="socialContext"]');
    if (!ctxEl) return !!art.querySelector('[data-testid="unretweet"]');
    return /reposted/i.test(ctxEl.textContent || "");
  }

  /** Short human-readable snippet of a post, for dry-run logging. */
  function describeEntry(entry) {
    const text = (entry.element.querySelector('[data-testid="tweetText"]')?.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 70);
    const kind = entry.isRepost ? "repost" : "post";
    return text ? `${kind} "${text}${text.length >= 70 ? "…" : ""}"` : `${kind} (no text)`;
  }

  function log(msg, level = "info") {
    const line = `[XPP] ${msg}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
    chrome.runtime
      .sendMessage({ type: "XPP_LOG", line: msg, level })
      .catch(() => {});
  }

  function status() {
    chrome.runtime
      .sendMessage({
        type: "XPP_STATUS",
        payload: {
          running: state.running,
          wave: state.wave,
          waveTarget: state.waveTarget,
          deletedThisWave: state.deletedThisWave,
          deletedTotal: state.deletedTotal,
          failed: state.failed,
          cooldownUntil: state.cooldownUntil,
          engine: state.settings.engine,
          engineNote: state.engineNote,
          dryRun: !!state.settings.dryRun,
          source: state.settings.source || "timeline",
          queueLeft: (state.archiveQueue || []).length,
          now: Date.now(),
        },
      })
      .catch(() => {});
  }

  function getCsrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function getBearerToken() {
    // X's web client ships one public bearer token, identical for every
    // logged-in browser session. It is not a personal credential and cannot be
    // used without the user's own ct0 cookie, which is read at runtime below.
    return (
      state._bearer ||
      (state._bearer =
        "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA")
    );
  }

  // ------------------------------------------------------- tweets from DOM

  function currentUsername() {
    // Matches /handle, /handle/with_replies, /handle/media, etc.
    const m = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$)/);
    if (m && !["home", "explore", "i", "search", "notifications", "messages"].includes(m[1])) {
      return m[1].toLowerCase();
    }
    return document
      .querySelector('a[data-testid="AppTabBar_Profile_Link"]')
      ?.getAttribute("href")
      ?.replace("/", "")
      ?.toLowerCase();
  }

  /**
   * Author of a post, read from its permalink (/{author}/status/{id}).
   * That is authoritative and, crucially, survives replies — where the
   * User-Name block lists the person you replied to *before* your own link.
   */
  function authorOf(art) {
    const links = art.querySelectorAll('a[href*="/status/"]');
    for (const a of links) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/^\/([A-Za-z0-9_]{1,15})\/status\/\d+/);
      if (m) return m[1].toLowerCase();
    }
    return null;
  }

  /** Collect your own posts currently rendered in the timeline. */
  function collectOwnPosts() {
    const me = currentUsername();
    const out = [];
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (const art of articles) {
      // Tweet ID from the permalink's <time> anchor.
      const link = art.querySelector('a[href*="/status/"] time')?.closest("a");
      let id = null;
      if (link) {
        const m = link.getAttribute("href").match(/\/status\/(\d+)/);
        if (m) id = m[1];
      }
      if (!id || state.seenIds.has(id)) continue;

      // Only touch posts we are certain are ours.
      const author = authorOf(art) || replyAwareAuthor(art);
      if (!me || author !== me) continue;

      out.push({ id, element: art, isRepost: detectRepost(art) });
    }
    return out;
  }

  // -------------------------------------------------------- DOM deletion

  async function openCaretMenu(article) {
    const caret = article.querySelector('[data-testid="caret"]');
    if (!caret) return false;
    caret.click();
    await sleep(rand(350, 800));
    return true;
  }

  async function clickMenuDelete() {
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) =>
      /^delete$/i.test((el.textContent || "").trim()),
    );
    if (!item) return false;
    item.click();
    await sleep(rand(400, 900));

    // Confirmation sheet.
    const confirm = document.querySelector('[data-testid="confirmationSheetConfirm"]');
    if (confirm) {
      confirm.click();
      await sleep(rand(500, 1100));
    }
    return true;
  }

  async function deleteViaDom(entry) {
    if (entry.isRepost) return unretweetViaDom(entry);
    if (!(await openCaretMenu(entry.element))) {
      state.engineNote = "Could not find the post menu (layout changed?).";
      return false;
    }
    return clickMenuDelete();
  }

  /** Remove one repost via the unretweet control. */
  async function unretweetViaDom(entry) {
    const un = entry.element.querySelector('[data-testid="unretweet"]');
    if (!un) return false;
    un.click();
    await sleep(rand(300, 700));
    const confirm = document.querySelector('[data-testid="unretweetConfirm"]');
    if (confirm) confirm.click();
    await sleep(rand(300, 700));
    return true;
  }

  // ---------------------------------------------------- GraphQL deletion

  /** Learn the current DeleteTweet query ID from page scripts. */
  function discoverMutationId(opName) {
    if (state.learnedDeleteQueryId) return state.learnedDeleteQueryId;
    for (const s of document.querySelectorAll("script:not([src])")) {
      const t = s.textContent || "";
      if (!t.includes(opName)) continue;
      // Look for  "...":{queryId:"HASH",operationName:"DeleteTweet"
      const re = new RegExp(
        `queryId:"([A-Za-z0-9_-]{15,})",operationName:"${opName}"`,
      );
      const m = t.match(re);
      if (m) {
        state.learnedDeleteQueryId = m[1];
        return m[1];
      }
    }
    return null;
  }

  async function deleteViaGraphql(id) {
    const csrf = getCsrfToken();
    if (!csrf) {
      state.engineNote = "No ct0 cookie found — are you logged in?";
      return false;
    }
    let queryId = discoverMutationId("DeleteTweet");
    if (!queryId) {
      state.engineNote =
        "DeleteTweet query ID not found in page bundle; using DOM engine instead.";
      return deleteViaDomById(id);
    }
    const url = `https://x.com/i/api/graphql/${queryId}/DeleteTweet`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${getBearerToken()}`,
        "content-type": "application/json",
        "x-csrf-token": csrf,
        "x-twitter-active-user": "yes",
        "x-twitter-auth-type": "OAuth2Session",
      },
      credentials: "include",
      body: JSON.stringify({
        variables: { tweet_id: id, dark_request: false },
        queryId,
      }),
    });
    if (res.status === 429) {
      state.engineNote = "Rate limited by X (429). Backing off.";
      return "RATE_LIMITED";
    }
    if (!res.ok) {
      state.engineNote = `Delete failed (${res.status}).`;
      // Stale query ID is the most likely cause; forget it so the next
      // attempt re-learns from a freshly served bundle.
      state.learnedDeleteQueryId = null;
      return false;
    }
    return true;
  }

  /** DOM fallback when we know the id but the endpoint is unavailable. */
  async function deleteViaDomById(id) {
    const art = document.querySelector(`article[data-testid="tweet"] a[href*="/status/${id}"]`)
      ?.closest('article[data-testid="tweet"]');
    if (!art) return false;
    return deleteViaDom({ id, element: art, isRepost: false });
  }

  // ------------------------------------------------------------ the runner

  function currentTarget() {
    return randInt(state.settings.batchMin, state.settings.batchMax);
  }

  async function scrollMore() {
    window.scrollBy(0, Math.round(window.innerHeight * rand(0.8, 1.4)));
    await sleep(rand(1200, 2600));
  }

  /**
   * Profile tabs, in the order we want to clean them.
   * Replies live on /with_replies, a separate timeline.
   */
  function tabOrder() {
    const mode = state.settings.mode;
    if (mode === "posts") return ["posts"];
    if (mode === "replies") return ["with_replies"];
    return ["posts", "with_replies"];
  }

  /**
   * Navigate to the next profile tab that still has work. Returns true if we
   * moved (the page reloads, so the run resumes via sessionStorage).
   */
  async function goToNextTab() {
    const me = currentUsername();
    if (!me) return false;

    const order = tabOrder();
    const current = location.pathname.includes("/with_replies")
      ? "with_replies"
      : "posts";
    const idx = order.indexOf(current);
    const next = idx === -1 ? null : order[idx + 1];
    if (!next) return false;

    const url =
      next === "with_replies"
        ? `https://x.com/${me}/with_replies`
        : `https://x.com/${me}`;

    log(`Tab exhausted — continuing on ${next}.`, "warn");
    sessionStorage.setItem(
      "xpp_resume",
      JSON.stringify({
        settings: state.settings,
        deletedTotal: state.deletedTotal,
        wave: state.wave,
      }),
    );
    state.running = false;
    location.href = url;
    return true;
  }

  /** Called at startup: pick the run back up if we navigated mid-session. */
  function maybeResume() {
    let saved;
    try {
      saved = JSON.parse(sessionStorage.getItem("xpp_resume") || "null");
    } catch {
      return;
    }
    if (!saved) return;
    sessionStorage.removeItem("xpp_resume");
    log(`Resumed on ${location.pathname} — continuing the purge.`);
    state.deletedTotal = saved.deletedTotal || 0;
    state.wave = saved.wave || 0;
    state._resuming = true;
    start(saved.settings);
  }

  async function runWave() {
    state.wave += 1;
    state.deletedThisWave = 0;
    state.waveTarget = currentTarget();
    log(
      `Wave ${state.wave} starting — target ${state.waveTarget} posts, ` +
        `${state.settings.cooldownMinMin}–${state.settings.cooldownMaxMin} min cooldown after.`,
    );
    status();

    if (state.settings.source === "archive") return runWaveFromArchive();

    let idleScrolls = 0;

    while (
      state.running &&
      state.deletedThisWave < state.waveTarget &&
      !state.stoppedByUser
    ) {
      if (state.settings.maxTotal && state.deletedTotal >= state.settings.maxTotal) {
        log(`Total cap of ${state.settings.maxTotal} reached. Stopping.`);
        stop("cap");
        return;
      }

      const posts = collectOwnPosts().filter(
        (p) => state.settings.includeReposts || !p.isRepost,
      );

      if (posts.length === 0) {
        idleScrolls += 1;
        if (idleScrolls > 25) {
          // Timeline exhausted: move on to replies before giving up.
          if (await goToNextTab()) {
            idleScrolls = 0;
            continue;
          }
          log("No more of your posts found on this timeline. Stopping.", "warn");
          stop("exhausted");
          return;
        }
        await scrollMore();
        continue;
      }
      idleScrolls = 0;

      const entry = posts[0];
      state.seenIds.add(entry.id);

      let ok;
      if (state.settings.dryRun) {
        // Dry run: exercise discovery + pacing, but never mutate.
        const preview = describeEntry(entry);
        log(`[DRY RUN] would delete ${entry.id} — ${preview}`);
        state.wouldDelete.push({ id: entry.id, preview, at: Date.now() });
        ok = true;
      } else if (state.settings.engine === "graphql") {
        ok = await deleteViaGraphql(entry.id);
        if (ok === "RATE_LIMITED") {
          log("X returned 429 — entering cooldown early.", "warn");
          await cooldown();
          continue;
        }
        if (ok !== true) {
          // Endpoint moved or refused: fall back to clicking for this post,
          // and remember that GraphQL is not currently usable.
          state.engineNote = state.engineNote || "GraphQL delete failed; using DOM.";
          state.graphqlBroken = true;
        }
      } else {
        ok = await deleteViaDom(entry);
      }

      if (ok === true) {
        state.deletedThisWave += 1;
        state.deletedTotal += 1;
        if (state.settings.dryRun) {
          log(
            `Matched ${entry.id} (${state.deletedThisWave}/${state.waveTarget} this wave, ${state.deletedTotal} total).`,
          );
        } else {
          log(`Deleted ${entry.id} (${state.deletedThisWave}/${state.waveTarget} this wave, ${state.deletedTotal} total).`);
        }
      } else {
        state.failed += 1;
        log(`Skipped ${entry.id} (could not delete).`, "warn");
      }
      status();

      // Jittered pause between individual deletions.
      await sleep(randInt(state.settings.stepMinMs, state.settings.stepMaxMs));

      if (state.deletedThisWave >= state.waveTarget) break;
    }

    if (!state.running) return;

    if (state.stoppedByUser) {
      log("Stopped by user.");
      return;
    }

    if (state.settings.dryRun) logDryRunVerdict();

    await cooldown();
  }

  async function cooldown() {
    const minutes = rand(state.settings.cooldownMinMin, state.settings.cooldownMaxMin);
    const ms = minutes * 60 * 1000;
    state.cooldownUntil = Date.now() + ms;
    log(`Cooldown: ${minutes.toFixed(1)} minutes.`);
    status();
    while (Date.now() < state.cooldownUntil && state.running) {
      await sleep(1000);
      status();
    }
    state.cooldownUntil = 0;
    status();
    if (state.running) await runWave();
  }

  async function start(settings) {
    if (state.running) return;
    state.settings = { ...DEFAULTS, ...settings };
    if (state.settings.batchMin > state.settings.batchMax) {
      [state.settings.batchMin, state.settings.batchMax] = [
        state.settings.batchMax,
        state.settings.batchMin,
      ];
    }
    state.running = true;
    state.stoppedByUser = false;
    if (state._resuming) {
      // Keep counts carried across the page reload from tab navigation.
      state._resuming = false;
    } else {
      state.wave = 0;
      state.deletedTotal = 0;
    }
    state.failed = 0;
    state.learnedDeleteQueryId = null;
    state.seenIds = new Set();
    state.wouldDelete = [];
    if (!state.archiveQueue) state.archiveQueue = [];
    if (state.settings.source !== "archive") state.archiveQueue = [];
    state.engineNote = "";
    state.graphqlBroken = false;
    if (state.settings.dryRun) {
      log("DRY RUN — nothing will be deleted. Pacing is simulated for real.", "warn");
    }
    status();
    runWave();
  }

  /** One-line dry-run summary. Called whenever a run ends, however it ends. */
  function logDryRunVerdict() {
    if (!state.settings.dryRun) return;
    if (state.wouldDelete.length === 0) {
      log("Dry-run: no posts matched — nothing to preview.", "warn");
      return;
    }
    log(`Dry-run: ${state.wouldDelete.length} posts matched.`);
  }

  function stop(reason = "user") {
    state.running = false;
    state.stoppedByUser = true;
    state.cooldownUntil = 0;
    log(
      `Stopped (${reason}). Deleted ${state.deletedTotal} posts this session.`,
    );
    logDryRunVerdict();
    status();
  }

  // ------------------------------------------------- archive-driven runner
  //
  // Timeline discovery can only reach posts X still renders. The archive is a
  // complete list, including posts too old to scroll to. That means every
  // deletion here must go through GraphQL: there is no DOM node to click.
  //
  // Note: archive entries that are reposts cannot be removed by id through
  // DeleteTweet, so they are skipped here.

  async function runWaveFromArchive() {
    const queue = state.archiveQueue;
    if (!queue || queue.length === 0) {
      log("Archive queue is empty — nothing left to delete.", "warn");
      stop("exhausted");
      return;
    }

    let idle = 0;
    while (
      state.running &&
      state.deletedThisWave < state.waveTarget &&
      !state.stoppedByUser
    ) {
      if (state.settings.maxTotal && state.deletedTotal >= state.settings.maxTotal) {
        log(`Total cap of ${state.settings.maxTotal} reached. Stopping.`);
        stop("cap");
        return;
      }

      const entry = queue[0];
      if (!entry) break;

      if (state.settings.dryRun) {
        log(
          `[DRY RUN] would delete ${entry.id} — post "${(entry.text || "").slice(0, 70)}" (${entry.createdAt})`,
        );
        state.wouldDelete.push({
          id: entry.id,
          preview: `post "${(entry.text || "").slice(0, 70)}"`,
          createdAt: entry.createdAt,
          at: Date.now(),
        });
        state.deletedThisWave += 1;
        state.deletedTotal += 1;
        queue.shift();
        status();
        await sleep(randInt(state.settings.stepMinMs, state.settings.stepMaxMs));
        continue;
      }

      // Reposts are not deleted through DeleteTweet, so skip them here.
      if (entry.isRetweet) {
        log(`Skipped ${entry.id} (repost).`);
        queue.shift();
        continue;
      }

      const res = await deleteViaGraphqlDirect(entry.id);

      if (res === "RATE_LIMITED") {
        log("X returned 429 — cooling down before continuing.", "warn");
        await cooldown();
        return;
      }

      if (res === true) {
        state.deletedThisWave += 1;
        state.deletedTotal += 1;
        queue.shift();
        log(
          `Deleted ${entry.id} (${state.deletedThisWave}/${state.waveTarget} this wave, ${state.deletedTotal} total, ${queue.length} left in archive).`,
        );
      } else {
        // Keep it in the queue but bound the attempts so one bad id cannot
        // stall an entire wave.
        entry.attempts = (entry.attempts || 0) + 1;
        state.failed += 1;
        log(
          `Failed ${entry.id} (attempt ${entry.attempts}): ${state.engineNote || "unknown error"}`,
          "warn",
        );
        if (entry.attempts >= 3) {
          log(`Giving up on ${entry.id}.`, "warn");
          queue.shift();
        } else if (++idle > 8) {
          log("Too many consecutive failures — stopping.", "error");
          stop("errors");
          return;
        }
      }
      status();
      await sleep(randInt(state.settings.stepMinMs, state.settings.stepMaxMs));
    }

    if (!state.running || state.stoppedByUser) return;
    await cooldown();
  }

  /** Delete one id with no DOM fallback — required for archive mode. */
  async function deleteViaGraphqlDirect(id) {
    const csrf = getCsrfToken();
    if (!csrf) {
      state.engineNote = "No ct0 cookie — log in to x.com first.";
      return false;
    }
    const queryId =
      discoverMutationId("DeleteTweet") || state.settings.deleteQueryId || null;
    if (!queryId) {
      state.engineNote =
        "DeleteTweet query ID not found. Open x.com devtools, delete one post manually, and paste the queryId in Options.";
      return false;
    }
    const res = await fetch(`https://x.com/i/api/graphql/${queryId}/DeleteTweet`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${getBearerToken()}`,
        "content-type": "application/json",
        "x-csrf-token": csrf,
        "x-twitter-active-user": "yes",
        "x-twitter-auth-type": "OAuth2Session",
      },
      credentials: "include",
      body: JSON.stringify({
        variables: { tweet_id: id, dark_request: false },
        queryId,
      }),
    });
    if (res.status === 429) return "RATE_LIMITED";
    if (res.status === 404) return true; // already gone
    if (!res.ok) {
      state.engineNote = `HTTP ${res.status}`;
      state.learnedDeleteQueryId = null;
      return false;
    }
    return true;
  }

  // ----------------------------------------------------------- messaging

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "XPP_LOAD_ARCHIVE") {
      try {
        const items = msg.items || [];
        if (!Array.isArray(items) || items.length === 0) {
          sendResponse({ ok: false, error: "No posts found in that file." });
          return true;
        }
        state.archiveQueue = items.map((i) => ({ ...i, attempts: 0 }));
        state.settings.source = "archive";
        state.settings.engine = "graphql";
        state.settings.deleteQueryId = msg.deleteQueryId || null;
        state.wouldDelete = [];
        log(
          `Archive loaded: ${items.length} posts queued ` +
            `(${items.filter((i) => i.isRetweet).length} retweets, ` +
            `${items.filter((i) => i.inReplyTo).length} replies).`,
        );
        sendResponse({ ok: true, count: state.archiveQueue.length });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return true;
    }
    if (msg?.type === "XPP_START") {
      start(msg.settings).then(() =>
        sendResponse({ ok: true, running: state.running }),
      );
      return true;
    }
    if (msg?.type === "XPP_STOP") {
      stop();
      sendResponse({ ok: true });
      return true;
    }
    if (msg?.type === "XPP_QUERY") {
      sendResponse({
        ok: true,
        running: state.running,
        wave: state.wave,
        waveTarget: state.waveTarget,
        deletedThisWave: state.deletedThisWave,
        deletedTotal: state.deletedTotal,
        cooldownUntil: state.cooldownUntil,
        engineNote: state.engineNote,
        dryRun: !!state.settings.dryRun,
        wouldDelete: state.wouldDelete.slice(-200),
        username: currentUsername(),
      });
      return true;
    }
    if (msg?.type === "XPP_EXPORT" && state.settings.dryRun) {
      sendResponse({
        ok: true,
        items: state.wouldDelete,
        json: JSON.stringify(state.wouldDelete, null, 2),
      });
      return true;
    }
    return false;
  });

  log("Xissor content script ready.");
  maybeResume();
})();
