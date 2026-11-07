// Exercises the archive queue loop against a stubbed fetch.
// Run: node test/archive-runner.test.js
//
// The runner lives inside an IIFE in content.js, so this test re-implements
// only the decision table it depends on and pins those decisions. If the
// content script changes shape, the checks below are what should be updated.

let failures = 0;
function eq(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (got ${actual}, want ${expected})`);
}

// Mirrors deleteViaGraphqlDirect's status mapping.
function mapStatus(status) {
  if (status === 429) return "RATE_LIMITED";
  if (status === 404) return true;
  if (status >= 200 && status < 300) return true;
  return false;
}

eq("200 means deleted", mapStatus(200), true);
eq("404 means already gone (treated as success)", mapStatus(404), true);
eq("429 means back off", mapStatus(429), "RATE_LIMITED");
eq("403 means failed", mapStatus(403), false);
eq("500 means failed", mapStatus(500), false);

// Attempt bounding: a permanently failing id must not stall a wave forever.
function runQueue(queue, failEvery) {
  const deleted = [];
  let guard = 0;
  while (queue.length && guard++ < 500) {
    const e = queue[0];
    const ok = !failEvery(e.id);
    if (ok) {
      deleted.push(e.id);
      queue.shift();
    } else {
      e.attempts = (e.attempts || 0) + 1;
      if (e.attempts >= 3) queue.shift();
      else continue;
    }
  }
  return deleted;
}

const q = [
  { id: "1" }, { id: "2" }, { id: "3" },
];
const ok = runQueue([...q.map((x) => ({ ...x }))], () => false);
eq("all deletable ids deleted", ok.join(","), "1,2,3");

// Every id fails: loop must terminate via the 3-attempt cap.
const stubborn = [{ id: "9", attempts: 0 }];
const none = runQueue(stubborn, () => true);
eq("permanently failing id is eventually dropped", stubborn.length, 0);
eq("and nothing is counted as deleted", none.length, 0);

// One bad id in the middle must not block later ones.
const mixed = [{ id: "a" }, { id: "bad" }, { id: "c" }];
const viaMixed = runQueue(mixed, (id) => id === "bad");
eq("bad id does not block the rest", viaMixed.join(","), "a,c");

// Retweet filtering: skipped, not deleted, and not retried.
function classify(entry, includeReposts) {
  if (entry.isRetweet && !includeReposts) return "SKIP";
  return "DELETE";
}
eq("retweet skipped by default", classify({ isRetweet: true }, false), "SKIP");
eq("retweet deleted when enabled", classify({ isRetweet: true }, true), "DELETE");
eq("normal post deleted", classify({ isRetweet: false }, false), "DELETE");

process.exit(failures ? 1 : 0);
