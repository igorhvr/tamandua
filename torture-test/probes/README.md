# Held-Out Acceptance Probes

This directory contains the mechanical acceptance probes for the
tamandua torture test campaign (the O16 substrate).

## Contract

Every probe script follows this interface:

```
probe.sh <workspace> <base-ref> <scratch-dir>
```

| Argument | Description |
|---|---|
| `workspace` | Path to the agent's result workspace (merged target for merge workflows, final branch/working copy for plain/worktree runs) |
| `base-ref` | Pristine base reference (branch name or commit SHA) — available for arm validation but probes operate on the workspace |
| `scratch-dir` | Writable directory for temporary artifacts (clones, build outputs). Must be created by the probe if needed. |

## Exit Codes

| Code | Meaning |
|---|---|
| 0 | **PASS** — task genuinely accomplished in the given workspace |
| 1 | **FAIL** — task NOT accomplished (probe detected missing or incorrect work) |
| 2 | **INFRA-ERROR** — probe could not run (missing dependencies, corrupted workspace, etc.) |

## Conventions

- **Runtime:** each probe must complete in under 60 seconds.
- **No network:** probes never make network calls.
- **Numeric verdict:** probes produce a structured exit code, never agent prose.
- **Observable behavior:** probes assert observable behavior (run CLI, curl page, time perf path), never implementation details or agent report parsing.
- **Revert-probes:** bug-task probes additionally assert the regression test exists AND fails when the fix is reverted (stash-style revert in a throwaway clone).
- **Held-out:** probes live ONLY in this directory, outside every agent-reachable fixture repo. The `secrecy-sweep.sh` script enforces this mechanically.

## Monorepo Path Convention

Monorepo fixtures (`tt-poly-lite`) use **repo-root-relative** paths for all
seeds, fix patches, and probes. This is the authoritative convention per
`torture-test/tamandua-torture-test-spec/02-fixture-projects.md`.

### Convention

- **Seeds, patches, and probes** reference files relative to the monorepo root
  (the golden bare clone root), which contains `python/` and `ts/` subtrees.
- **Seed overlay files** for `tt-poly-lite/python` targets are resolved by
  basename within the workspace root; the `python/` prefix is implicit in the
  directory layout.
- **Fix patches** carry the full subtree prefix in their paths.

### Path examples

For `tt-poly-lite/python` overlay fix patches (applied with `-p1`):

| Component | Correct (repo-root-relative) | Incorrect (subtree-relative) |
|---|---|---|
| Fix patch path | `b/python/src/schedlib/recurrence.py` | `b/src/schedlib/recurrence.py` |
| Fix patch path | `a/python/tests/test_recurrence.py` | `a/tests/test_recurrence.py` |

For `tt-poly-lite/ts` git-format fix patches (applied with `-p4`):

| Component | Path convention |
|---|---|
| Fix patch header | `b/torture-test/fixtures-src/tt-poly-lite/ts/src/store.ts` |
| Effective workspace path (after -p4 strip) | `ts/src/store.ts` |

### How validate-all.sh applies patches for monorepo fixtures

`validate-all.sh` always applies fix patches from the **repo root**
(the golden bare clone), never from a subtree. The `detect_patch_level`
function determines the correct `-p` level from the patch header:

- **`tt-poly-lite/python` overlay patches** use `b/python/...` or `a/python/...`
  paths → `detect_patch_level` returns `-p1`. With `-p1`, the leading `a/` or `b/`
  is stripped, yielding `python/src/...` — which matches the repo-root layout.
- **`tt-poly-lite/ts` git-format patches** use
  `a/torture-test/fixtures-src/tt-poly-lite/ts/...` paths →
  `detect_patch_level` returns `-p4`. After stripping 4 leading components,
  the effective path is `ts/src/...`.

### Probes

Probes for monorepo fixtures live under `tt-poly-lite/python/<task-id>/` and
`tt-poly-lite/ts/<task-id>/`. They operate on the agent's result workspace
(same layout: `python/` + `ts/` subtrees at root). Probe scripts reference
`probe-common.sh` with the correct relative path:

```bash
# From tt-poly-lite/python/<task-id>/probe.sh:
source "$(dirname "$0")/../../../lib/probe-common.sh"

# From tt-poly-lite/ts/<task-id>/probe.sh:
source "$(dirname "$0")/../../../lib/probe-common.sh"
```

## Shared Library

`lib/probe-common.sh` — source at the top of every probe script:

```bash
source "$(dirname "$0")/../../lib/probe-common.sh"
```

Key functions:
- `vrun <cmd...>` — verbose command execution (echoes to stderr)
- `fail <msg>`, `pass_ <msg>`, `infra_error <msg>` — terminal functions with correct exit codes
- `assert_grep <pattern> <file>`, `assert_not_grep <pattern> <file>`
- `check_file_exists <file>`, `check_dir_exists <dir>`
- `check_cmd_output <pattern> <cmd...>`
- `check_regression_test <workspace> <pattern>`
- `validate_probe_args <workspace> <base-ref> <scratch-dir>`
- `apply_seed_overlay`, `apply_seed_patch`, `revert_seed_patch`
- Language-specific test runners: `run_python_tests`, `run_ts_tests`, `run_go_tests`, `run_rust_tests`, `run_java_tests`

## Directory Structure

```
probes/
├── README.md                     ← this file
├── secrecy-sweep.sh              ← proves no probe content leaks into fixture repos
├── validate-all.sh               ← three-arm validation harness
├── lib/
│   ├── probe-common.sh           ← shared utility library
│   └── probe-common.test.sh      ← self-tests for the library
├── tt-go/
│   └── <task-id>/
│       └── probe.sh
├── tt-java/
│   └── <task-id>/
│       └── probe.sh
├── tt-poly-lite/
│   ├── python/
│   │   └── <task-id>/
│   │       └── probe.sh
│   └── ts/
│       └── <task-id>/
│           └── probe.sh
├── tt-python/
│   └── <task-id>/
│       └── probe.sh
├── tt-python@master/
│   └── <task-id>/
│       └── probe.sh
├── tt-rust/
│   └── <task-id>/
│       └── probe.sh
└── tt-ts/
    └── <task-id>/
        └── probe.sh
```

## Probe Template

```bash
#!/usr/bin/env bash
# Probe: <task-id> — <description>
# Fixture: tt-xxx
# Task type: bug | feature | vuln | broken-test

source "$(dirname "$0")/../../lib/probe-common.sh"

WORKSPACE="$1"
BASE_REF="$2"
SCRATCH="$3"

validate_probe_args "$WORKSPACE" "$BASE_REF" "$SCRATCH"

# 1. Check observable behavior
# 2. Bug probes: check_regression_test + revert-probe
# 3. Feature probes: verify acceptance criteria
# 4. Vuln probes: grep for hardened code
# 5. BRK probes: verify TEST_CMD exits 0

# If all checks pass:
pass_ "task <task-id> genuinely accomplished"
```

## State

All generated state (clones, build artifacts, results) lives under
`torture-test/var/` which is gitignored. Nothing under `probes/` is
ever written to during probe execution — probes are read-only
verifiers.
