/**
 * MTLK-INTERACTIVE-SUITE US-010 — sequential manifest-aware runner wiring.
 *
 * `scripts/tests/matchlock/runner/run-cases.sh` is the suite's sequential tier
 * driver, ported from the ACCEPTED W2 toolset `tools/run-cases.sh` (v3). It
 * records the REQUESTED manifest BEFORE anything executes, runs the frozen PTY
 * driver self-test before any VM case, runs `run-case.sh` then `hygiene.sh` per
 * requested case, HALTs on the first failing component, and writes the
 * phase-done marker only when every requested case passed.
 *
 * This file pins those wiring invariants statically (the runtime behavior is
 * covered by the tier fixtures / the real gate):
 *
 *   - the manifest is recorded (via `lib/manifest.sh`) before the first case;
 *   - the pty self-test runs before any VM case and before the gate lock;
 *   - each case runs `run-case.sh` and then `hygiene.sh`, exit codes captured
 *     directly (no pipeline masking);
 *   - the first nonzero component writes `matrix/HALTED` and stops the run;
 *   - the phase-done marker is guarded on "no HALTED" and appears exactly once;
 *   - unrequested tiers stay UNEXECUTED (the runner only requests the passed
 *     tiers and only reads back rows with `requested == 1`);
 *   - the gate lock is acquired at one layer only, via `lib/lock.sh`, and is
 *     released before the T4 M7 spot-run (which acquires it itself).
 *
 * Pure filesystem reads (no child_process, no dist import, no daemon, no VM, no
 * model, no network), so this file stays in the parallel lane and needs no
 * tests/serial-files.txt entry.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const runnerPath = path.join(repoRoot, "scripts", "tests", "matchlock", "runner", "run-cases.sh");
const manifestPath = path.join(repoRoot, "scripts", "tests", "matchlock", "lib", "manifest.sh");

function readRunner(): string {
  assert.ok(existsSync(runnerPath), `missing runner ${runnerPath}`);
  assert.ok(statSync(runnerPath).isFile(), "run-cases.sh is not a regular file");
  return readFileSync(runnerPath, "utf-8");
}

/** Extract a top-level `name() { ... }` function body from shell source. */
function functionBody(text: string, name: string): string {
  const marker = `\n${name}() {`;
  const start = text.indexOf(marker);
  assert.ok(start >= 0, `run-cases.sh must define ${name}()`);
  const lines = text.slice(start + 1).split("\n");
  const body: string[] = [];
  for (const line of lines) {
    body.push(line);
    if (body.length > 1 && line === "}") break;
  }
  assert.equal(body[body.length - 1], "}", `could not find the end of ${name}()`);
  return body.join("\n");
}

