// Tier-2 US-004 + US-005 + US-006 + US-007 + US-011 + US-012: section-A roster
// (wave-4 merge-gate & evidence corridor) + traceability skeleton + sections
// B/G/C1/C2 + H + I/J/K.
//
// Pins the section-A batch of cases/tier2.jsonl (US-004), the shared
// manifest invariants that hold once sections B + G (US-005), C1 (US-006),
// C2 (US-007) and H (US-011) are appended:
//   * the manifest exists with the 10 section-A + 11 section-B/G + 6
//     section-C1 + 3 section-C2 + 10 section-D + 3 section-E + 6 section-F
//     + 4 section-H cases and
//     tt-controller --manifest cases/tier2.jsonl --validate-only exits 0
//     (schema + semantic probe/chaos validation per E3.C, incl. the US-003
//     typed chaos extension for delete-tstx-row, kill-daemon and
//     kill-harness);
//   * every workflow-launching REAL case (harness pi/hermes/dsh) carries a
//     non-empty context.test_cmd equal to its fixture's canonical TEST_CMD
//     from the fixture FIXTURE.md (never guessed);
//   * every bug-fix case's seed exists in the fixture SEEDS.md catalog and
//     its task file names the seeded defect the seed actually implants;
//   * every case carries a spec_ref into 08-wave-4-fault-injection.md;
//   * every case's task file exists under cases/tasks/tier2/ and describes
//     the fixture's actual contents (seed-defect text matches the SEEDS.md
//     catalog);
//   * gates are ["TIER2","W4"], mandatory/shed_ok per spec 11 (sections A/B/G
//     are NOT on the SHED-OK list: all mandatory, none shed_ok);
//   * E3.D calibration: real bfmw cases cap wall at/above the family p50
//     35-min floor with tokens at family p95; fdmw at/above the family p50
//     138-min floor with tokens at family p95 (2.5M); do-now at the tier1
//     do-now unit; security-merge within the 300-800k family band;
//   * the traceability skeleton (cases/tier2-traceability.md) carries the
//     section maps, the tier0-referenced W4 cells (w4.25/w4.35/w4.49 —
//     referenced, never duplicated), and the exclusion-list headers.
//
// Confined to torture-test/ (writes only under gitignored var/). Zero tokens.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const controller = path.join(ttRoot, "bin", "tt-controller");
const manifestPath = path.join(ttRoot, "cases", "tier2.jsonl");
const traceabilityPath = path.join(ttRoot, "cases", "tier2-traceability.md");
const tasksDir = path.join(ttRoot, "cases", "tasks", "tier2");

// The canonical per-fixture TEST_CMD, verified against each fixture's
// FIXTURE.md (tt-ts: "npm test"; tt-python: ".venv/bin/pytest -q"; tt-poly and
// tt-poly-lite: "./run-all-tests" from their READMEs; tt-go: "go test ./..."
// from its FIXTURE.md TEST_CMD). A case whose test_cmd disagrees with this
// table is an authoring error — never a guess.
const FIXTURE_TEST_CMD: Record<string, string> = {
  "tt-ts": "npm test",
  "tt-python": ".venv/bin/pytest -q",
  "tt-poly": "./run-all-tests",
  "tt-poly-lite": "./run-all-tests",
  "tt-go": "go test ./...",
};

// The 10 section-A cases (spec 08 §A): W4.01, W4.02, W4.03, W4.04a/b/c,
// W4.05, W4.29, W4.36, W4.37.
const SECTION_A_IDS = [
  "W4.01-missing-evidence-reroute",
  "W4.02-fail-missing-refusal",
  "W4.03-red-adjacent-commit",
  "W4.04a-mechanical-override",
  "W4.04b-behavioral-bait",
  "W4.04c-keyline-laundering",
  "W4.05-slow-suite-contention",
  "W4.29-strict-gate-retry-finalize",
  "W4.36-broken-work-concession",
  "W4.37-keyline-spoof-repo-content",
];

// The 11 section-B/G cases (spec 08 §B + §G, US-005): W4.06, W4.07,
// W4.08-no-relaunch, W4.08-control, W4.33a-d, W4.48a-c.
const SECTION_BG_IDS = [
  "W4.06-colleague-rebase",
  "W4.07-conflicting-colleague-commit",
  "W4.08-no-relaunch",
  "W4.08-control",
  "W4.33a-daemon-restart-resume",
  "W4.33b-update-under-it-resume",
  "W4.33c-deleted-worktree-refusal",
  "W4.33d-reroute-exhaustion-resume",
  "W4.48a-daemon-kill-mid-park",
  "W4.48b-pause-rugpull-window",
  "W4.48c-compound-gate-degradation",
];

// The 6 section-C1 cases (spec 08 §C, US-006): W4.09 pi+hermes kill-harness,
// W4.10 kill-daemon + restart-recovery, W4.27 shim exit matrix, W4.32 ENOSPC.
const SECTION_C1_IDS = [
  "W4.09-pi-kill-harness",
  "W4.09-hermes-kill-harness",
  "W4.10-kill-daemon",
  "W4.10-restart-recovery",
  "W4.27-shim-exit-matrix",
  "W4.32-enospc",
];

// The 3 section-C2 cases (spec 08 §C, US-007): W4.11 SIGKILL/Ctrl-C launch
// matrix, W4.12 port squatter, W4.13 out-of-band worktree deletion.
const SECTION_C2_IDS = [
  "W4.11-sigkill-launch-matrix",
  "W4.12-port-squatter",
  "W4.13-worktree-deletion",
];

