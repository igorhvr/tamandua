#!/usr/bin/env node
// tt-storm-real-readiness.mjs — STORM-REAL US-015 REAL pilot readiness.
//
// US-015 prepares a capacity-scaled REAL lite pilot campaign (a genuine
// --profile REAL --scale lite preparation with a same-profile designated
// pending candidate) and PUBLISHES a readiness artifact the coordinator
// follows to arm, approve and run the pilot — WITHOUT arming on a seed,
// approving, or starting any real round in this run.
//
// This module is the ONE place the readiness shape and its exact commands are
// built and validated:
//
//   * buildRealPilotReadiness({ state, descriptor, candidateState, ... }) is
//     PURE (no I/O, no spawning, no clock beyond an injected timestamp): it
//     projects a prepared REAL lite campaign's persisted identity into the
//     readiness document, including the exact arm/approve/run/report commands
//     the coordinator runs and the complete required approval contents.
//   * validateRealPilotReadiness(readiness) is PURE and fail-closed: it
//     refuses a readiness that is missing the campaign/profile/scale, names
//     the wrong approval path, omits a command, or claims a real round ran.
//   * buildRealPilotReadinessFromCampaign({ campaignDir }) is the thin I/O
//     runner that reads the prepared campaign (and its designated pending
//     candidate) from disk and validates the result.
//
// The JSON itself is the durable coordinator artifact; the campaign stays
// mode=prepared and qualification.real_launch_allowed=false. Nothing here
// arms, approves, or runs.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { DESCRIPTOR_NAME, computeGateHashes } from './tt-storm-rehearsal.mjs';
import { REAL, isRealProfile, labelForProfile } from './tt-storm-profile.mjs';
import { LITE, LITE_FIXTURE_NAME, scaleFromState } from './tt-storm-scale.mjs';
import { STORM_RESULTS_DIR, STORM_STATE_NAME } from './tt-storm-shared.mjs';

// The published readiness + the approval the coordinator is asked to issue.
// The pilot approval path is PILOT-SPECIFIC (never the shared
// storm-real-safety-approval.json): the pilot is a bounded, named campaign.
export const PILOT_READINESS_PATH = '/home/kaladin/matchlock-work/storm-real-pilot-readiness-0923.json';
export const PILOT_APPROVAL_PATH = '/home/kaladin/matchlock-work/storm-real-pilot-approval-0923.json';

// The seed-root is NOT known at US-015 time: the SEED-REGEN run (#79) owns the
// owned aged seed. The placeholder is carried verbatim into the arm command
// and must be filled by the coordinator from that run's recorded seed root.
export const SEED_ROOT_PLACEHOLDER = '<SEED_ROOT_FROM_SEED-REGEN_RUN_79>';
export const SEED_ROOT_SOURCE = 'SEED-REGEN run (#79) — the owned aged seed root it recorded';

export const PILOT_STORY = 'STORM-REAL-PROFILE';
export const PILOT_STEP_STORY = 'US-015';
export const PILOT_BEAD = 'tamandua-6sy.6.6';
export const PILOT_PARENT_BEAD = 'tamandua-6sy.6';

// The complete set of top-level keys a published readiness MUST carry. Kept
// explicit so validateRealPilotReadiness refuses a truncated document.
export const REQUIRED_READINESS_KEYS = Object.freeze([
  'kind',
  'story',
  'step_story',
  'profile',
  'scale',
  'campaign',
  'pending_candidate',
  'approval',
  'seed_root',
  'commands',
  'safety',
]);

// The complete approval contents the coordinator must issue for the pilot.
// These are exactly the fields the production verifyCoordinatorApproval
// requires (real_launch_allowed/campaign_id/source_commit/approval_kind/
// profile/gate_hashes) plus the readable identity fields it records.
export const REQUIRED_APPROVAL_FIELDS = Object.freeze([
  'approval_kind',
  'profile',
  'real_launch_allowed',
  'campaign_id',
  'source_commit',
  'source_tree',
  'gate_hash_files',
  'gate_hashes',
  'approved_by',
  'approved_at_utc',
  'note',
]);

function campaignStatePath(campaignDir) {
  return path.join(campaignDir, STORM_STATE_NAME);
}

function campaignDescriptorPath(campaignDir) {
  return path.join(campaignDir, DESCRIPTOR_NAME);
}

function readJson(absPath) {
  return JSON.parse(fs.readFileSync(absPath, 'utf8'));
}

