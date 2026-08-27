# S26: O10 full-table ledger reconciliation is incompatible with multi-case campaigns — scope it and guarantee campaign-start suite state

Tier-2 real campaign attempt-2 (campaign-20260826T225744158Z-4bf26d7f,
evidence + snapshots on disk) terminated 70/70 with 32 TEST_INFRA_FAIL, of
which ~17 have `O10 ERROR: ORACLE_RUNTIME_ERROR ("suite_ledger does not
reconcile byte-for-field with the read-only database snapshot")` as their
ONLY failing oracle. Attempt-1 (campaign-20260826T115835332Z-b3659e65,
aborted 2 cases in) shows the cross-campaign flavor of the same class:
a contained-real-daemon DB carrying 106 rows since 08-13 poisoned O10 AND
O9 (false single-flight executor-count/recovery-order/waiter findings +
O9_REPLAY_ROW_MISSING via reused `var/fixtures/work/<case>/<fixture>`
origin paths).

Root cause (verified on evidence): the snapshotter
(oracle-evidence-snapshot.mjs ~:1150) captures `suite-ledger.json` SCOPED
to the case's suite origins (gate-key origin + event origins — the S13
d84c8558 design), but `o10.mjs` `readDatabase()` reads the ENTIRE
`suite_results` table and `evaluateO10` requires byte-for-field equality
of the two (o10.mjs ~:263-266). Any row from any other case — stale
cross-campaign OR accumulated intra-campaign — makes O10 throw. Sampled:
W4.05 artifact=1 row vs db=6; W4.13 artifact=1 vs db=42; W4.28 artifact=1
vs db=73 (rows grow monotonically through the campaign).

## Stories

1. **Answer the #8 question with evidence.** The byte-for-field check
   predates campaign #8 (3ae7332c, 08-02) and the scoped capture landed
   08-14 (d84c8558), yet tier-1 campaign #8 (08-21, 28 real cases, one
   shared contained daemon, accumulating DB) did not drown in O10 errors.
   Determine mechanically why (per-case gate_key nullability? tier-1
   origin set shapes? something else) from campaign #8's on-disk evidence
   before changing code, and write the answer into the landing report.
   If #8's immunity reveals a DIFFERENT intended design, honor it.

2. **Fix at the oracle layer, fail-closed.** O10 must recompute the
   case's suite-origin scope from its own inputs (launch_intent gate_key
   origin + captured event origins — the same derivation the snapshotter
   uses) and reconcile byte-for-field WITHIN that scope: scoped artifact
   rows vs scoped DB rows. Tamper-detection inside the scope is
   preserved; foreign-origin rows are foreign (S13 doctrine), not
   reconciliation failures. Audit O9's reconciliation (o9.mjs ~:391 and
   its row-resolution paths) for the same class and align it; O2/O3z
   reconciliations too if they read full-table. Document the scope
   contract in oracles/CONTRACT.md.

3. **Guarantee campaign-start suite state.** Attempt-1's cross-campaign
   contamination must become impossible: tt-controller's real-daemon
   preflight (daemon-up path) must verify the contained REAL daemon's
   suite_results is empty (or verifiably scoped-clean) at campaign start
   and fail closed with a precise STATUS line telling the operator to
   reset (or perform a controlled reset itself via a documented seam —
   pick the fail-closed design and document it; the scripted daemon
   already has MACP7 reset-state, the real daemon deliberately does not
   — do NOT weaken that asymmetry without documenting why the chosen
   design is safe). Never touch the operator's live daemon (33xx).

## Prove

- Red-then-green for the O10 scope fix via tt-oracle-replay against
  attempt-2's evidence (campaign-20260826T225744158Z-4bf26d7f): every
  TEST_INFRA_FAIL whose only failure is the O10 reconciliation ERROR
  flips to its true verdict; every other finding byte-identical in the
  delta table. Same replay against attempt-1's two cases documents the
  cross-campaign flavor healing.
- New self-tests: scoped-reconciliation red-arm (foreign-origin rows in
  DB, scoped artifact → PASS with foreign rows ignored; in-scope
  mismatch → still throws), campaign-start suite-state preflight
  red-arm (non-empty suite_results → precise fail-closed refusal).
- Full self-test battery green from repo root; bare `./run-torture-test
  --tier2` GREEN x2 on merged main (24/24 scripted); bare --tier1 GREEN.

## Hard constraints

- Files ONLY inside torture-test/. Zero tokens. Live daemon (33xx)
  untouched. Preserve all fail-closed semantics. Do NOT re-run any real
  campaign cases (evidence replay only). Do NOT modify attempt-1/-2
  evidence or snapshots — they are adjudication material.
