// Tier-1 integration gate (US-009): RED-then-GREEN proof for the bare vacuity
// guard (US-008). Zero tokens.
//
// This is the PROOF requested by the overall task (Proof #3): force every
// scripted cell in a bare campaign to predicate-skip on linux and show the
// campaign goes RED with the machine-parseable vacuous-campaign finding —
// where before US-008 the EXACT same configuration produced a vacuously GREEN
// exit 0 — and then show that a NORMAL bare tier1 selection is still GREEN.
//
// The RED arm reconstructs the a446deac defect shape faithfully on a copy of
// the REAL tier1 manifest (under gitignored var/, original byte-for-byte
// untouched): every scripted (non-pi/hermes/dsh) cell's `requires` is rewritten
// to {platform:"darwin"} — unexpectedly unsatisfiable on linux under a LOADED
// VALID host profile, so applyHostRequirements honestly gates each one
// NOT_RUN(predicate) with zero attempts (never host-profile-missing), exactly
// like the mac's missing /proc produced via US-006's worldview. The 24 real
// pi/hermes cells are pending-real (correct for bare mode). Running that copy
// bare (--scripted-only) MUST:
//   (a) exit with code 1 (FINDINGS) and NEVER render GREEN,
//   (b) carry report.vacuity.triggered=true and a campaign-level finding
//       {category:'vacuous-campaign', case_id:null} in report.json AND a
//       VACUOUS_CAMPAIGN line in report.txt (the regression this task fixes),
//   (c) record zero token spend and zero scripted attempts.
// RED LEG (the "pre-change it was GREEN" trajectory): the same harvested
// state.json is fed through the frozen pre-US-008 verdict arm
// (bin/tt-report-legacy-vacuity.mjs, byte-faithful to commit dafa40a7) which
// MUST return {verdict:'GREEN', exitCode:0} — pinning the vacuous GREEN that
// hid the defect. A faithfulness pin first diffs that arm against the
// embedded pre-US-008 function bodies below (self-contained — MACP5.1: the
// bodies were captured from dafa40a7 at authoring time, replacing `git show
// dafa40a7:torture-test/bin/tt-report.mjs`, whose commit is unreachable on
// merged main / fresh clones) so the GREEN claim is provably the pre-fix
// behavior, not a restatement.
//
// The GREEN arm (control, AC2) is a NORMAL bare tier1 selection: the ORIGINAL
// cases/tier1.jsonl run bare, where the 4 scripted local cells have
// SATISFIABLE requires (since MACP4 US-006:
// {"capabilities":["node-sqlite","daemon-scripted"],"node_min":22} — the
// daemon-scripted leaf is true on this linux host), so at least one scripted
// cell EXECUTES (through the zero-token scripted daemon) and the campaign is
// genuinely GREEN (exit 0) with vacuity silent. The control is what the task
// demands after the fix: the vacuity guard must not block legitimate bare
// campaigns.
//
// Confined to torture-test/ (writes under gitignored var/). The GREEN arm
// drives the scripted daemon on the fixed TT ports (5334/5338/5339), so the
// quiet-window port convention applies: stop any stray scripted daemon and
// assert ports free BEFORE starting, and repeat after. TAMANDUA_PI_BINARY /
// TAMANDUA_HERMES_BINARY backstops guard against any accidental real model
// invocation, so the proof is always zero-token.
//
// TT_SELF_TEST_VAR_ROOT: when set, the transient manifest copies written by
// this proof are isolated under that root instead of torture-test/var/ (the
// same seam oracles/self-test/run.sh uses). Campaign results always land in
// torture-test/var/results under a unique campaign id, which cannot collide
// with a concurrent run; the env seam only redirects this proof's own mutable
// fixture copies.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { it } from "node:test";

