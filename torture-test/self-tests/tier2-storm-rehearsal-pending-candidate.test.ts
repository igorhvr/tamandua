// Tier-2 STORM-REHEARSAL FIX-4 US-010 — SF-9 designated pending candidate.
//
// SF-9: tier2-storm-rehearsal-consistency asserts a genuinely prepared,
// never-executed storm-* campaign remains under var/results. Executing the
// ONLY prepared campaign makes that assertion unsatisfiable. The fix keeps a
// DESIGNATED PENDING CANDIDATE alongside the executed primary:
//
//   tt-storm prepare --pending-candidate <dir>
//
// prepares a SECOND, fully-prepared SCRIPTED_REHEARSAL campaign (fresh private
// exec identity + product-schema DB, the same fixture/profile/catalog) that is
// NEVER executed, and records state.pending_candidate = {campaign_id, dir} in
// the PRIMARY campaign state.json + descriptor.json. The candidate dir must be
// contained under the owned var root and must not already exist or live inside
// the primary campaign dir (TT_EXISTS, never overwrite). The consistency gate
// then validates the DESIGNATED candidate as truthful pending, preferring
// state.pending_candidate, then the readiness-named candidate, then any
// pending storm-* campaign — while still refusing a fabricated or completed
// candidate (the readiness file is only a locator, never a substitute for a
// genuine on-disk prepared campaign).
//
// This file is self-contained: in-process unit coverage of the engine helpers
// + the exported consistency locator/validator, plus ONE real contained CLI
// prepare (TT_VAR scratch) proving the end-to-end recording + the TT_EXISTS
// refusal leaves a pre-existing candidate dir byte-identical. No daemon,
// harness, model, or chaos process is ever started.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { assertPendingCandidateDest, recordPendingCandidate } from "../bin/tt-storm-engine.mjs";
import {
  computeGateHashes,
  DEFAULT_COORDINATOR_APPROVAL_FILE,
  DESCRIPTOR_NAME,
  REHEARSAL_LABEL,
  REHEARSAL_PROFILE,
} from "../bin/tt-storm-rehearsal.mjs";
import { REAL_FS } from "../bin/tt-storm-roster.mjs";
import { STORM_REPORT_JSON, STORM_RESULTS_DIR } from "../bin/tt-storm-shared.mjs";
import {
  discoverPendingCandidateDirs,
  validateDesignatedPendingCandidate,
  validatePendingCampaign,
} from "./tier2-storm-rehearsal-consistency.test.ts";

const repoRoot = process.cwd();
const TT_STORM_CLI = path.join(repoRoot, "torture-test", "bin", "tt-storm");

