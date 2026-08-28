# US-005: S26 tt-oracle-replay invariant pin — red-then-green on attempt-1/-2 evidence

S26 story US-005: add a mechanical pin to `torture-test/bin/tt-oracle-replay`
(`--verify-s26-invariants`) that fixes the S26 replay contract — the ONLY
allowed verdict flips between a stored campaign verdict and its offline
replay are (a) O10 suite-ledger reconciliation ERRORs
(`ORACLE_RUNTIME_ERROR` with the `suite_ledger does not reconcile
byte-for-field` summary) flipping to their TRUE verdict
(PASS/FAIL/NOT_EVALUABLE — the US-002 scoped-reconciliation heal), and
(b) O9 replay-row heals (`O9_REPLAY_ROW_MISSING` / `O9_SINGLEFLIGHT_*`
false positives healed by the US-003 row-resolution alignment) — and then
prove red-then-green against the attempt-2 and attempt-1 evidence
(campaign-20260826T225744158Z-4bf26d7f and
campaign-20260826T115835332Z-b3659e65-c60d-499d-9ccd-77fd9d26b291)
without re-running any real campaign case (zero tokens, read-only evidence).

## What changed (files inside torture-test/ only)

- `torture-test/bin/tt-oracle-replay`:
  - New `--verify-s26-invariants` mode running `verifyS26Invariants({ rows })`
    (two checks):
    - `s26-o10-reconciliation-heal` — EVERY stored O10 reconciliation ERROR
      (oracle O10, stored verdict ERROR, an `ORACLE_RUNTIME_ERROR` finding
      whose summary carries `suite_ledger does not reconcile
      byte-for-field`) must replay to a true verdict (PASS/FAIL/
      NOT_EVALUABLE). A stored reconciliation ERROR that still replays
      ERROR is the RED arm (the pre-US-002 code shape) and fails the pin.
    - `s26-flip-scope` — every verdict flip must be an O10 reconciliation
      ERROR -> true verdict OR an O9 replay-row heal (`isO9ReplayRowHeal`:
      O9, stored FAIL -> replayed PASS, `O9_REPLAY_ROW_MISSING` among the
      stored findings, every stored finding in the S26 O9 heal class
      `{O9_REPLAY_ROW_MISSING, O9_SINGLEFLIGHT_EXECUTOR_COUNT,
      O9_SINGLEFLIGHT_RECOVERY_ORDER, O9_SINGLEFLIGHT_WAITER_UNRESOLVED}`).
      ANY other flip — including any O10 non-reconciliation ERROR flip
      (e.g. `target ref identity changed between snapshots`) or any non-O10
      change — violates the pin and exits 1.
  - Replay rows now carry `beforeFindings` (the stored finding objects with
    summaries, via the new `readStoredFindingObjects`) so the pin can
    distinguish the O10 reconciliation ERROR from other O10
    `ORACLE_RUNTIME_ERROR`s (a summary-less synthetic row falls back to the
    finding id).
  - E3.B integration (so `--verify-invariants` stays coherent with the S26
    fixes): `isScopedDisappearing` treats `O9_REPLAY_ROW_MISSING` as
    scoped on O9 only, and the I2 flip-transition-classes check accepts an
    O10 reconciliation ERROR -> PASS/FAIL flip. Honest-verdict preservation
    semantics are otherwise unchanged.
- `torture-test/bin/tt-oracle-replay-invariants.test.mjs`: S26 unit + e2e
  tests (below).
- `torture-test/impl-tasks/S26-replay-invariant-pin.md`: this report.

## Red-then-green proof

### Red arm (demonstrated synthetically — pre-US-002 code shape)

US-002 is already merged on this branch, so the pre-US-002 oracle cannot be
re-invoked; the red arm is pinned by the self-tests:

- `verifyS26Invariants flags a stored O10 reconciliation ERROR that did not
  heal (red arm)` — a synthetic row with the stored reconciliation ERROR
  shape whose replay verdict stays `ERROR` (the pre-US-002 full-table read
  would still throw) violates `s26-o10-reconciliation-heal`.
