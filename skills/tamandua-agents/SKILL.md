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
tamandua workflow list [--json]          # Shows [worktree] or [direct] marker per workflow
tamandua workflow install <workflow-id|--all>
tamandua workflow uninstall <workflow-id|--all> [--force]
tamandua workflow run <workflow-id> "<task>" [--context <key=value> ...] [--working-directory-for-harness <dir>] [--worktree-origin-repository <dir>] [--worktree-origin-ref <ref>] [--pi-as-harness | --hermes-as-harness] [--no-hurry-please-save-tokens-mode] [--no-relaunch-upon-rugpull] [--wait [--timeout <dur>] [--json]]
tamandua workflow status <query>
tamandua workflow runs
tamandua workflow wait <selector...> [--all] [--timeout <dur>] [--json] [--quiet]
tamandua workflow pause <run-id>
tamandua workflow pause-all [--drain]
tamandua workflow resume <run-id>
tamandua workflow resume-all
tamandua workflow stop <run-id>
tamandua workflow cancel <run-id>        # Alias for stop
tamandua workflow autoresearch <run-id>
tamandua workflow delete <run-id> [--force]
tamandua nudge
```

**Flag rejection:** `tamandua workflow run` now rejects unknown `--flags` and
`-x` short flags with a clear error message instead of silently absorbing them
into the task title. Use `--` to pass a task that starts with `--` or `-`
(e.g. `tamandua workflow run mywf -- --my-task-flag`).

`tamandua nudge` wakes all scheduled agents for all currently running runs,
causing them to poll once immediately without waiting for their normal
timers. Does not resume paused runs or interrupt in-flight agents.

`tamandua workflow wait` blocks until the selected runs reach a terminal
status (completed/done, failed, or canceled) or until `--timeout` expires.
Selectors can be a run UUID, a unique run-id prefix, or `#N` (run number).
Multiple selectors wait for all of them; `--all` waits for every non-terminal
run at invocation time. Without `--timeout`, waits indefinitely.

The `--wait` flag on `tamandua workflow run` starts the run and then enters
the wait behavior above for that run. With `--json`, the wait result is
printed as a JSON object.

**Exit codes** (precedence top-down):
- 4 — selector not found or ambiguous prefix
- 2 — timeout expired with at least one run still non-terminal
- 1 — at least one run failed
- 3 — at least one run canceled (and none failed)
- 0 — all runs completed successfully

Exit code 2 is an expected, documented outcome — it means the bounded wait
window elapsed and the caller should decide whether to keep waiting.

**Bounded-wait loop pattern** for capped shell harnesses:
```bash
while ! tamandua workflow wait <selector> --timeout 5m; do
  [ $? -eq 2 ] || break
done
```
This polls in 5-minute windows until the run finishes (code 0) or fails
permanently (code 1/3/4).

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

Run context guidance:

- `--context key=value` injects a template context key into the run and is
  repeatable. Tamandua splits each value on the first `=` and rejects duplicate
  keys.
- Example: `--context branch=feature/my-branch`.

Workspace-mode guidance:

- Workflows declare `run.workspace` as `direct` (the default) or `worktree`.
  Workflow IDs ending in `-worktree` use worktree mode.
- Direct-mode workflows may use `--working-directory-for-harness`; when it is
  omitted, the directory defaults to the shell's current working directory.
  Direct mode rejects both `--worktree-origin-repository` and
  `--worktree-origin-ref`.
- Worktree-mode workflows reject `--working-directory-for-harness`. Use
  `--worktree-origin-repository <dir>` to select the origin repository and
  `--worktree-origin-ref <ref>` to select a branch, tag, or SHA. These default
  to the current repository and current branch, respectively.
- A worktree launch requires the origin repository to have no uncommitted
  changes. Commit or stash changes before launching, or Tamandua refuses the
  launch.
- Worktree runs never modify the origin repository; all run changes stay in
  the isolated worktree.

#### Supervising a run

