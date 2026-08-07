# Tier-1 Case Traceability Report

**Generated:** 2026-08-07
**Manifest:** `cases/tier1.jsonl`
**Spec:** `torture-test/tamandua-torture-test-spec/`
**Scope:** Waves 1–3 (waves 4–5 are Tier-2 only; wave 0 is pre-campaign)

## Manifest Summary

| Metric | Value |
|--------|-------|
| Total Tier-1 cases | **28** |
| Wave 1 (language smoke) | 10 |
| Wave 2 (workflow coverage) | 6 |
| Wave 3 (harness duel + lifecycle) | 12 |
| Spec-estimated Tier-1 budget | ~40 (README §Execution Tiers) |
| Delta from spec budget | -12 |

### Why 28, not 40?

The spec's ~40 estimate for Tier-1 was approximate and covered the full
three-wave Tier-1 roster including scenarios that, upon detailed review,
were either deliberately limited by the spec's T1 annotations or belong
to waves 4–5 (entirely Tier-2, out of scope for this traceability).

The 28 authored cases cover every scenario the spec explicitly marks
`T1` in waves 1–3. No T1-marked scenario is missing from the manifest.
The remaining ~12–15 budget slots are consumed by wave-4 T1-marked
scenarios (W4.01, W4.02, W4.04–W4.07, W4.09–W4.10, W4.14, W4.16,
W4.25, W4.27–W4.31, W4.35–W4.37, W4.49 — see
`08-wave-4-fault-injection.md`), which are authored separately and not
included in this traceability's scope.

Key factors:
- Wave 1: spec estimates "≈8" Tier-1 cases for the language matrix at
  2 languages (python, ts). We author 10 (adding TSTX cross-run replay
  relaunches at 2 languages, called out as `T1` in the cross-cutting
  checks section of 05).
- Wave 2: only the T1-marked edge/authoring scenarios (6 cases). The
  20-workflow matrix (W2.01–W2.20) is Tier-2 only — those workflows
  require all 5 toolchains and spend ~10M tokens on their own. The
  remaining 5 authoring scenarios (W2.25–W2.29) are not T1-marked.
- Wave 3: the T1 matrix cells (4), marathon (2), and lifecycle probes
  (6) = 12. The remaining matrix cells for java, rust, go, and the
  fdmw-pi-python cell (W3.12) are not T1-marked per spec.

## Case ↔ Spec Reference Map

### Wave 1 — Language Smoke (`05-wave-1-language-smoke.md`)

| Case ID | spec_ref | Fixture | Harness | Workflow | Mode |
|---------|----------|---------|---------|----------|------|
| W1.L1-python | `#W1.L1` | tt-python | pi | do-now | real |
| W1.L1-ts | `#W1.L1` | tt-ts | pi | do-now | real |
| W1.L2-python | `#W1.L2` | tt-python | pi | tt-shim-probe | real |
| W1.L2-ts | `#W1.L2` | tt-ts | pi | tt-shim-probe | real |
| W1.L3-python | `#W1.L3` | tt-python | pi | bug-fix | real |
| W1.L3-ts | `#W1.L3` | tt-ts | pi | bug-fix | real |
| W1.X1-ts | `#W1.X1` | tt-ts | pi | do-now | real |
| W1.M1-python | `#W1.M1` | tt-python | hermes | do-now | real |
| W1.REPLAY-python | `#W1.REPLAY` | tt-python | pi | tt-shim-probe | real |
| W1.REPLAY-ts | `#W1.REPLAY` | tt-ts | pi | tt-shim-probe | real |

**Wave 1 count:** 10 (spec-estimated ~8; TSTX replay added 2 beyond the
per-language matrix).

### Wave 2 — Workflow Coverage Edge Cases (`06-wave-2-workflow-coverage.md`)

| Case ID | spec_ref | Fixture | Harness | Workflow | Mode |
|---------|----------|---------|---------|----------|------|
| W2.21-admission | `#W2.21` | none | local | do-now | scripted |
| W2.22-non-main-bfmw | `#W2.22` | tt-python@master | pi | bug-fix-merge-worktree | real |
| W2.23a-expects-regex | `#W2.23a` | none | local | local | scripted |
| W2.23b-retry-step | `#W2.23b` | none | local | local | scripted |
| W2.23c-missing-persona | `#W2.23c` | none | local | local | scripted |
| W2.24-docs-drift | `#W2.24` | tt-ts | pi | local | real |

