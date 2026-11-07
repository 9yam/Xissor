// Isolation test for the authorship/repost filter in src/content.js.
// Run: node test/selection.test.js
// The functions are copied verbatim from content.js (minus the runner).

function makeArticle(author, id, opts = {}) {
  const ctx = opts.social ? { textContent: opts.social } : null;
  return {
    querySelector(sel) {
      if (sel === 'a[href*="/status/"] time') {
        return { closest: () => ({ getAttribute: () => `/${author}/status/${id}` }) };
      }
      if (sel === '[data-testid="socialContext"]') return ctx;
      return null;
    },
    querySelectorAll(sel) {
      if (sel.includes("User-Name")) return [{ getAttribute: () => `/${author}` }];
      return [];
    },
  };
}

const ME = "hype";
const articles = [
  makeArticle(ME, "111"),
  makeArticle(ME, "222"),
  makeArticle("someoneelse", "333"), // must be ignored
  makeArticle(ME, "444", { social: "You reposted" }),
  makeArticle("someoneelse", "555", { social: "You reposted" }),
];

global.document = {
  querySelectorAll: () => articles,
  querySelector: () => ({ getAttribute: () => "/home" }),
};
global.location = { pathname: "/hype" };

function currentUsername() {
  const m = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
  return m ? m[1].toLowerCase() : null;
}

function collectOwnPosts(seenIds) {
  const me = currentUsername();
  const out = [];
  for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
    const link = art.querySelector('a[href*="/status/"] time')?.closest("a");
    let id = null;
    if (link) {
      const m = link.getAttribute("href").match(/\/status\/(\d+)/);
      if (m) id = m[1];
    }
    if (!id || seenIds.has(id)) continue;

    const authorLinks = art.querySelectorAll('[data-testid="User-Name"] a[href^="/"]');
    let author = null;
    for (const a of authorLinks) {
      const name = a.getAttribute("href").slice(1).split("/")[0];
      if (name && !name.startsWith("i")) {
        author = name.toLowerCase();
        break;
      }
    }
    if (!me || author !== me) continue;

    const ctx = art.querySelector('[data-testid="socialContext"]')?.textContent || "";
    out.push({ id, isRepost: !!ctx && /reposted/i.test(ctx) });
  }
  return out;
}

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (got ${actual}, want ${expected})`);
}

const found = collectOwnPosts(new Set());
check("only own posts collected", found.map((p) => p.id).join(","), "111,222,444");
check(
  "reposts excluded by default",
  found.filter((p) => !p.isRepost).map((p) => p.id).join(","),
  "111,222",
);
check(
  "already-seen ids skipped",
  collectOwnPosts(new Set(["111"])).map((p) => p.id).join(","),
  "222,444",
);

// Not on a profile page => no username => nothing selected.
global.location = { pathname: "/home" };
check("off-profile selects nothing", collectOwnPosts(new Set()).length, 0);

process.exit(failures ? 1 : 0);
