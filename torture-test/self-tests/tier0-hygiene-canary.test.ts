// FIX10 US-005 gate: O18-style operator-identity hygiene canary wired into
// the campaign controller.
//
// Regression net for the 2026-08-05 breach: a torture-test hook rewrote the
// OPERATOR's real ~/.gitconfig and the contamination was silent. US-005 makes
// every campaign snapshot sha256 hashes of the operator-identity files
// (~/.gitconfig required, ~/.ssh/config and crontab when present) BEFORE case
// execution and verify them unchanged AFTER every case is terminal; any diff
// becomes a campaign-level FINDING (HYGIENE_* types) and forces exit 1.
//
// Confined to torture-test/. Zero tokens: the focused campaigns use the
// existing zero-token scripted harness (W0.0-fast) or a trivial mutator
// command; the canary's watched home is a TEST-ONLY override
// (TT_HYGIENE_CANARY_HOME, honored only under TT_CONTROLLER_SELF_TEST=1) so
// the real operator identity is never read except by the read-only default
// snapshot probe. The real ~/.gitconfig is only ever READ (sha256 snapshot)
// and asserted unchanged after the run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const varRoot = path.join(ttRoot, "var");
const resultsRoot = path.join(varRoot, "results");
const CONTROLLER = path.join(ttRoot, "bin", "tt-controller");
const CANARY_MODULE = path.join(ttRoot, "bin", "tt-hygiene-canary.mjs");
const REPORT_MODULE = path.join(ttRoot, "bin", "tt-report.mjs");
const TIER0_MANIFEST = path.join(ttRoot, "cases", "tier0.jsonl");

const operatorHome = os.homedir();
const realGitconfig = path.join(operatorHome, ".gitconfig");

function sha256OfFile(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

type CommandResult = { status: number | null; stdout: string; stderr: string };

function run(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 300_000): CommandResult {
  const result = spawnSync(file, args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

// Controller env: keep the operator env but (a) drop NODE_TEST_CONTEXT so
// node:test does not mark the spawned controller/daemon children as test
// processes, (b) disable the live-state guard (the scripted env uses its own
// TT home/ports), (c) pin the harness binaries to false so no real agent can
// ever launch, and (d) arm the canary test-only override.
function controllerEnv(canaryHome: string): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
    TAMANDUA_TEST_GUARD: "0",
    TAMANDUA_PI_BINARY: "/bin/false",
    TAMANDUA_HERMES_BINARY: "/usr/bin/false",
    TT_CONTROLLER_SELF_TEST: "1",
    TT_HYGIENE_CANARY_HOME: canaryHome,
  };
}

function campaignIdFrom(stdout: string): string {
  const match = /^Campaign: (campaign-[A-Za-z0-9._-]+)$/m.exec(stdout);
  assert.ok(match, `controller output omitted campaign ID:\n${stdout}`);
  return match[1];
}

function writeGitconfig(home: string, content: string): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, ".gitconfig"), content, { mode: 0o600 });
}

