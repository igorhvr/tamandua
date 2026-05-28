---
name: tamandua-agents
description: Tamandua is a local CLI/workflow orchestrator for coordinating multi-agent coding runs on top of pi. Use this skill when the user mentions the word tamandua or when a task involves Tamandua workflows, runs, steps, agents, worktrees, dashboard/control-plane services, logs, pause/resume, or Tamandua-specific output contracts and documentation.
---

# Tamandua Agents

## Instructions

Use this skill when operating as a Tamandua workflow agent.

### 1) Confirm CLI access

Use the `tamandua` CLI if available on PATH.

```bash
tamandua version
tamandua source-path
tamandua skill-path
```

If the binary is not on PATH, use the Node entrypoint directly:

```bash
node /path/to/tamandua/dist/cli/cli.js <command>
```

If neither the `tamandua` binary nor the Node entrypoint can be found,
clone and install Tamandua from its GitHub repository:

```bash
git clone https://github.com/igorhvr/tamandua ~/my-tamandua
cd ~/my-tamandua
./build
./install
```

This places a `tamandua` symlink at `~/.local/bin/tamandua`. Verify the
install worked by running `tamandua version`.

### 2) Know the workflow-level commands

Use these when managing workflow runs (outside individual step execution):

```bash
tamandua workflow list [--json]
tamandua workflow install <workflow-id|--all>
tamandua workflow uninstall <workflow-id|--all> [--force]
tamandua workflow run <workflow-id> "<task>" [--working-directory-for-harness <dir>] [--worktree-origin-repository <dir>] [--worktree-origin-ref <ref>] [--pi-as-harness | --hermes-as-harness] [--no-hurry-please-save-tokens-mode] [--no-relaunch-upon-rugpull]
tamandua workflow status <query>
tamandua workflow runs
tamandua workflow pause <run-id>
tamandua workflow pause-all [--drain]
tamandua workflow resume <run-id>
tamandua workflow resume-all
tamandua workflow stop <run-id>
tamandua workflow autoresearch <run-id>
tamandua workflow delete <run-id> [--force]
tamandua nudge
```

`tamandua nudge` wakes all scheduled agents for all currently running runs,
causing them to poll once immediately without waiting for their normal
timers. Does not resume paused runs or interrupt in-flight agents.

`resume` works for both paused runs (restarted via the daemon) and failed
runs (resumed directly). `pause-all --drain` lets in-progress steps finish
before pausing.

`delete` permanently removes a workflow run and associated steps, stories,
and managed worktree data. Active runs are refused by default; use `--force`
to cancel and delete a running or paused run in one step.

`install` fetches workflow files, provisions agent workspaces, and registers
agents in `~/.tamandua/agents.json`. Use `--all` (or `all`) to install every
bundled workflow in one command. `uninstall` removes the workflow and its
agent configuration. Use `--force` to skip the active-runs safety check.
`uninstall --all` removes every installed workflow.

Use `tamandua update [--force]` only for local Tamandua maintenance. Without
`--force`, update blocks after rebuilding if active runs are present — it
leaves services and installed workflows unchanged. Use `--force` to proceed
despite active runs (services are stopped and restarted, workflows reinstalled).
Remote MCP clients can discover the same maintenance command via
`tamandua.update.command`; run the actual update through the local CLI because
it may restart dashboard, MCP, and the control plane.

Harness working directory guidance:

- CLI run: `--working-directory-for-harness` is optional; if omitted it defaults to the shell's current working directory.
- Prefer passing an explicit absolute path when the task depends on a specific repo checkout.

Worktree guidance:

- Use `--worktree-origin-repository <dir>` to clone a repo into an isolated
  git worktree for the run. Defaults to the current repository.
- Use `--worktree-origin-ref <ref>` to check out a specific branch, tag, or
  SHA in the worktree. Defaults to the current branch.
- Worktree runs never modify the origin repository — all changes stay in
  the isolated worktree.

Use `--no-hurry-please-save-tokens-mode` to lower agent polling frequency
for the run. When enabled, the scheduler floor becomes 15 minutes (default
15 minutes) instead of the normal 1 minute (default 5 minutes), reducing
token consumption. Use this for low-priority or long-running background
runs where responsiveness is less important than cost savings.

