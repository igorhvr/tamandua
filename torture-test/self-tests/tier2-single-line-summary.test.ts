// US-005 — the four exit-0 PRODUCT_FAIL local-command cells now emit their
// final summary in the canonical SINGLE-LINE JSON form the controller parses.
// US-006 (T2.1) extends the pin to W4.12-port-squatter: its runner had the
// same multi-line `, null, 2` summary defect, masked in the operator campaign
// by the bootstrap failure (the daemon never came up); once the bootstrap is
// fixed the cell must ALSO emit a parseable single-line summary or it would
// classify exit-0 PRODUCT_FAIL exactly like the US-005 four.
// US-007 (T2.1) extends the pin to W4.20-update-repo-state-classification:
// its runner had the same multi-line summary defect, masked in the operator
// campaign by the behind-leg assertion failure (leftover active-run
// contamination from a preceding cell made `tamandua update` refuse); once
// the isolation fix lands the cell must ALSO emit a parseable single-line
// summary or it would classify exit-0 PRODUCT_FAIL.
// US-008 (T2.1) extends the pin to W4.24-serial-lane-concurrent: the cell
// already emitted its summary single-line, but the US-008 daemon-down
// recovery change rewrites the runner's summary block (adding the
// `daemon_recovery` evidence) — the pin guarantees the rewrite keeps the
// canonical `})}\n`);` single-line form with result "PASS" (the controller's
// local-case mechanical check), so a future regression cannot silently turn
// the cell into an exit-0 PRODUCT_FAIL.
//
// Campaign evidence (operator run on merged main): W4.27-shim-exit-matrix,
// W4.11-sigkill-launch-matrix, W4.19-stale-catalog-warn-not-block and
// W4.34-stale-cli-new-daemon each exited 0 and fully exercised their corridor,
// but the local-case proof showed summary=null and checks.scenario_passed=false
// -> 'local-case mechanical check failed: scenario_passed'. Root cause:
// bin/tt-controller parseLocalCommandSummary only parses a SINGLE-LINE JSON
// object on the last non-empty stdout line, while these four runners printed
// `JSON.stringify({...}, null, 2)` (multi-line pretty-printed). The lone PASS
// cell W4.21 (run-bare-noninteractive.mjs) prints `JSON.stringify({...})`
// single-line.
//
// This test pins the static shape of the summary emission for the runners
// (AC1/AC4): the final stdout summary must be a single-line JSON.stringify
// emission carrying result "PASS" — never the 3-arg pretty-print form. It is
// scoped to the SUMMARY EMISSION block (the final process.stdout.write with a
// JSON.stringify object), because these runners legitimately use
// `JSON.stringify(..., null, 2)` in stderr assert messages (w4.27/w4.11) and
// in stamp-file writes (w4.19/w4.34) — those must stay intact. The end-to-end
// execution of the cells (AC2/AC3) is driven by run-scripted-scenario in
// the campaign battery / US-010 re-proof; this file stays fast (zero tokens,
// no daemon).
//
// Confined to torture-test/. Zero tokens. No daemon is started.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");

// The US-005/US-006 cells and the runner that emits each summary.
const CELLS: Record<string, string> = {
  "W4.27-shim-exit-matrix": "scenarios/w4.27/shim-exit-matrix/run-shim-exit-matrix.mjs",
  "W4.11-sigkill-launch-matrix": "scenarios/w4.11/sigkill-launch-matrix/run-sigkill-launch-matrix.mjs",
  "W4.19-stale-catalog-warn-not-block": "scenarios/w4.19/stale-catalog-warn-not-block/run-stale-catalog.mjs",
  "W4.34-stale-cli-new-daemon": "scenarios/w4.34/stale-cli-new-daemon/run-stale-cli.mjs",
  // US-006: W4.12's runner carries the same single-line summary contract.
  "W4.12-port-squatter": "scenarios/w4.12/port-squatter/run-port-squatter.mjs",
  // US-007: W4.20's runner had the same `, null, 2` defect, masked in the
  // operator campaign by the behind-leg assertion failure (leftover active-run
  // contamination); once the isolation fix lands the cell must ALSO emit a
  // parseable single-line summary or it would classify exit-0 PRODUCT_FAIL.
  "W4.20-update-repo-state-classification":
    "scenarios/w4.20/update-repo-state-classification/run-update-repo-state.mjs",
  // US-008: W4.24's runner summary block was rewritten (daemon_recovery
  // evidence) — the pin keeps the canonical single-line form + result PASS.
  "W4.24-serial-lane-concurrent":
    "scenarios/w4.24/serial-lane-concurrent/run-serial-lane-concurrent.mjs",
};

