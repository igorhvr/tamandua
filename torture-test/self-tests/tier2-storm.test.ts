// Tier-2 US-014: the wave-5 storm — the capacity-scaled two-round storm case
// (W5.storm-capacity-scaled) in cases/tier2.jsonl.
//
// The storm is authored as ONE REAL contract-pin row whose task file IS the
// full two-round briefing (spec 09-wave-5-storm.md): the Round A clean roster
// (S1–S10, 90s stagger, 44-timer queue math, the S5/S9 guaranteed-conflict
// overlap pair on the STORM-SENTINEL, 15s simultaneity sampling) + the Round
// B reduced roster (B1–B5 with the chaos schedule: read-path pounding, nudge
// storm, pause/resume, worker kill, dirty-PARK bait, guaranteed-conflict
// colleague commit, stop+delete under load, mass rugpull, daemon bounce).
// The row is execution_mode real on fixture tt-poly-lite with seed "storm"
// (the composite seed/storm ref documented in the fixture's SEEDS.md +
// seeds/storm/STORM.md), gates [TIER2, W5], and requires covering the
// capacity-scaled roster (toolchains node+python3, capabilities pi+hermes,
// node_min 22) so bare --tier2 marks it pending-real (GREEN) and
// --include-real can launch it.
//
// The storm's multi-run ORCHESTRATOR (launch stagger, simultaneity sampler,
// queue admission, Round B chaos dispatch) is controller machinery beyond
// this roster-authoring scope (12-runner-automation) — the case PINS the
// roster + success bands + check contract, and the tier2-traceability
// exclusion list carries the explicit machinery-gap row (case -> spec
// section -> reason). The Round B chaos schedule lives in the briefing as a
// dispatch contract, NOT as a typed manifest chaos block (`chaos: null`).
//
// Zero-token by construction: manifest assertions are pure file reads +
// --validate-only; the pending-real leg runs the controller with
// --scripted-only over a scratch manifest of the VERBATIM storm row under a
// synthesized host-profile that satisfies the capacity-scaled requires —
// never a workflow launch, no model, no daemon. The synthesized profile is
// restored to the honest W0.0 profile in `finally` (the standard
// one-file-per-invocation host-profile pattern).
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
const hostProfilePath = path.join(ttRoot, "var", "w0", "host-profile.json");

const CAMPAIGN_LINE = /^Campaign:\s+(campaign-[^\s]+)$/m;

// The one W5 storm row (US-014). A REAL contract-pin case: execution_mode
// real, fixture tt-poly-lite, seed "storm" (the composite seed/storm ref),
// harness pi + workflow feature-dev-merge-worktree (the storm's dominant
// family and the capacity-scaled variant's lead run), gates [TIER2, W5].
const STORM_IDS = ["W5.storm-capacity-scaled"];

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Spawn env for the controller: the operator env minus NODE_TEST_CONTEXT
// (node:test sets it in every test process, which would auto-arm the tamandua
// TEST ISOLATION guard inside the controller's spawned children) with
// TAMANDUA_TEST_GUARD explicitly disabled, and the harness binaries pinned to
// /bin/false so an accidental real launch can never spend tokens.
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    ...process.env,
    TAMANDUA_TEST_GUARD: "0",
    TAMANDUA_PI_BINARY: "/bin/false",
    TAMANDUA_HERMES_BINARY: "/bin/false",
    TAMANDUA_DSH_BINARY: "/bin/false",
  };
  delete env.NODE_TEST_CONTEXT;
  return { ...env, ...extra };
}

