// Tier-2 US-003: typed chaos block extended to the tt-chaos kill/delete
// actions (kill-harness, kill-daemon, delete-tstx-row).
//
// Wave-4 spec scenarios (W4.01, W4.04a, W4.09, W4.10, W4.36, ...) require
// kill -9 and TSTX-row-deletion injections that bin/tt-chaos already
// implements (kill-harness, kill-daemon, delete-tstx-row), but the manifest
// chaos block could only express sigstop_sigcont. This file pins the
// extension:
//   * case.schema.json chaosBlock accepts the three new types with per-type
//     targets (kill-harness -> harness_process, kill-daemon ->
//     daemon_process, delete-tstx-row -> tstx_row); hold_seconds is
//     sigstop_sigcont-only and signal is kill-only (default SIGKILL); an
//     unknown type, unknown property, or a param the type does not take is
//     still REJECTED fail-closed;
//   * tt-controller --validate-only accepts a kill-harness block (exit 0)
//     and rejects per-type violations (wrong target, hold_seconds on a kill
//     action, signal on sigstop_sigcont, delete-tstx-row without tree) as
//     well as a delete-tstx-row block on a local-command case;
//   * buildChaosArgv emits tt-chaos <type> --run <id> --when <marker> with
//     --signal for kill actions and --hold-seconds only for sigstop_sigcont,
//     and the chaos evidence records the declared signal/tree;
//   * TT_DRY_RUN_REAL_LAUNCH PASSes on a kill-chaos case (zero tokens).
//
// Confined to torture-test/ (writes only under gitignored var/). Zero tokens.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const schemaPath = path.join(ttRoot, "cases", "case.schema.json");
const controller = path.join(ttRoot, "bin", "tt-controller");
const varRoot = path.join(ttRoot, "var");
const CAMPAIGN_LINE = /^Campaign:\s+(campaign-[^\s]+)$/m;

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

type RunResult = { status: number | null; stdout: string; stderr: string };

function run(file: string, args: string[], extraEnv: Record<string, string> = {}, timeout = 300_000): RunResult {
  const result = spawnSync(file, args, {
    cwd: repoRoot,
    env: { ...env, ...extraEnv },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout,
  });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function runValidate(manifestPath: string): RunResult {
  return run(controller, ["--manifest", manifestPath, "--validate-only"]);
}

function readSchema(): Record<string, any> {
  return JSON.parse(fs.readFileSync(schemaPath, "utf8"));
}

// Build a single-case manifest under a temp dir inside torture-test/var (the
// controller refuses manifests that escape torture-test/). The base is a real
// workflow case (pi harness, bug-fix-merge-worktree, tt-ts fixture); field
// overrides are applied on top.
function buildCaseManifest(overrides: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(varRoot, "us003-chaos-schema-"));
  const base: Record<string, any> = {
    id: "T2-US003-CHOKE",
    wave: 4,
    workflow: "bug-fix-merge-worktree",
    fixture: "tt-ts",
    harness: "pi",
    task: "cases/tasks/tier2/T2-US003-CHOKE.md",
    context: { execution_mode: "real", test_cmd: "npm test" },
    caps: { tokens: 4000000, wall_min: 240 },
    requires: { toolchains: ["node"], node_min: 22 },
    boundary_files: ["fixtures-src/tt-ts/src"],
    forbidden: ["fixtures-src/tt-ts/operator-notes.local"],
    oracles: [],
    gates: ["TIER2", "W4"],
    chaos: null,
    shed_ok: false,
    mandatory: true,
    class: "verification",
    spec_ref: "08-wave-4-fault-injection.md#W4.09",
    production_duration_floor_ms: 60000,
  };
  Object.assign(base, overrides);
  const manifest = path.join(dir, "case.jsonl");
  fs.writeFileSync(manifest, `${JSON.stringify(base)}\n`);
  return manifest;
}

// Assert a manifest is ACCEPTED by --validate-only (exit 0).
function expectAccepted(label: string, overrides: Record<string, unknown>): void {
  const manifest = buildCaseManifest(overrides);
  try {
    const res = runValidate(manifest);
    assert.equal(res.status, 0, `${label} must validate:\n${res.stdout}${res.stderr}`);
  } finally {
    fs.rmSync(path.dirname(manifest), { recursive: true, force: true });
  }
}