Use `--no-relaunch-upon-rugpull` to disable automatic replacement-run
creation after a rugpull (base branch move) is detected on a failed
merge or merge-worktree run. By default, Tamandua creates a replacement
run when a rugpull is detected, so the merge can target the updated base.

`tamandua workflow autoresearch <run-id>` shows AutoResearch progress
for a workflow run. It resolves the run's harness working directory,
reads the project-local `autoresearch.config.json` and
`autoresearch.jsonl` files, and prints the current metric summary and
recent experiment timeline.

### 2.6) System status with tamandua status

Use `tamandua status` for a comprehensive overview of the Tamandua system:

```bash
tamandua status
```

`status` reports:

- **Services** — Dashboard, MCP, and control-plane status (up/down, PID, port)
- **Tamandua Info** — Source path, skill path, version, and source tree SHA256
- **Workflow Runs** — Summary of all runs (running, paused, done, failed)
- **Running Processes** — Active pi/hermes harness processes spawned by Tamandua

### 2.7) Worktree management

Worktree commands manage the git worktrees Tamandua creates for isolated
workflow runs.

```bash
tamandua worktree list
tamandua worktree status <run-id>
tamandua worktree remove <run-id> [--force]
tamandua worktree prune --completed --older-than <duration>
```

`list` shows all managed worktrees with run ID, status, cleanup policy, and
filesystem path.

`status` shows detailed worktree info for a run: origin repo, ref, SHA,
original branch, worktree path, and cleanup policy.

`remove` deletes a worktree and its tracking entry. By default, only
non-ready worktrees can be removed. Use `--force` to remove any status.

`prune` cleans up old worktrees for completed or canceled runs older than a
duration (e.g. `7d`, `24h`, `30m`). Requires both `--completed` and
`--older-than` flags.

### 2.8) Control plane management

The control plane provides run-scoped scheduling that the dashboard daemon
uses to manage agent polling and work dispatch.

```bash
tamandua control-plane start [--port N]
tamandua control-plane stop
tamandua control-plane status
```

Default port: 3339.

`status` reports whether the control plane is running (PID, port, endpoint).

Start will refuse if the control plane is already running, printing its
current status instead. Stop is safe to run even when no control plane
is active.

### 2.9) Full uninstall with tamandua uninstall

`tamandua uninstall [--force]` stops all Tamandua services and removes every
installed workflow, including agent workspaces, agent registrations, and cron
jobs.

```bash
tamandua uninstall [--force]
```

By default, uninstall checks for active runs (running or paused) and refuses
if any exist. Use `--force` to skip this check.

Compare with `tamandua workflow uninstall <name> [--force]` which removes a
single workflow without stopping services, and `tamandua workflow uninstall
--all [--force]` which removes all workflows (also no service stops).

### 2.10) AutoResearch experiment commands

AutoResearch runs durable optimization experiment loops. Sessions are stored
in project-local files (`autoresearch.config.json`, `autoresearch.jsonl`,
`autoresearch.md`). The three core commands are init, run-experiment, and
log-experiment.

#### Init

`tamandua autoresearch init` creates a new AutoResearch session.

```bash
tamandua autoresearch init --goal <text> --metric <name> --direction <lower|higher> --command <cmd> [options]
```

Required options:
- `--goal <text>` — description of the optimization target
- `--metric <name>` — name of the primary metric (e.g. `total_ms`, `val_bpb`)
- `--direction <lower|higher>` — whether lower or higher is better
- `--command <cmd>` — benchmark command to run for each experiment

Optional options:
- `--unit <unit>` — metric unit (e.g. `seconds`, `ms`, `bpb`, `auc`)
- `--metric-regex <regex>` — regex with the metric value in capture group 1
- `--checks-command <cmd>` — correctness command to run after successful benchmarks
- `--cwd <dir>` — project directory (default: current directory)
- `--overwrite` — replace existing autoresearch files

Example:

```bash
tamandua autoresearch init \
  --goal "speed up test suite" \
  --metric total_ms \
  --unit ms \
  --direction lower \
  --command "pnpm test --run"
```

#### Run-Experiment

`tamandua autoresearch run-experiment` executes the configured benchmark
command, captures output, parses the metric, runs optional checks, and
appends a result to `autoresearch.jsonl`.

```bash
tamandua autoresearch run-experiment [options]
```

