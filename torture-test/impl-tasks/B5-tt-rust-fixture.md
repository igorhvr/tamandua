# Build the tt-rust torture fixture (source + seeds + deterministic golden builder)

Authoritative spec in this repo — READ first:
- `torture-test/tamandua-torture-test-spec/02-fixture-projects.md` — the
  tt-rust section and "Common requirements (all fixtures)" are binding.
- REFERENCE IMPLEMENTATIONS (follow structure, determinism approach,
  SEEDS.md format, acceptance discipline exactly):
  `torture-test/fixtures-src/tt-python/`, `torture-test/fixtures-src/tt-ts/`,
  and (if merged by the time you start) `torture-test/fixtures-src/tt-go/`.

Host note: rust is nix-provided (cargo 1.97 on PATH via ~/.nix-profile).
Do not use rustup.

## Deliverables (mirror pattern, for Rust)

1. `torture-test/fixtures-src/tt-rust/` — committed source: small
   idiomatic cargo project per spec 02's tt-rust section (`cargo test`
   based, green at baseline), all spec-mandated seeded content for
   tt-rust (bugs with archetypes, vuln seeds, feature surfaces), and both
   junk-probe classes (untracked-not-gitignored `target/` regenerated
   junk; inert `operator-notes.local`).
2. `torture-test/fixtures-src/tt-rust/seeds/` — per-seed patches +
   known-good fix patches + `SEEDS.md` (archetype + expected symptom).
3. `torture-test/fixtures-src/tt-rust/build-golden.sh` — deterministic
   golden builder to `torture-test/var/fixtures/golden/tt-rust.git` with
   `seed/*` refs, byte-stable hashes verified across rebuilds, post-build
   baseline-green verification in a scratch clone.

## Hard constraints

- Files ONLY inside `torture-test/`; generated state ONLY under
  `torture-test/var/`. Zero crates.io dependencies (std + built-in test
  framework only — must build/test offline). Suite runtime < 2 min.
- The tamandua repo's own files untouched.

## Acceptance (verify before reporting done)

- Two consecutive `build-golden.sh` runs print identical hashes.
- Scratch clone: baseline green; every `seed/BUG-*` red with documented
  symptom; fix patches restore green.
- Junk-probe invariants hold after one test run in a fresh clone
  (`target/` untracked, visible in git status, not gitignored).
