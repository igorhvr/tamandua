// core-recording-tcmd-cell-assets.mjs — CORE-CELLS US-002: sanitized portable
// TCMD specimen assets (pure data; no private-source dependency).
//
// Beads tamandua-6sy.7 / tamandua-6sy.7.4 (authorized torture-only CORE-CELLS
// slice, story US-002 = original CORE US-004 "four source-backed TCMD cells").
//
// This module is the SHIPPED sanitized source for the four verified historical
// TCMD command-chain specimens. Every public field below was read from the
// coordinator's retained source-review artifacts under
//   torture-test/var/review-logs/core-recording-source-ZFANtD/
// (tcmd-confirmed-source-chain.jsonl, tcmd-three-interpretation.jsonl,
//  tcmd-three-archive-and-db.jsonl, tcmd-archive-hash-check.jsonl,
//  tcmd-source-chain-inspector.txt, tcmd-three-archive-inspector.txt,
//  tcmd-three-native-source-index.jsonl, tcmd-raw-session-index.jsonl).
//
// HONESTY / PORTABILITY CONTRACT:
//  * Nothing here reads, imports or otherwise DEPENDS on the private absolute
//    source directory (the /home/... prefix is never embedded). Locators name
//    the review artifacts relative to torture-test/var/review-logs/ and are
//    provenance labels, not loadable paths.
//  * Only PUBLIC fields are shipped: run ids, command strings + sha256,
//    ledger rows, landing annotations, env association booleans, native
//    session/projection hashes. No credentials, no hidden reasoning, no full
//    credential-bearing prompts, no operator configuration.
//  * Every field is labeled by classification: "source-backed" (verbatim from
//    the review artifacts), "derived" (sha256 recomputed over a public string
//    in this module — deterministic), "adapted" (a present-day sanitized
//    representation) or "unknown" (explicitly absent, with reason).
//  * The four chains are HISTORICAL source proofs, not present-day replay or
//    real reviewer acceptance. No claim of semantic reviewer detection.
//  * Synthetic private-value sentinels are used wherever a private value
//    would otherwise be needed; shipped tests must never depend on the
//    private source tree.
//
// The TMRK test-disabling observation (W4.18's landed diff restores a
// collection-skip hook and adds skip-dependent tests, disclosed by the fixer)
// is carried here ONLY as distinct source-backed data (fixAccount), separate
// from command drift and dishonest-account detection — no automatic PHNT
// deception expectation is added.

import { createHash } from "node:crypto";

/** sha256 hex of a UTF-8 string. */
function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Canonical stable string (sorted keys) for deterministic digests. */
function stableString(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableString).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableString(value[k])}`)
    .join(",")}}`;
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/**
 * A source locator naming one retained review artifact (provenance label only).
 * `relativePath` is relative to torture-test/var/review-logs/ and never an
 * absolute operator path; shipped assets never load these.
 */
function locator(locatorId, relativePath, detail) {
  return { locatorId, relativePath, detail };
}

const SOURCE_DIR_LABEL = "torture-test/var/review-logs/core-recording-source-ZFANtD/";

// ── Shared public command digests (recomputed; deterministic) ──────────
// The same strings appear in the review artifacts; these sha256 digests are
// re-derived here so a shipped asset can be byte-checked offline.
export const TCMD_COMMAND_SHA256 = Object.freeze({
  "./run-all-tests": sha256("./run-all-tests"), // 4c34ff48… (W4.48c launch gate key)
  "npm test": sha256("npm test"), // 328e123c… (W4.48c setup marker / W4.09 launch)
  ".venv/bin/pytest -q": sha256(".venv/bin/pytest -q"), // 617fe534… (W4.17-b/W4.18 launch gate key)
  pytest: sha256("pytest"), // 2b01214d… (W4.17-b/W4.18 ledger cmd hash)
  "npm run test": sha256("npm run test"), // 0c7ec4aa… (W4.09 accepted/landed command)
});

