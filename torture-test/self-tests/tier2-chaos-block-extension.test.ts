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
//     plus (E3.C.1 US-003) the EXPLICIT recorded harness target
//     (--target-pid/--target-pgid/--target-start-time) so tt-chaos never
//     re-resolves the harness by /proc sweep (linux-only facility — MACP3
//     US-003: source-text/prose reference only here, no runtime /proc
//     access), and the chaos evidence records
//     the declared signal/tree;
//   * TT_DRY_RUN_REAL_LAUNCH PASSes on a kill-chaos case (zero tokens).
//
// S32 battery-hermeticity (US-001): the stub-campaign marker corridor is
// seeded into THIS test's OWN per-test temp contained home
// (var/us003-hermetic-home-<pid>-*, via the controller's
// TT_CONTROLLER_SPAWN_HOME_OVERRIDE seam) and NEVER into the shared
// contained home var/home/.tamandua — a pre-existing campaign-populated
// tamandua.db there (real tamandua schema) must stay byte-for-byte
// untouched (asserted per run), so the battery passes even on a dirty home.
//
// Confined to torture-test/ (writes only under gitignored var/). Zero tokens.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

// ── S32 hermeticity (US-001): shared-contained-home isolation ────────
// The chaos stub campaign must seed its marker corridor in its OWN per-test
// temp contained home (var/us003-hermetic-home-<pid>-*, via
// TT_CONTROLLER_SPAWN_HOME_OVERRIDE) and NEVER read or write the shared
// contained home var/home/.tamandua — a pre-existing campaign-populated
// tamandua.db there carries the REAL tamandua schema
// (steps.input_template/expects NOT NULL, no reroute_count column), which
// used to break the seed INSERT ("NOT NULL constraint failed:
// steps.input_template"). These helpers snapshot and re-assert the shared
// home DB so the hermeticity claim is proven per-run (AC2: mtime/content
// unchanged; an absent DB must stay absent).
type SharedDbSnapshot = { exists: boolean; bytes: Buffer | null; mtimeMs: number | null };

function snapshotSharedHomeDb(dbPath: string): SharedDbSnapshot {
  try {
    const stat = fs.statSync(dbPath);
    return { exists: true, bytes: fs.readFileSync(dbPath), mtimeMs: stat.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, bytes: null, mtimeMs: null };
    }
    throw error;
  }
}

function assertSharedHomeDbUntouched(dbPath: string, before: SharedDbSnapshot): void {
  if (!before.exists) {
    assert.equal(fs.existsSync(dbPath), false,
      "hermetic chaos campaign must not create the shared contained home DB");
    return;
  }
  const after = snapshotSharedHomeDb(dbPath);
  assert.equal(after.exists, true, "shared contained home DB vanished during the test");
  assert.equal(after.mtimeMs, before.mtimeMs,
    "shared contained home DB mtime changed — the hermetic test must not write var/home/.tamandua");
  assert.deepEqual(after.bytes, before.bytes,
    "shared contained home DB content changed — the hermetic test must not write var/home/.tamandua");
}