- `--verify-s26-invariants exits 1 on an O10 non-reconciliation ERROR flip
  (violating)` — a synthetic campaign whose stored O10 ERROR carries the
  `target ref identity changed between snapshots` summary replays
  `ERROR -> NOT_EVALUABLE`; the flip is NOT the reconciliation class, so
  `s26-flip-scope` violates and the tool exits 1.

### Green arm — attempt-2 evidence (campaign-20260826T225744158Z-4bf26d7f-e648-42f1-8274-0011926de7dd)

Replay of the full campaign with the US-002/US-003 fixes:

```
pairs: 292  flips: 25  unchanged: 267  invoke_failures: 0
transitions: ERROR->FAIL: 23, FAIL->PASS: 2
S26 invariant report (--verify-s26-invariants):
  [OK] s26-o10-reconciliation-heal
  [OK] s26-flip-scope
s26: OK          # exit 0
```

- **23 O10 reconciliation ERROR -> FAIL flips** (true verdicts, carrying the
  genuine O10 findings: 19x `O10_EVENT_SET_MISMATCH`; 2x
  `O10_EVENT_SET_MISMATCH + O10_REROUTE_COUNT`; 1x
  `O10_EVENT_SET_MISMATCH + O10_MERGER_INVOCATION_COUNT + O10_REF_MOVEMENT +
  O10_REROUTE_COUNT + O10_TERMINAL_DISPOSITION`; 1x the same plus
  `O10_REFUSAL_DIAGNOSIS`): W4.02-fail-missing-refusal, W4.03-red-adjacent-
  commit, W4.04a-mechanical-override, W4.04b-behavioral-bait,
  W4.05-slow-suite-contention, W4.06-colleague-rebase,
  W4.07-conflicting-colleague-commit, W4.13-worktree-deletion,
  W4.15-story-flood, W4.16-scope-bait, W4.17-a-red-baseline-land-annotated,
  W4.17-b-red-baseline-refuse, W4.18-flaky-alternator,
  W4.26-unreachable-origin, W4.28-tstx-cross-repo-collision,
  W4.31-precommit-amend, W4.32-enospc, W4.33c-deleted-worktree-refusal,
  W4.39-b-union-dishonest, W4.45-branch-delete, W4.45-gc-aggressive,
  W4.dsh-fdmw, W5.storm-capacity-scaled.
- **2 O9 `O9_REPLAY_ROW_MISSING` FAIL -> PASS heals** (US-003): W4.01-
  missing-evidence-reroute, W4.02-fail-missing-refusal (the cross-campaign
  flavor, also present intra-campaign).
- Every other pair byte-identical (267 unchanged), 0 invoke failures, and
  the tool's own sha256 digest check confirms the source campaign was
  unmodified (`source_campaign_unchanged: true`; independently re-verified
  below).
- The non-reconciliation O10 ERROR (W4.29-strict-gate-retry-finalize,
  `target ref identity changed between snapshots`) stays ERROR (delta same)
  and is correctly NOT treated as a heal.

The 18 attempt-2 `TEST_INFRA_FAIL` cases whose classification reason is
exactly `{category: oracle-infrastructure, oracles: [O10]}` (the story's
"~17") are all in the 23-case heal list; the remaining 5 O10 ERROR cases
healed too (they also carry genuine O10 findings now), and the 14 other
`TEST_INFRA_FAIL` cases (chaos-invocation-failed / probe-trigger-unreached /
workflow-spec-missing / scheduler-execution-failed) have no O10 reconciliation
rows at all.

### Green arm — attempt-1 evidence (campaign-20260826T115835332Z-b3659e65-c60d-499d-9ccd-77fd9d26b291)

Replay of the aborted cross-campaign attempt (only W4.01/W4.02 captured
oracle evidence; W4.03 has launch files but no oracle pairs):

