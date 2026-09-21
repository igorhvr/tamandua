---
name: tamandua-agents
description: Tamandua Matchlock guest worker helper (restricted surface). Use when running scheduled Matchlock workflow work inside a VM: claiming steps, executing the returned input, and reporting results through the guest helper CLI. This is the opt-in worker view of the tamandua-agents skill; the native skill stays untouched.
---

# Tamandua Agents — Matchlock guest worker view

This is the restricted skill that ships in the Matchlock read-only guest helper
pack at `/workspace/runtime`. The guest `tamandua` helper is NOT an
unrestricted Tamandua installation: it answers a small command surface for the
current run/invocation only and forwards step operations to the scoped host
broker. Anything else fails explicitly — do not attempt admin/DB fallbacks.

## Quick card — the 90% path

1. If instructed to check first: `tamandua step peek <agent-id> --run-id <run-id>`
   prints `HAS_WORK` or `NO_WORK` (optional for scheduled workers).
2. Claim with `tamandua step claim <agent-id> --run-id <run-id>`. If it prints
   `NO_WORK`, stop without doing step work. Otherwise save the returned
   `stepId` immediately, then execute the returned `input` work.
3. Write the required report and submit it with
   `tamandua step complete <step-id> --file <report>` (preferred) or via stdin.
4. Use `tamandua step current <agent-id> --run-id <run-id>` to recover a lost
   step id (prints the claim JSON or `NONE`).

## CRITICAL — STATUS line requirement (unchanged)

Your output is parsed by an automated scheduler looking for exact markers:

- Success starts with `STATUS: done` as its own plain-text line at column 0,
  followed by the role-specific `KEY:` lines this step must produce (omitting
  one forces a retry).
- `STATUS:` and `KEY:` lines are plain text — no bold, no backticks, no code
  fences, no leading bullets.
- On failure report `STATUS: failed` with a `REASON:` line.
- Report through the guest CLI. Printing a final chat message NEVER completes
  a step.
- `REJECTED` completions (submit-time validation failure) print to stderr with
  exit 1 and you STILL HOLD the step: fix the output and resubmit in the same
  round. Retain your report file until completion is accepted.

## Supported surface

- `tamandua version`, `tamandua --version`, `tamandua -v` — matching build
  version, answered locally.
- `tamandua --help`, `tamandua -h`, `tamandua help` — helper help.
- `tamandua skill-path` — real readable path to this skill file in the pack.
- `tamandua step peek|claim|current <agent-id> --run-id <run-id>`
- `tamandua step complete <step-id> [--file <path>]` — report from file or
  stdin. Paths resolve relative to your guest cwd; the guest helper reads the
  file itself and sends bounded content only. `STORIES_JSON_FILE: <path>` is
  dereferenced guest-side exactly like the native CLI.
- `tamandua step fail <step-id> [--reason-file <path>] [<reason>]`
- `tamandua step stories <run-id> [--json]` — bound-run story plan. With
  `--json`, prints the native object `{"runId":"run-…","stories":[…]}`; with
  no flag, prints the native human listing. Read-only, never completes/fails
  a step.
- `tamandua workflow status <run-id> --json` — native workflow status
  run-JSON for THIS run only. The human status display is not available on
  the restricted guest surface — always pass `--json`.
- `tamandua logs <run-id>` — bounded run-scoped activity for THIS run: the
  most recent run events rendered as native log lines (finite tail, never the
  whole event file). Prints `No events yet.` when the run has no events.
- `tamandua merge-branch --origin <repo> --branch <b> --into <t>
  --expect-tip <sha> --message <msg> [--run-id <run>]` — the authorized
  finalizer landing. The host broker type-checks the merger role, the live
  finalize_merge claim, the admitted original repository, the run's original
  target branch and the current authoritative tip BEFORE any Git runs. Only
  then does the guest execute the shared merge core with guest Git against the
  RW-mounted original. Output/exit codes are the native ones
  (`STATUS`/`MERGED_TREE`/`MERGED_COMMIT`/`NOOP`/`CHECKOUT_REFRESH`/`PARKED_*`;
  0 landed, 1 operational error, 2 target_moved, 3 conflicts). A refusal
  before authorization performs NO Git action — never bypass it with raw
  `git update-ref` on the origin.

Stories/status/logs are READ-ONLY and are served only for the run bound to
this invocation (`run-<uuid>` from your claim input). Asking for any other
run, a bare run number, or a global enumeration is refused — never try to
inspect other runs or the whole host event stream.

Respect the native argument contracts: prefixed ids (`run-…`, `step-…`) are
validated, `step complete` rejects positional report text, and stdout JSON /
`NO_WORK` / `NONE` output shapes are preserved.

## Explicitly unsupported (no host fallback)

- `step release`, workflow lifecycle commands other than `workflow status
  --json` (`workflow run/list/runs/install/uninstall/stop/pause/resume/
  delete/wait/fail`), dispatcher child runs, `logs-tail`, global log
  enumeration (`logs` with no run-id / `logs <N>` / `logs #<N>`),
  `source-path`, `update`/`install`/`uninstall`,
  daemon/control-plane and admin/operator actions or direct database access.
- The test-ledger shim (`tamandua-test`) is a REQUIRED later stage; do not
  fake ledger results. Report honestly if a required capability is missing.

## Keep the IDs straight

- Run ID: `run-<uuid>` — belongs in `--run-id` and workflow commands.
- Step ID: `step-<uuid>` — comes from the claim and belongs in
  `step complete` / `step fail`.
- Agent ID: the configured role identifier — belongs in
  `step peek/claim/current`; it is never a step ID.
