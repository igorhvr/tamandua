# Relocate torture-test test files out of tests/ back into torture-test/ (containment)

## Why

The torture-test implementation campaign has ONE binding containment
rule from the operator: ALL torture-test files live inside
`torture-test/`; the ONLY exception is the top-level `run-torture-test`
launcher. Nothing else outside `torture-test/` may be touched.

Two landed runs violated this by adding product-suite tests under
`tests/` (and registering them in `tests/serial-files.txt`):

- D1 scripted runtimes (commit 60ae1e4): `tests/scripted-runtime-*.test.ts`
  (7 files) + serial-files.txt entries.
- B7 tt-poly (if merged by the time you run): `tests/tt-poly-*.test.ts`
  and similar + serial-files.txt entries. Check
  `git log --stat` for the B7 merge to enumerate exactly.

These couple the PRODUCT gate (`npm test`) to torture-test internals: a
torture-test refactor could redden the product suite, and they lengthen
the already ~15.5-minute suite. The coverage itself is valuable — keep
it, but host and invoke it from inside `torture-test/`.

## Deliverables

1. Move every torture-test-originated test file currently under
   `tests/` into `torture-test/self-tests/` (keep file names). Fix
   their relative imports (e.g. `../src/lib/temp-dir.ts` →
   `../../src/lib/temp-dir.ts`) and any `process.cwd()`-relative path
   assumptions so they pass when run from the repo root.
2. Remove their entries from `tests/serial-files.txt` (restore it to
   covering ONLY product tests).
3. Add `torture-test/self-tests/run.sh` that runs all relocated tests
   serially via `node --test` (node >= 22 runs .ts directly here; no
   build step, no new deps) and exits non-zero on any failure. Wire an
   invocation of `run.sh` into the components' existing self-test entry
   points where one obviously fits (e.g. referenced from
   `torture-test/scripted-runtimes/test.sh` as an optional deep lane) —
   do NOT wire it into `npm test`.
4. Verify `git diff --stat` for your change shows ONLY deletions under
   `tests/` plus changes inside `torture-test/`.

## Hard constraints

- After this change, `npm test` must be green and must no longer
  execute any of the relocated files.
- Do not weaken or drop any assertion while relocating; port, don't
  rewrite.
- Files ONLY inside `torture-test/` (plus the `tests/` deletions this
  task exists to make).

## Acceptance (verify before reporting done)

- `torture-test/self-tests/run.sh` passes twice consecutively.
- `grep -r "scripted-runtime\|tt-poly" tests/` returns nothing.
- Full `npm test` green (mind the 15-25+ minute duration — never use a
  command timeout under 30 minutes; run detached and poll).
