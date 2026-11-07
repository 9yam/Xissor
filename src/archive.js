/* Archive parsing for X data exports.
 *
 * X ships `tweets.js` (and `tweets-part1.js`, ...) as:
 *     window.YTD.tweets.part0 = [ { tweet: { id_str, full_text, created_at, ... } }, ... ]
 * Some exports (and community archives) use bare JSON arrays instead.
 *
 * This module is UI-free so it can be unit tested under Node.
 */

(function (root) {
  /**
   * Strip the `window.YTD.foo.partN =` prefix and parse the remaining array.
   * Accepts already-valid JSON too.
   */
  function parseArchive(text) {
    if (typeof text !== "string") throw new Error("Archive file is empty.");
    let body = text.trim();

    // Drop a BOM if present.
    if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);

    const assignment = body.match(/^\s*window\.[A-Za-z0-9_.]+\s*=\s*/);
    if (assignment) body = body.slice(assignment[0].length);

    // Trailing `;` is common in YTD files.
    body = body.replace(/;\s*$/, "");

    let data;
    try {
      data = JSON.parse(body);
    } catch (err) {
      throw new Error(`Not valid JSON after stripping the YTD prefix: ${err.message}`);
    }
    if (!Array.isArray(data)) throw new Error("Expected an array of tweet objects.");
    return data;
  }

  /**
   * Normalise parsed entries into { id, createdAt, text }.
   * Handles both `{tweet:{...}}` and flat `{id_str,...}` shapes.
   * Retweets (`retweeted_status_id_str`) are flagged so the caller can skip them.
   */
  function normalise(entries) {
    const out = [];
    const seen = new Set();
    for (const entry of entries) {
      const t = entry && (entry.tweet || entry);
      if (!t) continue;

      const id = String(t.id_str || t.id || "").trim();
      // X ids are pure digits. Real ones are long, but do not impose a
      // length floor here: validation is about shape, not size.
      if (!/^\d{1,25}$/.test(id) || seen.has(id)) continue;
      seen.add(id);

      out.push({
        id,
        createdAt: t.created_at || "",
        text: (t.full_text || t.text || "").replace(/\s+/g, " ").trim(),
        isRetweet: !!t.retweeted_status_id_str,
        inReplyTo: t.in_reply_to_status_id_str || null,
      });
    }
    // Oldest first is friendlier when you have to stop part-way.
    out.sort((a, b) => {
      const ta = Date.parse(a.createdAt) || 0;
      const tb = Date.parse(b.createdAt) || 0;
      return ta - tb;
    });
    return out;
  }

  /** merge several archive shards into one de-duplicated, ordered list */
  function mergeArchives(lists) {
    const byId = new Map();
    for (const list of lists) {
      for (const item of list) if (!byId.has(item.id)) byId.set(item.id, item);
    }
    return [...byId.values()].sort(
      (a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0),
    );
  }

  const api = { parseArchive, normalise, mergeArchives };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.XPP_ARCHIVE = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
