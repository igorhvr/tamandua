// Tier-1 integration gate (US-009): Proof test — the fail-closed path triggers
// (exit 2, INFRA_FAILURE, non-GREEN) when an --include-real campaign launches
// ZERO real cases. Zero tokens.
//
// E2.2 root cause: an --include-real campaign in which EVERY real case is
// predicate-blocked still reported GREEN (exit 0) — the same fail-open class as
// the all-skipped validate-all defect (FIX6). US-005 landed the fail-closed
// verdict guard in tt-report.mjs; this file is the end-to-end PROOF that the
// guard actually fires on the real campaign path.
//
// The proof works by building a COPY of the tier1 manifest (under gitignored
// var/) in which every real (pi/hermes) case's `requires.capabilities` is
// pointed at an impossible capability (`definitely-absent-capability`) so that
// ZERO real cases can launch (applyHostRequirements honestly gates each one
// NOT_RUN(predicate) with expected/observed evidence). Running the include-real
// campaign (tt-controller in real mode, execution_selection 'all') against that
// copy MUST:
//   (a) exit with code 2,
//   (b) carry a distinct non-GREEN INFRA_FAILURE verdict NAMING the
//       zero-real-launches cause (never a vacuous GREEN),
//   (c) leave the ORIGINAL cases/tier1.jsonl byte-for-byte untouched.
//
// The 4 scripted local cases (W2.21/W2.23*) still execute through the scripted
// daemon (zero tokens) as part of the campaign, faithfully matching the
// include-real campaign shape. TAMANDUA_PI_BINARY/HERMES_BINARY backstops guard
// against any accidental real model invocation, so the proof is always
// zero-token even if a real case somehow slipped through.
//
// Confined to torture-test/ (writes under gitignored var/). Zero tokens.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createHash } from "node:crypto";
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

const CAMPAIGN_LINE = /^Campaign:\s+(campaign-[A-Za-z0-9._-]+)$/m;
const SCRIPTED_PORTS = [5334, 5338, 5339];
const IMPOSSIBLE_CAP = "definitely-absent-capability";

type CommandResult = { status: number | null; stdout: string; stderr: string };
type CaseRecord = { id: string; harness?: string; requires?: Record<string, unknown> };

// Assert every real (pi/hermes) manifest case carries the impossible capability
// in its `requires.capabilities` after our copy transform.
function assertRealCasesBlocked(records: CaseRecord[]): void {
  const real = records.filter((r) => r.harness === "pi" || r.harness === "hermes");
  assert.ok(real.length > 0, "the tier1 manifest must contain real pi/hermes cases");
  for (const r of real) {
    const caps = (r.requires?.capabilities as string[] | undefined) ?? [];
    assert.ok(caps.includes(IMPOSSIBLE_CAP), `${r.id}: must carry the impossible capability`);
  }
}

// Build a COPY of the tier1 manifest, confined under gitignored var/, with every
// real case's requires pointed at the impossible capability. Returns the copy path.
function buildBlockedManifestCopy(): string {
  const dir = path.join(varRoot, "us009-manifest-copy");
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, "tier1-zero-real.jsonl");
  const records: CaseRecord[] = [];
  for (const line of fs.readFileSync(MANIFEST, "utf8").split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const record = JSON.parse(line) as CaseRecord;
    if (record.harness === "pi" || record.harness === "hermes") {
      const caps = new Set<string>(Array.isArray(record.requires?.capabilities) ? record.requires!.capabilities as string[] : []);
      caps.add(IMPOSSIBLE_CAP);
      record.requires = { ...(record.requires ?? {}), capabilities: [...caps] };
    }
    records.push(record);
  }
  assertRealCasesBlocked(records);
  fs.writeFileSync(outPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return outPath;
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// node:test marks descendant processes; the campaign drives the scripted daemon
// on the fixed TT ports (5334/5338/5339) under the gitignored TT home, so
// disable only the live-state guard and drop NODE_TEST_CONTEXT (mirrors
// tier1-include-real-proof.test.ts). /bin/false backstops guard against any
// accidental real model invocation.
const campaignEnv: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
};

