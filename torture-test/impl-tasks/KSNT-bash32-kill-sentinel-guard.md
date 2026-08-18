# KSNT: tt-kill-sentinel is bash-3.2-unsafe — unguarded array expansion trips the MACP1 lint gate (union gap E3.C.1 × MACP1)

The tier0 self-test `tier0-bash32-compat-lint.test.ts` (hard gate) is RED on
main since the E3.C.1 + MACP1 concurrent merges:

  torture-test/bin/tt-kill-sentinel: 218: unguarded command-argument
  expansion "${SUITE_CMD[@]}" under set -u — an empty array aborts on
  bash 3.2; use the guarded form ${name[@]+"${name[@]}"}

Root cause is a merge-union gap: E3.C.1 (74f4d332, merged 14:55) added the
line; MACP1 (861d2a7d, merged 15:45) added the lint; each branch was green
alone, the union is red. No behavior regression on linux, but the unguarded
form ABORTS on Darwin bash 3.2 when SUITE_CMD is empty, so this blocks the
mac scripted-campaign rungs.

1. Fix line 218 with the guarded idiom `${SUITE_CMD[@]+"${SUITE_CMD[@]}"}`.
2. Sweep tt-kill-sentinel (whole file) for any other bash-3.2-unsafe
   constructs the lint's pattern list covers, and fix them the same way —
   the lint reported only line 218, but confirm by running it, not by eye.
3. Prove: `node --test torture-test/self-tests/tier0-bash32-compat-lint.test.ts`
   green from the REPO ROOT (the suite derives repoRoot from cwd);
   the E3.C.1 kill-ancestry sentinel tests still green (do not change
   sentinel semantics — the guarded form is expansion-equivalent for
   non-empty arrays); `./torture-test/self-tests/run.sh` shows the lint
   suite PASS (other suites may legitimately fail on 53xx port contention
   from a concurrent run's scripted daemons — those are NOT yours and NOT
   a gate for this task; record which ones you observed and why).

## Hard constraints

- Files ONLY inside torture-test/. Zero tokens. Live daemon (33xx)
  untouched. A concurrent run (T2.1) owns tier2 scenario/case files and
  may cycle scripted daemons on 53xx — do not start scripted daemons and
  do not touch daemon-control; tt-kill-sentinel is yours.
