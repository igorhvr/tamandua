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
