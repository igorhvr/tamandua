/**
 * MTLK-INTERACTIVE-SUITE US-014 — acceptance execution contract.
 *
 * Pins the committed record of the US-014 acceptance run and the minimal
 * FUNCTION fixes that run required (never an assertion weakening):
 *
 *   - `PORT-REPORT.md` §7 carries a US-014 acceptance-execution record with the
 *     requested-vs-observed matrix, the exact environment blockers per tier
 *     (`TUNSETIFF: operation not permitted`, the declared T3 NOTRUN), the
 *     fixture-level negative controls captured red, and the operator's
 *     outside-sandbox re-run command under the shared gate lock;
 *   - the entrypoint seeds the private HOME's `~/.pi/agent`, defaults the
 *     evidence root OUTSIDE the protected guest roots (`/tmp`, `/var`) and
 *     excludes matchlock's `vm-00000000` placeholder from the observed-rounds
 *     evidence;
 *   - CANDIDATE binds the executable `<repo>/dist/cli/cli.js` as the case
 *     `argv[0]` (the frozen driver execs `argv[0]` directly);
 *   - `run-cases.sh` passes the M7 repo argument only in CANDIDATE mode, and
 *     `m7-spot-run.sh` records the matchlock binary sha in `M7-IDENTITY`.
 *
 * Pure filesystem reads (no child_process, no dist import, no daemon, no VM, no
 * network), so this file stays in the parallel lane and needs no
 * `tests/serial-files.txt` entry.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const suiteDir = resolve(repoRoot, "scripts", "tests", "matchlock");

function read(rel: string): string {
  return readFileSync(resolve(suiteDir, rel), "utf-8");
}

const report = read("PORT-REPORT.md");
const entrypoint = read("run-interactive-suite.sh");
const common = read("lib/common.sh");
const runCases = read("runner/run-cases.sh");
const m7 = read("runner/m7-spot-run.sh");

/** Extract a `## <heading>` section body up to the next top-level `## `. */
function sectionBody(heading: string): string {
  const start = report.indexOf(heading);
  assert.ok(start >= 0, `PORT-REPORT.md must carry the heading ${heading}`);
  const rest = report.slice(start);
  const next = rest.search(/\n## /);
  return next >= 0 ? rest.slice(0, next) : rest;
}

describe("Matchlock interactive acceptance execution (MTLK-INTERACTIVE-SUITE US-014)", () => {
  it("records the US-014 acceptance execution in the requested-vs-observed matrix", () => {
    const matrix = sectionBody("## 7. Requested vs observed tier matrix");
    assert.match(matrix, /US-014 acceptance execution/);
    for (const tier of ["`t1`", "`t2`", "`t3`", "`t4`"]) {
      assert.ok(matrix.includes(tier), `acceptance matrix must cover tier ${tier}`);
    }
    assert.match(matrix, /T1 FIXTURES RESULT: pass=142 fail=0/);
    assert.match(matrix, /NOT-RUN \/ ENVIRONMENT/);
    assert.match(matrix, /NOT-RUN \(declared\)/);
  });

  it("names the exact environment blockers, never a fabricated pass", () => {
    const matrix = sectionBody("## 7. Requested vs observed tier matrix");
    assert.match(matrix, /TUNSETIFF: operation not permitted/);
    assert.match(matrix, /t3-disabled:MTLK_T3_ENABLED-not-set/);
    assert.match(matrix, /reconcile nftables rule: netlink receive: operation not permitted/);
    assert.match(matrix, /rm_failed=1/);
    assert.match(matrix, /NoNewPrivs: 1` \/ `CapEff: 0/);
  });

  it("records the fixture-level negative controls captured red", () => {
    const matrix = sectionBody("## 7. Requested vs observed tier matrix");
    assert.match(matrix, /Fixture-level negative controls \(captured red\)/);
    for (const label of [
      "refused_before_launch",
      'mount_write_through: "missing"',
      'mount_write_through: "bad-content"',
      "unowned-new-vm:vm-aaaaaaaa",
      "VALIDATION-FAIL missing-case-summary:M3",
      "identity-digest",
      "m7-binding-missing",
    ]) {
      assert.ok(matrix.includes(label), `negative-control record must name ${label}`);
    }
    for (const log of [
      "scratch/run-case/s1.log",
      "scratch/run-case/s4.log",
      "scratch/run-case/s4b.log",
      "scratch/run-case/s19.log",
      "scratch/validator/n1.log",
    ]) {
      assert.ok(matrix.includes(log), `negative-control record must name the log ${log}`);
    }
  });

  it("names the operator's outside-sandbox re-run command under the shared gate lock", () => {
    const matrix = sectionBody("## 7. Requested vs observed tier matrix");
    assert.match(matrix, /flock --exclusive -w 3600 \/home\/kaladin\/matchlock-work\/vaivm-gate\.lock/);
    assert.match(matrix, /run-interactive-suite\.sh --tier t2 --tier t3 --tier t4/);
    assert.match(matrix, /--expect-digest sha256:145fe73e/);
  });

  it("seeds the private HOME's pi configuration directory", () => {
    assert.ok(entrypoint.includes("mtlk_pi_agent_seed"), "the pi seed helper must exist");
    assert.ok(entrypoint.includes(".pi/agent"), "the pi configuration directory must be bound");
  });

  it("defaults the evidence root outside the protected guest roots", () => {
    assert.ok(entrypoint.includes("MTLK_EVIDENCE_ROOT"), "the evidence root must be configurable");
    assert.match(
      entrypoint,
      /mktemp -d "\$MTLK_EVIDENCE_ROOT\/mtlk\.XXXXXX"/,
      "the default evidence dir must be created under the configurable non-protected root",
    );
    assert.match(
      entrypoint,
      /MTLK_EVIDENCE_ROOT="\$\{MTLK_EVIDENCE_ROOT:-\$MTLK_OPERATOR_HOME\/\.cache\/tamandua-mtlk\}"/,
      "the default root must live under the operator HOME cache",
    );
  });

  it("excludes matchlock's placeholder id from the observed-rounds evidence", () => {
    assert.ok(entrypoint.includes("vm-00000000"), "the placeholder sentinel must be excluded");
    assert.match(entrypoint, /SENTINEL_IDS/);
  });

  it("binds CANDIDATE argv[0] to the executable worktree cli.js", () => {
    assert.match(
      common,
      /MTLK_TAMANDUA_ARGV0="\$MTLK_TAMANDUA_BIN"/,
      "CANDIDATE must exec the built cli.js directly as argv[0]",
    );
  });

  it("passes the M7 repo argument only in CANDIDATE mode", () => {
    const iM7 = runCases.indexOf("mtlk_run_m7()");
    assert.ok(iM7 >= 0, "run-cases.sh must define mtlk_run_m7()");
    const body = runCases.slice(iM7, runCases.indexOf("\nmtlk_run_requested_tiers", iM7));
    assert.match(body, /MTLK_MODE[\s\S]*candidate/);
    assert.match(body, /else[\s\S]*M7_RUNNER" "\$EV"/);
  });

  it("records the matchlock sha in the M7 provenance identity", () => {
    assert.match(m7, /MTLK_MATCHLOCK_SHA/);
    assert.match(m7, /M7-IDENTITY tamandua_sha=.*matchlock_sha=/);
  });
});