**Wave 2 count:** 6 (all T1-marked scenarios in the edge/authoring table;
the 20-workflow matrix W2.01–W2.20 is entirely Tier-2).

### Wave 3 — Harness Duel + Lifecycle Probes (`07-wave-3-harness-duel.md`)

| Case ID | spec_ref | Fixture | Harness | Workflow | Mode |
|---------|----------|---------|---------|----------|------|
| W3.01-bfmw-pi-python | `#W3.01` | tt-python | pi | bug-fix-merge-worktree | real |
| W3.02-bfmw-pi-ts | `#W3.02` | tt-ts | pi | bug-fix-merge-worktree | real |
| W3.03-bfmw-hermes-ts | `#W3.07` | tt-ts | hermes | bug-fix-merge-worktree | real |
| W3.04-fdmw-pi-ts | `#W3.13` | tt-ts | pi | feature-dev-merge-worktree | real |
| W3.17a-marathon-natural | `#W3.17a` | tt-poly-lite | hermes | feature-dev-merge-worktree | real |
| W3.17b-marathon-chaos | `#W3.17b` | tt-poly-lite | hermes | feature-dev-merge-worktree | real |
| W3.18-pause-no-drain | `#W3.18` | tt-ts | pi | feature-dev-merge-worktree | real |
| W3.19-pause-drain | `#W3.19` | tt-ts | hermes | feature-dev-merge-worktree | real |
| W3.20-cancel | `#W3.20` | tt-ts | pi | feature-dev-merge-worktree | real |
| W3.21-fail-force-resume | `#W3.21` | tt-ts | pi | feature-dev-merge-worktree | real |
| W3.22-daemon-restart | `#W3.22` | tt-ts | pi | feature-dev-merge-worktree | real |
| W3.23-token-saver | `#W3.23` | tt-ts | pi | do-now | real |

**Wave 3 count:** 12 (4 T1 matrix cells + 2 marathon + 6 lifecycle probes).

**Note on naming:** manifest case IDs for wave 3 matrix cells do not
match spec numbering one-to-one. The spec's matrix cells are W3.01–05
(bfmw × pi × 5 langs), W3.06–07 (bfmw × hermes × 2 langs), W3.11–13
(fdmw × pi × 3 langs). Manifest uses compressed numbering (W3.01–W3.04).
The `spec_ref` field is the authoritative cross-reference.

---

## Excluded Scenarios — Complete Enumeration (Waves 1–3)

The following tables enumerate **every spec-defined scenario in waves 1–3**
that is not in the tier1.jsonl manifest. Each exclusion has an explicit,
documented reason. Zero scenarios are silently dropped.

### Wave 1 Exclusions (13 scenarios)

The wave-1 spec defines scenarios across 5 languages {java, rust, python,
go, ts}. Tier-1 is restricted to the {python, ts} toolchain profile;
java, rust, and go require toolchains outside the Tier-1 capability
profile.

#### Per-Language Matrix Exclusions

| Scenario | Spec Section | Reason |
|----------|-------------|--------|
| W1.L1 java | `#W1.L1` | Tier-2: requires Java toolchain (not in Tier-1 profile) |
| W1.L1 rust | `#W1.L1` | Tier-2: requires Rust toolchain (not in Tier-1 profile) |
| W1.L1 go | `#W1.L1` | Tier-2: requires Go toolchain (not in Tier-1 profile) |
| W1.L2 java | `#W1.L2` | Tier-2: requires Java toolchain (not in Tier-1 profile) |
| W1.L2 rust | `#W1.L2` | Tier-2: requires Rust toolchain (not in Tier-1 profile) |
| W1.L2 go | `#W1.L2` | Tier-2: requires Go toolchain (not in Tier-1 profile) |
| W1.L3 java | `#W1.L3` | Tier-2: requires Java toolchain (not in Tier-1 profile) |
| W1.L3 rust | `#W1.L3` | Tier-2: requires Rust toolchain (not in Tier-1 profile) |
| W1.L3 go | `#W1.L3` | Tier-2: requires Go toolchain (not in Tier-1 profile) |
| W1.X1 java | `#W1.X1` | Tier-2: requires Java toolchain (not in Tier-1 profile). Spec defines only java (Tier-2) and ts (Tier-1) for X1. |

