# TFLK: increase only the installation integration-test deadline

## Authorization

Igor authorized this exact narrow proposal on 2026-09-04: a separate dsh run
raises the installation test deadline from 120 to 600 seconds, keeping the real
installation, every assertion, and product runtime unchanged.

Beads: tamandua-6sy.20. This is NOT authorization for the older proposal to reuse
dependencies/build output, or for a general test-hygiene refactor.

## Evidence

`tests/install-script-workflows.test.ts`, test
`install.sh --local installs bundled workflows and exits 0`, invokes the real
`scripts/install.sh --local` in a temporary home. Its `spawnSync` call has a
120-second command wall limit for the installation and build. The recorded
review evidence shows that limit being hit under concurrent run load, while the
same test passed in quieter windows. This can make the Tier-0 build/unit cell red.

The authorized correction is extra test execution time, not weaker coverage or
a faster substitute for the operation being tested.

## One implementation story

Change that specific `spawnSync` limit from `120_000` to `600_000` and update its
directly corresponding comment to explain the ten-minute allowance for the real
installation/build on a loaded host.

Acceptance:

- The product diff is confined to that numeric setting and its comment in
  `tests/install-script-workflows.test.ts`.
- The command, environment isolation, real install/build, assertions, and
  cleanup ownership are unchanged. No new test skips, retries, cache, or stubs.
- The focused existing test file passes on this run's built worktree.
- Typecheck passes.

The workflow's normal integration-test step must run `npm test`: both lanes
green, with an empty test-isolation violation ledger. Record the tree, command,
exit status and duration. Do not add another multi-gate proof story for this
two-line change. If setup reproduces the known baseline deadline failure, record
it honestly as the defect to fix; do not repeatedly rerun the unchanged baseline.

## Boundaries

- No changes to `scripts/install.sh`, product runtime, other tests (including
  install-partial-failure), or torture-test source/assets. No borrowed build
  output, dependency-reuse shortcut, changed assertions, or general cleanup.
- If evidence reveals a different failure, report it with exact evidence and
  stop rather than expanding this authorization or declaring an unrun test green.
- Build/test only in this run's worktree. Never rebuild the origin checkout,
  refresh the live catalog, or restart/stop the live daemon. Existing runs depend
  on its current matching binary/catalog.
- All test state stays isolated and listener ports random, with the test guard
  enabled. Never touch the live user state or production listeners.
- No broad process-kill commands. Only exact verified test-owned child processes
  may be terminated. Preserve existing worktrees and evidence; no forced
  worktree cleanup or broad recursive removal.
- Give the full npm suite at least 30 minutes at the command runner level and
  inspect progress instead of imposing a short enclosing wall limit.
- No torture battery or tier campaigns in this run: R4a #906 may own the shared
  contained ports. No real paid e2e. The coordinator performs any required
  independent quiet-window campaign checks after the landings.
- Merge to local main through this workflow only. No origin push or release.

Test command: npm test