Options:
- `--cwd <dir>` — project directory (default: current directory)
- `--command <cmd>` — override the configured command for this run
- `--metric-regex <regex>` — override metric parser for this run
- `--checks-command <cmd>` — override or provide correctness checks
- `--timeout-seconds <n>` — command timeout (default: 1800)

Example:

```bash
tamandua autoresearch run-experiment
```

#### Log-Experiment

`tamandua autoresearch log-experiment` records the keep/discard decision,
learning, and next focus for an experiment. By default, `--status auto`
classifies the latest measured result by comparing it with prior accepted
runs.

```bash
tamandua autoresearch log-experiment --description <text> [options]
```

Options:
- `--cwd <dir>` — project directory (default: current directory)
- `--status <status>` — `auto`, `baseline`, `keep`, `discard`, `crash`, or `checks_failed`
- `--metric <number>` — metric value if no latest run_result should be used
- `--description <text>` — what changed in this experiment
- `--hypothesis <text>` — hypothesis tested
- `--learned <text>` — evidence learned from the result
- `--next-focus <text>` — next experiment direction
- `--commit` — commit kept/baseline results with git
- `--revert-discard` — revert non-autoresearch tracked files on discard

Output includes the logged run status, the best metric so far, and a
confidence line (band, score, MAD noise floor, sample count). Treat `low`
confidence as a signal to rerun or confirm the current best before
stacking more changes.

Example:

```bash
tamandua autoresearch log-experiment \
  --status auto \
  --description "cache parser hot path" \
  --learned "faster but flaky on invalid input" \
  --next-focus "fix cache invalidation"
```

### 2.11) AutoResearch loop and iteration commands

AutoResearch supports running bounded experiment loops and transactional
single-iteration execution. The loop command orchestrates the full
run-measure-log cycle repeatedly; run-loop-iteration executes one step
transactionally (commit on keep, revert on discard/crash).

#### Loop

`tamandua autoresearch loop` runs a bounded experiment loop with live
terminal progress.

```bash
tamandua autoresearch loop [options]
```

An action mode is REQUIRED — the loop will fail without one.

Action modes:
- `--measure-only` — Repeated benchmark only (no optimization). Honest
  measurement; no code/config changes between iterations.
- `--prompt` — pi-driven optimization. Between iterations, spawns pi to make
  one small code change guided by AutoResearch history.

Options:
- `--target-metric <number>` — Stop loop when the target metric is reached
  (compared via the configured direction)
- `--max-iterations <number>` — Maximum number of iterations (default: 20)
- `--max-consecutive-failures <n>` — Stop after N consecutive failures
  (default: 3)
- `--timeout <duration>` — Per-pi-action timeout (default: 5m). Format:
  `<number><s|m|h>` (e.g. `300s`, `10m`, `1h`)
- `--cwd <dir>` — Project directory (default: current directory)

Stop conditions (the loop stops when any one is met):
- Target metric reached (requires `--target-metric` or config target)
- Max iterations reached (`--max-iterations`)
- Too many consecutive failures (`--max-consecutive-failures`)
- User cancels with Ctrl-C / SIGINT

Progress display shows for each iteration: action mode label
(`[measure-only]` or `[prompt]`), `[N/MAX]` iteration number, current focus,
measured metric, decision (`keep`/`discard`/`crash`), best metric (loop +
all-time), failure count, and stop reason.

After the loop ends, a final summary prints: total iterations, best metric
(this loop and all-time), best run number, and kept/discarded/crashed counts.

Cancellation (Ctrl-C / SIGINT) prints the last completed iteration info
and leaves `autoresearch.jsonl` in a consistent state.

Examples:

```bash
tamandua autoresearch loop --measure-only --max-iterations 10
tamandua autoresearch loop --prompt --target-metric 0.5 --max-iterations 30
tamandua autoresearch loop --prompt --max-consecutive-failures 5
tamandua autoresearch loop --prompt --timeout 10m --max-iterations 10
```

#### Run-Loop-Iteration

`tamandua autoresearch run-loop-iteration` runs a single transactional
experiment iteration.

```bash
tamandua autoresearch run-loop-iteration [options]
```

Transactional lifecycle:

