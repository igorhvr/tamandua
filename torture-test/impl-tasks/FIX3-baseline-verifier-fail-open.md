# Close two fail-open gaps in tt-verify-fixture-baselines

`torture-test/bin/tt-verify-fixture-baselines` (landed with the C1
controller merge) is the W0.fixture-baselines smoke gate. First real
smoke campaign (2026-08-01, GREEN) exposed two fail-open defects — the
exact "vacuous pass" class the torture spec's oracles are designed to
kill (see `torture-test/tamandua-torture-test-spec/04-wave-0-preflight.md`
and 03-oracles.md O17 philosophy: absence of evidence is a FAIL, not a
pass):

1. **Vacuous green on empty/absent golden root.** With zero `*.git`
   entries under `torture-test/var/fixtures/golden/`, it prints
   total=0 failed=0 result=PASS and exits 0. A never-provisioned host
   sails through the gate.
2. **Determinism records ignored.** Each merged fixture builder writes
   a per-fixture `<name>.git.hashes` byte-stability record next to the
   golden repo (e.g. `tt-go.git.hashes`). The verifier never reads
   them: refs are not compared to recorded hashes, and a MISSING
   `.hashes` file goes unnoticed (today `tt-poly-lite.git` has none —
   real gap this task must also close by generating it via its builder
   convention or flagging it).

## Deliverables

1. Update `torture-test/bin/tt-verify-fixture-baselines`:
   - Exit non-zero with result FAIL (distinct message) when the golden
     root is missing or contains zero `*.git` fixtures.
   - For every `<name>.git`, REQUIRE `<name>.git.hashes` alongside it;
     missing file = FAIL for that fixture with a remedy message naming
     the builder to run.
   - Parse the hashes file and verify every recorded ref exists in the
     repo with exactly the recorded hash (`git --git-dir=... rev-parse
     <ref>`); any mismatch or missing ref = FAIL with both values in
     the evidence JSON. Keep existing bare/HEAD/fsck checks.
   - Optional `--expect <name>[,<name>...]`: fixtures that MUST be
     present (missing = FAIL). Wire the smoke case
     (`torture-test/cases/smoke.jsonl` W0.fixture-baselines entry) to
     pass the currently-built set: tt-python,tt-ts,tt-go,tt-java,tt-rust,tt-poly-lite.
2. Bring `tt-poly-lite` up to the per-fixture hashes convention: its
   builder (`torture-test/fixtures-src/tt-poly-lite/build-golden.sh`)
   must write `tt-poly-lite.git.hashes` like the other builders; run it
   and confirm the verifier then passes against real state.
3. Self-test additions (in the existing controller/self-test style,
   inside torture-test/): empty root FAILs; missing hashes file FAILs;
   tampered ref hash FAILs; healthy root PASSes. Runnable standalone,
   green twice consecutively.

## Hard constraints

- Files ONLY inside `torture-test/`; nothing outside it.
- No new npm dependencies; plain node like the current script.
- Do not weaken any existing check.

## Acceptance (verify before reporting done)

- `./run-torture-test --smoke` on this machine: GREEN, with the
  fixture-baselines evidence JSON showing per-fixture hash-comparison
  results for all six fixtures.
- Deliberately corrupting one recorded hash (restore after) flips the
  smoke to a failing verdict.
- Self-tests green twice consecutively.
