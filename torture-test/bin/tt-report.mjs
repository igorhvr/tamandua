import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { OUTCOMES } from './tt-classification.mjs';
import { isRunawayFinding, runawayFindingSubsumed } from './tt-subsumption.mjs';

const REAL_HARNESSES = new Set(['pi', 'hermes', 'dsh']);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function elapsedMs(startedAt, finishedAt) {
  const started = new Date(startedAt).valueOf();
  const finished = new Date(finishedAt).valueOf();
  return Number.isFinite(started) && Number.isFinite(finished)
    ? Math.max(0, finished - started)
    : 0;
}

function attemptWallMs(attempt) {
  return elapsedMs(attempt.started_at, attempt.terminal_at ?? attempt.finished_at);
}

function oracleFindings(caseState) {
  const findings = [];
  for (const result of caseState.oracle_results ?? []) {
    if (result.status === 'VALID' && ['FAIL', 'ERROR'].includes(result.response?.result)) {
      const responseFindings = result.response.findings ?? [];
      if (responseFindings.length === 0) {
        findings.push({
          type: `ORACLE_${result.response.result}`,
          case_id: caseState.id,
          oracle_id: result.oracle_id,
          attempt_id: result.attempt_id ?? null,
        });
      } else {
        for (const finding of responseFindings) {
          findings.push({
            type: `ORACLE_${result.response.result}`,
            case_id: caseState.id,
            oracle_id: result.oracle_id,
            attempt_id: result.attempt_id ?? null,
            finding: clone(finding),
          });
        }
      }
    } else if (result.status === 'TEST_INFRA') {
      findings.push({
        type: 'ORACLE_TEST_INFRA',
        case_id: caseState.id,
        oracle_id: result.oracle_id,
        attempt_id: result.attempt_id ?? null,
        errors: clone(result.errors ?? []),
      });
    }
  }
  return findings;
}

function hasInfrastructureFailure(state) {
  return state.cases.some((item) => item.outcome === 'TEST_INFRA_FAIL'
    // MACP3 US-006: host-profile-missing is infrastructure failure REGARDLESS
    // of how it was persisted — applyHostRequirements records it as
    // TEST_INFRA_FAIL, but a legacy/other-NOT_RUN encoding must not be
    // treated as a normal green skip either. Never a vacuous NOT_RUN.
    || item.reason?.category === 'host-profile-missing'
    || (item.outcome === 'NOT_RUN' && !['predicate', 'pending-real', 'host-profile-missing'].includes(item.reason?.category))
    || (item.oracle_results ?? []).some((result) =>
      result.status === 'TEST_INFRA'
        || (result.status === 'VALID' && result.response?.result === 'ERROR')));
}

function isRealHarness(harness) {
  return REAL_HARNESSES.has(harness);
}

function isRealMode(state) {
  // Real-mode intent is signalled by execution_selection 'all' (the controller
  // maps --include-real / no --scripted-only to 'all'; bare scripted-only runs
  // persist execution_selection 'scripted-only'). Bare mode therefore never
  // trips this check, preserving the pending-real GREEN semantics.
  return (state?.options?.execution_selection ?? 'all') === 'all';
}

// When an include-real campaign was requested, >0 real (pi/hermes/dsh) cases
// exist in the manifest, and yet zero real cases actually launched (every real
// case is terminal without any execution round — predicate-blocked or
// otherwise skipped), return a human-readable cause string. Otherwise return
// null. This is the fail-closed guard against a vacuous GREEN for a real
// campaign that ran nothing.
export function zeroRealLaunchesCause(state) {
  if (!isRealMode(state)) return null;
  const realCases = (state?.cases ?? []).filter((item) => isRealHarness(item.harness));
  if (realCases.length === 0) return null;
  const realLaunched = realCases.filter((item) => (item.attempts ?? []).length > 0).length;
  if (realLaunched > 0) return null;
  return `include-real requested but zero real cases launched (${realCases.length} real pi/hermes/dsh cases in manifest, execution_selection=all, but no real launch recorded)`;
}

