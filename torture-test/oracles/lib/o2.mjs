import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  FindingCollector,
  OracleRuntimeError,
  openEvidenceDatabase,
  runGit,
  writeEvidenceJson,
} from './index.mjs';

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OracleRuntimeError(`${label} must be a JSON object`);
  }
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) throw new OracleRuntimeError(`${label} must be an array`);
  return value;
}

function readJson(file, label) {
  try {
    return object(JSON.parse(fs.readFileSync(file, 'utf8')), label);
  } catch (error) {
    if (error instanceof OracleRuntimeError) throw error;
    throw new OracleRuntimeError(`cannot parse ${label}: ${error.message}`, { cause: error });
  }
}

function canonicalRunId(value) {
  if (typeof value !== 'string' || value.length === 0) throw new OracleRuntimeError('run ID must be nonempty');
  return value.startsWith('run-') ? value : `run-${value}`;
}

function timestampMs(value, label) {
  if (typeof value !== 'string') throw new OracleRuntimeError(`${label} must be a timestamp`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new OracleRuntimeError(`${label} must be canonical UTC ISO-8601`);
  }
  return parsed.valueOf();
}

function requireOid(value, label) {
  if (typeof value !== 'string' || !OID.test(value)) throw new OracleRuntimeError(`${label} must be a lowercase git object ID`);
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readRefs(file, expectedPhase) {
  const artifact = readJson(file, `refs_${expectedPhase}`);
  if (artifact.schema_version !== 1 || artifact.phase !== expectedPhase) {
    throw new OracleRuntimeError(`refs_${expectedPhase} must be a version-1 ${expectedPhase} snapshot`);
  }
  const repository = object(artifact.repository, `refs_${expectedPhase}.repository`);
  if (typeof artifact.target_ref !== 'string' || !artifact.target_ref.startsWith('refs/')) {
    throw new OracleRuntimeError(`refs_${expectedPhase}.target_ref must be a full ref name`);
  }
  return {
    repository,
    target_ref: artifact.target_ref,
    target_tip: requireOid(artifact.target_tip, `refs_${expectedPhase}.target_tip`),
  };
}

function readReflog(file) {
  const artifact = readJson(file, 'target_reflog');
  if (artifact.schema_version !== 1) throw new OracleRuntimeError('target_reflog.schema_version must be 1');
  if (typeof artifact.target_ref !== 'string' || !artifact.target_ref.startsWith('refs/')) {
    throw new OracleRuntimeError('target_reflog.target_ref must be a full ref name');
  }
  return {
    repository: object(artifact.repository, 'target_reflog.repository'),
    target_ref: artifact.target_ref,
    entries: array(artifact.entries, 'target_reflog.entries').map((entry, index) => {
      const row = object(entry, `target_reflog.entries[${index}]`);
      if (typeof row.raw !== 'string') throw new OracleRuntimeError(`target_reflog.entries[${index}].raw must be a string`);
      if (row.old_oid === undefined || row.new_oid === undefined) return { ...row, parsed: false };
      return {
        ...row,
        old_oid: requireOid(row.old_oid, `target_reflog.entries[${index}].old_oid`),
        new_oid: requireOid(row.new_oid, `target_reflog.entries[${index}].new_oid`),
        parsed: true,
      };
    }),
  };
}

function readEvents(file) {
  const artifact = readJson(file, 'run_events');
  if (artifact.schema_version !== 1) throw new OracleRuntimeError('run_events.schema_version must be 1');
  return array(artifact.rows, 'run_events.rows').map((row, index) => {
    const wrapper = object(row, `run_events.rows[${index}]`);
    const event = object(wrapper.event, `run_events.rows[${index}].event`);
    return { ...event, evidence_index: index };
  });
}

function readLaunchIntent(file) {
  const artifact = readJson(file, 'launch_intent');
  if (artifact.schema_version !== 1) throw new OracleRuntimeError('launch_intent.schema_version must be 1');
  const policy = object(artifact.policy, 'launch_intent.policy');
  const gateKey = object(artifact.gate_key, 'launch_intent.gate_key');
  if (typeof gateKey.origin_repo !== 'string' || gateKey.origin_repo.length === 0) {
    throw new OracleRuntimeError('launch_intent.gate_key.origin_repo must be nonempty');
  }
  requireOid(gateKey.cmd_hash, 'launch_intent.gate_key.cmd_hash');
  return { policy, gate_key: gateKey, argv: array(artifact.argv, 'launch_intent.argv') };
}

function suiteRowShape(row, label) {
  const value = object(row, label);
  if (!Number.isInteger(value.id) || typeof value.origin_repo !== 'string') {
    throw new OracleRuntimeError(`${label} has invalid identity fields`);
  }
  requireOid(value.tree_hash, `${label}.tree_hash`);
  requireOid(value.cmd_hash, `${label}.cmd_hash`);
  if (!Number.isInteger(value.exit_code)) throw new OracleRuntimeError(`${label}.exit_code must be an integer`);
  return value;
}

function readSuiteLedger(file) {
  const artifact = readJson(file, 'suite_ledger');
  if (artifact.schema_version !== 1) throw new OracleRuntimeError('suite_ledger.schema_version must be 1');
  return array(artifact.rows, 'suite_ledger.rows')
    .map((row, index) => suiteRowShape(row, `suite_ledger.rows[${index}]`));
}

function readRuns(invocation) {
  const database = openEvidenceDatabase(invocation);
  try {
    const columns = new Set(database.prepare('PRAGMA table_info(runs)').all().map((row) => row.name));
    const missing = ['id', 'workflow_id', 'status', 'context'].filter((column) => !columns.has(column));
    if (missing.length > 0) throw new OracleRuntimeError(`runs snapshot lacks required columns: ${missing.join(', ')}`);
    const runs = database.prepare('SELECT id, workflow_id, status, context FROM runs ORDER BY id').all().map((row) => {
      let context;
      try { context = object(JSON.parse(row.context), `run ${row.id} context`); } catch (error) {
        if (error instanceof OracleRuntimeError) throw error;
        throw new OracleRuntimeError(`run ${row.id} context must be valid JSON`, { cause: error });
      }
      return { ...row, run_id: canonicalRunId(row.id), context };
    });
    const stepColumns = new Set(database.prepare('PRAGMA table_info(steps)').all().map((row) => row.name));
    const missingSteps = ['run_id', 'step_id', 'terminal_reroute_count']
      .filter((column) => !stepColumns.has(column));
    if (missingSteps.length > 0) throw new OracleRuntimeError(`steps snapshot lacks required columns: ${missingSteps.join(', ')}`);
    const steps = database.prepare(
      'SELECT run_id, step_id, terminal_reroute_count FROM steps ORDER BY run_id, step_id',
    ).all().map((row) => ({ ...row, run_id: canonicalRunId(row.run_id) }));
    const suiteColumns = new Set(database.prepare('PRAGMA table_info(suite_results)').all().map((row) => row.name));
    const missingSuite = ['id', 'origin_repo', 'tree_hash', 'cmd_hash', 'exit_code']
      .filter((column) => !suiteColumns.has(column));
    if (missingSuite.length > 0) throw new OracleRuntimeError(`suite_results snapshot lacks required columns: ${missingSuite.join(', ')}`);
    const suiteRows = database.prepare('SELECT * FROM suite_results ORDER BY id').all()
      .map((row, index) => suiteRowShape(row, `suite_results[${index}]`));
    return { runs, steps, suiteRows };
  } finally {
    database.close();
  }
}

function ensureExtractedTreeSafe(root, relative = '') {
  const current = path.join(root, relative);
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const childRelative = relative === '' ? entry.name : path.join(relative, entry.name);
    const child = path.join(root, childRelative);
    const details = fs.lstatSync(child);
    if (details.isSymbolicLink()) throw new OracleRuntimeError('git snapshot contains a symlink');
    if (details.isDirectory()) ensureExtractedTreeSafe(root, childRelative);
    else if (!details.isFile()) throw new OracleRuntimeError('git snapshot contains a non-regular entry');
  }
}