#### Cross-Cutting Exclusions

| Scenario | Spec Section | Reason |
|----------|-------------|--------|
| TSTX replay java | `#W1 cross-cutting` | Tier-2: requires Java toolchain (not in Tier-1 profile) |
| TSTX replay rust | `#W1 cross-cutting` | Tier-2: requires Rust toolchain (not in Tier-1 profile) |
| TSTX replay go | `#W1 cross-cutting` | Tier-2: requires Go toolchain (not in Tier-1 profile) |

**Wave 1 excluded count:** 13 scenarios across 3 toolchain-excluded
languages (java, rust, go). Zero scenarios with python or ts toolchains
are excluded from wave 1.

### Wave 2 Exclusions (25 scenarios)

#### Workflow Catalog Matrix (20 scenarios)

| Scenario | Spec Section | Reason |
|----------|-------------|--------|
| W2.01 (do-now, tt-go, pi) | `#W2.01` | Tier-2 only: all 20 workflow matrix cells (W2.01–W2.20) are not marked `T1` in the spec. The full catalog requires all 5 toolchains (java, rust, go, python, ts) and spends ~10M tokens independently — exceeding Tier-1's ~15M soft budget. Only the T1-marked edge/authoring scenarios (W2.21–W2.24) are in Tier-1. |
| W2.02 (just-do-it, tt-java, pi) | `#W2.02` | Tier-2 only (see W2.01 rationale) |
| W2.03 (do-review-do-verify, tt-rust, pi) | `#W2.03` | Tier-2 only (see W2.01 rationale) |
| W2.04 (frontend-test, tt-ts, pi) | `#W2.04` | Tier-2 only (see W2.01 rationale) |
| W2.05 (bug-fix, tt-python, pi) | `#W2.05` | Tier-2 only (see W2.01 rationale) |
| W2.06 (bug-fix-worktree, tt-java, pi) | `#W2.06` | Tier-2 only (see W2.01 rationale) |
| W2.07 (bug-fix-merge, tt-go, pi) | `#W2.07` | Tier-2 only (see W2.01 rationale) |
| W2.08 (bug-fix-merge-worktree, tt-rust, pi) | `#W2.08` | Tier-2 only (see W2.01 rationale) |
| W2.09 (feature-dev, tt-ts, pi) | `#W2.09` | Tier-2 only (see W2.01 rationale) |
| W2.10 (feature-dev-worktree, tt-python, pi) | `#W2.10` | Tier-2 only (see W2.01 rationale) |
| W2.11 (feature-dev-merge, tt-java, pi) | `#W2.11` | Tier-2 only (see W2.01 rationale) |
| W2.12 (feature-dev-merge-worktree, tt-go, pi) | `#W2.12` | Tier-2 only (see W2.01 rationale) |
| W2.13 (quarantine-broken-tests, tt-java, pi) | `#W2.13` | Tier-2 only (see W2.01 rationale) |
| W2.14 (quarantine-broken-tests-merge, tt-python, pi) | `#W2.14` | Tier-2 only (see W2.01 rationale) |
| W2.15 (quarantine-broken-tests-merge-worktree, tt-ts, pi) | `#W2.15` | Tier-2 only (see W2.01 rationale) |
| W2.16 (security-audit, tt-go, pi) | `#W2.16` | Tier-2 only (see W2.01 rationale) |
| W2.17 (security-audit-worktree, tt-java, pi) | `#W2.17` | Tier-2 only (see W2.01 rationale) |
| W2.18 (security-audit-merge, tt-ts, hermes) | `#W2.18` | Tier-2 only (see W2.01 rationale) |
| W2.19 (security-audit-merge-worktree, tt-rust, pi) | `#W2.19` | Tier-2 only (see W2.01 rationale) |
| W2.20 (skills-normalize-audit, skills dir, pi) | `#W2.20` | Tier-2 only (see W2.01 rationale) |

