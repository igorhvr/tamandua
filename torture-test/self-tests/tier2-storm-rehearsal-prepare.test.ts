// Tier-2 STORM-REHEARSAL US-001 — fresh-owned rehearsal preparation /
// input / profile / behavior builder (in-process; NO daemon/harness/chaos).
//
// The tt-storm rehearsal gate's PREPARE layer must allocate and fully
// provision every fresh-owned input the real zero-model SCRIPTED_REHEARSAL
// will consume, derived from the ACTUAL current bundled workflows/rosters, so
// a coordinator can review ONE coherent source-pinned descriptor and
// authorize an exact executable campaign. This file is the ONE focused
// torture self-test for that preparation builder:
//
//   * catalog seeding from the ACTUAL bundled catalog (workflows/) with
//     per-workflow source path + sha256 provenance; the derived active timer
//     cap is the SUM of per-workflow distinct step-agent counts over the
//     CURRENT catalog registrations (never a hardcoded historical number);
//   * fresh owned private execution/input roots under a contained var root,
//     realpath + dev/ino captured AT allocation;
//   * the owned TINY git origin + sibling clones (colleague/park) with a
//     broken-tests branch — entirely local, no network, no credentials;
//   * per-run task files for EVERY Round A (S1-S10, incl. S7 broken-tests
//     quarantine + S9/S10 queue entries) and Round B (B1-B5, incl. B4
//     red-bait + B5 do-now) roster entry, each referencing the ACTUAL bundled
//     workflow id + harness assignment and declaring exact expected scripted
//     operations/outputs — no tiny renamed substitute workflows;
//   * descriptor + campaign-state shape (source commit/tree + tree_dirty,
//     complete gate-file sha256 set, catalog identity, frozen binary/runtime
//     pins, resource plan, per-run input manifest, exact authorized rehearse
//     command);
//   * a full rehearsal prepare spawns NO daemon/harness/chaos and a second
//     prepare against the same destination refuses with the existing files
//     untouched.
//
// Everything runs under fresh owned temp roots (os.tmpdir scratch) or a
// TT_VAR-overridden scratch var for the real CLI subprocess; the git fixture
// is created by LOCAL git subprocesses only (GIT_CONFIG_GLOBAL=/dev/null,
// no network, no provider credentials). No filesystem disposal of retained
// artifacts is ever performed by the code under test; tests remove only their
// own scratch dirs in finally, per suite convention.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { REAL_FS } from "../bin/tt-storm-roster.mjs";
import {
  ROUND_A_ROSTER,
  ROUND_B_ROSTER,
  STORM_WORKFLOW_IDS,
  computeActiveTimerCap,
  deriveTimerCounts,
  parseWorkflowAgents,
} from "../bin/tt-storm-roster.mjs";
import { deriveStormNumbers, spawnCapture } from "../bin/tt-storm-shared.mjs";
import { buildPrivateExecContext, persistableExecIdentity } from "../bin/tt-storm-real.mjs";
import { stormPrepare } from "../bin/tt-storm-engine.mjs";
import {
  allocateRehearsalInputRoots,
  computeGateHashes,
  DEFAULT_COORDINATOR_APPROVAL_FILE,
  DESCRIPTOR_NAME,
  deriveScriptedHoldSchedule,
  provisionOwnedGitFixture,
  provisionTaskFiles,
  REHEARSAL_LABEL,
  REHEARSAL_PROFILE,
  seedCatalogFromBundled,
} from "../bin/tt-storm-rehearsal.mjs";

