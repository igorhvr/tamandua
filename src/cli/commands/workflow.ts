/**
 * Workflow catalog, run lifecycle, and inspection commands.
 *
 * Kept as a single command group so the top-level CLI only routes workflow
 * arguments and all workflow-specific output contracts remain together.
 */

import { installWorkflow } from "../../installer/install.js";
import { uninstallAllWorkflows, uninstallWorkflow, checkActiveRuns } from "../../installer/uninstall.js";
import {
  getWorkflowStatus,
  listRuns,
  stopWorkflow,
  deleteWorkflow,
  forceFailRun,
  readHarnessProbeFailureBlock,
  buildWorkflowStatusJson,
  formatMatchlockPolicyUnusableStatusLine,
  MATCHLOCK_PREPARING_STATUS_LINE,
} from "../../installer/status.js";
import { runWorkflow, resumeWorkflow, type ResumeResult, type RunWorkflowResult } from "../../installer/run.js";
import {
  resolveMatchlockResourceLimits,
  formatMatchlockResourceSummary,
  MATCHLOCK_DEFAULT_SWAP_MB,
  MATCHLOCK_MAX_SWAP_MB,
  MATCHLOCK_SWAP_ENV,
} from "../../installer/matchlock/resource-limits.js";
import {
  STANDARD_MATCHLOCK_IMAGE,
  MATCHLOCK_IMAGE_ENV,
} from "../../installer/matchlock/standard-image.js";
import {
  buildWorkflowWarnings,
  parseWorkflowWarnings,
  withWorkflowWarnings,
  writeWorkflowWarningsToStderr,
} from "../../installer/matchlock/warnings.js";
import { listBundledWorkflows } from "../../installer/workflow-fetch.js";
import { loadWorkflowSpec } from "../../installer/workflow-spec.js";
import { resolveBundledWorkflowDir } from "../../installer/paths.js";
import { readPort } from "../../server/daemonctl.js";
import os from "node:os";
import { pauseRunWithDaemon, resumeRunWithDaemon } from "../../server/control-client.js";
import { buildAbandonReasonAggregate } from "../../installer/step-ops.js";
import { checkCatalogStalenessWarning } from "../../installer/catalog-version.js";
import { parseWorkflowRunArgs, parseWorkdirCollisionPolicyFlags, parseMatchlockRootUsageOverrideFlag } from "../workflow-run-args.js";
import { reportUnknownCommand } from "../shared.js";
import { logger } from "../../lib/logger.js";
import type { HarnessType } from "../../installer/types.js";
import { printWorkflowAutoresearch } from "./autoresearch.js";
import {
  formatWorkflowRunLaunchLines,
  resolveWorkflowRunLaunchInfo,
  workflowRunLaunchInfoToJson,
  type WorkflowRunLaunchInfo,
} from "../../installer/workflow-run-resolution.js";
import { handleWait, getWaitHelp } from "./wait.js";
import { detectWrongPrefix, stripIdPrefix, prefixRunId, prefixStepId } from "../../lib/id-prefix.js";
import { displayStoryStatus } from "../../lib/step-display.js";
import { formatInstant } from "../../lib/instant.js";
import { getInstantFailBackoffThreshold, getInstantFailWallThresholdMs } from "../../installer/instant-fail.js";
import {
  WORKDIR_REFUSAL_EXIT_CODE,
  formatSharedWorkdirWarning,
  type WorkdirCollisionPolicy,
} from "../../installer/workdir-collision.js";
import { sanitizeSchedulingError } from "../../installer/scheduling-error.js";

export function getWorkflowListHelp(): string {
  return `tamandua workflow list — List available bundled workflows with descriptions

Usage: tamandua workflow list [--json] [--id <name>]

Lists all bundled workflows that are available for installation from the
source checkout, showing a one-line description for each. These are the
workflows defined in the workflows/ directory of the Tamandua source tree.

Each workflow line shows the workspace mode: [worktree] for worktree-mode
workflows, [direct] for direct-mode workflows.

Options:
  --json    Output a JSON array of {id, name, description, workspaceMode} for programmatic consumption
  --id <name>
            Print only the entry for the named workflow (exact directory
            name) instead of the full list. Exits 0 when it exists, 1 with
            a one-line message when it does not. Combines with --json.

Examples:
  tamandua workflow list
  tamandua workflow list --json
  tamandua workflow list --id feature-dev-merge
  tamandua workflow list --id feature-dev-merge --json`;
}

export function getWorkflowRunsHelp(): string {
  return `tamandua workflow runs — List all workflow runs

Usage: tamandua workflow runs [--json]

Lists every workflow run in the database with status, workflow ID, token
usage, and a preview of the task description.

Output columns:
  Status    Run status (running, paused, done, failed, canceled)
  Run ID    8-character run identifier prefix
  Workflow  The workflow ID (e.g. feature-dev-merge)
  Tokens    Total tokens spent so far
  Task      Task description preview (truncated at 50 characters)

Options:
  --json    Output a JSON object with a runs array for machine consumption.
            Each run includes runId, runNumber, workflowId, status, tokensSpent,
            task (first 120 chars), createdAt, and updatedAt.

Examples:
  tamandua workflow runs
  tamandua workflow runs --json`;
}

export function getWorkflowInstallHelp(): string {
  return `tamandua workflow install — Install a specific workflow by name

Usage: tamandua workflow install <name>

Installs a single bundled workflow by its directory name. This fetches
the workflow YAML spec, provisions agent workspaces (AGENTS.md, IDENTITY.md,
SOUL.md, and any bundled skills), and registers agents in the agent config.

After installation, the workflow is ready to run with:
  tamandua workflow run <name> "task description"

Note: Installed bundled workflow files are refreshed on every install — local
edits are overwritten. Copy under a new workflow id to customize.

Examples:
  tamandua workflow install feature-dev-merge`;
}

export function getWorkflowUninstallHelp(): string {
  return `tamandua workflow uninstall — Uninstall one or all workflows

Usage: tamandua workflow uninstall <name> [--force]
       tamandua workflow uninstall --all [--force]

Uninstalls a workflow by name, or all workflows when --all is used.

By default, uninstall checks for active runs (running or paused) belonging
to the workflow and refuses if any exist. Use --force to skip this check.

Options:
  --all      Uninstall every installed workflow
  --force    Skip the active-runs check and uninstall anyway

Examples:
  tamandua workflow uninstall feature-dev-merge
  tamandua workflow uninstall feature-dev-merge --force
  tamandua workflow uninstall --all
  tamandua workflow uninstall --all --force`;
}