// MACP3 US-008: bare-campaign vacuity guard — the bare-mode mirror of
// zeroRealLaunchesCause. A bare (execution_selection='scripted-only')
// campaign that contains at least one scripted case yet where ZERO scripted
// cells actually executed (every scripted case is terminal with zero
// attempts — predicate-skipped or otherwise) produced zero evidence and must
// never render a bare GREEN; that is the E2.2 vacuous-GREEN class resurfacing
// through the predicate path. 'executed' follows the existing attempt/outcome
// data model exactly as zeroRealLaunchesCause does for real mode: a scripted
// cell counts as executed iff its attempts array is non-empty. Legitimately
// evaluated predicate skips under a VALID loaded profile are still skips —
// with ZERO executions they yield a vacuous campaign (RED/FINDINGS); skips
// caused by host-profile-missing (US-006) are infra (already RED/INFRA) and
// take precedence via hasInfrastructureFailure. Returns a human-readable
// cause string, or null. Tier-agnostic: this is the single verdict chokepoint
// every bare campaign (tier0/1/2, smoke+dry-run) flows through.
export function bareVacuityCause(state) {
  if (isRealMode(state)) return null;
  const scriptedCases = (state?.cases ?? []).filter((item) => !isRealHarness(item.harness));
  if (scriptedCases.length === 0) return null;
  const scriptedExecuted = scriptedCases.filter((item) => (item.attempts ?? []).length > 0).length;
  if (scriptedExecuted > 0) return null;
  return `bare (scripted-only) campaign executed zero scripted cells (${scriptedCases.length} scripted cases in manifest, execution_selection=scripted-only, all skipped) — vacuous GREEN`;
}

export function verdictExitCode(state) {
  const failClosedCause = zeroRealLaunchesCause(state);
  if (failClosedCause !== null) return { verdict: 'INFRA_FAILURE', exitCode: 2 };
  if (hasInfrastructureFailure(state)) return { verdict: 'INFRA_FAILURE', exitCode: 2 };
  // MACP3 US-008: bare-campaign vacuity guard. An all-skipped bare campaign
  // must be RED (FINDINGS/exit 1) with an explicit vacuous-campaign finding,
  // never GREEN. INFRA (above) has precedence: a host-profile-missing or
  // other infrastructure failure is already RED/INFRA (exit 2) and explains
  // the failure precisely, so it must not be downgraded to a vacuity
  // FINDINGS. Real-mode behavior is untouched (bareVacuityCause returns null
  // unless execution_selection='scripted-only').
  const vacuityCause = bareVacuityCause(state);
  if (vacuityCause !== null) return { verdict: 'FINDINGS', exitCode: 1 };
  // FIX10 US-005: a hygiene-canary diff (operator-identity file changed
  // during the campaign) is a campaign-level FINDING — never silent.
  const hygieneDiffs = state?.hygiene_canary?.diffs;
  if (Array.isArray(hygieneDiffs) && hygieneDiffs.length > 0) {
    return { verdict: 'FINDINGS', exitCode: 1 };
  }
  const hasFinding = state.cases.some((item) =>
    !['PASS', 'NOT_RUN'].includes(item.outcome) || (item.findings ?? []).length > 0);
  return hasFinding
    ? { verdict: 'FINDINGS', exitCode: 1 }
    : { verdict: 'GREEN', exitCode: 0 };
}

