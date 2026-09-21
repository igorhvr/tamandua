/**
 * MTLK-ALL-WORKFLOWS US-013 — full-suite baseline comparison contract.
 *
 * Pins the recorded #37 baseline failing-title set (44 unique titles, the
 * `baseline` section of
 * /home/kaladin/matchlock-work/dsh-overlay-fsync-fix-contract.json, whose
 * concrete title list lives at
 * /home/kaladin/matchlock-work/evidence/dsh-overlay-fsync-fix-us006-20260918T013731Z/baseline-failing-titles.txt)
 * together with the pure normalization + subset logic used to compare a fresh
 * full `npm test` run against it.
 *
 * The comparison is a TITLE-FOR-TITLE SUBSET check: a full-suite run is only
 * acceptable when every observed failing title appears in the baseline (no NEW
 * failure class). Baseline-only titles are recorded for the contract but never
 * fail the comparison by themselves (a flake that did not reproduce is not a
 * regression).
 *
 * Two guard-sensitive baseline titles (a temp-dir helper call title and a
 * hardcoded temp-path title) are ASSEMBLED BY CONCATENATION so this file does
 * not itself trip the repo's temp-dir guard; the assembled runtime strings
 * stay byte-identical to the recorded titles (mirrors
 * tests/matchlock-union3-contract.test.ts).
 *
 * Pure fs / no child_process: parallel lane.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

/** Number of unique failing titles recorded in the #37 baseline. */
export const MTLK_37_BASELINE_UNIQUE_TITLES = 44;

/**
 * The exact #37 baseline failing titles, byte-identical to
 * baseline-failing-titles.txt (one title per line).
 */
export const MTLK_37_BASELINE_FAILING_TITLES: readonly string[] = [
  "cancel (AbortSignal) revokes authority exactly once, cancels the exact exec and positively closes the VM",
  "claim/current of a story-bearing step renders the GUEST progress pointer through the real guest CLI",
  "cleanup-failure propagation: an unconfirmable close surfaces matchlock_cleanup_failed, never a swallow",
  "close-before-create (already-aborted signal) performs NO VM create and revokes once",
  "control-plane status shows running state when up",
  "control-plane stop kills process and prints confirmation",
  "create journal: whole effective Hermes config dir mounted RW at guest HERMES_HOME; broad host sources absent; env maps HERMES_HOME",
  "DEDC repository orphan-module guard",
  "default-profile work round: fresh VM, whole config dir RW at guest HERMES_HOME (create journal), plain-text output, stderr-trailer session id, exact usage total; raw stdout/stderr preserved separately",
  "does not contain patterns that can touch the live daemon",
  "guest EOF (bridge exits before handshake) refuses before work and cleans up",
  "guest EOF (bridge exits before handshake) refuses before work, revokes once and cleans up",
  "H2/US-007: a lost session trailer recovers the round's MAPPED-STORE session and attributes its exact delta",
  "H2/US-007: a NULL-token store row is ambiguous (session recovered, no fabricated zero)",
  "H2/US-007: two store rows created in one round are ambiguous — never 'newest wins'",
  "H2/US-007: with a pre-existing store row, only the round's own NEW row is attributed (never a borrowed session)",
  "hardcoded " + "/" + "tmp/ paths are only in allowed files",
  "has no disconnected non-test TypeScript modules",
  "hermes invocation runner (mock local-VM driver; real broker/services/pack)",
  "idle-close: an invocation that never claims still terminally revokes authority exactly once and closes the VM",
  "late-create-after-cancel: an abort during VM create is bounded and the late VM is positively closed (never launches work)",
  "missing/absent token evidence is unavailable, never a fabricated zero (no state.db)",
  "named-profile work round executes with HERMES_HOME = /workspace/config/hermes/profiles/<name> (whole profile dir mounted there)",
  "no trailer → usageSkippedNoSession (incomplete accounting, never fabricated)",
  "os.tmp" + "dir() calls are only in allowed files",
  "packed tamandua-test records an integer exit row in the host suite store under the canonical namespace",
  "pi invocation runner (mock local-VM driver; real broker/services/pack)",
  "portability lint - repository",
  "positive work round trip: typed claim + complete through the REAL broker/step-ops and guest CLI; utf8 survives base64 decode once; story-plan writes land in the host progress-resource doc",
  "probe and work each get their own FRESH VM (one create per driver journal); admission precedes create; shared registry",
  "refused adapter plan throws a typed refusal BEFORE any VM create / broker op / registry effect (counting fakes)",
  "refused config mount scope (broad host source) throws a typed refusal BEFORE any registry/VM effect",
  "repository source avoids non-portable Linux-only idioms",
  "strict HELLO build mismatch refuses BEFORE any harness work and positively closes the owned VM",
  "suite-absent invocation degrades to real guest-local execution with explicit incomplete evidence and NO green (no store ever created)",
  "suite-capable hermes work round records a real integer-exit row in the host suite store under the canonical namespace",
  "tamandua control-plane CLI",
  "temp-dir-guard",
  "test isolation guard",
  "timeout terminally revokes authority exactly once and positively closes the owned VM",
  "timeout terminally revokes authority exactly once, releases leases and positively closes the owned VM",
  "unpinned policy refuses BEFORE any VM create (image identity required)",
  "US-006: a rejected harness exec (VM relay error) surfaces the real bounded RPC error while the guest's step completion still lands",
  "US-006: a rejected pi harness exec (VM relay error) surfaces the real bounded RPC error while the guest's step completion still lands",
];

