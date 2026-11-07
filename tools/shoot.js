/* Screenshot harness: renders src/popup.html with a stubbed chrome.* API and
 * captures the states documented in README.md.
 *
 * Run: node tools/shoot.js
 * Output: docs/img/*.png
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { crop } = require("./crop.js");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "docs", "img");
const TMP = path.join(ROOT, ".shots");

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chromePath) {
  console.error("No Chrome/Edge binary found. Edit CHROME_CANDIDATES.");
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

const BASE_SETTINGS = {
  batchMin: 50,
  batchMax: 70,
  cooldownMinMin: 3,
  cooldownMaxMin: 5,
  stepMinMs: 2500,
  stepMaxMs: 6000,
  engine: "dom",
  mode: "posts",
  source: "timeline",
  maxTotal: 0,
  includeReposts: false,
  dryRun: false,
  deleteQueryId: null,
};

function status(over) {
  return {
    running: false,
    wave: 0,
    waveTarget: 0,
    deletedThisWave: 0,
    deletedTotal: 0,
    failed: 0,
    cooldownUntil: 0,
    engine: "dom",
    engineNote: "",
    dryRun: false,
    source: "timeline",
    queueLeft: 0,
    ...over,
  };
}

const L = (line, level = "info") => ({ t: Date.now(), line, level });

/** Each shot: name, settings overrides, status, log lines, optional click. */
const SHOTS = [
  {
    name: "01-idle",
    caption: "Idle — the default view",
    settings: {},
    status: status({}),
    log: [],
  },
  {
    name: "02-dry-run",
    caption: "Dry run — previews matches without deleting",
    settings: { dryRun: true },
    status: status({ dryRun: true, running: true, wave: 1, waveTarget: 63, deletedThisWave: 12, deletedTotal: 12 }),
    log: [
      L("Wave 1 starting — target 63 posts, 3–5 min cooldown after."),
      L('[DRY RUN] would delete 1691234567890123456 — post "shipping v0.2 today, small batch…"'),
      L('[DRY RUN] would delete 1691234567890123457 — post "hot take: builds should be boring"'),
      L('[DRY RUN] would delete 1691234567890123458 — post "wrote up the rate limiter notes"'),
      L("[DRY RUN] would delete 1691234567890123459 — post (no text)"),
    ],
  },
  {
    name: "03-running",
    caption: "Running — wave progress and live activity",
    settings: { cooldownMaxMin: 5 },
    status: status({
      running: true,
      wave: 3,
      waveTarget: 58,
      deletedThisWave: 41,
      deletedTotal: 164,
      failed: 2,
    }),
    log: [
      L("Wave 3 starting — target 58 posts, 3–5 min cooldown after."),
      L("Deleted 1691234567890123471 (39/58 this wave, 162 total)."),
      L("Skipped 1691234567890123472 (could not delete).", "warn"),
      L("Deleted 1691234567890123473 (40/58 this wave, 163 total)."),
      L("Deleted 1691234567890123474 (41/58 this wave, 164 total)."),
    ],
  },
  {
    name: "04-cooldown",
    caption: "Cooldown — randomised pause between waves",
    settings: {},
    status: status({
      running: true,
      wave: 2,
      waveTarget: 61,
      deletedThisWave: 61,
      deletedTotal: 127,
      cooldownUntil: Date.now() + 143000,
    }),
    log: [
      L("Wave 2 starting — target 61 posts, 3–5 min cooldown after."),
      L("Deleted 1691234567890123456 (61/61 this wave, 127 total)."),
      L("Cooldown: 3.7 minutes."),
    ],
  },
  {
    name: "05-archive",
    caption: "Archive mode — queue posts from your X data export",
    settings: { source: "archive", dryRun: false },
    status: status({ source: "archive", queueLeft: 1284, running: false }),
    log: [L("Archive loaded: 1284 posts queued (0 retweets, 612 replies).")],
  },
  {
    name: "06-replies",
    caption: "Replies mode — walks your replies tab too",
    settings: { mode: "both" },
    status: status({ running: true, wave: 1, waveTarget: 55, deletedThisWave: 18, deletedTotal: 18 }),
    log: [
      L("Wave 1 starting — target 55 posts, 3–5 min cooldown after."),
      L("Deleted 1691234567890123480 (17/55 this wave, 17 total)."),
      L("Tab exhausted — continuing on with_replies.", "warn"),
      L("Resumed on /hype/with_replies — continuing the purge."),
    ],
  },
];