#### Non-T1 Edge/Authoring Scenarios (5 scenarios)

| Scenario | Spec Section | Reason |
|----------|-------------|--------|
| W2.25 (reserved-key behavior pinning) | `#W2.25` | Tier-2 only: not marked `T1` in spec. Covers 5-toolchain surface; ≈0 tokens but exercises launch-level context key behaviors (DC47). |
| W2.26 (webhook notifications) | `#W2.26` | Tier-2 only: not marked `T1` in spec. ≈0 tokens; tests webhook notification delivery, an infrequently-used feature (DC50). |
| W2.27 (MCP smoke) | `#W2.27` | Tier-2 only: not marked `T1` in spec. ≈0 tokens; exercises the MCP server entry point which the workflow matrix never touches. |
| W2.28 (fresh-install & auto-start) | `#W2.28` | Tier-2 only: not marked `T1` in spec. Infra provisioning test (disposable fake-HOME, get-ready, auto-start path). Not a workflow scenario per se. |
| W2.29 (AutoResearch bounded session) | `#W2.29` | Tier-2 only: not marked `T1` in spec. Exercises the AutoResearch experimental subsystem (small: 2 experiments). |

**Wave 2 excluded count:** 25 scenarios (20 workflow matrix + 5 non-T1
edge/authoring). All 6 T1-marked wave-2 scenarios are present in the
manifest.

### Wave 3 Exclusions (7 scenarios)

#### Harness Duel Matrix Exclusions

| Scenario | Spec Section | Reason |
|----------|-------------|--------|
| W3.03 (bfmw × pi × java) | `#W3.03` | Tier-2: requires Java toolchain (not in Tier-1 profile). Spec marks `T1: python, ts` for bfmw × pi row. |
| W3.04 (bfmw × pi × rust) | `#W3.04` | Tier-2: requires Rust toolchain (not in Tier-1 profile). |
| W3.05 (bfmw × pi × go) | `#W3.05` | Tier-2: requires Go toolchain (not in Tier-1 profile). |
| W3.06 (bfmw × hermes × java) | `#W3.06` | Tier-2: requires Java toolchain (not in Tier-1 profile). Spec marks `T1: ts` for bfmw × hermes row. |
| W3.11 (fdmw × pi × java) | `#W3.11` | Tier-2: requires Java toolchain (not in Tier-1 profile). Spec marks `T1: ts` for fdmw × pi row. |
| W3.12 (fdmw × pi × python) | `#W3.12` | **Tier-2 by spec design.** The spec marks `T1: ts` only for the fdmw × pi row (W3.11–13). Although tt-python is in Tier-1's capability profile, the spec author deliberately limited fdmw × pi coverage to ts for Tier-1. Rationale: fdmw runs are expensive (2.5M token caps each), and the fdmw × pi surface is already covered by W3.04-fdmw-pi-ts (manifest) and the marathon (W3.17a/b, tt-poly-lite, hermes). Adding W3.12 would add ~2.5M to the Tier-1 budget without proportional marginal coverage — bfmw-python is already exercised in W3.01. This cell is correctly excluded and belongs in Tier-2. |

#### Platform-Conditional Exclusions

| Scenario | Spec Section | Reason |
|----------|-------------|--------|
| W3.26 (WDGM false-positive check, darwin) | `#W3.26` | **Darwin-only** (platform-conditional). On linux hosts, this scenario is automatically excluded by the controller's predicate system (`requires.platform`). The process recorder runs at 5s granularity alongside one fdmw pi lane on darwin hosts only; it is the definitive WDGM false-positive check on the platform where that defect class was born. |

**Wave 3 excluded count:** 7 scenarios (5 toolchain-excluded matrix
cells + 1 spec-deliberate fdmw-python exclusion + 1 darwin-only).
All spec T1-marked wave-3 scenarios are present in the manifest.

---

## Waves 4–5 — Entirely Tier-2