1. If `--prompt` is provided, invokes pi to make one candidate code change.
2. Runs the configured experiment command and measures the metric.
3. Logs the result to `autoresearch.jsonl`:
   - `keep`/`baseline` results are committed (`autoresearch*` files excluded).
   - `discard` results are reverted (candidate changes rolled back).
   - `crash`/`checks_failed` results are reverted.
4. Ensures the working tree has no dirty non-autoresearch files.

Options:
- `--cwd <dir>` — Project directory (default: current directory)
- `--prompt <text>` — pi agent prompt for code change (optional)
- `--command <cmd>` — Override the configured experiment command
- `--timeout <duration>` — Per-pi-action timeout (default: 5m). Format:
  `<number><s|m|h>` (e.g. `300s`, `10m`, `1h`)
- `--iteration <n>` — Iteration number (for logging)
- `--description <text>` — Description of the experiment

Output: JSON object with run number, status, metric, agent success,
committed/reverted flags, and the full log entry.

Examples:

```bash
tamandua autoresearch run-loop-iteration --prompt "try smaller LR" --iteration 1
tamandua autoresearch run-loop-iteration --command "uv run train.py" --iteration 5
tamandua autoresearch run-loop-iteration --prompt test --iteration 1
```

### 2.12) AutoResearch monitoring and setup commands

AutoResearch provides commands for inspecting experiment status, generating
evidence-driven prompts, pruning stale sessions, and interactive setup.

#### Status

`tamandua autoresearch status` summarizes the experiment loop state.

```bash
tamandua autoresearch status [--cwd <dir>]
```

Options:
- `--cwd <dir>` — project directory (default: current directory)

Status output includes:
- **Baseline** — the initial measurement before any optimization
- **Best result** — the best metric seen so far (this session and all-time)
- **Keep count** — experiments accepted as improvements
- **Discard count** — experiments that did not improve or were worse
- **Crash count** — experiments that failed to complete
- **Confidence** — how far the best improvement sits above measured noise
  (`high`/`medium`/`low`, scored as improvement divided by the MAD noise
  floor across measured runs; `unknown` until 3+ measured metrics exist)
- **Ratchet prompt** — evidence-driven prompt for the next experiment
- **Run count** — total experiments executed

If no session has been initialized, status reports that no AutoResearch
session exists.

Example:

```bash
tamandua autoresearch status
tamandua autoresearch status --cwd /path/to/project
```

#### Next

`tamandua autoresearch next` prints the evidence-driven ratchet prompt that
agents should read before proposing the next experiment.

```bash
tamandua autoresearch next [--cwd <dir>]
```

Options:
- `--cwd <dir>` — project directory (default: current directory)

The ratchet prompt includes:
- The current baseline and best result
- A summary of what was tried in prior experiments
- What was learned from prior experiments
- Suggested focus direction for the next experiment

This is the same ratchet prompt displayed by `autoresearch status`. It is
intended to be consumed programmatically by agents or scripts.

Example:

```bash
tamandua autoresearch next
tamandua autoresearch next --cwd /path/to/project
```

#### Prune

`tamandua autoresearch prune` removes stale session registry rows from the
SQLite database. It does **not** touch project-local `autoresearch.jsonl` or
`autoresearch.config.json` — those files remain safe on disk.

```bash
tamandua autoresearch prune --older-than <duration> [--missing] [--dry-run]
```

Options:
- `--older-than <duration>` — prune sessions older than this duration (**required**)
- `--missing` — only prune sessions whose project files no longer exist on disk
- `--dry-run` — show what would be pruned without deleting anything

Duration format:
- Duration is specified as a number followed by a unit letter:
  - `d` — days (e.g. `30d` = 30 days)
  - `h` — hours (e.g. `24h` = 24 hours)
  - `m` — minutes (e.g. `30m` = 30 minutes)

Without `--missing`, all sessions older than the duration are pruned.
With `--missing`, only sessions whose working directory or config files are
no longer accessible are pruned.

Examples:

```bash
tamandua autoresearch prune --older-than 30d
tamandua autoresearch prune --older-than 7d --missing
tamandua autoresearch prune --older-than 30d --dry-run
```

#### Wizard

`tamandua autoresearch wizard` launches an interactive setup flow that guides
you through creating a new AutoResearch session.

```bash
tamandua autoresearch wizard [--cwd <dir>]
```

Options:
- `--cwd <dir>` — working directory (default: current directory)

