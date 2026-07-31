# Implement the gating oracle battery (O1, O2, O3z, O8, O9, O10, O11) + self-tests + calibration pack

Authoritative spec in this repo — READ these fully first:
- `torture-test/tamandua-torture-test-spec/03-oracles.md` — the
  requirements document. Implement the GATING set exactly as specified:
  O1 (terminal-state integrity), O2 (merge truth — the heart: ref moved
  exactly once, MERGED_TREE == TESTED_TREE with the commit-tree leg,
  patch-id presence, mode-scoped evidence legs, no-phantom, bidirectional
  reconciliation, reflog capture), O3z (zero-token completion + system
  tokens absolute zero), O8 (scope/boundary: bait byte-identical, no
  test weakening — checksum-based), O9 (TSTX ledger integrity: keying,
  monotonicity, single-flight observables, cross-repo separation), O10
  (merge-gate corridor: the FMIS 4-mode table, reroute-once semantics,
  launch-intent binding, exact-key laundering guard), O11 (token
  attribution: per-run nonzero, no cross-charge, informed rejections).
- `torture-test/oracles/CONTRACT.md` — the per-oracle executable +
  evidence-JSON contract defined by tt-controller (merged before this
  task; follow it exactly so the controller can run you).
- `torture-test/tamandua-torture-test-spec/12-runner-automation.md`
  (§tt-oracle — mutation self-tests; §calibration pack — the hand-built
  hard-case evidence states).

## Deliverables

1. `torture-test/oracles/o1` `o2` `o3z` `o8` `o9` `o10` `o11` — each an
   executable (node, no build, no new deps) taking a run id (or evidence
   dir, per CONTRACT.md), reading ONLY mechanical evidence (TT sqlite DB
   read-only, git plumbing against fixture repos/worktrees, filesystem),
   emitting PASS/FAIL + evidence JSON per the contract. NO agent prose
   is ever an input to a verdict.
2. **Mutation self-tests**: `torture-test/oracles/self-test/` — for EACH
   oracle, at least one tiny synthetic evidence state in which it MUST
   fail (e.g. fabricated completed-run-with-unmoved-ref for O2; a
   zero-token completed run for O3z; a weakened-test diff for O8; a
   green ledger row for the wrong tree for O9; an agent-emitted
   merge_gate=off governing the decision for O10), plus one green state
   each. `torture-test/oracles/self-test/run.sh` runs all and fails if
   any oracle misses its synthetic violation or false-positives on the
   green state.
3. **Calibration pack**: `torture-test/oracles/calibration/` — the three
   hand-built HARD cases from spec 12: O2 phantom-merge (annotated
   events, plausible branch, target genuinely unmoved), O9 stale-replay
   (matching tree hash, suite duration predating a committed suite
   change), O11 cross-charge (two concurrent runs, one round's tokens on
   the other's row). Wire into the same run.sh; version them with the
   oracles.
4. Wire-up: ensure `tt-controller` (existing) can invoke each oracle per
   CONTRACT.md against a real harvested run dir — demonstrate on any
   completed run already in the TT results, or a synthetic one.

## Hard constraints

- Files ONLY inside `torture-test/`; state ONLY under `torture-test/var/`.
- All sqlite access read-only (`sqlite3 -readonly` / node readonly).
- Production state untouched and unread except where CONTRACT.md
  explicitly passes a DB path — never default to the real ~/.tamandua.
- If CONTRACT.md is missing or ambiguous on a point, extend it in the
  same change (documented), do not invent a divergent convention.

## Acceptance

- `torture-test/oracles/self-test/run.sh` green (all violations caught,
  no false positives), twice consecutively.
- Calibration pack: all three hard cases caught.
- Each oracle runs standalone against a synthetic evidence dir in <10s.
