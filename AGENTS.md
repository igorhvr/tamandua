# AGENTS.md

Instructions for AI coding assistants and developers working on the tamandua codebase.

## Development

### Build and Install

```bash
# Build from source (checkout root):
./build              # npm install + tsc + inject-version
./install            # symlink ~/.local/bin/tamandua → this checkout
./build-and-install  # both steps at once
```

The `build` script requires Node.js >= 22. It runs `npm install` followed by `npm run build` (TypeScript compilation, HTML copy, version injection).

The `install` script delegates to `scripts/install.sh --local <pwd>` — it creates a symlink so `tamandua` on your PATH always uses the dist from your checkout. No global npm install, no GitHub clone needed.

```bash
# After editing source, rebuild:
./build

# Run tests:
npm test
```

## Project Structure

```
tamandua/
├── bin/tamandua                  # Shell wrapper
├── src/
│   ├── index.ts                  # Export entry
│   ├── db.ts                     # SQLite database (runs, steps, stories, worktrees, autoresearch sessions)
│   ├── autoresearch/
│   │   └── autoresearch.ts       # AutoResearch experiment engine (durable optimization loops, confidence scoring)
│   ├── cli/
│   │   ├── cli.ts                # Main CLI entry point
│   │   ├── ant.ts                # ASCII art easter egg
│   │   └── ant.test.ts           # Easter egg tests
│   ├── installer/
│   │   ├── install.ts            # Workflow installer
│   │   ├── uninstall.ts          # Workflow uninstaller
│   │   ├── agent-provision.ts    # Agent workspace provisioning
│   │   ├── agent-scheduler.ts    # Deterministic dispatch scheduler (in-process peek → work spawn)
│   │   ├── workflow-fetch.ts     # Fetch bundled workflows
│   │   ├── workflow-spec.ts      # Load/workflowspec from YAML
│   │   ├── workspace-files.ts    # File copy utilities
│   │   ├── step-ops.ts           # Step claim/complete/fail/pipeline logic
│   │   ├── run.ts                # Run creation
│   │   ├── status.ts             # Run status queries
│   │   ├── events.ts             # Event logging
│   │   ├── logs-tail-format.ts   # Shared logs-tail line formatting (CLI + dashboard API)
│   │   ├── worktree-manager.ts   # Managed git worktree creation/removal for runs
│   │   ├── run-harness.ts        # Harness (pi/hermes) invocation for runs
│   │   ├── rugpull.ts            # Relaunch-upon-rugpull handling
│   │   ├── pi-stream-parser.ts   # pi --mode json output stream parsing
│   │   ├── paths.ts              # Path resolution
│   │   ├── types.ts              # Shared types
│   │   ├── pi-config.ts          # pi config reading
│   │   └── symlink.ts            # CLI symlink management
│   ├── server/
│   │   ├── daemon.ts             # Dashboard daemon process (co-manages dashboard + MCP listeners)
│   │   ├── daemonctl.ts          # Daemon lifecycle control
│   │   ├── dashboard.ts          # Dashboard HTTP server
│   │   ├── control-server.ts     # Daemon control plane (pause/resume/terminate runs)
│   │   ├── control-client.ts     # Client for the daemon control plane
│   │   ├── kanban-data.ts        # Kanban snapshot/card-detail builders
│   │   ├── mcp-server.ts         # Remote MCP HTTP server bootstrap (streamable transport)
│   │   ├── index.html            # Dashboard UI
│   │   └── kanban.html           # Kanban board UI (per-run)
│   ├── medic/
│   │   ├── medic.ts              # Health check orchestration
│   │   ├── checks.ts             # Individual health checks
│   │   └── medic-cron.ts         # Cron setup for medic
│   └── lib/
│       ├── logger.ts             # File logging
│       ├── logger.test.ts        # Logger tests
│       └── frontend-detect.ts    # Frontend file detection
├── workflows/                    # Bundled workflow definitions (worktree variants symlink agent dirs)
├── agents/shared/                # Shared agent personas (setup, pr, verifier — symlinked into workflows)
├── skills/                       # Bundled skills
├── docs/                         # User documentation
├── tests/                        # Integration tests
├── e2e-tests/                    # End-to-end tests (smoke + real; NOT part of npm test)
├── www/                          # Static website (tamandua.org)
├── scripts/                      # Build scripts
├── package.json
├── tsconfig.json
└── README.md
```

## Architecture

Tamandua is an agent team orchestrator built on top of pi (the coding agent CLI).

### Runtime model