// Pre-US-008 function bodies, whitespace-normalized exactly as extractBody()
// compares (MACP5.1): the byte-faithfulness pin's self-contained source of
// truth. They were captured from commit dafa40a7 of
// torture-test/bin/tt-report.mjs (the last commit before US-008 ba3fc754
// added bareVacuityCause) at authoring time. Embedding them inline replaces
// `git show dafa40a7:<path>` — that commit exists only on the authoring
// branch and is unreachable on merged main / fresh clones, so any git-history
// resolution would break outside the authoring worktree.
const PRE_US008_VERDICT_EXIT_CODE_BODY =
  " const failClosedCause = zeroRealLaunchesCause(state); if (failClosedCause !== null) return { verdict: 'INFRA_FAILURE', exitCode: 2 }; if (hasInfrastructureFailure(state)) return { verdict: 'INFRA_FAILURE', exitCode: 2 }; // FIX10 US-005: a hygiene-canary diff (operator-identity file changed // during the campaign) is a campaign-level FINDING — never silent. const hygieneDiffs = state?.hygiene_canary?.diffs; if (Array.isArray(hygieneDiffs) && hygieneDiffs.length > 0) { return { verdict: 'FINDINGS', exitCode: 1 }; } const hasFinding = state.cases.some((item) => !['PASS', 'NOT_RUN'].includes(item.outcome) || (item.findings ?? []).length > 0); return hasFinding ? { verdict: 'FINDINGS', exitCode: 1 } : { verdict: 'GREEN', exitCode: 0 };";
const PRE_US008_ZERO_REAL_LAUNCHES_CAUSE_BODY =
  " if (!isRealMode(state)) return null; const realCases = (state?.cases ?? []).filter((item) => isRealHarness(item.harness)); if (realCases.length === 0) return null; const realLaunched = realCases.filter((item) => (item.attempts ?? []).length > 0).length; if (realLaunched > 0) return null; return `include-real requested but zero real cases launched (${realCases.length} real pi/hermes/dsh cases in manifest, execution_selection=all, but no real launch recorded)`;";
const PRE_US008_HAS_INFRASTRUCTURE_FAILURE_BODY =
  " return state.cases.some((item) => item.outcome === 'TEST_INFRA_FAIL' // MACP3 US-006: host-profile-missing is infrastructure failure REGARDLESS // of how it was persisted — applyHostRequirements records it as // TEST_INFRA_FAIL, but a legacy/other-NOT_RUN encoding must not be // treated as a normal green skip either. Never a vacuous NOT_RUN. || item.reason?.category === 'host-profile-missing' || (item.outcome === 'NOT_RUN' && !['predicate', 'pending-real', 'host-profile-missing'].includes(item.reason?.category)) || (item.oracle_results ?? []).some((result) => result.status === 'TEST_INFRA' || (result.status === 'VALID' && result.response?.result === 'ERROR')));";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const binDir = path.join(ttRoot, "bin");
const controller = path.join(binDir, "tt-controller");
const daemonControl = path.join(binDir, "daemon-control");
const verifyEnv = path.join(binDir, "tt-verify-environment");
const hostProfilePath = path.join(ttRoot, "var", "w0", "host-profile.json");
const MANIFEST = path.join(ttRoot, "cases", "tier1.jsonl");
const resultsRoot = path.join(ttRoot, "var", "results");
const legacyModulePath = path.join(binDir, "tt-report-legacy-vacuity.mjs");
const legacyModuleUrl = pathToFileURL(legacyModulePath);

// TT_SELF_TEST_VAR_ROOT isolation seam for this proof's transient fixtures
// (mirrors oracles/self-test/run.sh). Campaign results are read from the
// controller's real resultsRoot (unique campaign id => never collides), so
// only the mutable copy area is redirectable.
const isoVarRoot = process.env.TT_SELF_TEST_VAR_ROOT
  ? path.resolve(process.env.TT_SELF_TEST_VAR_ROOT)
  : path.join(ttRoot, "var");

const CAMPAIGN_LINE = /^Campaign:\s+(campaign-[A-Za-z0-9._-]+)$/m;
const SCRIPTED_PORTS = [5334, 5338, 5339];
const REAL_HARNESSES = new Set(["pi", "hermes", "dsh"]);
const UNSATISFIABLE_REQUIRES = { platform: "darwin" };

type CaseRecord = { id: string; harness?: string; requires?: Record<string, unknown> };
type CommandResult = { status: number | null; stdout: string; stderr: string };