The wizard interactively asks:
- **Goal** — what you want to optimize
- **Metric name** — what to measure (e.g. `total_ms`, `val_bpb`)
- **Direction** — whether lower or higher is better
- **Command** — the benchmark command to run for each experiment
- **Unit** (optional) — metric unit (e.g. `seconds`, `ms`, `bpb`)
- **Checks command** (optional) — correctness validation after benchmarks

After collecting answers, the wizard generates the exact `tamandua
autoresearch init` command needed. If initialization is requested, it
optionally executes the init command, then generates the `tamandua
autoresearch loop` command to start the optimization loop. No project files
are created directly by the wizard — it delegates to the init command.

Example:

```bash
tamandua autoresearch wizard
tamandua autoresearch wizard --cwd /path/to/project
```

### 3) Follow the step lifecycle exactly

Always execute step commands in this order:

1. `tamandua step peek <agent-id> --run-id <run-id>`
2. If result is `HAS_WORK`, run `tamandua step claim <agent-id> --run-id <run-id>`
3. Parse claim JSON: `{"stepId":"...","runId":"...","input":"..."}`
4. **SAVE `stepId` immediately** and execute the `input` task
5. Report with the saved step id:
   - Success: `tamandua step complete <stepId>` (send status output through stdin)
   - Failure: `tamandua step fail <stepId> "<reason>"`

Use the run ID supplied by your scheduler prompt or workflow context. `step peek` and `step claim` require `--run-id` so agents serving concurrent runs cannot claim each other's work.

Never call `step complete` or `step fail` with an agent ID. They require the claimed step UUID.

For diagnostics, use `tamandua step stories <run-id>` to list all stories
for a run and their statuses. This is useful when diagnosing blocked
pipelines or understanding story progress.

### 4) Completion contract

On success, provide structured output that includes:

- `STATUS: done`
- `CHANGES: ...`
- `TESTS: ...`

Then pipe that output into `tamandua step complete <stepId>`.

On failure, call `tamandua step fail <stepId> "<clear reason>"` with actionable detail.

### 2.1) MCP run start (remote)

When using MCP, `tamandua.run.start` requires a harness working directory.
`workingDirectoryForHarness` is mandatory (not optional) for MCP runs.

Required MCP args:

- `workflowId`
- `taskTitle`
- `workingDirectoryForHarness` (mandatory)

Optional MCP args:

- `noHurrySaveTokensMode` (boolean) — lowers agent polling frequency to
  save tokens, same as the CLI `--no-hurry-please-save-tokens-mode` flag.
  When `true`, the scheduler uses a 15-minute floor and 15-minute default
  instead of the normal 1-minute floor and 5-minute default.

Additional MCP tools:

- `tamandua.run.delete` — permanently delete a run. Requires `runId`. Optional
  `force` (boolean) to cancel and delete active runs.

Recovery pattern for tool-calling models:

- If MCP returns: `Argument "workingDirectoryForHarness" must be a non-empty string`
- Retry the same tool call with an explicit absolute path (for example `/home/user/repo`).

### 2.2) Inspect activity with logs and logs-tail

Use logs to inspect recent run activity or follow events as they happen.

The selector can be:
- A number — shows that many most recent entries globally
- A run ID prefix — shows entries for that run
- `#<run-number>` — shows entries for the Nth run

```bash
# Show recent entries
tamandua logs                        # default: last 20 entries
tamandua logs 50                     # last 50 entries
tamandua logs <run-id>               # entries for a specific run
tamandua logs #3                     # entries for run number 3

# Follow activity as new events arrive
tamandua logs-tail                   # tail recent activity (live)
tamandua logs-tail 50                # tail, starting with last 50 entries
tamandua logs-tail <run-id>          # tail events for a specific run
tamandua logs-tail #3                # tail events for run number 3
```

Example: after starting a workflow, follow its progress:

```bash
tamandua workflow run feature-dev "Add login page"
# -> Run started: 8a3b2c1d-...
tamandua logs-tail 8a3b2c1d          # follow events as they arrive
```

### 2.3) Dashboard lifecycle and source path

Start, stop, and check the web dashboard:

```bash
tamandua dashboard start [--port N]    # Start dashboard (default: 3334)
tamandua dashboard stop                # Stop dashboard
tamandua dashboard status              # Check dashboard + MCP status
```

