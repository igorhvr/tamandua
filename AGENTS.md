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
│   │   ├── harness-adapter.ts    # Pi/Hermes/dsh adapter dispatch (findBinary/runRound)
│   │   ├── harness-launch.ts     # Shared per-execution launch: fresh native signal domain + fallback
│   │   ├── native-signal-backend.ts  # Native signal-isolation backend probe + launcher argv (pure)
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
├── native/                       # Native signal-isolation assets (landlock-helper.c, seatbelt-signal.sb)
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

### Service identity sockets (DPID)

Each long-lived service advertises its identity over a state-dir Unix socket —
`daemon.sock`, `dashboard.sock`, `mcp.sock` (see `src/server/daemon-identity.ts`,
`getServiceSocketPath`/`bindIdentitySocket`/`probeIdentitySocket`). The socket is
the authoritative liveness primitive on every platform (no lsof/pidfile parsing
needed on macOS); the pidfile is only an informational hint. The standalone
`dashboard-standalone.ts` / `mcp-standalone.ts` servers bind their socket
before writing any pidfile (bind-first, so a losing bind race leaves no trace),
and `startDashboardStandalone` / `startMcp` adopt a live socket instead of
spawning a duplicate. An identity whose `stateDir` differs from the effective
one is never adopted. `stop*Takeover` resolves socket-first, then the verified
port holder, then the pidfile, and unlinks the socket only after the owner pid
is gone.

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
5. Work rounds run pi in JSON mode (`--mode json`) so scheduler logic can extract `message_end.message.usage` token metadata and attribute increments to `runs.tokens_spent` using run IDs parsed from tool outputs (falling back to the dispatch job's own runId). pi reports usage PER API CALL, so the parser SUMS usage across every assistant `message_end` of the round (never just the last one) under ONE shared harness policy — `input + output + cache_write`, cache_read EXCLUDED (matching hermes and dsh; definition in `src/installer/token-usage-policy.ts`). The per-call field aliasing and the fallback to `totalTokens` when a usage object has no component fields also live in that module (`extractPerCallTokenTotal`), so the parser and the real-canary session-store reconciliation use the SAME extraction and cannot drift. The dsh harness has no stdout usage, so its rounds are accounted from the session store instead (`src/installer/dsh-usage.ts`): dsh >= 0.1.5 writes `$DSH_HOME/sessions/<escaped-cwd>/session-<uuid>/session.v3.jsonl.zstd` (a concatenated zstd frame container — every frame is decoded), and the reader counts each request ONCE from the TOP-LEVEL `data.usage` of v3 records as `inputTokens + outputTokens` (dsh `inputTokens` is already uncached; `cacheReadTokens` is EXCLUDED, matching the shared policy, and `reasoningTokens` is already inside `outputTokens`). Session directories holding only an older layout (`session.jsonl.zstd` from 0.1.0 or `session.v2.jsonl.zstd` from 0.1.3) are unsupported: the reader logs ONE warning naming the found file and the required `dsh >= 0.1.5` and returns null — never a fabricated 0 — so the remedy is `upgrade dsh`.
6. Successful token attribution emits a `run.tokens.updated` event (`tokenDelta` + `tokensSpent` fields); terminal run lifecycle events (`run.completed`/`run.failed`) also carry `tokensSpent`, but that figure is the total **as of completion** and is a snapshot — the harness's final `message_end` usage lands after the `step complete` tool call, so the terminal event can under-report the final round.
7. The final-round gap is closed by a `run.tokens.final` event (DB-TOKENS F3) emitted once per `completed`/`failed` run from scheduler teardown, after the last in-flight round's attribution settles or when the teardown grace expires with no usage. It carries `runId`, `workflowId`, `tokensSpent` (the `runs.tokens_spent` row read at emit time) and, only when usage landed, the last settled round's `tokenDelta` (omitted, never fabricated, otherwise). It is emitted after the terminal event and never delays or reorders it. `run.tokens.final` is the authoritative closing figure; readers that display a run's spend use the `runs` row or the latest `run.tokens.*` event, never the terminal event's snapshot. Canceled runs get no `run.tokens.final` — settle-before-terminal already makes `run.canceled` authoritative.
8. `tamandua_stats.system_tokens_spent` is a legacy ledger kept as a

   tripwire: nothing writes to it anymore; tests assert it stays 0.

**Claim ownership (CPID2).** `steps.claim_pid` records the HARNESS WORKER
pid, never the scheduling daemon's pid. The scheduler exports the daemon pid
as `TAMANDUA_DAEMON_PID` (used by the daemonctl self-stop guard) and the
harness launch wrapper exports its own `$$` as `TAMANDUA_WORKER_PID`
(pid === pgid for the detached group leader); `step claim` records the latter
as `claim_pid` and the resolved harness group as `claim_pgid`, falling back to
the resolved pgid when `TAMANDUA_WORKER_PID` is absent. `claim_job_id` is the
dispatch round id. dead-owner detection (`recoverStepsWithDeadWorkers`, C18)
and `step.respawned.priorPid` therefore refer to real harness processes. This
was a semantics change only — no new column, no `SCHEMA_VERSION` bump.

### Control plane / run registration (busy harness workdir refuse/queue/allow)

The daemon control plane (`src/server/control-server.ts`) admits at most one
**direct (non-worktree) run** per harness working directory. Admission runs
through `admitOrQueueRun()`, reached from the synchronous `POST
/control/register-run` path and from the reconciler's periodic pass. The
collision policy is resolved by `resolveWorkdirCollisionPolicy()` from the pure
US-001 module `src/installer/workdir-collision.ts`: the run's persisted context
key `workdir_collision_policy` (`refuse` | `queue` | `allow`) wins; when it is
absent/invalid, `TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR=1` means `allow`;
otherwise the default is `refuse`.

A second direct run pointed at a directory that a live scheduled run already
holds is **refused by default**. `_runIdForScheduledHarnessWorkdir()` (realpath
comparison against the daemon's in-memory job metadata) names the holder, and
`admitOrQueueRun()` returns HTTP **409**
`{ state: 'refused', error, message, heldByRunId, holder: { runId, runNumber,
workflowId, status, since }, workingDirectoryForHarness }`, sets
`scheduling_status = 'error'` plus `scheduling_error = <message>`, and logs WARN
`control-server: register-run workdir collision refused`. The message is built
by `formatWorkdirRefusalMessage()` from the shared constants; it is quoted here
verbatim:

```
Cannot start run: harness working directory {dir} is already held by run #{runNumber} ({workflowId}, status {status}, since {since}).
Retry later once the holder finishes, or:
  --queue-behind-holder  queue this run and admit it when the holder releases the directory
  --allow-multiple-runs-in-one-working-directory  run concurrently now; concurrent git writes in one checkout are your responsibility
  TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR=1  environment form of the allow flag
Worktree workflow variants (-worktree) never collide: each run gets its own worktree.
```

The CLI surfaces the refusal as a typed, non-throwing
`RunWorkflowResult.workdirRefused` (the run row ends `status='failed'`,
`scheduling_status='error'`) and exits with the distinct exit code 75 —
different from 1 (general failure) and 2 (wait timeout). Resume
(`resumeWorkflow`) and replacement/rugpull runs (`relaunchRunAfterRugpull`)
apply the **same** rule: a resumed or replacement run that would collide is
refused with the same message unless a queue/allow flag is given.

`--queue-behind-holder` selects the `queue` policy and keeps the existing
`waiting` machinery. `admitOrQueueRun()` keeps `runs.status = 'running'` while
setting:

- `scheduling_status = 'waiting'`
- `scheduling_error = 'waiting for harness workdir held by run <holderId>: <dir>'`
- `scheduling_requested_at = COALESCE(scheduling_requested_at, <now ISO>)`

and returns HTTP **202** `{ state: 'waiting', heldByRunId, workingDirectoryForHarness }`.
Release and admission are unchanged: `reconcileOnce()` re-selects
`scheduling_status IN ('pending_register', 'active', 'error', 'waiting')` on
each 30s tick, and `admitQueuedRuns()` (run on terminate) selects
`scheduling_status IN ('queued', 'waiting')`. Once the holder's scheduled jobs
are gone, admission sets `scheduling_status = 'active'`, clears
`scheduling_error`, and the run dispatches normally.

`--allow-multiple-runs-in-one-working-directory` /
`TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR=1` selects the `allow` policy: the
collision is admitted now, the response adds `sharedWorkdir: true` when a
collision was actually admitted, and exactly one uniform WARN
(`control-server: register-run shared harness workdir allowed`) is logged per
(run, holder). That warning is the same single line for every workflow, merge or
not. Queue logging is unchanged: WARN
`control-server: register-run waiting for harness workdir` (first refusal, then
at most once per 60s, `TAMANDUA_WORKDIR_WAIT_WARN_INTERVAL_MS` override) while
the wait persists, and INFO
`control-server: register-run admitted after workdir wait`.

Operator surfaces: a refused `workflow run` prints the message to stderr and
exits 75; a queued run exits **0** and prints `Queued behind run <holder>:
harness workdir <dir> is held by that run. It will be admitted automatically
when the holder releases it.` (`--wait` still waits); `tamandua status` run
summaries append `  WAITING: waiting for harness workdir held by run <id>:
<dir>` and `workflow status` prints `Scheduling: <reason>` (also in `--json`),
so a waiting run is distinguishable from a dead one.

`TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR=1` still bypasses the queue and admits
immediately; the one-live-run-per-workdir rule itself is **not** lifted.
**Post-grace process sweep (DSWP).** The terminal-run sweep
(`sweepRunProcesses` in `src/installer/run-cleanup.ts`) kills a surviving
process only when it has EXCLUSIVE proof the process was spawned by THIS
daemon instance for THIS run (bead tamandua-6sy.77). There are exactly two
such channels:

- the run's recorded process-group ids (`options.pgids`, captured by this
  daemon at spawn time; evidence `pgid owned by run: <pgid>`), and
- a marker the daemon itself injected into the child environment: an exact
  `TAMANDUA_RUN_ID=<runId>` token AND an exact
  `TAMANDUA_DAEMON_INSTANCE=<daemonInstance>` token (evidence
  `daemon-scoped run marker: run=<runId>`). The opaque token
  (`computeDaemonInstanceToken` in `src/installer/sweep-ownership.ts`) is the
  sha256 of the daemon's effective state dir plus its kernel process-start
  identity (pid + start epoch), so it is stable for one daemon and different
  for every other instance — including a test daemon started from inside a
  harness round that inherited the same `TAMANDUA_RUN_ID`.

`matchRunEvidence` is the ONLY kill matcher. `matchDiagnosticRunEvidence`
keeps the broad cwd / environ-path / `TAMANDUA_WORKER_JOB_ID` / cmdline
channels for `tamandua doctor` and `processBelongsToRun`, which are
REPORT-ONLY and never kill. cwd under the recorded working directory (and
environ path mentions, `TAMANDUA_WORKER_JOB_ID`, cmdline naming the run
id/path) is NEVER sufficient kill evidence: those channels are inherited or
incidental, and "cwd under the working directory" once reaped 14 processes
belonging to an enclosing run — the dsh harness round running the test suite,
the test runner's ancestors, and rounds of a sibling run. cwd is NEVER
consulted, not even to NARROW a match: whenever the marker channel is enabled
and the bulk snapshot could not read environ (macOS `lsof`-only snapshot), the
daemon-scoped marker environ is resolved through the platform-neutral reader
(`readProcEnviron` → `src/lib/proc-info.ts` `getEnvironText`/`environHasEntry`;
KERN_PROCARGS2 on darwin) for EVERY candidate, so the channel works regardless
of cwd and for direct-mode runs. The recorded path is optional
(`string | null`); it is irrelevant to the marker channel, so a direct-mode run
without a worktree is still sweepable via the pgid and marker channels.
Processes are killed by pid only
after evidence matches — never by name or glob — and every reaped pid is
logged with its evidence string; the `run.process_cleanup` event detail
carries the (nullable) path, the swept `pgids`, and the sweeping
`daemonInstance`.

Marker hygiene keeps an outer round's markers out of a nested daemon.
`buildHarnessChildEnv` (`src/installer/agent-scheduler.ts`) FRESHLY writes
`TAMANDUA_RUN_ID` and `TAMANDUA_WORKER_JOB_ID` for every round, stamps
`TAMANDUA_DAEMON_INSTANCE` from `getDaemonInstanceToken()` (omitted, never
fabricated, when unavailable), and sets `TAMANDUA_WORKER_PID: undefined` so an
inherited outer worker pid is dropped. `cleanChildEnv` in
`tests/helpers/test-env.ts` allowlists the child environment, so a test daemon
never inherits an outer run's `TAMANDUA_RUN_ID` / `TAMANDUA_WORKER_JOB_ID` /
`TAMANDUA_DAEMON_INSTANCE` either. Test daemons are stopped by exact pid in
teardown: the runtime `tests/helpers/daemon-survivor-guard.ts` and the static
`tests/test-daemon-teardown-guard.test.ts` both fail a file whose spawned
daemon outlives its test.

A worktree is NOT required (DSWP part 2). `removeRunCrons` captures the run's
`workingDirectoryForHarness` and in-flight harness child pgids before wiping
`jobMetadata`/`inFlightChildren`, then schedules `runPostGraceSweep` (exported
for tests) with that target. The sweep directory resolves captured working dir
→ `getRunWorktree(runId)?.worktreePath` → `working_directory_for_harness`/`repo`
from `runs.context`; owned pgids are the captured set plus every distinct
non-null `steps.claim_pgid` for the run. If neither resolves, the sweep still
runs with a null path (marker channel). This is why direct-mode runs (no
`run_worktrees` row) are now swept too — the old "Sweep timer: no worktree
found" early return is gone.

**Worktree-mode runs are untouched.** `-worktree` variants never collide: each
run registers its own per-run worktree, so the one-direct-run-per-workdir rule
does not apply to them. Every other register-run failure remains fatal:
missing/relative/nonexistent harness workdir, branch mismatch, unsupported
harness, and malformed input still throw, are marked `scheduling_status =
'error'`, and return **422** — they never enter `waiting`.
**Round-outcome classification (PRAW).** Each dispatch round's *assistant*
text is classified by `classifyWorkRoundOutcome` (via
`parseWorkRoundMetadata` → `summarizeWorkRoundOutput`), and there is **no
raw-transcript fallback**:

- A JSON round (`pi --mode json`, hermes, dsh) with no assistant text yields
  `assistantOutput: ""` and outcome `empty_output` — the raw JSONL transcript
  is NEVER used as the round's output. A `tool_execution` result that echoes
  the task instructions, a cat'ed file, or the agent's own
  `tamandua step complete --output` text must not masquerade as the agent's
  report (the run-49 defect). Identifier hints (run/step ids) are still
  harvested from tool data and token usage is still summed, so token
  attribution and cross-run hijack detection are unaffected.
- `STATUS: done` / `STATUS: fail|failed|error` and `NO_WORK_AVAILABLE` are
  recognized ONLY at the start of a line of the assistant's own final text
  (the `^` anchor applied with the multiline flag, leading whitespace allowed)
  — never embedded mid-line and never inside a `tool_execution` payload.
  Text-mode (non-JSON) rounds keep their existing behavior: their normalized
  text is the round output.
- Outcome routing: `work_done` → `autoCompleteStepIfRunning`; `other_output`
  / `empty_output` → `recoverOrphanedStepsForAgent`; `no_work` → benign no-op.

**Paused auto-completion (PRAW).** Scheduler output-derived auto-completion
(`autoCompleteStepIfRunning` → `completeStep(..., { rejectPausedRun: true })`)
refuses a run whose `status` is `paused` OR whose `scheduling_status` is
`draining_pause`, exactly as it already refuses `failed`/`canceled`, and logs
at INFO with the runId/stepId and run/scheduling status. The guard is opt-in:
the agent-issued CLI `tamandua step complete` path passes no such option, so a
pause drain still lets in-flight agent work finish and report normally.

**Paused recovery (PKIL).** A non-drain `run pause` kills the worker, but a
pause is not a worker loss. `recoverOrphanedStepsForAgent` takes an
`abandonReason`; `"paused_by_operator"` is a distinct recovery class that
resets the running step (or loop step + its current story) to `pending`
WITHOUT consuming any retry/abandon budget, leaves `runs.worker_lost_count`
and `runs.ceiling_expiry_count` untouched, and emits `step.paused_kill`
(carrying `exitCode`/`signal`/`stderrTail` forensics) rather than
`step.worker_lost`; the `step.respawned` that follows carries
`reason: "paused_by_operator"` and the unchanged retry value. The paused
branch never runs the retry-exhaustion / `on_fail.retry_step` reroute logic,
so a step already at `max_retries` still resets to pending and the run stays
alive. US-005 wires the non-drain pause path to this class:
`removeRunCrons(runId, { pausedByOperator: true })` — passed only by the
non-drain `run pause` path — marks each in-flight dispatch round in a
module-level registry before aborting/SIGTERMing it; `executeDispatchRound`
reads and clears its own mark once the round settles and routes both recovery
paths (clean-exit/empty-output and adapter-throw/SIGTERM) through
`abandonReason: 'paused_by_operator'`. Draining pause, terminate, cancel, and
natural completion pass no flag, so their worker_lost semantics are unchanged.

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

### Bounded process introspection (`lsof`)

`lsof` walks kernel process/file tables and can block **forever** inside the
kernel on a host with a stale FUSE or network mount (a 2026 incident left 24
`lsof` processes wedged for five days). Every `lsof` invocation must be
bounded:

- Product code goes through `src/lib/lsof-probe.ts` `runLsof(args)`: it always
  prepends `-b` (no blocking kernel calls) and `-w` (suppress warnings) and
  runs under a hard `spawnSync(..., { timeout, killSignal: "SIGKILL" })`
  (default 5 s, `TAMANDUA_LSOF_TIMEOUT_MS`). A timed-out probe returns
  `kind: "timeout"` — never an empty `ok` — and callers must treat anything
  but `ok` as unknown and **fail closed** (e.g. `processHasOpenFileUnder`
  returns `"unknown"`, `daemonctl` refuses to signal).
- Any remaining direct Node call site (test helpers, the torture-test Node
  tools) must pass `-b -w`, a finite `timeout` and `killSignal: "SIGKILL"`.
  `tests/lsof-bounded-lint.test.ts` scans `src/`, `tests/` and
  `torture-test/bin` and fails otherwise.
- POSIX shell call sites (torture `bin/daemon-control`, `tt-recorder`) use a
  portable background+poll+`kill -KILL`+`wait` wrapper (macOS has no GNU
  `timeout`), never a bare `lsof`. `bin/daemon-control` defines
  `lsof_bounded` (bound `TT_LSOF_TIMEOUT_S`, default 5, integer-validated):
  it backgrounds `lsof -b -w <args>` with stdout in a temp file, SIGKILLs
  and `wait`s on expiry, and returns NO evidence (fail-closed) on
  timeout/unavailable so a wedged probe can never be read as "no open
  file"/"no listener". All three of its lsof sites (the Darwin cwd
  ownership evidence and both port-listener pid extractions) go through it;
  `tt-recorder` carries the same pattern for its `-iTCP -sTCP:LISTEN` arm.
