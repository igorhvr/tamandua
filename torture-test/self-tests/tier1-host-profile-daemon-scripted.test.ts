// MACP4 US-005 — Host profile: record `daemon-scripted` capability on both
// platforms (tier1 self-test).
//
// MACP3 US-004 marker: every '/proc' occurrence in THIS file is linux-only
// documentation/assertion prose — the daemon-scripted capability computation
// itself is a pure PATH scan and never touches the procfs mount (the
// tier0-procfs-portability-lint allowlist entry for this file is
// us004-harness-guarded).
//
// W0.0 (tt-verify-environment) must record a `daemon-scripted` Boolean-leaf
// capability in host-profile.json on BOTH linux and darwin: true iff the
// host has the scripted-daemon plain-background fallback launch
// prerequisites — bash AND nohup AND node resolvable via POSIX `command -v`
// PATH-lookup semantics. This is the narrowest true requirement for the
// tier1 W2 scripted cells (daemon-control's non-systemd fallback launch
// path), replacing the blanket `platform: linux` predicate (US-006 consumes
// the leaf).
//
// What this file proves (all zero-token, hermetic, confined to torture-test/):
//   1. On THIS linux host the leaf is true in BOTH --fast and full modes
//      (AC1), and the computation is a pure PATH scan — no /proc, no getent
//      (structural pin of the check body, AC2's computation claim).
//   2. Simulated-Darwin arm (AC2): with the MACP3 injectable-platform-seam
//      pattern (TT_VERIFY_PLATFORM=darwin — the same seam family as
//      TT_PROCESS_IDENTITY_PLATFORM / TT_DC_PLATFORM) and a fake PATH that
//      has bash+nohup+node but NO getent and NO systemd binaries, the tool
//      records platform.os=darwin, skips systemd exactly like a real mac,
//      and STILL computes capabilities.daemon-scripted=true — both-platform
//      computation proven without a mac.
//   3. Negative arm (AC3): with bash/nohup hidden via a PATH seam the leaf
//      records false, and a manifest cell requiring
//      ["node-sqlite","daemon-scripted"] is gated NOT_RUN(predicate) by
//      tt-controller with expected/observed evidence naming
//      capabilities.daemon-scripted — honest gating, never a silent skip,
//      never INFRA.
//   4. AC4: with the REAL linux profile, the same manifest cell requiring
//      ["node-sqlite","daemon-scripted"] passes through tt-controller
//      UNGATED (executes, no predicate block) — tt-controller's
//      observedCapability fall-through (profile.capabilities[name] for
//      unknown names) needs NO code change for the new capability.
//
// The host-profile.json at var/w0 is a SHARED artifact: every arm that
// overwrites it (simulated-Darwin, negative) restores the REAL profile in a
// finally block so sibling tests see truth. Writes only under gitignored
// var/ (profile + transient manifests + campaign results).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const binDir = path.join(ttRoot, "bin");
const verifyEnv = path.join(binDir, "tt-verify-environment");
const controller = path.join(binDir, "tt-controller");
const varRoot = path.join(ttRoot, "var");
const hostProfilePath = path.join(varRoot, "w0", "host-profile.json");

const CAMPAIGN_LINE = /^Campaign:\s+(campaign-[^\s]+)$/m;
const PRED_CASE_ID = "US005-DAEMON-SCRIPTED-PRED";

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Child processes of this self-test must not carry node:test's context into
// the campaign machinery: the contained tamandua state lives under the real
// ~/.tamandua (this worktree is inside it), so the auto-activated isolation
// guard would refuse the controller's token ledger and every scripted cell
// would die TEST_INFRA_FAIL. Strip NODE_TEST_CONTEXT and set
// TAMANDUA_TEST_GUARD=0 — the established campaign-child env convention
// (tier1-bare-vacuity-red-green.test.ts / tier1-zero-real-launch-infra.test.ts).
const childEnv: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
  TAMANDUA_TEST_GUARD: "0",
};