// Assert a manifest is REJECTED by --validate-only (exit 2) with a reason
// matching the needle.
function expectRejected(label: string, overrides: Record<string, unknown>, needle: RegExp): void {
  const manifest = buildCaseManifest(overrides);
  try {
    const res = runValidate(manifest);
    assert.equal(res.status, 2, `${label} must exit 2 (validation failure):\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout + res.stderr, needle, `${label} must name a distinct reason matching ${needle}`);
  } finally {
    fs.rmSync(path.dirname(manifest), { recursive: true, force: true });
  }
}

describe("Tier-2 chaos block extension (US-003): kill-harness / kill-daemon / delete-tstx-row", () => {
  it("case.schema.json chaosBlock accepts the four types with per-type targets and the new per-type params", () => {
    const block = readSchema().$defs.chaosBlock;
    assert.ok(block, "schema must define $defs.chaosBlock");
    assert.equal(block.additionalProperties, false, "chaosBlock must forbid unknown properties");
    // US-003: hold_seconds is no longer universally required (it is
    // sigstop_sigcont-only); the per-type target/param constraints live in
    // the controller's semantic validator, which stays fail-closed.
    assert.deepEqual(block.required, ["type", "target", "trigger", "operator"], "chaosBlock must require type/target/trigger/operator");
    assert.deepEqual(
      block.properties.type.enum,
      ["sigstop_sigcont", "kill-harness", "kill-daemon", "delete-tstx-row"],
      "chaos type enum must include the kill/delete actions",
    );
    assert.deepEqual(
      block.properties.target.enum,
      ["harness_process", "daemon_process", "tstx_row"],
      "chaos target enum must include the per-type targets",
    );
    assert.equal(block.properties.hold_seconds.type, "number", "hold_seconds must stay typed number");
    assert.equal(block.properties.hold_seconds.exclusiveMinimum, 0, "hold_seconds must be > 0");
    assert.ok(Array.isArray(block.properties.signal?.enum), "chaos signal must be an enum");
    assert.ok(block.properties.signal.enum.includes("SIGKILL"), "chaos signal enum must include SIGKILL");
    assert.equal(block.properties.tree.type, "string", "chaos tree must be typed string");
    assert.equal(block.properties.tree.minLength, 1, "chaos tree must be non-empty");
  });

  it("--validate-only accepts kill-harness, kill-daemon, and delete-tstx-row blocks with their per-type targets", () => {
    expectAccepted("kill-harness + harness_process + explicit signal", {
      chaos: { type: "kill-harness", target: "harness_process", trigger: "mid_round", signal: "SIGTERM", operator: "tt-chaos" },
    });
    expectAccepted("kill-harness without signal (defaults to SIGKILL)", {
      chaos: { type: "kill-harness", target: "harness_process", trigger: "event:merge.parked", operator: "tt-chaos" },
    });
    expectAccepted("kill-daemon + daemon_process", {
      chaos: { type: "kill-daemon", target: "daemon_process", trigger: "mid_round", operator: "tt-chaos" },
    });
    expectAccepted("delete-tstx-row + tstx_row + tree", {
      chaos: { type: "delete-tstx-row", target: "tstx_row", trigger: "event:merge.parked", tree: "abc123def456", operator: "tt-chaos" },
    });
    // Regression: the W3.17b sigstop shape stays valid.
    expectAccepted("sigstop_sigcont + harness_process + hold_seconds", {
      chaos: { type: "sigstop_sigcont", target: "harness_process", trigger: "mid_round", hold_seconds: 600, operator: "tt-chaos" },
    });
  });

  it("per-type target and param violations are REJECTED fail-closed", () => {
    expectRejected(
      "kill-harness with the wrong target (daemon_process)",
      { chaos: { type: "kill-harness", target: "daemon_process", trigger: "mid_round", operator: "tt-chaos" } },
      /target for type 'kill-harness' must be 'harness_process'/,
    );
    expectRejected(
      "kill-daemon with the wrong target (harness_process)",
      { chaos: { type: "kill-daemon", target: "harness_process", trigger: "mid_round", operator: "tt-chaos" } },
      /target for type 'kill-daemon' must be 'daemon_process'/,
    );
    expectRejected(
      "delete-tstx-row with the wrong target (harness_process)",
      { chaos: { type: "delete-tstx-row", target: "harness_process", trigger: "mid_round", tree: "abc123", operator: "tt-chaos" } },
      /target for type 'delete-tstx-row' must be 'tstx_row'/,
    );
    expectRejected(
      "hold_seconds on a kill-harness block (param the action does not take)",
      { chaos: { type: "kill-harness", target: "harness_process", trigger: "mid_round", hold_seconds: 30, operator: "tt-chaos" } },
      /does not take hold_seconds/,
    );
    expectRejected(
      "signal on a sigstop_sigcont block",
      { chaos: { type: "sigstop_sigcont", target: "harness_process", trigger: "mid_round", hold_seconds: 600, signal: "SIGKILL", operator: "tt-chaos" } },
      /does not take signal/,
    );
    expectRejected(
      "delete-tstx-row without a tree",
      { chaos: { type: "delete-tstx-row", target: "tstx_row", trigger: "mid_round", operator: "tt-chaos" } },
      /tree must be a non-empty string for delete-tstx-row/,
    );
    expectRejected(
      "an invalid signal value on a kill action",
      { chaos: { type: "kill-harness", target: "harness_process", trigger: "mid_round", signal: "SIGBOGUS", operator: "tt-chaos" } },
      /signal must be one of/,
    );
    expectRejected(
      "an unknown chaos type",
      { chaos: { type: "sigkill", target: "harness_process", trigger: "mid_round", hold_seconds: 600, operator: "tt-chaos" } },
      /type must be one of/,
    );
    expectRejected(
      "an unknown chaos property",
      { chaos: { type: "kill-harness", target: "harness_process", trigger: "mid_round", operator: "tt-chaos", bogus: 1 } },
      /unknown property/,
    );
  });

  it("a delete-tstx-row block on a local-command case fails closed", () => {
    expectRejected(
      "delete-tstx-row on a local-command case",
      {
        id: "T2-US003-LOCAL",
        workflow: "local",
        fixture: "none",
        harness: "local",
        context: { execution_mode: "scripted" },
        caps: { tokens: 0, wall_min: 5 },
        requires: {},
        boundary_files: [],
        forbidden: [],
        gates: ["TIER2"],
        chaos: { type: "delete-tstx-row", target: "tstx_row", trigger: "now", tree: "abc123", operator: "tt-chaos" },
        reset: { executable: "node", args: ["-e", "1"], cwd: "." },
        command: { executable: "node", args: ["-e", "process.exit(0)"], cwd: "." },
      },
      /not supported on local-command cases/,
    );
  });

  it("buildChaosArgv emits per-type argv and chaos evidence records signal/tree (full stub campaign)", () => {
    // Full zero-token stub campaign (the tt-controller.test.sh chaos fixture
    // pattern): a stub `tamandua` on PATH emits a run id + completed status,
    // and TT_CONTROLLER_TT_CHAOS_PATH points at a recording stub. The chaos
    // runner spawns the stub with the exact buildChaosArgv output, so
    // attempt.chaos_evidence.argv is the end-to-end argv proof.
    const stubBin = fs.mkdtempSync(path.join(varRoot, `us003-argv-bin-${process.pid}-`));
    const chaosArgvFile = path.join(varRoot, `us003-chaos-argv-${Date.now()}-${process.pid}.jsonl`);
    fs.rmSync(chaosArgvFile, { force: true });

    // Stub `tamandua`: handles workflow run/status/runs exactly like the
    // tt-controller.test.sh workflow stub (CONTROLLER_WORKFLOW_MODE=stdout).
    const tamandua = path.join(stubBin, "tamandua");
    fs.writeFileSync(tamandua, `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "workflow" ] && [ "\${2:-}" = "runs" ]; then
  printf '%s\\n' '{"runs":[]}'
  exit 0
fi
if [ "\${1:-}" = "workflow" ] && [ "\${2:-}" = "status" ]; then
  printf '%s\\n' '{"runId":"run-11111111-1111-4111-8111-111111111111","status":"completed","tokensSpent":0,"steps":[]}'
  exit 0
fi
printf 'Run: run-11111111-1111-4111-8111-111111111111\\n'
printf '%s\\n' '{"status":"completed"}'
`, { mode: 0o755 });

    // Recording stub tt-chaos: appends its argv to the evidence file and
    // exits 0 (never signals anything — no real process).
    const chaosStub = path.join(stubBin, "tt-chaos");
    fs.writeFileSync(chaosStub, `#!/usr/bin/env bash
printf '%s\\n' "\$(node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' "\$@")" >> "\${US003_CHAOS_ARGV_FILE:?US003_CHAOS_ARGV_FILE must be set}"
exit 0
`, { mode: 0o755 });

    // Two cases in one manifest: kill-harness (with an explicit signal) and
    // delete-tstx-row (with a tree), so the per-type argv is proven together.
    const killRecord = {
      id: "T2-US003-KILL-ARGV",
      wave: 4,
      workflow: "bug-fix-merge-worktree",
      fixture: "tt-ts",
      harness: "pi",
      task: "cases/tasks/tier2/T2-US003-KILL-ARGV.md",
      context: { execution_mode: "real", test_cmd: "npm test" },
      caps: { tokens: 4000000, wall_min: 240 },
      requires: {},
      boundary_files: ["fixtures-src/tt-ts/src"],
      forbidden: [],
      oracles: [],
      gates: ["TIER2", "W4"],
      chaos: { type: "kill-harness", target: "harness_process", trigger: "mid_round", signal: "SIGTERM", operator: "tt-chaos" },
      shed_ok: false,
      mandatory: true,
      class: "verification",
      spec_ref: "08-wave-4-fault-injection.md#W4.09",
      production_duration_floor_ms: 60000,
    };
    const deleteRecord = {
      ...killRecord,
      id: "T2-US003-DELETE-ARGV",
      task: "cases/tasks/tier2/T2-US003-DELETE-ARGV.md",
      chaos: { type: "delete-tstx-row", target: "tstx_row", trigger: "event:merge.parked", tree: "abc123def456", operator: "tt-chaos" },
    };
    const manifestPath = path.join(varRoot, `us003-argv-manifest-${Date.now()}-${process.pid}.jsonl`);
    fs.writeFileSync(manifestPath, `${JSON.stringify(killRecord)}\n${JSON.stringify(deleteRecord)}\n`);

    let res!: RunResult;
    let campaignId: string | null = null;
    try {
      res = run(controller, ["--manifest", manifestPath], {
        PATH: `${stubBin}:${process.env.PATH ?? ""}`,
        TT_CONTROLLER_TT_CHAOS_PATH: chaosStub,
        TT_CONTROLLER_PREFLIGHT_DISABLED: "1",
        US003_CHAOS_ARGV_FILE: chaosArgvFile,
      });
      const m = CAMPAIGN_LINE.exec(res.stdout);
      campaignId = m === null ? null : m[1];
    } finally {
      fs.rmSync(manifestPath, { force: true });
      fs.rmSync(stubBin, { recursive: true, force: true });
    }
    assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);

    const state = JSON.parse(fs.readFileSync(path.join(varRoot, "results", campaignId!, "state.json"), "utf8"));
    assert.equal(state.spend.tokens_observed, 0, "stub campaign must spend zero tokens");
    const killCase = state.cases.find((c: any) => c.id === "T2-US003-KILL-ARGV");
    const deleteCase = state.cases.find((c: any) => c.id === "T2-US003-DELETE-ARGV");
    assert.ok(killCase && deleteCase, "both stub cases must be in campaign state");

    const killEvidence = killCase.attempts?.[0]?.chaos_evidence;
    assert.ok(killEvidence, `kill case must record chaos evidence: ${JSON.stringify(killCase)}`);
    assert.equal(killEvidence.status, "completed", "stub tt-chaos exits 0 -> evidence completed");
    assert.equal(killEvidence.injection_type, "kill-harness");
    assert.equal(killEvidence.target, "harness_process");
    assert.equal(killEvidence.declared_signal, "SIGTERM", "evidence must record the declared signal");
    assert.equal(killEvidence.hold_seconds, null, "kill actions must not carry hold_seconds in evidence");
    // AC2: tt-chaos kill-harness --run <id> --when <marker> --signal <SIG>.
    assert.deepEqual(
      killEvidence.argv,
      [chaosStub, "kill-harness", "--run", "run-11111111-1111-4111-8111-111111111111", "--when", "step:developer:running", "--signal", "SIGTERM"],
      `kill-harness argv must be tt-chaos kill-harness --run <id> --when <marker> --signal <SIG> (got ${JSON.stringify(killEvidence.argv)})`,
    );

    const deleteEvidence = deleteCase.attempts?.[0]?.chaos_evidence;
    assert.ok(deleteEvidence, `delete case must record chaos evidence: ${JSON.stringify(deleteCase)}`);
    assert.equal(deleteEvidence.injection_type, "delete-tstx-row");
    assert.equal(deleteEvidence.target, "tstx_row");
    assert.equal(deleteEvidence.tree, "abc123def456", "evidence must record the declared tree");
    // AC2: tt-chaos delete-tstx-row --run <id> --when <marker> --tree <hash>
    // (no --hold-seconds, no --signal).
    assert.deepEqual(
      deleteEvidence.argv,
      [chaosStub, "delete-tstx-row", "--run", "run-11111111-1111-4111-8111-111111111111", "--when", "event:merge.parked", "--tree", "abc123def456"],
      `delete-tstx-row argv must carry --tree and nothing else per-type (got ${JSON.stringify(deleteEvidence.argv)})`,
    );

    fs.rmSync(path.join(varRoot, "results", campaignId!), { recursive: true, force: true });
    fs.rmSync(chaosArgvFile, { force: true });
  });

  it("TT_DRY_RUN_REAL_LAUNCH PASS on a kill-chaos case", () => {
    // A kill-harness chaos case riding the full dry-run launch path: the
    // case must validate, pass the chaosGuard, and complete PASS with zero
    // tokens — and the launch-argv recording (TT_DRY_RUN_REAL_LAUNCH) must
    // succeed for a kill-chaos case.
    const manifestPath = buildCaseManifest({
      id: "T2-US003-KILL",
      chaos: { type: "kill-harness", target: "harness_process", trigger: "mid_round", signal: "SIGTERM", operator: "tt-chaos" },
    });
    const outPath = path.join(varRoot, `us003-argv-${Date.now()}-${process.pid}.jsonl`);
    fs.rmSync(outPath, { force: true });
    let res!: RunResult;
    let campaignId: string | null = null;
    try {
      res = run(controller, ["--manifest", manifestPath], { TT_DRY_RUN_REAL_LAUNCH: outPath });
      const m = CAMPAIGN_LINE.exec(res.stdout);
      campaignId = m === null ? null : m[1];
    } finally {
      fs.rmSync(manifestPath, { force: true });
    }
    assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);
    assert.equal(res.status, 0, `kill-chaos dry-run campaign must exit 0:\n${res.stdout}${res.stderr}`);

    const state = JSON.parse(fs.readFileSync(path.join(varRoot, "results", campaignId!, "state.json"), "utf8"));
    const caseState = state.cases.find((c: any) => c.id === "T2-US003-KILL");
    assert.ok(caseState, "kill-chaos case missing from campaign state");
    assert.equal(caseState.outcome, "PASS", "dry-run kill-chaos case must be PASS");
    const attempt = caseState.attempts[0];
    assert.equal(attempt.dry_run_launch, true, "attempt must carry the dry_run_launch marker");
    assert.equal(state.spend.tokens_observed, 0, "dry-run must spend zero tokens");
    // The launch argv must include the workflow + fixture args (the chaos
    // argv itself is exercised end-to-end by the tt-controller.test.sh stub
    // fixture; here the semantic layer already proved per-type argv legality).
    assert.ok(Array.isArray(attempt.dry_run_argv) && attempt.dry_run_argv.includes("workflow"),
      "attempt must persist the recorded launch argv");

    fs.rmSync(path.join(varRoot, "results", campaignId!), { recursive: true, force: true });
    fs.rmSync(outPath, { force: true });
  });

  it("tt-controller --manifest <scratch manifest with a kill-harness chaos block> --validate-only exits 0", () => {
    // AC3 first half, spelled out as its own assertion for the report.
    expectAccepted("kill-harness block validates", {
      chaos: { type: "kill-harness", target: "harness_process", trigger: "mid_round", operator: "tt-chaos" },
    });
  });
});