- Structural self-test gotcha (`torture-test/bin/daemon-control.test.sh`):
  its `cmd_start`/`cmd_stop` assertions are written as
  `grep -A 300 '^cmd_stop()' "$TOOL" | grep -q PATTERN`. Under
  `set -o pipefail`, once the extracted body window exceeds macOS's 16 KiB
  pipe buffer and the downstream `grep -q` exits on its first match, the
  upstream grep is killed by SIGPIPE (rc=141) and every such assertion
  flips to failure even though the pattern matched. Keep new comment/body
  bytes out of the first 301 lines of `cmd_stop` (put the rationale in the
  doc block BEFORE the function) and prefer a capture-then-grep helper for
  new assertions on bodies larger than the pipe buffer.

### Merge-branch run identity (TATR)

`tamandua merge-branch` (src/cli/commands/merge-branch.ts →
`runPlumbingMerge` in src/installer/merge-branch.ts) attributes every
`merge.landed` / `merge.target_moved` / `merge.conflicts` event to a run
id resolved as `params.runId ?? process.env.TAMANDUA_RUN_ID ?? ''`:

- The scheduler sets `TAMANDUA_RUN_ID` in every worker round's harness
  env (src/installer/agent-scheduler.ts), so any `merge-branch`
  invocation inside a run is run-attributed automatically; the
  `finalize_merge` step context also threads `--run-id` explicitly.