// Rewrite every scripted (non-real) cell of a manifest copy so its requires is
// the single honest, unsatisfiable predicate {platform:"darwin"} — on linux
// under a LOADED valid profile that is NOT_RUN(predicate) with zero attempts,
// the exact a446deac skip shape. Real cells keep their real requires (they are
// pending-real in bare mode and their requires never evaluates). Returns the
// copy path under the isolated var root; the ORIGINAL manifest is untouched.
function buildAllSkipManifestCopy(): string {
  const dir = path.join(isoVarRoot, "us009-proof-fixtures");
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, "tier1-all-skipped.jsonl");
  const records: CaseRecord[] = [];
  for (const line of fs.readFileSync(MANIFEST, "utf8").split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const record = JSON.parse(line) as CaseRecord;
    if (!REAL_HARNESSES.has(String(record.harness))) {
      // Every scripted (non-pi/hermes/dsh) cell becomes legitimately
      // unsatisfiable on linux: NOT_RUN(predicate), zero attempts. This is the
      // fail-closed-vs-vacuous discriminator — NOT host-profile-missing, so
      // the campaign must trip the VACUITY guard, not US-006 infra.
      record.requires = { ...UNSATISFIABLE_REQUIRES };
    }
    records.push(record);
  }
  const scripted = records.filter((r) => !REAL_HARNESSES.has(String(r.harness)));
  assert.ok(scripted.length > 0, "the tier1 manifest must contain scripted cells");
  for (const r of scripted) {
    assert.deepEqual(r.requires, UNSATISFIABLE_REQUIRES,
      `${r.id}: scripted cell must carry the unsatisfiable darwin-only requires`);
  }
  fs.writeFileSync(outPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return outPath;
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// node:test marks descendant processes; the GREEN-arm campaign drives the
// scripted daemon on the fixed TT ports under the gitignored TT home, so
// disable only the live-state guard and drop NODE_TEST_CONTEXT (mirrors
// tier1-zero-real-launch-infra.test.ts). /bin/false backstops guard against
// any accidental real model invocation (zero tokens always).
const campaignEnv: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
};

function run(file: string, args: string[], env = campaignEnv, timeout = 300_000): CommandResult {
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

// Quiet-window port convention: the scripted daemon owns 5334/5338/5339, and a
// stray one from a concurrent/interrupted run must not poison this proof. Stop
// it first (assertPortsFree verifies the window is actually quiet) and stop it
// again after, exactly as the other scripted-daemon proofs do. Never weaken the
// environment gate — if the ports are busy the proof fails loudly.
async function assertPortsFree(): Promise<void> {
  for (const port of SCRIPTED_PORTS) {
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", (error) => reject(new Error(`scripted port ${port} is not free: ${error.message}`)));
      server.listen(port, "127.0.0.1", () => server.close((error) => (error ? reject(error) : resolve())));
    });
  }
}

// Ensure the real host-profile exists; predicates are evaluated against it, so
// an all-skipped arm must be NOT_RUN(predicate) under a LOADED VALID profile
// (never host-profile-missing). tt-verify-environment --fast produces it
// truthfully and ZERO-token (US-003/004-proven).
function ensureHostProfile(): void {
  if (fs.existsSync(hostProfilePath)) return;
  const res = run(verifyEnv, ["--fast", "--json"]);
  assert.equal(res.status, 0, `tt-verify-environment --fast failed:\n${res.stderr}${res.stdout}`);
  assert.ok(fs.existsSync(hostProfilePath), "host-profile.json must be produced");
}

// Extract the normalized body of `function NAME(state) { ... }` — the closing
// brace must be column 0 (true for every pinned function). Whitespace is
// collapsed so the pin is about the CODE, not formatting.
function extractBody(src: string, fnName: string): string {
  const re = new RegExp(`function\\s+${fnName}\\(state\\) \\{([\\s\\S]*?)\\n\\}`, "m");
  const m = src.match(re);
  assert.ok(m, `function ${fnName}(state) not found in source`);
  return m[1].replace(/\s+/g, " ");
}