// Slices the source between a top-level `function NAME(` declaration and the
// next top-level declaration (all tt-controller declarations are column-0).
function functionSlice(source: string, name: string): string {
  const lines = source.split(/\r?\n/);
  const declaration = new RegExp(`^(?:export )?(?:async )?function ${name}\\(`);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (declaration.test(lines[i])) { start = i; break; }
  }
  assert.ok(start >= 0, `function ${name} not found in tt-controller`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^(?:async )?function [A-Za-z_$][\w$]*\(/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join("\n");
}

let gitconfigBefore = "";
describe("FIX10 US-005 operator-identity hygiene canary", () => {
  before(() => {
    fs.mkdirSync(varRoot, { recursive: true });
    gitconfigBefore = sha256OfFile(realGitconfig);
  });
  after(() => {
    assert.equal(sha256OfFile(realGitconfig), gitconfigBefore,
      "the real ~/.gitconfig hash changed during the test run — containment broke");
  });

  // ── Module unit tests ────────────────────────────────────────────────────

  it("snapshots the watched operator-identity files as HASHES ONLY (never contents)", async () => {
    const { snapshotHygieneCanary } = await import(CANARY_MODULE);
    const home = fs.mkdtempSync(path.join(varRoot, `canary-home-${process.pid}-`));
    try {
      const secret = "user.name = Operator Secret Identity\nuser.email = op@example.com\n";
      writeGitconfig(home, secret);
      const override = process.env.TT_HYGIENE_CANARY_HOME;
      process.env.TT_HYGIENE_CANARY_HOME = home;
      process.env.TT_CONTROLLER_SELF_TEST = "1";
      try {
        const snapshot = snapshotHygieneCanary();
        assert.equal(snapshot.home, home, "test override home must be used");
        const gitconfig = snapshot.files.find((entry: any) => entry.name === "gitconfig");
        assert.ok(gitconfig, "gitconfig entry missing");
        assert.equal(gitconfig.present, true);
        assert.match(gitconfig.hash, /^[a-f0-9]{64}$/, "gitconfig hash must be sha256 hex");
        assert.equal(gitconfig.hash, crypto.createHash("sha256").update(secret).digest("hex"),
          "hash must match the file content");
        const ssh = snapshot.files.find((entry: any) => entry.name === "ssh_config");
        assert.equal(ssh.present, false, "absent ~/.ssh/config must record present:false");
        assert.equal(ssh.hash, null);
        const crontab = snapshot.files.find((entry: any) => entry.name === "crontab");
        assert.ok(crontab.hash === null || /^[a-f0-9]{64}$/.test(crontab.hash),
          "crontab entry must be a hash or null");
        // Privacy: the serialized snapshot must never contain file contents.
        const serialized = JSON.stringify(snapshot);
        assert.ok(!serialized.includes(secret), "snapshot must never embed file contents");
        assert.ok(!serialized.includes("Operator Secret Identity"),
          "snapshot must never embed identity values");
      } finally {
        if (override === undefined) delete process.env.TT_HYGIENE_CANARY_HOME;
        else process.env.TT_HYGIENE_CANARY_HOME = override;
        delete process.env.TT_CONTROLLER_SELF_TEST;
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("resolves the REAL operator home via os.userInfo().homedir (never $HOME) and reads it read-only", async () => {
    const { resolveHygieneHome, snapshotHygieneCanary } = await import(CANARY_MODULE);
    const override = process.env.TT_HYGIENE_CANARY_HOME;
    delete process.env.TT_HYGIENE_CANARY_HOME;
    try {
      assert.equal(resolveHygieneHome(), operatorHome,
        "default canary home must be os.userInfo().homedir — deliberately not $HOME");
      const before = sha256OfFile(realGitconfig);
      const snapshot = snapshotHygieneCanary();
      assert.equal(snapshot.home, operatorHome);
      const gitconfig = snapshot.files.find((entry: any) => entry.name === "gitconfig");
      assert.ok(gitconfig, "default snapshot must watch ~/.gitconfig");
      assert.equal(gitconfig.present, true, "the operator ~/.gitconfig exists and must be watched");
      assert.equal(gitconfig.hash, crypto.createHash("sha256")
        .update(fs.readFileSync(realGitconfig)).digest("hex"));
      assert.equal(sha256OfFile(realGitconfig), before, "default snapshot must never modify ~/.gitconfig");
    } finally {
      if (override !== undefined) process.env.TT_HYGIENE_CANARY_HOME = override;
    }
  });

  it("refuses the test-only home override unless TT_CONTROLLER_SELF_TEST=1 (fail closed)", async () => {
    const { resolveHygieneHome } = await import(CANARY_MODULE);
    const override = process.env.TT_HYGIENE_CANARY_HOME;
    process.env.TT_HYGIENE_CANARY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), `canary-ungated-${process.pid}-`));
    delete process.env.TT_CONTROLLER_SELF_TEST;
    try {
      assert.throws(() => resolveHygieneHome(),
        /TT_HYGIENE_CANARY_HOME requires TT_CONTROLLER_SELF_TEST=1/,
        "an ungated override must be refused (production must always use the real home)");
    } finally {
      if (override === undefined) delete process.env.TT_HYGIENE_CANARY_HOME;
      else process.env.TT_HYGIENE_CANARY_HOME = override;
    }
  });

  it("verifyHygieneCanary reports UNCHANGED/CHANGED/ABSENT with HYGIENE_* diffs", async () => {
    const { snapshotHygieneCanary, verifyHygieneCanary } = await import(CANARY_MODULE);
    const home = fs.mkdtempSync(path.join(varRoot, `canary-verify-${process.pid}-`));
    try {
      writeGitconfig(home, "user.name = A\n");
      const override = process.env.TT_HYGIENE_CANARY_HOME;
      process.env.TT_HYGIENE_CANARY_HOME = home;
      process.env.TT_CONTROLLER_SELF_TEST = "1";
      try {
        const before = snapshotHygieneCanary();
        // (a) unchanged -> UNCHANGED, no diffs.
        const unchanged = verifyHygieneCanary(before.files, before.files);
        assert.deepEqual(unchanged.diffs, []);
        const gitconfigStatus = unchanged.statuses.find((entry: any) => entry.name === "gitconfig");
        assert.equal(gitconfigStatus.status, "UNCHANGED");
        // (b) mutate the watched .gitconfig -> CHANGED + HYGIENE_GITCONFIG.
        fs.appendFileSync(path.join(home, ".gitconfig"), "user.email = evil@example.com\n");
        const after = snapshotHygieneCanary();
        const mutated = verifyHygieneCanary(before.files, after.files);
        const changed = mutated.statuses.find((entry: any) => entry.name === "gitconfig");
        assert.equal(changed.status, "CHANGED");
        assert.notEqual(changed.before, changed.after, "hashes must differ after mutation");
        const diff = mutated.diffs.find((entry: any) => entry.name !== undefined || entry.type === "HYGIENE_GITCONFIG");
        assert.equal(diff.type, "HYGIENE_GITCONFIG");
        assert.equal(diff.before, changed.before);
        assert.equal(diff.after, changed.after);
        // (c) delete the watched file -> CHANGED with a null after hash.
        fs.rmSync(path.join(home, ".gitconfig"));
        const deletedAfter = snapshotHygieneCanary();
        const deleted = verifyHygieneCanary(before.files, deletedAfter.files);
        const deletedStatus = deleted.statuses.find((entry: any) => entry.name === "gitconfig");
        assert.equal(deletedStatus.status, "CHANGED");
        assert.equal(deletedStatus.after, null);
        // (d) file that never existed -> ABSENT, no diff.
        const absentStatus = deleted.statuses.find((entry: any) => entry.name === "ssh_config");
        assert.equal(absentStatus.status, "ABSENT");
        assert.ok(deleted.diffs.every((entry: any) => entry.type !== "HYGIENE_SSH_CONFIG"),
          "an absent-then-absent file must not produce a diff");
      } finally {
        if (override === undefined) delete process.env.TT_HYGIENE_CANARY_HOME;
        else process.env.TT_HYGIENE_CANARY_HOME = override;
        delete process.env.TT_CONTROLLER_SELF_TEST;
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // ── Report-module tests ──────────────────────────────────────────────────

  it("verdictExitCode: a hygiene diff is FINDINGS (exit 1), never silent", async () => {
    const { verdictExitCode, buildCampaignReport, renderCampaignReport } = await import(REPORT_MODULE);
    const at = (seconds: number) => `2026-08-01T00:00:${String(seconds).padStart(2, "0")}.000Z`;
    const attempt = (outcome: string) => ({
      id: "attempt-1", case_id: "C", kind: "local", phase: "terminal",
      started_at: at(1), terminal_at: at(3), outcome,
    });
    const caseState = (outcome: string) => ({
      id: "C", wave: 1, workflow: "local", fixture: "none", harness: "local",
      class: "verification", phase: "terminal", outcome, terminal_at: at(5),
      attempts: [attempt(outcome)], findings: [], oracle_results: [],
      spend: { tokens_observed: 0, observations: [] },
    });
    const base = {
      version: 1, campaign_id: "hygiene-unit", phase: "ready",
      created_at: at(0), updated_at: at(9),
      manifest: { path: "cases/h.jsonl", sha256: "a".repeat(64), case_count: 1, case_ids: ["C"] },
      options: { concurrency: 1, stagger_ms: 0, token_poll_interval_ms: 300000 },
      spend: { tokens_observed: 0, observations: [] },
      cases: [caseState("PASS")], discovered_runs: [],
    };
    // All-clear: no hygiene state -> GREEN.
    assert.deepEqual(verdictExitCode({ ...base }), { verdict: "GREEN", exitCode: 0 });
    // Armed + unchanged -> GREEN.
    const clean = {
      ...base,
      hygiene_canary: {
        home: "/home/operator",
        before: [{ name: "gitconfig", path: "/home/operator/.gitconfig", hash: "b".repeat(64), present: true }],
        diffs: [],
        statuses: [{ name: "gitconfig", path: "/home/operator/.gitconfig", before: "b".repeat(64), after: "b".repeat(64), status: "UNCHANGED" }],
      },
    };
    assert.deepEqual(verdictExitCode(clean), { verdict: "GREEN", exitCode: 0 });
    // A single hygiene diff -> FINDINGS exit 1 even though the case PASSed.
    const breached = {
      ...clean,
      hygiene_canary: {
        ...clean.hygiene_canary!,
        after: [{ name: "gitconfig", path: "/home/operator/.gitconfig", hash: "c".repeat(64), present: true }],
        statuses: [{ name: "gitconfig", path: "/home/operator/.gitconfig", before: "b".repeat(64), after: "c".repeat(64), status: "CHANGED" }],
        diffs: [{ type: "HYGIENE_GITCONFIG", file: "/home/operator/.gitconfig", before: "b".repeat(64), after: "c".repeat(64) }],
      },
    };
    assert.deepEqual(verdictExitCode(breached), { verdict: "FINDINGS", exitCode: 1 });

    const report = buildCampaignReport(breached);
    assert.equal(report.exit_code, 1);
    assert.equal(report.verdict, "FINDINGS");
    assert.equal(report.hygiene_canary.home, "/home/operator");
    const file = report.hygiene_canary.files.find((entry: any) => entry.name === "gitconfig");
    assert.equal(file.status, "CHANGED");
    assert.equal(file.before, "b".repeat(64));
    assert.equal(file.after, "c".repeat(64));
    assert.equal(report.hygiene_canary.diffs[0].type, "HYGIENE_GITCONFIG");
    const text = renderCampaignReport(report);
    assert.match(text, /HYGIENE CANARY\nHome: \/home\/operator/);
    assert.match(text, /- gitconfig: CHANGED \(before=b{64}, after=c{64}\)/);
    assert.match(text, /- FINDING HYGIENE_GITCONFIG: \/home\/operator\/\.gitconfig changed/);
    assert.match(text, /VERDICT\nFINDINGS \(exit 1\)\n$/);
  });

  it("renders the HYGIENE CANARY section with UNCHANGED files on a clean armed campaign", async () => {
    const { buildCampaignReport, renderCampaignReport } = await import(REPORT_MODULE);
    const at = (seconds: number) => `2026-08-01T00:00:${String(seconds).padStart(2, "0")}.000Z`;
    const state = {
      version: 1, campaign_id: "hygiene-clean", phase: "ready",
      created_at: at(0), updated_at: at(9),
      manifest: { path: "cases/h.jsonl", sha256: "a".repeat(64), case_count: 1, case_ids: ["C"] },
      options: { concurrency: 1, stagger_ms: 0, token_poll_interval_ms: 300000 },
      spend: { tokens_observed: 0, observations: [] },
      cases: [{
        id: "C", wave: 1, workflow: "local", fixture: "none", harness: "local",
        class: "verification", phase: "terminal", outcome: "PASS", terminal_at: at(5),
        attempts: [{ id: "attempt-1", case_id: "C", kind: "local", phase: "terminal", started_at: at(1), terminal_at: at(3), outcome: "PASS" }],
        findings: [], oracle_results: [], spend: { tokens_observed: 0, observations: [] },
      }],
      discovered_runs: [],
      hygiene_canary: {
        home: "/home/operator",
        before: [{ name: "gitconfig", path: "/home/operator/.gitconfig", hash: "b".repeat(64), present: true }],
        after: [{ name: "gitconfig", path: "/home/operator/.gitconfig", hash: "b".repeat(64), present: true }],
        diffs: [],
        statuses: [{ name: "gitconfig", path: "/home/operator/.gitconfig", before: "b".repeat(64), after: "b".repeat(64), status: "UNCHANGED" }],
      },
    };
    const report = buildCampaignReport(state);
    assert.equal(report.verdict, "GREEN");
    assert.equal(report.exit_code, 0);
    const text = renderCampaignReport(report);
    assert.match(text, /HYGIENE CANARY\nHome: \/home\/operator\n- gitconfig: UNCHANGED \(before=b{64}, after=b{64}\)\n- operator identity files unchanged/);
    assert.match(text, /VERDICT\nGREEN \(exit 0\)\n$/);
  });

  // ── Controller wiring: functional campaigns ──────────────────────────────

  it("arms the canary before execution and verifies it at terminal (focused scripted campaign, exit 0)", () => {
    fs.mkdirSync(varRoot, { recursive: true });
    const record = fs.readFileSync(TIER0_MANIFEST, "utf8").split(/\r?\n/)
      .find((line) => line.includes('"id":"W0.0-fast"'));
    assert.ok(record, "W0.0-fast manifest record is missing");
    const focusedManifest = path.join(varRoot, `hygiene-focus-${process.pid}.jsonl`);
    fs.writeFileSync(focusedManifest, `${record}\n`, { flag: "wx" });
    const canaryHome = fs.mkdtempSync(path.join(varRoot, `canary-focus-home-${process.pid}-`));
    try {
      writeGitconfig(canaryHome, "user.name = Focus\nuser.email = focus@example.com\n");
      const result = run(CONTROLLER, ["--manifest", focusedManifest, "--scripted-only"], controllerEnv(canaryHome));
      assert.equal(result.status, 0, `focused campaign failed:\n${result.stdout}\n${result.stderr}`);
      const campaignDir = path.join(resultsRoot, campaignIdFrom(result.stdout));
      const state = JSON.parse(fs.readFileSync(path.join(campaignDir, "state.json"), "utf8"));
      const report = JSON.parse(fs.readFileSync(path.join(campaignDir, "report.json"), "utf8"));
      // Armed BEFORE case execution.
      assert.ok(Array.isArray(state.hygiene_canary?.before) && state.hygiene_canary.before.length > 0,
        "state must record a before-snapshot");
      assert.equal(state.hygiene_canary.before.find((entry: any) => entry.name === "gitconfig").present, true);
      assert.ok(Array.isArray(state.hygiene_canary.diffs), "diffs ledger must exist");
      // Verified at terminal with UNCHANGED status (exit 0 => GREEN).
      assert.equal(report.verdict, "GREEN");
      assert.equal(report.exit_code, 0);
      const files = report.hygiene_canary.files;
      assert.ok(files.length >= 3, "all watched files must be reported");
      const gitconfig = files.find((entry: any) => entry.name === "gitconfig");
      assert.equal(gitconfig.status, "UNCHANGED");
      assert.equal(gitconfig.before, gitconfig.after);
      assert.deepEqual(report.hygiene_canary.diffs, []);
      const text = fs.readFileSync(path.join(campaignDir, "report.txt"), "utf8");
      assert.match(text, /HYGIENE CANARY/);
      assert.match(text, /- gitconfig: UNCHANGED/);
      assert.match(text, /- operator identity files unchanged/);
      assert.match(text, /VERDICT\nGREEN \(exit 0\)\n$/);
    } finally {
      fs.rmSync(focusedManifest, { force: true });
      fs.rmSync(canaryHome, { recursive: true, force: true });
    }
  });

  it("detects a simulated operator-file mutation as a campaign FINDING and exits 1", () => {
    fs.mkdirSync(varRoot, { recursive: true });
    const canaryHome = fs.mkdtempSync(path.join(varRoot, `canary-mutate-home-${process.pid}-`));
    const mutator = path.join(varRoot, `hygiene-mutate-${process.pid}.sh`);
    const manifestPath = path.join(varRoot, `hygiene-mutate-${process.pid}.jsonl`);
    try {
      writeGitconfig(canaryHome, "user.name = Before\nuser.email = before@example.com\n");
      // The simulated breach: the case command rewrites the WATCHED operator
      // identity file (the canary home) mid-campaign, exactly like the
      // 2026-08-05 hook did to the real ~/.gitconfig.
      fs.writeFileSync(mutator,
        `#!/usr/bin/env bash\nprintf 'user.name = Tamandua Tier-0\\nuser.email = tier0@tetradactyla.invalid\\n' > "${canaryHome}/.gitconfig"\nexit 0\n`,
        { mode: 0o755 });
      const manifest = [{
        id: "T0.hygiene-mutation",
        wave: 0,
        workflow: "local",
        fixture: "none",
        harness: "local",
        task: "cases/tasks/tier0/W0.0-fast.md",
        context: { execution_mode: "scripted" },
        caps: { tokens: 0, wall_min: 1 },
        requires: {},
        boundary_files: [],
        forbidden: [],
        oracles: [],
        gates: ["TIER0"],
        command: { executable: `var/hygiene-mutate-${process.pid}.sh`, args: [], cwd: "." },
        chaos: null,
        shed_ok: false,
        mandatory: true,
        class: "verification",
      }];
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest[0])}\n`, { flag: "wx" });

      const result = run(CONTROLLER, ["--manifest", manifestPath, "--scripted-only"], controllerEnv(canaryHome));
      assert.equal(result.status, 1,
        `a hygiene breach must yield exit 1 (FINDINGS), got ${result.status}:\n${result.stdout}\n${result.stderr}`);
      const campaignDir = path.join(resultsRoot, campaignIdFrom(result.stdout));
      const state = JSON.parse(fs.readFileSync(path.join(campaignDir, "state.json"), "utf8"));
      const report = JSON.parse(fs.readFileSync(path.join(campaignDir, "report.json"), "utf8"));
      assert.equal(state.cases[0].outcome, "PASS", "the case itself passed — only the canary trips the verdict");
      assert.equal(report.verdict, "FINDINGS");
      assert.equal(report.exit_code, 1);
      const gitconfig = report.hygiene_canary.files.find((entry: any) => entry.name === "gitconfig");
      assert.equal(gitconfig.status, "CHANGED");
      assert.notEqual(gitconfig.before, gitconfig.after);
      assert.ok(report.hygiene_canary.diffs.some((entry: any) => entry.type === "HYGIENE_GITCONFIG"),
        "the report must carry a HYGIENE_GITCONFIG finding");
      const text = fs.readFileSync(path.join(campaignDir, "report.txt"), "utf8");
      assert.match(text, /HYGIENE CANARY/);
      assert.match(text, /- gitconfig: CHANGED/);
      assert.match(text, /- FINDING HYGIENE_GITCONFIG/);
      assert.match(text, /VERDICT\nFINDINGS \(exit 1\)\n$/);
      assert.equal(sha256OfFile(realGitconfig), gitconfigBefore,
        "the real ~/.gitconfig must never be touched by the simulated breach");
    } finally {
      fs.rmSync(mutator, { force: true });
      fs.rmSync(manifestPath, { force: true });
      fs.rmSync(canaryHome, { recursive: true, force: true });
    }
  });

  // ── Static wiring proofs ─────────────────────────────────────────────────

  it("startCampaign/resumeCampaign arm the canary before execution; terminal reports verify it", () => {
    const source = fs.readFileSync(CONTROLLER, "utf8");
    const start = functionSlice(source, "startCampaign");
    assert.ok(start.includes("ensureHygieneCanaryBefore(state)"),
      "startCampaign must arm the canary before case execution");
    assert.ok(start.indexOf("ensureHygieneCanaryBefore(state)") < start.indexOf("executeEligibleCases("),
      "startCampaign must arm the canary BEFORE executing cases");
    const resume = functionSlice(source, "resumeCampaign");
    assert.ok(resume.includes("ensureHygieneCanaryBefore(state)"),
      "resumeCampaign must arm the canary (or keep the existing baseline)");
    assert.ok(resume.indexOf("ensureHygieneCanaryBefore(state)") < resume.indexOf("executeEligibleCases("),
      "resumeCampaign must arm the canary BEFORE executing cases");
    const terminal = functionSlice(source, "writeTerminalCampaignReports");
    assert.ok(terminal.includes("verifyHygieneCanaryAtTerminal(campaignDir, state)"),
      "terminal reports must verify the canary after every case is terminal");
    assert.ok(terminal.indexOf("verifyHygieneCanaryAtTerminal") < terminal.indexOf("writeCampaignReports("),
      "the canary must be verified BEFORE the reports are built");
    const ensure = functionSlice(source, "ensureHygieneCanaryBefore");
    assert.match(ensure, /state\.hygiene_canary\.before/, "the baseline must be stored in state.hygiene_canary.before");
    assert.match(ensure, /Array\.isArray\(state\.hygiene_canary\.before\)/,
      "an already-armed campaign (resume) must keep its original baseline");
    assert.match(ensure, /snapshotHygieneCanary\(\)/, "the baseline must come from the shared canary module");
    const verify = functionSlice(source, "verifyHygieneCanaryAtTerminal");
    assert.match(verify, /snapshotHygieneCanary\(\)/, "verify must recompute the hashes after the campaign");
    assert.match(verify, /verifyHygieneCanary\(/, "verify must compare before against after");
    assert.match(verify, /state\.hygiene_canary\.diffs/, "verify must record any diff into campaign state");
    assert.match(verify, /atomicWriteState\(campaignDir, state\)/,
      "verify must persist the canary result before reports are written");
    assert.match(verify, /HYGIENE_CANARY_NOT_ARMED/,
      "a campaign that reaches terminal without a baseline must fail closed (loud finding)");
  });

  it("verdictExitCode treats hygiene diffs as FINDINGS (exit 1) after infra checks", async () => {
    const { verdictExitCode } = await import(REPORT_MODULE);
    const source = fs.readFileSync(REPORT_MODULE, "utf8");
    const slice = functionSlice(source, "verdictExitCode");
    assert.ok(slice.indexOf("hygiene_canary?.diffs") > slice.indexOf("hasInfrastructureFailure"),
      "infra failure (exit 2) must remain more severe than a hygiene finding (exit 1)");
    assert.match(slice, /{ verdict: 'FINDINGS', exitCode: 1 }/);
  });
});
