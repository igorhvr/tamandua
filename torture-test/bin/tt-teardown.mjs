#!/usr/bin/env node
// tt-teardown.mjs — terminal-case working-clone teardown policy
//
// US-005 (E2.3). Spec 11 (schedule/budget/abort) and spec 12 (runner
// automation) are SILENT on whether a TERMINAL case's provisioned working
// clone (`var/fixtures/work/<case-id>/<fixture>`, created by
// tt-fixture-provision.mjs) should be retained as evidence or pruned after
// terminalization. This module is the single, EXPLICITLY DECLARED teardown
// policy for that offscreen surface — fail-closed by design: the decision is
// always RECORDED, and pruning only ever targets a real provisioned clone that
// has already been harvested.
//
// DECLARED TEARDOWN POLICY (see DECLARED_TEARDOWN_POLICY):
//   - PASSED case  -> PRUNE the working clone after oracle harvest. A passed
//     clone has already been harvested by the oracles; it carries only
//     deterministic arming junk and no failure forensics, so retaining it would
//     merely accumulate <case-count> full working clones under
//     var/fixtures/work/ across a campaign (roughly doubling the fixture
//     working set for zero evidentiary value).
//   - FAILED case  -> KEEP the working clone as failure-state evidence. A
//     failed case's working tree is ITSELF the evidence of its failure state
//     (the exact tree the harness ran against, including any dirt the agent
//     left behind in a never-finished run). Spec 11's
//     evidence-capture-before-destruction spirit says: never destroy evidence
//     that could explain a failure. Re-provisioning reconstructs the STARTING
//     tree, not the terminal failure state — keeping it is the only way a
//     post-mortem can inspect the real tree.
//
// Every decision (case id, terminal outcome, kept/pruned action, work clone
// path, teardown timestamp) is recorded and persisted to results/state.json by
// the controller (the case's `teardown` record) and surfaced in the campaign
// report (`RUN TEARDOWN` section + each row's `teardown`). Teardown only ever
// touches a clone that a case actually provisioned; NOT_RUN / pending-real /
// predicate-excluded cases that never provisioned a clone are left completely
// untouched (no record, no filesystem action).
//
// This is a standalone importable module AND a thin CLI (mirroring
// tt-fixture-provision.mjs / tt-golden-bootstrap.mjs). US-005 imports
// `applyTeardownPolicy` from here and invokes it from the controller's
// `markTerminal` (the single terminalization choke point), AFTER oracle
// harvest.
//
// Files only inside torture-test/.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);

// The single, authoritative statement of the teardown policy. Keeping it as a
// frozen exported constant makes the policy machine-readable (tests assert its
// content) and documents it at the point of application. Spec 11/12 are silent
// on working-clone retention, so this is the DECLARED choice the rest of the
// toolchain (state.json records + campaign report) reports against.
export const DECLARED_TEARDOWN_POLICY = Object.freeze({
  scope: 'var/fixtures/work/<case-id>/<fixture> (the provisioned real-case working clone)',
  basis: 'Spec 11 (schedule/budget/abort) and spec 12 (runner automation) are silent on '
    + 'terminal-case working-clone retention; US-005 adopts and declares this explicit policy.',
  passed_case: Object.freeze({
    action: 'prune',
    rationale: 'A harvested PASSED clone carries only deterministic arming junk and no '
      + 'failure forensics; retaining it would accumulate <case-count> full working clones '
      + 'under var/fixtures/work/ for zero evidentiary value.',
  }),
  failed_case: Object.freeze({
    action: 'keep',
    rationale: 'A FAILED case\'s working tree is itself the evidence of its terminal '
      + 'failure state (spec 11\'s evidence-capture-before-destruction: never destroy '
      + 'evidence that could explain a failure). Re-provisioning reconstructs the starting '
      + 'tree, not the failure state.',
  }),
  record_every_decision: true,
  record_location: 'results/state.json (<case>.teardown) + campaign report (RUN TEARDOWN section)',
  prunes_only_provisioned_clones: true,
});

