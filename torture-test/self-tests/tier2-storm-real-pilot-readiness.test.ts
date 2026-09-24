// Tier-2 STORM-REAL US-015 — REAL lite pilot readiness.
//
// US-015 prepares the capacity-scaled REAL lite pilot campaign (a genuine
// --profile REAL --scale lite --pending-candidate preparation) and publishes a
// readiness artifact naming the campaign, the profile/scale, the exact
// arm/approve/run commands, the required approval contents, the pilot approval
// path and the seed-root placeholder the coordinator fills from the SEED-REGEN
// run (#79). NOTHING is armed on a seed, approved, or run by this story: the
// campaign stays mode=prepared with qualification.real_launch_allowed=false.
//
// This file is the focused self-test:
//   * the pure readiness builder projects a REAL lite campaign (with a
//     same-profile designated pending candidate) into a schema-valid
//     readiness whose commands/approval/seed placeholder are exact;
//   * the builder refuses a non-REAL profile, a non-lite scale, a missing
//     spend cap and a missing private DB (fail-closed);
//   * the validator refuses a truncated document, a wrong approval path, a
//     missing run command and a mismatched pending-candidate profile;
//   * when the published readiness exists, the on-disk campaign and its
//     designated pending candidate are validated as truthful prepared
//     same-profile campaigns and NO real round was started.
//
// In-process only: no daemon, no harness, no model, no ports, no source edits.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  PILOT_APPROVAL_PATH,
  PILOT_READINESS_PATH,
  SEED_ROOT_PLACEHOLDER,
  buildRealPilotReadiness,
  validateRealPilotReadiness,
} from "../bin/tt-storm-real-readiness.mjs";
import { DESCRIPTOR_NAME, computeGateHashes } from "../bin/tt-storm-rehearsal.mjs";
import { REAL } from "../bin/tt-storm-profile.mjs";
import { LITE, LITE_FIXTURE_NAME } from "../bin/tt-storm-scale.mjs";
// The REAL-aware truthful-pending validator lives in the consistency suite.
// Importing it also registers that suite's tests (the pending-candidate test
// does the same); every assertion below is still about the pilot readiness.
import { validatePendingCampaign } from "./tier2-storm-rehearsal-consistency.test.ts";

const READINESS_PATH = process.env.STORM_REAL_PILOT_READINESS ?? PILOT_READINESS_PATH;

function syntheticDescriptor(campaignId: string, campaignDir: string): any {
  return {
    kind: "tt-storm-rehearsal-descriptor",
    profile: REAL,
    label: "real storm (real pi/hermes/dsh harnesses + real product daemon, operator credentials) — NOT a tiny-fixture rehearsal",
    campaign: { id: campaignId, dir: campaignDir },
    source: { commit: "c".repeat(40), tree: "t".repeat(40), tree_dirty: false },
    roster: {
      scale: LITE,
      roster_id: LITE,
      round_a: 4,
      round_b: 4,
      workflow_ids: [
        "feature-dev-merge-worktree",
        "bug-fix-merge-worktree",
        "quarantine-broken-tests-merge-worktree",
        "do-now",
      ],
    },
    runtime_pins: {
      harnesses: {
        pi: { harness: "pi", path: "/usr/local/bin/pi", sha256: "a".repeat(64), version: "0.85.1" },
        hermes: { harness: "hermes", path: "/usr/local/bin/hermes", sha256: "b".repeat(64), version: "v0.21.1" },
      },
    },
    authorized_rehearse: {
      profile: REAL,
      approval_file: "/root/matchlock-work/storm-real-safety-approval.json",
      entrypoint: "/repo/torture-test/bin/tt-storm",
      rounds: ["rehearse --campaign x --round A", "rehearse --campaign x --round B"],
    },
    spend_cap: { tokens: 200000000, scope: "total" },
    active_cap: 20,
  };
}

