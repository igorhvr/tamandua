// US-009 (T2.1) — the W4.42/W4.43/W4.44a/W4.44b shared-scripted-daemon
// bootstrap failure: a CONCURRENT campaign in another worktree SIGTERM'd
// this worktree's freshly-started daemon scope.
//
// Campaign evidence (operator run on merged main): the four cells each
// exited 1 in ~1.3s with `run-scripted-scenario: daemon-control scripted
// start failed` and a `Terminated systemd-run --user --scope --unit=...`
// line, running immediately after the W4.40 x4 / W4.41 x2 infra-failed
// cells. The systemd user journal in the failure window (local
// 21:10:04-21:10:10 = UTC 00:10:04-00:10:10) shows the root cause: worktree
// 862-c9ab2422's tier0 campaign (campaign-20260816T230030765Z) was starting
// cells every few hundred ms (w4.35-failed-rebased-true-missing at
// 00:10:05.890Z, w4.35-failed-rebased-true-red at 00:10:07.251Z,
// w4.35-missing-status-rebased-absent-green at 00:10:08.613Z,
// w4.35-missing-status-rebased-absent-missing at 00:10:09.987Z), and each
// daemon-control cmd_start clean-slate ran
// `systemctl --user stop tamandua-tt-scripted.scope` against the OLD FIXED
// per-user unit name — SIGTERM'ing WHATEVER daemon owned that scope,
// including the operator campaign's just-created scope (journal: main's
// scopes lived 146-533ms, consumed 87-148M memory, no daemon log entries).
//
// Fix (confined to torture-test/):
//  1. bin/daemon-control derives a PER-WORKTREE systemd scope unit name
//     (tamandua-tt-<kind>-<8hex of the repo root>) so no other worktree can
//     stop or collide with this worktree's daemon scope.
//  2. bin/daemon-control waits (bounded, TT_DAEMON_PORT_WAIT_SECONDS,
//     default 180) for the kind's FIXED ports to free before launching, so
//     concurrent worktrees serialize on the shared ports instead of failing
//     the bootstrap with EADDRINUSE, and fails with a clear diagnostic when
//     the bound is exceeded.
//  3. bin/daemon-control clears a STALE tamandua.pid (dead pid) left by a
//     killed daemon so the pid wait starts fresh.
//  4. the four cells' run.sh exec their runner from the PARENT scenario dir
//     (`$scenario_dir/../run-*.mjs` — the runner files live beside the cell
//     dir), fixing the MODULE_NOT_FOUND that surfaced once the bootstrap
//     stopped failing.
//
// This test pins (zero tokens, no daemon, hermetic):
//  - the daemon-control fix shapes (AC4: no assertion weakened — these are
//    shared-bootstrap fixes, the runner assertions are untouched),
//  - the stability + worktree-distinctness of the scope-suffix derivation,
//  - the four cells' run.sh runner-path wiring (AC2: the cells must be able
//    to start once the bootstrap succeeds).
// The behavioral greens (busy-port refusal arm, stale-pid cleanup, per-
// worktree provenance scopeUnit) live in bin/daemon-control.test.sh, and the
// full corridor greens (each cell from a clean var + campaign order) are
// driven by the campaign battery / US-010 re-proof.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");

function readSource(rel: string): string {
  return fs.readFileSync(path.join(ttRoot, rel), "utf8");
}

// The derivation daemon-control uses is a CRC32-style checksum of the repo
// root formatted as 8 lowercase hex chars (its `cksum | awk '{printf
// "%08x", $1}'`). This hermetic reimplementation pins the SHAPE — exactly 8
// lowercase hex, deterministic per repo root, distinct across worktrees —
// without depending on the `cksum` binary in the test process. (The exact
// unit name is cross-checked behaviorally in bin/daemon-control.test.sh,
// which mirrors daemon-control's own cksum invocation.)
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32Hex8(input: string): string {
  let crc = 0xffffffff;
  for (let i = 0; i < input.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ input.charCodeAt(i)) & 0xff] ^ (crc >>> 8);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

function scopeSuffixFor(repoRootPath: string): string {
  return crc32Hex8(repoRootPath);
}

const CELL_RUNSH = [
  ["scenarios/w4.42/shared-workdir-refusal/run.sh", "../run-shared-workdir.mjs"],
  ["scenarios/w4.43/refusal-storm/run.sh", "../run-refusal-storm.mjs"],
  ["scenarios/w4.44/double-tap/run.sh", "../run-double-tap.mjs"],
  ["scenarios/w4.44/post-success-immunity/run.sh", "../run-post-success-immunity.mjs"],
] as const;