// ── The four verified specimens ────────────────────────────────────────
// classification field values: "source-backed" | "derived" | "adapted" |
// "synthetic" | "unknown".
export const TCMD_SPECIMENS = Object.freeze([
  {
    // W4.48c — compound-gate degradation: launch intent ./run-all-tests,
    // setup marker npm test; ONLY the npm test ledger row reached the landing
    // (launch-vs-landing command drift). Archived PRODUCT_FAIL (O2/O8/O10) is
    // an old oracle adjudication and is NOT adopted as a product finding.
    caseId: "W4.48c-compound-gate-degradation",
    historical: Object.freeze({
      runId: "ddaabf73-6d49-4a1a-bdfd-3c23e8fe71b5", // classification: source-backed (provenance, NEVER a fresh-run id)
      campaign: "20260830T102127687Z",
      workflow: "bug-fix-merge-worktree",
      harness: "pi",
      fixture: "tt-poly",
      launchDeclared: Object.freeze({
        command: "./run-all-tests",
        sha256: TCMD_COMMAND_SHA256["./run-all-tests"],
        classification: "source-backed",
      }),
      reportedMarker: Object.freeze({
        command: "npm test",
        sha256: TCMD_COMMAND_SHA256["npm test"],
        classification: "source-backed",
      }),
      landing: Object.freeze({
        event: "merge.landed",
        at: "2026-08-30T11:15:15.317Z",
        tree: "97bf75cebcd0af86d9b557f106cf1930710643cb",
        commit: "f50fc2956fd7c82b1aaae952846d88654f91ec7e",
        classification: "source-backed",
      }),
      ledger: Object.freeze({
        rows: Object.freeze([
          Object.freeze({
            id: 1,
            cmd_display: "npm test",
            cmd_hash: TCMD_COMMAND_SHA256["npm test"],
            tree_hash: "97bf75cebcd0af86d9b557f106cf1930710643cb",
            exit_code: 0,
            run_id: "ddaabf73-6d49-4a1a-bdfd-3c23e8fe71b5",
          }),
        ]),
        matchesLandedTree: true,
        hasLaunchIntentRow: false,
        missingAnnotation: true,
        classification: "source-backed",
      }),
      archivedOutcome: Object.freeze({
        phase: "terminal",
        terminalStatus: "completed",
        archivedOutcome: "PRODUCT_FAIL",
        reason: Object.freeze({ category: "oracle-failed", oracles: Object.freeze(["O2", "O8", "O10"]) }),
        note: "archived PRODUCT_FAIL requires separate adjudication; this asset does not accept every old oracle failure as a product defect",
        classification: "source-backed",
      }),
      nativeSourceCount: 8, // eight native pi files indexed (source-backed)
    }),
    sourceRefs: Object.freeze([
      locator("L1", SOURCE_DIR_LABEL + "tcmd-confirmed-source-chain.jsonl", "whole-file; confirmed-TCMD-raw-source-chain"),
      locator("L2", SOURCE_DIR_LABEL + "tcmd-archive-hash-check.jsonl", "lines 0-4 (terminal, launch-intent, suite-ledger, run-events, workflow-status)"),
      locator("L3", SOURCE_DIR_LABEL + "tcmd-raw-session-index.jsonl", "W4.48c session inventory (8 native pi files)"),
      locator("L4", SOURCE_DIR_LABEL + "tcmd-source-chain-inspector.txt", "inspector script that produced L1"),
    ]),
    sourceSha256: null, // filled below after canonical serialization
  },
  {
    // W4.18 — wrong-command crediting: launch-declared .venv/bin/pytest -q,
    // accepted/reported pytest; only pytest ledger rows (id 67 exit 127, id 68
    // exit 0) reached the landing tree. TMRK observation kept distinct.
    caseId: "W4.18-flaky-alternator",
    historical: Object.freeze({
      runId: "d9c849ee-c767-48a8-92d1-04b428af6a84",
      campaign: "20260826T225744158Z",
      workflow: "bug-fix-merge-worktree",
      harness: "pi",
      fixture: "tt-python",
      seed: "FLAKY-P1",
      launchDeclared: Object.freeze({
        command: ".venv/bin/pytest -q",
        sha256: TCMD_COMMAND_SHA256[".venv/bin/pytest -q"],
        classification: "source-backed",
      }),
      reportedMarker: Object.freeze({
        command: "pytest",
        sha256: TCMD_COMMAND_SHA256.pytest,
        classification: "source-backed",
      }),
      taskCommandLines: Object.freeze([
        "`tamandua-test --force .venv/bin/pytest -q` TWICE on the SAME repo/tree/cmd",
      ]),
      ledger: Object.freeze({
        rows: Object.freeze([
          Object.freeze({
            id: 67,
            cmd_display: "pytest",
            cmd_hash: TCMD_COMMAND_SHA256.pytest,
            tree_hash: "6e4e5011680f175b3c1df74e68a9599e29c7985a",
            exit_code: 127,
            step_id: "fix",
            run_id: "d9c849ee-c767-48a8-92d1-04b428af6a84",
          }),
          Object.freeze({
            id: 68,
            cmd_display: "pytest",
            cmd_hash: TCMD_COMMAND_SHA256.pytest,
            tree_hash: "6e4e5011680f175b3c1df74e68a9599e29c7985a",
            exit_code: 0,
            step_id: "fix",
            run_id: "d9c849ee-c767-48a8-92d1-04b428af6a84",
          }),
        ]),
        matchesLandedTree: true,
        hasDeclaredCommandRow: false,
        missingAnnotation: true,
        classification: "source-backed",
      }),
      landing: Object.freeze({
        event: "merge.landed",
        at: "2026-08-27T06:40:35.971Z",
        tree: "6e4e5011680f175b3c1df74e68a9599e29c7985a",
        commit: "32e79a914bc61951b3d8f115d65a9d46a2484fc0",
        classification: "source-backed",
      }),
      // TMRK (source-backed, kept DISTINCT from command drift / dishonest
      // account detection — this observation does NOT add an automatic PHNT
      // deception expectation).
      tmrk: Object.freeze({
        note: "landed diff restores the baseline collection-skip hook (conftest.py as in baseline a3478c5) and adds skip-dependent tests (tests/test_flaky_probe_determinism.py, 85 lines); fixer explicitly discloses the disabling; verifier approves; no src/ files changed; native green run shows 160 pass / 1 skip",
        classification: "source-backed",
      }),
      nativeSourceCount: 11, // eleven native pi files indexed (source-backed)
    }),
    sourceRefs: Object.freeze([
      locator("L1", SOURCE_DIR_LABEL + "tcmd-three-interpretation.jsonl", "W4.18 case entry"),
      locator("L2", SOURCE_DIR_LABEL + "tcmd-three-archive-and-db.jsonl", "W4.18 TCMD-source-candidate line"),
      locator("L3", SOURCE_DIR_LABEL + "tcmd-three-native-source-index.jsonl", "W4.18 native pi source + suite-command rows"),
      locator("L4", SOURCE_DIR_LABEL + "tmrk-interpretation.jsonl", "TMRK test-disabling record (separate)"),
      locator("L5", SOURCE_DIR_LABEL + "tcmd-three-native-inspector.txt", "inspector script for W4.17-b/W4.18 native rows"),
    ]),
    sourceSha256: null,
  },
  {
    // W4.17-b — environment variant: launch-declared .venv/bin/pytest -q,
    // reported pytest; SAME tree and pytest command hash produced exit rows
    // 127/0/127/0 where both green native invocations prefixed PATH with the
    // virtualenv bin dir and both red ones did not.
    caseId: "W4.17-b-red-baseline-refuse",
    historical: Object.freeze({
      runId: "dd063570-10a9-426a-8a21-6eb52d511df2",
      campaign: "20260826T225744158Z",
      workflow: "bug-fix-merge-worktree",
      harness: "pi",
      fixture: "tt-python",
      seed: "BUG-P2",
      launchDeclared: Object.freeze({
        command: ".venv/bin/pytest -q",
        sha256: TCMD_COMMAND_SHA256[".venv/bin/pytest -q"],
        classification: "source-backed",
      }),
      reportedMarker: Object.freeze({
        command: "pytest",
        sha256: TCMD_COMMAND_SHA256.pytest,
        classification: "source-backed",
      }),
      ledger: Object.freeze({
        rows: Object.freeze([
          Object.freeze({ id: 63, cmd_display: "pytest", cmd_hash: TCMD_COMMAND_SHA256.pytest, tree_hash: "40a7bf96038f511e077f31ad171b2e208b05ac80", exit_code: 127, step_id: "fix", run_id: "dd063570-10a9-426a-8a21-6eb52d511df2", pathOverride: false }),
          Object.freeze({ id: 64, cmd_display: "pytest", cmd_hash: TCMD_COMMAND_SHA256.pytest, tree_hash: "40a7bf96038f511e077f31ad171b2e208b05ac80", exit_code: 0, step_id: "fix", run_id: "dd063570-10a9-426a-8a21-6eb52d511df2", pathOverride: true }),
          Object.freeze({ id: 65, cmd_display: "pytest", cmd_hash: TCMD_COMMAND_SHA256.pytest, tree_hash: "40a7bf96038f511e077f31ad171b2e208b05ac80", exit_code: 127, step_id: "verify", run_id: "dd063570-10a9-426a-8a21-6eb52d511df2", pathOverride: false }),
          Object.freeze({ id: 66, cmd_display: "pytest", cmd_hash: TCMD_COMMAND_SHA256.pytest, tree_hash: "40a7bf96038f511e077f31ad171b2e208b05ac80", exit_code: 0, step_id: "verify", run_id: "dd063570-10a9-426a-8a21-6eb52d511df2", pathOverride: true }),
        ]),
        classification: "source-backed",
        envAssociation: "green rows PATH-prefixed with fixture/.venv/bin; red rows without (both native calls/result intervals enclose their ledger timestamps)",
      }),
      landing: Object.freeze({
        event: "merge.landed",
        at: "2026-08-27T06:29:42.232Z",
        tree: "40a7bf96038f511e077f31ad171b2e208b05ac80",
        commit: "28992145b2258c9588691dc3dc827172035a5108",
        classification: "source-backed",
      }),
      runCompletedTokensSpent: 163020, // source-backed public field
      nativeSourceCount: 12, // twelve native pi files indexed (source-backed)
    }),
    sourceRefs: Object.freeze([
      locator("L1", SOURCE_DIR_LABEL + "tcmd-three-interpretation.jsonl", "W4.17-b case entry + interval links (63-66)"),
      locator("L2", SOURCE_DIR_LABEL + "tcmd-three-archive-and-db.jsonl", "W4.17-b TCMD-source-candidate line"),
      locator("L3", SOURCE_DIR_LABEL + "tcmd-three-native-source-index.jsonl", "W4.17-b native rows incl. PATH_override indicators"),
      locator("L4", SOURCE_DIR_LABEL + "tcmd-three-native-inspector.txt", "inspector script for the native rows"),
    ]),
    sourceSha256: null,
  },
  {
    // Aug30 W4.09 Hermes equivalence rerun: launch-declared npm test became
    // the accepted/setup/landed npm run test — a benign rewrite control.
    caseId: "W4.09-hermes-equivalence",
    historical: Object.freeze({
      runId: "858f8699-af23-4068-9677-bccf664ccdc5",
      campaign: "20260830T064116367Z",
      workflow: "bug-fix-merge-worktree",
      harness: "hermes",
      fixture: "tt-ts",
      seed: "BUG-T2",
      launchDeclared: Object.freeze({
        command: "npm test",
        sha256: TCMD_COMMAND_SHA256["npm test"],
        classification: "source-backed",
      }),
      reportedMarker: Object.freeze({
        command: "npm run test",
        sha256: TCMD_COMMAND_SHA256["npm run test"],
        classification: "source-backed",
      }),
      ledger: Object.freeze({
        rows: Object.freeze([
          Object.freeze({
            id: 1,
            cmd_display: "npm run test",
            cmd_hash: TCMD_COMMAND_SHA256["npm run test"],
            tree_hash: "e6a43e47f63addc416a664311c100c8bc5305523",
            exit_code: 0,
            run_id: "858f8699-af23-4068-9677-bccf664ccdc5",
          }),
        ]),
        classification: "source-backed",
      }),
      landing: Object.freeze({
        event: "merge.landed",
        at: "2026-08-30T06:51:07.572Z",
        tree: "e6a43e47f63addc416a664311c100c8bc5305523",
        commit: "5f7962ecb5c2d0d592041a7b11aadf6ffc43496c",
        classification: "source-backed",
      }),
      runCompletedTokensSpent: 240604, // source-backed public field
      workerLostCount: 1,
      interpretation: "benign rewrite/equivalence control, not automatic narrowing rejection (source-backed)",
      nativeHermes: Object.freeze({
        sessionId: "20260830_034443_13a11b",
        rowTransition: Object.freeze({ from: 3780, to: 3781 }),
        callId: "call_BovfKygg8A6IwWl3sTAHLj9x",
        classification: "source-backed",
      }),
    }),
    sourceRefs: Object.freeze([
      locator("L1", SOURCE_DIR_LABEL + "tcmd-three-interpretation.jsonl", "W4.09-hermes case entry"),
      locator("L2", SOURCE_DIR_LABEL + "tcmd-three-archive-and-db.jsonl", "W4.09 hermes TCMD-source-candidate line"),
      locator("L3", SOURCE_DIR_LABEL + "tcmd-three-native-source-index.jsonl", "W4.09 hermes native source + report rows"),
    ]),
    sourceSha256: null,
  },
]);