function buildStub({ settings, status: st, log }) {
  return `
const SETTINGS = ${JSON.stringify({ ...BASE_SETTINGS, ...settings })};
const STATUS = ${JSON.stringify(st)};
const LOG = ${JSON.stringify(log)};
window.chrome = {
  storage: {
    local: {
      get: async (k) => ({ xppSettings: SETTINGS, xppStatus: STATUS, xppLog: LOG }),
      set: async () => {},
    },
  },
  runtime: { sendMessage: async () => null },
  tabs: {
    query: async () => [{ id: 1, url: "https://x.com/hype" }],
    sendMessage: async (id, m) => {
      if (m.type === "XPP_QUERY") return STATUS;
      if (m.type === "XPP_EXPORT") return { ok: true, items: [], json: "[]" };
      return null;
    },
  },
};
`;
}


/** Render a page headlessly and return its real content height in CSS px. */
function measureHeight(file) {
  const html = fs
    .readFileSync(file, "utf8")
    .replace(
      "</body>",
      '<script>setTimeout(function(){document.title="H="+document.documentElement.scrollHeight;},1600);</script></body>',
    );
  const probe = file.replace(/\.html$/, "-probe.html");
  fs.writeFileSync(probe, html);
  const dom = execFileSync(
    chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--window-size=372,2000",
      "--virtual-time-budget=3000",
      "--dump-dom",
      `file:///${probe.replace(/\\/g, "/")}`,
    ],
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  );
  const m = dom.match(/<title>H=(\d+)<\/title>/);
  fs.rmSync(probe, { force: true });
  return m ? Number(m[1]) : 1180;
}

let failures = 0;
for (const shot of SHOTS) {
  const html = fs
    .readFileSync(path.join(ROOT, "src", "popup.html"), "utf8")
    .replace(
      '<script src="archive.js"></script>',
      `<script>${buildStub(shot)}</script><script src="archive.js"></script>`,
    )
    .replace(
      "</body>",
      // body.archive is normally toggled by a change listener; set the class up
      // front so archive-mode shots show the section.
      (shot.settings.source === "archive"
        ? '<script>document.addEventListener("DOMContentLoaded",function(){document.body.classList.add("archive");' +
          'var i=document.getElementById("archiveInfo");if(i)i.innerHTML="<b>1284</b> posts parsed from tweets.js";' +
          'var s=document.getElementById("source");if(s)s.value="archive";});</script>'
        : "") +
        `<script>setTimeout(function(){var el=document.getElementById("log");if(el)el.scrollTop=0;},2000);</script></body>`,
    );

  const file = path.join(TMP, `${shot.name}.html`);
  fs.writeFileSync(file, html);
  fs.copyFileSync(path.join(ROOT, "src", "popup.js"), path.join(TMP, "popup.js"));
  fs.copyFileSync(path.join(ROOT, "src", "archive.js"), path.join(TMP, "archive.js"));

  const png = path.join(OUT, `${shot.name}.png`);
  // Trim to the real content height so docs show no dead space at the bottom.
  let height = 1180;
  try {
    height = Math.min(2400, Math.max(560, measureHeight(file) + 8));
  } catch {
    /* fall back to the default height */
  }
  try {
    execFileSync(
      chromePath,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=2",
        `--window-size=372,${height}`,
        `--screenshot=${png}`,
        // Longer budget so the log's scroll-to-top (injected below) lands.
        "--virtual-time-budget=4200",
        `file:///${file.replace(/\\/g, "/")}`,
      ],
      { stdio: "pipe" },
    );
    // Trim trailing uniform rows so docs images have no dead space.
    try {
      crop(png);
    } catch (e) {
      console.log(`     (crop skipped: ${e.message})`);
    }
    const size = fs.statSync(png).size;
    console.log(`OK   ${shot.name}.png  (${(size / 1024).toFixed(1)} KB)`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${shot.name}: ${err.message.split("\n")[0]}`);
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n${failures} shot(s) failed` : "\nAll screenshots written to docs/img/");
process.exit(failures ? 1 : 0);