```
pairs: 16  flips: 3  unchanged: 13  invoke_failures: 0
transitions: ERROR->FAIL: 2, FAIL->PASS: 1
S26 invariant report (--verify-s26-invariants):
  [OK] s26-o10-reconciliation-heal
  [OK] s26-flip-scope
s26: OK          # exit 0
```

- **2 O10 reconciliation ERROR -> FAIL flips** (W4.01-missing-evidence-
  reroute, W4.02-fail-missing-refusal) — the cross-campaign O10 flavor heals.
- **1 O9 `O9_REPLAY_ROW_MISSING` FAIL -> PASS heal** (W4.02-fail-missing-
  refusal).
- W4.01 O9 stays FAIL (delta same): the `O9_REPLAY_ROW_MISSING` stored
  finding vanishes (the US-003 heal) while the
  `O9_SINGLEFLIGHT_EXECUTOR_COUNT / O9_SINGLEFLIGHT_RECOVERY_ORDER /
  O9_SINGLEFLIGHT_WAITER_UNRESOLVED` findings persist — they describe the
  contaminated DB's single-flight observations and replay identically, so
  they are honest (no flip, no violation).
- 13 unchanged, source campaign byte-identical.

### Evidence integrity (read-only adjudication material)

- The tool verifies a full sha256 digest of every campaign file before and
  after each replay (`source_campaign_unchanged: true` in both runs; a
  modification is a hard failure).
- Independently re-verified: full recursive sha256 digests of both campaign
  dirs were snapshotted before the S26/E3.B replay runs
  (`/tmp/s26-replay/<campaign>.digest`, 2413 files for attempt-2, 125 for
  attempt-1) and re-compared after — byte-identical.

## Tests

`torture-test/bin/tt-oracle-replay-invariants.test.mjs` (48 tests, 47 pass +
1 skip — the preval-campaign pin skips when that evidence is absent):

- `isO10ReconciliationErrorRow` classification (summary-based, summary-less
  fallback, non-reconciliation summary, non-O10/ERROR shapes).
- `isO9ReplayRowHeal` classification (heal set, honest-finding
  disqualification, wrong oracle/verdict).
- `verifyS26Invariants` green arm (O10 -> PASS/FAIL/NOT_EVALUABLE all
  accepted), red arm (stored reconciliation ERROR that replays ERROR is
  flagged), O9 heal accepted, and the violating classes flagged (O10
  non-reconciliation flip, non-O10 flip, O9 flip with an honest finding).
- Exact attempt-2 delta shape accepted; the same shape with one honest O3z
  flip added is rejected.
- E3.B integration: `verifyReplayInvariants` accepts the S26 classes;
  `O9_REPLAY_ROW_MISSING` scoped on O9 only; an O10 non-reconciliation
  ERROR -> PASS stays an unclassified honest flip.
- e2e: `--verify-s26-invariants` exits 0 on an allowed O10 reconciliation
  heal (synthetic campaign) and exits 1 on a violating flip, with the JSON
  payload carrying `s26` and the replay rows carrying `beforeFindings`.

## Notes

- `--verify-invariants` (E3.B) was also run over attempt-2 as a coherence
  check: `honest-finding-preservation` and `flip-transition-classes` now
  PASS (the S26 classes are accepted), and `cnev-pins` / `o8-seeded-pins`
  skip (campaign not in their universe). The `runaway-backing` check flags
  W4.37-keyline-spoof-repo-content (an INCONCLUSIVE case whose report
  carries a runaway-cap finding but whose 4 captured oracle pairs all
  replay PASS) — a pre-existing E3.B campaign-#7-era check on a campaign
  E3.B was never designed for, orthogonal to the S26 contract; the S26 pin
  (what AC2 requires) exits 0.
- Zero tokens were spent (evidence replay only; no daemon, no model).
- The live 33xx daemon and `~/.tamandua` were never touched.
- Attempt-1/-2 evidence and snapshots are unmodified (digests above).
- Diff confined to `torture-test/` (bin/tt-oracle-replay +
  bin/tt-oracle-replay-invariants.test.mjs + this report).