function hygieneCanaryFiles(hygieneCanary) {
  if (Array.isArray(hygieneCanary.statuses)) return clone(hygieneCanary.statuses);
  // Fallback for states without a recorded verify (pre-verify or synthetic):
  // derive the per-file status from the before/after snapshots.
  const before = Array.isArray(hygieneCanary.before) ? hygieneCanary.before : [];
  const after = Array.isArray(hygieneCanary.after) ? hygieneCanary.after : [];
  const names = new Set([...before, ...after].map((entry) => entry?.name).filter(Boolean));
  const rows = [];
  for (const name of names) {
    const beforeEntry = before.find((entry) => entry.name === name);
    const afterEntry = after.find((entry) => entry.name === name);
    const beforeHash = beforeEntry?.hash ?? null;
    const afterHash = afterEntry?.hash ?? null;
    const beforePresent = beforeEntry?.present === true;
    const afterPresent = afterEntry?.present === true;
    const status = !beforePresent && !afterPresent
      ? 'ABSENT'
      : (beforePresent && afterPresent && beforeHash === afterHash) ? 'UNCHANGED' : 'CHANGED';
    rows.push({
      name,
      path: afterEntry?.path ?? beforeEntry?.path ?? null,
      before: beforeHash,
      after: afterHash,
      status,
    });
  }
  return rows;
}

