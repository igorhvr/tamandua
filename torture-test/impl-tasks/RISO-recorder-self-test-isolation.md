# RISO: isolate the legacy recorder self-test without weakening its assertions

## Authority and immediate safety constraint

Suite-only repair under Igor's standing autonomous torture-test authorization,
reconfirmed on 2026-09-04. Implement through a dsh run. Beads: tamandua-0j7.4.1.
This is unrelated to the deferred KHYG product-protection decision: do not change
product code, product agent prompts, or add global process-command shims.

DO NOT execute the existing `torture-test/bin/tt-recorder.test.sh` before repairing
its isolation. A fresh checkout alone is insufficient: one test attempts to bind
the production dashboard port. Establish the safe fixture boundary first.

## Confirmed source findings

The old issue was described as an absent-WAL assertion flake. The all-Beads audit
and independent coordinator source review found a stronger root cause:

- The harness derives its working state from the invoking checkout's actual
  `torture-test/var`, including its recorder directory and both contained homes.
- Startup cleanup trusts a pre-existing recorder PID and removes recorder state.
- The daemon-size section writes fake database contents into the existing
  contained homes, assumes the scripted WAL is absent, and later recursively
  removes those homes.
- The production-port exclusion case attempts an actual bind to port 3334 and
  reports PASS when the listener fails or coverage cannot be established.

The normal `torture-test/self-tests/run.sh` does not run this legacy shell
harness. Preserve that fact while repairing it; do not casually add a long
process-spawning harness to every battery invocation.

## Required result

Running this self-test must neither inspect/control an existing campaign's
recorder nor modify its state, database, credentials, or evidence. Every mutable
fixture and spawned process must belong exclusively to this self-test invocation.
The zero-WAL assertion remains exact for an intentionally absent fixture WAL;
present-WAL sizes must match the fixture bytes. Do not replace these checks with
an always-true or merely nonnegative condition.

Prefer constructing a fresh minimal fixture tree and copying the real recorder
tool into it, allowing the existing path resolution to select owned test state.
The recorder is currently self-contained; inspect dependencies before choosing
the smallest safe approach. Avoid adding new runtime override knobs just to make
the test possible. Never point a fixture link or cleanup path at real user state.

## Story boundaries

### US-001 — Private filesystem and process ownership

Make all harness sections use fresh invocation-owned fixture state consistently,
including repeated root calculations later in the script. Remove cleanup of the
source checkout's recorder and contained homes. Track only child processes the
test actually created; verify identity/ownership before stopping detached test
recorders. A supplied or pre-existing PID file must never authorize killing an
unrelated process. Normal exit and failure cleanup must leave no owned children
running and must not traverse outside the exact newly created fixture paths.

Add a focused regression proving that a pre-populated neighboring fake campaign
tree and a sentinel process survive unchanged. Use wholly synthetic, self-owned
outer fixtures, not actual campaign data, for that regression. Preserve the WAL
size assertions and assert actual fixture contents. Gate: focused isolation
regression, plus shell syntax/typecheck where applicable.

### US-002 — Honest port-exclusion coverage without production listeners

Replace the production-port bind attempt with an isolated behavioral fixture at
the narrowest existing process/port observation boundary. Exercise the real
recorder exclusion logic with controlled port evidence. Include both an excluded
production-port observation and an allowed contained-process observation so an
always-exclude implementation fails. If an actual socket is needed, use an
OS-selected random port; never bind or probe production ports.

Unavailable observations must not be reported as successful verification. The
Linux coverage must execute; preserve honest existing platform applicability and
Darwin behavior without weakening portability lints. Add a guard that catches
reintroduction of production binds and source-checkout state usage in this
harness. Gate: the focused positive/negative port-isolation regression, plus
syntax/typecheck.

### US-003 — Repeatability and cleanup proof on the corrected harness

Only after the first two stories' boundaries are in place, run the corrected full
recorder shell harness twice consecutively. Demonstrate exact absent/present WAL
results, no pre-existing sentinel-data changes, no surviving owned children, no
production listener access, and a clean tracked tree. Make the regression
repeatable without depending on operator state or deleting existing test state.
Record commands, exit statuses, tree and evidence. This corrected-harness proof
is the one acceptance gate for the story; do not add a full tier ladder to it.

## Boundaries

- Changes stay under `torture-test/`, principally the legacy recorder harness,
  focused isolation regression(s), and necessary lint registration/documentation.
  Prefer leaving the recorder runtime unchanged. If a suite-only test seam is
  unavoidable, keep it local and prove normal recorder behavior unchanged.
- Do not run unsafe pre-fix code against any real checkout state. A red proof may
  use a synthetic fixture and a deny-and-record boundary that prevents an actual
  production bind; source inspection already establishes the unsafe old calls.
- No blanket name/pattern process kills, global shell shims, production daemon
  lifecycle actions, or cleanup of pre-existing directories. Preserve user files,
  live state, worktrees, and all campaign evidence. Do not follow old unguarded
  cleanup examples merely because they were checked in.
- No product source/test changes outside torture-test, no npm dependency changes,
  no assertion weakening, no vacuous PASS, and no unrelated portability refactor.
- Other runs, including R4a, may hold shared contained ports. Do not launch the
  torture battery or tier campaigns in this run. Focused recorder tests must be
  isolated from those ports and all real daemon state. No paid real e2e.
- Build/test in this run's worktree only. Never rebuild the origin checkout,
  refresh its installed catalog, or stop/restart its live daemon.
- Normal workflow npm validation remains required with both lanes green and an
  empty isolation ledger. Give it at least 30 minutes at the command runner level.
  The coordinator will run the broader independent battery after R4a and other
  contained-port users are finished; do not claim that deferred proof as passed.
- Merge through this workflow to local main only; no origin push or release.

Test command: npm test