Put a substantial task in a file and preserve it as one quoted CLI argument:

```bash
tamandua workflow run <workflow-id> "$(cat task.md)" [workspace-mode flags]
```

Inspect and stop the run with the CLI:

```bash
tamandua workflow status <run-id>
tamandua workflow runs
tamandua logs <run-id>
tamandua workflow stop <run-id>
tamandua workflow cancel <run-id>
```

Both `stop` and `cancel` terminate the run and print `Cancelled run X.`.
`cancel` is a documented alias for `stop`. Prefer these CLI commands for run-state inspection. If the CLI does not
expose a needed field, reading `~/.tamandua/tamandua.db` directly is an
acceptable fallback, but always open it read-only with
`sqlite3 -readonly ~/.tamandua/tamandua.db`; do not use the database as the
first resort.

Never edit installed workflow files under `~/.tamandua/workflows`: every
install and update overwrites them, so local edits are silently overwritten.
To customize a workflow, copy it under a new workflow ID instead.

Use `tamandua update [--force]` only for local Tamandua maintenance. Without
`--force`, update blocks after rebuilding if active runs are present — it
leaves services and installed workflows unchanged. Use `--force` to proceed
despite active runs (services are stopped and restarted, workflows reinstalled
— this reinstalls all workflows, refreshing bundled files).
Remote MCP clients can discover the same maintenance command via
`tamandua.update.command`; run the actual update through the local CLI because
it may restart dashboard, MCP, and the control plane.

**After a local build** (no remote pull): use `./build && ./install` followed
by `tamandua restart` to pick up the new code. `restart` stops and restarts
all services from the currently installed build without reinstalling workflows —
it is the sanctioned replacement for the `sleep 2; tamandua get-ready` idiom.

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
`--no-hurry-please-save-tokens-mode` makes the run prefer the
`pi-token-saver` harness: every work spawn looks for a `pi-token-saver`
command on PATH first (per invocation, so installing it mid-run takes
effect) and falls back to `pi` when it is absent. It does not change
scheduling — idle dispatch is free either way.

Use `--no-relaunch-upon-rugpull` to disable automatic replacement-run
creation after a rugpull (base branch move) is detected on a failed
merge or merge-worktree run. By default, Tamandua creates a replacement
run when a rugpull is detected, so the merge can target the updated base.
The rugpull mechanism is narrow in scope: it only applies to
`finalize_merge` failures in merge workflows where the base branch
tip moved during the run. Mid-pipeline step retry exhaustion, expects
validation exhaustion, and worker death permanently fail runs by design —
no automatic replacement is triggered. Use `tamandua workflow resume
<run-id>` to reattempt a permanently failed run; fix the underlying issue
before resuming.

`tamandua workflow autoresearch <run-id>` shows AutoResearch progress
for a workflow run. It resolves the run's harness working directory,
reads the project-local `autoresearch.config.json` and
`autoresearch.jsonl` files, and prints the current metric summary and
recent experiment timeline.

### 2.7) System status with tamandua status

Use `tamandua status` for a comprehensive overview of the Tamandua system:

```bash
tamandua status
```

`status` reports:

- **Services** — Dashboard, MCP, and control-plane status (up/down, PID, port)
- **Tamandua Info** — Source path, skill path, version, and source tree SHA256
- **Workflow Runs** — Summary of all runs (running, paused, done, failed)
- **Running Processes** — Active pi/hermes harness processes spawned by Tamandua

### 2.8) Worktree management

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

### 2.9) Control plane management

The control plane provides run-scoped scheduling for deterministic work
dispatch (hosted by the daemon process alongside the reconciler/motor).

