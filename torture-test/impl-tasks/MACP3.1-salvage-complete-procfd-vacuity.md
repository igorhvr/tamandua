# MACP3.1: adopt and land the MACP3 branch — /proc portability + vacuity guard (salvage of run-0ba389c8)

MACP3 (run-0ba389c8) force-failed on the abandonment ceiling (8/8) WITHOUT
merging: it was mistakenly launched on the pi harness, whose ~66-minute
internal round cap kept truncating US-010's long final-proof round mid-work
(clean exit, no STATUS, outcome other_output — evidence in tamandua.log,
"Orphaned step recovery" entries, 2026-08-19). The WORK IS DONE AND GOOD
through US-009 on branch:

  feature/macp3-procfd-portability-vacuous-green
  (HEAD f53737f9 "US-009 - Red-then-green proof for the bare vacuity guard")

Your job: land it honestly.

1. Merge branch feature/macp3-procfd-portability-vacuous-green into your
   work branch (it is 10+ commits of reviewed-by-its-own-verifier work:
   portable exclusive-create replacing /proc/self/fd in the oracle
   evidence writer + host-profile path, a /proc sweep of runtime tools
   and test harnesses with guarded/documented sites, an unguarded-/proc
   lint self-test, fail-closed predicate semantics [unevaluable =>
   TEST_INFRA_FAIL, never silent skip], and the bare-verdict vacuity
   guard with red-then-green proof).
2. Rebase/reconcile onto current main (main has moved: KSNT a446deac +
   T2.1 ea8563c9 landed daemon-control/controller/scenario changes).
   Resolve semantically, not just textually: T2.1 changed tt-controller
   provisioning and daemon-control; re-run the relevant self-tests after
   reconciliation.
3. Verify the adopted work on the union honestly — do not assume the
   branch is correct because MACP3's verifier passed it: run the /proc
   lint self-test, the vacuity red-then-green tests, the scope-isolation
   suite, and the tier2-assets guard suite; all green from repo root.
4. Complete the original US-010: MACP3 task doc updated
   (torture-test/impl-tasks/ evidence note), full self-test battery
   `./torture-test/self-tests/run.sh` exit 0 from repo root, and bare
   `./run-torture-test --tier1` GREEN on the merged result — genuinely
   executed scripted cells (the vacuity guard itself must be live), in a
   quiet window (53xx free; if busy, wait — do not weaken the gate).
5. Report: confirm each original MACP3 acceptance item (portability fix,
   /proc sweep completeness, fail-closed predicates, vacuity guard) with
   pointers to the adopted commits + your union re-validation evidence.

## Hard constraints

- Files ONLY inside torture-test/. Zero tokens. Live daemon (33xx)
  untouched. No concurrent torture runs expected; if 53xx ports are
  busy anyway, treat it as a quiet-window wait, not an error to fix.
- Do NOT re-implement from scratch — adopt the branch; write new code
  only where the main-reconciliation or your re-validation finds a
  genuine defect (document any such fix distinctly in your report).

---

## Landing report — MACP3.1 salvage (run-8b9671d8, US-009)

This section is the landing report for the MACP3.1 salvage: it confirms
each original MACP3 acceptance item (from
`impl-tasks/MACP3-procfd-portability-vacuous-green.md`) against the adopted
commits (merged at `3651f00c`, union HEAD `17ac9e7e`, branch
`feature/macp3.1-salvage-land`) and the union re-validation evidence
recorded by the US-002..US-005 verification stories (evidence-pointer
commits `c973db58` / `519ee6a7` / `f70ec2d3` / `51baebd0`) plus the
US-010 gates completed by US-006..US-008 (`70656bdf` / `fac8f443` /
`ae9611dd`).

### Acceptance item 1 — Portability fix: portable exclusive-create replaces /proc/self/fd

- **Adopted commits:** `922c0f34` (US-001 — portable exclusive-create in the
  oracle evidence writer, replacing the `/proc/self/fd/<n>/<name>` pattern)
  and `94b2cafe` (US-002 — hermetic red-then-green proof simulating a
  missing /proc via an injectable platform seam).
- **Union re-validation evidence:** `node --test
  torture-test/self-tests/tier0-procfs-portability-lint.test.ts` exits 0
  (11/11, incl. the G1/G2/G3/G4 gates) and `node --test
  torture-test/oracles/lib/evidence-portability.test.mjs` exits 0 (8/8:
  portable exclusive-create, Darwin no-/proc simulation, O_NOFOLLOW,
  containment) — recorded as US-003 evidence pointer `519ee6a7`.

### Acceptance item 2 — /proc sweep completeness

- **Adopted commits:** `14ac1c01` (US-003 — /proc sweep of runtime tools,
  every site guarded with a Darwin branch or inline linux-only doc),
  `58c249fc` (US-004 — /proc sweep of test harnesses, guarded with inline
  docs), and `90c21f14` (US-005 — unguarded-/proc lint self-test with a
  file-granularity ALLOWLIST, G1/G2/G3/G4 gates).
