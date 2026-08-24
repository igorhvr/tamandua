// MACP4 US-007 — Dual-path proof: all four tier1 W2 scripted cells still
// PASS on linux via BOTH the systemd launch path AND the forced
// plain-background fallback path (TT_FORCE_NO_SYSTEMD=1). Zero tokens.
//
// The Darwin-capability claim (MACP4 task): on the mac, daemon-control's
// non-systemd fallback launch path (US-001) + the portable harness
// (US-003) + the portable operator-home chain (US-002/US-004) let the four
// W2 scripted cells run; their `requires` predicate is the narrowed
// capability gate ["node-sqlite","daemon-scripted"] (US-006, satisfiable on
// BOTH linux and darwin — US-005). This file is the repeatable, zero-token
// linux-side mechanical pin of that claim:
//
//   (a) each of scenarios/w2.21, w2.23a, w2.23b, w2.23c is executed via
//       scenarios/lib/run-scripted-scenario under the NORMAL launch path
//       (systemd user scope on this linux host) and must exit 0 with the
//       cell's PASS evidence payload (the O1/O3z/O11 substance: terminal
//       status + zero tokens — the oracles the cell's scenario.json
//       declares), and daemon-control's stderr must show the systemd
//       marker;
//   (b) the same four cells repeat under TT_FORCE_NO_SYSTEMD=1 (the
//       mechanical forcing of has_systemd_scope()=false — exactly the
//       plain-background path the mac uses) and must pass identically,
//       with the fallback marker on stderr;
//   (c) the four cells are asserted NOT predicate-skipped under the
//       narrowed manifest requires on linux: the manifest rows carry the
//       narrowed requires, the REAL host profile satisfies every leaf
//       (daemon-scripted true, node-sqlite sqliteAvailable, node_min 22),
//       and a bare tier1 campaign (normal AND forced-fallback) executes
//       all four (state attempts > 0, outcome PASS) with a GREEN verdict
//       and the vacuity guard silent. Each campaign leg ALSO asserts the
//       launch-path marker in the W2 cells' recorded campaign evidence
//       (MACP4 US-008): the systemd marker on the normal leg, the
//       plain-background fallback marker on the TT_FORCE_NO_SYSTEMD=1 leg —
//       proving the override survives the whole campaign spawn path
//       (tt-controller loadSpawnEnvironment forward), not just the harness
//       legs.
//
// Quiet-window discipline: every leg stops any stray scripted daemon and
// asserts ports 5334/5338/5339 free BEFORE and AFTER (the scripted daemon
// owns them). TAMANDUA_PI_BINARY/TAMANDUA_HERMES_BINARY backstops
// (/bin/false) guard against any accidental real model invocation, so the
// proof is always zero-token. The campaign children drive the contained
// tamandua DB, so NODE_TEST_CONTEXT is stripped and TAMANDUA_TEST_GUARD=0
// (the campaignEnv pattern). Git cleanliness is snapshotted before/after.
//
// This test drives real scripted-daemon campaigns on the fixed TT ports, so
// it belongs to the heavy-campaign class and is EXCLUDED from self-tests/
// run.sh's bounded battery; it is executed individually by
// bin/verify-heavy-campaign-tests.test.sh (all three lists — run.sh
// HEAVY_CAMPAIGN_TESTS, the verify script, and e2e-golden-integrity's
// pinned list — stay in lock-step; e2e-golden-integrity AC5 pins it).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const binDir = path.join(ttRoot, "bin");
const varRoot = path.join(ttRoot, "var");
const resultsRoot = path.join(varRoot, "results");
const controller = path.join(binDir, "tt-controller");
const daemonControl = path.join(binDir, "daemon-control");
const verifyEnv = path.join(binDir, "tt-verify-environment");
const hostProfilePath = path.join(varRoot, "w0", "host-profile.json");
const MANIFEST = path.join(ttRoot, "cases", "tier1.jsonl");
const harness = path.join(ttRoot, "scenarios", "lib", "run-scripted-scenario");

