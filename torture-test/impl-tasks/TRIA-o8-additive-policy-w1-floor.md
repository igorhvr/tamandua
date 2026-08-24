# TRIA: adopted triage decisions — S19 O8 diff-aware additive policy + wave-1 duration-floor recalibration

Two operator-adopted decisions from the campaign #8 triage (2026-08-24),
both suite-side.

## 1. S19 — O8 seeded-test policy: diff-aware additive carve-out

Current behavior (torture-test/oracles/lib/o8.mjs ~255): ANY sha256/type/
mode delta of a baseline test-path file fires O8_SEEDED_TEST_CHANGED, a
case-failing finding. Campaign #8 lane-C dossier proved all four flagged
edits were strictly additive regression tests the task texts demanded,
and that workers can dodge the oracle by putting identical work in NEW
files (exempt, o8.mjs ~254) — a suite-fragmentation incentive.

Adopted policy (implement exactly this):
- O8 already reconciles the git snapshot; compute a line-level diff of
  each flagged seeded test file vs baseline.
- If the delta is PROVABLY ADDITIVE — every baseline line present and
  unmodified (pure import-line insertions tolerated), no test markers
  introduced (the existing O8_TEST_MARKER_INTRODUCED leg is unchanged
  and separate) — emit informational, NON-FAILING
  O8_SEEDED_TEST_EXTENDED instead (recorded in findings with the diff
  stats, never flips the oracle result).
- ANY other delta — deleted lines, modified lines, renames/mode changes,
  markers — keeps the hard-FAIL O8_SEEDED_TEST_CHANGED exactly as today.
- Fix-consequence assertion rewrites STAY hard-FAIL (operator decision:
  no liberalization without real examples).
- O8_EXISTING_OUTSIDE_BOUNDARY and all boundary logic unchanged.
- CONTRACT.md updated to document the split.

Prove red-then-green against the ACTUAL campaign #8 evidence via
tt-oracle-replay or targeted O8 replays: W1.L3-python, W1.L3-ts, W3.22
seeded-test findings become O8_SEEDED_TEST_EXTENDED (cases would no
longer fail on that leg) while W3.22's .gitignore boundary finding and a
synthetic weakening fixture (delete/modify a seeded assertion) still
hard-FAIL. Add the synthetic weakening + synthetic additive cases to the
O8 self-tests.

## 2. Wave-1 O1 duration floor: 120s -> 30s (measured honest baseline)

Campaign #8's four wave-1 do-now runs finished 46-102s with fully audited
honest work (lane D); the 120s spec-era pin guarantees false O1_DURATION_
FLOOR findings in every future campaign now that SFX-B un-deadened the
guard. Set production_duration_floor_ms to 30000 for the wave-1 do-now
family rows in torture-test/cases/tier1.jsonl, with an inline comment/
field documenting the recalibration basis ("2026-08-24: measured honest
baseline 46-102s across campaign-8; floor 30s = margin below fastest
honest run; spec-era 120s produced 4/4 false positives"). Do NOT touch
other waves' floors. Prove: O1 replay over the campaign #8 evidence shows
the four wave-1 floor findings clear while any case that finished <30s
(none) would still fire; O1 self-tests updated if they pin the old value.

## Hard constraints
- Files ONLY inside torture-test/ — specifically oracles/lib/o8.mjs,
  oracle CONTRACT.md, O8/O1 self-tests, and the W1.* rows of
  cases/tier1.jsonl. Zero tokens. Live daemon (33xx) untouched.
- A concurrent run (MACP4) owns the W2.* rows of cases/tier1.jsonl
  (requires predicates), daemon-control, env scripts, and W2 scenario
  cells — do not touch those rows or files; your tier1.jsonl edits are
  W1.* rows only. Concurrent product runs own src/** — untouched.