- Agent settings live at `~/.pi/agent/settings.json`
- Work is dispatched via direct `pi --print` invocation (no gateway HTTP API)
- Sessions use `pi --print --session`
- Agent config lives in `~/.tamandua/agents.json`
- Permissions are expressed as role descriptions

### Agent Scheduler (deterministic dispatch motor)

The scheduler decides "is there work?" itself and spawns a model ONLY when
there is. Checking for work never invokes a model, so idle runs cost zero
tokens (MOTOR-CONTRACT.md N1/N2). Per-(runId, agentId) in-memory
`setInterval` jobs (not OS cron) drive dispatch rounds
(`executeDispatchRound`):

1. Deterministic peek: an in-process `peekStep` SQL COUNT — no spawn, no
   model, no tokens when idle. The 15s tick (`DISPATCH_INTERVAL_MS`) is a
   fallback sweep that also drives stale-claim recovery; step completions
   and run starts nudge the daemon (`/control/nudge`) for immediate
   dispatch, so step-to-step latency is near zero.
2. Work phase: on HAS_WORK, spawns `pi --print` (or hermes) with the work
   prompt (`buildWorkPrompt`: persona block + run-scoped `step claim` →
   execute → STATUS report). The CLI launcher is invoked directly — never
   `node <cli>`; the launcher is a shell script.