- Run-scoped events land in `events/<runId>.jsonl` AND `events/all.jsonl`;
  a genuinely runless manual merge (no `--run-id`, no env) emits
  `runId: ""` and lands only in `events/.jsonl` (the empty-id stream).
- The target-advancing `git update-ref` carries `-m` with a structured
  reflog message (`tamandua: merge.landed run=<id> tree=<oid>`, or
  `(manual)` for runless merges) — see `targetAdvanceReflogMessage`.
- Gotcha for scripted e2e (`e2e-tests/workflows-scripted.test.ts`):
  merge-branch commands run inside a worker round now inherit
  `TAMANDUA_RUN_ID`, so landings that previously were runless (e.g. a
  contention-marker advance simulating an external actor) are
  run-attributed and appear in `events/<runId>.jsonl` — index-based
  merge-event assertions must account for them.

### Shared merge pure core (US-005)

The atomic squash-merge algorithm lives in the dependency-free
`src/installer/matchlock/merge-core.ts` (`runMergeCore`): Node-core imports
only, with the git runner, the event emitter and the clock injected.
`runPlumbingMerge` in `src/installer/merge-branch.ts` is a thin native
delegate that resolves the run id (`params.runId ?? TAMANDUA_RUN_ID ?? ''`)
and supplies the real host runner + `emitEvent`. The module is placed under
`installer/matchlock/` on purpose: `guest-pack-builder.ts` walks its closure
from explicit roots (`WALK_ROOTS`) and refuses any module resolving outside
`dist/installer/matchlock`, so this is the only location a host/guest shared
core can live. The guest pack ships it (Node-core only) even before a guest
entry imports it. Mechanical parity coverage is
`src/installer/matchlock/merge-core.test.ts` (serial lane).

### Finalizer ledger seam (US-006)

`evaluateFinalizeMergeLedgerGate(stepId, source?)` in
`src/installer/ledger-gate.ts` and BOTH `finalize_merge` decision sites in
`src/installer/step-ops.ts` (the claim gate in `enforceClaimLedgerGate` and the
`completeStep` acceptance gate) accept an optional host-attested
`FinalizeMergeEvidenceSource`. With no source the gate queries native
`suite_results` exactly as before — decisions, events and refusal text are
byte-identical. With a source the decision comes ONLY from
`source.queryMergeEvidence` (exit 0 => green, other => red, no row => missing);
the native ledger is never a fallback, and `formatLedgerGateRefusal` uses the
source's `nearestEvidence` for diagnostics. The source is constructed ONLY by
`pi-invocation-runner` (`createHostSuiteLedgerEvidenceSource`, over the same
`HostSuiteStore` + canonical `GuestSuiteNamespace` the suite bridge serves) and
threaded through `NativeStepServices` via `StepProgressOptions`/
`StepMutationOptions.ledgerEvidenceSource`. No run context, guest input or env
var can activate it. Coverage: `src/installer/ledger-gate-matchlock-seam.test.ts`
and `src/installer/matchlock/finalizer-ledger-seam.test.ts` (both serial lane);
see also `HostSuiteStore.nearestMergeEvidence`.

### Scoped guest merge-branch + host merge authorization (US-007)

The merger role of an opted-in merge workflow lands through the scoped bridge,
never through host Git execution of guest-controlled config. Two wire ops
(`merge.authorize` / `merge.report`, `BRIDGE_OPS` in
`src/installer/matchlock/guest-protocol.ts`, validated canonically by
`validateMergeBridgeParams` at BOTH the guest-service and broker boundaries)
carry the exact named options (`--origin --branch --into --expect-tip
--message [--run-id]`, multiline/Unicode safe).

Flow: the guest CLI (`src/installer/matchlock/guest-cli.ts` `merge-branch`)
asks `merge.authorize`; the broker threads the fresh authoritative claim into
an optional `HostMergeServices` (`src/installer/matchlock/host-merge-services.ts`;
production `createHostMergeService` in `host-merge-service.ts`) which refuses
with a TYPED `MERGE_*` code BEFORE any Git when the role is not `merger`, the
claim is missing/stale/foreign or not the run's `finalize_merge` step, the
origin is outside the admitted original root, `--into` is not the run's
original branch, the run id mismatches the binding, or `--expect-tip` differs
from the authoritative target tip. Only then does the guest run the shared
`runMergeCore` (US-005) with GUEST git against the RW-mounted original and
report the outcome; the host independently verifies the authoritative target
tip and emits the run-attributed `merge.landed`/`merge.target_moved`/
`merge.conflicts` event (a mismatched/fabricated receipt refuses `MERGE_VERIFY`,
never a fabricated landing). Reports are idempotent by `opKey` (exact ack
replay) and bound to the live invocation + claim; cancel/close revoke.

Executable-Git boundary: all hook/signing/helper-bearing plumbing
(commit-tree/update-ref/read-tree/symbolic-ref/worktree/merge-tree) runs in the
guest via `guestMergeGitRunner` (spawnSync argv, no shell). The ONLY host Git is
the injected narrow `readTargetTip` — a fixed `rev-parse --verify <ref>^{commit}`
plumbing read with `-C <admitted origin>` (no shell, no guest argv, no
hooks/signing/credential helpers, no worktree-metadata path). Production
runner/scheduler wiring (run context + `finalize_merge` step identity) is
US-008; the broker accepts the optional service today. Coverage:
`src/installer/matchlock/host-merge-service.test.ts` + the US-007 block in
`broker.test.ts` (refusal matrix, recording-only zero-mutation) and
`guest-bridge.test.ts` (real-fixture landed/noop/conflicts/target_moved/
dirty-owner parking with MERGED_TREE parity, multiline/Unicode message).

Harness parity (MTLK-ALL-WORKFLOWS US-001/US-002): the already-built
`HostMergeServices` is forwarded into `createHostBroker` by the pi runner
(`RunMatchlockInvocationOptions.merge`) and by the hermes runner
(`RunHermesInvocationOptions.merge`); `runProductionHermesRound` converts a
supplied `round.merge` with `createMergeServiceForContext` exactly like the pi
path. The dsh scheduler route is the third seam: `DshSchedulerRound.merge`
carries the host-attested `HostMergeContext`, `toDshSchedulerRound` forwards it,
and `runProductionDshRound` converts it with `createMergeServiceForContext` and
passes it to `runDshInvocation` (whose opts spread forwards it into
`createHostBroker`); it also now mirrors the pi exact-path preflight
(`matchlockRoundScopeRefusal`) and the merge-capability preflight. The broker
keeps every merge op UNSUPPORTED when no service is wired (never a host
fallback), and a merge-capability work round with no host merge context is
refused by BOTH `runProductionMatchlockRound` and `runProductionDshRound`
BEFORE any VM.

