// Tier-2 STORM-REAL US-003 profile-bound coordinator approval gate.
//
// Proves an approval issued for one campaign profile can never authorize the
// other profile, at the pure validator AND at every real launching route
// (approve/rehearse/run). The routes exercised here refuse BEFORE any daemon
// is materialized, so NO daemon/harness/chaos/model is ever started; the only
// child processes are the tt-storm CLI itself and its read-only git
// provenance probe. Synthetic campaigns are built under a fresh scratch var
// root (TT_VAR) with a real private exec-identity receipt so `requireContained`
// is genuinely satisfied and the refusal truly comes from the profile-bound
// approval validator.
//
// NOT part of any default fast lane: run with `node --test`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  buildPrivateExecContext,
  persistableExecIdentity,
  verifyCoordinatorApproval,
} from "../bin/tt-storm-real.mjs";
import {
  REAL,
  SCRIPTED_REHEARSAL,
  profileFromCampaignState,
} from "../bin/tt-storm-profile.mjs";
import { computeGateHashes } from "../bin/tt-storm-rehearsal.mjs";

const repoRoot = process.cwd();
const TT_STORM_CLI = path.join(repoRoot, "torture-test", "bin", "tt-storm");
const TAMANDUA_BIN = path.join(repoRoot, "bin", "tamandua");

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tt-storm-profile-approval-"));
const varRoot = path.join(workRoot, "var");
const approvalsDir = path.join(workRoot, "approvals");
fs.mkdirSync(varRoot, { recursive: true });
fs.mkdirSync(approvalsDir, { recursive: true });

function currentHead(): string {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  return String(r.stdout ?? "").trim();
}
const HEAD = currentHead();

let seq = 0;
// A minimal, genuinely contained prepared campaign for one profile: a real
// private exec-identity receipt (so requireContained passes) + a persisted
// profile. No daemon state is needed because every negative here refuses at
// the approval validator first.
function makeCampaign(profile: string): { id: string; campaignDir: string; statePath: string } {
  const id = `storm-profile-${profile.toLowerCase()}-${process.pid}-${++seq}`;
  const campaignDir = path.join(varRoot, "results", id);
  fs.mkdirSync(campaignDir, { recursive: true });
  const execCtx = buildPrivateExecContext({ varRoot, binaries: { tamandua: TAMANDUA_BIN } });
  const state = {
    schema_version: 1,
    campaign_id: id,
    created_at: "2026-09-23T00:00:00.000Z",
    updated_at: "2026-09-23T00:00:00.000Z",
    mode: "prepared",
    qualification: { real_launch_allowed: false, note: "not-yet-qualified" },
    exec_identity: persistableExecIdentity(execCtx),
    // STORM-REAL US-006: a REAL campaign carries the required persisted hard
    // spend cap; the launching `run` route re-supplies it and requires an exact
    // match, so the profile-binding negative controls must clear that check
    // before the approval check they target.
    rehearsal: profile === REAL ? { profile, spend_cap: { tokens: 1000, scope: "total" } } : { profile },
    rounds: { A: { status: "planned", runs: {} }, B: { status: "planned", runs: {} } },
    plan: { launches: [], roundBPhases: [] },
  };
  const statePath = path.join(campaignDir, "state.json");
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  fs.writeFileSync(path.join(campaignDir, "ops.jsonl"), "");
  fs.writeFileSync(path.join(campaignDir, "intent.jsonl"), "");
  return { id, campaignDir, statePath };
}

function writeApproval(name: string, body: Record<string, any>): string {
  const file = path.join(approvalsDir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + "\n");
  return file;
}

// A fully valid approval except for the profile: `profile === null` omits the
// field entirely (the missing-profile case).
function baseApproval(campaignId: string, profile: string | null): Record<string, any> {
  const approval: Record<string, any> = {
    real_launch_allowed: true,
    campaign_id: campaignId,
    source_commit: HEAD,
    approval_kind: "SCRIPTED_REHEARSAL",
    gate_hashes: computeGateHashes(),
  };
  if (profile !== null) approval.profile = profile;
  return approval;
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [TT_STORM_CLI, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, TT_VAR: varRoot, TAMANDUA_TEST_GUARD: "1" },
  });
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
}

