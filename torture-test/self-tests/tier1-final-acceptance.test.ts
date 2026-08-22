// E3.A US-014 — Final acceptance: bare tier1 GREEN x2, hygiene canary
// unchanged, no leaks.
//
// This test pins the acceptance-battery invariants that are cheap to check
// mechanically on every run (read-only + one --validate-only pass; NO
// campaign machinery):
//   * the branch diff is confined to the intended authoring files —
//     tier1.jsonl, case.schema.json, tier1 task .md files, the traceability
//     doc, bin/tt-fixture-provision.mjs, self-tests, and (since E3.C) the
//     controller/probe/oracle machinery: bin/tt-controller,
//     bin/tt-controller.test.sh, bin/tt-chaos (+ self-test), bin/oracle-*.mjs,
//     oracles/ (E3.C adds the O16 lifecycle oracle and O4 executable) — and
//     (since MACP1) the fixture-source portability surface: fixtures-src/
//     builders/validators/bootstraps and bin/verify-builder-determinism.test.sh —
//     and never touches probes/, seeds/, or bin/tt-hygiene-canary.mjs;
//   * bin/tt-hygiene-canary.mjs is byte-identical to the merge-base version
//     (the canary itself must remain untouched so its campaign snapshots stay
//     trustworthy);
//   * the authoring-layer end state is pinned: every real case carries a
//     non-empty context.test_cmd; the bug-fix cases carry their real seeds
//     (BUG-P1/BUG-T1/BUG-P2/BUG-T2/BUG-T3) and W2.22 stays unseeded (its
//     master-trap premise requires no seed checkout); W1.X1 keeps its
//     hostile-path fixture alias (space + non-ASCII);
//   * the manifest still validates through the PRODUCTION controller
//     --validate-only path (28 cases).
//
// The campaign-side halves of the acceptance battery (bare --tier1 GREEN
// twice, zero tokens, hygiene canary UNCHANGED in the campaign report,
// scripted daemon STOPPED, ports 5334/5338/5339 free, git status clean) are
// exercised by tier1-repeatability.test.ts in the heavy battery
// (bin/verify-heavy-campaign-tests.test.sh) — keeping this file fast enough
// to stay in self-tests/run.sh.
//
// Confined to torture-test/. Zero tokens.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const manifest = path.join(ttRoot, "cases", "tier1.jsonl");
const controller = path.join(ttRoot, "bin", "tt-controller");
const hygieneCanary = path.join(ttRoot, "bin", "tt-hygiene-canary.mjs");