### Capability admission + exact linked-worktree wiring (US-008)

`src/installer/matchlock/capabilities.ts` is the declarative capability
closure: `MATCHLOCK_WORKFLOW_CAPABILITIES` maps each ADMITTED workflow id to
the later-role tools it needs (`guest-git`, `guest-test-suite`,
`merge-branch`, `run-queries`), and `MATCHLOCK_AVAILABLE_CAPABILITIES` is what
the integrated backend provides. `matchlockDispatchDecision` (dispatch-guard.ts)
admits a valid pinned policy only when the workflow id is admitted AND its
declared closure is a subset of `ctx.availableCapabilities` (defaults to the
full set); anything else refuses `matchlock_workflow_unsupported` BEFORE any
probe/findBinary/spawn/VM.

Explicit per-shape catalog (MTLK-ALL-WORKFLOWS US-004): there is no blanket
allow-list. Every bundled id under `workflows/` is either in
`MATCHLOCK_WORKFLOW_CAPABILITIES` with an explicit closure or in
`MATCHLOCK_REFUSED_WORKFLOWS`, which pins a precise
`MatchlockWorkflowRefusalCode` + reason (`guest-github-cli` for `*-github-pr`,
`child-workflow-dispatch` for `just-do-it`, `browser-visual-verification` for
`frontend-test`, `unscoped-host-filesystem` for `skills-normalize-audit`).
Admitted non-merge story/worktree shapes (`feature-dev[-worktree]`,
`bug-fix[-worktree]`, `quarantine-broken-tests`, `security-audit[-worktree]`)
declare `guest-git + guest-test-suite + run-queries`; every `*-merge` route
adds `merge-branch`. `MATCHLOCK_BUNDLED_WORKFLOW_IDS` is the admitted ∪ refused
set, and the dispatch-guard matrix test enumerates the real `workflows/`
directory to prove no bundled id falls through to the generic message (which
now applies ONLY to genuinely unknown/custom ids).

Harness parity (MTLK-ALL-WORKFLOWS US-003): there is NO harness-by-workflow
allow-list. `MATCHLOCK_HARNESS_WORKFLOW_IDS` is deleted and
`matchlockHarnessSupportsWorkflow` delegates to the global admitted set, so a
valid pinned policy is admitted on workflow + capability closure for `pi`,
`hermes` and `dsh` alike. The only remaining harness check is policy-vs-context
consistency: a context harness that differs from the pinned policy harness
refuses `matchlock_workflow_unsupported` BEFORE any probe/findBinary/spawn/VM.
The generic unknown-workflow refusal message names "the admitted workflows".

Exact worktree scope: run creation (`admission.ts` `planFreshScope`) resolves a
managed linked worktree via `repository-scope.ts` to the worktree cwd, the
ENTIRE original/main checkout and any EXTERNAL git/common dirs
(separate-git-dir). `mount-plan.ts` mounts the cwd, original root and external
git metadata RW at their identical absolute host/guest paths; `.git`
file/`commondir`/`gitdir` resolution follows the real git layout and a symlink
spelling is refused (no clone, readonly origin, import, symlink-only cwd or
metadata rewrite).

Scheduler/runner: `agent-scheduler.ts` captures the run context, resolves the
run's own `finalize_merge` step row id, and builds a `HostMergeContext`
(`scheduler-matchlock.ts` `buildMatchlockMergeContext`) for workflows that
require `merge-branch`. `runProductionMatchlockRound` enforces the exact-path
invariant (`matchlockRoundScopeRefusal`: cwd === policy.workingDirectory, a
work mount or original root at that exact path, identical host/guest spelling),
refuses a merge-capability round with no merge context BEFORE any VM, and
builds the production merge service in `merge-invocation-wiring.ts`
(`createMergeServiceForContext` → `createHostMergeService` + the narrow
`readAuthoritativeTargetTip`) which the runner forwards to the broker. The
runner deliberately keeps NO direct `node:child_process` import (the wiring
module owns it) so serial test classification is unaffected. Coverage:
`dispatch-guard.test.ts` (admit/refuse + capability matrix), `admission.test.ts`
(real linked-worktree / separate-git-dir exact paths + refusals),
`agent-scheduler-matchlock.test.ts` (merge context, scope invariant, target-tip
read, production merge service authorize, refusals before any probe/VM).

### Event log atomic appends (EVTA)

Every event is written by `appendEventLine(filePath, line)` in
`src/installer/events.ts`: the line is serialized to ONE Buffer ending in
`'\n'` and appended with ONE `fs.writeSync` on an `O_APPEND` descriptor
(`fs.openSync(filePath, "a")`); only a short write retries the remainder
(each retry still appends at EOF). Never append an event with
`fs.appendFileSync` — a multi-write append can be interleaved by another
writer, which is exactly how the vaivm `step.worker_lost` line ended up
truncated at column 1333 with the next event concatenated onto it (beads
`tamandua-6sy.64`).

Writer contract:

- **Run-scoped files (`events/<runId>.jsonl`) have exactly ONE writer
  process** — the process that owns the run. They need no cross-process lock;
  only the in-process per-file queue (below) serializes reentrant appends.
- **`events/all.jsonl` is shared by every event-emitting process** and is
  therefore guarded by a per-file advisory lock: exclusive-create
  `all.jsonl.lock` (`fs.openSync(lockPath, "wx")`) with bounded retry
  (`TAMANDUA_EVENT_LOCK_TIMEOUT_MS`, default 5000, clamped 1..60000) and
  stale-lock takeover after `EVENT_LOCK_STALE_MS` (30 s, mtime-based). The
  lock covers the append AND the rotation check and is released in `finally`.
  If the lock cannot be acquired the global append is SKIPPED (the run-scoped
  line is still durable) and a warning is logged — fail-closed for
  integrity. The lock file is intentionally empty; existence + mtime are the
  whole protocol.
- The per-file in-process queue (`withEventFileQueue`) drains reentrant
  appends FIFO before the active writer returns. Because Node runs JS on one
  thread, a synchronous append cannot be preempted mid-call, so the queue’s
  only job is to make reentrancy and future async callers safe.
- `rotateGlobalEventsFile` behaviour is unchanged (archive shifting,
  `.1`/`.2`/`.3`, generation counter) and runs inside the lock.

Reader contract (EVTA US-009): every reader classifies raw JSONL through the
pure exported `parseJsonlEventBuffer(buf, baseOffset)` — complete
newline-terminated lines that parse to a JSON object are events; complete
lines that fail `JSON.parse` or are not objects are `corrupt` entries (with an
absolute byte offset, length and bounded preview); the final unterminated
segment is `trailingPartial` (never corrupt, never returned), and empty /
CR-only lines are skipped silently.

- `readEventsFromCursor` reports every interior corrupt line through
  `logger.warn("Corrupt event line", { file, offset, length })` and keeps
  `nextOffset` at the start of a `trailingPartial` line so a torn write is
  re-read once the writer completes it.
- `getRunEvents` (both the full path and the `tailRunEvents` window),
  `getRecentEvents` use the same parser; `getRecentEvents` additionally skips
  the pre-window partial (its read window starts mid-line) without reporting
  it. Reporting never throws and never drops a valid line, so the existing
  “malformed lines are skipped from the result” tests stay green.

Cross-process writer integrity is covered by
`tests/events-multiwriter.test.ts` (registered in `tests/serial-files.txt`):
two processes emit > 4 KiB lines into `all.jsonl` concurrently and every
line must parse. Single-write / O_APPEND / short-write / lock behaviour and
the torn-last-line / corrupt-line reporting behaviour are covered in
`src/installer/events.test.ts`.

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

### Real-VM whole-path merge-workflow gate (US-009/US-010)

The on-demand real-VM gate for the genuine bundled merge workflows lives in
`e2e-tests/matchlock-worktree-merge-gate.test.ts` and is run by
`./run-matchlock-worktree-merge-e2e-test` (NOT part of `npm test` or any fast
lane). It drives an isolated daemon → scheduler → Matchlock runner → fresh VMs
to real workflow completion for `feature-dev-merge-worktree` (worktree) and
`bug-fix-merge-worktree` (worktree) and the capability-equivalent direct route
`bug-fix-merge` (launched from INSIDE the owned origin checkout so run creation
seeds `original_branch`), with the tester/verifier's packed `tamandua-test`
recording real `HostSuiteStore` rows and the guest `merge-branch` performing a
real target advance on a tiny OWNED origin. Each scenario has its own owned
origin, daemon/control port and positive exact-owned cleanup; all share one
imported fixture image and one retained evidence dir.

Shared, corrected exact-owned VM lifecycle helpers live in
`e2e-tests/helpers/matchlock-gate-lifecycle.ts` (strict `readVmInventory`:
corrupt DB throws, absent ≠ empty; `cleanupOwnedVms`: a failed/unknown
`matchlock rm` FAILS and RETAINS state — no `fs.rmSync` fallback; corrupt event
JSON throws). The fast injected-failure controls run under `npm test` via
`tests/matchlock-gate-lifecycle.test.ts` (no real VM) and again inside the gate
before any VM is created.