// Which terminal outcomes prune vs keep. Only a clean PASS is pruned; every
// other terminal outcome (PRODUCT_FAIL, AGENT_FLAKE, PROVIDER_FAIL,
// TEST_INFRA_FAIL, INVALID, INCONCLUSIVE, NOT_RUN...) is kept as evidence.
// NOT_RUN cases are absent from the teardown sweep anyway (they never
// provisioned a clone), but the mapping is total and explicit so the policy is
// unambiguous about every outcome.
export function teardownDecision(outcome) {
  return outcome === 'PASS' ? 'prune' : 'keep';
}

// Apply the declared teardown policy to a single terminal case's provisioned
// working clone.
//
//   caseId:        the manifest case id (for the record).
//   outcome:       the case's terminal outcome (PASS -> prune, anything else
//                  -> keep).
//   workClonePath: the provisioned working clone path
//                  (var/fixtures/work/<case-id>/<fixture>). null/'' is legal
//                  and records a no-clone decision (nothing to prune/keep).
//
// Returns { ok:true, record } where `record` is the persisted teardown
// decision, or { ok:false, reason } for a caller bug (missing case id/outcome).
// This is deliberately safe and idempotent: pruning an already-missing clone is
// a no-op (force:true), and the record always reflects physical reality via
// `existed` / `pruned` / `kept`.
export function applyTeardownPolicy({ caseId, outcome, workClonePath }) {
  if (typeof caseId !== 'string' || caseId === '') {
    return { ok: false, reason: { category: 'teardown-case-unspecified', message: 'a case id is required' } };
  }
  if (typeof outcome !== 'string' || outcome === '') {
    return { ok: false, reason: { category: 'teardown-outcome-unspecified', message: 'a terminal outcome is required' } };
  }
  const hasClone = typeof workClonePath === 'string' && workClonePath !== '';
  const existed = hasClone && fs.existsSync(workClonePath);
  const action = teardownDecision(outcome);
  let pruned = false;
  if (existed && action === 'prune') {
    fs.rmSync(workClonePath, { recursive: true, force: true });
    pruned = !fs.existsSync(workClonePath);
  }
  const record = {
    case_id: caseId,
    outcome,
    action,
    kept: existed && action === 'keep',
    pruned,
    existed,
    work_clone_path: hasClone ? workClonePath : null,
    teardown_at: new Date().toISOString(),
  };
  return { ok: true, record };
}

// ── CLI entry ───────────────────────────────────────────────────────
function usage() {
  const out = [
    `Usage: tt-teardown --case-id <id> --outcome <outcome> [--work-clone-path <path>] [--json]`,
    ``,
    `Apply the declared terminal-case working-clone teardown policy (US-005).`,
    ``,
    `Policy (DECLARED_TEARDOWN_POLICY):`,
    `  - PASS   -> PRUNE the provisioned working clone (harvested; no forensics to keep).`,
    `  - others -> KEEP it as failure-state evidence.`,
    `Every decision is recorded. Only a provisioned clone is ever touched; a missing`,
    `clone is a no-op that is still recorded.`,
    ``,
    `Options:`,
    `  --case-id <id>         Case id for the teardown record.`,
    `  --outcome <outcome>    Terminal outcome; PASS prunes, anything else keeps.`,
    `  --work-clone-path <p>  Provisioned working clone path to prune/keep.`,
    `  --json                 Emit the JSON verdict on stdout (default).`,
    `  --help, -h             Print this help and exit.`,
    ``,
    `Exit codes: 0 = policy applied (decision recorded); 2 = usage error / caller bug.`,
  ];
  return out.join('\n');
}

function printJson(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function runCli(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--case-id') opts.caseId = argv[++i];
    else if (arg === '--outcome') opts.outcome = argv[++i];
    else if (arg === '--work-clone-path') opts.workClonePath = argv[++i];
    else if (arg === '--json') { /* default */ }
    else {
      printJson({ ok: false, usage_error: `unknown option: ${arg}`, hint: usage().split('\n')[0] });
      return 2;
    }
  }
  if (opts.caseId === undefined || opts.outcome === undefined) {
    printJson({
      ok: false,
      usage_error: '--case-id and --outcome are required',
      hint: usage().split('\n')[0],
    });
    return 2;
  }
  const result = applyTeardownPolicy(opts);
  printJson(result);
  return result.ok ? 0 : 2;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isCli) {
  process.exitCode = runCli(process.argv.slice(2));
}
