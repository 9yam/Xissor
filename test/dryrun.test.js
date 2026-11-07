// Asserts that dry-run mode cannot reach a mutating path.
// Run: node test/dryrun.test.js
const fs = require("fs");
const src = fs.readFileSync("src/content.js", "utf8");

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

// 1. The dry-run branch must be tested BEFORE the engine branches, so no
//    delete call can run first.
const dryIdx = src.indexOf("if (state.settings.dryRun) {");
const gqlIdx = src.indexOf('state.settings.engine === "graphql"');
check("dry-run branch precedes engine branches", dryIdx !== -1 && dryIdx < gqlIdx);

// 2. Inside the dry-run branch, no delete function may be called.
const branchStart = src.indexOf("if (state.settings.dryRun) {");
const branchEnd = src.indexOf('} else if (state.settings.engine === "graphql")', branchStart);
const branch = src.slice(branchStart, branchEnd);
check(
  "dry-run branch calls no delete function",
  !/deleteViaDom|deleteViaGraphql|clickMenuDelete|openCaretMenu/.test(branch),
);

// 3. Both mutating engines skip confirmation sheets in dry run by construction,
//    because they are only reachable via the else-if chain.
check("deleteViaDom only reached via else branch", /} else \{\s*ok = await deleteViaDom/.test(src));

// 4. Dry run must still be able to export its match list.
check("export handler exists", /XPP_EXPORT/.test(src));

// 5. Defaults must have dry run off, so a fresh install is explicit about it.
check("dryRun defaults to false", /dryRun: false/.test(src));

process.exit(failures ? 1 : 0);