// Extract the final stdout summary emission: the LAST process.stdout.write
// whose template starts with `${JSON.stringify({`. Returns the block text.
function finalSummaryEmission(source: string): string {
  const marker = 'process.stdout.write(`${JSON.stringify({';
  const idx = source.lastIndexOf(marker);
  assert.ok(idx >= 0, `runner must end with a process.stdout.write single-line JSON summary (missing '${marker}')`);
  const rest = source.slice(idx);
  // The block ends at the template-close + call-close + statement terminator:
  // `})}\n`);`  (single-line form). Assert that exact closing so a regression
  // back to `}, null, 2)}\n`);` fails loudly. Note `\\n` here is the literal
  // two-character escape sequence inside the runner's template literal.
  const closing = "})}\\n`);";
  assert.ok(rest.startsWith(marker) && rest.includes(closing),
    "summary emission must close with `})}\\n`);` (single-line JSON, no `, null, 2` pretty-print)");
  return rest.slice(0, rest.indexOf(closing) + closing.length);
}

describe("Tier-2 US-005 — the four exit-0 PRODUCT_FAIL cells emit canonical single-line JSON summaries", () => {
  it("each runner's final stdout summary is a single-line JSON.stringify emission with result PASS (AC1/AC4)", () => {
    for (const [id, runnerPath] of Object.entries(CELLS)) {
      const source = fs.readFileSync(path.join(ttRoot, runnerPath), "utf8");
      const emission = finalSummaryEmission(source);
      // The summary must carry result "PASS" (the controller's local-case
      // mechanical check requires summary.result === "PASS").
      assert.match(emission, /result:\s*"PASS"/, `${id}: summary must emit result "PASS"`);
      // The emission must NOT use the 3-arg pretty-print form. The regex is
      // scoped to the emission block so legit `null, 2` uses elsewhere
      // (stderr assert messages, stamp files) never trip it.
      assert.ok(!/JSON\.stringify\(\{[^]*?,\s*null,\s*2\s*\)/.test(emission),
        `${id}: summary emission must NOT pretty-print with a null-spaces argument (the controller's parseLocalCommandSummary only reads single-line JSON)`);
      // Sanity: the emission block itself must not contain the 3-arg form at
      // all (belt-and-suspenders on top of the closing-shape assertion).
      assert.ok(!emission.includes(", null, 2)"),
        `${id}: summary emission block must not contain the pretty-print argument list`);
      // The runner must not write anything to stdout after the summary — the
      // summary is the LAST stdout emission in the file.
      const after = source.slice(idxOfEndOf(emission, source));
      assert.ok(!/process\.stdout\.write/.test(after),
        `${id}: no stdout emission may follow the final summary (it must be the last stdout line)`);
    }
  });

  it("the runners still exercise their full corridors (assert messages + stamp writes keep their pretty-printed diagnostics)", () => {
    // w4.27/w4.11: the corridor-incomplete assert message legitimately uses
    // JSON.stringify(arms, null, 2) on STDERR — untouched.
    for (const runnerPath of [CELLS["W4.27-shim-exit-matrix"], CELLS["W4.11-sigkill-launch-matrix"]]) {
      const source = fs.readFileSync(path.join(ttRoot, runnerPath), "utf8");
      assert.match(source, /JSON\.stringify\(arms,\s*null,\s*2\)/,
        `${runnerPath}: stderr corridor assert must keep its pretty-printed arms diagnostics`);
    }
    // w4.19/w4.34: the stamp-file writes legitimately use pretty-printed JSON
    // on DISK — untouched.
    const w419 = fs.readFileSync(path.join(ttRoot, CELLS["W4.19-stale-catalog-warn-not-block"]), "utf8");
    assert.match(w419, /writeFileSync\(stampPath,\s*`\$\{JSON\.stringify\(stale,\s*null,\s*2\)\}\\n`\)/,
      "W4.19 stamp injection must keep its pretty-printed file write");
    const w434 = fs.readFileSync(path.join(ttRoot, CELLS["W4.34-stale-cli-new-daemon"]), "utf8");
    assert.match(w434, /tt-source-identity\.json/,
      "W4.34 must still write the source-identity stamp file");
    assert.match(w434, /JSON\.stringify\(\{ ref: pumaRef, commit: pumaCommit, version: pumaVersion \},\s*null,\s*2\)/,
      "W4.34 source-identity stamp must keep its pretty-printed file write");
  });
});

// Find the offset just past `emission` within `source` (for the no-follow-on
// stdout check). The emission text is unique: it ends with the `})}\n`);`
// closing, and we search from the last marker occurrence.
function idxOfEndOf(emission: string, source: string): number {
  const idx = source.lastIndexOf(emission);
  assert.ok(idx >= 0, "summary emission not found in runner source");
  return idx + emission.length;
}
