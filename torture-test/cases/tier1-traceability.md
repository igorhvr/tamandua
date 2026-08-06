# Tier-1 Case Traceability Report

**Generated:** 2026-08-06
**Manifest:** `cases/tier1.jsonl`
**Spec:** `torture-test/tamandua-torture-test-spec/`

## Manifest Summary

| Metric | Value |
|--------|-------|
| Total Tier-1 cases | **28** |
| Wave 1 (language smoke) | 10 |
| Wave 2 (workflow coverage) | 6 |
| Wave 3 (harness duel + lifecycle) | 12 |
| Spec estimate | ~40 (README §Tier-1) |
| Delta from spec | -12 |

### Why 28, not 40?

The spec's ~40 estimate for Tier-1 was approximate and covered the full
three-wave roster including scenarios that, upon detailed review of
per-case caps and the 15M token budget (spec §11), could not all fit
within Tier-1's budget envelope. The 28 authored cases are the spec's
T1-marked scenarios and additional Tier-1-relevant cases (TSTX replay
legs). Only the scenarios the spec explicitly marks `T1` are included
here; the remaining ~12-15 scenarios belong to Tier-2 (full campaign).

Key factors:
- Wave 1: spec estimates "≈8" Tier-1 cases for the language matrix at
  2 languages. We author 10 (adding TSTX cross-run replay relaunches at
  2 languages, called out as `T1` in the cross-cutting checks section).
- Wave 2: only the T1-marked edge/authoring scenarios (6 cases). The
  20-workflow matrix (W2.01–W2.20) is Tier-2 only — those workflows
  require all 5 toolchains and spend ~10M tokens on their own.
- Wave 3: the T1 matrix cells (4), marathon (2), and lifecycle probes
  (6) = 12. The remaining matrix cells for java, rust, go are Tier-2.

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

**Wave 1 count:** 10 of ~8 spec-estimated (TSTX replay added 2 beyond the
per-language matrix).

### Wave 2 — Workflow Coverage Edge Cases (`06-wave-2-workflow-coverage.md`)

| Case ID | spec_ref | Fixture | Harness | Workflow | Mode |
|---------|----------|---------|---------|----------|------|
| W2.21-admission | `#W2.21` | tt-ts | local | just-do-it | scripted |
| W2.22-non-main-bfmw | `#W2.22` | tt-python@master | pi | bug-fix-merge-worktree | real |
| W2.23a-expects-regex | `#W2.23a` | none | local | local | scripted |
| W2.23b-retry-step | `#W2.23b` | none | local | local | scripted |
| W2.23c-missing-persona | `#W2.23c` | none | local | local | scripted |
| W2.24-docs-drift | `#W2.24` | tt-ts | pi | local | real |

**Wave 2 count:** 6 (all T1-marked scenarios in the edge/authoring table).

### Wave 3 — Harness Duel + Lifecycle Probes (`07-wave-3-harness-duel.md`)

| Case ID | spec_ref | Fixture | Harness | Workflow | Mode |
|---------|----------|---------|---------|----------|------|
| W3.01-bfmw-pi-python | `#W3.01` | tt-python | pi | bug-fix-merge-worktree | real |
| W3.02-bfmw-pi-ts | `#W3.02` | tt-ts | pi | bug-fix-merge-worktree | real |
| W3.03-bfmw-hermes-ts | `#W3.03` | tt-ts | hermes | bug-fix-merge-worktree | real |
| W3.04-fdmw-pi-ts | `#W3.04` | tt-ts | pi | feature-dev-merge-worktree | real |
| W3.17a-marathon-natural | `#W3.17a` | tt-poly-lite | hermes | feature-dev-merge-worktree | real |
| W3.17b-marathon-chaos | `#W3.17b` | tt-poly-lite | hermes | feature-dev-merge-worktree | real |
| W3.18-pause-no-drain | `#W3.18` | tt-ts | pi | feature-dev-merge-worktree | real |
| W3.19-pause-drain | `#W3.19` | tt-ts | hermes | feature-dev-merge-worktree | real |
| W3.20-cancel | `#W3.20` | tt-ts | pi | feature-dev-merge-worktree | real |
| W3.21-fail-force-resume | `#W3.21` | tt-ts | pi | feature-dev-merge-worktree | real |
| W3.22-daemon-restart | `#W3.22` | tt-ts | pi | feature-dev-merge-worktree | real |
| W3.23-token-saver | `#W3.23` | tt-ts | pi | do-now | real |