function ensureExtractedGitIsolation(root) {
  for (const relative of ['objects/info/alternates', 'objects/info/http-alternates', 'refs/replace']) {
    if (fs.existsSync(path.join(root, relative))) {
      throw new OracleRuntimeError(`git snapshot contains forbidden external-object mechanism ${relative}`);
    }
  }
}

function inspectGitSnapshotArchive(invocation) {
  const common = {
    cwd: invocation.campaignRoot,
    encoding: 'utf8',
    shell: false,
    timeout: 5000,
    maxBuffer: 8 * 1024 * 1024,
    env: { PATH: process.env.PATH, LC_ALL: 'C' },
  };
  const names = spawnSync('/usr/bin/tar', ['--list', '--file', invocation.evidencePaths.git_bundle], common);
  const verbose = spawnSync('/usr/bin/tar', ['--list', '--verbose', '--numeric-owner', '--file', invocation.evidencePaths.git_bundle], common);
  for (const result of [names, verbose]) {
    if (result.error !== undefined || result.status !== 0 || result.signal !== null) {
      const detail = result.error?.message ?? result.stderr?.trim() ?? result.signal ?? `exit ${result.status}`;
      throw new OracleRuntimeError(`cannot inspect git snapshot: ${detail}`);
    }
  }
  for (const name of names.stdout.split(/\r?\n/).filter(Boolean)) {
    const withoutPrefix = name.startsWith('./') ? name.slice(2) : name;
    const normalized = withoutPrefix.endsWith('/') ? withoutPrefix.slice(0, -1) : withoutPrefix;
    if (normalized === '') continue;
    if (path.posix.isAbsolute(normalized) || normalized.includes('\\')
        || normalized.split('/').some((segment) => segment === '' || segment === '..')) {
      throw new OracleRuntimeError('git snapshot contains an unsafe archive path');
    }
  }
  for (const line of verbose.stdout.split(/\r?\n/).filter(Boolean)) {
    if (!['-', 'd'].includes(line[0])) {
      throw new OracleRuntimeError('git snapshot archive may contain only regular files and directories');
    }
  }
}