it("US-009: legacy pre-US-008 verdict arm is byte-faithful (dafa40a7) and contains no vacuity guard", () => {
  const legacySrc = fs.readFileSync(legacyModulePath, "utf8");
  // The frozen arm's VERDICT MATH must carry no vacuity guard (the pre-US-008
  // source of truth had none — the module's own header comments may mention
  // bareVacuityCause as documentation, so the check is on the extracted code
  // bodies, which the byte-faithfulness assertions below pin to the pre-US-008
  // implementations).
  for (const [fn, body] of [
    ["legacyVerdictExitCode", PRE_US008_VERDICT_EXIT_CODE_BODY],
    ["zeroRealLaunchesCause", PRE_US008_ZERO_REAL_LAUNCHES_CAUSE_BODY],
    ["hasInfrastructureFailure", PRE_US008_HAS_INFRASTRUCTURE_FAILURE_BODY],
  ] as Array<[string, string]>) {
    assert.ok(
      !extractBody(legacySrc, fn).includes("bareVacuityCause"),
      `${fn} must not contain the vacuity guard (this is the pre-fix source of truth)`,
    );
    assert.ok(
      !body.includes("bareVacuityCause"),
      `embedded pre-US-008 ${fn} body must not contain the vacuity guard`,
    );
  }
  // The frozen arm's verdict math must stay byte-faithful to the actual
  // pre-fix implementation, or the RED leg's "pre-change it was GREEN" claim
  // becomes a restatement. Whitespace-normalized only. The pre-US-008 bodies
  // are embedded inline above (MACP5.1: self-contained — they were captured
  // from commit dafa40a7 at authoring time; git-history resolution of that
  // commit breaks on merged main, where it is unreachable).
  assert.equal(
    extractBody(legacySrc, "legacyVerdictExitCode"),
    PRE_US008_VERDICT_EXIT_CODE_BODY,
    "legacyVerdictExitCode must be byte-faithful to the pre-US-008 verdictExitCode (dafa40a7)",
  );
  assert.equal(
    extractBody(legacySrc, "zeroRealLaunchesCause"),
    PRE_US008_ZERO_REAL_LAUNCHES_CAUSE_BODY,
    "zeroRealLaunchesCause must be byte-faithful to the pre-US-008 implementation",
  );
  assert.equal(
    extractBody(legacySrc, "hasInfrastructureFailure"),
    PRE_US008_HAS_INFRASTRUCTURE_FAILURE_BODY,
    "hasInfrastructureFailure must be byte-faithful to the pre-US-008 implementation",
  );
});