**Live-instance isolation (for agents running INSIDE a tamandua run):** the
`tamandua step` reporting commands (claim / complete / fail, documented
below) are the ONLY sanctioned interaction with the live tamandua instance
that is scheduling you. Never start/stop/restart the live daemon, MCP, or control plane — including
`tamandua restart`, which restarts all three. To exercise lifecycle behavior,
spin up an ISOLATED instance instead: point `HOME`/`TAMANDUA_STATE_DIR` at a
temp directory and use non-default ports (`TAMANDUA_CONTROL_PORT` plus
explicit `--port` values). As a backstop, `stop`/`restart` refuse to signal
the daemon that scheduled you ("Refusing to stop the daemon…"): that error
means you targeted the live instance — switch to an isolated one.

```bash
tamandua control-plane start [--port N]
tamandua control-plane stop
tamandua control-plane restart [--port N]
tamandua control-plane status
tamandua control-plane status
```

Default port: 3339.

`status` reports whether the control plane is running (PID, port, endpoint).

Start will refuse if the control plane is already running, printing its
current status instead. Stop is safe to run even when no control plane
is active.

### 2.10) Full uninstall with tamandua uninstall

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

### 2.11) On-failure routing and rerouting

When a step fails, workflows can route the failure back to an upstream
producer step for correction instead of immediately permanently failing
(see `docs/creating-workflows.md` for full details). This is configured per
step via `on_fail` in the workflow YAML:

- **`on_fail.retry_step`** — reroutes the failing step to a named upstream
  producer step. The producer re-executes, and the downstream step that
  failed gets a fresh chance after the upstream fix.
- **`max_reroutes`** — limits how many times a step can be rerouted before
  giving up (default 2). When the reroute budget exhausts, the run
  permanently fails.

Events emitted during routing:

- `step.rerouted` — step was sent back to an upstream producer
- `step.reroute_budget_exhausted` — reroute limit reached; step is
  permanently failed
These events are visible in `tamandua logs` and `tamandua logs-tail`.
Permanently failed runs can be reattempted with
`tamandua workflow resume <run-id>`; fix the underlying issue before
resuming.

### 2.12) AutoResearch experiment commands

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
- `--timeout-seconds <n>` — command timeout (default: 3600)

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
- `--status <status>` — `auto`, `baseline`, `keep`, `discard`, `crash`, `metric_not_found`, or `checks_failed`
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

### 2.13) AutoResearch loop and iteration commands

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
   - `metric_not_found` results do not update best/baseline — the run is recorded as unmeasured.
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

### 2.14) AutoResearch monitoring and setup commands

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

Scheduled workflow agents are told by their dispatch prompt that a step is
pending. For those scheduled agents, `tamandua step peek` is optional; peek is
primarily useful for manual or diagnostic operation. Whether or not you peek,
follow the claim lifecycle:

1. Optionally run `tamandua step peek <agent-id> --run-id <run-id>`.
2. Run `tamandua step claim <agent-id> --run-id <run-id>` when the dispatch
   prompt says work is pending or peek returns `HAS_WORK`.
3. Check for `NO_WORK` before parsing the claim output as JSON. A claim can
   legally return `NO_WORK` even after `HAS_WORK` because another worker won
   the race or the loop completed. If it does, stop without doing step work.
4. Otherwise parse claim JSON: `{"stepId":"...","runId":"...","input":"..."}`.
5. **SAVE `stepId` immediately** and execute the `input` task.
6. Report with the saved step id:
   - Success: `tamandua step complete <stepId>` (send status output through stdin)
   - Failure: `tamandua step fail <stepId> "<reason>"`

Use the run ID supplied by your scheduler prompt or workflow context. `step peek` and `step claim` require `--run-id` so agents serving concurrent runs cannot claim each other's work.

Never call `step complete` or `step fail` with an agent ID. They require the claimed step UUID.

For diagnostics, use `tamandua step stories <run-id>` to list all stories
for a run and their statuses. This is useful when diagnosing blocked
pipelines or understanding story progress.

### 4) Completion contract

**CRITICAL — piping a report into `tamandua step complete <stepId>` is the ONLY
thing that completes a step.** Printing `STATUS: done` in a final chat or
session message does not complete it.

