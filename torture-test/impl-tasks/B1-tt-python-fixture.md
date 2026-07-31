# Build the tt-python torture fixture (source + seeds + deterministic golden builder)

You are implementing one fixture of the tamandua torture-test suite. The
authoritative specification lives in this repository at
`torture-test/tamandua-torture-test-spec/` — READ these files first:

- `02-fixture-projects.md` — the requirements document; the tt-python
  section and the "Common requirements (all fixtures)" section are binding,
  including seeded defects, defect archetypes, junk-probe classes, traps,
  and the held-out-probe rules.
- `01-environment-and-isolation.md` — where runtime state lives
  (`torture-test/var/`), containment rules.

## Deliverable

1. `torture-test/fixtures-src/tt-python/` — the complete committed source
   of the fixture: a small, idiomatic, realistic Python project (pytest;
   size and shape per spec 02) whose test suite is GREEN at baseline, with
   ALL spec-mandated content: the seeded bugs (each bug on its own
   `seed/BUG-*` construction — see builder below), seeded feature
   surfaces, the flaky-probe marker (skipped by default), the
   `$(sentinel)`-named subdirectory with its canary, the python/python3 +
   venv trap, and the junk-probe arrangements (untracked-not-gitignored
   regenerated junk + the inert `operator-notes.local` file) exactly as
   spec 02 defines them.
2. `torture-test/fixtures-src/tt-python/seeds/` — one patch (or overlay
   dir) per seeded defect/arming (bugs, flaky arming, slow arming if spec'd
   for this fixture), plus a known-good fix patch per bug (needed later for
   probe three-arm validation). Each seed documented in a `SEEDS.md` with
   its archetype (A1–A5) and expected symptom.
3. `torture-test/fixtures-src/tt-python/build-golden.sh` — builds
   `torture-test/var/fixtures/golden/tt-python.git` (a bare repo) from the
   source: initializes a repo with DETERMINISTIC commits (fixed
   GIT_AUTHOR_NAME/EMAIL/DATE + GIT_COMMITTER_* so the tree AND commit
   hashes are byte-stable across rebuilds), creates one `seed/<ID>` ref per
   seed applied on top of the baseline, and verifies after building that
   the baseline test suite passes in a scratch clone (bootstrap the venv
   the way the spec's raw-arming trap demands). Re-running the script must
   reproduce identical hashes (print them; fail if a rebuild diverges).

## Hard constraints

- Create/modify files ONLY inside `torture-test/`.
- All generated state (golden bares, scratch clones, venvs) goes under
  `torture-test/var/` (gitignored). The committed fixture source must not
  contain venvs, caches, or generated junk.
- No new npm/pip dependencies for the tamandua repo itself; the fixture's
  own Python deps must be stdlib+pytest only (pytest assumed present via
  the host's python3 -m pytest or a venv the builder bootstraps).
- Do NOT create the held-out probes themselves (separate task) — but the
  known-good fix patches they will need must exist per deliverable 2.

## Acceptance (verify before reporting done)

- `bash torture-test/fixtures-src/tt-python/build-golden.sh` succeeds from
  a clean checkout; prints stable hashes twice in two consecutive runs.
- In a scratch clone of the built golden: baseline suite green; each
  `seed/BUG-*` ref checked out makes the suite RED with the documented
  symptom; applying the corresponding fix patch makes it green again.
- The junk-probe invariants hold in a fresh clone after one test run
  (regenerated junk exists untracked; inert file byte-identical).
- `git -C <scratch clone> status` shows the untracked junk (NOT ignored).
