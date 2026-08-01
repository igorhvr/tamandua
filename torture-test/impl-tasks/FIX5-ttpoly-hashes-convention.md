# tt-poly builder: adopt the per-fixture <name>.git.hashes convention

The B7 tt-poly merge (b54a330) branched before FIX3 (3f64b89) landed,
so its builder still writes the OLD hidden determinism record
(`torture-test/var/fixtures/golden/.build-hashes-tt-poly`) instead of
the standardized `tt-poly.git.hashes` that
`torture-test/bin/tt-verify-fixture-baselines` now REQUIRES next to
every `<name>.git`. Observed 2026-08-01: with tt-poly.git built, the
smoke campaign honestly fails — W0.fixture-baselines PRODUCT_FAIL,
"missing hashes file" for tt-poly.git. (Build determinism itself is
fine: two consecutive builds print "Hash stability: IDENTICAL".)

Reference implementation: FIX3's US-006 did exactly this migration for
tt-poly-lite — see `torture-test/fixtures-src/tt-poly-lite/build-golden.sh`
(writes `tt-poly-lite.git.hashes` in the verifier-parseable format).

## Deliverables

1. `torture-test/fixtures-src/tt-poly/build-golden.sh`: write
   `torture-test/var/fixtures/golden/tt-poly.git.hashes` in the same
   format tt-poly-lite's builder uses (every ref the builder creates:
   baseline/HEAD, all seed/*, broken-tests, seed/storm), replacing the
   `.build-hashes-tt-poly` file for BOTH the stability comparison and
   the persisted record. Delete any leftover
   `.build-hashes-tt-poly` handling; also clean up the stale
   `.build-hashes-tt-poly-lite` if the poly-lite builder no longer
   references it (check first).
2. Add `tt-poly` to the smoke case's `--expect` list in
   `torture-test/cases/smoke.jsonl` (W0.fixture-baselines entry) so all
   SEVEN fixtures are required from now on.
3. If a product-side test asserts the old filename (grep `tests/` and
   `torture-test/` for `build-hashes-tt-poly`), update it — but put any
   NEW test content inside `torture-test/` per the containment rule
   (FIX2 is relocating strays; do not add new ones).

## Hard constraints

- Files ONLY inside `torture-test/` (except updating an EXISTING
  product test if one hardcodes the old filename).
- Builder determinism preserved: two consecutive builds → identical
  hashes and "IDENTICAL" stability verdict.
- Golden repo content (refs/hashes) must NOT change — this is a
  record-file rename, not a content change.

## Acceptance (verify before reporting done)

- Two consecutive `build-golden.sh` runs: identical hashes, stability
  IDENTICAL, and `tt-poly.git.hashes` present and parseable.
- `./run-torture-test --smoke`: GREEN with all seven fixtures listed
  in the fixture-baselines evidence, each with hash-comparison results.
- Corrupting one hash in `tt-poly.git.hashes` (restore after) flips
  the smoke verdict to failing.