`dashboard status` reports both dashboard and MCP server status in a single
output. The remote MCP server can be managed independently with
`tamandua mcp start [--port N]`, `tamandua mcp stop`, and `tamandua mcp status`
(standalone on port 3338 by default).

`tamandua source-path` prints the source checkout path that `tamandua update`
uses to pull, rebuild, and reinstall.

### 2.4) First-time setup with get-ready

Use `tamandua get-ready` to prepare a fresh Tamandua checkout.

```bash
tamandua get-ready
```

`get-ready` performs these setup steps in order:

1. Installs all bundled workflows into your Tamandua state directory
2. Ensures the CLI launcher symlink exists at `~/.local/bin/tamandua`
3. Starts the dashboard daemon if it is not already running
   (the daemon co-manages the dashboard HTTP server and the in-process control plane)
4. Reports dashboard and MCP server status

Run `get-ready` after pulling a new Tamandua checkout or after
`tamandua update` if workflows or services need reinstallation.
It is safe to run multiple times — already-installed workflows are
skipped and a running daemon is left untouched.

Example session:

```bash
cd /path/to/tamandua
./build && ./install
tamandua get-ready
# -> Installs bundled workflows
# -> Ensures CLI symlink exists
# -> Dashboard is running on port 3334
# -> MCP server is not running (start it with: tamandua mcp start)
```

### 2.5) Hermes harness support (Alpha)

The `--hermes-as-harness` flag runs agents with the Hermes harness instead of
the default pi harness.

```bash
tamandua workflow run <workflow-id> "<task>" --hermes-as-harness
```

> ⚠️ **Hermes support is in alpha.** It is **very slow** compared to pi, and
> **token accounting is broken** — token counts reported by Hermes runs are
> inaccurate. Pi is the default and recommended harness for production use.

The `--pi-as-harness` flag explicitly selects the pi harness (this is the
default, so the flag is rarely needed unless a previous run used
`--hermes-as-harness`).

These flags are mutually exclusive — you cannot specify both in the same run.

To use a custom Hermes binary, set the `TAMANDUA_HERMES_BINARY` environment
variable:

```bash
export TAMANDUA_HERMES_BINARY=/path/to/hermes
tamandua workflow run <workflow-id> "<task>" --hermes-as-harness
```

If `TAMANDUA_HERMES_BINARY` is not set, Tamandua searches for `hermes` on
`PATH`. The binary is validated at scheduling time — if it is not found or
not executable, the run fails at startup.

### 5) Review artifacts on changes

When making code changes, review whether these artifacts need updating:

- `docs/creating-workflows.md` — user-facing workflow documentation
- `src/server/mcp-server.ts` — MCP tools registered for agent use
- `src/cli/cli.ts` — CLI commands that agents invoke
- `src/server/index.html` — dashboard UI
- `README.md` — project overview

Changes that typically cascade to multiple artifacts:

- **Step lifecycle** changes → update CLI, MCP, docs
- **CLI command** additions or changes → update skill, MCP, docs
- **Agent provisioning** changes → update skill, workspace files
- **Output format contract** changes → update docs, MCP

If you update this skill file, verify that bundled workflow persona AGENTS.md
files reflect the change.

## Examples

### Polling loop example

```bash
# Phase 1: Peek
tamandua step peek feature-dev_developer --run-id 7aeb4da9-1111-4222-8333-abcdefabcdef
# -> NO_WORK (stop) OR HAS_WORK (continue)

# Phase 2: Claim
tamandua step claim feature-dev_developer --run-id 7aeb4da9-1111-4222-8333-abcdefabcdef
# -> {"stepId":"87409f73-...","runId":"7aeb4da9-...","input":"Implement ..."}
# Save stepId=87409f73-...

# Execute the input task...

# Success report (uses saved stepId)
echo 'STATUS: done
CHANGES: Added skill docs and tests
TESTS: node --test tests/*.test.ts' | tamandua step complete 87409f73-4ba6-492a-be44-30b2b6ffbadb

# Failure alternative
# tamandua step fail 87409f73-4ba6-492a-be44-30b2b6ffbadb "Missing repository path"
```

### Manual step inspection

```bash
tamandua step stories <run-id>
```

Use `step stories` to inspect current story status for a run when diagnosing blocked pipelines.