3. `runPi` emits lifecycle logs (`pi pre-launch`, `pi launched`, `pi completed`/`pi execution failed`) with PID, timing, and bounded stream preview metadata for observability without dumping full prompts or large stderr payloads
4. `executeDispatchRound` emits stage logs (`Dispatch round skipped/idle`, `Work round start/complete/failed`) with shared round context (`jobId`, `agentId`, timeout/workdir/model when available) and bounded outcome/error previews
5. Work rounds run pi in JSON mode (`--mode json`) so scheduler logic can extract `message_end.message.usage` token metadata and attribute increments to `runs.tokens_spent` using run IDs parsed from tool outputs (falling back to the dispatch job's own runId).
6. Successful token attribution emits a `run.tokens.updated` event (`tokenDelta` + `tokensSpent` fields); terminal run lifecycle events (`run.completed`/`run.failed`) also carry `tokensSpent` for cost visibility.
7. `tamandua_stats.system_tokens_spent` is a legacy ledger kept as a
   tripwire: nothing writes to it anymore; tests assert it stays 0.

### Step Lifecycle

```
waiting → pending → running → done/failed
```

- Steps start as `waiting` (blocked by preceding steps)
- Pipeline advancement marks them `pending`
- Agent claims → `running`
- Agent completes → `done`, pipeline advances
- Agent fails → retry or escalate
- **Rugpull relaunch scope:** The automatic replacement-run mechanism
  applies **only** to `finalize_merge` step failures in merge workflows
  (`*-merge`, `*-merge-worktree`) where the base branch tip moved during
  the run. Any other failure — mid-pipeline step retry exhaustion, expects
  validation exhaustion, worker death — permanently fails the run
  UNLESS the workflow declares `on_fail.retry_step`, in which case
  the run reroutes to the named upstream producer (bounded by
  `max_reroutes`, default 2 before falling through to permanent
  failure). No automatic replacement is triggered for these failures.
  Use `tamandua workflow resume <run-id>` to reattempt a permanently
  failed run; fix the underlying issue before resuming.

### CLI Help Convention

Every CLI command and subcommand supports `--help` / `-h` through a shared infrastructure
in `src/cli/cli.ts` (canonical implementation: commit `bf326a5c015b4da479df83e87bbc2bd7c1063857`).

**Core infrastructure functions:**

- `hasHelpFlag(args: string[]): boolean` — detects `--help` or `-h` anywhere in `args`
- `printHelp(text: string): void` — writes `text` to stdout and exits with code 0
- `printHelpSubcommand(subcommands: Record<string, string>): void` — renders an aligned
  subcommand listing from a `{ name: description }` map

**Per-command help functions** follow the `get<Thing>Help()` naming convention:
one function per command or subcommand that returns a multi-line help string.
Examples: `getStepPeekHelp()`, `getWorkflowRunHelp()`, `getUpdateHelp()`,
`getDashboardStartHelp()`. The full pattern is `get{Group}{Action}Help` —
e.g. `getMcpStartHelp` covers `tamandua mcp start --help`.

**--help dispatch** runs at the very top of `main()` before any command execution,
I/O, or side effects (including update warnings). This guarantees `--help` is always
available and never triggers unintended operations.

**`getUsageText()`** (global usage, shown when no recognized command is passed with
`--help`) opens with: `Run tamandua <command> --help for detailed command help.`
followed by a top-level command listing.

**When adding or changing commands:** every new command or subcommand needs:
- A corresponding `get<Thing>Help()` function
- A `--help` dispatch if-block in `main()` (before the command execution path)

## Environment Overrides

- `TAMANDUA_WORKFLOWS_SRC`: Overrides the directory from which bundled workflows are loaded. When set, the installer resolves this directory (relative or absolute) instead of the default `<repo>/workflows/`. Tests that exercise `workflow install --all` or `get-ready` with custom workflow fixtures should point this at a temp directory containing the desired workflow set. Set in `src/installer/paths.ts` `resolveBundledWorkflowsDir()`.

## State

- SQLite database: `~/.tamandua/tamandua.db`
- Agent config: `~/.tamandua/agents.json`
- Cron jobs: `~/.tamandua/cron-jobs.json`
- Events: `~/.tamandua/events.jsonl`
- Logs: `~/.tamandua/tamandua.log`
- Medic: `~/.tamandua/medic.json`

## Update and Catalog Staleness

Installed workflows live in `~/.tamandua/workflows/` and may become older than the
bundled catalog shipped with the current tamandua binary. This means prompt-level
fixes to workflow personas (in `workflows/` and `agents/`) are silently inert until
the installed catalog is refreshed. Two mechanisms surface this gap:

- **Doctor check:** `tamandua doctor` includes a catalog-staleness check in the
  STALENESS group. It compares the installed catalog stamp against the current
  build version and warns with a remedy if they differ or the stamp is missing.
- **Launch-time nudge:** `tamandua workflow run` prints a one-line warning to
  stderr (never blocks the launch) when the installed catalog is older than the
  bundled catalog:
  `Warning: installed catalog is older than bundled catalog. Run tamandua update --force to apply latest workflow/persona fixes.`

**Remedy:** Run `tamandua update --force` to refresh the installed catalog.

**Stamp file:** The installed catalog records a version stamp at
`~/.tamandua/workflows/.catalog-version.json` at install/update time. It contains
the build version, source path, and install timestamp. The doctor check and
launch-time nudge are cheap — stat + read + string compare, no network, no git.

## Artifacts to Review on Changes

When making changes, review whether these artifacts need updating:

- `docs/creating-workflows.md` — user-facing workflow documentation
- `skills/tamandua-agents/SKILL.md` — provisioned to agents as AGENTS.md/IDENTITY.md/SOUL.md
- `src/server/mcp-server.ts` — MCP tools registered for agent use
- `src/cli/cli.ts` — CLI commands that agents invoke, and per-command help functions (`get<Thing>Help()`)
- `src/server/index.html` — dashboard UI
- `src/server/kanban.html` — kanban board UI
- `README.md` — project overview

Output format contract: agent output is classified by exact STATUS markers
(`STATUS: done`, `STATUS: failed`/`error`); missing markers cause the step to
be treated as lost/abandoned and retried. Bundled personas carry a
`## CRITICAL — STATUS Line Requirement` section — keep it when adding new
workflow agents (see docs/creating-workflows.md).

Changes that typically cascade to multiple artifacts:
- **Step lifecycle**: step claim/complete/fail/pipeline logic
- **CLI commands**: new or changed commands (step, workflow, logs, dashboard) — when adding/changing commands, verify the corresponding `get<Thing>Help()` is also updated and that the `--help` dispatch if-block exists in `main()`
- **Agent provisioning**: personas, workspace files, skill provisioning
- **Workflow structure**: new step types, loop wiring, pipeline ordering
- **Output format contracts**: agent output blocks (STATUS/CHANGES/TESTS)

If you update `skills/tamandua-agents/SKILL.md`, verify that bundled workflow persona AGENTS.md files reflect the change.

## Testing

```bash
# Run all tests (unit + integration)
npm test

# Or build first then test (tests import from dist/)
npm run build && npm test
```

Tests use Node's built-in `node:test` and `node:assert`.

### Two-lane test suite (PRLL)

`npm test` delegates to `scripts/run-all-lanes.sh`, which runs the suite in
two lanes; contributors don't need to know about lanes — just run `npm test`:

1. **Serial lane** (`scripts/run-serial-tests.sh`, concurrency 1): test files
   that spawn OS processes or exercise daemon lifecycle. These carry
   absolute-deadline assertions that rotate flaky under parallel load, so they
   run alone. The file list lives in `tests/serial-files.txt`.
2. **Parallel lane** (`scripts/run-parallel-tests.sh`, default concurrency):
   every other `*.test.ts` under `src/` and `tests/`, discovered with `find`
   (the old `src/**/*.test.ts` glob silently skipped top-level files like
   `src/db.test.ts`; `find` covers everything except `e2e-tests/`).

**Classification rule**: a test file belongs in the serial lane if it
(a) imports from `node:child_process`, or (b) calls a daemonctl spawner
(`startDaemon`/`startMcp`/`startControlPlane` and their stop/restart
counterparts). In-process servers (`createDashboardServer`,
`createTamanduaMcpServer`) are NOT serial candidates.

If you add a spawn-capable test file without listing it in
`tests/serial-files.txt`, `tests/serial-classification-guard.test.ts` fails
with instructions; `tests/serial-files-integrity.test.ts` pins the reverse
direction (everything listed must be spawn-capable and existing).

Never convert absolute-deadline assertions into polls or retries to fix a
flake — raise the timeout or move the file to the serial lane.

### End-to-End Tests

End-to-end tests live under `e2e-tests/`. There are **three kinds**, and the
distinction is critical:

| Test | Script | What it does | Duration |
|------|--------|--------------|----------|
| **Smoke (state-machine)** | `./run-all-smoke-e2e-tests` | Exercises workflow state machine, pipeline wiring, and step lifecycle using manual `step claim` / `step complete` with canned outputs. No real agents, models, or schedulers. | ~10–15 seconds |
| **Scripted (full pipeline, fake pi)** | `./run-all-scripted-e2e-tests` | Runs the REAL daemon → scheduler → harness spawn → step-ops → worktree/merge pipeline, with `TAMANDUA_PI_BINARY` pointed at a deterministic scripted agent (`e2e-tests/helpers/scripted-agent.ts`) that executes the claim/complete work protocol, including chaos scenarios (lost steps, crashed agents). No models, ZERO tokens. Primary regression net for motor changes — see `tests/MOTOR-CONTRACT.md`. | ~30–60 seconds |
| **Real canary (single run)** | `./run-real-e2e-canary` | ONE do-now run with a trivial task through the real daemon → scheduler → pi pipeline, with token-accounting audits. **Spends a small amount of real tokens.** Use at motor-change milestones before the full real suite. | ~2–10 minutes |
| **Real (full pipeline)** | `./run-all-real-e2e-tests` | Launches actual Tamandua workflows that run through the full daemon → scheduler → pi agent pipeline. Uses real model invocations, real worktree creation, real git merges. | 30+ minutes per workflow |

`./run-all-e2e-tests` is the convenience alias — it runs the **smoke and
scripted tests** (fast, no tokens). It does NOT run the real e2e test.

#### Real End-to-End Test — Cost and Duration

The real e2e test (`./run-all-real-e2e-tests`) is **expensive**:
- **Tokens:** Spends real API tokens on model invocations (pi agents process
the full workflow autonomously — planning, implementing, verifying, testing,
and merging).
- **Time:** Expect 30–60 minutes for the full sequential run (feature-dev-merge
+ bug-fix-merge workflows).
- **System resources:** Creates real worktrees, runs npm install, executes
tests, and performs git merges.

#### Test isolation (READ THIS TOO)

Tamandua is the main tool used to develop tamandua itself. Tests — and
anything they spawn — must NEVER touch the live instance:

- `npm test` sets `TAMANDUA_TEST_GUARD=1`: opening the real `~/.tamandua`
  state or binding a production port (3334/3338/3339) throws a
  "TEST ISOLATION VIOLATION" error. The guard passes through
  `cleanChildEnv` to spawned daemons and scripts. Do not work around it —
  fix the test's isolation instead.
- The guard auto-activates whenever `NODE_TEST_CONTEXT` is set (node:test
  sets it in every test process), even without `TAMANDUA_TEST_GUARD=1`.
  To explicitly disable the guard (e.g., a third-party test suite shelling
  out to the tamandua CLI), set `TAMANDUA_TEST_GUARD=0`.
- Every test gets its own temp HOME/`TAMANDUA_STATE_DIR`/`TAMANDUA_DB_PATH`
  and RANDOM ports for every listener it starts — including
  `TAMANDUA_CONTROL_PORT` for any daemon it spawns (the daemon binds a
  control plane too, not just the dashboard port).
- Agents working inside a tamandua run: the step CLI (`step claim` /
  `complete` / `fail`) is the ONLY sanctioned interaction with the live
  instance. To exercise daemon/MCP/control-plane lifecycle, start an
  ISOLATED instance (temp state dir + random ports). `stopDaemon` refuses
  to stop the daemon scheduling you (TAMANDUA_WORKER_PID guard).

#### Agent Default Behavior (READ THIS)

- **AGENTS MUST NOT RUN REAL E2E TESTS BY DEFAULT.** Only run `./run-all-tests`
or `npm test` when fulfilling routine development duties.
- If running e2e tests is required, run `./run-all-e2e-tests` (smoke + scripted, fast, no tokens).
- **Only run `./run-real-e2e-canary` or `./run-all-real-e2e-tests` when
explicitly asked** — both spend real tokens (the canary a little, the full
suite a lot). Never infer or assume they should be run.

#### When Each Test Should Be Used

- **Smoke e2e:** Use during development to validate state machine changes,
step lifecycle logic, pipeline wiring fixes. Fast enough for every commit.
- **Scripted e2e:** Use for any change to the motor — agent scheduler, run
harness, step-ops pipeline advance, daemon scheduling lifecycle, worktree
plumbing. Zero tokens, fast enough for every commit. The motor-agnostic
behavioral contract it enforces is documented in `tests/MOTOR-CONTRACT.md`,
along with the deterministic-motor acceptance criteria (N1–N3) that
`tests/deterministic-motor-acceptance.test.ts` and the scripted tier keep
pinned (idle dispatch spawns nothing and spends zero tokens).
- **Real e2e:** Use when validating the full daemon/scheduler/agent pipeline
end-to-end, after major infrastructure changes, or when explicitly told to.
- **None of these are included in `npm test`** — they live under `e2e-tests/`
and are separate from the regular suite.
- **None are compiled by `tsconfig.json`** — they live outside `src/`.

### Parallel Test Safety

Tamandua is often used to develop and test itself. All tests use isolated temporary HOME and TAMANDUA_STATE_DIR directories, so PID/port files never conflict across parallel test files.

- **Random ports:** Tests that spawn listeners use `reserveRandomPort()` (bind-to-0). Normal tests must not bind, fetch, or probe default ports 3334/3338/3339.
- **Temp HOME isolation:** Use `fs.mkdtempSync()` for temporary HOME directories, pass `HOME` env to spawned subprocesses, clean up in `finally` blocks. Helpers that run CLI must use an explicit isolated env — do not fall back to `process.env`.
- **Scoped daemon control:** Pass `{ homeDir: tempHome }` or stop the exact child process handle created by the test. Never call lifecycle functions against real HOME; verify any PID belongs to the test environment before killing it.
- **Guard coverage:** `tests/test-isolation-guard.test.ts` scans for patterns that can touch the live daemon. Update it when adding new service lifecycle tests.

`npm test` remains a convenience alias that runs the full parallel suite.

`src/server/mcp-server.ts` supports dependency injection via `createTamanduaMcpServer(..., { services })` / `startTamanduaMcpServer(..., { services })`; protocol tests in `src/server/mcp-server.test.ts` should use this hook instead of duplicating DB/event setup.

`src/server/daemon.ts` starts dashboard + MCP together (dashboard port from `~/.tamandua/port`, MCP fixed to 3338). Co-lifecycle regression coverage lives in `src/server/daemon.test.ts`.

Dashboard UI regressions are covered in `src/server/dashboard.test.ts` by fetching `/` from `createDashboardServer(...)` and asserting required HTML/script hooks (including logs-tail cursor polling markup).

`tests/workflow-validation.test.ts` validates bundled workflows: directory discovery, `workflow.yml` id matching, `workspace.files` path existence, skill wiring and frontmatter, README catalog entries (e.g., `feature-dev-merge-worktree`). Bundled workflow agents should declare `tamandua-agents` in `workspace.skills`, preserving any existing skills like `agent-browser`.
`tests/workflow-graph-simulation.test.ts` simulates every bundled workflow to completion in-process through pure step-ops (happy path, mid-run retry, retry exhaustion) — when adding a workflow, it is covered automatically; a `regex:` expects clause may need a new entry in its `REGEX_EXPECTS_CANDIDATES`.
Step output parsing (`parseOutputKeyValues` in `src/installer/step-ops.ts`) lowercases keys, so an agent output like `ORIGINAL_BRANCH: main` is consumed downstream as `{{original_branch}}`.
Installer skill copy behavior (workflow-local + shared bundled skills) is covered in `tests/agent-skill-provisioning.test.ts`.

Integration tests (CLI and dashboard API) should spawn subprocesses with temp `HOME` and `TAMANDUA_STATE_DIR` to isolate event files, SQLite, and DB path resolution.
