// core-recording-rvoc-rcnt-cell-assets.mjs — CORE-CELLS US-004: sanitized
// portable RVOC + RCNT specimen assets (pure data; no private-source
// dependency).
//
// Beads tamandua-6sy.7 / tamandua-6sy.7.4 (authorized torture-only CORE-CELLS
// slice, story US-004 = original CORE US-006 "RVOC recovery and RCNT
// class-specific budgets").
//
// Two source-backed specimens are shipped here:
//
//   RVOC — W4.10-kill-daemon, run 59e8e12c-2a7e-438d-aa48-6a3b99abb750
//     (campaign 20260901T121246549Z-9ef7d11f-f464-4800-80af-11af436ff457,
//     workflow bug-fix-merge-worktree). Two successful same-row fixer
//     claims surround step.worker_lost in the archived event stream
//     (all.jsonl 6114 -> 6116 -> 6117). There was NO dedicated
//     step.respawned in the archived stream — but the worker_lost recovery
//     event DID exist and is acknowledged as the connecting event. Current
//     product behavior emits step.respawned AFTER the recovery event.
//
//   RCNT — W4.10-restart-recovery, run f60941b9-6b36-403d-9730-2c7805c8eb7b
//     (campaign 20260830T074704018Z-210fdc36-d450-47f4-be4f-f3b72780bf8c).
//     Native merger output "STATUS: retry" + "REBASED: true" identifies an
//     ORDINARY rebase reroute; the archived finalize_merge row shows
//     reroute_count 1 / terminal_reroute_count 0 and the run completed and
//     landed. The old all-reroutes-equal-terminal oracle equality rule was
//     WRONG; class-specific counters are the control.
//
// HONESTY / PORTABILITY CONTRACT:
//  * Nothing here reads, imports or DEPENDS on the private absolute source
//    directory (torture-test/var/review-logs/core-recording-source-ZFANtD/).
//    Locators name the review artifacts relative to
//    torture-test/var/review-logs/ and are provenance labels, not loadable
//    paths.
//  * Only PUBLIC fields ship: run ids, archived artifact sha256s, event
//    rows/timestamps, step-row counters, public claim-command/result
//    digests, the recorded reroute tool-result text. No credentials, no
//    hidden reasoning, no operator configuration, no full credential-bearing
//    prompts.
//  * Every field is labeled by classification: "source-backed" (verbatim
//    from the review artifacts), "derived" (recomputed over a public string
//    in this module — deterministic), "adapted" (a present-day sanitized
//    representation) or "synthetic" (an explicit present-day reproduction
//    that is NOT the captured historical behavior).
//  * NO claim anywhere asserts that a dedicated "step.respawned" event
//    existed historically, and NO claim anywhere asserts that "there was no
//    connecting event": step.worker_lost existed and is acknowledged.
//  * NO all-reroutes-equal-terminal equality rule is encoded here or in the
//    cell tests; the RCNT fossil is preserved as a control against that
//    erroneous old oracle rule.
//  * No real credentials/provider/network are ever exercised; the fresh
//    corridors are zero-token scripted producers.

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
 * A source locator naming one retained review artifact (provenance label
 * only). `relativePath` is relative to torture-test/var/review-logs/ and is
 * never an absolute operator path; shipped assets never load these.
 */
function locator(locatorId, relativePath, detail) {
  return { locatorId, relativePath, detail };
}

const SOURCE_DIR_LABEL = "torture-test/var/review-logs/core-recording-source-ZFANtD/";

// ── RVOC specimen (W4.10-kill-daemon, run 59e8e12c) ──────────────────────