- **Union re-validation evidence:** `node --test
  torture-test/self-tests/tier0-procfs-portability-lint.test.ts` exits 0
  (11/11) on the union — the lint scans every tracked torture-test file and
  its G4 gate enumerates the four T2.1-owned daemon-control paths
  (`bin/daemon-control`, `bin/daemon-control.test.sh`,
  `scenarios/w4.23/daemon-cross-runtime-restart/run-cross-runtime.mjs`,
  `scenarios/w4.49/run-update-arm.mjs`) — recorded as US-003 evidence
  pointer `519ee6a7`.

### Acceptance item 3 — Fail-closed predicates: unevaluable => TEST_INFRA_FAIL, never silent skip

- **Adopted commits:** `01bfc95f` (US-006 — absent/failed host profile must
  not silently evaluate predicates to false: unevaluable => TEST_INFRA_FAIL,
  category host-profile-missing, never NOT_RUN(predicate)) and `67f83c11`
  (US-007 — unit + controller-level tests for the fail-closed semantics).
- **Union re-validation evidence:** `node --test
  torture-test/bin/tt-report.test.mjs` exits 0 (19/19: host-profile-missing
  => INFRA exit 2; legacy NOT_RUN(host-profile-missing) also fails closed;
  the verdict graph precedence INFRA > vacuity FINDINGS) — recorded as
  US-004 evidence pointer `f70ec2d3`.

### Acceptance item 4 — Vacuity guard for bare verdicts

- **Adopted commits:** `ba3fc754` (US-008 — all-scripted-skipped bare
  campaign => RED with an explicit vacuous-campaign finding, tier-agnostic
  wiring in tt-run/controller verdict logic) and `f53737f9` (US-009 —
  red-then-green proof: RED arm all-skipped => FINDINGS exit 1 with a
  machine-parseable vacuous-campaign finding; GREEN arm normal bare tier1
  still exit 0 with genuinely executed scripted cells).
- **Union re-validation evidence:** `node --test
  torture-test/self-tests/tier1-bare-vacuity-red-green.test.ts` exits 0
  (3/3) on the union — recorded as US-004 evidence pointer `f70ec2d3`.
  Live gate on the merged result: bare `./run-torture-test --tier1` GREEN
  exit 0 with the 4 scripted cells (W2.21, W2.23a, W2.23b, W2.23c) genuinely
  executed (terminal attempts > 0, NOT all NOT_RUN) and no vacuous-campaign
  finding, in a quiet window (ports 5334/5338/5339 free) — recorded as
  US-008 evidence pointer `ae9611dd`, re-asserted twice more by the
  tier1-repeatability test in US-007 (`fac8f443`).

### Original US-010 gates (a)/(b)/(c)

- **(a) Task doc updated with evidence note:** `70656bdf` (US-006) — appended
  the evidence note to `impl-tasks/MACP3-procfd-portability-vacuous-green.md`
  with the adopted-commits table and union re-validation suites.
- **(b) Full self-test battery exit 0:** `fac8f443` (US-007) —
  `./torture-test/self-tests/run.sh` exit 0 (108/108) twice consecutively
  from repo root, working tree clean.
- **(c) Bare `./run-torture-test --tier1` GREEN:** `ae9611dd` (US-008) —
  exit 0 (GREEN), scripted cells genuinely executed, vacuity guard live,
  ports free, zero tokens.

### Union re-validation summary (US-002..US-005)

All eight union re-validation suites were re-run from repo root on the
merged union and exited 0 — the adopted branch was not assumed correct
because MACP3's own verifier passed it:

- **Scope-isolation suite (T2.1 reconciliation)** —
  `node --test torture-test/self-tests/tier1-daemon-control-scope-isolation.test.ts`
  (7/7) and
  `node --test torture-test/self-tests/tier2-cross-worktree-scope-isolation.test.ts`
  (6/6) — evidence pointer `c973db58` (US-002).
- **/proc portability lint + evidence portability** —
  `node --test torture-test/self-tests/tier0-procfs-portability-lint.test.ts`
  (11/11) and
  `node --test torture-test/oracles/lib/evidence-portability.test.mjs`
  (8/8) — evidence pointer `519ee6a7` (US-003).
- **Vacuity guard red-then-green + fail-closed predicates** —
  `node --test torture-test/self-tests/tier1-bare-vacuity-red-green.test.ts`
  (3/3) and `node --test torture-test/bin/tt-report.test.mjs` (19/19) —
  evidence pointer `f70ec2d3` (US-004).
- **Tier2-assets guard suite** —
  `node --test torture-test/self-tests/tier2-tier2-assets.test.ts` (8/8)
  and `bash torture-test/bin/tt-tier2-assets.test.sh` (22/22) — evidence
  pointer `51baebd0` (US-005).
- **Typecheck** — `npm run build` (tsc typecheck + version injection)
  exits 0 on the union.

### Genuine-defect fixes during reconciliation

None. The main reconciliation (US-001, merge `3651f00c`) was textually and
semantically clean, and every union re-validation (US-002..US-005) exited 0
from repo root without requiring a code fix — no new code beyond the adopted
branch was needed for the union. The only additional authored files are this
landing report and its pinning self-test (US-009).