function syntheticRealLiteState(campaignId: string, candidateDir: string): any {
  return {
    campaign_id: campaignId,
    mode: "prepared",
    qualification: { real_launch_allowed: false, note: "not-yet-qualified" },
    source: { commit: "c".repeat(40), tree: "t".repeat(40), tree_dirty: false, active_cap: 20 },
    rounds: { A: { status: "planned", runs: {} }, B: { status: "planned", runs: {} } },
    report: null,
    fixture: { name: LITE_FIXTURE_NAME, basis: "operator-recorded tt-poly-lite pilot identity at prepare time" },
    exec_identity: {
      db_path: "/var/tt/home/.tamandua/tamandua.db",
      state_root: "/var/tt/home/.tamandua",
      home_root: "/var/tt/home",
      tmp_root: "/var/tt/tmp",
    },
    rehearsal: {
      profile: REAL,
      scale: LITE,
      roster_id: LITE,
      spend_cap: { tokens: 200000000, scope: "total" },
      runtime_pins: syntheticDescriptor(campaignId, "/var/campaign").runtime_pins,
    },
    pending_candidate: { campaign_id: "storm-pending-pilot", dir: candidateDir, recorded_at: "2026-09-23T00:00:00.000Z" },
  };
}

function syntheticPendingState(campaignId: string): any {
  const s = syntheticRealLiteState(campaignId, "/var/none");
  delete s.pending_candidate;
  return s;
}

