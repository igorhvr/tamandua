// Tier-2 STORM-REHEARSAL US-004 — post-rehearsal evidence/closure
// consistency self-test (ONE focused torture self-test FILE).
//
// Story US-004: after the coordinator-owned approval matches the coherent
// safety+gate code and descriptor, ONE complete zero-model real
// SCRIPTED_REHEARSAL runs and the campaign's results/report.json +
// report.txt must truthfully cover every obligation (10 Round A ids, the
// 8-same-window claim observation + 2 queue decisions, 5 Round B ids + the
// identical B5 relaunch, all 11 phase actions with their preceding
// predicate evidence, the N4 single-flight exact-one execution,
// dead-owner/reclaim evidence, exact positive closure inventory, and
// run/system token ledgers EXACTLY zero). When the approval branch did NOT
// run (the coordinator file is absent or does not match), the SAME file
// validates the truthful pending/readiness state instead: the prepared
// campaign stays byte-identical and unexecuted (qualification not granted,
// rounds planned, results/report.json never manufactured, descriptor and
// gate hashes coherent), and no rehearsal evidence directory exists.
//
// The exported validators are pure and reusable: validatePendingCampaign
// proves a campaign truthfully did NOT execute, validateRehearsalEvidence
// proves a produced report/state genuinely covers the roster/ledger/
// closure contract (and refuses incomplete or self-contradictory evidence).
// The test cases run BOTH branches: (a) strictness proofs over synthetic
// pending and synthetic evidence fixtures (so this file is meaningful even
// on a fresh clone with no prepared campaign under var/), and (b) the
// REAL campaigns found under torture-test/var/results/storm-* — each must
// be either truthful-pending (no report.json yet) or, when a report exists,
// evidence-valid. No real daemon / harness / chaos / model is ever spawned;
// this file only READS campaign state under the gitignored var root and the
// coordinator approval file (never creates/edits it). No filesystem
// disposal of retained artifacts is performed by the code under test.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { B_MERGE_TARGET_IDS, ROUND_B_PHASES } from "../bin/tt-storm-engine.mjs";
import { isB5RelaunchLineage, isLandedParkEvidence, verifyCoordinatorApproval } from "../bin/tt-storm-real.mjs";
import { isRealProfile, isStormProfile, labelForProfile } from "../bin/tt-storm-profile.mjs";
import {
  computeGateHashes,
  DEFAULT_COORDINATOR_APPROVAL_FILE,
  DESCRIPTOR_NAME,
  GATE_HASH_FILES,
  REHEARSAL_LABEL,
  REHEARSAL_PROFILE,
  deriveScriptedHoldSchedule,
} from "../bin/tt-storm-rehearsal.mjs";
import { ROUND_A_ROSTER, ROUND_B_ROSTER } from "../bin/tt-storm-roster.mjs";
import { parseRunKey, STORM_REPORT_JSON, STORM_REPORT_TXT, STORM_RESULTS_DIR } from "../bin/tt-storm-shared.mjs";

const repoRoot = process.cwd();
const varRoot = path.join(repoRoot, "torture-test", "var");
const resultsRoot = path.join(varRoot, "results");
// SF-9 (fix-4) / FIX-5 (US-007) / FIX-6 (US-005) / FIX-7 (US-009) /
// FIX-8 (US-002): the coordinator readiness file is a LOCATOR for the
// designated pending candidate — never the source of truth. The on-disk
// prepared campaign it names must still validate as truthful pending. The
// fix8 rehearsal publishes
// /root/matchlock-work/storm-rehearsal-fix8-readiness.json; it is consulted
// FIRST, with the fix7 locator the next fallback, then fix6, then fix5, and
// the fix-4 readiness file retained only as an absent-tolerant last fallback
// for a host that has published fix4 but not a later one.
// FIX5_READINESS_FILE / FIX4_READINESS_FILE keep their exported names for any
// external importer (FIX4_READINESS_FILE is a back-compat alias of fix5, as
// it has been since US-007). A missing/unreadable readiness file is never an
// error: discovery just skips it and falls through to the campaign's own
// state.pending_candidate (which has precedence anyway).
export const FIX8_READINESS_FILE = "/root/matchlock-work/storm-rehearsal-fix8-readiness.json";
export const FIX7_READINESS_FILE = "/root/matchlock-work/storm-rehearsal-fix7-readiness.json";
export const FIX6_READINESS_FILE = "/root/matchlock-work/storm-rehearsal-fix6-readiness.json";
export const FIX5_READINESS_FILE = "/root/matchlock-work/storm-rehearsal-fix5-readiness.json";
export const FIX4_READINESS_FILE = FIX5_READINESS_FILE;
export const FIX4_READINESS_FALLBACK_FILE = "/root/matchlock-work/storm-rehearsal-fix4-readiness.json";
export const READINESS_LOCATOR_FILES = [FIX8_READINESS_FILE, FIX7_READINESS_FILE, FIX6_READINESS_FILE, FIX5_READINESS_FILE, FIX4_READINESS_FALLBACK_FILE];

// Roster coverage contract — the EXACT per-round roster identity (10 Round A
// ids incl. the queued S9/S10, 5 Round B ids) the report must list.
const ROUND_A_IDS = ROUND_A_ROSTER.map((r) => r.id);
const ROUND_B_IDS = ROUND_B_ROSTER.map((r) => r.id);
const ROUND_A_ACTIVE_IDS = ROUND_A_ROSTER.filter((r) => !r.queued).map((r) => r.id); // S1..S8
const ROUND_B_PHASE_IDS = ROUND_B_PHASES.map((p) => p.id); // the 11 phase actions

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function gitHead(repo: string): string {
  const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
  if (res.status !== 0) return "";
  return String(res.stdout ?? "").trim();
}

// Seed roots allocated by tt-storm-aged live in the SAME var/results directory
// as storm campaigns, named `storm-aged.<ts>.<rand>.<rand>`. A bare `storm-*`
// scan therefore misclassifies them as campaigns (they carry manifest.json,
// never state.json). The aged-seed namespace is distinct from the storm
// campaign namespace (`storm-<ts>-<uuid>` / `storm-pending-*` /
// `storm-designated-pending-*`), so exclude it from every campaign scan.
//
// The same collision class applies to the run-RECORD directory the storm-chain
// gate writes at var/results/storm-chain-<ts>/ (US-011 STORM-SEED-QUALIFY): it
// is a directory holding the chain file list, per-file logs and summaries —
// never a campaign, and it carries no state.json. Enumerate every tooling /
// evidence namespace that shares the `storm-` prefix so a new one cannot
// silently turn into a false "state.json missing" host-state red.
const NON_CAMPAIGN_STORM_PREFIXES = ["storm-aged", "storm-chain", "storm-seed-regen"] as const;
function isStormCampaignName(n: string): boolean {
  return n.startsWith("storm-") && !NON_CAMPAIGN_STORM_PREFIXES.some((p) => n.startsWith(p));
}