// ensureHostProfile — the controller's REAL-case eligibility/preflight reads
// var/w0/host-profile.json (the host profile produced by tt-verify-environment
// --fast). On a FRESH var (gitignored — wiped with the worktree) the profile
// is absent and the real-launch dry-run arm fails 'host-profile-missing'
// before any case executes. Generate it here (idempotent, zero tokens,
// mechanical toolchain probe — the same sanctioned generator the
// tier0-dry-run-argv-recording battery uses) so this file is order-independent.
function ensureHostProfile(): void {
  const hostProfilePath = path.join(varRoot, "w0", "host-profile.json");
  if (fs.existsSync(hostProfilePath)) return;
  const verify = spawnSync(path.join(ttRoot, "bin", "tt-verify-environment"), ["--fast", "--json"], {
    cwd: ttRoot,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(verify.status, 0,
    `host-profile generation failed for the real-launch arm: ${verify.stderr ?? verify.stdout}`);
  assert.ok(fs.existsSync(hostProfilePath),
    "host-profile.json must be written by tt-verify-environment --fast");
}

function runValidate(manifestPath: string): RunResult {
  return run(controller, ["--manifest", manifestPath, "--validate-only"]);
}

function readSchema(): Record<string, any> {
  return JSON.parse(fs.readFileSync(schemaPath, "utf8"));
}

// Build a single-case manifest under a temp dir inside torture-test/var (the
// controller refuses manifests that escape torture-test/). The base is a real
// workflow case (pi harness, feature-dev-merge-worktree, tt-ts fixture);
// field overrides are applied on top. fdmw is pinned so the `mid_round`
// chaos trigger (translated to step:developer:running) stays valid under
// US-003's fail-closed trigger-vocabulary preflight (developer is an fdmw
// agent; it is NOT bug-fix-merge-worktree vocabulary).
function buildCaseManifest(overrides: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(varRoot, "us003-chaos-schema-"));
  const base: Record<string, any> = {
    id: "T2-US003-CHOKE",
    wave: 4,
    workflow: "feature-dev-merge-worktree",
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
    // T2.1 US-010: the block's requirement set is SPLIT into an allOf/anyOf
    // pair so the TYPED injection arm (type/target/trigger/operator) and the
    // O11 DECLARATION-ONLY arm (synthetic_token_ledger — the run id is
    // unknowable at authoring time; the controller materializes it at oracle
    // time) are mutually exclusive but at least one is always required. The
    // top-level `required` is therefore empty; the per-arm requirements live
    // in allOf.
    assert.deepEqual(block.required, [], "chaosBlock top-level required must be empty (per-arm requirements in allOf)");
    const arms = block.allOf?.[0]?.anyOf;
    assert.ok(Array.isArray(arms) && arms.length === 2,
      "chaosBlock must carry exactly two requirement arms (typed injection + O11 declaration-only)");
    const typedArm = arms.find((arm: any) => arm.required?.includes("type"));
    const ledgerArm = arms.find((arm: any) => arm.required?.includes("synthetic_token_ledger"));
    assert.ok(typedArm, "chaosBlock must require type/target/trigger/operator on the typed injection arm");
    assert.deepEqual(typedArm.required, ["type", "target", "trigger", "operator"],
      "typed chaos arm must require type/target/trigger/operator");
    assert.ok(ledgerArm, "chaosBlock must require synthetic_token_ledger on the O11 declaration-only arm");
    assert.deepEqual(ledgerArm.required, ["synthetic_token_ledger"],
      "O11 declaration-only arm must require exactly synthetic_token_ledger");
    assert.deepEqual(
      block.properties.type.enum,
      ["sigstop_sigcont", "kill-harness", "kill-daemon", "delete-tstx-row", "move-branch"],
      "chaos type enum must include the kill/delete actions and the US-004 move-branch colleague target-move",
    );
    assert.deepEqual(
      block.properties.target.enum,
      ["harness_process", "daemon_process", "tstx_row", "origin_target_ref"],
      "chaos target enum must include the per-type targets and the US-004 origin target ref",
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
      chaos: { type: "kill-harness", target: "harness_process", trigger: "event:merge.landed", operator: "tt-chaos" },
    });
    expectAccepted("kill-daemon + daemon_process", {
      chaos: { type: "kill-daemon", target: "daemon_process", trigger: "mid_round", operator: "tt-chaos" },
    });
    expectAccepted("delete-tstx-row + tstx_row + tree", {
      chaos: { type: "delete-tstx-row", target: "tstx_row", trigger: "event:merge.landed", tree: "abc123def456", operator: "tt-chaos" },
    });
    // Regression: the W3.17b sigstop shape stays valid.
    expectAccepted("sigstop_sigcont + harness_process + hold_seconds", {
      chaos: { type: "sigstop_sigcont", target: "harness_process", trigger: "mid_round", hold_seconds: 600, operator: "tt-chaos" },
    });
    // US-004: the typed move-branch colleague target-move validates with its
    // origin_target_ref target + ref/repeat/interval_s/wait_timeout_s params.
    expectAccepted("move-branch + origin_target_ref + persistent-move params", {
      chaos: { type: "move-branch", target: "origin_target_ref", trigger: "step:finalize_merge:running", operator: "tt-chaos", ref: "refs/heads/main", repeat: 5, interval_s: 30, wait_timeout_s: 4200 },
    });
    expectAccepted("move-branch single move (repeat absent, no interval)", {
      chaos: { type: "move-branch", target: "origin_target_ref", trigger: "step:finalize_merge:running", operator: "tt-chaos", ref: "refs/heads/main" },
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
    // US-004 per-type rules for the move-branch colleague target-move: a
    // missing ref, interval_s without repeat > 1, or a move-branch param on
    // another type all fail closed.
    expectRejected(
      "move-branch without a ref",
      { chaos: { type: "move-branch", target: "origin_target_ref", trigger: "step:finalize_merge:running", operator: "tt-chaos" } },
      /ref must be a non-empty ref name for move-branch/,
    );
    expectRejected(
      "move-branch with interval_s but no repeat > 1",
      { chaos: { type: "move-branch", target: "origin_target_ref", trigger: "step:finalize_merge:running", operator: "tt-chaos", ref: "refs/heads/main", repeat: 1, interval_s: 30 } },
      /interval_s requires repeat > 1/,
    );
    expectRejected(
      "move-branch with the wrong target (harness_process)",
      { chaos: { type: "move-branch", target: "harness_process", trigger: "step:finalize_merge:running", operator: "tt-chaos", ref: "refs/heads/main" } },
      /target for type 'move-branch' must be 'origin_target_ref'/,
    );
    expectRejected(
      "ref on a kill-harness block (move-branch-only param)",
      { chaos: { type: "kill-harness", target: "harness_process", trigger: "mid_round", operator: "tt-chaos", ref: "refs/heads/main" } },
      /does not take ref/,
    );
    expectRejected(
      "repeat on a kill-harness block (move-branch-only param)",
      { chaos: { type: "kill-harness", target: "harness_process", trigger: "mid_round", operator: "tt-chaos", repeat: 3 } },
      /does not take repeat/,
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
    // The workflow is feature-dev-merge-worktree: the kill case's `mid_round`
    // trigger translates to step:developer:running, which is fdmw vocabulary
    // (the US-003 preflight rejects it on any other workflow).
    const killRecord = {
      id: "T2-US003-KILL-ARGV",
      wave: 4,
      workflow: "feature-dev-merge-worktree",
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
      chaos: { type: "delete-tstx-row", target: "tstx_row", trigger: "event:merge.landed", tree: "abc123def456", operator: "tt-chaos" },
    };
    const manifestPath = path.join(varRoot, `us003-argv-manifest-${Date.now()}-${process.pid}.jsonl`);
    fs.writeFileSync(manifestPath, `${JSON.stringify(killRecord)}\n${JSON.stringify(deleteRecord)}\n`);

    // S28 (US-005): the fail-closed terminal guard refuses to spawn an
    // operator against a run the status query reports terminal — and the
    // stub `workflow status` reports 'completed' from the start. The
    // harness-target wait's MARKER check runs BEFORE the status check, so
    // seeding the marker corridor makes both invocations proceed exactly as
    // in a real run:
    //   * kill case: a steps-table claim row makes step:developer:running
    //     fire (the product's own marker mechanism), and
    //   * delete case: an event-stream row makes event:merge.landed fire.
    //
    // S32 hermeticity (US-001): the corridor is seeded into THIS test's OWN
    // per-test temp contained home (mkdtemp under torture-test/var —
    // var/us003-hermetic-home-<pid>-XXXXXX) and the controller is pointed at
    // it via TT_CONTROLLER_SPAWN_HOME_OVERRIDE, so the marker corridor
    // (steps-table + per-run event file) and every child spawn resolve
    // against the temp home. The SHARED contained home (var/home/.tamandua)
    // is never read or written — a pre-existing campaign-populated
    // tamandua.db there carries the REAL tamandua schema
    // (steps.input_template/expects NOT NULL, no reroute_count column) and
    // used to break the seed INSERT. Cleanup removes the temp home entirely
    // (incl. -wal/-shm); the shared home DB identity is asserted unchanged.
    const chaosRunId = "run-11111111-1111-4111-8111-111111111111";
    const chaosRunShort = chaosRunId.slice("run-".length);
    const hermeticHome = fs.mkdtempSync(path.join(varRoot, `us003-hermetic-home-${process.pid}-`));
    const hermeticStateDir = path.join(hermeticHome, ".tamandua");
    const hermeticDbPath = path.join(hermeticStateDir, "tamandua.db");
    const hermeticEventsDir = path.join(hermeticStateDir, "events");
    const hermeticEventFile = path.join(hermeticEventsDir, `${chaosRunShort}.jsonl`);
    // AC2: snapshot the shared contained home DB (content + mtime) BEFORE the
    // test so we can prove this hermetic test never touches it.
    const sharedDbPath = path.join(varRoot, "home", ".tamandua", "tamandua.db");
    const sharedDbBefore = snapshotSharedHomeDb(sharedDbPath);
    try {
      fs.mkdirSync(hermeticEventsDir, { recursive: true });
      // Tolerant + idempotent (CREATE TABLE IF NOT EXISTS): the temp home is
      // fresh per test, and the seeding must survive a re-run of the file.
      const db = new DatabaseSync(hermeticDbPath, { open: true });
      try {
        db.exec(`CREATE TABLE IF NOT EXISTS steps (
          id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL,
          agent_id TEXT NOT NULL, step_index INTEGER NOT NULL, status TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'single', current_story_id TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0, abandoned_count INTEGER NOT NULL DEFAULT 0,
          reroute_count INTEGER NOT NULL DEFAULT 0, claim_pid INTEGER,
          claim_pgid INTEGER, claim_updated_at TEXT, updated_at TEXT NOT NULL
        );`);
        db.prepare(
          `INSERT OR REPLACE INTO steps
             (id, run_id, step_id, agent_id, step_index, status, type, retry_count, abandoned_count, reroute_count, updated_at)
           VALUES ('us003-claim-row', ?, 'step-developer', 'developer', 0, 'running', 'single', 0, 0, 0, ?)`,
        ).run(chaosRunShort, new Date().toISOString());
      } finally {
        db.close();
      }
      // The marker check reads the per-run event file and looks for the
      // declared event — seed the row in the TEMP home's event stream.
      fs.writeFileSync(
        hermeticEventFile,
        `${JSON.stringify({ ts: new Date().toISOString(), event: "merge.landed", runId: chaosRunId })}\n`,
      );
    } catch (error) {
      throw new Error(`cannot seed the chaos marker corridor in ${hermeticHome}: ${(error as Error).message}`);
    }

    let res!: RunResult;
    let campaignId: string | null = null;
    try {
      res = run(controller, ["--manifest", manifestPath], {
        PATH: `${stubBin}:${process.env.PATH ?? ""}`,
        TT_CONTROLLER_TT_CHAOS_PATH: chaosStub,
        TT_CONTROLLER_PREFLIGHT_DISABLED: "1",
        TT_CONTROLLER_SPAWN_HOME_OVERRIDE: hermeticHome,
        US003_CHAOS_ARGV_FILE: chaosArgvFile,
      });
      const m = CAMPAIGN_LINE.exec(res.stdout);
      campaignId = m === null ? null : m[1];
    } finally {
      fs.rmSync(manifestPath, { force: true });
      fs.rmSync(stubBin, { recursive: true, force: true });
      // S32 cleanup: remove the temp home ENTIRELY (incl. -wal/-shm
      // sidecars). Nothing under var/home was ever read or written.
      fs.rmSync(hermeticHome, { recursive: true, force: true });
      // AC2: the shared contained home DB must be unchanged (or still absent).
      assertSharedHomeDbUntouched(sharedDbPath, sharedDbBefore);
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
    // E3.C.1 US-003: the controller records the harness identity at launch
    // (launch-process record in the stub campaign) and hands it to tt-chaos
    // as EXPLICIT --target-* args — the operator must never re-resolve the
    // harness by /proc sweep (prose reference to the linux-only facility;
    // no runtime /proc access in this file — MACP3 US-003). Assert the recorded target is present and the
    // argv carries exactly its pid/pgid/startTime (startTime 'proc:'-stripped
    // like buildChaosArgv does).
    const killTarget = killEvidence.target_record;
    assert.ok(killTarget !== null && Number.isInteger(killTarget.pid) && killTarget.pid > 0,
      `kill evidence must record the explicit harness target (got ${JSON.stringify(killEvidence.target_record)})`);
    const killTargetTail = ["--target-pid", String(killTarget.pid)];
    if (Number.isInteger(killTarget.pgid) && killTarget.pgid > 0) {
      killTargetTail.push("--target-pgid", String(killTarget.pgid));
    }
    if (typeof killTarget.startTime === "string" && killTarget.startTime !== "") {
      const raw = killTarget.startTime.startsWith("proc:")
        ? killTarget.startTime.slice("proc:".length)
        : killTarget.startTime;
      killTargetTail.push("--target-start-time", raw);
    }
    // AC2: tt-chaos kill-harness --run <id> --when <marker> --signal <SIG>,
    // followed by the explicit recorded --target-pid/--target-pgid/
    // --target-start-time identity (E3.C.1 US-003 — never a scan-resolved
    // target).
    assert.deepEqual(
      killEvidence.argv,
      [chaosStub, "kill-harness", "--run", "run-11111111-1111-4111-8111-111111111111", "--when", "step:developer:running", "--signal", "SIGTERM", ...killTargetTail],
      `kill-harness argv must be tt-chaos kill-harness --run <id> --when <marker> --signal <SIG> --target-* <recorded identity> (got ${JSON.stringify(killEvidence.argv)})`,
    );

    const deleteEvidence = deleteCase.attempts?.[0]?.chaos_evidence;
    assert.ok(deleteEvidence, `delete case must record chaos evidence: ${JSON.stringify(deleteCase)}`);
    assert.equal(deleteEvidence.injection_type, "delete-tstx-row");
    assert.equal(deleteEvidence.target, "tstx_row");
    assert.equal(deleteEvidence.tree, "abc123def456", "evidence must record the declared tree");
    // E3.C.1 US-003: delete-tstx-row also carries the explicit recorded
    // --target-* identity (buildChaosArgv appends it for every type — the
    // operator never scan-resolves).
    const deleteTarget = deleteEvidence.target_record;
    assert.ok(deleteTarget !== null && Number.isInteger(deleteTarget.pid) && deleteTarget.pid > 0,
      `delete evidence must record the explicit harness target (got ${JSON.stringify(deleteEvidence.target_record)})`);
    const deleteTargetTail = ["--target-pid", String(deleteTarget.pid)];
    if (Number.isInteger(deleteTarget.pgid) && deleteTarget.pgid > 0) {
      deleteTargetTail.push("--target-pgid", String(deleteTarget.pgid));
    }
    if (typeof deleteTarget.startTime === "string" && deleteTarget.startTime !== "") {
      const raw = deleteTarget.startTime.startsWith("proc:")
        ? deleteTarget.startTime.slice("proc:".length)
        : deleteTarget.startTime;
      deleteTargetTail.push("--target-start-time", raw);
    }
    // AC2: tt-chaos delete-tstx-row --run <id> --when <marker> --tree <hash>
    // (no --hold-seconds, no --signal), plus the explicit --target-* identity.
    assert.deepEqual(
      deleteEvidence.argv,
      [chaosStub, "delete-tstx-row", "--run", "run-11111111-1111-4111-8111-111111111111", "--when", "event:merge.landed", "--tree", "abc123def456", ...deleteTargetTail],
      `delete-tstx-row argv must carry --tree plus the explicit --target-* identity per-type (got ${JSON.stringify(deleteEvidence.argv)})`,
    );

    fs.rmSync(path.join(varRoot, "results", campaignId!), { recursive: true, force: true });
    fs.rmSync(chaosArgvFile, { force: true });
  });

  it("TT_DRY_RUN_REAL_LAUNCH PASS on a kill-chaos case", () => {
    // A kill-harness chaos case riding the full dry-run launch path: the
    // case must validate, pass the chaosGuard, and complete PASS with zero
    // tokens — and the launch-argv recording (TT_DRY_RUN_REAL_LAUNCH) must
    // succeed for a kill-chaos case.
    // The real-launch path requires the real host profile; generate it on a
    // fresh var (idempotent, zero tokens) so this file is battery-order
    // independent (the tier0-dry-run-argv-recording pattern).
    ensureHostProfile();
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
      fs.rmSync(path.dirname(manifestPath), { recursive: true, force: true });
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
