// Tier-1 integration gate (US-008): Proof test — `--include-real` reaches the
// real-launch path for W1.L1-python and a hermes case, zero tokens.
//
// E2.2 root cause: on the first real Tier-1 launch, every real case was
// predicate-blocked and the campaign was vacuously GREEN (exit 0) with zero
// real launches. US-004/005/006 landed the canonical predicate contract, the
// fail-closed verdict, and the zero-token dry-run/argv-recording hook. This
// file is the end-to-end PROOF that `--tier1 --include-real` (the actual
// include-real campaign driveable via the launcher) reaches the real-launch
// path on THIS host for W1.L1-python (pi) and one hermes case, using US-006's
// TT_DRY_RUN_REAL_LAUNCH hook so the proof spends ZERO tokens (the dry-run
// short-circuit records the launch argv and marks the case PASS without ever
// invoking a model).
//
// Hermes robustness: the hermes case is REQUIRED to be either
//   (a) recorded-launched (a launch argv exists), OR
//   (b) honestly NOT_RUN(predicate) with evidence naming hermes presence false
// when hermes is not resolvable on this host.
// On this operator-preconfigured machine hermes IS present, so branch (a)
// holds; branch (b) is asserted on any host where hermes is absent so a red
// result still means "honestly gated", never a silent skip.
//
// Walled off: TT_DRY_RUN_REAL_LAUNCH is only consulted by executeWorkflowCase
// for execution_mode 'real'; normal campaigns (env unset) are unaffected.
//
// US-012 (S1 proof): the same zero-token campaign is also the proof that every
// real tier1 case feeds launchGateKey. Three per-case assertions cover the 24
// execution_mode 'real' cases (the 4 scripted local cases W2.21/W2.23* are
// excluded by construction): (a) the manifest declares a non-empty
// context.test_cmd; (b) the recorded launch argv passes it through as
// `--context test_cmd=<value>` — ONE argv element, spaces included;
// (c) launchGateKey computed through the oracle's own exported snapshot
// surface (beginOracleEvidenceSnapshot, a read-only import from
// bin/oracle-evidence-snapshot.mjs — launchGateKey itself is private to that
// file) against a scratch git repo is a JSON object with origin_repo and
// cmd_hash string keys. A real case honestly NOT_RUN(predicate) on a
// hermes-absent host skips only the argv passthrough; manifest test_cmd and
// gate-key objectness still hold for it.
//
// Confined to torture-test/ (writes under gitignored var/). Zero tokens.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { beginOracleEvidenceSnapshot } from "../bin/oracle-evidence-snapshot.mjs";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const binDir = path.join(ttRoot, "bin");
const varRoot = path.join(ttRoot, "var");
const resultsRoot = path.join(varRoot, "results");
const launcher = path.join(repoRoot, "run-torture-test");
const verifyEnv = path.join(binDir, "tt-verify-environment");
const daemonControl = path.join(binDir, "daemon-control");
const hostProfilePath = path.join(varRoot, "w0", "host-profile.json");
const manifestPath = path.join(ttRoot, "cases", "tier1.jsonl");

const CAMPAIGN_LINE = /^Campaign:\s+(campaign-[A-Za-z0-9._-]+)$/m;
const SCRIPTED_PORTS = [5334, 5338, 5339];

// The two real proof cases required by the story: W1.L1-python (pi) and one
// hermes case (W3.03-bfmw-hermes-ts).
const PYTHON_CASE = "W1.L1-python";
const HERMES_CASE = "W3.03-bfmw-hermes-ts";
const HOSTILE_CASE = "W1.X1-ts";

// US-012 (AC2): the four scripted local cases must be excluded from the
// per-case real assertions — pinned here so a future execution_mode edit on
// any of them fails loudly.
const SCRIPTED_CASES = [
  "W2.21-admission",
  "W2.23a-expects-regex",
  "W2.23b-retry-step",
  "W2.23c-missing-persona",
];

type CommandResult = { status: number | null; stdout: string; stderr: string };

// node:test marks descendant processes; the include-real campaign drives the
// scripted daemon on the fixed TT ports (5334/5338/5339) under the gitignored
// TT home (not the operator ~/.tamandua), so disable only the live-state guard
// and drop NODE_TEST_CONTEXT (mirrors tier1-repeatability.test.ts). /bin/false
// backstops guard against any accidental real model invocation.
const campaignEnv: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
};