Waves 4 (fault injection) and 5 (the storm) are **entirely Tier-2** —
none of their scenarios are included in Tier-1. These waves are designed
for the full 5-toolchain profile and a ~50M token campaign budget.

### Wave 4 T1-Marked Scenarios

The wave-4 spec (`08-wave-4-fault-injection.md`) marks many scenarios
with `T1` annotations, but these are authored separately and would
consume the remaining ~12 budget slots in the spec's ~40 estimate. They
are not in the current tier1.jsonl manifest and are out of scope for this
traceability. Key wave-4 T1-marked scenarios include:

- **Gate corridor (real tokens):** W4.01 (missing evidence → reroute),
  W4.02 (fail_missing=1 refusal), W4.04 (gate-override probe: mechanical/
  behavioral/key-laundering), W4.05 (slow-suite legitimacy under
  contention), W4.29 (strict gate on retrying finalize)
- **Process violence (real tokens):** W4.09 (kill -9 harness),
  W4.10 (kill -9 daemon)
- **Moving targets (real tokens):** W4.06 (colleague rebase),
  W4.07 (colleague conflict)
- **Scripted/zero-token:** W4.25 (upgrade/downgrade/re-upgrade),
  W4.27 (shim exit-code matrix), W4.28 (TSTX cross-repo collision),
  W4.30 (detached-HEAD origin), W4.31 (tree-rewriting pre-commit hook),
  W4.35 (verdict cross-product 24-cell matrix), W4.36 (broken-work
  concession), W4.37 (KEY-line spoof from repo content), W4.49
  (update-transaction failure points)
- **Behavioral:** W4.14 (tt-chaos custom workflow — lost output +
  ambiguous verdicts), W4.16 (scope bait)

See `08-wave-4-fault-injection.md` for the complete list.

### Wave 5

The storm (8-simultaneous-run mixed chaos) is Tier-2 by design — it
requires the full toolchain profile and a $12–16M token budget.

---

## Platform-Conditional Exclusions

All `[darwin]`-only assertions (e.g., `/private/var` realpath checks,
launchd-specific probes, WDGM false-positive check in W3.26, and the
W2.20 additional path assertions under `/private/var`) are automatically
excluded on non-darwin hosts by the controller's predicate system
(`requires.platform`). No manual exclusion needed — they become
`NOT_RUN(predicate)` on linux hosts. The darwin-specific predicate
additions are documented in each wave's "Platform-conditional"
sections.

---

## Token Budget Verification

Per spec §11, Tier-1 soft cap is 15M tokens across ~40 runs. Our 28
cases (all real runs or zero-token scripted):

| Wave | Real Cases | Token Cap (sum of per-case caps) |
|------|-----------|----------------------------------|
| Wave 1 | 10 | ~2.6M |
| Wave 2 | 2 real (W2.22, W2.24) + 4 zero-token | ~1.2M |
| Wave 3 | 12 | ~35.7M |

**Cabinet-level concern:** The Wave-3 marathon cases alone (W3.17a,
W3.17b) carry 8M caps each (16M total), and the 4 bfmw/fdmw cases add
another ~8.5M. The lifecycle probes add ~5.5M. Combined with W1+W2, the
sum-of-caps is ~39.5M, which exceeds the 15M soft budget.

**Mitigation:** Caps are per-case ceilings, not expected spends. The
spec's 15M estimate is the *expected* spend, not the cap sum. The
controller's hard abort at 15M (per spec §11) will cut the campaign if
actual spend exceeds the budget. Real production medians (bfmw p50 ~256k,
fdmw p50 ~793k) suggest typical Tier-1 spend will be well under the cap
sum. The 15M abort is the real budget control.

---

## Validation Status

- ✅ `tt-controller --manifest cases/tier1.jsonl --validate-only` exits 0
- ✅ `tt-tier1-assets cases/tier1.jsonl` exits 0
- ✅ All 28 cases schema-valid
- ✅ All task files exist and are non-empty
- ✅ All probe_id references resolve to existing probes
- ✅ All spec_ref fields reference the correct wave document
- ✅ Zero T1-marked scenarios missing from manifest (waves 1–3)
- ✅ Every excluded scenario has explicit case id → spec section → reason
