// S29 (US-003) — fail-closed trigger-vocabulary preflight.
//
// Arming a probe `when` / chaos `trigger` whose event/step/agent name is not
// in the KNOWN VOCABULARY is an immediate scenario error (distinct
// machine-parseable reason) instead of a 4–8-minute silent
// probe-trigger-unreached / chaos-invocation-failed wait. The known
// vocabulary is the case's workflow spec steps/agents
// (workflows/<workflow-id>/workflow.yml) plus the pinned product event/status
// vocabularies (bin/tt-trigger-vocabulary.mjs).
//
// This test proves:
//   * RED-ARM (AC1): `tt-controller --validate-only` on a manifest copy with
//     `step:developer:running` on a bug-fix-merge-worktree case fails
//     IMMEDIATELY with `unknown-probe-trigger: step:developer:running not in
//     workflow bug-fix-merge-worktree step/agent vocabulary` (no polling —
//     --validate-only is a pure preflight);
//   * RED-ARM (AC4): an unknown event name (`event:run.does_not_exist`) fails
//     closed immediately with `unknown-probe-trigger` / `unknown-chaos-trigger`;
//   * RED-ARM: the launch preflight (probeSequenceGuard / chaosGuard) fails
//     the case closed as TEST_INFRA_FAIL before any launch attempt — never a
//     silent wait;
//   * GREEN-ARM (AC3): the real tier2.jsonl (post US-002/US-003 calibration)
//     validates clean with no unknown-trigger errors;
//   * GREEN-ARM (AC2): the vocabulary derives step/agent ids from the
//     workflow spec and includes the pinned product event names.
//
// Confined to torture-test/ (writes only under gitignored var/ + os.tmpdir).
// Zero tokens (TAMANDUA_PI_BINARY/HERMES stubbed to /bin/false for the
// guard-campaign tests, which never reach a launch). Follows the
// tier2-*.test.ts self-test pattern; picked up by self-tests/run.sh's tier2
// glob automatically.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const varRoot = path.join(ttRoot, "var");
const resultsRoot = path.join(varRoot, "results");
const controller = path.join(ttRoot, "bin", "tt-controller");
const TIER2 = path.join(ttRoot, "cases", "tier2.jsonl");
const BFM_WORKFLOW_YAML = path.join(repoRoot, "workflows", "bug-fix-merge-worktree", "workflow.yml");
const FDM_WORKFLOW_YAML = path.join(repoRoot, "workflows", "feature-dev-merge-worktree", "workflow.yml");
const CAMPAIGN_LINE = /^Campaign:\s+(campaign-[A-Za-z0-9._-]+)$/m;

// node:test marks descendant processes; drop NODE_TEST_CONTEXT so the
// TAMANDUA_TEST_GUARD live-state protection does not auto-activate for the
// spawned controller. /bin/false backstops guard against any accidental real
// model invocation (the guard-failing cases never reach a launch).
const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
};

type CommandResult = { status: number | null; stdout: string; stderr: string };