const CAMPAIGN_LINE = /^Campaign:\s+(campaign-[A-Za-z0-9._-]+)$/m;
const SCRIPTED_PORTS = [5334, 5338, 5339];
const REAL_HARNESSES = new Set(["pi", "hermes", "dsh"]);
// The narrowest-true-requirement predicate US-006 landed for the W2 cells.
const NARROWED_REQUIRES = { capabilities: ["node-sqlite", "daemon-scripted"], node_min: 22 };
// daemon-control launch-path markers (stderr): the systemd scope arm and
// the TT_FORCE_NO_SYSTEMD/plain-background fallback arm (MACP4 US-001).
const SYSTEMD_MARKER = /using systemd scope:/;
const FALLBACK_MARKER = /systemd not available — using plain background spawn/;
const ORACLES = ["O1", "O3z", "O11"];

// The four tier1 W2 scripted cells, with their manifest ids and scenario
// dirs (the manifest command is exactly `scenarios/lib/run-scripted-
// scenario scenarios/<dir>` with cwd torture-test/).
const W2_CELLS = [
  { id: "W2.21-admission", dir: "w2.21" },
  { id: "W2.23a-expects-regex", dir: "w2.23a" },
  { id: "W2.23b-retry-step", dir: "w2.23b" },
  { id: "W2.23c-missing-persona", dir: "w2.23c" },
];

type CommandResult = { status: number | null; stdout: string; stderr: string };
type CaseRecord = { id: string; harness?: string; requires?: Record<string, unknown> };

// node:test marks descendant processes; the harness and campaigns drive the
// scripted daemon on the fixed TT ports under the gitignored TT home, so
// disable only the live-state guard and drop NODE_TEST_CONTEXT (mirrors
// tier1-bare-vacuity-red-green.test.ts). /bin/false backstops guard against
// any accidental real model invocation (zero tokens always).
const campaignEnv: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
};

function run(file: string, args: string[], env = campaignEnv, timeout = 300_000, cwd = repoRoot): CommandResult {
  const result = spawnSync(file, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    return { status: null, stdout: String(result.stdout ?? ""), stderr: `${result.stderr ?? ""}\n[timed out after ${timeout}ms]` };
  }
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
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

function readManifest(): CaseRecord[] {
  return fs
    .readFileSync(MANIFEST, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as CaseRecord);
}

function gitSnapshot(): string {
  const result = run("git", ["status", "--porcelain", "--untracked-files=all"], process.env);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

// Quiet-window port convention: the scripted daemon owns 5334/5338/5339; a
// stray one from a concurrent/interrupted run must not poison this proof.
// Assert ports free BEFORE starting a leg and repeat AFTER — if the window
// is not quiet the proof fails loudly (never weakens the environment gate).
async function assertPortsFree(): Promise<void> {
  for (const port of SCRIPTED_PORTS) {
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", (error) => reject(new Error(`scripted port ${port} is not free: ${error.message}`)));
      server.listen(port, "127.0.0.1", () => server.close((error) => (error ? reject(error) : resolve())));
    });
  }
}

// Ensure the real host-profile exists; predicates are evaluated against it
// (tt-verify-environment --fast produces it truthfully and ZERO-token).
function ensureHostProfile(): void {
  if (fs.existsSync(hostProfilePath)) return;
  const res = run(verifyEnv, ["--fast", "--json"]);
  assert.equal(res.status, 0, `tt-verify-environment --fast failed:\n${res.stderr}${res.stdout}`);
  assert.ok(fs.existsSync(hostProfilePath), "host-profile.json must be produced");
}

// The scenario command's PASS evidence payload is the LAST stdout line that
// parses as JSON and carries a `result` field (the harness inherits the
// child's stdout, so the evidence JSON is the only stdout content; this
// parser is defensive against any future informational stdout lines).
function parseEvidence(stdout: string): Record<string, any> {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
  let found: Record<string, any> | null = null;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && "result" in parsed) found = parsed;
    } catch {
      // not a JSON line — ignore
    }
  }
  assert.ok(found, `scenario command must emit a JSON PASS evidence payload; stdout was:\n${stdout}`);
  return found!;
}

