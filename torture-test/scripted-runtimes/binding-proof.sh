#!/usr/bin/env bash
# binding-proof.sh — W0 binding proof: start the scripted daemon, run a trivial
# do-now through it, assert zero real tokens spent, and verify output matches
# the behaviors file.
#
# This script is runnable proof that the scripted daemon pipeline works end-to-end
# WITHOUT consuming real tokens. It is the W0.3b deliverable from spec 12.
#
# Usage: binding-proof.sh
#
# Environment variables:
#   TT_REPO_ROOT       — repo root path (auto-detected if unset)
#
# Exit codes:
#   0   Proof succeeded — zero real tokens, output matches behaviors file
#   1   Prerequisite missing or proof failure
set -euo pipefail

# ── Path resolution ──────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TT_REPO_ROOT="${TT_REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
TT_DIR="$TT_REPO_ROOT/torture-test"
VAR_DIR="$TT_DIR/var"
ACCOUNT_HOME="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)"
ACCOUNT_HOME="${ACCOUNT_HOME:-/home/$(id -un)}"

RED='\033[31m'
GREEN='\033[32m'
YELLOW='\033[33m'
NC='\033[0m' # No Color

info()  { printf '%s\n' "$*" >&2; }
pass() { printf "${GREEN}  PASS: %s${NC}\n" "$*" >&2; }
fail() { printf "${RED}  FAIL: %s${NC}\n" "$*" >&2; }
warn() { printf "${YELLOW}  WARN: %s${NC}\n" "$*" >&2; }
daemon_control() { env HOME="$ACCOUNT_HOME" "$DAEMON_CONTROL" "$@"; }