// The 10 section-D cases (spec 08 §D, US-008): W4.14 verdict trap (custom
// one-step workflow), W4.15 story flood, W4.16 scope bait, W4.17-a/b
// red-baseline rationalization (merge_gate unset / green), W4.18 flaky
// alternator, W4.38 hostile task text (scripted mechanical + real
// behavioral), W4.39 union-day two-arm (honest scripted + dishonest real).
const SECTION_D_IDS = [
  "W4.14-verdict-trap",
  "W4.15-story-flood",
  "W4.16-scope-bait",
  "W4.17-a-red-baseline-land-annotated",
  "W4.17-b-red-baseline-refuse",
  "W4.18-flaky-alternator",
  "W4.38-hostile-task-scripted",
  "W4.38-hostile-task-real",
  "W4.39-a-union-honest",
  "W4.39-b-union-dishonest",
];

// The 3 section-E cases (spec 08 §E, US-009): W4.19 artificially stale
// catalog stamp warn-not-block, W4.20 update repo-state classification
// (behind/ahead/diverged/network-error), W4.34 stale CLI vs new daemon.
const SECTION_E_IDS = [
  "W4.19-stale-catalog-warn-not-block",
  "W4.20-update-repo-state-classification",
  "W4.34-stale-cli-new-daemon",
];

// The 6 section-F cases (spec 08 §F, US-010): W4.26 unreachable origin
// remote, W4.28 two-independent-bares TSTX cross-repo collision, W4.30
// detached-HEAD origin, W4.31 tree-rewriting pre-commit hook, W4.45 origin
// substrate hostility (two sub-arms: gc-aggressive / branch-delete).
const SECTION_F_IDS = [
  "W4.26-unreachable-origin",
  "W4.28-tstx-cross-repo-collision",
  "W4.30-detached-head-origin",
  "W4.31-precommit-amend",
  "W4.45-gc-aggressive",
  "W4.45-branch-delete",
];

// The 4 section-H cases (spec 08 §H, US-011): W4.21 bare non-interactive
// PATH full launch, W4.22 symlinked temp/var fixture paths, W4.23 daemon
// cross-node-runtime restart, W4.24 product serial lane concurrent with two
// TT runs.
const SECTION_H_IDS = [
  "W4.21-bare-noninteractive-launch",
  "W4.22-symlink-path-parity",
  "W4.23-daemon-cross-runtime-restart",
  "W4.24-serial-lane-concurrent",
];

// The 12 section-I/J/K cases (spec 08 §I/§J/§K, US-012): W4.40 x4 hermes
// stream-contract arms (scripted-hermes), W4.41 x2 resolver arms
// (scripted-hermes), W4.42 shared-workdir refusal, W4.43 refusal storm,
// W4.44 double-tap + post-success-immunity, W4.46 provider-error rounds
// (scripted-pi), W4.47 auth expiry on the copy (real pi do-now).
const SECTION_IJK_IDS = [
  "W4.40-delayed-trailer",
  "W4.40-oversized-stdout",
  "W4.40-trailer-absent",
  "W4.40-malformed-trailer",
  "W4.41-login-shell-tier",
  "W4.41-all-tiers-fail",
  "W4.42-shared-workdir-refusal",
  "W4.43-refusal-storm",
  "W4.44a-double-tap",
  "W4.44b-post-success-immunity",
  "W4.46-provider-error-rounds",
  "W4.47-auth-expiry-copy",
];

// The 4 dsh-lane cases (US-013, operator-directed alpha harness): W4.dsh-do-now
// (W4.37 KEY-line spoof base), W4.dsh-bfmw (W4.02 fail_missing=1 refusal
// base), W4.dsh-fdmw (W4.06 moving-target rebase base), W4.dsh-lifecycle
// (W4.33 resume-composition base). Every dsh row is a REAL case (harness
// "dsh", execution_mode real) with requires.capabilities ["dsh"] resolving to
// host-profile harness.dsh.present, context.test_cmd per fixture FIXTURE.md,
// E3.D floors+caps per family, and E3.C chaos/probe blocks where the base
// scenario has them.
const SECTION_DSH_IDS = [
  "W4.dsh-do-now",
  "W4.dsh-bfmw",
  "W4.dsh-fdmw",
  "W4.dsh-lifecycle",
];

// The 1 wave-5 storm case (US-014): W5.storm-capacity-scaled — a REAL
// contract-pin row (execution_mode real, harness pi, workflow
// feature-dev-merge-worktree — the storm's dominant family), fixture
// tt-poly-lite, seed "storm" (the composite seed/storm ref), gates
// [TIER2, W5], requires covering the capacity-scaled roster (toolchains
// node+python3, capabilities pi+hermes, node_min 22). Its task file IS the
// full two-round storm briefing (09-wave-5-storm.md).
const SECTION_W5_IDS = [
  "W5.storm-capacity-scaled",
];

// dsh-lane bug-fix cases (workflow bug-fix-merge-worktree, seeded) — seed must
// exist in the fixture SEEDS.md catalog AND the task text must name the seeded
// defect (same E3.A S2 contract as the pi rows).
const DSH_SEEDED_CASES: Record<string, { fixture: string; seed: string }> = {
  "W4.dsh-bfmw": { fixture: "tt-ts", seed: "BUG-T2" },
  "W4.dsh-lifecycle": { fixture: "tt-ts", seed: "BUG-T3" },
};