it("US-009: RED arm — all-scripted-skipped bare tier1 => FINDINGS exit 1 with vacuous-campaign finding; pre-fix legacy verdict on the SAME state => vacuous GREEN (exit 0)", { timeout: 30 * 60 * 1000 }, async () => {
  // Hygiene: no lingering scripted daemon from a prior test — quiet window.
  const initialStop = run(daemonControl, ["scripted", "stop"], process.env);
  assert.equal(initialStop.status, 0, `${initialStop.stdout}\n${initialStop.stderr}`);
  await assertPortsFree();
  const before = gitSnapshot();
  const originalHash = sha256(MANIFEST);
  ensureHostProfile();

  // RED arm copy: every scripted cell carries {platform:"darwin"} => honest
  // NOT_RUN(predicate) with zero attempts on linux under a valid profile.
  const redManifest = buildAllSkipManifestCopy();

  let redResult!: CommandResult;
  let redCampaignId: string | null = null;
  try {
    redResult = await runStreaming(controller, ["--manifest", redManifest, "--scripted-only"], campaignEnv);
    const m = CAMPAIGN_LINE.exec(redResult.stdout);
    redCampaignId = m === null ? null : m[1];
    assert.ok(redCampaignId, `bare all-skipped campaign did not print a campaign ID:\n${redResult.stdout}\n${redResult.stderr}`);
    const campaignDir = path.join(resultsRoot, redCampaignId);
    const state = loadJson(path.join(campaignDir, "state.json"));
    const report = loadJson(path.join(campaignDir, "report.json"));

    // The bare intent was honored end-to-end.
    assert.equal(state.options.execution_selection, "scripted-only", "RED arm must run bare (scripted-only)");

    // The a446deac defect shape, faithfully: 24 real cells pending-real
    // (correct for bare mode) + 4 scripted cells NOT_RUN(predicate).
    const realCases = state.cases.filter((c: any) => REAL_HARNESSES.has(String(c.harness)));
    const scriptedCases = state.cases.filter((c: any) => !REAL_HARNESSES.has(String(c.harness)));
    assert.equal(realCases.length, 24, "bare tier1 must contain 24 real pi/hermes cells (pending-real)");
    assert.equal(scriptedCases.length, 4, "bare tier1 must contain 4 scripted local cells");
    for (const cs of realCases) {
      assert.equal(cs.outcome, "NOT_RUN", `${cs.id}: real cell must be pending-real`);
      assert.equal(cs.reason?.category, "pending-real", `${cs.id}: pending-real category required`);
      assert.deepEqual(cs.attempts, [], `${cs.id}: real cell must never have attempted in bare mode`);
    }
    for (const cs of scriptedCases) {
      assert.equal(cs.outcome, "NOT_RUN", `${cs.id}: darwin-only requires must gate the cell NOT_RUN on linux`);
      assert.equal(cs.reason?.category, "predicate",
        `${cs.id}: must be an HONEST evaluated predicate skip (profile loaded), not host-profile-missing`);
      const evidence = cs.reason?.evidence;
      assert.ok(Array.isArray(evidence) && evidence.length > 0, `${cs.id}: predicate block must carry evidence`);
      assert.equal(evidence.some((e: any) => String(e.predicate).includes("platform")), true,
        `${cs.id}: evidence must name the platform predicate`);
      assert.deepEqual(cs.attempts, [], `${cs.id}: zero executions expected`);
      assert.equal(cs.spend?.tokens_observed ?? 0, 0, `${cs.id}: zero tokens`);
    }

    // AC1: exit 1 FINDINGS, vacuity operative, machine-parseable finding —
    // never GREEN.
    assert.equal(redResult.status, 1, `all-skipped bare tier1 must exit 1 (FINDINGS):\n${redResult.stdout}\n${redResult.stderr}`);
    assert.equal(report.verdict, "FINDINGS", "report must be FINDINGS, never GREEN");
    assert.equal(report.exit_code, 1, "report must carry exit code 1");
    assert.equal(report.vacuity.triggered, true, "vacuity guard must be the operative fail-closed signal");
    assert.match(report.vacuity.cause, /executed zero scripted cells/);
    const vic = report.findings.find((f: any) => f.category === "vacuous-campaign");
    assert.ok(vic, "findings must contain a machine-parseable vacuous-campaign finding");
    assert.equal(vic.type, "VACUOUS_CAMPAIGN");
    assert.equal(vic.case_id, null, "vacuous-campaign finding is campaign-level (case_id null)");
    assert.ok(typeof vic.summary === "string" && /executed zero scripted cells/.test(vic.summary),
      `vacuous-campaign summary must name the cause: ${JSON.stringify(vic)}`);
    assert.equal(report.infra_failures.length, 0, "this is a vacuity FINDINGS, not an infra failure");
    const reportTxt = fs.readFileSync(path.join(campaignDir, "report.txt"), "utf8");
    assert.match(reportTxt, /VACUOUS_CAMPAIGN - bare \(scripted-only\) campaign executed zero scripted cells/,
      "report.txt must list the vacuous-campaign finding");
    assert.match(reportTxt, /VERDICT\nFINDINGS \(exit 1\)/, "rendered VERDICT must be FINDINGS (exit 1)");
    assert.ok(!/GREEN \(exit 0\)/.test(reportTxt), "all-skipped bare tier1 must never render GREEN");
    // Zero tokens overall.
    assert.equal(report.spend.tokens_observed, 0, "report must show zero tokens observed");
    assert.equal(state.spend.tokens_observed, 0, "state spend ledger must show zero tokens");

    // RED LEG — the "pre-change it was GREEN" trajectory: the SAME harvested
    // state fed through the frozen pre-US-008 verdict arm must be vacuously
    // GREEN (exit 0). This is the behaviour the a446deac task observed and the
    // regression US-008 fixes; the campaign shape just proven RED is the very
    // shape that was documented as GREEN before the guard.
    const legacy = await import(legacyModuleUrl);
    assert.equal(typeof legacy.legacyVerdictExitCode, "function", "legacy verdict arm must be importable");
    assert.deepEqual(
      legacy.legacyVerdictExitCode(state),
      { verdict: "GREEN", exitCode: 0 },
      "pre-US-008 verdict logic must render this exact all-skipped state vacuously GREEN (exit 0) — pinning the a446deac vacuous-GREEN the guard eliminates",
    );

    // AC4-in-RED: the ORIGINAL tier1.jsonl is byte-for-byte untouched by the
    // copy-based RED arm.
    assert.equal(sha256(MANIFEST), originalHash, "original tier1.jsonl must be unchanged by the RED arm");
  } finally {
    if (redCampaignId !== null) {
      fs.rmSync(path.join(resultsRoot, redCampaignId), { recursive: true, force: true });
    }
    fs.rmSync(redManifest, { force: true });
  }
  // Hygiene: quiet window held end-to-end.
  await assertPortsFree();
  assert.equal(gitSnapshot(), before, "RED arm changed git status");
});

