# Build the tt-ts torture fixture (source + seeds + deterministic golden builder)

You are implementing one fixture of the tamandua torture-test suite. The
authoritative specification lives in this repository at
`torture-test/tamandua-torture-test-spec/` — READ these files first:

- `02-fixture-projects.md` — the requirements document; the tt-ts section
  and the "Common requirements (all fixtures)" section are binding,
  including seeded defects, defect archetypes, junk-probe classes, traps,
  and the held-out-probe rules.
- `01-environment-and-isolation.md` — where runtime state lives
  (`torture-test/var/`), containment rules.

## Deliverable

Mirror of the tt-python fixture task, for TypeScript/node:

1. `torture-test/fixtures-src/tt-ts/` — committed source: a small,
   idiomatic, realistic TypeScript project per spec 02's tt-ts section
   (its own package.json/lockfile INSIDE the fixture, node test runner or
   the spec-named runner, green at baseline) with ALL spec-mandated
   content for tt-ts: seeded bugs, feature surfaces for the fdmw tasks,
   and — load-bearing — the junk-probe arrangement: `package-lock.json`
   handling / regenerated untracked junk exactly as spec 02 defines it
   (untracked, NOT gitignored: it is the dirty-tree regression signal),
   plus the inert `operator-notes.local` class.
2. `torture-test/fixtures-src/tt-ts/seeds/` — one patch/overlay per
   seeded defect + known-good fix patch per bug + `SEEDS.md` with
   archetypes (A1–A5) and expected symptoms.
3. `torture-test/fixtures-src/tt-ts/build-golden.sh` — builds
   `torture-test/var/fixtures/golden/tt-ts.git` with DETERMINISTIC
   commits (fixed author/committer name/email/date; byte-stable hashes
   across rebuilds — print and verify), one `seed/<ID>` ref per seed,
   and a post-build verification that the baseline suite is green in a
   scratch clone (npm install allowed there — it must regenerate the
   untracked junk the probe needs).

## Hard constraints

- Create/modify files ONLY inside `torture-test/`.
- All generated state under `torture-test/var/` (gitignored). Committed
  fixture source contains no node_modules.
- The fixture is self-contained: its npm dependencies minimal (prefer
  zero-dependency + node's built-in test runner unless spec 02 says
  otherwise); the tamandua repo's own package.json is untouched.
- Do NOT create held-out probes (separate task); DO create the fix
  patches they will need.

## Acceptance (verify before reporting done)

- `bash torture-test/fixtures-src/tt-ts/build-golden.sh` succeeds; two
  consecutive runs print identical hashes.
- Scratch clone: baseline green; each `seed/BUG-*` red with documented
  symptom; fix patch restores green.
- After one suite run in a fresh clone, the regenerated junk exists and
  is UNTRACKED (visible in `git status`, absent from .gitignore); the
  inert junk file is byte-identical to its committed sampler reference.