const repoRoot = process.cwd();
const TT_DIR = path.join(repoRoot, "torture-test");
const TAMANDUA_BIN = path.join(repoRoot, "bin", "tamandua");
const TT_STORM_CLI = path.join(TT_DIR, "bin", "tt-storm");
const BUNDLED_WORKFLOWS = path.join(repoRoot, "workflows");
// US-008: the committed-pointer contract for the fresh fix8 campaign prepared
// in THIS worktree. The pointer (and every campaign it names) lives under the
// gitignored torture-test/var, so a fresh clone has no pointer and the host
// tests below simply return — exactly like the fix7 host-state convention.
const FIX8_CAMPAIGN_POINTER = path.join(TT_DIR, "var", "storm-rehearsal-fix8", "storm-rehearsal-fix8-campaign.json");
// US-009 (STORM-REHEARSAL-FIX9): the pointer + published readiness for the
// fresh fix9 campaign prepared in THIS worktree. Both are host-state artifacts
// (the pointer lives under gitignored torture-test/var; the readiness under
// /root/matchlock-work), so a fresh clone / host has neither and P8b simply
// returns. The readiness part is validated only when the file exists so the
// chain run that PRODUCES the self-test logs (before the readiness is built)
// still passes, and the standalone re-run after publication proves it.
const FIX9_CAMPAIGN_POINTER = path.join(TT_DIR, "var", "storm-rehearsal-fix9", "storm-rehearsal-fix9-campaign.json");
const FIX9_READINESS_PATH = "/root/matchlock-work/storm-rehearsal-fix9-readiness.json";
const FIX9_BRANCH = "fix/torture-storm-rehearsal-rugpull-identity-20260913";
const FIX9_NEW_SELF_TEST = "torture-test/self-tests/tier2-storm-rehearsal-noop-evidence.test.ts";

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Owned scratch dir created by THIS test, removed in finally.
function ownedScratch(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tt-reh-prepare-${label}-`));
}

// A real, LOCAL git adapter for the fixture provisioning (spawnCapture with
// mergeParentEnv:false so only the explicit hermetic env reaches git).
function makeRealGitAdapter() {
  return {
    run: async (cwd: string, args: string[], { env = {} }: { env?: Record<string, string> } = {}) => {
      const res = await spawnCapture(["git", ...args], {
        cwd,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, ...env },
        mergeParentEnv: false,
        timeoutMs: 120_000,
      });
      return res;
    },
  };
}

function git(cwd: string, args: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env },
  });
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
}

function gitHead(repo: string): string {
  const res = git(repo, ["rev-parse", "HEAD"]);
  assert.equal(res.status, 0, `rev-parse HEAD in ${repo}: ${res.stderr}`);
  return res.stdout.trim();
}

function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function loadLines(file: string): string[] {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
}

// Recording proc adapter: proves a rehearsal prepare NEVER reaches any
// launcher/daemon/chaos/transport channel (all calls recorded, none allowed).
function makeRecordingProc() {
  const calls: Array<[string, any]> = [];
  const fn = async () => { throw new Error("recording proc must not be invoked during prepare"); };
  return {
    calls,
    launchWorkflow: async (argv: any) => { calls.push(["launch", argv]); return fn(); },
    tamandua: async (argv: any) => { calls.push(["tamandua", argv]); return fn(); },
    chaosAction: async (argv: any) => { calls.push(["chaos", argv]); return fn(); },
    daemonControl: async (argv: any) => { calls.push(["daemon", argv]); return fn(); },
    httpGet: async (url: any) => { calls.push(["http", url]); return fn(); },
    mcpTool: async (req: any) => { calls.push(["mcp", req]); return fn(); },
  };
}

function childEnvForCli(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return { ...env, ...extra };
}

function runCliPrepare(scratchVar: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [TT_STORM_CLI, "prepare", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 300_000,
    env: childEnvForCli({ TT_VAR: scratchVar }),
  });
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
}

// US-008: the read-only `tt-storm plan` entrypoint (hermetic scratch TT_VAR so
// the installed-catalog resolution never touches the repo's shared var).
function runCliPlan(scratchVar: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [TT_STORM_CLI, "plan"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 300_000,
    env: childEnvForCli({ TT_VAR: scratchVar }),
  });
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
}

describe("STORM-REHEARSAL US-001 prepare builder — in-process + real CLI (no daemon/harness/chaos)", () => {
  it("P1: catalog seeding from the ACTUAL bundled catalog derives identical numbers; active cap is the SUM of current per-workflow distinct step-agent counts (never a hardcoded timer count)", async () => {
    const scratch = ownedScratch("catalog");
    try {
      // Independent derivation #1: straight from the ACTUAL bundled catalog.
      const bundled = await deriveStormNumbers({ fs: REAL_FS, installedCatalogRoot: null, bundledCatalogRoot: BUNDLED_WORKFLOWS });
      assert.ok(bundled.cap.total > 0, "bundled derivation must resolve a positive active cap");
      assert.equal(bundled.resolved.kind, "bundled", "without an installed root the resolution is the bundled catalog");

      // Independent derivation #2: parse every active roster workflow's
      // workflow.yml directly and sum the distinct step-agent counts.
      const activeRoster = ROUND_A_ROSTER.filter((r) => !r.queued);
      let directSum = 0;
      for (const r of activeRoster) {
        const yml = fs.readFileSync(path.join(BUNDLED_WORKFLOWS, r.workflow, "workflow.yml"), "utf8");
        const parsed = parseWorkflowAgents(yml, r.workflow);
        directSum += parsed.stepAgents.length;
      }
      assert.equal(bundled.cap.total, directSum, "cap must equal the SUM of per-workflow distinct step-agent counts over the actual catalog");

      // Seeding the private installed catalog from the bundled catalog.
      const installedRoot = path.join(scratch, "home", ".tamandua", "workflows");
      const seed = seedCatalogFromBundled({ fs: REAL_FS, bundledRoot: BUNDLED_WORKFLOWS, installedRoot });
      assert.equal(seed.kind, "installed");
      assert.ok(seed.seeded.length >= STORM_WORKFLOW_IDS.length, "every storm workflow directory must be seeded");
      for (const wf of STORM_WORKFLOW_IDS) {
        assert.ok(seed.seeded.includes(wf), `bundled workflow ${wf} must be seeded`);
        const actual = fs.readFileSync(path.join(BUNDLED_WORKFLOWS, wf, "workflow.yml"), "utf8");
        assert.equal(seed.perWorkflow[wf].sourceSha256, sha(actual), `${wf} source sha must equal a fresh sha256 of the actual bundled workflow.yml`);
        assert.ok(fs.existsSync(seed.perWorkflow[wf].installedPath), `${wf} installed workflow.yml must exist`);
        assert.equal(seed.perWorkflow[wf].installedSha256, seed.perWorkflow[wf].sourceSha256, `${wf} seeded copy is byte-identical to the source`);
      }

      // Independent derivation #3: over the SEEDED installed catalog — must
      // match the bundled derivation exactly (same registrations).
      const installed = await deriveStormNumbers({ fs: REAL_FS, installedCatalogRoot: installedRoot, bundledCatalogRoot: BUNDLED_WORKFLOWS });
      assert.equal(installed.resolved.kind, "installed", "a seeded installed root is authoritative");
      assert.equal(installed.cap.total, bundled.cap.total, "seeded-installed derivation must equal bundled derivation");
      for (const wf of STORM_WORKFLOW_IDS) {
        assert.equal(installed.counts[wf].distinctStepAgents, bundled.counts[wf].distinctStepAgents, `${wf} count must be identical after seeding`);
      }
      // computeActiveTimerCap over the seeded counts is internally consistent.
      const cap = computeActiveTimerCap(installed.counts);
      assert.equal(cap.total, installed.cap.total);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("P2: allocateRehearsalInputRoots — fresh owned roots under var with realpath + dev/ino captured at allocation; traversal refused", () => {
    const scratch = ownedScratch("alloc");
    try {
      const varRoot = path.join(scratch, "var");
      fs.mkdirSync(varRoot, { recursive: true });
      const campaignId = "storm-prepare-unit-0001";
      const roots = allocateRehearsalInputRoots({ fs: REAL_FS, varRoot, campaignId });
      assert.ok(fs.existsSync(roots.root), "input root must exist");
      assert.ok(fs.existsSync(roots.tasksRoot), "tasks root must exist");
      assert.ok(fs.existsSync(roots.reposRoot), "repos root must exist");
      assert.ok(fs.existsSync(roots.worktreeRoot), "worktree root must exist");
      for (const key of ["root", "tasks", "repos", "worktree"]) {
        const receipt = roots.receipts[key];
        assert.ok(path.isAbsolute(receipt.realpath), `${key} receipt realpath must be absolute`);
        const rel = path.relative(varRoot, receipt.realpath);
        assert.ok(rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)), `${key} receipt must stay under the var root`);
        assert.ok(receipt.ino !== null && receipt.ino > 0, `${key} inode captured at allocation`);
        assert.ok(receipt.dev !== null && receipt.dev > 0, `${key} dev captured at allocation`);
      }
      // Re-allocation of the same campaign is idempotent and keeps the same
      // inodes (same directories — never replaced).
      const again = allocateRehearsalInputRoots({ fs: REAL_FS, varRoot, campaignId });
      assert.equal(again.root, roots.root);
      assert.equal(again.receipts.root.ino, roots.receipts.root.ino, "re-allocation must not replace the owned directory");
      // Traversal / unsafe campaign ids are refused.
      assert.throws(() => allocateRehearsalInputRoots({ fs: REAL_FS, varRoot, campaignId: "../escape" }), (e: any) => e.code === "TT_USAGE");
      assert.throws(() => allocateRehearsalInputRoots({ fs: REAL_FS, varRoot, campaignId: "a/b" }), (e: any) => e.code === "TT_USAGE");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("P3: provisionOwnedGitFixture — owned tiny origin + sibling colleague/park clones + broken-tests branch, dev/ino receipts, local-only", async () => {
    const scratch = ownedScratch("gitfix");
    try {
      const reposRoot = path.join(scratch, "repos");
      fs.mkdirSync(reposRoot, { recursive: true });
      const gitAdapter = makeRealGitAdapter();
      const fixture = await provisionOwnedGitFixture({ fs: REAL_FS, git: gitAdapter, reposRoot, env: { HOME: scratch } });

      assert.ok(fs.existsSync(path.join(fixture.originRepo, "README.md")), "origin has the fixture README");
      assert.ok(fs.existsSync(path.join(fixture.originRepo, "go", "workerpool", "pool.go")), "origin has the go-lane file");
      assert.ok(fs.existsSync(path.join(fixture.originRepo, "rust", "bugfix", "src", "lib.rs")), "origin has the rust bug area");
      assert.match(gitHead(fixture.originRepo), /^[0-9a-f]{40}$/);
      // main + broken-tests branches exist and differ.
      const branches = git(fixture.originRepo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).stdout.trim().split(/\r?\n/).sort();
      assert.deepEqual(branches, ["broken-tests", "main"]);
      assert.notEqual(fixture.mainHead, fixture.brokenTestsHead, "broken-tests branch must carry the seeded broken test");
      const brokenOnBranch = git(fixture.originRepo, ["cat-file", "-e", `broken-tests:tests/broken_test.py`]);
      assert.equal(brokenOnBranch.status, 0, "broken test file exists only on the broken-tests branch");
      const brokenOnMain = git(fixture.originRepo, ["cat-file", "-e", `main:tests/broken_test.py`]);
      assert.notEqual(brokenOnMain.status, 0, "broken test file must NOT exist on main");
      // Sibling clones at the same main head as origin; origin remote is LOCAL.
      for (const dir of [fixture.colleagueRepo, fixture.parkRepo]) {
        assert.equal(gitHead(dir), fixture.mainHead, `${dir} must be cloned at origin main`);
        const remote = git(dir, ["remote", "get-url", "origin"]).stdout.trim();
        assert.equal(remote, fixture.originRepo, "the only remote is the LOCAL owned origin (no network)");
      }
      // dev/ino receipts captured at allocation for all three repos.
      for (const key of ["origin", "colleague", "park"]) {
        const r = fixture.receipts[key];
        assert.ok(path.isAbsolute(r.realpath));
        assert.ok(r.ino !== null && r.ino > 0, `${key} receipt ino captured`);
        assert.ok(r.dev !== null && r.dev > 0, `${key} receipt dev captured`);
      }
      // Known cc1/cc2/broken-test file identities are recorded.
      assert.equal(fixture.files.cc1, "docs/cc1.md");
      assert.equal(fixture.files.cc2, "rust/bugfix/src/lib.rs");
      assert.equal(fixture.files.brokenTests, "tests/broken_test.py");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("P4: per-run task files for ALL 10 Round A + 5 Round B entries reference the ACTUAL workflow id + harness from tt-storm-roster.mjs (S7 broken-tests, B4 red-bait, B5 do-now) and declare expected scripted operations/outputs — no substitute workflows", async () => {
    const scratch = ownedScratch("tasks");
    try {
      const tasksRoot = path.join(scratch, "tasks");
      const fixture = { originRepo: path.join(scratch, "repos", "origin") };
      const prov = provisionTaskFiles({ fs: REAL_FS, tasksRoot, fixture });
      assert.equal(Object.keys(prov.taskFiles).length, 15, "S1-S10 + B1-B5 = 15 task files");
      assert.equal(Object.keys(prov.manifest).length, 15);

      const allRoster = [...ROUND_A_ROSTER, ...ROUND_B_ROSTER];
      const seenWorkflows = new Set<string>();
      for (const r of allRoster) {
        const file = prov.taskFiles[r.id];
        assert.ok(file, `${r.id} must have a provisioned task file`);
        assert.ok(fs.existsSync(file), `${r.id} task file exists on disk: ${file}`);
        assert.equal(path.basename(file), `${r.run}.task.md`);
        const content = fs.readFileSync(file, "utf8");
        assert.ok(content.includes(`ROSTER_ID: ${r.id}`), `${r.id} names its roster id`);
        assert.ok(content.includes(`WORKFLOW: ${r.workflow}`), `${r.id} names the ACTUAL bundled workflow ${r.workflow}`);
        assert.ok(content.includes(`HARNESS: ${r.harness}`), `${r.id} names its harness ${r.harness}`);
        assert.ok(content.includes("## Expected scripted operations"), `${r.id} declares expected scripted operations`);
        assert.ok(content.includes("## Expected scripted output"), `${r.id} declares expected scripted output`);
        assert.ok(content.includes(REHEARSAL_LABEL), `${r.id} labels the rehearsal infrastructure (not full tt-poly storm)`);
        seenWorkflows.add(r.workflow);
      }
      // NO tiny renamed substitute workflows: every workflow id used by the
      // roster exists as a REAL bundled workflow directory with a workflow.yml.
      for (const wf of seenWorkflows) {
        assert.ok(fs.existsSync(path.join(BUNDLED_WORKFLOWS, wf, "workflow.yml")), `roster workflow ${wf} must exist in the actual bundled catalog`);
      }
      assert.deepEqual([...seenWorkflows].sort(), [...STORM_WORKFLOW_IDS].sort(), "roster task files use exactly the storm workflow set");

      // Per-entry flag / context semantics.
      const s7 = fs.readFileSync(prov.taskFiles.S7, "utf8");
      assert.ok(s7.includes("branch=broken-tests"), "S7 task carries the broken-tests quarantine context");
      assert.ok(s7.includes("TARGET_BRANCH: broken-tests"), "S7 task targets broken-tests");
      assert.ok(s7.includes("quarantine-broken-tests-merge-worktree"), "S7 uses the ACTUAL quarantine-broken-tests-merge-worktree workflow");
      const s9 = fs.readFileSync(prov.taskFiles.S9, "utf8");
      assert.ok(s9.includes("QUEUED: true"), "S9 is a queue entry");
      const s10 = fs.readFileSync(prov.taskFiles.S10, "utf8");
      assert.ok(s10.includes("WORKFLOW: do-now"), "S10 is the do-now queue-drain canary");
      const b4 = fs.readFileSync(prov.taskFiles.B4, "utf8");
      assert.ok(b4.includes("RED_BAIT: true"), "B4 task is the red-bait");
      assert.ok(b4.includes("bug-fix-merge-worktree"), "B4 uses the ACTUAL bug-fix-merge-worktree workflow");
      assert.match(b4, /expected RED|stays RED|deliberately must not go green/, "B4 expects the truthful red outcome");
      const b5 = fs.readFileSync(prov.taskFiles.B5, "utf8");
      assert.ok(b5.includes("DO_NOW: true"), "B5 task is do-now");
      assert.ok(b5.includes("WORKFLOW: do-now"), "B5 uses do-now");
      for (const rid of ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "B1", "B2", "B3", "B4", "B5"]) {
        const runName = allRoster.find((r) => r.id === rid)?.run;
        assert.ok(runName !== undefined && prov.manifest[runName] !== undefined, `manifest carries roster ${rid} (run ${runName})`);
        assert.equal(prov.manifest[runName].rosterId, rid);
      }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("P5: a full rehearsal prepare through stormPrepare spawns NO daemon/harness/chaos, seeds the catalog, provisions inputs, and a second prepare against the same destination refuses with files untouched", async () => {
    const scratch = ownedScratch("prepare");
    try {
      const varRoot = path.join(scratch, "var");
      fs.mkdirSync(varRoot, { recursive: true });
      const installedRoot = path.join(varRoot, "home", ".tamandua", "workflows");
      const execCtx = buildPrivateExecContext({ varRoot, binaries: { tamandua: TAMANDUA_BIN } });
      const proc = makeRecordingProc();
      const ctx: any = {
        fs: REAL_FS,
        clock: {
          nowMs: () => Date.now(),
          nowUtc: () => new Date().toISOString(),
          sleep: async () => {},
        },
        proc,
        db: null,
        git: makeRealGitAdapter(),
        varRoot,
        campaignDir: null,
        opts: {
          rehearsalPrepare: true,
          installedCatalogRoot: installedRoot,
          bundledCatalogRoot: BUNDLED_WORKFLOWS,
          sourceCommit: "c".repeat(40),
          sourceTree: "t".repeat(40),
          sourceTreeDirty: false,
          execIdentity: persistableExecIdentity(execCtx),
          gitEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: path.join(scratch, "git-home") },
          gateHashes: computeGateHashes(),
          coordinatorApprovalFile: DEFAULT_COORDINATOR_APPROVAL_FILE,
        },
        argv: ["prepare"],
      };

      const res: any = await stormPrepare(ctx);
      // No launcher/daemon/chaos/transport channel was ever reached.
      assert.equal(proc.calls.length, 0, `prepare must not spawn anything (recording proc saw: ${JSON.stringify(proc.calls)})`);

      // The campaign dir holds exactly the four prepare files (+ the reserved
      // results/ subdir created by initCampaign).
      const dirEntries = fs.readdirSync(res.campaignDir).sort();
      assert.deepEqual(dirEntries, ["descriptor.json", "intent.jsonl", "ops.jsonl", "results", "state.json"], "campaign dir file set");

      // US-006 reconciliation (fix-2 S5): the scripted-runtime contract is
      // materialized under the OWNED roots and recorded in state — never inside
      // the campaign dir (whose file set must stay unchanged above).
      const sr5 = res.state.rehearsal.scripted_runtime;
      assert.ok(sr5 && typeof sr5 === "object", "P5 state records the scripted-runtime contract (S5)");
      assert.ok(sr5.agents > 0, "P5 scripted behaviors cover at least one agent");
      assert.ok(path.isAbsolute(sr5.behaviors_file) && fs.existsSync(sr5.behaviors_file), "P5 behaviors file exists at an absolute path");
      assert.equal(sr5.behaviors_sha256, sha(fs.readFileSync(sr5.behaviors_file, "utf8")), "P5 behaviors sha256 matches the file bytes");
      assert.ok(sr5.behaviors_file.startsWith(res.rehearsal.inputRoots.root + path.sep), "P5 behaviors file lives under the owned rehearsal input root");
      assert.ok(!sr5.behaviors_file.startsWith(res.campaignDir + path.sep), "P5 behaviors file is NEVER written inside campaignDir");
      assert.ok(path.isAbsolute(sr5.state_dir) && fs.statSync(sr5.state_dir).isDirectory(), "P5 scripted state dir exists");
      assert.ok(sr5.state_dir.startsWith(execCtx.state_root + path.sep), "P5 scripted state dir lives under the private exec-identity state root");
      assert.ok(!sr5.state_dir.startsWith(res.campaignDir + path.sep), "P5 scripted state dir is NEVER written inside campaignDir");
      assert.deepEqual([...sr5.workflows].sort(), [...STORM_WORKFLOW_IDS].sort(), "P5 scripted runtime covers exactly the storm workflow set");

      // Catalog seeded under the private installed root.
      for (const wf of STORM_WORKFLOW_IDS) {
        assert.ok(fs.existsSync(path.join(installedRoot, wf, "workflow.yml")), `seeded catalog has ${wf}`);
      }

      // Second prepare against the SAME destination refuses (TT_EXISTS) and
      // the existing files are untouched.
      const before: Record<string, string> = {};
      for (const name of ["state.json", "descriptor.json", "intent.jsonl", "ops.jsonl"]) {
        before[name] = sha(fs.readFileSync(path.join(res.campaignDir, name), "utf8"));
      }
      const ctx2: any = { ...ctx, campaignDir: res.campaignDir };
      await assert.rejects(() => stormPrepare(ctx2), (e: any) => e.code === "TT_EXISTS");
      for (const name of Object.keys(before)) {
        assert.equal(sha(fs.readFileSync(path.join(res.campaignDir, name), "utf8")), before[name], `${name} untouched after refused re-prepare`);
      }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("P6: the REAL tt-storm CLI prepare (TT_VAR scratch) exits 0, prints the DERIVED cap, and writes a coherent state.json + descriptor.json (source pins, exec-identity receipts, gate hashes, catalog identity, runtime pins, resource plan, per-run manifest, exact authorized command)", () => {
    const scratch = ownedScratch("cli");
    try {
      fs.mkdirSync(path.join(scratch, "results"), { recursive: true });
      const first = runCliPrepare(scratch, []);
      assert.equal(first.status, 0, `CLI prepare exit 0:\nstdout=${first.stdout}\nstderr=${first.stderr}`);
      assert.match(first.stdout, /Active timer cap \(derived from actual registrations\): \d+/, "prepare prints the derived cap");
      assert.match(first.stdout, new RegExp(REHEARSAL_PROFILE), "prepare prints the SCRIPTED_REHEARSAL profile");
      const m = /Campaign dir: (\S+)/.exec(first.stdout);
      assert.ok(m, "prepare prints the campaign dir");
      const campaignDir = m[1];
      assert.match(path.basename(campaignDir), /^storm-/, "campaign dir is named storm-*");
      assert.ok(path.dirname(campaignDir).endsWith(path.join("results")), "campaign dir lives under <var>/results");

      // Exactly the four files (+ reserved results/ subdir).
      assert.deepEqual(fs.readdirSync(campaignDir).sort(), ["descriptor.json", "intent.jsonl", "ops.jsonl", "results", "state.json"]);

      // ops.jsonl/intent.jsonl non-empty and JSON-lines parseable.
      for (const name of ["ops.jsonl", "intent.jsonl"]) {
        const lines = loadLines(path.join(campaignDir, name));
        assert.ok(lines.length > 0, `${name} has records`);
        for (const l of lines) JSON.parse(l);
      }

      // state.json: campaign id, source commit/tree + tree_dirty matching git,
      // exec-identity receipt with dev/ino, complete gate-hash set.
      const state = loadJson(path.join(campaignDir, "state.json"));
      assert.equal(state.campaign_id, path.basename(campaignDir));
      const head = git(repoRoot, ["rev-parse", "HEAD"]);
      const tree = git(repoRoot, ["rev-parse", "HEAD^{tree}"]);
      assert.equal(state.source.commit, head.stdout.trim(), "state.source.commit matches git rev-parse HEAD");
      assert.equal(state.source.tree, tree.stdout.trim(), "state.source.tree matches git rev-parse HEAD^{tree}");
      assert.equal(typeof state.source.tree_dirty, "boolean", "tree_dirty is a real boolean");
      const porcelain = git(repoRoot, ["status", "--porcelain"]);
      assert.equal(state.source.tree_dirty, porcelain.stdout.trim() !== "", "tree_dirty matches the working tree");
      assert.equal(state.qualification.real_launch_allowed, false, "prepare never self-qualifies");
      assert.ok(state.exec_identity?.ownership?.home?.ino > 0, "exec-identity receipt captured at allocation");
      // US-001/S2: the exec-identity DB is created fresh by the PRODUCT schema
      // path, so its receipt must carry a real dev/ino and the prepared DB must
      // bear current product columns (notify_url proves it is not the run #56
      // hand-rolled `runs` DDL).
      assert.ok(state.exec_identity?.ownership?.db?.ino > 0, "exec-identity DB receipt captured after product-schema creation");
      const preparedDbPath = state.exec_identity.db_path;
      assert.ok(preparedDbPath && fs.existsSync(preparedDbPath), "prepared product-schema DB exists at the exec-identity path");
      const preparedDb = new DatabaseSync(preparedDbPath);
      let preparedRunColumns: string[] = [];
      try {
        preparedRunColumns = (preparedDb.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map((r) => r.name);
      } finally {
        preparedDb.close();
      }
      assert.ok(preparedRunColumns.includes("notify_url"), "prepared DB runs table includes the product column notify_url");
      const currentGateHashes = computeGateHashes();
      assert.deepEqual(state.gate_hashes, currentGateHashes, "state carries the complete gate-file sha256 set");
      for (const [file, hash] of Object.entries(currentGateHashes)) {
        assert.equal(hash, sha(fs.readFileSync(path.join(repoRoot, file), "utf8")), `${file} gate hash equals a fresh sha256 of the file`);
      }
      assert.ok(state.rehearsal?.profile === REHEARSAL_PROFILE, "state.rehearsal.profile is SCRIPTED_REHEARSAL");
      assert.equal(Object.keys(state.rehearsal.task_manifest).length, 15);
      for (const key of ["origin", "colleague", "park"]) {
        assert.ok(state.rehearsal.inputs.fixture.receipts[key].ino > 0, `${key} receipt ino persisted in state`);
      }

      // US-006 reconciliation (fix-2 S5): state carries the per-campaign
      // scripted-runtime contract with the behaviors file under the owned input
      // root and the scripted state dir under the private exec-identity state
      // root (never inside campaignDir).
      const scripted = state.rehearsal.scripted_runtime;
      assert.ok(scripted && typeof scripted === "object", "state.rehearsal.scripted_runtime recorded (S5)");
      assert.match(scripted.behaviors_sha256, /^[0-9a-f]{64}$/, "scripted behaviors_sha256 is 64 hex chars");
      assert.equal(scripted.behaviors_sha256, sha(fs.readFileSync(scripted.behaviors_file, "utf8")), "scripted behaviors sha256 matches the file bytes");
      assert.ok(path.isAbsolute(scripted.behaviors_file) && fs.existsSync(scripted.behaviors_file), "scripted behaviors file exists at an absolute path");
      assert.ok(scripted.behaviors_file.startsWith(state.rehearsal.inputs.root + path.sep), "scripted behaviors file lives under the owned input root");
      assert.ok(!scripted.behaviors_file.startsWith(campaignDir + path.sep), "scripted behaviors file is NEVER inside campaignDir");
      assert.ok(path.isAbsolute(scripted.state_dir) && fs.statSync(scripted.state_dir).isDirectory(), "scripted state dir exists at an absolute path");
      assert.ok(scripted.state_dir.startsWith(state.exec_identity.state_root + path.sep), "scripted state dir lives under the private exec-identity state root");
      assert.ok(!scripted.state_dir.startsWith(campaignDir + path.sep), "scripted state dir is NEVER inside campaignDir");
      assert.ok(scripted.agents > 0, "scripted runtime covers at least one agent");
      assert.deepEqual([...scripted.workflows].sort(), [...STORM_WORKFLOW_IDS].sort(), "scripted runtime covers exactly the storm workflow set");

      // descriptor.json shape.
      const desc = loadJson(path.join(campaignDir, DESCRIPTOR_NAME));
      assert.equal(desc.kind, "tt-storm-rehearsal-descriptor");
      assert.equal(desc.profile, REHEARSAL_PROFILE);
      assert.equal(desc.campaign.id, state.campaign_id);
      assert.deepEqual(desc.gate_hashes, currentGateHashes, "descriptor carries the gate hashes");
      assert.equal(desc.catalog_identity.kind, "installed");
      assert.ok(desc.catalog_identity.installed_root.includes(path.join("home", ".tamandua", "workflows")), "catalog identity names the private installed root");
      assert.equal(desc.roster.round_a, 10);
      assert.equal(desc.roster.round_b, 5);
      assert.equal(Object.keys(desc.input_manifest.task_files).length, 15);
      // runtime pins: absolute frozen binaries + scripted runtimes, no real-harness fallback.
      for (const key of ["tamandua", "tamanduaTest", "daemonControl", "ttChaos", "git"]) {
        assert.ok(desc.runtime_pins.binaries[key].path.endsWith(key === "tamanduaTest" ? "tamandua-test" : key === "daemonControl" ? "daemon-control" : key === "ttChaos" ? "tt-chaos" : key), `binary pin for ${key}`);
        assert.equal(desc.runtime_pins.binaries[key].present, true, `binary ${key} present`);
        assert.match(desc.runtime_pins.binaries[key].sha256 ?? "", /^[0-9a-f]{64}$/, `binary ${key} sha256 pinned`);
      }
      assert.equal(desc.runtime_pins.scripted_runtimes.pi.present, true, "frozen scripted pi runtime pinned");
      assert.equal(desc.runtime_pins.scripted_runtimes.hermes.present, true, "frozen scripted hermes runtime pinned");
      assert.equal(desc.runtime_pins.scripted_runtimes.probe_enabled, true);
      assert.match(desc.runtime_pins.scripted_runtimes.note, /no real-harness fallback|credentials absent/, "no real-harness fallback declared");
      // US-006 reconciliation: the descriptor mirrors the scripted-runtime
      // contract so a coordinator can reconcile the campaign before launch.
      assert.ok(desc.scripted_runtime && typeof desc.scripted_runtime === "object", "descriptor carries scripted_runtime (S5)");
      assert.equal(desc.scripted_runtime.behaviors_sha256, scripted.behaviors_sha256, "descriptor mirrors the behaviors sha256");
      assert.equal(desc.scripted_runtime.state_dir, scripted.state_dir, "descriptor mirrors the scripted state dir");
      assert.deepEqual([...desc.scripted_runtime.workflows].sort(), [...STORM_WORKFLOW_IDS].sort(), "descriptor scripted runtime covers the storm workflow set");
      // resource plan.
      assert.ok(desc.resource_plan.fixture.origin.endsWith(path.join("repos", "origin")), "resource plan names the owned origin");
      assert.ok(desc.resource_plan.listeners.includes("dashboard") && desc.resource_plan.listeners.includes("mcp") && desc.resource_plan.listeners.includes("control"));
      // exact authorized command — real values, no placeholder.
      const auth = desc.authorized_rehearse;
      assert.equal(auth.profile, REHEARSAL_PROFILE);
      assert.equal(auth.approval_file, DEFAULT_COORDINATOR_APPROVAL_FILE);
      assert.equal(auth.rounds.length, 2);
      for (const round of auth.rounds) {
        assert.ok(round.includes(campaignDir), "authorized round command names the REAL campaign dir");
        assert.ok(round.includes(DEFAULT_COORDINATOR_APPROVAL_FILE), "authorized round command names the coordinator approval file");
        assert.ok(round.includes("--round "), "authorized round command names the round");
        assert.ok(!round.includes("<prepared-campaign-dir>") && !round.includes("PLACEHOLDER"), "no placeholder campaign identity");
      }
      // second prepare against the SAME destination refuses non-zero and the
      // existing files are left untouched.
      const second = runCliPrepare(scratch, ["--campaign", campaignDir]);
      assert.notEqual(second.status, 0, "second prepare against the same destination must refuse");
      // The campaign destination now already owns a product-schema DB, so the
      // second prepare refuses at the fresh-DB guarantee (TT_EXEC_DB_STALE)
      // BEFORE reaching stormPrepare's campaign-dir-exists refusal; both are
      // valid fail-closed refusals that must leave the campaign untouched.
      assert.match(second.stderr, /already exists|REFUSED|TT_EXEC_DB_STALE/, "refusal reason names the existing destination or the stale DB");
      const afterState = sha(fs.readFileSync(path.join(campaignDir, "state.json"), "utf8"));
      assert.equal(afterState, sha(fs.readFileSync(path.join(campaignDir, "state.json"), "utf8")));
      // Real fixture repos exist (owned git origin + sibling clones).
      assert.ok(fs.existsSync(path.join(state.rehearsal.inputs.fixture.originRepo, ".git")), "owned origin exists");
      assert.ok(fs.existsSync(path.join(state.rehearsal.inputs.fixture.colleagueRepo, ".git")), "owned colleague clone exists");
      assert.ok(fs.existsSync(path.join(state.rehearsal.inputs.fixture.parkRepo, ".git")), "owned park clone exists");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  // ── US-008 (STORM-REHEARSAL-FIX8) ─────────────────────────────────────
  // The READ-ONLY plan entrypoint and the fresh fix8 campaign + designated
  // pending candidate the coordinator's readiness will locate. P7 exercises
  // the real CLI plan hermetically (always runs); P8 validates the on-disk
  // campaign pointer prepared in THIS worktree and is tolerant when absent
  // (fresh clone / host without a prepared campaign).

  it("P7: the real read-only `tt-storm plan` exits 0 and records source_commit == git HEAD and source_tree == HEAD^{tree} (no writes)", () => {
    const scratch = ownedScratch("plan");
    try {
      const plan = runCliPlan(scratch);
      assert.equal(plan.status, 0, `plan exit 0:\nstdout=${plan.stdout}\nstderr=${plan.stderr}`);
      const parsed = JSON.parse(plan.stdout);
      const head = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
      const tree = git(repoRoot, ["rev-parse", "HEAD^{tree}"]).stdout.trim();
      assert.equal(parsed.source_commit, head, "plan source_commit equals git rev-parse HEAD");
      assert.equal(parsed.source_tree, tree, "plan source_tree equals git rev-parse HEAD^{tree}");
      assert.equal(typeof parsed.tree_dirty, "boolean", "plan records tree_dirty as a real boolean");
      assert.ok(parsed.active_cap > 0, "plan derives a positive active timer cap from the actual catalog");
      assert.ok(parsed.per_workflow && Object.keys(parsed.per_workflow).length > 0, "plan records the ACTUAL per-workflow registration counts");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("P8: the fresh fix8 campaign + designated pending candidate prepared in THIS worktree are truthful-pending; the derived exact rehearse commands name --campaign/--round/--db and NO approval path", () => {
    if (!fs.existsSync(FIX8_CAMPAIGN_POINTER)) {
      // A fresh clone / host that has not prepared the fix8 campaign yet: the
      // committed contract is carried by P5/P6 above plus the prepare tests.
      return;
    }
    const ev = loadJson(FIX8_CAMPAIGN_POINTER);
    assert.equal(ev.kind, "storm-rehearsal-fix8-campaign");
    assert.equal(ev.story, "US-008");

    const head = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    const tree = git(repoRoot, ["rev-parse", "HEAD^{tree}"]).stdout.trim();
    assert.equal(ev.source.commit, head, "the campaign pointer pins the final HEAD");
    assert.equal(ev.source.tree, tree, "the campaign pointer pins HEAD^{tree}");
    assert.equal(ev.source.tree_dirty, false, "the campaign was prepared on a clean tree");
    assert.equal(ev.source.plan_exit_code, 0, "the read-only plan exited 0");
    assert.equal(ev.source.head_matches_plan_source_commit, true);

    // The retained plan stdout is parseable and pins the same source.
    assert.ok(fs.existsSync(ev.source.plan_stdout_path), "retained plan stdout exists");
    const plan = loadJson(ev.source.plan_stdout_path);
    assert.equal(plan.source_commit, head, "retained plan stdout source_commit == HEAD");
    assert.equal(plan.source_tree, tree, "retained plan stdout source_tree == HEAD^{tree}");
    assert.equal(sha(fs.readFileSync(ev.source.plan_stdout_path, "utf8")), ev.source.plan_stdout_sha256, "retained plan stdout sha256 matches");

    // Primary campaign: truthful-pending and naming the pending candidate.
    const c = ev.campaign;
    assert.ok(fs.existsSync(c.dir), "primary campaign dir exists");
    assert.equal(c.campaign_id_equals_basename, true);
    assert.equal(c.mode, "prepared");
    assert.equal(c.qualification.real_launch_allowed, false, "prepare never self-qualifies");
    assert.deepEqual(c.rounds, { A: "planned", B: "planned" });
    assert.equal(c.run_records_A, 0, "no Round A run records");
    assert.equal(c.run_records_B, 0, "no Round B run records");
    assert.equal(c.report, null, "no report on the unexecuted primary");
    assert.equal(c.report_json_absent, true);
    assert.equal(c.results_dir_empty, true, "the primary results dir is empty");
    assert.deepEqual(fs.readdirSync(path.join(c.dir, "results")), [], "primary results dir stays empty on disk");
    assert.ok(c.db_path && path.isAbsolute(c.db_path) && fs.existsSync(c.db_path), "primary product-schema DB exists");
    const primaryState = loadJson(path.join(c.dir, "state.json"));
    const primaryDesc = loadJson(path.join(c.dir, DESCRIPTOR_NAME));
    assert.equal(primaryState.source.commit, head);
    assert.equal(primaryState.campaign_id, c.id);

    // Pending candidate: fully prepared, unexecuted, designated by the primary.
    const p = ev.pending_candidate;
    assert.ok(fs.existsSync(p.dir), "pending candidate dir exists");
    assert.match(path.basename(p.dir), /^storm-pending-/, "the candidate is a storm-pending-* campaign");
    assert.equal(p.campaign_id_equals_basename, true);
    assert.equal(p.mode, "prepared");
    assert.equal(p.qualification_real_launch_allowed, false);
    assert.deepEqual(p.rounds, { A: "planned", B: "planned" });
    assert.equal(p.run_records_A, 0);
    assert.equal(p.run_records_B, 0);
    assert.equal(p.report, null);
    assert.equal(p.report_json_absent, true);
    assert.deepEqual(fs.readdirSync(path.join(p.dir, "results")), [], "pending candidate results dir stays empty");
    assert.ok(p.db_path && fs.existsSync(p.db_path), "pending candidate product-schema DB exists");
    assert.notEqual(p.db_path, c.db_path, "pending candidate uses a fresh private DB");
    assert.deepEqual(primaryState.pending_candidate, { campaign_id: p.id, dir: p.dir, recorded_at: primaryState.pending_candidate.recorded_at }, "primary state names the pending candidate");
    assert.equal(primaryDesc.pending_candidate.dir, p.dir, "primary descriptor mirrors the pending candidate");
    const pendingState = loadJson(path.join(p.dir, "state.json"));
    assert.equal(pendingState.campaign_id, p.id);
    assert.equal(pendingState.mode, "prepared");
    // The candidate was created BEFORE the primary recorded the designation,
    // so the designation points at the genuinely prepared campaign on disk
    // (never an overwrite/fabrication).
    assert.ok(String(pendingState.created_at) <= String(primaryState.pending_candidate.recorded_at), "candidate was created before the primary designated it");

    // Derived exact rehearse commands: --campaign/--round/--db, no approval path.
    const er = ev.exact_rehearse;
    assert.equal(er.full_commands.length, 2, "exactly the two Round A/B commands");
    for (const [idx, round] of ["A", "B"].entries()) {
      const cmd = er.full_commands[idx];
      assert.ok(cmd.includes("rehearse"), `round ${round} command invokes rehearse`);
      assert.ok(cmd.includes(`--campaign ${c.dir}`), `round ${round} command names the campaign dir`);
      assert.ok(cmd.includes(`--round ${round}`), `round ${round} command names the round`);
      assert.ok(cmd.includes(`--db ${c.db_path}`), `round ${round} command names the campaign DB`);
      assert.ok(!/approval/i.test(cmd), `round ${round} command names NO approval path: ${cmd}`);
    }
    assert.equal(er.approval_path_present_in_commands, false);
    assert.deepEqual(er.required_flags, ["--campaign", "--round", "--db"]);

    // Derived hold/phase schedule and the campaign plan projection agree.
    const derived = deriveScriptedHoldSchedule();
    assert.deepEqual(ev.derived_hold_schedule, derived, "the retained derived hold schedule is a fresh recompute");
    assert.deepEqual(ev.roundBPhases, derived.round_b.phases, "the retained roundBPhases equal the derived phases");
    assert.deepEqual(primaryState.plan?.roundBPhases, derived.round_b.phases, "the primary state.plan.roundBPhases equal the derived phases");

    // Safety: no rehearse/approve/arm and no approval file was created/edited.
    for (const [flag, value] of Object.entries(ev.safety)) {
      assert.equal(value, false, `safety flag ${flag} must be false`);
    }
  });

  // ── US-009 (STORM-REHEARSAL-FIX9) ─────────────────────────────────────
  // The fresh fix9 campaign + designated pending candidate prepared in THIS
  // worktree, plus the published fix9 readiness that LOCATES them (never
  // substitutes for the on-disk candidate). Tolerant when the gitignored
  // pointer is absent (fresh clone). The readiness half of the assertion only
  // runs once the readiness exists, so the chain run that produces the
  // self-test logs (before publication) still passes and the standalone re-run
  // after publication proves the readiness itself.
  it("P8b: the fresh fix9 campaign + designated pending candidate are truthful-pending and the fix9 readiness locates them with --campaign/--round/--db and NO approval path", () => {
    if (!fs.existsSync(FIX9_CAMPAIGN_POINTER)) return;
    const ev = loadJson(FIX9_CAMPAIGN_POINTER);
    assert.equal(ev.kind, "storm-rehearsal-fix9-campaign");
    assert.equal(ev.story, "US-009");
    assert.equal(ev.branch, FIX9_BRANCH);

    const head = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    const tree = git(repoRoot, ["rev-parse", "HEAD^{tree}"]).stdout.trim();
    assert.equal(ev.source.commit, head, "the fix9 pointer pins the final HEAD");
    assert.equal(ev.source.tree, tree, "the fix9 pointer pins HEAD^{tree}");
    assert.equal(ev.source.tree_dirty, false, "the fix9 campaign was prepared on a clean tree");
    assert.equal(ev.source.plan_exit_code, 0, "the read-only plan exited 0");
    assert.equal(ev.source.head_matches_plan_source_commit, true);

    assert.ok(fs.existsSync(ev.source.plan_stdout_path), "retained plan stdout exists");
    const plan = loadJson(ev.source.plan_stdout_path);
    assert.equal(plan.source_commit, head, "retained plan stdout source_commit == HEAD");
    assert.equal(plan.source_tree, tree, "retained plan stdout source_tree == HEAD^{tree}");
    assert.equal(sha(fs.readFileSync(ev.source.plan_stdout_path, "utf8")), ev.source.plan_stdout_sha256, "retained plan stdout sha256 matches");

    const c = ev.campaign;
    assert.ok(fs.existsSync(c.dir), "primary fix9 campaign dir exists");
    assert.equal(c.campaign_id_equals_basename, true);
    assert.equal(c.mode, "prepared");
    assert.equal(c.qualification.real_launch_allowed, false, "prepare never self-qualifies");
    assert.deepEqual(c.rounds, { A: "planned", B: "planned" });
    assert.equal(c.run_records_A, 0, "no Round A run records");
    assert.equal(c.run_records_B, 0, "no Round B run records");
    assert.equal(c.report, null, "no report on the unexecuted primary");
    assert.equal(c.results_dir_empty, true, "the primary results dir is empty");
    assert.deepEqual(fs.readdirSync(path.join(c.dir, "results")), [], "primary results dir stays empty on disk");
    assert.ok(c.db_path && path.isAbsolute(c.db_path) && fs.existsSync(c.db_path), "primary product-schema DB exists");
    const primaryState = loadJson(path.join(c.dir, "state.json"));
    assert.equal(primaryState.source.commit, head);
    assert.equal(primaryState.campaign_id, c.id);

    const p = ev.pending_candidate;
    assert.ok(fs.existsSync(p.dir), "pending candidate dir exists");
    assert.match(path.basename(p.dir), /^storm-pending-/, "the candidate is a storm-pending-* campaign");
    assert.equal(p.campaign_id_equals_basename, true);
    assert.equal(p.mode, "prepared");
    assert.equal(p.qualification_real_launch_allowed, false);
    assert.deepEqual(p.rounds, { A: "planned", B: "planned" });
    assert.equal(p.run_records_A, 0);
    assert.equal(p.run_records_B, 0);
    assert.equal(p.report, null);
    assert.deepEqual(fs.readdirSync(path.join(p.dir, "results")), [], "pending candidate results dir stays empty");
    assert.ok(p.db_path && fs.existsSync(p.db_path), "pending candidate product-schema DB exists");
    assert.notEqual(p.db_path, c.db_path, "pending candidate uses a fresh private DB");
    assert.equal(primaryState.pending_candidate.campaign_id, p.id, "primary state names the pending candidate");
    assert.equal(primaryState.pending_candidate.dir, p.dir, "primary state points at the on-disk candidate");
    const pendingState = loadJson(path.join(p.dir, "state.json"));
    assert.equal(pendingState.campaign_id, p.id);
    assert.equal(pendingState.mode, "prepared");

    const er = ev.exact_rehearse;
    assert.equal(er.full_commands.length, 2, "exactly the two Round A/B commands");
    for (const [idx, round] of ["A", "B"].entries()) {
      const cmd = er.full_commands[idx];
      assert.ok(cmd.includes("rehearse"), `round ${round} command invokes rehearse`);
      assert.ok(cmd.includes(`--campaign ${c.dir}`), `round ${round} command names the campaign dir`);
      assert.ok(cmd.includes(`--round ${round}`), `round ${round} command names the round`);
      assert.ok(cmd.includes(`--db ${c.db_path}`), `round ${round} command names the campaign DB`);
      assert.ok(!/approval/i.test(cmd), `round ${round} command names NO approval path: ${cmd}`);
    }
    assert.equal(er.approval_path_present_in_commands, false);
    assert.deepEqual(er.required_flags, ["--campaign", "--round", "--db"]);

    const derived = deriveScriptedHoldSchedule();
    assert.deepEqual(ev.derived_hold_schedule, derived, "the retained derived hold schedule is a fresh recompute");
    assert.deepEqual(primaryState.plan?.roundBPhases, derived.round_b.phases, "the fix9 primary state.plan.roundBPhases equal the derived phases");

    for (const [flag, value] of Object.entries(ev.safety)) {
      assert.equal(value, false, `fix9 safety flag ${flag} must be false`);
    }

    // ── published fix9 readiness (validated only when it exists) ─────────
    if (!fs.existsSync(FIX9_READINESS_PATH)) return;
    const rd = loadJson(FIX9_READINESS_PATH);
    assert.equal(rd.kind, "storm-rehearsal-fix9-readiness");
    assert.equal(rd.branch, FIX9_BRANCH);
    assert.equal(rd.source.commit, head, "readiness source.commit == HEAD");
    assert.equal(rd.source.tree, tree, "readiness source.tree == HEAD^{tree}");
    assert.equal(rd.source.tree_dirty, false, "readiness published on a clean tree");
    assert.equal(rd.campaign.id, c.id, "readiness locates the primary campaign");
    assert.equal(rd.campaign.dir, c.dir, "readiness campaign dir == pointer campaign dir");
    assert.equal(rd.pending_candidate.id, p.id, "readiness locates the pending candidate");
    assert.equal(rd.pending_candidate.dir, p.dir, "readiness pending dir == pointer pending dir");

    // gate hashes are the COMPLETE recompute from the engine on disk.
    const fresh = computeGateHashes();
    assert.equal(rd.gate_hash_files.length, Object.keys(fresh).length, "complete gate_hash_files");
    assert.equal(rd.gate_hashes_recompute_match, true, "readiness gate hashes recompute-match");
    for (const f of rd.gate_hash_files) assert.equal(rd.gate_hashes_sha256[f], fresh[f], `gate hash ${f} matches a fresh recompute`);

    assert.deepEqual(rd.derived_hold_schedule.hold_schedule, derived, "readiness hold schedule is a fresh recompute");

    const rdCmds = rd.exact_rehearse.full_commands;
    assert.equal(rdCmds.length, 2, "readiness names exactly two rehearse invocations");
    for (const [idx, round] of ["A", "B"].entries()) {
      assert.ok(rdCmds[idx].includes(`--campaign ${c.dir}`), `readiness round ${round} names --campaign`);
      assert.ok(rdCmds[idx].includes(`--round ${round}`), `readiness round ${round} names --round`);
      assert.ok(rdCmds[idx].includes(`--db ${c.db_path}`), `readiness round ${round} names --db`);
      assert.ok(!/approval/i.test(rdCmds[idx]), `readiness round ${round} names NO approval path`);
    }
    assert.equal(rd.exact_rehearse.approval_path_present_in_commands, false);

    // every self-test in the readiness ran alone, under flock, exit 0, fail 0.
    assert.ok(Array.isArray(rd.self_tests) && rd.self_tests.length > 0, "readiness carries per-file self-test logs");
    assert.equal(rd.self_tests_summary.all_exit_zero, true, "every readiness self-test exited 0");
    assert.equal(rd.self_tests_summary.zero_fail, true, "every readiness self-test had 0 failures");
    for (const t of rd.self_tests) {
      assert.equal(t.exit, 0, `${t.file} exited 0`);
      assert.equal(t.fail, 0, `${t.file} had 0 failures`);
      assert.equal(t.under_flock, true, `${t.file} ran under the shared gate lock`);
    }
    assert.ok(rd.self_tests.some((t: any) => t.file === FIX9_NEW_SELF_TEST), "the fix9 new self-test is in the chain");
    assert.ok(rd.test_cmd_extended.includes(FIX9_NEW_SELF_TEST), "test_cmd_extended covers the fix9 new self-test");
    assert.equal((rd.test_cmd_extended.match(/node --test/g) || []).length, rd.self_tests.length, "test_cmd_extended has one node --test per recorded file");
    assert.match(rd.test_cmd_extended, /TAMANDUA_TEST_GUARD=1/);
    assert.match(rd.test_cmd_extended, /TAMANDUA_PI_BINARY=\/usr\/bin\/false/);
    assert.match(rd.test_cmd_extended, /TAMANDUA_DSH_BINARY=\/usr\/bin\/false/);
    assert.match(rd.test_cmd_extended, /TAMANDUA_HERMES_BINARY=\/usr\/bin\/false/);

    // the published readiness was independently validated and never names an approval path.
    assert.equal(rd.readiness_validation.passed, true, "readiness validation passed");
    assert.deepEqual(rd.readiness_validation.failed_checks ?? [], [], "no failed readiness checks");
    // Every boolean safety flag is a "must NOT have happened" flag EXCEPT
    // all_diagnostics_retained, which must be true.
    assert.equal(rd.safety.all_diagnostics_retained, true, "readiness retained all diagnostics");
    for (const [flag, value] of Object.entries(rd.safety)) {
      if (typeof value !== "boolean" || flag === "all_diagnostics_retained") continue;
      assert.equal(value, false, `readiness safety flag ${flag} must be false`);
    }
  });
});