export function getWorkflowRunHelp(): string {
  return `tamandua workflow run — Start a new workflow run

Usage: tamandua workflow run <name> <task> [options]

Starts a new run of the given workflow with the specified task description.
The task is passed to the workflow's agents as their objective.

On success, prints the run ID in prefixed format: run-<uuid>. Both prefixed
and bare UUID forms are accepted when passing the run ID to other commands.

A direct run whose harness working directory is already held by a live run
is refused by default with exit code 75 and a message naming the holder and
the three ways out (retry later, --queue-behind-holder, or
--allow-multiple-runs-in-one-working-directory / TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR=1).
Worktree workflow variants (-worktree) never collide: each run gets its own
worktree.

Options:
  --no-hurry-please-save-tokens-mode
      Prefer a token-saver wrapper for this run's work: whenever a step
      spawns a harness (pi, hermes, or dsh), the matching <harness>-token-saver
      command is looked up on PATH first (per invocation, so installing it
      mid-run takes effect) and used if present; otherwise the plain
      harness binary runs as usual. Idle checking is free either way —
      the dispatch motor never spends tokens between steps.
  --context <key=value>
      Inject a key-value pair into the run's template context for step
      input resolution. Repeatable for multiple keys. The key and value
      are split on the first '=' character. Keys must be non-empty and
      must not be duplicated across --context flags.
      Example: --context branch=feature/my-branch
  --working-directory-for-harness <dir>
      Set the working directory for the agent harness during this run.
      Agents will operate within this directory.
  --queue-behind-holder
      Queue this run behind the live run holding the harness working
      directory, admitting it automatically when the holder releases the
      directory.
      Mutually exclusive with
      --allow-multiple-runs-in-one-working-directory.
  --allow-multiple-runs-in-one-working-directory
      Run concurrently even though the harness working directory is held by
      another live run; concurrent git writes in one checkout are the
      caller's responsibility. Mutually exclusive with
      --queue-behind-holder.
      TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR=1 is the environment form of
      this flag.
  --worktree-origin-repository <dir>
      Repository to clone when creating a worktree for this run.
      Defaults to the current repository.
  --worktree-origin-ref <ref>
      Git ref (branch, tag, or SHA) to check out in the worktree.
      Defaults to the current branch.
  --pi-as-harness
      Use pi as the agent harness (this is the default).
      Mutually exclusive with --hermes-as-harness and --dsh-as-harness.
  --hermes-as-harness
      Use hermes as the agent harness instead of pi.
      Mutually exclusive with --pi-as-harness and --dsh-as-harness.
      Under a Matchlock opt-in, the run executes the IMAGE's hermes inside a
      fresh Matchlock VM. The effective Hermes config root/profile (default,
      named or custom HERMES_HOME) is resolved from the SUBMISSION
      environment (HOME / HERMES_HOME / cwd at run creation) — never the
      daemon's. Without --matchlock, hermes runs natively on the host exactly
      as before.
      Under --matchlock the whole effective config directory is mounted
      read-write at the native guest HERMES_HOME (default:
      /workspace/config/hermes; named profile:
      /workspace/config/hermes/profiles/<name>). Guest output is plain text
      (not pi JSON); the session id comes from the stderr trailer and usage
      is read from the mapped store inside the still-owned VM as
      input+output+cache_write only (unknown/ambiguous/truncated is
      unavailable, never a fabricated zero). This build's
      Hermes-under-Matchlock path is synthetic-fixture qualified; real model
      and credential qualification is coordinator-owned remaining work.
  --dsh-as-harness
      Use the DeepSeek Harness (dsh) as the agent harness instead of pi.
      Alpha support.
      Mutually exclusive with --pi-as-harness and --hermes-as-harness.
      Supported with --matchlock (see below): an opted-in dsh Matchlock run
      resolves the effective DSH_HOME once at submission (default
      ~/.dsh, or the explicit DSH_HOME with relative/tilde semantics),
      mounts the WHOLE frozen home read-write at /workspace/config/dsh and
      runs the image's dsh headless in a fresh VM per probe/work round.
  Matchlock (VM isolation):
    --matchlock                     Run isolated with the standard image
                                    (igorhvr/tamandua, multi-arch; provisioned
                                    by tamandua matchlock setup)
    --matchlock-image <image>       Run isolated with an explicit image
                                    (must already be in the local matchlock
                                    store; tamandua never fetches at launch)
  --matchlock
      Opt in to Matchlock with the standard image ${STANDARD_MATCHLOCK_IMAGE}.
      A pure boolean: it never consumes a following token, so it can appear
      anywhere on the command line with zero ambiguity. The standard image is
      multi-arch; "tamandua matchlock setup" provisions this host by pulling
      the host-architecture variant, and admission pins the resolved
      variant's content+config identity before the run can be scheduled.
      --matchlock and --matchlock-image <image> are the ONLY two opt-in
      forms; nothing is implicit. No other flag, env var, workflow YAML,
      agent output, or MCP/API default activates Matchlock, and there is no
      host fallback; without an opt-in the run uses the native path and
      performs zero Matchlock actions.
      A bare --matchlock resolves no image at launch: if the standard image
      (or the ${MATCHLOCK_IMAGE_ENV} override) is absent from the local
      matchlock store, admission refuses the run and marks it failed with the
      "tamandua matchlock setup" remedy (or pass an explicit already-imported
      image with --matchlock-image <image>); nothing runs natively. NO code
      path fetches or builds an image at launch.
      ${MATCHLOCK_IMAGE_ENV} overrides the standard reference for a host
      (e.g. a registry mirror or a hardened internal rebuild). It is
      consulted only when an opt-in is present and no explicit image was
      given: set without an opt-in it is ignored, exactly like the existing
      TAMANDUA_MATCHLOCK_CPUS / _MEMORY_MB / _DISK_MB / _ALLOW_PRIVATE /
      _SWAP_MB env defaults. Precedence is
      --matchlock-image <image> > ${MATCHLOCK_IMAGE_ENV} > built-in
      ${STANDARD_MATCHLOCK_IMAGE}.
      Matchlock runs refuse to execute as root by default: matchlock is
      documented to run unprivileged (sudo is for its one-time host
      preparation only, never for running matchlock itself) and "tamandua
      matchlock setup" exists precisely so matchlock never needs root later.
      If you insist, re-run with
      --force-matchlock-usage-as-root-not-recommended-per-matchlock-docs
      (a dependent flag: it also requires an opt-in).
      Supported harnesses under --matchlock: pi-as-harness (default) and --dsh-as-harness,
      and hermes with --hermes-as-harness; all three are admitted with --matchlock.
      An opted-in run is admitted and pinned at submission: the selected
      configuration source must exist (only the host harness executable may
      be absent) and the image's immutable content+config identity is
      resolved and persisted before the run can be scheduled. Retry/resume
      reuses the persisted pin — a moved tag is never re-pinned. For a hermes
      opt-in the effective Hermes config directory is resolved from the
      submission environment and mounted read-write at the guest HERMES_HOME
      (whole selected config directory, default or named profile). For dsh the
      whole frozen effective DSH_HOME is mounted read-write at
      /workspace/config/dsh (preserving sessions/, profiles/, storages/, credentials/ and
      unknown entries as one mount) and the guest runs
      'dsh --profile headless <prompt>'.
      Guest DNS: every opted-in VM's resolver is composed with
      network.dns_priority resolved at submission from
      TAMANDUA_MATCHLOCK_DNS_PRIORITY=ipv4|ipv6 (default ipv4) and recorded
      in the run policy with its source. Workflow commands deliberately
      expose no per-run DNS flag; the interactive commands
      (tamandua matchlock pi|pi-shell|hermes|hermes-shell) own the
      --matchlock-prioritize-ipv4-dns-resolution /
      --matchlock-prioritize-ipv6-dns-resolution flags.
      A hermes/dsh work round returns plain text (not pi JSON); the session id
      comes from the stderr trailer and usage is projected from the mapped
      store inside the still-owned VM (input+output+cache_write; unknown/
      ambiguous/truncated is unavailable, never zero). The hermes and dsh
      Matchlock paths in this build are synthetic-fixture qualified, not
      real-model acceptance.
      Supported workflows under --matchlock in this build are exactly the
      shapes whose explicit later-role capability closure the backend serves:
      do-now and do-review-do-verify (no later-role tools); the non-merge
      story/worktree pipelines feature-dev, feature-dev-worktree, bug-fix,
      bug-fix-worktree, quarantine-broken-tests, security-audit and
      security-audit-worktree (guest git, packed tamandua-test suite evidence
      and bounded run queries); and every merge route feature-dev-merge,
      feature-dev-merge-worktree, bug-fix-merge, bug-fix-merge-worktree,
      quarantine-broken-tests-merge, quarantine-broken-tests-merge-worktree,
      security-audit-merge and security-audit-merge-worktree (the same closure
      plus the scoped merge-branch capability). Admission preflights that
      explicit closure and refuses every other shape with a workflow-specific
      exact reason BEFORE any VM/probe/native harness: *-github-pr needs a
      guest 'gh' CLI plus provisioned remote auth; just-do-it needs bounded
      child workflow dispatch; frontend-test needs browser/visual verification;
      skills-normalize-audit scans an operator-specified directory outside the
      admitted original root; an unknown/custom workflow id fails closed.
      All three harnesses (pi, hermes and dsh) carry the same admitted workflow
      set: there is no harness-by-workflow allow-list, and every admitted
      workflow (including the merge shapes) is executable by each harness.
      Every dispatched
      invocation (launch probe and work
      round) of the selected harness (pi, hermes or dsh) runs in its own
      FRESH Matchlock VM with the versioned guest helper pack mounted
      read-only at /workspace/runtime (guest
      reporting CLI at /workspace/runtime/bin/tamandua); the guest image must
      already provide the selected harness, its runtime and the tools the
      workflow needs. No harness is installed into the image and there is NO host/native fallback.
      The guest environment preserves the USER IMAGE's own effective PATH
      (captured at admission from the image config and prepended ONLY with
      the helper-pack bin) — never a conservative host PATH that would hide
      an image-declared executable location.
      Shapes outside the admitted closure — just-do-it child dispatch,
      PR/github-pr, browser verification and skills-normalize-audit — are
      REFUSED before any VM/probe/native harness starts with the precise
      missing capability or mechanism, never a blanket allow-list message;
      custom/unknown workflow ids fail closed. There is no blanket allow-list.
      This is not completed overall workflow support.
  --matchlock-image <image>
      Opt in to Matchlock with an explicit, operator-supplied image
      (also accepted as --matchlock-image=<image>). The value must be a
      non-empty image reference; a following recognized flag is never
      consumed as the value. The image must already be present in the local
      matchlock store: tamandua never fetches or builds an image at launch,
      and a store miss refuses the run with the import or
      "tamandua matchlock setup" remedy (nothing runs natively).
      --matchlock-image always wins over a bare --matchlock when both are
      given (passing just one is recommended). The Matchlock semantics
      documented under --matchlock above (harnesses, admitted workflows, VM
      freshness, guest helper pack, pinning and refusals) apply to both
      opt-in forms.
  --matchlock-cpus <n>
      VM vCPU count for an opted-in Matchlock run. A positive integer.
      Requires --matchlock or --matchlock-image <image>; without an opt-in
      the flag is a usage error.
      Built-in default: min(8, host online CPUs). Explicit values (flag or
      env) are ALWAYS clamped to at most 16 vCPUs (a standing project rule)
      and at most the host's online CPU count.
  --matchlock-memory <MB|Ng>
      VM memory for an opted-in Matchlock run. A positive integer number of
      MB, or a '<n>g' suffix meaning n*1024 MB (e.g. 16g = 16384 MB).
      Requires --matchlock or --matchlock-image <image>. Built-in default: min(16384 MB, 50% of
      host MemTotal); explicit values are ALWAYS clamped to at most 75% of
      host MemTotal.
  --matchlock-disk <MB|Ng>
      VM disk size for an opted-in Matchlock run. A positive integer number
      of MB, or a '<n>g' suffix meaning n*1024 MB (e.g. 40g = 40960 MB).
      Requires --matchlock or --matchlock-image <image>. Built-in default: 20480 MB; the value
      must be a finite positive number.
      Env defaults (read at launch, only when the flag is absent):
      TAMANDUA_MATCHLOCK_CPUS, TAMANDUA_MATCHLOCK_MEMORY_MB and
      TAMANDUA_MATCHLOCK_DISK_MB. Precedence per field is flag > env >
      built-in default; env values are clamped by the same caps as flags.
      The resolved limits are printed at launch and recorded in the run
      policy.
  --matchlock-swap <MB|Ng>
      Swap size for every VM of an opted-in Matchlock run. A positive integer
      number of MB, or a '<n>g' suffix meaning n*1024 MB (e.g. 8g = 8192 MB).
      Built-in default: ${MATCHLOCK_DEFAULT_SWAP_MB} MB on every Matchlock VM.
      Maximum: ${MATCHLOCK_MAX_SWAP_MB} MB (matchlock's cap). 0 is not a valid
      value — swap is disabled with --matchlock-no-swap, and the error for 0
      points at that off switch.
      Requires --matchlock or --matchlock-image <image>; without an opt-in
      the flag is a usage error. Env default (read at launch, only when the
      flag is absent): ${MATCHLOCK_SWAP_ENV}, a size or the literal "off"
      (case-insensitive) meaning swap disabled. Precedence:
      --matchlock-no-swap > --matchlock-swap > ${MATCHLOCK_SWAP_ENV} >
      built-in ${MATCHLOCK_DEFAULT_SWAP_MB} MB. Without an opt-in the env var
      is ignored too.
  --matchlock-no-swap
      Disable swap entirely for the opted-in Matchlock run (the persisted
      policy records swapMB 0). A pure boolean: it never consumes a following
      token. Mutually exclusive with --matchlock-swap. Requires --matchlock
      or --matchlock-image <image>. Env equivalent:
      ${MATCHLOCK_SWAP_ENV}=off.
  --matchlock-no-privileged
      Create every VM of the opted-in run WITHOUT the default whole-VM
      privilege: in-guest sudo is blocked (standard VM). The persisted run
      policy records the resolved value with its source (matchlockPrivileged
      false, source "flag"). A pure boolean: it never consumes a following
      token; a value-bearing (=...) form is an error. Requires --matchlock
      or --matchlock-image <image>; without an opt-in the flag is a usage
      error. Env equivalent: TAMANDUA_MATCHLOCK_NO_PRIVILEGED=1 (the ONLY
      enabling value). Precedence:
      --matchlock-no-privileged > TAMANDUA_MATCHLOCK_NO_PRIVILEGED=1 >
      default on.
  --matchlock-allow-private <entry>
      Per-run exception list of private destinations the opted-in Matchlock
      VM may reach; mapped to the Matchlock network.allow_private policy.
      Repeatable (also accepted as --matchlock-allow-private=<entry>); every
      occurrence appends one entry, duplicates are deduped, and the resolved
      list is persisted in the run's Matchlock policy so every round, retry
      and resume of the run reaches the same destinations.
      Requires --matchlock or --matchlock-image <image>; without an opt-in
      the flag is a usage error.
      An entry is a host name, an IPv4/IPv6 literal or CIDR, optionally
      suffixed with :port (a bracketed IPv6 destination uses [addr]:port; a
      bare IPv6 literal carries no port). Entries are validated by SHAPE at
      launch only — DNS resolution is Matchlock's job, and a host name
      qualifies only when every address it resolves to is allowed or public.
      Env default (read at launch, only when the flag is absent):
      TAMANDUA_MATCHLOCK_ALLOW_PRIVATE, a comma-separated list of the same
      entries. An explicit --matchlock-allow-private overrides the env list;
      the env var is ignored without --matchlock. Private, loopback,
      link-local, CGNAT and Yggdrasil (including IPv6) destinations stay
      blocked for everything not explicitly listed.
  --task-file <path>
      Read the task description from a file instead of passing it inline.
      The file path is dereferenced exactly once at CLI time — the path
      is never stored downstream. Mutually exclusive with inline task
      text; error if both are given.
  --no-relaunch-upon-rugpull
      Disable automatic replacement-run after a rugpull (base branch move)
      is detected on a failed merge/merge-worktree run.
  --wait
      Block until the run reaches a terminal status (completed, failed,
      or canceled). Heartbeat output is written to stderr; exit codes
      follow the same precedence as tamandua workflow wait.
  --timeout <duration>
      Max wait duration (e.g. 30s, 10m, 2h). Only meaningful with --wait.
      Units: s, m, h, d.
  --json
      Print one JSON object to stdout with the resolved launch facts
      (working directory/origin, clean, harness, daemon) and the created
      run's fields (runId, workflowId, task, status, stepCount, harnessCwd).
      With --wait, the wait result (runs/timedOut) is merged into the same
      object after the run completes.

Examples:
  tamandua workflow run feature-dev-merge "Add dark mode toggle" --matchlock
  tamandua workflow run feature-dev-merge "Add dark mode toggle" --matchlock-image registry.acme/jail:2
  tamandua workflow run feature-dev-merge "Add dark mode toggle"
  tamandua workflow run feature-dev-merge "Refactor DB layer" \\
      --no-hurry-please-save-tokens-mode
  tamandua workflow run feature-dev-merge "Build login page" \\
      --working-directory-for-harness /path/to/project
  tamandua workflow run feature-dev-merge "Fix bug #42" \\
      --worktree-origin-repository /repos/myapp --worktree-origin-ref develop
  tamandua workflow run quarantine-broken-tests-merge-worktree "Quarantine failing tests" \\
      --context branch=quarantine/broken-tests
  tamandua workflow run feature-dev-merge "Add dark mode" --wait
  tamandua workflow run feature-dev-merge "Add dark mode" --wait --timeout 5m
  tamandua workflow run feature-dev-merge "Add dark mode" --wait --json
  tamandua workflow run feature-dev-merge --task-file task.md --wait
  tamandua workflow run feature-dev-merge "Add dark mode" \\
      --working-directory-for-harness /path/to/project --queue-behind-holder
  tamandua workflow run feature-dev-merge "Add dark mode" \\
      --allow-multiple-runs-in-one-working-directory`;
}