On success, pipe structured output containing `STATUS: done` as its own
plain-text line into `step complete`. By convention, it is the first report
line, followed by the step's `KEY:` lines such as `CHANGES:` and `TESTS:`. The
scheduler matches status markers anywhere in the piped output; they do not have
to be the final line.

For example, the report payload is:

```text
STATUS: done
CHANGES: ...
TESTS: ...
```

Pipe that payload to the saved step UUID, for example:

```bash
printf 'STATUS: done\nCHANGES: ...\nTESTS: ...\n' | tamandua step complete <stepId>
```

**CRITICAL — STATUS markers are parsed by the scheduler.** Output is
classified by exact markers: `STATUS: done` (success) or `STATUS: failed` /
`STATUS: error` (failure). If no status marker is present, the scheduler treats
the step as lost/abandoned and retries it, wasting a retry slot even when the
work was completed.

STATUS: and KEY: contract lines must start at column 0 as plain text: no bold,
no backticks, no fences, and no leading bullets in the report payload.
`**BRANCH:** foo` fails validation; `BRANCH: foo` passes.

Verdict channels are distinct:

- A verifier that rejects work pipes `STATUS: retry` plus a `REASON:` or other
  summary KEY: line into `tamandua step complete <stepId>`. This reroutes the
  producer for another attempt.
- `tamandua step fail <stepId> "<reason>"` means "I could not do the work."
  Use it with an actionable reason when execution cannot be completed. Do not
  use `step fail` to deliver a retry verdict.

#### STORIES_JSON reports

When a step requires `STORIES_JSON:`, its value must be a single-line JSON
array ending with `]`, with no trailing prose after the array. The array must
not contain embedded newline-separated lines starting with `UPPERCASE_KEY:`;
the extractor truncates the value when it encounters such a line.

Construct `STORIES_JSON` with `python3` and `json.dumps` via a heredoc and pipe
the result directly to `step complete`, rather than hand-quoting JSON:

```bash
python3 - <<'PY' | tamandua step complete <stepId>
import json

stories = [{"id": "US-001", "title": "Example"}]
print("STATUS: done")
print("STORIES_JSON: " + json.dumps(stories, separators=(",", ":")))
PY
```

### 2.1) MCP run start (remote)

When using MCP, `tamandua.run.start` requires a harness working directory.
`workingDirectoryForHarness` is mandatory (not optional) for MCP runs.

Required MCP args:

- `workflowId`
- `taskTitle`
- `workingDirectoryForHarness` (mandatory)

Optional MCP args:

