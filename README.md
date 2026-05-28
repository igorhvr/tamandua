# Tamandua

Build your agent team in [pi](https://github.com/mariozechner/pi-coding-agent) with one command.

You don't need to hire a dev team. You need to define one. Tamandua gives you a team of specialized AI agents — planner, developer, verifier, tester, reviewer — that work together in reliable, repeatable workflows. One install. Zero infrastructure.

### Install from GitHub

```bash
curl -fsSL https://raw.githubusercontent.com/igorhvr/tamandua/main/scripts/install.sh | bash
```

Or just tell your agent: **"Clone github.com/igorhvr/tamandua to my home dir, install it and learn the skill included inside it."**

### Install from local checkout

```bash
git clone https://github.com/igorhvr/tamandua.git
cd tamandua
./build-and-install
```

Or step by step:

```bash
./build        # npm install + tsc
./install      # symlink into ~/.local/bin
```

The `build` script handles everything: checks Node.js >= 22, runs `npm install`, compiles TypeScript. The `install` script creates a symlink at `~/.local/bin/tamandua` pointed at your checkout — so you can keep the source wherever you like and `tamandua` stays in sync. Both call into `scripts/install.sh` internally.

That's it. Run `tamandua workflow list` to see available workflows.

> **Not on npm.** Tamandua is installed from source (or GitHub), not the npm registry.

> **Requires Node.js >= 22.** If `tamandua` fails with a `node:sqlite` error, make sure you're running real Node.js 22+, not Bun's node wrapper.

---

## Native AutoResearch

Tamandua includes native AutoResearch primitives for measurable optimization loops.
Unlike a normal workflow, AutoResearch stores durable project-local state so an
agent can resume after restarts, learn from each measured run, and choose the next
experiment from evidence.

Use AutoResearch when the task has a reliable numeric metric and the agent should
run a sequence of experiments instead of one batch of edits. Typical examples are
raising test coverage, reducing validation loss, improving latency, or lowering
cost while preserving correctness.

```bash
tamandua autoresearch init \
  --goal "reduce validation loss" \
  --metric val_bpb \
  --direction lower \
  --command "uv run train.py"

tamandua autoresearch run-experiment
tamandua autoresearch log-experiment --status auto \
  --description "try lower learning rate" \
  --hypothesis "smaller LR improves stability" \
  --learned "validation improved but training slowed" \
  --next-focus "test warmup schedule"
tamandua autoresearch next

# Inspect the loop for a Tamandua workflow run
tamandua workflow autoresearch <run-id>
```

### Triggering AutoResearch

AutoResearch can be driven manually from any project directory, or delegated to a
Tamandua workflow agent. In both cases the project needs a metric command that
prints one parseable number. The command should be deterministic enough to compare
experiments and should exclude generated or third-party code when measuring a
project-owned objective.

Manual loop:

```bash
cd /path/to/project

tamandua autoresearch init \
  --goal "Increase unit test coverage to 1.000 without changing application code" \
  --metric coverage \
  --unit ratio \
  --direction higher \
  --command "./measure-test-coverage.sh" \
  --metric-regex "^([0-9]\\.[0-9]{3})$" \
  --checks-command "./measure-test-coverage.sh"

tamandua autoresearch run-experiment
tamandua autoresearch log-experiment --status auto \
  --description "baseline coverage" \
  --hypothesis "establish current coverage" \
  --learned "baseline recorded" \
  --next-focus "cover the lowest-risk uncovered module"
tamandua autoresearch next
```

Workflow-driven loop:

```bash
tamandua workflow install do-now
tamandua dashboard start

tamandua workflow run do-now \
  "In the target repo, create or verify ./measure-test-coverage.sh, initialize tamandua autoresearch, then run 10 bounded experiments. Before each edit run tamandua autoresearch next. Only add or change tests/fixtures/test config. After each experiment run tamandua autoresearch run-experiment and tamandua autoresearch log-experiment --status auto with description, hypothesis, learned, and next-focus. Stop and report best metric, commits, and remaining gaps." \
  --working-directory-for-harness /path/that/contains/or/is/the/project \
  --pi-as-harness
```

Monitor it while the workflow runs:

```bash
tamandua workflow status <run-id>
tamandua workflow autoresearch <run-id>
open http://localhost:3334
```

The dashboard's AutoResearch panel reads the run's harness working directory,
discovers the nearest `autoresearch.config.json` / `autoresearch.jsonl`, and
renders the experiment trace. Gray points are attempted experiments; green points
and the green line are the kept best-so-far frontier.

### Session Registry

Tamandua maintains a SQLite registry of AutoResearch sessions so the dashboard
can discover them directly without scanning workflow runs. The registry lives in
a table called `autoresearch_sessions` inside the main Tamandua database
(`~/.tamandua/tamandua.db`).

- **Project-local files are the source of truth.** `autoresearch.config.json`,
  `autoresearch.jsonl`, `autoresearch.md`, and `autoresearch.sh` remain on disk
  in your project. The DB registry is an index/cache for discovery and dashboard
  UX — it never modifies your project files.
- **Sessions are registered automatically.** Every `tamandua autoresearch` command
  (init, run-experiment, log-experiment, status, next, loop) updates or creates
  the registry entry for that project directory.
- **Backfill on dashboard start.** When the dashboard starts, it scans recent
  workflow runs for harness directories that contain AutoResearch files and
  backfills any missing registry entries.

### Pruning Stale Registry Entries

Use `tamandua autoresearch prune` to clean up stale registry rows without
removing any project-local files.

```bash
# Prune sessions not updated in 30 days
tamandua autoresearch prune --older-than 30d

# Prune only sessions whose project files no longer exist
tamandua autoresearch prune --older-than 7d --missing

# Preview what would be pruned without deleting
tamandua autoresearch prune --older-than 30d --dry-run
```

The prune command only touches the SQLite registry — your `autoresearch.jsonl`,
config files, and experiment history remain untouched on disk.

### Example Experiment

For a test-coverage loop, a single experiment should be narrow enough to explain
before editing and measurable enough to keep or discard after the run.

```bash
# 1. Ask the ratchet what evidence should drive the next edit.
tamandua autoresearch next

# Example returned focus:
# Best run 1: 0.336 ratio
# Next focus: cover pure helpers in batch_processor without touching application code

# 2. Make one focused test-only change.
# Example hypothesis:
# "Adding unit tests for batch_processor pure helper functions will increase
# coverage without requiring Spark or changing runtime code."

# 3. Measure and log the result.
tamandua autoresearch run-experiment
tamandua autoresearch log-experiment --status auto \
  --description "cover batch_processor pure helpers" \
  --hypothesis "pure-helper tests increase coverage without Spark" \
  --learned "coverage increased from 0.336 to 0.477; helper paths are now covered" \
  --next-focus "cover utils.py pure helpers and runtime stubs"
```

If the metric improves in the configured direction and checks pass, the logged run
is kept. If it regresses, crashes, or fails checks, it is logged as discarded,
crash, or checks_failed; with `--revert-discard`, Tamandua can revert non-state
experiment files while preserving `autoresearch.jsonl`.

Project files:

| File | Purpose |
|------|---------|
| `autoresearch.config.json` | Session config: goal, metric, direction, command, parser, checks. |
| `autoresearch.md` | Agent-facing objective and operating loop. |
| `autoresearch.jsonl` | Append-only run history: measured results, decisions, learning, next focus. |
| `autoresearch.sh` | Benchmark command. |
| `autoresearch.checks.sh` | Optional correctness checks run after successful measurements. |

When a workflow run was started with `--working-directory-for-harness`, the
dashboard includes an AutoResearch panel that reads that directory's
`autoresearch.jsonl` and shows best/baseline metrics, kept/discarded counts,
failures, and the recent learning timeline.

The core loop is `init -> run-experiment -> log-experiment -> next`. `log --status auto` classifies a
run as `baseline`, `keep`, `discard`, `crash`, or `checks_failed` by comparing the
latest metric with prior accepted results. The `next` prompt carries the ratchet:
it restates the goal, best result, last learning, and next focus before the agent
starts another experiment.

---

## What You Get: Bundled Workflows

Tamandua ships with 21 bundled workflows organized into five families. Use `tamandua workflow list` to see available workflows, and `tamandua workflow install <id>` to install one.

### Worktree Variants

Worktree variants (`*-worktree`, `*-merge-worktree`) run in a detached git worktree
created from your origin repository. Your main working copy stays untouched until the
workflow completes. This gives you full isolation — continue working while agents
iterate — and a clean abort path: delete the worktree and nothing in your origin repo
has changed. The origin repository only sees changes when a `-merge` variant squashes
the result back into the original branch.

### Rugpull Handling

When a merge workflow (`-merge`, `-merge-worktree`) fails at the `finalize_merge`
step and the base branch tip has moved since the run started, Tamandua automatically
launches a fresh replacement run with the same parameters. This "rugpull" detection
runs after the final merge failure — if the base branch stayed put, no replacement is
triggered. Pass `--no-relaunch-upon-rugpull` to `workflow run` to suppress the
automatic replacement.

### Feature Development

Story-based feature development. The planner decomposes your task into ordered user
stories. Each story goes through implement → verify → test before the next one starts.

| Variant | Workflow ID | Agents | Pipeline |
|---------|------------|--------|----------|
| Local-only | `feature-dev` | 5 | plan → setup → implement → verify → test |
| + Merge | `feature-dev-merge` | 6 | plan → setup → implement → verify → test → finalize_merge |
| Worktree | `feature-dev-worktree` | 5 | plan → setup → implement → verify → test |
| Worktree + Merge | `feature-dev-merge-worktree` | 6 | plan → setup → implement → verify → test → finalize_merge |
| GitHub PR | `feature-dev-github-pr` | 6 | plan → setup → implement → verify → test → pr → review |

**Local-only** stops after testing — commits stay on the feature branch, no merge or
PR. **+ Merge** variants add a `finalize_merge` step that squash-merges all commits
back into the original branch. **Worktree** variants run isolated in a detached worktree.
**GitHub PR** variants create a pull request and run a code review step.

### Bug Fix

Bug triage and fix. The triager reproduces the bug, the investigator finds the root
cause, the fixer patches it, and the verifier confirms the fix against acceptance
criteria.

| Variant | Workflow ID | Agents | Pipeline |
|---------|------------|--------|----------|
| Local-only | `bug-fix` | 5 | triage → investigate → setup → fix → verify |
| + Merge | `bug-fix-merge` | 6 | triage → investigate → setup → fix → verify → finalize_merge |
| Worktree | `bug-fix-worktree` | 5 | triage → investigate → setup → fix → verify |
| Worktree + Merge | `bug-fix-merge-worktree` | 6 | triage → investigate → setup → fix → verify → finalize_merge |
| GitHub PR | `bug-fix-github-pr` | 6 | triage → investigate → setup → fix → verify → pr |

### Security Audit

Vulnerability scanning and patching. Scans for vulnerabilities, ranks by severity,
patches each one, re-audits after all fixes are applied, and runs regression tests.

| Variant | Workflow ID | Agents | Pipeline |
|---------|------------|--------|----------|
| Local-only | `security-audit` | 6 | scan → prioritize → setup → fix → verify → test |
| + Merge | `security-audit-merge` | 7 | scan → prioritize → setup → fix → verify → test → finalize_merge |
| Worktree | `security-audit-worktree` | 6 | scan → prioritize → setup → fix → verify → test |
| Worktree + Merge | `security-audit-merge-worktree` | 7 | scan → prioritize → setup → fix → verify → test → finalize_merge |
| GitHub PR | `security-audit-github-pr` | 7 | scan → prioritize → setup → fix → verify → test → pr |

### Quarantine Broken Tests

Detect failing tests, disable them minimally, and iterate until the full test suite
passes. Useful for establishing a clean baseline on a branch with known test failures.

| Variant | Workflow ID | Agents | Pipeline |
|---------|------------|--------|----------|
| Local-only | `quarantine-broken-tests` | 3 | setup → quarantine → verify |
| + Merge | `quarantine-broken-tests-merge` | 4 | setup → quarantine → verify → finalize_merge |
| Worktree + Merge | `quarantine-broken-tests-merge-worktree` | 4 | setup → quarantine → verify → finalize_merge |

### Quick Tasks

Single-agent workflows for quick one-off tasks and workflow auto-selection.

| Workflow ID | Agents | Pipeline | Description |
|------------|--------|----------|-------------|
| `do-now` | 1 | execute | Submit any task. Get back a success/failure report. No planning, no stories. |
| `just-do-it` | 1 | dispatch | Describe what you want. Dispatches to the most appropriate workflow automatically. For coding tasks (feature-dev*, bug-fix*, security-audit*) it defaults to merge-worktree variants unless the prompt gives a specific reason otherwise. |
| `do-review-do-verify` | 3 | do → review → do-again → verify | Two-pass execution: do the work, review it, revise, then verify the result. |

Install all bundled workflows at once with:

```bash
$ tamandua workflow install --all
```

---

## Why It Works

- **Deterministic workflows** — Same workflow, same steps, same order. Not "hopefully the agent remembers to test."
- **Agents verify each other** — The developer doesn't mark their own homework. A separate verifier checks every story against acceptance criteria.
- **Fresh context, every step** — Each agent gets a clean session. No context window bloat. No hallucinated state from 50 messages ago.
- **Retry and escalate** — Failed steps retry automatically. If retries exhaust, it escalates to you. Nothing fails silently.

---

## How It Works

1. **Define** — Agents and steps in YAML. Each agent gets a persona, workspace, and strict acceptance criteria. No ambiguity about who does what.
2. **Install** — One command provisions everything: agent workspaces, polling, subagent permissions. No Docker, no queues, no external services.
3. **Run** — Agents poll for work independently. Claim a step, do the work, pass context to the next agent. SQLite tracks state. The scheduler keeps it moving.

### Minimal by design

YAML + SQLite + polling. That's it. No Redis, no Kafka, no container orchestrator. Tamandua is a TypeScript CLI with zero external dependencies. It runs wherever pi runs.

---

## Quick Example

```bash
$ tamandua workflow install feature-dev

# Or install all bundled workflows at once
$ tamandua workflow install --all
✓ Installed workflow: feature-dev

$ tamandua workflow run feature-dev "Add user authentication with OAuth"
Run: a1fdf573
Workflow: feature-dev
Status: running

$ tamandua workflow status "OAuth"
Run: a1fdf573
Workflow: feature-dev
Steps:
  [done   ] plan (planner)
  [done   ] setup (setup)
  [running] implement (developer)  Stories: 3/7 done
  [pending] verify (verifier)
  [pending] test (tester)
```

---

## Build Your Own

The bundled workflows are starting points. Define your own agents, steps, retry logic, and verification gates in plain YAML and Markdown. If you can write a prompt, you can build a workflow.

```yaml
id: my-workflow
name: My Custom Workflow
agents:
  - id: researcher
    name: Researcher
    workspace:
      files:
        AGENTS.md: agents/researcher/AGENTS.md

steps:
  - id: research
    agent: researcher
    input: |
      Research {{task}} and report findings.
      Reply with STATUS: done and FINDINGS: ...
    expects: "STATUS: done"
```

Full guide: [docs/creating-workflows.md](docs/creating-workflows.md)

---

## Security

You're installing agent teams that run code on your machine. We take that seriously.

- **Curated repo only** — Tamandua only installs workflows from the official repository. No arbitrary remote sources.
- **Reviewed for prompt injection** — Every workflow is reviewed for prompt injection attacks and malicious agent files before merging.
- **Community contributions welcome** — Want to add a workflow? Submit a PR. All submissions go through careful security review before they ship.
- **Transparent by default** — Every workflow is plain YAML and Markdown. You can read exactly what each agent will do before you install it.

---

## Commands

### Lifecycle

| Command | Description |
|---------|-------------|
| `tamandua get-ready` | Install bundled workflows and start dashboard/control plane |
| `tamandua source-path` | Print the Tamandua source checkout path |
| `tamandua skill-path` | Print the path to the bundled tamandua-agents agent skill |
| `tamandua update [--force]` | Pull the source checkout, rebuild, reinstall workflows, and restart previously running services |
| `tamandua uninstall [--force]` | Full teardown (agents, crons, DB) |

### Workflows

| Command | Description |
|---------|-------------|
| `tamandua workflow run <id> <task> [--working-directory-for-harness <dir>] [--pi-as-harness \| --hermes-as-harness]` | Start a run (defaults harness CWD to your current directory) |
| `tamandua workflow status <query>` | Check run status |
| `tamandua workflow runs` | List all runs |
| `tamandua workflow resume <run-id>` | Resume a failed run |
| `tamandua workflow delete <run-id> [--force]` | Permanently delete a workflow run and associated data |
| `tamandua workflow list` | List available workflows |
| `tamandua workflow install <id> [--all]` | Install one or all workflows |
| `tamandua workflow uninstall <id>` | Remove a single workflow |

### Management

| Command | Description |
|---------|-------------|
| `tamandua dashboard` | Start the web dashboard (also starts remote MCP on `http://localhost:3338/mcp`) |
| `tamandua logs [<lines>|<run-id>|#<run-number>]` | View recent log entries |
| `tamandua logs-tail [<lines>|<run-id>|#<run-number>]` | Follow recent activity as new events arrive |
| `tamandua nudge` | Wake all scheduled agents for running runs to poll immediately |

When you start the management dashboard (`tamandua dashboard`), Tamandua automatically starts the remote MCP server too.

- Dashboard: `http://localhost:3334` (or your custom `--port`)
- MCP endpoint: `http://localhost:3338/mcp` (fixed port)

Use `tamandua dashboard status` to verify both endpoints are up.

#### Kanban view

Each run also has a swim-lane view at `http://localhost:3334/runs/<run-id>/kanban`
(linked from the run-ID in the dashboard's runs table). Lanes are derived
dynamically from the workflow's steps: single steps render one card per lane,
loop steps (e.g. the developer agent iterating over user stories) render one
card per story. Cards are colour-coded by status (todo / running / done /
failed) and the page polls `/api/runs/<run-id>/kanban` every 3 seconds. The
JSON endpoint is also useful for external integrations — see
`src/server/kanban-data.ts` for the response shape.

### Harness Selection

By default, Tamandua uses **pi** (`pi --print`) as its agent harness. You can
override this with the harness selection flags on `tamandua workflow run`:

| Flag | Description |
|------|-------------|
| `--pi-as-harness` | Use pi as the agent harness. **This is the default.** |
| `--hermes-as-harness` | Use [Hermes](https://github.com/nicholasgasior/hermes) as the agent harness instead of pi. |

These flags are **mutually exclusive** — specifying both is an error.

#### Hermes Support (Alpha)

> **⚠️ Alpha quality.** Hermes harness support is in **alpha** and has known
> limitations: it is **very slow** compared to pi, and **token accounting is
> broken** (token usage numbers in runs and the dashboard will be inaccurate).
> Use pi (`--pi-as-harness`) for production workflows.

To use a custom Hermes binary path, set the `TAMANDUA_HERMES_BINARY`
environment variable:

```bash
export TAMANDUA_HERMES_BINARY=/path/to/hermes
```

If `TAMANDUA_HERMES_BINARY` is not set, Tamandua searches for `hermes` on your
`PATH`. The harness validation runs at scheduling time — if the Hermes binary
isn't found or isn't executable, the run fails immediately with a clear error.

### Remote MCP tools

The remote MCP endpoint exposes 14 tools:

#### Run Management

| Tool | Description |
|------|-------------|
| `tamandua.runs.list` | List recent Tamandua workflow runs. Accepts optional `limit` (integer, 1–200, default 50). |
| `tamandua.run.status` | Fetch detailed status for a run. Requires `query` (run id, prefix, or task substring). |
| `tamandua.run.start` | Start a workflow run. Requires `workflowId` and `taskTitle`. |
| `tamandua.run.pause` | Pause a running workflow run. Requires `runId`. Optional `drain` (boolean) to wait for in-flight work before pausing. |
| `tamandua.run.resume` | Resume a paused workflow run. Requires `runId`. |
| `tamandua.run.delete` | Permanently delete a workflow run and associated steps, stories, and worktree metadata. Requires `runId`. Optional `force` (boolean) cancels and deletes running or paused runs. |

#### Events & Metadata

| Tool | Description |
|------|-------------|
| `tamandua.events.recent` | List recent global Tamandua events. Accepts optional `limit` (integer, 1–500, default 50). |
| `tamandua.source.path` | Return the local Tamandua source checkout path. No parameters. |
| `tamandua.skill.path` | Return the path to the bundled tamandua-agents agent skill. No parameters. |
| `tamandua.update.command` | Return local CLI guidance for updating Tamandua safely. No parameters. |

#### AutoResearch

| Tool | Description |
|------|-------------|
| `tamandua.autoresearch.init` | Create project-local AutoResearch state. Requires `cwd`, `goal`, `metricName`, `direction`, and `command`. Optional `metricUnit`, `metricRegex`, `checksCommand`, and `overwrite`. |
| `tamandua.autoresearch.run_experiment` | Run the configured experiment command in `cwd`, parse the metric, run optional checks, and append a `run_result`. Optional `command`, `metricRegex`, `checksCommand`, and `timeoutMs`. |
| `tamandua.autoresearch.log_experiment` | Append the decision and learning for the latest run. Requires `cwd` and `description`; optional `status`, `metric`, `hypothesis`, `learned`, `nextFocus`, `commit`, and `revertDiscard`. |
| `tamandua.autoresearch.status` | Summarize baseline, best result, failures, and the next ratchet prompt for `cwd`. |

#### `tamandua.run.start` Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `workflowId` | Yes | Workflow id to run. |
| `taskTitle` | Yes | Task description for the workflow run. |
| `workingDirectoryForHarness` | For direct workflows | Harness working directory for remote MCP runs. Required for direct workflows, invalid for worktree workflows. |
| `worktreeOriginRepository` | For worktree workflows | Repository path to create the worktree from. Required for worktree workflows, invalid for direct workflows. |
| `worktreeOriginRef` | No | Git ref (branch, tag, SHA) for the worktree. Optional. Only valid for worktree workflows. |
| `noHurrySaveTokensMode` | No | When `true`, reduces polling frequency to save tokens (15-min floor, 15-min default instead of 1-min floor, 5-min default). Optional, defaults to `false`. |

`workingDirectoryForHarness` and `worktreeOriginRepository` are **mutually exclusive**: direct workflows require the former, worktree workflows require the latter. Supplying the wrong one or both results in an invalid-params error.

---

## Requirements

- Node.js >= 22
- [pi](https://github.com/mariozechner/pi-coding-agent) installed on the host
  - Tamandua uses pi for AI agent execution. Agents run via `pi --print` in non-interactive mode.
- `gh` CLI for PR creation steps

---

## License

[MIT](LICENSE)

---

## Origins

Tamandua began as a fork of [antfarm](https://github.com/snarktank/antfarm) and pursues the same goal — orchestrating teams of AI agents through deterministic, repeatable workflows — but is built on top of [pi](https://github.com/mariozechner/pi-coding-agent) instead of OpenClaw. Credit to the original authors for the design and inspiration.

---

Built with Tamanduás in mind.