export function getWorkflowStatusHelp(): string {
  return `tamandua workflow status — Show detailed run status with step listing

Usage: tamandua workflow status <query> [--json]

Shows detailed information about a workflow run, including status, token
usage, workspace mode (for worktree runs), and a list of every step with
its current status and assigned agent role.

The query accepts a run-id prefix for matching.

Output includes:
  Run          Run ID (8-char prefix)
  Workflow     Workflow ID
  Task         Full task description
  Status       Current run status
  Harness      Harness selected for the run (shown when not pi);
               dsh runs are labeled "dsh (alpha)"
  Tokens       Total tokens spent
  Workspace    Workspace mode (only shown for worktree runs)
  Steps        Per-step listing with step ID, status icon, and agent role
  Stories      Per-story listing with a status label; a story that a resume
               re-queued from FAILED shows as "pending (reset on resume, N
               prior failure[s])" while its stored status stays pending
  Red-ledger landing
               Ledger row, non-zero exit code, and suite timestamp when a
               default-mode merge landed over known red suite evidence

Step status indicators:
  [done   ]    Step completed successfully
  [running]    Step currently being executed
  [failed ]    Step failed (may be retried)
  [pending]    Step waiting to be claimed
  [verify ]    Loop step parked between stories while per-story verification runs

Options:
  --json    Output a JSON object with full run details for machine consumption.
            Includes runId, runNumber, workflowId, status, harnessType, task (first 200 chars),
            tokensSpent, createdAt, updatedAt, workspaceMode (worktree runs),
            worktreePath, worktreeOriginRef, steps array (stepId, stepIndex,
            agentRole, status, displayStatus, retryCount, abandonedCount, rerouteCount, claimPid,
            claimUpdatedAt, updatedAt), stories array (storyId, title, status,
            resumeResetCount, priorFailureCount (when > 0), abandonedCount),
            and optional redLedgerLanding evidence. Step outputs
            are NOT included.

Examples:
  tamandua workflow status run-abc12345
  tamandua workflow status run-abc12345 --json`;
}

export function getWorkflowDeleteHelp(): string {
  return `tamandua workflow delete — Permanently delete a workflow run

Usage: tamandua workflow delete <run-id> [--force]

Permanently deletes a workflow run and all associated data, including steps,
stories, and managed worktrees. The run-id accepts prefix matching.

By default, active runs (running or paused) cannot be deleted — they must
be canceled first. Use --force to cancel and delete an active run in one step.

Options:
  --force    Cancel and delete even if the run is currently running or paused.

Examples:
  tamandua workflow delete run-abc12345
  tamandua workflow delete run-abc12345 --force`;
}

export function getWorkflowStopHelp(): string {
  return `tamandua workflow stop — Cancel a running workflow

Usage: tamandua workflow stop <run-id>

Cancels a running workflow by setting its status to canceled. The run-id
accepts prefix matching.

Active agents associated with the run will see the cancellation on their
next polling cycle.

Examples:
  tamandua workflow stop run-abc12345`;
}

export function getWorkflowPauseHelp(): string {
  return `tamandua workflow pause — Pause a running workflow

Usage: tamandua workflow pause <run-id> [--drain]

Pauses a running workflow via the daemon. Only runs with status
"running" can be paused. The daemon must be running for this command to work
(start it with \`tamandua daemon start\`).

When paused, agents stop polling and active work sessions are interrupted.
Paused runs can be resumed later with \`tamandua workflow resume\`.

Options:
  --drain    Let in-flight agent sessions complete before pausing, rather
             than interrupting them immediately.

Examples:
  tamandua workflow pause run-abc12345
  tamandua workflow pause run-abc12345 --drain`;
}

export function getWorkflowResumeHelp(): string {
  return `tamandua workflow resume — Resume a paused or failed workflow run

Usage: tamandua workflow resume <run-id> [options]

Resumes a workflow run that is paused, mid-drain, or has failed. The run-id
accepts prefix matching.

A failed-run resume is a fresh launch for collision purposes: when the
harness working directory is already held by a live run it is refused by
default with exit code 75 and the same message as 'workflow run', naming
the holder and the three ways out.

Behavior by status:
  paused    Connects to the daemon and resumes agent polling.
            The daemon must be running for this to work.
  running   Resumable only while a pause --drain is still in progress
            (scheduling draining_pause): the plain resume CANCELS the
            pending drain and proceeds, printing a warning that a drain
            was in progress and is being cancelled. Other running runs
            are already active and do not need to be resumed.
  failed    Restarts the run from the failed step, creating a new run
            entry. The daemon is notified of the new run automatically.
            For loop-over-stories runs, every FAILED story is re-queued
            to pending with a fresh verification retry budget so the
            loop can pick it up again and the run can complete.
            A refused collision exits 75; pass --queue-behind-holder or
            --allow-multiple-runs-in-one-working-directory to proceed.
  Other     Terminal runs (completed, canceled) cannot be resumed.

Options:
  --queue-behind-holder
      Queue the resumed failed run behind the live run holding the harness
      working directory, admitting it when the holder releases it.
      Mutually exclusive with
      --allow-multiple-runs-in-one-working-directory.
  --allow-multiple-runs-in-one-working-directory
      Resume the failed run concurrently even though the harness working
      directory is held by another live run; concurrent git writes in one
      checkout are the caller's responsibility. Mutually exclusive with
      --queue-behind-holder.
      TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR=1 is the environment form of
      this flag.
      Worktree workflow variants (-worktree) never collide: each run gets
      its own worktree.
  --force-matchlock-usage-as-root-not-recommended-per-matchlock-docs
      R13 root-usage override (Matchlock runs only). A STANDALONE pure
      boolean: it never consumes a following token. Matchlock is documented
      to run unprivileged, so a root process resumes a consent-less
      Matchlock run only when this override was passed to THIS resume (or
      when the run's persisted policy already records rootUsageConsent).
      The override is honored only when the target run carries a non-NULL
      persisted Matchlock policy: passing it for a truly native run (no
      isolation intent, no policy) is refused, an intent-only row is routed
      to preparation recovery (never native), and a present-but-unusable
      policy refuses on the STATUS-UNUSABLE path before consent is
      consulted. A refused resume preserves the run's prior state.

Examples:
  tamandua workflow resume run-abc12345   # Resume a paused run
  tamandua workflow resume run-abc12345   # Cancel a pending drain / re-start a failed run
  tamandua workflow resume run-abc12345 --queue-behind-holder
  tamandua workflow resume run-abc12345 \\
      --allow-multiple-runs-in-one-working-directory
  tamandua workflow resume run-abc12345 \\
      --force-matchlock-usage-as-root-not-recommended-per-matchlock-docs`;
}