function run(file: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}, timeout = 300_000): CommandResult {
  const result = spawnSync(file, args, {
    cwd: repoRoot,
    env: { ...env, ...extraEnv },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout,
  });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function runValidate(manifestPath: string): CommandResult {
  return run(controller, ["--manifest", manifestPath, "--validate-only"]);
}

function readRecords(manifestPath: string): Record<string, any>[] {
  return fs.readFileSync(manifestPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function recordById(id: string, manifestPath = TIER2): Record<string, any> {
  const record = readRecords(manifestPath).find((item) => item.id === id);
  assert.ok(record, `manifest must contain case ${id}`);
  return JSON.parse(JSON.stringify(record));
}

// Build a single-case manifest under a temp dir inside torture-test/var (the
// controller refuses manifests that escape torture-test/). The base is a deep
// copy of a tier2 record; field overrides are applied on top. Returns the
// temp dir so the caller can clean it up.
function buildCaseManifest(baseId: string, overrides: Record<string, unknown>): { dir: string; manifest: string } {
  const dir = fs.mkdtempSync(path.join(varRoot, "s29-vocab-preflight-"));
  const base = recordById(baseId);
  Object.assign(base, overrides);
  const manifest = path.join(dir, "case.jsonl");
  fs.writeFileSync(manifest, `${JSON.stringify(base)}\n`);
  return { dir, manifest };
}

// Assert --validate-only REJECTS the manifest (exit 2) with a distinct
// machine-parseable reason matching the needle — immediately, no polling.
function expectRejected(label: string, baseId: string, overrides: Record<string, unknown>, needle: RegExp): void {
  const built = buildCaseManifest(baseId, overrides);
  try {
    const res = runValidate(built.manifest);
    assert.equal(res.status, 2, `${label} must exit 2 (validation failure):\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout + res.stderr, needle, `${label} must name a distinct reason matching ${needle}`);
  } finally {
    fs.rmSync(built.dir, { recursive: true, force: true });
  }
}

describe("S29 (US-003) — fail-closed trigger-vocabulary preflight", () => {
  it("RED-ARM (AC1): step:developer:running on a bfmw case fails --validate-only immediately with unknown-probe-trigger", () => {
    expectRejected(
      "unknown probe step/agent role on bfmw",
      "W4.33a-daemon-restart-resume",
      {
        probe_sequence: [{
          run: 1,
          actions: [
            { op: "pause_drain", when: "step:developer:running", hold_seconds: 600 },
            { op: "resume", when: "now" },
          ],
        }],
      },
      /unknown-probe-trigger: step:developer:running not in workflow bug-fix-merge-worktree step\/agent vocabulary/,
    );
  });

  it("RED-ARM (AC4): an unknown event name (event:run.does_not_exist) fails closed immediately", () => {
    expectRejected(
      "unknown probe event",
      "W4.33d-reroute-exhaustion-resume",
      {
        probe_sequence: [{
          run: 1,
          actions: [{ op: "resume", when: "event:run.does_not_exist" }],
        }],
      },
      /unknown-probe-trigger: event:run.does_not_exist not in product event vocabulary/,
    );
  });

  it("RED-ARM: a chaos trigger naming a role outside the workflow vocabulary fails with unknown-chaos-trigger", () => {
    expectRejected(
      "unknown chaos step/agent role on bfmw",
      "W4.09-pi-kill-harness",
      { chaos: { type: "kill-harness", target: "harness_process", trigger: "step:developer:running", signal: "SIGKILL", operator: "tt-chaos" } },
      /unknown-chaos-trigger: step:developer:running not in workflow bug-fix-merge-worktree step\/agent vocabulary/,
    );
  });

  it("RED-ARM: a chaos trigger naming an unknown event (event:merge.parked) fails with unknown-chaos-trigger", () => {
    // merge.parked is NOT a product event (the pinned vocabulary derives from
    // the contained product's emitters) — the preflight rejects it instead of
    // arming a marker that can never fire.
    expectRejected(
      "unknown chaos event",
      "W4.48a-daemon-kill-mid-park",
      { chaos: { type: "kill-daemon", target: "daemon_process", trigger: "event:merge.parked", signal: "SIGKILL", operator: "tt-chaos" } },
      /unknown-chaos-trigger: event:merge.parked not in product event vocabulary/,
    );
  });

  it("RED-ARM: an unknown step state fails closed (state is part of the marker vocabulary)", () => {
    expectRejected(
      "unknown step state",
      "W4.33a-daemon-restart-resume",
      {
        probe_sequence: [{
          run: 1,
          actions: [
            { op: "pause_drain", when: "step:fixer:banana", hold_seconds: 600 },
            { op: "resume", when: "now" },
          ],
        }],
      },
      /unknown-probe-trigger: step:fixer:banana state 'banana' not in step status vocabulary/,
    );
  });

  it("RED-ARM: object-form awaited triggers check the event/status vocabulary too", () => {
    expectRejected(
      "unknown object event",
      "W4.33d-reroute-exhaustion-resume",
      {
        probe_sequence: [{
          run: 1,
          actions: [{ op: "resume", when: { event: "run.does_not_exist", timeout_s: 5 } }],
        }],
      },
      /unknown-probe-trigger: event "run\.does_not_exist" not in product event vocabulary/,
    );
    expectRejected(
      "unknown object status",
      "W4.33d-reroute-exhaustion-resume",
      {
        probe_sequence: [{
          run: 1,
          actions: [{ op: "resume", when: { status: "pausd", timeout_s: 5 } }],
        }],
      },
      /unknown-probe-trigger: status "pausd" not in run status vocabulary/,
    );
  });

  it("RED-ARM: a case whose declared workflow has no resolvable spec fails with unknown-workflow-spec", () => {
    expectRejected(
      "missing workflow spec",
      "W4.33a-daemon-restart-resume",
      {
        workflow: "no-such-workflow-xyz",
        probe_sequence: [{
          run: 1,
          actions: [
            { op: "pause_drain", when: "step:fixer:running", hold_seconds: 600 },
            { op: "resume", when: "now" },
          ],
        }],
      },
      /unknown-workflow-spec: workflow "no-such-workflow-xyz" spec not found/,
    );
  });

  it("RED-ARM: launch preflight fails the case closed (TEST_INFRA_FAIL) BEFORE any launch attempt — never a silent wait", () => {
    // The execute path runs probeSequenceGuard FIRST: an unknown-trigger case
    // is persisted TEST_INFRA_FAIL(probe-sequence-invalid) on a launch-intent
    // attempt with the distinct unknown-probe-trigger reason — no launch
    // hook, no polling, no 8-minute wait.
    const built = buildCaseManifest("W4.33a-daemon-restart-resume", {
      id: "T-S29-VOCAB-GUARD",
      context: { execution_mode: "scripted", test_cmd: "npm test" },
      requires: {},
      oracles: [],
      probe_sequence: [{
        run: 1,
        actions: [
          { op: "pause_drain", when: "step:developer:running", hold_seconds: 600 },
          { op: "resume", when: "now" },
        ],
      }],
    });
    let campaignId: string | null = null;
    try {
      // TT_CONTROLLER_PREFLIGHT_DISABLED=1: the guard-failing case never
      // reaches a launch, so the scripted-state-reset preflight must not
      // engage (keeps this test from colliding with other campaign tests
      // that share var/home-scripted; the per-case guards are execution
      // logic, not preflight).
      const res = run(controller, ["--manifest", built.manifest, "--scripted-only"], { TT_CONTROLLER_PREFLIGHT_DISABLED: "1" });
      const m = CAMPAIGN_LINE.exec(res.stdout);
      campaignId = m === null ? null : m[1];
      assert.ok(campaignId, `campaign must be recorded:\n${res.stdout}\n${res.stderr}`);
      const state = JSON.parse(fs.readFileSync(path.join(resultsRoot, campaignId!, "state.json"), "utf8"));
      const item = state.cases[0];
      assert.equal(item.id, "T-S29-VOCAB-GUARD");
      assert.equal(item.phase, "terminal");
      assert.equal(item.outcome, "TEST_INFRA_FAIL");
      assert.equal(item.reason?.category, "probe-sequence-invalid");
      assert.match(item.reason?.message ?? "", /unknown-probe-trigger: step:developer:running/);
      assert.equal(item.attempts.length, 1, "exactly one launch-intent guard attempt must be persisted");
      const attempt = item.attempts[0];
      assert.equal(attempt.phase, "terminal");
      assert.equal(attempt.outcome, "TEST_INFRA_FAIL");
      assert.equal(attempt.launch, undefined, "no launch hook may exist — no launch attempt was created");
      const errors = attempt.probe_sequence_guard?.errors as string[] | undefined;
      assert.ok(Array.isArray(errors) && errors.length === 1,
        `guard attempt must carry exactly the unknown-trigger semantic error: ${JSON.stringify(errors)}`);
      assert.match(errors[0], /unknown-probe-trigger: step:developer:running not in workflow bug-fix-merge-worktree/);
    } finally {
      if (campaignId !== null) fs.rmSync(path.join(resultsRoot, campaignId), { recursive: true, force: true });
      fs.rmSync(built.dir, { recursive: true, force: true });
    }
  });

  it("RED-ARM: launch preflight fails a chaos block with an unknown trigger closed (chaos-block-invalid)", () => {
    const built = buildCaseManifest("W4.09-pi-kill-harness", {
      id: "T-S29-VOCAB-CHAOS-GUARD",
      context: { execution_mode: "scripted", test_cmd: "npm test" },
      requires: {},
      oracles: [],
      chaos: { type: "kill-harness", target: "harness_process", trigger: "step:developer:running", signal: "SIGKILL", operator: "tt-chaos" },
    });
    let campaignId: string | null = null;
    try {
      const res = run(controller, ["--manifest", built.manifest, "--scripted-only"], { TT_CONTROLLER_PREFLIGHT_DISABLED: "1" });
      const m = CAMPAIGN_LINE.exec(res.stdout);
      campaignId = m === null ? null : m[1];
      assert.ok(campaignId, `campaign must be recorded:\n${res.stdout}\n${res.stderr}`);
      const state = JSON.parse(fs.readFileSync(path.join(resultsRoot, campaignId!, "state.json"), "utf8"));
      const item = state.cases[0];
      assert.equal(item.id, "T-S29-VOCAB-CHAOS-GUARD");
      assert.equal(item.outcome, "TEST_INFRA_FAIL");
      assert.equal(item.reason?.category, "chaos-block-invalid");
      assert.match(item.reason?.message ?? "", /unknown-chaos-trigger: step:developer:running/);
      assert.equal(item.attempts.length, 1);
      assert.equal(item.attempts[0].launch, undefined, "no launch hook may exist — the chaos guard failed before launch");
      const errors = item.attempts[0].chaos_guard?.errors as string[] | undefined;
      assert.ok(Array.isArray(errors) && errors.some((e) => e.includes("unknown-chaos-trigger: step:developer:running")),
        `chaos guard must carry the unknown-chaos-trigger reason: ${JSON.stringify(errors)}`);
    } finally {
      if (campaignId !== null) fs.rmSync(path.join(resultsRoot, campaignId), { recursive: true, force: true });
      fs.rmSync(built.dir, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM (US-004): the premise-redesign cells carry the typed move-branch chaos injection and validate clean", () => {
    // US-004 (S29 premise redesign) wires the colleague target-move as a TYPED
    // move-branch chaos block the controller actually executes (previously
    // chaos: null — the injection never ran, so event:run.failed /
    // event:merge.target_moved never fired). The probe `when` triggers stay
    // armed on the REAL premise events; the chaos block makes them reachable.
    const records = readRecords(TIER2);
    for (const id of ["W4.33d-reroute-exhaustion-resume", "W4.48b-pause-rugpull-window"]) {
      const record = records.find((item) => item.id === id);
      assert.ok(record, `${id} must exist`);
      const chaos = record.chaos;
      assert.ok(chaos && typeof chaos === "object", `${id}: the redesigned corridor must carry a chaos block`);
      assert.equal(chaos.type, "move-branch", `${id}: the typed injection must be move-branch`);
      assert.equal(chaos.target, "origin_target_ref", `${id}: move-branch targets the origin target ref`);
      assert.equal(chaos.operator, "tt-chaos", `${id}: the operator must be tt-chaos`);
      // The target ref is the branch the merger merges into: the SEEDED
      // branch for seeded tt-ts cells (seed/BUG-T4 for BUG-T4, seed/BUG-T2
      // for BUG-T2) — not main.
      const expectedRef = id === "W4.33d-reroute-exhaustion-resume"
        ? "refs/heads/seed/BUG-T4"
        : "refs/heads/seed/BUG-T2";
      assert.equal(chaos.ref, expectedRef, `${id}: the target ref must be ${expectedRef} (the merger's merge target)`);
      assert.equal(chaos.trigger, "step:finalize_merge:running",
        `${id}: the injection arms on the finalize step (the wave-4 discipline)`);
      assert.ok(Number.isSafeInteger(chaos.repeat) && chaos.repeat > 1,
        `${id}: the persistent-move budget must be declared (repeat > 1)`);
      assert.ok(Number.isSafeInteger(chaos.interval_s) && chaos.interval_s > 0,
        `${id}: the move interval must be declared`);
      assert.ok(Number.isSafeInteger(chaos.wait_timeout_s) && chaos.wait_timeout_s > 0,
        `${id}: the phase-marker wait bound must be declared (the trigger is minutes into the run)`);
      assert.notEqual(chaos.trigger, "step:developer:running",
        `${id}: the chaos trigger must not carry the wrong-vocabulary marker`);
    }
    // The real manifest still validates clean under the preflight.
    const res = runValidate(TIER2);
    assert.equal(res.status, 0, `tier2 manifest must validate clean:\n${res.stdout}${res.stderr}`);
  });

  it("GREEN-ARM (AC3): the real tier2.jsonl validates clean with no unknown-trigger errors", () => {
    const res = runValidate(TIER2);
    assert.equal(res.status, 0, `tier2 manifest must validate clean:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 70 case\(s\)/);
    assert.doesNotMatch(res.stdout + res.stderr, /unknown-(probe|chaos)-trigger/,
      "no unknown-trigger errors may remain in the calibrated manifest");
    assert.doesNotMatch(res.stdout + res.stderr, /unknown-workflow-spec/,
      "every declared workflow must resolve to a spec");
  });

  it("GREEN-ARM (AC2): the vocabulary derives step/agent ids from the workflow spec and includes the pinned product events", async () => {
    const mod = await import(path.join(ttRoot, "bin", "tt-trigger-vocabulary.mjs"));
    const bfmw = mod.workflowVocabularyFor("bug-fix-merge-worktree");
    assert.deepEqual(bfmw.steps, ["triage", "investigate", "setup", "fix", "verify", "finalize_merge"],
      "bfmw step ids from workflows/bug-fix-merge-worktree/workflow.yml");
    assert.deepEqual(bfmw.agents, ["triager", "investigator", "setup", "fixer", "verifier", "merger"],
      "bfmw agent ids from the workflow spec");
    const fdmw = mod.workflowVocabularyFor("feature-dev-merge-worktree");
    assert.ok(fdmw.agents.includes("developer"), "fdmw must have the developer agent (step:developer:running is valid there)");
    assert.ok(fdmw.steps.includes("implement"), "fdmw must have the implement step");
    // The pinned product event vocabulary (derived from the contained
    // product's emitters) covers every family the story names.
    for (const name of [
      "run.started", "run.failed", "run.completed", "run.canceled", "run.paused",
      "run.process_cleanup", "merge.target_moved", "merge.landed", "merge.conflicts",
      "step.running", "step.done", "step.pending", "step.failed", "pipeline.advanced",
    ]) {
      assert.ok(mod.PRODUCT_EVENT_VOCABULARY.includes(name), `pinned event vocabulary must include ${name}`);
    }
    // Namespace families (dispatch.*, story.*, rugpull.*, ...) are covered by
    // the substring satisfier — every namespace the story names must have at
    // least one real emitted member in the pinned list.
    for (const namespace of ["dispatch", "story", "rugpull"]) {
      assert.ok(mod.PRODUCT_EVENT_VOCABULARY.some((name: string) => name.startsWith(`${namespace}.`)),
        `pinned vocabulary must carry the ${namespace}.* family`);
    }
    // The runtime satisfier contract: event:<type> fires on a SUBSTRING match,
    // so a marker is rejectable iff no pinned name contains it.
    assert.equal(mod.stringMarkerVocabularyError("event:merge.target_moved", "bug-fix-merge-worktree", bfmw, "probe"), null,
      "a REAL product event (premise question, not vocabulary) must pass");
    assert.equal(mod.stringMarkerVocabularyError("event:run.failed", "bug-fix-merge-worktree", bfmw, "probe"), null,
      "run.failed is real product vocabulary — W4.33d is premise redesign, not a vocabulary error");
  });

  it("GREEN-ARM: the calibrated manifest arms the US-003 chaos/dsh cells on step:fixer:running (bfmw vocabulary)", () => {
    // US-003's preflight surfaced FOUR more wrong-vocabulary markers beyond
    // US-002's three probe cells: the W4.09 × 2 / W4.10-kill-daemon chaos
    // triggers and W4.dsh-lifecycle's probe trigger were ALL still
    // `step:developer:running` on bug-fix-merge-worktree. They are calibrated
    // to the bfmw coding step (agent-role spelling, same convention as
    // US-002), so the real manifest validates clean under the preflight.
    const records = readRecords(TIER2);
    for (const id of ["W4.09-pi-kill-harness", "W4.09-hermes-kill-harness", "W4.10-kill-daemon"]) {
      const record = records.find((item) => item.id === id);
      assert.ok(record, `${id} must exist`);
      assert.equal(record.workflow, "bug-fix-merge-worktree", `${id} must be bfmw`);
      assert.equal(record.chaos.trigger, "step:fixer:running",
        `${id} chaos trigger must arm on the bfmw coding step after the US-003 calibration`);
      assert.notEqual(record.chaos.trigger, "step:developer:running",
        `${id}: step:developer:running must be gone (not bfmw vocabulary)`);
    }
    const dshLifecycle = records.find((item) => item.id === "W4.dsh-lifecycle");
    assert.ok(dshLifecycle, "W4.dsh-lifecycle must exist");
    assert.equal(dshLifecycle.probe_sequence[0].actions[0].when, "step:fixer:running",
      "W4.dsh-lifecycle pause_drain must arm on step:fixer:running after the US-003 calibration");
    assert.notEqual(dshLifecycle.probe_sequence[0].actions[0].when, "step:developer:running",
      "W4.dsh-lifecycle: step:developer:running must be gone");
  });
});
