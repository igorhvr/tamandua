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

---

## US-003 proof — twice-run repeatability and cleanup on the corrected harness (2026-09-06)

Story: US-003 — "Twice-run repeatability and cleanup proof on the corrected
recorder harness". This is the corrected-harness acceptance gate: run the
repaired full legacy recorder harness (`torture-test/bin/tt-recorder.test.sh`)
twice consecutively and prove exact WAL results, untouched pre-existing
synthetic neighbor state, no surviving owned children, no production listener
access, and a clean tracked tree. No full tier ladder was added; the harness is
NOT registered in `torture-test/self-tests/run.sh` (unchanged, as required).

### Minimal intent-preserving harness correction required for the gate

Running the full harness end-to-end surfaced exactly two PRE-EXISTING stale
structural greps in the harness that failed against the already-merged,
correct tool text (both fail identically at the US-001 parent commit; the
US-001/US-002 diffs touch neither the tool nor those greps). Because this
story's gate requires two consecutive runs that each exit 0 with FAILURES==0,
the two stale greps received the coordinator-noted minimal intent-preserving
correction (no assertion weakening, no vacuous PASS, tool runtime unchanged):

1. Test 73 first grep — asserted `cmd_stop()` must contain an inline
   `tr '\0' ' ' < ...cmdline` evidence read. The merged tool's `cmd_stop()`
   delegates that read to the shared `_pid_cmdline` evidence helper (same
   /proc-or-ps NUL-to-space read). The grep now accepts either the inline form
   OR the `_pid_cmdline` delegation (`grep -qE '_pid_cmdline|tr.*\\0.* .*<.*cmdline'`),
   so the assertion still FAILs if cmd_stop ever signals without an
   evidence-based cmdline check.