describe("Matchlock interactive runner wiring (MTLK-INTERACTIVE-SUITE US-010)", () => {
  it("ships the driver wired to the shared suite modules and components", () => {
    const text = readRunner();
    for (const needle of [
      "lib/common.sh",
      "lib/manifest.sh",
      "lib/lock.sh",
      "run-case.sh",
      "hygiene.sh",
      "pty-selftest.sh",
      "m7-spot-run.sh",
      "mtlk_resolve_runtime",
      "mtlk_require_digest",
      "mtlk_resolve_mode",
      "mtlk_probe_capabilities",
      "mtlk_gate_lock_acquire",
      "mtlk_gate_lock_release",
    ]) {
      assert.ok(text.includes(needle), `run-cases.sh must reference ${needle}`);
    }
    // The lock is owned by lib/lock.sh; the driver must never take it raw.
    assert.doesNotMatch(text, /\bflock\b/, "the driver must not call flock directly");
  });

  it("records the requested manifest before any case executes", () => {
    const text = readRunner();
    const main = functionBody(text, "main");
    const iPrepare = main.indexOf("mtlk_prepare");
    const iRecord = main.indexOf("mtlk_record_requested_manifest");
    const iRun = main.indexOf("mtlk_run_requested_tiers");
    const iFinish = main.indexOf("mtlk_finish");
    assert.ok(iPrepare >= 0, "main must run mtlk_prepare");
    assert.ok(iRecord >= 0, "main must record the requested manifest");
    assert.ok(iRun >= 0, "main must run the requested tiers");
    assert.ok(iFinish >= 0, "main must finish (finalize + phase-done)");
    assert.ok(iRecord < iRun, "the manifest must be recorded before the tiers run");
    assert.ok(iRun < iFinish, "finalization must happen after execution");

    const record = functionBody(text, "mtlk_record_requested_manifest");
    for (const api of [
      "mtlk_manifest_init",
      "mtlk_manifest_request_tier",
      "mtlk_manifest_add_case",
      "mtlk_manifest_freeze",
    ]) {
      assert.ok(record.includes(api), `the manifest recording must use ${api}`);
    }
    assert.ok(
      record.indexOf("mtlk_manifest_init") < record.indexOf("mtlk_manifest_freeze"),
      "the manifest must be initialized before it is frozen",
    );
  });

  it("runs the frozen PTY self-test before any VM case", () => {
    const text = readRunner();
    const tiers = functionBody(text, "mtlk_run_requested_tiers");
    const iSelf = tiers.indexOf("mtlk_run_pty_selftest");
    const iLock = tiers.indexOf("mtlk_gate_lock_acquire");
    const iVmTier = tiers.indexOf("mtlk_run_manifest_tier");
    const iM7 = tiers.indexOf("mtlk_run_m7");
    assert.ok(iSelf >= 0, "the driver must run the pty self-test");
    assert.ok(iLock >= 0, "the driver must acquire the gate lock for VM cases");
    assert.ok(iSelf < iLock, "the self-test must run before the lock is taken");
    assert.ok(iSelf < iVmTier, "the self-test must run before any VM case");
    assert.ok(iLock < iVmTier, "VM cases run under the lock");
    assert.ok(iM7 >= 0, "the driver must run the T4 M7 spot-run");
    const iRelease = tiers.indexOf("mtlk_gate_lock_release");
    assert.ok(iRelease >= 0, "the driver must release the gate lock");
    assert.ok(
      iRelease < iM7,
      "the lock must be released before M7 (which acquires it at its own layer)",
    );

    const selfTest = functionBody(text, "mtlk_run_pty_selftest");
    assert.match(selfTest, /bash "\$SELFTEST"/, "the self-test is actually spawned");
    assert.match(selfTest, /rc=\$\?/, "the self-test exit code is captured directly");
  });

  it("runs run-case.sh then hygiene.sh per requested case and halts on the first failure", () => {
    const text = readRunner();
    const oneCase = functionBody(text, "mtlk_run_one_case");
    const iRun = oneCase.indexOf('bash "$RUN_CASE"');
    const iHyg = oneCase.indexOf('bash "$HYGIENE"');
    assert.ok(iRun >= 0, "each case must run run-case.sh");
    assert.ok(iHyg >= 0, "each case must run hygiene.sh");
    assert.ok(iRun < iHyg, "hygiene runs after the case wrapper, never instead of it");
    // Component exit codes are captured directly: no pipeline may sit between
    // the component and its `rc=$?` / `hy=$?`.
    assert.match(
      oneCase,
      /bash "\$RUN_CASE" "\$casejson" "\$out" "\$ML" >"\$rlog" 2>&1\n\s*rc=\$\?/,
      "the run-case exit code must not be masked by a pipeline",
    );
    assert.match(
      oneCase,
      /bash "\$HYGIENE" "\$out\/case-summary\.json" "\$ML" >"\$hlog" 2>&1\n\s*hy=\$\?/,
      "the hygiene exit code must not be masked by a pipeline",
    );
    assert.doesNotMatch(oneCase, /bash "\$RUN_CASE"[^\n]*\|/, "no pipeline may mask the case rc");
    assert.doesNotMatch(oneCase, /bash "\$HYGIENE"[^\n]*\|/, "no pipeline may mask the hygiene rc");
    // First failure halts: HALTED is written and the caller returns.
    const halt = functionBody(text, "mtlk_halt");
    assert.match(halt, />"\$MTX\/HALTED"/, "the first failure must write matrix/HALTED");
    assert.match(halt, /MATRIX-HALT/, "the halt must be visible in the matrix log");
    assert.match(oneCase, /mtlk_halt "\$name" "\$rc" "\$hy"/);
    assert.match(oneCase, /return 1/);

    const tier = functionBody(text, "mtlk_run_manifest_tier");
    assert.ok(tier.includes("mtlk_run_one_case"), "the tier loop must call the per-case wrapper");
    assert.match(tier, /mtlk_run_one_case "\$tier" "\$name" "\$evidence" \|\| return 1/);
  });

  it("writes the phase-done marker only when every requested case passed", () => {
    const text = readRunner();
    const occurrences = text.match(/MATRIX-PHASE-DONE/g) ?? [];
    assert.equal(occurrences.length, 1, "the phase-done marker must be written in exactly one place");
    const finish = functionBody(text, "mtlk_finish");
    assert.match(
      finish,
      /\[ "\$rc" = 0 \] && \[ ! -f "\$MTX\/HALTED" \][\s\S]*MATRIX-PHASE-DONE/,
      "the phase-done marker must be guarded on a zero rc and no HALTED marker",
    );
    assert.ok(finish.includes("mtlk_manifest_finalize"), "finish must finalize the manifest");
  });

  it("reads the requested cases from the frozen manifest and leaves unrequested tiers UNEXECUTED", () => {
    const text = readRunner();
    // Cases are read back from the frozen manifest, filtered on requested == 1.
    assert.ok(text.includes("mtlk_manifest_file"), "the driver must read the recorded manifest");
    assert.ok(text.includes('$1 == "case"'), "the driver must iterate case rows");
    assert.ok(text.includes('$4 == "1"'), "only REQUESTED rows may execute");
    // Only the passed tiers are requested; every other tier keeps its recorded
    // default (UNEXECUTED) from lib/manifest.sh.
    const record = functionBody(text, "mtlk_record_requested_manifest");
    assert.match(record, /for tier in \$REQUESTED_TIERS/);
    assert.match(record, /mtlk_manifest_request_tier "\$ev" "\$tier"/);
    const manifest = readFileSync(manifestPath, "utf-8");
    assert.match(
      manifest,
      /printf 'tier\\t%s\\t-\\t0\\t%s\\t-\\tUNEXECUTED\\n'/,
      "an unrequested tier must default to UNEXECUTED in the manifest",
    );
    // T3 absent credentials is a declared NOTRUN, never a silent PASS.
    assert.ok(text.includes("mtlk_t3_ready"), "the driver must gate T3 on credentials");
    assert.match(text, /mtlk_manifest_mark "\$EV" t3 - NOTRUN/, "an optional not-ready T3 is NOTRUN");
  });

  it("cannot silently skip a requested case: a missing case JSON fails and halts", () => {
    const text = readRunner();
    const oneCase = functionBody(text, "mtlk_run_one_case");
    assert.match(oneCase, /MATRIX-CASE-MISSING/);
    assert.match(oneCase, /mtlk_manifest_mark "\$EV" "\$tier" "\$name" FAIL/);
    assert.doesNotMatch(oneCase, /continue\b/, "a requested case must not be silently skipped");
  });

  it("stays backend-agnostic and free of host literals", () => {
    const text = readRunner();
    assert.doesNotMatch(text, /\b(?:firecracker|qemu)\b/i, "no backend name may appear in the runner");
    for (const literal of ["/home/", "/Users/", "li155-matrix", "/opt/tamandua"]) {
      assert.ok(!text.includes(literal), `run-cases.sh must not contain the host literal ${literal}`);
    }
    assert.doesNotMatch(text, /\b[0-9a-f]{64}\b/i, "the digest must be a runner input, not a literal");
  });
});