// ─────────────────────────────────────────────────────────────────────
// Pure projection.
// ─────────────────────────────────────────────────────────────────────
export function buildRealPilotReadiness({
  state,
  descriptor,
  campaignDir,
  candidateState = null,
  publishedAtUtc,
  approvalPath = PILOT_APPROVAL_PATH,
  seedRootPlaceholder = SEED_ROOT_PLACEHOLDER,
  gateHashes = null,
} = {}) {
  if (!state || typeof state !== 'object') throw new Error('buildRealPilotReadiness requires a campaign state');
  if (!campaignDir || typeof campaignDir !== 'string') throw new Error('buildRealPilotReadiness requires a campaignDir');
  const profile = state.rehearsal?.profile ?? null;
  if (!isRealProfile(profile)) {
    throw new Error(`buildRealPilotReadiness requires a REAL campaign state (got ${JSON.stringify(profile)})`);
  }
  const scale = scaleFromState(state);
  if (scale !== LITE) {
    throw new Error(`buildRealPilotReadiness requires a LITE campaign state (got ${JSON.stringify(scale)})`);
  }
  const dbPath = state.exec_identity?.db_path ?? null;
  const cap = state.rehearsal?.spend_cap ?? null;
  if (!dbPath) throw new Error('REAL pilot campaign carries no exec_identity.db_path');
  if (!cap || !Number.isFinite(Number(cap.tokens)) || typeof cap.scope !== 'string') {
    throw new Error('REAL pilot campaign carries no persisted spend cap');
  }
  const entrypoint = descriptor?.authorized_rehearse?.entrypoint ?? 'tt-storm';
  const pending = state.pending_candidate ?? null;
  const pendingState = candidateState ?? null;
  const gateMap = gateHashes ?? computeGateHashes();
  const gateFiles = Object.keys(gateMap).sort();
  const campaignId = state.campaign_id;

  const armAgedState = `${entrypoint} arm aged-state --campaign ${campaignDir} --seed-root ${seedRootPlaceholder}`;
  const armSeedValidation = `${entrypoint} arm seed-validation --campaign ${campaignDir}`;
  const approve = `${entrypoint} approve --campaign ${campaignDir} --approval-file ${approvalPath}`;
  const runRound = (round) =>
    `${entrypoint} run --campaign ${campaignDir} --round ${round} --db ${dbPath} --spend-cap-tokens ${cap.tokens} --spend-cap-scope ${cap.scope} --detach`;
  const report = `${entrypoint} report --campaign ${campaignDir} --db ${dbPath}`;

  return {
    kind: 'storm-real-pilot-readiness',
    story: PILOT_STORY,
    step_story: PILOT_STEP_STORY,
    bead: PILOT_BEAD,
    parent_bead: PILOT_PARENT_BEAD,
    published_at_utc: publishedAtUtc ?? null,
    status:
      'READY_FOR_COORDINATOR_REVIEW — REAL lite pilot campaign prepared (tt-poly-lite fixture, same-profile designated pending candidate). NOT armed on a seed, NOT approved, NO real round started: the campaign stays mode=prepared with qualification.real_launch_allowed=false. Fill the seed-root placeholder from the SEED-REGEN run (#79), arm, issue the pilot approval, then run.',
    profile,
    label: descriptor?.label ?? labelForProfile(profile),
    scale,
    roster: descriptor?.roster ?? null,
    fixture: state.fixture?.name ?? null,
    expected_fixture: LITE_FIXTURE_NAME,
    source: {
      commit: state.source?.commit ?? null,
      tree: state.source?.tree ?? null,
      tree_dirty: state.source?.tree_dirty ?? null,
    },
    campaign: {
      id: campaignId,
      dir: campaignDir,
      state: campaignStatePath(campaignDir),
      descriptor: campaignDescriptorPath(campaignDir),
      db_path: dbPath,
      profile,
      scale,
      mode: state.mode ?? null,
      qualification: state.qualification ?? null,
      real_launch_allowed: state.qualification?.real_launch_allowed === true,
      rounds: {
        A: state.rounds?.A?.status ?? null,
        B: state.rounds?.B?.status ?? null,
      },
      run_records: {
        A: Object.keys(state.rounds?.A?.runs ?? {}).length,
        B: Object.keys(state.rounds?.B?.runs ?? {}).length,
      },
      report: state.report ?? null,
      results_dir: path.join(campaignDir, STORM_RESULTS_DIR),
      results_dir_empty: isResultsDirEmpty(path.join(campaignDir, STORM_RESULTS_DIR)),
      spend_cap: { tokens: cap.tokens, scope: cap.scope },
      active_cap: state.source?.active_cap ?? descriptor?.active_cap ?? null,
    },
    pending_candidate: {
      campaign_id: pending?.campaign_id ?? null,
      dir: pending?.dir ?? null,
      recorded_at: pending?.recorded_at ?? null,
      profile: pendingState?.rehearsal?.profile ?? null,
      scale: pendingState ? scaleFromState(pendingState) : null,
      mode: pendingState?.mode ?? null,
      real_launch_allowed: pendingState?.qualification?.real_launch_allowed === true,
    },
    spend_cap: { tokens: cap.tokens, scope: cap.scope, scope_note: 'total counts local-endpoint (cost 0) + paid tokens; the pilot must enforce its own share of the campaign cap' },
    approval: {
      path: approvalPath,
      required_contents: {
        approval_kind: 'coordinator',
        profile: REAL,
        real_launch_allowed: true,
        campaign_id: campaignId,
        source_commit: state.source?.commit ?? null,
        source_tree: state.source?.tree ?? null,
        gate_hash_files: gateFiles,
        gate_hashes: gateMap,
        approved_by: '<coordinator identity>',
        approved_at_utc: '<ISO-8601 UTC timestamp>',
        note: '<what the coordinator is approving and why>',
      },
      required_fields: [...REQUIRED_APPROVAL_FIELDS],
      currently_present: fs.existsSync(approvalPath),
    },
    seed_root: {
      placeholder: seedRootPlaceholder,
      source: SEED_ROOT_SOURCE,
      filled_from: null,
    },
    commands: {
      arm_aged_state: armAgedState,
      arm_seed_validation: armSeedValidation,
      approve,
      run: [runRound('A'), runRound('B')],
      report,
      note: 'Run the arm commands (replace the seed-root placeholder first), then approve with the pilot approval file, then run Round A and Round B. --detach keeps the observation loop alive past the operator ssh session.',
    },
    safety: {
      no_real_round_started: true,
      not_approved: state.qualification?.real_launch_allowed !== true,
      not_armed_on_seed: (state.arming ?? null) === null || Object.keys(state.arming ?? {}).length === 0,
      campaign_stays_prepared: state.mode === 'prepared',
      authority: 'campaign prepared on this tree; the live daemon / operator state were never touched',
    },
    gate_hash_files: gateFiles,
    gate_hashes_sha256: gateMap,
  };
}