2. Test 91 last grep — asserted the production-port guard never uses name-only
   matching (`ss |netstat.*grep|pgrep.*port|lsof.*grep`). The guard's `ss `-token
   pattern false-matched the word "less " inside a tool comment ("a /proc-less
   host (Darwin) skips it") within the -A30 window. The scan now masks
   '#'-comment text first (`sed 's/[[:space:]]*#.*$//'`, mirroring the
   reintroduction-guard mask style) so doc prose cannot trip it, while a real
   executed ss/netstat/pgrep/lsof name-match still FAILs (trip re-verified on a
   scratch copy with an inserted executed `ss -tulpn | grep "3334"` line).

Focused gates before the full harness (all exit 0, 0 FAIL):
- `bash torture-test/bin/tt-recorder-guard-proof.test.sh` -> 18 PASS
- `bash torture-test/bin/tt-recorder-isolation.test.sh` -> 13 PASS
- `bash torture-test/bin/tt-recorder-port-isolation.test.sh` -> 12 PASS
- `bash -n` on all five recorder shell files -> OK
- `node --test` individually (tier0-bash32-compat-lint 11 pass,
  tier0-gnu-portability-lint 18 pass, tier0-procfs-portability-lint 16 pass,
  tier0-home-literal-portability-lint 12 pass, tier0-macp5-gnu-ism-sweep 6 pass,
  tier1-final-acceptance 7 pass) -> all exit 0.

### Commands (reproducible; fresh per-invocation fixtures only)

External synthetic sentinel neighbor (its own mktemp root; NEVER the repo's
`torture-test/var`, never a harness fixture; wholly synthetic bytes):

```bash
NB="$(mktemp -d "${TMPDIR:-/tmp}/riso-us003-neighbor.XXXXXX")"
mkdir -p "$NB/torture-test/var/recorder" \
         "$NB/torture-test/var/home/.tamandua" \
         "$NB/torture-test/var/home/sentinel-cwd" \
         "$NB/torture-test/var/home-scripted/.tamandua"
printf '%s' 'neighbor-real-db-sentinel'     > "$NB/torture-test/var/home/.tamandua/tamandua.db"
printf '%s' 'neighbor-real-wal-sentinel'    > "$NB/torture-test/var/home/.tamandua/tamandua.db-wal"
printf '%s' 'neighbor-scripted-db-sentinel' > "$NB/torture-test/var/home-scripted/.tamandua/tamandua.db"
printf '%s' 'neighbor-identifiable-sentinel' > "$NB/torture-test/var/home/.tamandua/identifiable-file"
(cd "$NB/torture-test/var/home/sentinel-cwd" && exec sleep 3600) &
SPID=$!
printf '%s\n' "$SPID" > "$NB/torture-test/var/recorder/tt-recorder.pid"
# baseline byte copies kept OUTSIDE the neighbor for cmp
```

Two consecutive full-harness runs (each run allocates its own fresh fixture and
removes only its own recorded roots):

```bash
bash torture-test/bin/tt-recorder.test.sh   # run 1
bash torture-test/bin/tt-recorder.test.sh   # run 2
```

### Results (run in worktree 910-8711e8d5 on feature/riso-recorder-isolation)

- Run 1: exit **0**; `=== All tests passed ===`; 202 PASS / 0 FAIL
  (`FAIL:` count 0).
- Run 2: exit **0**; `=== All tests passed ===`; 202 PASS / 0 FAIL
  (`FAIL:` count 0).
- Fixture roots (removed by each run's exit cleanup; no leftover process):
  run1 `/tmp/tt-recorder-selftest.IMnnJY`, run2 `/tmp/tt-recorder-selftest.Fkv2su`;
  neither directory exists after the run and `ps`/`pgrep` scoped to those paths
  returns nothing.

WAL exactness lines present in BOTH runs (exact fixture bytes, no >=0 or
always-true condition):
```
PASS: real daemon db_size_bytes (15) matches actual stat size (15)
PASS: real daemon wal_size_bytes (18) matches actual wal size (18)
PASS: scripted daemon db_size_bytes (11) matches actual file size
PASS: scripted daemon wal_size_bytes=0 when .db-wal file does not exist
```

Sentinel / child / port-guard checks after BOTH runs:
- external sentinel process (pid 2652459, `sleep 3600`, cwd
  `/tmp/riso-us003-neighbor.vickRF/torture-test/var/home/sentinel-cwd`) still
  alive via `kill -0` after both runs; identity-verified and stopped after the
  proof (no owned child survives).
- neighbor pidfile + all four sentinel files byte-identical (`cmp`) to the
  baseline copies held outside the neighbor.
- no process whose cmdline references either run's fixture var path remains.
- harness isolation regression inside each run: "isolation: neighbor sentinel
  process still alive", "neighbor recorder pidfile byte-identical", "all
  neighbor sentinel files byte-identical (cmp)", "only the sentinel remains
  registered (all section-owned children stopped)" — all PASS in both runs.
- port guards: Test 88 isolated behavioral fixture PASS (allowed contained
  random-port listener included; excluded synthetic-pid production-port
  observation via fake-lsof) and Test 92 reintroduction guard PASS
  ("no executed production-port bind or source-checkout state usage") in BOTH
  runs; the guard-adjacent PASS lines below appear verbatim in both run logs
  (run1 lines 316-350/399-402; run2 the same 16 lines), and `ss -ltn` on
  3334/3338/3339 before and after shows only the pre-existing product daemons
  — no new socket was created by either run:
```
PASS: production cwd exclusion: process with cwd under real ~/.tamandua (NOT worktree) is excluded from discovery
PASS: worktree cwd safety: process under ~/.tamandua/worktrees/ IS included
PASS: allowed contained listener (harness-88a): real _is_production_ports rc=1 (not production) for random port ... (included in real discovery)
PASS: excluded production port (harness-88b): real _is_production_ports rc=0 (production) for synthetic pid 987654321 under fake-lsof LISTEN on 3334
PASS: excluded production port (harness-88b): without-shim degradation — rc=1 with the explicit degradation line
PASS: excluded production port (harness-88b): verbose 'excluding production process' line fires
PASS: port guard uses /proc/net/tcp (evidence-based socket inode matching)
PASS: port guard does NOT use ss/netstat/lsof for process matching (evidence-based)
PASS: reintroduction guard (harness source): no executed production-port bind or source-checkout state usage
PASS: reintroduction guard (fixture tool copy): no executed production-port bind or source-checkout state usage
PASS: isolation: neighbor sentinel process still alive ...
PASS: isolation: neighbor recorder pidfile byte-identical ...
PASS: isolation: all neighbor sentinel files byte-identical (cmp)
PASS: isolation: only the sentinel remains registered (all section-owned children stopped)
```
  The harness path guard (TT_ROOT_VAR-under-fixture startup + re-derivation
  guards, both silent-OK / FAIL-loudly) never printed a FAIL in either run —
  the run would have aborted with a "FAIL: TT_ROOT_VAR ... is not under the
  invocation fixture root" line and a non-zero exit otherwise.
- git status --porcelain empty after the runs (only the intended committed
  story files below).

Evidence retained (never deleted): driver + logs under
`/tmp/riso-us003-proof-area/` (driver.out), `/tmp/riso-us003-proof.em5ORI/`
(run1.log, run2.log, baseline/), `/tmp/riso-us003-neighbor.vickRF/`.

### Lint allowlist entry (verifier fix, same story)

The 16-pass `tier0-procfs-portability-lint` claim above requires a
documentation-category ALLOWLIST entry for this file in
`torture-test/self-tests/tier0-procfs-portability-lint.test.ts` (this doc's
`/proc` occurrences — the `/proc-or-ps` and `/proc-less host` prose in the
Test 73/91 correction narrative and the verbatim `PASS: port guard uses
/proc/net/tcp` harness line — are documentation text; the doc performs no
runtime procfs access). The entry landed with this story's follow-up commit;
re-run of `node --test torture-test/self-tests/tier0-procfs-portability-lint.test.ts`
-> 16 pass / 0 fail, exit 0.

### Story commit

`feat: US-003 - Twice-run repeatability and cleanup proof on the corrected
recorder harness` — includes the two minimal intent-preserving harness grep
corrections above and this evidence section. Typecheck (`npm run build`) exit 0.