export function getWorkflowPauseAllHelp(): string {
  return `tamandua workflow pause-all — Pause all running workflows

Usage: tamandua workflow pause-all [--drain]

Pauses every workflow run currently in "running" status. Uses the dashboard
daemon to pause each run. If the daemon is unreachable for a specific run,
a warning is printed and that run is skipped.

Options:
  --drain    Let in-flight agent sessions complete before pausing, rather
             than interrupting them immediately. Applies to all runs.

Examples:
  tamandua workflow pause-all
  tamandua workflow pause-all --drain`;
}

export function getWorkflowResumeAllHelp(): string {
  return `tamandua workflow resume-all — Resume all paused workflows

Usage: tamandua workflow resume-all

Resumes every workflow run currently in "paused" status. Uses the dashboard
daemon to resume agent polling for each run. If the daemon is unreachable
for a specific run, a warning is printed and that run is skipped.

Only paused runs are resumed; failed runs are not resumed by this command
(use \`tamandua workflow resume <run-id>\` for individual failed runs).

Examples:
  tamandua workflow resume-all`;
}

export function getWorkflowFailHelp(): string {
  return `tamandua workflow fail — Force a running or paused run to failed status

Usage: tamandua workflow fail <run-id> --reason <text> [--force]

Forces a running or paused workflow run to terminal failed status. The run-id
accepts prefix matching and #N (run number).

The --reason argument is required and is recorded in the run.force_failed
event for auditability.

By default, this command checks whether any worker for the run is still alive
(step with running status and live claim_pid). If a live worker is found, the
command refuses and lists the alive workers with their step IDs and PIDs. Use
--force to override this guard and force-fail the run anyway (the worker is
NOT terminated — only the run status is changed).

Options:
  --reason <text>    Reason for force-failing the run (required)
  --force            Force-fail even if a worker is still alive

Examples:
  tamandua workflow fail run-abc12345 --reason "Run stuck after repo migration"
  tamandua workflow fail run-abc12345 --reason "Run abandoned" --force
  tamandua workflow fail #42 --reason "Manual intervention"`;
}

export function getWorkflowGroupHelp(): string {
  return `tamandua workflow — Manage workflows and runs

Usage: tamandua workflow <list|runs|install|uninstall|run|status|autoresearch|stop|delete|wait|pause|resume|pause-all|resume-all|fail>

Commands for managing Tamandua workflows and their runs.

Subcommands:
  list        List available bundled workflows
  runs        List all workflow runs with status, tokens, task preview
  install     Install a specific workflow by name
  uninstall   Uninstall a workflow (--all for all workflows, --force to skip
              active-runs check)
  run         Start a new workflow run with the given task
  status      Show detailed run status with step listing
  autoresearch
              Show AutoResearch progress for a run
  stop        Cancel a running workflow
  delete      Permanently delete a run and all its data (--force for active runs)
  wait        Block until workflow runs reach terminal status
  pause       Pause a running workflow via the daemon
  resume      Resume a paused or failed workflow run
  pause-all   Pause all running workflows
  resume-all  Resume all paused workflows
  fail        Force a running or paused run to failed status

Examples:
  tamandua workflow list
  tamandua workflow runs
  tamandua workflow install feature-dev-merge
  tamandua workflow run feature-dev-merge "Add a new feature"
  tamandua workflow status run-abc12345
  tamandua workflow autoresearch run-abc12345
  tamandua workflow wait run-abc12345
  tamandua workflow pause run-abc12345 --drain
  tamandua workflow fail run-abc12345 --reason "Stuck run"`;
}


export function getWorkflowWaitHelp(): string {
  return getWaitHelp();
}

export function getWorkflowAutoresearchHelp(): string {
  return `tamandua workflow autoresearch — Show AutoResearch progress for a workflow run

Usage: tamandua workflow autoresearch <run-id>

Resolves the run's harness working directory, reads its project-local
autoresearch.config.json and autoresearch.jsonl files, then prints the
current metric summary and recent experiment timeline.

Examples:
  tamandua workflow autoresearch run-abc12345`;
}

/**
 * Print non-done step states for a run.
 * One line per step: [status] stepIdPrefix (role) retry N
 */
function printNonDoneStepStates(runId: string): void {
  try {
    const detail = getWorkflowStatus(runId);
    const nonDone = detail.steps.filter((s) => s.status !== "done");
    for (const step of nonDone) {
      const role = step.agentId.split("_").slice(-1)[0];
      const prefix = step.stepId.slice(0, 8);
      console.log(`  [${step.status}] step-${prefix} (${role}) retry ${step.retryCount}`);
    }
  } catch {
    // If step query fails (e.g. DB error), don't break the resume flow.
  }
}

/**
 * SKILL-UX S3 (US-003): build the single JSON document emitted by
 * `tamandua workflow run --json`. It carries the run fields a caller already
 * gets from the text Run: block (runId, workflowId, task, status, ...) plus
 * the resolved launch facts, so scripts can consume the same values as the
 * text-mode resolution lines. The wait result is merged into this same object
 * by handleWait when --wait is also given.
 */
function buildWorkflowRunJsonOutput(
  result: RunWorkflowResult,
  launchInfo: WorkflowRunLaunchInfo | null,
): Record<string, unknown> {
  const jsonOutput: Record<string, unknown> = {
    runId: prefixRunId(result.runId),
    runNumber: result.runNumber,
    workflowId: result.workflowId,
    task: result.taskTitle,
    status: result.status,
    stepCount: result.stepCount,
    harnessCwd: result.workingDirectoryForHarness,
  };

  if (launchInfo) {
    const resolution = workflowRunLaunchInfoToJson(launchInfo);
    // MTLK-VM-SIZE US-005: the persisted admitted policy is authoritative when
    // runWorkflow reports limits (e.g. a replacement that inherited them). A
    // fresh CLI opt-in persists exactly the launch-resolved values, so this is
    // normally a no-op; it just keeps --json honest if they ever diverge.
    if (resolution.matchlockResources && result.matchlockResourceLimits) {
      resolution.matchlockResources = {
        ...resolution.matchlockResources,
        cpus: result.matchlockResourceLimits.cpus,
        memoryMB: result.matchlockResourceLimits.memoryMB,
        diskSizeMB: result.matchlockResourceLimits.diskSizeMB,
        // SHARED-V3 (MTLK-ISO-SLICE2 US-012): the swap size and provenance also
        // come from the ADMITTED policy (the launch-resolved values are the same
        // for a fresh opt-in, but the admitted policy is authoritative).
        swapMB: result.matchlockResourceLimits.swapMB,
        ...(result.matchlockImageSource
          ? { imageSource: result.matchlockImageSource }
          : {}),
      };
    }
    // SHARED-V3 (MTLK-ISO-SLICE2 US-012): fold the admitted immutable pin into
    // the SAME post-admission JSON document so `matchlockResources` carries the
    // full uniform field set (imageSource, swapMB, imageDigest,
    // imageConfigDigest) for an isolated run. The pre-admission launch block
    // cannot know the digests; this document is printed after run creation.
    if (resolution.matchlockResources && result.matchlockPin) {
      resolution.matchlockResources = {
        ...resolution.matchlockResources,
        imageDigest: result.matchlockPin.digest,
        imageConfigDigest: result.matchlockPin.configDigest,
      };
    }
    jsonOutput.resolution = resolution;
    // MTLK-VM-SIZE US-005: mirror the matchlock facts at the document's top
    // level too, exactly where `workflow status --json` exposes
    // `matchlockResources`, so the same object is readable from either
    // command. Native runs carry neither key.
    if (resolution.matchlockResources) {
      jsonOutput.matchlockResources = resolution.matchlockResources;
    }
  }
  if (result.daemonWarning) jsonOutput.daemonWarning = result.daemonWarning;
  if (result.queuedBehindRunId) {
    jsonOutput.queuedBehindRunId = result.queuedBehindRunId;
    if (result.schedulingState) jsonOutput.schedulingState = result.schedulingState;
  }
  if (result.captureWarnings) jsonOutput.captureWarnings = result.captureWarnings;

  // MTLK-ISO-SLICE2 US-013: the shared top-level warnings channel is PRESENT
  // only when non-empty (absent — never `[]` — on a clean launch). A launch
  // whose admitted policy records root-usage consent gets `root_usage_override`,
  // re-derived from the ADMITTED policy (an inherited replacement included).
  return withWorkflowWarnings(
    jsonOutput,
    buildWorkflowWarnings({
      rootUsageConsent: result.matchlockRootUsageConsent === true,
    }),
  );
}