describe("tier2 cross-worktree scope isolation (US-009)", () => {
  it("daemon-control derives a per-worktree systemd scope unit name", () => {
    const source = readSource("bin/daemon-control");
    const cmdStart = source.slice(source.indexOf("cmd_start()"));
    assert.match(cmdStart, /scope_unit="tamandua-tt-\$name-\$scope_suffix"/,
      "cmd_start must derive the scope unit from the per-worktree suffix");
    assert.match(cmdStart, /cksum/,
      "cmd_start must derive the suffix from the repo root via cksum");
    assert.doesNotMatch(cmdStart, /scope_unit="tamandua-tt-\$name"/,
      "cmd_start must NOT fall back to the old fixed per-user unit name");
    assert.match(cmdStart, /US-009/,
      "cmd_start must document the cross-worktree isolation fix (US-009)");
  });

  it("scope suffix derivation is stable and distinct across worktrees", () => {
    const a = scopeSuffixFor("/home/igorhvr/idm/tamandua");
    const b = scopeSuffixFor("/home/igorhvr/idm/tamandua");
    const c = scopeSuffixFor("/home/igorhvr/.tamandua/worktrees/tamandua-73d5fbc9/865-8a2347b6");
    assert.equal(a, b, "the suffix must be deterministic for the same repo root");
    assert.match(a, /^[0-9a-f]{8}$/, "the suffix must be exactly 8 lowercase hex chars");
    assert.notEqual(a, c, "two different worktrees must derive different scope units");
    assert.match(`tamandua-tt-scripted-${a}`, /^tamandua-tt-scripted-[0-9a-f]{8}$/,
      "the full unit name must be a valid systemd scope unit name");
  });

  it("daemon-control waits (bounded) for the fixed ports to free before launch", () => {
    const source = readSource("bin/daemon-control");
    const cmdStart = source.slice(source.indexOf("cmd_start()"));
    assert.match(cmdStart, /TT_DAEMON_PORT_WAIT_SECONDS/,
      "cmd_start must support the port-wait bound override");
    assert.match(cmdStart, /refusing to launch into a busy port/,
      "cmd_start must fail with a clear diagnostic when the bound is exceeded");
    // The wait must precede the launch (systemd-run / nohup) and follow the
    // clean-slate scope teardown.
    const waitIdx = cmdStart.indexOf("TT_DAEMON_PORT_WAIT_SECONDS");
    const launchIdx = cmdStart.indexOf('systemd-run --user --scope --unit=');
    assert.ok(waitIdx >= 0 && launchIdx > waitIdx,
      "the port-free wait must precede the launch");
  });

  it("daemon-control clears a stale tamandua.pid left by a killed daemon", () => {
    const source = readSource("bin/daemon-control");
    const cmdStart = source.slice(source.indexOf("cmd_start()"));
    assert.match(cmdStart, /STALE tamandua\.pid/,
      "cmd_start must document the stale-pid-file cleanup");
    assert.match(cmdStart, /rm -f -- "\$daemon_pid_file"/,
      "cmd_start must remove the stale pid file before waiting for the new daemon's pid");
  });

  it("the four cells' run.sh exec the runner from the parent scenario dir", () => {
    for (const [runShRel, expectedRunnerRef] of CELL_RUNSH) {
      const runSh = readSource(runShRel);
      assert.match(runSh, new RegExp(`exec node "\\$scenario_dir/${expectedRunnerRef.replaceAll(".", "\\.")}"`),
        `${runShRel} must exec the runner from the parent scenario dir`);
      // The referenced runner must actually exist next to the cell dir.
      const runnerRel = path.join(
        path.dirname(runShRel), "..", expectedRunnerRef.replace(/^\.\.\//, ""),
      );
      assert.ok(fs.existsSync(path.join(ttRoot, runnerRel)),
        `the runner referenced by ${runShRel} must exist at ${runnerRel}`);
    }
  });

  it("the four runners still emit the canonical single-line PASS summary", () => {
    // The run.sh path fix must not have touched the runners' summary
    // emission: each runner must still end with a single-line JSON
    // JSON.stringify carrying result "PASS" (the controller's local-case
    // mechanical check). Reuses the tier2-single-line-summary pin shape.
    const runners = [
      "scenarios/w4.42/run-shared-workdir.mjs",
      "scenarios/w4.43/run-refusal-storm.mjs",
      "scenarios/w4.44/run-double-tap.mjs",
      "scenarios/w4.44/run-post-success-immunity.mjs",
    ] as const;
    for (const runner of runners) {
      const source = readSource(runner);
      const summaryIdx = source.lastIndexOf('process.stdout.write(`${JSON.stringify({');
      assert.ok(summaryIdx >= 0, `${runner} must emit its summary via a single-line JSON.stringify`);
      const summaryBlock = source.slice(summaryIdx);
      assert.match(summaryBlock, /result: "PASS"/,
        `${runner} summary must carry result "PASS"`);
      assert.doesNotMatch(summaryBlock, /JSON\.stringify\([^)]*,\s*null,\s*2\)/,
        `${runner} summary must NOT use the multi-line pretty-print form`);
    }
  });
});