// One dual-path leg for one cell: quiet window (stop stray daemon, ports
// free), run the EXACT manifest command (run-scripted-scenario with cwd
// torture-test/), assert exit 0 + PASS evidence + zero tokens + the expected
// daemon-control launch-path marker, then hold the quiet window again.
async function runCellLeg(
  cell: { id: string; dir: string },
  extraEnv: NodeJS.ProcessEnv,
  expectedMarker: RegExp,
  legLabel: string,
): Promise<void> {
  const label = `${cell.id} (${legLabel})`;
  const initialStop = run(daemonControl, ["scripted", "stop"], process.env);
  assert.equal(initialStop.status, 0, `${label}: stray-daemon stop failed:\n${initialStop.stdout}\n${initialStop.stderr}`);
  await assertPortsFree();
  const before = gitSnapshot();
  ensureHostProfile();

  const env = { ...campaignEnv, ...extraEnv };
  // Mirror the manifest command exactly: executable
  // scenarios/lib/run-scripted-scenario, arg scenarios/<dir>, cwd "." (the
  // controller resolves "." to torture-test/ — resolvePinnedHookCwd).
  const result = run(harness, [`scenarios/${cell.dir}`], env, 15 * 60 * 1000, ttRoot);
  assert.equal(result.status, 0, `${label}: run-scripted-scenario must exit 0:\n${result.stdout}\n${result.stderr}`);

  const evidence = parseEvidence(result.stdout);
  assert.equal(evidence.result, "PASS", `${label}: cell evidence must be PASS — ${JSON.stringify(evidence)}`);
  assert.equal(evidence.tokens_spent, 0, `${label}: cell evidence must record zero tokens spent`);
  assert.equal(evidence.system_tokens_spent, 0, `${label}: cell evidence must record the zero system-token tripwire`);
  assert.ok(
    typeof evidence.terminal_status === "string" && evidence.terminal_status.length > 0,
    `${label}: cell evidence must record a terminal status (O1 substance)`,
  );
  // The launch-path marker proves WHICH daemon-control arm ran (systemd
  // scope vs the plain-background fallback — the mac's only path).
  assert.match(result.stderr, expectedMarker, `${label}: daemon-control stderr must show the expected launch-path marker`);

  // Quiet window held: daemon stopped, ports free, git tree untouched.
  const daemonStatus = run(daemonControl, ["scripted", "status"], process.env);
  assert.equal(daemonStatus.status, 0, daemonStatus.stderr);
  assert.match(daemonStatus.stdout, /^STATUS: STOPPED$/m, `${label}: scripted daemon must be stopped after the leg`);
  await assertPortsFree();
  assert.equal(gitSnapshot(), before, `${label} changed git status`);
}