function extractGitSnapshot(invocation) {
  inspectGitSnapshotArchive(invocation);
  const destination = path.join(invocation.evidenceDir, `.o2-git-${process.pid}`);
  fs.mkdirSync(destination, { mode: 0o700 });
  const result = spawnSync('/usr/bin/tar', [
    '--extract', '--file', invocation.evidencePaths.git_bundle, '--directory', destination,
    '--no-same-owner', '--no-same-permissions',
  ], {
    cwd: invocation.campaignRoot,
    encoding: 'utf8',
    shell: false,
    timeout: 5000,
    env: { PATH: process.env.PATH, LC_ALL: 'C' },
  });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) {
    fs.rmSync(destination, { recursive: true, force: true });
    const detail = result.error?.message ?? result.stderr?.trim() ?? result.signal ?? `exit ${result.status}`;
    throw new OracleRuntimeError(`cannot extract git snapshot: ${detail}`);
  }
  try {
    ensureExtractedTreeSafe(destination);
    ensureExtractedGitIsolation(destination);
    return destination;
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

function git(invocation, repository, args, options = {}) {
  return runGit({ campaignRoot: invocation.campaignRoot, repository, args, ...options });
}

function resolveCommit(invocation, repository, revision, label) {
  const value = git(invocation, repository, ['rev-parse', '--verify', `${revision}^{commit}`]).stdout.trim();
  return requireOid(value, label);
}

function resolveTree(invocation, repository, revision, label) {
  const value = git(invocation, repository, ['rev-parse', '--verify', `${revision}^{tree}`]).stdout.trim();
  return requireOid(value, label);
}

function patchId(invocation, repository, diff) {
  if (diff.trim() === '') return null;
  const output = git(invocation, repository, ['patch-id', '--stable'], { input: diff }).stdout.trim();
  if (output === '') return null;
  const id = output.split(/\s+/, 1)[0];
  return requireOid(id, 'git patch-id output');
}

function treeDiff(invocation, repository, oldRevision, newRevision) {
  return git(invocation, repository, [
    'diff-tree', '--no-commit-id', '--binary', '-p', oldRevision, newRevision,
  ]).stdout;
}

function targetPatchIds(invocation, repository, oldTip, newTip) {
  const commits = git(invocation, repository, ['rev-list', '--reverse', `${oldTip}..${newTip}`]).stdout
    .split(/\r?\n/).filter(Boolean).map((value) => requireOid(value, 'target range commit'));
  return commits.map((commit) => {
    const parents = git(invocation, repository, ['rev-list', '--parents', '-n', '1', commit]).stdout.trim().split(/\s+/);
    const parent = parents[1] ?? `${commit}^`;
    return { commit, patch_id: patchId(invocation, repository, treeDiff(invocation, repository, parent, commit)) };
  });
}

function eventRunId(event) {
  const value = event.runId ?? event.run_id;
  return typeof value === 'string' ? canonicalRunId(value) : null;
}

function eventShape(event, index) {
  return {
    index,
    run_id: eventRunId(event),
    target: event.target,
    branch: event.branch,
    expected_tip: requireOid(event.expectedTip, `merge.landed[${index}].expectedTip`),
    merged_commit: requireOid(event.mergedCommit, `merge.landed[${index}].mergedCommit`),
    merged_tree: requireOid(event.mergedTree, `merge.landed[${index}].mergedTree`),
    noop: event.noop === true,
    ts: event.ts,
    occurred_at_ms: timestampMs(event.ts, `merge.landed[${index}].ts`),
  };
}

function eventName(event) {
  return event.event ?? event.type;
}

function mechanicalEvent(event, index) {
  return {
    ...event,
    index,
    run_id: eventRunId(event),
    occurred_at_ms: timestampMs(event.ts, `${eventName(event)}[${index}].ts`),
  };
}

function exactGateRows(rows, gateKey, tree) {
  return rows.filter((row) => row.origin_repo === gateKey.origin_repo
    && row.tree_hash === tree && row.cmd_hash === gateKey.cmd_hash);
}

function sameSuiteRows(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sourceRef(branch, target) {
  if (typeof branch !== 'string' || branch.length === 0 || OID.test(branch)) {
    throw new OracleRuntimeError('merge.landed branch must identify a named source ref, not an object ID');
  }
  const normalized = branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch}`;
  const suffix = normalized.slice('refs/heads/'.length);
  if (!/^[A-Za-z0-9._/-]+$/.test(suffix)
      || suffix.startsWith('/') || suffix.endsWith('/') || suffix.endsWith('.lock')
      || suffix.includes('//') || suffix.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new OracleRuntimeError('merge.landed branch is not a safe captured branch ref');
  }
  return normalized === target ? null : normalized;
}

function add(findings, id, summary, runId, details = {}) {
  findings.add(id, summary, { run_id: runId, ...details });
}

export function evaluateO2(invocation) {
  const findings = new FindingCollector();
  const before = readRefs(invocation.evidencePaths.refs_before, 'before');
  const after = readRefs(invocation.evidencePaths.refs_after, 'after');
  const reflog = readReflog(invocation.evidencePaths.target_reflog);
  if (before.target_ref !== after.target_ref || before.target_ref !== reflog.target_ref) {
    throw new OracleRuntimeError('O2 target ref identity disagrees across ref and reflog snapshots');
  }
  if (!sameJson(before.repository, after.repository) || !sameJson(before.repository, reflog.repository)) {
    throw new OracleRuntimeError('O2 repository identity disagrees across git snapshots');
  }

  const databaseEvidence = readRuns(invocation);
  const runs = databaseEvidence.runs;
  const suiteRows = readSuiteLedger(invocation.evidencePaths.suite_ledger);
  if (!sameSuiteRows(databaseEvidence.suiteRows, suiteRows)) {
    throw new OracleRuntimeError('suite_ledger rows do not reconcile with the read-only database snapshot');
  }
  const launchIntent = readLaunchIntent(invocation.evidencePaths.launch_intent);
  const runIds = new Set([
    ...invocation.context.attempts.map((attempt) => attempt.run_id),
    ...invocation.context.discovered_runs.map((run) => run.run_id),
  ].filter(Boolean).map(canonicalRunId));
  const mergeRuns = runs.filter((run) => runIds.has(run.run_id) && run.workflow_id.includes('-merge'));
  if (mergeRuns.length === 0) throw new OracleRuntimeError('O2 context contains no merge-family run in the database snapshot');
  const mechanicalEvents = readEvents(invocation.evidencePaths.run_events)
    .map((event, index) => mechanicalEvent(event, index));
  const events = mechanicalEvents.filter((event) => eventName(event) === 'merge.landed')
    .map((event) => eventShape(event, event.index));
  const provenanceEvents = mechanicalEvents.filter((event) => [
    'merge.landed_without_suite_evidence', 'merge.gate_overridden', 'step.rerouted',
  ].includes(eventName(event)));
  const mergeRunIds = new Set(mergeRuns.map((run) => run.run_id));
  const allLandingEvents = events.filter((event) => !event.noop && event.run_id !== null && mergeRunIds.has(event.run_id));
  if (allLandingEvents.length > 1) {
    findings.add('O2_DUPLICATE_LANDING', 'captured merge run graph claimed one target transition more than once', {
      landing_count: allLandingEvents.length,
      run_ids: allLandingEvents.map((event) => event.run_id).sort(),
    });
  }
  if (before.target_tip !== after.target_tip && allLandingEvents.length === 0) {
    findings.add('O2_LANDING_EVENT_MISSING', 'target ref moved without one non-noop merge.landed event');
  }
  const extracted = extractGitSnapshot(invocation);
  const observations = [];

  try {
    resolveCommit(invocation, extracted, before.target_tip, 'preflight target commit');
    resolveCommit(invocation, extracted, after.target_tip, 'terminal target commit');
    const refMoved = before.target_tip !== after.target_tip;
    const baselineSeconds = Date.parse(invocation.context.mechanical_evidence.references.refs_before.captured_at) / 1000;
    const terminalSeconds = Date.parse(invocation.context.mechanical_evidence.references.target_reflog.captured_at) / 1000;
    const capturedTransitions = reflog.entries.filter((entry) => entry.parsed
      && entry.old_oid !== entry.new_oid
      && Number.isSafeInteger(entry.timestamp)
      && entry.timestamp >= baselineSeconds
      && entry.timestamp <= terminalSeconds);
    const matchingTransitions = reflog.entries.filter((entry) => entry.parsed
      && entry.old_oid === before.target_tip && entry.new_oid === after.target_tip && entry.old_oid !== entry.new_oid);
    const capturedMatchingTransitions = capturedTransitions.filter((entry) => entry.old_oid === before.target_tip
      && entry.new_oid === after.target_tip);

    for (const transition of capturedTransitions) {
      const owners = allLandingEvents.filter((event) => event.expected_tip === transition.old_oid
        && event.merged_commit === transition.new_oid);
      if (owners.length !== 1) {
        findings.add('O2_REF_TRANSITION_UNATTRIBUTED', 'raw target-ref transition does not map to exactly one captured run landing disposition', {
          old_oid: transition.old_oid,
          new_oid: transition.new_oid,
          owner_count: owners.length,
        });
      }
    }
    for (const landing of allLandingEvents) {
      const transitions = capturedTransitions.filter((entry) => entry.old_oid === landing.expected_tip
        && entry.new_oid === landing.merged_commit);
      if (transitions.length !== 1) {
        add(findings, 'O2_LANDING_TRANSITION_UNRECONCILED', 'merge.landed event does not map to exactly one raw target-ref transition', landing.run_id, {
          event_index: landing.index,
          transition_count: transitions.length,
        });
      }
    }

    for (const run of mergeRuns.sort((left, right) => left.run_id.localeCompare(right.run_id))) {
      const runEvents = events.filter((event) => event.run_id === run.run_id);
      const landingEvents = runEvents.filter((event) => !event.noop);
      const noopEvents = runEvents.filter((event) => event.noop);
      if (run.status === 'completed' && !refMoved) {
        add(findings, 'O2_PHANTOM_MERGE', 'completed merge-family run left the target ref unchanged', run.run_id, {
          target_ref: before.target_ref, target_tip: before.target_tip,
        });
      }
      if (landingEvents.length > 1) {
        add(findings, 'O2_DUPLICATE_LANDING', 'run claimed more than one non-noop target landing', run.run_id, {
          landing_count: landingEvents.length,
        });
      }
      if (refMoved && (capturedMatchingTransitions.length !== 1 || capturedTransitions.length !== 1)) {
        add(findings, 'O2_REF_TRANSITION_COUNT', 'target ref movement does not have exactly one matching raw-reflog transition', run.run_id, {
          matching_transition_count: matchingTransitions.length,
          captured_matching_transition_count: capturedMatchingTransitions.length,
          captured_transition_count: capturedTransitions.length,
          before: before.target_tip,
          after: after.target_tip,
        });
      }

      const landing = landingEvents[0];
      let testedTree = null;
      let commitTree = null;
      let sourcePatch = null;
      let targetPatches = [];
      let evidenceMode = null;
      let matchingSuiteRows = [];
      if (landing !== undefined) {
        if (run.status !== 'completed') {
          add(findings, 'O2_LANDED_RUN_NOT_COMPLETED', 'run moved the target but did not finish completed', run.run_id, {
            status: run.status,
          });
        }
        if (landing.target !== before.target_ref) {
          add(findings, 'O2_TARGET_IDENTITY_MISMATCH', 'merge event target differs from the captured target ref', run.run_id, {
            expected: before.target_ref, observed: landing.target,
          });
        }
        if (landing.expected_tip !== before.target_tip || landing.merged_commit !== after.target_tip) {
          add(findings, 'O2_REF_EVENT_MISMATCH', 'merge event commit transition differs from captured pre/post refs', run.run_id, {
            expected_old: before.target_tip, observed_old: landing.expected_tip,
            expected_new: after.target_tip, observed_new: landing.merged_commit,
          });
        }
        testedTree = run.context.tested_tree;
        if (typeof testedTree !== 'string' || !OID.test(testedTree)) {
          throw new OracleRuntimeError(`run ${run.run_id} context lacks a mechanical tested_tree attestation`);
        }
        if (landing.merged_tree !== testedTree) {
          add(findings, 'O2_TESTED_TREE_MISMATCH', 'merge event tree differs from the attested tested tree', run.run_id, {
            tested_tree: testedTree, merged_tree: landing.merged_tree,
          });
        }
        const runProvenance = provenanceEvents.filter((event) => event.run_id === run.run_id);
        const concessions = runProvenance.filter((event) => eventName(event) === 'merge.landed_without_suite_evidence');
        const overrides = runProvenance.filter((event) => eventName(event) === 'merge.gate_overridden');
        const gateKey = launchIntent.gate_key;
        matchingSuiteRows = exactGateRows(suiteRows, gateKey, landing.merged_tree);
        const provenanceMatchesKey = (event) => event.origin === gateKey.origin_repo
          && event.treeHash === landing.merged_tree && event.cmdHash === gateKey.cmd_hash;
        if (concessions.length > 0) {
          evidenceMode = 'default-concession';
          if (concessions.length !== 1 || concessions[0].gateMode !== 'default'
              || !provenanceMatchesKey(concessions[0])) {
            add(findings, 'O2_CONCESSION_PROVENANCE_INVALID', 'default concession lacks one exact-key landing provenance event', run.run_id, {
              concession_count: concessions.length,
            });
          }
          if (matchingSuiteRows.length !== 0) {
            add(findings, 'O2_CONCESSION_EXACT_KEY_ROW', 'default concession waived evidence despite an exact-key green/red suite row', run.run_id, {
              row_ids: matchingSuiteRows.map((row) => row.id),
            });
          }
          const finalizeSteps = databaseEvidence.steps.filter((step) => step.run_id === run.run_id
            && step.step_id === 'finalize_merge');
          const priorReroutes = runProvenance.filter((event) => eventName(event) === 'step.rerouted'
            && event.stepId === 'finalize_merge' && event.occurred_at_ms < landing.occurred_at_ms);
          if (finalizeSteps.length !== 1 || finalizeSteps[0].terminal_reroute_count !== 1
              || priorReroutes.length !== 1) {
            add(findings, 'O2_CONCESSION_REROUTE_INVALID', 'default concession does not have exactly one prior terminal finalize reroute', run.run_id, {
              finalize_step_count: finalizeSteps.length,
              terminal_reroute_count: finalizeSteps[0]?.terminal_reroute_count ?? null,
              prior_reroute_event_count: priorReroutes.length,
            });
          }
        } else if (launchIntent.policy.merge_gate === 'off' || overrides.length > 0) {
          evidenceMode = 'off';
          const argvBindsOff = launchIntent.argv.some((argument, index) => argument === '--context'
            && launchIntent.argv[index + 1] === 'merge_gate=off');
          if (launchIntent.policy.merge_gate !== 'off' || !argvBindsOff) {
            add(findings, 'O2_OFF_MODE_LAUNCH_UNBOUND', 'off-mode landing is not bound to captured manifest and launch argv intent', run.run_id);
          }
          if (overrides.length !== 1 || overrides[0].gateMode !== 'off'
              || overrides[0].occurred_at_ms >= landing.occurred_at_ms
              || !provenanceMatchesKey(overrides[0])) {
            add(findings, 'O2_OFF_MODE_PROVENANCE_INVALID', 'off-mode landing lacks one prior exact-key merge.gate_overridden event', run.run_id, {
              override_count: overrides.length,
            });
          }
        } else {
          evidenceMode = 'ordinary';
          if (matchingSuiteRows.length === 0) {
            add(findings, 'O2_SUITE_EVIDENCE_MISSING', 'ordinary landing lacks a green/red suite row for the exact origin, merged tree, and command hash', run.run_id, {
              origin_repo: gateKey.origin_repo,
              merged_tree: landing.merged_tree,
              cmd_hash: gateKey.cmd_hash,
            });
          }
        }
        commitTree = resolveTree(invocation, extracted, landing.merged_commit, 'merged commit tree');
        if (commitTree !== landing.merged_tree) {
          add(findings, 'O2_COMMIT_TREE_MISMATCH', 'merged commit tree differs from merge event mergedTree', run.run_id, {
            merged_commit: landing.merged_commit, commit_tree: commitTree, merged_tree: landing.merged_tree,
          });
        }
        const ancestry = git(invocation, extracted, ['merge-base', '--is-ancestor', landing.merged_commit, after.target_tip], {
          acceptedStatuses: [0, 1],
        });
        if (ancestry.status !== 0) {
          add(findings, 'O2_MERGED_COMMIT_NOT_ANCESTOR', 'merged commit is not an ancestor of the terminal target', run.run_id, {
            merged_commit: landing.merged_commit, target_tip: after.target_tip,
          });
        }
        const landingSourceRef = sourceRef(landing.branch, before.target_ref);
        if (landingSourceRef === null) {
          add(findings, 'O2_SOURCE_REF_INVALID', 'landing source ref aliases the target ref', run.run_id, {
            branch: landing.branch, target: before.target_ref,
          });
        } else {
          const branchCommit = resolveCommit(invocation, extracted, landingSourceRef, 'landing source branch');
          if (branchCommit === after.target_tip) {
            add(findings, 'O2_SOURCE_REF_INVALID', 'landing source ref resolves to the terminal target commit', run.run_id, {
              branch: landingSourceRef, target_tip: after.target_tip,
            });
          }
          const branchTree = resolveTree(invocation, extracted, branchCommit, 'landing source branch tree');
          if (branchTree !== landing.merged_tree) {
            add(findings, 'O2_SOURCE_TREE_MISMATCH', 'captured landing source branch tree differs from the attested merged tree', run.run_id, {
              branch: landingSourceRef, branch_tree: branchTree, merged_tree: landing.merged_tree,
            });
          }
        }
        sourcePatch = patchId(invocation, extracted, treeDiff(invocation, extracted, landing.expected_tip, landing.merged_tree));
        if (sourcePatch === null) {
          add(findings, 'O2_EMPTY_LANDING', 'non-noop landing source has an empty patch against the expected target tip', run.run_id, {
            branch: landing.branch, expected_tip: landing.expected_tip,
          });
        }
        targetPatches = targetPatchIds(invocation, extracted, landing.expected_tip, after.target_tip);
        if (sourcePatch !== null && !targetPatches.some((row) => row.patch_id === sourcePatch)) {
          add(findings, 'O2_PATCH_NOT_PRESENT', 'source branch patch-id is not byte-present in the terminal target history', run.run_id, {
            source_patch_id: sourcePatch,
            target_patch_ids: targetPatches.map((row) => row.patch_id).filter(Boolean),
          });
        }
      }

      for (const noop of noopEvents) {
        const priorLanding = allLandingEvents
          .filter((candidate) => candidate.occurred_at_ms < noop.occurred_at_ms)
          .sort((left, right) => right.occurred_at_ms - left.occurred_at_ms)[0];
        const validRecovery = priorLanding !== undefined
          && noop.target === before.target_ref
          && noop.expected_tip === priorLanding.merged_commit
          && noop.merged_commit === priorLanding.merged_commit
          && noop.merged_tree === priorLanding.merged_tree;
        if (!validRecovery) {
          add(findings, 'O2_INVALID_NOOP_RECOVERY', 'no-op observation is not a mechanically proven post-landing recovery', run.run_id, {
            event_index: noop.index,
          });
        }
      }

      observations.push({
        run_id: run.run_id,
        status: run.status,
        tested_tree: testedTree,
        ref_moved: refMoved,
        reflog_transition_count: matchingTransitions.length,
        captured_matching_reflog_transition_count: capturedMatchingTransitions.length,
        captured_reflog_transition_count: capturedTransitions.length,
        non_noop_landing_count: landingEvents.length,
        noop_recovery_count: noopEvents.length,
        source_patch_id: sourcePatch,
        target_patches: targetPatches,
        evidence_mode: evidenceMode,
        suite_row_ids: matchingSuiteRows.map((row) => row.id),
      });
    }
  } finally {
    fs.rmSync(extracted, { recursive: true, force: true });
  }

  const unknownEvents = events.filter((event) => event.run_id === null || !mergeRuns.some((run) => run.run_id === event.run_id));
  for (const event of unknownEvents) {
    findings.add('O2_LANDING_RUN_UNKNOWN', 'merge.landed event is not attributable to a captured merge-family run', {
      run_id: event.run_id, event_index: event.index,
    });
  }

  const evidence = [writeEvidenceJson(invocation, 'o2-merge-truth.json', {
    schema_version: 1,
    target_ref: before.target_ref,
    refs: { before: before.target_tip, after: after.target_tip },
    landings: observations,
  }, 'sqlite-events-git-plumbing')];
  if (findings.length > 0) {
    evidence.push(writeEvidenceJson(invocation, 'o2-raw-reflog-anomalies.json', {
      schema_version: 1,
      target_ref: reflog.target_ref,
      refs: { before: before.target_tip, after: after.target_tip },
      finding_ids: [...new Set(findings.toJSON().map((finding) => finding.id))].sort(),
      entries: reflog.entries.map(({ parsed, ...entry }) => entry),
    }, 'raw-reflog-anomaly-attribution'));
  }
  return { result: findings.length === 0 ? 'PASS' : 'FAIL', findings: findings.toJSON(), evidence };
}