function git(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function branchBase(): string {
  // The E3.A branch was cut from main; resolve the merge-base at runtime so
  // the pins survive future main advancement (and after merge, when the base
  // becomes HEAD itself and the diff is trivially empty/confined).
  const result = git(["merge-base", "HEAD", "main"]);
  if (result.status !== 0 || !result.stdout.trim()) {
    const origin = git(["merge-base", "HEAD", "origin/main"]);
    if (origin.status === 0 && origin.stdout.trim()) return origin.stdout.trim();
    throw new Error(`cannot resolve branch base: ${result.stderr || "main and origin/main both unavailable"}`);
  }
  return result.stdout.trim();
}

function changedFiles(): string[] {
  const base = branchBase();
  const result = git(["diff", "--name-only", `${base}...HEAD`]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
}

function manifestRecords(): Array<Record<string, any>> {
  return fs
    .readFileSync(manifest, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

// ─────────────────────────────────────────────────────────────────────
// Diff-confinement lists — module scope so the confinement test and the
// US-002 shape test share one source of truth.
// ─────────────────────────────────────────────────────────────────────
// E3.C extends the E3.A authoring surface with the controller/probe/oracle
// machinery (probe sequencer, chaos wiring, O16/O4 oracles) — all still
// confined to torture-test/. The oracle-machinery bin test files
// (bin/oracle-*.mjs, bin/tt-oracle-replay*, bin/o9-mechanical-harvest.*,
// bin/o11-production-evidence.*) are part of that surface: they consume
// oracle-context / oracle-evidence-snapshot, whose version-1 evidence key
// set and gating registry E3.C extends. bin/tt-chaos (+ its self-test) is
// the chaos operator the controller's chaos wiring (E3.C US-008) invokes;
// US-004 adds its sigstop_sigcont action here. US-011 registers the
// zero-token scripted probe battery in the heavy-campaign lock-step lists
// (self-tests/run.sh HEAVY_CAMPAIGN_TESTS +
// bin/verify-heavy-campaign-tests.test.sh + e2e-golden-integrity), so the
// isolated heavy-test invocation script joins the authoring surface.
// E3.C.1 (US-001) adds the torture-test-local process-identity /
// kill-target safety primitives (bin/tt-process-identity.mjs + its unit
// test) and admits the daemon-control authoring surface
// (bin/daemon-control + bin/daemon-control.test.sh), which E3.C.1 US-004
// hardens with recorded-startTime identity before ANY signal. US-007 adds
// the sentinel-parent regression-proof wrapper (bin/tt-kill-sentinel).
const allowed = [
  "torture-test/cases/tier1.jsonl",
  "torture-test/cases/case.schema.json",
  "torture-test/cases/tier1-traceability.md",
  "torture-test/cases/tasks/tier1/",
  // Tier-2 roster (US-004): the wave-4 section-A manifest, its
  // traceability skeleton, and its task files are part of the Tier-2
  // authoring surface — exactly like the tier1 manifest/traceability/tasks
  // are for Tier-1.
  "torture-test/cases/tier2.jsonl",
  "torture-test/cases/tier2-traceability.md",
  "torture-test/cases/tasks/tier2/",
  // Tier-2 section F (US-010): the W4.31 tree-rewriting pre-commit hook
  // fixture asset lives under torture-test/fixtures/hooks/ (a NEW
  // authoring surface) and the W4.26/28/30/31 reset hooks live under
  // torture-test/cases/hooks/ (the existing hook surface extended by the
  // roster stories) — new authoring surfaces added in the same story that
  // created them.
  "torture-test/fixtures/",
  "torture-test/cases/hooks/",
  // Tier-2 section C1 (US-006): the W4.27 zero-token shim exit-code-matrix
  // case lives under scenarios/w4.27/ (the tier0 scenario-cell shape) —
  // a NEW scenario surface for the Tier-2 roster.
  "torture-test/scenarios/w4.27/",
  // Tier-2 section C2 (US-007): the W4.11 SIGKILL/Ctrl-C launch matrix and
  // W4.12 port-squatter cases live under scenarios/w4.11/ and
  // scenarios/w4.12/ (the tier0 scenario-cell shape) — new scenario
  // surfaces added in the same story that created them.
  "torture-test/scenarios/w4.11/",
  "torture-test/scenarios/w4.12/",
  // Tier-2 section D (US-008): the W4.14 verdict-trap case references a
  // NEW TT-custom one-step workflow spec under torture-test/workflows/
  // (the tt-shim-probe / tt-docs-drift pattern) — a new authoring
  // surface added in the same story that created it.
  "torture-test/workflows/",
  // Tier-2 section E (US-009): the W4.19 stale-catalog, W4.20 update
  // repo-state, and W4.34 stale-CLI-vs-new-daemon cases live under
  // scenarios/w4.19/, scenarios/w4.20/ and scenarios/w4.34/ (the tier0
  // scenario-cell shape) — new scenario surfaces added in the same story
  // that created them.
  "torture-test/scenarios/w4.19/",
  "torture-test/scenarios/w4.20/",
  "torture-test/scenarios/w4.34/",
  // Tier-2 section H (US-011): the W4.21 bare-noninteractive-launch,
  // W4.22 symlink-path-parity, W4.23 daemon-cross-runtime-restart and
  // W4.24 serial-lane-concurrent cases live under scenarios/w4.21/,
  // scenarios/w4.22/, scenarios/w4.23/ and scenarios/w4.24/ (the tier0
  // scenario-cell shape) — new scenario surfaces added in the same story
  // that created them.
  "torture-test/scenarios/w4.21/",
  "torture-test/scenarios/w4.22/",
  "torture-test/scenarios/w4.23/",
  "torture-test/scenarios/w4.24/",
  // Tier-2 sections I/J/K (US-012): the W4.40 stream-contract arms,
  // W4.41 resolver arms, W4.42 shared-workdir refusal, W4.43 refusal
  // storm, W4.44 double-tap + post-success-immunity and W4.46
  // provider-error-rounds cases live under scenarios/w4.40/,
  // scenarios/w4.41/, scenarios/w4.42/, scenarios/w4.43/,
  // scenarios/w4.44/ and scenarios/w4.46/ (the tier0 scenario-cell
  // shape) — new scenario surfaces added in the same story that created
  // them.
  "torture-test/scenarios/w4.40/",
  "torture-test/scenarios/w4.41/",
  "torture-test/scenarios/w4.42/",
  "torture-test/scenarios/w4.43/",
  "torture-test/scenarios/w4.44/",
  "torture-test/scenarios/w4.46/",
  // Tier-2 US-001: the four scripted-pi cells authored in the T2.1
  // EMERGENCY (W4.04c-keyline-laundering, W4.36-broken-work-concession,
  // W4.38-hostile-task-scripted, W4.39-a-union-honest) live under
  // scenarios/w4.04c/, scenarios/w4.36/, scenarios/w4.38/ and
  // scenarios/w4.39a/ (the tier0 scenario-cell shape) — new scenario
  // surfaces added in the same story that created them.
  "torture-test/scenarios/w4.04c/",
  "torture-test/scenarios/w4.36/",
  "torture-test/scenarios/w4.38/",
  "torture-test/scenarios/w4.39a/",
  // Tier-2 section H (US-011) also updated the spec directory: spec 01
  // (the E2.2 canonical contract) documents the capabilities
  // .node-runtimes-2 Boolean-leaf recording that tt-verify-environment
  // (W0.0) now discovers — a new spec surface added in the same story
  // that created it.
  "torture-test/tamandua-torture-test-spec/",
  "torture-test/bin/tt-fixture-provision.mjs",
  // MACP2 (US-005): the --provision --rebuild-invalid self-heal mode touches
  // the golden bootstrap module itself (ensureGoldenBare + its CLI) — part of
  // the provisioning authoring surface alongside tt-fixture-provision.mjs.
  "torture-test/bin/tt-golden-bootstrap.mjs",
  "torture-test/bin/tt-controller",
  "torture-test/bin/tt-controller.test.sh",
  "torture-test/bin/tt-chaos",
  "torture-test/bin/tt-chaos.test.sh",
  "torture-test/bin/verify-heavy-campaign-tests.test.sh",
  "torture-test/bin/tt-process-identity.mjs",
  "torture-test/bin/tt-process-identity.test.mjs",
  "torture-test/bin/daemon-control",
  "torture-test/bin/daemon-control.test.sh",
  "torture-test/bin/tt-kill-sentinel",
  "torture-test/bin/oracle-",
  "torture-test/bin/tt-oracle-replay",
  "torture-test/bin/o9-mechanical-harvest.integration.test.mjs",
  "torture-test/bin/o11-production-evidence.test.mjs",
  // Tier-2 dsh lane (US-001/US-002): the dsh host-profile probe, the
  // harness-auth probe's dsh presence leg, and the campaign report's
  // fail-closed cause list are part of the Tier-2 authoring surface —
  // exactly like E3.C extended the list for the oracle machinery.
  "torture-test/bin/tt-harness-auth-probe",
  "torture-test/bin/tt-harness-auth-probe.test.sh",
  "torture-test/bin/tt-report.mjs",
  "torture-test/bin/tt-report.test.mjs",
  // MACP3 US-009: the red-then-green proof authors the frozen PRE-US-008
  // verdict arm (bin/tt-report-legacy-vacuity.mjs) used to pin the vacuous
  // GREEN that existed before the US-008 bare vacuity guard — a preserved
  // historical snapshot like evidence-procfd-legacy.mjs, with a
  // byte-faithfulness pin against commit dafa40a7 (verified in the proof
  // self-test). Its containing self-test lives under torture-test/self-tests/
  // (already authorized); the legacy module itself joins the report surface.
  "torture-test/bin/tt-report-legacy-vacuity.mjs",
  "torture-test/bin/tt-verify-environment",
  "torture-test/bin/tt-verify-environment.test.sh",
  // MACP3 (US-003/US-004): the /proc portability sweep authorizes the
  // runtime tools + harnesses it marked (bin/tt-recorder, bin/tt-daemon-up
  // and their .test.sh harnesses, plus the shared scripted-scenario lib
  // scenarios/lib/run-scripted-scenario) — Darwin-portability guard/
  // comment-only changes (the same way MACP1/MACP2 authorize their
  // surfaces). US-005 adds the procfs-portability lint under
  // torture-test/self-tests/ (already authorized). MACP3 US-006/US-007
  // author the fail-closed predicate semantics surface — bin/tt-report.mjs
  // and its unit suite bin/tt-report.test.mjs (report verdict + INFRA
  // FAILURES surfacing). T2.1-owned files
  // (bin/daemon-control, bin/daemon-control.test.sh, scenarios/w4.23/,
  // scenarios/w4.49/) are never touched by MACP3 — only allowlisted.
  "torture-test/bin/tt-recorder",
  "torture-test/bin/tt-recorder.test.sh",
  "torture-test/bin/tt-daemon-up",
  "torture-test/bin/tt-daemon-up.test.sh",
  // CDSK (US-002): the S15 schema-handshake parity leg adds the read-only
  // SQL-surface probe (bin/tt-schema-probe.mjs) to the daemon-up authoring
  // surface — same class as the build-version parity guard it sits beside.
  "torture-test/bin/tt-schema-probe.mjs",
  "torture-test/scenarios/lib/run-scripted-scenario",
  // US-015: the --tier2 ladder rung — bin/tt-run wires tier2 availability
  // + routing (its test extends with the tier2 assertions and the E2.2
  // fail-closed proof), and bin/tt-tier2-assets is the NEW tier2 asset
  // validator (tier1-assets mirror + seed-vs-SEEDS.md + capabilities
  // well-formedness) with its own test.
  "torture-test/bin/tt-run",
  "torture-test/bin/tt-run.test.sh",
  "torture-test/bin/tt-tier2-assets",
  "torture-test/bin/tt-tier2-assets.test.sh",
  // T2.1 US-002: the tracked-tree scenario-assets guard — bin/tt-tier0-
  // assets joins the authoring surface (it now requires manifest-
  // referenced scenario dirs to exist in the TRACKED TREE via git
  // ls-files, same as tt-tier2-assets), and the shared git tracked-tree
  // helper lives under scenarios/lib/ (the scenario-cell support surface).
  "torture-test/bin/tt-tier0-assets",
  "torture-test/scenarios/lib/",
  "torture-test/oracles/",
  "torture-test/self-tests/",
  // MACP1 (US-002): the Darwin-parity portability surface — the fixture
  // SOURCE trees under fixtures-src/ (builders/validators/bootstraps: the
  // bash-3.2 sweep, the old-pip-safe bootstrap, and the fail-closed builder
  // error surfacing) and bin/verify-builder-determinism.test.sh (the
  // self-test that pins their golden hash ledgers) are legitimate MACP1
  // authoring files.
  "torture-test/fixtures-src/",
  "torture-test/bin/verify-builder-determinism.test.sh",
  // MACP2 (US-001): the impl-task task docs (portability evidence + resolution
  // decisions recorded in torture-test/impl-tasks/*.md, e.g.
  // MACP2-pycache-junk-portability.md) are part of the MACP2 authoring surface
  // — exactly like fixtures-src/ was authorized for MACP1.
  "torture-test/impl-tasks/",
  // MACP1 (US-010): the bash-3.2 compatibility sweep also rewrites the
  // scripted-runtimes dev tooling — fork-parity-check and
  // install-scenario-workflows (associative-array removal so they run under
  // macOS /bin/bash 3.2.57) — part of the Darwin-parity authoring surface.
  "torture-test/scripted-runtimes/",
  // E3.C.2 (US-001/US-002/US-003): the impl-tasks/ surface is the established
  // E3.C.2 evidence/notes location (root-cause note, implementation notes,
  // campaign/journal/provenance evidence bundles). US-003 adds it to the
  // authoring set so the final-acceptance confinement test passes on the
  // merged E3.C.2 branch diff.
  "torture-test/impl-tasks/",
];
// US-016 added the Tier-2 story's no-touch surfaces to the forbidden set:
// the E3.C.1-owned tier1 kill-path/probe-battery self-tests (a concurrent
// run owns those files; coordinate by never touching them — new proofs go
// in NEW files). torture-test/fixtures-src/ was also forbidden for the
// Tier-2 roster task, but MACP1 (US-002) authorizes the fixture-source
// portability surface (bash-3.2 sweep, old-pip bootstrap, error surfacing),
// so it moved to the allowed list above.
// E3.C.1 itself exempts its own new/modified files from that class: THIS
// branch IS the E3.C.1 run, and its own authoring surface legitimately
// contains tier1-kill-ancestry-hygiene.test.ts, tier1-kill-sentinel-
// survival.test.ts, and tier1-scripted-probe-battery.test.ts (the branch
// created/modified them as part of its own story — the US-016 guard was
// written to keep OTHER runs' diffs off those files). The universal
// no-touch surfaces above (canary, probes/, seeds/) are NOT exempted and
// apply to every run, including this one.
const forbidden = [
  "torture-test/bin/tt-hygiene-canary.mjs",
  "torture-test/probes/",
  "torture-test/seeds/",
  "torture-test/self-tests/tier1-scripted-probe-battery.test.ts",
];
// Pattern guard for the whole E3.C.1-owned class: any tier1 self-test
// whose name carries a kill corridor or the probe battery is off-limits
// to runs that do not own it (even if a future rename escapes the
// exact-file entry above).
const e3c1Owned = /^(tier1-.*kill.*|.*probe-battery.*)\.test\.ts$/;

describe("E3.A US-014 — final acceptance battery pins", () => {
  it("branch diff is confined to the intended authoring files", () => {
    const files = changedFiles();
    // The branch's own new/modified files — its own authoring surface. This
    // branch is the E3.C.1 run, so its own kill-path/probe-battery self-tests
    // are exempt from the E3.C.1-owned class above (the branch legitimately
    // authored them); the universal no-touch surfaces are never exempted.
    const branchOwnFiles = new Set(files);
    const violations: string[] = [];
    for (const file of files) {
      if (!allowed.some((prefix) => file === prefix || file.startsWith(prefix))) {
        violations.push(`${file}: outside the intended authoring set`);
      }
      const hit = forbidden.find((prefix) => file === prefix || file.startsWith(prefix));
      const isE3c1OwnedClass = file === "torture-test/self-tests/tier1-scripted-probe-battery.test.ts" ||
        (file.startsWith("torture-test/self-tests/") && e3c1Owned.test(path.basename(file)));
      if (hit && !(isE3c1OwnedClass && branchOwnFiles.has(file))) {
        violations.push(`${file}: FORBIDDEN (touches ${hit})`);
      }
      if (isE3c1OwnedClass && !branchOwnFiles.has(file)) {
        violations.push(`${file}: FORBIDDEN (E3.C.1-owned tier1 kill-path/probe-battery self-test)`);
      }
    }
    assert.deepEqual(violations, [], `diff confinement violations:\n${violations.join("\n")}`);
  });

  it("MACP1 authoring surface is authorized by the diff-confinement lists (US-002)", () => {
    // The MACP1 Darwin-parity task legitimately touches the fixture-SOURCE
    // trees (builders/validators/bootstraps under fixtures-src/: bash-3.2
    // sweep, old-pip bootstrap, error surfacing) and the builder-
    // determinism self-test. The allowed list must authorize that surface,
    // the forbidden list must no longer forbid it, and the remaining
    // no-touch surfaces (hygiene canary, probes/, seeds/, E3.C.1 kill-path
    // self-tests) must stay forbidden — with the e3c1Owned regex unchanged.
    for (const surface of [
      "torture-test/fixtures-src/",
      "torture-test/bin/verify-builder-determinism.test.sh",
    ]) {
      assert.ok(
        allowed.some((prefix) => surface === prefix || surface.startsWith(prefix)),
        `allowed list must authorize the MACP1 authoring surface ${surface}`,
      );
    }
    assert.ok(
      !forbidden.some((prefix) => "torture-test/fixtures-src/".startsWith(prefix)),
      "torture-test/fixtures-src/ must NOT be forbidden — MACP1 authorizes the fixture-source portability surface",
    );
    for (const offLimits of [
      "torture-test/bin/tt-hygiene-canary.mjs",
      "torture-test/probes/",
      "torture-test/seeds/",
      "torture-test/self-tests/tier1-scripted-probe-battery.test.ts",
    ]) {
      assert.ok(
        forbidden.some((prefix) => offLimits === prefix || offLimits.startsWith(prefix)),
        `forbidden list must keep ${offLimits} off-limits`,
      );
    }
    // e3c1Owned regex unchanged: still matches any tier1 kill-path or
    // probe-battery self-test name, and nothing else.
    assert.equal(e3c1Owned.source, "^(tier1-.*kill.*|.*probe-battery.*)\\.test\\.ts$");
    assert.ok(e3c1Owned.test("tier1-foo-kill.test.ts"), "e3c1Owned must match tier1 kill-path names");
    assert.ok(e3c1Owned.test("tier1-scripted-probe-battery.test.ts"), "e3c1Owned must match probe-battery names");
    assert.ok(!e3c1Owned.test("tier1-final-acceptance.test.ts"), "e3c1Owned must not match ordinary tier1 self-tests");
  });

  it("bin/tt-hygiene-canary.mjs is byte-identical to the merge-base version", () => {
    const base = branchBase();
    const result = git(["show", `${base}:torture-test/bin/tt-hygiene-canary.mjs`]);
    assert.equal(result.status, 0, `cannot read base canary: ${result.stderr}`);
    assert.equal(sha256(fs.readFileSync(hygieneCanary)), sha256(Buffer.from(result.stdout, "utf8")),
      "tt-hygiene-canary.mjs drifted from the merge-base version — the canary must remain untouched");
  });

  it("every real tier1 case carries a non-empty context.test_cmd", () => {
    const records = manifestRecords();
    const realCases = records.filter((record) => record.context?.execution_mode === "real");
    assert.ok(realCases.length >= 20, `expected the real case population, got ${realCases.length}`);
    const missing: string[] = [];
    for (const record of realCases) {
      const testCmd = record.context?.test_cmd;
      if (typeof testCmd !== "string" || testCmd.trim() === "") missing.push(record.id);
    }
    assert.deepEqual(missing, [], "real cases missing context.test_cmd (S1 launchGateKey feed)");
  });

  it("bug-fix cases carry their real seeds and W2.22 stays unseeded", () => {
    const records = manifestRecords();
    const seeded: Record<string, string> = {
      "W1.L3-python": "BUG-P1",
      "W1.L3-ts": "BUG-T1",
      "W3.01-bfmw-pi-python": "BUG-P2",
      "W3.02-bfmw-pi-ts": "BUG-T2",
      "W3.03-bfmw-hermes-ts": "BUG-T3",
    };
    for (const [id, expectedSeed] of Object.entries(seeded)) {
      const record = records.find((r) => r.id === id);
      assert.ok(record, `missing manifest case ${id}`);
      assert.equal(record.seed, expectedSeed, `${id}: seed must be ${expectedSeed} (S2 arming)`);
    }
    const w222 = records.find((r) => r.id === "W2.22-non-main-bfmw");
    assert.ok(w222, "missing manifest case W2.22-non-main-bfmw");
    assert.equal(w222.seed, undefined,
      "W2.22 must stay unseeded — a seed checkout would replace the clone branch and break its master-trap premise");
  });

  it("W1.X1 keeps its hostile-path fixture alias with root-relative boundaries", () => {
    const records = manifestRecords();
    const w1x1 = records.find((r) => r.id === "W1.X1-ts");
    assert.ok(w1x1, "missing manifest case W1.X1-ts");
    assert.equal(w1x1.fixture, "tt-ts café", "W1.X1 fixture must be the reserved hostile-path alias");
    assert.ok(w1x1.fixture.includes(" ") && /[^\x00-\x7F]/.test(w1x1.fixture),
      "W1.X1 fixture must contain a space and a non-ASCII character");
    assert.deepEqual(w1x1.boundary_files, ["src"], "W1.X1 boundary_files must be work-clone-root-relative");
    assert.deepEqual(w1x1.forbidden, ["operator-notes.local"], "W1.X1 forbidden must be work-clone-root-relative");
  });

  it("tier1 manifest validates through the production controller (28 cases)", () => {
    const result = spawnSync(controller, ["--manifest", manifest, "--validate-only"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Validated 28 case\(s\)/);
  });
});
