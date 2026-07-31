# Build the tt-go torture fixture (source + seeds + deterministic golden builder)

Authoritative spec in this repo — READ first:
- `torture-test/tamandua-torture-test-spec/02-fixture-projects.md` — the
  tt-go section and "Common requirements (all fixtures)" are binding.
- REFERENCE IMPLEMENTATIONS (follow their structure, script conventions,
  determinism approach, SEEDS.md format, and acceptance discipline
  exactly): `torture-test/fixtures-src/tt-python/` and
  `torture-test/fixtures-src/tt-ts/` — both are merged, reviewed, and
  verified deterministic. Diverge from their pattern only where the spec's
  tt-go section demands it.

## Deliverables (mirror of tt-python/tt-ts, for Go)

1. `torture-test/fixtures-src/tt-go/` — committed source: small idiomatic
   Go project per spec 02's tt-go section (go test based, green at
   baseline) with all spec-mandated seeded content for tt-go (bugs with
   archetypes, vuln seeds, feature surfaces) and both junk-probe classes
   (untracked-not-gitignored regenerated junk appropriate to the Go
   ecosystem per spec; inert `operator-notes.local`).
2. `torture-test/fixtures-src/tt-go/seeds/` — per-seed patches + known-good
   fix patches + `SEEDS.md` (archetype + expected symptom each).
3. `torture-test/fixtures-src/tt-go/build-golden.sh` — deterministic golden
   builder to `torture-test/var/fixtures/golden/tt-go.git` with `seed/*`
   refs, byte-stable hashes across rebuilds (verify like the reference
   builders do), post-build baseline-green verification in a scratch clone.

## Hard constraints

- Files ONLY inside `torture-test/`; generated state ONLY under
  `torture-test/var/`. No module downloads at test time (vendor or
  stdlib-only — the fixture must build/test offline).
- The tamandua repo's own files untouched.

## Acceptance (verify before reporting done)

- Two consecutive `build-golden.sh` runs print identical hashes.
- Scratch clone: baseline green; every `seed/BUG-*` red with its
  documented symptom; fix patch restores green.
- Junk-probe invariants hold after one test run in a fresh clone.
