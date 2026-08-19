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

## Evidence note — US-010 (a) landing (MACP3.1 salvage, run-8b9671d8)

This section records the honest landing of the work described above. The
original MACP3 run (run-0ba389c8) force-failed on the abandonment ceiling
(8/8) WITHOUT merging — it was mistakenly launched on the pi harness,
whose ~66-minute internal round cap kept truncating the long final-proof
round mid-work (clean exit, no STATUS, outcome other_output; evidence in
tamandua.log, "Orphaned step recovery" entries, 2026-08-19). The work
through US-009 was complete and good on branch
`feature/macp3-procfd-portability-vacuous-green`; the MACP3.1 salvage
adopted it, reconciled it with main (which had moved: KSNT a446deac +
T2.1 ea8563c9), re-validated it on the union, and lands it here.

### Adopted commits (US-001 .. US-009)

Each commit below was implemented and reviewed by its own verifier on the
original MACP3 branch, then merged into `feature/macp3.1-salvage-land`
(merge `3651f00c`, union HEAD `17ac9e7e`):

| Story | Commit | Deliverable |
|-------|--------|-------------|
| US-001 | `922c0f34` | Portable exclusive-create in oracle evidence writer (replaces the `/proc/self/fd/<n>/<name>` pattern) |
| US-002 | `94b2cafe` | Hermetic red-then-green tests for the portable exclusive create (simulate missing /proc via injectable platform seam) |
| US-003 | `14ac1c01` | /proc sweep of runtime tools (guard with a Darwin branch or inline doc) |
| US-004 | `58c249fc` | /proc sweep of test harnesses (`.test.sh` / test scripts) with inline docs |
| US-005 | `90c21f14` | Lint-style self-test banning unguarded `/proc` literals in torture-test (allowlist, G1/G2/G3/G4 gates) |
| US-006 | `01bfc95f` | Fail-closed predicate semantics: absent/failed host profile => TEST_INFRA_FAIL (host-profile-missing), never a silent skip |
| US-007 | `67f83c11` | Tests for fail-closed predicate semantics (unit + controller-level) |
| US-008 | `ba3fc754` | Vacuity guard for BARE verdicts: all-scripted-skipped => RED (vacuous-campaign finding) |
| US-009 | `f53737f9` | Red-then-green proof for the bare vacuity guard (branch HEAD) |

### Union re-validation evidence (US-002 .. US-005, run-8b9671d8)

All suites were re-run on the merged union from repo root and exited 0 —
the adopted branch was NOT assumed correct because its own verifier passed
it. Evidence-pointer commits: US-002 `c973db58`, US-003 `519ee6a7`,
US-004 `f70ec2d3`, US-005 `51baebd0`.

- **Scope-isolation suite (T2.1 reconciliation)** — `node --test
  torture-test/self-tests/tier1-daemon-control-scope-isolation.test.ts`
  (7/7) and `tier2-cross-worktree-scope-isolation.test.ts` (6/6): the
  per-worktree daemon-control scope derivation and stop isolation stay
  green on the union with the MACP3 /proc sweep.
- **/proc portability lint + evidence portability** — `node --test
  torture-test/self-tests/tier0-procfs-portability-lint.test.ts` (11/11,
  incl. the G1/G2/G3/G4 mutation proofs; G4 covers the four T2.1-owned
  daemon-control paths) and `node --test
  torture-test/oracles/lib/evidence-portability.test.mjs` (8/8: portable
  exclusive-create, Darwin no-/proc simulation, O_NOFOLLOW, containment).
- **Vacuity guard red-then-green + fail-closed predicates** — `node
  --test torture-test/self-tests/tier1-bare-vacuity-red-green.test.ts`
  (3/3: RED arm all-scripted-skipped => FINDINGS exit 1 with a
  vacuous-campaign finding; GREEN arm exit 0 with 4 genuinely executed
  scripted cells) and `node --test torture-test/bin/tt-report.test.mjs`
  (19/19 fail-closed predicate + vacuity verdict unit tests).
- **Tier2-assets guard suite** — `node --test
  torture-test/self-tests/tier2-tier2-assets.test.ts` (8/8) and `bash
  torture-test/bin/tt-tier2-assets.test.sh` (22/22).
- **Typecheck** — `npm run build` (tsc typecheck + version injection)
  exits 0 on the union.

No genuine defect was found during the main reconciliation or the union
re-validation — no code fixes beyond the adopted branch were required.
The remaining original US-010 gates — (b) full self-test battery
`./torture-test/self-tests/run.sh` exit 0 and (c) bare
`./run-torture-test --tier1` GREEN with the vacuity guard live — are
recorded in the MACP3.1 landing report
(`impl-tasks/MACP3.1-salvage-complete-procfd-vacuity.md`).