function isResultsDirEmpty(resultsDir) {
  try {
    return fs.readdirSync(resultsDir).length === 0;
  } catch {
    return true;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Pure validation.
// ─────────────────────────────────────────────────────────────────────
export function validateRealPilotReadiness(readiness, { approvalPath = PILOT_APPROVAL_PATH } = {}) {
  const issues = [];
  const notes = [];
  if (!readiness || typeof readiness !== 'object') {
    return { ok: false, issues: ['readiness is not an object'], notes };
  }
  for (const key of REQUIRED_READINESS_KEYS) {
    if (!(key in readiness)) issues.push(`readiness is missing required key ${key}`);
  }
  if (readiness.kind !== 'storm-real-pilot-readiness') issues.push(`kind ${JSON.stringify(readiness.kind)} != storm-real-pilot-readiness`);
  if (readiness.profile !== REAL) issues.push(`profile ${JSON.stringify(readiness.profile)} != ${REAL}`);
  if (readiness.scale !== LITE) issues.push(`scale ${JSON.stringify(readiness.scale)} != ${LITE}`);
  if (readiness.expected_fixture !== LITE_FIXTURE_NAME) issues.push(`expected_fixture != ${LITE_FIXTURE_NAME}`);

  const c = readiness.campaign;
  if (!c || typeof c !== 'object') {
    issues.push('campaign missing/invalid');
  } else {
    if (typeof c.id !== 'string' || c.id.length === 0) issues.push('campaign.id missing');
    if (typeof c.dir !== 'string' || !path.isAbsolute(c.dir)) issues.push('campaign.dir must be absolute');
    if (c.profile !== REAL) issues.push(`campaign.profile ${JSON.stringify(c.profile)} != ${REAL}`);
    if (c.scale !== LITE) issues.push(`campaign.scale ${JSON.stringify(c.scale)} != ${LITE}`);
    if (c.mode !== 'prepared') issues.push(`campaign.mode ${JSON.stringify(c.mode)} != prepared`);
    if (c.real_launch_allowed === true) issues.push('campaign.real_launch_allowed === true but no round ran');
    if (c.report != null) issues.push('campaign.report populated but no round ran');
    if (c.run_records && (c.run_records.A !== 0 || c.run_records.B !== 0)) issues.push('campaign carries run records but no round ran');
    if (c.results_dir_empty !== true) issues.push('campaign.results_dir_empty must be true');
    if (!c.spend_cap || !Number.isFinite(Number(c.spend_cap.tokens)) || typeof c.spend_cap.scope !== 'string') {
      issues.push('campaign.spend_cap missing/invalid');
    }
  }

  const p = readiness.pending_candidate;
  if (!p || typeof p !== 'object') {
    issues.push('pending_candidate missing/invalid');
  } else {
    if (typeof p.campaign_id !== 'string' || p.campaign_id.length === 0) issues.push('pending_candidate.campaign_id missing');
    if (typeof p.dir !== 'string' || !path.isAbsolute(p.dir)) issues.push('pending_candidate.dir must be absolute');
    if (p.profile !== REAL) issues.push(`pending_candidate.profile ${JSON.stringify(p.profile)} != ${REAL} (same-profile candidate required)`);
    if (p.scale !== LITE) issues.push(`pending_candidate.scale ${JSON.stringify(p.scale)} != ${LITE} (same-scale candidate required)`);
    if (p.mode !== 'prepared') issues.push('pending_candidate.mode must be prepared');
    if (p.real_launch_allowed === true) issues.push('pending_candidate.real_launch_allowed must be false');
  }

  const a = readiness.approval;
  if (!a || typeof a !== 'object') {
    issues.push('approval missing/invalid');
  } else {
    if (a.path !== approvalPath) issues.push(`approval.path ${JSON.stringify(a.path)} != ${approvalPath}`);
    const contents = a.required_contents;
    if (!contents || typeof contents !== 'object') {
      issues.push('approval.required_contents missing');
    } else {
      for (const f of REQUIRED_APPROVAL_FIELDS) {
        if (!(f in contents)) issues.push(`approval.required_contents is missing ${f}`);
      }
      if (contents.profile !== REAL) issues.push(`approval.required_contents.profile ${JSON.stringify(contents.profile)} != ${REAL}`);
      if (contents.real_launch_allowed !== true) issues.push('approval.required_contents.real_launch_allowed must be true');
      if (typeof contents.campaign_id !== 'string' || contents.campaign_id.length === 0) issues.push('approval.required_contents.campaign_id missing');
      if (typeof contents.source_commit !== 'string' || contents.source_commit.length === 0) issues.push('approval.required_contents.source_commit missing');
      if (!contents.gate_hashes || typeof contents.gate_hashes !== 'object' || Object.keys(contents.gate_hashes).length === 0) {
        issues.push('approval.required_contents.gate_hashes must be a non-empty object');
      }
    }
  }

  const s = readiness.seed_root;
  if (!s || typeof s !== 'object' || typeof s.placeholder !== 'string' || s.placeholder.length === 0) {
    issues.push('seed_root.placeholder missing');
  }

  const cmds = readiness.commands;
  if (!cmds || typeof cmds !== 'object') {
    issues.push('commands missing/invalid');
  } else {
    for (const key of ['arm_aged_state', 'arm_seed_validation', 'approve', 'report']) {
      if (typeof cmds[key] !== 'string' || cmds[key].length === 0) issues.push(`commands.${key} missing`);
    }
    if (!Array.isArray(cmds.run) || cmds.run.length < 2) {
      issues.push('commands.run must name at least the A and B rounds');
    } else {
      for (const [idx, round] of ['A', 'B'].entries()) {
        const cmd = cmds.run[idx];
        if (typeof cmd !== 'string' || !cmd.includes(`--round ${round}`)) issues.push(`commands.run[${idx}] must name --round ${round}`);
        if (typeof cmd === 'string' && !cmd.includes('--spend-cap-tokens')) issues.push(`commands.run[${idx}] must name --spend-cap-tokens`);
      }
    }
    if (typeof cmds.arm_aged_state === 'string' && !cmds.arm_aged_state.includes('--seed-root')) {
      issues.push('commands.arm_aged_state must name --seed-root');
    }
    if (typeof cmds.arm_aged_state === 'string' && !cmds.arm_aged_state.includes(String(s?.placeholder ?? ''))) {
      issues.push('commands.arm_aged_state must carry the seed-root placeholder');
    }
    if (typeof cmds.approve === 'string' && !cmds.approve.includes(approvalPath)) {
      issues.push('commands.approve must name the pilot approval path');
    }
  }

  const safe = readiness.safety;
  if (!safe || typeof safe !== 'object') {
    issues.push('safety missing/invalid');
  } else {
    if (safe.no_real_round_started !== true) issues.push('safety.no_real_round_started must be true');
    if (safe.not_approved !== true) notes.push('safety.not_approved was not true at publication');
  }

  if (!Array.isArray(readiness.gate_hash_files) || readiness.gate_hash_files.length === 0) {
    issues.push('gate_hash_files must be a non-empty array');
  }
  return { ok: issues.length === 0, issues, notes };
}

// ─────────────────────────────────────────────────────────────────────
// I/O runner.
// ─────────────────────────────────────────────────────────────────────
export function readPreparedRealPilot({ campaignDir, fsx = fs } = {}) {
  const state = JSON.parse(String(fsx.readFileSync(campaignStatePath(campaignDir), 'utf8')));
  const descriptor = JSON.parse(String(fsx.readFileSync(campaignDescriptorPath(campaignDir), 'utf8')));
  let candidateState = null;
  const candidateDir = state?.pending_candidate?.dir ?? null;
  if (candidateDir) {
    try {
      candidateState = JSON.parse(String(fsx.readFileSync(path.join(candidateDir, STORM_STATE_NAME), 'utf8')));
    } catch {
      candidateState = null;
    }
  }
  return { state, descriptor, candidateState };
}

export function buildRealPilotReadinessFromCampaign({ campaignDir, publishedAtUtc, approvalPath = PILOT_APPROVAL_PATH, seedRootPlaceholder = SEED_ROOT_PLACEHOLDER, gateHashes = null } = {}) {
  const { state, descriptor, candidateState } = readPreparedRealPilot({ campaignDir });
  return buildRealPilotReadiness({ state, descriptor, campaignDir, candidateState, publishedAtUtc, approvalPath, seedRootPlaceholder, gateHashes });
}

export function writeRealPilotReadiness({ readiness, outPath = PILOT_READINESS_PATH, fsx = fs } = {}) {
  const dir = path.dirname(outPath);
  fsx.mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(readiness, null, 2) + '\n';
  fsx.writeFileSync(outPath, body);
  return { file: outPath, sha256: createHash('sha256').update(body, 'utf8').digest('hex') };
}

// A tiny CLI so the readiness can be regenerated deterministically:
//   node torture-test/bin/tt-storm-real-readiness.mjs --campaign <dir> [--out <path>]
export async function main(argv = process.argv.slice(2)) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--campaign') opts.campaign = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--approval') opts.approval = argv[++i];
    else if (a === '--seed-root-placeholder') opts.seedRootPlaceholder = argv[++i];
    else if (a === '--help' || a === '-h') {
      process.stdout.write('usage: tt-storm-real-readiness --campaign <dir> [--out <path>] [--approval <path>] [--seed-root-placeholder <s>]\n');
      return 0;
    }
  }
  if (!opts.campaign) {
    process.stderr.write('tt-storm-real-readiness requires --campaign <dir>\n');
    return 1;
  }
  const readiness = buildRealPilotReadinessFromCampaign({
    campaignDir: path.resolve(opts.campaign),
    publishedAtUtc: new Date().toISOString(),
    approvalPath: opts.approval ?? PILOT_APPROVAL_PATH,
    seedRootPlaceholder: opts.seedRootPlaceholder ?? SEED_ROOT_PLACEHOLDER,
  });
  const verdict = validateRealPilotReadiness(readiness, { approvalPath: opts.approval ?? PILOT_APPROVAL_PATH });
  if (!verdict.ok) {
    process.stderr.write(`readiness INVALID:\n${verdict.issues.map((i) => `  - ${i}`).join('\n')}\n`);
    return 1;
  }
  const written = writeRealPilotReadiness({ readiness, outPath: opts.out ?? PILOT_READINESS_PATH });
  process.stdout.write(`Pilot readiness: ${written.file}\n`);
  process.stdout.write(`  campaign: ${readiness.campaign.id} (${readiness.campaign.dir})\n`);
  process.stdout.write(`  profile/scale: ${readiness.profile}/${readiness.scale}\n`);
  process.stdout.write(`  pending candidate: ${readiness.pending_candidate.campaign_id} (${readiness.pending_candidate.profile}/${readiness.pending_candidate.scale})\n`);
  process.stdout.write(`  approval: ${readiness.approval.path}\n`);
  process.stdout.write(`  seed-root placeholder: ${readiness.seed_root.placeholder}\n`);
  process.stdout.write(`  commands: ${readiness.commands.arm_aged_state}\n`);
  process.stdout.write(`            ${readiness.commands.approve}\n`);
  for (const cmd of readiness.commands.run) process.stdout.write(`            ${cmd}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`${err?.message ?? String(err)}\n`);
    process.exit(1);
  });
}