- `noHurrySaveTokensMode` (boolean) — same as the CLI
  `--no-hurry-please-save-tokens-mode` flag: work spawns prefer a
  `pi-token-saver` command from PATH over `pi` (falling back to `pi`
  when absent).

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
tamandua logs --tail 50              # last 50 entries (flag form)
tamandua logs 50                     # last 50 entries (numeric selector)
tamandua logs <run-id>               # entries for a specific run
tamandua logs <run-id> --tail 20     # tail a specific run with initial limit
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
tamandua dashboard restart [--port N]  # Stop then start (also picks up rebuilt code)
tamandua dashboard status              # Check dashboard + MCP status
```

`dashboard status` reports both dashboard and MCP server status in a single
output. The remote MCP server can be managed independently with
`tamandua mcp start [--port N]`, `tamandua mcp stop`, `tamandua mcp restart [--port N]`, and `tamandua mcp status`
(standalone on port 3338 by default).

Restart all Tamandua services at once (dashboard, MCP server, daemon
control plane + motor) from the currently installed build:

```bash
tamandua restart [--force]
```

`restart` stops services in order (dashboard → MCP → daemon), waits for each
to fully shut down (real stop→ready barriers, no fixed sleeps), then starts them
(daemon → dashboard → MCP) and waits for each to become healthy. It does NOT
git pull, rebuild, reinstall workflows, or touch `~/.tamandua/workflows`.
Services come up from whatever is currently installed.

This is the sanctioned way to pick up a locally rebuilt tree: build and install
first (`./build && ./install`), then `tamandua restart` — a single honest verb
replacing the old `sleep`-then-`get-ready` idiom.

By default, `restart` refuses when active workflow runs exist (running or paused),
listing them and suggesting `--force`.

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
3. Starts the daemon (control plane + motor), dashboard standalone, and
   MCP server if they are not already running (each service runs as an
   independent process)
4. Reports dashboard, daemon, and MCP server status

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

> ⚠️ **Hermes support is in alpha.** It is **very slow** compared to pi.
> Token usage is read from hermes' state.db after each round (best-effort: falls
> back to 0 tokens with a warning if the hermes schema is unavailable or changed).
> Pi is the default and recommended harness for production use.

The `--pi-as-harness` flag explicitly selects the pi harness (this is the
default, so the flag is rarely needed unless a previous run used
`--hermes-as-harness`).

These flags are mutually exclusive — you cannot specify both in the same run.

#### Hermes Binary Resolution

Tamandua resolves the Hermes binary through a **three-tier chain**. The
binary is validated at scheduling time — if no Hermes binary is found or
the resolved binary is not executable, the run fails at startup with a
clear actionable error.

**Tier 1 — Explicit environment variable:**

```bash
export TAMANDUA_HERMES_BINARY=/path/to/hermes
```

Set `TAMANDUA_HERMES_BINARY` to an absolute or relative path. Relative paths
are resolved against the daemon's working directory at validation time.

**Tier 2 — Process PATH (with optional token-saver):**

If `TAMANDUA_HERMES_BINARY` is not set, Tamandua searches the daemon's own
`PATH` for `hermes`. When `noHurrySaveTokensMode` is enabled, Tier 2 first
searches for `hermes-token-saver` (a token-saving wrapper) before falling back
to a bare `hermes` binary.

**Tier 3 — Bounded zsh login-shell fallback:**

If neither the env var nor the process `PATH` yields a working Hermes,
Tamandua spawns `zsh -lic 'command -v hermes'` so Hermes installed via
login-shell startup files (e.g. `~/.zshrc`, `~/.zprofile`) can be discovered.
This is a bounded, best-effort fallback — if zsh is not available or returns
nothing, resolution fails.

#### Absolute-Path Invocation

Every resolved Hermes binary path is **always absolute**. Relative
`TAMANDUA_HERMES_BINARY` values and relative/empty `PATH` entries are resolved
against the daemon process cwd at validation time before the result is stored.
This prevents `./hermes: not found` errors when the dispatcher invokes the binary
from a different working directory.

#### Child-Only PATH Adjustment

When dispatching a Hermes agent session, the resolved binary's directory is
prepended to the child's `PATH` so nested Hermes invocations within the agent
session find the same binary — even if it lives outside the original `PATH`
(e.g. login-shell-discovered Hermes). The original `PATH` is preserved as a
suffix; this adjustment applies only to the child process.

#### Zero Filesystem Mutation

Tamandua's Hermes discovery is **entirely side-effect-free**: it never
creates, deletes, replaces, chmods, or otherwise mutates `~/.local/bin/hermes`
or any user executable or symlink. Tamandua does not own or manage a
`~/.local/bin/hermes` symlink. The only Hermes-related operation is resolving
and running an existing binary.

### 2.6) Troubleshooting with tamandua doctor

`tamandua doctor` is a one-shot diagnostic that checks environment
(Node.js >= 22, pi on PATH, gh on PATH), services (dashboard, daemon, MCP), daemon staleness (running daemon matches installed
build), database state (run-level anomalies), and LLM prompt adherence
(per-step key-emission rates from workflow runs, measuring how often
agents deliver expected output keys). Each check prints **pass/fail**
status and on failure prints the **exact remedy command** to run.

```bash
tamandua doctor
tamandua doctor --help
```

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