**Wave 3 count:** 12 (4 matrix T1 cells + 2 marathon + 6 lifecycle probes).

---

## Excluded Scenarios — Explicit Enumeration

The following spec scenarios are **deliberately excluded** from Tier-1.
They belong to Tier-2 (full campaign) because they require toolchains or
language fixtures not in the {python, ts} Tier-1 profile, would exceed
the 15M token budget, or are explicitly marked Tier-2 only in the spec.

### Wave 1 Exclusions

| Scenario | Spec Section | Reason |
|----------|-------------|--------|
| W1.L1 java | `#W1.L1` | Tier-2: requires Java toolchain (not in Tier-1 profile) |
| W1.L1 rust | `#W1.L1` | Tier-2: requires Rust toolchain |
| W1.L1 go | `#W1.L1` | Tier-2: requires Go toolchain |
| W1.L2 java | `#W1.L2` | Tier-2: requires Java toolchain |
| W1.L2 rust | `#W1.L2` | Tier-2: requires Rust toolchain |
| W1.L2 go | `#W1.L2` | Tier-2: requires Go toolchain |
| W1.L3 java | `#W1.L3` | Tier-2: requires Java toolchain |
| W1.L3 rust | `#W1.L3` | Tier-2: requires Rust toolchain |
| W1.L3 go | `#W1.L3` | Tier-2: requires Go toolchain |
| W1.X1 java | `#W1.X1` | Tier-2: requires Java toolchain |
| TSTX replay java, rust, go | `#W1 cross-cutting` | Tier-2: requires those toolchains |

**Wave 1 excluded:** 11 scenarios (3 non-T1 languages × 3 core + 1 X1
+ 1 replay × 3).

### Wave 2 Exclusions

| Scenario | Spec Section | Reason |
|----------|-------------|--------|
| W2.01–W2.20 (20 workflow matrix cells) | `#W2.01`–`#W2.20` | **Tier-2 only.** The full 20-workflow catalog requires all 5 toolchains (java, rust, go, python, ts) and spends ~10M tokens independently. Tier-1 is restricted to {python, ts, poly-lite}. These are not marked `T1` in the spec. |
| W2.25 reserved-key behavior | `#W2.25` | Tier-2 only (≈0 tokens, but covers 5-toolchain surface) |
| W2.26 webhook notifications | `#W2.26` | Tier-2 only (≈0 tokens) |
| W2.27 MCP smoke | `#W2.27` | Tier-2 only (≈0 tokens, but requires full daemon/MCP setup beyond Tier-1 scope) |
| W2.28 fresh-install auto-start | `#W2.28` | Tier-2 only (infra provisioning test, not a workflow scenario) |
| W2.29 AutoResearch session | `#W2.29` | Tier-2 only (experimental subsystem) |

**Wave 2 excluded:** 25 scenarios (20 workflow matrix + 5 non-T1 edge
scenarios). Only the 6 T1-marked edge/authoring scenarios are in Tier-1.

### Wave 3 Exclusions

| Scenario | Spec Section | Reason |
|----------|-------------|--------|
| W3.03/W3.05 bfmw × pi × {java, rust, go} | `#W3.03`–`#W3.05` | Tier-2: requires Java/Rust/Go toolchains |
| W3.06 bfmw × hermes × java | `#W3.06` | Tier-2: requires Java toolchain |
| W3.11 fdmw × pi × java | `#W3.11` | Tier-2: requires Java toolchain |
| W3.12 fdmw × pi × python | `#W3.12` | **NOT excluded — missing from manifest. Oversight in US-006 authoring.** The fdmw × pi × python cell should be present; tt-python is in Tier-1's profile. Task for Tier-2 addition. |

**Wave 3 excluded:** 6 scenarios. Note: `W3.12 fdmw × pi × python` was
inadvertently not authored — it is a Tier-2 cell in the spec's matrix
but uses tt-python which is in Tier-1's capability profile. This should
be added when Tier-2 cases are authored.

### Platform-conditional exclusions

All `[darwin]`-only assertions (e.g., `/private/var` realpath checks,
launchd-specific probes, WDGM false-positive check) are automatically
excluded on non-darwin hosts by the controller's predicate system
(`requires.platform`). No manual exclusion needed — they simply become
`NOT_RUN(predicate)` on linux hosts.

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