export function buildCampaignReport(state) {
  if (!Array.isArray(state.cases) || state.cases.some((item) => item.phase !== 'terminal')) {
    throw new Error('cannot generate a campaign report before every manifest case is terminal');
  }
  if ((state.discovered_runs ?? []).some((run) => run.phase !== 'terminal')) {
    throw new Error('cannot generate a campaign report while a discovered run is nonterminal');
  }

  const discoveredByCase = new Map();
  for (const run of state.discovered_runs ?? []) {
    const linked = discoveredByCase.get(run.root_case_id) ?? [];
    linked.push(clone(run));
    discoveredByCase.set(run.root_case_id, linked);
  }
  const rows = state.cases.map((item) => ({
    id: item.id,
    wave: item.wave,
    class: item.class,
    workflow: item.workflow,
    fixture: item.fixture,
    harness: item.harness,
    outcome: item.outcome,
    reason: clone(item.reason ?? null),
    tokens_observed: item.spend?.tokens_observed ?? 0,
    wall_ms: item.attempts.reduce((total, attempt) => total + attemptWallMs(attempt), 0)
      + (discoveredByCase.get(item.id) ?? []).reduce((total, run) => total + attemptWallMs(run), 0),
    attempts: clone(item.attempts),
    discovered_runs: discoveredByCase.get(item.id) ?? [],
    oracle_results: clone(item.oracle_results ?? []),
    findings: clone(item.findings ?? []),
    teardown: clone(item.teardown ?? null),
  }));
  const outcomeTotals = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0]));
  for (const row of rows) outcomeTotals[row.outcome] += 1;
  const verdict = verdictExitCode(state);
  const failClosedCause = zeroRealLaunchesCause(state);
  const vacuityCause = bareVacuityCause(state);
  // MACP3 US-008: the vacuous-campaign finding is surfaced ONLY when it is the
  // operative fail-closed signal (the verdict is a non-INFRA FINDINGS). When an
  // infrastructure failure drives the verdict, INFRA FAILURES already names the
  // cause precisely and a vacuous-campaign finding would mislabel an
  // infra-failed campaign as 'vacuous'. Machine-parseable via
  // finding.category === 'vacuous-campaign'; case_id is null (campaign-level).
  const vacuousFinding = (vacuityCause !== null && verdict.verdict !== 'INFRA_FAILURE')
    ? [{
        type: 'VACUOUS_CAMPAIGN',
        category: 'vacuous-campaign',
        case_id: null,
        summary: vacuityCause,
        detected_at: state.updated_at,
      }]
    : [];
  const subsumedFindings = rows.flatMap((row) =>
    row.outcome === 'TEST_INFRA_FAIL'
      ? row.findings
          .filter((finding) => isRunawayFinding(finding))
          .map((finding) => ({
            case_id: row.id,
            ...finding,
            subsumed: true,
            subsumed_by: {
              outcome: 'TEST_INFRA_FAIL',
              category: row.reason?.category ?? null,
            },
          }))
      : [],
  );
  const findings = rows.flatMap((row, index) => [
    ...row.findings
      // S43c (US-008): classification precedence — TEST_INFRA_FAIL infra
      // classifications take precedence over RUNAWAY cap findings on the
      // same case (campaign-20260826T225744158Z: W4.dsh-bfmw classified
      // chaos-invocation-failed while report.txt's FINDINGS rendered the
      // run's wall_min RUNAWAY finding as if it were the cell's verdict).
      // A RUNAWAY finding on a TEST_INFRA_FAIL case is subsumed — derived
      // from outcome + type (never from the stored `subsumed` flag alone) so
      // legacy evidence reconciles identically — and rendered in the
      // SUBSUMED FINDINGS section instead of the standalone FINDINGS ledger.
      .filter((finding) => !runawayFindingSubsumed(finding, row.outcome))
      .map((finding) => ({ case_id: row.id, ...finding })),
    ...oracleFindings(state.cases[index]),
  ]);
  // MACP3 US-008: append the vacuous-campaign finding (when operative) so it
  // is listed in the campaign findings ledger exactly like any other finding.
  if (vacuousFinding.length > 0) findings.push(vacuousFinding[0]);
  const pendingReal = rows
    .filter((row) => row.outcome === 'NOT_RUN' && row.reason?.category === 'pending-real')
    .map((row) => ({ id: row.id, wave: row.wave, class: row.class, reason: clone(row.reason) }));
  const notRun = rows
    .filter((row) => row.outcome === 'NOT_RUN' && row.reason?.category !== 'pending-real')
    .map((row) => ({ id: row.id, wave: row.wave, class: row.class, reason: clone(row.reason) }));
  // MACP3 US-006: infra-failure ledger — every TEST_INFRA_FAIL row with its
  // actual reason (category + human-readable message/evidence). This is what
  // makes a host-profile-missing campaign surface its findings in the report
  // instead of merely exiting non-zero; the verdict alone never names the
  // affected cases. A valid-profile negative finding is a normal skip, never
  // this list.
  const infraFailures = rows
    .filter((row) => row.outcome === 'TEST_INFRA_FAIL')
    .map((row) => ({ id: row.id, wave: row.wave, class: row.class, reason: clone(row.reason) }));
  // US-005: the declared teardown ledger — every terminal-case working-clone
  // decision (case id, terminal outcome, kept/pruned action, timestamp).
  // Spec 11/12 are silent on working-clone retention, so this explicitly
  // declared policy and its per-case decisions are surfaced here for evidence.
  const teardown_decisions = rows
    .map((row) => row.teardown)
    .filter((dec) => dec !== null && dec !== undefined);

  return {
    version: 1,
    campaign: {
      id: state.campaign_id,
      created_at: state.created_at,
      completed_at: state.updated_at,
      manifest: clone(state.manifest),
      resume_count: state.resume_count ?? 0,
    },
    rows,
    discovered_runs: clone(state.discovered_runs ?? []),
    outcome_totals: outcomeTotals,
    spend: {
      tokens_observed: state.spend?.tokens_observed ?? 0,
      wall_ms: elapsedMs(state.created_at, state.updated_at),
      observations: clone(state.spend?.observations ?? []),
    },
    teardown_decisions,
    pending_real: pendingReal,
    not_run: notRun,
    infra_failures: infraFailures,
    findings,
    // S43c (US-008): subsumed RUNAWAY findings — the case-level RUNAWAY cap
    // findings filed on TEST_INFRA_FAIL cells while their runs were in
    // flight. The infra classification is the cell's ONE authoritative
    // verdict (documented precedence: TEST_INFRA_FAIL takes precedence over
    // RUNAWAY cap findings); these findings are preserved as evidence here
    // and in the report's SUBSUMED FINDINGS section, never as standalone
    // FINDINGS that read like the cell's verdict.
    subsumed_findings: subsumedFindings,
    // FIX10 US-005: O18-style operator-identity hygiene canary — per-file
    // before/after hashes and status (UNCHANGED/CHANGED/ABSENT) plus any
    // campaign-level HYGIENE_* diffs. Hashes only, never file contents.
    hygiene_canary: state.hygiene_canary === undefined || state.hygiene_canary === null
      ? null
      : {
          home: state.hygiene_canary.home ?? null,
          files: hygieneCanaryFiles(state.hygiene_canary),
          diffs: state.hygiene_canary.diffs ?? [],
          verified_at: state.hygiene_canary.verified_at ?? null,
        },
    verdict: verdict.verdict,
    exit_code: verdict.exitCode,
    fail_closed: {
      triggered: failClosedCause !== null,
      cause: failClosedCause,
    },
    // MACP3 US-008: bare-campaign vacuity guard ledger — the machine-parseable
    // counterpart of fail_closed but for execution_selection='scripted-only'
    // (bare) campaigns: a bare GREEN requires at least one scripted cell to
    // actually EXECUTE; all-scripted-skipped is FINDINGS (exit 1) with a
    // 'vacuous-campaign' finding. triggered is true only when the guard is the
    // operative fail-closed signal (an infra failure takes precedence and is
    // reported via infra_failures instead).
    vacuity: {
      triggered: vacuousFinding.length > 0,
      cause: vacuityCause,
    },
  };
}