it("US-009: GREEN arm (control) — a NORMAL bare tier1 selection with at least one scripted cell executing stays GREEN exit 0, vacuity silent", { timeout: 30 * 60 * 1000 }, async () => {
  const before = gitSnapshot();
  const originalHash = sha256(MANIFEST);

  // Quiet window again: stop any stray scripted daemon and verify ports free.
  const initialStop = run(daemonControl, ["scripted", "stop"], process.env);
  assert.equal(initialStop.status, 0, `${initialStop.stdout}\n${initialStop.stderr}`);
  await assertPortsFree();
  ensureHostProfile();

  // The ORIGINAL tier1 manifest run bare. Its 4 scripted local cells carry
  // SATISFIABLE requires (capabilities ["node-sqlite","daemon-scripted"] since
  // MACP4 US-006 — daemon-scripted is true on this linux host), so >=1
  // scripted cell EXECUTES through the zero-token scripted daemon; 24 real
  // cells are pending-real. This is the control the task demands: after the
  // vacuity guard, a normal bare tier1 must still be GREEN.
  let greenResult!: CommandResult;
  let greenCampaignId: string | null = null;
  try {
    greenResult = await runStreaming(controller, ["--manifest", MANIFEST, "--scripted-only"], campaignEnv);
    const m = CAMPAIGN_LINE.exec(greenResult.stdout);
    greenCampaignId = m === null ? null : m[1];
    assert.ok(greenCampaignId, `control campaign did not print a campaign ID:\n${greenResult.stdout}\n${greenResult.stderr}`);
    const campaignDir = path.join(resultsRoot, greenCampaignId);
    const state = loadJson(path.join(campaignDir, "state.json"));
    const report = loadJson(path.join(campaignDir, "report.json"));

    assert.equal(state.options.execution_selection, "scripted-only", "control arm must run bare (scripted-only)");

    // AC2: at least one scripted cell actually executed (positive control for
    // the vacuity guard's 'executed' definition: attempts.length > 0).
    const scriptedCases = state.cases.filter((c: any) => !REAL_HARNESSES.has(String(c.harness)));
    assert.ok(scriptedCases.length > 0, "control must contain scripted cells");
    const executed = scriptedCases.filter((c: any) => (c.attempts ?? []).length > 0);
    assert.ok(executed.length > 0, "control: at least one scripted cell must EXECUTE (attempts>0)");
    for (const cs of executed) {
      assert.equal(cs.outcome, "PASS", `${cs.id}: executed control cell must reach a real terminal outcome`);
    }
    const realCases = state.cases.filter((c: any) => REAL_HARNESSES.has(String(c.harness)));
    assert.equal(realCases.length, 24, "bare control must still carry 24 pending-real cells");
    for (const cs of realCases) {
      assert.equal(cs.outcome, "NOT_RUN", `${cs.id}: real cell must remain pending-real in bare control`);
      assert.equal(cs.reason?.category, "pending-real", `${cs.id}: pending-real category required`);
    }

    // AC2: GREEN exit 0, vacuity silent, no vacuous-campaign finding.
    assert.equal(greenResult.status, 0, `normal bare tier1 must exit 0 (GREEN):\n${greenResult.stdout}\n${greenResult.stderr}`);
    assert.equal(report.verdict, "GREEN", "control report must be GREEN");
    assert.equal(report.exit_code, 0, "control report must carry exit code 0");
    assert.equal(report.vacuity.triggered, false, "vacuity guard must be silent when >=1 scripted cell executed");
    assert.ok(!report.findings.some((f: any) => f.category === "vacuous-campaign"),
      "no vacuous-campaign finding expected when a scripted cell executed");
    const reportTxt = fs.readFileSync(path.join(campaignDir, "report.txt"), "utf8");
    assert.match(reportTxt, /VERDICT\nGREEN \(exit 0\)/, "control report.txt must render GREEN (exit 0)");
    assert.equal(report.spend.tokens_observed, 0, "control must stay zero-token (scripted daemon only)");

    // AC4-in-GREEN: ORIGINAL manifest untouched by the control run too.
    assert.equal(sha256(MANIFEST), originalHash, "original tier1.jsonl must be unchanged by the control arm");
  } finally {
    if (greenCampaignId !== null) {
      fs.rmSync(path.join(resultsRoot, greenCampaignId), { recursive: true, force: true });
    }
  }

  // Quiet window held, daemon stopped, git tree untouched.
  const daemonStatus = run(daemonControl, ["scripted", "status"], process.env);
  assert.equal(daemonStatus.status, 0, daemonStatus.stderr);
  assert.match(daemonStatus.stdout, /^STATUS: STOPPED$/m);
  await assertPortsFree();
  assert.equal(gitSnapshot(), before, "control arm changed git status");
});
