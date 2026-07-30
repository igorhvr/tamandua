# 05 — Wave 1: Language Smoke (T+4h → T+8h, soft 3M / hard 4M tokens)

Purpose: prove the **per-language plumbing** — setup-agent stack detection,
TEST_CMD discovery and shim wrapping, TSTX keying under each ecosystem's
junk, token attribution — with the cheapest real workflows, before the
expensive families run. Concurrency 2 (one pi + one hermes lane).

## Scenarios

Per language L ∈ {java, rust, python, go, ts} — restricted to the
languages the host profile supports (`T1` = also in Tier-1, where
L ∈ {python, ts} only):

| ID | Run | Task | Specific assertions (beyond standard battery) |
|----|-----|------|-----------------------------------------------|
| W1.L1 `T1` | `do-now`, pi | Add one small pure function + its test to tt-L; commit. | Setup-free workflow works per language; O8 scope; commit exists; suite green after. (tt-python: pre-bootstrapped arming — 02.) |
| W1.L2 `T1` | **`tt-shim-probe`** (a purpose-built one-step custom workflow whose input template contains `TEST_CMD: {{test_cmd}}` and the standard shim-usage block), pi, launched with `--context test_cmd='<RAW command, unwrapped>'` | "Run the test suite using TEST_CMD verbatim; report the command and outcome." | The scheduler's `wrapTestCmdInContext` adds **exactly one** wrapper to the raw command (wrapper-growth fossil DC19); TSTX row recorded under the committed tree; agent did not substitute its own command. Two earlier drafts were unimplementable here: do-now/just-do-it never render `{{test_cmd}}` at all, and pre-seeding an already-wrapped command would be deterministically double-wrapped (no de-dup guard exists in source) — seed RAW, let the product wrap. This custom workflow also gives the authoring surface (DC46) its second data point. |
| W1.L3 `T1` | `bug-fix`, pi | Fix the easiest seeded bug (`BUG-*1`) — direct (non-worktree) mode in a disposable clone. | Full triage→fix→verify chain; setup step discovers BUILD_CMD/TEST_CMD (tt-python: raw arming — setup must bootstrap the venv); the workflow's own `{{test_cmd}}` templating wraps the shim exactly once; verifier honest-retry verdicts route to fixer, not run failure. |

**W1.X1 (pi):** rerun one W1.L1 (tt-java at Tier-2; tt-ts at Tier-1) from
a working-clone path containing a space + non-ASCII char (02's
path-hostility probe): launch, worktree-less direct mode, TSTX record —
all path-string surfaces survive.

**W1.M1 `T1` (hermes):** one `do-now` hermes on tt-python — O3
attribution asserted under real workflow shape before hermes carries any
expensive W3 lane.

## Cross-cutting checks at wave boundary

- **TSTX cross-run replay `T1`:** relaunch W1.L2 for two languages with
  unchanged trees; suites must replay (`TAMANDUA-TEST CACHED`, ledger row
  reuse, near-zero suite wall time) rather than re-execute.
- **Attribution medians `T1`:** record per-language pi token medians — these
  seed the O3 advisory bands and the W3 comparisons.
- **No cross-fixture bleed `T1`:** O9 confirms every ledger row's
  origin_repo points at the correct fixture clone (full cross-repo
  collision probe is W4.28).
- Run count (manifest-derived view): ≈17 at Tier-2 (5 languages × 3
  scenarios + X1 + M1 + replay relaunches); Tier-1 ≈ 8.

## Wave gate (mechanical outcomes only — 03)

Zero unwaived S0/S1 and mechanical PRODUCT_FAIL rate < 10% → open W2.
A single language failing *systematically* (e.g. maven wrapping broken)
quarantines that language's lanes in W2/W3 — filed, campaign continues.
Behavioral rates are recorded but do not gate at W1 sample sizes.