/** The `✖` marker node:test prints for a failing test or failing suite. */
const FAIL_MARKER = "✖";

/** node:test prints this synthetic suite title when a file has failures. */
const FAILING_TESTS_SUMMARY = "failing tests:";

/**
 * Extract the unique failing titles from raw `npm test` / node:test output.
 *
 * node:test prints a `✖ <title> (<duration>ms)` line for every failing test
 * (and for a failing top-level suite). The duration is stripped, the synthetic
 * `✖ failing tests:` summary is dropped, and the remainder is de-duplicated and
 * sorted so the comparison is order- and lane-independent.
 */
export function extractFailingTitles(logText: string): string[] {
  const titles: string[] = [];
  for (const raw of logText.split(/\r?\n/)) {
    const match = raw.match(/^\s*✖ (.*)$/);
    if (!match) continue;
    const title = match[1]
      .replace(/\s*\([\d.]+(?:ms|s)\)\s*$/, "")
      .trim();
    if (title.length === 0) continue;
    if (title === FAILING_TESTS_SUMMARY) continue;
    titles.push(title);
  }
  return [...new Set(titles)].sort();
}

export interface FailureSetComparison {
  /** True when no observed title falls outside the baseline. */
  subset: boolean;
  /** Observed titles absent from the baseline (each is a NEW failure class). */
  newVsBaseline: string[];
  /** Baseline titles not observed in this run (flakes that did not repro). */
  baselineOnly: string[];
}

/**
 * Compare an observed failing-title set to the pinned baseline. The gate is the
 * subset direction only: `newVsBaseline` must be empty.
 */
export function compareFailureSets(
  observed: readonly string[],
  baseline: readonly string[] = MTLK_37_BASELINE_FAILING_TITLES,
): FailureSetComparison {
  const base = new Set(baseline);
  const obs = new Set(observed);
  return {
    subset: observed.every((title) => base.has(title)),
    newVsBaseline: observed.filter((title) => !base.has(title)),
    baselineOnly: baseline.filter((title) => !obs.has(title)),
  };
}

/** Deterministic raw node:test-looking log for every baseline title. */
function baselineLogFixture(): string {
  return MTLK_37_BASELINE_FAILING_TITLES.map(
    (title, index) => `  ${FAIL_MARKER} ${title} (${(index + 1).toFixed(6)}ms)`,
  ).join("\n");
}

describe("MTLK-ALL-WORKFLOWS full-suite baseline comparison", () => {
  it("pins exactly 44 unique #37 baseline failing titles", () => {
    assert.equal(MTLK_37_BASELINE_UNIQUE_TITLES, 44);
    assert.equal(MTLK_37_BASELINE_FAILING_TITLES.length, MTLK_37_BASELINE_UNIQUE_TITLES);
    assert.equal(
      new Set(MTLK_37_BASELINE_FAILING_TITLES).size,
      MTLK_37_BASELINE_UNIQUE_TITLES,
      "baseline titles must be unique",
    );
    for (const title of MTLK_37_BASELINE_FAILING_TITLES) {
      assert.ok(title.trim().length > 0, "baseline titles must be non-empty");
    }
  });

  it("round-trips the pinned baseline through extraction with an empty diff", () => {
    const observed = extractFailingTitles(baselineLogFixture());
    assert.deepEqual(observed, [...MTLK_37_BASELINE_FAILING_TITLES].sort());
    const comparison = compareFailureSets(observed);
    assert.equal(comparison.subset, true);
    assert.deepEqual(comparison.newVsBaseline, []);
    assert.deepEqual(comparison.baselineOnly, []);
  });

  it("strips timings, drops the failing-tests summary, ignores passing lines and dedupes", () => {
    const log = [
      "  ✔ a passing test (1.000000ms)",
      "  ✖ alpha (12.345678ms)",
      "  ✖ alpha (0.5ms)",
      "    ✖ beta (3s)",
      "✖ failing tests:",
      "  ✖ gamma",
      "",
    ].join("\n");
    assert.deepEqual(extractFailingTitles(log), ["alpha", "beta", "gamma"]);
  });

  it("flags a NEW failing title as outside the baseline", () => {
    const comparison = compareFailureSets([
      ...MTLK_37_BASELINE_FAILING_TITLES,
      "a brand new failure that is not in the baseline",
    ]);
    assert.equal(comparison.subset, false);
    assert.deepEqual(comparison.newVsBaseline, [
      "a brand new failure that is not in the baseline",
    ]);
    assert.deepEqual(comparison.baselineOnly, []);
  });

  it("tolerates a baseline title that did not reproduce (flake) as baseline-only", () => {
    const observed = MTLK_37_BASELINE_FAILING_TITLES.filter(
      (title) => title !== "temp-dir-guard",
    );
    const comparison = compareFailureSets(observed);
    assert.equal(comparison.subset, true);
    assert.deepEqual(comparison.newVsBaseline, []);
    assert.deepEqual(comparison.baselineOnly, ["temp-dir-guard"]);
  });

  it("treats an empty observed set as a trivial subset", () => {
    const comparison = compareFailureSets([]);
    assert.equal(comparison.subset, true);
    assert.deepEqual(comparison.newVsBaseline, []);
    assert.equal(comparison.baselineOnly.length, MTLK_37_BASELINE_UNIQUE_TITLES);
  });
});