// One bare tier1 campaign leg (normal or forced-fallback): assert the four
// W2 scripted cells EXECUTE (attempts > 0, outcome PASS — never
// NOT_RUN(predicate)) under the narrowed manifest requires, the 24 real
// cells stay pending-real, the verdict is GREEN exit 0 with the vacuity
// guard silent, and zero tokens are spent. Additionally asserts the
// campaign-level daemon-control launch-path marker in the W2 cells'
// recorded evidence (MACP4 US-008): the override must reach daemon-control
// through the WHOLE campaign spawn path, not just the harness legs.
async function runCampaignLeg(extraEnv: NodeJS.ProcessEnv, legLabel: string, expectedMarker: RegExp): Promise<void> {
  const initialStop = run(daemonControl, ["scripted", "stop"], process.env);
  assert.equal(initialStop.status, 0, `${initialStop.stdout}\n${initialStop.stderr}`);
  await assertPortsFree();
  const before = gitSnapshot();
  const originalHash = createHash("sha256").update(fs.readFileSync(MANIFEST)).digest("hex");
  ensureHostProfile();

  let result!: CommandResult;
  let campaignId: string | null = null;
  try {
    const env = { ...campaignEnv, ...extraEnv };
    result = await runStreaming(controller, ["--manifest", MANIFEST, "--scripted-only"], env);
    const m = CAMPAIGN_LINE.exec(result.stdout);
    campaignId = m === null ? null : m[1];
    assert.ok(campaignId, `bare tier1 campaign (${legLabel}) did not print a campaign ID:\n${result.stdout}\n${result.stderr}`);
    const campaignDir = path.join(resultsRoot, campaignId);
    const state = loadJson(path.join(campaignDir, "state.json"));
    const report = loadJson(path.join(campaignDir, "report.json"));

    assert.equal(state.options.execution_selection, "scripted-only", `${legLabel}: campaign must run bare`);

    const realCases = state.cases.filter((c: any) => REAL_HARNESSES.has(String(c.harness)));
    const scriptedCases = state.cases.filter((c: any) => !REAL_HARNESSES.has(String(c.harness)));
    assert.equal(realCases.length, 24, `${legLabel}: bare tier1 must contain 24 pending-real pi/hermes cells`);
    assert.equal(scriptedCases.length, 4, `${legLabel}: bare tier1 must contain 4 scripted local cells`);

    // AC2: the four W2 cells EXECUTE under the narrowed requires — never
    // NOT_RUN(predicate) on linux — with attempts > 0 and a PASS outcome.
    for (const cell of W2_CELLS) {
      const cs = scriptedCases.find((c: any) => c.id === cell.id);
      assert.ok(cs, `${legLabel}: state must contain ${cell.id}`);
      assert.equal(cs.outcome, "PASS", `${legLabel}: ${cell.id} must PASS — ${JSON.stringify(cs.reason ?? {})}`);
      assert.ok(Array.isArray(cs.attempts) && cs.attempts.length > 0,
        `${legLabel}: ${cell.id} must have executed (attempts > 0) — never NOT_RUN(predicate)`);
      assert.equal(cs.spend?.tokens_observed ?? 0, 0, `${legLabel}: ${cell.id} must spend zero tokens`);
      // MACP4 US-008 campaign-level marker: the recorded daemon-control
      // stderr for this cell's attempt must show the launch path the leg
      // intended (systemd scope for the normal leg, the forced plain-
      // background fallback for TT_FORCE_NO_SYSTEMD=1). This closes the
      // campaign-level gap: TT_FORCE_NO_SYSTEMD must survive the whole
      // campaign spawn path (tt-controller loadSpawnEnvironment forward),
      // so the campaign proof is genuinely on the fallback path, not a
      // second systemd run.
      const attemptDirs = cs.attempts.map((a: any) => String(a.id)).filter((id: string) => id !== "");
      assert.ok(attemptDirs.length > 0, `${legLabel}: ${cell.id} must have attempt ids for evidence`);
      let sawMarker = false;
      for (const attemptId of attemptDirs) {
        const stderrPath = path.join(campaignDir, "evidence", cell.id, attemptId, "command.stderr");
        if (!fs.existsSync(stderrPath)) continue;
        if (expectedMarker.test(fs.readFileSync(stderrPath, "utf8"))) { sawMarker = true; break; }
      }
      assert.ok(sawMarker,
        `${legLabel}: ${cell.id} campaign evidence must show the ${legLabel} daemon-control marker ` +
        `(${expectedMarker}) — the override did not reach daemon-control through the campaign spawn path`);
    }
    for (const cs of realCases) {
      assert.equal(cs.outcome, "NOT_RUN", `${legLabel}: ${cs.id} must remain pending-real in bare mode`);
      assert.equal(cs.reason?.category, "pending-real", `${legLabel}: ${cs.id} pending-real category required`);
    }

    // Campaign-level: GREEN exit 0, vacuity silent, zero tokens.
    assert.equal(result.status, 0, `${legLabel}: bare tier1 must exit 0 (GREEN):\n${result.stdout}\n${result.stderr}`);
    assert.equal(report.verdict, "GREEN", `${legLabel}: report must be GREEN`);
    assert.equal(report.exit_code, 0, `${legLabel}: report must carry exit code 0`);
    assert.equal(report.vacuity.triggered, false, `${legLabel}: vacuity guard must be silent (4 cells executed)`);
    assert.ok(!report.findings.some((f: any) => f.category === "vacuous-campaign"),
      `${legLabel}: no vacuous-campaign finding expected`);
    assert.equal(report.spend.tokens_observed, 0, `${legLabel}: campaign must be zero-token`);
    assert.equal(createHash("sha256").update(fs.readFileSync(MANIFEST)).digest("hex"),
      originalHash, `${legLabel}: original tier1.jsonl must be untouched`);
  } finally {
    if (campaignId !== null) {
      fs.rmSync(path.join(resultsRoot, campaignId), { recursive: true, force: true });
    }
  }

  const daemonStatus = run(daemonControl, ["scripted", "status"], process.env);
  assert.equal(daemonStatus.status, 0, daemonStatus.stderr);
  assert.match(daemonStatus.stdout, /^STATUS: STOPPED$/m, `${legLabel}: scripted daemon must be stopped after the campaign`);
  await assertPortsFree();
  assert.equal(gitSnapshot(), before, `${legLabel} changed git status`);
}