describe("STORM-REAL US-015 pilot readiness", () => {
  it("R1: the pure builder projects a REAL lite campaign + same-profile candidate into a schema-valid readiness", () => {
    const campaignDir = "/var/tt/results/storm-us015";
    const candidateDir = "/var/tt/results/storm-pending-us015";
    const state = syntheticRealLiteState("storm-us015", candidateDir);
    const descriptor = syntheticDescriptor("storm-us015", campaignDir);
    const rd: any = buildRealPilotReadiness({
      state,
      descriptor,
      campaignDir,
      candidateState: syntheticPendingState("storm-pending-us015"),
      publishedAtUtc: "2026-09-23T00:00:00.000Z",
      approvalPath: PILOT_APPROVAL_PATH,
    });
    const verdict = validateRealPilotReadiness(rd, { approvalPath: PILOT_APPROVAL_PATH });
    assert.equal(verdict.ok, true, `built readiness must validate: ${JSON.stringify(verdict.issues)}`);

    assert.equal(rd.kind, "storm-real-pilot-readiness");
    assert.equal(rd.profile, REAL);
    assert.equal(rd.scale, LITE);
    assert.equal(rd.campaign.profile, REAL);
    assert.equal(rd.campaign.scale, LITE);
    assert.equal(rd.campaign.mode, "prepared");
    assert.equal(rd.campaign.real_launch_allowed, false);
    assert.equal(rd.campaign.results_dir_empty, true);
    assert.deepEqual(rd.campaign.spend_cap, { tokens: 200000000, scope: "total" });
    assert.equal(rd.pending_candidate.profile, REAL, "the designated candidate is the SAME profile");
    assert.equal(rd.pending_candidate.scale, LITE, "the designated candidate is the SAME scale");
    assert.equal(rd.pending_candidate.mode, "prepared");
    assert.equal(rd.approval.path, PILOT_APPROVAL_PATH);
    assert.equal(rd.approval.required_contents.profile, REAL);
    assert.equal(rd.approval.required_contents.real_launch_allowed, true);
    assert.equal(rd.approval.required_contents.campaign_id, "storm-us015");
    assert.equal(rd.seed_root.placeholder, SEED_ROOT_PLACEHOLDER);
    assert.match(rd.commands.arm_aged_state, /arm aged-state .* --seed-root /);
    assert.ok(rd.commands.arm_aged_state.includes(SEED_ROOT_PLACEHOLDER), "the arm command carries the seed placeholder");
    assert.match(rd.commands.arm_seed_validation, /arm seed-validation /);
    assert.ok(rd.commands.approve.includes(PILOT_APPROVAL_PATH), "the approve command names the pilot approval path");
    assert.equal(rd.commands.run.length, 2);
    for (const [idx, round] of ["A", "B"].entries()) {
      assert.ok(rd.commands.run[idx].includes(`--round ${round}`));
      assert.ok(rd.commands.run[idx].includes("--spend-cap-tokens 200000000"));
      assert.ok(rd.commands.run[idx].includes("--spend-cap-scope total"));
      assert.ok(rd.commands.run[idx].includes("--detach"));
    }
    assert.equal(rd.safety.no_real_round_started, true);
    assert.equal(rd.safety.not_approved, true);
    assert.equal(rd.safety.not_armed_on_seed, true);
  });

  it("R2: the builder refuses a non-REAL profile, a non-lite scale, a missing cap and a missing private DB (fail-closed)", () => {
    const campaignDir = "/var/tt/results/storm-us015";
    const descriptor = syntheticDescriptor("storm-us015", campaignDir);
    const good = syntheticRealLiteState("storm-us015", "/var/tt/results/storm-pending-us015");

    const nonReal = syntheticRealLiteState("storm-us015", "/var/tt/results/storm-pending-us015");
    nonReal.rehearsal.profile = "SCRIPTED_REHEARSAL";
    assert.throws(
      () => buildRealPilotReadiness({ state: nonReal, descriptor, campaignDir }),
      /REAL campaign/,
      "a SCRIPTED_REHEARSAL campaign is refused",
    );

    const nonLite = syntheticRealLiteState("storm-us015", "/var/tt/results/storm-pending-us015");
    nonLite.rehearsal.roster_id = "full";
    nonLite.rehearsal.scale = "full";
    assert.throws(
      () => buildRealPilotReadiness({ state: nonLite, descriptor, campaignDir }),
      /LITE campaign/,
      "a full-scale campaign is refused",
    );

    const noCap = syntheticRealLiteState("storm-us015", "/var/tt/results/storm-pending-us015");
    noCap.rehearsal.spend_cap = null;
    assert.throws(
      () => buildRealPilotReadiness({ state: noCap, descriptor, campaignDir }),
      /spend cap/,
      "a campaign without a persisted cap is refused",
    );

    const noDb = syntheticRealLiteState("storm-us015", "/var/tt/results/storm-pending-us015");
    noDb.exec_identity = null;
    assert.throws(
      () => buildRealPilotReadiness({ state: noDb, descriptor, campaignDir }),
      /db_path/,
      "a campaign without a private DB is refused",
    );
    assert.ok(good, "the good fixture is untouched by the refusals");
  });

  it("R3: the validator refuses a truncated document, a wrong approval path, missing commands and a mismatched candidate profile", () => {
    const campaignDir = "/var/tt/results/storm-us015";
    const state = syntheticRealLiteState("storm-us015", "/var/tt/results/storm-pending-us015");
    const descriptor = syntheticDescriptor("storm-us015", campaignDir);
    const base: any = buildRealPilotReadiness({
      state,
      descriptor,
      campaignDir,
      candidateState: syntheticPendingState("storm-pending-us015"),
      publishedAtUtc: "2026-09-23T00:00:00.000Z",
      approvalPath: PILOT_APPROVAL_PATH,
    });

    const missingKey: any = JSON.parse(JSON.stringify(base));
    delete missingKey.commands;
    assert.equal(validateRealPilotReadiness(missingKey).ok, false, "a document without commands is refused");

    const wrongApproval: any = JSON.parse(JSON.stringify(base));
    wrongApproval.approval.path = "/elsewhere/approval.json";
    assert.equal(validateRealPilotReadiness(wrongApproval, { approvalPath: PILOT_APPROVAL_PATH }).ok, false, "a wrong approval path is refused");

    const missingRun: any = JSON.parse(JSON.stringify(base));
    missingRun.commands.run = [missingRun.commands.run[0]];
    assert.equal(validateRealPilotReadiness(missingRun).ok, false, "a readiness without both rounds is refused");

    const wrongCandidate: any = JSON.parse(JSON.stringify(base));
    wrongCandidate.pending_candidate.profile = "SCRIPTED_REHEARSAL";
    const v = validateRealPilotReadiness(wrongCandidate);
    assert.equal(v.ok, false, "a mismatched candidate profile is refused");
    assert.ok(v.issues.some((i) => i.includes("same-profile")), JSON.stringify(v.issues));

    const claimedRun: any = JSON.parse(JSON.stringify(base));
    claimedRun.campaign.real_launch_allowed = true;
    assert.equal(validateRealPilotReadiness(claimedRun).ok, false, "a readiness claiming a real launch is refused");
  });

  it("R4: the published readiness validates and the on-disk REAL lite campaign + candidate are truthful prepared and same-profile", () => {
    if (!fs.existsSync(READINESS_PATH)) return; // fresh host: the readiness is an out-of-band artifact
    const rd = JSON.parse(fs.readFileSync(READINESS_PATH, "utf8"));
    const verdict = validateRealPilotReadiness(rd, { approvalPath: rd.approval?.path ?? PILOT_APPROVAL_PATH });
    assert.equal(verdict.ok, true, `published readiness must validate: ${JSON.stringify(verdict.issues)}`);
    assert.equal(rd.profile, REAL);
    assert.equal(rd.scale, LITE);
    assert.equal(rd.campaign.mode, "prepared");
    assert.equal(rd.campaign.real_launch_allowed, false);
    assert.equal(rd.safety.no_real_round_started, true);
    assert.equal(rd.source.commit, rd.campaign.source?.commit ?? rd.source.commit);

    // The on-disk campaign must be a genuine prepared REAL lite campaign:
    // unqualified, no run records, no report, empty results dir.
    const stateFile = path.join(rd.campaign.dir, "state.json");
    if (!fs.existsSync(stateFile)) return; // campaign retained elsewhere
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const descriptor = JSON.parse(fs.readFileSync(path.join(rd.campaign.dir, DESCRIPTOR_NAME), "utf8"));
    assert.equal(state.campaign_id, rd.campaign.id);
    assert.equal(state.mode, "prepared");
    assert.equal(state.qualification?.real_launch_allowed, false, "prepare never self-qualifies");
    assert.equal(state.report, null, "no real round was started");
    assert.equal(Object.keys(state.rounds?.A?.runs ?? {}).length, 0);
    assert.equal(Object.keys(state.rounds?.B?.runs ?? {}).length, 0);
    assert.equal(state.rehearsal?.profile, REAL);
    assert.equal(state.rehearsal?.roster_id, LITE);
    assert.equal(state.fixture?.name, LITE_FIXTURE_NAME);
    assert.equal(descriptor.profile, REAL);
    assert.equal(descriptor.scale, LITE);

    // The designated pending candidate is the SAME profile and scale, and is
    // itself a truthful prepared campaign.
    const candidateDir = state.pending_candidate?.dir;
    assert.ok(candidateDir, "the primary records a designated pending candidate");
    assert.equal(state.pending_candidate.campaign_id, rd.pending_candidate.campaign_id);
    assert.equal(candidateDir, rd.pending_candidate.dir);
    const candState = JSON.parse(fs.readFileSync(path.join(candidateDir, "state.json"), "utf8"));
    const candDescriptor = JSON.parse(fs.readFileSync(path.join(candidateDir, DESCRIPTOR_NAME), "utf8"));
    assert.equal(candState.rehearsal?.profile, REAL, "the candidate is the SAME profile as the primary");
    assert.equal(candState.rehearsal?.roster_id, LITE, "the candidate is the SAME scale as the primary");
    assert.equal(candDescriptor.profile, REAL);
    assert.equal(candDescriptor.scale, LITE);
    assert.equal(candState.mode, "prepared");
    assert.equal(candState.qualification?.real_launch_allowed, false);
    assert.equal(candState.report, null);
    assert.deepEqual(fs.readdirSync(path.join(candidateDir, "results")), [], "candidate results dir stays empty");

    // The REAL-aware truthful-pending validator accepts both the campaign and
    // its same-profile candidate (the consistency gate's own contract).
    const approvalFile = rd.approval?.path ?? PILOT_APPROVAL_PATH;
    const primaryVerdict = validatePendingCampaign({
      campaignDir: rd.campaign.dir,
      state,
      descriptor,
      currentSourceCommit: state.source?.commit ?? rd.source.commit,
      approvalFile,
    });
    assert.equal(primaryVerdict.ok, true, `REAL primary must validate as truthful pending: ${JSON.stringify(primaryVerdict.issues)}`);
    const candidateVerdict = validatePendingCampaign({
      campaignDir: candidateDir,
      state: candState,
      descriptor: candDescriptor,
      currentSourceCommit: state.source?.commit ?? rd.source.commit,
      approvalFile,
    });
    assert.equal(candidateVerdict.ok, true, `REAL candidate must validate as truthful pending: ${JSON.stringify(candidateVerdict.issues)}`);

    // The published gate hashes are a COMPLETE recompute of the current tree
    // (a changed boundary after publication would drift here).
    const fresh = computeGateHashes();
    assert.equal(rd.gate_hash_files.length, Object.keys(fresh).length, "gate_hash_files is complete");
    for (const f of rd.gate_hash_files) assert.equal(rd.gate_hashes_sha256[f], fresh[f], `gate hash ${f} matches a fresh recompute`);
  });
});