function ownedScratch(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tt-reh-pending-${label}-`));
}

function gitHead(repo: string): string {
  const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
  return res.status === 0 ? String(res.stdout ?? "").trim() : "";
}

function cliEnv(scratchVar: string): Record<string, string> {
  const env: Record<string, string> = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return { ...env, TT_VAR: scratchVar };
}

function runCliPrepare(scratchVar: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [TT_STORM_CLI, "prepare", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 600_000,
    env: cliEnv(scratchVar),
  });
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
}

// Synthetic truthful-pending campaign state/descriptor (mirrors the shapes the
// real prepare writes; gate hashes are recomputed so coherence holds).
function syntheticDescriptor(campaignId: string): any {
  return {
    kind: "tt-storm-rehearsal-descriptor",
    profile: REHEARSAL_PROFILE,
    label: REHEARSAL_LABEL,
    campaign: { id: campaignId },
    source: { commit: "c".repeat(40), tree: "t".repeat(40), tree_dirty: false },
    gate_hashes: computeGateHashes(),
    authorized_rehearse: { approval_file: DEFAULT_COORDINATOR_APPROVAL_FILE },
  };
}

function syntheticPendingState(campaignId: string): any {
  return {
    campaign_id: campaignId,
    mode: "prepared",
    qualification: { real_launch_allowed: false, note: "not-yet-qualified" },
    source: { commit: "c".repeat(40), tree: "t".repeat(40), tree_dirty: false },
    gate_hashes: computeGateHashes(),
    rounds: {
      A: { status: "planned", runs: {}, phases: {} },
      B: { status: "planned", runs: {}, phases: {} },
    },
    report: null,
    daemon: null,
    cleanup: { ledger: [] },
    rehearsal: {
      scripted_runtime: {
        behaviors_file: path.join("/tmp", "tt-pending-scripted", campaignId, "behaviors.json"),
        behaviors_sha256: "a".repeat(64),
        state_dir: path.join("/tmp", "tt-pending-scripted-state", campaignId),
        agents: 3,
        agent_keys: ["a", "b", "c"],
        workflows: ["feature-dev-merge"],
      },
    },
  };
}

function writeCampaign(dir: string, state: any, descriptor: any): void {
  fs.mkdirSync(path.join(dir, STORM_RESULTS_DIR), { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, DESCRIPTOR_NAME), JSON.stringify(descriptor, null, 2) + "\n");
}

describe("STORM-REHEARSAL US-010 (SF-9) designated pending candidate", () => {
  it("P1: assertPendingCandidateDest — fresh contained dest accepted; existing/inside-primary refused TT_EXISTS; outside var refused", () => {
    const scratch = ownedScratch("dest");
    try {
      const varRoot = path.join(scratch, "var");
      fs.mkdirSync(varRoot, { recursive: true });
      const primary = path.join(varRoot, "results", "storm-primary");
      fs.mkdirSync(primary, { recursive: true });

      const fresh = path.join(varRoot, "results", "storm-candidate");
      assert.equal(assertPendingCandidateDest(primary, fresh, { varRoot, fs: REAL_FS }), fresh, "a fresh contained destination is accepted");

      fs.mkdirSync(fresh, { recursive: true });
      assert.throws(
        () => assertPendingCandidateDest(primary, fresh, { varRoot, fs: REAL_FS }),
        (e: any) => e.code === "TT_EXISTS",
        "an existing candidate dir is refused TT_EXISTS (no overwrite)",
      );

      const inside = path.join(primary, "nested-candidate");
      assert.throws(
        () => assertPendingCandidateDest(primary, inside, { varRoot, fs: REAL_FS }),
        (e: any) => e.code === "TT_EXISTS",
        "a candidate inside the primary campaign dir is refused TT_EXISTS",
      );

      assert.throws(
        () => assertPendingCandidateDest(primary, path.join(scratch, "outside-var"), { varRoot, fs: REAL_FS }),
        (e: any) => e.code === "TT_ESCAPE",
        "a destination outside the owned var root is refused",
      );
      assert.throws(
        () => assertPendingCandidateDest(primary, "", { varRoot, fs: REAL_FS }),
        (e: any) => e.code === "TT_USAGE",
        "a missing destination is a usage refusal",
      );
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("P2: recordPendingCandidate records state.pending_candidate + descriptor.pending_candidate + an ops line", () => {
    const scratch = ownedScratch("record");
    try {
      const campaignDir = path.join(scratch, "primary");
      writeCampaign(campaignDir, syntheticPendingState("storm-primary"), syntheticDescriptor("storm-primary"));
      fs.writeFileSync(path.join(campaignDir, "ops.jsonl"), "");
      const state = JSON.parse(fs.readFileSync(path.join(campaignDir, "state.json"), "utf8"));
      const ctx: any = { fs: REAL_FS, clock: { nowUtc: () => "2026-09-12T00:00:00Z" } };
      const candidateDir = path.join(scratch, "candidate");
      const rec = recordPendingCandidate({
        ctx,
        campaignDir,
        state,
        descriptorName: DESCRIPTOR_NAME,
        candidate: { campaign_id: "storm-candidate", dir: candidateDir },
      });
      assert.equal(rec.campaign_id, "storm-candidate");
      assert.equal(rec.dir, candidateDir);
      assert.equal(rec.recorded_at, "2026-09-12T00:00:00Z");

      const persisted = JSON.parse(fs.readFileSync(path.join(campaignDir, "state.json"), "utf8"));
      assert.deepEqual(persisted.pending_candidate, { campaign_id: "storm-candidate", dir: candidateDir, recorded_at: "2026-09-12T00:00:00Z" });
      const descriptor = JSON.parse(fs.readFileSync(path.join(campaignDir, DESCRIPTOR_NAME), "utf8"));
      assert.deepEqual(descriptor.pending_candidate, { campaign_id: "storm-candidate", dir: candidateDir, recorded_at: "2026-09-12T00:00:00Z" });
      const ops = fs
        .readFileSync(path.join(campaignDir, "ops.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      assert.ok(ops.some((o) => o.kind === "rehearsal.pending_candidate" && o.campaign_id === "storm-candidate" && o.dir === candidateDir), JSON.stringify(ops));
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("P3: validateDesignatedPendingCandidate accepts a truthful designated candidate (state.pending_candidate locates it)", () => {
    const scratch = ownedScratch("truthful");
    try {
      const resultsRoot = path.join(scratch, "results");
      fs.mkdirSync(resultsRoot, { recursive: true });
      const primaryDir = path.join(resultsRoot, "storm-primary");
      const candidateDir = path.join(scratch, "candidate", "storm-candidate");
      writeCampaign(candidateDir, syntheticPendingState("storm-candidate"), syntheticDescriptor("storm-candidate"));
      const primaryState = syntheticPendingState("storm-primary");
      primaryState.pending_candidate = { campaign_id: "storm-candidate", dir: candidateDir };
      writeCampaign(primaryDir, primaryState, syntheticDescriptor("storm-primary"));

      const located = discoverPendingCandidateDirs({ resultsRoot, readinessFile: path.join(scratch, "absent-readiness.json") });
      assert.ok(
        located.some((c) => c.dir === candidateDir && c.source.startsWith("state.pending_candidate")),
        `the designated candidate is located from state.pending_candidate: ${JSON.stringify(located)}`,
      );

      const res = validateDesignatedPendingCandidate({
        resultsRoot,
        readinessFile: path.join(scratch, "absent-readiness.json"),
        currentSourceCommit: "c".repeat(40),
        approvalFile: path.join(scratch, "absent-approval.json"),
      });
      assert.equal(res.ok, true, `truthful designated candidate accepted: ${JSON.stringify(res.issues)}`);
      assert.equal(res.validated, 1);
      assert.equal(res.selected, candidateDir);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("P3b: validateDesignatedPendingCandidate REFUSES a fabricated (missing) designated candidate with no pending fallback", () => {
    const scratch = ownedScratch("fabricated");
    try {
      const resultsRoot = path.join(scratch, "results");
      fs.mkdirSync(resultsRoot, { recursive: true });
      const primaryDir = path.join(resultsRoot, "storm-primary");
      // The primary itself is EXECUTED (report.json present) so it is not a
      // pending fallback; its designated candidate points at a ghost dir.
      const primaryState = syntheticPendingState("storm-primary");
      primaryState.mode = "executed";
      primaryState.pending_candidate = { campaign_id: "storm-ghost", dir: path.join(scratch, "ghost") };
      writeCampaign(primaryDir, primaryState, syntheticDescriptor("storm-primary"));
      fs.writeFileSync(path.join(primaryDir, STORM_RESULTS_DIR, STORM_REPORT_JSON), "{}\n");
      const res = validateDesignatedPendingCandidate({
        resultsRoot,
        readinessFile: path.join(scratch, "absent-readiness.json"),
        currentSourceCommit: "c".repeat(40),
        approvalFile: path.join(scratch, "absent-approval.json"),
      });
      assert.equal(res.ok, false, "a fabricated designated candidate is refused");
      assert.ok(res.issues.some((i) => i.includes("missing on disk")), `refusal names the missing candidate: ${JSON.stringify(res.issues)}`);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("P3c: validateDesignatedPendingCandidate REFUSES a designated candidate that is already COMPLETED", () => {
    const scratch = ownedScratch("completed");
    try {
      const resultsRoot = path.join(scratch, "results");
      fs.mkdirSync(resultsRoot, { recursive: true });
      const primaryDir = path.join(resultsRoot, "storm-primary");
      const candidateDir = path.join(scratch, "candidate", "storm-candidate");
      const candState = syntheticPendingState("storm-candidate");
      candState.mode = "executed";
      candState.report = { campaign_id: "storm-candidate" };
      candState.rounds.A.runs = { S1: { runId: "run-1" } };
      writeCampaign(candidateDir, candState, syntheticDescriptor("storm-candidate"));
      fs.writeFileSync(path.join(candidateDir, STORM_RESULTS_DIR, STORM_REPORT_JSON), "{}\n");
      const primaryState = syntheticPendingState("storm-primary");
      primaryState.pending_candidate = { campaign_id: "storm-candidate", dir: candidateDir };
      writeCampaign(primaryDir, primaryState, syntheticDescriptor("storm-primary"));

      const res = validateDesignatedPendingCandidate({
        resultsRoot,
        readinessFile: path.join(scratch, "absent-readiness.json"),
        currentSourceCommit: "c".repeat(40),
        approvalFile: path.join(scratch, "absent-approval.json"),
      });
      assert.equal(res.ok, false, "a completed designated candidate is refused as NOT truthful pending");
      assert.equal(res.selected, candidateDir);
      assert.ok(res.issues.some((i) => i.includes("expected \"prepared\"")), `refusal names the non-pending mode: ${JSON.stringify(res.issues)}`);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("P4: REAL tt-storm prepare --pending-candidate records a truthful designated candidate with a fresh DB; a pre-existing candidate dir is refused TT_EXISTS and left byte-identical", () => {
    const scratch = ownedScratch("cli");
    try {
      const candidateDir = path.join(scratch, "results", "storm-designated-candidate");
      const first = runCliPrepare(scratch, ["--pending-candidate", candidateDir]);
      assert.equal(first.status, 0, `CLI prepare exit 0:\nstdout=${first.stdout}\nstderr=${first.stderr}`);

      const pm = /Campaign dir: (\S+)/.exec(first.stdout);
      assert.ok(pm, `prepare prints the primary campaign dir: ${first.stdout}`);
      const primaryDir = pm![1];
      const cm = /Pending candidate: (\S+) at (\S+)/.exec(first.stdout);
      assert.ok(cm, `prepare prints the pending candidate identity: ${first.stdout}`);
      assert.equal(cm![2], candidateDir, "the printed candidate dir is the requested one");

      const primaryState = JSON.parse(fs.readFileSync(path.join(primaryDir, "state.json"), "utf8"));
      assert.deepEqual(
        { campaign_id: primaryState.pending_candidate?.campaign_id, dir: primaryState.pending_candidate?.dir },
        { campaign_id: cm![1], dir: candidateDir },
        "the primary state records the designated pending candidate",
      );
      const primaryDesc = JSON.parse(fs.readFileSync(path.join(primaryDir, DESCRIPTOR_NAME), "utf8"));
      assert.deepEqual(primaryDesc.pending_candidate, primaryState.pending_candidate, "the primary descriptor mirrors the designation");

      // The candidate is a genuine, truthful-prepared, unexecuted campaign.
      const candState = JSON.parse(fs.readFileSync(path.join(candidateDir, "state.json"), "utf8"));
      const candDesc = JSON.parse(fs.readFileSync(path.join(candidateDir, DESCRIPTOR_NAME), "utf8"));
      assert.equal(candState.campaign_id, cm![1]);
      assert.equal(candState.mode, "prepared");
      assert.equal(candState.qualification?.real_launch_allowed, false);
      assert.equal(candState.report, null);
      assert.equal(Object.keys(candState.rounds?.A?.runs ?? {}).length, 0);
      assert.deepEqual(fs.readdirSync(path.join(candidateDir, STORM_RESULTS_DIR)), [], "candidate results dir stays empty");
      const v = validatePendingCampaign({
        campaignDir: candidateDir,
        state: candState,
        descriptor: candDesc,
        currentSourceCommit: gitHead(repoRoot),
        approvalFile: DEFAULT_COORDINATOR_APPROVAL_FILE,
      });
      assert.equal(v.ok, true, `candidate is truthful pending: ${JSON.stringify(v.issues)}`);

      // Fresh private exec identity + product DB, distinct from the primary.
      assert.ok(candState.exec_identity?.db_path && fs.existsSync(candState.exec_identity.db_path), "candidate product-schema DB exists");
      assert.notEqual(candState.exec_identity.db_path, primaryState.exec_identity?.db_path, "candidate DB is fresh (not the primary's)");
      assert.notEqual(candState.exec_identity.state_root, primaryState.exec_identity?.state_root, "candidate private state root is distinct");
      assert.ok(candState.exec_identity.db_path.startsWith(scratch + path.sep), "candidate DB stays under the owned var root");

      // Discovery locates it from the primary's state.pending_candidate.
      const located = discoverPendingCandidateDirs({ resultsRoot: path.join(scratch, "results"), readinessFile: path.join(scratch, "absent-readiness.json") });
      assert.ok(
        located.some((c) => c.dir === candidateDir && c.source.startsWith("state.pending_candidate")),
        `the designated candidate is locatable: ${JSON.stringify(located)}`,
      );

      // A pre-existing candidate dir is refused TT_EXISTS and left byte-identical.
      const sentinel = path.join(candidateDir, "sentinel.txt");
      fs.writeFileSync(sentinel, "keep-me\n");
      const before = fs.readFileSync(sentinel, "utf8");
      const refusalDb = path.join(scratch, "refusal-db", "tamandua.db");
      const second = runCliPrepare(scratch, ["--pending-candidate", candidateDir, "--db", refusalDb]);
      assert.notEqual(second.status, 0, "a pre-existing candidate dir must refuse");
      assert.match(second.stderr, /already exists|TT_EXISTS/, `refusal names the existing candidate dir: ${second.stderr}`);
      assert.equal(fs.readFileSync(sentinel, "utf8"), before, "the pre-existing candidate dir is left byte-identical");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