// Bug-fix cases (workflow bug-fix-merge-worktree, seeded) — seed must exist in
// the fixture SEEDS.md catalog AND the task text must name the seeded defect.
const SEEDED_CASES: Record<string, { fixture: string; seed: string }> = {
  "W4.01-missing-evidence-reroute": { fixture: "tt-ts", seed: "BUG-T1" },
  "W4.02-fail-missing-refusal": { fixture: "tt-ts", seed: "BUG-T2" },
  "W4.03-red-adjacent-commit": { fixture: "tt-ts", seed: "BUG-T3" },
  "W4.04a-mechanical-override": { fixture: "tt-ts", seed: "BUG-T4" },
  "W4.04b-behavioral-bait": { fixture: "tt-ts", seed: "BUG-T1" },
  "W4.04c-keyline-laundering": { fixture: "tt-ts", seed: "BUG-T2" },
  "W4.05-slow-suite-contention": { fixture: "tt-poly", seed: "POLY-BUG-T1" },
  "W4.36-broken-work-concession": { fixture: "tt-ts", seed: "BUG-T1" },
};

// node:test marks descendant processes; drop NODE_TEST_CONTEXT so the
// TAMANDUA_TEST_GUARD live-state protection does not auto-activate for the
// spawned controller (the standard self-test pattern). /bin/false backstops
// guard against any accidental real model invocation.
const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
  TAMANDUA_DSH_BINARY: "/usr/bin/false",
};

type Case = Record<string, any>;

function readManifest(): Case[] {
  const source = fs.readFileSync(manifestPath, "utf8");
  const records: Case[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    records.push(JSON.parse(line));
  }
  return records;
}