function readState(statePath: string): any {
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

after(() => {
  // Synthetic negative fixture created by THIS test only.
  fs.rmSync(workRoot, { recursive: true, force: true });
});

describe("STORM-REAL US-003 profile-bound coordinator approval", () => {
  it("profileFromCampaignState reads the persisted campaign profile and never fabricates one", () => {
    assert.equal(profileFromCampaignState({ rehearsal: { profile: REAL } }), REAL);
    assert.equal(profileFromCampaignState({ rehearsal: { profile: SCRIPTED_REHEARSAL } }), SCRIPTED_REHEARSAL);
    assert.equal(profileFromCampaignState({}), null);
    assert.equal(profileFromCampaignState({ rehearsal: {} }), null);
    assert.equal(profileFromCampaignState({ rehearsal: { profile: "   " } }), null);
    assert.equal(profileFromCampaignState({ rehearsal: { profile: 7 } }), null);
    assert.equal(profileFromCampaignState(null), null);
    assert.equal(profileFromCampaignState("not-a-state"), null);
  });

  it("verifyCoordinatorApproval refuses a missing or mismatched approval profile and accepts a matching one", () => {
    const gateHashes = { "torture-test/bin/tt-storm-real.mjs": "a".repeat(64) };
    const base = {
      real_launch_allowed: true,
      campaign_id: "storm-x",
      source_commit: "abc",
      approval_kind: "SCRIPTED_REHEARSAL",
      gate_hashes: gateHashes,
    };
    const wrong = verifyCoordinatorApproval({
      approval: { ...base, profile: REAL },
      campaignId: "storm-x",
      sourceCommit: "abc",
      gateHashes,
      expectedProfile: SCRIPTED_REHEARSAL,
    });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.code, "TT_REHEARSAL_NOT_APPROVED");
    assert.match(wrong.reason, /does not match expected/);

    const missing = verifyCoordinatorApproval({
      approval: base,
      campaignId: "storm-x",
      sourceCommit: "abc",
      gateHashes,
      expectedProfile: SCRIPTED_REHEARSAL,
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "TT_REHEARSAL_NOT_APPROVED");
    assert.match(missing.reason, /carries no profile/);

    const match = verifyCoordinatorApproval({
      approval: { ...base, profile: SCRIPTED_REHEARSAL },
      campaignId: "storm-x",
      sourceCommit: "abc",
      gateHashes,
      expectedProfile: SCRIPTED_REHEARSAL,
    });
    assert.equal(match.ok, true);

    // No expectedProfile keeps the legacy (unbound) validator behaviour so
    // non-rehearsal callers are unaffected.
    assert.equal(verifyCoordinatorApproval({ approval: base, campaignId: "storm-x", sourceCommit: "abc", gateHashes }).ok, true);
  });

  it("approve refuses the wrong profile in both directions and leaves the campaign unqualified", () => {
    const scriptedCamp = makeCampaign(SCRIPTED_REHEARSAL);
    const realApproval = writeApproval("approve-scripted-campaign-real-approval", baseApproval(scriptedCamp.id, REAL));
    const r1 = runCli(["approve", "--campaign", scriptedCamp.campaignDir, "--approval-file", realApproval]);
    assert.equal(r1.status, 3, `approve must refuse a REAL approval for a SCRIPTED_REHEARSAL campaign:\n${r1.stderr}`);
    assert.match(r1.stderr, /TT_REHEARSAL_NOT_APPROVED/);
    assert.match(r1.stderr, /does not match expected/);
    assert.equal(readState(scriptedCamp.statePath).qualification.real_launch_allowed, false, "campaign stays unqualified");

    const realCamp = makeCampaign(REAL);
    const scriptedApproval = writeApproval("approve-real-campaign-scripted-approval", baseApproval(realCamp.id, SCRIPTED_REHEARSAL));
    const r2 = runCli(["approve", "--campaign", realCamp.campaignDir, "--approval-file", scriptedApproval]);
    assert.equal(r2.status, 3, `approve must refuse a SCRIPTED_REHEARSAL approval for a REAL campaign:\n${r2.stderr}`);
    assert.match(r2.stderr, /TT_REHEARSAL_NOT_APPROVED/);
    assert.match(r2.stderr, /does not match expected/);
    assert.equal(readState(realCamp.statePath).qualification.real_launch_allowed, false, "campaign stays unqualified");
  });

  it("approve refuses an approval with no profile field and leaves the campaign unqualified", () => {
    const camp = makeCampaign(SCRIPTED_REHEARSAL);
    const noProfile = writeApproval("approve-missing-profile", baseApproval(camp.id, null));
    const r = runCli(["approve", "--campaign", camp.campaignDir, "--approval-file", noProfile]);
    assert.equal(r.status, 3, `approve must refuse an approval carrying no profile:\n${r.stderr}`);
    assert.match(r.stderr, /TT_REHEARSAL_NOT_APPROVED/);
    assert.match(r.stderr, /carries no profile/);
    assert.equal(readState(camp.statePath).qualification.real_launch_allowed, false, "campaign stays unqualified");
  });

  it("approve with a matching profile still qualifies the campaign, derived from persisted state (not a CLI flag)", () => {
    const camp = makeCampaign(SCRIPTED_REHEARSAL);
    const approval = writeApproval("approve-matching-profile", baseApproval(camp.id, SCRIPTED_REHEARSAL));
    // A deliberately WRONG --profile flag is ignored: approve must bind the
    // approval to the PERSISTED profile (SCRIPTED_REHEARSAL) and succeed.
    const r = runCli(["approve", "--campaign", camp.campaignDir, "--approval-file", approval, "--profile", REAL]);
    assert.equal(r.status, 0, `approve with a matching profile must succeed:\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    const after = readState(camp.statePath);
    assert.equal(after.qualification.real_launch_allowed, true);
    assert.equal(after.qualification.profile, SCRIPTED_REHEARSAL, "qualification records the persisted campaign profile");
    assert.equal(after.qualification.approval_file, approval);
  });

  it("rehearse refuses a wrong/missing profile approval before any daemon is materialized", () => {
    const camp = makeCampaign(SCRIPTED_REHEARSAL);
    const wrong = writeApproval("rehearse-wrong-profile", baseApproval(camp.id, REAL));
    const r1 = runCli(["rehearse", "--campaign", camp.campaignDir, "--round", "A", "--approval-file", wrong]);
    assert.equal(r1.status, 3, `rehearse must refuse a wrong-profile approval:\n${r1.stderr}`);
    assert.match(r1.stderr, /TT_REHEARSAL_NOT_APPROVED/);
    assert.match(r1.stderr, /does not match expected/);

    const missing = writeApproval("rehearse-missing-profile", baseApproval(camp.id, null));
    const r2 = runCli(["rehearse", "--campaign", camp.campaignDir, "--round", "A", "--approval-file", missing]);
    assert.equal(r2.status, 3, `rehearse must refuse a profile-less approval:\n${r2.stderr}`);
    assert.match(r2.stderr, /carries no profile/);

    assert.equal(readState(camp.statePath).qualification.real_launch_allowed, false, "campaign stays unqualified after refused rehearsals");
  });

  it("run re-derives expectedProfile from persisted state and refuses a wrong/missing profile approval", () => {
    const camp = makeCampaign(REAL);
    const wrong = writeApproval("run-wrong-profile", baseApproval(camp.id, SCRIPTED_REHEARSAL));
    const state = readState(camp.statePath);
    state.qualification = { real_launch_allowed: true, approval_file: wrong, source_commit: HEAD };
    fs.writeFileSync(camp.statePath, JSON.stringify(state, null, 2) + "\n");
    const r1 = runCli(["run", "--campaign", camp.campaignDir, "--round", "A", "--spend-cap-tokens", "1000"]);
    assert.equal(r1.status, 3, `run must refuse a wrong-profile approval:\n${r1.stderr}`);
    assert.match(r1.stderr, /TT_REHEARSAL_NOT_APPROVED/);
    assert.match(r1.stderr, /does not match expected/);

    const missing = writeApproval("run-missing-profile", baseApproval(camp.id, null));
    const state2 = readState(camp.statePath);
    state2.qualification.approval_file = missing;
    fs.writeFileSync(camp.statePath, JSON.stringify(state2, null, 2) + "\n");
    const r2 = runCli(["run", "--campaign", camp.campaignDir, "--round", "A", "--spend-cap-tokens", "1000"]);
    assert.equal(r2.status, 3, `run must refuse a profile-less approval:\n${r2.stderr}`);
    assert.match(r2.stderr, /carries no profile/);
  });
});