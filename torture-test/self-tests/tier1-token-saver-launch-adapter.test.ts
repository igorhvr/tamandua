// Tier-1 self-test (E3.D US-010 / S12 controller): token-saver paired launch
// adapter — flagged + control runs.
//
// W3.23-token-saver (context.token_saver_control === true) is the token-saver
// lifecycle probe. The controller executes it as TWO do-now launches against
// the same provisioned clone:
//   run A (flagged):  the managed pi-token-saver stub (bin/tt-token-saver-stub)
//     is installed into var/adapters-bin and --no-hurry-please-save-tokens-mode
//     is appended to the launch argv;
//   run B (control):  the stub is removed and the run launches WITHOUT the flag.
// The pair's evidence (argv, run ids, per-run token ledger, stub-record counts)
// lives on attempt.token_saver, and the mechanical contract (flagged >= 1 stub
// record, control 0) yields the distinct token-saver-contract finding when
// violated — never a silent PASS. token_saver_control is controller-internal
// wiring: excluded from --context passthrough, and the flag is appended ONLY
// for token-saver cases.
//
// Zero-token by construction: the dry-run hook (TT_DRY_RUN_REAL_LAUNCH)
// records both argvs without spawning anything; the real-launch controls point
// the `tamandua` executable at a throwaway PATH stub that records argv, emits
// canned run ids + terminal statuses, and (where the scenario requires) drives
// the managed stub against a throwaway fake pi — no model, no real harness,
// no token spend.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const binDir = path.join(ttRoot, "bin");
const controller = path.join(binDir, "tt-controller");
const varRoot = path.join(ttRoot, "var");
const adaptersBin = path.join(varRoot, "adapters-bin");
const resultsRoot = path.join(varRoot, "results");
const containedDb = path.join(varRoot, "home", ".tamandua", "tamandua.db");

