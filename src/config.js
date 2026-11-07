// Shared default settings. Kept in one place so content + popup agree.
// Deleting is irreversible, so all knobs are conservative by default.
const DEFAULTS = {
  // How many posts to delete in one "wave" before the long cooldown.
  batchMin: 50,
  batchMax: 70,

  // Random cooldown between waves, in minutes.
  cooldownMinMin: 3,
  cooldownMaxMin: 5,

  // Delay between individual deletes inside a wave, in milliseconds.
  stepMinMs: 2500,
  stepMaxMs: 6000,

  // Which timelines to walk. "posts" = your own tweets only.
  mode: "posts", // posts | replies | both

  // Stop after this many total deletions (0 = no cap).
  totalCap: 0,

  // Retweets: unretweet instead of delete.
  includeReposts: false,

  // Safety: require the operator to confirm each wave unless this is true.
  autoKeys: false,
};

if (typeof globalThis !== "undefined") {
  globalThis.XPP_DEFAULTS = DEFAULTS;
}
