# SFX-B: campaign #8 oracle calibration fixes — S20 reflog parser, S21 O9 scoping, S22 O11 seal model, S23 O1 reporter, S25 O16 errors

From the campaign #8 attempt-3 adjudicated review (campaign dir
torture-test/var/results/campaign-20260822T073029892Z-48c0215b-...; all
root causes mechanically verified with file:line evidence).

1. **S20 — reflog parser rejects message-less lines.** The landing
   update-ref writes reflog entries with no message segment; the capture
   parser regex in oracle-evidence-snapshot.mjs (~line 1073) requires the
   \t<message> tail, so every real landing transition was captured
   raw-only and O2_REF_TRANSITION_COUNT counted 0 on all 8 landing cases.
   Make the regex tolerate an absent message (the before/after OIDs,
   identity, and timestamp are all present and were verified correct).
   Keep raw lines archived as today.
2. **S21 — O9 bundles stale cross-attempt ledger rows.** All 17
   O9_LEDGER_TREE_UNRESOLVED findings were rows created 2026-08-13 by
   PRIOR campaign attempts (contained state persists across attempts,
   fixture repos re-provision, O9 scopes its bundle by origin_repo path
   only — deterministic per case id). Scope the O9 row bundle to the
   current attempt (attempt/campaign time-window or run-id set from the
   captured graph — pick the mechanism that stays honest: rows from THIS
   case's runs only). Current-attempt rows all resolve; do not weaken
   tree resolution itself.
3. **S22 — O11 retry-seal predicate lacks the legal retry corridors.**
   Both COMPLETED_FROM_RETRY_VERDICT hits were legitimate: (a) honest
   single-step retry (accepted retry verdict, transition.action="retry",
   step re-dispatched, later separate accepted done) and (b) the RTRV
   fix's own on_fail.retry_step reroute corridor
   (transition.action="reroute"). Fix o11-output-contract.mjs (~185):
   the seal must fire only when an accepted retry-verdict row's
   transition.action is 'done' OR the step reached done with NO later
   accepted done validation — i.e. match the finding's name, completed
   FROM the retry verdict. Make done-multiplicity per-dispatch
   (reroute-aware: a rerouted step legally re-executes and re-validates).
   ALSO fix the attempt-number synthesis in
   oracle-evidence-snapshot.mjs (~501-535): rejections and validations
   currently use two independent per-stream counters that desync on any
   rejected→accepted→rejected sequence, producing the
   REJECTION_VALIDATION_MISMATCH / REJECTION_WITHOUT_VALIDATION false
   pairs (same physical event double-flagged). Use one shared per-claim
   counter or join by recordId/timestamp.
4. **S23 — O1 wave floor guard is structurally dead sequentially.** The
   wave reporter is the FIRST case in manifest order, whose O1 runs when
   the wave has 1 sample (< MIN_FLOOR_RATE_SAMPLE) → suppressed; every
   later case computes and discards. Campaign #8: 4/4 wave-1 cases beat
   the 120s floor (54/46/89/102s) with no O1_DURATION_FLOOR_RATE finding.
   Fix o1.mjs: report family findings from the LAST-terminal case of the
   wave (or re-evaluate at wave close) so the guard functions at
   concurrency 1.
5. **S25 — O16 errored (status TEST_INFRA, no verdict) on 7 cases**
   (W1.L3×2, W3.01-04, W3.18). Diagnose from the O16 stderr/context in
   the campaign evidence and fix the oracle so it renders a verdict on
   those case shapes; red-then-green against the captured evidence.

Prove: each fix red-then-green against the ACTUAL campaign #8 captured
evidence (the campaign dir is the fixture — replay the oracle against it
and show the false findings disappear while true findings persist:
O2_LANDING_EVENT_MISSING must STILL fire until the product MLID fix
lands, W3.22's .gitignore boundary catch must STILL fire); full
self-test battery green from repo root.

## Hard constraints
- Files ONLY inside torture-test/ — specifically torture-test/oracles/**
  and torture-test/bin/oracle-evidence-snapshot.mjs. Zero tokens. Live
  daemon (33xx) untouched. Concurrent runs own tt-controller,
  daemon-control, tt-daemon-up (SFX-A) and src/** (TATR) — touch none.
  Do NOT change O8 policy (S19 awaits an operator decision).