const FLAG = "--no-hurry-please-save-tokens-mode";
const CAMPAIGN_LINE = /^Campaign:\s+(campaign-[^\s]+)$/m;

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runTt(args: string[], extraEnv: Record<string, string> = {}): RunResult {
  // The real-launch adapter tests spawn the contained launch path; strip the
  // node:test guard vars from the controller's spawn env (documented
  // self-test pattern — the controller's own containment layer stays active).
  const env = { ...process.env, HOME: os.homedir(), ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  delete env.TAMANDUA_TEST_GUARD;
  const res = spawnSync(process.execPath, [controller, ...args], {
    cwd: ttRoot,
    encoding: "utf8",
    timeout: 300_000,
    env,
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

// Read one case record VERBATIM from cases/tier1.jsonl by id.
function tier1Record(id: string): any {
  const lines = fs
    .readFileSync(path.join(ttRoot, "cases", "tier1.jsonl"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  const record = lines.find((item) => item.id === id);
  assert.ok(record, `cases/tier1.jsonl must contain the case ${id}`);
  return structuredClone(record);
}

// The W3.23 record minus its gating oracles: the adapter mechanics are the
// subject here; real oracles are exercised elsewhere. Everything else
// (workflow, fixture, harness, caps, requires) stays verbatim.
function tokenSaverCaseRecord(): any {
  const record = tier1Record("W3.23-token-saver");
  return { ...record, oracles: [] };
}

// Write a temp manifest under var/ (gitignored). Returns the manifest path.
function writeManifest(records: any[]): string {
  const manifestPath = path.join(varRoot, `US010-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.jsonl`);
  fs.writeFileSync(manifestPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return manifestPath;
}

function campaignIdOf(res: RunResult): string | null {
  const match = CAMPAIGN_LINE.exec(res.stdout);
  return match === null ? null : match[1];
}

function caseStateOf(campaignId: string, caseId: string): any {
  const state = loadJson(path.join(resultsRoot, campaignId, "state.json"));
  return state.cases.find((caseState: any) => caseState.id === caseId);
}

function campaignState(campaignId: string): any {
  return loadJson(path.join(resultsRoot, campaignId, "state.json"));
}

function cleanupCampaign(campaignId: string | null, manifestPath: string, outPath: string | null = null) {
  fs.rmSync(manifestPath, { force: true });
  if (outPath !== null) fs.rmSync(outPath, { force: true });
  if (campaignId !== null) {
    fs.rmSync(path.join(resultsRoot, campaignId), { recursive: true, force: true });
  }
}

function ensureTtTsGolden() {
  if (!fs.existsSync(path.join(varRoot, "fixtures", "golden", "tt-ts.git"))) {
    const res = spawnSync(process.execPath, [path.join(binDir, "tt-golden-bootstrap.mjs"), "--fixture", "tt-ts"], {
      cwd: ttRoot,
      encoding: "utf8",
      timeout: 300_000,
    });
    assert.equal(res.status, 0, `tt-ts golden bootstrap failed: ${res.stderr}`);
  }
}

// Seed the contained real-home workflow DB (runs/steps tables). The adapter's
// discovered-run convergence reads the complete run inventory; the stub
// tamandua serves an empty inventory, so the tables just need to exist.
function seedContainedDb() {
  fs.mkdirSync(path.dirname(containedDb), { recursive: true });
  const database = new DatabaseSync(containedDb);
  database.exec(`CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, task TEXT NOT NULL,
    status TEXT NOT NULL, context TEXT NOT NULL DEFAULT '{}',
    tokens_spent INTEGER NOT NULL DEFAULT 0, scheduling_status TEXT,
    scheduling_requested_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS steps (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL,
    agent_id TEXT NOT NULL, step_index INTEGER NOT NULL, status TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'single', current_story_id TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0, abandoned_count INTEGER NOT NULL DEFAULT 0,
    reroute_count INTEGER NOT NULL DEFAULT 0, claim_pid INTEGER,
    claim_updated_at TEXT, updated_at TEXT NOT NULL
  );`);
  database.close();
}

// Install a throwaway `tamandua` PATH stub + fake pi that drive the paired
// launch. The stub bakes absolute paths (the controller strips TT_*/TAMANDUA_*
// from its spawn env) and records one JSON line per `workflow run` invocation:
//   { argv, at, stub_present }
// `mode` selects the scenario:
//   contract-ok    the flagged run invokes the managed stub ONCE (fake pi);
//                  the control run invokes nothing;
//   flagged-zero   the flagged run never invokes the managed stub;
//   control-stray  the flagged run invokes the stub once AND the control run
//                  appends a stray stub record directly to the evidence log
//                  (simulating a stub leak during the control window).
function installPairedLaunchStub(stubBin: string, mode: string): { marker: string; fakePiMarker: string } {
  const marker = path.join(stubBin, "launch-observations.jsonl");
  const fakePiMarker = path.join(stubBin, "fake-pi-calls.jsonl");
  const fakePi = path.join(stubBin, "fake-pi");
  const stub = path.join(stubBin, "tamandua");
  fs.writeFileSync(fakePi, `#!/usr/bin/env bash\nprintf '%s\\n' "$(node -e 'process.stdout.write(JSON.stringify({argv:process.argv.slice(1),at:Date.now()}))' -- "$@")" >> ${JSON.stringify(fakePiMarker)}\nexit 0\n`);
  fs.chmodSync(fakePi, 0o755);
  fs.writeFileSync(stub, `#!/usr/bin/env bash
ADAPTERS_BIN=${JSON.stringify(adaptersBin)}
RESULTS=${JSON.stringify(resultsRoot)}
MARKER=${JSON.stringify(marker)}
FAKE_PI=${JSON.stringify(fakePi)}
MODE=${JSON.stringify(mode)}
record_launch() {
  stub_present=false
  [ -x "$ADAPTERS_BIN/pi-token-saver" ] && stub_present=true
  node -e 'const { argv } = process; process.stdout.write(JSON.stringify({ argv: argv.slice(1, -1), at: Date.now(), stub_present: argv[argv.length - 1] === "true" }) + "\\n")' "$@" "$stub_present" >> "$MARKER"
}
if [ "\${1:-}" = "workflow" ] && [ "\${2:-}" = "run" ]; then
  record_launch "$@"
  case "$*" in
    *--no-hurry-please-save-tokens-mode*)
      printf '%s\\n' "Run: run-aaaa1111-2222-4333-8444-555555555555"
      if [ -x "$ADAPTERS_BIN/pi-token-saver" ] && [ "$MODE" != "flagged-zero" ]; then
        TAMANDUA_PI_BINARY="$FAKE_PI" "$ADAPTERS_BIN/pi-token-saver" --simulated-work-spawn
      fi
      printf '%s\\n' '{"runs":[{"runId":"run-aaaa1111-2222-4333-8444-555555555555","status":"completed"}]}'
      exit 0
      ;;
    *)
      printf '%s\\n' "Run: run-bbbb2222-3333-4444-8555-666666666666"
      if [ "$MODE" = "control-stray" ]; then
        LOG="$(ls -t "$RESULTS"/campaign-*/evidence/W3.23-token-saver/attempt-1/token-saver-evidence.jsonl 2>/dev/null | head -1)"
        if [ -n "\${LOG:-}" ]; then
          printf '%s\\n' '{"ts":"2026-08-14T00:00:00.000Z","pid":9999,"argv0":"pi-token-saver (test-injected stray)","argv":[],"resolved_pi":"fake"}' >> "$LOG"
        fi
      fi
      printf '%s\\n' '{"runs":[{"runId":"run-bbbb2222-3333-4444-8555-666666666666","status":"completed"}]}'
      exit 0
      ;;
  esac
fi
if [ "\${1:-}" = "workflow" ] && [ "\${2:-}" = "status" ]; then
  case "\${3:-}" in
    run-aaaa1111-2222-4333-8444-555555555555)
      printf '%s\\n' '{"runId":"run-aaaa1111-2222-4333-8444-555555555555","status":"completed","tokensSpent":13,"steps":[]}' ;;
    run-bbbb2222-3333-4444-8555-666666666666)
      printf '%s\\n' '{"runId":"run-bbbb2222-3333-4444-8555-666666666666","status":"completed","tokensSpent":17,"steps":[]}' ;;
    *) exit 9 ;;
  esac
  exit 0
fi
if [ "\${1:-}" = "workflow" ] && [ "\${2:-}" = "runs" ]; then
  printf '%s\\n' '{"runs":[]}'
  exit 0
fi
exit 0
`);
  fs.chmodSync(stub, 0o755);
  return { marker, fakePiMarker };
}

function realPairEnv(stubBin: string): Record<string, string> {
  return {
    PATH: `${stubBin}:${process.env.PATH ?? ""}`,
    TT_CONTROLLER_PREFLIGHT_DISABLED: "1",
    TT_CONTROLLER_TOKEN_SETTLE_MS: "100",
    TT_CONTROLLER_POLL_INTERVAL_MS: "200",
    TT_CONTROLLER_CAP_CHECK_INTERVAL_MS: "200",
    // S24 (US-007): the contained daemon's PATH (seam-injected — no real
    // daemon runs inside this self-test) carries var/adapters-bin FIRST, so
    // the flagged-launch preflight's daemon-PATH containment assertion is
    // verifiable and healthy (the red preflight cases override this with the
    // leak shape).
    TT_CONTROLLER_DAEMON_ENVIRON_SAMPLE: `${adaptersBin}:/usr/bin:/bin`,
  };
}

// Assert the pair's entry-level evidence shape on a completed adapter attempt.
function assertPairEntry(entry: any, role: string, runId: string) {
  assert.equal(entry.role, role);
  assert.ok(Array.isArray(entry.argv) && entry.argv.includes("tamandua"), `${role}: entry must carry the exact argv`);
  assert.ok(!entry.argv.includes("token_saver_control"), `${role}: token_saver_control must never appear in the launch argv`);
  assert.equal(entry.run_id, runId, `${role}: run id must be bound to the entry`);
  assert.equal(entry.terminal_status, "completed", `${role}: run must be terminal-completed`);
  assert.ok(Number.isSafeInteger(entry.stub_records) && entry.stub_records >= 0,
    `${role}: stub-records count must be recorded`);
  assert.ok(Array.isArray(entry.token_ledger?.observations),
    `${role}: the per-run token-ledger observations must be recorded`);
  assert.ok(entry.token_ledger.observations.every((obs: any) => obs.run_id === runId),
    `${role}: every per-run token observation must bind to the run id`);
}

describe("US-010 token-saver paired launch adapter (S12 controller)", () => {
  it("AC1: dry-run evidence for W3.23 records exactly two launch argvs with the flag only on the flagged one", () => {
    const manifestPath = writeManifest([tokenSaverCaseRecord()]);
    const outPath = path.join(varRoot, `us010-dry-${Date.now()}-${process.pid}.jsonl`);
    fs.rmSync(outPath, { force: true });
    let res!: RunResult;
    let campaignId: string | null = null;
    try {
      res = runTt(["--manifest", path.relative(ttRoot, manifestPath)], {
        TT_DRY_RUN_REAL_LAUNCH: outPath,
      });
      campaignId = campaignIdOf(res);
    } finally {
      fs.rmSync(manifestPath, { force: true });
    }
    assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);
    assert.equal(res.status, 0, `dry-run campaign must exit 0:\n${res.stdout}${res.stderr}`);

    const records = fs.readFileSync(outPath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 2, "the token-saver dry run must record EXACTLY two launch argvs");
    assert.deepEqual(records.map((record) => record.launch_role).sort(), ["control", "flagged"],
      "both records must carry launch_role flagged/control");
    assert.ok(records.every((record) => record.token_saver_case === true),
      "both records must carry the token_saver_case marker");
    const flagged = records.find((record) => record.launch_role === "flagged");
    const control = records.find((record) => record.launch_role === "control");
    assert.ok(flagged.argv.includes(FLAG), "the flagged argv must carry --no-hurry-please-save-tokens-mode");
    assert.ok(!control.argv.includes(FLAG), "the control argv must NOT carry the flag");
    assert.ok(!flagged.argv.includes("token_saver_control") && !control.argv.includes("token_saver_control"),
      "token_saver_control must never reach the launch argv (--context exclusion)");
    for (const record of records) {
      assert.equal(record.workflow, "do-now");
      assert.equal(record.executable, "tamandua");
      assert.ok(record.argv.includes("--pi-as-harness"));
      assert.ok(record.argv.includes("--wait") && record.argv.includes("--json"));
      assert.ok(record.work_clone.existed === true, "the provisioned clone must exist at argv-capture time");
    }

    const caseState = caseStateOf(campaignId, "W3.23-token-saver");
    assert.equal(caseState.outcome, "PASS", "the dry-run case must be PASS (zero tokens)");
    const attempt = caseState.attempts[0];
    assert.equal(attempt.dry_run_launch, true);
    assert.equal(attempt.token_saver.adapter, "token-saver-paired-launch");
    assert.equal(attempt.token_saver.status, "dry-run-complete");
    assert.equal(attempt.token_saver.launches.length, 2);
    const flaggedEntry = attempt.token_saver.launches.find((entry: any) => entry.role === "flagged");
    const controlEntry = attempt.token_saver.launches.find((entry: any) => entry.role === "control");
    assert.ok(flaggedEntry.argv.includes(FLAG) && flaggedEntry.flag_present === true);
    assert.ok(!controlEntry.argv.includes(FLAG) && controlEntry.flag_present === false);
    assert.deepEqual(attempt.dry_run_argv.map((argv: string[]) => argv.includes(FLAG)), [true, false],
      "attempt.dry_run_argv must carry both argvs (flag only on the flagged one)");
    assert.equal(flaggedEntry.stub.outcome, "dry-run-skipped");
    assert.equal(controlEntry.stub.outcome, "dry-run-skipped");
    assert.equal(campaignState(campaignId).spend.tokens_observed, 0, "the dry run spends zero tokens");

    cleanupCampaign(campaignId, manifestPath, outPath);
  });

  it("AC5: no non-token-saver case ever receives the flag and its argv/record shape is unchanged", () => {
    const manifestPath = writeManifest([tokenSaverCaseRecord(), tier1Record("W1.L2-ts")]);
    const outPath = path.join(varRoot, `us010-dry-mixed-${Date.now()}-${process.pid}.jsonl`);
    fs.rmSync(outPath, { force: true });
    let res!: RunResult;
    let campaignId: string | null = null;
    try {
      res = runTt(["--manifest", path.relative(ttRoot, manifestPath)], {
        TT_DRY_RUN_REAL_LAUNCH: outPath,
      });
      campaignId = campaignIdOf(res);
    } finally {
      fs.rmSync(manifestPath, { force: true });
    }
    assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);
    assert.equal(res.status, 0, `dry-run campaign must exit 0:\n${res.stdout}${res.stderr}`);

    const records = fs.readFileSync(outPath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    const w323 = records.filter((record) => record.case_id === "W3.23-token-saver");
    const ts = records.filter((record) => record.case_id === "W1.L2-ts");
    assert.equal(w323.length, 2, "W3.23 must record exactly two argvs");
    assert.equal(ts.length, 1, "a non-token-saver case must record exactly one argv");
    assert.ok(!ts[0].argv.includes(FLAG), "no non-token-saver case ever gets the flag");
    assert.equal(ts[0].launch_role, undefined, "non-token-saver records carry no launch_role");
    assert.equal(ts[0].token_saver_case, undefined, "non-token-saver records carry no token_saver_case marker");
    assert.ok(!ts[0].argv.includes("token_saver_control"));
    // The W1.L2-ts argv is byte-identical to the pre-adapter shape (US-008 AC4).
    assert.deepEqual(ts[0].argv.slice(1), [
      "workflow", "run", "tt-shim-probe",
      "--task-file", "cases/tasks/tier1/W1.L2-ts.md",
      "--context", "test_cmd=npm test",
      "--pi-as-harness",
      "--working-directory-for-harness",
      path.join(varRoot, "fixtures", "work", "W1.L2-ts", "tt-ts"),
      "--wait", "--json",
    ], "a non-token-saver case's argv must be unchanged by the adapter");

    const tsState = caseStateOf(campaignId, "W1.L2-ts");
    assert.equal(tsState.attempts[0].token_saver, undefined,
      "non-token-saver attempts must not carry token_saver evidence");

    cleanupCampaign(campaignId, manifestPath, outPath);
  });

  it("a scripted case carrying token_saver_control fails closed with token-saver-scripted-unsupported", () => {
    const record = tokenSaverCaseRecord();
    record.id = "TS-SCRIPTED";
    record.context = { ...record.context, execution_mode: "scripted" };
    const manifestPath = writeManifest([record]);
    let res!: RunResult;
    let campaignId: string | null = null;
    try {
      res = runTt(["--manifest", path.relative(ttRoot, manifestPath)], {
        TT_CONTROLLER_PREFLIGHT_DISABLED: "1",
      });
      campaignId = campaignIdOf(res);
    } finally {
      fs.rmSync(manifestPath, { force: true });
    }
    assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);
    assert.equal(res.status, 2, "a fail-closed TEST_INFRA campaign exits 2 (INFRA_FAILURE)");

    const caseState = caseStateOf(campaignId, "TS-SCRIPTED");
    assert.equal(caseState.outcome, "TEST_INFRA_FAIL");
    assert.equal(caseState.attempts.length, 1, "the guard records exactly one launch-intent attempt");
    const attempt = caseState.attempts[0];
    assert.equal(attempt.classification_reason.category, "token-saver-scripted-unsupported",
      "the distinct fail-closed reason must be token-saver-scripted-unsupported");
    assert.equal(attempt.token_saver_adapter.resolution, "token-saver-scripted-unsupported");
    assert.ok(!fs.existsSync(path.join(resultsRoot, campaignId, "evidence", "TS-SCRIPTED")),
      "the scripted guard must never reach a spawn (no launch evidence dir)");

    cleanupCampaign(campaignId, manifestPath);
  });

  it("AC2/AC3: the real pair runs flagged+control — stub present only in the flagged window, both ledgers recorded, contract ok", () => {
    ensureTtTsGolden();
    seedContainedDb();
    const stubBin = fs.mkdtempSync(path.join(os.tmpdir(), "us010-pair-"));
    const { marker, fakePiMarker } = installPairedLaunchStub(stubBin, "contract-ok");
    const manifestPath = writeManifest([tokenSaverCaseRecord()]);
    let res!: RunResult;
    let campaignId: string | null = null;
    let markerContent = "";
    let fakePiContent = "";
    try {
      res = runTt(["--manifest", path.relative(ttRoot, manifestPath)], realPairEnv(stubBin));
      campaignId = campaignIdOf(res);
      if (fs.existsSync(marker)) markerContent = fs.readFileSync(marker, "utf8");
      if (fs.existsSync(fakePiMarker)) fakePiContent = fs.readFileSync(fakePiMarker, "utf8");
    } finally {
      fs.rmSync(manifestPath, { force: true });
      fs.rmSync(stubBin, { recursive: true, force: true });
    }
    assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);
    assert.equal(res.status, 0, `the pair campaign must exit 0:\n${res.stdout}${res.stderr}`);

    const caseState = caseStateOf(campaignId, "W3.23-token-saver");
    assert.equal(caseState.outcome, "PASS", `the satisfied contract must PASS:\n${JSON.stringify(caseState.reason)}`);
    assert.equal(caseState.attempts.length, 1, "the pair runs inside ONE attempt");
    assert.deepEqual(caseState.findings.map((finding: any) => finding.type), [],
      "a satisfied contract must not produce the token-saver-contract finding");
    const attempt = caseState.attempts[0];
    assert.equal(attempt.token_saver.adapter, "token-saver-paired-launch");
    assert.equal(attempt.token_saver.status, "terminal");

    const launches = attempt.token_saver.launches;
    assert.equal(launches.length, 2, "exactly two launches");
    const flagged = launches.find((entry: any) => entry.role === "flagged");
    const control = launches.find((entry: any) => entry.role === "control");
    assert.ok(flagged, "flagged entry present");
    assert.ok(control, "control entry present");
    assert.ok(flagged.argv.includes(FLAG) && flagged.flag_present === true);
    assert.ok(!control.argv.includes(FLAG) && control.flag_present === false);
    assert.notEqual(flagged.run_id, control.run_id, "the two runs must have distinct run ids");
    assertPairEntry(flagged, "flagged", "run-aaaa1111-2222-4333-8444-555555555555");
    assertPairEntry(control, "control", "run-bbbb2222-3333-4444-8555-666666666666");

    // S24 (US-007): the flagged launch passed the preflight — the stub target
    // was preflight-clean (absent at the pre-install check) and the contained
    // daemon PATH (seam-verified) carries adapters-bin FIRST. The preflight
    // evidence rides the flagged entry.
    const preflight = flagged.preflight;
    assert.ok(preflight, "the flagged entry must carry the S24 preflight evidence");
    assert.equal(preflight.ok, true, `flagged preflight must pass: ${JSON.stringify(preflight)}`);
    assert.equal(preflight.stub_target_ok, true,
      `stub target must be preflight-clean: ${JSON.stringify(preflight.stub_target)}`);
    assert.ok(["absent", "managed-file"].includes(preflight.stub_target_state),
      `stub target state must be absent (pre-install) or managed-file: ${preflight.stub_target_state}`);
    assert.equal(preflight.daemon_path.ok, true,
      `daemon PATH containment must pass: ${JSON.stringify(preflight.daemon_path)}`);
    assert.equal(preflight.daemon_path.verifiable, true);
    assert.match(preflight.checked_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      "preflight must carry a UTC checked_at");
    assert.equal(preflight.adapters_bin, adaptersBin);
    assert.equal(preflight.stub_target, path.join(adaptersBin, "pi-token-saver"));

    // Per-run token ledger: 13 tokens attributed to the flagged run, 4 more to
    // the control (17 total on the shared attempt ledger).
    assert.equal(flagged.token_ledger.tokens_observed, 13);
    assert.ok(flagged.token_ledger.observations.some((obs: any) => obs.attributed_delta === 13));
    assert.equal(control.token_ledger.tokens_observed, 17);
    assert.ok(control.token_ledger.observations.some((obs: any) => obs.attributed_delta === 4));
    assert.equal(attempt.tokens_observed, 17, "the attempt-level ledger aggregates both runs");
    assert.equal(campaignState(campaignId).spend.tokens_observed, 17,
      "the campaign ledger attributes both runs' spend to the one case");

    // AC2: the managed stub exists on PATH only during the flagged window.
    assert.equal(flagged.stub.stub_present, true, "the stub must be present during the flagged window");
    assert.equal(control.stub.stub_present, false, "the stub must be absent during the control window");
    assert.equal(flagged.stub_records, 1, "the flagged run must record one stub work-spawn record");
    assert.equal(control.stub_records, 0, "the control run must record zero stub records");
    assert.equal(flagged.stub_record_lines.length, 1);
    const record = JSON.parse(flagged.stub_record_lines[0]);
    assert.deepEqual(record.argv, ["--simulated-work-spawn"], "the stub record must carry the invocation argv");
    assert.equal(typeof record.resolved_pi, "string", "the stub record must name the resolved real pi");
    assert.ok(!fs.existsSync(path.join(adaptersBin, "pi-token-saver")),
      "the managed stub must be removed after the pair");

    // The launch-observation stub corroborates the window invariant at the
    // exact launch instants.
    const observations = markerContent
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    assert.equal(observations.length, 2, "exactly two launch invocations");
    assert.equal(observations[0].stub_present, true, "first (flagged) launch sees the stub on PATH");
    assert.equal(observations[1].stub_present, false, "second (control) launch sees no stub on PATH");
    assert.ok(observations[0].argv.includes(FLAG) && !observations[1].argv.includes(FLAG));

    // Zero REAL tokens: the fake pi was invoked exactly once (by the managed
    // stub) and spent nothing.
    const fakePiCalls = fakePiContent
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    assert.equal(fakePiCalls.length, 1, "the managed stub must exec the real pi exactly once");
    assert.deepEqual(fakePiCalls[0].argv, ["--simulated-work-spawn"]);

    cleanupCampaign(campaignId, manifestPath);
  });

  it("AC4: zero stub records on the flagged run yields the token-saver-contract finding (never PASS)", () => {
    ensureTtTsGolden();
    seedContainedDb();
    const stubBin = fs.mkdtempSync(path.join(os.tmpdir(), "us010-fzero-"));
    installPairedLaunchStub(stubBin, "flagged-zero");
    const manifestPath = writeManifest([tokenSaverCaseRecord()]);
    let res!: RunResult;
    let campaignId: string | null = null;
    try {
      res = runTt(["--manifest", path.relative(ttRoot, manifestPath)], realPairEnv(stubBin));
      campaignId = campaignIdOf(res);
    } finally {
      fs.rmSync(manifestPath, { force: true });
      fs.rmSync(stubBin, { recursive: true, force: true });
    }
    assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);
    assert.equal(res.status, 1, "an INCONCLUSIVE campaign exits 1 (not a GREEN PASS)");

    const caseState = caseStateOf(campaignId, "W3.23-token-saver");
    assert.equal(caseState.outcome, "INCONCLUSIVE", "a violated contract must never be PASS");
    const attempt = caseState.attempts[0];
    assert.equal(attempt.classification_reason.category, "token-saver-contract-violated");
    const finding = caseState.findings.find((item: any) => item.type === "token-saver-contract");
    assert.ok(finding, "the distinct token-saver-contract finding must be recorded");
    assert.equal(finding.flagged_stub_records, 0);
    assert.equal(finding.control_stub_records, 0);
    assert.match(finding.message, /flagged run recorded zero stub work-spawn records/);
    const flagged = attempt.token_saver.launches.find((entry: any) => entry.role === "flagged");
    assert.equal(flagged.stub_records, 0);
    assert.equal(attempt.token_saver.contract.ok, false);

    cleanupCampaign(campaignId, manifestPath);
  });

  it("AC4: a stub record on the control run yields the token-saver-contract finding (never PASS)", () => {
    ensureTtTsGolden();
    seedContainedDb();
    const stubBin = fs.mkdtempSync(path.join(os.tmpdir(), "us010-cstray-"));
    installPairedLaunchStub(stubBin, "control-stray");
    const manifestPath = writeManifest([tokenSaverCaseRecord()]);
    let res!: RunResult;
    let campaignId: string | null = null;
    try {
      res = runTt(["--manifest", path.relative(ttRoot, manifestPath)], realPairEnv(stubBin));
      campaignId = campaignIdOf(res);
    } finally {
      fs.rmSync(manifestPath, { force: true });
      fs.rmSync(stubBin, { recursive: true, force: true });
    }
    assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);
    assert.equal(res.status, 1, "an INCONCLUSIVE campaign exits 1 (not a GREEN PASS)");

    const caseState = caseStateOf(campaignId, "W3.23-token-saver");
    assert.equal(caseState.outcome, "INCONCLUSIVE", "a violated contract must never be PASS");
    const attempt = caseState.attempts[0];
    assert.equal(attempt.classification_reason.category, "token-saver-contract-violated");
    const finding = caseState.findings.find((item: any) => item.type === "token-saver-contract");
    assert.ok(finding, "the distinct token-saver-contract finding must be recorded");
    assert.equal(finding.flagged_stub_records, 1);
    assert.equal(finding.control_stub_records, 1);
    assert.match(finding.message, /control run recorded 1 stub record/);
    const control = attempt.token_saver.launches.find((entry: any) => entry.role === "control");
    assert.equal(control.stub_records, 1, "the control run's stray stub record must be counted");
    assert.equal(control.stub_record_lines.length, 1);
    assert.equal(attempt.token_saver.contract.ok, false);

    cleanupCampaign(campaignId, manifestPath);
  });

  it("S24 preflight RED: a daemon PATH without the adapters-bin prepend fails the flagged launch closed with token-saver-preflight-failed BEFORE any launch", () => {
    ensureTtTsGolden();
    seedContainedDb();
    const stubBin = fs.mkdtempSync(path.join(os.tmpdir(), "us010-preflight-dpath-"));
    installPairedLaunchStub(stubBin, "contract-ok");
    const manifestPath = writeManifest([tokenSaverCaseRecord()]);
    let res!: RunResult;
    let campaignId: string | null = null;
    let markerContent = "";
    try {
      // The W3.23 leak shape: the operator's ~/.local/bin PRECEDES
      // var/adapters-bin on the contained daemon PATH (the daemon would
      // resolve a foreign pi-token-saver). The preflight must fail closed
      // with 'token-saver-preflight-failed' before the flagged launch.
      res = runTt(["--manifest", path.relative(ttRoot, manifestPath)], {
        ...realPairEnv(stubBin),
        TT_CONTROLLER_DAEMON_ENVIRON_SAMPLE: `${os.homedir()}/.local/bin:${adaptersBin}:/usr/bin:/bin`,
      });
      campaignId = campaignIdOf(res);
      const marker = path.join(stubBin, "launch-observations.jsonl");
      if (fs.existsSync(marker)) markerContent = fs.readFileSync(marker, "utf8");
    } finally {
      fs.rmSync(manifestPath, { force: true });
      fs.rmSync(stubBin, { recursive: true, force: true });
    }
    assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);
    assert.equal(res.status, 2, "a fail-closed TEST_INFRA campaign exits 2 (INFRA_FAILURE)");

    const caseState = caseStateOf(campaignId, "W3.23-token-saver");
    assert.equal(caseState.outcome, "TEST_INFRA_FAIL",
      `the preflight violation must classify TEST_INFRA_FAIL: ${JSON.stringify(caseState.reason)}`);
    const attempt = caseState.attempts[0];
    assert.equal(attempt.classification_reason?.category, "token-saver-preflight-failed",
      `the distinct fail-closed reason must be token-saver-preflight-failed: ${JSON.stringify(attempt.classification_reason)}`);
    assert.equal(attempt.classification_reason?.preflight?.daemon_path?.ok, false);
    assert.equal(attempt.classification_reason?.preflight?.daemon_path?.reason, "operator-bin-precedes");
    assert.equal(attempt.classification_reason?.preflight?.daemon_path?.operator_dir,
      path.join(os.homedir(), ".local", "bin"));
    const flagged = attempt.token_saver.launches.find((entry: any) => entry.role === "flagged");
    assert.equal(flagged.preflight?.ok, false, "the flagged entry must carry the failing preflight evidence");
    assert.equal(flagged.preflight?.daemon_path?.ok, false);
    assert.equal(flagged.preflight?.daemon_path?.verifiable, true);
    assert.equal(flagged.preflight?.daemon_path?.adapters_bin, adaptersBin);
    assert.ok(typeof flagged.preflight?.checked_at === "string");
    // The preflight fails BEFORE any launch: the launch-observation stub
    // (records one line per `workflow run`) saw no invocation at all.
    assert.equal(markerContent.trim(), "",
      "the preflight violation must fail before ANY launch (no launch argv recorded)");

    cleanupCampaign(campaignId, manifestPath);
  });

  it("S24 preflight RED: a stub target in adapters-bin that is not a usable managed regular file fails the flagged launch closed with token-saver-preflight-failed", () => {
    ensureTtTsGolden();
    seedContainedDb();
    const stubBin = fs.mkdtempSync(path.join(os.tmpdir(), "us010-preflight-stub-"));
    installPairedLaunchStub(stubBin, "contract-ok");
    // Poison the canonical stub target with a DIRECTORY (a "stub" that is not
    // a regular file — the managed install would refuse it; the preflight
    // fails closed FIRST with the distinct category). The adapters-bin
    // content is backed up/restored so a concurrent tt-token-saver-stub
    // install never sees a foreign target.
    const poisonTarget = path.join(adaptersBin, "pi-token-saver");
    let existingTarget: string | null = null;
    if (fs.existsSync(poisonTarget)) {
      existingTarget = path.join(adaptersBin, `pi-token-saver.us007-backup-${Date.now()}`);
      fs.renameSync(poisonTarget, existingTarget);
    }
    fs.mkdirSync(poisonTarget, { recursive: true });
    const manifestPath = writeManifest([tokenSaverCaseRecord()]);
    let res!: RunResult;
    let campaignId: string | null = null;
    let markerContent = "";
    let poisonUntouched = false;
    try {
      res = runTt(["--manifest", path.relative(ttRoot, manifestPath)], realPairEnv(stubBin));
      campaignId = campaignIdOf(res);
      const marker = path.join(stubBin, "launch-observations.jsonl");
      if (fs.existsSync(marker)) markerContent = fs.readFileSync(marker, "utf8");
      poisonUntouched = fs.existsSync(poisonTarget) && fs.statSync(poisonTarget).isDirectory();
    } finally {
      fs.rmSync(poisonTarget, { recursive: true, force: true });
      if (existingTarget !== null) fs.renameSync(existingTarget, poisonTarget);
      fs.rmSync(manifestPath, { force: true });
      fs.rmSync(stubBin, { recursive: true, force: true });
    }
    assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);
    assert.equal(res.status, 2, "a fail-closed TEST_INFRA campaign exits 2 (INFRA_FAILURE)");

    const caseState = caseStateOf(campaignId, "W3.23-token-saver");
    assert.equal(caseState.outcome, "TEST_INFRA_FAIL",
      `the stub-target violation must classify TEST_INFRA_FAIL: ${JSON.stringify(caseState.reason)}`);
    const attempt = caseState.attempts[0];
    assert.equal(attempt.classification_reason?.category, "token-saver-preflight-failed",
      `the distinct fail-closed reason must be token-saver-preflight-failed: ${JSON.stringify(attempt.classification_reason)}`);
    assert.equal(attempt.classification_reason?.preflight?.stub_target_ok, false);
    assert.equal(attempt.classification_reason?.preflight?.stub_target_state, "not-regular-file");
    const flagged = attempt.token_saver.launches.find((entry: any) => entry.role === "flagged");
    assert.equal(flagged.preflight?.ok, false, "the flagged entry must carry the failing preflight evidence");
    assert.equal(flagged.preflight?.stub_target_ok, false);
    assert.equal(flagged.preflight?.stub_target_state, "not-regular-file");
    assert.equal(flagged.preflight?.stub_target, poisonTarget);
    // The preflight fails BEFORE any launch — and before the managed install
    // ever runs (the poison target is still the directory at the end).
    assert.equal(markerContent.trim(), "",
      "the stub-target violation must fail before ANY launch (no launch argv recorded)");
    assert.ok(poisonUntouched,
      "the poisoned target must remain untouched (the preflight fails before the install)");

    cleanupCampaign(campaignId, manifestPath);
  });
});
