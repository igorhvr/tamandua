# Build tt-poly-lite (two-language storm monorepo) + its golden builder

Authoritative spec in this repo — READ first:
- `torture-test/tamandua-torture-test-spec/02-fixture-projects.md` — the
  tt-poly / tt-poly-lite sections and "Common requirements" are binding.
  tt-poly-lite = the python/ + ts/ restriction of tt-poly with its own
  `run-all-tests` (~3-4 min ceiling), used by Tier-1's storm and
  capacity-scaled storms.
- `torture-test/tamandua-torture-test-spec/09-wave-5-storm.md` — the storm
  consumes this fixture: note the guaranteed-conflict sentinel line in
  `ts/src/store.js` (S5/S9 overlap pair), disjoint per-language task
  areas, and the composite `seed/storm` ref that pins every storm task's
  bait/bug/sentinel content.
- REFERENCE IMPLEMENTATIONS (reuse structure and determinism conventions;
  where sensible, DERIVE the subtree content from the merged tt-python and
  tt-ts fixtures rather than inventing new code):
  `torture-test/fixtures-src/tt-python/`, `torture-test/fixtures-src/tt-ts/`.

## Deliverables

1. `torture-test/fixtures-src/tt-poly-lite/` — committed source: a
   monorepo with `python/` and `ts/` subtrees (each a working project with
   its own tests, adapted from the reference fixtures), a top-level
   `run-all-tests` script (runs both suites, exits non-zero on any
   failure, total wall < 4 min), the storm's sentinel line in
   `ts/src/store.js` exactly as 09 requires, per-subtree seeded content
   the storm roster needs (POLY-BUG in python/, POLY-BRK tests, POLY-VULN
   seeds — scope them to what specs 02+09 name for the lite variant), and
   both junk-probe classes.
2. `torture-test/fixtures-src/tt-poly-lite/seeds/` — per-seed patches,
   fix patches, `SEEDS.md`, PLUS the composite `seed/storm` construction
   (one ref that layers every storm seed; document exactly which seeds it
   composes).
3. `torture-test/fixtures-src/tt-poly-lite/build-golden.sh` —
   deterministic golden builder to
   `torture-test/var/fixtures/golden/tt-poly-lite.git` with all `seed/*`
   refs incl. `seed/storm`; byte-stable hashes verified across rebuilds;
   post-build `run-all-tests` green in a scratch clone.

## Hard constraints

- Files ONLY inside `torture-test/`; generated state ONLY under
  `torture-test/var/`.
- `run-all-tests` must work with only python3 + node on PATH (no other
  toolchains), offline.
- The tamandua repo's own files untouched.

## Acceptance (verify before reporting done)

- Two consecutive builds print identical hashes.
- Scratch clone: `run-all-tests` green at baseline and < 4 min; each
  seed ref red in exactly its documented subtree; `seed/storm` checkout
  shows ALL composed seeds simultaneously (verify each documented symptom
  is present); fix patches restore green individually.
- Junk-probe invariants hold in both subtrees after one full run.