export const RVOC_ASSET = {
  caseId: "W4.10-kill-daemon",
  sourceIdentity: {
    kind: "pi", // workflow bug-fix-merge-worktree (fixer = pi agent)
    runId: "59e8e12c-2a7e-438d-aa48-6a3b99abb750", // source-backed (provenance; NEVER a fresh-run id)
    workflowId: "bug-fix-merge-worktree", // source-backed
    campaignLabel: "campaign-20260901T121246549Z-9ef7d11f-f464-4800-80af-11af436ff457", // provenance label
    classification: "source-backed",
  },
  historical: {
    // Archived state + artifact hashes (rvoc-archive-and-db.jsonl rows 1-4).
    stateSha256: "61c9d780a21f427dcee4cb97670c72de08730e666cc4753b9ac0255888ee99c2", // source-backed
    artifacts: {
      databaseSqliteSha256: "382a3ca3ba9c353020ecbb3a16151e56b86423a405265e621a20973ef14111b3", // source-backed
      runEventsJsonSha256: "04eaf36f8766065658d65573836e14f858a5f170cba5d7cbf39790b8767815a6", // source-backed
      probeEvidenceJsonSha256: "3aaa2e26c2b8d6627f27fd1b8a20dce7e9629b847335422fd01fe6a279928956", // source-backed
      classification: "source-backed",
    },
    // The archived lifecycle rows for the recovered fix cell (all.jsonl).
    // Two successful same-row fixer claims surround step.worker_lost. No
    // dedicated step.respawned exists in the archived stream — recorded as a
    // fact, with worker_lost acknowledged as the connecting event that DID
    // exist.
    archivedFixCellEvents: [
      { archive: "all.jsonl", line: 6114, event: "step.running", ts: "2026-09-01T12:15:24.982Z", stepId: "fix" },
      { archive: "all.jsonl", line: 6116, event: "step.worker_lost", ts: "2026-09-01T12:15:31.873Z", stepId: "fix" },
      { archive: "all.jsonl", line: 6117, event: "step.running", ts: "2026-09-01T12:15:34.262Z", stepId: "fix" },
    ], // classification: source-backed
    // The step row recovered by the kill: retry_count 1 (recovered step, not
    // duplicate concurrent execution per the archived fix step row).
    archivedStepRow: {
      id: "7ae14b30-1e14-462f-84bf-eb1d8d97f72b", // public step-row uuid (also named by both native claim results)
      stepId: "fix",
      status: "done",
      retryCount: 1,
      rerouteCount: 0,
      terminalRerouteCount: 0,
      classification: "source-backed",
    },
    archivedRunRow: {
      status: "completed",
      // two distinct observed token figures in the retained artifacts:
      // the run.completed event carries tokensSpent 112594 while the archived
      // DB row carries tokens_spent 131913 — both recorded verbatim.
      runCompletedEventTokensSpent: 112594, // source-backed
      dbRowTokensSpent: 131913, // source-backed
      workerLostCount: 1, // source-backed (run.completed event field)
      classification: "source-backed",
    },
    // The historical O10 finding this fossil documents: an FMIS oracle
    // expected exactly one step.running for the fix cell but observed two —
    // the second step.running had NO connecting event in the archived
    // stream. It is recorded here as historical context (the defect class
    // current step.respawned disambiguates), never replayed as an oracle.
    oracleFinding: {
      oracle: "O10",
      findingId: "O10_EVENT_SET_MISMATCH",
      summary: "FMIS cell lifecycle step.running stream is inconsistent with the captured step evidence",
      kind: "running-count-mismatch",
      stepId: "fix",
      expected: 1,
      observed: 2,
      classification: "source-backed",
    },
    // Native fixer sessions: two separate fixer sessions (12:15:22.825Z and
    // 12:15:32.294Z) each contain a successful claim call/result naming the
    // IDENTICAL expected step-row (7ae14b30-...) and run (59e8e12c-...).
    nativeClaims: {
      sessionFiles: [
        {
          fileLabel: "2026-09-01T12-15-22-825Z_01a05ce5-3ec9-7848-8bab-5030300be784.jsonl",
          fileSha256: "e915ffbc6fdc27793c253ce45f36879207fd80b6c4538bfc5963e373379b3397", // source-backed
          claimLine: 5,
          claimTime: "2026-09-01T12:15:24.829Z",
          callId: "call_00_1Ys4jTvxJT93tWamB0E94886",
          commandSha256: "f09f13d6f16c690f0c1f0f5f4c8122fac0bc70657119a6d03b0cf03ed4f67a9e", // source-backed (public digest of the claim command text)
          resultLine: 6,
          resultTime: "2026-09-01T12:15:24.988Z",
          resultSha256: "f3a5e07fa33a31ecdddea794379616af79312c4254a4f792b8a78af99a338ecc", // source-backed
        },
        {
          fileLabel: "2026-09-01T12-15-32-294Z_01a05ce5-63c6-7b47-b8e6-7193e285c145.jsonl",
          fileSha256: "0e1fa12ec80034dbaa20480bfb375621419081d1a00fb26c2493c504299442bc", // source-backed
          claimLine: 5,
          claimTime: "2026-09-01T12:15:34.102Z",
          callId: "call_00_1nVHNiZbIEs76kefFcSb6583",
          commandSha256: "f09f13d6f16c690f0c1f0f5f4c8122fac0bc70657119a6d03b0cf03ed4f67a9e", // source-backed (identical claim command digest)
          resultLine: 6,
          resultTime: "2026-09-01T12:15:34.268Z",
          resultSha256: "448c76206d044f4196555a6e091fc4ec9a2b09e4d603318a5dfafdad3d29f0bd", // source-backed
        },
      ],
      // Both claim results contain the identical expected step-row uuid and
      // run id (public). is_error false on both.
      bothIsErrorFalse: true, // source-backed
      bothContainSameStepRowAndRun: true, // source-backed
      classification: "source-backed",
    },
    interpretation:
      "Suitable raw-sourced RVOC observability fossil: a dedicated respawn transition was absent despite recovered work. Do NOT repeat the old shorthand that there was no connecting event at all — step.worker_lost already existed in the archived stream. Current product behavior adds step.respawned AFTER worker_lost/timeout/ceiling_expiry and does not erase those recovery events.",
  },
  corridors: {
    // One fresh real-motor corridor proves the CURRENT same-step recovery /
    // respawn ordering: a scripted pi worker claims the do-now execute step
    // and dies after the claim (die-after-claim, exit 1); the real scheduler
    // recovers the claimed step (step.worker_lost), emits step.respawned
    // AFTER the recovery event, and the SAME step row is claimed again and
    // completes. The fresh run's receipts bind the FRESH run id only.
    rvoc_current_recovery_ordering: {
      recordedShape: "two successful same-row fixer claims surround step.worker_lost (all.jsonl 6114/6116/6117); NO dedicated step.respawned in the archived stream (worker_lost was the connecting event that DID exist)",
      freshShape:
        "do-now corridor: claim #1 -> die-after-claim (exit 1, no report) -> step.worker_lost -> step.respawned (current product event, reason worker_lost) -> claim #2 of the SAME step row -> step done; run completed",
      expected: {
        runStatus: "completed",
        workerLostCount: 1,
        respawnedCount: 1,
        retryCountOnStep: 1,
        sameStepRowForBothClaims: true,
        respawnedAfterRecoveryEvent: true,
        tokens: 0,
      },
      productNote:
        "no product default changed; the fresh corridor replays the recorded recovery shape through the CURRENT motor, whose step.respawned event did not exist in the archived stream (asserted only as current behavior, never as historical)",
    },
  },
  sourceRefs: [
    locator("L1", SOURCE_DIR_LABEL + "rvoc-interpretation.jsonl", "RVOC interpretation: two same-row claims surround worker_lost; no dedicated step.respawned historically; worker_lost existed; current respawned-after-recovery-event semantics"),
    locator("L2", SOURCE_DIR_LABEL + "rvoc-archive-and-db.jsonl", "archived state/artifact hashes, event rows 6093-6139, fix step row + run row, O10 running-count-mismatch finding"),
    locator("L3", SOURCE_DIR_LABEL + "rvoc-archive-inspector.txt", "read-only inspector script that produced L2"),
    locator("L4", SOURCE_DIR_LABEL + "rvoc-native-source-index.jsonl", "seven native fixer session files hashed; two separate fixer sessions with successful same-row claim call/results"),
    locator("L5", SOURCE_DIR_LABEL + "rvoc-native-inspector.txt", "read-only inspector script that produced L4"),
  ],
  unknown: [
    {
      fact: "exact OS kill mechanics / pid ownership of the historical daemon kill",
      reason: "the archived snapshot alone does not prove exact OS kill mechanics or pid ownership; those require separate chaos identity correlation (recorded in the interpretation limitations)",
    },
  ],
  sourceSha256: null,
};

