# Build the tt-java torture fixture (source + seeds + deterministic golden builder)

Authoritative spec in this repo — READ first:
- `torture-test/tamandua-torture-test-spec/02-fixture-projects.md` — the
  tt-java section and "Common requirements (all fixtures)" are binding,
  INCLUDING the `./mvnw` Maven-wrapper requirement, the off-PATH-JDK
  JAVA_HOME README trap, and the `target/` junk probe.
- REFERENCE IMPLEMENTATIONS (follow structure, determinism approach,
  SEEDS.md format, acceptance discipline exactly):
  `torture-test/fixtures-src/tt-python/` and
  `torture-test/fixtures-src/tt-ts/`.

## Deliverables (mirror pattern, for Java + Maven)

1. `torture-test/fixtures-src/tt-java/` — committed source: small
   idiomatic Maven project per spec 02's tt-java section, `TEST_CMD:
   ./mvnw -q -B test`, committed Maven Wrapper, green at baseline, all
   spec-mandated seeds (the 4 bugs listed in spec 02 with their
   archetypes, vulns, feature surfaces), README documenting the JAVA_HOME
   hint per the trap, `target/` as untracked-NOT-gitignored junk probe +
   inert `operator-notes.local`.
2. `torture-test/fixtures-src/tt-java/seeds/` — per-seed patches +
   known-good fix patches + `SEEDS.md`.
3. `torture-test/fixtures-src/tt-java/build-golden.sh` — deterministic
   golden builder to `torture-test/var/fixtures/golden/tt-java.git` with
   `seed/*` refs, byte-stable hashes verified across rebuilds, post-build
   baseline-green verification in a scratch clone (first build may
   populate the local Maven repo cache — cache under `torture-test/var/`
   if you need a dedicated one; suite runs must not need network after
   the first warm).

## Hard constraints

- Files ONLY inside `torture-test/`; generated state (incl. any Maven
  repo cache you dedicate) ONLY under `torture-test/var/`.
- Keep the project tiny: dependency-free (JUnit via the smallest workable
  arrangement the spec allows; prefer whatever minimizes network and
  cache size). Suite runtime well under 5 minutes.
- The tamandua repo's own files untouched.

## Acceptance (verify before reporting done)

- Two consecutive `build-golden.sh` runs print identical hashes.
- Scratch clone: `./mvnw -q -B test` green at baseline (works on this
  host — maven 3.9 and a JDK are present); every `seed/BUG-*` red with
  documented symptom; fix patches restore green.
- After one suite run in a fresh clone: `target/` exists, untracked,
  visible in `git status`, absent from .gitignore; inert junk
  byte-identical.