it("US-007 AC2: the four W2 cells are NOT predicate-skipped under the narrowed manifest requires on linux", () => {
  const records = readManifest();
  assert.equal(records.length, 28, "tier1 manifest must still hold 28 cases");
  for (const cell of W2_CELLS) {
    const record = records.find((r) => r.id === cell.id);
    assert.ok(record, `missing manifest case ${cell.id}`);
    // The narrowed requires: capability gate, no blanket platform predicate.
    assert.deepEqual(record.requires, NARROWED_REQUIRES,
      `${cell.id}: requires must be ${JSON.stringify(NARROWED_REQUIRES)} (platform key dropped, daemon-scripted added)`);
    // The manifest command the dual-path legs exercise: exactly the harness
    // + the cell's scenario dir with cwd torture-test/.
    assert.equal(record.command?.executable, "scenarios/lib/run-scripted-scenario",
      `${cell.id}: manifest command executable must be the shared harness`);
    assert.deepEqual(record.command?.args, [`scenarios/${cell.dir}`],
      `${cell.id}: manifest command args must name the cell's scenario dir`);
    // The cell's scenario.json declares the O1/O3z/O11 oracles whose
    // substance (terminal status + zero tokens) the PASS evidence carries.
    const scenario = loadJson(path.join(ttRoot, "scenarios", cell.dir, "scenario.json"));
    assert.deepEqual(scenario.oracles, ORACLES, `${cell.id}: scenario.json must declare oracles O1/O3z/O11`);
  }

  // The REAL host profile satisfies every leaf of the narrowed requires, so
  // on this linux host the cells EXECUTE (never NOT_RUN(predicate)):
  // daemon-scripted (US-005 Boolean leaf, both platforms), node-sqlite
  // (sqliteAvailable), node_min 22 (max runtime major).
  ensureHostProfile();
  const profile = loadJson(hostProfilePath);
  assert.equal(profile.capabilities?.["daemon-scripted"], true,
    "host profile must record capabilities.daemon-scripted === true on this linux host");
  const runtimes = profile.nodeRuntimes ?? [];
  assert.ok(Array.isArray(runtimes) && runtimes.some((r: any) => r.sqliteAvailable === true),
    "host profile must record a node runtime with sqliteAvailable === true (node-sqlite)");
  const majors = runtimes.map((r: any) => r.major).filter((m: any) => typeof m === "number");
  assert.ok(majors.some((m: number) => m >= 22), "host profile must record a node runtime >= 22 (node_min)");
});

it("US-007 (a): all four W2 cells PASS via the NORMAL systemd launch path (exit 0, PASS evidence, zero tokens)", { timeout: 60 * 60 * 1000 }, async () => {
  for (const cell of W2_CELLS) {
    await runCellLeg(cell, {}, SYSTEMD_MARKER, "normal/systemd path");
  }
});

it("US-007 (b): all four W2 cells PASS via the FORCED plain-background fallback path (TT_FORCE_NO_SYSTEMD=1)", { timeout: 60 * 60 * 1000 }, async () => {
  for (const cell of W2_CELLS) {
    await runCellLeg(cell, { TT_FORCE_NO_SYSTEMD: "1" }, FALLBACK_MARKER, "forced-fallback path");
  }
});

it("US-007 (c): bare tier1 campaigns execute all four W2 cells (attempts>0, PASS, GREEN) — normal AND forced-fallback", { timeout: 90 * 60 * 1000 }, async () => {
  await runCampaignLeg({}, "normal/systemd", SYSTEMD_MARKER);
  await runCampaignLeg({ TT_FORCE_NO_SYSTEMD: "1" }, "forced-fallback", FALLBACK_MARKER);
});