/** Deterministic sha256 over the sorted-key canonical form of the RVOC payload. */
export function rvocSpecimenSourceSha256() {
  const { sourceSha256: _digest, ...payload } = RVOC_ASSET;
  return sha256(stableString(payload));
}

// ── RCNT specimen (W4.10-restart-recovery, run f60941b9) ─────────────────

export const RCNT_ASSET = {
  caseId: "W4.10-restart-recovery",
  sourceIdentity: {
    kind: "pi", // workflow bug-fix-merge-worktree (merger = pi agent)
    runId: "f60941b9-6b36-403d-9730-2c7805c8eb7b", // source-backed (provenance; NEVER a fresh-run id)
    workflowId: "bug-fix-merge-worktree", // source-backed
    campaignLabel: "campaign-20260830T074704018Z-210fdc36-d450-47f4-be4f-f3b72780bf8c", // provenance label
    classification: "source-backed",
  },
  historical: {
    // Archived state + artifact hashes (rcnt-archive-and-db.jsonl rows 1-5).
    stateSha256: "f17dd3a228468a2003a81cf1c3379ebaf9855ebc1bb3f4d7ac7c5cc7f5549dbf", // source-backed
    artifacts: {
      databaseSqliteSha256: "ef9ccd5733985136704a70255a0a6ddae163b3b3da99a141f1f3f402ce27e728", // source-backed
      runEventsJsonSha256: "7b8a65a975b5c995fb38b68cba3a505ac4737ea0f8602fb30897fcda02f7a479", // source-backed
      workflowStatusJsonSha256: "41c93baaabc02241e9d569f0f25427c5796be259cc28d34c46dfd51273c6ab56", // source-backed
      probeEvidenceJsonSha256: "15db61dad6128a0dbd29db79c8a9017631aa9f151317569cdfa3095637d43230", // source-backed
      classification: "source-backed",
    },
    // Archived events relevant to the restart-recovery run (run-events.json
    // indices / all.jsonl line for the landing).
    archivedEvents: [
      { index: 55, event: "step.worker_lost", ts: "2026-08-30T07:50:31.448Z", stepId: "fix", note: "restart recovery of the fix worker" },
      { index: 102, event: "step.rerouted", ts: "2026-08-30T07:54:11.043Z", stepId: "finalize_merge", note: "single step.rerouted (ordinary rebase reroute)" },
      { allJsonlLine: 5621, event: "merge.landed", ts: "2026-08-30T07:55:46.340Z", mergedCommit: "540c3dda56a3e168d5656bf8505b8b3837c18549", mergedTree: "0c5939f2e9ff5b29ec6850384c0277561c32dd7a", note: "run landed after the reroute" },
      { index: 117, event: "run.completed", ts: "2026-08-30T07:55:50.946Z", tokensSpent: 170098, workerLostCount: 1 },
    ], // classification: source-backed
    // Archived step rows: the ORDINARY rebase reroute consumed the general
    // counter only; terminal_reroute_count stayed 0 and the run completed.
    archivedStepRows: [
      {
        stepId: "fix",
        status: "done",
        retryCount: 1, // worker_lost restart recovery
        rerouteCount: 0,
        terminalRerouteCount: 0,
        classification: "source-backed",
      },
      {
        stepId: "finalize_merge",
        status: "done",
        retryCount: 0, // reset to 0 by the reroute (rerouteWithPolicy)
        rerouteCount: 1,
        terminalRerouteCount: 0,
        landedCommit: "540c3dda56a3e168d5656bf8505b8b3837c18549",
        landedTree: "0c5939f2e9ff5b29ec6850384c0277561c32dd7a",
        classification: "source-backed",
      },
    ],
    // Native merger source: the accepted retry verdict identifies an ORDINARY
    // rebase (STATUS: retry / REBASED: true). The matching tool result
    // returned the reroute verdict text verbatim.
    nativeMergerSource: {
      sessionFileLabel: "2026-08-30T07-52-46-909Z_01a051a8-1c3d-7082-87ed-600a057b39ef.jsonl",
      sessionFileSha256: "1c0ccbbcb6194892dfbd04bc7de9f1b3f4a55a4681b183f3a1e852fa6e20ae0b", // source-backed
      rawReportLine: 41,
      toolCallId: "call_00_a3GG4KkVE5swLzbH4Rlv2256",
      keyLines: ["STATUS: retry", "REBASED: true"], // source-backed — the accepted native verdict identifying an ORDINARY rebase
      toolResultLine: 42,
      toolResultText:
        '{"status":"rerouted","detail":"STATUS: retry verdict — rerouted to upstream producer via on_fail.retry_step"}\nCOMPLETE_EXIT=0', // source-backed (public reroute verdict text)
      classification: "source-backed",
    },
    interpretation:
      "The original RCNT counter mismatch was an oracle-contract error for an ordinary rebase reroute, NOT proof the terminal counter needed incrementing. Native accepted STATUS: retry / REBASED: true identifies an ORDINARY rebase; general reroute_count 1 and terminal_reroute_count 0 were correct. Current WAVE-B.1 class-specific counters preserve the terminal allowance; this fossil is a control against the erroneous all-reroutes-consume-terminal-budget rule. Historical events lack terminal/rerouteMode flags; ordinary-rebase classification comes from the correlated raw report, not invented event fields.",
  },
  corridors: {
    // Fresh real-motor corridor (A): an ORDINARY rebase reroute consumes the
    // general reroute_count but NOT the terminal allowance.
    ordinary_rebase_reroute: {
      recordedShape: "finalize_merge consumer returned an accepted STATUS: retry / REBASED: true verdict; rerouted once to the upstream producer; reroute_count 1 / terminal_reroute_count 0; run completed and landed",
      freshShape:
        "two-step core-reroute-corridor fixture (produce -> consume) through the real isolated motor: the consumer completes with the recorded retry-verdict shape (STATUS: retry / REBASED: true) and is rerouted to the upstream producer via on_fail.retry_step; the producer reruns and the consumer completes; reroute_count 1 / terminal_reroute_count 0 and the run completes (a real merge landing is NOT claimed here)",
      expected: {
        runStatus: "completed",
        rerouteCount: 1,
        terminalRerouteCount: 0,
        reroutedEventCount: 1,
        reroutedEventTerminal: false,
        retryCountOnConsumer: 0,
        tokens: 0,
      },
      adaptationNote:
        "the fixture consumer models the recorded finalize_merge retry-verdict reroute semantics (identical step-ops reroute machinery) on a fresh two-step corridor; a real merge-branch landing stays a merge-gated-corridor obligation and is NOT claimed by this cell",
    },
    // Explicitly labeled SYNTHETIC terminal control (subset apart from
    // ordinary rebases): a terminal-class refusal (FAILURE_CLASS:
    // refused_permanent) consumes the one-shot terminal allowance
    // (terminal_reroute_count 1, run still alive); a second terminal refusal
    // exhausts it (run failed, no further reroute).
    synthetic_terminal_control: {
      classification: "synthetic",
      label: "EXPLICITLY SYNTHETIC TERMINAL CONTROL — never the historical ordinary-rebase shape",
      freshShape:
        "same two-step fixture: consumer fails with FAILURE_CLASS: refused_permanent (first) -> terminal-class reroute (terminal_reroute_count 1, reroute_count 1, run alive); producer reruns; consumer fails again with a terminal class -> terminal allowance exhausted -> run failed with no second reroute",
      expected: {
        firstTerminalRerouteStatus: "rerouted",
        runStatusAfterFirstTerminalRefusal: "running", // run NOT failed by the first terminal refusal
        terminalRerouteCount: 1,
        rerouteCount: 1,
        reroutedEventCount: 1,
        reroutedEventTerminal: true,
        secondTerminalRefusalStatus: "run_failed",
        tokens: 0,
      },
    },
  },
  sourceRefs: [
    locator("L1", SOURCE_DIR_LABEL + "rcnt-interpretation.jsonl", "RCNT interpretation: ordinary rebase reroute control; general count 1 / terminal 0 correct; old equality rule erroneous"),
    locator("L2", SOURCE_DIR_LABEL + "rcnt-archive-and-db.jsonl", "archived state/artifact hashes, event vocabulary, fix worker_lost, finalize_merge reroute + run_rows + step_rows"),
    locator("L3", SOURCE_DIR_LABEL + "rcnt-archive-inspector.txt", "read-only inspector script that produced L2"),
    locator("L4", SOURCE_DIR_LABEL + "rcnt-native-source-index.jsonl", "nine native merger/fixer session files hashed; raw rebase report source line 41 keylines"),
    locator("L5", SOURCE_DIR_LABEL + "rcnt-source-result-link.jsonl", "matching tool result line 42: rerouted verdict text verbatim + COMPLETE_EXIT=0"),
    locator("L6", SOURCE_DIR_LABEL + "rcnt-native-inspector.txt", "read-only inspector script over the native session directory"),
  ],
  unknown: [
    {
      fact: "historical event terminal/rerouteMode flags",
      reason: "the archived event stream lacks terminal/rerouteMode flags; ordinary-rebase classification comes from the correlated raw report (STATUS: retry / REBASED: true), not invented event fields",
    },
  ],
  sourceSha256: null,
};