function table(rows) {
  const headings = ['CASE', 'WAVE', 'CLASS', 'OUTCOME', 'TOKENS', 'WALL'];
  const values = rows.map((row) => [
    row.id, String(row.wave), row.class, row.outcome,
    String(row.tokens_observed), formatDuration(row.wall_ms),
  ]);
  const widths = headings.map((heading, index) => Math.max(
    heading.length,
    ...values.map((row) => row[index].length),
  ));
  const line = (row) => row.map((value, index) => value.padEnd(widths[index])).join('  ').trimEnd();
  return [line(headings), line(widths.map((width) => '-'.repeat(width))), ...values.map(line)].join('\n');
}

function formatDuration(milliseconds) {
  const wholeMinutes = Math.floor(milliseconds / 60_000);
  const seconds = ((milliseconds % 60_000) / 1000).toFixed(3);
  return `${wholeMinutes}m ${seconds}s`;
}

function reasonSummary(reason) {
  if (reason === null || reason === undefined) return 'unspecified';
  return reason.category ?? JSON.stringify(reason);
}

// MACP3 US-006: human-readable infra-failure summary. Includes the
// category and, when present, the human-readable reason.message (e.g. the
// underlying host-profile load error) so the rendered report clearly names
// the infrastructure defect instead of only a bare category token.
function infraReasonSummary(reason) {
  const summary = reasonSummary(reason);
  const message = reason?.message;
  const evidence = reason?.evidence;
  const extras = [
    ...(typeof message === 'string' && message.length > 0 ? [message] : []),
    ...(Array.isArray(evidence) && evidence.length > 0 ? [JSON.stringify(evidence)] : []),
  ];
  return extras.length === 0 ? summary : `${summary} (${extras.join('; ')})`;
}

function findingSummary(finding) {
  const label = finding.oracle_id ?? finding.oracle ?? finding.type;
  const summary = finding.finding?.summary ?? finding.summary ?? finding.type;
  // MACP3 US-008: campaign-level findings (e.g. VACUOUS_CAMPAIGN) have no
  // owning case — render them without a case prefix so the category label is
  // unambiguous.
  if (finding.case_id === undefined || finding.case_id === null) return `${label} - ${summary}`;
  return `${finding.case_id}: ${label} - ${summary}`;
}