function run(file: string, args: string[], extraEnv: Record<string, string> = {}, timeout = 300_000) {
  const result = spawnSync(file, args, {
    cwd: repoRoot,
    env: { ...env, ...extraEnv },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout,
  });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function readSeedsMd(fixture: string): string {
  const seedsPath = path.join(ttRoot, "fixtures-src", fixture, "seeds", "SEEDS.md");
  return fs.readFileSync(seedsPath, "utf8");
}

// A seed is in the catalog iff the SEEDS.md has a heading `### <seed>` (the
// catalog's entry format for both tt-ts and tt-poly).
function seedInCatalog(seedsMd: string, seed: string): boolean {
  const escaped = seed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^###\\s+${escaped}\\b`, "m").test(seedsMd);
}

describe("Tier-2 US-004..US-014 — section-A + B/G + C1 + C2 + D + E + F + H + I/J/K + dsh-lane + W5-storm roster (wave-4 gate corridor + moving targets + composition + process/daemon/launch violence + contract & behavioral traps + weird-git target repos + platform-conditional lanes + harness-stream/launch-hostility/provider-auth + operator-directed dsh lane + capacity-scaled two-round storm)", () => {
  it("cases/tier2.jsonl exists with the 10 section-A + 11 section-B/G + 6 section-C1 + 3 section-C2 + 10 section-D + 3 section-E + 6 section-F + 4 section-H + 12 section-I/J/K + 4 dsh-lane + 1 W5-storm cases and --validate-only exits 0", () => {
    const records = readManifest();
    const ids = records.map((record) => record.id);
    assert.deepEqual(
      [...ids].sort(),
      [...SECTION_A_IDS, ...SECTION_BG_IDS, ...SECTION_C1_IDS, ...SECTION_C2_IDS, ...SECTION_D_IDS, ...SECTION_E_IDS, ...SECTION_F_IDS, ...SECTION_H_IDS, ...SECTION_IJK_IDS, ...SECTION_DSH_IDS, ...SECTION_W5_IDS].sort(),
      `tier2.jsonl must contain exactly the 10 section-A + 11 section-B/G + 6 section-C1 + 3 section-C2 + 10 section-D + 3 section-E + 6 section-F + 4 section-H + 12 section-I/J/K + 4 dsh-lane + 1 W5-storm cases (got ${ids.join(", ")})`,
    );
    const res = run(controller, ["--manifest", manifestPath, "--validate-only"]);
    assert.equal(res.status, 0, `tt-controller --validate-only must exit 0:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 70 case\(s\)/);
  });

  it("every W4 case carries gates [TIER2,W4] and every W5 case gates [TIER2,W5]; all mandatory=true, shed_ok=false per spec 11", () => {
    for (const record of readManifest()) {
      if (record.gates.includes("W5")) {
        assert.deepEqual(record.gates, ["TIER2", "W5"], `${record.id} W5 gates must be [TIER2, W5]`);
        assert.equal(record.wave, 5, `${record.id} wave must be 5 (W5 storm)`);
      } else {
        assert.deepEqual(record.gates, ["TIER2", "W4"], `${record.id} gates must be [TIER2, W4]`);
        assert.equal(record.wave, 4, `${record.id} wave must be 4`);
      }
      assert.equal(record.mandatory, true, `${record.id} must be mandatory (sections A/B/G are not on the spec-11 SHED-OK list)`);
      assert.equal(record.shed_ok, false, `${record.id} must not be shed-ok (sections A/B/G are not on the spec-11 SHED-OK list)`);
    }
  });

  it("every W4 case carries a spec_ref into 08-wave-4-fault-injection.md; the W5 storm case into 09-wave-5-storm.md", () => {
    for (const record of readManifest()) {
      assert.equal(typeof record.spec_ref, "string", `${record.id} must carry spec_ref`);
      if (record.gates.includes("W5")) {
        assert.match(record.spec_ref, /^09-wave-5-storm\.md#/, `${record.id} spec_ref must point into 09-wave-5-storm.md`);
      } else {
        assert.match(record.spec_ref, /^08-wave-4-fault-injection\.md#W4\./, `${record.id} spec_ref must point into 08-wave-4-fault-injection.md`);
      }
    }
  });

  it("every workflow-launching real case has context.test_cmd matching its fixture's canonical TEST_CMD", () => {
    const REAL_HARNESSES = new Set(["pi", "hermes", "dsh"]);
    let realWorkflowCases = 0;
    for (const record of readManifest()) {
      if (!REAL_HARNESSES.has(record.harness)) continue;
      if (record.workflow === "local") continue;
      realWorkflowCases += 1;
      const canonical = FIXTURE_TEST_CMD[record.fixture];
      assert.ok(canonical, `${record.id}: fixture ${record.fixture} has no canonical TEST_CMD in the test map`);
      assert.equal(record.context?.test_cmd, canonical,
        `${record.id}: context.test_cmd must be the fixture's canonical TEST_CMD (${canonical}), got ${JSON.stringify(record.context?.test_cmd)}`);
    }
    // All 45 real cases are workflow-launching (8 section-A + 11 section-B/G
    // + 5 section-C1 + 1 section-C2/W4.13 + 8 section-D: W4.14/15/16/17-a/17-b/
    // 18/38-real/39-b + 6 section-F: W4.26/28/30/31/45-gc/45-branch-delete
    // + 1 section-K: W4.47-auth-expiry-copy real do-now
    // + 4 dsh-lane rows: W4.dsh-do-now / W4.dsh-bfmw / W4.dsh-fdmw /
    // W4.dsh-lifecycle
    // + 1 W5-storm row: W5.storm-capacity-scaled);
    // the 25 scripted cases (W4.04c, W4.36,
    // W4.38-hostile-task-scripted, W4.39-a-union-honest scripted-pi,
    // W4.27/W4.11/W4.12/W4.19/W4.20/W4.34/W4.21/W4.22/W4.23/W4.24
    // local-command, W4.40 x4 + W4.41 x2 scripted-hermes,
    // W4.42/W4.43/W4.44a/W4.44b local-command, W4.46 scripted-pi) are
    // excluded from the
    // REAL harness check but still carry test_cmd (checked below for the
    // scripted-pi ones).
    assert.equal(realWorkflowCases, 45, "expected 45 workflow-launching real cases");
  });

  it("every workflow-launching scripted section-A case also carries context.test_cmd (E3.A contract)", () => {
    for (const record of readManifest()) {
      if (record.harness !== "scripted-pi" && record.harness !== "scripted-hermes") continue;
      assert.equal(typeof record.context?.test_cmd, "string",
        `${record.id}: scripted workflow case must carry context.test_cmd (the workflow's verify step runs it)`);
      assert.ok(record.context.test_cmd.length > 0, `${record.id}: test_cmd must be non-empty`);
      const canonical = FIXTURE_TEST_CMD[record.fixture];
      assert.equal(record.context.test_cmd, canonical,
        `${record.id}: scripted test_cmd must match the fixture canonical TEST_CMD`);
    }
  });

  it("every bug-fix section-A case's seed exists in the fixture SEEDS.md catalog and its task file names the seeded defect", () => {
    for (const [caseId, { fixture, seed }] of Object.entries({ ...SEEDED_CASES, ...DSH_SEEDED_CASES })) {
      const record = readManifest().find((item) => item.id === caseId);
      assert.ok(record, `${caseId} must exist in the manifest`);
      assert.equal(record.seed, seed, `${caseId} must declare seed ${seed}`);
      const seedsMd = readSeedsMd(fixture);
      assert.ok(seedInCatalog(seedsMd, seed), `${caseId}: seed ${seed} must exist in ${fixture} SEEDS.md catalog`);
      const task = fs.readFileSync(path.join(ttRoot, record.task), "utf8");
      assert.match(task, new RegExp(seed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `${caseId}: task file must name the seeded defect (seed ${seed})`);
    }
    // W4.29 (security-audit-merge) is NOT a bug-fix case: it audits the
    // fixture's dormant vulnerabilities, which must exist in the tt-ts
    // SEEDS.md catalog (VULN-T1/T2) and be named in its task.
    const w429 = readManifest().find((item) => item.id === "W4.29-strict-gate-retry-finalize");
    assert.ok(w429, "W4.29 must exist");
    assert.equal(w429.seed, undefined, "W4.29 (security-audit-merge) must not carry a bug-fix seed");
    const tsSeeds = readSeedsMd("tt-ts");
    for (const vuln of ["VULN-T1", "VULN-T2"]) {
      assert.ok(seedInCatalog(tsSeeds, vuln), `tt-ts SEEDS.md must catalog ${vuln}`);
    }
    const w429Task = fs.readFileSync(path.join(ttRoot, w429.task), "utf8");
    assert.match(w429Task, /VULN-T1/, "W4.29 task must name VULN-T1");
    assert.match(w429Task, /VULN-T2/, "W4.29 task must name VULN-T2");
  });

  it("E3.D calibration: real bfmw wall caps at/above the family p50 35-min floor, tokens at family p95", () => {
    for (const record of readManifest()) {
      if (record.harness === "scripted-pi" || record.harness === "scripted-hermes" || record.harness === "local") {
        assert.equal(record.caps.tokens, 0, `${record.id}: scripted case must be zero-token`);
        continue;
      }
      assert.ok(record.caps.wall_min > 0 && record.caps.tokens > 0, `${record.id}: real case caps must be positive`);
      if (record.workflow === "bug-fix-merge-worktree") {
        assert.ok(record.caps.wall_min >= 35,
          `${record.id}: bfmw wall cap must be at/above the family p50 35-min floor (got ${record.caps.wall_min})`);
        assert.ok(record.caps.tokens >= 1000000,
          `${record.id}: bfmw token cap must sit at family p95 (1M), never below p50 (got ${record.caps.tokens})`);
        assert.ok(record.production_duration_floor_ms > 0,
          `${record.id}: real bfmw must carry production_duration_floor_ms (E3.D calibration record)`);
      }
      if (record.workflow === "feature-dev-merge-worktree") {
        assert.ok(record.caps.wall_min >= 138,
          `${record.id}: fdmw wall cap must be at/above the family p50 138-min floor (got ${record.caps.wall_min})`);
        assert.ok(record.caps.tokens >= 2500000,
          `${record.id}: fdmw token cap must sit at family p95 (2.5M), never below p50 (got ${record.caps.tokens})`);
        assert.ok(record.production_duration_floor_ms > 0,
          `${record.id}: real fdmw must carry production_duration_floor_ms (E3.D calibration record)`);
      }
      if (record.workflow === "security-audit-merge") {
        assert.ok(record.caps.tokens >= 300000 && record.caps.tokens <= 800000,
          `${record.id}: security-merge token cap must sit in the 300-800k family band (got ${record.caps.tokens})`);
      }
      if (record.workflow === "do-now") {
        assert.ok(record.caps.wall_min >= 5 && record.caps.tokens >= 200000,
          `${record.id}: do-now caps must sit at the tier1 do-now unit (wall 5, tokens 200k)`);
      }
    }
  });

  it("chaos/probe blocks validate per the E3.C schema incl. the US-003 delete-tstx-row + kill-daemon extensions", () => {
    const records = readManifest();
    const deleteRows = records.filter((record) => record.chaos?.type === "delete-tstx-row");
    // W4.01, W4.02, W4.29, W4.36 (section A) + W4.48c (section G compound) +
    // W4.dsh-bfmw (dsh lane, W4.02 base) declare the drain-armed
    // delete-tstx-row block. (S39: W4.29 joined — its task text always
    // promised the W4.01/W4.02 corridor but the manifest carried chaos:null,
    // so the corridor NEVER fired in the campaign; the S39 arming gap fix
    // declares it.)
    assert.deepEqual(
      deleteRows.map((record) => record.id).sort(),
      [
        "W4.01-missing-evidence-reroute",
        "W4.02-fail-missing-refusal",
        "W4.29-strict-gate-retry-finalize",
        "W4.36-broken-work-concession",
        "W4.48c-compound-gate-degradation",
        "W4.dsh-bfmw",
      ],
      "exactly the six drain-armed cases must carry delete-tstx-row chaos",
    );
    for (const record of deleteRows) {
      assert.equal(record.chaos.target, "tstx_row", `${record.id}: delete-tstx-row targets tstx_row`);
      assert.equal(record.chaos.operator, "tt-chaos", `${record.id}: chaos operator must be tt-chaos`);
      assert.equal(record.chaos.trigger, "step:finalize_merge:pending",
        `${record.id}: delete arms when finalize_merge is pending under the drain barrier`);
      assert.equal(record.chaos.tree, "TESTEDTREE",
        `${record.id}: chaos.tree is the documented sentinel (resolved to TESTED_TREE at execution)`);
      // The drain-armed cases also carry the pause_drain + resume probe
      // sequence (single run group; the chaos block rejects multi-run shapes).
      assert.ok(Array.isArray(record.probe_sequence) && record.probe_sequence.length === 1,
        `${record.id}: must carry a single-run probe_sequence`);
      const ops = record.probe_sequence[0].actions.map((action: any) => action.op);
      assert.deepEqual(ops, ["pause_drain", "resume"], `${record.id}: probe ops must be pause_drain then resume`);
      assert.equal(record.probe_sequence[0].actions[0].when, "step:verify:running",
        `${record.id}: pause_drain arms while verify is still running (the spec's drain-arming race note)`);
    }
    // W4.48a carries the typed kill-daemon chaos block (US-003 extension).
    const w448a = records.find((item) => item.id === "W4.48a-daemon-kill-mid-park");
    assert.equal(w448a.chaos.type, "kill-daemon", "W4.48a must carry a kill-daemon chaos block");
    assert.equal(w448a.chaos.target, "daemon_process", "W4.48a kill-daemon targets daemon_process");
    assert.equal(w448a.chaos.signal, "SIGKILL", "W4.48a kill-daemon declares SIGKILL");
    assert.equal(w448a.chaos.trigger, "step:finalize_merge:running",
      "W4.48a kill arms when finalize_merge is running (the park→landing corridor approximation)");
    // Section C1 (US-006): W4.09's two rows carry the typed kill-harness
    // chaos block (pi + hermes); W4.10-kill-daemon carries the typed
    // kill-daemon chaos block.
    for (const [id, harness] of [
      ["W4.09-pi-kill-harness", "pi"],
      ["W4.09-hermes-kill-harness", "hermes"],
    ]) {
      const record = records.find((item) => item.id === id);
      assert.equal(record.harness, harness, `${id} must run on the ${harness} harness`);
      assert.equal(record.chaos.type, "kill-harness", `${id} must carry a kill-harness chaos block`);
      assert.equal(record.chaos.target, "harness_process", `${id} kill-harness targets harness_process`);
      assert.equal(record.chaos.signal, "SIGKILL", `${id} kill-harness declares SIGKILL`);
      assert.equal(record.chaos.trigger, "step:fixer:running",
        `${id} kill-harness arms mid-fix (the bfmw coding step — S29 calibration US-003: step:developer:running is not bfmw vocabulary, so the US-003 preflight would reject it)`);
      assert.equal(record.chaos.operator, "tt-chaos", `${id} chaos operator must be tt-chaos`);
    }
    const w410Kill = records.find((item) => item.id === "W4.10-kill-daemon");
    assert.equal(w410Kill.chaos.type, "kill-daemon", "W4.10-kill-daemon must carry a kill-daemon chaos block");
    assert.equal(w410Kill.chaos.target, "daemon_process", "W4.10-kill-daemon targets daemon_process");
    assert.equal(w410Kill.chaos.signal, "SIGKILL", "W4.10-kill-daemon declares SIGKILL");
    assert.equal(w410Kill.chaos.trigger, "step:fixer:running",
      "W4.10-kill-daemon kills the daemon mid-fix (harness left alive; S29 calibration US-003 — step:developer:running is not bfmw vocabulary)");
    assert.equal(w410Kill.chaos.operator, "tt-chaos", "W4.10-kill-daemon chaos operator must be tt-chaos");
    // W4.10-restart-recovery carries the typed restart_daemon probe action on
    // EVERY run group (the daemon-level multi-run contract, W3.22 shape) with
    // the per-run recovery expectation.
    const w410Restart = records.find((item) => item.id === "W4.10-restart-recovery");
    assert.ok(Array.isArray(w410Restart.probe_sequence) && w410Restart.probe_sequence.length === 2,
      "W4.10-restart-recovery must declare a two-run restart_daemon probe sequence");
    for (const group of w410Restart.probe_sequence) {
      const restart = group.actions.find((action: any) => action.op === "restart_daemon");
      assert.ok(restart, "W4.10-restart-recovery: every run group must declare restart_daemon");
      assert.equal(restart.when, "step:fixer:running",
        "restart arms mid-fix (the bfmw coding step — S29 calibration, US-002: step:developer:running is not bfmw vocabulary)");
      assert.equal(restart.expect?.recovery_within_dispatch_intervals, 2,
        "W4.10-restart-recovery expects recovery within 2 dispatch intervals");
      assert.equal(restart.expect?.token_flush_preserved, true, "token flush must be preserved");
      assert.equal(restart.expect?.run_completes, true, "the run must complete after the restart");
    }
    assert.ok(w410Restart.oracles.includes("O16"),
      "W4.10-restart-recovery must declare O16 (the probe-evidence lifecycle oracle)");
    // W4.03/W4.04a + the moving-target/rugpull rows carry chaos:null (their
    // injections — colleague-commit / write-context / move-branch — are
    // documented machinery deltas, not silent trims). The dsh rows inherit
    // their base rows' chaos:null where the base corridor is a machinery
    // delta (W4.dsh-fdmw's colleague-commit; W4.dsh-do-now's reset-hook
    // planted diagnostics; W4.dsh-lifecycle's operator restart seam).
    // EXCEPTION (US-004 S29 premise redesign): W4.33d and W4.48b now carry
    // the TYPED move-branch chaos block — the colleague target-move the
    // controller genuinely executes, making event:run.failed /
    // event:merge.target_moved reachable (previously chaos:null, so the
    // premise events never fired — the S29 probe-trigger-unreached defect).
    for (const id of [
      "W4.03-red-adjacent-commit",
      "W4.04a-mechanical-override",
      "W4.06-colleague-rebase",
      "W4.07-conflicting-colleague-commit",
      "W4.08-no-relaunch",
      "W4.08-control",
      "W4.dsh-do-now",
      "W4.dsh-fdmw",
      "W4.dsh-lifecycle",
    ]) {
      const record = records.find((item) => item.id === id);
      assert.equal(record.chaos, null, `${id}: chaos must be null (injection is a documented machinery delta)`);
    }
    for (const id of ["W4.33d-reroute-exhaustion-resume", "W4.48b-pause-rugpull-window"]) {
      const rec = records.find((item) => item.id === id);
      assert.ok(rec, `${id}: must exist in tier2.jsonl`);
      assert.ok(rec.chaos && typeof rec.chaos === "object",
        `${id}: the US-004 premise redesign must wire a typed chaos block (the colleague target-move is now executed, not a machinery delta)`);
      assert.equal(rec.chaos.type, "move-branch", `${id}: typed injection must be move-branch`);
      assert.equal(rec.chaos.target, "origin_target_ref", `${id}: move-branch targets the origin target ref`);
      // The target ref is the branch the bfmw merger actually merges into:
      // for seeded tt-ts cells that is the SEEDED branch (seed/BUG-T4 for
      // W4.33d's BUG-T4 seed, seed/BUG-T2 for W4.48b's BUG-T2) — NOT main.
      const expectedRef = id === "W4.33d-reroute-exhaustion-resume"
        ? "refs/heads/seed/BUG-T4"
        : "refs/heads/seed/BUG-T2";
      assert.equal(rec.chaos.ref, expectedRef, `${id}: target ref must be ${expectedRef} (the merger's merge target)`);
      assert.equal(rec.chaos.trigger, "step:finalize_merge:running", `${id}: wave-4 arming on the finalize step`);
      assert.ok(rec.chaos.repeat > 1 && rec.chaos.interval_s > 0 && rec.chaos.wait_timeout_s > 0,
        `${id}: the persistent-move budget + interval + wait bound must be declared`);
      // US-007 (S36): W4.33d's premise is per-attempt deterministic re-arm —
      // the free-running cadence never re-armed per finalize attempt, so the
      // real rerun completed cleanly (S36 root cause). W4.33d must declare
      // rearm: true + a positive rearm_hold_s; W4.48b keeps the free-running
      // cadence (a single target move in the pause window is its premise).
      if (id === "W4.33d-reroute-exhaustion-resume") {
        assert.equal(rec.chaos.rearm, true,
          "W4.33d: the S36 redesign must declare rearm: true (each fresh step:finalize_merge:running occurrence triggers the next move)");
        assert.ok(Number.isInteger(rec.chaos.rearm_hold_s) && rec.chaos.rearm_hold_s > 0,
          "W4.33d: rearm must declare a positive rearm_hold_s (the post-marker hold so the tip capture precedes the move)");
      } else {
        assert.equal(rec.chaos.rearm, undefined, "W4.48b: must keep the free-running cadence (no rearm)");
      }
    }
    // W4.dsh-lifecycle carries the W4.33a-shaped pause_drain + resume probe
    // (operator restart seam during the hold; O16 judges run_completes).
    const dshLifecycle = records.find((item) => item.id === "W4.dsh-lifecycle");
    assert.ok(Array.isArray(dshLifecycle.probe_sequence) && dshLifecycle.probe_sequence.length === 1,
      "W4.dsh-lifecycle must carry a single-run probe_sequence");
    const lifecycleOps = dshLifecycle.probe_sequence[0].actions.map((action: any) => action.op);
    assert.deepEqual(lifecycleOps, ["pause_drain", "resume"], "W4.dsh-lifecycle probe ops must be pause_drain then resume");
    assert.equal(dshLifecycle.probe_sequence[0].actions[0].when, "step:fixer:running",
      "W4.dsh-lifecycle pause_drain arms at step:fixer:running (the W4.33a shape — S29 calibration US-003: step:developer:running is not bfmw vocabulary, the US-003 preflight would reject it)");
    assert.equal(dshLifecycle.probe_sequence[0].actions[1].expect?.run_completes, true,
      "W4.dsh-lifecycle resume expects run_completes (O16)");
    assert.ok(dshLifecycle.oracles.includes("O16"), "W4.dsh-lifecycle must declare O16");
  });

  it("task files exist under cases/tasks/tier2/ for all 70 cases and describe the fixture's actual contents", () => {
    const records = readManifest();
    for (const record of records) {
      assert.equal(typeof record.task, "string", `${record.id}: task path required`);
      assert.ok(record.task.startsWith("cases/tasks/tier2/"), `${record.id}: task must live under cases/tasks/tier2/`);
      const taskPath = path.join(ttRoot, record.task);
      const details = fs.lstatSync(taskPath, { throwIfNoEntry: false });
      assert.ok(details?.isFile() && !details.isSymbolicLink(), `${record.id}: task file must exist as a regular file: ${record.task}`);
      const realTask = fs.realpathSync(taskPath);
      assert.ok(realTask.startsWith(`${fs.realpathSync(tasksDir)}${path.sep}`),
        `${record.id}: task file must resolve inside cases/tasks/tier2/`);
      const task = fs.readFileSync(taskPath, "utf8");
      assert.ok(task.trim().length > 0, `${record.id}: task file must be non-empty`);
      // No phantom symptoms: a bug-fix task must describe the fixture's actual
      // seeded defect (checked per-seed above); every task must mention its
      // own fixture by name so it cannot describe a different project.
      // (Fixture "none" rows — W4.27/W4.11/W4.12/W4.21/W4.22/W4.23/W4.24
      // local-command cells — have no provisioned fixture to mention; their
      // scenario cells ARE the content.)
      if (record.fixture !== "none") {
        assert.match(task, new RegExp(record.fixture.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
          `${record.id}: task must describe the ${record.fixture} fixture's actual contents`);
      }
    }
    // No leftover extra files in the task dir beyond the 70 authored.
    const authored = fs.readdirSync(tasksDir).filter((name) => name.endsWith(".md")).sort();
    const expected = records.map((record) => path.basename(record.task)).sort();
    assert.deepEqual(authored, expected, "cases/tasks/tier2/ must contain exactly the 70 authored task files");
  });

  it("the traceability report carries the section maps, the tier0-referenced W4 cells, and the exclusion-list headers", () => {
    const trace = fs.readFileSync(traceabilityPath, "utf8");
    assert.match(trace, /# Tier-2 Case Traceability Report/, "traceability header");
    assert.match(trace, /## Manifest Summary/, "manifest summary section");
    assert.match(trace, /## Case ↔ Spec Reference Map/, "case -> spec_ref map section");
    // Every manifest id has a traceability row (traceability completeness).
    for (const record of readManifest()) {
      assert.match(trace, new RegExp(record.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `traceability must carry a row for ${record.id}`);
    }
    // Sections B, G, C1, C2, D, E, F and H have their own reference-map +
    // exclusion sections.
    assert.match(trace, /Wave 4 Section B/, "section-B reference map header");
    assert.match(trace, /Wave 4 Section G/, "section-G reference map header");
    assert.match(trace, /Wave 4 Section C1/, "section-C1 reference map header");
    assert.match(trace, /Wave 4 Section C2/, "section-C2 reference map header");
    assert.match(trace, /Wave 4 Section D/, "section-D reference map header");
    assert.match(trace, /Wave 4 Section E/, "section-E reference map header");
    assert.match(trace, /Wave 4 Section F/, "section-F reference map header");
    assert.match(trace, /Wave 4 Section H/, "section-H reference map header");
    assert.match(trace, /Wave 4 Section I/, "section-I reference map header");
    assert.match(trace, /Wave 4 Section J/, "section-J reference map header");
    assert.match(trace, /Wave 4 Section K/, "section-K reference map header");
    assert.match(trace, /## Excluded Scenarios — Complete Enumeration \(section B\)/, "section-B exclusion enumeration");
    assert.match(trace, /## Excluded Scenarios — Complete Enumeration \(section G\)/, "section-G exclusion enumeration");
    assert.match(trace, /## Excluded Scenarios — Complete Enumeration \(section C1\)/, "section-C1 exclusion enumeration");
    assert.match(trace, /## Excluded Scenarios — Complete Enumeration \(section C2\)/, "section-C2 exclusion enumeration");
    assert.match(trace, /## Excluded Scenarios — Complete Enumeration \(section D\)/, "section-D exclusion enumeration");
    assert.match(trace, /## Excluded Scenarios — Complete Enumeration \(section F\)/, "section-F exclusion enumeration");
    assert.match(trace, /## Excluded Scenarios — Complete Enumeration \(section H\)/, "section-H exclusion enumeration");
    assert.match(trace, /## Excluded Scenarios — Complete Enumeration \(section I\)/, "section-I exclusion enumeration");
    assert.match(trace, /## Excluded Scenarios — Complete Enumeration \(section J\)/, "section-J exclusion enumeration");
    assert.match(trace, /## Excluded Scenarios — Complete Enumeration \(section K\)/, "section-K exclusion enumeration");
    // The dsh lane (US-013) has its own reference-map + exclusion sections.
    assert.match(trace, /dsh lane/, "traceability must carry the dsh-lane section");
    assert.match(trace, /operator-directed|operator-directed, alpha/, "the dsh-lane decision (operator-directed, alpha harness) must be documented");
    assert.match(trace, /## Excluded Scenarios — Complete Enumeration \(dsh lane\)/, "dsh-lane exclusion enumeration");
    // Tier0-referenced scripted W4 cells — referenced, never duplicated.
    assert.match(trace, /w4\.25/, "traceability must reference the tier0 w4.25 cell");
    assert.match(trace, /w4\.35/, "traceability must reference the tier0 w4.35 cells");
    assert.match(trace, /w4\.49/, "traceability must reference the tier0 w4.49 cells");
    assert.match(trace, /referenced, never duplicated|never duplicated/, "tier0 cells must be documented as references, not duplicates");
    // Exclusion-list section headers (case -> spec section -> reason).
    assert.match(trace, /## Excluded Scenarios/, "exclusion-list section header");
    assert.match(trace, /08-wave-4-fault-injection\.md/, "spec section reference in traceability");
    // The campaign-tiers doc note (README Execution tiers, not spec 04).
    assert.match(trace, /README\.md/, "campaign-tiers doc note must point at the spec README");
    assert.match(trace, /04-wave-0-preflight/, "traceability must note that spec 04 is wave-0 preflight, not the tiers doc");
  });

  it("the dsh lane is present (US-013) and the W5 storm is authored (US-014)", () => {
    const records = readManifest();
    // Exactly the four dsh-lane rows (US-013) are present; they are real
    // cases gated on the dsh capability.
    const dshRows = records.filter((record) => record.harness === "dsh");
    assert.deepEqual(dshRows.map((record) => record.id).sort(), [...SECTION_DSH_IDS].sort(),
      "the four dsh-lane rows must be present (US-013)");
    for (const record of dshRows) {
      assert.equal(record.context?.execution_mode, "real",
        `${record.id}: a dsh case is ALWAYS real (scripted-dsh does not exist)`);
      assert.ok(Array.isArray(record.requires?.capabilities) && record.requires.capabilities.includes("dsh"),
        `${record.id}: requires.capabilities must include dsh (host-profile harness.dsh.present)`);
      assert.match(record.spec_ref ?? "", /^08-wave-4-fault-injection\.md#W4\./,
        `${record.id}: dsh row must carry a spec_ref into its base W4 scenario`);
    }
    // The W5 storm (US-014) is now authored: exactly the one capacity-scaled
    // contract-pin row, gated [TIER2, W5] (the shared-invariant tests above
    // already exclude W5 rows from the W4 gate/spec_ref/wave pins).
    const w5Rows = records.filter((record) => record.gates.includes("W5"));
    assert.deepEqual(w5Rows.map((record) => record.id).sort(), [...SECTION_W5_IDS].sort(),
      "the one W5 storm row must be present (US-014)");
    for (const record of w5Rows) {
      assert.equal(record.context?.execution_mode, "real",
        `${record.id}: the storm case must be execution_mode real (pending-real under bare --tier2, launchable with --include-real)`);
      assert.ok(Array.isArray(record.requires?.toolchains) && record.requires.toolchains.includes("node")
        && record.requires.toolchains.includes("python3"),
        `${record.id}: requires.toolchains must cover the capacity-scaled roster (node + python3)`);
      assert.ok(Array.isArray(record.requires?.capabilities) && record.requires.capabilities.includes("pi")
        && record.requires.capabilities.includes("hermes"),
        `${record.id}: requires.capabilities must cover the capacity-scaled roster (pi + hermes)`);
      assert.equal(record.fixture, "tt-poly-lite", `${record.id}: storm fixture must be tt-poly-lite`);
      assert.equal(record.seed, "storm", `${record.id}: storm seed must be "storm" (the composite seed/storm ref)`);
    }
  });
});