/** Deterministic sha256 over the sorted-key canonical form of the RCNT payload. */
export function rcntSpecimenSourceSha256() {
  const { sourceSha256: _digest, ...payload } = RCNT_ASSET;
  return sha256(stableString(payload));
}

RVOC_ASSET.sourceSha256 = rvocSpecimenSourceSha256();
RCNT_ASSET.sourceSha256 = rcntSpecimenSourceSha256();
Object.freeze(RVOC_ASSET.sourceRefs);
Object.freeze(RCNT_ASSET.sourceRefs);
// Freeze the whole trees AFTER the digests are filled.
deepFreeze(RVOC_ASSET);
deepFreeze(RCNT_ASSET);

/** Deep-frozen asset accessors. */
export function loadRvocAsset() {
  return RVOC_ASSET;
}

export function loadRcntAsset() {
  return RCNT_ASSET;
}

const PRIVATE_MARKERS = [
  "/home/igorhvr", // operator absolute prefix
  "core-recording-source-ZFANtD/../", // no upward references
  "file:///home",
  "/var/home/.pi/agent/sessions/", // native session absolute roots
  "/var/home/.tamandua", // retained state absolute roots
  "/var/results/campaign-", // archived campaign absolute roots
  "/var/fixtures/work/",
];

/**
 * Assert an exported asset payload never carries private-location strings.
 * Returns { ok: true } or { ok: false, marker }.
 */
export function assertNoPrivateSourceDependency(text) {
  for (const marker of PRIVATE_MARKERS) {
    if (typeof text === "string" && text.includes(marker)) {
      return { ok: false, marker };
    }
  }
  return { ok: true };
}
