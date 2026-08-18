# MACP3: /proc/self/fd evidence writes break Darwin (O3z + host-profile) AND all-predicate-skip makes bare GREEN vacuous

Mac validation at a446deac, both campaigns created within 1s and terminal
in <30ms (evidence: torture-test/var/results on the mac,
campaign-20260818T163719127Z-a61d3870 tier0, campaign-20260818T163720247Z-3ca0ef6d tier1):

- **Tier0 INFRA_FAILURE (correctly fail-closed):** W0.0-fast, O3z —
  "exclusive evidence create failed for o3z-token-gate.json: ENOENT
  .../proc/self/fd/11/o3z-token-gate.json". `/proc` does not exist on
  Darwin. Host-profile generation fails the same way — the mac has NO
  var/host-profile.json after the run.
- **Tier1 GREEN (exit 0) — VACUOUS:** all 30 cases NOT_RUN in 21ms:
  24 pending-real (correct for bare mode) + the 4 scripted W2 cells
  NOT_RUN category=predicate — their `requires` predicates evaluated
  false/unevaluable because the host profile is absent (the same /proc
  defect upstream). Zero cells executed; verdict still GREEN. This is
  the E2.2 vacuous-GREEN class resurfacing through the predicate path.

1. **Portability fix:** replace the /proc/self/fd/<n>/<name> exclusive-
   create pattern in the oracle evidence writer (and host-profile /
   tt-verify-environment if shared) with a portable exclusive create
   (e.g. open with O_CREAT|O_EXCL / fs 'wx' relative to a real dirfd or
   path). Then sweep: `git grep -n "/proc/" -- torture-test/` and for
   every hit either (a) make it portable, (b) guard it with an explicit
   platform check that has a Darwin branch, or (c) document inline why
   it is linux-only AND unreachable on Darwin. No silent linux-isms.
2. **Fail-closed predicate semantics:** an absent/failed host profile
   must NOT silently evaluate predicates to false. If predicate
   evaluation is impossible, the case outcome must be TEST_INFRA_FAIL
   (category host-profile-missing or similar), never NOT_RUN(predicate).
3. **Vacuity guard for bare verdicts:** a bare campaign may only be
   GREEN if at least one scripted cell actually EXECUTED and every
   scripted cell in the manifest reached a real terminal outcome
   (PASS/FAIL/INFRA) or a *legitimately evaluated* predicate skip.
   All-scripted-skipped => RED with an explicit vacuous-campaign
   finding. Wire this into tt-run/controller verdict logic wherever
   bare GREEN is computed (tier-agnostic: tier0/1/2).
4. **Proofs (this run executes on linux — Darwin cannot be E2E-proven
   here; the operator validates on the mac after merge):**
   - Hermetic red-then-green unit tests for the portable exclusive
     create (simulate missing /proc via injectable path/platform seam).
   - A lint-style self-test banning unguarded "/proc/" literals in
     torture-test (allowlist for documented linux-only guarded sites).
   - Red-then-green for the vacuity guard: force all scripted cells to
     predicate-skip on linux and show the campaign goes RED with the
     vacuous-campaign finding; then a normal bare tier1 still GREEN.
   - Bare `./run-torture-test --tier1` GREEN on the merged result
     (linux, quiet window — if 53xx ports are busy from a concurrent
     run, wait for them; do not weaken the environment gate).

## Hard constraints

- Files ONLY inside torture-test/. Zero tokens. Live daemon (33xx)
  untouched. A concurrent run (T2.1) owns tier2 scenario/case files and
  daemon-control changes in its branch — do NOT touch daemon-control or
  tier2 scenario dirs; oracle evidence writer, tt-verify-environment,
  predicate evaluation, and verdict logic are yours. Rebase onto
  current main before finalize if it has moved.
