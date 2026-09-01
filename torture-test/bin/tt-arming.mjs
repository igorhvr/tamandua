// S42 (US-005) — fail-closed mandatory-arming gate.
//
// Campaign-20260826T225744158Z left both W4.17 arms VACUOUS: the task text
// and tier2-traceability promise a reset-hook arming overlay planting "2
// documented pre-existing red tests" into the tt-python fixture, but no such
// hook existed (cases/hooks/ carried only W4.26/28/30/31), no red baseline
// was ever planted, and the cases still produced verdicts from an unarmed
// premise. The controller's reset-hook machinery honors only DECLARED hooks,
// so the promise was never performed.
//
// This module implements the post-run fail-closed verification: when a case
// declares a MANDATORY arming block (`arming: {mandatory: true, ...}`) and
// the attempt reached terminal, a per-case arming manifest
// (var/arming/<case-id>.json — written by the arming reset hook AFTER it
// provably performed the arming) must exist and record the declared arming.
// If the manifest is absent, says `armed !== true`, or records a type/count
// that disagrees with the declaration, the attempt is classified
// TEST_INFRA_FAIL with the DISTINCT category 'arm-absent' naming the case/
// run/arming — never a silent vacuous verdict. The existing reset-failed
// semantics (hook missing/unrunnable at invocation time — exit non-zero /
// spawn error / missing executable) are untouched and take precedence: the
// hook was invoked and failed.
//
// Pure + dependency-free (node builtins only): imported by bin/tt-controller
// and exercised directly by self-tests/tier2-s42-w4.17-arming-hook.test.ts.
import fs from 'node:fs';
import path from 'node:path';

// The per-case arming manifest path: <varRoot>/arming/<case-id>.json. The
// hook's TT_ROOT is the same varRoot (env/tt-env.sh exports
// TT_ROOT=<repo>/torture-test/var), so the hook writes exactly this path.
export function armingManifestPath(varRoot, caseId) {
  return path.join(varRoot, 'arming', `${caseId}.json`);
}

// Read + parse the arming manifest. Returns the parsed object, or null when
// the manifest is missing, unreadable, or malformed — an unreadable/malformed
// manifest is EVIDENCE OF ABSENCE (fail closed), never a crash.
export function readArmingManifest(varRoot, caseId) {
  if (typeof varRoot !== 'string' || varRoot === '') return null;
  if (typeof caseId !== 'string' || caseId === '') return null;
  const manifestPath = armingManifestPath(varRoot, caseId);
  if (!fs.existsSync(manifestPath)) return null;
  let text;
  try {
    text = fs.readFileSync(manifestPath, 'utf8');
  } catch {
    return null;
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return null;
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
  return manifest;
}

// The S42 fail-closed gate. Returns the TEST_INFRA_FAIL reason object
// (category 'arm-absent') when the attempt must fail closed, or null when no
// arming obligation is violated.
//
// Fires ONLY when ALL of:
//   1. the case declares an `arming` block with `mandatory: true` (a
//      non-mandatory / absent declaration carries no obligation);
//   2. the attempt reached terminal (`atTerminal: true`, or phase/terminal_at
//      already set) — a run still in flight may yet be armed;
//   3. the per-case arming manifest is absent, or says `armed !== true`, or
//      records a type/count that disagrees with the declaration.
//
// `varRoot` is the contained torture-test var root (the controller passes
// VAR_ROOT = torture-test/var, the same root the hook's TT_ROOT resolves to).
export function armAbsentGate(caseRecord, attempt, options = {}) {
  const arming = caseRecord?.arming;
  if (arming === null || arming === undefined || typeof arming !== 'object') return null;
  if (arming.mandatory !== true) return null;

  const atTerminal = options.atTerminal === true
    || attempt?.phase === 'terminal'
    || attempt?.terminal_at !== undefined;
  if (!atTerminal) return null;

  const varRoot = options.varRoot;
  if (typeof varRoot !== 'string' || varRoot === '') return null;

  const caseId = caseRecord.id;
  const runId = attempt?.run_id;
  const manifest = readArmingManifest(varRoot, caseId);
  const reasonBase = {
    category: 'arm-absent',
    case_id: caseId,
    run_id: runId ?? null,
    arming_type: arming.type ?? null,
  };

  if (manifest === null) {
    return {
      ...reasonBase,
      message: `mandatory case ${caseId} declared arming ${JSON.stringify(arming)} but no arming manifest exists at ${armingManifestPath(varRoot, caseId)} — the mandated seed/arm was never performed (reset hook absent, unrunnable, or vacuous); refusing to produce a vacuous verdict for run ${runId ?? '?'}`,
      manifest: null,
      declared: arming,
    };
  }

  if (manifest.armed !== true) {
    return {
      ...reasonBase,
      message: `mandatory case ${caseId} declared arming ${JSON.stringify(arming)} but the arming manifest records armed=${JSON.stringify(manifest.armed)} — the mandated seed/arm was not completed; refusing to produce a vacuous verdict for run ${runId ?? '?'}`,
      manifest,
      declared: arming,
    };
  }

  if (typeof arming.type === 'string' && arming.type !== '' && manifest.type !== arming.type) {
    return {
      ...reasonBase,
      message: `mandatory case ${caseId} declared arming type '${arming.type}' but the arming manifest records type '${manifest.type ?? null}' — the wrong arming was performed; refusing to produce a vacuous verdict for run ${runId ?? '?'}`,
      manifest,
      declared: arming,
    };
  }

  if (Number.isSafeInteger(arming.count) && arming.count > 0 && manifest.count !== arming.count) {
    return {
      ...reasonBase,
      message: `mandatory case ${caseId} declared arming count ${arming.count} but the arming manifest records count ${JSON.stringify(manifest.count)} — the arming was not performed as declared; refusing to produce a vacuous verdict for run ${runId ?? '?'}`,
      manifest,
      declared: arming,
    };
  }

  return null;
}
