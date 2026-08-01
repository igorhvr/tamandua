# Build the full tt-poly five-language storm monorepo + golden builder

Authoritative spec in this repo — READ first:
- `torture-test/tamandua-torture-test-spec/02-fixture-projects.md` — the
  tt-poly section + "Common requirements" are binding.
- `torture-test/tamandua-torture-test-spec/09-wave-5-storm.md` — the
  Tier-2 storm consumes this fixture: per-language task areas (go/
  worker-pool, java/ ledger, python/ scheduling, rust/ POLY-BUG-R,
  ts/src/store.ts sentinel overlap pair, repo-wide POLY-VULNs, POLY-BRK
  tests), composite `seed/storm`.
- REFERENCE IMPLEMENTATIONS — all merged, reviewed, deterministic:
  `torture-test/fixtures-src/tt-poly-lite/` (THE structural template:
  extend its pattern from 2 to 5 subtrees; where its python/ and ts/
  subtrees fit tt-poly's needs, derive directly) and the five language
  fixtures (tt-python, tt-ts, tt-go, tt-java, tt-rust) for per-language
  idioms, seeds style, and builder conventions (per-fixture
  `<name>.git.hashes` determinism record — NOT a shared file).

## Deliverables

1. `torture-test/fixtures-src/tt-poly/` — committed source: monorepo
   with `python/ ts/ go/ java/ rust/` subtrees (each a working project
   with tests, adapted from the merged fixtures), top-level
   `run-all-tests` (all five suites, non-zero on any failure; java via
   the committed mvnw; rust via nix cargo on PATH; total wall per spec
   02's budget), the storm sentinel in `ts/src/store.ts` (same marker
   convention as poly-lite), per-language seeded content the Tier-2
   storm roster needs, both junk-probe classes in every subtree that
   spec 02 mandates.
2. `torture-test/fixtures-src/tt-poly/seeds/` — per-seed patches + fix
   patches + `SEEDS.md` (archetypes) + composite `seed/storm` layering
   every storm seed (document composition).
3. `torture-test/fixtures-src/tt-poly/build-golden.sh` — deterministic
   builder to `torture-test/var/fixtures/golden/tt-poly.git`, all
   `seed/*` refs incl. `seed/storm`, byte-stable hashes verified,
   post-build `run-all-tests` green in a scratch clone.

## Hard constraints

- Files ONLY inside `torture-test/`; generated state ONLY under
  `torture-test/var/`. Offline after first maven-cache warm (dedicated
  cache under var/ if needed).
- The tamandua repo's own files untouched.

## Acceptance (verify before reporting done)

- Two consecutive builds print identical hashes.
- Scratch clone: `run-all-tests` green at baseline; each seed ref red
  in exactly its documented subtree; `seed/storm` shows ALL composed
  seeds simultaneously; fix patches individually restore green.
- Junk-probe invariants hold per subtree after one full run.