export async function handleWorkflow(
  group: string | undefined,
  args: string[],
  printUsage: () => void,
): Promise<boolean> {
  if (group !== "workflow") return false;
  const [, action, target] = args;
  if (args.length < 2) { printUsage(); process.exit(1); }
  if (group !== "workflow") { printUsage(); process.exit(1); }

  // Build CLI requester identity for pause/resume attribution (US-004).
  const cliIdentity = `${os.userInfo().username}@${os.hostname()}:${process.pid} (cli)`;

  if (action === "runs") {
    const jsonFlag = args.includes("--json");
    const runs = listRuns();
    if (jsonFlag) {
      const jsonRuns = runs.map((r) => {
        const entry: Record<string, unknown> = {
          runId: prefixRunId(r.id),
          runNumber: r.runNumber,
          workflowId: r.workflowId,
          status: r.status,
          tokensSpent: r.tokensSpent,
          task: r.task.slice(0, 120),
        };
        // TIME-OUTPUT US-005: serialize every instant as ISO-8601 UTC with Z,
        // normalizing legacy naive stored values. A missing/unparseable value is
        // omitted rather than passed through raw or fabricated.
        const createdAt = formatInstant(r.createdAt, { style: "iso" });
        if (createdAt !== undefined) entry.createdAt = createdAt;
        const updatedAt = formatInstant(r.updatedAt, { style: "iso" });
        if (updatedAt !== undefined) entry.updatedAt = updatedAt;
        return entry;
      });
      console.log(JSON.stringify({ runs: jsonRuns }));
      return true;
    }
    if (runs.length === 0) { console.log("No workflow runs found."); return true; }
    console.log("Workflow runs:");
    for (const r of runs) {
      const wl = r.workerLostCount > 0 ? ` wl:${r.workerLostCount}`.padEnd(6) : "      ";
      const ce = r.ceilingExpiryCount > 0 ? ` ce:${r.ceilingExpiryCount}`.padEnd(6) : "";
      // Instant-fail loop surfacing (DDTH): once a run has K+ consecutive
      // instant-fail rounds it is backing off toward escalation — show the
      // pathology before it is fatal.
      const ifMarker = r.instantFailCount >= getInstantFailBackoffThreshold()
        ? ` if:${r.instantFailCount}`.padEnd(6)
        : "";
      // OUTAGE-ROUNDS (SCLS) US-006: mirror the instant-fail loop marker for
      // consecutive slow pre-claim deaths so a silent verifier death loop is
      // visible in the compact list before it is fatal.
      const pcMarker = r.preclaimDeathCount >= getInstantFailBackoffThreshold()
        ? ` pc:${r.preclaimDeathCount}`.padEnd(6)
        : "";
      console.log(`  [${r.status.padEnd(9)}] run-${r.id.slice(0, 8).padEnd(10)} ${r.workflowId.padEnd(14)}${wl}${ce}${ifMarker}${pcMarker}${r.tokensSpent.toLocaleString().padStart(8)} tokens  ${r.task.slice(0, 50)}${r.task.length > 50 ? "..." : ""}`);
    }
    return true;
  }

  if (action === "list") {
    const jsonFlag = args.includes("--json");
    // SKILL-UX S2: parse --id <name> and --id=<name> to filter the list to one workflow.
    let idFilter: string | null = null;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--id") {
        const value = args[i + 1];
        if (value !== undefined) idFilter = value;
        break;
      }
      if (arg.startsWith("--id=")) {
        idFilter = arg.slice("--id=".length);
        break;
      }
    }
    const workflows = await listBundledWorkflows();
    if (workflows.length === 0) {
      if (idFilter !== null) {
        process.stderr.write(`No bundled workflow named "${idFilter}".\n`);
        process.exit(1);
      }
      if (jsonFlag) console.log("[]");
      else console.log("No workflows available.");
      return true;
    }
    // Load specs for all workflows — needed for workspaceMode in both text and JSON paths
    const specs = await Promise.all(
      workflows.map(async (wid) => {
        try {
          const dir = resolveBundledWorkflowDir(wid);
          const spec = await loadWorkflowSpec(dir);
          return { id: spec.id, name: spec.name || spec.id, description: spec.description || "", workspaceMode: spec.run?.workspace || "direct" };
        } catch {
          return { id: wid, name: wid, description: "", workspaceMode: "direct" };
        }
      }),
    );
    if (idFilter !== null) {
      const idx = workflows.indexOf(idFilter);
      if (idx === -1) {
        process.stderr.write(`No bundled workflow named "${idFilter}".\n`);
        process.exit(1);
      }
      const entry = specs[idx];
      if (jsonFlag) {
        console.log(JSON.stringify([entry]));
      } else {
        // SKILL-UX S2: collapse any multi-line description to keep the filtered
        // entry a single line (the full list prints descriptions verbatim).
        const description = entry.description.replace(/\s+/g, " ").trim();
        console.log(`  ${entry.id} - ${description} [${entry.workspaceMode}]`);
      }
      return true;
    }
    if (jsonFlag) {
      console.log(JSON.stringify(specs));
      return true;
    }
    console.log("Available workflows:");
    for (let i = 0; i < workflows.length; i++) { console.log(`  ${specs[i].id} - ${specs[i].description} [${specs[i].workspaceMode}]`); }
    return true;
  }

  if (action === "stop" || action === "cancel") {
    if (!target) { process.stderr.write("Missing run-id.\n"); process.exit(1); }
    const wrongPrefix = detectWrongPrefix(target, "run");
    if (wrongPrefix) { process.stderr.write(`${wrongPrefix}\n`); process.exit(1); }
    try { const fullId = getWorkflowStatus(target).id; const r = await stopWorkflow(fullId, { source: "cli-stop" }); console.log(`Cancelled run run-${r.runId.slice(0, 8)}.`); } catch (err) { process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`); process.exit(1); }
    return true;
  }

  if (action === "pause") {
    if (!target) { process.stderr.write("Missing run-id.\n"); process.exit(1); }
    const wrongPrefix = detectWrongPrefix(target, "run");
    if (wrongPrefix) { process.stderr.write(`${wrongPrefix}\n`); process.exit(1); }
    const drain = args.includes("--drain");
    let fullId: string;
    let runStatus: string;
    try {
      const detail = getWorkflowStatus(target);
      fullId = detail.id;
      runStatus = detail.status;
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    if (runStatus !== "running") {
      process.stderr.write(`Cannot pause run run-${fullId.slice(0, 8)}: status is "${runStatus}" (only running runs can be paused).\n`);
      process.exit(1);
    }
    const response = await pauseRunWithDaemon(fullId, drain, cliIdentity);
    if (response === null) {
      process.stderr.write("Daemon is unreachable. Is the daemon running? Try: tamandua daemon start\n");
      process.exit(1);
    }
    if (response.status !== 200) {
      const errMsg = typeof response.body.error === "string" ? response.body.error : "Unknown error";
      process.stderr.write(`Failed to pause run: ${errMsg}\n`);
      process.exit(1);
    }
    console.log(`Paused run run-${fullId.slice(0, 8)}.`);
    return true;
  }

  if (action === "resume") {
    if (!target) { process.stderr.write("Missing run-id.\n"); process.exit(1); }
    const wrongPrefix = detectWrongPrefix(target, "run");
    if (wrongPrefix) { process.stderr.write(`${wrongPrefix}\n`); process.exit(1); }
    let fullId: string;
    let runStatus: string;
    let schedulingStatus: string | null | undefined;
    try {
      const detail = getWorkflowStatus(target);
      fullId = detail.id;
      runStatus = detail.status;
      schedulingStatus = detail.schedulingStatus ?? null;
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    // PAUS US-004: a run mid-drain (pause --drain still in progress) keeps
    // status 'running' with schedulingStatus 'draining_pause'. A plain
    // resume must accept it and CANCEL the pending drain: the control plane
    // flips the run and reports drainCancelled in the 2xx body. Runs that
    // are simply paused follow the same daemon path; all other 'running'
    // runs stay refused below.
    const drainPending = runStatus === "running" && schedulingStatus === "draining_pause";
    // MTLK-ISO-SLICE2 US-009 (R13): the deliberate root-usage override is a
    // STANDALONE pure boolean for resume. It is threaded to the control plane
    // for the paused/draining form; the failed-run form's consent is the
    // follow-on story (US-010) and is not silently claimed here.
    const rootUsageOverride = parseMatchlockRootUsageOverrideFlag(args);
    if (runStatus === "paused" || drainPending) {
      const response = await resumeRunWithDaemon(fullId, cliIdentity, rootUsageOverride);
      if (response === null) {
        process.stderr.write("Daemon is unreachable. Is the daemon running? Try: tamandua daemon start\n");
        process.exit(1);
      }
      // PREP-STATE: an intent-only row is held mid-preparation. The daemon
      // returns the typed preparing-held 202; surface the shared remedy and
      // fail instead of printing a false "Resumed run".
      const body = response.body ?? {};
      if (body.held === true || body.state === "preparing") {
        const message = typeof body.message === "string"
          ? body.message
          : `Run run-${fullId.slice(0, 8)} is held mid-preparation and cannot be resumed natively.`;
        process.stderr.write(`${message}\n`);
        process.exit(1);
      }
      if (response.status !== 200 && response.status !== 202) {
        const errMsg = typeof response.body.error === "string" ? response.body.error : "Unknown error";
        process.stderr.write(`Failed to resume run: ${errMsg}\n`);
        process.exit(1);
      }
      // PAUS US-004: surface a cancelled pending drain as an operator
      // warning. Only a resume that actually cancelled a drain carries the
      // flag — a paused run whose drain already finished resumes without it.
      if (drainPending && response.body && response.body.drainCancelled === true) {
        process.stderr.write(`Warning: run run-${fullId.slice(0, 8)} had a pending drain in progress; plain resume cancels the drain.\n`);
      }
      // MTLK-ISO-SLICE2 US-013: the shared advisory warnings channel the
      // control plane returned in its resume JSON body (e.g.
      // consent_granted_on_resume / root_usage_override). Advisory only.
      writeWorkflowWarningsToStderr(parseWorkflowWarnings(response.body.warnings));
      console.log(`Resumed run run-${fullId.slice(0, 8)}.`);
      printNonDoneStepStates(fullId);
      return true;
    }
    if (runStatus === "failed") {
      // WORKDIR-FLAGS US-005: a failed-run resume accepts the same workdir
      // collision flags as a fresh launch, with the same precedence and env
      // fallback. A bad flag combination is a usage error.
      let workdirCollisionPolicy: WorkdirCollisionPolicy;
      try {
        workdirCollisionPolicy = parseWorkdirCollisionPolicyFlags(args);
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }

      // resumeWorkflow throws on registration failure (e.g. the daemon is
      // mid-teardown for a just-force-failed run and returns the retriable
      // "run teardown in progress" error). Render those cleanly — stderr
      // message, meaningful exit code, no stack trace — instead of letting
      // the throw escape to the top-level handler.
      let result: ResumeResult;
      try {
        result = await resumeWorkflow(fullId, {
          workdirCollisionPolicy,
          ...(rootUsageOverride ? { matchlockRootUsageOverride: true } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Failed to resume run: ${message}\n`);
        process.exit(1);
      }
      if (result.status === "not_found") { console.log(`No failed run found matching "${target}".`); return true; }
      // MTLK-ISO-SLICE2 US-010 (R13): a typed Matchlock refusal on the
      // failed-run path (truly-native + override, STATUS-UNUSABLE, root gate or
      // the swap-capability handshake) preserves the run's prior state. The
      // message already names the fact and the remedy.
      if (result.status === "refused" && result.matchlockRefused) {
        process.stderr.write(result.matchlockRefused.message + "\n");
        process.exit(1);
      }
      // MTLK-ISO-SLICE2 US-008 (PREP-STATE): an intent-only run is held
      // mid-preparation, never resumed natively. Surface the shared
      // held/preparing remedy instead of the "Resumed run" confirmation.
      if (result.status === "preparing" && result.preparingHeld) {
        process.stderr.write(result.preparingHeld.message + "\n");
        process.exit(1);
      }
      // WORKDIR-FLAGS US-005: a refused harness-workdir collision is a typed,
      // distinct outcome. Write the daemon's actionable message (it already
      // names the holder and the three ways out) to stderr and exit with the
      // dedicated refusal code — never the generic failure path.
      if (result.status === "refused" && result.workdirRefused) {
        process.stderr.write(result.workdirRefused.message + "\n");
        process.exit(WORKDIR_REFUSAL_EXIT_CODE);
      }
      if (result.queuedBehindRunId) {
        // US-005: the explicit queue policy parked the resume behind a live
        // holder; the run is registered and the reconciler admits it later.
        console.log(
          `Queued behind run ${result.queuedBehindRunId}: the harness working directory is held by that run. ` +
          `The resumed run run-${result.runId!.slice(0, 8)} (${result.workflowId}) will be admitted automatically when the holder releases it.`,
        );
        console.log(`Check: tamandua workflow status run-${result.runId!.slice(0, 8)}`);
      } else {
        console.log(`Resumed run run-${result.runId!.slice(0, 8)} (${result.workflowId}), restarting from step: ${result.stepId}`);
      }
      // YSE US-002: re-queue confirmation when resume reset FAILED stories.
      if (result.resetCount !== undefined && result.resetCount > 0) {
        console.log(`Reset ${result.resetCount} failed ${result.resetCount === 1 ? "story" : "stories"} to pending for resume.`);
      }
      // MTLK-ISO-SLICE2 US-013: the shared advisory warnings channel from the
      // failed-run resume (consent_granted_on_resume / root_usage_override).
      writeWorkflowWarningsToStderr(result.warnings ?? []);
      printNonDoneStepStates(result.runId!);
      return true;
    }
    if (runStatus === "completed" || runStatus === "canceled") {
      process.stderr.write(`Cannot resume run run-${fullId.slice(0, 8)}: status is "${runStatus}" (terminal runs cannot be resumed).\n`);
      process.exit(1);
    }
    process.stderr.write(`Cannot resume run run-${fullId.slice(0, 8)}: status is "${runStatus}" (only paused or failed runs can be resumed).\n`);
    process.exit(1);
  }

  if (action === "pause-all") {
    const drain = args.includes("--drain");
    const runs = listRuns(1000).filter(r => r.status === "running");
    if (runs.length === 0) {
      console.log("No runs to pause.");
      return true;
    }
    let paused = 0;
    for (const r of runs) {
      const response = await pauseRunWithDaemon(r.id, drain, cliIdentity);
      if (response === null) {
        console.warn(`Warning: daemon unreachable for run run-${r.id.slice(0, 8)} — skipped`);
        continue;
      }
      if (response.status !== 200) {
        console.warn(`Warning: failed to pause run run-${r.id.slice(0, 8)} — skipped`);
        continue;
      }
      paused++;
    }
    console.log(`Paused ${paused} run(s).`);
    return true;
  }

  if (action === "resume-all") {
    const runs = listRuns(1000).filter(r => r.status === "paused");
    if (runs.length === 0) {
      console.log("No runs to resume.");
      return true;
    }
    let resumed = 0;
    for (const r of runs) {
      const response = await resumeRunWithDaemon(r.id, cliIdentity);
      if (response === null) {
        console.warn(`Warning: daemon unreachable for run run-${r.id.slice(0, 8)} — skipped`);
        continue;
      }
      if (response.status !== 200 && response.status !== 202) {
        console.warn(`Warning: failed to resume run run-${r.id.slice(0, 8)} — skipped`);
        continue;
      }
      resumed++;
      console.log(`  Resumed run run-${r.id.slice(0, 8)}.`);
      printNonDoneStepStates(r.id);
      console.log();
    }
    console.log(`Resumed ${resumed} run(s).`);
    return true;
  }

  const WORKFLOW_ACTIONS = [
    "runs", "list", "stop", "cancel", "pause", "resume", "pause-all", "resume-all",
    "install", "uninstall", "run", "status", "autoresearch", "wait", "delete", "fail", "ensure-crons",
  ];
  if (!WORKFLOW_ACTIONS.includes(action)) {
    reportUnknownCommand(action, WORKFLOW_ACTIONS, "workflow");
  }

  if (!target) { printUsage(); process.exit(1); }

  if (action === "install") {
    const isAll = target === "--all" || target === "all";
    if (isAll) {
      const workflows = await listBundledWorkflows();
      if (workflows.length === 0) { console.log("No bundled workflows found."); return true; }
      console.log(`Installing ${workflows.length} workflow(s)...`);
      let failures = 0;
      for (const wf of workflows) { try { await installWorkflow({ workflowId: wf }); console.log(`  ✓ ${wf}`); } catch (err) { console.log(`  ✗ ${wf}: ${err instanceof Error ? err.message : String(err)}`); failures++; } }
      if (failures > 0) {
        console.log(`${failures} of ${workflows.length} workflows failed to install`);
        process.exitCode = 1;
      }
      console.log(`\nDone. Start with: tamandua workflow run <name> "your task"`);
      return true;
    }
    const result = await installWorkflow({ workflowId: target });
    console.log(`Installed workflow: ${result.workflowId}\nAgent crons will start when a run begins.\n\nStart with: tamandua workflow run ${result.workflowId} "your task"`);
    return true;
  }

  if (action === "uninstall") {
    const force = args.includes("--force"); const isAll = target === "--all" || target === "all";
    const activeRuns = await checkActiveRuns(isAll ? undefined : target);
    if (activeRuns.length > 0 && !force) { process.stderr.write(`Cannot uninstall: ${activeRuns.length} active run(s):\n`); activeRuns.forEach(r => process.stderr.write(`  - ${r.id}: ${r.task}\n`)); process.exit(1); }
    if (isAll) { await uninstallAllWorkflows(); console.log("All workflows uninstalled."); } else { await uninstallWorkflow(target); console.log(`Uninstalled: ${target}`); }
    return true;
  }

  if (action === "run") {
    const workflowName = args[2];
    if (!workflowName) { process.stderr.write("Missing workflow name.\n"); process.exit(1); }

    let runArgs: ReturnType<typeof parseWorkflowRunArgs>;
    try {
      runArgs = parseWorkflowRunArgs(args.slice(3));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }

    if (!runArgs.taskTitle) { process.stderr.write("Missing task description.\n"); process.exit(1); }
    let harnessType: HarnessType | undefined;
    if (runArgs.harnessAs !== undefined) {
      harnessType = runArgs.harnessAs as HarnessType;
    }

    // TATR US-009: when this CLI is invoked inside a worker round, the
    // scheduler sets TAMANDUA_RUN_ID to the run that spawned the round.
    // Derive the parent linkage from it so child runs record which run
    // created them (persisted as runs.parent_run_id and carried on
    // run.started). Manual launches outside a run have no such env var
    // and stay parentless (parent_run_id NULL).
    const parentRunId = process.env.TAMANDUA_RUN_ID?.trim() || undefined;

    // MTLK-DSH-EXEC US-002: for a harness "dsh" Matchlock opt-in, capture the
    // FROZEN submission context (submitting HOME / DSH_HOME / cwd) HERE in the
    // submitting CLI process — run creation persists the resolved effective
    // DSH_HOME and never re-discovers it from the daemon HOME/env at dispatch.
    const isDshMatchlock = runArgs.matchlockImage !== undefined && harnessType === "dsh";
    const dshSubmission =
      isDshMatchlock && runArgs.matchlockImage !== undefined
        ? {
            homeDir: process.env.HOME && process.env.HOME.trim() !== "" ? process.env.HOME : os.homedir(),
            env: { DSH_HOME: process.env.DSH_HOME },
            cwd: process.cwd(),
          }
        : undefined;

    // MTLK-VM-SIZE US-003 / MTLK-SWAP US-008: resolve + validate the VM
    // resource limits at LAUNCH (flag > TAMANDUA_MATCHLOCK_* env >
    // host-derived default, all capped). The swap size rides the same
    // resolver: `--matchlock-no-swap` > `--matchlock-swap` >
    // TAMANDUA_MATCHLOCK_SWAP_MB (a size or `off`) > 8192. An invalid value
    // (including an out-of-range/invalid swap env value) exits non-zero BEFORE
    // runWorkflow creates any run row.
    let matchlockResourceLimits:
      | { cpus: number; memoryMB: number; diskSizeMB: number; swapMB: number }
      | undefined;
    if (runArgs.matchlockImage !== undefined) {
      try {
        const resolved = resolveMatchlockResourceLimits({
          cpus: runArgs.matchlockCpus,
          memoryMB: runArgs.matchlockMemory,
          diskSizeMB: runArgs.matchlockDisk,
          // MTLK-SWAP: raw `--matchlock-swap` value / `--matchlock-no-swap`
          // boolean; both are validated here before any run row exists.
          swapMB: runArgs.matchlockSwap,
          noSwap: runArgs.matchlockNoSwap,
          env: process.env,
        });
        matchlockResourceLimits = {
          cpus: resolved.cpus,
          memoryMB: resolved.memoryMB,
          diskSizeMB: resolved.diskSizeMB,
          // SHARED-V3 (MTLK-ISO-SLICE2 US-011): the resolved swap size (0 = off)
          // is persisted on the run's policy AND rendered as `swap=<n>MB|off`
          // on the combined launch line.
          swapMB: resolved.swapMB,
        };
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    }

    // SKILL-UX S3 (US-002/US-003): resolve the launch facts BEFORE
    // runWorkflow emits its synchronous `run #N ... created` stderr line.
    // Text mode prints them as the FIRST stdout lines; JSON mode folds them
    // into the single JSON document printed after the run row is created.
    // Resolution is best-effort (a fact that cannot be determined is
    // omitted, never a launch failure); runWorkflow still owns validation
    // errors and the existing exit codes.
    const launchInfo = await resolveWorkflowRunLaunchInfo({
      workflowId: workflowName,
      harnessType,
      workingDirectoryForHarness: runArgs.workingDirectoryForHarness,
      worktreeOriginRepository: runArgs.worktreeOriginRepository,
      worktreeOriginRef: runArgs.worktreeOriginRef,
    });
    // MTLK-VM-SIZE US-005: fuse the resolved Matchlock VM facts into the SAME
    // resolved-launch block the SKILL-UX lines use, so the `matchlock: <image>
    // cpus=… memory=…MB disk=…MB` line is printed exactly once, before the
    // synchronous `run #N ... created` line, and the same facts reach
    // `--json`. A fresh CLI opt-in persists exactly these launch-resolved
    // limits, so they are authoritative here; a rugpull REPLACEMENT (which
    // inherits the failed run's persisted policy) is launched by the daemon
    // and never re-emits this CLI launch block. The JSON path additionally
    // prefers the persisted admitted limits when runWorkflow reports them.
    if (launchInfo && runArgs.matchlockImage !== undefined && matchlockResourceLimits) {
      launchInfo.matchlockResources = {
        image: runArgs.matchlockImage,
        // SHARED-V3 (MTLK-ISO-SLICE2 US-011): the parser's REAL provenance
        // ("explicit" | "standard") drives the ` (standard image)` marker, and
        // the resolved swap size (0 = off) drives `swap=<n>MB|off` on the SAME
        // combined line. The line describes the resolved LAUNCH configuration;
        // the admitted pin is reported separately after admission succeeds.
        ...(runArgs.matchlockImageSource
          ? { imageSource: runArgs.matchlockImageSource }
          : {}),
        cpus: matchlockResourceLimits.cpus,
        memoryMB: matchlockResourceLimits.memoryMB,
        diskSizeMB: matchlockResourceLimits.diskSizeMB,
        swapMB: matchlockResourceLimits.swapMB,
        // MTLK-ALLOW-PRIVATE (US-006): show the launch-resolved (flag > env)
        // exception list in the SAME resolved-launch block. Omitted entirely
        // when empty so the line/JSON stay byte-identical for a run that
        // admitted no allow-private entries.
        ...(runArgs.matchlockAllowPrivate && runArgs.matchlockAllowPrivate.length > 0
          ? { allowPrivate: [...runArgs.matchlockAllowPrivate] }
          : {}),
      };
    }
    if (launchInfo && !runArgs.jsonFlag) {
      for (const line of formatWorkflowRunLaunchLines(launchInfo)) {
        console.log(line);
      }
    }

    const result = await runWorkflow({
      workflowId: workflowName,
      taskTitle: runArgs.taskTitle,
      workingDirectoryForHarness: runArgs.workingDirectoryForHarness,
      worktreeOriginRepository: runArgs.worktreeOriginRepository,
      worktreeOriginRef: runArgs.worktreeOriginRef,
      noHurrySaveTokensMode: runArgs.noHurrySaveTokensMode,
      noRelaunchUponRugpull: runArgs.noRelaunchUponRugpull,
      harnessType,
      workdirCollisionPolicy: runArgs.workdirCollisionPolicy,
      matchlockImage: runArgs.matchlockImage,
      // MTLK-ISO-SLICE1 SHARED-V3: the parser's REAL image provenance
      // ("explicit" | "standard") and the per-action root-usage override
      // consent reach run creation so the persisted v3 policy is truthful
      // (admission persists them; this slice adds no other behavior).
      matchlockImageSource: runArgs.matchlockImageSource,
      matchlockRootUsageOverride: runArgs.matchlockRootUsageOverride,
      matchlockHarness: runArgs.matchlockImage !== undefined && harnessType === "dsh" ? "dsh" : "pi",
      dshSubmission,
      matchlockResourceLimits,
      // ICEBOX Pillar B: the parsed pure-boolean privilege opt-out reaches
      // run creation, which resolves the effective setting (opt-out flag >
      // TAMANDUA_MATCHLOCK_NO_PRIVILEGED=1 > default ON) at submission and
      // threads the value + source into admission/persistence.
      matchlockNoPrivileged: runArgs.matchlockNoPrivileged,
      // MTLK-ALLOW-PRIVATE: the launch-resolved (flag > env) entry list reaches
      // run creation/admission, which persists it on the run's Matchlock policy.
      matchlockAllowPrivate: runArgs.matchlockAllowPrivate,
      context: runArgs.context,
      parentRunId,
    });

    // WORKDIR-FLAGS US-004: a refused harness-workdir collision is a distinct,
    // typed outcome. Render the daemon's actionable message (it already names
    // the holder and the three ways out) to stderr and exit with the dedicated
    // code — never the generic failure/status output. A refused run exits
    // before any --wait loop; a queued run still enters it.
    if (result.workdirRefused) {
      process.stderr.write(result.workdirRefused.message + "\n");
      process.exit(WORKDIR_REFUSAL_EXIT_CODE);
    }

    const stalenessWarning = checkCatalogStalenessWarning();
    if (stalenessWarning) {
      process.stderr.write(stalenessWarning + "\n");
    }
    if (result.captureWarnings) {
      for (const warning of result.captureWarnings) {
        process.stderr.write(warning + "\n");
      }
    }
    // MTLK-ISO-SLICE2 US-013: text mode prints the shared warnings channel to
    // stderr as bounded one-liners (JSON mode carries the same entries inside
    // its single stdout document instead).
    if (!runArgs.jsonFlag) {
      writeWorkflowWarningsToStderr(
        buildWorkflowWarnings({
          rootUsageConsent: result.matchlockRootUsageConsent === true,
        }),
      );
    }
    // Build wait args for post-run blocking, if --wait is set
    let waitArgs: string[] | null = null;
    if (runArgs.wait) {
      waitArgs = [result.runId];
      if (runArgs.jsonFlag) waitArgs.push("--json");
      if (runArgs.timeout) waitArgs.push("--timeout", runArgs.timeout);
    }

    // SKILL-UX S3 (US-003): --json emits ONE JSON document to stdout (the run
    // fields below plus the resolved launch facts, and the wait result merged
    // in when --wait is also given) instead of the human-readable Run: block.
    // Text mode keeps the resolved-launch block byte-identical for a native
    // run; an opted-in run additionally prints the admitted pin below.
    const runJson = runArgs.jsonFlag
      ? buildWorkflowRunJsonOutput(result, launchInfo)
      : undefined;

    if (!runJson) {
      // MTLK-ISO-SLICE2 US-011: the launch block prints BEFORE runWorkflow, so
      // the admitted pin can only be reported now, AFTER admission succeeded.
      // The DISTINCT `matchlock pinned:` prefix keeps the exactly-one
      // `matchlock:` line invariant intact. --json folds the digests into its
      // single post-creation document instead of emitting a text line.
      if (result.matchlockPin) {
        console.log(
          `matchlock pinned: digest=${result.matchlockPin.digest} config=${result.matchlockPin.configDigest}`,
        );
      }
      if (result.daemonWarning) {
        let dashboardLine = "";
        try {
          const port = readPort();
          dashboardLine = `\nDashboard: http://localhost:${port}/`;

        } catch {
          // can't read dashboard port
        }
        console.log(`Run: ${prefixRunId(result.runId)}\nWorkflow: ${result.workflowId}\nTask: ${result.taskTitle}\nRun created (pending admission); the reconciler will admit it when the control plane responds.`);
        console.log(`Check: tamandua workflow status run-${result.runId.slice(0, 8)}${dashboardLine}`);
      } else if (result.queuedBehindRunId) {
        // US-003: the harness working directory is held by another live run, so
        // registration returned a retriable 'waiting' admission (not a failure).
        // The run is registered and the reconciler admits it once the holder
        // releases the directory — exit 0 and explain the queue position.
        console.log(
          `Run: ${prefixRunId(result.runId)}\nWorkflow: ${result.workflowId}\nTask: ${result.taskTitle}\n` +
          `Queued behind run ${result.queuedBehindRunId}: harness workdir ${result.workingDirectoryForHarness} is held by that run. ` +
          `It will be admitted automatically when the holder releases it.`,
        );
        console.log(`Check: tamandua workflow status run-${result.runId.slice(0, 8)}`);
      } else {
        console.log(`Run: ${prefixRunId(result.runId)}\nWorkflow: ${result.workflowId}\nTask: ${result.taskTitle}\nStatus: ${result.status}\nHarness CWD: ${result.workingDirectoryForHarness}`);
      }
    }

    // WORKDIR-FLAGS US-004: when the caller explicitly allowed sharing (via the
    // flag or the TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR=1 env form), surface
    // exactly one uniform warning on stderr. A launch that never reached the
    // control plane (daemonWarning) did not actually share anything, so it is
    // skipped.
    if (runArgs.workdirCollisionPolicy === "allow" && !result.daemonWarning) {
      process.stderr.write(formatSharedWorkdirWarning(result.workingDirectoryForHarness) + "\n");
    }

    // If --wait, enter the wait loop for the newly created run. In JSON mode
    // the single stdout document is completed by the wait result (merged by
    // handleWait) so no text is emitted before it.
    if (waitArgs) {
      const exitCode = await handleWait(waitArgs, runJson);
      process.exitCode = exitCode;
    } else if (runJson) {
      console.log(JSON.stringify(runJson));
    }

    return true;
  }

  if (action === "status") {
    if (!target) { process.stderr.write("Missing query.\n"); process.exit(1); }
    const wrongPrefix = detectWrongPrefix(target, "run");
    if (wrongPrefix) { process.stderr.write(`${wrongPrefix}\n`); process.exit(1); }
    const jsonFlag = args.includes("--json");
    try {
      const result = getWorkflowStatus(target);
      if (jsonFlag) {
        // The union extracted this construction into buildWorkflowStatusJson()
        // (src/installer/status.ts) so the Matchlock host query service returns
        // byte-identical JSON. It carries every field main's inline block had,
        // including result.preclaimDeathCount (OUTAGE-ROUNDS SCLS US-006).
        const jsonOutput = buildWorkflowStatusJson(result);
        console.log(JSON.stringify(jsonOutput));
        return true;
      }
      // MTLK-ISO-SLICE2 US-013: text mode prints the shared warnings channel to
      // stderr as bounded one-liners; the JSON branch above carries the same
      // entries in the document instead.
      writeWorkflowWarningsToStderr(
        buildWorkflowWarnings({
          rootUsageConsent: result.matchlockRootUsageConsent === true,
        }),
      );
      console.log(`Run: ${prefixRunId(result.id)}\nWorkflow: ${result.workflowId}\nTask: ${result.task}\nStatus: ${result.status}`);
      // WORKDIR-QUEUE US-004: a run queued behind a busy harness workdir keeps
      // status 'running' with schedulingStatus 'waiting'. Print the stored
      // scheduling reason verbatim (e.g. "waiting for harness workdir held by
      // run <id>: <dir>") so the operator can tell waiting from dead.
      //
      // MTLK-ISO2-TRANSITION-CAS (Family C-1): the column is free-form, so the
      // line is allow-listed through the shared classifier — a legacy raw
      // parser fragment is dropped, never printed.
      const sanitizedSchedulingError = sanitizeSchedulingError(
        result.schedulingStatus,
        result.schedulingError,
      );
      if (result.schedulingStatus === "waiting" && sanitizedSchedulingError) {
        console.log(`Scheduling: ${sanitizedSchedulingError}`);
      }
      if (result.harnessType !== "pi") {
        const harnessLabel = result.harnessType === "dsh" ? "dsh (alpha)" : result.harnessType;
        console.log(`Harness: ${harnessLabel}`);
      }
      // MTLK-VM-SIZE US-004: show the resolved VM size for Matchlock runs using
      // the SAME formatter as the launch line so the two can never drift.
      //
      // MTLK-ISO-SLICE2 US-014 (four-state vocabulary): a non-NULL unusable
      // policy renders its bounded typed STATUS-UNUSABLE line (never native,
      // never a healthy isolated line); an intent-recorded run with a NULL
      // policy renders its bounded PREPARING/held line. Native runs print
      // neither (byte-identical).
      if (result.matchlockResources) {
        console.log(
          formatMatchlockResourceSummary(
            result.matchlockResources.image,
            result.matchlockResources,
            result.matchlockResources.allowPrivate,
          ),
        );
        // MTLK-ISO2-CORRECTIVE (F7 / spec C §4.6): the isolated status display
        // renders the resource line AND the persisted pinned digests. The
        // distinct `matchlock pinned:` prefix keeps the exactly-one
        // `matchlock:` line invariant intact.
        if (
          result.matchlockResources.imageDigest &&
          result.matchlockResources.imageConfigDigest
        ) {
          console.log(
            `matchlock pinned: digest=${result.matchlockResources.imageDigest} config=${result.matchlockResources.imageConfigDigest}`,
          );
        }
      } else if (result.matchlockPolicyError) {
        console.log(formatMatchlockPolicyUnusableStatusLine(result.matchlockPolicyError));
      } else if (result.matchlockState === "preparing") {
        console.log(MATCHLOCK_PREPARING_STATUS_LINE);
      }
      console.log(`Tokens: ${result.tokensSpent.toLocaleString()}`);
      if (result.redLedgerLanding) {
        // TIME-OUTPUT US-005: the human red-ledger line renders an ISO-Z
        // instant, never the raw stored value.
        const ledgerCreatedAt = formatInstant(result.redLedgerLanding.ledgerCreatedAt, { style: "iso" }) ?? "?";
        console.log(`Red-ledger landing: row ${result.redLedgerLanding.ledgerRowId}, exit ${result.redLedgerLanding.exitCode}, suite recorded ${ledgerCreatedAt}`);
      }
      if (result.ceilingExpiryCount > 0) console.log(`Rounds expired at ceiling: ${result.ceilingExpiryCount}`);
      if (result.workerLostCount > 0) console.log(`Worker lost: ${result.workerLostCount}`);
      // Instant-fail loop surfacing (DDTH): make the pathology visible
      // before it is fatal — K+ consecutive sub-threshold zero-output
      // nonzero-exit rounds mean the motor is backing off and heading for
      // force-fail escalation.
      if (result.instantFailCount >= getInstantFailBackoffThreshold()) {
        console.log(`Worker instant-fail loop: ${result.instantFailCount} consecutive sub-${Math.round(getInstantFailWallThresholdMs() / 1000)}s exit-1 rounds`);
      }
      // OUTAGE-ROUNDS (SCLS) US-006: mirror the instant-fail line for the slow
      // pre-claim death loop (rounds past the wall threshold that exit/die
      // without claiming), so the operator sees the escalation before the N cap.
      if (result.preclaimDeathCount >= getInstantFailBackoffThreshold()) {
        console.log(`Pre-claim deaths: ${result.preclaimDeathCount}`);
      }
      if (result.workspace_mode === "worktree") {
        console.log(`Workspace: ${result.workspace_mode}`);
        if (result.worktree_path) console.log(`Worktree: ${result.worktree_path}`);
        if (result.worktree_origin_ref) console.log(`Origin ref: ${result.worktree_origin_ref}`);
      }
      // Surface abandon reasons for failed runs
      if (result.status === "failed") {
        const aggregate = buildAbandonReasonAggregate(result.id);
        const hasRecords = !aggregate.includes("no per-story abandonment records found");
        if (hasRecords) {
          console.log(`Abandon reasons: ${aggregate}`);
        }
      }
      console.log(`Steps:`);
      for (const step of result.steps) {
        const ds = step.displayStatus;
        const icon = ds === "done" ? "  [done   ]" : ds === "running" ? "  [running]" : ds === "failed" ? "  [failed ]" : ds === "pending" ? "  [pending]" : ds === "verifying" ? "  [verify ]" : `  [${ds.padEnd(7)}]`;
        console.log(`${icon} ${prefixStepId(step.stepId)} (${step.agentId.split("_").slice(-1)[0]})`);
        if (step.status === "failed" && step.output) {
          console.log(`         ${step.output}`);
        }
      }
      // YSE US-005: stories listing with the presentation-only display
      // label. A story that a resume re-queued from FAILED shows as
      // 'pending (reset on resume, N prior failure[s])' — the stored status
      // stays 'pending', only the label differs.
      if (result.stories && result.stories.length > 0) {
        console.log(`Stories:`);
        for (const story of result.stories) {
          const label = displayStoryStatus({ status: story.status, resumeResetCount: story.resumeResetCount });
          console.log(`  ${story.storyId} [${label}] ${story.title}`);
        }
      }
      // IFLB US-004: a run that failed because the launch-time harness probe
      // failed prints its mechanical keyline block verbatim as the LAST
      // output — FAILURE_CLASS: harness_unavailable first, STDERR_TAIL last,
      // no prose after it. The block is read from the run's durable per-run
      // events (the probe round wrote it before force-failing), so it
      // renders even after a daemon/CLI restart. Runs without a probe
      // failure print nothing extra (output stays unchanged).
      if (result.status === "failed") {
        const probeBlock = readHarnessProbeFailureBlock(result.id);
        if (probeBlock) {
          console.log(probeBlock);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : `No run found matching "${target}".`;
      console.log(message.startsWith("No run found matching") ? `No run found matching "${target}".` : message);
    }
    return true;
  }

  if (action === "autoresearch") {
    if (!target) {
      process.stderr.write("Missing run-id.\nUsage: tamandua workflow autoresearch <run-id>\n");
      process.exit(1);
    }
    const wrongPrefix = detectWrongPrefix(target, "run");
    if (wrongPrefix) { process.stderr.write(`${wrongPrefix}\n`); process.exit(1); }
    printWorkflowAutoresearch(target);
    return true;
  }

  if (action === "wait") {
    // Shift args to remove the group+action prefix, keeping remaining args.
    // handleWait returns the exit code. Set it as the process exit code.
    const exitCode = await handleWait(args.slice(2));
    process.exitCode = exitCode;
    return true;
  }

  if (action === "delete") {
    if (!target) { process.stderr.write("Missing run-id.\nUsage: tamandua workflow delete <run-id> [--force]\n"); process.exit(1); }
    const wrongPrefix = detectWrongPrefix(target, "run");
    if (wrongPrefix) { process.stderr.write(`${wrongPrefix}\n`); process.exit(1); }
    const force = args.includes("--force");
    try {
      let fullId: string;
      try {
        fullId = getWorkflowStatus(target).id;
      } catch (err) {
        const message = err instanceof Error ? err.message : `No run found matching "${target}".`;
        process.stderr.write(message.startsWith("No run found matching") ? `No run found matching "${target}".\n` : `${message}\n`);
        process.exit(1);
      }
      const result = await deleteWorkflow(fullId, { force });
      console.log(`Deleted run run-${result.runId.slice(0, 8)}.`);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    return true;
  }



  if (action === "fail") {
    if (!target) { process.stderr.write("Missing run-id.\nUsage: tamandua workflow fail <run-id> --reason <text> [--force]\n"); process.exit(1); }

    const wrongPrefix = detectWrongPrefix(target, "run");
    if (wrongPrefix) { process.stderr.write(`${wrongPrefix}\n`); process.exit(1); }

    // Parse --reason and --force from args (skip group and action indices)
    const failArgs = args.slice(2);
    const reasonIdx = failArgs.indexOf("--reason");
    let failReason: string | undefined;
    if (reasonIdx !== -1 && reasonIdx + 1 < failArgs.length) {
      failReason = failArgs[reasonIdx + 1];
    }
    if (!failReason) {
      process.stderr.write("Missing --reason. Usage: tamandua workflow fail <run-id> --reason <text> [--force]\n");
      process.exit(1);
    }
    const forceFlag = failArgs.includes("--force");

    let fullId: string;
    let runStatus: string;
    try {
      const detail = getWorkflowStatus(target);
      fullId = detail.id;
      runStatus = detail.status;
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }

    if (runStatus !== "running" && runStatus !== "paused") {
      process.stderr.write(`Cannot force-fail run run-${fullId.slice(0, 8)}: status is "${runStatus}" (only running or paused runs can be force-failed).\n`);
      process.exit(1);
    }

    try {
      const result = await forceFailRun(fullId, failReason, forceFlag);
      if (!result.ok) {
        // Refused due to alive workers
        process.stderr.write(`${result.reason}\n`);
        if (result.aliveWorkers) {
          for (const w of result.aliveWorkers) {
            process.stderr.write(`  Step step-${w.stepId.slice(0, 8)} (${w.agentId}) PID ${w.pid}\n`);
          }
        }
        logger.warn(`forceFailRun refused: ${result.reason}`, { runId: fullId, aliveWorkers: result.aliveWorkers });
        process.exit(1);
      }
      console.log(`Force-failed run run-${fullId.slice(0, 8)}: ${failReason}`);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    return true;
  }

  if (action === "ensure-crons") {
    // Polling jobs are now tied to (runId, agentId) and admitted via the
    // daemon control plane. There is no longer a workflow-wide
    // "ensure-crons" notion — use `tamandua workflow run` instead
    // (which registers the new run with the daemon).
    process.stderr.write(
      "`workflow ensure-crons` is removed. Run-scoped scheduling makes it obsolete \u2014 " +
      "start a run with `tamandua workflow run <id> '<task>'`.\n",
    );
    process.exit(1);
  }

  // Unreachable — all known actions exit or return above. The unknown-action
  // guard before the target check ensures we never reach this point.
  return true;
}
