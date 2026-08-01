import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { OUTCOMES } from './tt-classification.mjs';

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
    || (item.outcome === 'NOT_RUN' && item.reason?.category !== 'predicate')
    || (item.oracle_results ?? []).some((result) =>
      result.status === 'TEST_INFRA'
        || (result.status === 'VALID' && result.response?.result === 'ERROR')));
}

export function verdictExitCode(state) {
  if (hasInfrastructureFailure(state)) return { verdict: 'INFRA_FAILURE', exitCode: 2 };
  const hasFinding = state.cases.some((item) =>
    !['PASS', 'NOT_RUN'].includes(item.outcome) || (item.findings ?? []).length > 0);
  return hasFinding
    ? { verdict: 'FINDINGS', exitCode: 1 }
    : { verdict: 'GREEN', exitCode: 0 };
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
  }));
  const outcomeTotals = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0]));
  for (const row of rows) outcomeTotals[row.outcome] += 1;
  const findings = rows.flatMap((row, index) => [
    ...row.findings.map((finding) => ({ case_id: row.id, ...finding })),
    ...oracleFindings(state.cases[index]),
  ]);
  const notRun = rows
    .filter((row) => row.outcome === 'NOT_RUN')
    .map((row) => ({ id: row.id, wave: row.wave, class: row.class, reason: clone(row.reason) }));
  const verdict = verdictExitCode(state);

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
    not_run: notRun,
    findings,
    verdict: verdict.verdict,
    exit_code: verdict.exitCode,
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

function findingSummary(finding) {
  const label = finding.oracle_id ?? finding.oracle ?? finding.type;
  const summary = finding.finding?.summary ?? finding.summary ?? finding.type;
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
    'VERDICT',
    `${report.verdict} (exit ${report.exit_code})`,
    '',
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