function run(file: string, args: string[], env = campaignEnv, timeout = 1200_000): CommandResult {
  const result = spawnSync(file, args, { cwd: repoRoot, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout });
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

// Ensure the real host-profile exists; the campaign loads it to evaluate
// predicates (US-003/004 proved tt-verify-environment --fast produces it
// truthfully and ZERO-token).
function ensureHostProfile(): void {
  if (fs.existsSync(hostProfilePath)) return;
  const res = run(verifyEnv, ["--fast", "--json"]);
  assert.equal(res.status, 0, `tt-verify-environment --fast failed:\n${res.stderr}${res.stdout}`);
  assert.ok(fs.existsSync(hostProfilePath), "host-profile.json must be produced");
}

it("US-009: zero-real-launched include-real campaign exits 2 (INFRA_FAILURE) naming the cause; original manifest untouched; zero tokens", { timeout: 25 * 60 * 1000 }, async () => {
  // Hygiene: no lingering scripted daemon from a prior test, ports free.
  const initialStop = run(daemonControl, ["scripted", "stop"], process.env);
  assert.equal(initialStop.status, 0, `${initialStop.stdout}\n${initialStop.stderr}`);
  await assertPortsFree();
  const before = gitSnapshot();
  const originalHash = sha256(MANIFEST);
  ensureHostProfile();

  // Copy the tier1 manifest under gitignored var/ with every real case's
  // requires pointing at the impossible capability (=> 0 real cases launch).
  const copyPath = buildBlockedManifestCopy();
  const copyHash = sha256(copyPath);

  let result!: CommandResult;
  let campaignId: string | null = null;
  try {
    // Run the include-real campaign against the COPY: tt-controller in real
    // mode (no --scripted-only => execution_selection 'all'). The launcher
    // hardcodes cases/tier1.jsonl, so we invoke the controller directly with
    // the copy (still the include-real controller path). The impossible
    // capability gates every real case NOT_RUN(predicate) BEFORE execution.
    result = await runStreaming(controller, ["--manifest", copyPath], campaignEnv);
    const m = CAMPAIGN_LINE.exec(result.stdout);
    campaignId = m === null ? null : m[1];

    assert.ok(campaignId, `include-real campaign did not print a campaign ID:\n${result.stdout}\n${result.stderr}`);
    const campaignDir = path.join(resultsRoot, campaignId);
    const report = loadJson(path.join(campaignDir, "report.json"));
    const state = loadJson(path.join(campaignDir, "state.json"));

    // The include-real (real-mode) intent was honored end-to-end.
    assert.equal(state.options.execution_selection, "all",
      "include-real campaign must run in real mode (execution_selection 'all')");

    // AC1: exit code 2.
    assert.equal(result.status, 2, `zero-real-launched include-real campaign must exit 2:\n${result.stdout}\n${result.stderr}`);
    assert.equal(report.exit_code, 2, "report must carry exit code 2");

    // AC2: a distinct non-GREEN INFRA_FAILURE verdict NAMING the cause (not GREEN).
    assert.equal(report.verdict, "INFRA_FAILURE",
      "zero-real-launched include-real campaign must be a distinct non-GREEN INFRA_FAILURE");
    assert.ok(report.fail_closed.triggered === true,
      "fail_closed must be triggered when include-real launches zero real cases");
    assert.equal(typeof report.fail_closed.cause, "string");
    assert.ok(report.fail_closed.cause.length > 0);
    assert.match(report.fail_closed.cause, /zero real cases launched/,
      "report must name the zero-real-launches cause");
    // The controller streams its summary to stdout but writes the VERDICT/Cause
    // rendering to report.txt; assert the human-readable Cause line there.
    const reportTxt = fs.readFileSync(path.join(campaignDir, "report.txt"), "utf8");
    assert.ok(/Cause: include-real requested but zero real cases launched/.test(reportTxt),
      "renderCampaignReport must print the Cause: line naming the zero-real-launches cause");
    assert.match(reportTxt, /VERDICT\nINFRA_FAILURE \(exit 2\)/,
      "rendered report VERDICT must be the distinct non-GREEN INFRA_FAILURE (exit 2)");

    // Every real case honestly gated NOT_RUN(predicate) with evidence naming the
    // impossible capability (no silent skip, no launch). The 4 scripted local
    // cases still PASS through the scripted daemon.
    const realCases = state.cases.filter((c: any) => c.harness === "pi" || c.harness === "hermes");
    const scriptedCases = state.cases.filter((c: any) => c.harness !== "pi" && c.harness !== "hermes");
    assert.ok(realCases.length > 0, "state must contain real pi/hermes cases");
    for (const cs of realCases) {
      assert.equal(cs.outcome, "NOT_RUN", `${cs.id}: impossible capability must gate it NOT_RUN`);
      assert.equal(cs.reason?.category, "predicate", `${cs.id}: gating category must be predicate`);
      const evidence = cs.reason?.evidence;
      assert.ok(Array.isArray(evidence) && evidence.length > 0, `${cs.id}: predicate block must carry evidence`);
      const ev = evidence.find((e: any) => String(e.predicate).includes("capabilities.definitely-absent-capability"));
      assert.ok(ev, `${cs.id}: evidence must name the impossible capability`);
      assert.equal(ev.expected, true);
      assert.notEqual(ev.observed, true, `${cs.id}: evidence must record an honest non-present observed value`);
      assert.deepEqual(cs.attempts, [], `${cs.id}: must never have launched an attempt`);
      assert.equal(cs.spend?.tokens_observed ?? 0, 0, `${cs.id}: case spend ledger must be zero`);
    }
    for (const cs of scriptedCases) {
      assert.equal(cs.outcome, "PASS", `${cs.id}: scripted local case must PASS through the scripted daemon`);
    }

    // AC4: zero tokens across every spend ledger.
    assert.equal(report.spend.tokens_observed, 0, "report must show zero tokens observed");
    assert.equal(state.spend.tokens_observed, 0, "state spend ledger must show zero tokens");

    // AC3: the ORIGINAL tier1.jsonl is byte-for-byte unchanged by the copy-based run.
    assert.equal(sha256(MANIFEST), originalHash, "original tier1.jsonl must be unchanged by the copy-based run");

    // Hygiene: scripted daemon stops cleanly, ports free, git tree unchanged.
    const daemonStatus = run(daemonControl, ["scripted", "status"], process.env);
    assert.equal(daemonStatus.status, 0, daemonStatus.stderr);
    assert.match(daemonStatus.stdout, /^STATUS: STOPPED$/m);
    await assertPortsFree();
    assert.equal(gitSnapshot(), before, "copy-based campaign changed git status");
  } finally {
    if (campaignId !== null) {
      fs.rmSync(path.join(resultsRoot, campaignId), { recursive: true, force: true });
    }
    fs.rmSync(copyPath, { force: true });
    // The copy dir stamp is regenerated per run; keep an empty dir harmless.
  }
  // Defensive: the impl copy must have been consumed, not the original.
  assert.ok(copyHash.length === 64, "impl copy hash sanity");
});