function run(file: string, args: string[], env = campaignEnv, timeout = 1200_000): CommandResult {
  const result = spawnSync(file, args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout,
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    return { status: null, stdout: String(result.stdout ?? ""), stderr: `${result.stderr ?? ""}\n[timed out after ${timeout}ms]` };
  }
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function runStreaming(file: string, args: string[], env = campaignEnv): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Load the tier1 case manifest (one JSON case per line, 28 lines).
function loadTier1Manifest(): any[] {
  return fs
    .readFileSync(manifestPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

// US-012 scratch state for the gate-key computation: a scratch git repository,
// an empty scratch database, and a campaign directory — all under gitignored
// var/ because beginOracleEvidenceSnapshot validates every path against ttRoot
// containment. The scratch repo must have at least one commit so the snapshot
// machinery can resolve git plumbing and suiteOriginRepo.
function createGateKeyScratch() {
  fs.mkdirSync(varRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(varRoot, "us012-gate-key."));
  const stateDir = path.join(root, "state");
  const campaignDir = path.join(root, "results", "campaign-us012");
  const repoDir = path.join(root, "repo");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(campaignDir, { recursive: true });
  fs.mkdirSync(repoDir);
  const git = (args: string[]) => {
    const res = run("git", ["-C", repoDir, ...args], process.env);
    assert.equal(res.status, 0, `git ${args.join(" ")}:\n${res.stderr}`);
  };
  git(["init", "-b", "main"]);
  git(["config", "user.name", "US-012 Gate-Key Proof"]);
  git(["config", "user.email", "us012@example.invalid"]);
  fs.writeFileSync(path.join(repoDir, "value.txt"), "scratch fixture\n");
  git(["add", "."]);
  git(["commit", "-m", "scratch fixture"]);
  // Empty scratch database: the oracle reports tamandua_stats as
  // table_present false, which is all the baseline capture needs.
  const databasePath = path.join(stateDir, "tamandua.db");
  const db = new DatabaseSync(databasePath);
  db.close();
  return { root, stateDir, campaignDir, repoDir, databasePath };
}

it("US-012: every real tier1 case carries a non-empty context.test_cmd and the oracle computes an object launchGateKey", { timeout: 5 * 60 * 1000 }, () => {
  // AC2: only the 24 execution_mode 'real' cases take the per-case
  // assertions; the 4 scripted local cases are excluded by construction.
  const manifest = loadTier1Manifest();
  assert.equal(manifest.length, 28, "tier1 manifest must keep 28 cases");
  const realCases = manifest.filter((c: any) => (c.context ?? {}).execution_mode === "real");
  assert.equal(realCases.length, 24, "exactly 24 real cases are expected in tier1.jsonl");
  for (const id of SCRIPTED_CASES) {
    const scripted = manifest.find((c: any) => c.id === id);
    assert.ok(scripted, `${id}: scripted case must exist in tier1.jsonl`);
    assert.equal(scripted.context?.execution_mode, "scripted", `${id}: must be execution_mode scripted`);
    assert.ok(!realCases.some((c: any) => c.id === id),
      `${id}: scripted case must be excluded from the per-case real assertions`);
  }

  // (a) manifest-level test_cmd: every real case declares a non-empty command.
  for (const caseRecord of realCases) {
    const testCmd = caseRecord.context?.test_cmd;
    assert.equal(typeof testCmd, "string", `${caseRecord.id}: context.test_cmd must be a string`);
    assert.ok(testCmd.length > 0, `${caseRecord.id}: context.test_cmd must be non-empty`);
  }

  // (c) launchGateKey: computed through the oracle's own exported snapshot
  // surface (read-only import from bin/oracle-evidence-snapshot.mjs —
  // launchGateKey itself is private to that file, and this story must not
  // modify it; beginOracleEvidenceSnapshot persists the gate_key it computes
  // into launch-intent.json) against a scratch git repo. Without a
  // manifest-level test_cmd the gate key is null and the whole O2/O9/O10
  // evidence chain collapses — this asserts objectness for every real case.
  const scratch = createGateKeyScratch();
  try {
    for (const caseRecord of realCases) {
      const started = beginOracleEvidenceSnapshot({
        ttRoot,
        campaignDir: scratch.campaignDir,
        stateDir: scratch.stateDir,
        databasePath: scratch.databasePath,
        repositoryPath: scratch.repoDir,
        caseRecord,
        attempt: {
          id: `us012-${caseRecord.id}`,
          run_id: null,
          launch_intent_at: new Date().toISOString(),
          execution_mode: "real",
        },
        launchArgv: ["tamandua", "workflow", "run", caseRecord.workflow],
      });
      const launchIntent = loadJson(path.join(scratch.campaignDir, started.references.launch_intent.path));
      const gateKey = launchIntent.gate_key;
      assert.ok(gateKey !== null && typeof gateKey === "object",
        `${caseRecord.id}: launchGateKey must be a JSON object, got ${JSON.stringify(gateKey)}`);
      assert.equal(typeof gateKey.origin_repo, "string", `${caseRecord.id}: gate_key.origin_repo must be a string`);
      assert.ok(gateKey.origin_repo.length > 0, `${caseRecord.id}: gate_key.origin_repo must not be empty`);
      assert.equal(typeof gateKey.cmd_hash, "string", `${caseRecord.id}: gate_key.cmd_hash must be a string`);
      assert.match(gateKey.cmd_hash, /^[0-9a-f]{64}$/, `${caseRecord.id}: gate_key.cmd_hash must be a sha256 hex digest`);
      // Strong tie: the oracle hashed the EXACT manifest command and resolved
      // the origin to the scratch repository.
      assert.equal(gateKey.cmd_hash,
        createHash("sha256").update(caseRecord.context.test_cmd).digest("hex"),
        `${caseRecord.id}: gate_key.cmd_hash must be the sha256 of the manifest test_cmd`);
      assert.equal(gateKey.origin_repo, fs.realpathSync(scratch.repoDir),
        `${caseRecord.id}: gate_key.origin_repo must resolve to the scratch repository`);
    }
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
  }
});

function gitSnapshot(): string {
  const result = run("git", ["status", "--porcelain", "--untracked-files=all"], process.env);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function assertPortsFree(): Promise<void> {
  for (const port of SCRIPTED_PORTS) {
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", (error) => reject(new Error(`scripted port ${port} is not free: ${error.message}`)));
      server.listen(port, "127.0.0.1", () => server.close((error) => (error ? reject(error) : resolve())));
    });
  }
}

// Ensure the real host-profile (var/w0/host-profile.json) exists. The include
// real-launch campaign requires it (loadRequiredHostProfile), and US-004/003
// proved tt-verify-environment --fast produces it truthfully and ZERO-token
// (no --spend => no harness auth / model spend). Regenerating is idempotent
// and ~0.3s; this makes the proof self-contained on a clean checkout.
function ensureHostProfile(): void {
  if (fs.existsSync(hostProfilePath)) return;
  const res = run(verifyEnv, ["--fast", "--json"]);
  assert.equal(res.status, 0, `tt-verify-environment --fast failed:\n${res.stderr}${res.stdout}`);
  assert.ok(fs.existsSync(hostProfilePath), "host-profile.json must be produced");
}

it("US-008: --include-real with the dry-run hook reaches the real-launch path for W1.L1-python and a hermes case, zero tokens", { timeout: 20 * 60 * 1000 }, async () => {
  // Hygiene: no lingering scripted daemon from a prior test, ports free.
  const initialStop = run(daemonControl, ["scripted", "stop"], process.env);
  assert.equal(initialStop.status, 0, `${initialStop.stdout}\n${initialStop.stderr}`);
  await assertPortsFree();
  const before = gitSnapshot();

  // The include-real campaign reads the REAL host profile; ensure it exists.
  ensureHostProfile();

  // Run the ACTUAL include-real campaign (`--tier1 --include-real` maps to
  // tt-controller with the tier1 manifest in real mode) with US-006's dry-run
  // hook active. The dry-run short-circuits every real (pi/hermes) case before
  // any model spawn, recording the exact launch argv to our file. The 4
  // scripted local cases (W2.21/W2.23*) still execute through the scripted
  // daemon (zero tokens) as part of the real tier1 campaign.
  const argvOut = path.join(os.tmpdir(), `us008-argv-${Date.now()}-${process.pid}.jsonl`);
  fs.rmSync(argvOut, { force: true });
  const dryEnv: NodeJS.ProcessEnv = { ...campaignEnv, TT_DRY_RUN_REAL_LAUNCH: argvOut };

  let result!: CommandResult;
  let campaignId: string | null = null;
  result = await runStreaming(launcher, ["--tier1", "--include-real"], dryEnv);
  const m = CAMPAIGN_LINE.exec(result.stdout);
  campaignId = m === null ? null : m[1];

  try {
    assert.ok(campaignId, `include-real campaign did not print a campaign ID:\n${result.stdout}\n${result.stderr}`);
    const campaignDir = path.join(resultsRoot, campaignId);
    const report = loadJson(path.join(campaignDir, "report.json"));
    const state = loadJson(path.join(campaignDir, "state.json"));

    // The include-real (real-mode) intent was honored end-to-end.
    assert.equal(state.options.execution_selection, "all",
      "include-real campaign must run in real mode (execution_selection 'all')");

    // AC3: zero tokens — the dry-run stub never invokes a model.
    assert.equal(report.spend.tokens_observed, 0, "report must show zero tokens observed");
    assert.equal(state.spend.tokens_observed, 0, "state spend ledger must show zero tokens");
    for (const caseState of state.cases) {
      assert.equal(caseState.spend?.tokens_observed ?? 0, 0,
        `${caseState.id}: case spend ledger must show zero tokens`);
    }

    // AC1 + verdict: the include-real campaign is GREEN exit 0. Because at
    // least one real case (W1.L1-python) actually LAUNCHED (dry-run attempt),
    // the US-005 fail-closed guard must NOT fire — proving reachability, not
    // a vacuous all-skipped GREEN.
    assert.equal(report.verdict, "GREEN", `include-real dry-run campaign must be GREEN:\n${result.stderr}`);
    assert.equal(report.exit_code, 0);

    // The recorded launch argv is the authoritative reachability proof.
    assert.ok(fs.existsSync(argvOut), `argv-recording file was not written: ${argvOut}`);
    const lines = fs
      .readFileSync(argvOut, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    const byId = new Map(lines.map((r) => [r.case_id, r]));

    // ── W1.L1-python (pi): MUST have a recorded launch argv (AC1). ──
    const python = byId.get(PYTHON_CASE);
    assert.ok(python, `${PYTHON_CASE} launch argv must be recorded by the include-real campaign`);
    assert.equal(python.harness, "pi");
    assert.equal(python.workflow, "do-now");
    assert.equal(python.executable, "tamandua");
    assert.ok(Array.isArray(python.argv) && python.argv.includes("do-now"), "argv must include the workflow");
    const pyTaskIdx = python.argv.indexOf("--task-file");
    assert.ok(pyTaskIdx >= 0, "argv must include --task-file");
    assert.equal(python.argv[pyTaskIdx + 1], `cases/tasks/tier1/${PYTHON_CASE}.md`, "argv must include the task path");
    assert.ok(python.argv.includes("--pi-as-harness"), "argv must include the scheduler's pi harness flag");
    const pyWdIdx = python.argv.indexOf("--working-directory-for-harness");
    assert.ok(pyWdIdx >= 0, "argv must include the fixture path flag for a non-worktree workflow");
    assert.match(python.argv[pyWdIdx + 1], /tt-python$/, "argv fixture path must name the fixture");
    assert.ok(python.argv.includes("--wait") && python.argv.includes("--json"),
      "argv must include the scheduler args --wait --json");
    assertRealCaseLaunched(state, PYTHON_CASE, argvOut);

    // ── hermes case: EITHER recorded-launched (a) OR honestly NOT_RUN(predicate)
    //    with hermes-absent evidence (b) when hermes is not resolvable (AC2). ──
    const hermes = byId.get(HERMES_CASE);
    if (hermes !== undefined) {
      // Branch (a): this host has hermes present (US-004), so the include-real
      // campaign reached the real-launch path for a hermes case too.
      assert.equal(hermes.harness, "hermes");
      assert.equal(hermes.executable, "tamandua");
      assert.ok(hermes.argv.includes("--hermes-as-harness"), "argv must include the scheduler's hermes harness flag");
      const hTaskIdx = hermes.argv.indexOf("--task-file");
      assert.ok(hTaskIdx >= 0, "argv must include --task-file");
      assert.equal(hermes.argv[hTaskIdx + 1], `cases/tasks/tier1/${HERMES_CASE}.md`);
      const woIdx = hermes.argv.indexOf("--worktree-origin-repository");
      assert.ok(woIdx >= 0, "hermes worktree workflow argv must include --worktree-origin-repository");
      assert.match(hermes.argv[woIdx + 1], /tt-ts$/, "hermes fixture path must name the fixture");
      assert.ok(hermes.argv.includes("--wait") && hermes.argv.includes("--json"));
      assertRealCaseLaunched(state, HERMES_CASE, argvOut);
    } else {
      // Branch (b): hermes is not resolvable on this host. The case must be
      // honestly gated NOT_RUN(predicate) with evidence NAMING hermes presence
      // false — never a silent skip, never an infra failure.
      const cs = state.cases.find((c: any) => c.id === HERMES_CASE);
      assert.ok(cs, `${HERMES_CASE} must appear in campaign state`);
      assert.equal(cs.outcome, "NOT_RUN", `${HERMES_CASE} must be NOT_RUN when hermes is absent`);
      assert.equal(cs.reason?.category, "predicate", `${HERMES_CASE} must be gated category=predicate`);
      const evidence = cs.reason?.evidence;
      assert.ok(Array.isArray(evidence) && evidence.length > 0, "predicate block must carry evidence");
      const hermesEvidence = evidence.find((e: any) => String(e.predicate).includes("hermes"));
      assert.ok(hermesEvidence, "predicate evidence must name the hermes capability");
      assert.equal(hermesEvidence.expected, true);
      assert.notEqual(hermesEvidence.observed, true,
        "evidence must record an honest observed value (hermes presence false)");
      assert.deepEqual(cs.attempts, [], `${HERMES_CASE} must not have launched an attempt`);
    }

    // ── W1.X1-ts (US-011): the hostile-path alias case must survive the real
    //    provisioning + launch-argv path with its hostile clone path intact. ──
    const hostile = byId.get(HOSTILE_CASE);
    assert.ok(hostile, `${HOSTILE_CASE} launch argv must be recorded by the include-real campaign`);
    assert.equal(hostile.harness, "pi");
    assert.equal(hostile.workflow, "do-now");
    assert.equal(hostile.fixture, "tt-ts café", "argv record must carry the authored hostile fixture name");
    const hostileWdIdx = hostile.argv.indexOf("--working-directory-for-harness");
    assert.ok(hostileWdIdx >= 0, "argv must include the fixture path flag for a non-worktree workflow");
    const hostileArgvPath = hostile.argv[hostileWdIdx + 1];
    assert.ok(hostileArgvPath.endsWith("tt-ts café"),
      "harness working directory must end with the authored hostile fixture name");
    assert.ok(hostileArgvPath.includes(" "), "harness working directory must contain U+0020 (space)");
    assert.ok(
      [...hostileArgvPath].some((ch) => ch.charCodeAt(0) > 127),
      "harness working directory must contain a non-ASCII character",
    );
    // The US-007 in-band lstat evidence must prove the hostile clone PHYSICALLY
    // existed when the argv was captured, and at exactly the path the argv hands
    // to the harness.
    assert.ok(hostile.work_clone, "argv record must embed work_clone evidence");
    assert.equal(hostile.work_clone.path, hostileArgvPath,
      "work_clone.path must equal the harness working directory handed to tamandua");
    assert.ok(hostile.work_clone.path.includes(" "), "work_clone.path must contain U+0020 (space)");
    assert.ok(
      [...hostile.work_clone.path].some((ch) => ch.charCodeAt(0) > 127),
      "work_clone.path must contain a non-ASCII character",
    );
    assert.equal(hostile.work_clone.existed, true,
      "the hostile-path clone must physically exist at argv-capture time");
    assert.equal(hostile.work_clone.is_directory, true, "work_clone must be a directory");
    assertRealCaseLaunched(state, HOSTILE_CASE, argvOut);

    // ── US-012 (S1 proof): argv passthrough for every real case. The
    //    controller emits each context entry as `--context key=value` with
    //    the value as ONE argv element (spaces included), so a command like
    //    `.venv/bin/pytest -q` must arrive as a single `test_cmd=...`
    //    element equal to the manifest value exactly. A real case with NO
    //    recorded argv must be honestly NOT_RUN(predicate) with evidence
    //    (hermes-absent hosts); its manifest test_cmd and gate-key
    //    objectness are covered by the gate-key test above. Scripted cases
    //    never reach the dry-run recorder, so the argv file must contain
    //    ONLY real cases (AC2 exclusion). ──
    const manifest = loadTier1Manifest();
    const realCases = manifest.filter((c: any) => (c.context ?? {}).execution_mode === "real");
    assert.equal(realCases.length, 24, "exactly 24 real cases are expected in tier1.jsonl");
    const realIds = new Set(realCases.map((c: any) => c.id));
    for (const record of lines) {
      assert.ok(realIds.has(record.case_id),
        `${record.case_id}: only execution_mode real cases may appear in the argv file (scripted cases excluded)`);
    }
    for (const caseRecord of realCases) {
      const record = byId.get(caseRecord.id);
      if (record === undefined) {
        // Honestly gated NOT_RUN(predicate) with evidence — accepted per the
        // story's hermes-absent branch. The only capability predicate any
        // real tier1 case declares is `hermes` (W1.M1-python, W3.03,
        // W3.17a/b, W3.19), so the evidence must name it: a NOT_RUN for any
        // other reason is an infra failure, never a silent skip.
        const caseState = state.cases.find((c: any) => c.id === caseRecord.id);
        assert.ok(caseState, `${caseRecord.id}: must appear in campaign state`);
        assert.equal(caseState.outcome, "NOT_RUN",
          `${caseRecord.id}: a real case without a recorded argv must be NOT_RUN`);
        assert.equal(caseState.reason?.category, "predicate",
          `${caseRecord.id}: must be gated category=predicate`);
        const evidence = caseState.reason?.evidence;
        assert.ok(Array.isArray(evidence) && evidence.length > 0,
          `${caseRecord.id}: predicate block must carry evidence`);
        const hermesEvidence = evidence.find((e: any) => String(e.predicate).includes("hermes"));
        assert.ok(hermesEvidence,
          `${caseRecord.id}: predicate evidence must name the hermes capability (the only honest gate for a real case)`);
        assert.equal(hermesEvidence.expected, true, `${caseRecord.id}: hermes predicate must expect presence`);
        assert.notEqual(hermesEvidence.observed, true,
          `${caseRecord.id}: evidence must record an honest observed value (hermes presence false)`);
        continue;
      }
      const testCmd = caseRecord.context.test_cmd;
      const contextEntries: string[] = [];
      for (let index = 0; index + 1 < record.argv.length; index += 1) {
        if (record.argv[index] === "--context") contextEntries.push(record.argv[index + 1]);
      }
      assert.ok(contextEntries.length >= 1, `${caseRecord.id}: argv must contain at least one --context entry`);
      assert.ok(contextEntries.includes(`test_cmd=${testCmd}`),
        `${caseRecord.id}: argv must pass test_cmd as ONE element --context test_cmd=${testCmd}`);
    }

    // Hygiene: the scripted daemon used by the campaign's local cases stops
    // cleanly, ports free, and the git tree is unchanged.
    const daemonStatus = run(daemonControl, ["scripted", "status"], process.env);
    assert.equal(daemonStatus.status, 0, daemonStatus.stderr);
    assert.match(daemonStatus.stdout, /^STATUS: STOPPED$/m);
    await assertPortsFree();
    assert.equal(gitSnapshot(), before, "include-real campaign changed git status");
  } finally {
    if (campaignId !== null) {
      fs.rmSync(path.join(resultsRoot, campaignId), { recursive: true, force: true });
    }
    fs.rmSync(argvOut, { force: true });
  }
});

function assertRealCaseLaunched(state: any, caseId: string, argvOut: string): void {
  const cs = state.cases.find((c: any) => c.id === caseId);
  assert.ok(cs, `${caseId}: must appear in campaign state`);
  assert.equal(cs.outcome, "PASS", `${caseId}: dry-run recorded launch must be PASS`);
  assert.ok(Array.isArray(cs.attempts) && cs.attempts.length >= 1,
    `${caseId}: must have at least one recorded attempt (proof of launch reachability)`);
  const dry = cs.attempts.find((a: any) => a.dry_run_launch === true);
  assert.ok(dry, `${caseId}: attempt must carry the dry_run_launch marker`);
  assert.equal(dry.dry_run_argv_path, argvOut, `${caseId}: attempt must point at the recorded argv file`);
  assert.ok(Array.isArray(dry.dry_run_argv) && dry.dry_run_argv.includes("workflow"),
    `${caseId}: attempt must persist the recorded launch argv`);
}