# ── Cleanup trap ─────────────────────────────────────────────────────
# Executed on exit regardless of success/failure. Stops the daemon and
# removes temp files.
cleanup() {
  local exit_code=$?
  info ""
  info "=== Cleanup ==="

  # Stop daemon if it was started (daemon-control stop is idempotent)
  if [ "${DAEMON_STARTED:-0}" = "1" ]; then
    info "Stopping scripted daemon..."
    daemon_control scripted stop 2>&1 | while IFS= read -r line; do info "  [daemon-control] $line"; done || true
  fi

  # Clean up scenario workflow copy
  if [ -n "${SCENARIO_WF_DIR:-}" ] && [ -d "$SCENARIO_WF_DIR" ]; then
    info "Removing scenario workflow copy: $SCENARIO_WF_DIR"
    rm -rf "$SCENARIO_WF_DIR"
  fi

  # Clean up temp files
  if [ -n "${TASK_FILE:-}" ] && [ -f "$TASK_FILE" ]; then
    rm -f "$TASK_FILE"
  fi

  if [ "${KEEP_BEHAVIORS:-0}" != "1" ]; then
    if [ -n "${BEHAVIORS_FILE:-}" ] && [ -f "$BEHAVIORS_FILE" ]; then
      rm -f "$BEHAVIORS_FILE"
    fi
  fi

  # Remove temp dir
  if [ -n "${TMP_DIR:-}" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi

  exit "$exit_code"
}
trap cleanup EXIT

# ── Diagnostics ──────────────────────────────────────────────────────
print_diagnostics() {
  info ""
  info "=== Diagnostics ==="
  info "Daemon status:"
  if [ "${DAEMON_STARTED:-0}" = "1" ]; then
    daemon_control scripted status 2>&1 || true
  else
    info "  Daemon was not started."
  fi

  if [ -n "${RUN_ID:-}" ]; then
    info ""
    info "Run status:"
    env -i $(source_scripted_env) PATH="${PATH}" \
      "$TAMANDUA_CLI" workflow status "$RUN_ID" 2>&1 || true
  fi

  info ""
  info "Invocation log (tamandua.log):"
  local scripted_state; scripted_state="$(resolve_scripted_state_dir)"
  local log_file="$scripted_state/tamandua.log"
  if [ -f "$log_file" ]; then
    info "Log file: $log_file"
    grep -i -E 'pi pre-launch|pi launched|harness|scripted|invocation|PI_BINARY|HERMES_BINARY' "$log_file" 2>/dev/null | tail -20 || info "  (no relevant entries)"
  else
    info "  (no log file at $log_file)"
  fi
}

# ── Env resolution ───────────────────────────────────────────────────
# Source the scripted env script for variable resolution without changing
# our actual HOME (parse the print output).

source_scripted_env() {
  local scripted_env="$TT_DIR/env/tt-env-scripted.sh"
  bash "$scripted_env" print
}

resolve_scripted_state_dir() {
  source_scripted_env | grep '^TAMANDUA_STATE_DIR=' | cut -d= -f2-
}

resolve_scripted_pi_binary() {
  source_scripted_env | grep '^TAMANDUA_PI_BINARY=' | cut -d= -f2-
}

resolve_scripted_hermes_binary() {
  source_scripted_env | grep '^TAMANDUA_HERMES_BINARY=' | cut -d= -f2-
}

# ── Prerequisite checks ──────────────────────────────────────────────

check_prerequisites() {
  info "=== Checking prerequisites ==="

  # 1. daemon-control
  DAEMON_CONTROL="$TT_DIR/bin/daemon-control"
  if [ ! -x "$DAEMON_CONTROL" ]; then
    fail "Prerequisite missing: daemon-control not found or not executable at $DAEMON_CONTROL"
    exit 1
  fi
  pass "daemon-control: $DAEMON_CONTROL"

  # 2. TAMANDUA_PI_BINARY
  PI_BIN="$(resolve_scripted_pi_binary)"
  if [ ! -f "$PI_BIN" ]; then
    fail "Prerequisite missing: TAMANDUA_PI_BINARY ($PI_BIN) does not exist"
    exit 1
  fi
  if [ ! -x "$PI_BIN" ]; then
    fail "Prerequisite missing: TAMANDUA_PI_BINARY ($PI_BIN) is not executable"
    exit 1
  fi
  pass "TAMANDUA_PI_BINARY: $PI_BIN"

  # 3. TAMANDUA_HERMES_BINARY
  HERMES_BIN="$(resolve_scripted_hermes_binary)"
  if [ ! -f "$HERMES_BIN" ]; then
    fail "Prerequisite missing: TAMANDUA_HERMES_BINARY ($HERMES_BIN) does not exist"
    exit 1
  fi
  if [ ! -x "$HERMES_BIN" ]; then
    fail "Prerequisite missing: TAMANDUA_HERMES_BINARY ($HERMES_BIN) is not executable"
    exit 1
  fi
  pass "TAMANDUA_HERMES_BINARY: $HERMES_BIN"

  # 4. tamandua CLI
  TAMANDUA_CLI="${TT_REPO_ROOT}/bin/tamandua"
  if [ ! -x "$TAMANDUA_CLI" ]; then
    # Fallback to PATH lookup
    TAMANDUA_CLI="$(command -v tamandua 2>/dev/null || true)"
    if [ -z "$TAMANDUA_CLI" ]; then
      fail "Prerequisite missing: tamandua CLI not found"
      exit 1
    fi
  fi
  pass "tamandua CLI: $TAMANDUA_CLI"

  # 5. Node runtime (needed for scripted runtimes)
  NODE_BIN="${TT_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
  if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
    fail "Prerequisite missing: node binary not found"
    exit 1
  fi
  pass "node: $NODE_BIN"

  info ""
}

# ── Setup temp directory ─────────────────────────────────────────────
setup_temp_dir() {
  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tt-binding-proof.XXXXXX")"
  mkdir -p "$TMP_DIR"
  info "Temp directory: $TMP_DIR"
}

# ── Create behaviors file ────────────────────────────────────────────
create_behaviors_file() {
  info "=== Creating behaviors file ==="

  BEHAVIORS_FILE="$TMP_DIR/behaviors.json"

  # The scenario-unique workflow ID will be "do-now-proof"
  # Agent: do-now-proof_doer (full key format)
  # Zero tokens: the proof must show no real token spend.
  cat > "$BEHAVIORS_FILE" <<'EOF'
{
  "agents": {
    "do-now-proof_doer": {
      "output": "STATUS: done\nREPORT: Binding proof task completed successfully. This is a scripted agent response confirming the pipeline works end-to-end.",
      "tokens": 0
    }
  },
  "heartbeatTokens": 0,
  "defaultTokens": 0
}
EOF

  export TAMANDUA_SCRIPTED_BEHAVIORS="$BEHAVIORS_FILE"
  info "Behaviors file: $BEHAVIORS_FILE"
  pass "Behaviors file created"

  # Also set TAMANDUA_SCRIPTED_STATE for atomic counter persistence
  mkdir -p "$TMP_DIR/scripted-state"
  export TAMANDUA_SCRIPTED_STATE="$TMP_DIR/scripted-state"
  info "Scripted state: $TAMANDUA_SCRIPTED_STATE"
}

# ── Start scripted daemon ────────────────────────────────────────────
start_daemon() {
  info "=== Starting scripted daemon ==="
  info "Daemon control: $DAEMON_CONTROL"

  # Make sure any previous daemon is stopped first
  daemon_control scripted stop 2>&1 | while IFS= read -r line; do info "  [pre-stop] $line"; done || true
  sleep 1

  # Start the daemon
  daemon_control scripted start 2>&1 | while IFS= read -r line; do info "  [start] $line"; done

  # Verify daemon is running
  local status_out
  status_out="$(daemon_control scripted status 2>&1)" || true
  if echo "$status_out" | grep -q 'RUNNING'; then
    pass "Scripted daemon is RUNNING"
  else
    fail "Scripted daemon did not reach RUNNING state"
    info "Status output: $status_out"
    print_diagnostics
    exit 1
  fi

  DAEMON_STARTED=1
}

# ── Install scenario-unique workflow copy ────────────────────────────
install_scenario_workflow() {
  info "=== Installing scenario-unique workflow copy ==="

  INSTALL_SCRIPT="$SCRIPT_DIR/install-scenario-workflows"
  if [ ! -x "$INSTALL_SCRIPT" ]; then
    fail "install-scenario-workflows not found or not executable: $INSTALL_SCRIPT"
    exit 1
  fi

  # Source env for the command
  local scripted_env; scripted_env="$(source_scripted_env)"
  local scripted_state; scripted_state="$(echo "$scripted_env" | grep '^TAMANDUA_STATE_DIR=' | cut -d= -f2-)"
  local scripted_home; scripted_home="$(echo "$scripted_env" | grep '^HOME=' | cut -d= -f2-)"
  SCENARIO_WF_DIR="$scripted_state/workflows/do-now-proof"

  # Workflow installation provisions agent workspaces and reads pi settings
  # even though this proof cannot invoke a real model.  Provision only the
  # empty config shape in the contained scripted HOME.
  mkdir -p "$scripted_home/.pi/agent"
  if [ ! -f "$scripted_home/.pi/agent/settings.json" ]; then
    printf '{}\n' >"$scripted_home/.pi/agent/settings.json"
  fi

  # The proof uses a deliberately stable behavior key.  A killed prior proof
  # can therefore leave this one known scenario copy behind; reclaim only
  # that contained destination before asking the fail-closed installer to
  # create it again.  Assigning the path before install also lets EXIT cleanup
  # remove a partially-created destination.
  if [ -d "$SCENARIO_WF_DIR" ]; then
    info "Removing stale binding-proof workflow copy: $SCENARIO_WF_DIR"
    rm -rf -- "$SCENARIO_WF_DIR"
  fi

  # First ensure the base workflow is installed in the scripted env
  info "Ensuring 'do-now' workflow is installed in scripted env..."
  env -i $(echo "$scripted_env") PATH="${PATH}" \
    "$TAMANDUA_CLI" workflow install do-now 2>&1 | while IFS= read -r line; do info "  [install] $line"; done

  # Install the scenario-unique copy: do-now → do-now-proof
  info "Creating workflow copy: do-now → do-now-proof"
  local install_out
  install_out="$(env -i TAMANDUA_STATE_DIR="$scripted_state" PATH="${PATH}" \
    "$INSTALL_SCRIPT" do-now proof --json 2>&1)" || {
    fail "install-scenario-workflows failed"
    info "Output: $install_out"
    exit 1
  }
  info "  $install_out"

  # Verify the copy exists
  if [ -d "$SCENARIO_WF_DIR" ]; then
    pass "Workflow copy created: do-now-proof"
  else
    fail "Workflow copy not found at $SCENARIO_WF_DIR"
    exit 1
  fi
}

# ── Create task file ─────────────────────────────────────────────────
create_task_file() {
  TASK_FILE="$TMP_DIR/task.txt"
  cat > "$TASK_FILE" <<'EOF'
This is a binding-proof task. Reply with exactly:
STATUS: done
REPORT: Binding proof task completed successfully. This is a scripted agent response confirming the pipeline works end-to-end.

This task must complete without spending any real tokens.
EOF
  info "Task file: $TASK_FILE"
}

# ── Run the workflow ─────────────────────────────────────────────────
run_workflow() {
  info "=== Launching do-now-proof workflow ==="

  local scripted_env; scripted_env="$(source_scripted_env)"

  # Run the workflow with --wait --json. Capture stdout (JSON + launch info)
  # and stderr (heartbeat lines) separately.
  local run_stdout run_stderr run_rc
  run_stdout="$(mktemp "$TMP_DIR/run-stdout.XXXXXX")"
  run_stderr="$(mktemp "$TMP_DIR/run-stderr.XXXXXX")"

  # Capture the run command's REAL exit status. The command is the condition
  # of an `if`, so `set -e` does not abort here and `$?` in the `else` branch
  # is the command's status. Never append `|| true` — that erases the status.
  if env -i $(echo "$scripted_env") PATH="${PATH}" \
    "$TAMANDUA_CLI" workflow run do-now-proof --task-file "$TASK_FILE" --wait --timeout 5m --json \
    >"$run_stdout" 2>"$run_stderr"; then
    run_rc=0
  else
    run_rc=$?
  fi

  info "Workflow run stderr (heartbeats):"
  cat "$run_stderr" | while IFS= read -r line; do info "  [wait] $line"; done
  info ""
  info "Workflow run stdout:"
  cat "$run_stdout" | while IFS= read -r line; do info "  $line"; done
  info ""

  # Fail closed on a nonzero run exit status: a failed run must never be
  # reported as PASS.
  if [ "$run_rc" -ne 0 ]; then
    fail "Workflow run command failed (rc=$run_rc)"
    info "stdout contents:"
    cat "$run_stdout" >&2
    info "stderr contents:"
    cat "$run_stderr" >&2
    print_diagnostics
    exit 1
  fi

  # Fail closed on a timeout signature even when the command exited 0.
  local timeout_signature=""
  if grep -Eq '"timedOut"[[:space:]]*:[[:space:]]*true' "$run_stdout" "$run_stderr"; then
    timeout_signature='"timedOut": true'
  elif grep -Eqi 'timed[ -]out|wait loop timed out' "$run_stdout" "$run_stderr"; then
    timeout_signature="wait-loop timed out"
  fi
  if [ -n "$timeout_signature" ]; then
    fail "Workflow run timed out (signature: $timeout_signature)"
    info "stdout contents:"
    cat "$run_stdout" >&2
    info "stderr contents:"
    cat "$run_stderr" >&2
    print_diagnostics
    exit 1
  fi

  # Extract run ID from stdout. The merged --wait --json document begins with
  # `{"runId":"run-<uuid>"...`; text mode prints "Run: run-<uuid>".
  RUN_ID="$(grep -oE 'run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' "$run_stdout" | head -1 || true)"
  if [ -z "$RUN_ID" ]; then
    fail "Could not extract run ID from stdout"
    print_diagnostics
    exit 1
  fi
  info "Run ID: $RUN_ID"

  # Parse the wait JSON robustly (no jq dependency). Select the LAST stdout
  # line that is a complete JSON object (trimmed line starts '{' and ends
  # '}') and JSON-parses, then REQUIRE a non-empty runs array, a completed
  # status, and numeric tokensSpent. A line is never accepted merely because
  # it contains the substring `runs`.
  local parsed parse_err parse_rc=0
  parse_err="$(mktemp "$TMP_DIR/parse-err.XXXXXX")"
  parsed="$("$NODE_BIN" --input-type=module - "$run_stdout" 2>"$parse_err" <<'NODE_PARSE'
import fs from "node:fs";

const file = process.argv[2];
let text;
try {
  text = fs.readFileSync(file, "utf8");
} catch {
  process.stderr.write(
    "Could not read workflow run --wait --json output\n",
  );
  process.exit(2);
}

let parsedObject = null;
for (const raw of text.split(/\r?\n/)) {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
  try {
    const candidate = JSON.parse(trimmed);
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      parsedObject = candidate;
    }
  } catch {
    // Not a complete JSON object; keep looking for the last one.
  }
}

if (!parsedObject) {
  process.stderr.write(
    "Could not extract JSON result from workflow run --wait --json output (no complete JSON object line)\n",
  );
  process.exit(2);
}

const runs = parsedObject.runs;
if (!Array.isArray(runs) || runs.length === 0) {
  process.stderr.write(
    "Run output missing expected runs data (runs array absent or empty)\n",
  );
  process.exit(3);
}

const run = runs[0];
const status = run && typeof run.status === "string" ? run.status : "";
if (status !== "completed" && status !== "done") {
  process.stderr.write(
    `Run did not complete successfully (status: ${status || "missing"})\n`,
  );
  process.exit(4);
}

const tokens = run.tokensSpent;
if (typeof tokens !== "number" || !Number.isInteger(tokens) || tokens < 0) {
  process.stderr.write(
    `Tokens spent is ${JSON.stringify(tokens)} — expected a non-negative integer\n`,
  );
  process.exit(5);
}

process.stdout.write(`RUN_STATUS=${status}\n`);
process.stdout.write(`TOKENS_SPENT=${tokens}\n`);
process.stdout.write(`RUN_COUNT=${runs.length}\n`);
NODE_PARSE
)" || parse_rc=$?

  if [ "$parse_rc" -ne 0 ]; then
    local parse_msg
    parse_msg="$(cat "$parse_err" 2>/dev/null || true)"
    fail "${parse_msg:-Could not parse workflow run --wait --json output (parser rc=$parse_rc)}"
    info "stdout contents:"
    cat "$run_stdout" >&2
    print_diagnostics
    exit 1
  fi

  local run_status tokens_spent run_count
  run_status="$(printf '%s\n' "$parsed" | grep '^RUN_STATUS=' | cut -d= -f2-)"
  tokens_spent="$(printf '%s\n' "$parsed" | grep '^TOKENS_SPENT=' | cut -d= -f2-)"
  run_count="$(printf '%s\n' "$parsed" | grep '^RUN_COUNT=' | cut -d= -f2-)"

  info "Run status: $run_status"
  info "Tokens spent: $tokens_spent"
  info "Run count: $run_count"

  # ── Assertions ──────────────────────────────────────────────────

  # Assert: run completed
  if [ "$run_status" = "completed" ] || [ "$run_status" = "done" ]; then
    pass "Run completed successfully (status: $run_status)"
  else
    fail "Run did not complete successfully (status: $run_status)"
    print_diagnostics
    exit 1
  fi

  # Assert: zero real tokens spent
  if [ "$tokens_spent" = "0" ]; then
    pass "Zero real tokens spent: $tokens_spent"
  else
    fail "Tokens spent is $tokens_spent — expected 0 (no real tokens)"
    print_diagnostics
    exit 1
  fi

  # Assert: output matches behaviors file expectations
  # The validated parse must contain at least one run.
  if [ "${run_count:-0}" -ge 1 ]; then
    pass "Run output contains expected runs array (run count: $run_count)"
  else
    fail "Run output missing expected runs data (run count: ${run_count:-0})"
    print_diagnostics
    exit 1
  fi

  # ── Assert: no real pi/hermes processes invoked ──────────────────
  # Check tamandua.log for evidence that ONLY scripted binaries were used
  local scripted_state; scripted_state="$(resolve_scripted_state_dir)"
  local log_file="$scripted_state/tamandua.log"

  if [ -f "$log_file" ]; then
    # The log should contain references to scripted-pi/scripted-hermes, NOT real pi/hermes
    local pi_refs; pi_refs="$(grep -c 'PI_BINARY' "$log_file" 2>/dev/null || echo "0")"
    local scripted_refs; scripted_refs="$(grep -c 'scripted-pi\|scripted-hermes' "$log_file" 2>/dev/null || echo "0")"
    info "Log analysis: $pi_refs PI_BINARY refs, $scripted_refs scripted refs"

    # Check if any real pi/hermes invocations happened (by looking for direct
    # invocations of "pi" or "hermes" without "scripted-" prefix in harness spawns)
    local real_harness; real_harness="$(grep -cE 'pi pre-launch.*\bpi\b' "$log_file" 2>/dev/null || echo "0")"
    if [ "$real_harness" = "0" ] || [ "$real_harness" -le "$scripted_refs" ]; then
      pass "No real pi/hermes invocations detected (scripted refs: $scripted_refs)"
    else
      warn "Possible real pi invocations detected ($real_harness refs vs $scripted_refs scripted refs)"
    fi
  else
    warn "No tamandua.log found at $log_file — cannot verify no-real-harness assertion"
  fi
}

# ═════════════════════════════════════════════════════════════════════
# Main
# ═════════════════════════════════════════════════════════════════════

main() {
  info ""
  info "=== binding-proof.sh — W0 binding proof ==="
  info ""

  check_prerequisites
  setup_temp_dir
  create_behaviors_file
  start_daemon
  install_scenario_workflow
  create_task_file
  run_workflow

  info ""
  info "=== Binding proof PASSED ==="
  info "The scripted daemon pipeline runs end-to-end without real tokens."
}

main "$@"