The test-only synthetic pi harness
(`e2e-tests/matchlock-fixture/synthetic-pi.mjs`) supports the worktree-merge
roles: planner (STORIES_JSON/BRANCH), setup (creates the feature branch and
emits the raw `TEST_CMD`), developer/fixer (commits an owned fixture change),
tester (runs the wrapped `tamandua-test` and emits `TESTED_TREE`), verifier
(emits `TESTED_TREE`; for the bug-fix workflows, which have no tester step, the
verifier itself runs the wrapped `tamandua-test` to record the ledger row),
triager (BRANCH/SEVERITY), investigator,
auditor (HONEST), reviewer (ACCEPT) and merger (scoped guest `merge-branch`).
On its first merger invocation it deterministically exercises the target-moved
loop on OWNED refs: an owned external-actor same-tree advance of the target, a
stale `--expect-tip` merge refusal, an in-worktree rebase, and `STATUS: retry`
so the upstream producer (`test` for feature-dev, `verify` for bug-fix)
re-validates the rebased tree; the second invocation lands for real.
`MERGED_TREE` must equal the last `TESTED_TREE`. Production refuses a moved tip
at `merge.authorize` (typed `MERGE_TIP`, before any Git), so the gate accepts
either a `merge.target_moved` event or the recorded stale-tip refusal + rebase
(`stale-merge rc=` / `rebased onto`) plus the `step.rerouted` event as the real
loop.

The TEST_CMD contract detail that makes the ledger seam green: setup emits a
RAW command (`node test.mjs`), step-ops persists it as `test_cmd_established`
and renders the wrapped `tamandua-test --repo … --run … --step … -- 'node
test.mjs'` to the agent; the guest shim hashes the inner raw argv and records
`committedTreeHash` (`git rev-parse HEAD^{tree}`), which is exactly the
`TESTED_TREE` the tester reports — so `queryMergeEvidence(namespace, originRepo,
testedTree, sha256(rawTestCmd))` finds the row.

### MTLK-UNPIN: the real-VM gates are unpinned