function runTt(script: string, args: string[], env?: Record<string, string>): RunResult {
  const res = spawnSync(process.execPath, [script, ...args], {
    cwd: ttRoot,
    encoding: "utf8",
    timeout: 300_000,
    env: { ...childEnv, ...(env ?? {}) },
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

// A local-command case record (zero-token execution path) carrying the
// given requires block. The controller evaluates requires predicates
// against the host profile BEFORE deciding how to execute, so a local case
// is the honest zero-token way to observe the predicate verdict.
function localCaseRecord(id: string, requires: any): any {
  return {
    id,
    wave: 4,
    workflow: "local",
    fixture: "none",
    harness: "local",
    task: `cases/tasks/tier1/${id}.md`,
    context: { execution_mode: "scripted" },
    caps: { tokens: 0, wall_min: 5 },
    requires,
    boundary_files: [],
    forbidden: [],
    oracles: [],
    gates: [],
    chaos: null,
    shed_ok: false,
    mandatory: true,
    class: "verification",
    reset: { executable: "node", args: ["-e", "process.exit(0)"], cwd: "." },
    command: {
      executable: "node",
      args: ["-e", "console.log(JSON.stringify({status:'done'}));process.exit(0)"],
      cwd: ".",
    },
  };
}

function writeManifest(records: any[]): string {
  const name = `US005-${Date.now()}-${process.pid}.jsonl`;
  const manifestPath = path.join(varRoot, name);
  fs.writeFileSync(manifestPath, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return manifestPath;
}

function runCampaign(manifestPath: string): { campaignId: string | null; state: any } {
  const rel = path.relative(ttRoot, manifestPath);
  const res = runTt(controller, ["--manifest", rel]);
  const m = CAMPAIGN_LINE.exec(res.stdout);
  const campaignId = m === null ? null : m[1];
  assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);
  const statePath = path.join(varRoot, "results", campaignId, "state.json");
  assert.ok(fs.existsSync(statePath), `campaign state not found: ${statePath}`);
  return { campaignId, state: loadJson(statePath) };
}

// Resolve a binary on the REAL PATH (for symlinking into fake PATH seams).
function realBinary(name: string): string | null {
  const res = spawnSync("which", [name], { encoding: "utf8", timeout: 5000 });
  if (res.status !== 0) return null;
  const out = String(res.stdout ?? "").trim();
  return out.length > 0 ? out : null;
}

// Build a fake bin dir holding symlinks to the REAL binaries for every name
// in `include`. Names in `exclude` are deliberately NOT linked (a PATH seam
// hiding a prerequisite, e.g. bash/nohup on the negative arm). ss/lsof are
// always omitted so the port probe reports every port free — the ONLY delta
// is whatever the test intends.
function buildFakeBin(include: string[], exclude: string[] = []): string {
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "tt-us005-fake-"));
  for (const name of include) {
    if (exclude.includes(name)) continue;
    const real = realBinary(name);
    if (real !== null) fs.symlinkSync(real, path.join(fakeBin, name));
  }
  return fakeBin;
}

// The binaries W0.0's --fast REQUIRED checks need (the Test-17 restricted-
// PATH convention + nohup for the daemon-scripted capability).
const FAST_REQUIRED_BINS = [
  "node", "npm", "python3", "git", "bash", "which", "curl", "jq", "sqlite3",
  "df", "true", "sh", "systemd-run", "systemctl", "nohup",
];

// Extract the normalized body of `function NAME(...) { ... }` (closing brace
// at column 0 — true for every pinned function). Whitespace collapsed so the
// pin is about the CODE, not formatting.
function extractFunctionBody(src: string, fnName: string): string {
  const re = new RegExp(`function\\s+${fnName}\\([^)]*\\) \\{([\\s\\S]*?)\\n\\}`, "m");
  const m = src.match(re);
  assert.ok(m, `function ${fnName} not found in source`);
  return m[1].replace(/\s+/g, " ");
}

// Extract the body of the capability-daemon-scripted check: from the
// registerCheck('capability-daemon-scripted', ...) opening through the
// matching closing `});` at column 0.
function extractDaemonScriptedCheck(src: string): string {
  const start = src.indexOf("registerCheck('capability-daemon-scripted'");
  assert.ok(start >= 0, "capability-daemon-scripted check not found in tt-verify-environment");
  const end = src.indexOf("\n});", start);
  assert.ok(end >= 0, "capability-daemon-scripted check has no closing });");
  return src.slice(start, end).replace(/\s+/g, " ");
}

describe("MACP4 US-005 — daemon-scripted host-profile capability", () => {
  it("AC1: tt-verify-environment records capabilities.daemon-scripted === true on this linux host (--fast AND full)", () => {
    let res = runTt(verifyEnv, ["--fast", "--json"]);
    assert.equal(res.status, 0, `tt-verify-environment --fast failed:\n${res.stderr}${res.stdout}`);
    assert.equal(loadJson(hostProfilePath).capabilities?.["daemon-scripted"], true,
      "--fast host-profile must record capabilities.daemon-scripted === true on this linux host");

    // Full (non-fast) mode: the toolchain build+test probes are fast on this
    // fully-provisioned host; the capability leaf must be recorded the same way.
    res = runTt(verifyEnv, ["--json"]);
    assert.equal(res.status, 0, `tt-verify-environment (full) failed:\n${res.stderr}${res.stdout}`);
    assert.equal(loadJson(hostProfilePath).capabilities?.["daemon-scripted"], true,
      "FULL-mode host-profile must also record capabilities.daemon-scripted === true");
  });

  it("AC2 (computation): the daemon-scripted check is a pure PATH scan — no /proc, no getent — and is computed on a simulated-Darwin host", () => {
    const src = fs.readFileSync(verifyEnv, "utf8");

    // Structural pin: the check body itself must never touch the procfs mount
    // or getent — that is what makes the computation both-platform. (The
    // file as a whole legitimately contains /proc for the linux-only port-
    // ownership probe; the CAPABILITY computation is what must be pure.)
    const checkBody = extractDaemonScriptedCheck(src);
    assert.ok(!checkBody.includes("/proc"), "capability-daemon-scripted check must not read /proc");
    assert.ok(!checkBody.includes("getent"), "capability-daemon-scripted check must not call getent");
    const scanBody = extractFunctionBody(src, "commandOnPath");
    assert.ok(!scanBody.includes("/proc"), "commandOnPath must not read /proc");
    assert.ok(!scanBody.includes("getent"), "commandOnPath must not call getent");
    assert.match(scanBody, /fs\.accessSync/, "commandOnPath must resolve executability via fs.accessSync (command -v PATH-lookup semantics)");

    // Simulated-Darwin arm (MACP3 injectable-platform-seam pattern): a fake
    // PATH with bash+nohup+node but NO getent and NO systemd binaries, plus
    // TT_VERIFY_PLATFORM=darwin. The tool must record platform.os=darwin,
    // skip systemd exactly like a real mac, and STILL compute the capability
    // true — both-platform computation proven on a /proc-less, getent-less
    // environment.
    const fakeBin = buildFakeBin(FAST_REQUIRED_BINS, ["systemd-run", "systemctl"]);
    try {
      const res = runTt(verifyEnv, ["--tier", "tier1", "--fast", "--json"], {
        PATH: fakeBin,
        TT_VERIFY_PLATFORM: "darwin",
      });
      assert.equal(res.status, 0, `simulated-Darwin run must exit 0:\n${res.stderr}${res.stdout}`);
      const profile = loadJson(hostProfilePath);
      assert.equal(profile.platform?.os, "darwin", "TT_VERIFY_PLATFORM seam must force the recorded platform");
      assert.equal(profile.containment?.systemdUserScope, false,
        "simulated-Darwin profile must record containment.systemdUserScope=false (systemd skipped, like a real mac)");
      assert.equal(profile.capabilities?.["daemon-scripted"], true,
        "daemon-scripted must compute true on the simulated-Darwin host (bash+nohup+node present; no getent, no systemd)");
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
      // Restore the REAL profile so sibling tests see truth.
      const restore = runTt(verifyEnv, ["--fast", "--json"]);
      assert.equal(restore.status, 0, `profile restore failed:\n${restore.stderr}`);
    }
  });

  it("AC3: negative arm — bash/nohup hidden => capability false, and a cell requiring it is NOT_RUN(predicate) with expected/observed evidence", () => {
    const fakeBin = buildFakeBin(FAST_REQUIRED_BINS, ["bash", "nohup"]);
    const manifestPath = writeManifest([
      localCaseRecord(PRED_CASE_ID, { capabilities: ["node-sqlite", "daemon-scripted"], node_min: 22 }),
    ]);
    const campaignIds: string[] = [];
    try {
      // 1. Overwrite the shared profile with the negative-arm host: bash and
      // nohup hidden -> capabilities.daemon-scripted === false (honest leaf).
      const res = runTt(verifyEnv, ["--tier", "tier1", "--fast", "--json"], { PATH: fakeBin });
      assert.equal(res.status, 1,
        `negative-arm verify must exit non-zero (only the daemon-scripted REQUIRED check fails):\n${res.stderr}${res.stdout}`);
      const profile = loadJson(hostProfilePath);
      assert.equal(profile.capabilities?.["daemon-scripted"], false,
        "hidden bash/nohup must record capabilities.daemon-scripted === false (never silently dropped)");

      // 2. The manifest cell gated on ["node-sqlite","daemon-scripted"] must
      // be NOT_RUN(predicate) — honest gating with expected/observed
      // evidence, never a silent skip, never INFRA.
      const { campaignId, state } = runCampaign(manifestPath);
      campaignIds.push(campaignId!);
      const caseState = state.cases.find((c: any) => c.id === PRED_CASE_ID);
      assert.ok(caseState, `predicate case ${PRED_CASE_ID} missing from campaign state`);
      assert.equal(caseState.outcome, "NOT_RUN", "absent daemon-scripted capability must gate outcome NOT_RUN");
      assert.equal(caseState.reason?.category, "predicate",
        "absent daemon-scripted capability must be gated category=predicate (never INFRA)");
      assert.deepEqual(caseState.attempts, [], "NOT_RUN(predicate) cell must never execute");
      const evidence = caseState.reason?.evidence ?? [];
      assert.ok(Array.isArray(evidence) && evidence.length > 0, "predicate block must carry non-empty evidence");
      const capEvidence = evidence.find((e: any) => String(e?.predicate).includes("capabilities.daemon-scripted"));
      assert.ok(capEvidence, `evidence must name capabilities.daemon-scripted (got ${JSON.stringify(evidence)})`);
      assert.equal(capEvidence.expected, true, "evidence must record expected=true for the capability");
      assert.equal(capEvidence.observed, false, "evidence must record observed=false (honest, not a silent skip)");
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
      fs.rmSync(manifestPath, { force: true });
      for (const campaignId of campaignIds) {
        fs.rmSync(path.join(varRoot, "results", campaignId), { recursive: true, force: true });
      }
      // Restore the REAL profile so sibling tests see truth.
      const restore = runTt(verifyEnv, ["--fast", "--json"]);
      assert.equal(restore.status, 0, `profile restore failed:\n${restore.stderr}`);
    }
  });

  it("AC4: a cell requiring capabilities [\"node-sqlite\",\"daemon-scripted\"] passes UNGATED through tt-controller on linux (no tt-controller change needed)", () => {
    // Real linux profile: daemon-scripted true (AC1 leg just restored it).
    const profile = loadJson(hostProfilePath);
    assert.equal(profile.capabilities?.["daemon-scripted"], true, "precondition: real profile has daemon-scripted=true");
    assert.equal(profile.platform?.os, "linux", "precondition: real profile is the linux host");

    const manifestPath = writeManifest([
      localCaseRecord(PRED_CASE_ID, { capabilities: ["node-sqlite", "daemon-scripted"], node_min: 22 }),
    ]);
    let campaignId: string | null = null;
    try {
      const campaign = runCampaign(manifestPath);
      campaignId = campaign.campaignId;
      const caseState = campaign.state.cases.find((c: any) => c.id === PRED_CASE_ID);
      assert.ok(caseState, `case ${PRED_CASE_ID} missing from campaign state`);
      // The capability must NOT gate the cell: it executes and reaches a real
      // terminal outcome (PASS — the local node -e command exits 0).
      assert.equal(caseState.outcome, "PASS",
        `honestly-present daemon-scripted capability must execute the cell, got outcome=${caseState.outcome}`);
      assert.notEqual(caseState.reason?.category, "predicate",
        "honestly-present daemon-scripted capability must not carry a predicate block");
      assert.ok((caseState.attempts ?? []).length > 0, "cell must have executed (attempts > 0)");
      assert.equal(caseState.spend?.tokens_observed ?? 0, 0, "local cell must be zero-token");
    } finally {
      fs.rmSync(manifestPath, { force: true });
      if (campaignId !== null) {
        fs.rmSync(path.join(varRoot, "results", campaignId), { recursive: true, force: true });
      }
    }
  });
});
