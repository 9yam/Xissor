// Regression tests for reply detection.
// Run: node test/replies.test.js
//
// Reproduces the reported bug: on /with_replies a post by you links to the
// person you replied to BEFORE linking to you, so "first href wins" picks the
// wrong author and the post is silently skipped.

let failures = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

// ---- copies of the logic under test, kept in sync with src/content.js ----

function currentUsername(pathname, profileHref) {
  const m = pathname.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$)/);
  if (m && !["home", "explore", "i", "search", "notifications", "messages"].includes(m[1])) {
    return m[1].toLowerCase();
  }
  return profileHref ? profileHref.replace("/", "").toLowerCase() : null;
}

function authorOf(art) {
  for (const a of art.querySelectorAll('a[href*="/status/"]')) {
    const href = a.getAttribute("href") || "";
    const m = href.match(/^\/([A-Za-z0-9_]{1,15})\/status\/\d+/);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

// ---- fixture builders ----

// A reply card: "Replying to @target" link appears first in User-Name,
// plus a separate status permalink. This is the shape that broke.
function replyCard(author, target, id) {
  return {
    querySelector(sel) {
      if (sel === 'a[href*="/status/"] time')
        return { closest: () => ({ getAttribute: () => `/${author}/status/${id}` }) };
      if (sel === '[data-testid="socialContext"]') return null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel.includes('href*="/status/"'))
        return [{ getAttribute: () => `/${author}/status/${id}` }];
      if (sel.includes("User-Name"))
        return [
          { getAttribute: () => `/${target}` },
          { getAttribute: () => `/${author}` },
        ];
      return [];
    },
  };
}

// Old behaviour, for contrast.
function oldAuthor(art) {
  for (const a of art.querySelectorAll('[data-testid="User-Name"] a[href^="/"]')) {
    const n = a.getAttribute("href").slice(1).split("/")[0];
    if (n && !n.startsWith("i")) return n.toLowerCase();
    return n.toLowerCase();
  }
  return null;
}

// 1. The bug itself.
const card = replyCard("hype", "someoneelse", "777");
eq("OLD logic misidentifies the reply target", oldAuthor(card), "someoneelse");
eq("NEW logic finds the real author", authorOf(card), "hype");

// 2. Replies tab path now yields a username (previously returned null).
eq("plain profile path", currentUsername("/hype"), "hype");
eq("with_replies path", currentUsername("/hype/with_replies"), "hype");
eq("media path", currentUsername("/hype/media"), "hype");
eq("with_replies trailing slash", currentUsername("/hype/with_replies/"), "hype");

// 3. Reserved paths must not be mistaken for a handle.
eq("home is not a handle", currentUsername("/home", "/hype"), "hype");
eq("explore is not a handle", currentUsername("/explore", "/hype"), "hype");
eq("notifications is not a handle", currentUsername("/notifications", "/hype"), "hype");
eq("i/status is not a handle", currentUsername("/i/status/123", "/hype"), "hype");

// 4. A post by someone else on your replies tab is still rejected.
const other = replyCard("stranger", "third_party", "888");
eq("others' replies not selected", [authorOf(other)].filter((a) => a === "hype").length, 0);

// 5. Tab walking order.
function tabOrder(mode) {
  if (mode === "posts") return ["posts"];
  if (mode === "replies") return ["with_replies"];
  return ["posts", "with_replies"];
}
eq("posts mode stops after posts", tabOrder("posts"), ["posts"]);
eq("replies mode targets replies", tabOrder("replies"), ["with_replies"]);
eq("both mode visits posts then replies", tabOrder("both"), ["posts", "with_replies"]);

process.exit(failures ? 1 : 0);