function runTt(script: string, args: string[], env: Record<string, string> = {}): RunResult {
  const res = spawnSync(process.execPath, [script, ...args], {
    cwd: ttRoot,
    encoding: "utf8",
    timeout: 300_000,
    env: childEnv(env),
  });
  return {
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
}

function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

type Case = Record<string, any>;

function readManifest(): Case[] {
  return fs
    .readFileSync(manifestPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function stormRows(): Case[] {
  return readManifest().filter((record) => record.gates.includes("W5"));
}

function stormRow(): Case {
  const rows = stormRows();
  assert.equal(rows.length, 1, `exactly the one W5 storm row must exist (got ${rows.map((r) => r.id).join(", ")})`);
  return rows[0];
}

// A synthesized host-profile satisfying the storm row's capacity-scaled
// requires: platform linux, toolchains node + python3 (the tt-poly-lite
// roster), node >= 22 via nodeRuntimes, and harness pi + hermes present (the
// capacity-scaled roster runs fdmw(pi), bfmw(hermes), quarantine-mw(pi),
// do-now(pi)). W0.0's honest profile is restored in the test's finally block.
function writeSynthesizedProfile(): void {
  const profile = {
    platform: { os: "linux", arch: "arm64", release: "0.0.0", label: "linux" },
    containment: { systemdUserScope: true },
    toolchains: {
      node: { present: true, buildPassed: null, testPassed: null, evidence: "synthesized" },
      python3: { present: true, buildPassed: null, testPassed: null, evidence: "synthesized" },
    },
    capabilities: { "node-runtimes-2": true },
    nodeRuntimes: [{ version: "v24.0.0", major: 24, minor: 0, patch: 0, sqliteAvailable: true }],
    harness: {
      pi: { present: true, authenticated: null, skipReason: "synthesized" },
      hermes: { present: true, authenticated: null, skipReason: "synthesized" },
      dsh: { present: true, authenticated: null, skipReason: "synthesized" },
    },
  };
  fs.writeFileSync(hostProfilePath, `${JSON.stringify(profile, null, 2)}\n`);
}

// A scratch manifest containing the VERBATIM storm row (copied from
// cases/tier2.jsonl so the pending-real leg tests the REAL roster shape). The
// name carries a monotonic counter so two manifests written in the same
// millisecond never collide (Date.now() alone is not unique enough).
let scratchCounter = 0;
function writeScratchManifest(records: Case[]): string {
  scratchCounter += 1;
  const name = `US014-${Date.now()}-${process.pid}-${scratchCounter}.jsonl`;
  const scratchPath = path.join(ttRoot, "var", name);
  fs.writeFileSync(scratchPath, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return scratchPath;
}

function campaignIdOf(res: RunResult): string | null {
  const m = CAMPAIGN_LINE.exec(res.stdout);
  return m === null ? null : m[1];
}

function loadCampaignState(campaignId: string): any {
  const statePath = path.join(ttRoot, "var", "results", campaignId, "state.json");
  assert.ok(fs.existsSync(statePath), `campaign state not found: ${statePath}`);
  return loadJson(statePath);
}

describe("Tier-2 W5 storm (US-014) — the capacity-scaled two-round storm contract-pin case", () => {
  it("the W5 storm row exists with execution_mode real, fixture tt-poly-lite, seed storm, gates [TIER2,W5], requires covering the capacity-scaled roster, and --validate-only exits 0", () => {
    const row = stormRow();
    // AC1: seed field is "storm" (the composite seed/storm ref).
    assert.equal(row.seed, "storm", "the storm row's seed must be \"storm\" (the composite seed/storm ref)");
    // AC2: requires cover the capacity-scaled roster.
    assert.ok(Array.isArray(row.requires?.toolchains)
      && row.requires.toolchains.includes("node")
      && row.requires.toolchains.includes("python3"),
      "requires.toolchains must cover the capacity-scaled roster (node + python3 — the tt-poly-lite subtrees)");
    assert.ok(Array.isArray(row.requires?.capabilities)
      && row.requires.capabilities.includes("pi")
      && row.requires.capabilities.includes("hermes"),
      "requires.capabilities must cover the capacity-scaled roster (pi + hermes — the roster's harness mix)");
    assert.equal(row.requires?.node_min, 22, "requires.node_min must be 22 (node >= 22, the tt-poly-lite requirement)");
    // AC2: the case is execution_mode real with gates [TIER2, W5].
    assert.equal(row.context?.execution_mode, "real", "the storm case must be execution_mode real");
    assert.deepEqual(row.gates, ["TIER2", "W5"], "the storm case gates must be [TIER2, W5]");
    assert.equal(row.wave, 5, "the storm case wave must be 5");
    // The row is a real workflow-launching case: fixture + canonical test_cmd.
    assert.equal(row.fixture, "tt-poly-lite", "the storm fixture must be tt-poly-lite (the capacity-scaled storm monorepo)");
    assert.equal(row.context?.test_cmd, "./run-all-tests",
      "context.test_cmd must be the tt-poly-lite canonical TEST_CMD (./run-all-tests)");
    assert.equal(row.harness, "pi", "the storm row anchors on harness pi (the roster majority / capacity-scaled lead)");
    assert.equal(row.workflow, "feature-dev-merge-worktree",
      "the storm row anchors on feature-dev-merge-worktree (Round A's dominant family)");
    assert.equal(row.chaos, null,
      "the storm row carries chaos: null (Round B's chaos schedule is the orchestrator's dispatch contract — machinery delta)");
    assert.match(row.spec_ref, /^09-wave-5-storm\.md#/, "spec_ref must point into 09-wave-5-storm.md");
    // E3.D: the row pins the wave-level caps (the whole two-round storm) and
    // an honest corridor floor.
    assert.ok(row.caps.tokens >= 16000000, `caps.tokens must sit at the storm wave's hard cap (16M), got ${row.caps.tokens}`);
    assert.ok(row.caps.wall_min >= 720, `caps.wall_min must cover the 8h storm window + margin (720), got ${row.caps.wall_min}`);
    assert.ok(row.production_duration_floor_ms >= 28800000,
      `production_duration_floor_ms must sit at the honest two-round corridor floor (8h), got ${row.production_duration_floor_ms}`);
    // AC1: the manifest validates (exit 0).
    const res = runTt(controller, ["--manifest", "cases/tier2.jsonl", "--validate-only"]);
    assert.equal(res.status, 0, `tt-controller --validate-only must exit 0:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 70 case\(s\)/);
  });

  it("the seed/storm composite ref exists in the tt-poly-lite SEEDS.md catalog and the task file is the full two-round briefing (Round A roster, simultaneity sampling, queue admission snapshot, Round B chaos schedule, success bands)", () => {
    const row = stormRow();
    // AC1: the composite seed/storm ref is documented in tt-poly-lite
    // SEEDS.md (and its seeds/storm/STORM.md companion).
    const seedsMd = fs.readFileSync(path.join(ttRoot, "fixtures-src", "tt-poly-lite", "seeds", "SEEDS.md"), "utf8");
    assert.match(seedsMd, /seed\/storm/, "tt-poly-lite SEEDS.md must document the composite seed/storm ref");
    const stormMd = path.join(ttRoot, "fixtures-src", "tt-poly-lite", "seeds", "storm", "STORM.md");
    assert.ok(fs.existsSync(stormMd), "tt-poly-lite seeds/storm/STORM.md must exist (the composite ref's construction doc)");
    // AC3: the task file IS the storm briefing — it must contain the Round A
    // roster table (S1–S10), the 15s simultaneity-sampling contract, the
    // queue admission snapshot assertion, the Round B chaos schedule, and
    // the success bands.
    const taskPath = path.join(ttRoot, row.task);
    assert.ok(recordTaskIsRegular(row.task), `${row.id}: task file must exist as a regular file: ${row.task}`);
    const task = fs.readFileSync(taskPath, "utf8");
    assert.ok(task.trim().length > 0, "the storm briefing must be non-empty");
    // Round A roster table: the ten runs S1..S10 with their workflows.
    for (const run of ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10"]) {
      assert.match(task, new RegExp(`\\b${run}\\b`), `the briefing must name Round A run ${run}`);
    }
    assert.match(task, /storm-fdmw-1|storm-fdmw-2|storm-fdmw-3|storm-fdmw-4/, "the briefing must name the fdmw roster runs");
    assert.match(task, /storm-bfmw-1|storm-bfmw-2/, "the briefing must name the bfmw roster runs");
    assert.match(task, /storm-sec/, "the briefing must name the security-audit roster run");
    assert.match(task, /storm-quar/, "the briefing must name the quarantine roster run");
    assert.match(task, /storm-drdv/, "the briefing must name the do-review-do-verify roster run");
    assert.match(task, /storm-donow/, "the briefing must name the do-now queue-drain canary");
    assert.match(task, /90s stagger|90s/, "the briefing must pin the Round A launch stagger");
    assert.match(task, /TAMANDUA_MAX_ACTIVE_TIMERS\s*=\s*44|44-timer|44 timer/, "the briefing must pin the 44-timer queue math");
    assert.match(task, /STORM-SENTINEL/, "the briefing must name the S5/S9 STORM-SENTINEL guaranteed-conflict overlap pair");
    assert.match(task, /merge-tree/, "the briefing must pin the git merge-tree conflict pre-verification");
    // The 15s simultaneity-sampling contract (8-concurrent window or honest
    // reduced-peak report).
    assert.match(task, /every 15s|15s/, "the briefing must pin the 15s simultaneity sampling interval");
    assert.match(task, /8 roster runs|all 8 roster runs|8-concurrent|8 concurrent|all 8 runs/,
      "the briefing must pin the 8-concurrent simultaneity window");
    assert.match(task, /observed peak|reduced peak|honest reduced peak/,
      "the briefing must require the honest reduced-peak report when 8 is never reached");
    // The queue admission-decision correctness assertion (freeSlots snapshot
    // at S9/S10 admission).
    assert.match(task, /freeSlots/, "the briefing must pin the freeSlots admission snapshot");
    assert.match(task, /S9\/S10|S9 and S10/, "the briefing must pin the S9/S10 queued admissions");
    // Round B: the reduced roster (B1–B5) + the chaos schedule.
    for (const run of ["B1", "B2", "B3", "B4", "B5"]) {
      assert.match(task, new RegExp(`\\b${run}\\b`), `the briefing must name Round B run ${run}`);
    }
    assert.match(task, /nudge storm|Nudge storm/, "the briefing must pin the nudge storm");
    assert.match(task, /PARK bait|dirty.*PARK|Leave-dirty/, "the briefing must pin the dirty-PARK bait");
    assert.match(task, /mass rugpull|Mass rugpull/, "the briefing must pin the mass rugpull");
    assert.match(task, /read-path pounding|Read-path pounding/, "the briefing must pin the read-path pounding");
    assert.match(task, /colleague commit/, "the briefing must pin the colleague commits");
    assert.match(task, /daemon bounce|tamandua restart/, "the briefing must pin the daemon bounce");
    // The success bands.
    assert.match(task, /≥6 of the 8 merge-eligible|6 of the 8 merge-eligible|>=6 of 8/,
      "the briefing must pin the >=6-of-8 merge-eligible success band");
    assert.match(task, /conflict-designated|Conflict-designated/, "the briefing must assess conflict-designated runs separately");
    assert.match(task, /O2 union/, "the briefing must pin the O2 patch-id union check");
    assert.match(task, /O3z|token accounting|Token accounting/, "the briefing must pin token accounting");
    assert.match(task, /wedge deadline|Wedge deadline/, "the briefing must pin the wedge deadline");
    assert.match(task, /results\/w5/, "the briefing must pin the results/w5 forensics snapshot");
    assert.match(task, /broken-tests/, "the briefing must pin the quarantine lane's broken-tests target");
    assert.match(task, /capacity-scaled/, "the briefing must document the capacity-scaled scale-down");
    assert.match(task, /tt-poly-lite/, "the briefing must describe the tt-poly-lite fixture's actual contents");
  });

  it("bare --scripted-only marks the verbatim storm row NOT_RUN pending-real with zero tokens under a satisfying host-profile", () => {
    // AC2 at the ROSTER level, zero-token: with a synthesized host-profile
    // that satisfies the capacity-scaled requires (node+python3, pi+hermes,
    // node 22), the controller's execution selection (applied BEFORE
    // predicates) marks the REAL storm row pending-real under bare
    // --scripted-only — GREEN, never executed, zero tokens.
    const row = stormRow();
    const scratchManifestPath = writeScratchManifest([row]);
    const campaignIds: string[] = [];
    try {
      writeSynthesizedProfile();
      const res = runTt(controller, ["--manifest", path.relative(ttRoot, scratchManifestPath), "--scripted-only"]);
      const campaignId = campaignIdOf(res);
      assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);
      campaignIds.push(campaignId);
      const state = loadCampaignState(campaignId);
      const caseState = state.cases.find((c: any) => c.id === row.id);
      assert.ok(caseState, `${row.id} missing from campaign state`);
      assert.equal(caseState.outcome, "NOT_RUN", `${row.id}: bare --scripted-only -> NOT_RUN`);
      assert.equal(caseState.reason?.category, "pending-real",
        `${row.id}: a real storm case under --scripted-only is pending-real (never executed as scripted)`);
      assert.equal(state.spend.tokens_observed, 0, "bare --scripted-only must spend zero tokens");
      assert.equal(caseState.spend.tokens_observed, 0, "the storm case must spend zero tokens under bare --scripted-only");
    } finally {
      fs.rmSync(scratchManifestPath, { force: true });
      for (const campaignId of campaignIds) {
        fs.rmSync(path.join(ttRoot, "var", "results", campaignId), { recursive: true, force: true });
      }
      // Restore the honest W0.0 profile so sibling tests see truth.
      runTt(path.join(ttRoot, "bin", "tt-verify-environment"), ["--fast", "--json"]);
    }
  });

  it("traceability carries the W5 storm rows: reference map, exclusion enumeration with the orchestrator machinery delta (case -> spec section -> reason), and token budget note", () => {
    const trace = fs.readFileSync(traceabilityPath, "utf8");
    // AC5: traceability rows appended for section W5.
    for (const id of STORM_IDS) {
      assert.match(trace, new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `traceability must carry a row for ${id}`);
    }
    assert.match(trace, /## Case ↔ Spec Reference Map — Wave 5 storm/,
      "traceability must carry the W5 storm reference-map section");
    assert.match(trace, /W5\.storm-capacity-scaled/, "the W5 map row must name the storm case");
    assert.match(trace, /09-wave-5-storm\.md/, "the W5 rows must reference spec 09-wave-5-storm.md");
    // AC4: the exclusion list documents the storm-orchestrator machinery
    // delta (case -> spec section -> reason) — no silent trim.
    assert.match(trace, /## Excluded Scenarios — Complete Enumeration \(wave-5 storm\)/,
      "traceability must carry the W5 exclusion enumeration");
    assert.match(trace, /MACHINERY GAP|machinery-gap|multi-run ORCHESTRATOR|multi-run orchestrator/,
      "the exclusion row must document the storm-orchestrator machinery gap");
    assert.match(trace, /12-runner-automation/,
      "the exclusion row must point at the 12-runner-automation machinery gap");
    assert.match(trace, /case -> spec section -> reason|Spec Section \| Reason/,
      "the exclusion enumeration must follow the case -> spec section -> reason format");
    assert.match(trace, /never a silent trim|Never a silent trim|zero silent trims/,
      "the exclusion row must assert zero silent trims");
    // The machinery-deltas table carries the same gap.
    assert.match(trace, /W5\.storm-capacity-scaled/, "the machinery-deltas table must name the storm row");
    // The manifest summary counts the storm row.
    assert.match(trace, /Total Tier-2 cases \(sections A \+ B \+ G \+ C1 \+ C2 \+ D \+ E \+ F \+ H \+ I \+ J \+ K \+ dsh lane \+ W5 storm\) \| \*\*70\*\*/,
      "manifest summary must show 70 cases incl. the W5 storm");
    assert.match(trace, /\| Real \(token-bearing\) cases \| 45 \|/,
      "manifest summary must show 45 real cases (the storm row is real)");
    assert.match(trace, /Wave 5 storm \(capacity-scaled, two-round briefing\) \| 1 \(W5\.storm-capacity-scaled\)/,
      "manifest summary must list the W5 storm row");
    assert.match(trace, /## Token Budget Note \(wave-5 storm\)/,
      "traceability must carry the wave-5 storm token budget note");
  });
});

function recordTaskIsRegular(task: string): boolean {
  const taskPath = path.join(ttRoot, task);
  const details = fs.lstatSync(taskPath, { throwIfNoEntry: false });
  return details?.isFile() === true && details.isSymbolicLink() === false;
}