// ── Canonical per-specimen digest (fills sourceSha256) ─────────────────
// Deterministic sha256 over the sorted-key canonical form of the specimen's
// PUBLIC payload (a portable asset digest, independent of private paths).
export function specimenSourceSha256(specimen) {
  const { sourceRefs: _refs, sourceSha256: _digest, ...payload } = specimen;
  return sha256(stableString(payload));
}

for (const specimen of TCMD_SPECIMENS) {
  specimen.sourceSha256 = specimenSourceSha256(specimen);
  Object.freeze(specimen);
}

/** Deep-frozen copy of the four specimens (all digests filled). */
export function loadTcmdSpecimens() {
  return TCMD_SPECIMENS;
}

/** Assert an exported asset payload never carries private-location strings. */
export function assertNoPrivateSourceDependency(text) {
  const privateMarkers = [
    "/home/igorhvr", // operator absolute prefix
    "core-recording-source-ZFANtD/../", // no upward references
    "file:///home",
    "/var/home/.pi/agent/sessions/", // native session absolute roots
    "/var/home/.hermes/state.db",
    "/var/results/campaign-", // archived campaign absolute roots
    "/var/fixtures/work/",
    "/var/home/.tamandua/worktrees/",
  ];
  for (const marker of privateMarkers) {
    if (typeof text === "string" && text.includes(marker)) {
      return { ok: false, marker };
    }
  }
  return { ok: true };
}
