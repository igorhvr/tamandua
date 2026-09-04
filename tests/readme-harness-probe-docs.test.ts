import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const readmePath = resolve(import.meta.dirname, "..", "README.md");
const readmeContent = readFileSync(readmePath, "utf-8");
// Phrase checks tolerate normal Markdown line-wrapping and blockquote
// prefixes: collapse any whitespace run (incl. newlines) to a single space
// and drop leading '>' blockquote markers, then search verbatim.
const flat = readmeContent
  .split("\n")
  .map((l) => l.replace(/^\s*>\s?/, ""))
  .join("\n")
  .replace(/\s+/g, " ");

function assertFlatPhrase(phrase: string, message: string): void {
  assert.ok(flat.includes(phrase), message);
}

describe("README launch-time harness probe documentation (IFLB)", () => {
  it("documents the probe runs at the run's first dispatch before any step is claimed", () => {
    assertFlatPhrase(
      "Launch-time harness probe",
      "README must contain a 'Launch-time harness probe' subsection"
    );
    assertFlatPhrase(
      "Before a run's first real work round — and before any step is claimed —",
      "README must state the probe runs before the first real round / before any step is claimed"
    );
  });

  it("documents the probe asks the harness to run <launcher> skill-path and reply with the PATH", () => {
    assertFlatPhrase(
      "run the exact command `<launcher> skill-path`",
      "README must document the probe command '<launcher> skill-path'"
    );
    assertFlatPhrase(
      "the same absolute CLI launcher path step prompts use, never a bare `tamandua`",
      "README must state the probe uses the same absolute CLI launcher as step prompts"
    );
    assertFlatPhrase(
      "and reply with the PATH",
      "README must state the harness replies with the PATH"
    );
  });

  it("documents the daemon computes the expected path itself", () => {
    assertFlatPhrase(
      "daemon computes the expected value itself by running the same command",
      "README must state the daemon computes the expected value itself"
    );
    assertFlatPhrase(
      "contains that path as a whole line or token",
      "README must state the pass rule: expected path as a whole line or token"
    );
    assertFlatPhrase(
      "whitespace trimmed, markdown code fences/backticks stripped",
      "README must state normalization: whitespace trimmed, code fences/backticks stripped"
    );
  });

  it("documents the cost: one tiny model turn per run, exactly once per run", () => {
    assertFlatPhrase(
      "The probe costs **one tiny model turn per run**",
      "README must document the probe's one-tiny-model-turn-per-run cost"
    );
    assertFlatPhrase(
      "and runs exactly once per run",
      "README must state the probe runs exactly once per run"
    );
  });

  it("documents the keyline failure block with every key and STDERR_TAIL last", () => {
    const keys = [
      "FAILURE_CLASS: harness_unavailable",
      "HARNESS: pi",
      "PROBE_CMD:",
      "EXPECTED:",
      "OBSERVED:",
      "EXIT_CODE:",
      "SIGNAL:",
      "DURATION_MS:",
      "STDERR_TAIL:",
    ];
    const blockStart = readmeContent.indexOf("```\nFAILURE_CLASS: harness_unavailable\n");
    assert.ok(blockStart >= 0, "README keyline block must open with a fence then FAILURE_CLASS first");
    const blockClose = readmeContent.indexOf("```", blockStart + 3);
    assert.ok(blockClose > blockStart, "README keyline block must be fenced");
    const block = readmeContent.slice(blockStart, blockClose);
    let prev = -1;
    for (const key of keys) {
      const at = block.indexOf(key, prev + 1);
      assert.ok(at > prev, `README keyline block must contain ${key} in order`);
      prev = at;
    }
    // STDERR_TAIL is the last key: the block's final non-empty line must be the STDERR_TAIL keyline.
    const nonEmptyLines = block
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    assert.ok(
      nonEmptyLines.length > 0 && nonEmptyLines[nonEmptyLines.length - 1].startsWith("STDERR_TAIL:"),
      "STDERR_TAIL must be the last keyline in the block"
    );
  });

  it("documents the failure surface: run force-failed, no step claimed, shown by status and run --wait", () => {
    assertFlatPhrase(
      "the run is force-failed immediately and legibly — no workflow step is claimed or started",
      "README must state the run is force-failed immediately with no step claimed on probe failure"
    );
    assertFlatPhrase(
      "shown verbatim by `tamandua workflow status` and `tamandua workflow run --wait`",
      "README must say the block is shown by workflow status and workflow run --wait"
    );
  });

  it("documents the 180 s default wall with TAMANDUA_HARNESS_PROBE_WALL_MS override", () => {
    assertFlatPhrase(
      "The probe's wall clock defaults to **180 seconds**",
      "README must document the 180-second default wall"
    );
    assertFlatPhrase(
      "(`TAMANDUA_HARNESS_PROBE_WALL_MS` overrides it)",
      "README must document the TAMANDUA_HARNESS_PROBE_WALL_MS override"
    );
  });

  it("documents the TAMANDUA_HARNESS_PROBE=0 escape hatch (default on)", () => {
    assertFlatPhrase(
      "Set `TAMANDUA_HARNESS_PROBE=0` to disable the probe entirely (escape hatch; the probe is on by default)",
      "README must document TAMANDUA_HARNESS_PROBE=0 disables the probe and that it is on by default"
    );
  });

  it("documents the fixed mid-run instant-fail relaunch policy (K and N defaults + horizon)", () => {
    assertFlatPhrase(
      "A harness that passes the launch-time probe but breaks MID-run is handled by the instant-fail relaunch policy (RSPN)",
      "README must state mid-run harness breakage is handled by the instant-fail relaunch policy"
    );
    assertFlatPhrase(
      "After **K** consecutive instant-fail rounds (default **K = 6**) the scheduler starts an escalating relaunch backoff",
      "README must explain K: consecutive instant-fail rounds at which the escalating relaunch backoff starts, default 6"
    );
    assertFlatPhrase(
      "After **N** consecutive instant-fail rounds (default **N = 20**) the run is force-failed with a precise reason",
      "README must explain N: consecutive instant-fail rounds at which the run is force-failed, default 20"
    );
    assertFlatPhrase(
      "six rounds on the 15 s tick, then 30 s / 60 s / 120 s backoffs up through the 20th round",
      "README must state the ~27-minute default horizon (six 15s-tick rounds then 30/60/120s backoffs to the 20th round)"
    );
    assertFlatPhrase(
      "about 27 minutes",
      "README must state the default escalation horizon is about 27 minutes"
    );
  });
});