The nine on-demand Matchlock real-VM gate drivers (`run-matchlock-*-e2e-test`
and `run-hermes-synthetic-e2e-test`) do **not** pin a runtime sha256. Each
resolves `matchlock` from `PATH` (or an explicit `TAMANDUA_MATCHLOCK_RPC_BIN`
override) and defaults guest-init to `guest-init` next to that binary or on
`PATH` (`MATCHLOCK_GUEST_INIT` / `MATCHLOCK_GUEST_FUSED` are optional
overrides); an unset guest-init is left for matchlock to resolve itself. Each
driver records the observed `matchlock --version` and the sha256 of every
resolved binary in `<TAMANDUA_GATE_EVIDENCE_DIR>/runtime-observed.txt`, so the
runtime used by a gate run is reproducible from the retained evidence. There is
no doctor check and no pinning (Igor's decision, bead tamandua-6sy.33.10.36).
`tests/matchlock-unpin.test.ts` pins the absence of pins.

### dsh mount plan changes: the contained real-dsh boot gate is REQUIRED

Any change to the dsh Matchlock mount plan — `src/installer/matchlock/mount-plan.ts`,
`src/installer/matchlock/dsh-profile-overlay.ts`, or the controller's composed
`DSH_HOME` mounts — MUST run, in addition to `npm run build` and the touched
unit tests, BOTH the synthetic profile-overlay gate
(`./run-matchlock-dsh-profile-overlay-e2e-test`) AND the contained real-dsh boot
gate (`./run-matchlock-dsh-real-boot-gate-e2e-test`). The real-dsh boot gate
boots the REAL image `dsh` through the production invocation runner and is the
only gate that executes the real `healProfilesModuleFallback` → `withFileLock`
sibling `profiles/node_modules.lock`; the zero-provider synthetic gates cannot
substitute for it (the #31 gate set reported a hollow green for exactly this
reason). Run both under the shared gate lock (`flock --exclusive
/home/kaladin/matchlock-work/vaivm-gate.lock`) with the SYSTEM matchlock (no
pins) and from a fresh login session (`ssh localhost`) whose `NoNewPrivs` is
unset and which carries the `kvm`/`netdev` supplementary groups — the developer
sandbox runs with `NoNewPrivs=1`, so matchlock's file capabilities are ignored
and VM creation fails with `TUNSETIFF: operation not permitted`. The
zero-provider fixture `e2e-tests/dsh-fixture/fake-dsh.mjs` also reproduces
`withFileLock` at the boot-sibling path `<profiles>/node_modules.lock`
(`fs.openSync(lock, "wx", 0o600)`, released in `finally`), so ANY dsh mount plan
MUST leave the guest a writable `profiles/` parent — the lock's parent is
`profiles/` itself, never the mounted `node_modules` destination — or the
synthetic gates fail too. `tests/matchlock-dsh-boot-lock-fixture.test.ts` is the
fast regression pinning the writable/absent/non-writable `profiles/` outcomes
(exit 0 vs the run #32 `ENOENT` shape with exit 8).

Harness-sibling whole-path gates (MTLK-ALL-WORKFLOWS): the SAME genuine
`feature-dev-merge-worktree` scenario is also driven under the dsh
(`e2e-tests/matchlock-dsh-merge-worktree-gate.test.ts` /
`./run-matchlock-dsh-merge-worktree-e2e-test`) and hermes
(`e2e-tests/matchlock-hermes-merge-worktree-gate.test.ts` /
`./run-matchlock-hermes-merge-worktree-e2e-test`) Matchlock routes with the
TEST-ONLY synthetic dsh/hermes fixtures. Both are opt-in
(`REAL_VM_GATE_ENABLED`), run under the shared gate lock, and pin the host-origin
squash landing (`MERGED_TREE == TESTED_TREE`), the host-suite evidence row, the
per-story target_moved → rebase → retest loop, distinct fresh VMs and
exact-owned teardown. The hermes gate additionally reconciles
`runs.tokens_spent` EXACTLY against the Σ projected mapped-store session totals
(input + output + cache_write; cache_read excluded), which proves every
story/verify/retry round recovered its authoritative session (stderr trailer or
the H2 store fallback) with no borrowed session. Fast pure-fs artifact
contracts: `tests/matchlock-dsh-merge-worktree-gate-artifacts.test.ts` and
`tests/matchlock-hermes-merge-worktree-gate-artifacts.test.ts`.

Real-model dsh canary (MTLK-ALL-WORKFLOWS US-010): the synthetic dsh gate is
joined by the REAL-TOKEN, REAL-VM canary
`e2e-tests/matchlock-dsh-merge-worktree-canary.test.ts` /
`./run-matchlock-dsh-merge-worktree-canary-e2e-test`. It drives the genuine
bundled `feature-dev-merge-worktree` through an isolated daemon → scheduler →
dsh Matchlock runner → fresh VMs with the operator image
`igorhvr/bedlam-ubuntu`, `--dsh-as-harness`, and the operator's REAL dsh
credentials staged from `TAMANDUA_GATE_REAL_DSH_HOME` into a fresh gate-owned
`DSH_HOME` (never `sessions/`, never printed). It is opt-in
(`REAL_VM_CANARY_ENABLED = EVIDENCE_DIR && MATCHLOCK_RPC_BIN && REAL_DSH_HOME`),
runs under the shared gate lock, and asserts a real squash landing on a tiny
OWNED origin (`MERGED_TREE` == the origin target tree + a real `merge.landed`),
`runs.tokens_spent > 0` with POSITIVE per-round attribution (every mapped v3
session usage > 0 and the total equal to `runs.tokens_spent` under
input+output / cache_read-excluded, tolerance 0), and an empty positive
owned-VM inventory. Fast pure-fs artifact contract:
`tests/matchlock-dsh-merge-worktree-canary-artifacts.test.ts`. Like every
real-VM gate it cannot boot in the developer agent sandbox (`CapEff: 0` +
`NoNewPrivs: 1` suppress matchlock's file caps → first VM create fails
`TUNSETIFF: operation not permitted`); the operator/tester runs it outside the
sandbox.

Real-model hermes canary (MTLK-ALL-WORKFLOWS US-011): the hermes sibling is
`e2e-tests/matchlock-hermes-merge-worktree-canary.test.ts` /
`./run-matchlock-hermes-merge-worktree-canary-e2e-test`. It drives the same
genuine bundled `feature-dev-merge-worktree` through an isolated daemon →
scheduler → hermes Matchlock runner → fresh VMs with the operator image
`igorhvr/bedlam-ubuntu` and `--hermes-as-harness`, staging the operator's REAL
hermes config/credentials (`TAMANDUA_GATE_REAL_HERMES_HOME`, default
`$HOME/.hermes`) into a fresh gate-owned default `<HOME>/.hermes` (only
`config.yaml` / `auth.json` / `.env` etc. are copied — `state.db*` and
`sessions/` are deliberately NOT, so the mapped token ledger starts EMPTY and
never borrows an operator session; credentials are never printed). It is opt-in
(`REAL_VM_CANARY_ENABLED = EVIDENCE_DIR && MATCHLOCK_RPC_BIN &&
REAL_HERMES_HOME`), runs under the shared gate lock, and asserts a real squash
landing on a tiny OWNED origin (`MERGED_TREE` == the origin target tree + a real
`merge.landed`), `runs.tokens_spent > 0` with POSITIVE per-round attribution
(every mapped `state.db` session row projects a positive total and the run total
equals the Σ rows under input+output+cache_write / cache_read-excluded,
tolerance 0), and an empty positive owned-VM inventory. Fast pure-fs artifact
contract: `tests/matchlock-hermes-merge-worktree-canary-artifacts.test.ts`. Like
every real-VM gate it cannot boot in the developer agent sandbox and is run by
the operator/tester outside it.

### Real-VM DSV2-in-VM dsh gate (MATCHLOCK-UNION-3 US-010)

The on-demand REAL-TOKEN, REAL-VM gate for the in-VM dsh v3 store reader lives
in `e2e-tests/matchlock-dsh-real-gate.test.ts` and is run by
`./run-matchlock-dsh-real-gate-e2e-test` (NOT part of `npm test` or any fast
lane; it boots fresh VMs and spends real model tokens). It drives ONE real
`do-now` through an isolated daemon → scheduler → Matchlock dsh invocation
runner → fresh VMs with `--dsh-as-harness --matchlock igorhvr/bedlam-ubuntu`,
then asserts the run completes, `runs.tokens_spent > 0`, and
`runs.tokens_spent ===` the mapped host v3 store total (input + output,
cache_read excluded, tolerance 0). The store total is read with the PRODUCTION
confined in-VM reader (`dist/installer/matchlock/dsh-session-store.js`
`discoverSessionArtifacts` + `readDshSessionArtifact`) from
`<DSH_HOME>/sessions/<projectKey>/session-<id>/session.v3.jsonl.zstd`
(multi-frame zstd; TOP-LEVEL `data.usage` only, never the `data.stream`
mirror). Every created VM is positively closed and recorded in the ledger.

The gate stages a FRESH gate-owned `DSH_HOME` from the operator's real dsh home
(credentials + `profiles/`, `sessions/` deliberately NOT copied so the
attributed store starts empty) and runs the whole path through the production
short-HOME alias, so no gate-side alias repair is needed.

**Operator image gotcha:** the plain docker tag `igorhvr/bedlam-ubuntu:latest`
is NOT the qualified toolchain image (it has node only). The REAL image that
ships dsh 0.1.5-rc.2, hermes and pi exists ONLY in the operator matchlock
image store (`~/.cache/matchlock/images`, scope `local`). The runner therefore
always seeds the private store from `TAMANDUA_GATE_OPERATOR_CACHE`
(hardlinked content-addressed blobs + copied metadata; the runner defaults it to
`$HOME/.cache/matchlock`) instead of importing the docker tag. Gate E confirmed
the store image digest `sha256:cd83b838…` / config `sha256:cca820df…` and the
probe/work v3 session totals reconciled exactly (probe 6769 + work 5308 =
12077 == `runs.tokens_spent`).

## Real-VM gates cannot run in the developer agent sandbox

The developer agent's command sandbox runs with `NoNewPrivs: 1` and
`CapEff: 0`, so the matchlock binary's file capabilities
(`cap_net_admin,cap_net_raw=ep`) are suppressed. The first VM create therefore
fails with `create VM: create TAP device: TUNSETIFF: operation not permitted`
(and `matchlock rm` with `reconcile nftables rule: netlink receive: operation
not permitted`). This is documented pre-existing host behaviour, not a gate or
product defect — see `docs/matchlock-dsh-qualification.md` §"Why #31's gates
missed the boot-lock failure": the developer sandbox suppresses those caps and
"the operator/tester must run real-VM gates outside that sandbox".

Consequences:
- New real-VM gates should make the VM scenario OPT-IN (skip the real-VM
  `describe` unless the runner-provided environment is present) so a bare
  `node --test` exercises only the fast no-VM controls. See
  `e2e-tests/matchlock-dsh-merge-worktree-gate.test.ts` (`REAL_VM_GATE_ENABLED`)
  and its pure-fs artifact contract
  `tests/matchlock-dsh-merge-worktree-gate-artifacts.test.ts`.
- The developer writes/commits the gate + the no-VM controls and records the
  sandbox `TUNSETIFF`/`nf_tables` EPERM as ENVIRONMENT; the operator/tester runs
  the real-VM gate under `flock --exclusive
  /home/kaladin/matchlock-work/vaivm-gate.lock` outside the sandbox.

### Pi gate family + fast-e2e regression (MTLK-ALL-WORKFLOWS US-012)

`tests/matchlock-pi-gate-fast-e2e-regression.test.ts` is the fast, pure-fs
(parallel-lane) contract for the pi gate family: it pins that the four
real-VM runners (`run-matchlock-worktree-merge-e2e-test`,
`run-matchlock-synthetic-e2e-test`, `run-matchlock-empty-output-e2e-test`,
`run-matchlock-long-home-e2e-test`) stay wired to their gate files, build
first, allocate an `mktemp -d` evidence dir and propagate the exit code; that
every gate file keeps its "NOT part of any default fast lane" header and its
no-VM controls; and that no real-VM gate/runner leaks into
`run-all-e2e-tests` / `run-all-smoke-e2e-tests` / `run-all-scripted-e2e-tests`.
The pi admission parity itself is pinned by `dispatch-guard.test.ts` (incl. the
"pi differential unchanged" case) and `harness-workflow-matrix.test.ts`.

`./run-all-e2e-tests` (smoke + scripted) has one host-environment red that is
NOT a product regression: because `origin/main` is ahead of the branch,
`src/server/daemon.ts`'s startup `runVersionCheck()` writes
`updateAvailable: true` into the run's isolated state dir, so the CLI prints
`WARNING: A new version of tamandua is available! Run: tamandua update` to
stderr for `workflow status`, which breaks
`e2e-tests/workflows-harness-probe.test.ts` test (a)'s
`text.trimEnd().endsWith("STDERR_TAIL:")` assertion. This is the same class
recorded in `MATCHLOCK_OBS_FINDINGS` (`host-origin-advanced-update-warning`) and
reproduces deterministically when the file is run alone under the gate lock.
Classify it ENVIRONMENT/host; do not "fix" the warning by touching product code
in this integration run.

### Full-suite #37 baseline comparison (MTLK-ALL-WORKFLOWS US-013)

`tests/matchlock-all-workflows-baseline.test.ts` (parallel lane, pure fs)
pins the recorded **#37 baseline failing-title set** (44 unique titles, the
`baseline` section of
`/home/kaladin/matchlock-work/dsh-overlay-fsync-fix-contract.json`, concrete
list at `evidence/dsh-overlay-fsync-fix-us006-20260918T013731Z/baseline-failing-titles.txt`)
and the pure comparison logic used by the full-suite gate:

- `extractFailingTitles(logText)` pulls the unique failing titles from raw
  node:test output: it matches the `✖ <title>` lines (U+2716 + one space),
  strips the trailing ` (<duration>ms|s)`, drops the synthetic
  `✖ failing tests:` suite summary, then dedupes and sorts.
- `compareFailureSets(observed, baseline)` is the gate: **`newVsBaseline` must
  be empty** (title-for-title subset). `baselineOnly` titles are flakes that
  did not reproduce and are recorded, not regressions.
- The two guard-sensitive baseline titles (a temp-dir helper call and a
  hardcoded temp path) are assembled by concatenation so the file does not
  itself trip `src/lib/temp-dir.guard.test.ts`; assembled strings stay
  byte-identical. Do NOT put those two literals in this file's comments either —
  the guard reads the whole file as one string.

The US-013 full TEST_CMD under
`flock --exclusive /home/kaladin/matchlock-work/vaivm-gate.lock` (detached
setsid+nohup) produced `rc=1` with **serial 4290 tests / 4251 pass / 38 fail**
and **parallel 3183 / 3176 / 4**; the observed failing-title set EXACTLY equals
the 44-title #37 baseline (empty diff both directions). The failure classes are
all host-environment/deterministic: 35 `/root`-fixture EACCES (hermes+pi
invocation runners), 2 control-plane CLI (origin/main-ahead update warning), 1
portability lint, 4 parallel guards, 1 guard-ledger. Re-running representative
baseline-failing files ALONE under the lock reproduced each red
deterministically, so none is a concurrent-load flake; the known
SQLite/concurrency suites (`tests/update-protocol.test.ts`,
`tests/step-ops-dispatch-races.test.ts`) passed in the full run. Evidence:
`/home/kaladin/matchlock-work/evidence/us013-full-suite-F0pCEJ/`
(`us013-results.json` sidecar for US-014). Never silence a baseline failure by
touching product `src/`.

## Environment Overrides

- `TAMANDUA_WORKFLOWS_SRC`: Overrides the directory from which bundled workflows are loaded. When set, the installer resolves this directory (relative or absolute) instead of the default `<repo>/workflows/`. Tests that exercise `workflow install --all` or `get-ready` with custom workflow fixtures should point this at a temp directory containing the desired workflow set. Set in `src/installer/paths.ts` `resolveBundledWorkflowsDir()`.

## State

- SQLite database: `~/.tamandua/tamandua.db`
- Agent config: `~/.tamandua/agents.json`
- Cron jobs: `~/.tamandua/cron-jobs.json`
- Events: `~/.tamandua/events.jsonl`
- Logs: `~/.tamandua/tamandua.log`
- Medic: `~/.tamandua/medic.json`

### DB schema changes (migrations)

- New columns are added ONLY via guarded idempotent ALTERs inside `migrate()`
  in `src/db.ts`, using the `SELECT name FROM pragma_table_info('<table>')
  WHERE name = '<col>'` guard (the pattern `instant_fail_count` uses). The
  table's `CREATE TABLE` statement keeps its original explicit column list,
  and nullable additions never touch explicit-column INSERTs or the status.ts
  SELECT column lists.
- ANY change to `migrate()` MUST bump `SCHEMA_VERSION` (currently 13). This is
  the WLST5.1 failure mode: adding a guarded ALTER without bumping leaves
  existing DBs (user_version === the old version) early-returning in
  `migrate()` and skipping the ALTER, so any SQL touching the new column
  crashes with "no such column". The bump applies to DDL changes inside
  `applySchema()`, and `migrate()` now serializes cold-start migration across
  processes (`BEGIN IMMEDIATE` + bounded retry, re-reading `user_version`
  under the lock) so concurrent first-opens cannot race the guarded ALTERs.
- ONE schema chain (UNION-PORT v13): the main and Matchlock lineages each
  claimed a `v10`, and then each claimed a `v12` for a DIFFERENT column
  (`steps.preclaim_death_count` on main, `runs.matchlock_policy` on the
  Matchlock lineage), so the union port renumbers both into one idempotent
  chain ending at `SCHEMA_VERSION = 13`.
  `v9 -> v10` is `migrateInstantsToIsoZ()` (rewrites naive
  `YYYY-MM-DD HH:MM:SS` values to ISO-8601 UTC `...Z` in every timestamp
  column; idempotent, so it also normalizes a Matchlock-lineage DB that still
  holds naive values). `v10 -> v11` is the guarded
  `steps.target_moved_reroute_count INTEGER DEFAULT 0` ALTER (main's
  REROUTE-BUDGET). `v11 -> v12` is the guarded
  `steps.preclaim_death_count INTEGER NOT NULL DEFAULT 0` ALTER (main's
  OUTAGE-ROUNDS pre-claim counter). `v12 -> v13` is the guarded
  `runs.matchlock_policy TEXT` ALTER (the Matchlock lineage's nullable,
  host-owned execution-isolation policy JSON; NULL means the native path).
  `migrate()` does NOT early-return for any `user_version < 13`; it classifies
  the starting lineage with the exported pure `detectSchemaLineage(db)` helper
  by reading `PRAGMA table_info` — never the colliding `user_version` alone:
  `main-v12` (preclaim present, matchlock absent), `union-v12` (matchlock
  present, preclaim absent), `pre-v12` (earlier/empty) and `current` (v13 with
  both). The matchlock-lineage old v10/v12 column is kept as-is (the
  `pragma_table_info` guard on every ALTER stays authoritative), and
  `migrateInstantsToIsoZ()` still runs for every DB below 13 so a
  matchlock-lineage DB with naive instants is normalized; the final stamp is
  `user_version = 13`.
- Migration coverage belongs in `src/db.test.ts` MIGV tests: build a legacy DB
  with raw pre-bump DDL + `PRAGMA user_version = <starting version>` in a temp
  HOME, open it through `getDb()` in a subprocess (import from `dist/db.js`,
  `TAMANDUA_TEST_GUARD=1`), and assert the new column(s), the re-stamped
  user_version, and a status SELECT over runs. The union4 matrix
  (`MIGV union4 v13 schema chain`) covers every starting state: v9, v10 MAIN
  (ISO-Z, no target_moved, no matchlock_policy), v10 MATCHLOCK
  (matchlock_policy present, naive instants, no target_moved), v11 MAIN, v11
  MATCHLOCK, v12 MAIN (preclaim present, no matchlock_policy), v12 UNION
  (matchlock_policy present, no preclaim), and already-at-13, plus a forced
  slow-path re-run proving each guarded step is idempotent.

### Time and staleness (TIME-CLOCKS)

ONE clock/staleness rule owns every interval, deadline, and stored instant.
It is implemented in `src/lib/instant.ts`, documented at call sites, and
enforced mechanically by `tests/time-clocks-guard.test.ts` (US-014) plus the
cross-cutting wall-jump regression suite
`tests/time-clocks-wall-jump.test.ts` (US-013).

- **Rule 1 — in-process intervals and deadlines are monotonic.** Retry
  backoff, round elapsed/remaining wall budgets, harness readiness, daemon
  start/stop waits, the control-plane wait, the suite claim timeout, the
  dashboard cache TTL, CLI elapsed timers, and teardown graces measure and
  enforce their budgets with `monotonicNow()` / `Stopwatch` / `Deadline` —
  **never** a difference of `Date.now()` values. A wall-clock jump (NTP
  step, suspend/resume) must not produce a negative, inflated, or premature
  result. A monotonic reading is opaque: never persist it and never mix it
  with epoch milliseconds.
- **Rule 2 — durable instants are UTC ISO-Z, compared numerically.** Values
  that must survive a restart (claim leases, staleness thresholds, recovery
  windows, reconciler cutoffs, stored `created_at` ages) are written via
  `nowIso()` / `SQL_NOW_ISO`, read via `parseInstant()`, and compared with
  `instantAgeMs()` / `isOlderThan()` — **never as string comparisons**. Each
  call site passes an explicit tolerance and documents why. An unparseable
  or missing instant is never stale (`isOlderThan()` returns `false`), so an
  unknown age cannot fabricate a recovery, expiration, or replay.
- **Rule 3 — file mtimes keep OS-epoch semantics.** Daemon pidfile / start
  lock provenance and dsh session "created since spawn" have no monotonic
  analogue, so they stay epoch-based, but the age/since-spawn decision still
  routes through the same `instantAgeMs()` / `isOlderThan()` helpers with
  the same documented-tolerance discipline.

`tests/time-clocks-guard.test.ts` comment-blind scans `src/**/*.ts`
(excluding `*.test.ts`) for raw `Date.now()` interval/deadline idioms and
fails on any match not justified in
`tests/time-clocks-guard.allowlist.json`; sanctioned serialization and
OS-epoch sites carry a TIME-CLOCKS allow-list reason. Adding a new wall-clock
interval or a string comparison of instants is therefore a build failure, not
a review comment.

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

### Sandbox-safe process metadata (MPSX)

Inside the macOS Seatbelt signal profile used for per-execution isolation,
`/bin/ps` (setuid) is EPERM, so every ps-based process probe degrades to
nothing in a sandboxed worker round. `native/proc-info.c` (compiled by
`scripts/build-native.mjs` to `dist/native/proc-info`, like `proc-starttime`)
exposes the needed metadata through `sysctl(2)`:

```
proc-info list | pid <pid> | dump | env <pid>   # pid/ppid/pgid/state/start/cmdline, TAB-separated; env is raw NUL-separated
```

`src/lib/proc-info.ts` prefers it for `listPids`/`getPgid`/`getCmdline`/
`getProcessState`/`getElapsedSeconds` and the bulk `listProcessDetails()`,
falling back to ps only when the helper was not built; procfs stays the
primary Linux source. The `env <pid>` subcommand walks KERN_PROCARGS2 past
argv and returns the environ block: macOS `ps -E` cannot read another
process's environment, but sysctl(2) returns it for same-user processes, so
`getEnvironText`/`environHasEntry` are NOT procfs-only — the state-dir
scoping guard (`processBelongsToEffectiveConfig`) binds a port holder to its
effective `TAMANDUA_STATE_DIR`/`HOME` on darwin exactly as on Linux.
`scripts/update-protocol.mjs` also derives its mac
process identity from the `proc-starttime` helper (formatted as a
deterministic UTC `Lstart` string via `formatUtcLstart`) and its parent chain
from `proc-info pid <pid>`, so identity capture and ancestry validation work
in-sandbox and no longer vary with the caller's `TZ`. New spawn-capable test
files must be registered in `tests/serial-files.txt`.

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
(a) imports from `node:child_process`, (b) calls a daemonctl spawner
(`startDaemon`/`startMcp`/`startControlPlane` and their stop/restart
counterparts), or (c) imports any export of a source module that itself
imports `node:child_process` (e.g. a module that spawnSyncs a child —
`harness-probe.test.ts` is serial because `harness-probe.ts` owns the
`<launcher> skill-path` spawn). The guard resolves dist-style test imports
back to their source module and flags the process-spawning dependency even
when the test only calls pure functions. In-process servers
(`createDashboardServer`, `createTamanduaMcpServer`) are NOT serial
candidates.

If you add a spawn-capable test file without listing it in
`tests/serial-files.txt`, `tests/serial-classification-guard.test.ts` fails
with instructions; `tests/serial-files-integrity.test.ts` pins the reverse
direction (everything listed must be spawn-capable and existing).

Never convert absolute-deadline assertions into polls or retries to fix a
flake — raise the timeout or move the file to the serial lane.

#### Full-suite TMPDIR must stay short (matchlock long-home tests)

Do **not** export `TMPDIR` under a deep directory (for example an evidence
directory) when running `npm test`. Several serial-lane matchlock tests derive
a throwaway `HOME` from `TMPDIR` and then build
`<HOME>/.matchlock/vms/vm-*/vsock.sock_5001`; if that path exceeds the Linux
107-byte `sun_path` limit the runner refuses early with
`matchlock_home_socket_path_too_long`, and the FIFO/socket progress-resource
test fails with `listen EINVAL`. That produces a cluster of ~11 spurious
long-home serial failures that do not exist with the default short `TMPDIR`.
If you must point evidence at a deep path, keep the test `TMPDIR` short (or
leave it unset) and route only the log/evidence paths there. Always compare the
observed failing-title set against the recorded #37 baseline before treating a
red full-suite run as a regression.

#### Launch-time harness probe in dispatch tests (IFLB)

The dispatch motor probes a run's harness at its first real dispatch
(`<launcher> skill-path`) and force-fails the run immediately when the
harness cannot answer. In-process dispatch tests that drive
`executeDispatchRound`/daemons with **canned fake harnesses** (fake pi /
hermes / dsh shims that reply `NO_WORK_AVAILABLE`, claim+die, or print
canned output regardless of the prompt) must set `TAMANDUA_HARNESS_PROBE=0`
for the round — saved/restored exactly like `TAMANDUA_PI_BINARY` is today —
otherwise the probe runs the fake through the probe prompt and force-fails
the run before the intended work round. Suites that exercise the probe
itself use a probe-aware fake pi whose output contains the expected path
(the daemon computes it by running the same command), journaling probe
invocations so the once-per-run rule is assertable. The PRODUCT scripted
harness runtimes (`e2e-tests/helpers/scripted-agent-runtime-shared.mjs` —
recognize the `TAMANDUA_HARNESS_PROBE: skill-path` marker line, run the
quoted `<launcher> skill-path` command for real, and reply with the PATH;
shared by the pi/dsh/hermes runtimes in `e2e-tests/helpers`) ANSWER probe
prompts, so daemon e2e suites (workflows-scripted/-hermes/-dsh,
workflows-harness-probe, workflows-instant-fail-loop, autoresearch-scripted,
stress-concurrent) run with
the probe ENABLED by default — the probe round is never journaled and never
consumes a canned-behaviors invocation index, so per-agent invocation/round
assertions are unaffected. A probe answer must be emitted in the runtime's
own output contract (pi: a message_end JSON line; dsh/hermes: plain-text
final message) and exits 0. Npm daemon suites whose scenario is NOT the
probe (dashboard-crash-isolation, pause-kill-resume-regression) still launch
with `TAMANDUA_HARNESS_PROBE=0` to keep the behavior under test focused.

Mid-run instant-fail rounds (a harness that passed the launch probe but
exits fast with zero output without claiming a step) now RELAUNCH after
the backoff window: after K consecutive instant-fail rounds the scheduler
skips ticks inside an escalating backoff window but spawns again once it
elapses, and after N consecutive rounds it force-fails the run with a
`run.instant_fail_loop` event. The wall threshold is 6 s by default
(`DEFAULT_INSTANT_FAIL_WALL_THRESHOLD_MS = 6000`) so provider refusals
that die after a network round trip (e.g. a dsh QUOTA refusal at ~3 s)
are classified rather than respawned invisibly; the classification uses
the harness process wall time (`harnessWallMs`, VM setup excluded) and
`TAMANDUA_INSTANT_FAIL_WALL_MS` overrides the threshold for tests/ops.
Defaults are K = 6 / N = 20
(`TAMANDUA_INSTANT_FAIL_BACKOFF_K` / `TAMANDUA_INSTANT_FAIL_ESCALATION_N`
override them); a non-instant-fail round between failures resets the
consecutive count. Do not pin the old 3/10 defaults anywhere. The fast e2e
`e2e-tests/workflows-instant-fail-loop.test.ts` (registered in both
`run-all-scripted-e2e-tests` and `run-all-e2e-tests`) pins the MID-RUN
relaunch end-to-end: a probe-passing shim that exit-1s on every work round,
with env K=2 / N=4 / base 3s, must force-fail with `run.instant_fail_loop`
within about a minute and show no `previous_round_in_flight` skip after a
backoff-gated tick.

Pre-claim deaths (a harness that passed the launch probe but then ran at
least the 6 s wall threshold and exited or died WITHOUT claiming a pending
step) are the SLOW complement of an instant fail and join the SAME
K = 6 / N = 20 escalating backoff and cap with a distinct vocabulary: each
death emits `step.preclaim_round_died` (exit code, signal, harness wall ms,
bounded stderr tail) and increments `steps.preclaim_death_count`
(the `v11 -> v12` step; the overall `SCHEMA_VERSION` is 13), the dispatch gate
is `preclaim_death_backoff`, and the
N-th death emits `run.preclaim_death_loop` then force-fails the run
(`formatPreclaimDeathReason`). Any successful claim resets the counter and
the in-memory streak; detection is timing + claim state ONLY (no
provider-error parsing, identical for pi/hermes/dsh) and neither instant
fails nor pre-claim deaths charge step/story retry budget or touch the
WLST5 counters. Surfaced as `pc:N`, `Pre-claim deaths: N` and
`PRE-CLAIM DEATH LOOP (N)` next to the instant-fail markers. Pinned by
`e2e-tests/workflows-preclaim-death-loop.test.ts`,
`e2e-tests/workflows-instant-fail-threshold.test.ts` and
`tests/outage-rounds-contract-docs.test.ts`.

The torture-test scripted tiers have their own FORK of these runtimes
(`torture-test/scripted-runtimes/` — runtime-pi.mjs / runtime-hermes.mjs /
runtime-shared.mjs, forked from `e2e-tests/helpers/` at the commit recorded in
`torture-test/scripted-runtimes/FROZEN_SHA`). When the e2e helper contract
grows (as the IFLB probe support did in US-006/US-007), port the change into
the torture fork too — fork-only code goes inside documented
`KNOB-REGION-BEGIN`/`KNOB-REGION-END` markers plus keyword exemptions in
`fork-parity-check` / `scripted-runtime-fork.test.ts`, and code that must track
the live e2e helpers (e.g. the probe answer blocks) should stay byte-identical
to the e2e copy. The torture probe self-test is
`torture-test/self-tests/tier0-scripted-runtime-harness-probe.test.ts`.
Never run multiple torture self-test files concurrently in one `node --test
f1 f2 ...` process: `scripted-runtime-install-parity.test.ts` temporarily
mutates the real runtime files in place (restoring in `finally`), which can
crash a concurrently spawned runtime child.

### End-to-End Tests

End-to-end tests live under `e2e-tests/`. There are **three kinds**, and the
distinction is critical:

| Test | Script | What it does | Duration |
|------|--------|--------------|----------|
| **Smoke (state-machine)** | `./run-all-smoke-e2e-tests` | Exercises workflow state machine, pipeline wiring, and step lifecycle using manual `step claim` / `step complete` with canned outputs. No real agents, models, or schedulers. | ~10–15 seconds |
| **Scripted (full pipeline, fake pi)** | `./run-all-scripted-e2e-tests` | Runs the REAL daemon → scheduler → harness spawn → step-ops → worktree/merge pipeline, with `TAMANDUA_PI_BINARY` pointed at a deterministic scripted agent (`e2e-tests/helpers/scripted-agent.ts`) that executes the claim/complete work protocol, including chaos scenarios (lost steps, crashed agents) and the concurrent-runs stress scenario (`e2e-tests/workflows-stress-concurrent.test.ts`: 8 simultaneous `bug-fix-merge-worktree` pipelines). No models, ZERO tokens. Primary regression net for motor changes — see `tests/MOTOR-CONTRACT.md`. | ~1–3 minutes (the concurrent stress test dominates) |
| **Real canary (single run)** | `./run-real-e2e-canary` | ONE do-now run with a trivial task through the real daemon → scheduler → pi pipeline, with token-accounting audits. **Spends a small amount of real tokens.** Use at motor-change milestones before the full real suite. | ~2–10 minutes |
| **Real (full pipeline)** | `./run-all-real-e2e-tests` | Launches actual Tamandua workflows that run through the full daemon → scheduler → pi agent pipeline. Uses real model invocations, real worktree creation, real git merges. | 30+ minutes per workflow |

`./run-all-e2e-tests` is the convenience alias — it runs the **smoke and
scripted tests** (fast, no tokens), including the concurrent-runs stress
scenario (`e2e-tests/workflows-stress-concurrent.test.ts`), which raises the
expected wall-clock time above the plain scripted tier. It does NOT run the
real e2e test.

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
  to stop the daemon scheduling you (TAMANDUA_DAEMON_PID guard).

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

<!-- BEGIN BEADS SETUP: generated by bd setup -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
