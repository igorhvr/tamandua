# Stop tt-poly end-to-end self-test from polluting fixtures-src

`torture-test/self-tests/tt-poly-end-to-end-verification.test.ts` runs
suite commands directly inside `torture-test/fixtures-src/tt-poly/`
(observed: `rust/target/` appears there after every
`torture-test/self-tests/run.sh` execution, mtime matching the test
run). Consequences: the dev repo goes dirty (untracked build output),
and worktree-mode workflow launches from this repo are then REFUSED
("origin repository has uncommitted changes") until someone cleans it.
This blocked two launches on 2026-08-02.

Audit ALL of `torture-test/self-tests/*.ts` (and
`torture-test/probes/validate-all.sh` bootstrap paths for good
measure) for any execution that writes build artifacts into
`fixtures-src/` — rust target/, java target/, go build cache, python
__pycache__, node_modules, tsc output. Every such execution must run
in a scratch CLONE/copy under `torture-test/var/self-tests/` (FIX6
established the pattern with TORTURE_GOLDEN_DIR scratch dirs — follow
it), never in the committed fixture source tree.

## Hard constraints

- Files ONLY inside `torture-test/`.
- Do not weaken any assertion; same coverage, hermetic execution.
- Do NOT add .gitignore entries to hide the pollution — fix the cause.
  (Fixture junk-probe semantics inside GOLDEN repos are intentional
  and out of scope; this is about the committed fixtures-src tree.)

## Acceptance (verify before reporting done)

- `git status --porcelain` is EMPTY after running
  `torture-test/self-tests/run.sh` twice from a clean tree (prove with
  before/after output in your report).
- `torture-test/self-tests/run.sh` green twice consecutively.
- `find torture-test/fixtures-src -name target -o -name __pycache__
  -o -name node_modules` returns nothing after the runs.