// Recursively collect every numeric value under the token-ledger key names
// the engine/DB use. Zero-model rehearsal: EVERY numeric token value must be
// exactly 0 — a single non-zero value is a false ledger claim.
const TOKEN_KEY_RE = /^(tokens|tokensSpent|tokens_spent|run_tokens|system_tokens|run_tokens_spent|system_tokens_spent)$/;
function collectTokenValues(node: any, out: Array<{ where: string; value: number }>, where = "$"): void {
  if (node === null || node === undefined || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectTokenValues(v, out, `${where}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (TOKEN_KEY_RE.test(k)) {
      if (typeof v === "number") out.push({ where: `${where}.${k}`, value: v });
      if (Array.isArray(v)) v.forEach((x, i) => { if (typeof x === "number") out.push({ where: `${where}.${k}[${i}]`, value: x }); });
    }
    if (v !== null && typeof v === "object") collectTokenValues(v, out, `${where}.${k}`);
  }
}

function assertDeepEqualSet(actual: Record<string, string>, expected: Record<string, string>, label: string, issues: string[]): void {
  const aKeys = Object.keys(actual).sort();
  const eKeys = Object.keys(expected).sort();
  if (JSON.stringify(aKeys) !== JSON.stringify(eKeys)) {
    issues.push(`${label}: file set differs (actual ${aKeys.length} vs expected ${eKeys.length}): ${JSON.stringify(aKeys)}`);
    return;
  }
  for (const k of eKeys) {
    if (actual[k] !== expected[k]) issues.push(`${label}: hash mismatch for ${k}`);
  }
}

// Deep-check that the campaign descriptor + state + a fresh gate-hash
// recompute all agree on the source-pinned gate set (no drift).
function gateHashCoherence(state: any, descriptor: any, issues: string[]): void {
  if (!state || typeof state.gate_hashes !== "object") {
    issues.push("state.gate_hashes missing or not an object");
    return;
  }
  if (!descriptor || typeof descriptor.gate_hashes !== "object") {
    issues.push("descriptor.gate_hashes missing or not an object");
    return;
  }
  let fresh: Record<string, string> | null = null;
  try {
    fresh = computeGateHashes();
  } catch (err) {
    issues.push(`gate-hash recompute refused: ${(err as Error).message}`);
    return;
  }
  assertDeepEqualSet(state.gate_hashes, fresh, "state.gate_hashes vs fresh recompute", issues);
  assertDeepEqualSet(descriptor.gate_hashes, fresh, "descriptor.gate_hashes vs fresh recompute", issues);
  assert.equal(Object.keys(fresh).length, GATE_HASH_FILES.length, "gate file list length");
}

// ─────────────────────────────────────────────────────────────────────
// validatePendingCampaign — truthful UNEXECUTED/readiness state.
// Returns { ok, notes, issues }. A campaign that claims pending must show:
// no qualification grant, no executed-round evidence, NO manufactured
// results/report.json, coherent descriptor + state + fresh gate hashes,
// and — when the coordinator approval file is present — the SAME strict
// validator must REFUSE it (a matching approval with zero evidence is a
// contradiction, never "pending"). An ABSENT approval is the truthful
// not-approved condition (a note, never a contradiction).
// ─────────────────────────────────────────────────────────────────────
export function validatePendingCampaign(opts: {
  campaignDir: string;
  state: any;
  descriptor: any;
  currentSourceCommit: string;
  approvalFile: string;
}): { ok: boolean; notes: string[]; issues: string[] } {
  const { campaignDir, state, descriptor, currentSourceCommit, approvalFile } = opts;
  const notes: string[] = [];
  const issues: string[] = [];
  const id = path.basename(campaignDir);

  if (!state || typeof state !== "object") { issues.push("state.json missing/invalid"); return { ok: false, notes, issues }; }
  if (typeof state.campaign_id !== "string" || state.campaign_id.length === 0) issues.push("state.campaign_id missing");
  else if (state.campaign_id !== id) issues.push(`state.campaign_id ${state.campaign_id} != basename ${id}`);
  if (state.mode !== "prepared") issues.push(`state.mode is ${JSON.stringify(state.mode)} (expected "prepared")`);

  // Qualification must be NOT granted while pending.
  const qual = state.qualification;
  if (!qual || typeof qual !== "object") issues.push("state.qualification missing");
  else if (qual.real_launch_allowed === true) issues.push("qualification.real_launch_allowed === true on an unexecuted campaign");

  // No executed-round evidence.
  const roundsA = state.rounds?.A ?? null;
  const roundsB = state.rounds?.B ?? null;
  if (!roundsA || roundsA.status !== "planned") issues.push(`round A status ${JSON.stringify(roundsA?.status)} (expected planned)`);
  if (!roundsB || roundsB.status !== "planned") issues.push(`round B status ${JSON.stringify(roundsB?.status)} (expected planned)`);
  if (roundsA && Object.keys(roundsA.runs ?? {}).length > 0) issues.push("round A carries run records on an unexecuted campaign");
  if (roundsB && Object.keys(roundsB.runs ?? {}).length > 0) issues.push("round B carries run records on an unexecuted campaign");
  if (state.report != null) issues.push("state.report populated on an unexecuted campaign");
  if (state.daemon && state.daemon.status === "running") issues.push("state.daemon claims running on an unexecuted campaign");
  if (state.cleanup && Array.isArray(state.cleanup.ledger) && state.cleanup.ledger.length > 0) {
    issues.push("cleanup ledger populated on an unexecuted campaign");
  }

  // NO manufactured rehearsal evidence (results/report.json + report.txt).
  const resultsDir = path.join(campaignDir, STORM_RESULTS_DIR);
  if (fs.existsSync(resultsDir)) {
    for (const name of fs.readdirSync(resultsDir)) {
      if (name === STORM_REPORT_JSON || name === STORM_REPORT_TXT) {
        issues.push(`manufactured rehearsal evidence present: ${resultsDir}/${name} on an unexecuted campaign`);
      }
    }
  }

  // Source + descriptor coherence. The campaign PROFILE is a persisted
  // identity (SCRIPTED_REHEARSAL or REAL); the validator is profile-aware so
  // a truthfully-prepared REAL pending candidate validates exactly like a
  // scripted one, while an unknown profile is refused. The profile-specific
  // evidence below (scripted-runtime contract for SCRIPTED_REHEARSAL, real
  // harness pins for REAL) keeps each profile truthful on its own terms.
  const campaignProfile = isStormProfile(state.rehearsal?.profile)
    ? state.rehearsal.profile
    : isStormProfile(descriptor?.profile)
      ? descriptor.profile
      : REHEARSAL_PROFILE;
  const src = state.source;
  if (!src || typeof src.commit !== "string" || src.commit.length === 0) issues.push("state.source.commit missing");
  if (!descriptor || typeof descriptor !== "object") {
    issues.push(`${DESCRIPTOR_NAME} missing/invalid`);
  } else {
    if (descriptor.kind !== "tt-storm-rehearsal-descriptor") issues.push(`descriptor.kind ${JSON.stringify(descriptor.kind)}`);
    if (!isStormProfile(descriptor.profile)) {
      issues.push(`descriptor.profile ${JSON.stringify(descriptor.profile)} is not an admitted storm profile (SCRIPTED_REHEARSAL|REAL)`);
    } else {
      const expectedLabel = labelForProfile(descriptor.profile);
      if (descriptor.label !== expectedLabel) issues.push(`descriptor.label != ${expectedLabel}`);
      if (isStormProfile(state.rehearsal?.profile) && state.rehearsal.profile !== descriptor.profile) {
        issues.push(`state.rehearsal.profile ${JSON.stringify(state.rehearsal.profile)} != descriptor.profile ${JSON.stringify(descriptor.profile)}`);
      }
    }
    if (descriptor.campaign?.id !== id) issues.push(`descriptor.campaign.id ${JSON.stringify(descriptor.campaign?.id)} != ${id}`);
    if (descriptor.source?.commit !== src?.commit) issues.push("descriptor.source.commit != state.source.commit");
    if (descriptor.source?.tree !== src?.tree) issues.push("descriptor.source.tree != state.source.tree");
    if (descriptor.authorized_rehearse?.approval_file !== DEFAULT_COORDINATOR_APPROVAL_FILE) {
      issues.push(`descriptor.authorized_rehearse.approval_file != ${DEFAULT_COORDINATOR_APPROVAL_FILE}`);
    }
  }
  gateHashCoherence(state, descriptor, issues);

  // US-006 reconciliation (fix-2 S5): a "prepared" SCRIPTED_REHEARSAL
  // campaign MUST carry the per-campaign scripted-runtime contract (behaviors
  // file + private scripted state dir). Without it the frozen zero-model
  // runtimes crash before claiming a step, so a campaign that lacks it is not
  // truthful-pending. A REAL campaign has no frozen scripted runtime; its
  // truthful-pending evidence is the pinned real-harness set instead.
  if (isRealProfile(campaignProfile)) {
    const harnessPins = state.rehearsal?.runtime_pins?.harnesses ?? descriptor?.runtime_pins?.harnesses ?? null;
    if (!harnessPins || typeof harnessPins !== "object" || Object.keys(harnessPins).length === 0) {
      issues.push("state.rehearsal.runtime_pins.harnesses missing on a prepared REAL campaign");
    }
  } else {
    const scripted = state.rehearsal?.scripted_runtime ?? null;
    if (!scripted || typeof scripted !== "object") {
      issues.push("state.rehearsal.scripted_runtime missing on a prepared campaign (S5)");
    } else {
    if (typeof scripted.behaviors_file !== "string" || !path.isAbsolute(scripted.behaviors_file)) {
      issues.push(`state.rehearsal.scripted_runtime.behaviors_file must be an absolute path: ${JSON.stringify(scripted.behaviors_file)}`);
    }
    if (!/^[0-9a-f]{64}$/.test(String(scripted.behaviors_sha256 ?? ""))) {
      issues.push(`state.rehearsal.scripted_runtime.behaviors_sha256 is not 64 hex chars: ${JSON.stringify(scripted.behaviors_sha256)}`);
    }
    if (typeof scripted.state_dir !== "string" || !path.isAbsolute(scripted.state_dir)) {
      issues.push(`state.rehearsal.scripted_runtime.state_dir must be an absolute path: ${JSON.stringify(scripted.state_dir)}`);
    }
    if (!(Number(scripted.agents) > 0)) {
      issues.push(`state.rehearsal.scripted_runtime.agents must cover at least one agent: ${JSON.stringify(scripted.agents)}`);
    }
    if (typeof scripted.behaviors_file === "string" && (scripted.behaviors_file === campaignDir || scripted.behaviors_file.startsWith(campaignDir + path.sep))) {
      issues.push("state.rehearsal.scripted_runtime.behaviors_file must not live inside the campaign dir");
    }
    if (typeof scripted.state_dir === "string" && (scripted.state_dir === campaignDir || scripted.state_dir.startsWith(campaignDir + path.sep))) {
      issues.push("state.rehearsal.scripted_runtime.state_dir must not live inside the campaign dir");
    }
    }
  }

  // Approval truth: absent -> truthful not-approved (note). Present -> the
  // strict validator must REFUSE (a matching approval with zero evidence is
  // a contradiction, never "pending").
  let approval: any = null;
  let approvalReadable = false;
  try {
    approval = JSON.parse(fs.readFileSync(approvalFile, "utf8"));
    approvalReadable = true;
  } catch {
    approval = null;
  }
  if (!approvalReadable) {
    notes.push(`approval file absent/unreadable: ${approvalFile} — not approved (TT_REHEARSAL_NOT_APPROVED)`);
  } else {
    const verdict = verifyCoordinatorApproval({
      approval,
      campaignId: id,
      sourceCommit: currentSourceCommit,
      gateHashes: computeGateHashes(),
      expectedProfile: campaignProfile,
    });
    if (verdict.ok) {
      issues.push(`approval file MATCHES campaign ${id} + current source but no rehearsal evidence exists — state is NOT truthful pending`);
    } else {
      notes.push(`approval file present but does NOT authorize this campaign/source: ${verdict.code} — not approved`);
    }
  }

  return { ok: issues.length === 0, notes, issues };
}

// ─────────────────────────────────────────────────────────────────────
// SF-15 (fix-9): a human-readable reason explaining why a run-id-matched
// park-landing candidate is NOT real park evidence. It always names a
// recognizable token ('noop' / 'already-coherent' / 'refreshed' /
// 'not-applicable' / 'no parked semantics') so a red campaign's diagnostic
// is specific instead of a generic "without park-landing evidence".
// ─────────────────────────────────────────────────────────────────────
function describeParkLandingRejection(events: any[]): string {
  const reasons = new Set<string>();
  for (const e of events) {
    if (!e || typeof e !== "object") {
      reasons.add("malformed event");
      continue;
    }
    if (e.noop === true) reasons.add("noop:true");
    const refresh = typeof e.checkoutRefresh === "string" && e.checkoutRefresh.length > 0 ? e.checkoutRefresh : "";
    if (refresh) reasons.add(`checkoutRefresh=${refresh}`);
    else if (e.noop !== true) reasons.add("no parked semantics");
  }
  return reasons.size > 0 ? [...reasons].sort().join(", ") : "no parked semantics";
}

// ─────────────────────────────────────────────────────────────────────
// validateRehearsalEvidence — produced-report/evidence consistency after a
// real SCRIPTED_REHEARSAL. Returns { ok, notes, issues }. When checkFiles
// is true (real evidence branch) the results/report.json + report.txt must
// actually exist on disk; synthetic fixtures pass checkFiles:false.
// ─────────────────────────────────────────────────────────────────────
export function validateRehearsalEvidence(opts: {
  campaignDir: string;
  state: any;
  report: any;
  checkFiles?: boolean;
}): { ok: boolean; notes: string[]; issues: string[] } {
  const { campaignDir, state, report, checkFiles = true } = opts;
  const notes: string[] = [];
  const issues: string[] = [];
  const id = path.basename(campaignDir);
  if (!report || typeof report !== "object") { issues.push("report missing/invalid"); return { ok: false, notes, issues }; }
  if (report.campaign_id !== id) issues.push(`report.campaign_id ${JSON.stringify(report.campaign_id)} != ${id}`);

  if (checkFiles) {
    const resultsDir = path.join(campaignDir, STORM_RESULTS_DIR);
    for (const name of [STORM_REPORT_JSON, STORM_REPORT_TXT]) {
      if (!fs.existsSync(path.join(resultsDir, name))) issues.push(`evidence file missing: ${resultsDir}/${name}`);
    }
  }

  const roundA = report.rounds?.A ?? null;
  const roundB = report.rounds?.B ?? null;
  if (!roundA) issues.push("report.rounds.A missing");
  if (!roundB) issues.push("report.rounds.B missing");

  // Round A coverage: every roster id (S1..S10) present; active S1..S8 must
  // carry a real run id (an 8-same-window observation needs every active run).
  const runsA: any[] = Array.isArray(roundA?.runs) ? roundA.runs : [];
  const byIdA = new Map(runsA.map((r) => [r.rosterId, r]));
  for (const rid of ROUND_A_IDS) {
    const rec = byIdA.get(rid);
    if (!rec) {
      issues.push(`round A report omits roster entry ${rid}`);
      continue;
    }
    if (!rec.runId) issues.push(`round A roster entry ${rid} has no recorded run id`);
  }
  for (const rid of ROUND_A_ACTIVE_IDS) {
    const rec = byIdA.get(rid);
    if (rec && !rec.runId) issues.push(`round A active entry ${rid} has no run id — cannot be part of the 8-run window`);
  }

  // 8-same-window claim + 2 queue decisions must be real observations.
  const sim = report.simultaneity;
  if (!sim) issues.push("report.simultaneity missing");
  else if (sim.eightConcurrentWindowObserved !== true) issues.push(`8-concurrent window not observed: ${JSON.stringify(sim.verdict ?? sim)}`);
  const q = report.queue;
  if (!q) issues.push("report.queue missing");
  else {
    if (!Array.isArray(q.attempts) || q.attempts.length < 2) issues.push(`queue admission attempts < 2 (got ${Array.isArray(q.attempts) ? q.attempts.length : "none"})`);
    if (q.s9Status === "not-planned" || q.s10Status === "not-planned") issues.push(`queue decision missing (S9=${q.s9Status} S10=${q.s10Status})`);
    if (q.decisionCorrectness !== true) issues.push(`queue decision correctness not true: ${JSON.stringify(q.decisionCorrectness)}`);
  }

  // Round B coverage: B1..B5 present + the identical B5 relaunch.
  const runsB: any[] = Array.isArray(roundB?.runs) ? roundB.runs : [];
  const byIdB = new Map(runsB.map((r) => [r.rosterId, r]));
  for (const rid of ROUND_B_IDS) {
    const rec = byIdB.get(rid);
    if (!rec) {
      issues.push(`round B report omits roster entry ${rid}`);
      continue;
    }
    if (!rec.runId && !rec.relaunchOf) issues.push(`round B roster entry ${rid} has no recorded run id`);
  }
  // The identical B5 stop/delete/relaunch must be evidenced. The fix6 engine's
  // REAL representation is a terminal-DELETED B5 record with NO lineage of its
  // own PLUS a SEPARATE parent-linked 'B5-relaunch' record (rosterId
  // 'B5-relaunch', relaunchOf 'B5', a real run id, terminalStatus
  // 'completed'); every phase predicate waits with outcome 'marker_satisfied'
  // (never 'ok'). The synthetic green fixture before this fix mutated the B5
  // record to carry relaunchOf, so the chain never certified the real branch.
  //
  // Accepted evidence (in order of precedence):
  //   1. ENGINE SHAPE — B5 terminal 'deleted' AND a 'B5-relaunch' record with
  //      relaunchOf 'B5', a non-empty runId and terminalStatus 'completed'.
  //   2. LEGACY B5 lineage — the B5 record itself carries relaunchOf.
  //   3. SATISFIED B-stopdel predicate — 'marker_satisfied' (current engine)
  //      or the older 'ok' spelling.
  // Strictness: when a 'B5-relaunch' record is PRESENT it must be well-formed.
  // A fabricated/partial relaunch record is never rescued by an unrelated
  // B-stopdel predicate or a legacy B5.relaunchOf — the engine shape requires
  // BOTH the deleted B5 and the completed parent-linked relaunch.
  const b5Record = byIdB.get("B5");
  const b5Deleted = !!b5Record && b5Record.terminalStatus === "deleted" && !b5Record.relaunchOf;
  const b5RelaunchRecords = runsB.filter((r) => r.rosterId === "B5-relaunch");
  // US-008 (fix-9 requirement 3): the linkage predicate is SHARED with
  // probePhaseMarkerReal ('B5 relaunch lineage') via isB5RelaunchLineage, so a
  // no-op/aliased relaunch (a record that reuses B5's OWN run id, carries no
  // run id, is unlinked, or is not completed) can never satisfy the gate.
  const b5RelaunchLinked = b5RelaunchRecords.some((r) =>
    isB5RelaunchLineage({ b5Record, relaunchRecord: r }),
  );
  const b5LegacyLineage = runsB.some((r) => r.rosterId === "B5" && r.relaunchOf);
  const b5StopdelSatisfied =
    Array.isArray(roundB?.phases) &&
    roundB.phases.some(
      (p: any) => p.id === "B-stopdel" && (p.waitOutcome?.outcome === "marker_satisfied" || p.waitOutcome?.outcome === "ok"),
    );
  const b5RelaunchObserved =
    (b5Deleted && b5RelaunchLinked) ||
    (b5RelaunchRecords.length === 0 && (b5LegacyLineage || b5StopdelSatisfied));
  if (!b5RelaunchObserved) {
    const detail = b5RelaunchRecords.length > 0
      ? "B5-relaunch record present but not a completed parent-linked run"
      : "no relaunchOf lineage, no B-stopdel marker_satisfied/ok outcome";
    issues.push(`identical B5 stop/delete/relaunch not evidenced in round B (${detail})`);
  }

  // ALL 11 phase actions present, each with its preceding predicate
  // evidence (a fired phase without a recorded waitOutcome is not evidence).
  const phasesB: any[] = Array.isArray(roundB?.phases) ? roundB.phases : [];
  const phaseById = new Map(phasesB.map((p) => [p.id, p]));
  for (const pid of ROUND_B_PHASE_IDS) {
    const ph = phaseById.get(pid);
    if (!ph) {
      issues.push(`round B phase ${pid} missing from report`);
      continue;
    }
    if (typeof ph.status !== "string" || ph.status.length === 0) issues.push(`round B phase ${pid} has no status`);
    if (ph.firedAt && (!ph.waitOutcome || !ph.waitOutcome.outcome)) {
      issues.push(`round B phase ${pid} fired without a recorded predicate waitOutcome`);
    }
    if (ph.notRunReason && !ph.firedAt && ph.waitOutcome?.outcome === "ok") {
      issues.push(`round B phase ${pid} contradictory (notRunReason + ok outcome)`);
    }
  }

  // US-008 (Requirement 4 / SF-14+SF-15): the two chaos phases that move /
  // dirty a LIVE merge target must be evidenced by the PRODUCT's own reaction,
  // never by the orchestration action alone. A B-rugpull that only committed
  // in the colleague clone (no merge.target_moved) and a B-park that dirtied
  // an unrelated checkout (no park landing) leave the campaign unproven.
  // Only a phase that actually RAN is held to this: an honest missed/not_run
  // phase is already non-green and never fabricates evidence.
  // SF-15 (fix-8): the B1..B4 state/report ids are the PUBLIC `run-<uuid>`
  // form while the product's own merge events carry the BARE `<uuid>` (see
  // src/installer/events.ts: every event.runId is unprefixed and the
  // run-scoped file is events/<uuid>.jsonl). Comparing those two raw strings
  // silently drops every real event, so canonicalize BOTH sides at this
  // boundary with parseRunKey (the product-id contract documented in
  // torture-test/bin/tt-storm-shared.mjs): a parseable run key compares by
  // its bare uuid, and ids that are not run keys (e.g. legacy synthetic tags)
  // fall back to exact match only when neither side is a run key. Never patch
  // product rows/files — normalize the comparison here.
  const bMergeRunBares = new Set<string>();
  const bMergeRunRawIds = new Set<string>();
  for (const rid of B_MERGE_TARGET_IDS) {
    const rec = byIdB.get(rid);
    if (rec && typeof rec.runId === "string" && rec.runId.length > 0) {
      const parsed = parseRunKey(rec.runId);
      if (parsed.ok) bMergeRunBares.add(parsed.bare as string);
      else bMergeRunRawIds.add(rec.runId);
    }
  }
  // Match a productEvidence event's runId to a targeted B1..B4 run id: bare
  // uuid vs public `run-<uuid>` (either direction) canonicalize to the same
  // key; a non-run-key on BOTH sides still matches by exact string.
  const matchesTargetRunId = (value: unknown): boolean => {
    if (typeof value !== "string" || value.length === 0) return false;
    const parsed = parseRunKey(value);
    if (parsed.ok) return bMergeRunBares.has(parsed.bare as string);
    return bMergeRunRawIds.has(value);
  };
  const productEvidencePhases: Array<{ id: string; field: "targetMoved" | "parkLanding"; label: string }> = [
    { id: "B-rugpull", field: "targetMoved", label: "real merge.target_moved evidence for a targeted merge run" },
    { id: "B-park", field: "parkLanding", label: "real park-landing evidence for a targeted merge run" },
  ];
  for (const spec of productEvidencePhases) {
    const ph = phaseById.get(spec.id);
    if (!ph) continue; // a missing phase is already reported by the coverage loop above
    const ran = ph.status === "fired" || ph.status === "done" || !!ph.firedAt;
    if (!ran) continue;
    const pe = ph.productEvidence;
    if (!pe || typeof pe !== "object") {
      issues.push(`round B phase ${spec.id} fired with no product evidence: ${spec.label} (the chaos action alone is not evidence)`);
      continue;
    }
    if (pe.ok === false) {
      issues.push(`round B phase ${spec.id} product-evidence channel unavailable: ${pe.error ?? "unknown"}`);
      continue;
    }
    const events: any[] = Array.isArray((pe as any)[spec.field]) ? (pe as any)[spec.field] : [];
    const targeted = events.filter((e) => e && matchesTargetRunId(e.runId));
    if (targeted.length === 0) {
      issues.push(`round B phase ${spec.id} fired without ${spec.label} (the chaos action alone is not evidence)`);
      continue;
    }
    // SF-15 (fix-9): a run-id match is NOT enough for the PARK phase. The
    // product must have taken a REAL parking action: noOpLanding sets
    // checkoutRefresh 'already-coherent' WITHOUT inspecting the checkout
    // (NPF-1), so a targeted noop:true / already-coherent / refreshed /
    // not-applicable landing must never satisfy the B-park gate. Reuse the
    // reader's exact strict predicate (US-005) so a landing the product-
    // evidence reader rejects can never be re-admitted here.
    if (spec.field === "parkLanding") {
      const realParked = targeted.filter((e) => isLandedParkEvidence(e));
      if (realParked.length === 0) {
        issues.push(
          `round B phase ${spec.id} park-landing evidence is not a real parked merge.landed ` +
            `(no-op/already-coherent landing: ${describeParkLandingRejection(targeted)}; the chaos action alone is not evidence)`,
        );
      }
    }
  }

  // Positive closure: cleanup inventory must be empty of failures.
  if (!report.cleanup || !Array.isArray(report.cleanup.failed)) issues.push("report.cleanup.failed missing");
  else if (report.cleanup.failed.length > 0) issues.push(`cleanup failed phases: ${JSON.stringify(report.cleanup.failed)}`);

  // Nongreen distinctness: a run classified green (terminalStatus completed,
  // not red-bait) must never simultaneously appear in red/missing/
  // inconclusive/not_run — states are disjoint and non-green stays non-green.
  const greenKeys = new Set<string>();
  for (const r of ["A", "B"] as const) {
    const runs: any[] = Array.isArray(report.rounds?.[r]?.runs) ? report.rounds[r].runs : [];
    for (const rec of runs) {
      if (rec.terminalStatus === "completed" && !(rec.redBait ?? false) && rec.rosterId) greenKeys.add(`${r}:${rec.rosterId}`);
    }
  }
  for (const bucket of ["red", "missing", "inconclusive", "not_run"] as const) {
    const entries: any[] = Array.isArray(report.states?.[bucket]) ? report.states[bucket] : [];
    for (const e of entries) {
      if (e.round && e.rosterId && greenKeys.has(`${e.round}:${e.rosterId}`)) {
        issues.push(`state ${e.rosterId} is both green and ${bucket} (nongreen distinctness violated)`);
      }
    }
  }

  // Zero-model ledger: every numeric token value in state + report is 0.
  const tokens: Array<{ where: string; value: number }> = [];
  collectTokenValues(state, tokens, "state");
  collectTokenValues(report, tokens, "report");
  for (const t of tokens) {
    if (t.value !== 0) issues.push(`non-zero token value at ${t.where}: ${t.value} (zero-model rehearsal violated)`);
  }

  return { ok: issues.length === 0, notes, issues };
}

// ─────────────────────────────────────────────────────────────────────
// SF-9 (fix-4) — the DESIGNATED PENDING CANDIDATE locator/validator.
//
// `tt-storm prepare --pending-candidate <dir>` prepares a SECOND, fully
// prepared, never-executed SCRIPTED_REHEARSAL campaign alongside the primary
// and records {campaign_id, dir} as state.pending_candidate in the primary
// state.json + descriptor.json. The gate below locates that candidate with
// this precedence:
//   1. any campaign's state.pending_candidate (the designated candidate);
//   2. the fix-4 readiness file's pending_candidate (a LOCATOR only);
//   3. any pending storm-* campaign under resultsRoot (no report.json).
// The FIRST located candidate that actually exists as a campaign dir
// (state.json present) is authoritative: a designated candidate that is
// fabricated (missing), completed (report.json / run records / mode
// executed), or otherwise contradictory is REFUSED, never silently replaced
// by a weaker fallback.
// ─────────────────────────────────────────────────────────────────────
export function discoverPendingCandidateDirs(opts: {
  resultsRoot: string;
  readinessFile?: string | null;
  // FIX-5 (US-007): an ordered list of readiness locators (fix5 first, fix4
  // fallback). Each entry is optional and absent-tolerant; readinessFile is
  // still honored for back-compat and is consulted after the list.
  readinessFiles?: Array<string | null | undefined> | null;
  fsx?: typeof fs;
}): Array<{ dir: string; source: string }> {
  const fsx = opts.fsx ?? fs;
  const out: Array<{ dir: string; source: string }> = [];
  let names: string[] = [];
  try {
    names = fsx.readdirSync(opts.resultsRoot).filter((n) => isStormCampaignName(n));
  } catch {
    names = [];
  }
  for (const n of names) {
    try {
      const st = JSON.parse(String(fsx.readFileSync(path.join(opts.resultsRoot, n, "state.json"), "utf8")));
      const pc = st?.pending_candidate;
      const pcDir = typeof pc === "string" ? pc : pc?.dir;
      if (typeof pcDir === "string" && pcDir.length > 0) out.push({ dir: pcDir, source: `state.pending_candidate:${n}` });
    } catch {
      /* not a campaign / unreadable state */
    }
  }
  const readinessLocators: Array<string | null | undefined> = [
    ...(Array.isArray(opts.readinessFiles) ? opts.readinessFiles : []),
    ...(opts.readinessFile ? [opts.readinessFile] : []),
  ];
  const seenLocators = new Set<string>();
  for (const locator of readinessLocators) {
    if (!locator || seenLocators.has(locator)) continue;
    seenLocators.add(locator);
    try {
      const rd = JSON.parse(String(fsx.readFileSync(locator, "utf8")));
      const pc = rd?.pending_candidate;
      const pcDir = typeof pc === "string" ? pc : (pc?.dir ?? pc?.campaign_dir);
      if (typeof pcDir === "string" && pcDir.length > 0) {
        out.push({ dir: pcDir, source: `readiness.pending_candidate:${path.basename(locator)}` });
      }
    } catch {
      /* absent readiness file is fine */
    }
  }
  for (const n of names) {
    const dir = path.join(opts.resultsRoot, n);
    if (!fsx.existsSync(path.join(dir, STORM_RESULTS_DIR, STORM_REPORT_JSON))) out.push({ dir, source: `pending-campaign:${n}` });
  }
  return out;
}

export function validateDesignatedPendingCandidate(opts: {
  resultsRoot: string;
  readinessFile?: string | null;
  readinessFiles?: Array<string | null | undefined> | null;
  currentSourceCommit: string;
  approvalFile: string;
  fsx?: typeof fs;
}): { ok: boolean; validated: number; selected: string | null; source: string | null; issues: string[] } {
  const fsx = opts.fsx ?? fs;
  const candidates = discoverPendingCandidateDirs({ resultsRoot: opts.resultsRoot, readinessFile: opts.readinessFile, readinessFiles: opts.readinessFiles, fsx });
  if (candidates.length === 0) {
    return { ok: false, validated: 0, selected: null, source: null, issues: ["no pending storm-* campaign or designated pending candidate found on disk"] };
  }
  let selected: { dir: string; source: string } | null = null;
  for (const c of candidates) {
    if (fsx.existsSync(path.join(c.dir, "state.json"))) {
      selected = c;
      break;
    }
  }
  if (!selected) {
    return {
      ok: false,
      validated: 0,
      selected: null,
      source: null,
      issues: [`designated pending candidate(s) missing on disk: ${candidates.map((c) => `${c.dir} (${c.source})`).join(", ")}`],
    };
  }
  let state: any;
  try {
    state = JSON.parse(String(fsx.readFileSync(path.join(selected.dir, "state.json"), "utf8")));
  } catch (err) {
    return { ok: false, validated: 0, selected: selected.dir, source: selected.source, issues: [`candidate state.json unreadable: ${(err as Error).message}`] };
  }
  const descriptorFile = path.join(selected.dir, DESCRIPTOR_NAME);
  let descriptor: any = null;
  if (fsx.existsSync(descriptorFile)) {
    try {
      descriptor = JSON.parse(String(fsx.readFileSync(descriptorFile, "utf8")));
    } catch {
      descriptor = null;
    }
  }
  const res = validatePendingCampaign({ campaignDir: selected.dir, state, descriptor, currentSourceCommit: opts.currentSourceCommit, approvalFile: opts.approvalFile });
  return {
    ok: res.issues.length === 0,
    validated: res.issues.length === 0 ? 1 : 0,
    selected: selected.dir,
    source: selected.source,
    issues: res.issues.map((i) => `${selected!.source}: ${i}`),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Test cases
// ─────────────────────────────────────────────────────────────────────

describe("tier2-storm-rehearsal-consistency", () => {
  const approvalFile = DEFAULT_COORDINATOR_APPROVAL_FILE;
  const currentSourceCommit = gitHead(repoRoot);

  describe("roster + phase contract (coverage baseline)", () => {
    it("Round A roster has exactly the 10 ids S1..S10 (8 active + S9/S10 queued)", () => {
      assert.equal(ROUND_A_ROSTER.length, 10);
      assert.deepEqual(ROUND_A_IDS, ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10"]);
      assert.deepEqual(ROUND_A_ACTIVE_IDS, ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"]);
      assert.equal(ROUND_A_ROSTER.filter((r) => r.queued).length, 2);
    });
    it("Round B roster has exactly the 5 ids B1..B5 (B4 red-bait, B5 do-now)", () => {
      assert.equal(ROUND_B_ROSTER.length, 5);
      assert.deepEqual(ROUND_B_IDS, ["B1", "B2", "B3", "B4", "B5"]);
      assert.equal(ROUND_B_ROSTER.find((r) => r.id === "B4")?.red_bait, true);
      assert.equal(ROUND_B_ROSTER.find((r) => r.id === "B5")?.run, "storm-b5-donow");
    });
    it("Round B phase schedule carries all 11 actions", () => {
      assert.equal(ROUND_B_PHASES.length, 11);
      assert.deepEqual(
        [...ROUND_B_PHASE_IDS].sort(),
        ["B-bounce", "B-cc1", "B-cc2", "B-kill", "B-nudge", "B-park", "B-pause", "B-pounding", "B-resume", "B-rugpull", "B-stopdel"].sort(),
      );
    });
  });

  // FIX-5 (US-007) / FIX-6 (US-005): the readiness file is only a LOCATOR for
  // the designated pending candidate. The fix6 rehearsal must point the locator
  // chain at the fix6 readiness FIRST, with fix5 as the next fallback and fix4
  // as an absent-tolerant last fallback; a missing readiness file must never
  // throw or mask a candidate that the campaign itself names via
  // state.pending_candidate (which keeps precedence in discovery).
  describe("FIX-8 readiness locator (US-002, fix7/fix6/fix5/fix4 fallbacks)", () => {
    // Minimal read-only fs mirror: reads come from the given map, every other
    // path is treated as absent (no directory, no file). Keeps discovery
    // absent-tolerant without touching the host filesystem.
    function memFsx(files: Map<string, string>, dirs: Record<string, string[]> = {}): typeof fs {
      return {
        readdirSync: (p: string | URL) => {
          const key = String(p);
          if (dirs[key]) return dirs[key];
          throw new Error(`ENOENT readdir ${key}`);
        },
        readFileSync: (p: string | URL) => {
          const key = String(p);
          if (files.has(key)) return files.get(key) as string;
          throw new Error(`ENOENT open ${key}`);
        },
        existsSync: (_p: string | URL) => false,
      } as unknown as typeof fs;
    }

    it("points at the fix8 readiness path first, with the fix7/fix6/fix5/fix4 locators retained as fallbacks", () => {
      assert.equal(FIX8_READINESS_FILE, "/root/matchlock-work/storm-rehearsal-fix8-readiness.json");
      assert.equal(FIX7_READINESS_FILE, "/root/matchlock-work/storm-rehearsal-fix7-readiness.json");
      assert.equal(FIX6_READINESS_FILE, "/root/matchlock-work/storm-rehearsal-fix6-readiness.json");
      assert.equal(FIX5_READINESS_FILE, "/root/matchlock-work/storm-rehearsal-fix5-readiness.json");
      assert.equal(FIX4_READINESS_FILE, FIX5_READINESS_FILE, "the retained FIX4_READINESS_FILE back-compat alias still points at the fix5 locator");
      assert.equal(READINESS_LOCATOR_FILES[0], FIX8_READINESS_FILE, "the fix8 locator must be consulted first");
      assert.equal(READINESS_LOCATOR_FILES[1], FIX7_READINESS_FILE, "the fix7 locator is the next fallback");
      assert.equal(READINESS_LOCATOR_FILES[2], FIX6_READINESS_FILE, "the fix6 locator is the next fallback");
      assert.equal(READINESS_LOCATOR_FILES[3], FIX5_READINESS_FILE, "the fix5 locator is the next fallback");
      assert.ok(READINESS_LOCATOR_FILES.includes(FIX4_READINESS_FALLBACK_FILE), "the fix4 locator stays as a fallback");
      // All five locators are distinct paths (a duplicate would silently
      // collapse the ordered fallback chain in discovery).
      assert.equal(new Set(READINESS_LOCATOR_FILES).size, READINESS_LOCATOR_FILES.length, "readiness locators must be distinct");
      assert.equal(READINESS_LOCATOR_FILES.length, 5, "fix8, fix7, fix6, fix5 and fix4 locators are all retained");
      assert.notEqual(FIX4_READINESS_FALLBACK_FILE, FIX8_READINESS_FILE, "the fix4 fallback must differ from the fix8 locator");
      assert.notEqual(FIX4_READINESS_FALLBACK_FILE, FIX7_READINESS_FILE, "the fix4 fallback must differ from the fix7 locator");
      assert.notEqual(FIX4_READINESS_FALLBACK_FILE, FIX6_READINESS_FILE, "the fix4 fallback must differ from the fix6 locator");
      assert.notEqual(FIX4_READINESS_FALLBACK_FILE, FIX5_READINESS_FILE, "the fix4 fallback must differ from the fix5 locator");
    });

    it("locates the pending candidate named by the fix8 readiness file (preferred locator)", () => {
      const candidateDir = "/virtual/candidate/storm-fix8-pending";
      const files = new Map<string, string>([
        [FIX8_READINESS_FILE, JSON.stringify({ pending_candidate: { dir: candidateDir } })],
      ]);
      // The fix8 locator is present FIRST and must name a discoverable
      // candidate without any of the older fallbacks.
      const located = discoverPendingCandidateDirs({
        resultsRoot: "/virtual/results-fix8",
        readinessFiles: READINESS_LOCATOR_FILES,
        fsx: memFsx(files),
      });
      assert.deepEqual(located, [
        { dir: candidateDir, source: `readiness.pending_candidate:${path.basename(FIX8_READINESS_FILE)}` },
      ]);
    });

    it("tolerates absent readiness locators and still discovers state.pending_candidate", () => {
      const virtualResults = "/virtual/results-absent-readiness";
      const primaryState = path.join(virtualResults, "storm-primary", "state.json");
      const candidateDir = "/virtual/candidate/storm-candidate";
      const files = new Map<string, string>([
        [primaryState, JSON.stringify({ pending_candidate: { dir: candidateDir } })],
      ]);
      // ALL readiness locators are absent in this mirror (the fix7 file does
      // not exist until the coordinator publishes it) — discovery must not
      // throw and must fall through to state.pending_candidate.
      const located = discoverPendingCandidateDirs({
        resultsRoot: virtualResults,
        readinessFiles: READINESS_LOCATOR_FILES,
        fsx: memFsx(files, { [virtualResults]: ["storm-primary"] }),
      });
      assert.ok(
        located.some((c) => c.dir === candidateDir && c.source.startsWith("state.pending_candidate")),
        `absent readiness must not block state.pending_candidate discovery: ${JSON.stringify(located)}`,
      );
    });

    it("locates the pending candidate named by the fix7 readiness file (fallback locator)", () => {
      const candidateDir = "/virtual/candidate/storm-fix7-pending";
      const files = new Map<string, string>([
        [FIX7_READINESS_FILE, JSON.stringify({ pending_candidate: { dir: candidateDir } })],
      ]);
      // The fix8 locator is absent here; fix7 is the first present locator and
      // must name a discoverable candidate without the older fallbacks.
      const located = discoverPendingCandidateDirs({
        resultsRoot: "/virtual/results-fix7",
        readinessFiles: READINESS_LOCATOR_FILES,
        fsx: memFsx(files),
      });
      assert.deepEqual(located, [
        { dir: candidateDir, source: `readiness.pending_candidate:${path.basename(FIX7_READINESS_FILE)}` },
      ]);
    });

    it("locates the pending candidate named by the fix6 readiness file", () => {
      const candidateDir = "/virtual/candidate/storm-fix6-pending";
      const files = new Map<string, string>([
        [FIX6_READINESS_FILE, JSON.stringify({ pending_candidate: { dir: candidateDir } })],
      ]);
      // The fix7/fix5/fix4 locators are intentionally absent here: the fix6
      // locator alone must name a discoverable candidate.
      const located = discoverPendingCandidateDirs({
        resultsRoot: "/virtual/results-fix6",
        readinessFiles: READINESS_LOCATOR_FILES,
        fsx: memFsx(files),
      });
      assert.deepEqual(located, [
        { dir: candidateDir, source: `readiness.pending_candidate:${path.basename(FIX6_READINESS_FILE)}` },
      ]);
    });

    it("falls back to the fix5 locator when the fix7 and fix6 readiness files are absent", () => {
      const candidateDir = "/virtual/candidate/storm-fix5-pending";
      const files = new Map<string, string>([
        [FIX5_READINESS_FILE, JSON.stringify({ pending_candidate: { dir: candidateDir } })],
      ]);
      const located = discoverPendingCandidateDirs({
        resultsRoot: "/virtual/results-fix5-fallback",
        readinessFiles: READINESS_LOCATOR_FILES,
        fsx: memFsx(files),
      });
      assert.deepEqual(located, [
        { dir: candidateDir, source: `readiness.pending_candidate:${path.basename(FIX5_READINESS_FILE)}` },
      ]);
    });

    it("keeps the campaign's own state.pending_candidate ahead of a fix6-named candidate", () => {
      const virtualResults = "/virtual/results-precedence";
      const stateNamed = "/virtual/candidate/storm-state-named";
      const readinessNamed = "/virtual/candidate/storm-readiness-named";
      const files = new Map<string, string>([
        [path.join(virtualResults, "storm-primary", "state.json"), JSON.stringify({ pending_candidate: { dir: stateNamed } })],
        [FIX6_READINESS_FILE, JSON.stringify({ pending_candidate: { dir: readinessNamed } })],
      ]);
      const located = discoverPendingCandidateDirs({
        resultsRoot: virtualResults,
        readinessFiles: READINESS_LOCATOR_FILES,
        fsx: memFsx(files, { [virtualResults]: ["storm-primary"] }),
      });
      // Precedence is unchanged (US-005): state.pending_candidate first, then
      // readiness locators, then any pending storm-* campaign.
      assert.equal(located[0]?.dir, stateNamed, `state.pending_candidate must keep precedence: ${JSON.stringify(located)}`);
      assert.ok(
        located.some((c) => c.dir === readinessNamed && c.source.startsWith("readiness.pending_candidate")),
        `the fix6 readiness candidate must still be discovered: ${JSON.stringify(located)}`,
      );
    });

    it("excludes storm-aged.* seed roots from the storm campaign scan (aged-seed namespace)", () => {
      // The aged-state generator (tt-storm-aged) allocates seed roots in the
      // SAME var/results directory as storm campaigns, named `storm-aged.*`.
      // A seed root carries manifest.json (never state.json), so a bare
      // `storm-*` scan would surface it as a pending-campaign fallback. This
      // is the red-arming test for isStormCampaignName: it must be excluded.
      const virtualResults = "/virtual/results-aged-namespace";
      const campaignId = "storm-20260101T000000Z-00000000-0000-4000-8000-000000000000";
      const seedRoot = path.join(virtualResults, "storm-aged.2026-01-01T00-00-00-000Z.abc123.Def456");
      const candidateDir = "/virtual/candidate/storm-designated-pending";
      const files = new Map<string, string>([
        [path.join(virtualResults, campaignId, "state.json"), JSON.stringify({ campaign_id: campaignId, pending_candidate: { dir: candidateDir } })],
      ]);
      const located = discoverPendingCandidateDirs({
        resultsRoot: virtualResults,
        readinessFiles: READINESS_LOCATOR_FILES,
        fsx: memFsx(files, { [virtualResults]: [path.basename(seedRoot), campaignId] }),
      });
      assert.ok(
        located.some((c) => c.dir === candidateDir && c.source.startsWith("state.pending_candidate")),
        `the campaign's designated candidate must still be discovered: ${JSON.stringify(located)}`,
      );
      assert.ok(
        !located.some((c) => c.dir === seedRoot),
        `a storm-aged.* seed root must never be scanned as a storm campaign: ${JSON.stringify(located)}`,
      );
    });

    it("excludes storm-chain-* run-record dirs from the storm campaign scan (chain-evidence namespace)", () => {
      // The storm-chain gate (US-011 STORM-SEED-QUALIFY) writes its run record
      // (file list, per-file logs, chain summary) under
      // var/results/storm-chain-<ts>/. That directory shares the `storm-`
      // prefix and is a DIRECTORY, so a bare `storm-*` scan surfaces it and the
      // host-state assertions then fail with
      // "state.json missing for .../storm-chain-<ts>". This is the red-arming
      // test for isStormCampaignName: the chain-evidence namespace must be
      // excluded while a real campaign in the same directory is still found.
      const virtualResults = "/virtual/results-chain-namespace";
      const campaignId = "storm-20260101T000000Z-00000000-0000-4000-8000-000000000000";
      const chainRecord = path.join(virtualResults, "storm-chain-2026-01-01T00-00-00Z");
      const candidateDir = "/virtual/candidate/storm-designated-pending";
      const files = new Map<string, string>([
        [path.join(virtualResults, campaignId, "state.json"), JSON.stringify({ campaign_id: campaignId, pending_candidate: { dir: candidateDir } })],
      ]);
      const located = discoverPendingCandidateDirs({
        resultsRoot: virtualResults,
        readinessFiles: READINESS_LOCATOR_FILES,
        fsx: memFsx(files, { [virtualResults]: [path.basename(chainRecord), campaignId] }),
      });
      assert.ok(
        located.some((c) => c.dir === candidateDir && c.source.startsWith("state.pending_candidate")),
        `the campaign's designated candidate must still be discovered: ${JSON.stringify(located)}`,
      );
      assert.ok(
        !located.some((c) => c.dir === chainRecord),
        `a storm-chain-* run-record dir must never be scanned as a storm campaign: ${JSON.stringify(located)}`,
      );
    });

    it("excludes storm-seed-regen-* run/evidence dirs from the storm campaign scan (seed-regen namespace)", () => {
      // The SEED-REGEN run (US-001/US-003/US-005) writes its evidence under
      // var/results/storm-seed-regen-<...>/ (environment receipts, the fresh
      // owned tt-poly origin at storm-seed-regen-origin, the full-seed
      // receipts at storm-seed-regen-us005). Each is a DIRECTORY sharing the
      // `storm-` prefix and none carries a campaign state.json, so a bare
      // `storm-*` scan surfaces them and the host-state assertions fail with
      // "state.json missing for .../storm-seed-regen-origin". This is the
      // red-arming test for isStormCampaignName: the seed-regen evidence
      // namespace must be excluded while a real campaign in the same
      // directory is still found.
      const virtualResults = "/virtual/results-seed-regen-namespace";
      const campaignId = "storm-20260101T000000Z-00000000-0000-4000-8000-000000000000";
      const originRecord = path.join(virtualResults, "storm-seed-regen-origin");
      const seedReceipt = path.join(virtualResults, "storm-seed-regen-us005");
      const candidateDir = "/virtual/candidate/storm-designated-pending";
      const files = new Map<string, string>([
        [path.join(virtualResults, campaignId, "state.json"), JSON.stringify({ campaign_id: campaignId, pending_candidate: { dir: candidateDir } })],
      ]);
      const located = discoverPendingCandidateDirs({
        resultsRoot: virtualResults,
        readinessFiles: READINESS_LOCATOR_FILES,
        fsx: memFsx(files, { [virtualResults]: [path.basename(originRecord), path.basename(seedReceipt), campaignId] }),
      });
      assert.ok(
        located.some((c) => c.dir === candidateDir && c.source.startsWith("state.pending_candidate")),
        `the campaign's designated candidate must still be discovered: ${JSON.stringify(located)}`,
      );
      assert.ok(
        !located.some((c) => c.dir === originRecord),
        `a storm-seed-regen-* evidence dir must never be scanned as a storm campaign: ${JSON.stringify(located)}`,
      );
      assert.ok(
        !located.some((c) => c.dir === seedReceipt),
        `a storm-seed-regen-* evidence dir must never be scanned as a storm campaign: ${JSON.stringify(located)}`,
      );
    });
  });

  describe("validateRehearsalEvidence (approved branch — strictness over synthetic evidence)", () => {
    // SF-15 (fix-8): the real product shape is asymmetric — the
    // state/report render the targeted B1..B4 runs as PUBLIC `run-<uuid>`
    // while the product's OWN merge events carry the BARE `<uuid>` (see
    // src/installer/events.ts). The synthetic green fixture must mirror that
    // exact asymmetry; a matching-id-on-both-sides fixture is what masked the
    // attempt-8 mismatch in the 45-file chain.
    const B_MERGE_UUID: Record<string, string> = {
      B1: "b1000000-0000-4000-8000-0000000000b1",
      B2: "b2000000-0000-4000-8000-0000000000b2",
      B3: "b3000000-0000-4000-8000-0000000000b3",
      B4: "b4000000-0000-4000-8000-0000000000b4",
    };
    function syntheticRun(rosterId: string, runId: string, extra: any = {}): any {
      return { rosterId, run: `${rosterId}-run`, workflow: "wf", harness: "pi", runId, status: "running", terminalStatus: null, ...extra };
    }
    // The fix6 engine's phase predicates are recorded as 'marker_satisfied'
    // (never 'ok'); the green fixture must certify that real spelling.
    function phaseSatisfied(id: string): any {
      return { id, status: "done", firedAt: "2026-09-09T23:00:00Z", waitOutcome: { outcome: "marker_satisfied", satisfied: true, marker: "hold-confirmed", observed: id } };
    }
    // Synthetic green evidence shaped EXACTLY like the fix6 engine report:
    // B5 is terminal 'deleted' with no lineage of its own, and the identical
    // do-now relaunch is a SEPARATE 'B5-relaunch' record (relaunchOf 'B5', a
    // real runId, terminalStatus 'completed'). Every phase predicate carries
    // the real 'marker_satisfied' outcome.
    function syntheticGreenReport(): any {
      const roundARuns = ROUND_A_IDS.map((rid, i) =>
        syntheticRun(rid, `run-${i + 1}-${rid.toLowerCase()}`, {
          admission: { decision: ROUND_A_ACTIVE_IDS.includes(rid) ? "admit" : "queue", freeSlots: ROUND_A_ACTIVE_IDS.includes(rid) ? 8 : 0 },
          terminalStatus: "completed",
        }),
      );
      const roundBRuns = ROUND_B_IDS.map((rid) => {
        const uuid = B_MERGE_UUID[rid];
        const runId = uuid ? `run-${uuid}` : `run-b-${rid.toLowerCase()}`;
        return syntheticRun(rid, runId, rid === "B4" ? { redBait: true, terminalStatus: "completed" } : { terminalStatus: "completed" });
      });
      roundBRuns[4] = { ...roundBRuns[4], terminalStatus: "deleted" };
      const b5Relaunch = syntheticRun("B5-relaunch", "run-b-b5-relaunch", { terminalStatus: "completed", relaunchOf: "B5" });
      // US-008 (Requirement 4): the green fixture must ALSO carry the real
      // product-side evidence for the two chaos phases the evidence validator
      // now requires — a real merge.target_moved for a targeted merge run
      // (B-rugpull) and real park-landing evidence (B-park). Without it the
      // fixture would no longer certify the real evidence-valid branch.
      const phases = ROUND_B_PHASE_IDS.map(phaseSatisfied);
      const bMergeRunIds = B_MERGE_TARGET_IDS.map((rid) => `run-${B_MERGE_UUID[rid]}`);
      phases.find((p: any) => p.id === "B-rugpull").productEvidence = {
        phaseId: "B-rugpull",
        sinceUtc: "2026-09-09T22:00:00Z",
        runIds: bMergeRunIds,
        ok: true,
        error: null,
        targetMoved: [{ event: "merge.target_moved", runId: B_MERGE_UUID.B1, ts: "2026-09-09T22:01:00Z", detail: "target refs/heads/main moved: expected ... actual ..." }],
        landed: [],
        parkLanding: [],
      };
      const parkLanded = {
        event: "merge.landed",
        runId: B_MERGE_UUID.B2,
        ts: "2026-09-09T22:03:00Z",
        // SF-15 (fix-9): the synthetic green fixture must certify a REAL
        // park action (noop:false + the product's documented parked:<backup>),
        // never the NPF-1 no-op/already-coherent shape.
        noop: false,
        checkoutRefresh: "parked:main-tamandua-parked-20260909T220300Z-deadbe",
        parkedBranch: "main-tamandua-parked-20260909T220300Z-deadbe",
        parkedReason: "local-changes",
      };
      phases.find((p: any) => p.id === "B-park").productEvidence = {
        phaseId: "B-park",
        sinceUtc: "2026-09-09T22:02:00Z",
        runIds: bMergeRunIds,
        ok: true,
        error: null,
        targetMoved: [],
        landed: [parkLanded],
        parkLanding: [parkLanded],
      };
      return {
        campaign_id: "storm-consistency-synthetic",
        generated_at: "2026-09-09T23:59:59Z",
        simultaneity: { configured: 8, observedPeak: 8, eightConcurrentWindowObserved: true, verdict: "8-concurrent window observed" },
        queue: {
          attempts: [
            { decision: "queue", freeSlots: 0, demandedTimers: 7 },
            { decision: "admit", freeSlots: 8, demandedTimers: 1 },
          ],
          s9Status: "admitted", s10Status: "admitted", decisionCorrectness: true, decisionCorrectnessJudged: 2, decisionCorrectnessUnjudged: 0,
        },
        rounds: {
          A: { status: "round_done", runs: roundARuns, phases: [] },
          B: { status: "round_done", runs: [...roundBRuns, b5Relaunch], phases },
        },
        cleanup: { failed: [] },
        states: { red: [], missing: [], not_run: [], inconclusive: [] },
      };
    }

    it("accepts a fully-green synthetic evidence report (all coverage + ledger zero)", () => {
      const report = syntheticGreenReport();
      const state = { rounds: { A: { runs: { S1: { tokens: 0 } } }, B: { runs: {} } }, system_tokens: 0 };
      const res = validateRehearsalEvidence({ campaignDir: "/tmp/storm-consistency-synthetic", state, report, checkFiles: false });
      assert.equal(res.ok, true, `unexpected issues: ${JSON.stringify(res.issues)}`);
      // The fixture must certifiably mirror the fix6 engine's REAL shape: the
      // B5 record is terminal 'deleted' with no lineage, the identical relaunch
      // is a separate parent-linked 'B5-relaunch' record, and phase predicates
      // carry 'marker_satisfied' (never 'ok').
      const b5 = report.rounds.B.runs.find((r: any) => r.rosterId === "B5");
      assert.equal(b5.terminalStatus, "deleted");
      assert.ok(!b5.relaunchOf, "the deleted B5 record must NOT carry lineage");
      const relaunch = report.rounds.B.runs.find((r: any) => r.rosterId === "B5-relaunch");
      assert.equal(relaunch.relaunchOf, "B5");
      assert.equal(relaunch.terminalStatus, "completed");
      assert.ok(relaunch.runId, "the B5-relaunch record carries a real run id");
      assert.ok(
        report.rounds.B.phases.every((p: any) => p.waitOutcome?.outcome === "marker_satisfied"),
        "the green fixture must use the engine's marker_satisfied outcome spelling",
      );
      // US-008: the fixture also carries the real product-side evidence the
      // validator requires for the two target-moving/dirtying chaos phases.
      const rug = report.rounds.B.phases.find((p: any) => p.id === "B-rugpull");
      const park = report.rounds.B.phases.find((p: any) => p.id === "B-park");
      assert.equal(rug.productEvidence.ok, true);
      assert.ok(rug.productEvidence.targetMoved.length > 0, "green fixture has real B-rugpull product evidence");
      assert.equal(park.productEvidence.ok, true);
      assert.ok(park.productEvidence.parkLanding.length > 0, "green fixture has real B-park product evidence");
      // SF-15 (fix-8): the green fixture MUST carry the real asymmetric product
      // shape — PUBLIC `run-<uuid>` report ids vs BARE `<uuid>` event runIds —
      // so an id-shape regression can never again hide behind a
      // matching-id-on-both-sides fixture.
      for (const rid of B_MERGE_TARGET_IDS) {
        const rec = report.rounds.B.runs.find((r: any) => r.rosterId === rid);
        assert.equal(rec.runId, `run-${B_MERGE_UUID[rid]}`, `report run id for ${rid} must be the public run-<uuid> form`);
      }
      assert.equal(rug.productEvidence.targetMoved[0].runId, B_MERGE_UUID.B1, "product event runId must be the bare uuid");
      assert.equal(park.productEvidence.parkLanding[0].runId, B_MERGE_UUID.B2, "product event runId must be the bare uuid");
      assert.notEqual(rug.productEvidence.targetMoved[0].runId, `run-${B_MERGE_UUID.B1}`, "event id and report id must differ in raw form");
    });

    it("accepts the engine's real B5-relaunch lineage, the legacy B5-with-relaunchOf shape, and a satisfied B-stopdel predicate", () => {
      // (a) Engine shape: deleted B5 + a separate parent-linked relaunch.
      const engineShape = syntheticGreenReport();
      let res = validateRehearsalEvidence({ campaignDir: "/tmp/storm-consistency-synthetic", state: { rounds: {} }, report: engineShape, checkFiles: false });
      assert.equal(res.ok, true, `engine-shaped B5 lineage must be accepted: ${JSON.stringify(res.issues)}`);

      // (b) Legacy: the B5 record itself carries the relaunch lineage.
      const legacy = syntheticGreenReport();
      legacy.rounds.B.runs = legacy.rounds.B.runs.filter((r: any) => r.rosterId !== "B5-relaunch");
      const legacyB5 = legacy.rounds.B.runs.find((r: any) => r.rosterId === "B5");
      legacyB5.terminalStatus = "completed";
      legacyB5.relaunchOf = "run-b-b5";
      legacyB5.runId = "run-b-b5-relaunched";
      res = validateRehearsalEvidence({ campaignDir: "/tmp/storm-consistency-synthetic", state: { rounds: {} }, report: legacy, checkFiles: false });
      assert.equal(res.ok, true, `legacy B5-with-relaunchOf must remain accepted: ${JSON.stringify(res.issues)}`);

      // (c) Older B-stopdel 'ok' predicate spelling, with no lineage record.
      const stopdelOk = syntheticGreenReport();
      stopdelOk.rounds.B.runs = stopdelOk.rounds.B.runs.filter((r: any) => r.rosterId !== "B5-relaunch");
      stopdelOk.rounds.B.phases.find((p: any) => p.id === "B-stopdel").waitOutcome = { outcome: "ok", observed: "B-stopdel" };
      res = validateRehearsalEvidence({ campaignDir: "/tmp/storm-consistency-synthetic", state: { rounds: {} }, report: stopdelOk, checkFiles: false });
      assert.equal(res.ok, true, `legacy B-stopdel 'ok' outcome must remain accepted: ${JSON.stringify(res.issues)}`);

      // (d) Current B-stopdel 'marker_satisfied' spelling alone, no lineage record.
      const stopdelMarker = syntheticGreenReport();
      stopdelMarker.rounds.B.runs = stopdelMarker.rounds.B.runs.filter((r: any) => r.rosterId !== "B5-relaunch");
      res = validateRehearsalEvidence({ campaignDir: "/tmp/storm-consistency-synthetic", state: { rounds: {} }, report: stopdelMarker, checkFiles: false });
      assert.equal(res.ok, true, `B-stopdel marker_satisfied must satisfy lineage: ${JSON.stringify(res.issues)}`);
    });

    it("refuses when Round A omits a roster id or an active run has no run id", () => {
      const report = syntheticGreenReport();
      report.rounds.A.runs = report.rounds.A.runs.filter((r: any) => r.rosterId !== "S3");
      report.rounds.A.runs.push({ ...syntheticRun("S7", ""), terminalStatus: "completed" });
      const res = validateRehearsalEvidence({ campaignDir: "/tmp/x", state: { rounds: {} }, report, checkFiles: false });
      assert.equal(res.ok, false);
      assert.ok(res.issues.some((i) => i.includes("omits roster entry S3")));
      assert.ok(res.issues.some((i) => i.includes("S7 has no run id")));
    });

    it("refuses when the 8-same-window observation or the 2 queue decisions are missing", () => {
      const report = syntheticGreenReport();
      report.simultaneity.eightConcurrentWindowObserved = false;
      report.queue.decisionCorrectness = null;
      report.queue.attempts = [];
      report.queue.s10Status = "not-planned";
      const res = validateRehearsalEvidence({ campaignDir: "/tmp/x", state: { rounds: {} }, report, checkFiles: false });
      assert.equal(res.ok, false);
      assert.ok(res.issues.some((i) => i.includes("8-concurrent window not observed")));
      assert.ok(res.issues.some((i) => i.includes("queue admission attempts < 2")));
      assert.ok(res.issues.some((i) => i.includes("queue decision missing")));
    });

    it("refuses when a Round B phase is missing or fired without predicate evidence", () => {
      const report = syntheticGreenReport();
      report.rounds.B.phases = report.rounds.B.phases.filter((p: any) => p.id !== "B-rugpull");
      report.rounds.B.phases.push({ id: "B-bounce", status: "done", firedAt: "2026-09-09T23:30:00Z", waitOutcome: null });
      const res = validateRehearsalEvidence({ campaignDir: "/tmp/x", state: { rounds: {} }, report, checkFiles: false });
      assert.equal(res.ok, false);
      assert.ok(res.issues.some((i) => i.includes("phase B-rugpull missing")));
      assert.ok(res.issues.some((i) => i.includes("phase B-bounce fired without a recorded predicate waitOutcome")));
    });

    it("refuses a non-zero token ledger and a green run relabelled into a non-green bucket", () => {
      const report = syntheticGreenReport();
      report.states.missing.push({ round: "A", rosterId: "S1", runId: "run-1-s1", status: "missing" });
      const state = { rounds: { A: { runs: { S1: { tokens: 17 } } }, B: { runs: {} } }, system_tokens: 3 };
      const res = validateRehearsalEvidence({ campaignDir: "/tmp/x", state, report, checkFiles: false });
      assert.equal(res.ok, false);
      assert.ok(res.issues.some((i) => i.includes("non-zero token value")));
      assert.ok(res.issues.some((i) => i.includes("both green and missing")));
    });

    it("refuses when B5 is deleted but no B5-relaunch record exists", () => {
      const report = syntheticGreenReport();
      report.rounds.B.runs = report.rounds.B.runs.filter((r: any) => r.rosterId !== "B5-relaunch");
      // No independent B-stopdel predicate either — nothing evidences the
      // identical stop/delete/relaunch.
      report.rounds.B.phases = report.rounds.B.phases.filter((p: any) => p.id !== "B-stopdel");
      const res = validateRehearsalEvidence({ campaignDir: "/tmp/x", state: { rounds: {} }, report, checkFiles: false });
      assert.equal(res.ok, false);
      assert.ok(
        res.issues.some((i) => i.includes("identical B5 stop/delete/relaunch not evidenced")),
        `expected B5-relaunch issue, got: ${JSON.stringify(res.issues)}`,
      );
    });

    it("refuses a fabricated B5-relaunch (missing runId, or B5 not terminal deleted)", () => {
      // (a) Parent-linked relaunch record with no run id — not a real relaunch.
      const noRunId = syntheticGreenReport();
      noRunId.rounds.B.runs.find((r: any) => r.rosterId === "B5-relaunch").runId = "";
      let res = validateRehearsalEvidence({ campaignDir: "/tmp/x", state: { rounds: {} }, report: noRunId, checkFiles: false });
      assert.equal(res.ok, false);
      assert.ok(
        res.issues.some((i) => i.includes("identical B5 stop/delete/relaunch not evidenced")),
        `fabricated no-runId relaunch must fail: ${JSON.stringify(res.issues)}`,
      );

      // (b) A completed parent-linked relaunch while B5 was never deleted is
      // self-contradictory — the deleted target is required.
      const notDeleted = syntheticGreenReport();
      notDeleted.rounds.B.runs.find((r: any) => r.rosterId === "B5").terminalStatus = "completed";
      res = validateRehearsalEvidence({ campaignDir: "/tmp/x", state: { rounds: {} }, report: notDeleted, checkFiles: false });
      assert.equal(res.ok, false);
      assert.ok(
        res.issues.some((i) => i.includes("identical B5 stop/delete/relaunch not evidenced")),
        `relaunch without a deleted B5 must fail: ${JSON.stringify(res.issues)}`,
      );

      // (c) US-008 no-op guard: a 'B5-relaunch' record that reuses the deleted
      // B5 record's OWN run id is an alias, not a distinct relaunch — the
      // shared isB5RelaunchLineage predicate must reject it.
      const aliased = syntheticGreenReport();
      const b5 = aliased.rounds.B.runs.find((r: any) => r.rosterId === "B5");
      aliased.rounds.B.runs.find((r: any) => r.rosterId === "B5-relaunch").runId = b5.runId;
      res = validateRehearsalEvidence({ campaignDir: "/tmp/x", state: { rounds: {} }, report: aliased, checkFiles: false });
      assert.equal(res.ok, false, "an aliased B5-relaunch run id must not satisfy the lineage gate");
      assert.ok(
        res.issues.some((i) => i.includes("identical B5 stop/delete/relaunch not evidenced")),
        `aliased B5-relaunch must fail: ${JSON.stringify(res.issues)}`,
      );
    });

    it("refuses a fired B-rugpull with no product target_moved evidence (the chaos action alone is not evidence)", () => {
      // The action ran ('fired') but the product never observed a moved merge
      // target: the phase record has no productEvidence at all.
      const missing = syntheticGreenReport();
      delete missing.rounds.B.phases.find((p: any) => p.id === "B-rugpull").productEvidence;
      let res = validateRehearsalEvidence({ campaignDir: "/tmp/x", state: { rounds: {} }, report: missing, checkFiles: false });
      assert.equal(res.ok, false);
      assert.ok(
        res.issues.some((i) => i.includes("B-rugpull") && i.includes("fired with no product evidence")),
        `a fired B-rugpull with no productEvidence must fail: ${JSON.stringify(res.issues)}`,
      );

      // A healthy channel that observed NO merge.target_moved (commit-only
      // rugpull) is equally invalid — the empty array is not evidence.
      const commitOnly = syntheticGreenReport();
      commitOnly.rounds.B.phases.find((p: any) => p.id === "B-rugpull").productEvidence = {
        phaseId: "B-rugpull", sinceUtc: "2026-09-09T22:00:00Z", runIds: ["run-b-b1"],
        ok: true, error: null, targetMoved: [], landed: [], parkLanding: [],
      };
      res = validateRehearsalEvidence({ campaignDir: "/tmp/x", state: { rounds: {} }, report: commitOnly, checkFiles: false });
      assert.equal(res.ok, false);
      assert.ok(
        res.issues.some((i) => i.includes("B-rugpull") && i.includes("without") && i.includes("merge.target_moved")),
        `a commit-only B-rugpull must fail: ${JSON.stringify(res.issues)}`,
      );
    });

    it("refuses a fired B-park with no park-landing evidence, and evidence for a non-targeted run", () => {
      const emptyLanding = syntheticGreenReport();
      emptyLanding.rounds.B.phases.find((p: any) => p.id === "B-park").productEvidence = {
        phaseId: "B-park", sinceUtc: "2026-09-09T22:02:00Z", runIds: ["run-b-b2"],
        ok: true, error: null, targetMoved: [], landed: [], parkLanding: [],
      };
      let res = validateRehearsalEvidence({ campaignDir: "/tmp/x", state: { rounds: {} }, report: emptyLanding, checkFiles: false });
      assert.equal(res.ok, false);
      assert.ok(
        res.issues.some((i) => i.includes("B-park") && i.includes("without") && i.includes("park-landing")),
        `a B-park with no park landing must fail: ${JSON.stringify(res.issues)}`,
      );

      // Park evidence for a FOREIGN run (not one of the B1..B4 merge targets)
      // does not prove the live merge target reacted.
      const foreignRun = syntheticGreenReport();
      foreignRun.rounds.B.phases.find((p: any) => p.id === "B-park").productEvidence = {
        phaseId: "B-park", sinceUtc: "2026-09-09T22:02:00Z", runIds: ["run-b-b2"],
        ok: true, error: null, targetMoved: [],
        landed: [{ event: "merge.landed", runId: "run-foreign-9999", checkoutRefresh: "parked:x" }],
        parkLanding: [{ event: "merge.landed", runId: "run-foreign-9999", checkoutRefresh: "parked:x" }],
      };
      res = validateRehearsalEvidence({ campaignDir: "/tmp/x", state: { rounds: {} }, report: foreignRun, checkFiles: false });
      assert.equal(res.ok, false);
      assert.ok(
        res.issues.some((i) => i.includes("B-park") && i.includes("without") && i.includes("park-landing")),
        `park evidence for a foreign run must fail: ${JSON.stringify(res.issues)}`,
      );
    });

    // SF-15 (fix-9): the consistency gate previously accepted ANY run-id-
    // matched parkLanding entry, so the exact attempt-9 no-op shape
    // (noop:true / checkoutRefresh 'already-coherent') satisfied a fired
    // B-park even though the product landed NOTHING and never parked. The
    // strict predicate now rejects every no-op shape and the issue names the
    // reason, so a red campaign's diagnostic is specific.
    it("refuses a fired B-park whose only targeted landing is a no-op/already-coherent (SF-15)", () => {
      const noopCases: Array<{ label: string; landing: any; token: RegExp }> = [
        {
          label: "noop:true + already-coherent (the attempt-9 NPF-1 shape)",
          landing: { event: "merge.landed", runId: B_MERGE_UUID.B2, ts: "2026-09-09T22:03:00Z", noop: true, checkoutRefresh: "already-coherent" },
          token: /already-coherent|noop/,
        },
        {
          label: "noop:true with no checkoutRefresh",
          landing: { event: "merge.landed", runId: B_MERGE_UUID.B2, ts: "2026-09-09T22:03:00Z", noop: true },
          token: /noop/,
        },
        {
          label: "noop:true that still carries a parked field (stale field must not re-admit)",
          landing: {
            event: "merge.landed", runId: B_MERGE_UUID.B2, ts: "2026-09-09T22:03:00Z",
            noop: true, checkoutRefresh: "parked:stale-backup", parkedBranch: "stale-backup", parkedReason: "local-changes",
          },
          token: /noop/,
        },
        {
          label: "refreshed in place (no parking action)",
          landing: { event: "merge.landed", runId: B_MERGE_UUID.B2, ts: "2026-09-09T22:03:00Z", noop: false, checkoutRefresh: "refreshed" },
          token: /refreshed/,
        },
        {
          label: "not-applicable (no attached checkout)",
          landing: { event: "merge.landed", runId: B_MERGE_UUID.B2, ts: "2026-09-09T22:03:00Z", noop: false, checkoutRefresh: "not-applicable" },
          token: /not-applicable/,
        },
      ];
      for (const c of noopCases) {
        const report = syntheticGreenReport();
        const bp = report.rounds.B.phases.find((p: any) => p.id === "B-park");
        bp.productEvidence = {
          phaseId: "B-park", sinceUtc: "2026-09-09T22:02:00Z", runIds: ["run-b-b2"],
          ok: true, error: null, targetMoved: [], landed: [c.landing], parkLanding: [c.landing],
        };
        const res = validateRehearsalEvidence({ campaignDir: "/tmp/x", state: { rounds: {} }, report, checkFiles: false });
        assert.equal(res.ok, false, `${c.label}: a no-op park landing must make the gate RED`);
        const issue = res.issues.find((i) => i.includes("B-park") && i.includes("park-landing"));
        assert.ok(issue, `${c.label}: expected a B-park park-landing issue, got: ${JSON.stringify(res.issues)}`);
        assert.ok(c.token.test(issue as string), `${c.label}: issue must name the no-op reason (${c.token}), got: ${issue}`);
        // A no-op landing must not be rescued by the targetMoved channel either.
        assert.ok(
          !res.issues.some((i) => i.includes("B-park") && i.includes("without")),
          `${c.label}: the targeted (but no-op) landing must be diagnosed as a no-op, not as missing evidence`,
        );
      }
    });

    it("accepts a non-noop parked landing carrying parkedBranch/parkedReason without checkoutRefresh (SF-15)", () => {
      const report = syntheticGreenReport();
      const bp = report.rounds.B.phases.find((p: any) => p.id === "B-park");
      const landing = {
        event: "merge.landed", runId: B_MERGE_UUID.B3, ts: "2026-09-09T22:03:00Z",
        noop: false, parkedBranch: "main-tamandua-parked-x", parkedReason: "local-changes",
      };
      bp.productEvidence = {
        phaseId: "B-park", sinceUtc: "2026-09-09T22:02:00Z", runIds: ["run-b-b3"],
        ok: true, error: null, targetMoved: [], landed: [landing], parkLanding: [landing],
      };
      const res = validateRehearsalEvidence({ campaignDir: "/tmp/storm-consistency-synthetic", state: { rounds: {} }, report, checkFiles: false });
      assert.equal(res.ok, true, `a non-noop parked landing must pass: ${JSON.stringify(res.issues)}`);
    });

    it("refuses product evidence whose channel is unavailable (ok:false), even for a fired chaos phase", () => {
      const unavailable = syntheticGreenReport();
      unavailable.rounds.B.phases.find((p: any) => p.id === "B-rugpull").productEvidence = {
        phaseId: "B-rugpull", sinceUtc: "2026-09-09T22:00:00Z", runIds: ["run-b-b1"],
        ok: false, error: "product events dir is missing/unreadable", targetMoved: [], landed: [], parkLanding: [],
      };
      const res = validateRehearsalEvidence({ campaignDir: "/tmp/x", state: { rounds: {} }, report: unavailable, checkFiles: false });
      assert.equal(res.ok, false);
      assert.ok(
        res.issues.some((i) => i.includes("B-rugpull") && i.includes("product-evidence channel unavailable")),
        `an unreadable evidence channel must fail: ${JSON.stringify(res.issues)}`,
      );
    });

    it("accepts a fully-shaped report carrying real productEvidence for B-rugpull and B-park", () => {
      const report = syntheticGreenReport();
      const res = validateRehearsalEvidence({ campaignDir: "/tmp/storm-consistency-synthetic", state: { rounds: {} }, report, checkFiles: false });
      assert.equal(res.ok, true, `fully-shaped product evidence must be accepted: ${JSON.stringify(res.issues)}`);
      const rug = report.rounds.B.phases.find((p: any) => p.id === "B-rugpull");
      const park = report.rounds.B.phases.find((p: any) => p.id === "B-park");
      assert.ok(rug.productEvidence.targetMoved.length > 0);
      assert.ok(park.productEvidence.parkLanding.length > 0);
      // SF-15 (fix-9): the green fixture's park landing must be a REAL parked
      // action (noop:false + the product's documented parked:<backup>).
      assert.equal(park.productEvidence.parkLanding[0].noop, false, "green park landing must be non-noop");
      assert.match(String(park.productEvidence.parkLanding[0].checkoutRefresh), /^parked:.+$/);
    });

    // SF-15 (fix-8): the exact bug attempt 8 shipped. The validator compared
    // the report's PUBLIC `run-<uuid>` ids to the product's BARE `<uuid>`
    // event ids with a raw Set.has, so every real event was dropped and a real
    // campaign read 0 evidence. This guard exercises BOTH directions and
    // asserts that raw exact-string matching would find nothing, so deleting
    // the canonicalization fails this suite.
    it("canonicalizes prefixed-vs-bare run ids in BOTH directions (raw exact-string matching cannot match)", () => {
      // (a) Real product shape: report ids PUBLIC `run-<uuid>`, event ids BARE.
      const prefixed = syntheticGreenReport();
      const rugA = prefixed.rounds.B.phases.find((p: any) => p.id === "B-rugpull");
      const parkA = prefixed.rounds.B.phases.find((p: any) => p.id === "B-park");
      assert.ok(rugA.productEvidence.targetMoved.some((e: any) => e.runId === B_MERGE_UUID.B1));
      const rawReportIds = new Set(prefixed.rounds.B.runs.map((r: any) => r.runId));
      assert.equal(
        rugA.productEvidence.targetMoved.filter((e: any) => rawReportIds.has(e.runId)).length,
        0,
        "raw exact match must drop the real product shape",
      );
      assert.equal(
        parkA.productEvidence.parkLanding.filter((e: any) => rawReportIds.has(e.runId)).length,
        0,
        "raw exact match must drop the real product shape",
      );
      let res = validateRehearsalEvidence({ campaignDir: "/tmp/storm-consistency-synthetic", state: { rounds: {} }, report: prefixed, checkFiles: false });
      assert.equal(res.ok, true, `prefixed report + bare event ids must be accepted: ${JSON.stringify(res.issues)}`);

      // (b) Reverse shape: report ids BARE `<uuid>`, event ids PUBLIC `run-<uuid>`.
      const bare = syntheticGreenReport();
      for (const rid of B_MERGE_TARGET_IDS) {
        bare.rounds.B.runs.find((r: any) => r.rosterId === rid).runId = B_MERGE_UUID[rid];
      }
      const rugB = bare.rounds.B.phases.find((p: any) => p.id === "B-rugpull");
      const parkB = bare.rounds.B.phases.find((p: any) => p.id === "B-park");
      rugB.productEvidence.targetMoved[0].runId = `run-${B_MERGE_UUID.B1}`;
      parkB.productEvidence.parkLanding[0].runId = `run-${B_MERGE_UUID.B2}`;
      const rawBareIds = new Set(bare.rounds.B.runs.map((r: any) => r.runId));
      assert.equal(
        rugB.productEvidence.targetMoved.filter((e: any) => rawBareIds.has(e.runId)).length,
        0,
        "raw exact match must drop the reverse shape",
      );
      res = validateRehearsalEvidence({ campaignDir: "/tmp/storm-consistency-synthetic", state: { rounds: {} }, report: bare, checkFiles: false });
      assert.equal(res.ok, true, `bare report + prefixed event ids must be accepted: ${JSON.stringify(res.issues)}`);
    });
  });

  describe("validatePendingCampaign (unapproved branch — truthful pending/readiness)", () => {
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
    function syntheticPendingState(campaignId: string, gateHashes: Record<string, string>): any {
      return {
        campaign_id: campaignId,
        mode: "prepared",
        qualification: { real_launch_allowed: false, note: "not-yet-qualified" },
        source: { commit: "c".repeat(40), tree: "t".repeat(40), tree_dirty: false },
        gate_hashes: gateHashes,
        rounds: {
          A: { status: "planned", runs: {}, phases: {} },
          B: { status: "planned", runs: {}, phases: {} },
        },
        report: null,
        daemon: null,
        cleanup: { ledger: [] },
        // US-006 reconciliation (fix-2 S5): every prepared campaign records the
        // scripted-runtime contract (behaviors file + private state dir) outside
        // the campaign dir.
        rehearsal: {
          scripted_runtime: {
            behaviors_file: path.join("/tmp", "tt-consistency-scripted", campaignId, "behaviors.json"),
            behaviors_sha256: "a".repeat(64),
            state_dir: path.join("/tmp", "tt-consistency-scripted-state", campaignId),
            agents: 3,
            agent_keys: ["a", "b", "c"],
            workflows: ["feature-dev-merge"],
          },
        },
      };
    }

    it("accepts a synthetic truthful pending campaign (no evidence, coherent hashes, absent approval)", () => {
      const id = "storm-consistency-pending-synthetic";
      const gh = computeGateHashes();
      const res = validatePendingCampaign({
        campaignDir: path.join("/tmp", id),
        state: syntheticPendingState(id, gh),
        descriptor: syntheticDescriptor(id),
        currentSourceCommit: "c".repeat(40),
        approvalFile: path.join("/tmp", "absent-approval-synthetic.json"),
      });
      assert.equal(res.ok, true, `unexpected issues: ${JSON.stringify(res.issues)}`);
      assert.ok(res.notes.some((n) => n.includes("not approved")));
    });

    it("refuses a prepared campaign that lacks the scripted-runtime contract (fix-2 S5)", () => {
      const id = "storm-consistency-pending-no-scripted";
      const gh = computeGateHashes();
      const state = syntheticPendingState(id, gh);
      delete state.rehearsal.scripted_runtime;
      const res = validatePendingCampaign({
        campaignDir: path.join("/tmp", id),
        state,
        descriptor: syntheticDescriptor(id),
        currentSourceCommit: "c".repeat(40),
        approvalFile: path.join("/tmp", "absent-approval-synthetic.json"),
      });
      assert.equal(res.ok, false);
      assert.ok(res.issues.some((i) => i.includes("state.rehearsal.scripted_runtime missing")), `expected scripted-runtime issue, got: ${JSON.stringify(res.issues)}`);
    });

    it("refuses a pending campaign whose scripted state dir lives inside the campaign dir", () => {
      const id = "storm-consistency-pending-scripted-inside";
      const gh = computeGateHashes();
      const state = syntheticPendingState(id, gh);
      state.rehearsal.scripted_runtime.state_dir = path.join("/tmp", id, "scripted-state");
      const res = validatePendingCampaign({
        campaignDir: path.join("/tmp", id),
        state,
        descriptor: syntheticDescriptor(id),
        currentSourceCommit: "c".repeat(40),
        approvalFile: path.join("/tmp", "absent-approval-synthetic.json"),
      });
      assert.equal(res.ok, false);
      assert.ok(res.issues.some((i) => i.includes("must not live inside the campaign dir")), `expected containment issue, got: ${JSON.stringify(res.issues)}`);
    });

    it("refuses a campaign that claims pending but carries run records", () => {
      const id = "storm-consistency-pending-fake-evidence";
      const gh = computeGateHashes();
      const state = syntheticPendingState(id, gh);
      state.rounds.A.runs = { S1: { rosterId: "S1", runId: "run-1" } };
      const res = validatePendingCampaign({
        campaignDir: path.join("/tmp", id),
        state,
        descriptor: syntheticDescriptor(id),
        currentSourceCommit: "c".repeat(40),
        approvalFile: path.join("/tmp", "absent-approval-synthetic.json"),
      });
      assert.equal(res.ok, false);
      assert.ok(res.issues.some((i) => i.includes("round A carries run records")));
    });

    it("refuses drift between state gate hashes and a fresh recompute", () => {
      const id = "storm-consistency-pending-drift";
      const gh = computeGateHashes();
      const state = syntheticPendingState(id, gh);
      state.gate_hashes = { ...gh, "torture-test/bin/tt-storm": "0".repeat(64) };
      const res = validatePendingCampaign({
        campaignDir: path.join("/tmp", id),
        state,
        descriptor: syntheticDescriptor(id),
        currentSourceCommit: "c".repeat(40),
        approvalFile: path.join("/tmp", "absent-approval-synthetic.json"),
      });
      assert.equal(res.ok, false);
      assert.ok(res.issues.some((i) => i.includes("hash mismatch")));
    });
  });

  describe("REAL campaigns under torture-test/var/results (host state)", () => {
    // Host state is OPTIONAL: the union worktree may hold no real storm-*
    // campaign (the US-003 prepared campaign lives in the rehearsal source
    // worktree, not in git). Validate host campaigns when present; when the
    // directory exists but carries none, honestly report SKIP rather than
    // failing for an out-of-band artifact. "Union of intent (torture-union
    // US-006)": mirrors tier0-core-recording-contract-publication's
    // host-evidence skip (f55e594e) and never weakens the validation below
    // when a real campaign IS present.
    const haveResultsRoot = fs.existsSync(resultsRoot);
    const stormCampaignNames = fs.existsSync(resultsRoot)
      ? fs.readdirSync(resultsRoot).filter((n) => isStormCampaignName(n) && fs.statSync(path.join(resultsRoot, n)).isDirectory())
      : [];

    it("every real storm-* campaign is either truthful-pending or evidence-valid", (t) => {
      if (stormCampaignNames.length === 0) {
        t.skip("no real storm-* campaign in this checkout's host state (the US-003 prepared campaign is out-of-band; not an artifact of this tree)");
        return;
      }
      const campaigns = stormCampaignNames.map((n) => path.join(resultsRoot, n));
      let pendingValidated = 0;
      let evidenceValidated = 0;
      for (const campaignDir of campaigns) {
        const stateFile = path.join(campaignDir, "state.json");
        const descriptorFile = path.join(campaignDir, DESCRIPTOR_NAME);
        const reportFile = path.join(campaignDir, STORM_RESULTS_DIR, STORM_REPORT_JSON);
        assert.ok(fs.existsSync(stateFile), `state.json missing for ${campaignDir}`);
        const state = loadJson(stateFile);
        const hasEvidence = fs.existsSync(reportFile);
        if (!hasEvidence) {
          const descriptor = fs.existsSync(descriptorFile) ? loadJson(descriptorFile) : null;
          const res = validatePendingCampaign({
            campaignDir,
            state,
            descriptor,
            currentSourceCommit,
            approvalFile,
          });
          assert.deepEqual(res.issues, [], `campaign ${campaignDir} is NOT truthful pending: ${JSON.stringify(res.issues)}`);
          pendingValidated += 1;
        } else {
          const report = loadJson(reportFile);
          const res = validateRehearsalEvidence({ campaignDir, state, report });
          assert.equal(res.ok, true, `campaign ${campaignDir} evidence invalid: ${JSON.stringify(res.issues)}`);
          evidenceValidated += 1;
        }
      }
      assert.ok(pendingValidated >= 1 || evidenceValidated >= 1, "validated at least one real campaign");
    });

    it("the prepared candidate campaign is byte-identical pending (mode prepared, qualification false, results empty)", (t) => {
      if (stormCampaignNames.length === 0) {
        t.skip("no real storm-* campaign in this checkout's host state");
        return;
      }
      const pending = stormCampaignNames
        .filter((n) => !fs.existsSync(path.join(resultsRoot, n, STORM_RESULTS_DIR, STORM_REPORT_JSON)));
      assert.ok(pending.length >= 1, "no pending campaign found");
      for (const n of pending) {
        const state = loadJson(path.join(resultsRoot, n, "state.json"));
        assert.equal(state.mode, "prepared");
        assert.equal(state.qualification?.real_launch_allowed, false);
        assert.equal(state.report, null);
        assert.equal(Object.keys(state.rounds?.A?.runs ?? {}).length, 0);
        assert.equal(Object.keys(state.rounds?.B?.runs ?? {}).length, 0);
        assert.equal(state.daemon ?? null, null);
        const resultsDir = path.join(resultsRoot, n, STORM_RESULTS_DIR);
        if (fs.existsSync(resultsDir)) {
          assert.deepEqual(fs.readdirSync(resultsDir), [], `results dir must stay empty for pending campaign ${n}`);
        }
        // campaign_id == basename
        assert.equal(state.campaign_id, n);
      }
    });

    it("the DESIGNATED pending candidate is truthful pending (SF-9: state.pending_candidate, then readiness-named, then any pending)", () => {
      if (!haveResultsRoot) return;
      const stormDirs = fs.readdirSync(resultsRoot).filter((n) => isStormCampaignName(n));
      if (stormDirs.length === 0) {
        // Fresh-worktree host state (see the sibling test above): no campaign
        // has been prepared yet, so there is no candidate to validate. Once a
        // storm-* campaign exists, a designated pending (unexecuted) campaign
        // MUST remain — this is the SF-9 gate the candidate satisfies.
        return;
      }
      const designated = validateDesignatedPendingCandidate({
        resultsRoot,
        // FIX-7 (US-009): fix7 locator first, then fix6, then fix5, then the
        // fix4 fallback; all are absent-tolerant, and the campaign's own
        // state.pending_candidate has precedence in discovery.
        readinessFiles: READINESS_LOCATOR_FILES,
        currentSourceCommit,
        approvalFile,
      });
      assert.equal(
        designated.ok,
        true,
        `no truthful designated pending candidate (selected=${designated.selected ?? "none"}, source=${designated.source ?? "none"}): ${JSON.stringify(designated.issues)}`,
      );
      assert.ok(designated.selected, "a designated pending candidate was located on disk");
      // The selected candidate is byte-identical pending: prepared, never
      // qualified, no run records / no daemon, empty results dir, and its
      // campaign_id equals its basename.
      const selectedDir = designated.selected as string;
      const state = loadJson(path.join(selectedDir, "state.json"));
      assert.equal(state.mode, "prepared");
      assert.equal(state.qualification?.real_launch_allowed, false);
      assert.equal(state.report, null);
      assert.equal(Object.keys(state.rounds?.A?.runs ?? {}).length, 0);
      assert.equal(Object.keys(state.rounds?.B?.runs ?? {}).length, 0);
      assert.equal(state.daemon ?? null, null);
      const resultsDir = path.join(selectedDir, STORM_RESULTS_DIR);
      if (fs.existsSync(resultsDir)) {
        assert.deepEqual(fs.readdirSync(resultsDir), [], `results dir must stay empty for pending candidate ${selectedDir}`);
      }
      assert.equal(state.campaign_id, path.basename(selectedDir));
    });

    it("every prepared campaign's state.plan.roundBPhases equals deriveScriptedHoldSchedule() (B-park/B-rugpull hold B1..B4, no early release)", () => {
      if (!haveResultsRoot) return;
      const stormDirs = fs.readdirSync(resultsRoot).filter((n) => isStormCampaignName(n));
      const prepared: string[] = [];
      for (const n of stormDirs) {
        const stateFile = path.join(resultsRoot, n, "state.json");
        if (!fs.existsSync(stateFile)) continue;
        let state: any;
        try {
          state = loadJson(stateFile);
        } catch {
          continue;
        }
        if (state?.mode !== "prepared") continue;
        // A REAL campaign keeps the authoritative (full) or reduced (lite)
        // Round B phase table, never the SCRIPTED_REHEARSAL derived hold
        // schedule. Assert its own non-empty table here; the scale-aware
        // roster contract is covered by the STORM-REAL self-tests.
        if (isRealProfile(state?.rehearsal?.profile)) {
          const realPhases = state?.plan?.roundBPhases ?? ROUND_B_PHASES;
          assert.ok(
            Array.isArray(realPhases) && realPhases.length > 0,
            `REAL campaign ${path.join(resultsRoot, n)} carries no Round B phase table`,
          );
          continue;
        }
        prepared.push(path.join(resultsRoot, n));
      }
      if (prepared.length === 0) return; // fresh-worktree host state: nothing prepared yet
      const derived = deriveScriptedHoldSchedule();
      for (const campaignDir of prepared) {
        const state = loadJson(path.join(campaignDir, "state.json"));
        assert.deepEqual(
          state.plan?.roundBPhases,
          derived.round_b.phases,
          `prepared campaign ${campaignDir} state.plan.roundBPhases must equal deriveScriptedHoldSchedule().round_b.phases`,
        );
        const byId = new Map<string, any>((state.plan.roundBPhases as any[]).map((p) => [p.id, p]));
        for (const id of ["B-park", "B-rugpull"]) {
          const ph = byId.get(id);
          assert.ok(ph, `${campaignDir} is missing derived phase ${id}`);
          assert.deepEqual(
            ph.waitFor?.targets,
            [...B_MERGE_TARGET_IDS],
            `${id} must derive its wait targets from the live merge targets B1..B4`,
          );
          assert.deepEqual(ph.release_targets, [], `${id} must not release its live merge targets`);
        }
        // B1..B4 are released ONLY at B-bounce; no earlier derived phase releases them.
        const bounce = byId.get("B-bounce");
        assert.ok(bounce, `${campaignDir} is missing derived phase B-bounce`);
        for (const rid of B_MERGE_TARGET_IDS) {
          assert.ok(bounce.release_targets.includes(rid), `B-bounce must release live merge target ${rid}`);
          for (const ph of state.plan.roundBPhases as any[]) {
            if (ph.id !== "B-bounce") {
              assert.ok(!ph.release_targets.includes(rid), `${ph.id} must not release ${rid} before B-bounce`);
            }
          }
        }
      }
    });
  });
});