export function renderCampaignReport(report) {
  const totals = OUTCOMES.map((outcome) => `${outcome}=${report.outcome_totals[outcome]}`).join('  ');
  return [
    'TAMANDUA TORTURE-TEST CAMPAIGN REPORT',
    `Campaign: ${report.campaign.id}`,
    `Manifest: ${report.campaign.manifest.path}`,
    `Created: ${report.campaign.created_at}`,
    `Completed: ${report.campaign.completed_at}`,
    '',
    'SCENARIO OUTCOMES',
    table(report.rows),
    `Totals: ${totals}`,
    '',
    'SPEND LEDGER',
    `Tokens observed: ${report.spend.tokens_observed}`,
    `Wall spend: ${formatDuration(report.spend.wall_ms)}`,
    '',
    'PENDING_REAL',
    ...(report.pending_real.length === 0
      ? ['(none)']
      : report.pending_real.map((item) => `- ${item.id}: ${reasonSummary(item.reason)}`)),
    '',
    'RUN TEARDOWN (US-005)',
    ...(report.teardown_decisions.length === 0
      ? ['(no provisioned working clones — nothing to teardown)']
      : report.teardown_decisions.map((dec) =>
          `- ${dec.case_id}: outcome=${dec.outcome} action=${dec.action} kept=${dec.kept} pruned=${dec.pruned} @ ${dec.teardown_at}`)),
    '',
    'NOT_RUN',
    ...(report.not_run.length === 0
      ? ['(none)']
      : report.not_run.map((item) => `- ${item.id}: ${reasonSummary(item.reason)}`)),
    '',
    'FINDINGS',
    ...(report.findings.length === 0
      ? ['(none)']
      : report.findings.map((finding) => `- ${findingSummary(finding)}`)),
    '',
    // S43c (US-008): classification precedence — a RUNAWAY cap finding on a
    // TEST_INFRA_FAIL cell is a downstream artifact of the infra failure and
    // is rendered here, explicitly subsumed by the authoritative
    // TEST_INFRA_FAIL classification (never a standalone FINDINGS entry that
    // reads like the cell's verdict).
    'SUBSUMED FINDINGS',
    ...(report.subsumed_findings.length === 0
      ? ['(none)']
      : report.subsumed_findings.map((finding) =>
          `- ${findingSummary(finding)} (subsumed by ${finding.subsumed_by.outcome} ${finding.subsumed_by.category ?? '?'})`)),
    '',
    'INFRA FAILURES',
    ...(report.infra_failures.length === 0
      ? ['(none)']
      : report.infra_failures.map((item) => `- ${item.id}: ${infraReasonSummary(item.reason)}`)),
    '',
    'HYGIENE CANARY',
    ...(report.hygiene_canary === null || report.hygiene_canary === undefined
      ? ['(no hygiene canary state — campaign predates FIX10 US-005)']
      : [
          `Home: ${report.hygiene_canary.home ?? '(unresolved)'}`,
          ...report.hygiene_canary.files.map((file) =>
            `- ${file.name}: ${file.status} (before=${file.before ?? 'absent'}, after=${file.after ?? 'absent'})`),
          ...(report.hygiene_canary.diffs.length === 0
            ? ['- operator identity files unchanged']
            : report.hygiene_canary.diffs.map((diff) =>
                `- FINDING ${diff.type}: ${diff.file ?? diff.name ?? '?'} changed (before=${diff.before ?? 'absent'}, after=${diff.after ?? 'absent'})`)),
        ]),
    '',
    'VERDICT',
    `${report.verdict} (exit ${report.exit_code})`,
    ...(report.fail_closed?.triggered && report.fail_closed.cause
      ? [`Cause: ${report.fail_closed.cause}`, '']
      : ['']),
  ].join('\n');
}

function atomicWrite(directory, filename, content) {
  const destination = path.join(directory, filename);
  const temporary = path.join(directory, `.${filename}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, destination);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export function writeCampaignReports(campaignDir, state) {
  const report = buildCampaignReport(state);
  atomicWrite(campaignDir, 'report.json', `${JSON.stringify(report, null, 2)}\n`);
  atomicWrite(campaignDir, 'report.txt', renderCampaignReport(report));
  const directoryDescriptor = fs.openSync(campaignDir, 'r');
  try {
    fs.fsyncSync(directoryDescriptor);
  } finally {
    fs.closeSync(directoryDescriptor);
  }
  return report;
}
