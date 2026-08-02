# Two defects: destructive builder self-tests + validate-all vacuous skip-exit

Both found 2026-08-02 during the B8.1 landing review.

## Defect 1: builder self-tests destroy the operator's shared golden state

`torture-test/self-tests/tt-poly-build-golden.test.ts` (and check its
siblings, e.g. tt-poly-lite-build-golden.test.ts and any other
relocated test that touches builders) sets `goldenDir` to the SHARED
`torture-test/var/fixtures/golden/` and `fs.rmSync(goldenDir,
{recursive: true})` before rebuilding ONLY its own fixture (three call
sites: ~lines 597, 704, 1223). Observed live: running
`torture-test/self-tests/run.sh` wiped six of seven operator-built
golden bares (only tt-poly.git survived, freshly rebuilt at
2026-08-01 20:55). Builder self-tests must be HERMETIC:

- Run the builder with its output redirected to a per-test scratch dir
  under `torture-test/var/self-tests/` (mktemp-style unique, cleaned
  after). If `build-golden.sh` does not support an output-dir override
  (env var or flag), ADD one (default unchanged:
  var/fixtures/golden) and use it from the tests — check all fixture
  builders for consistency and use the same override name everywhere.
- After this change, running the full `torture-test/self-tests/run.sh`
  must leave a pre-populated `torture-test/var/fixtures/golden/`
  byte-identical (verify with before/after `ls` + hashes-file
  comparison in your report).

## Defect 2: validate-all exits 0 when EVERY probe was skipped

`torture-test/probes/validate-all.sh` (~line 757): when `PASS -eq 0 &&
SKIP -gt 0` it prints "All probes were skipped (golden bares may not
exist yet)." and `exit 0`. A validation harness that validated NOTHING
must not exit green — same fail-open class as FIX3/FIX4. Change to a
distinct non-zero exit (2, matching the infra-error convention) with a
remedy message naming the builders. Partial skips with zero failures
should also be reported loudly (list skipped) but may exit 0 only if
at least one probe validated and no probe failed; fully document the
exit contract in the header comment. Extend the inline self-tests to
cover the all-skipped case.

## Hard constraints

- Files ONLY inside `torture-test/`.
- Do not weaken any existing assertion; the builder tests must still
  verify real builder behavior (determinism, refs) — just against
  scratch output.
- `torture-test/self-tests/run.sh` green twice consecutively.

## Acceptance (verify before reporting done)

- Populate golden dir (run all 7 builders), snapshot listing + hashes
  files; run `torture-test/self-tests/run.sh` twice; snapshot again —
  identical, all 7 goldens intact.
- `validate-all.sh` against an EMPTY golden dir: non-zero exit.
- `validate-all.sh --self-test` green, including the new case.
