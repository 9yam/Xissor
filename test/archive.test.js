// Unit tests for the archive parser. Run: node test/archive.test.js
const { parseArchive, normalise, mergeArchives } = require("../src/archive.js");

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (got ${detail})` : ""}`);
}
/** compare an actual value against an expected one */
function eq(name, actual, expected) {
  check(name, actual === expected, `${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`);
}

// 1. Real X export shape, with the YTD prefix and trailing semicolon.
const ytd = [
  'window.YTD.tweets.part0 = [',
  ' {"tweet": {"id_str": "100", "full_text": "oldest  post\\nwith newline",',
  '           "created_at": "Mon Jan 01 00:00:00 +0000 2018"}},',
  ' {"tweet": {"id_str": "300", "full_text": "newest",',
  '           "created_at": "Wed Jan 03 00:00:00 +0000 2018"}},',
  ' {"tweet": {"id_str": "200", "full_text": "middle",',
  '           "created_at": "Tue Jan 02 00:00:00 +0000 2018"}}',
  '];',
].join("\n");

const parsed = parseArchive(ytd);
check("parses YTD prefix + trailing semicolon", Array.isArray(parsed) && parsed.length === 3);

const norm = normalise(parsed);
eq("all three parsed", norm.length, 3);
eq("sorted oldest first", norm.map((t) => t.id).join(","), "100,200,300");
eq("whitespace collapsed in text", norm[0].text, "oldest post with newline");
eq("createdAt preserved", norm[1].createdAt, "Tue Jan 02 00:00:00 +0000 2018");

// 2. Bare JSON array (no prefix) must also work.
eq("accepts bare JSON array", parseArchive('[{"id_str":"999","full_text":"x"}]').length, 1);

// 3. Dedup across shards.
const merged = mergeArchives([
  normalise([{ tweet: { id_str: "100", full_text: "a", created_at: "Mon Jan 01 00:00:00 +0000 2018" } }]),
  normalise([{ tweet: { id_str: "100", full_text: "dup" } }, { tweet: { id_str: "50", full_text: "b", created_at: "Sun Dec 31 00:00:00 +0000 2017" } }]),
]);
eq("dedups across shards", merged.length, 2);
eq("merges in date order", merged.map((t) => t.id).join(","), "50,100");

// 4. Junk tolerance: entries with no usable id are dropped, not thrown on.
const junk = normalise([
  { tweet: { full_text: "no id at all" } },
  { tweet: { id_str: "abc" } },
  null,
  { tweet: { id_str: "12345", full_text: "keep me" } },
]);
eq("drops entries without a valid id", junk.length, 1);
eq("keeps the valid one", junk[0].id, "12345");

// 5. Retweets and replies are flagged, not silently mixed in.
const kinds = normalise([
  { tweet: { id_str: "11111", retweeted_status_id_str: "9" } },
  { tweet: { id_str: "22222", in_reply_to_status_id_str: "8" } },
]);
check("flags retweets", kinds.find((t) => t.id === "11111").isRetweet === true);
check("flags replies", kinds.find((t) => t.id === "22222").inReplyTo === "8");

// 6. Clear errors on garbage input.
function throws(fn, label) {
  try {
    fn();
    check(label, false, "did not throw");
  } catch {
    check(label, true);
  }
}
throws(() => parseArchive("not a data export"), "throws on garbage input");
throws(() => parseArchive('{"not":"an array"}'), "throws on non-array JSON");
throws(() => parseArchive(""), "throws on empty input");

process.exit(failures ? 1 : 0);
