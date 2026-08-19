#!/usr/bin/env bash
# MACP3 US-004 note: this harness's '/proc' mentions (prose describing the OLD
# /proc/port + /proc scan resolution that RECORDED provenance replaced) are
# linux-only documentation — no runtime procfs access in this file, so nothing
# is reachable-as-runtime on Darwin. '/proc' substrings of "process" (e.g.
# exact-key/process evidence) are the word, not the procfs mount.
set -euo pipefail

# E2.5 US-004 controller preflight wiring is covered by the dedicated
# tt-controller-preflight.test.sh (which exercises the real preflight chain).
# This unit-style regression suite simulates real launches with a stub
# `tamandua` and has tight timing windows (scheduler/resume/interruption); it
# does NOT set up or inspect the contained real daemon. Disable the real-case
# preflight here so these tests keep their exact prior behavior — fast,
# daemon-free, no timing regressions. Real deployments leave it unset.
export TT_CONTROLLER_PREFLIGHT_DISABLED=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TT_DIR="$(dirname "$SCRIPT_DIR")"
CONTROLLER="$SCRIPT_DIR/tt-controller"
SCHEMA="$TT_DIR/cases/case.schema.json"
CASES="$TT_DIR/cases/cases.jsonl"
mkdir -p "$TT_DIR/var"
TEST_ROOT="$(mktemp -d "$TT_DIR/var/tt-controller-test.XXXXXX")"
DANGLING_LINK=""
ESCAPED_CWD=""
INTERRUPTION_PID=""
INTERRUPTION_CONTROLLER_PID=""
O9_CONTROL_PID=""
O9_EVENTS_PATH=""
O9_EVENTS_BACKUP=""
O9_GOLDEN_BARE=""
FAKE_HARNESS_PID=""
DECOY_PID=""
CHAOS_TARGETS_FILE=""
DAEMON_CONTROL_ORIGINAL_HASH="$(sha256sum "$TT_DIR/bin/daemon-control" | cut -d' ' -f1)"
SMOKE_GOLDENS=()
ORACLE_TEST_FILES=()
DISCOVERY_DB=""
DISCOVERY_DB_BACKUP=""
DISCOVERY_DB_WAL_BACKUP=""
DISCOVERY_DB_SHM_BACKUP=""
WORKFLOW_REAL_DB=""
WORKFLOW_REAL_DB_BACKUP=""
WORKFLOW_REAL_DB_WAL_BACKUP=""
WORKFLOW_REAL_DB_SHM_BACKUP=""
DISCOVERY_EVENT_ARCHIVE=""
DISCOVERY_EVENTS_DIR=""
DISCOVERY_EVENTS_BACKUP_DIR=""
# E3.C US-008: the chaos runner's stub operator appends to the shared
# var/chaos/chaos.log (the oracle snapshot's chaos_log source); back it up
# before the chaos fixtures and restore in cleanup so the shared file is
# byte-identical afterward (hygiene — the run.sh clean-tree guard ignores
# gitignored var/, but sibling suites read chaos.log).
CHAOS_LOG_FILE="$TT_DIR/var/chaos/chaos.log"
CHAOS_LOG_BACKUP="$TEST_ROOT/original-chaos.log"
CAMPAIGN_DIRS_FILE="$TEST_ROOT/campaign-dirs"
HOST_PROFILE="$TT_DIR/var/w0/host-profile.json"
HOST_PROFILE_BACKUP="$TEST_ROOT/original-host-profile.json"
: > "$CAMPAIGN_DIRS_FILE"
mkdir -p "$(dirname "$HOST_PROFILE")"
if [ -f "$HOST_PROFILE" ]; then cp "$HOST_PROFILE" "$HOST_PROFILE_BACKUP"; fi
cleanup() {
  if [ -n "$O9_CONTROL_PID" ]; then
    kill -9 "$O9_CONTROL_PID" 2>/dev/null || true
    wait "$O9_CONTROL_PID" 2>/dev/null || true
  fi
  # E3.C.1 US-003: never leak the chaos decoy / recorded fake-harness
  # processes across tests (they are own-group sleepers under var/).
  if [ -n "$DECOY_PID" ]; then
    kill -9 "$DECOY_PID" 2>/dev/null || true
    wait "$DECOY_PID" 2>/dev/null || true
  fi
  if [ -n "$FAKE_HARNESS_PID" ]; then
    kill -9 "$FAKE_HARNESS_PID" 2>/dev/null || true
    wait "$FAKE_HARNESS_PID" 2>/dev/null || true
  fi
  if [ -n "$CHAOS_TARGETS_FILE" ]; then
    rm -f -- "$CHAOS_TARGETS_FILE"
  fi
  if [ -n "$O9_EVENTS_PATH" ]; then
    rm -f -- "$O9_EVENTS_PATH"
    if [ -f "$O9_EVENTS_BACKUP" ]; then mv "$O9_EVENTS_BACKUP" "$O9_EVENTS_PATH"; fi
  fi
  if [ -n "$O9_GOLDEN_BARE" ]; then
    git --git-dir "$O9_GOLDEN_BARE" update-ref -d refs/heads/seed/o9-controller-special 2>/dev/null || true
  fi
  if [ -n "$INTERRUPTION_CONTROLLER_PID" ]; then
    kill -9 "$INTERRUPTION_CONTROLLER_PID" 2>/dev/null || true
  fi
  if [ -n "$INTERRUPTION_PID" ]; then
    kill -9 "$INTERRUPTION_PID" 2>/dev/null || true
    wait "$INTERRUPTION_PID" 2>/dev/null || true
  fi
  if [ "${#SMOKE_GOLDENS[@]}" -gt 0 ]; then
    rm -rf -- "${SMOKE_GOLDENS[@]+"${SMOKE_GOLDENS[@]}"}"
  fi
  if [ "${#ORACLE_TEST_FILES[@]}" -gt 0 ]; then
    rm -f -- "${ORACLE_TEST_FILES[@]+"${ORACLE_TEST_FILES[@]}"}"
  fi
  if [ -n "$DISCOVERY_DB" ]; then
    rm -f -- "$DISCOVERY_DB" "$DISCOVERY_DB-wal" "$DISCOVERY_DB-shm"
    if [ -n "$DISCOVERY_DB_BACKUP" ] && [ -f "$DISCOVERY_DB_BACKUP" ]; then
      mkdir -p "$(dirname "$DISCOVERY_DB")"
      mv "$DISCOVERY_DB_BACKUP" "$DISCOVERY_DB"
    fi
    if [ -n "$DISCOVERY_DB_WAL_BACKUP" ] && [ -f "$DISCOVERY_DB_WAL_BACKUP" ]; then
      mv "$DISCOVERY_DB_WAL_BACKUP" "$DISCOVERY_DB-wal"
    fi
    if [ -n "$DISCOVERY_DB_SHM_BACKUP" ] && [ -f "$DISCOVERY_DB_SHM_BACKUP" ]; then
      mv "$DISCOVERY_DB_SHM_BACKUP" "$DISCOVERY_DB-shm"
    fi
  fi
  if [ -n "$DISCOVERY_EVENTS_DIR" ]; then
    rm -f -- "$DISCOVERY_EVENTS_DIR/all.jsonl" "$DISCOVERY_EVENTS_DIR/all.jsonl.1" \
      "$DISCOVERY_EVENTS_DIR/all.jsonl.2" "$DISCOVERY_EVENTS_DIR/all.jsonl.3"
    for archived_event in "$DISCOVERY_EVENTS_BACKUP_DIR"/all.jsonl*; do
      [ -e "$archived_event" ] || continue
      mkdir -p "$DISCOVERY_EVENTS_DIR"
      mv "$archived_event" "$DISCOVERY_EVENTS_DIR/$(basename "$archived_event")"
    done
  fi
  if [ -n "$WORKFLOW_REAL_DB" ]; then
    rm -f -- "$WORKFLOW_REAL_DB" "$WORKFLOW_REAL_DB-wal" "$WORKFLOW_REAL_DB-shm"
    if [ -f "$WORKFLOW_REAL_DB_BACKUP" ]; then mv "$WORKFLOW_REAL_DB_BACKUP" "$WORKFLOW_REAL_DB"; fi
    if [ -f "$WORKFLOW_REAL_DB_WAL_BACKUP" ]; then mv "$WORKFLOW_REAL_DB_WAL_BACKUP" "$WORKFLOW_REAL_DB-wal"; fi
    if [ -f "$WORKFLOW_REAL_DB_SHM_BACKUP" ]; then mv "$WORKFLOW_REAL_DB_SHM_BACKUP" "$WORKFLOW_REAL_DB-shm"; fi
  fi
  if [ -f "$CHAOS_LOG_BACKUP" ]; then
    cp "$CHAOS_LOG_BACKUP" "$CHAOS_LOG_FILE"
  else
    rm -f -- "$CHAOS_LOG_FILE"
  fi
  while IFS= read -r campaign_dir; do
    case "$campaign_dir" in
      "$TT_DIR/var/results/"*) rm -rf -- "$campaign_dir" ;;
    esac
  done < "$CAMPAIGN_DIRS_FILE"
  if [ -f "$HOST_PROFILE_BACKUP" ]; then
    cp "$HOST_PROFILE_BACKUP" "$HOST_PROFILE"
  else
    rm -f -- "$HOST_PROFILE"
  fi
  rm -rf -- "$TEST_ROOT"
  if [ -n "$DANGLING_LINK" ]; then rm -f -- "$DANGLING_LINK"; fi
  if [ -n "$ESCAPED_CWD" ]; then rm -rf -- "$ESCAPED_CWD"; fi
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'PASS: %s\n' "$1"
}

# bash 3.2 (macOS /bin/bash 3.2.57) lacks the case-modifying parameter
# expansions (uppercase-all / lowercase-all are bash 4+); the test's few
# uses are converted to tr(1), which is portable everywhere.
toupper() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]'; }
tolower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# Most historical self-test cases inspect persisted evidence for deliberately
# red or infrastructure outcomes. Accept launcher verdicts 1/2 here only when
# the controller reached a recorded campaign; dedicated verdict tests below
# invoke the controller directly and assert the real process status.
run_recorded_campaign() {
  local output
  local status
  set +e
  output=$("$@" 2>&1)
  status=$?
  set -e
  printf '%s\n' "$output"
  if [ "$status" -le 2 ] && printf '%s\n' "$output" | grep -Fq 'Campaign: '; then
    return 0
  fi
  return "$status"
}

remember_campaign() {
  local output="$1"
  local campaign_id
  campaign_id="$(printf '%s\n' "$output" | sed -n 's/^Campaign: //p' | tail -1)"
  [ -n "$campaign_id" ] || fail "controller output did not identify its campaign: $output"
  printf '%s/%s\n' "$TT_DIR/var/results" "$campaign_id" >> "$CAMPAIGN_DIRS_FILE"
  printf '%s' "$campaign_id"
}

expect_usage_error() {
  local name="$1"
  shift
  local output
  local status
  set +e
  output=$("$CONTROLLER" "$@" 2>&1)
  status=$?
  set -e
  [ "$status" -eq 4 ] || fail "$name exited $status instead of 4: $output"
  printf '%s' "$output" | grep -Fq 'Usage: tt-controller' || fail "$name did not print usage: $output"
  pass "$name"
}

valid_case() {
  local id="$1"
  printf '%s\n' "{\"id\":\"$id\",\"wave\":3,\"workflow\":\"bug-fix-merge-worktree\",\"fixture\":\"tt-ts\",\"harness\":\"hermes\",\"task\":\"tasks/W3.07.md\",\"context\":{},\"caps\":{\"tokens\":4000000,\"wall_min\":240},\"requires\":{\"toolchains\":[\"node\"]},\"boundary_files\":[\"fixtures/tt-ts/src\"],\"forbidden\":[],\"oracles\":[\"TT-MISSING-O1\",\"TT-MISSING-O2\"],\"gates\":[\"W2\"],\"chaos\":null,\"shed_ok\":false,\"mandatory\":true,\"class\":\"verification\"}"
}

write_local_case() {
  local manifest="$1"
  local id="$2"
  local execution_mode="$3"
  local reset_exit="$4"
  local command_exit="$5"
  local shell_sentinel="$6"
  node --input-type=module - "$manifest" "$id" "$execution_mode" "$reset_exit" "$command_exit" "$shell_sentinel" <<'NODE'
import fs from 'node:fs';
const [manifest, id, executionMode, resetExit, commandExit, shellSentinel] = process.argv.slice(2);
const record = {
  id, wave: 0, workflow: 'local', fixture: 'none', harness: 'local',
  task: 'tasks/W3.07.md', context: { execution_mode: executionMode },
  caps: { tokens: 0, wall_min: 5 }, requires: {}, boundary_files: [], forbidden: [],
  oracles: [], gates: [], chaos: null, shed_ok: false, mandatory: true, class: 'verification',
  reset: {
    executable: 'node',
    args: ['-e', `console.log(JSON.stringify({hook:'reset',home:process.env.HOME,state:process.env.TAMANDUA_STATE_DIR,control:process.env.TAMANDUA_CONTROL_PORT,mcp:process.env.TAMANDUA_MCP_PORT,dashboard:process.env.TAMANDUA_DASHBOARD_PORT,pi:process.env.TAMANDUA_PI_BINARY??null,hermes:process.env.TAMANDUA_HERMES_BINARY??null,db:process.env.TAMANDUA_DB_PATH??null,worktrees:process.env.TAMANDUA_WORKTREE_ROOT??null,worker:process.env.TAMANDUA_WORKER_PID??null,run:process.env.TAMANDUA_RUN_ID??null,ttPoison:process.env.TT_OPERATOR_POISON??null,hermesPoison:process.env.HERMES_OPERATOR_POISON??null,arg:process.argv[1]}));console.error('reset stderr');process.exit(${Number(resetExit)})`, `;touch ${shellSentinel}`],
    cwd: '.',
  },
  command: {
    executable: 'node',
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(`${shellSentinel}.command-ran`)},'ran');console.log(JSON.stringify({hook:'command',home:process.env.HOME,state:process.env.TAMANDUA_STATE_DIR,control:process.env.TAMANDUA_CONTROL_PORT,mcp:process.env.TAMANDUA_MCP_PORT,dashboard:process.env.TAMANDUA_DASHBOARD_PORT,pi:process.env.TAMANDUA_PI_BINARY??null,hermes:process.env.TAMANDUA_HERMES_BINARY??null,db:process.env.TAMANDUA_DB_PATH??null,worktrees:process.env.TAMANDUA_WORKTREE_ROOT??null,worker:process.env.TAMANDUA_WORKER_PID??null,run:process.env.TAMANDUA_RUN_ID??null,ttPoison:process.env.TT_OPERATOR_POISON??null,hermesPoison:process.env.HERMES_OPERATOR_POISON??null,arg:process.argv[1]}));console.error('command stderr');process.exit(${Number(commandExit)})`, `;touch ${shellSentinel}`],
    cwd: '.',
  },
};
fs.writeFileSync(manifest, `${JSON.stringify(record)}\n`);
NODE
}

write_local_predicate_case() {
  local manifest="$1"
  local id="$2"
  node --input-type=module - "$manifest" "$id" <<'NODE'
import fs from 'node:fs';
const [manifest, id] = process.argv.slice(2);
const record = {
  id, wave: 0, workflow: 'local', fixture: 'none', harness: 'local',
  task: 'tasks/W3.07.md', context: { execution_mode: 'scripted' },
  caps: { tokens: 0, wall_min: 5 }, requires: { platform: 'darwin' },
  boundary_files: [], forbidden: [], oracles: [], gates: [], chaos: null,
  shed_ok: false, mandatory: true, class: 'verification',
  command: { executable: 'node', args: ['-e', 'process.exit(0)'], cwd: '.' },
};
fs.writeFileSync(manifest, `${JSON.stringify(record)}\n`);
NODE
}

# MACP3 US-006: local-harness case with an ARBITRARY requires object. APENDS to
# the manifest (truncate with ': > "$manifest"' first for a single-case file)
# so a mixed manifest can be built with repeated calls. The command exits 0, so
# a valid profile + satisfied predicates must let the case EXECUTE (PASS); a
# fail-closed host-profile block is detected by the case never reaching a
# command outcome.
write_local_requires_case() {
  local manifest="$1"
  local id="$2"
  local requires_json="$3"
  node --input-type=module - "$manifest" "$id" "$requires_json" <<'NODE'
import fs from 'node:fs';
const [manifest, id, requiresJson] = process.argv.slice(2);
const record = {
  id, wave: 0, workflow: 'local', fixture: 'none', harness: 'local',
  task: 'tasks/W3.07.md', context: { execution_mode: 'scripted' },
  caps: { tokens: 0, wall_min: 5 }, requires: JSON.parse(requiresJson),
  boundary_files: [], forbidden: [], oracles: [], gates: [], chaos: null,
  shed_ok: false, mandatory: true, class: 'verification',
  command: { executable: 'node', args: ['-e', 'process.exit(0)'], cwd: '.' },
};
fs.appendFileSync(manifest, `${JSON.stringify(record)}\n`);
NODE
}

write_scheduler_manifest() {
  local manifest="$1"
  local event_log="$2"
  local count="$3"
  local duration_ms="$4"
  node --input-type=module - "$manifest" "$event_log" "$count" "$duration_ms" "$TT_DIR/var/results" <<'NODE'
import fs from 'node:fs';
const [manifest, eventLog, countText, durationText, resultsRoot] = process.argv.slice(2);
const records = [];
for (let index = 1; index <= Number(countText); index += 1) {
  const id = `SCHEDULE-${index}`;
  const command = `
    const fs = require('node:fs');
    const path = require('node:path');
    const [eventLog, id, durationText, resultsRoot] = process.argv.slice(1);
    const states = fs.readdirSync(resultsRoot, {withFileTypes:true})
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(resultsRoot, entry.name, 'state.json'))
      .filter(file => fs.existsSync(file))
      .map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
    const item = states.flatMap(state => state.cases)
      .find(candidate => candidate.id === id && candidate.phase === 'running');
    const attempt = item?.attempts?.[0];
    if (!attempt || attempt.phase !== 'running' || !attempt.launch_intent_at || !attempt.command?.started_at) {
      process.exit(41);
    }
    fs.appendFileSync(eventLog, JSON.stringify({id, event:'start', at:Date.now()}) + '\\n');
    setTimeout(() => {
      fs.appendFileSync(eventLog, JSON.stringify({id, event:'end', at:Date.now()}) + '\\n');
    }, Number(durationText));
  `;
  records.push({
    id, wave: 0, workflow: 'local', fixture: 'none', harness: 'local',
    task: 'tasks/W3.07.md', context: { execution_mode: 'real' },
    caps: { tokens: 0, wall_min: 5 }, requires: {}, boundary_files: [], forbidden: [],
    oracles: [], gates: [], chaos: null, shed_ok: false, mandatory: true, class: 'verification',
    command: { executable: 'node', args: ['-e', command, eventLog, id, durationText, resultsRoot], cwd: '.' },
  });
}
fs.writeFileSync(manifest, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
NODE
}

write_satisfying_host_profile() {
  cat > "$HOST_PROFILE" <<'JSON'
{
  "platform": {"os": "linux", "label": "linux"},
  "containment": {"systemdUserScope": true, "procfs": true},
  "toolchains": {
    "node": {"present": true, "buildPassed": true, "testPassed": true}
  },
  "nodeRuntimes": [
    {"version": "v24.0.0", "major": 24, "sqliteAvailable": true}
  ]
}
JSON
}

expect_rejected() {
  local name="$1"
  local manifest="$2"
  local expected="$3"
  local output
  local status
  set +e
  output=$("$CONTROLLER" --manifest "$manifest" 2>&1)
  status=$?
  set -e
  [ "$status" -eq 2 ] || fail "$name exited $status instead of 2: $output"
  printf '%s' "$output" | grep -Fq "$expected" || fail "$name did not report '$expected': $output"
  pass "$name"
}

# MACP3 US-006: fail-closed predicate semantics contract check. A missing or
# invalid host profile (while a SELECTED case carries `requires`) must NOT
# abort the campaign and must NOT silently degrade into all-predicates-false
# NOT_RUN(predicate) skips — instead the campaign is still created, every
# predicate-bound selected case is terminal TEST_INFRA_FAIL with
# reason.category='host-profile-missing' and the underlying load error in
# reason.message, and verdictExitCode forces RED/INFRA (exit 2). This helper
# asserts that exact contract and registers the campaign dir for cleanup.
run_fail_closed_profile_campaign() {
  local name="$1"
  local manifest="$2"
  local output
  local status
  local campaign_id
  local state_path
  local report_txt
  set +e
  output=$("$CONTROLLER" --manifest "$manifest" 2>&1)
  status=$?
  set -e
  [ "$status" -eq 2 ] || fail "$name exited $status instead of 2 (INFRA): $output"
  campaign_id=$(printf '%s\n' "$output" | sed -n 's/^Campaign: //p' | tail -1)
  [ -n "$campaign_id" ] || fail "$name did not create a campaign (aborted?): $output"
  state_path="$TT_DIR/var/results/$campaign_id/state.json"
  report_txt="$TT_DIR/var/results/$campaign_id/report.txt"
  [ -f "$state_path" ] || fail "$name campaign missing state.json: $output"
  printf '%s/%s\n' "$TT_DIR/var/results" "$campaign_id" >> "$CAMPAIGN_DIRS_FILE"
  node --input-type=module - "$state_path" <<'NODE' || fail "$name host-profile-missing contract violated"
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const item = state.cases[0];
if (item.phase !== 'terminal' || item.outcome !== 'TEST_INFRA_FAIL') {
  throw new Error(`predicate-bound case is not terminal TEST_INFRA_FAIL: ${JSON.stringify({id:item.id,phase:item.phase,outcome:item.outcome,reason:item.reason})}`);
}
if (item.outcome === 'NOT_RUN' && item.reason?.category === 'predicate') {
  throw new Error(`vacuously skipped as NOT_RUN(predicate): ${JSON.stringify(item.reason)}`);
}
if (item.reason?.category !== 'host-profile-missing') {
  throw new Error(`infra reason is not host-profile-missing: ${JSON.stringify(item.reason)}`);
}
if (typeof item.reason?.message !== 'string' || !/cannot load required host profile/.test(item.reason.message)) {
  throw new Error(`host-profile-missing reason must carry the underlying load error: ${JSON.stringify(item.reason)}`);
}
NODE
  [ -f "$report_txt" ] || fail "$name campaign missing report.txt: $output"
  grep -Fq 'INFRA FAILURES' "$report_txt" || fail "$name report does not surface the INFRA FAILURES section"
  grep -Fq 'INFRA_FAILURE (exit 2)' "$report_txt" || fail "$name report lacks the INFRA_FAILURE verdict line"
  pass "$name"
}

mkdir -p "$TEST_ROOT/manifests"
write_satisfying_host_profile

mkdir -p "$TT_DIR/oracles"
oracle_pass="$TT_DIR/oracles/TT-ORACLE-PASS"
oracle_malformed="$TT_DIR/oracles/TT-ORACLE-MALFORMED"
oracle_contradictory="$TT_DIR/oracles/TT-ORACLE-CONTRADICTORY"
oracle_no_prose="$TT_DIR/oracles/TT-ORACLE-NO-PROSE"
oracle_provider_retry="$TT_DIR/oracles/TT-ORACLE-PROVIDER-RETRY"
ORACLE_TEST_FILES+=("$oracle_pass" "$oracle_malformed" "$oracle_contradictory" "$oracle_no_prose" "$oracle_provider_retry")
cat > "$oracle_pass" <<'NODE'
#!/usr/bin/env node
import fs from 'node:fs';
const contextFlag = process.argv.indexOf('--context');
if (process.argv[2] !== '--contract-version' || process.argv[3] !== '1'
    || contextFlag < 0 || process.argv[contextFlag + 1] !== process.env.TT_ORACLE_CONTEXT) process.exit(9);
const context = JSON.parse(fs.readFileSync(process.env.TT_ORACLE_CONTEXT, 'utf8'));
if (context.contract_version !== 1 || context.oracle_id !== process.env.TT_ORACLE_ID
    || context.case.id !== process.env.TT_CASE_ID
    || context.campaign.id !== process.env.TT_CAMPAIGN_ID
    || context.agent_prose !== undefined || !Array.isArray(context.attempts)) process.exit(8);
const started = new Date().toISOString();
const evidencePath = `${process.env.TT_ORACLE_EVIDENCE_DIR}/mechanical.json`;
fs.writeFileSync(evidencePath, `${JSON.stringify({mechanical:true,run_id:context.run_id})}\n`, {flag:'wx'});
console.log(JSON.stringify({
  contract_version: 1, oracle_id: process.env.TT_ORACLE_ID, result: 'PASS',
  started_at: started, finished_at: new Date().toISOString(), findings: [],
  evidence: [{path:'mechanical.json', kind:'filesystem'}],
}));
console.error('oracle diagnostic');
NODE
cat > "$oracle_malformed" <<'NODE'
#!/usr/bin/env node
console.log('{not-json}');
NODE
cat > "$oracle_contradictory" <<'NODE'
#!/usr/bin/env node
const now = new Date().toISOString();
console.log(JSON.stringify({contract_version:1,oracle_id:process.env.TT_ORACLE_ID,result:'FAIL',started_at:now,finished_at:now,findings:[{id:'F1',summary:'mechanical mismatch'}],evidence:[]}));
process.exit(0);
NODE
cat > "$oracle_no_prose" <<'NODE'
#!/usr/bin/env node
import fs from 'node:fs';
const context = JSON.parse(fs.readFileSync(process.env.TT_ORACLE_CONTEXT, 'utf8'));
const serialized = JSON.stringify(context);
if (serialized.includes('AGENT_RESPONSE_SENTINEL')) process.exit(8);
const step = context.attempts?.[0]?.steps_snapshot?.steps?.[0];
if (step?.stepId !== 'step-oracle-prose' || step?.stepIndex !== 0 || step?.status !== 'done') process.exit(9);
const now = new Date().toISOString();
console.log(JSON.stringify({
  contract_version:1, oracle_id:process.env.TT_ORACLE_ID, result:'PASS',
  started_at:now, finished_at:now, findings:[], evidence:[],
}));
NODE
chmod +x "$oracle_pass" "$oracle_malformed" "$oracle_contradictory" "$oracle_no_prose"

oracle_manifest="$TEST_ROOT/manifests/oracles.jsonl"
node --input-type=module - "$oracle_manifest" <<'NODE'
import fs from 'node:fs';
const manifest = process.argv[2];
const makeCase = (id, oracle) => ({
  id, wave: 0, workflow: 'local', fixture: 'none', harness: 'local',
  task: 'tasks/W3.07.md', context: {execution_mode:'real'}, caps: {tokens:0,wall_min:5},
  requires: {}, boundary_files: [], forbidden: [], oracles: [oracle], gates: [], chaos: null,
  shed_ok: false, mandatory: true, class: 'verification',
  command: {executable:'node',args:['-e','console.log("mechanical command output only")'],cwd:'.'},
});
fs.writeFileSync(manifest, [
  makeCase('ORACLE-PASS','TT-ORACLE-PASS'),
  makeCase('ORACLE-MISSING','TT-ORACLE-MISSING'),
  makeCase('ORACLE-MALFORMED','TT-ORACLE-MALFORMED'),
  makeCase('ORACLE-CONTRADICTORY','TT-ORACLE-CONTRADICTORY'),
].map(JSON.stringify).join('\n') + '\n');
NODE
oracle_output=$(run_recorded_campaign "$CONTROLLER" --manifest "$oracle_manifest") || fail "oracle campaign failed: $oracle_output"
oracle_campaign_id=$(remember_campaign "$oracle_output")
node --input-type=module - "$TT_DIR/var/results/$oracle_campaign_id/state.json" "$TT_DIR/var/results/$oracle_campaign_id" <<'NODE'
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const [statePath, campaignDir] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const byId = Object.fromEntries(state.cases.map(item => [item.id,item]));
const pass = byId['ORACLE-PASS'];
const result = pass.oracle_results?.[0];
if (pass.outcome !== 'PASS' || result?.status !== 'VALID' || result?.response?.result !== 'PASS'
    || result.exit_code !== 0 || !result.stdout || !result.stderr || !result.context
    || !/^[a-f0-9]{64}$/.test(result.stdout_sha256) || !/^[a-f0-9]{64}$/.test(result.stderr_sha256)
    || !/^[a-f0-9]{64}$/.test(result.context_sha256)) {
  throw new Error(`valid oracle evidence was not persisted: ${JSON.stringify(pass)}`);
}
if (createHash('sha256').update(fs.readFileSync(path.join(campaignDir, result.context))).digest('hex') !== result.context_sha256) {
  throw new Error('persisted oracle context hash does not match its bytes');
}
for (const reference of [result.stdout,result.stderr,result.context]) {
  const absolute = path.join(campaignDir, reference);
  if (!fs.statSync(absolute).isFile()) throw new Error(`oracle evidence missing: ${reference}`);
}
if (!fs.readFileSync(path.join(campaignDir,result.stderr),'utf8').includes('oracle diagnostic')) {
  throw new Error('oracle stderr was not captured independently');
}
const missing = byId['ORACLE-MISSING'];
if (missing.outcome !== 'PASS' || missing.oracle_results?.[0]?.status !== 'ORACLE_MISSING') {
  throw new Error(`missing oracle was not recorded independently: ${JSON.stringify(missing)}`);
}
for (const id of ['ORACLE-MALFORMED','ORACLE-CONTRADICTORY']) {
  const item = byId[id];
  if (item.outcome !== 'TEST_INFRA_FAIL' || item.oracle_results?.[0]?.status !== 'TEST_INFRA'
      || item.reason?.category !== 'oracle-infrastructure') throw new Error(`invalid oracle was guessed: ${JSON.stringify(item)}`);
}
NODE
pass "oracle hooks receive mechanical context and invalid or missing evidence fails closed"

node --test "$SCRIPT_DIR/oracle-context.test.mjs" || fail "oracle context schema/projection tests failed"
pass "oracle context schema accepts complete v1 evidence and rejects malformed or escaping references"

node --test "$SCRIPT_DIR/o9-mechanical-harvest.integration.test.mjs" \
  || fail "O9 controller-to-snapshot mechanical harvest integration failed"
pass "O9 real reclaim, stop/cancel, and targeted probes harvest to a contract-valid PASS"

node --test "$TT_DIR/oracles/lib/runtime.test.mjs" "$TT_DIR/oracles/lib/evidence-portability.test.mjs" "$TT_DIR/oracles/self-test/harness.test.mjs" \
  "$TT_DIR/oracles/self-test/o1.test.mjs" "$TT_DIR/oracles/self-test/o3z.test.mjs" \
  "$TT_DIR/oracles/self-test/o9.test.mjs" "$TT_DIR/oracles/self-test/o16.test.mjs" \
  "$TT_DIR/oracles/self-test/o4.test.mjs" \
  || fail "shared oracle runtime/self-test harness tests failed"
"$TT_DIR/oracles/self-test/run.sh" || fail "shared oracle mutation harness failed"
pass "shared oracle runtime enforces CONTRACT v1 and the mutation harness rejects result mismatches"

node "$SCRIPT_DIR/tt-classification.test.mjs" || fail "mechanical classification table failed"
pass "every taxonomy outcome and case class has deterministic structured precedence"

cat > "$oracle_provider_retry" <<'NODE'
#!/usr/bin/env node
import fs from 'node:fs';
const counterPath = process.env.CONTROLLER_PROVIDER_COUNTER;
const count = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) + 1 : 1;
fs.writeFileSync(counterPath, String(count));
const providerFailure = count === 1 || process.env.CONTROLLER_PROVIDER_ALWAYS === '1';
const now = new Date().toISOString();
console.log(JSON.stringify({
  contract_version: 1,
  oracle_id: process.env.TT_ORACLE_ID,
  result: 'PASS',
  started_at: now,
  finished_at: now,
  findings: [],
  evidence: [],
  classification: providerFailure
    ? { provider_failure: { identified: true, injected: false, kind: 'rate-limit' } }
    : { expectation_met: true },
}));
NODE
chmod +x "$oracle_provider_retry"

for provider_mode in retry-pass retry-exhausted; do
  provider_manifest="$TEST_ROOT/manifests/provider-$provider_mode.jsonl"
  provider_counter="$TEST_ROOT/provider-$provider_mode-count"
  provider_commands="$TEST_ROOT/provider-$provider_mode-commands"
  node --input-type=module - "$provider_manifest" "$provider_commands" <<'NODE'
import fs from 'node:fs';
const [manifest, commandLog] = process.argv.slice(2);
const record = {
  id: 'PROVIDER-RETRY', wave: 0, workflow: 'local', fixture: 'none', harness: 'local',
  task: 'tasks/W3.07.md', context: {execution_mode:'real'}, caps: {tokens:0,wall_min:5},
  requires: {}, boundary_files: [], forbidden: [], oracles: ['TT-ORACLE-PROVIDER-RETRY'],
  gates: [], chaos: null, shed_ok: false, mandatory: true, class: 'verification',
  command: {
    executable: 'node',
    args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(commandLog)},Date.now()+'\\n')`],
    cwd: '.',
  },
};
fs.writeFileSync(manifest, `${JSON.stringify(record)}\n`);
NODE
  provider_always=0
  [ "$provider_mode" = "retry-exhausted" ] && provider_always=1
  provider_output=$(CONTROLLER_PROVIDER_COUNTER="$provider_counter" \
    CONTROLLER_PROVIDER_ALWAYS="$provider_always" TT_CONTROLLER_PROVIDER_RETRY_BACKOFF_MS=80 \
    run_recorded_campaign "$CONTROLLER" --manifest "$provider_manifest") \
    || fail "$provider_mode campaign failed: $provider_output"
  provider_id=$(remember_campaign "$provider_output")
  node --input-type=module - "$TT_DIR/var/results/$provider_id/state.json" "$provider_commands" "$provider_mode" <<'NODE'
import fs from 'node:fs';
const [statePath, commandsPath, mode] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const item = state.cases[0];
const commandTimes = fs.readFileSync(commandsPath, 'utf8').trim().split('\n').map(Number);
if (item.attempts.length !== 2 || commandTimes.length !== 2) {
  throw new Error(`provider retry count is not exactly one: ${JSON.stringify({item,commandTimes})}`);
}
const [first, second] = item.attempts;
if (first.outcome !== 'PROVIDER_FAIL' || first.counts_toward_gate !== false
    || second.retry_of !== first.id || second.retry_number !== 1
    || new Date(second.started_at) < new Date(item.provider_retry.retry_not_before)
    || commandTimes[1] - commandTimes[0] < 60) {
  throw new Error(`provider retry linkage/backoff is wrong: ${JSON.stringify({item,commandTimes})}`);
}
const expectedFinal = mode === 'retry-pass' ? 'PASS' : 'PROVIDER_FAIL';
if (second.outcome !== expectedFinal || item.outcome !== second.outcome
    || item.provider_retry.status !== 'completed'
    || item.provider_retry.final_attempt_id !== second.id
    || second.counts_toward_gate !== (expectedFinal === 'PASS')
    || item.counts_toward_gate !== (expectedFinal === 'PASS')
    || item.oracle_results.length !== 2) {
  throw new Error(`final provider outcome/gate exclusion is wrong: ${JSON.stringify(item)}`);
}
NODE
done
pass "provider failures receive one linked backoff retry and never enter gate statistics"

operator_home="$HOME"
for execution_mode in real scripted; do
  isolated_manifest="$TEST_ROOT/manifests/isolated-$execution_mode.jsonl"
  shell_sentinel="$TEST_ROOT/shell-interpolation-$execution_mode"
  write_local_case "$isolated_manifest" "LOCAL-$(toupper "$execution_mode")" "$execution_mode" 0 0 "$shell_sentinel"
  isolated_output=$(\
    TT_REPO_ROOT=/tmp/operator-production-repo \
    TT_OPERATOR_POISON=operator-tt-state \
    TAMANDUA_DB_PATH=/tmp/operator-production.db \
    TAMANDUA_WORKTREE_ROOT=/tmp/operator-production-worktrees \
    TAMANDUA_WORKER_PID=12345 \
    TAMANDUA_RUN_ID=run-operator-production \
    HERMES_OPERATOR_POISON=operator-hermes-state \
    run_recorded_campaign "$CONTROLLER" --manifest "$isolated_manifest") || fail "$execution_mode local hooks failed: $isolated_output"
  isolated_id=$(remember_campaign "$isolated_output")
  isolated_state="$TT_DIR/var/results/$isolated_id/state.json"
  node --input-type=module - "$isolated_state" "$TT_DIR" "$execution_mode" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const [statePath, ttDir, mode] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const item = state.cases[0];
if (item.phase !== 'terminal' || item.outcome !== 'PASS' || item.attempts.length !== 1) {
  throw new Error(`local case did not finish PASS: ${JSON.stringify(item)}`);
}
const attempt = item.attempts[0];
for (const hookName of ['reset', 'command']) {
  const hook = attempt[hookName];
  if (!hook || hook.exit_code !== 0 || hook.signal !== null) throw new Error(`${hookName} result missing: ${JSON.stringify(hook)}`);
  for (const key of ['started_at', 'finished_at']) {
    if (new Date(hook[key]).toISOString() !== hook[key]) throw new Error(`${hookName}.${key} is not UTC`);
  }
  const stdoutPath = path.join(path.dirname(statePath), hook.stdout);
  const stderrPath = path.join(path.dirname(statePath), hook.stderr);
  const evidence = JSON.parse(fs.readFileSync(stdoutPath, 'utf8').trim());
  if (fs.readFileSync(stderrPath, 'utf8') !== `${hookName} stderr\n`) throw new Error(`${hookName} stderr not captured separately`);
  const expectedHome = mode === 'scripted' ? path.join(ttDir, 'var', 'home-scripted') : path.join(ttDir, 'var', 'home');
  const expectedPorts = mode === 'scripted' ? ['5339', '5338', '5334'] : ['4339', '4338', '4334'];
  if (evidence.home !== expectedHome || evidence.state !== path.join(expectedHome, '.tamandua')) throw new Error(`wrong ${mode} HOME/state: ${JSON.stringify(evidence)}`);
  if (JSON.stringify([evidence.control, evidence.mcp, evidence.dashboard]) !== JSON.stringify(expectedPorts)) throw new Error(`wrong ${mode} ports: ${JSON.stringify(evidence)}`);
  if (mode === 'scripted' && (!evidence.pi?.includes('scripted-pi') || !evidence.hermes?.includes('scripted-hermes'))) throw new Error(`scripted overrides missing: ${JSON.stringify(evidence)}`);
  if (mode === 'real' && (evidence.pi !== null || evidence.hermes !== null)) throw new Error(`real env inherited harness override: ${JSON.stringify(evidence)}`);
  for (const key of ['db', 'worktrees', 'worker', 'run', 'ttPoison', 'hermesPoison']) {
    if (evidence[key] !== null) throw new Error(`inherited operator routing variable ${key}: ${JSON.stringify(evidence)}`);
  }
  if (!evidence.arg.startsWith(';touch ')) throw new Error(`argv was not passed literally: ${JSON.stringify(evidence)}`);
}
if (!(new Date(attempt.reset.finished_at) <= new Date(attempt.command.started_at))) throw new Error('command started before reset completed');
NODE
  [ "$HOME" = "$operator_home" ] || fail "controller contaminated operator HOME"
  [ ! -e "$shell_sentinel" ] || fail "$execution_mode hook used shell interpolation"
  pass "$execution_mode child environment is isolated and hook evidence is durable"
done

node --input-type=module - "$isolated_state" <<'NODE'
import fs from 'node:fs';
const statePath = process.argv[2];
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const item = state.cases[0];
item.phase = 'running';
delete item.outcome;
delete item.terminal_at;
delete item.reason;
item.attempts = [{
  id: 'attempt-1', case_id: item.id, kind: 'workflow', phase: 'launch-intent',
  launch_intent_at: state.created_at, started_at: state.created_at,
}];
fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
NODE
guard_resume_output=$(run_recorded_campaign "$CONTROLLER" --resume "$isolated_id") || fail "resume with an unidentified launch intent failed: $guard_resume_output"
node --input-type=module - "$isolated_state" <<'NODE'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const item = state.cases[0];
if (item.phase !== 'terminal' || item.outcome !== 'TEST_INFRA_FAIL'
    || item.reason?.category !== 'unidentified-launch-intent'
    || item.attempts.length !== 1 || item.attempts[0].terminal_at === undefined) {
  throw new Error(`unidentified launch intent was not failed closed: ${JSON.stringify(item)}`);
}
NODE
pass "unidentified launch intent is TEST_INFRA_FAIL and is never relaunched"

scheduler_manifest="$TEST_ROOT/manifests/scheduler.jsonl"
scheduler_events="$TEST_ROOT/scheduler-events.jsonl"
write_scheduler_manifest "$scheduler_manifest" "$scheduler_events" 4 450
# Stagger is set well above the 100 ms assertion floor so a loaded box (other
# agents, parallel suites) cannot eat the margin and flake the deadline check.
scheduler_output=$(run_recorded_campaign "$CONTROLLER" --manifest "$scheduler_manifest" --concurrency 2 --stagger 400ms) || fail "bounded scheduler failed: $scheduler_output"
scheduler_id=$(remember_campaign "$scheduler_output")
node --input-type=module - "$TT_DIR/var/results/$scheduler_id/state.json" "$scheduler_events" <<'NODE'
import fs from 'node:fs';
const [statePath, eventPath] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const events = fs.readFileSync(eventPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
let active = 0;
let maximum = 0;
for (const event of events.sort((left, right) => left.at - right.at || (left.event === 'end' ? -1 : 1))) {
  active += event.event === 'start' ? 1 : -1;
  maximum = Math.max(maximum, active);
  if (active < 0) throw new Error(`invalid scheduler event ordering: ${JSON.stringify(events)}`);
}
if (maximum !== 2) throw new Error(`expected scheduler to refill two active slots, observed ${maximum}: ${JSON.stringify(events)}`);
const starts = events.filter(event => event.event === 'start').sort((left, right) => left.at - right.at);
if (starts.length !== 4) throw new Error(`not every case launched exactly once: ${JSON.stringify(events)}`);
for (let index = 1; index < starts.length; index += 1) {
  if (starts[index].at - starts[index - 1].at < 100) {
    throw new Error(`launch stagger was not enforced: ${JSON.stringify(starts)}`);
  }
}
for (const item of state.cases) {
  if (item.phase !== 'terminal' || item.outcome !== 'PASS' || item.attempts.length !== 1) {
    throw new Error(`case did not reach exactly one terminal record: ${JSON.stringify(item)}`);
  }
  const attempt = item.attempts[0];
  if (!attempt.launch_intent_at || new Date(attempt.launch_intent_at) > new Date(attempt.command.started_at)) {
    throw new Error(`launch intent was not durable before command start: ${JSON.stringify(attempt)}`);
  }
}
NODE
pass "scheduler enforces concurrency and stagger with durable launch intent"

stagger_resume_manifest="$TEST_ROOT/manifests/stagger-resume.jsonl"
stagger_resume_events="$TEST_ROOT/stagger-resume-events.jsonl"
write_scheduler_manifest "$stagger_resume_manifest" "$stagger_resume_events" 2 80
stagger_resume_output="$TEST_ROOT/stagger-resume-output"
"$CONTROLLER" --manifest "$stagger_resume_manifest" --concurrency 1 --stagger 1200ms >"$stagger_resume_output" 2>&1 &
stagger_resume_pid=$!
INTERRUPTION_PID="$stagger_resume_pid"
for _ in $(seq 1 150); do
  if [ -f "$stagger_resume_events" ] && grep -q '"event":"end"' "$stagger_resume_events"; then break; fi
  sleep 0.02
done
grep -q '"event":"end"' "$stagger_resume_events" 2>/dev/null || fail "stagger-resume case never completed its first launch"
stagger_resume_state=$(node --input-type=module - "$TT_DIR/var/results" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2];
for (const entry of fs.readdirSync(root, {withFileTypes:true})) {
  const statePath = path.join(root, entry.name, 'state.json');
  if (!entry.isDirectory() || !fs.existsSync(statePath)) continue;
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (state.manifest.case_count === 2 && state.manifest.case_ids[0] === 'SCHEDULE-1'
      && state.options.stagger_ms === 1200 && state.cases[0].phase === 'terminal'
      && state.cases[1].phase === 'pending') {
    process.stdout.write(statePath);
    break;
  }
}
NODE
)
[ -n "$stagger_resume_state" ] || fail "could not find campaign waiting in the stagger interval"
printf '%s\n' "$(dirname "$stagger_resume_state")" >> "$CAMPAIGN_DIRS_FILE"
stagger_resume_id="$(basename "$(dirname "$stagger_resume_state")")"
stagger_resume_controller_pid=$(node --input-type=module - "$(dirname "$stagger_resume_state")/.controller.lock" <<'NODE'
import fs from 'node:fs';
process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).pid));
NODE
)
kill -9 "$stagger_resume_controller_pid"
set +e
wait "$stagger_resume_pid" 2>/dev/null
set -e
INTERRUPTION_PID=""
stagger_resume_result=$(run_recorded_campaign "$CONTROLLER" --resume "$stagger_resume_id") || fail "resume during stagger failed: $stagger_resume_result"
node --input-type=module - "$stagger_resume_state" "$stagger_resume_events" <<'NODE'
import fs from 'node:fs';
const [statePath, eventPath] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const starts = fs.readFileSync(eventPath, 'utf8').trim().split('\n')
  .map(line => JSON.parse(line)).filter(event => event.event === 'start');
if (starts.length !== 2) throw new Error(`resume did not execute the pending case once: ${JSON.stringify(starts)}`);
if (starts[1].at - starts[0].at < 1000) {
  throw new Error(`resume forgot the durable stagger clock: ${JSON.stringify(starts)}`);
}
if (state.cases.some(item => item.phase !== 'terminal' || item.attempts.length !== 1)) {
  throw new Error(`stagger resume did not terminalize every case exactly once: ${JSON.stringify(state.cases)}`);
}
NODE
pass "resume preserves the launch stagger after the previous case is terminal"

interruption_manifest="$TEST_ROOT/manifests/scheduler-interruption.jsonl"
interruption_events="$TEST_ROOT/scheduler-interruption-events.jsonl"
write_scheduler_manifest "$interruption_manifest" "$interruption_events" 3 3000
interruption_output="$TEST_ROOT/interruption-output"
"$CONTROLLER" --manifest "$interruption_manifest" --concurrency 1 >"$interruption_output" 2>&1 &
interruption_pid=$!
INTERRUPTION_PID="$interruption_pid"
for _ in $(seq 1 100); do
  [ -s "$interruption_events" ] && break
  sleep 0.02
done
[ -s "$interruption_events" ] || fail "interruption case never reached its first launch"
interruption_state=$(node --input-type=module - "$TT_DIR/var/results" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2];
for (const entry of fs.readdirSync(root, {withFileTypes:true})) {
  const statePath = path.join(root, entry.name, 'state.json');
  if (!entry.isDirectory() || !fs.existsSync(statePath)) continue;
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (state.manifest.case_ids[0] === 'SCHEDULE-1' && state.manifest.case_count === 3
      && state.cases.some(item => item.phase === 'running')) {
    process.stdout.write(statePath);
    break;
  }
}
NODE
)
[ -n "$interruption_state" ] || fail "could not find interrupted campaign state"
printf '%s\n' "$(dirname "$interruption_state")" >> "$CAMPAIGN_DIRS_FILE"
interruption_id="$(basename "$(dirname "$interruption_state")")"
interruption_controller_pid=$(node --input-type=module - "$(dirname "$interruption_state")/.controller.lock" <<'NODE'
import fs from 'node:fs';
process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).pid));
NODE
)
INTERRUPTION_CONTROLLER_PID="$interruption_controller_pid"
set +e
active_resume_output=$("$CONTROLLER" --resume "$interruption_id" 2>&1)
active_resume_status=$?
set -e
[ "$active_resume_status" -eq 2 ] || fail "concurrent resume exited $active_resume_status instead of 2: $active_resume_output"
printf '%s' "$active_resume_output" | grep -Fq 'campaign is already controlled' || fail "concurrent resume did not report campaign ownership: $active_resume_output"
kill -9 "$interruption_controller_pid"
set +e
wait "$interruption_pid" 2>/dev/null
set -e
INTERRUPTION_PID=""
INTERRUPTION_CONTROLLER_PID=""
resume_interruption_output=$(run_recorded_campaign "$CONTROLLER" --resume "$interruption_id") || fail "interruption resume failed: $resume_interruption_output"
node --input-type=module - "$interruption_state" "$interruption_events" <<'NODE'
import fs from 'node:fs';
const [statePath, eventsPath] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const events = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
const starts = events.filter(event => event.event === 'start');
const ends = events.filter(event => event.event === 'end');
if (starts.length !== 3 || ends.length !== 3 || new Set(starts.map(event => event.id)).size !== 3) {
  throw new Error(`resume duplicated or omitted local execution: ${JSON.stringify(events)}`);
}
if (state.cases.some(item => item.phase !== 'terminal' || item.outcome !== 'PASS'
    || item.attempts.length !== 1 || item.attempts[0].terminal_at === undefined)) {
  throw new Error(`resume did not reconcile before executing every pending case once: ${JSON.stringify(state.cases)}`);
}
for (const item of state.cases) {
  if (new Set(item.attempts.map(attempt => attempt.id)).size !== item.attempts.length) {
    throw new Error(`duplicate attempt IDs persisted: ${JSON.stringify(item)}`);
  }
}
NODE
start_count=$(grep -c '"event":"start"' "$interruption_events")
[ "$start_count" -eq 3 ] || fail "resume did not execute each recovered and pending case exactly once"
pass "resume observes a live local attempt before executing pending cases without duplicates"

completed_recovery_manifest="$TEST_ROOT/manifests/completed-recovery.jsonl"
completed_recovery_events="$TEST_ROOT/completed-recovery-events.jsonl"
completed_recovery_output="$TEST_ROOT/completed-recovery-output"
write_scheduler_manifest "$completed_recovery_manifest" "$completed_recovery_events" 1 350
"$CONTROLLER" --manifest "$completed_recovery_manifest" >"$completed_recovery_output" 2>&1 &
completed_recovery_pid=$!
INTERRUPTION_PID="$completed_recovery_pid"
for _ in $(seq 1 100); do
  [ -s "$completed_recovery_events" ] && break
  sleep 0.02
done
[ -s "$completed_recovery_events" ] || fail "completed-result recovery case never launched"
completed_recovery_state=$(node --input-type=module - "$TT_DIR/var/results" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2];
for (const entry of fs.readdirSync(root, {withFileTypes:true})) {
  const statePath = path.join(root, entry.name, 'state.json');
  if (!entry.isDirectory() || !fs.existsSync(statePath)) continue;
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (state.manifest.case_count === 1 && state.manifest.case_ids[0] === 'SCHEDULE-1'
      && state.cases[0].phase === 'running') {
    process.stdout.write(statePath);
    break;
  }
}
NODE
)
[ -n "$completed_recovery_state" ] || fail "could not find completed-result recovery state"
printf '%s\n' "$(dirname "$completed_recovery_state")" >> "$CAMPAIGN_DIRS_FILE"
completed_recovery_id="$(basename "$(dirname "$completed_recovery_state")")"
completed_recovery_controller_pid=$(node --input-type=module - "$(dirname "$completed_recovery_state")/.controller.lock" <<'NODE'
import fs from 'node:fs';
process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).pid));
NODE
)
kill -9 "$completed_recovery_controller_pid"
set +e
wait "$completed_recovery_pid" 2>/dev/null
set -e
INTERRUPTION_PID=""
for _ in $(seq 1 100); do
  grep -q '"event":"end"' "$completed_recovery_events" 2>/dev/null && break
  sleep 0.02
done
grep -q '"event":"end"' "$completed_recovery_events" 2>/dev/null \
  || fail "detached local command did not produce durable completion evidence"
node --input-type=module - "$completed_recovery_state" <<'NODE'
import fs from 'node:fs';
const statePath = process.argv[2];
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const attempt = state.cases[0].attempts[0];
attempt.phase = 'terminal';
attempt.terminal_at = new Date().toISOString();
delete attempt.outcome;
fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
NODE
completed_recovery_result=$(run_recorded_campaign "$CONTROLLER" --resume "$completed_recovery_id") \
  || fail "completed-result resume failed: $completed_recovery_result"
node --input-type=module - "$completed_recovery_state" "$completed_recovery_events" <<'NODE'
import fs from 'node:fs';
const [statePath, eventsPath] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const item = state.cases[0];
const starts = fs.readFileSync(eventsPath, 'utf8').trim().split('\n')
  .map(line => JSON.parse(line)).filter(event => event.event === 'start');
if (starts.length !== 1 || item.phase !== 'terminal' || item.outcome !== 'PASS'
    || item.attempts.length !== 1 || item.attempts[0].recovery?.strategy !== 'local-result') {
  throw new Error(`durable completed result was not harvested exactly once: ${JSON.stringify({item, starts})}`);
}
NODE
pass "resume harvests a terminal unclassified attempt without rerunning the command"

workflow_bin_dir="$TEST_ROOT/workflow-bin"
workflow_events="$TEST_ROOT/workflow-events.jsonl"
workflow_reset_sentinel="$TEST_ROOT/workflow-reset"
mkdir -p "$workflow_bin_dir"
DISCOVERY_DB="$TT_DIR/var/home-scripted/.tamandua/tamandua.db"
DISCOVERY_DB_BACKUP="$TEST_ROOT/original-discovery.db"
DISCOVERY_DB_WAL_BACKUP="$TEST_ROOT/original-discovery.db-wal"
DISCOVERY_DB_SHM_BACKUP="$TEST_ROOT/original-discovery.db-shm"
mkdir -p "$(dirname "$DISCOVERY_DB")"
if [ -f "$DISCOVERY_DB" ]; then mv "$DISCOVERY_DB" "$DISCOVERY_DB_BACKUP"; fi
if [ -f "$DISCOVERY_DB-wal" ]; then mv "$DISCOVERY_DB-wal" "$DISCOVERY_DB_WAL_BACKUP"; fi
if [ -f "$DISCOVERY_DB-shm" ]; then mv "$DISCOVERY_DB-shm" "$DISCOVERY_DB_SHM_BACKUP"; fi
node --input-type=module - "$DISCOVERY_DB" <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const database = new DatabaseSync(process.argv[2]);
database.exec(`CREATE TABLE runs (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, task TEXT NOT NULL,
  status TEXT NOT NULL, context TEXT NOT NULL DEFAULT '{}',
  tokens_spent INTEGER NOT NULL DEFAULT 0, scheduling_status TEXT,
  scheduling_requested_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE steps (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL,
  agent_id TEXT NOT NULL, step_index INTEGER NOT NULL, status TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'single', current_story_id TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0, abandoned_count INTEGER NOT NULL DEFAULT 0,
  reroute_count INTEGER NOT NULL DEFAULT 0, claim_pid INTEGER,
  claim_pgid INTEGER,
  claim_updated_at TEXT, updated_at TEXT NOT NULL
);`);
database.close();
NODE
WORKFLOW_REAL_DB="$TT_DIR/var/home/.tamandua/tamandua.db"
WORKFLOW_REAL_DB_BACKUP="$TEST_ROOT/original-real-workflow.db"
WORKFLOW_REAL_DB_WAL_BACKUP="$TEST_ROOT/original-real-workflow.db-wal"
WORKFLOW_REAL_DB_SHM_BACKUP="$TEST_ROOT/original-real-workflow.db-shm"
mkdir -p "$(dirname "$WORKFLOW_REAL_DB")"
if [ -f "$WORKFLOW_REAL_DB" ]; then mv "$WORKFLOW_REAL_DB" "$WORKFLOW_REAL_DB_BACKUP"; fi
if [ -f "$WORKFLOW_REAL_DB-wal" ]; then mv "$WORKFLOW_REAL_DB-wal" "$WORKFLOW_REAL_DB_WAL_BACKUP"; fi
if [ -f "$WORKFLOW_REAL_DB-shm" ]; then mv "$WORKFLOW_REAL_DB-shm" "$WORKFLOW_REAL_DB_SHM_BACKUP"; fi
cp "$DISCOVERY_DB" "$WORKFLOW_REAL_DB"
cat > "$workflow_bin_dir/tamandua" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$(node -e 'process.stdout.write(JSON.stringify({argv:process.argv.slice(1),at:Date.now()}))' "$@")" >> "$CONTROLLER_WORKFLOW_EVENTS"
if [ "${1:-}" = "workflow" ] && [ "${2:-}" = "runs" ]; then
  if [ "${CONTROLLER_WORKFLOW_MODE:-}" = "discovery" ] \
      || [ "${CONTROLLER_WORKFLOW_MODE:-}" = "discovery-cap" ]; then
    cat "$CONTROLLER_LIMITED_RUNS_JSON"
    exit 0
  fi
  printf '%s\n' '{"runs":[]}'
  exit 0
fi
if [ "${1:-}" = "workflow" ] && [ "${2:-}" = "status" ]; then
  case "${CONTROLLER_WORKFLOW_MODE:-stdout}" in
    scripted-fixture-lstat) printf '{"runId":"run-11111111-1111-4111-8111-111111111111","status":"failed","tokensSpent":0,"steps":[]}\n' ;;
    stdout) printf '{"runId":"run-11111111-1111-4111-8111-111111111111","status":"completed","tokensSpent":0,"steps":[]}\n' ;;
    probe-pause-fail) printf '{"runId":"run-11111111-1111-4111-8111-111111111111","status":"completed","tokensSpent":0,"steps":[]}\n' ;;
    multi-run-seq)
      case "${3:-}" in
        run-aaaa1111-1111-4111-8111-111111111111)
          printf '{"runId":"%s","status":"canceled","tokensSpent":0,"steps":[]}\n' "${3:-}" ;;
        run-bbbb2222-2222-4222-8222-222222222222)
          printf '{"runId":"%s","status":"canceled","tokensSpent":0,"steps":[]}\n' "${3:-}" ;;
        *) exit 9 ;;
      esac
      ;;
    multi-run-conc)
      case "${3:-}" in
        run-cccc1111-1111-4111-8111-111111111111)
          printf '{"runId":"%s","status":"completed","tokensSpent":7,"steps":[]}\n' "${3:-}" ;;
        run-cccc2222-2222-4222-8222-222222222222)
          printf '{"runId":"%s","status":"completed","tokensSpent":9,"steps":[]}\n' "${3:-}" ;;
        run-cccc3333-3333-4333-8333-333333333333)
          printf '{"runId":"%s","status":"completed","tokensSpent":11,"steps":[]}\n' "${3:-}" ;;
        *) exit 9 ;;
      esac
      ;;
    stderr) printf '{"runId":"run-22222222-2222-4222-8222-222222222222","status":"running","tokensSpent":0,"steps":[]}\n' ;;
    resume) printf '{"runId":"run-22222222-2222-4222-8222-222222222222","status":"completed","tokensSpent":7,"steps":[]}\n' ;;
    harvest-status) printf '{"runId":"run-aaaaaaaa-1111-4111-8111-111111111111","status":"completed","tokensSpent":13,"steps":[{"stepId":"step-status","stepIndex":0,"status":"done"}]}\n' ;;
    oracle-prose) printf '{"runId":"run-eeeeeeee-5555-4555-8555-555555555555","status":"completed","tokensSpent":0,"steps":[{"stepId":"step-oracle-prose","stepIndex":0,"status":"done","displayStatus":"done","agentRole":"developer","output":"AGENT_RESPONSE_SENTINEL STATUS: done","error":"AGENT_RESPONSE_SENTINEL failure prose"}]}\n' ;;
    o9-special) printf '{"runId":"run-ffffffff-6666-4666-8666-666666666666","status":"completed","tokensSpent":0,"steps":[]}\n' ;;
    harvest-db) exit 9 ;;
    harvest-lie) printf '{"runId":"run-cccccccc-3333-4333-8333-333333333333","status":"failed","tokensSpent":17,"steps":[{"stepId":"step-lie","stepIndex":0,"status":"failed"}]}\n' ;;
    harvest-shifting-lie)
      observations="$(grep -c 'run-dddddddd-4444-4444-8444-444444444444' "$CONTROLLER_WORKFLOW_EVENTS" || true)"
      status=failed
      [ "$observations" -lt 2 ] || status=canceled
      printf '{"runId":"run-dddddddd-4444-4444-8444-444444444444","status":"%s","tokensSpent":19,"steps":[{"stepId":"step-shifting-lie","stepIndex":0,"status":"failed"}]}\n' "$status"
      ;;
    conflict) printf '{"runId":"run-33333333-3333-4333-8333-333333333333","status":"running","steps":[]}\n' ;;
    token-cap)
      count=0
      [ ! -f "$CONTROLLER_STATUS_COUNT" ] || count="$(cat "$CONTROLLER_STATUS_COUNT")"
      count=$((count + 1))
      printf '%s' "$count" > "$CONTROLLER_STATUS_COUNT"
      tokens=5
      [ "$count" -lt 2 ] || tokens=10
      status=running
      [ ! -f "$CONTROLLER_STOP_MARKER" ] || status=canceled
      printf '{"runId":"run-55555555-5555-4555-8555-555555555555","status":"%s","tokensSpent":%s,"steps":[]}\n' "$status" "$tokens"
      ;;
    wall-cap)
      status=running
      [ ! -f "$CONTROLLER_STOP_MARKER" ] || status=canceled
      printf '{"runId":"run-66666666-6666-4666-8666-666666666666","status":"%s","tokensSpent":4,"steps":[]}\n' "$status"
      ;;
    discovery)
      case "${3:-}" in
        run-77777777-7777-4777-8777-777777777777)
          printf '{"runId":"%s","status":"completed","tokensSpent":5,"task":"shared dispatch task","steps":[]}\n' "${3:-}" ;;
        run-88888888-8888-4888-8888-888888888888)
          status=running
          [ ! -f "$CONTROLLER_DISCOVERY_CHILD_WAITED" ] || status=completed
          printf '{"runId":"%s","status":"%s","tokensSpent":7,"steps":[]}\n' "${3:-}" "$status" ;;
        run-99999999-9999-4999-8999-999999999999)
          printf '{"runId":"%s","status":"completed","tokensSpent":11,"steps":[]}\n' "${3:-}" ;;
        *) exit 9 ;;
      esac
      ;;
    discovery-cap)
      case "${3:-}" in
        run-77777777-7777-4777-8777-777777777777)
          printf '{"runId":"%s","status":"completed","tokensSpent":5,"task":"shared dispatch task","steps":[]}\n' "${3:-}" ;;
        run-88888888-8888-4888-8888-888888888888)
          status=running
          [ ! -f "$CONTROLLER_DISCOVERY_CAP_STOP" ] || status=canceled
          printf '{"runId":"%s","status":"%s","tokensSpent":7,"steps":[]}\n' "${3:-}" "$status" ;;
        *) exit 9 ;;
      esac
      ;;
    *) exit 9 ;;
  esac
  exit 0
fi
if [ "${1:-}" = "workflow" ] && [ "${2:-}" = "stop" ]; then
  if [ "${CONTROLLER_WORKFLOW_MODE:-}" = "discovery" ]; then
    case "${3:-}" in
      run-88888888-8888-4888-8888-888888888888) : > "$CONTROLLER_DISCOVERY_CHILD_WAITED" ;;
      run-99999999-9999-4999-8999-999999999999) : > "$CONTROLLER_DISCOVERY_REPLACEMENT_WAITED" ;;
      *) exit 45 ;;
    esac
    exit 0
  fi
  if [ "${CONTROLLER_WORKFLOW_MODE:-}" = "discovery-cap" ]; then
    case "${3:-}" in
      run-88888888-8888-4888-8888-888888888888) : > "$CONTROLLER_DISCOVERY_CAP_STOP" ;;
      *) exit 45 ;;
    esac
    exit 0
  fi
  : > "$CONTROLLER_STOP_MARKER"
  exit 0
fi
if [ "${1:-}" = "workflow" ] && [ "${2:-}" = "wait" ]; then
  if [ "${CONTROLLER_WORKFLOW_MODE:-}" = "discovery" ]; then
    case "${3:-}" in
      run-88888888-8888-4888-8888-888888888888) : > "$CONTROLLER_DISCOVERY_CHILD_WAITED" ;;
      run-99999999-9999-4999-8999-999999999999) : > "$CONTROLLER_DISCOVERY_REPLACEMENT_WAITED" ;;
      *) exit 45 ;;
    esac
    if [ "${CONTROLLER_DISCOVERY_HANG_WAIT:-}" = "1" ] \
        && [ "${3:-}" = "run-88888888-8888-4888-8888-888888888888" ]; then
      sleep 5
    fi
    printf '{"runs":[{"runId":"%s","status":"completed"}],"timedOut":false}\n' "${3:-}"
    exit 0
  fi
  if [ "${CONTROLLER_WORKFLOW_MODE:-}" = "discovery-cap" ]; then
    case "${3:-}" in
      run-88888888-8888-4888-8888-888888888888) : ;;
      *) exit 45 ;;
    esac
    while [ ! -f "$CONTROLLER_DISCOVERY_CAP_STOP" ]; do sleep 0.01; done
    printf '{"runs":[{"runId":"%s","status":"canceled"}],"timedOut":false}\n' "${3:-}"
    exit 3
  fi
  if [ "${CONTROLLER_WORKFLOW_MODE:-}" = "resume" ]; then
    printf '{"runs":[{"runId":"%s","status":"completed"}],"timedOut":false}\n' "${3:-}"
    exit 0
  fi
  [ -f "$CONTROLLER_STOP_MARKER" ] || exit 44
  printf '{"runs":[{"runId":"%s","status":"canceled"}],"timedOut":false}\n' "${3:-}"
  exit 3
fi
# E3.C US-006 probe-action stub: `workflow pause` succeeds by default; in
# probe-pause-fail mode it refuses (exit 3) so the controller's probe
# sequencer classifies TEST_INFRA_FAIL with 'probe-action-failed' (the argv
# was already recorded at the top of this stub).
if [ "${1:-}" = "workflow" ] && [ "${2:-}" = "pause" ]; then
  if [ "${CONTROLLER_WORKFLOW_MODE:-stdout}" = "probe-pause-fail" ]; then
    printf 'stub pause refused\n' >&2
    exit 3
  fi
  exit 0
fi
# E3.C US-007 probe-action stubs: `workflow cancel` (W3.20's cancels) and
# `workflow resume`/`workflow fail` succeed; only their argv is recorded at
# the top of this stub.
if [ "${1:-}" = "workflow" ] && [ "${2:-}" = "cancel" ]; then
  exit 0
fi
if [ "${1:-}" = "workflow" ] && [ "${2:-}" = "resume" ]; then
  exit 0
fi
if [ "${1:-}" = "workflow" ] && [ "${2:-}" = "fail" ]; then
  exit 0
fi
# E3.C US-007 multi-launch stub: `workflow run` emits a per-launch run id
# (counted via CONTROLLER_MULTI_RUN_COUNTER) and the wait JSON a real
# `workflow run --wait --json` would print — canceled (exit 3) for the
# sequential W3.20 shape, completed (exit 0) for the concurrent W3.22 shape.
if [ "${1:-}" = "workflow" ] && [ "${2:-}" = "run" ]; then
  case "${CONTROLLER_WORKFLOW_MODE:-stdout}" in
    scripted-fixture-lstat)
      # US-003 (T2.1): mirror the product's launch-time origin lstat. The real
      # `tamandua workflow run --worktree-origin-repository <path>` lstats the
      # origin repository at launch; a missing clone dies with
      # 'ENOENT: no such file or directory, lstat <path>' — the exact
      # scheduler-execution-failed signature this test guards against. Exit 1
      # mirrors the product's failed-run exit code for the wait JSON below
      # (a failed run exits 1, so no O13 disagreement is recorded).
      origin_repo=""
      prev_arg=""
      for argv_item in "$@"; do
        if [ "$prev_arg" = "--worktree-origin-repository" ]; then origin_repo="$argv_item"; fi
        prev_arg="$argv_item"
      done
      if [ -z "$origin_repo" ] || [ ! -d "$origin_repo" ]; then
        printf 'ENOENT: no such file or directory, lstat %s\n' "${origin_repo:-<missing>}" >&2
        exit 1
      fi
      printf 'Run: run-11111111-1111-4111-8111-111111111111\n'
      printf '{"runs":[{"runId":"run-11111111-1111-4111-8111-111111111111","status":"failed","tokensSpent":0}],"timedOut":false}\n'
      exit 1
      ;;
    multi-run-seq|multi-run-conc)
      count=0
      [ ! -f "$CONTROLLER_MULTI_RUN_COUNTER" ] || count="$(cat "$CONTROLLER_MULTI_RUN_COUNTER")"
      count=$((count + 1))
      printf '%s' "$count" > "$CONTROLLER_MULTI_RUN_COUNTER"
      if [ "${CONTROLLER_WORKFLOW_MODE:-}" = "multi-run-conc" ]; then
        case "$count" in
          1) rid="run-cccc1111-1111-4111-8111-111111111111" ;;
          2) rid="run-cccc2222-2222-4222-8222-222222222222" ;;
          3) rid="run-cccc3333-3333-4333-8333-333333333333" ;;
          *) exit 9 ;;
        esac
      else
        case "$count" in
          1) rid="run-aaaa1111-1111-4111-8111-111111111111" ;;
          2) rid="run-bbbb2222-2222-4222-8222-222222222222" ;;
          3) rid="run-cccc3333-3333-4333-8333-333333333333" ;;
          *) exit 9 ;;
        esac
      fi
      printf 'Run: %s\n' "$rid"
      if [ "${CONTROLLER_WORKFLOW_MODE:-}" = "multi-run-seq" ]; then
        printf '{"runs":[{"runId":"%s","status":"canceled"}],"timedOut":false}\n' "$rid"
        exit 3
      fi
      printf '{"runs":[{"runId":"%s","status":"completed"}],"timedOut":false}\n' "$rid"
      exit 0
      ;;
  esac
fi
case "${CONTROLLER_WORKFLOW_MODE:-stdout}" in
  stdout)
    printf 'Run: run-11111111-1111-4111-8111-111111111111\n'
    printf '{"status":"completed"}\n'
    ;;
  probe-pause-fail)
    printf 'Run: run-11111111-1111-4111-8111-111111111111\n'
    printf '{"status":"completed"}\n'
    ;;
  stderr)
    printf 'run #42 (22222222) created; preparing workspace...\n' >&2
    kill -TERM $$
    ;;
  conflict)
    printf 'run #43 (33333333) created; preparing workspace...\n' >&2
    printf 'Run: run-44444444-4444-4444-8444-444444444444\n'
    ;;
  missing)
    printf 'launch ended before identifiers\n' >&2
    ;;
  token-cap)
    printf 'Run: run-55555555-5555-4555-8555-555555555555\n'
    while [ ! -f "$CONTROLLER_STOP_MARKER" ]; do sleep 0.01; done
    exit 3
    ;;
  wall-cap)
    printf 'Run: run-66666666-6666-4666-8666-666666666666\n'
    while [ ! -f "$CONTROLLER_STOP_MARKER" ]; do sleep 0.01; done
    exit 3
    ;;
  discovery)
    printf 'Run: run-77777777-7777-4777-8777-777777777777\n'
    printf '{"status":"completed"}\n'
    ;;
  discovery-cap)
    printf 'Run: run-77777777-7777-4777-8777-777777777777\n'
    printf '{"status":"completed"}\n'
    ;;
  harvest-status)
    printf 'Run: run-aaaaaaaa-1111-4111-8111-111111111111\n'
    printf '{"runs":[{"runId":"run-aaaaaaaa-1111-4111-8111-111111111111","status":"completed","tokensSpent":13}],"timedOut":false}\n'
    ;;
  harvest-db)
    printf 'Run: run-bbbbbbbb-2222-4222-8222-222222222222\n'
    ;;
  harvest-lie)
    printf 'Run: run-cccccccc-3333-4333-8333-333333333333\n'
    printf '{"runs":[{"runId":"run-cccccccc-3333-4333-8333-333333333333","status":"completed","tokensSpent":17}],"timedOut":false}\n'
    ;;
  harvest-shifting-lie)
    printf 'Run: run-dddddddd-4444-4444-8444-444444444444\n'
    printf '{"runs":[{"runId":"run-dddddddd-4444-4444-8444-444444444444","status":"completed","tokensSpent":19}],"timedOut":false}\n'
    ;;
  oracle-prose)
    printf 'Run: run-eeeeeeee-5555-4555-8555-555555555555\n'
    printf '{"runs":[{"runId":"run-eeeeeeee-5555-4555-8555-555555555555","status":"completed","tokensSpent":0}],"timedOut":false}\n'
    ;;
  o9-special)
    "$CONTROLLER_O9_SHIM" --repo "$CONTROLLER_O9_FIXTURE" \
      --run run-ffffffff-6666-4666-8666-666666666666 --step O9-CONTROLLER-SPECIAL-baseline-execute \
      --force -- /bin/true >/dev/null
    "$CONTROLLER_O9_SHIM" --repo "$CONTROLLER_O9_FIXTURE" \
      --run run-ffffffff-6666-4666-8666-666666666666 --step O9-CONTROLLER-SPECIAL-baseline-replay \
      -- /bin/true >/dev/null
    printf 'Run: run-ffffffff-6666-4666-8666-666666666666\n'
    printf '{"runs":[{"runId":"run-ffffffff-6666-4666-8666-666666666666","status":"completed","tokensSpent":0}],"timedOut":false}\n'
    ;;
esac
SH
chmod +x "$workflow_bin_dir/tamandua"
workflow_manifest="$TEST_ROOT/manifests/workflow-scheduler.jsonl"
valid_case "WORKFLOW-SCHEDULED" \
  | sed 's/"requires":{"toolchains":\["node"\]}/"requires":{}/' \
  | sed 's/"context":{}/"context":{"branch":"feature\/campaign","attempt":2}/' \
  | sed "s#\"class\":\"verification\"#\"reset\":{\"executable\":\"node\",\"args\":[\"-e\",\"require('node:fs').writeFileSync('$workflow_reset_sentinel','reset')\"],\"cwd\":\".\"},\"class\":\"verification\"#" \
  > "$workflow_manifest"
workflow_output=$(PATH="$workflow_bin_dir:$PATH" CONTROLLER_WORKFLOW_EVENTS="$workflow_events" \
  run_recorded_campaign "$CONTROLLER" --manifest "$workflow_manifest") || fail "workflow scheduler path failed: $workflow_output"
workflow_id=$(remember_campaign "$workflow_output")
node --input-type=module - "$TT_DIR/var/results/$workflow_id/state.json" "$workflow_events" "$workflow_reset_sentinel" \
  "$TT_DIR/var/fixtures/work/WORKFLOW-SCHEDULED/tt-ts" <<'NODE'
import fs from 'node:fs';
const [statePath, eventPath, resetPath, fixturePath] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const item = state.cases[0];
if (state.options.token_poll_interval_ms !== 300000
    || state.options.cap_check_interval_ms !== 15000) {
  throw new Error(`production polling/cap-check defaults are wrong: ${JSON.stringify(state.options)}`);
}
if (item.phase !== 'terminal' || item.outcome !== 'PASS' || item.attempts.length !== 1) {
  throw new Error(`workflow case did not reach one terminal record: ${JSON.stringify(item)}`);
}
const attempt = item.attempts[0];
if (attempt.kind !== 'workflow' || !attempt.launch_intent_at || !attempt.launch?.started_at
    || new Date(attempt.launch_intent_at) > new Date(attempt.launch.started_at)) {
  throw new Error(`workflow launch intent was not durable: ${JSON.stringify(attempt)}`);
}
if (fs.readFileSync(resetPath, 'utf8') !== 'reset') throw new Error('workflow reset did not run');
const event = fs.readFileSync(eventPath, 'utf8').trim().split('\n')
  .map(line => JSON.parse(line))
  .find(entry => entry.argv[0] === 'workflow' && entry.argv[1] === 'run');
const expected = ['workflow', 'run', 'bug-fix-merge-worktree', '--task-file'];
if (JSON.stringify(event.argv.slice(0, 4)) !== JSON.stringify(expected)
    || event.argv[4] !== 'tasks/W3.07.md'
    || !event.argv.includes('--wait') || !event.argv.includes('--json')
    || !event.argv.includes('--hermes-as-harness')
    || !event.argv.includes('branch=feature/campaign')
    || !event.argv.includes('attempt=2')) {
  throw new Error(`workflow CLI argv was not scheduled: ${JSON.stringify(event.argv)}`);
}
if (!event.argv.includes('--worktree-origin-repository') || !event.argv.includes(fixturePath)) {
  throw new Error(`workflow fixture origin was not supplied: ${JSON.stringify(event.argv)}`);
}
if (attempt.run_id !== 'run-11111111-1111-4111-8111-111111111111'
    || attempt.run_id_source !== 'stdout-full') {
  throw new Error(`stdout run identifier was not persisted: ${JSON.stringify(attempt)}`);
}
NODE
pass "workflow argv and full stdout run identifier are persisted"

# ── US-003 (T2.1): scripted workflow cases provision their fixture work clone ──
# The ENOENT root cause from the operator campaign: tt-controller gated fixture
# provisioning behind execution_mode === 'real', yet workflowRunArgs passes
# --worktree-origin-repository var/fixtures/work/<case-id>/<fixture> for SCRIPTED
# workflow cases too — the product lstats the origin repository at launch, so a
# clean tree (no authoring-worktree var/ leftovers) died with
# 'ENOENT: no such file or directory, lstat ...' (a scheduler-execution-failed /
# workflow-run-identification TEST_INFRA_FAIL). This regression test drives a
# scripted workflow case with a stub `tamandua` that MIRRORS the product's lstat
# (fails the launch if the origin repository is missing) and asserts the
# controller provisioned the clone BEFORE launch: the clone exists at
# var/fixtures/work/<case>/tt-ts, the attempt records fixture_provision_record +
# fixture_work_clone, the launch argv carries the provisioned path, and the case
# classifies by its terminal run status — never TEST_INFRA_FAIL. Local-command
# cells (fixture 'none') and replay attempts keep their prior semantics (they
# never re-provision; asserted by the replay gate tests above/below).
scripted_fixture_manifest="$TEST_ROOT/manifests/scripted-workflow-fixture.jsonl"
node --input-type=module - "$scripted_fixture_manifest" <<'NODE'
import fs from 'node:fs';
const record = {
  id: 'SCRIPTED-WORKFLOW-FIXTURE', wave: 4, workflow: 'bug-fix-merge-worktree',
  fixture: 'tt-ts', harness: 'scripted-pi',
  task: 'cases/tasks/tier2/W4.04c-keyline-laundering.md',
  context: { execution_mode: 'scripted', test_cmd: 'npm test' },
  caps: { tokens: 0, wall_min: 5 }, requires: {},
  boundary_files: ['fixtures/tt-ts/src'], forbidden: [],
  oracles: [], gates: [], chaos: null, shed_ok: false, mandatory: true,
  class: 'verification',
};
fs.writeFileSync(process.argv[2], `${JSON.stringify(record)}\n`);
NODE
[ -d "$TT_DIR/var/fixtures/golden/tt-ts.git" ] \
  || node "$TT_DIR/bin/tt-golden-bootstrap.mjs" --fixture tt-ts >/dev/null 2>&1 \
  || fail "could not bootstrap the tt-ts golden for the scripted fixture provisioning test"
scripted_clone_path="$TT_DIR/var/fixtures/work/SCRIPTED-WORKFLOW-FIXTURE/tt-ts"
rm -rf -- "$scripted_clone_path"
scripted_fixture_output=$(PATH="$workflow_bin_dir:$PATH" CONTROLLER_WORKFLOW_EVENTS="$workflow_events" \
  CONTROLLER_WORKFLOW_MODE=scripted-fixture-lstat \
  TT_CONTROLLER_POLL_INTERVAL_MS=20 TT_CONTROLLER_TRUTH_RECHECK_MS=20 \
  run_recorded_campaign "$CONTROLLER" --manifest "$scripted_fixture_manifest") \
  || fail "scripted workflow fixture provisioning campaign failed: $scripted_fixture_output"
scripted_fixture_id=$(remember_campaign "$scripted_fixture_output")
node --input-type=module - "$TT_DIR/var/results/$scripted_fixture_id/state.json" \
  "$workflow_events" "$scripted_clone_path" <<'NODE'
import fs from 'node:fs';
const [statePath, eventsPath, clonePath] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const item = state.cases.find((c) => c.id === 'SCRIPTED-WORKFLOW-FIXTURE');
if (!item) throw new Error('scripted workflow case missing from state');
const attempt = item.attempts.at(-1);
// The stub reports a failed terminal run -> the case is INCONCLUSIVE. The
// point is it is NOT TEST_INFRA_FAIL: the provisioned origin repository
// existed, so the stub's product-mirroring lstat never hit ENOENT (before
// US-003 the unprovisioned path made the stub exit 1 with the ENOENT
// signature and the case classify TEST_INFRA_FAIL workflow-run-identification).
if (item.outcome === 'TEST_INFRA_FAIL') {
  throw new Error(`scripted workflow case must not classify TEST_INFRA_FAIL (ENOENT): ${JSON.stringify({ item })}`);
}
if (item.outcome !== 'INCONCLUSIVE' || attempt.terminal_status !== 'failed') {
  throw new Error(`scripted workflow case must classify by its failed terminal run: ${JSON.stringify({ item })}`);
}
if (item.phase !== 'terminal') throw new Error(`scripted workflow case not terminal: ${JSON.stringify(item)}`);
if (attempt.execution_mode !== 'scripted') {
  throw new Error(`expected a scripted attempt: ${JSON.stringify(attempt)}`);
}
if (typeof attempt.fixture_work_clone !== 'string' || attempt.fixture_work_clone === '') {
  throw new Error(`scripted attempt must record the provisioned clone path: ${JSON.stringify(attempt)}`);
}
const provision = attempt.fixture_provision_record;
if (!provision || provision.work_clone_path !== attempt.fixture_work_clone
    || provision.fixture !== 'tt-ts' || provision.case_id !== 'SCRIPTED-WORKFLOW-FIXTURE'
    || typeof provision.golden_bare !== 'string') {
  throw new Error(`scripted attempt must record the fixture_provision_record: ${JSON.stringify(provision)}`);
}
// The clone must physically exist (INCONCLUSIVE teardown keeps it as evidence).
if (!fs.existsSync(clonePath) || !fs.existsSync(`${clonePath}/.git`)
    || !fs.existsSync(`${clonePath}/src/index.ts`)
    || !fs.existsSync(`${clonePath}/operator-notes.local`)) {
  throw new Error(`provisioned clone does not exist at ${clonePath}: ${JSON.stringify(item.teardown)}`);
}
const events = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const launch = [...events].reverse().find((entry) => entry.argv[0] === 'workflow' && entry.argv[1] === 'run');
if (!launch) throw new Error('no workflow run launch recorded');
const originIdx = launch.argv.indexOf('--worktree-origin-repository');
if (originIdx < 0 || launch.argv[originIdx + 1] !== clonePath) {
  throw new Error(`launch argv must pass the provisioned clone as origin: ${JSON.stringify(launch.argv)}`);
}
if (item.teardown?.kept !== true || item.teardown?.work_clone_path !== clonePath) {
  throw new Error(`INCONCLUSIVE teardown must keep the provisioned clone: ${JSON.stringify(item.teardown)}`);
}
NODE
pass "scripted workflow cases provision their fixture work clone before launch (no ENOENT)"

for harvest_mode in harvest-status harvest-db harvest-lie harvest-shifting-lie; do
  harvest_manifest="$TEST_ROOT/manifests/$harvest_mode.jsonl"
  valid_case "$(toupper "$harvest_mode")" \
    | sed 's/"requires":{"toolchains":\["node"\]}/"requires":{}/' \
    > "$harvest_manifest"
  if [ "$harvest_mode" = "harvest-db" ]; then
    node --input-type=module - "$WORKFLOW_REAL_DB" <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
const now = new Date().toISOString();
db.prepare(`INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
  VALUES (?, 'bug-fix-merge-worktree', 'db fallback task', 'completed', '{}', 23, ?, ?)`)
  .run('bbbbbbbb-2222-4222-8222-222222222222', now, now);
db.prepare(`INSERT INTO steps
  (id, run_id, step_id, agent_id, step_index, status, type, current_story_id,
   retry_count, abandoned_count, reroute_count, claim_pid, claim_updated_at, updated_at)
  VALUES ('db-step-row', ?, 'step-db', 'test_agent', 0, 'done', 'single', NULL, 1, 2, 3, NULL, NULL, ?)`)
  .run('bbbbbbbb-2222-4222-8222-222222222222', now);
db.close();
NODE
  fi
  harvest_output=$(PATH="$workflow_bin_dir:$PATH" CONTROLLER_WORKFLOW_EVENTS="$workflow_events" \
    CONTROLLER_WORKFLOW_MODE="$harvest_mode" \
    TT_CONTROLLER_TRUTH_RECHECK_MS=20 run_recorded_campaign "$CONTROLLER" --manifest "$harvest_manifest") \
    || fail "$harvest_mode workflow harvest failed: $harvest_output"
  harvest_id=$(remember_campaign "$harvest_output")
  node --input-type=module - "$TT_DIR/var/results/$harvest_id/state.json" "$harvest_mode" "$workflow_events" "$WORKFLOW_REAL_DB" <<'NODE'
import fs from 'node:fs';
const [statePath, mode, eventsPath, dbPath] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const item = state.cases[0];
const attempt = item.attempts[0];
if (!attempt.terminal_status || !Number.isSafeInteger(attempt.tokens_observed)
    || !Number.isInteger(attempt.wait_exit_code) || !Object.hasOwn(attempt, 'wait_json')
    || !Array.isArray(attempt.steps_snapshot?.steps) || !attempt.steps_snapshot?.source) {
  throw new Error(`workflow terminal harvest is incomplete: ${JSON.stringify(attempt)}`);
}
if (mode === 'harvest-status') {
  if (attempt.terminal_status !== 'completed' || attempt.tokens_observed !== 13
      || attempt.wait_exit_code !== 0 || attempt.wait_json?.runs?.[0]?.status !== 'completed'
      || attempt.steps_snapshot.source !== 'workflow-status-json'
      || attempt.steps_snapshot.steps[0]?.stepId !== 'step-status') {
    throw new Error(`status harvest evidence is wrong: ${JSON.stringify(attempt)}`);
  }
} else if (mode === 'harvest-db') {
  const sqliteCommand = attempt.steps_snapshot?.provenance?.command;
  if (attempt.terminal_status !== 'completed' || attempt.tokens_observed !== 23
      || attempt.wait_exit_code !== 0 || attempt.wait_json !== null
      || attempt.steps_snapshot.source !== 'sqlite-readonly'
      || attempt.steps_snapshot.steps[0]?.step_id !== 'step-db'
      || sqliteCommand?.[0] !== 'sqlite3' || sqliteCommand?.[1] !== '-readonly'
      || sqliteCommand?.[2] !== '-json'
      || !attempt.steps_snapshot.provenance.database.endsWith('var/home/.tamandua/tamandua.db')) {
    throw new Error(`readonly DB fallback evidence is wrong: ${JSON.stringify({attempt,dbPath})}`);
  }
} else if (mode === 'harvest-lie') {
  const finding = item.findings.find(entry => entry.type === 'O13_TRUTHFULNESS');
  if (attempt.terminal_status !== 'failed' || attempt.wait_exit_code !== 0
      || finding?.oracle !== 'O13' || finding?.terminal_status !== 'failed'
      || finding?.wait_exit_code !== 0 || finding?.wait_json_status !== 'completed') {
    throw new Error(`persistent wait/status disagreement was not recorded: ${JSON.stringify({attempt,findings:item.findings})}`);
  }
} else {
  const finding = item.findings.find(entry => entry.type === 'O13_TRUTHFULNESS');
  if (attempt.terminal_status !== 'canceled' || attempt.wait_exit_code !== 0
      || finding?.oracle !== 'O13' || finding?.terminal_status !== 'canceled'
      || finding?.expected_wait_exit_code !== 3 || finding?.wait_exit_code !== 0
      || finding?.wait_json_status !== 'completed') {
    throw new Error(`rechecked wait/status disagreement was lost after terminal state changed: ${JSON.stringify({attempt,findings:item.findings})}`);
  }
}
NODE
done
pass "workflow harvest records status evidence, readonly DB fallback, and O13 disagreements"

# ── E3.C US-006: probe execution engine (in-flight actions + evidence) ──
# The controller's real-case arm must execute a case's probe_sequence against
# the CONTAINED instance (stub `tamandua` on PATH + seeded contained DB) while
# the run is in flight, record per-action evidence (op, trigger, timestamps,
# argv, exit code, observed effect) as attempt.probe_evidence AND as the
# probe-evidence.json artifact, and classify a probe CLI failure as
# TEST_INFRA_FAIL 'probe-action-failed' — never silently swallowed.
PROBE_RUN_ID="run-11111111-1111-4111-8111-111111111111"
PROBE_SHORT_RUN_ID="11111111-1111-4111-8111-111111111111"
PROBE_DB="$WORKFLOW_REAL_DB"

seed_probe_step() {
  node --input-type=module - "$PROBE_DB" "$PROBE_SHORT_RUN_ID" <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
const now = new Date().toISOString();
db.prepare(`INSERT INTO steps
  (id, run_id, step_id, agent_id, step_index, status, type, current_story_id,
   retry_count, abandoned_count, reroute_count, claim_pid, claim_updated_at, updated_at)
  VALUES ('probe-dev-step', ?, 'step-developer', 'developer', 1, 'running', 'single', NULL, 0, 0, 0, NULL, NULL, ?)`)
  .run(process.argv[3], now);
db.close();
NODE
}

remove_probe_step() {
  node --input-type=module - "$PROBE_DB" <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
db.prepare(`DELETE FROM steps WHERE id = 'probe-dev-step'`).run();
db.close();
NODE
}

write_probe_case() {
  local manifest="$1"
  local id="$2"
  local sequence_json="$3"
  node --input-type=module - "$manifest" "$id" "$sequence_json" <<'NODE'
import fs from 'node:fs';
const [manifest, id, sequenceJson] = process.argv.slice(2);
const record = {
  id, wave: 3, workflow: 'bug-fix-merge-worktree', fixture: 'tt-ts', harness: 'hermes',
  task: 'tasks/W3.07.md', context: {}, caps: { tokens: 4000000, wall_min: 240 },
  requires: {}, boundary_files: ['fixtures/tt-ts/src'], forbidden: [],
  oracles: ['TT-MISSING-O1', 'TT-MISSING-O2'], gates: ['W2'], chaos: null,
  probe_sequence: JSON.parse(sequenceJson),
  shed_ok: false, mandatory: true, class: 'verification',
};
fs.writeFileSync(manifest, `${JSON.stringify(record)}\n`);
NODE
}

# Fixture 1: trigger never materializes (no seeded step) -> the probe cannot
# fire before the (stub-terminal) run ends -> TEST_INFRA_FAIL
# 'probe-trigger-unreached', never a silent launch->wait->snapshot PASS.
probe_unreached_manifest="$TEST_ROOT/manifests/probe-unreached.jsonl"
remove_probe_step
write_probe_case "$probe_unreached_manifest" "PROBE-UNREACHED" \
  '[{"run":1,"actions":[{"op":"pause","when":"step:developer:running","hold_seconds":1},{"op":"resume","when":"now"}]}]'
probe_unreached_events="$TEST_ROOT/probe-unreached-events.jsonl"
probe_unreached_output=$(PATH="$workflow_bin_dir:$PATH" CONTROLLER_WORKFLOW_EVENTS="$probe_unreached_events" \
  CONTROLLER_WORKFLOW_MODE=stdout run_recorded_campaign "$CONTROLLER" --manifest "$probe_unreached_manifest") \
  || fail "probe trigger-unreached campaign failed: $probe_unreached_output"
probe_unreached_id=$(remember_campaign "$probe_unreached_output")
node --input-type=module - "$TT_DIR/var/results/$probe_unreached_id/state.json" "$probe_unreached_id" <<'NODE'
import fs from 'node:fs';
const [statePath] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const attempt = state.cases[0].attempts[0];
if (attempt.outcome !== 'TEST_INFRA_FAIL'
    || attempt.classification_reason?.category !== 'probe-trigger-unreached'
    || attempt.classification_reason?.op !== 'pause'
    || attempt.classification_reason?.trigger !== 'step:developer:running'
    || attempt.classification_reason?.run_terminal_status !== 'completed') {
  throw new Error(`unreached trigger did not classify TEST_INFRA_FAIL probe-trigger-unreached: ${JSON.stringify({outcome: attempt.outcome, reason: attempt.classification_reason})}`);
}
if (!attempt.probe_evidence || attempt.probe_evidence.sequence_outcome !== 'failed'
    || attempt.probe_evidence.actions.length !== 1
    || attempt.probe_evidence.actions[0].op !== 'pause'
    || attempt.probe_evidence.actions[0].failure?.category !== 'probe-trigger-unreached'
    || attempt.probe_evidence.actions[0].argv !== null
    || attempt.probe_evidence.actions[0].exit_code !== null) {
  throw new Error(`unreached-trigger probe evidence is wrong: ${JSON.stringify(attempt.probe_evidence)}`);
}
NODE
pass "a probe trigger that never fires classifies TEST_INFRA_FAIL probe-trigger-unreached with evidence"

# Fixture 2: single-run probe_sequence (pause @ step:developer:running with a
# 1s hold, then resume @ now) executes in order while the run is in flight;
# attempt.probe_evidence + the probe-evidence.json artifact carry per-action
# timestamps/argv/exit codes/observed effects; the stub records the pause and
# resume argv; the case still classifies PASS.
probe_happy_manifest="$TEST_ROOT/manifests/probe-happy.jsonl"
seed_probe_step
write_probe_case "$probe_happy_manifest" "PROBE-HAPPY" \
  '[{"run":1,"actions":[{"op":"pause","when":"step:developer:running","hold_seconds":1},{"op":"resume","when":"now"}]}]'
probe_happy_events="$TEST_ROOT/probe-happy-events.jsonl"
probe_happy_output=$(PATH="$workflow_bin_dir:$PATH" CONTROLLER_WORKFLOW_EVENTS="$probe_happy_events" \
  CONTROLLER_WORKFLOW_MODE=stdout run_recorded_campaign "$CONTROLLER" --manifest "$probe_happy_manifest") \
  || fail "single-run probe sequence campaign failed: $probe_happy_output"
probe_happy_id=$(remember_campaign "$probe_happy_output")
node --input-type=module - "$TT_DIR/var/results/$probe_happy_id/state.json" \
  "$TT_DIR/var/results/$probe_happy_id" "$probe_happy_events" "$PROBE_RUN_ID" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const [statePath, campaignDir, eventsPath, runId] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const item = state.cases[0];
const attempt = item.attempts[0];
if (attempt.outcome !== 'PASS') {
  throw new Error(`single-run probe case did not PASS: ${JSON.stringify({outcome: attempt.outcome, reason: attempt.classification_reason})}`);
}
const evidence = attempt.probe_evidence;
if (!evidence || evidence.sequence_outcome !== 'completed'
    || evidence.run_id !== runId || evidence.run_ordinal !== 1
    || evidence.actions.length !== 2) {
  throw new Error(`probe evidence is incomplete: ${JSON.stringify(evidence)}`);
}
const [pause, resume] = evidence.actions;
const utcRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
if (pause.op !== 'pause' || pause.trigger !== 'step:developer:running'
    || JSON.stringify(pause.argv) !== JSON.stringify(['tamandua', 'workflow', 'pause', runId])
    || pause.exit_code !== 0 || pause.signal !== null || pause.error !== null
    || !utcRe.test(pause.armed_at) || !utcRe.test(pause.action_started_at)
    || !utcRe.test(pause.action_ended_at)
    || pause.hold_seconds !== 1 || !utcRe.test(pause.hold_started_at) || !utcRe.test(pause.hold_ended_at)
    || new Date(pause.hold_ended_at).valueOf() - new Date(pause.hold_started_at).valueOf() < 900
    || pause.effect?.status_after?.status !== 'completed'
    || !Array.isArray(pause.effect?.events_excerpt?.events)) {
  throw new Error(`pause probe record is wrong: ${JSON.stringify(pause)}`);
}
if (resume.op !== 'resume' || resume.trigger !== 'now'
    || JSON.stringify(resume.argv) !== JSON.stringify(['tamandua', 'workflow', 'resume', runId])
    || resume.exit_code !== 0 || resume.hold_seconds !== null
    || resume.effect?.status_after?.status !== 'completed') {
  throw new Error(`resume probe record is wrong: ${JSON.stringify(resume)}`);
}
const artifactPath = path.join(campaignDir, 'evidence', item.id, attempt.id, 'probe-evidence.json');
const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
if (JSON.stringify(artifact) !== JSON.stringify(evidence)) {
  throw new Error('probe-evidence.json artifact does not match attempt.probe_evidence');
}
const stubCalls = fs.readFileSync(eventsPath, 'utf8').trim().split('\n')
  .map((line) => JSON.parse(line))
  .filter((entry) => JSON.stringify(entry.argv).includes('"pause"') || JSON.stringify(entry.argv).includes('"resume"'));
if (stubCalls.length !== 2
    || JSON.stringify(stubCalls[0].argv) !== JSON.stringify(['workflow', 'pause', runId])
    || JSON.stringify(stubCalls[1].argv) !== JSON.stringify(['workflow', 'resume', runId])) {
  throw new Error(`stub did not record the pause/resume argv in order: ${JSON.stringify(stubCalls)}`);
}
NODE
pass "single-run probe sequence executes pause/resume in order and lands full evidence on the attempt + artifact"

# Fixture 3: a probe CLI failure (stub `workflow pause` refuses with exit 3)
# classifies TEST_INFRA_FAIL 'probe-action-failed' naming the op + exit code,
# and the sequence stops at the failed action (resume never fires).
probe_fail_manifest="$TEST_ROOT/manifests/probe-fail.jsonl"
write_probe_case "$probe_fail_manifest" "PROBE-FAIL" \
  '[{"run":1,"actions":[{"op":"pause","when":"step:developer:running","hold_seconds":1},{"op":"resume","when":"now"}]}]'
probe_fail_events="$TEST_ROOT/probe-fail-events.jsonl"
probe_fail_output=$(PATH="$workflow_bin_dir:$PATH" CONTROLLER_WORKFLOW_EVENTS="$probe_fail_events" \
  CONTROLLER_WORKFLOW_MODE=probe-pause-fail run_recorded_campaign "$CONTROLLER" --manifest "$probe_fail_manifest") \
  || fail "probe CLI failure campaign failed: $probe_fail_output"
probe_fail_id=$(remember_campaign "$probe_fail_output")
node --input-type=module - "$TT_DIR/var/results/$probe_fail_id/state.json" \
  "$TT_DIR/var/results/$probe_fail_id" "$probe_fail_events" "$PROBE_RUN_ID" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const [statePath, campaignDir, eventsPath, runId] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const item = state.cases[0];
const attempt = item.attempts[0];
if (attempt.outcome !== 'TEST_INFRA_FAIL'
    || attempt.classification_reason?.category !== 'probe-action-failed'
    || attempt.classification_reason?.op !== 'pause'
    || attempt.classification_reason?.exit_code !== 3) {
  throw new Error(`probe CLI failure did not classify TEST_INFRA_FAIL probe-action-failed: ${JSON.stringify({outcome: attempt.outcome, reason: attempt.classification_reason})}`);
}
const evidence = attempt.probe_evidence;
if (!evidence || evidence.sequence_outcome !== 'failed' || evidence.actions.length !== 1
    || evidence.actions[0].op !== 'pause'
    || evidence.actions[0].argv?.[3] !== runId
    || evidence.actions[0].exit_code !== 3
    || evidence.actions[0].failure?.category !== 'probe-action-failed'
    || evidence.actions[0].failure?.exit_code !== 3
    || evidence.failure?.category !== 'probe-action-failed') {
  throw new Error(`probe failure evidence is wrong: ${JSON.stringify(evidence)}`);
}
const artifactPath = path.join(campaignDir, 'evidence', item.id, attempt.id, 'probe-evidence.json');
const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
if (JSON.stringify(artifact) !== JSON.stringify(evidence)) {
  throw new Error('failed-probe artifact does not match attempt.probe_evidence');
}
const stubCalls = fs.readFileSync(eventsPath, 'utf8').trim().split('\n')
  .map((line) => JSON.parse(line))
  .filter((entry) => JSON.stringify(entry.argv).includes('"pause"') || JSON.stringify(entry.argv).includes('"resume"'));
if (stubCalls.length !== 1
    || JSON.stringify(stubCalls[0].argv) !== JSON.stringify(['workflow', 'pause', runId])) {
  throw new Error(`a failed pause must stop the sequence (no resume): ${JSON.stringify(stubCalls)}`);
}
NODE
pass "a probe CLI failure classifies TEST_INFRA_FAIL probe-action-failed naming the op and stops the sequence"
remove_probe_step

# ── E3.C US-007: multi-launch probe orchestration (W3.20/W3.22 shapes) ──
# The controller must GENUINELY execute multi-run probe_sequences — W3.20's two
# sequential runs (each cancel asserting the run.canceled terminal event lands
# via the event-stream excerpt) and W3.22's three concurrent runs with a
# mid-flight contained-daemon restart via daemon-control (NEVER a bare
# `tamandua restart`). Stub `tamandua` emits per-launch run ids
# (CONTROLLER_MULTI_RUN_COUNTER) and per-run statuses; a stub daemon-control
# records its argv so the test can prove the restart path.
MULTI_RUN_SEQ_1="run-aaaa1111-1111-4111-8111-111111111111"
MULTI_RUN_SEQ_2="run-bbbb2222-2222-4222-8222-222222222222"
MULTI_RUN_CONC_1="run-cccc1111-1111-4111-8111-111111111111"
MULTI_RUN_CONC_2="run-cccc2222-2222-4222-8222-222222222222"
MULTI_RUN_CONC_3="run-cccc3333-3333-4333-8333-333333333333"
MULTI_RUN_SEQ_1_SHORT="aaaa1111-1111-4111-8111-111111111111"
MULTI_RUN_SEQ_2_SHORT="bbbb2222-2222-4222-8222-222222222222"
MULTI_RUN_CONC_1_SHORT="cccc1111-1111-4111-8111-111111111111"
MULTI_RUN_EVENTS_DIR="$TT_DIR/var/home/.tamandua/events"
MULTI_RUN_SEEDED_EVENTS=()

seed_multi_step() {
  local db="$1" run_short="$2" agent="$3" step_id="$4"
  node --input-type=module - "$db" "$run_short" "$agent" "$step_id" <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const [dbPath, runShort, agent, stepId] = process.argv.slice(2);
const db = new DatabaseSync(dbPath);
const now = new Date().toISOString();
db.prepare(`INSERT INTO steps
  (id, run_id, step_id, agent_id, step_index, status, type, current_story_id,
   retry_count, abandoned_count, reroute_count, claim_pid, claim_updated_at, updated_at)
  VALUES (?, ?, ?, ?, 1, 'running', 'single', NULL, 0, 0, 0, NULL, NULL, ?)`)
  .run(stepId, runShort, `step-${agent}`, agent, now);
db.close();
NODE
}

remove_multi_steps() {
  node --input-type=module - "$PROBE_DB" <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
for (const id of ['multi-run-1-dev', 'multi-run-2-fin', 'multi-run-conc-1-dev']) {
  db.prepare(`DELETE FROM steps WHERE id = ?`).run(id);
}
db.close();
NODE
}

seed_run_canceled_event() {
  local run_id="$1" short_id="$2"
  mkdir -p "$MULTI_RUN_EVENTS_DIR"
  local event_file="$MULTI_RUN_EVENTS_DIR/$short_id.jsonl"
  printf '%s\n' "{\"event\":\"run.canceled\",\"ts\":\"2999-01-01T00:00:00.000Z\",\"runId\":\"$run_id\"}" > "$event_file"
  MULTI_RUN_SEEDED_EVENTS+=("$event_file")
}

# Fixture 1 (W3.20 shape): TWO runs launched SEQUENTIALLY — run 1 cancels at
# step:developer:running, run 2 cancels at step:finalize_merge:running — with
# per-run probe evidence (run.canceled terminal event asserted via the
# event-stream excerpt for BOTH cancels). The stub records the launch/cancel
# argv in order; no daemon-control / restart is ever constructed.
multi_seq_manifest="$TEST_ROOT/manifests/multi-run-seq.jsonl"
remove_multi_steps
seed_multi_step "$PROBE_DB" "$MULTI_RUN_SEQ_1_SHORT" "developer" "multi-run-1-dev"
seed_multi_step "$PROBE_DB" "$MULTI_RUN_SEQ_2_SHORT" "finalize_merge" "multi-run-2-fin"
seed_run_canceled_event "$MULTI_RUN_SEQ_1" "$MULTI_RUN_SEQ_1_SHORT"
seed_run_canceled_event "$MULTI_RUN_SEQ_2" "$MULTI_RUN_SEQ_2_SHORT"
write_probe_case "$multi_seq_manifest" "MULTI-RUN-SEQ" \
  '[{"run":1,"actions":[{"op":"cancel","when":"step:developer:running","expect":{"canceled_terminal_event":true}}]},{"run":2,"actions":[{"op":"cancel","when":"step:finalize_merge:running","expect":{"canceled_terminal_event":true}}]}]'
multi_seq_events="$TEST_ROOT/multi-run-seq-events.jsonl"
multi_seq_counter="$TEST_ROOT/multi-run-seq-counter"
multi_seq_output=$(PATH="$workflow_bin_dir:$PATH" CONTROLLER_WORKFLOW_EVENTS="$multi_seq_events" \
  CONTROLLER_WORKFLOW_MODE=multi-run-seq CONTROLLER_MULTI_RUN_COUNTER="$multi_seq_counter" \
  TT_CONTROLLER_TOKEN_SETTLE_MS=20 run_recorded_campaign "$CONTROLLER" --manifest "$multi_seq_manifest") \
  || fail "two-run sequential probe campaign failed: $multi_seq_output"
multi_seq_id=$(remember_campaign "$multi_seq_output")
node --input-type=module - "$TT_DIR/var/results/$multi_seq_id/state.json" "$multi_seq_events" \
  "$MULTI_RUN_SEQ_1" "$MULTI_RUN_SEQ_2" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const [statePath, eventsPath, run1Id, run2Id] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const item = state.cases[0];
const attempt = item.attempts[0];
if (attempt.probe_sequence_deferred !== undefined) {
  throw new Error(`multi-run sequence must no longer be deferred: ${JSON.stringify(attempt.probe_sequence_deferred)}`);
}
if (attempt.multi_run_probe?.launch_shape !== 'sequential' || attempt.multi_run_probe?.status !== 'completed') {
  throw new Error(`multi_run_probe evidence is wrong: ${JSON.stringify(attempt.multi_run_probe)}`);
}
const evidence = attempt.probe_evidence;
if (!evidence || evidence.launch_shape !== 'sequential' || evidence.sequence_outcome !== 'completed'
    || !Array.isArray(evidence.runs) || evidence.runs.length !== 2) {
  throw new Error(`sequential probe evidence is incomplete: ${JSON.stringify(evidence)}`);
}
const byOrdinal = new Map(evidence.runs.map((run) => [run.run_ordinal, run]));
const run1 = byOrdinal.get(1);
const run2 = byOrdinal.get(2);
if (!run1 || !run2) throw new Error(`per-run evidence must carry both ordinals: ${JSON.stringify(evidence.runs)}`);
const utcRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
if (run1.run_id !== run1Id || run1.launch_hook !== 'launch' || run1.terminal_status !== 'canceled'
    || run1.actions.length !== 1 || run1.actions[0].op !== 'cancel'
    || JSON.stringify(run1.actions[0].argv) !== JSON.stringify(['tamandua', 'workflow', 'cancel', run1Id])
    || run1.actions[0].exit_code !== 0 || !utcRe.test(run1.actions[0].action_started_at)
    || !Array.isArray(run1.actions[0].effect?.events_excerpt?.events)
    || !run1.actions[0].effect.events_excerpt.events.some((event) => event.event === 'run.canceled')) {
  throw new Error(`run 1 sequential probe evidence is wrong: ${JSON.stringify(run1)}`);
}
if (run2.run_id !== run2Id || run2.launch_hook !== 'launch_2' || run2.terminal_status !== 'canceled'
    || run2.actions.length !== 1 || run2.actions[0].op !== 'cancel'
    || run2.actions[0].trigger !== 'step:finalize_merge:running'
    || JSON.stringify(run2.actions[0].argv) !== JSON.stringify(['tamandua', 'workflow', 'cancel', run2Id])
    || run2.actions[0].exit_code !== 0
    || !Array.isArray(run2.actions[0].effect?.events_excerpt?.events)
    || !run2.actions[0].effect.events_excerpt.events.some((event) => event.event === 'run.canceled')) {
  throw new Error(`run 2 sequential probe evidence is wrong: ${JSON.stringify(run2)}`);
}
if (attempt.outcome !== 'INCONCLUSIVE'
    || attempt.classification_reason?.category !== 'ambiguous-evidence'
    || attempt.classification_reason?.ambiguities?.[0]?.category !== 'workflow-terminal'
    || attempt.classification_reason?.ambiguities?.[0]?.terminal_statuses?.length !== 2) {
  throw new Error(`sequential case must classify INCONCLUSIVE with both canceled runs: ${JSON.stringify({outcome: attempt.outcome, reason: attempt.classification_reason})}`);
}
const stubCalls = fs.readFileSync(eventsPath, 'utf8').trim().split('\n')
  .map((line) => JSON.parse(line));
const launches = stubCalls.filter((entry) => entry.argv[0] === 'workflow' && entry.argv[1] === 'run');
const cancels = stubCalls.filter((entry) => entry.argv[0] === 'workflow' && entry.argv[1] === 'cancel');
if (launches.length !== 2 || cancels.length !== 2
    || JSON.stringify(cancels[0].argv) !== JSON.stringify(['workflow', 'cancel', run1Id])
    || JSON.stringify(cancels[1].argv) !== JSON.stringify(['workflow', 'cancel', run2Id])
    || new Date(cancels[0].at) > new Date(cancels[1].at)) {
  throw new Error(`stub must record launch 1 → cancel 1 → launch 2 → cancel 2 in order: ${JSON.stringify(stubCalls)}`);
}
if (stubCalls.some((entry) => JSON.stringify(entry.argv).includes('restart'))) {
  throw new Error(`no daemon restart may be constructed for the sequential shape: ${JSON.stringify(stubCalls)}`);
}
const artifactPath = path.join(path.dirname(statePath), 'evidence', item.id, attempt.id, 'probe-evidence.json');
const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
if (JSON.stringify(artifact) !== JSON.stringify(attempt.probe_evidence)) {
  throw new Error('multi-run probe-evidence.json artifact does not match attempt.probe_evidence');
}
NODE
remove_multi_steps
for seeded_event in "${MULTI_RUN_SEEDED_EVENTS[@]}"; do rm -f -- "$seeded_event"; done
MULTI_RUN_SEEDED_EVENTS=()
pass "two-run sequential probe sequence (W3.20 shape) launches sequentially and records per-run run.canceled evidence"

# Fixture 2 (W3.22 shape): THREE runs launched CONCURRENTLY (staggered per
# state options), then restart_daemon executes ONCE mid-flight via
# daemon-control (stub records its argv — never a bare `tamandua restart`);
# per-run recovery (within 2 dispatch intervals) + token-flush preservation
# are recorded as evidence. All three runs complete → PASS.
daemon_control_stub="$TEST_ROOT/daemon-control-stub"
cat > "$daemon_control_stub" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$(node -e 'process.stdout.write(JSON.stringify({argv:process.argv.slice(1),at:Date.now()}))' "$@")" >> "$CONTROLLER_DAEMON_EVENTS"
exit 0
SH
chmod +x "$daemon_control_stub"
multi_conc_manifest="$TEST_ROOT/manifests/multi-run-conc.jsonl"
remove_multi_steps
seed_multi_step "$PROBE_DB" "$MULTI_RUN_CONC_1_SHORT" "developer" "multi-run-conc-1-dev"
write_probe_case "$multi_conc_manifest" "MULTI-RUN-CONC" \
  '[{"run":1,"actions":[{"op":"restart_daemon","when":"step:developer:running","expect":{"recovery_within_dispatch_intervals":2,"token_flush_preserved":true,"run_completes":true}}]},{"run":2,"actions":[{"op":"restart_daemon","when":"step:developer:running","expect":{"recovery_within_dispatch_intervals":2,"token_flush_preserved":true,"run_completes":true}}]},{"run":3,"actions":[{"op":"restart_daemon","when":"step:developer:running","expect":{"recovery_within_dispatch_intervals":2,"token_flush_preserved":true,"run_completes":true}}]}]'
multi_conc_events="$TEST_ROOT/multi-run-conc-events.jsonl"
multi_conc_daemon_events="$TEST_ROOT/multi-run-conc-daemon-events.jsonl"
multi_conc_counter="$TEST_ROOT/multi-run-conc-counter"
multi_conc_output=$(PATH="$workflow_bin_dir:$PATH" CONTROLLER_WORKFLOW_EVENTS="$multi_conc_events" \
  CONTROLLER_WORKFLOW_MODE=multi-run-conc CONTROLLER_MULTI_RUN_COUNTER="$multi_conc_counter" \
  CONTROLLER_DAEMON_EVENTS="$multi_conc_daemon_events" \
  TT_CONTROLLER_DAEMON_CONTROL_PATH="$daemon_control_stub" TT_CONTROLLER_TOKEN_SETTLE_MS=20 \
  run_recorded_campaign "$CONTROLLER" --manifest "$multi_conc_manifest" --stagger 50ms) \
  || fail "three-concurrent-run probe campaign failed: $multi_conc_output"
multi_conc_id=$(remember_campaign "$multi_conc_output")
node --input-type=module - "$TT_DIR/var/results/$multi_conc_id/state.json" "$multi_conc_events" \
  "$multi_conc_daemon_events" "$daemon_control_stub" \
  "$MULTI_RUN_CONC_1" "$MULTI_RUN_CONC_2" "$MULTI_RUN_CONC_3" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const [statePath, eventsPath, daemonEventsPath, daemonStubPath, run1Id, run2Id, run3Id] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const item = state.cases[0];
const attempt = item.attempts[0];
if (attempt.outcome !== 'PASS') {
  throw new Error(`concurrent multi-run case did not PASS: ${JSON.stringify({outcome: attempt.outcome, reason: attempt.classification_reason})}`);
}
if (attempt.multi_run_probe?.launch_shape !== 'concurrent' || attempt.multi_run_probe?.status !== 'completed') {
  throw new Error(`multi_run_probe evidence is wrong: ${JSON.stringify(attempt.multi_run_probe)}`);
}
if (attempt.run_id !== run1Id) {
  throw new Error(`the attempt must bind to the primary (run 1) id after the sequence: ${attempt.run_id}`);
}
const evidence = attempt.probe_evidence;
if (!evidence || evidence.launch_shape !== 'concurrent' || evidence.sequence_outcome !== 'completed'
    || !Array.isArray(evidence.runs) || evidence.runs.length !== 3
    || !Array.isArray(evidence.daemon_restarts) || evidence.daemon_restarts.length !== 1) {
  throw new Error(`concurrent probe evidence is incomplete: ${JSON.stringify(evidence)}`);
}
const byOrdinal = new Map(evidence.runs.map((run) => [run.run_ordinal, run]));
const expectedIds = [run1Id, run2Id, run3Id];
for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
  const run = byOrdinal.get(ordinal);
  if (!run) throw new Error(`missing run ${ordinal} evidence: ${JSON.stringify(evidence.runs)}`);
  if (!expectedIds.includes(run.run_id) || run.terminal_status !== 'completed') {
    throw new Error(`run ${ordinal} evidence is wrong: ${JSON.stringify(run)}`);
  }
  const restartAction = run.actions.find((action) => action.op === 'restart_daemon');
  if (!restartAction || restartAction.exit_code !== 0
      || restartAction.effect?.recovery?.recovered !== true
      || restartAction.effect?.recovery?.recovery_within_dispatch_intervals !== true
      || restartAction.effect?.recovery?.tokens_after_restart
        < restartAction.effect?.recovery?.tokens_before_restart
      || restartAction.effect?.recovery?.token_flush_preserved !== true) {
    throw new Error(`run ${ordinal} restart/recovery evidence is wrong: ${JSON.stringify(run)}`);
  }
}
const restart = evidence.daemon_restarts[0];
if (restart.op !== 'restart_daemon' || restart.kind !== 'real' || restart.exit_code !== 0
    || restart.argv?.[0] !== daemonStubPath || restart.argv?.[1] !== 'real' || restart.argv?.[2] !== 'restart'
    || !Array.isArray(restart.recovery) || restart.recovery.length !== 3) {
  throw new Error(`daemon restart evidence is wrong: ${JSON.stringify(restart)}`);
}
// E3.C.1 US-003: the restart teardown must go through RECORDED provenance —
// the controller records the daemon provenance (kind + pidfile pid +
// startTime identity) in the restart evidence and never resolves the daemon
// by /proc/port sweep (daemon-control applies its own provenance + identity
// checks per US-004). MACP3 US-004 doc note: '/proc' here is documentation
// prose — this harness never reads procfs (recorded provenance instead); the
// linux-only /proc sweep concept is unreachable-as-runtime on Darwin.
if (restart.provenance?.kind !== 'real'
    || !['unavailable', 'pidfile', 'pidfile+identity'].includes(restart.provenance.source)) {
  throw new Error(`daemon restart must record daemon provenance: ${JSON.stringify(restart.provenance)}`);
}
const stubCalls = fs.readFileSync(eventsPath, 'utf8').trim().split('\n')
  .map((line) => JSON.parse(line));
if (stubCalls.some((entry) => entry.argv[0] === 'workflow' && entry.argv[1] === 'restart')
    || stubCalls.some((entry) => entry.argv[0] === 'restart')) {
  throw new Error(`a bare tamandua restart must never be constructed: ${JSON.stringify(stubCalls)}`);
}
const daemonCalls = fs.readFileSync(daemonEventsPath, 'utf8').trim().split('\n')
  .map((line) => JSON.parse(line));
if (daemonCalls.length !== 1
    || JSON.stringify(daemonCalls[0].argv) !== JSON.stringify(['real', 'restart'])) {
  throw new Error(`daemon-control must be invoked exactly once with [real restart]: ${JSON.stringify(daemonCalls)}`);
}
NODE
remove_multi_steps
pass "three-concurrent-run probe sequence (W3.22 shape) restarts the contained daemon via daemon-control and records per-run recovery"

# ── E3.C US-008: chaos wiring (honor manifest chaos blocks) ──────────
# The controller's real-case arm must honor a case's manifest `chaos` block
# by invoking bin/tt-chaos under the case's contained spawn env while the
# run is in flight (W3.17b sigstop_sigcont on the harness process), record
# start/stop evidence as attempt.chaos_evidence (invocation argv, timestamps,
# exit code), and let the oracle snapshot copy var/chaos/chaos.log under the
# chaos_log evidence key (O4's REQUIRED_ORACLE_EVIDENCE — a chaos:null case
# must NEVER spawn tt-chaos, and a chaos invocation failure must classify
# TEST_INFRA_FAIL 'chaos-invocation-failed'). Tests stub bin/tt-chaos via
# TT_CONTROLLER_TT_CHAOS_PATH (mirrors the daemon-control stub) and record
# its argv; the chaos:null fixture's stub would exit non-zero if ever
# spawned, so any accidental invocation fails the campaign loudly.

CHAOS_BLOCK='{"type":"sigstop_sigcont","target":"harness_process","trigger":"mid_round","hold_seconds":600,"operator":"tt-chaos"}'
CHAOS_RUN_ID="run-11111111-1111-4111-8111-111111111111"
mkdir -p "$(dirname "$CHAOS_LOG_FILE")"
if [ -f "$CHAOS_LOG_FILE" ]; then cp "$CHAOS_LOG_FILE" "$CHAOS_LOG_BACKUP"; fi
: > "$CHAOS_LOG_FILE"

write_chaos_case() {
  local manifest="$1"
  local id="$2"
  local chaos_json="$3"
  local oracles_json="${4:-[\"TT-MISSING-O1\",\"TT-MISSING-O2\"]}"
  node --input-type=module - "$manifest" "$id" "$chaos_json" "$oracles_json" <<'NODE'
import fs from 'node:fs';
const [manifest, id, chaosJson, oraclesJson] = process.argv.slice(2);
const record = {
  id, wave: 3, workflow: 'bug-fix-merge-worktree', fixture: 'tt-ts', harness: 'hermes',
  task: 'tasks/W3.07.md', context: {}, caps: { tokens: 4000000, wall_min: 240 },
  requires: {}, boundary_files: ['fixtures/tt-ts/src'], forbidden: [],
  oracles: JSON.parse(oraclesJson), gates: ['W3'], chaos: JSON.parse(chaosJson),
  shed_ok: false, mandatory: true, class: 'verification',
};
fs.writeFileSync(manifest, `${JSON.stringify(record)}\n`);
NODE
}

# Stub tt-chaos: records its full argv to $CONTROLLER_CHAOS_EVENTS and, in
# record mode, appends the three sigstop_sigcont chaos.log entries a real
# operator would write (start/hold/cont) — the chaos_log the oracle snapshot
# copies for O4. The stub NEVER actually signals anything (no real harness);
# it only proves the controller's invocation contract. The entries carry the
# EXPLICIT --target-pid the controller passed (E3.C.1 US-003: fired chaos.log
# entries must reference recorded pid: targets, never scan-resolved ones).
cat > "$TEST_ROOT/tt-chaos-stub" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$(node -e 'process.stdout.write(JSON.stringify({argv:process.argv.slice(1),at:Date.now()}))' "$@")" >> "$CONTROLLER_CHAOS_EVENTS"
CHAOS_RUN=""
CHAOS_TARGET_PID=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--run" ]; then CHAOS_RUN="$arg"; fi
  if [ "$prev" = "--target-pid" ]; then CHAOS_TARGET_PID="$arg"; fi
  prev="$arg"
done
if [ "${CONTROLLER_CHAOS_MODE:-record}" = "record" ]; then
  printf '%s\n' "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"action\":\"sigstop_sigcont\",\"entry\":\"start\",\"runId\":\"$CHAOS_RUN\",\"pid\":$CHAOS_TARGET_PID}" >> "$CHAOS_LOG_FILE"
  printf '%s\n' "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"action\":\"sigstop_sigcont\",\"entry\":\"hold_complete\",\"runId\":\"$CHAOS_RUN\",\"pid\":$CHAOS_TARGET_PID}" >> "$CHAOS_LOG_FILE"
  printf '%s\n' "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"action\":\"sigstop_sigcont\",\"entry\":\"cont\",\"runId\":\"$CHAOS_RUN\",\"pid\":$CHAOS_TARGET_PID}" >> "$CHAOS_LOG_FILE"
fi
exit 0
SH
chmod +x "$TEST_ROOT/tt-chaos-stub"
cat > "$TEST_ROOT/tt-chaos-fail-stub" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$(node -e 'process.stdout.write(JSON.stringify({argv:process.argv.slice(1),at:Date.now()}))' "$@")" >> "$CONTROLLER_CHAOS_EVENTS"
printf 'chaos operator refused\n' >&2
exit 3
SH
chmod +x "$TEST_ROOT/tt-chaos-fail-stub"

# E3.C.1 US-003: harness-target-record fixtures. The controller must hand
# tt-chaos EXPLICIT --target-* args from a RECORDED harness identity (the
# steps-table claim row — { pid: claim_pgid, pgid: claim_pgid } — or the
# launch-process record) and never let the operator re-resolve by /proc sweep.
# MACP3 US-004 doc note: all '/proc' mentions in this block are documentation
# prose describing the OLD linux-only /proc cwd/cmdline scan — this harness
# never reads procfs (recorded explicit targets instead), so nothing is
# reachable-as-runtime on Darwin.
# To prove it:
#   * a fake-harness process (setsid own-group leader under var/) becomes the
#     steps-table claim_pgid — the RECORDED target the chaos argv must name;
#   * a decoy process matching the OLD /proc scan signature (cwd under TT_ROOT
#     + runId in argv[0]) must SURVIVE the run — an explicit-target operator
#     never touches it.
# Both spawn under setsid so their pgid is disjoint from the suite's ancestry.
CHAOS_SHORT_RUN_ID="${CHAOS_RUN_ID#run-}"
CHAOS_TARGETS_FILE="$TT_DIR/var/targets/$CHAOS_RUN_ID.json"

spawn_chaos_fake_harness() {
  ( cd "$TT_DIR" && exec setsid bash -c 'exec -a tt-fake-harness sleep 300' _ ) &
  FAKE_HARNESS_PID=$!
}

spawn_chaos_decoy() {
  ( cd "$TT_DIR" && exec setsid bash -c 'exec -a "$1" sleep 300' _ "$CHAOS_RUN_ID" ) &
  DECOY_PID=$!
}

seed_chaos_claim() {
  node --input-type=module - "$PROBE_DB" "$CHAOS_SHORT_RUN_ID" "$FAKE_HARNESS_PID" <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const [dbPath, runShort, pgid] = process.argv.slice(2);
const db = new DatabaseSync(dbPath);
const now = new Date().toISOString();
db.prepare(`INSERT INTO steps
  (id, run_id, step_id, agent_id, step_index, status, type, current_story_id,
   retry_count, abandoned_count, reroute_count, claim_pid, claim_pgid, claim_updated_at, updated_at)
  VALUES ('chaos-claim-row', ?, 'step-developer', 'developer', 1, 'running', 'single', NULL, 0, 0, 0, ?, ?, ?, ?)`)
  .run(runShort, pgid, pgid, now, now);
db.close();
NODE
}

remove_chaos_claim() {
  node --input-type=module - "$PROBE_DB" <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
db.prepare(`DELETE FROM steps WHERE id = 'chaos-claim-row'`).run();
db.close();
NODE
}

clean_chaos_state() {
  remove_chaos_claim
  rm -f -- "$CHAOS_TARGETS_FILE"
}

reap_chaos_processes() {
  if [ -n "$DECOY_PID" ]; then
    kill -TERM "$DECOY_PID" 2>/dev/null || true
    wait "$DECOY_PID" 2>/dev/null || true
    DECOY_PID=""
  fi
  if [ -n "$FAKE_HARNESS_PID" ]; then
    kill -TERM "$FAKE_HARNESS_PID" 2>/dev/null || true
    wait "$FAKE_HARNESS_PID" 2>/dev/null || true
    FAKE_HARNESS_PID=""
  fi
}

# Fixture 1: a chaos-block case invokes tt-chaos exactly per the manifest
# (operator tt-chaos, sigstop_sigcont, --run <run-id>, --when
# step:developer:running [mid_round translated], --hold-seconds 600), with
# start/stop records in attempt.chaos_evidence AND chaos.log captured into
# the oracle snapshot under the chaos_log key. The case declares O4 (whose
# REQUIRED_ORACLE_EVIDENCE includes chaos_log), so the controller's
# gating-oracle context validation only passes if the chaos log was actually
# captured — the O4 stub (self-test oracle root) then returns PASS.
chaos_oracle_root="$TEST_ROOT/self-test-oracles"
mkdir -p "$chaos_oracle_root"
cat > "$chaos_oracle_root/O4" <<'NODE'
#!/usr/bin/env node
import fs from 'node:fs';
const contextFlag = process.argv.indexOf('--context');
if (process.argv[2] !== '--contract-version' || process.argv[3] !== '1'
    || contextFlag < 0 || process.argv[contextFlag + 1] !== process.env.TT_ORACLE_CONTEXT) process.exit(9);
const context = JSON.parse(fs.readFileSync(process.env.TT_ORACLE_CONTEXT, 'utf8'));
if (context.contract_version !== 1 || context.oracle_id !== 'O4'
    || context.case.id !== process.env.TT_CASE_ID
    || context.campaign.id !== process.env.TT_CAMPAIGN_ID
    || context.mechanical_evidence?.references?.chaos_log === null
    || context.mechanical_evidence?.references?.chaos_log === undefined) process.exit(8);
const started = new Date().toISOString();
console.log(JSON.stringify({
  contract_version: 1, oracle_id: process.env.TT_ORACLE_ID, result: 'PASS',
  started_at: started, finished_at: new Date().toISOString(), findings: [],
  evidence: [],
}));
NODE
chmod +x "$chaos_oracle_root/O4"
chaos_manifest="$TEST_ROOT/manifests/chaos.jsonl"
write_chaos_case "$chaos_manifest" "CHAOS-BLOCK" "$CHAOS_BLOCK" '["O4"]'
chaos_events="$TEST_ROOT/chaos-events.jsonl"
# E3.C.1 US-003: record a fake harness (the steps-table claim_pgid target)
# and a scan-signature decoy, then seed the claim row — the controller must
# resolve the harness from the RECORDED claim row and hand it to tt-chaos as
# explicit --target-* args; the decoy must survive (never scan-resolved).
spawn_chaos_fake_harness
spawn_chaos_decoy
sleep 0.2
seed_chaos_claim
chaos_output=$(PATH="$workflow_bin_dir:$PATH" CONTROLLER_WORKFLOW_EVENTS="$workflow_events" \
  CONTROLLER_WORKFLOW_MODE=stdout \
  CONTROLLER_CHAOS_EVENTS="$chaos_events" CONTROLLER_CHAOS_MODE=record \
  CHAOS_LOG_FILE="$CHAOS_LOG_FILE" \
  TT_CONTROLLER_TT_CHAOS_PATH="$TEST_ROOT/tt-chaos-stub" \
  TT_CONTROLLER_SELF_TEST=1 TT_CONTROLLER_SELF_TEST_ORACLES_ROOT="$chaos_oracle_root" \
  run_recorded_campaign "$CONTROLLER" --manifest "$chaos_manifest") \
  || fail "chaos-block campaign failed: $chaos_output"
chaos_id=$(remember_campaign "$chaos_output")
node --input-type=module - "$TT_DIR/var/results/$chaos_id/state.json" "$chaos_events" "$CHAOS_LOG_FILE" \
  "$CHAOS_RUN_ID" "$TEST_ROOT/tt-chaos-stub" "$FAKE_HARNESS_PID" "$DECOY_PID" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const [statePath, eventsPath, chaosLogPath, runId, chaosStubPath, fakeHarnessPid, decoyPid] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const item = state.cases[0];
const attempt = item.attempts[0];
if (attempt.outcome !== 'PASS') {
  throw new Error(`chaos-block case did not PASS: ${JSON.stringify({outcome: attempt.outcome, reason: attempt.classification_reason})}`);
}
const evidence = attempt.chaos_evidence;
const utcRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
if (!evidence || evidence.status !== 'completed' || evidence.operator !== 'tt-chaos'
    || evidence.injection_type !== 'sigstop_sigcont' || evidence.target !== 'harness_process'
    || evidence.trigger !== 'mid_round' || evidence.trigger_marker !== 'step:developer:running'
    || evidence.hold_seconds !== 600 || evidence.run_id !== runId
    || evidence.exit_code !== 0 || evidence.signal !== null
    || !utcRe.test(evidence.started_at) || !utcRe.test(evidence.ended_at)) {
  throw new Error(`chaos evidence is wrong: ${JSON.stringify(evidence)}`);
}
// E3.C.1 US-003: the invocation argv MUST carry explicit --target-* args
// naming the RECORDED harness (claim_pgid == fake-harness pid, its own group
// leader), with the recorded startTime — never a scan-resolved target.
const argv = evidence.argv;
const targetIdx = argv.indexOf('--target-pid');
const pgidIdx = argv.indexOf('--target-pgid');
const startIdx = argv.indexOf('--target-start-time');
if (argv[0] !== chaosStubPath || argv[1] !== 'sigstop_sigcont'
    || argv[2] !== '--run' || argv[3] !== runId
    || argv[4] !== '--when' || argv[5] !== 'step:developer:running'
    || argv[6] !== '--hold-seconds' || argv[7] !== '600'
    || targetIdx < 0 || argv[targetIdx + 1] !== String(fakeHarnessPid)
    || pgidIdx < 0 || argv[pgidIdx + 1] !== String(fakeHarnessPid)
    || startIdx < 0 || !/^\d+$/.test(argv[startIdx + 1])) {
  throw new Error(`chaos argv must carry explicit --target-* args naming the recorded harness: ${JSON.stringify(argv)}`);
}
// The recorded target must be the steps-table claim row (source steps-table),
// pid == fake-harness pid, with a live-process startTime identity.
if (evidence.target_record?.source !== 'steps-table'
    || evidence.target_record?.pid !== Number(fakeHarnessPid)
    || evidence.target_record?.pgid !== Number(fakeHarnessPid)
    || typeof evidence.target_record?.startTime !== 'string'
    || !evidence.target_record.startTime.startsWith('proc:')) {
  throw new Error(`chaos evidence target_record must be the recorded steps-table harness: ${JSON.stringify(evidence.target_record)}`);
}
// chaos.log must be captured into the oracle snapshot under the chaos_log key
// (the O4 stub above would have exited 8 otherwise — the gating context
// validation enforces REQUIRED_ORACLE_EVIDENCE.chaos_log).
const chaosLogRef = attempt.oracle_evidence?.references?.chaos_log;
if (chaosLogRef === null || chaosLogRef === undefined || typeof chaosLogRef.path !== 'string') {
  throw new Error(`chaos_log was not captured into the oracle snapshot: ${JSON.stringify(attempt.oracle_evidence?.references)}`);
}
const copied = fs.readFileSync(path.join(path.dirname(statePath), chaosLogRef.path), 'utf8');
const entries = [...copied.matchAll(/"action":"sigstop_sigcont","entry":"(start|hold_complete|cont)"/g)].map((m) => m[1]);
if (JSON.stringify(entries) !== JSON.stringify(['start', 'hold_complete', 'cont'])) {
  throw new Error(`snapshot chaos_log copy is missing the stub operator's entries: ${JSON.stringify(entries)}`);
}
// The fired chaos.log entries must reference the RECORDED pid: target (the
// fake harness), never the scan-signature decoy.
if (!copied.includes(`"pid":${fakeHarnessPid}`) || copied.includes(`"pid":${decoyPid}`)) {
  throw new Error(`chaos.log fired entries must reference the recorded pid target, never a scan-resolved decoy: ${copied}`);
}
if (item.oracle_results?.[0]?.oracle_id !== 'O4' || item.oracle_results?.[0]?.status !== 'VALID'
    || item.oracle_results?.[0]?.response?.result !== 'PASS') {
  throw new Error(`O4 oracle did not VALID/PASS with chaos_log evidence: ${JSON.stringify(item.oracle_results)}`);
}
// The stub recorded EXACTLY one tt-chaos invocation with the explicit-target argv.
const stubCalls = fs.readFileSync(eventsPath, 'utf8').trim().split('\n')
  .map((line) => JSON.parse(line));
if (stubCalls.length !== 1
    || stubCalls[0].argv[0] !== 'sigstop_sigcont' || stubCalls[0].argv[2] !== runId
    || !stubCalls[0].argv.includes('--target-pid')) {
  throw new Error(`tt-chaos stub must record exactly one explicit-target invocation: ${JSON.stringify(stubCalls)}`);
}
NODE
# The decoy matching the OLD /proc scan signature must survive the run; the
# (MACP3 US-004 doc note: linux-only prose reference — no runtime procfs here.)
# recorded fake harness (the explicit target) must too (the stub signals
# nothing — only the argv contract is under test).
kill -0 "$DECOY_PID" 2>/dev/null || fail "scan-signature decoy died during the chaos run (it must never be targeted)"
kill -0 "$FAKE_HARNESS_PID" 2>/dev/null || fail "recorded fake harness died during the chaos run"
reap_chaos_processes
clean_chaos_state
pass "a chaos-block case invokes tt-chaos with explicit --target-* recorded harness args and captures chaos.log (O4 PASS); scan-signature decoy survives"

# Fixture 2: a chaos invocation failure (stub exits 3) classifies
# TEST_INFRA_FAIL with the DISTINCT category 'chaos-invocation-failed'
# naming the operator + exit code — never a silent PASS/INCONCLUSIVE.
chaos_fail_manifest="$TEST_ROOT/manifests/chaos-fail.jsonl"
write_chaos_case "$chaos_fail_manifest" "CHAOS-FAIL" "$CHAOS_BLOCK"
chaos_fail_events="$TEST_ROOT/chaos-fail-events.jsonl"
chaos_fail_output=$(PATH="$workflow_bin_dir:$PATH" CONTROLLER_WORKFLOW_EVENTS="$workflow_events" \
  CONTROLLER_WORKFLOW_MODE=stdout \
  CONTROLLER_CHAOS_EVENTS="$chaos_fail_events" \
  TT_CONTROLLER_TT_CHAOS_PATH="$TEST_ROOT/tt-chaos-fail-stub" \
  run_recorded_campaign "$CONTROLLER" --manifest "$chaos_fail_manifest") \
  || fail "chaos-fail campaign failed: $chaos_fail_output"
chaos_fail_id=$(remember_campaign "$chaos_fail_output")
node --input-type=module - "$TT_DIR/var/results/$chaos_fail_id/state.json" "$chaos_fail_events" \
  "$CHAOS_RUN_ID" <<'NODE'
import fs from 'node:fs';
const [statePath, eventsPath, runId] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const attempt = state.cases[0].attempts[0];
if (attempt.outcome !== 'TEST_INFRA_FAIL'
    || attempt.classification_reason?.category !== 'chaos-invocation-failed'
    || attempt.classification_reason?.operator !== 'tt-chaos'
    || attempt.classification_reason?.exit_code !== 3
    || attempt.classification_reason?.argv?.[0]?.endsWith('/tt-chaos-fail-stub') !== true) {
  throw new Error(`chaos invocation failure did not classify TEST_INFRA_FAIL chaos-invocation-failed: ${JSON.stringify({outcome: attempt.outcome, reason: attempt.classification_reason})}`);
}
if (attempt.chaos_evidence?.status !== 'failed'
    || attempt.chaos_evidence?.failure?.category !== 'chaos-invocation-failed'
    || attempt.chaos_evidence?.failure?.exit_code !== 3) {
  throw new Error(`chaos evidence did not record the failure: ${JSON.stringify(attempt.chaos_evidence)}`);
}
// E3.C.1 US-003: even with no steps-table claim row the invocation must
// carry EXPLICIT --target-* args from the recorded launch-process fallback —
// the operator is never left to re-resolve by /proc sweep.
// MACP3 US-004 doc note: linux-only prose — this harness never reads procfs.
const failArgv = attempt.chaos_evidence?.argv ?? attempt.classification_reason?.argv ?? [];
const targetIdx = failArgv.indexOf('--target-pid');
const startIdx = failArgv.indexOf('--target-start-time');
if (failArgv[0]?.endsWith('/tt-chaos-fail-stub') !== true
    || failArgv[1] !== 'sigstop_sigcont' || failArgv[3] !== runId
    || targetIdx < 0 || !/^\d+$/.test(String(failArgv[targetIdx + 1]))
    || startIdx < 0 || !/^\d+$/.test(String(failArgv[startIdx + 1]))) {
  throw new Error(`failed chaos invocation must still carry explicit --target-* args (no scan): ${JSON.stringify(failArgv)}`);
}
const stubCalls = fs.readFileSync(eventsPath, 'utf8').trim().split('\n')
  .map((line) => JSON.parse(line));
if (stubCalls.length !== 1
    || stubCalls[0].argv[0] !== 'sigstop_sigcont' || stubCalls[0].argv[2] !== runId
    || !stubCalls[0].argv.includes('--target-pid')) {
  throw new Error(`failed tt-chaos invocation must still record the explicit-target argv once: ${JSON.stringify(stubCalls)}`);
}
NODE
pass "a chaos invocation failure classifies TEST_INFRA_FAIL chaos-invocation-failed with a distinct reason (argv still explicit-target)"

# Fixture 3: a chaos:null case (W3.17a) NEVER spawns tt-chaos — the stub
# would record an invocation (and exit 9, failing the case) if the controller
# ever constructed one. Zero records in the events file proves it.
chaos_null_events="$TEST_ROOT/chaos-null-events.jsonl"
: > "$chaos_null_events"
chaos_null_manifest="$TEST_ROOT/manifests/chaos-null.jsonl"
write_chaos_case "$chaos_null_manifest" "CHAOS-NULL" 'null'
cat > "$TEST_ROOT/tt-chaos-null-trap" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$(node -e 'process.stdout.write(JSON.stringify({argv:process.argv.slice(1),at:Date.now()}))' "$@")" >> "$CONTROLLER_CHAOS_EVENTS"
exit 9
SH
chmod +x "$TEST_ROOT/tt-chaos-null-trap"
chaos_null_output=$(PATH="$workflow_bin_dir:$PATH" CONTROLLER_WORKFLOW_EVENTS="$workflow_events" \
  CONTROLLER_WORKFLOW_MODE=stdout \
  CONTROLLER_CHAOS_EVENTS="$chaos_null_events" \
  TT_CONTROLLER_TT_CHAOS_PATH="$TEST_ROOT/tt-chaos-null-trap" \
  run_recorded_campaign "$CONTROLLER" --manifest "$chaos_null_manifest") \
  || fail "chaos-null campaign failed: $chaos_null_output"
chaos_null_id=$(remember_campaign "$chaos_null_output")
node --input-type=module - "$TT_DIR/var/results/$chaos_null_id/state.json" "$chaos_null_events" <<'NODE'
import fs from 'node:fs';
const [statePath, eventsPath] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const attempt = state.cases[0].attempts[0];
if (attempt.outcome !== 'PASS') {
  throw new Error(`chaos-null case did not PASS: ${JSON.stringify({outcome: attempt.outcome, reason: attempt.classification_reason})}`);
}
if (attempt.chaos_evidence !== undefined) {
  throw new Error(`a chaos:null case must never carry chaos_evidence: ${JSON.stringify(attempt.chaos_evidence)}`);
}
const stubCalls = fs.readFileSync(eventsPath, 'utf8').trim();
if (stubCalls !== '') {
  throw new Error(`a chaos:null case (W3.17a) must NEVER spawn tt-chaos, got: ${stubCalls}`);
}
NODE
pass "a chaos:null case (W3.17a) never invokes tt-chaos (zero spawns)"

# Fixture 4: a chaos block that fails semantic validation (untranslatable
# trigger) is persisted TEST_INFRA_FAIL 'chaos-block-invalid' BEFORE any
# launch — no workflow launch events and no tt-chaos spawns.
chaos_guard_events="$TEST_ROOT/chaos-guard-events.jsonl"
: > "$chaos_guard_events"
chaos_guard_manifest="$TEST_ROOT/manifests/chaos-guard.jsonl"
write_chaos_case "$chaos_guard_manifest" "CHAOS-GUARD" \
  '{"type":"sigstop_sigcont","target":"harness_process","trigger":"unknown_trigger","hold_seconds":600,"operator":"tt-chaos"}'
chaos_guard_output=$(PATH="$workflow_bin_dir:$PATH" CONTROLLER_WORKFLOW_EVENTS="$chaos_guard_events" \
  CONTROLLER_WORKFLOW_MODE=stdout \
  CONTROLLER_CHAOS_EVENTS="$chaos_guard_events" \
  TT_CONTROLLER_TT_CHAOS_PATH="$TEST_ROOT/tt-chaos-null-trap" \
  run_recorded_campaign "$CONTROLLER" --manifest "$chaos_guard_manifest") \
  || fail "chaos guard campaign failed: $chaos_guard_output"
chaos_guard_id=$(remember_campaign "$chaos_guard_output")
node --input-type=module - "$TT_DIR/var/results/$chaos_guard_id/state.json" "$chaos_guard_events" <<'NODE'
import fs from 'node:fs';
const [statePath, eventsPath] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const attempt = state.cases[0].attempts[0];
if (attempt.outcome !== 'TEST_INFRA_FAIL'
    || attempt.classification_reason?.category !== 'chaos-block-invalid'
    || attempt.chaos_guard?.errors?.[0]?.includes('unknown_trigger') !== true) {
  throw new Error(`semantically-invalid chaos block did not classify TEST_INFRA_FAIL chaos-block-invalid: ${JSON.stringify({outcome: attempt.outcome, reason: attempt.classification_reason, guard: attempt.chaos_guard})}`);
}
if (attempt.phase !== 'terminal' || attempt.kind !== 'workflow') {
  throw new Error(`chaos guard attempt must be a terminal workflow launch-intent: ${JSON.stringify(attempt)}`);
}
const stubCalls = fs.readFileSync(eventsPath, 'utf8').trim();
if (stubCalls !== '') {
  throw new Error(`a chaos-block-invalid case must never launch or spawn tt-chaos, got: ${stubCalls}`);
}
NODE
pass "a semantically-invalid chaos block fails closed as TEST_INFRA_FAIL chaos-block-invalid before any launch"

oracle_prose_manifest="$TEST_ROOT/manifests/oracle-prose.jsonl"
valid_case "ORACLE-PROSE" \
  | sed 's/"requires":{"toolchains":\["node"\]}/"requires":{}/' \
  | sed 's/"oracles":\["TT-MISSING-O1","TT-MISSING-O2"\]/"oracles":["TT-ORACLE-NO-PROSE"]/' \
  > "$oracle_prose_manifest"
oracle_prose_output=$(PATH="$workflow_bin_dir:$PATH" CONTROLLER_WORKFLOW_EVENTS="$workflow_events" \
  CONTROLLER_WORKFLOW_MODE=oracle-prose run_recorded_campaign "$CONTROLLER" --manifest "$oracle_prose_manifest") \
  || fail "workflow oracle prose-isolation campaign failed: $oracle_prose_output"
oracle_prose_id=$(remember_campaign "$oracle_prose_output")
node --input-type=module - "$TT_DIR/var/results/$oracle_prose_id/state.json" \
  "$TT_DIR/var/results/$oracle_prose_id" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const [statePath, campaignDir] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const item = state.cases[0];
const result = item.oracle_results?.[0];
if (item.outcome !== 'PASS' || result?.status !== 'VALID') {
  throw new Error(`workflow oracle did not validate mechanical context: ${JSON.stringify(item)}`);
}
const context = fs.readFileSync(path.join(campaignDir, result.context), 'utf8');
if (context.includes('AGENT_RESPONSE_SENTINEL')) {
  throw new Error(`workflow oracle context leaked agent response prose: ${context}`);
}
NODE
pass "workflow oracle context excludes agent response prose from status steps"

O9_EVENTS_PATH="$TT_DIR/var/home/.tamandua/events/all.jsonl"
O9_EVENTS_BACKUP="$TEST_ROOT/original-o9-events.jsonl"
mkdir -p "$(dirname "$O9_EVENTS_PATH")"
if [ -f "$O9_EVENTS_PATH" ]; then mv "$O9_EVENTS_PATH" "$O9_EVENTS_BACKUP"; fi
o9_control_ready="$TEST_ROOT/o9-control-ready"
o9_control_log="$TEST_ROOT/o9-control.log"
cat > "$TEST_ROOT/o9-control-server.mjs" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [repoRoot, readyPath] = process.argv.slice(2);
const dbModule = await import(pathToFileURL(path.join(repoRoot, 'dist/db.js')).href);
dbModule.getDb();
const { createControlServer } = await import(pathToFileURL(path.join(repoRoot, 'dist/server/control-server.js')).href);
const server = createControlServer({ listen: false });
server.once('error', (error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
});
server.listen(Number(process.env.TAMANDUA_CONTROL_PORT), '127.0.0.1', () => {
  fs.writeFileSync(readyPath, `${process.pid}\n`);
});
process.on('SIGTERM', () => {
  server.closeAllConnections();
  dbModule.closeDb();
  process.exit(0);
});
NODE
HOME="$TT_DIR/var/home" TAMANDUA_STATE_DIR="$TT_DIR/var/home/.tamandua" \
  TAMANDUA_DB_PATH="$WORKFLOW_REAL_DB" TAMANDUA_CONTROL_PORT=4339 TAMANDUA_TEST_GUARD=0 \
  node "$TEST_ROOT/o9-control-server.mjs" "$TT_DIR/.." "$o9_control_ready" \
  > "$o9_control_log" 2>&1 &
O9_CONTROL_PID=$!
for _ in $(seq 1 100); do
  [ ! -f "$o9_control_ready" ] || break
  kill -0 "$O9_CONTROL_PID" 2>/dev/null \
    || fail "O9 control server exited before readiness: $(cat "$o9_control_log")"
  sleep 0.05
done
[ -f "$o9_control_ready" ] || fail "O9 control server did not become ready: $(cat "$o9_control_log")"
O9_CONTROL_PID="$(<"$o9_control_ready")"

o9_controller_fixture="$TT_DIR/var/fixtures/work/O9-CONTROLLER-SPECIAL/tt-ts"
rm -rf -- "$TT_DIR/var/fixtures/work/O9-CONTROLLER-SPECIAL"
# The work clone is produced by the controller's provisioning stage (fresh
# clone of the golden bare). To give that clone a unique tracked file whose
# restoration the O9 battery can prove, install a seed branch into the golden
# bare and point the manifest's seed field at it — the manually-created repo
# here is the SEED SOURCE, not the working clone.
o9_seed_repo="$TEST_ROOT/o9-seed-repo"
mkdir -p "$o9_seed_repo/src"
git -C "$o9_seed_repo" init -q -b main
git -C "$o9_seed_repo" config user.name 'Controller O9 Test'
git -C "$o9_seed_repo" config user.email 'controller-o9@example.invalid'
printf 'export const o9Fixture = "original bytes";\n' > "$o9_seed_repo/src/value.ts"
git -C "$o9_seed_repo" add .
git -C "$o9_seed_repo" commit -qm fixture
o9_controller_original_hash="$(sha256sum "$o9_seed_repo/src/value.ts" | cut -d' ' -f1)"
o9_golden_bare="$TT_DIR/var/fixtures/golden/tt-ts.git"
O9_GOLDEN_BARE="$o9_golden_bare"
node "$TT_DIR/bin/tt-golden-bootstrap.mjs" --fixture tt-ts >/dev/null 2>&1 \
  || fail "could not bootstrap the tt-ts golden for O9 seed provisioning"
git -C "$o9_seed_repo" push "$o9_golden_bare" main:refs/heads/seed/o9-controller-special >/dev/null 2>&1 \
  || fail "could not install the O9 seed branch into the tt-ts golden"
o9_controller_manifest="$TEST_ROOT/manifests/o9-controller-special.jsonl"
node --input-type=module - "$o9_controller_manifest" <<'NODE'
import fs from 'node:fs';
const manifest = process.argv[2];
const record = {
  id: 'O9-CONTROLLER-SPECIAL', wave: 0, workflow: 'bug-fix-merge-worktree',
  fixture: 'tt-ts', harness: 'hermes', task: 'tasks/W3.07.md',
  seed: 'o9-controller-special',
  context: {test_cmd: '/bin/true', o9_special_exits: true}, caps: {tokens: 1, wall_min: 5}, requires: {},
  boundary_files: ['src'], forbidden: [], oracles: ['O9'], gates: [],
  chaos: null, shed_ok: false, mandatory: true, class: 'verification',
};
fs.writeFileSync(manifest, `${JSON.stringify(record)}\n`);
NODE
o9_controller_output=$(PATH="$workflow_bin_dir:$PATH" CONTROLLER_WORKFLOW_EVENTS="$workflow_events" \
  CONTROLLER_O9_FIXTURE="$o9_controller_fixture" CONTROLLER_O9_SHIM="$TT_DIR/../bin/tamandua-test" \
  CONTROLLER_WORKFLOW_MODE=o9-special run_recorded_campaign "$CONTROLLER" --manifest "$o9_controller_manifest") \
  || fail "controller-authored O9 special-exit campaign failed: $o9_controller_output"
o9_controller_id=$(remember_campaign "$o9_controller_output")
node --input-type=module - "$TT_DIR/var/results/$o9_controller_id/state.json" \
  "$TT_DIR/var/results/$o9_controller_id" "$TT_DIR/var/home/.tamandua/events/all.jsonl" \
  "$o9_controller_fixture" "$o9_controller_original_hash" "$o9_controller_manifest" <<'NODE'
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const [statePath, campaignDir, eventsPath, fixturePath, originalHash, manifestPath] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const item = state.cases[0];
const attempt = item.attempts[0];
const oracle = item.oracle_results?.find(result => result.oracle_id === 'O9');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.oracles?.[0] !== 'O9' || manifest.context?.o9_special_exits !== true) {
  throw new Error(`test manifest did not opt into controller O9 probes: ${JSON.stringify(manifest)}`);
}
if (attempt.o9_targeted_probes?.status !== 'COMPLETE'
    || JSON.stringify(attempt.o9_targeted_probes.evidence?.exits) !== JSON.stringify([86,87,88])) {
  throw new Error(`controller did not author all targeted probes: ${JSON.stringify(attempt.o9_targeted_probes)}`);
}
if (attempt.oracle_evidence?.status !== 'COMPLETE'
    || oracle?.status !== 'VALID' || oracle.response?.result !== 'PASS') {
  throw new Error(`controller snapshot/O9 result was not PASS: ${JSON.stringify({attempt,oracle})}`);
}
const raw = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  .filter(event => event.event === 'suite.special_exit_observed'
    && event.runId === 'run-ffffffff-6666-4666-8666-666666666666'
    && event.stepId?.startsWith('O9-CONTROLLER-SPECIAL-o9-'));
if (raw.length !== 3 || JSON.stringify(raw.map(event => event.shimExitCode).sort()) !== JSON.stringify([86,87,88])) {
  throw new Error(`controller did not mechanically emit exactly one 86/87/88 observation: ${JSON.stringify(raw)}`);
}
const observations = JSON.parse(fs.readFileSync(
  path.join(campaignDir, attempt.oracle_evidence.references.suite_observations.path), 'utf8',
)).special_exit_observations;
if (observations.length !== 3) throw new Error(`snapshot did not retain exactly three special exits: ${JSON.stringify(observations)}`);
const ledger = JSON.parse(fs.readFileSync(
  path.join(campaignDir, attempt.oracle_evidence.references.suite_ledger.path), 'utf8',
)).rows;
for (const event of raw) {
  const observation = observations.find(row => row.shim_exit_code === event.shimExitCode);
  if (!observation || observation.invocation_id !== `${event.runId}:${event.stepId}`
      || observation.origin_repo !== event.originRepo || observation.tree_hash !== event.treeHash
      || observation.cmd_hash !== event.cmdHash || observation.pre_tree_hash !== event.preTreeHash
      || observation.post_tree_hash !== event.postTreeHash || observation.ledger_row_id !== event.ledgerRowId
      || observation.command_exit_code !== event.commandExitCode
      || observation.interrupted !== event.interrupted || observation.tracked_dirty !== event.trackedDirty
      || observation.junk_probe_path !== event.junkProbePath
      || observation.junk_probe_tracked !== false || event.junkProbeTracked !== false) {
    // 'exact-key/process evidence': '/proc' is a substring of "process" — no
    // procfs access (MACP3 US-004 doc note; extracted from an error string).
    throw new Error(`snapshot did not preserve emitted exact-key/process evidence: ${JSON.stringify({event,observation})}`);
  }
}
const byCode = Object.fromEntries(observations.map(row => [row.shim_exit_code,row]));
if (byCode[86].command_exit_code !== 0 || byCode[86].pre_tree_hash === byCode[86].post_tree_hash
    || byCode[86].ledger_row_id !== null || byCode[86].interrupted || byCode[86].tracked_dirty) {
  throw new Error(`exit 86 contract evidence is wrong: ${JSON.stringify(byCode[86])}`);
}
const red87 = ledger.find(row => row.id === byCode[87].ledger_row_id);
if (byCode[87].command_exit_code !== 87 || !byCode[87].interrupted || byCode[87].tracked_dirty
    || byCode[87].pre_tree_hash !== byCode[87].post_tree_hash || red87?.exit_code !== 87
    || red87.origin_repo !== byCode[87].origin_repo || red87.tree_hash !== byCode[87].tree_hash
    || red87.cmd_hash !== byCode[87].cmd_hash) {
  throw new Error(`exit 87 contract evidence is wrong: ${JSON.stringify({observation:byCode[87],red87})}`);
}
if (byCode[88].command_exit_code !== null || !byCode[88].tracked_dirty || byCode[88].interrupted
    || byCode[88].pre_tree_hash !== byCode[88].post_tree_hash || byCode[88].ledger_row_id !== null) {
  throw new Error(`exit 88 contract evidence is wrong: ${JSON.stringify(byCode[88])}`);
}
const fixtureHash = createHash('sha256').update(fs.readFileSync(path.join(fixturePath, 'src/value.ts'))).digest('hex');
if (fixtureHash !== originalHash) throw new Error('controller did not restore tracked fixture bytes');
if (fs.existsSync(path.join(fixturePath, '.git/tamandua-o9-junk-probe'))) throw new Error('controller did not remove the junk probe');
const trackedProbe = spawnSync('git', ['ls-files', '--error-unmatch', '--', '.git/tamandua-o9-junk-probe'], {
  cwd: fixturePath, stdio: 'ignore', shell: false,
}).status === 0;
if (trackedProbe) throw new Error('controller O9 junk probe entered the Git index');
if (item.teardown?.action !== 'keep'
    || item.teardown?.keep_reason !== 'o9-special-exit-restored-tree-evidence') {
  throw new Error(`O9 special-exit clone was not kept as restored-tree evidence: ${JSON.stringify(item.teardown)}`);
}
NODE
kill -9 "$O9_CONTROL_PID"
wait "$O9_CONTROL_PID" 2>/dev/null || true
O9_CONTROL_PID=""
rm -f -- "$O9_EVENTS_PATH"
if [ -f "$O9_EVENTS_BACKUP" ]; then mv "$O9_EVENTS_BACKUP" "$O9_EVENTS_PATH"; fi
O9_EVENTS_PATH=""
O9_EVENTS_BACKUP=""
pass "controller authors, snapshots, and passes O9 special exits 86/87/88 with a restored fixture"

snapshot_fixture="$TT_DIR/var/fixtures/work/ORACLE-SNAPSHOT/tt-ts"
rm -rf -- "$TT_DIR/var/fixtures/work/ORACLE-SNAPSHOT"
mkdir -p "$snapshot_fixture/src" "$snapshot_fixture/test"
git -C "$snapshot_fixture" init -q -b main
git -C "$snapshot_fixture" config user.name 'Controller Snapshot Test'
git -C "$snapshot_fixture" config user.email 'snapshot@example.invalid'
printf 'export const value = 1;\n' > "$snapshot_fixture/src/value.ts"
printf 'test("value", () => {});\n' > "$snapshot_fixture/test/value.test.ts"
printf 'bait\n' > "$snapshot_fixture/bait.txt"
git -C "$snapshot_fixture" add .
git -C "$snapshot_fixture" commit -qm fixture
snapshot_manifest="$TEST_ROOT/manifests/oracle-snapshot.jsonl"
valid_case "ORACLE-SNAPSHOT" \
  | sed 's/"requires":{"toolchains":\["node"\]}/"requires":{}/' \
  | sed 's/"context":{}/"context":{"merge_gate":"green","agent_prose":"AGENT_LAUNCH_PROSE_SENTINEL"}/' \
  | sed 's/"oracles":\["TT-MISSING-O1","TT-MISSING-O2"\]/"oracles":["O1"]/' \
  | sed 's/"forbidden":\[\]/"forbidden":["bait.txt"]/' \
  | sed 's#"fixtures/tt-ts/src"#"src"#' \
  > "$snapshot_manifest"
snapshot_output=$(PATH="$workflow_bin_dir:$PATH" CONTROLLER_WORKFLOW_EVENTS="$workflow_events" \
  CONTROLLER_WORKFLOW_MODE=oracle-prose run_recorded_campaign "$CONTROLLER" --manifest "$snapshot_manifest") \
  || fail "workflow oracle snapshot campaign failed: $snapshot_output"
snapshot_id=$(remember_campaign "$snapshot_output")
node --input-type=module - "$TT_DIR/var/results/$snapshot_id/state.json" \
  "$TT_DIR/var/results/$snapshot_id" "$WORKFLOW_REAL_DB" "$SCRIPT_DIR/oracle-context.mjs" <<'NODE'
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { OPTIONAL_ORACLE_EVIDENCE_KEYS } = await import(pathToFileURL(process.argv[5]).href);
const [statePath, campaignDir, sourceDb] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const attempt = state.cases[0].attempts[0];
const oracleResult = state.cases[0].oracle_results?.[0];
if (attempt.oracle_evidence?.status !== 'COMPLETE'
    || oracleResult?.status !== 'VALID' || oracleResult.response?.result !== 'FAIL'
    || !oracleResult.response?.findings?.some(finding => finding.id === 'O1_DB_RUN_MISSING')) {
  throw new Error(`oracle snapshot did not complete before invocation: ${JSON.stringify(state.cases[0])}`);
}
for (const [key, reference] of Object.entries(attempt.oracle_evidence.references)) {
  // US-003: probe_evidence/chaos_log are OPTIONAL snapshot keys — absent
  // artifacts leave the reference null (only oracles that require them, O16/O4,
  // gate on presence). Every mandatory key must still be captured + immutable.
  if (reference === null) {
    if (OPTIONAL_ORACLE_EVIDENCE_KEYS.includes(key)) continue;
    throw new Error(`snapshot omitted ${key}`);
  }
  const file = path.join(campaignDir, reference.path);
  const digest = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (digest !== reference.sha256 || (fs.statSync(file).mode & 0o222) !== 0) {
    throw new Error(`snapshot provenance/immutability failed for ${key}`);
  }
}
const context = fs.readFileSync(path.join(campaignDir, state.cases[0].oracle_results[0].context), 'utf8');
if (context.includes(sourceDb) || context.includes(`${process.env.HOME}/.tamandua`)) {
  throw new Error('oracle context leaked a source or production database path');
}
const launchIntent = fs.readFileSync(path.join(campaignDir, attempt.oracle_evidence.references.launch_intent.path), 'utf8');
if (launchIntent.includes('AGENT_LAUNCH_PROSE_SENTINEL') || !launchIntent.includes('merge_gate=green')) {
  throw new Error(`launch intent leaked prose or omitted gate policy: ${launchIntent}`);
}
NODE

battery_oracles="$TEST_ROOT/gating-oracles"
mkdir -p "$battery_oracles"
cat > "$battery_oracles/oracle" <<'NODE'
#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const contextIndex = process.argv.indexOf('--context');
const contextPath = process.argv[contextIndex + 1];
if (process.argv[2] !== '--contract-version' || process.argv[3] !== '1'
    || !path.isAbsolute(contextPath) || contextPath !== process.env.TT_ORACLE_CONTEXT) process.exit(9);
const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
let campaignDir = path.dirname(contextPath);
while (!fs.existsSync(path.join(campaignDir, 'state.json'))) {
  const parent = path.dirname(campaignDir);
  if (parent === campaignDir) process.exit(8);
  campaignDir = parent;
}
for (const reference of Object.values(context.mechanical_evidence.references)) {
  // US-003: probe_evidence/chaos_log are OPTIONAL evidence keys — their
  // reference is null when the probe sequencer / tt-chaos never ran. The
  // battery oracle only hash-pins the references that exist.
  if (reference === null) continue;
  const bytes = fs.readFileSync(path.join(campaignDir, reference.path));
  if (createHash('sha256').update(bytes).digest('hex') !== reference.sha256) process.exit(6);
}
const evidenceName = `${context.oracle_id.toLowerCase()}-controller-observation.json`;
fs.writeFileSync(path.join(process.env.TT_ORACLE_EVIDENCE_DIR, evidenceName), `${JSON.stringify({
  oracle_id: context.oracle_id, contract_version: context.contract_version,
  context_absolute: path.isAbsolute(contextPath), reference_count: Object.keys(context.mechanical_evidence.references).length,
})}\n`, { flag: 'wx' });
const planted = process.env.TT_CASE_ID === 'ORACLE-BATTERY-FAIL' && context.oracle_id === 'O11';
const now = new Date().toISOString();
console.log(JSON.stringify({
  contract_version: 1, oracle_id: context.oracle_id, result: planted ? 'FAIL' : 'PASS',
  started_at: now, finished_at: now,
  findings: planted ? [{ id: 'O11_PLANTED_CONTROLLER_FAILURE', summary: 'planted mechanical controller integration failure' }] : [],
  evidence: [{ path: evidenceName, kind: 'controller-integration' }],
}));
process.exit(planted ? 1 : 0);
NODE
chmod +x "$battery_oracles/oracle"
for oracle_id in O1 O2 O3z O8 O9 O10 O11; do
  cp "$battery_oracles/oracle" "$battery_oracles/$oracle_id"
  chmod +x "$battery_oracles/$oracle_id"
done

for battery_case in ORACLE-BATTERY ORACLE-BATTERY-FAIL; do
  rm -rf -- "$TT_DIR/var/fixtures/work/$battery_case"
  mkdir -p "$TT_DIR/var/fixtures/work/$battery_case"
  cp -R "$snapshot_fixture" "$TT_DIR/var/fixtures/work/$battery_case/tt-ts"
  battery_manifest="$TEST_ROOT/manifests/$(tolower "$battery_case").jsonl"
  valid_case "$battery_case" \
    | sed 's/"requires":{"toolchains":\["node"\]}/"requires":{}/' \
    | sed 's/"oracles":\["TT-MISSING-O1","TT-MISSING-O2"\]/"oracles":["O1","O2","O3z","O8","O9","O10","O11"]/' \
    | sed 's/"forbidden":\[\]/"forbidden":["bait.txt"]/' \
    | sed 's#"fixtures/tt-ts/src"#"src"#' \
    > "$battery_manifest"
  set +e
  battery_output=$(PATH="$workflow_bin_dir:$PATH" CONTROLLER_WORKFLOW_EVENTS="$workflow_events" \
    CONTROLLER_WORKFLOW_MODE=oracle-prose TT_CONTROLLER_SELF_TEST=1 \
    TT_CONTROLLER_SELF_TEST_ORACLES_ROOT="$battery_oracles" \
    "$CONTROLLER" --manifest "$battery_manifest" 2>&1)
  battery_status=$?
  set -e
  expected_battery_status=0
  [ "$battery_case" = "ORACLE-BATTERY-FAIL" ] && expected_battery_status=1
  [ "$battery_status" -eq "$expected_battery_status" ] \
    || fail "$battery_case exited $battery_status instead of $expected_battery_status: $battery_output"
  battery_id=$(remember_campaign "$battery_output")
  node --input-type=module - "$TT_DIR/var/results/$battery_id/state.json" \
    "$TT_DIR/var/results/$battery_id" "$battery_case" <<'NODE'
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const [statePath, campaignDir, caseId] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const item = state.cases[0];
const ids = ['O1', 'O2', 'O3z', 'O8', 'O9', 'O10', 'O11'];
if (item.oracle_results?.length !== ids.length
    || JSON.stringify(item.oracle_results.map(result => result.oracle_id)) !== JSON.stringify(ids)
    || item.oracle_results.some(result => result.status !== 'VALID')) {
  throw new Error(`controller did not discover and validate the gating battery: ${JSON.stringify(item)}`);
}
for (const result of item.oracle_results) {
  if (result.argv[1] !== '--contract-version' || result.argv[2] !== '1' || result.argv[3] !== '--context') {
    throw new Error(`wrong persisted oracle argv: ${JSON.stringify(result.argv)}`);
  }
  for (const [fileKey, hashKey] of [['stdout', 'stdout_sha256'], ['stderr', 'stderr_sha256'], ['context', 'context_sha256']]) {
    const bytes = fs.readFileSync(path.join(campaignDir, result[fileKey]));
    if (createHash('sha256').update(bytes).digest('hex') !== result[hashKey]) throw new Error(`${result.oracle_id} ${fileKey} hash mismatch`);
  }
  for (const evidence of result.response.evidence) {
    const bytes = fs.readFileSync(path.join(campaignDir, path.dirname(result.context), evidence.path));
    if (createHash('sha256').update(bytes).digest('hex') !== evidence.sha256) throw new Error(`${result.oracle_id} evidence hash mismatch`);
  }
  const context = JSON.parse(fs.readFileSync(path.join(campaignDir, result.context), 'utf8'));
  for (const reference of Object.values(context.mechanical_evidence.references)) {
    // US-003: optional evidence keys (probe_evidence/chaos_log) are legitimately
    // null when their machinery never ran; captured references must hash-pin.
    if (reference === null) continue;
    if (createHash('sha256').update(fs.readFileSync(path.join(campaignDir, reference.path))).digest('hex') !== reference.sha256) {
      throw new Error(`${result.oracle_id} referenced mechanical evidence was not hash-pinned`);
    }
  }
}
if (caseId === 'ORACLE-BATTERY') {
  if (item.outcome !== 'PASS' || item.oracle_results.some(result => result.response.result !== 'PASS')) {
    throw new Error(`synthetic harvested run did not persist seven green responses: ${JSON.stringify(item)}`);
  }
} else {
  const planted = item.oracle_results.find(result => result.oracle_id === 'O11');
  if (item.outcome !== 'PRODUCT_FAIL' || item.reason?.category !== 'oracle-failed'
      || planted?.response?.result !== 'FAIL'
      || !planted.response.findings.some(finding => finding.id === 'O11_PLANTED_CONTROLLER_FAILURE')) {
    throw new Error(`planted failure was not a named PRODUCT_FAIL: ${JSON.stringify(item)}`);
  }
}
NODE
  rm -rf -- "$TT_DIR/var/fixtures/work/$battery_case"
done
pass "controller discovers, invokes, hashes, validates, and classifies the seven-oracle battery"

rm -rf -- "$snapshot_fixture"
pass "controller harvests immutable complete evidence before invoking the real O1 gating oracle"

# ── US-006 (S9 controller): REPLAY cache-HIT gate ───────────────────────────
# After terminal harvest a replay case must show a cache-hit/replay shim
# observation for ITS run bound to the pair's origin/tree/cmd key. These
# tests seed snapshot fixtures via the TT_CONTROLLER_REPLAY_SNAPSHOT_FIXTURE_DIR
# self-test seam and drive a replay workflow case to a completed terminal
# harvest with the stub `tamandua` (harvest-status mode) — zero tokens, no
# real launches. The pair is a LOCAL scripted case whose command provisions
# the shared tt-ts work clone (tt-fixture-provision.mjs) and seeds the
# snapshot tree with REAL origin/tree/cmd values computed from that clone.
[ -d "$TT_DIR/var/fixtures/golden/tt-ts.git" ] \
  || node "$TT_DIR/bin/tt-golden-bootstrap.mjs" --fixture tt-ts >/dev/null 2>&1 \
  || fail "could not bootstrap the tt-ts golden for the replay cache-hit gate tests"
us006_pair_script="$TEST_ROOT/us006-pair-command.mjs"
cat > "$us006_pair_script" <<'NODE'
// Pair local-command helper for the US-006 replay cache-HIT gate tests:
// provisions the shared tt-ts work clone at
// var/fixtures/work/US006-REPLAY-PAIR/tt-ts and (except provision-only)
// seeds the replay snapshot fixture tree the controller's gate will read.
// argv: <fixture-root> <mode: hit|miss|malformed|provision-only>
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const [fixtureRoot, mode] = process.argv.slice(2);
const provision = spawnSync(process.execPath, [
  'bin/tt-fixture-provision.mjs', '--fixture', 'tt-ts',
  '--case-id', 'US006-REPLAY-PAIR', '--json',
], { encoding: 'utf8' });
if (provision.status !== 0) {
  process.stderr.write(String(provision.stderr ?? ''));
  process.exit(1);
}
if (mode === 'provision-only') process.exit(0);
const clonePath = path.resolve('var/fixtures/work/US006-REPLAY-PAIR/tt-ts');
const originRepo = fs.realpathSync(clonePath);
const treeResult = spawnSync('git', ['-C', clonePath, 'rev-parse', '--verify', 'HEAD^{tree}'], { encoding: 'utf8' });
if (treeResult.status !== 0) {
  process.stderr.write(String(treeResult.stderr ?? ''));
  process.exit(1);
}
const treeHash = treeResult.stdout.trim();
const cmdHash = createHash('sha256').update('npm test').digest('hex');
const runId = 'run-aaaaaaaa-1111-4111-8111-111111111111';
const snapDir = path.join(fixtureRoot, 'snapshots', 'US006-REPLAY', 'attempt-1');
fs.mkdirSync(snapDir, { recursive: true });
if (mode === 'malformed') {
  fs.writeFileSync(path.join(snapDir, 'snapshot.json'), '{not valid json\n');
  process.exit(0);
}
const observedAt = new Date().toISOString();
const base = { origin_repo: originRepo, tree_hash: treeHash, cmd_hash: cmdHash, force: false, run_id: runId, step_id: null };
const rows = mode === 'hit'
  ? [
      { id: 'suite-observation-1', invocation_id: 'evt:1', sequence: 1, phase: 'lookup', observed_at: observedAt, ...base, latest_row_id: 1 },
      { id: 'suite-observation-2', invocation_id: 'evt:1', sequence: 2, phase: 'replay', observed_at: observedAt, ...base, ledger_row_id: 1, marker: 'TAMANDUA-TEST CACHED', exit_code: 0, committed_tree_hash: treeHash },
    ]
  : [
      { id: 'suite-observation-1', invocation_id: 'evt:1', sequence: 1, phase: 'lookup', observed_at: observedAt, ...base, latest_row_id: null },
      { id: 'suite-observation-2', invocation_id: 'evt:1', sequence: 2, phase: 'execute', observed_at: observedAt, ...base, started_at: observedAt, pre_tree_hash: treeHash, post_tree_hash: treeHash, exit_code: 0 },
      { id: 'suite-observation-3', invocation_id: 'evt:1', sequence: 3, phase: 'record', observed_at: observedAt, ...base, ledger_row_id: 2, exit_code: 0 },
    ];
fs.writeFileSync(path.join(snapDir, 'suite-observations.json'), `${JSON.stringify({ rows })}\n`);
fs.writeFileSync(path.join(snapDir, 'launch-intent.json'), `${JSON.stringify({
  schema_version: 1, gate_key: { origin_repo: originRepo, cmd_hash: cmdHash },
})}\n`);
fs.writeFileSync(path.join(snapDir, 'snapshot.json'), `${JSON.stringify({
  schema_version: 1,
  status: 'COMPLETE',
  case_id: 'US006-REPLAY',
  attempt_id: 'attempt-1',
  completed_at: observedAt,
  files: {
    suite_observations: { path: 'snapshots/US006-REPLAY/attempt-1/suite-observations.json', kind: 'controller-suite-state-machine' },
    launch_intent: { path: 'snapshots/US006-REPLAY/attempt-1/launch-intent.json', kind: 'controller-launch-intent' },
  },
})}\n`);
NODE
us006_write_manifest() {
  local manifest="$1" fixture_root="$2" mode="$3"
  node --input-type=module - "$manifest" "$fixture_root" "$mode" "$us006_pair_script" <<'NODE'
import fs from 'node:fs';
const [manifestPath, fixtureRoot, mode, pairScript] = process.argv.slice(2);
const pair = {
  id: 'US006-REPLAY-PAIR', wave: 3, workflow: 'local', fixture: 'tt-ts', harness: 'local',
  task: 'cases/tasks/tier1/W1.L2-ts.md', context: { execution_mode: 'scripted' },
  caps: { tokens: 0, wall_min: 5 }, requires: {}, boundary_files: [], forbidden: [],
  oracles: [], gates: [], chaos: null, shed_ok: false, mandatory: true, class: 'verification',
  command: { executable: 'node', args: [pairScript, fixtureRoot, mode], cwd: '.' },
};
const replay = {
  id: 'US006-REPLAY', wave: 3, workflow: 'tt-shim-probe', fixture: 'tt-ts', harness: 'pi',
  task: 'cases/tasks/tier1/W1.REPLAY-ts.md',
  context: { execution_mode: 'real', test_cmd: 'npm test', replay_of: 'US006-REPLAY-PAIR' },
  caps: { tokens: 100000, wall_min: 240 }, requires: {}, boundary_files: [], forbidden: [],
  oracles: [], gates: ['TIER1'], chaos: null, shed_ok: false, mandatory: true, class: 'verification',
};
fs.writeFileSync(manifestPath, `${[pair, replay].map((record) => JSON.stringify(record)).join('\n')}\n`);
NODE
}
us006_run_gate_campaign() {
  local manifest="$1" fixture_root="$2"
  PATH="$workflow_bin_dir:$PATH" CONTROLLER_WORKFLOW_EVENTS="$workflow_events" \
    CONTROLLER_WORKFLOW_MODE=harvest-status \
    TT_CONTROLLER_SELF_TEST=1 \
    TT_CONTROLLER_REPLAY_SNAPSHOT_FIXTURE_DIR="$fixture_root" \
    TT_CONTROLLER_REPLAY_PAIR_WAIT_MS=0 \
    run_recorded_campaign "$CONTROLLER" --manifest "$manifest"
}
us006_run_bare_campaign() {
  local manifest="$1"
  PATH="$workflow_bin_dir:$PATH" CONTROLLER_WORKFLOW_EVENTS="$workflow_events" \
    CONTROLLER_WORKFLOW_MODE=harvest-status \
    TT_CONTROLLER_REPLAY_PAIR_WAIT_MS=0 \
    run_recorded_campaign "$CONTROLLER" --manifest "$manifest"
}

us006_hit_manifest="$TEST_ROOT/manifests/us006-hit.jsonl"
us006_hit_fixture="$TEST_ROOT/replay-fixture-hit"
us006_write_manifest "$us006_hit_manifest" "$us006_hit_fixture" "hit"
us006_hit_output=$(us006_run_gate_campaign "$us006_hit_manifest" "$us006_hit_fixture") \
  || fail "replay cache-HIT campaign failed: $us006_hit_output"
us006_hit_id=$(remember_campaign "$us006_hit_output")
node --input-type=module - "$TT_DIR/var/results/$us006_hit_id/state.json" \
  "$TT_DIR/var/fixtures/work/US006-REPLAY-PAIR/tt-ts" <<'NODE'
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const [statePath, clonePath] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const pair = state.cases.find((c) => c.id === 'US006-REPLAY-PAIR');
const replay = state.cases.find((c) => c.id === 'US006-REPLAY');
if (pair.outcome !== 'PASS') throw new Error(`pair must PASS first: ${JSON.stringify(pair)}`);
if (replay.outcome !== 'PASS') throw new Error(`replay cache HIT must PASS: ${JSON.stringify(replay)}`);
const attempt = replay.attempts.at(-1);
const gate = attempt?.replay_cache_assertion;
if (gate?.ok !== true || gate.evidence?.status !== 'replay-cache-hit') {
  throw new Error(`hit assertion evidence is missing on the attempt: ${JSON.stringify(attempt)}`);
}
if (gate.evidence.run_id !== 'run-aaaaaaaa-1111-4111-8111-111111111111') {
  throw new Error(`assertion must bind to this attempt's run: ${JSON.stringify(gate.evidence)}`);
}
if (!gate.evidence.observed_phases.includes('replay')) {
  throw new Error(`observed phases must include the cache-hit replay phase: ${JSON.stringify(gate.evidence.observed_phases)}`);
}
const tree = spawnSync('git', ['-C', clonePath, 'rev-parse', '--verify', 'HEAD^{tree}'], { encoding: 'utf8' }).stdout.trim();
if (gate.evidence.key.tree_hash !== tree || !/^[0-9a-f]{40,64}$/.test(tree)) {
  throw new Error(`assertion key must bind to the pair's committed tree: ${JSON.stringify(gate.evidence.key)} vs ${tree}`);
}
if (gate.evidence.hit_observation?.marker !== 'TAMANDUA-TEST CACHED') {
  throw new Error(`hit observation must carry the replay marker: ${JSON.stringify(gate.evidence.hit_observation)}`);
}
if ((replay.findings ?? []).some((f) => f.type === 'REPLAY_CACHE_MISS')) {
  throw new Error(`a hit must never record a REPLAY_CACHE_MISS finding: ${JSON.stringify(replay.findings)}`);
}
if (attempt.classification_reason !== undefined) {
  throw new Error(`a hit PASS must carry no classification reason: ${JSON.stringify(attempt.classification_reason)}`);
}
NODE
pass "REPLAY cache HIT passes and records the assertion evidence on the attempt"

us006_miss_manifest="$TEST_ROOT/manifests/us006-miss.jsonl"
us006_miss_fixture="$TEST_ROOT/replay-fixture-miss"
us006_write_manifest "$us006_miss_manifest" "$us006_miss_fixture" "miss"
us006_miss_output=$(us006_run_gate_campaign "$us006_miss_manifest" "$us006_miss_fixture") \
  || fail "replay cache-MISS campaign failed: $us006_miss_output"
us006_miss_id=$(remember_campaign "$us006_miss_output")
node --input-type=module - "$TT_DIR/var/results/$us006_miss_id/state.json" <<'NODE'
import fs from 'node:fs';
const [statePath] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const replay = state.cases.find((c) => c.id === 'US006-REPLAY');
if (replay.outcome === 'PASS') throw new Error(`execute/record must never PASS: ${JSON.stringify(replay)}`);
if (replay.outcome !== 'INCONCLUSIVE') throw new Error(`execute/record must classify INCONCLUSIVE: ${JSON.stringify(replay)}`);
if (replay.reason?.category !== 'replay-cache-miss') {
  throw new Error(`the distinct replay-cache-miss category must classify the outcome: ${JSON.stringify(replay.reason)}`);
}
const finding = (replay.findings ?? []).find((f) => f.type === 'REPLAY_CACHE_MISS');
if (!finding || JSON.stringify(finding.observed_phases) !== JSON.stringify(['lookup', 'execute', 'record'])) {
  throw new Error(`REPLAY_CACHE_MISS finding must carry the observed phases: ${JSON.stringify(replay.findings)}`);
}
if (finding.run_id !== 'run-aaaaaaaa-1111-4111-8111-111111111111') {
  throw new Error(`the miss finding must bind to this attempt's run: ${JSON.stringify(finding)}`);
}
const attempt = replay.attempts.at(-1);
const gate = attempt?.replay_cache_assertion;
if (gate?.ok !== false || gate.kind !== 'replay-cache-miss') {
  throw new Error(`miss assertion evidence is missing on the attempt: ${JSON.stringify(attempt)}`);
}
if (attempt.classification_reason?.category !== 'replay-cache-miss') {
  throw new Error(`attempt classification must carry replay-cache-miss: ${JSON.stringify(attempt.classification_reason)}`);
}
NODE
pass "REPLAY execute/record observations are never PASS and carry the replay-cache-miss finding"

us006_malformed_manifest="$TEST_ROOT/manifests/us006-malformed.jsonl"
us006_malformed_fixture="$TEST_ROOT/replay-fixture-malformed"
us006_write_manifest "$us006_malformed_manifest" "$us006_malformed_fixture" "malformed"
us006_malformed_output=$(us006_run_gate_campaign "$us006_malformed_manifest" "$us006_malformed_fixture") \
  || fail "replay malformed-snapshot campaign failed: $us006_malformed_output"
us006_malformed_id=$(remember_campaign "$us006_malformed_output")
node --input-type=module - "$TT_DIR/var/results/$us006_malformed_id/state.json" <<'NODE'
import fs from 'node:fs';
const [statePath] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const replay = state.cases.find((c) => c.id === 'US006-REPLAY');
if (replay.outcome !== 'TEST_INFRA_FAIL') {
  throw new Error(`a malformed snapshot must fail closed as TEST_INFRA: ${JSON.stringify(replay)}`);
}
if (replay.reason?.category !== 'replay-snapshot-unreadable') {
  throw new Error(`malformed snapshot must classify replay-snapshot-unreadable: ${JSON.stringify(replay.reason)}`);
}
const attempt = replay.attempts.at(-1);
const gate = attempt?.replay_cache_assertion;
if (gate?.ok !== false || gate.kind !== 'replay-cache-infra') {
  throw new Error(`infra assertion evidence is missing on the attempt: ${JSON.stringify(attempt)}`);
}
NODE
pass "a malformed replay snapshot fails closed as TEST_INFRA, never PASS"

us006_missing_manifest="$TEST_ROOT/manifests/us006-missing.jsonl"
us006_write_manifest "$us006_missing_manifest" "$TEST_ROOT/replay-fixture-unused" "provision-only"
us006_missing_output=$(us006_run_bare_campaign "$us006_missing_manifest") \
  || fail "replay missing-snapshot campaign failed: $us006_missing_output"
us006_missing_id=$(remember_campaign "$us006_missing_output")
node --input-type=module - "$TT_DIR/var/results/$us006_missing_id/state.json" <<'NODE'
import fs from 'node:fs';
const [statePath] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const replay = state.cases.find((c) => c.id === 'US006-REPLAY');
if (replay.outcome !== 'TEST_INFRA_FAIL') {
  throw new Error(`a missing snapshot must fail closed as TEST_INFRA: ${JSON.stringify(replay)}`);
}
if (replay.reason?.category !== 'replay-snapshot-missing') {
  throw new Error(`missing snapshot must classify replay-snapshot-missing: ${JSON.stringify(replay.reason)}`);
}
NODE
pass "a replay with no snapshot at all fails closed as TEST_INFRA (replay-snapshot-missing)"
rm -rf -- "$TT_DIR/var/fixtures/work/US006-REPLAY-PAIR"

direct_workflow_manifest="$TEST_ROOT/manifests/workflow-direct.jsonl"
valid_case "WORKFLOW-DIRECT" \
  | sed 's/"requires":{"toolchains":\["node"\]}/"requires":{}/' \
  | sed 's/"workflow":"bug-fix-merge-worktree"/"workflow":"do-now"/' \
  | sed 's/"harness":"hermes"/"harness":"pi"/' \
  > "$direct_workflow_manifest"
direct_workflow_output=$(PATH="$workflow_bin_dir:$PATH" CONTROLLER_WORKFLOW_EVENTS="$workflow_events" \
  run_recorded_campaign "$CONTROLLER" --manifest "$direct_workflow_manifest") \
  || fail "direct workflow argv path failed: $direct_workflow_output"
direct_workflow_id=$(remember_campaign "$direct_workflow_output")
node --input-type=module - "$TT_DIR/var/results/$direct_workflow_id/state.json" "$workflow_events" \
  "$TT_DIR/var/fixtures/work/WORKFLOW-DIRECT/tt-ts" <<'NODE'
import fs from 'node:fs';
const [statePath, eventsPath, fixturePath] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const events = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
const event = events.findLast(entry => entry.argv[0] === 'workflow' && entry.argv[1] === 'run');
if (state.cases[0].outcome !== 'PASS' || event.argv[2] !== 'do-now'
    || !event.argv.includes('--pi-as-harness')
    || !event.argv.includes('--working-directory-for-harness')
    || !event.argv.includes(fixturePath)
    || event.argv.includes('--worktree-origin-repository')) {
  throw new Error(`direct workflow fixture argv is incorrect: ${JSON.stringify(event.argv)}`);
}
NODE
pass "direct workflow argv selects the fixture working directory and pi harness"

discovery_manifest="$TEST_ROOT/manifests/workflow-discovery.jsonl"
discovery_child_waited="$TEST_ROOT/discovery-child-waited"
discovery_replacement_waited="$TEST_ROOT/discovery-replacement-waited"
discovery_limited_runs="$TEST_ROOT/discovery-limited-runs.json"
discovery_times=$(node -e 'const now=Date.now();console.log([0,60000,120000].map(n=>new Date(now+n).toISOString()).join(" "))')
read -r discovery_root_at discovery_child_at discovery_replacement_at <<< "$discovery_times"
valid_case "WORKFLOW-DISCOVERY" \
  | sed 's/"requires":{"toolchains":\["node"\]}/"requires":{}/' \
  | sed 's/"workflow":"bug-fix-merge-worktree"/"workflow":"just-do-it"/' \
  | sed 's/"context":{}/"context":{"execution_mode":"scripted"}/' \
  > "$discovery_manifest"
DISCOVERY_EVENTS_DIR="$TT_DIR/var/home-scripted/.tamandua/events"
DISCOVERY_EVENTS_BACKUP_DIR="$TEST_ROOT/original-discovery-events"
DISCOVERY_EVENT_ARCHIVE="$DISCOVERY_EVENTS_DIR/all.jsonl.1"
mkdir -p "$DISCOVERY_EVENTS_DIR" "$DISCOVERY_EVENTS_BACKUP_DIR"
for discovery_event in "$DISCOVERY_EVENTS_DIR/all.jsonl" "$DISCOVERY_EVENTS_DIR/all.jsonl.1" \
    "$DISCOVERY_EVENTS_DIR/all.jsonl.2" "$DISCOVERY_EVENTS_DIR/all.jsonl.3"; do
  if [ -f "$discovery_event" ]; then
    mv "$discovery_event" "$DISCOVERY_EVENTS_BACKUP_DIR/$(basename "$discovery_event")"
  fi
done
node --input-type=module - "$DISCOVERY_DB" "$DISCOVERY_EVENT_ARCHIVE" "$discovery_limited_runs" \
  "$discovery_root_at" "$discovery_child_at" "$discovery_replacement_at" <<'NODE'
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const [dbPath, archivePath, limitedRunsPath, rootAt, childAt, replacementAt] = process.argv.slice(2);
const db = new DatabaseSync(dbPath);
db.exec('DELETE FROM runs');
const insert = db.prepare(`INSERT INTO runs
  (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
  VALUES (?, ?, ?, ?, '{}', ?, ?, ?)`);
insert.run('77777777-7777-4777-8777-777777777777', 'just-do-it', 'shared dispatch task', 'completed', 5, rootAt, rootAt);
insert.run('88888888-8888-4888-8888-888888888888', 'do-now', 'shared dispatch task', 'running', 7, childAt, childAt);
insert.run('99999999-9999-4999-8999-999999999999', 'just-do-it', 'replacement task', 'completed', 11, replacementAt, replacementAt);
const limited = [];
for (let index = 0; index < 51; index += 1) {
  const suffix = String(index + 1).padStart(12, '0');
  const id = `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`;
  const createdAt = new Date(new Date(replacementAt).valueOf() + (index + 1) * 60_000).toISOString();
  insert.run(id, 'noise', `newer unrelated run ${index}`, 'completed', 0, createdAt, createdAt);
  if (index > 0) {
    limited.push({ runId: `run-${id}`, status: 'completed', tokensSpent: 0, task: `newer unrelated run ${index}`, createdAt });
  }
}
db.close();
fs.writeFileSync(limitedRunsPath, `${JSON.stringify({ runs: limited })}\n`);
fs.writeFileSync(archivePath, `${JSON.stringify({
  ts: replacementAt,
  event: 'run.rugpull_relaunched',
  runId: '88888888-8888-4888-8888-888888888888',
  detail: 'Rugpull replacement run launched: 99999999-9999-4999-8999-999999999999',
})}\n`);
NODE
discovery_output=$(PATH="$workflow_bin_dir:$PATH" CONTROLLER_WORKFLOW_EVENTS="$workflow_events" \
  TT_CONTROLLER_POLL_INTERVAL_MS=20 \
  CONTROLLER_WORKFLOW_MODE=discovery CONTROLLER_DISCOVERY_CHILD_WAITED="$discovery_child_waited" \
  CONTROLLER_DISCOVERY_REPLACEMENT_WAITED="$discovery_replacement_waited" \
  CONTROLLER_LIMITED_RUNS_JSON="$discovery_limited_runs" \
  CONTROLLER_DISCOVERY_ROOT_AT="$discovery_root_at" CONTROLLER_DISCOVERY_CHILD_AT="$discovery_child_at" \
  CONTROLLER_DISCOVERY_REPLACEMENT_AT="$discovery_replacement_at" \
  run_recorded_campaign "$CONTROLLER" --manifest "$discovery_manifest") \
  || fail "discovered-run convergence failed: $discovery_output"
discovery_id=$(remember_campaign "$discovery_output")
node --input-type=module - "$TT_DIR/var/results/$discovery_id/state.json" "$workflow_events" \
  "$discovery_child_at" "$discovery_replacement_at" "$discovery_limited_runs" <<'NODE'
import fs from 'node:fs';
const [statePath, eventsPath, childStartedAt, replacementStartedAt, limitedRunsPath] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const item = state.cases[0];
const discovered = state.discovered_runs;
if (!Array.isArray(discovered) || discovered.length !== 2
    || new Set(discovered.map(run => run.run_id)).size !== 2) {
  throw new Error(`linked runs were not persisted once: ${JSON.stringify(discovered)}`);
}
const child = discovered.find(run => run.run_id.startsWith('run-88888888'));
const replacement = discovered.find(run => run.run_id.startsWith('run-99999999'));
if (child?.parent_run_id !== 'run-77777777-7777-4777-8777-777777777777'
    || replacement?.parent_run_id !== child?.run_id
    || child?.root_case_id !== item.id || replacement?.root_case_id !== item.id) {
  throw new Error(`discovered relationships/root attribution are wrong: ${JSON.stringify(discovered)}`);
}
if (child.started_at !== childStartedAt
    || new Date(child.deadline_at).valueOf() - new Date(child.started_at).valueOf() !== 4 * 60 * 60 * 1000
    || replacement.started_at !== replacementStartedAt
    || new Date(replacement.deadline_at).valueOf() - new Date(replacement.started_at).valueOf() !== 4 * 60 * 60 * 1000) {
  throw new Error(`discovered deadlines did not use each run's creation time: ${JSON.stringify(discovered)}`);
}
if (discovered.some(run => run.phase !== 'terminal' || run.terminal_status !== 'completed')) {
  throw new Error(`campaign finished with a nonterminal discovered run: ${JSON.stringify(discovered)}`);
}
if (discovered.some(run => run.execution_mode !== item.attempts[0].execution_mode)) {
  throw new Error(`discovered runs did not inherit root launch execution mode: ${JSON.stringify(discovered)}`);
}
if (discovered.some(run => run.wait_exit_code !== 0 || run.wait_json?.runs?.[0]?.status !== 'completed'
    || !Array.isArray(run.steps_snapshot?.steps) || run.steps_snapshot?.source !== 'workflow-status-json')) {
  throw new Error(`discovered run harvest evidence is incomplete: ${JSON.stringify(discovered)}`);
}
if (child.tokens_observed !== 7 || replacement.tokens_observed !== 11
    || item.attempts[0].tokens_observed !== 5
    || item.spend.tokens_observed !== 23 || state.spend.tokens_observed !== 23) {
  throw new Error(`discovered spend was not attributed exactly once: ${JSON.stringify({discovered,item:item.spend,campaign:state.spend})}`);
}
const events = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
const cappedInventory = JSON.parse(fs.readFileSync(limitedRunsPath, 'utf8')).runs;
if (cappedInventory.length !== 50 || cappedInventory.some(run => run.runId === child.run_id
    || run.runId === replacement.run_id)
    || events.some(event => event.argv[0] === 'workflow' && event.argv[1] === 'runs')) {
  throw new Error('discovery did not bypass the capped workflow-runs surface');
}
for (const run of discovered) {
  const waits = events.filter(event => event.argv[0] === 'workflow' && event.argv[1] === 'wait'
    && event.argv[2] === run.run_id);
  if (waits.length !== 1) throw new Error(`discovered run was not reattached exactly once: ${JSON.stringify({run,waits})}`);
}
NODE
pass "child and replacement runs converge with own deadlines and exact spend attribution"

discovery_state="$TT_DIR/var/results/$discovery_id/state.json"
node --input-type=module - "$discovery_state" <<'NODE'
import fs from 'node:fs';
const statePath = process.argv[2];
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const child = state.discovered_runs.find(run => run.run_id.startsWith('run-88888888'));
child.phase = 'attached';
delete child.terminal_at;
delete child.terminal_status;
child.deadline_at = new Date(Date.now() - 1_000).toISOString();
delete child.stop_intent_at;
delete child.stop_reason;
fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
NODE
discovery_launches_before=$(grep -c '"argv":\["workflow","run"' "$workflow_events" || true)
discovery_resume_output=$(PATH="$workflow_bin_dir:$PATH" CONTROLLER_WORKFLOW_EVENTS="$workflow_events" \
  TT_CONTROLLER_POLL_INTERVAL_MS=20 \
  CONTROLLER_WORKFLOW_MODE=discovery CONTROLLER_DISCOVERY_CHILD_WAITED="$discovery_child_waited" \
  CONTROLLER_DISCOVERY_REPLACEMENT_WAITED="$discovery_replacement_waited" \
  CONTROLLER_LIMITED_RUNS_JSON="$discovery_limited_runs" \
  CONTROLLER_DISCOVERY_ROOT_AT="$discovery_root_at" CONTROLLER_DISCOVERY_CHILD_AT="$discovery_child_at" \
  CONTROLLER_DISCOVERY_REPLACEMENT_AT="$discovery_replacement_at" \
  CONTROLLER_DISCOVERY_HANG_WAIT=1 \
  run_recorded_campaign "$CONTROLLER" --resume "$discovery_id") \
  || fail "discovered-run resume failed: $discovery_resume_output"
discovery_launches_after=$(grep -c '"argv":\["workflow","run"' "$workflow_events" || true)
[ "$discovery_launches_after" -eq "$discovery_launches_before" ] \
  || fail "discovered-run resume launched a replacement root run"
node --input-type=module - "$discovery_state" "$workflow_events" <<'NODE'
import fs from 'node:fs';
const [statePath, eventsPath] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const child = state.discovered_runs.find(run => run.run_id.startsWith('run-88888888'));
const waits = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  .filter(event => event.argv[0] === 'workflow' && event.argv[1] === 'wait'
    && event.argv[2] === child.run_id);
const stops = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  .filter(event => event.argv[0] === 'workflow' && event.argv[1] === 'stop'
    && event.argv[2] === child.run_id);
if (child.phase !== 'terminal' || child.terminal_status !== 'completed'
    || child.reattach_count !== 2 || waits.length !== 2 || stops.length !== 1
    || child.stop_reason?.cap !== 'wall_min'
    || child.straggler_capture?.stop_intent_at !== child.stop_intent_at
    || child.straggler_capture?.reason?.cap !== 'wall_min'
    || !Array.isArray(child.straggler_capture?.steps_snapshot?.steps)) {
  throw new Error(`resume did not bound and reattach the persisted discovered run: ${JSON.stringify({child,waits,stops})}`);
}
if (state.cases[0].spend.tokens_observed !== 23 || state.spend.tokens_observed !== 23) {
  throw new Error(`resume double-attributed discovered spend: ${JSON.stringify(state.spend)}`);
}
NODE
pass "resume reattaches persisted discovered runs without relaunch or double spend"

for cap_mode in token-cap wall-cap; do
  cap_manifest="$TEST_ROOT/manifests/workflow-$cap_mode.jsonl"
  cap_stop_marker="$TEST_ROOT/$cap_mode-stop"
  cap_status_count="$TEST_ROOT/$cap_mode-status-count"
  valid_case "WORKFLOW-$(toupper "$cap_mode")" \
    | sed 's/"requires":{"toolchains":\["node"\]}/"requires":{}/' \
    > "$cap_manifest"
  node --input-type=module - "$cap_manifest" "$cap_mode" <<'NODE'
import fs from 'node:fs';
const [manifestPath, mode] = process.argv.slice(2);
const record = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
record.caps.tokens = mode === 'token-cap' ? 10 : 100;
record.caps.wall_min = mode === 'wall-cap' ? 0.002 : 5;
fs.writeFileSync(manifestPath, `${JSON.stringify(record)}\n`);
NODE
  cap_output=$(PATH="$workflow_bin_dir:$PATH" CONTROLLER_WORKFLOW_EVENTS="$workflow_events" \
    CONTROLLER_WORKFLOW_MODE="$cap_mode" CONTROLLER_STOP_MARKER="$cap_stop_marker" \
    CONTROLLER_STATUS_COUNT="$cap_status_count" TT_CONTROLLER_POLL_INTERVAL_MS=20 \
    TT_CONTROLLER_CAP_CHECK_INTERVAL_MS=20 \
    run_recorded_campaign "$CONTROLLER" --manifest "$cap_manifest") || fail "$cap_mode enforcement failed: $cap_output"
  cap_id=$(remember_campaign "$cap_output")
  node --input-type=module - "$TT_DIR/var/results/$cap_id/state.json" "$workflow_events" "$cap_mode" <<'NODE'
import fs from 'node:fs';
const [statePath, eventsPath, mode] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const item = state.cases[0];
const attempt = item.attempts[0];
const events = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
const runId = mode === 'token-cap'
  ? 'run-55555555-5555-4555-8555-555555555555'
  : 'run-66666666-6666-4666-8666-666666666666';
const relevant = events.filter(event => event.argv.includes(runId));
const stops = relevant.filter(event => event.argv[0] === 'workflow' && event.argv[1] === 'stop');
const waits = relevant.filter(event => event.argv[0] === 'workflow' && event.argv[1] === 'wait');
if (stops.length !== 1) throw new Error(`expected exactly one stop: ${JSON.stringify(relevant)}`);
if (waits.length !== 1 || waits[0].at < stops[0].at) throw new Error(`stop was not followed by wait: ${JSON.stringify(relevant)}`);
if (waits[0].argv.includes('--timeout')) throw new Error(`terminal cleanup incorrectly used waiter timeout: ${JSON.stringify(waits[0])}`);
if (item.phase !== 'terminal' || attempt.phase !== 'terminal' || !attempt.terminal_at) {
  throw new Error(`stopped run was not awaited to terminal: ${JSON.stringify(item)}`);
}
if (attempt.stop?.exit_code !== 0 || attempt.terminal_wait?.exit_code !== 3) {
  throw new Error(`stop/wait evidence missing: ${JSON.stringify(attempt)}`);
}
if (attempt.straggler_capture?.stop_intent_at !== attempt.stop_intent_at
    || attempt.straggler_capture?.reason?.cap !== (mode === 'token-cap' ? 'tokens' : 'wall_min')
    || !Array.isArray(attempt.straggler_capture?.steps_snapshot?.steps)) {
  throw new Error(`mechanical pre-stop straggler capture missing: ${JSON.stringify(attempt.straggler_capture)}`);
}
const finding = item.findings?.find(entry => entry.type === 'RUNAWAY');
const expectedKind = mode === 'token-cap' ? 'tokens' : 'wall_min';
if (!finding || finding.cap !== expectedKind) throw new Error(`RUNAWAY finding missing: ${JSON.stringify(item.findings)}`);
if (!Array.isArray(item.spend?.observations) || item.spend.observations.length === 0
    || !Array.isArray(state.spend?.observations) || state.spend.observations.length !== item.spend.observations.length) {
  throw new Error(`case/campaign observation ledgers missing: ${JSON.stringify({case:item.spend,campaign:state.spend})}`);
}
if (item.spend.tokens_observed !== attempt.tokens_observed
    || state.spend.tokens_observed !== item.spend.tokens_observed) {
  throw new Error(`observed spend was not attributed exactly once: ${JSON.stringify({attempt,case:item.spend,campaign:state.spend})}`);
}
if (mode === 'token-cap') {
  if (attempt.tokens_observed !== 10 || item.spend.observations.length < 2
      || finding.threshold !== 10 || finding.observed !== 10) {
    throw new Error(`token threshold evidence is wrong: ${JSON.stringify(item)}`);
  }
} else if (finding.threshold !== 0.002 || typeof finding.observed !== 'number'
    || finding.observed < finding.threshold) {
  throw new Error(`wall threshold evidence is wrong: ${JSON.stringify(item)}`);
}
// S8a: every breach record carries the enforcement-latency evidence (seconds
// from threshold crossing to detection) alongside the observed value.
if (typeof attempt.stop_reason?.observed !== 'number'
    || typeof attempt.stop_reason?.enforcement_latency !== 'number'
    || attempt.stop_reason.enforcement_latency < 0
    || attempt.stop_reason.observed !== finding.observed
    || attempt.stop_reason.enforcement_latency !== finding.enforcement_latency) {
  throw new Error(`stop_reason lacks observed/enforcement_latency: ${JSON.stringify({reason: attempt.stop_reason, finding})}`);
}
if (typeof attempt.straggler_capture?.reason?.enforcement_latency !== 'number'
    || attempt.straggler_capture.reason.enforcement_latency !== finding.enforcement_latency) {
  throw new Error(`straggler capture lacks enforcement latency: ${JSON.stringify(attempt.straggler_capture)}`);
}
NODE
done
pass "workflow token and wall caps persist spend and enforce one stop plus terminal wait"

# S8a decoupling proof: a wall cap fires on the cap-check cadence even while the
# token poll keeps its large production cadence. wall_min is scaled down
# (3 min * 1/1500 = 0.002 min, 120 ms) so the test stays fast; the observed
# < 3.5 min envelope plus the wall-clock bound prove the breach did NOT ride
# the 5-minute token poll. A 45 s timeout turns any regression into a fast
# failure instead of a 5-minute hang.
decoupled_manifest="$TEST_ROOT/manifests/workflow-wall-cap-decoupled.jsonl"
decoupled_stop_marker="$TEST_ROOT/wall-cap-decoupled-stop"
decoupled_status_count="$TEST_ROOT/wall-cap-decoupled-status-count"
valid_case "WORKFLOW-WALL-CAP-DECOUPLED" \
  | sed 's/"requires":{"toolchains":\["node"\]}/"requires":{}/' \
  > "$decoupled_manifest"
node --input-type=module - "$decoupled_manifest" <<'NODE'
import fs from 'node:fs';
const manifestPath = process.argv[2];
const record = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
record.caps.tokens = 100;
record.caps.wall_min = 0.002; // scaled-down stand-in for a 3-minute wall cap
fs.writeFileSync(manifestPath, `${JSON.stringify(record)}\n`);
NODE
decoupled_output_file="$TEST_ROOT/wall-cap-decoupled-output"
(
  PATH="$workflow_bin_dir:$PATH" CONTROLLER_WORKFLOW_EVENTS="$workflow_events" \
    CONTROLLER_WORKFLOW_MODE=wall-cap CONTROLLER_STOP_MARKER="$decoupled_stop_marker" \
    CONTROLLER_STATUS_COUNT="$decoupled_status_count" \
    TT_CONTROLLER_CAP_CHECK_INTERVAL_MS=20 \
    run_recorded_campaign "$CONTROLLER" --manifest "$decoupled_manifest" > "$decoupled_output_file" 2>&1
) &
decoupled_pid=$!
decoupled_done=""
for _ in $(seq 1 225); do
  kill -0 "$decoupled_pid" 2>/dev/null || { decoupled_done=1; break; }
  sleep 0.2
done
if [ -z "$decoupled_done" ]; then
  kill -9 "$decoupled_pid" 2>/dev/null || true
  wait "$decoupled_pid" 2>/dev/null || true
  fail "decoupled wall-cap enforcement exceeded its 45 s wall-clock bound (it rode the token poll)"
fi
set +e
wait "$decoupled_pid"
decoupled_status=$?
set -e
decoupled_output="$(cat "$decoupled_output_file")"
[ "$decoupled_status" -le 2 ] && printf '%s\n' "$decoupled_output" | grep -Fq 'Campaign: ' \
  || fail "decoupled wall-cap enforcement failed: $decoupled_output"
decoupled_id=$(remember_campaign "$decoupled_output")
node --input-type=module - "$TT_DIR/var/results/$decoupled_id/state.json" <<'NODE'
import fs from 'node:fs';
const statePath = process.argv[2];
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const item = state.cases[0];
const attempt = item.attempts[0];
const finding = item.findings?.find((entry) => entry.type === 'RUNAWAY');
// The token poll kept its production 5-minute cadence; only the cap check was fast.
if (state.options.token_poll_interval_ms !== 300000
    || state.options.cap_check_interval_ms !== 20) {
  throw new Error(`decoupled cadences were not persisted: ${JSON.stringify(state.options)}`);
}
if (attempt.stop_reason?.cap !== 'wall_min' || finding?.cap !== 'wall_min') {
  throw new Error(`decoupled wall cap did not fire: ${JSON.stringify({reason: attempt.stop_reason, findings: item.findings})}`);
}
if (typeof attempt.stop_reason.observed !== 'number'
    || attempt.stop_reason.observed < attempt.stop_reason.threshold
    || attempt.stop_reason.observed >= 3.5) {
  throw new Error(`wall breach observed outside the < 3.5 min envelope: ${JSON.stringify(attempt.stop_reason)}`);
}
const stopElapsedMs = new Date(attempt.stop_intent_at).valueOf() - new Date(attempt.started_at).valueOf();
if (stopElapsedMs > 30_000) {
  throw new Error(`wall breach waited ${stopElapsedMs} ms — it rode the token poll: ${JSON.stringify(attempt.stop_reason)}`);
}
const expectedLatency = Math.max(0,
  (new Date(attempt.stop_intent_at).valueOf()
    - (new Date(attempt.started_at).valueOf() + attempt.stop_reason.threshold * 60_000)) / 1000);
for (const evidence of [attempt.stop_reason, finding, attempt.straggler_capture?.reason]) {
  if (typeof evidence?.observed !== 'number' || typeof evidence?.enforcement_latency !== 'number'
      || evidence.enforcement_latency < 0
      || Math.abs(evidence.enforcement_latency - expectedLatency) > 1) {
    throw new Error(`breach evidence lacks observed/enforcement_latency: ${JSON.stringify({evidence, expectedLatency})}`);
  }
}
NODE
pass "wall cap fires on the dedicated cap-check cadence while the token poll stays at its production default"

# S8a (US-002) decoupling proof for DISCOVERED runs: a child run of a
# multi-run case whose wall deadline is ~3 minutes out (wall_min 3; the
# deadline distance is scaled down by seeding created_at 170 s in the past so
# the deadline lands ~10 s after discovery) is stopped near its deadline even
# while the token poll keeps a 10-minute cadence, and its stop_reason /
# straggler_capture.reason carry observed + enforcement_latency. A 60 s
# wall-clock bound turns any regression into a fast failure instead of a
# 10-minute hang. The explicit context.parentRunId link is what makes the
# pre-existing child discoverable (the just-do-it task inference rejects runs
# that started before the root attempt).
discovery_cap_manifest="$TEST_ROOT/manifests/workflow-discovery-cap.jsonl"
discovery_cap_stop_marker="$TEST_ROOT/discovery-cap-stop"
discovery_cap_limited_runs="$TEST_ROOT/discovery-cap-limited-runs.json"
valid_case "WORKFLOW-DISCOVERY-CAP" \
  | sed 's/"requires":{"toolchains":\["node"\]}/"requires":{}/' \
  | sed 's/"workflow":"bug-fix-merge-worktree"/"workflow":"just-do-it"/' \
  | sed 's/"context":{}/"context":{"execution_mode":"scripted"}/' \
  > "$discovery_cap_manifest"
node --input-type=module - "$discovery_cap_manifest" <<'NODE'
import fs from 'node:fs';
const record = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
record.caps.tokens = 1000;
record.caps.wall_min = 3;
fs.writeFileSync(process.argv[2], `${JSON.stringify(record)}\n`);
NODE
discovery_cap_root_at=$(node -e 'console.log(new Date(Date.now() - 5000).toISOString())')
discovery_cap_child_at=$(node -e 'console.log(new Date(Date.now() - 170000).toISOString())')
node --input-type=module - "$DISCOVERY_DB" "$discovery_cap_limited_runs" \
  "$discovery_cap_root_at" "$discovery_cap_child_at" <<'NODE'
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const [dbPath, limitedRunsPath, rootAt, childAt] = process.argv.slice(2);
const db = new DatabaseSync(dbPath);
db.exec('DELETE FROM runs');
const insert = db.prepare(`INSERT INTO runs
  (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
insert.run('77777777-7777-4777-8777-777777777777', 'just-do-it', 'shared dispatch task',
  'completed', '{"parentRunId":null}', 5, rootAt, rootAt);
insert.run('88888888-8888-4888-8888-888888888888', 'do-now', 'shared dispatch task',
  'running', '{"parentRunId":"77777777-7777-4777-8777-777777777777"}', 7, childAt, childAt);
db.close();
fs.writeFileSync(limitedRunsPath, `${JSON.stringify({ runs: [] })}\n`);
NODE
discovery_cap_output_file="$TEST_ROOT/discovery-cap-output"
(
  PATH="$workflow_bin_dir:$PATH" CONTROLLER_WORKFLOW_EVENTS="$workflow_events" \
    CONTROLLER_WORKFLOW_MODE=discovery-cap CONTROLLER_DISCOVERY_CAP_STOP="$discovery_cap_stop_marker" \
    CONTROLLER_LIMITED_RUNS_JSON="$discovery_cap_limited_runs" \
    TT_CONTROLLER_POLL_INTERVAL_MS=600000 TT_CONTROLLER_CAP_CHECK_INTERVAL_MS=20 \
    run_recorded_campaign "$CONTROLLER" --manifest "$discovery_cap_manifest" > "$discovery_cap_output_file" 2>&1
) &
discovery_cap_pid=$!
discovery_cap_done=""
for _ in $(seq 1 300); do
  kill -0 "$discovery_cap_pid" 2>/dev/null || { discovery_cap_done=1; break; }
  sleep 0.2
done
if [ -z "$discovery_cap_done" ]; then
  kill -9 "$discovery_cap_pid" 2>/dev/null || true
  wait "$discovery_cap_pid" 2>/dev/null || true
  fail "discovered-run wall-cap enforcement exceeded its 60 s wall-clock bound (it rode the token poll)"
fi
set +e
wait "$discovery_cap_pid"
discovery_cap_status=$?
set -e
discovery_cap_output="$(cat "$discovery_cap_output_file")"
[ "$discovery_cap_status" -le 2 ] && printf '%s\n' "$discovery_cap_output" | grep -Fq 'Campaign: ' \
  || fail "discovered-run wall-cap enforcement failed: $discovery_cap_output"
discovery_cap_id=$(remember_campaign "$discovery_cap_output")
node --input-type=module - "$TT_DIR/var/results/$discovery_cap_id/state.json" <<'NODE'
import fs from 'node:fs';
const statePath = process.argv[2];
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const item = state.cases[0];
const child = state.discovered_runs?.find((run) => run.run_id.startsWith('run-88888888'));
if (!child || child.root_case_id !== item.id || child.phase !== 'terminal'
    || child.terminal_status !== 'canceled') {
  throw new Error(`discovered child was not stopped to terminal: ${JSON.stringify(state.discovered_runs)}`);
}
// The token poll kept its 10-minute cadence; only the cap check was fast.
if (state.options.token_poll_interval_ms !== 600000
    || state.options.cap_check_interval_ms !== 20) {
  throw new Error(`discovered cadences were not persisted: ${JSON.stringify(state.options)}`);
}
if (child.stop_reason?.cap !== 'wall_min' || child.stop_reason?.threshold !== 3) {
  throw new Error(`discovered wall cap did not fire: ${JSON.stringify({reason: child.stop_reason, findings: item.findings})}`);
}
if (typeof child.stop_reason.observed !== 'number'
    || child.stop_reason.observed < child.stop_reason.threshold
    || child.stop_reason.observed >= 3.5) {
  throw new Error(`discovered wall breach observed outside the < 3.5 min envelope: ${JSON.stringify(child.stop_reason)}`);
}
const stopElapsedMs = new Date(child.stop_intent_at).valueOf() - new Date(child.started_at).valueOf();
if (stopElapsedMs < 3 * 60_000 || stopElapsedMs > 3 * 60_000 + 30_000) {
  throw new Error(`discovered wall breach fired ${stopElapsedMs} ms after start — not near the deadline: ${JSON.stringify(child)}`);
}
const expectedLatency = Math.max(0,
  (new Date(child.stop_intent_at).valueOf()
    - (new Date(child.started_at).valueOf() + child.stop_reason.threshold * 60_000)) / 1000);
for (const evidence of [child.stop_reason, child.straggler_capture?.reason]) {
  if (typeof evidence?.observed !== 'number' || typeof evidence?.enforcement_latency !== 'number'
      || evidence.enforcement_latency < 0
      || Math.abs(evidence.enforcement_latency - expectedLatency) > 5) {
    throw new Error(`discovered breach evidence lacks observed/enforcement_latency: ${JSON.stringify({evidence, expectedLatency})}`);
  }
}
const finding = item.findings?.find((entry) => entry.type === 'RUNAWAY' && entry.discovered === true);
if (!finding || finding.cap !== 'wall_min' || finding.run_id !== child.run_id
    || finding.observed !== child.stop_reason.observed
    || finding.enforcement_latency !== child.stop_reason.enforcement_latency) {
  throw new Error(`discovered RUNAWAY finding missing: ${JSON.stringify({finding, reason: child.stop_reason})}`);
}
NODE
pass "discovered-run wall cap fires near deadline on the dedicated cap-check cadence while the token poll stays large"

for workflow_mode in stderr conflict missing; do
  workflow_mode_manifest="$TEST_ROOT/manifests/workflow-$workflow_mode.jsonl"
  valid_case "WORKFLOW-$(toupper "$workflow_mode")" \
    | sed 's/"requires":{"toolchains":\["node"\]}/"requires":{}/' \
    > "$workflow_mode_manifest"
  workflow_launch_count_before=$(grep -c '"argv":\["workflow","run"' "$workflow_events" || true)
  set +e
  workflow_mode_output=$(env PATH="$workflow_bin_dir:$PATH" CONTROLLER_WORKFLOW_EVENTS="$workflow_events" \
    CONTROLLER_WORKFLOW_MODE="$workflow_mode" "$CONTROLLER" --manifest "$workflow_mode_manifest" 2>&1)
  workflow_mode_status=$?
  set -e
  expected_workflow_mode_status=2
  [ "$workflow_mode" = "stderr" ] && expected_workflow_mode_status=0
  [ "$workflow_mode_status" -eq "$expected_workflow_mode_status" ] \
    || fail "$workflow_mode identifier path exited $workflow_mode_status instead of $expected_workflow_mode_status: $workflow_mode_output"
  workflow_mode_id=$(remember_campaign "$workflow_mode_output")
  if [ "$workflow_mode" = "stderr" ]; then
    workflow_resume_id="$workflow_mode_id"
    workflow_resume_state="$TT_DIR/var/results/$workflow_mode_id/state.json"
  fi
  node --input-type=module - "$TT_DIR/var/results/$workflow_mode_id/state.json" "$workflow_mode" "$workflow_events" <<'NODE'
import fs from 'node:fs';
const [statePath, mode, eventsPath] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const item = state.cases[0];
const attempt = item.attempts[0];
const expected = {
  stderr: 'run-22222222-2222-4222-8222-222222222222',
  conflict: 'run-33333333-3333-4333-8333-333333333333',
};
if (mode === 'stderr') {
  if (attempt.run_id !== expected.stderr || attempt.run_id_source !== 'stderr-short-status') {
    throw new Error(`stderr short identifier was not resolved and persisted: ${JSON.stringify(attempt)}`);
  }
  if (attempt.launch.signal !== 'SIGTERM' || attempt.phase !== 'attached'
      || item.phase !== 'running' || item.outcome !== undefined) {
    throw new Error(`killed waiter did not remain attached: ${JSON.stringify(item)}`);
  }
} else {
  if (item.phase !== 'terminal' || item.outcome !== 'TEST_INFRA_FAIL'
      || item.reason?.category !== 'workflow-run-identification') {
    throw new Error(`${mode} identifier evidence was not an infrastructure failure: ${JSON.stringify(item)}`);
  }
  if (mode === 'conflict') {
    const resolved = attempt.run_id_observations.map(entry => entry.resolved_run_id).filter(Boolean);
    if (!resolved.includes(expected.conflict) || !resolved.includes('run-44444444-4444-4444-8444-444444444444')) {
      throw new Error(`conflicting identifiers were not retained as evidence: ${JSON.stringify(attempt)}`);
    }
  }
}
const launches = fs.readFileSync(eventsPath, 'utf8').trim().split('\n')
  .map(line => JSON.parse(line))
  .filter(event => event.argv[0] === 'workflow' && event.argv[1] === 'run'
    && event.argv[2] === 'bug-fix-merge-worktree');
const caseLaunches = launches.filter(event => event.argv.includes(`tasks/W3.07.md`));
if (caseLaunches.length < 1) throw new Error('workflow was not launched');
NODE
  workflow_launch_count_after=$(grep -c '"argv":\["workflow","run"' "$workflow_events" || true)
  [ $((workflow_launch_count_after - workflow_launch_count_before)) -eq 1 ] \
    || fail "$workflow_mode identifier evidence caused a blind relaunch"
done
workflow_resume_runs_before=$(grep -c '"argv":\["workflow","run"' "$workflow_events" || true)
workflow_resume_output=$(PATH="$workflow_bin_dir:$PATH" CONTROLLER_WORKFLOW_EVENTS="$workflow_events" \
  CONTROLLER_WORKFLOW_MODE=resume run_recorded_campaign "$CONTROLLER" --resume "$workflow_resume_id") \
  || fail "workflow reattachment failed: $workflow_resume_output"
workflow_resume_runs_after=$(grep -c '"argv":\["workflow","run"' "$workflow_events" || true)
[ "$workflow_resume_runs_after" -eq "$workflow_resume_runs_before" ] \
  || fail "workflow resume launched a replacement workflow run"
node --input-type=module - "$workflow_resume_state" "$workflow_events" <<'NODE'
import fs from 'node:fs';
const [statePath, eventsPath] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const item = state.cases[0];
const attempt = item.attempts[0];
const events = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
const relevant = events.filter(event => event.argv.includes(attempt.run_id));
if (!relevant.some(event => event.argv[0] === 'workflow' && event.argv[1] === 'wait')) {
  throw new Error(`resume did not invoke workflow wait: ${JSON.stringify(relevant)}`);
}
if (item.phase !== 'terminal' || item.outcome !== 'PASS' || attempt.phase !== 'terminal'
    || attempt.recovery?.strategy !== 'workflow-wait' || attempt.tokens_observed !== 7) {
  throw new Error(`workflow attempt was not harvested after reattachment: ${JSON.stringify(item)}`);
}
NODE
[ -f "$TT_DIR/bin/daemon-control" ] \
  && [ "$(sha256sum "$TT_DIR/bin/daemon-control" | cut -d' ' -f1)" = "$DAEMON_CONTROL_ORIGINAL_HASH" ] \
  || fail "self-test modified the tracked daemon-control executable"
export TT_CONTROLLER_DAEMON_CONTROL_PATH="$TEST_ROOT/missing-daemon-control"
pass "workflow resume reattaches by run ID and never launches a replacement"

failed_reset_manifest="$TEST_ROOT/manifests/failed-reset.jsonl"
failed_reset_sentinel="$TEST_ROOT/failed-reset-command-ran"
write_local_case "$failed_reset_manifest" "FAILED-RESET" real 17 0 "$failed_reset_sentinel"
failed_reset_output=$(run_recorded_campaign "$CONTROLLER" --manifest "$failed_reset_manifest") || fail "failed reset should be a recorded case outcome: $failed_reset_output"
failed_reset_id=$(remember_campaign "$failed_reset_output")
node --input-type=module - "$TT_DIR/var/results/$failed_reset_id/state.json" <<'NODE'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const item = state.cases[0];
if (item.phase !== 'terminal' || item.outcome !== 'TEST_INFRA_FAIL' || item.reason?.category !== 'reset-failed') throw new Error(`failed reset classification missing: ${JSON.stringify(item)}`);
if (item.attempts.length !== 1 || item.attempts[0].outcome !== 'TEST_INFRA_FAIL'
    || item.attempts[0].counts_toward_gate !== false
    || item.attempts[0].reset?.exit_code !== 17 || item.attempts[0].command !== undefined) {
  throw new Error(`command ran after reset failure or attempt was not classified: ${JSON.stringify(item.attempts)}`);
}
NODE
[ ! -e "$failed_reset_sentinel" ] || fail "failed reset allowed command launch"
[ ! -e "$failed_reset_sentinel.command-ran" ] || fail "failed reset executed the local command"
pass "failed reset blocks launch and records TEST_INFRA_FAIL"

output_bound_manifest="$TEST_ROOT/manifests/output-bound.jsonl"
write_local_case "$output_bound_manifest" "OUTPUT-BOUND" real 0 0 "$TEST_ROOT/output-bound-sentinel"
node --input-type=module - "$output_bound_manifest" <<'NODE'
import fs from 'node:fs';
const manifest = process.argv[2];
const record = JSON.parse(fs.readFileSync(manifest, 'utf8'));
record.reset = null;
record.command.args = ['-e', "process.stdout.write(Buffer.alloc(17 * 1024 * 1024, 120))"];
fs.writeFileSync(manifest, `${JSON.stringify(record)}\n`);
NODE
output_bound_output=$(run_recorded_campaign "$CONTROLLER" --manifest "$output_bound_manifest") || fail "output-bound case should be recorded: $output_bound_output"
output_bound_id=$(remember_campaign "$output_bound_output")
node --input-type=module - "$TT_DIR/var/results/$output_bound_id/state.json" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const statePath = process.argv[2];
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const item = state.cases[0];
const hook = item.attempts[0]?.command;
if (item.phase !== 'terminal' || item.outcome !== 'TEST_INFRA_FAIL' || !hook?.error?.includes('evidence limit')) {
  throw new Error(`oversized output was not bounded: ${JSON.stringify(item)}`);
}
if (fs.statSync(path.join(path.dirname(statePath), hook.stdout)).size > 16 * 1024 * 1024) {
  throw new Error('stdout evidence exceeded the configured limit');
}
NODE
pass "local evidence capture is bounded"

timeout_manifest="$TEST_ROOT/manifests/local-timeout.jsonl"
write_local_case "$timeout_manifest" "LOCAL-TIMEOUT" real 0 0 "$TEST_ROOT/timeout-sentinel"
node --input-type=module - "$timeout_manifest" <<'NODE'
import fs from 'node:fs';
const manifest = process.argv[2];
const record = JSON.parse(fs.readFileSync(manifest, 'utf8'));
record.reset = null;
record.caps.wall_min = 0.003;
record.command.args = ['-e', 'setTimeout(() => {}, 3000)'];
fs.writeFileSync(manifest, `${JSON.stringify(record)}\n`);
NODE
timeout_started=$(date +%s)
timeout_output=$(run_recorded_campaign "$CONTROLLER" --manifest "$timeout_manifest") || fail "timed-out local case should be recorded: $timeout_output"
timeout_elapsed=$(( $(date +%s) - timeout_started ))
[ "$timeout_elapsed" -lt 3 ] || fail "local wall cap did not terminate the command promptly"
timeout_id=$(remember_campaign "$timeout_output")
node --input-type=module - "$TT_DIR/var/results/$timeout_id/state.json" <<'NODE'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const item = state.cases[0];
if (item.phase !== 'terminal' || item.outcome !== 'TEST_INFRA_FAIL'
    || !item.attempts[0]?.command?.error?.includes('wall limit')) {
  throw new Error(`local wall timeout was not recorded: ${JSON.stringify(item)}`);
}
NODE
pass "local hook runtime is bounded by the case wall cap"

daemon_manifest="$TEST_ROOT/manifests/daemon-required.jsonl"
valid_case "DAEMON-REQUIRED" | sed 's/"requires":{"toolchains":\["node"\]}/"requires":{}/' > "$daemon_manifest"
if [ ! -x "$TT_DIR/bin/daemon-control" ]; then
  daemon_output=$(run_recorded_campaign "$CONTROLLER" --manifest "$daemon_manifest") || fail "missing daemon-control should be recorded: $daemon_output"
  daemon_id=$(remember_campaign "$daemon_output")
  node --input-type=module - "$TT_DIR/var/results/$daemon_id/state.json" <<'NODE'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const item = state.cases[0];
if (item.phase !== 'terminal' || item.outcome !== 'NOT_RUN' || item.reason?.category !== 'daemon-control-unavailable') throw new Error(`daemon availability outcome missing: ${JSON.stringify(item)}`);
if (item.attempts.length !== 0) throw new Error('daemon-unavailable case launched work');
NODE
  pass "daemon-requiring case is NOT_RUN when sanctioned daemon-control is unavailable"
fi

node --input-type=module - "$SCHEMA" <<'NODE'
import fs from 'node:fs';
const schema = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const required = new Set(schema.required);
for (const key of [
  'id', 'wave', 'workflow', 'fixture', 'harness', 'task', 'context',
  'caps', 'requires', 'oracles', 'gates', 'chaos', 'shed_ok', 'mandatory', 'class',
]) {
  if (!required.has(key)) throw new Error(`schema does not require ${key}`);
}
// spec_ref, probe_id, probes must NOT be required
for (const key of ['spec_ref', 'probe_id', 'probes']) {
  if (required.has(key)) throw new Error(`schema must not require optional field ${key}`);
}
const values = schema.properties.class.enum;
if (JSON.stringify(values) !== JSON.stringify(['verification', 'characterization', 'exploratory'])) {
  throw new Error(`unexpected class enum: ${JSON.stringify(values)}`);
}
if (!schema.properties.caps.required.includes('tokens') || !schema.properties.caps.required.includes('wall_min')) {
  throw new Error('caps does not require tokens and wall_min');
}
// spec_ref: optional string with length bounds
const specRef = schema.properties.spec_ref;
if (!specRef) throw new Error('schema is missing spec_ref property');
if (specRef.type !== 'string') throw new Error(`spec_ref type=${specRef.type}, expected string`);
if (specRef.minLength !== 1 || specRef.maxLength !== 512) throw new Error('spec_ref length bounds wrong');
// probe_id: optional string with pattern
const probeId = schema.properties.probe_id;
if (!probeId) throw new Error('schema is missing probe_id property');
if (probeId.type !== 'string') throw new Error(`probe_id type=${probeId.type}, expected string`);
if (!/^\^\[A-Za-z0-9\]/.test(probeId.pattern ?? '')) throw new Error('probe_id missing pattern');
// probes: optional array of strings, uniqueItems
const probes = schema.properties.probes;
if (!probes) throw new Error('schema is missing probes property');
if (probes.type !== 'array') throw new Error(`probes type=${probes.type}, expected array`);
if (!probes.uniqueItems) throw new Error('probes must declare uniqueItems');
if (!probes.items || probes.items.type !== 'string') throw new Error('probes items are not strings');
NODE
pass "schema pins required fields, caps, class taxonomy, and new optional spec_ref/probe_id/probes properties"

# Optional spec_ref/probe_id/probes fields are accepted by --validate-only
new_fields_manifest="$TEST_ROOT/manifests/new-fields.jsonl"
valid_case "NEW-FIELDS" | sed 's/"oracles":\["TT-MISSING-O1","TT-MISSING-O2"\]/"oracles":["O1"],"probe_id":"BUG-001-probe","probes":["BUG-001-probe","BUG-002-probe"],"spec_ref":"05-wave-1-language-smoke.md#W1.L3"/' > "$new_fields_manifest"
new_fields_output=$("$CONTROLLER" --manifest "$new_fields_manifest" --validate-only 2>&1) || fail "new spec_ref/probe_id/probes fields rejected: $new_fields_output"
pass "optional spec_ref, probe_id, and probes fields pass --validate-only"

# Misspelled top-level key (spec_refs) is still rejected
misspelled_manifest="$TEST_ROOT/manifests/misspelled.jsonl"
valid_case "MISSPELLED-KEY" | sed 's/"class":"verification"/"spec_refs":"oops","class":"verification"/' > "$misspelled_manifest"
expect_rejected "misspelled top-level key spec_refs is rejected" "$misspelled_manifest" 'unknown property "spec_refs"'

valid_output=$(run_recorded_campaign "$CONTROLLER" --manifest "$CASES") || fail "cases.jsonl rejected: $valid_output"
printf '%s' "$valid_output" | grep -Fq 'Validated ' || fail "valid manifest did not report validation success"
remember_campaign "$valid_output" > /dev/null
pass "every cases.jsonl line validates"

malformed="$TEST_ROOT/manifests/malformed.jsonl"
{
  valid_case "VALID-FIRST"
  printf '%s\n' '{"id":'
} > "$malformed"
expect_rejected "malformed JSON has a line-numbered error" "$malformed" 'line 2: invalid JSON'

missing="$TEST_ROOT/manifests/missing.jsonl"
printf '%s\n' '{"id":"MISSING","wave":0}' > "$missing"
expect_rejected "missing fields are rejected" "$missing" 'line 1: $: missing required property "workflow"'

invalid_enum="$TEST_ROOT/manifests/invalid-enum.jsonl"
valid_case "BAD-CLASS" | sed 's/"class":"verification"/"class":"guesswork"/' > "$invalid_enum"
expect_rejected "invalid class is rejected" "$invalid_enum" 'line 1: $.class: must be one of'

invalid_execution_mode="$TEST_ROOT/manifests/invalid-execution-mode.jsonl"
write_local_case "$invalid_execution_mode" "BAD-EXECUTION-MODE" production 0 0 "$TEST_ROOT/invalid-mode-sentinel"
expect_rejected "invalid execution mode is rejected" "$invalid_execution_mode" 'line 1: $.context.execution_mode: must be one of'

valid_requires="$TEST_ROOT/manifests/valid-requires.jsonl"
valid_case "PLATFORM-PREDICATE" | sed 's/"requires":{"toolchains":\["node"\]}/"requires":{"platform":"linux","toolchains":["node"],"capabilities":["procfs"]}/' > "$valid_requires"
valid_requires_output=$(run_recorded_campaign "$CONTROLLER" --manifest "$valid_requires") || fail "schema rejected supported requires predicates: $valid_requires_output"
remember_campaign "$valid_requires_output" > /dev/null
pass "platform, toolchain, and capability predicates validate"

predicate_eligible="$TEST_ROOT/manifests/predicate-eligible.jsonl"
valid_case "PREDICATE-ELIGIBLE" | sed 's/"requires":{"toolchains":\["node"\]}/"requires":{"platform":["linux","darwin"],"toolchains":["node"],"capabilities":["procfs","node-sqlite"],"containment":["systemd-user-scope","procfs"],"node_min":22}/' > "$predicate_eligible"
eligible_output=$(run_recorded_campaign "$CONTROLLER" --manifest "$predicate_eligible") || fail "satisfied predicates failed: $eligible_output"
eligible_id=$(remember_campaign "$eligible_output")
node --input-type=module - "$TT_DIR/var/results/$eligible_id/state.json" <<'NODE'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const item = state.cases[0];
if (item.reason?.category === 'predicate'
    || !((item.phase === 'pending' && item.outcome === undefined)
      || (item.phase === 'terminal' && item.outcome === 'NOT_RUN' && item.reason?.category === 'daemon-control-unavailable'))) {
  throw new Error(`satisfied predicates did not pass predicate evaluation: ${JSON.stringify(item)}`);
}
NODE
pass "satisfied platform, toolchain, containment, runtime, and capability predicates pass evaluation"

predicate_excluded="$TEST_ROOT/manifests/predicate-excluded.jsonl"
predicate_sentinel="$TEST_ROOT/predicate-hook-ran"
valid_case "PREDICATE-EXCLUDED" \
  | sed 's/"requires":{"toolchains":\["node"\]}/"requires":{"platform":"darwin","toolchains":["node","python3"],"capabilities":["unknown-capability"],"containment":["systemd-user-scope"],"node_min":30}/' \
  | sed "s#\"class\":\"verification\"#\"reset\":{\"executable\":\"node\",\"args\":[\"-e\",\"require('node:fs').writeFileSync('$predicate_sentinel','reset')\"],\"cwd\":\".\"},\"command\":{\"executable\":\"node\",\"args\":[\"-e\",\"require('node:fs').writeFileSync('$predicate_sentinel','command')\"],\"cwd\":\".\"},\"class\":\"verification\"#" \
  > "$predicate_excluded"
excluded_output=$(run_recorded_campaign "$CONTROLLER" --manifest "$predicate_excluded") || fail "predicate exclusion failed: $excluded_output"
excluded_id=$(remember_campaign "$excluded_output")
node --input-type=module - "$TT_DIR/var/results/$excluded_id/state.json" <<'NODE'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const item = state.cases[0];
if (item.phase !== 'terminal' || item.outcome !== 'NOT_RUN') {
  throw new Error(`excluded case is not terminal NOT_RUN: ${JSON.stringify(item)}`);
}
if (item.reason?.category !== 'predicate' || !Array.isArray(item.reason.evidence)) {
  throw new Error(`predicate reason/evidence missing: ${JSON.stringify(item.reason)}`);
}
const evidence = new Map(item.reason.evidence.map(entry => [entry.predicate, entry]));
for (const [predicate, expected, observed] of [
  ['platform', 'darwin', 'linux'],
  ['toolchains.python3', true, null],
  ['node_min', 30, 24],
  ['capabilities.unknown-capability', true, null],
]) {
  const entry = evidence.get(predicate);
  if (!entry || JSON.stringify(entry.expected) !== JSON.stringify(expected)
      || JSON.stringify(entry.observed) !== JSON.stringify(observed)) {
    throw new Error(`wrong ${predicate} evidence: ${JSON.stringify(entry)}`);
  }
}
// FIX10 US-005: the terminal hygiene-canary verify runs AFTER terminalization
// and refreshes state.updated_at, so durability means updated_at is never
// EARLIER than the terminal timestamp (not byte-equal to it).
if (new Date(state.updated_at) < new Date(item.terminal_at)
    || new Date(item.terminal_at).toISOString() !== item.terminal_at) {
  throw new Error(`terminal timestamp was not durably reflected: ${JSON.stringify(item)}`);
}
NODE
[ ! -e "$predicate_sentinel" ] || fail "predicate-excluded case executed a hook"
pass "failed and unavailable predicates persist terminal NOT_RUN evidence without executing hooks"

# ── US-002: canonical boolean-leaf predicate contract ───────────────────
# A toolchain predicate is satisfied iff the profile records
# toolchains.<name>.present === true. buildPassed/testPassed are NOT
# required for satisfaction (W0.0's --fast probes leave them null).
boolean_leaf_profile="$TEST_ROOT/manifests/boolean-leaf-host-profile.json"
cat > "$HOST_PROFILE" <<'JSON'
{
  "platform": {"os": "linux", "label": "linux"},
  "containment": {"systemdUserScope": true, "procfs": true},
  "toolchains": {
    "node": {"present": true, "buildPassed": null, "testPassed": null},
    "python3": {"present": true, "buildPassed": null, "testPassed": null}
  },
  "nodeRuntimes": [
    {"version": "v24.0.0", "major": 24, "sqliteAvailable": true}
  ]
}
JSON

bool_leaf="$TEST_ROOT/manifests/boolean-leaf-eligible.jsonl"
valid_case "BOOL-LEAF-ELIGIBLE" \
  | sed 's/"requires":{"toolchains":\["node"\]}/"requires":{"toolchains":["node","python3"]}/' \
  > "$bool_leaf"
bool_leaf_output=$(run_recorded_campaign "$CONTROLLER" --manifest "$bool_leaf") || fail "present-only toolchain predicate failed: $bool_leaf_output"
bool_leaf_id=$(remember_campaign "$bool_leaf_output")
node --input-type=module - "$TT_DIR/var/results/$bool_leaf_id/state.json" <<'NODE'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const item = state.cases[0];
if (item.reason?.category === 'predicate') {
  throw new Error(`present-only toolchain with null build/test was spuriously blocked: ${JSON.stringify(item.reason)}`);
}
NODE
pass "toolchain predicate satisfied on present=true alone (buildPassed/testPassed null)"

# A toolchain recorded present=false is honestly absent -> NOT_RUN(predicate).
cat > "$HOST_PROFILE" <<'JSON'
{
  "platform": {"os": "linux", "label": "linux"},
  "containment": {"systemdUserScope": true, "procfs": true},
  "toolchains": {
    "node": {"present": false, "buildPassed": false, "testPassed": false}
  },
  "nodeRuntimes": [
    {"version": "v24.0.0", "major": 24, "sqliteAvailable": true}
  ]
}
JSON
bool_leaf_absent="$TEST_ROOT/manifests/boolean-leaf-absent.jsonl"
valid_case "BOOL-LEAF-ABSENT" > "$bool_leaf_absent"
bool_leaf_absent_output=$(run_recorded_campaign "$CONTROLLER" --manifest "$bool_leaf_absent") || fail "absent toolchain predicate failed: $bool_leaf_absent_output"
bool_leaf_absent_id=$(remember_campaign "$bool_leaf_absent_output")
node --input-type=module - "$TT_DIR/var/results/$bool_leaf_absent_id/state.json" <<'NODE'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const item = state.cases[0];
if (item.phase !== 'terminal' || item.outcome !== 'NOT_RUN' || item.reason?.category !== 'predicate') {
  throw new Error(`absent toolchain case is not terminal NOT_RUN(predicate): ${JSON.stringify(item)}`);
}
const evidence = new Map(item.reason.evidence.map(entry => [entry.predicate, entry]));
const entry = evidence.get('toolchains.node');
if (!entry || entry.expected !== true
    || !(entry.observed && entry.observed.present === false)) {
  throw new Error(`wrong absent toolchain evidence: ${JSON.stringify(entry)}`);
}
NODE
pass "present=false toolchain gates NOT_RUN(predicate) with expected/observed evidence"

# ── US-002: pi/hermes capabilities resolve against harness presence ─────
# requires.capabilities hermes/pi must resolve against harness.<name>.present
# (canonical contract), so an honestly-present harness is not blocked and an
# honestly-absent one still gates NOT_RUN(predicate) with evidence.
cat > "$HOST_PROFILE" <<'JSON'
{
  "platform": {"os": "linux", "label": "linux"},
  "containment": {"systemdUserScope": true, "procfs": true},
  "toolchains": {
    "node": {"present": true, "buildPassed": true, "testPassed": true}
  },
  "nodeRuntimes": [
    {"version": "v24.0.0", "major": 24, "sqliteAvailable": true}
  ],
  "harness": {
    "pi": {"present": true, "authenticated": null, "skipReason": "requires --spend"},
    "hermes": {"present": true, "authenticated": null, "skipReason": "requires --spend"}
  }
}
JSON
hermes_present_eligible="$TEST_ROOT/manifests/harness-hermes-present-eligible.jsonl"
valid_case "HERMES-PRESENT-ELIGIBLE" \
  | sed 's/"requires":{"toolchains":\["node"\]}/"requires":{"toolchains":["node"],"capabilities":["hermes"]}/' \
  > "$hermes_present_eligible"
hermes_present_out=$(run_recorded_campaign "$CONTROLLER" --manifest "$hermes_present_eligible") || fail "present hermes capability failed: $hermes_present_out"
hermes_present_id=$(remember_campaign "$hermes_present_out")
node --input-type=module - "$TT_DIR/var/results/$hermes_present_id/state.json" <<'NODE'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const item = state.cases[0];
if (item.reason?.category === 'predicate'
    && item.reason?.evidence?.some(e => e.predicate === 'capabilities.hermes')) {
  throw new Error(`honestly-present hermes capability was spuriously blocked: ${JSON.stringify(item.reason)}`);
}
NODE
pass "hermes capability satisfied on harness.hermes.present===true (authenticated null)"

# Honestly-absent harness (present=false) must still gate NOT_RUN(predicate).
cat > "$HOST_PROFILE" <<'JSON'
{
  "platform": {"os": "linux", "label": "linux"},
  "containment": {"systemdUserScope": true, "procfs": true},
  "toolchains": {
    "node": {"present": true, "buildPassed": true, "testPassed": true}
  },
  "nodeRuntimes": [
    {"version": "v24.0.0", "major": 24, "sqliteAvailable": true}
  ],
  "harness": {
    "hermes": {"present": false, "authenticated": false, "error": "hermes binary not found on PATH"}
  }
}
JSON
hermes_present_absent="$TEST_ROOT/manifests/harness-hermes-present-absent.jsonl"
valid_case "HERMES-PRESENT-ABSENT" \
  | sed 's/"requires":{"toolchains":\["node"\]}/"requires":{"toolchains":["node"],"capabilities":["hermes"]}/' \
  > "$hermes_present_absent"
hermes_present_absent_out=$(run_recorded_campaign "$CONTROLLER" --manifest "$hermes_present_absent") || fail "absent-present hermes capability failed: $hermes_present_absent_out"
hermes_present_absent_id=$(remember_campaign "$hermes_present_absent_out")
node --input-type=module - "$TT_DIR/var/results/$hermes_present_absent_id/state.json" <<'NODE'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const item = state.cases[0];
if (item.phase !== 'terminal' || item.outcome !== 'NOT_RUN' || item.reason?.category !== 'predicate') {
  throw new Error(`absent hermes case is not terminal NOT_RUN(predicate): ${JSON.stringify(item)}`);
}
const evidence = new Map(item.reason.evidence.map(entry => [entry.predicate, entry]));
const entry = evidence.get('capabilities.hermes');
if (!entry || entry.expected !== true || entry.observed !== false) {
  throw new Error(`wrong absent hermes evidence: ${JSON.stringify(entry)}`);
}
NODE
pass "honestly-absent hermes (present=false) gates NOT_RUN(predicate) with evidence"

write_satisfying_host_profile

# ── MACP3 US-006: fail-closed predicate semantics ─────────────────────
# An absent/failed host profile while a SELECTED case carries `requires`
# must NOT abort the run and must NOT silently evaluate every predicate to
# false (NOT_RUN(predicate) skips; with all cells skipped a bare campaign
# would report vacuous GREEN). Instead the campaign is still created, every
# predicate-bound selected case is terminal TEST_INFRA_FAIL
# (host-profile-missing) with the underlying load error in reason.message,
# and verdictExitCode forces RED/INFRA (exit 2).
#
# The manifest carries a LOCAL case whose `requires.toolchains: ["node"]`
# is satisfied by write_satisfying_host_profile — proving (in the positive
# arm, after the profile is restored) that this same cell EXECUTES when the
# profile is present (never host-profile-missing), i.e. fail-closed fires
# ONLY on an actually unusable profile, never on a satisfied predicate.
us006_local_manifest="$TEST_ROOT/manifests/us006-local-requires.jsonl"
: > "$us006_local_manifest"
write_local_requires_case "$us006_local_manifest" "US006-REQ" '{"toolchains":["node"]}'

rm -f -- "$HOST_PROFILE"
run_fail_closed_profile_campaign "ac1: missing host profile => TEST_INFRA_FAIL(host-profile-missing), exit 2" "$us006_local_manifest"
# (profile still missing; second run confirms repeatable fail-closed exit 2)
run_fail_closed_profile_campaign "ac1: missing host profile (2nd run) => TEST_INFRA_FAIL(host-profile-missing), exit 2" "$us006_local_manifest"
printf '%s\n' '{not-json}' > "$HOST_PROFILE"
run_fail_closed_profile_campaign "ac1: malformed host profile => TEST_INFRA_FAIL(host-profile-missing), exit 2" "$us006_local_manifest"
write_satisfying_host_profile

# AC2/AC3 preservation arm: the SAME local case with a VALID profile and a
# satisfied predicate must EXECUTE (PASS -> GREEN exit 0), and the report must
# NOT contain any host-profile-missing finding.
us006_valid_output=$("$CONTROLLER" --manifest "$us006_local_manifest" 2>&1)
run_status=$?
[ "$run_status" -eq 0 ] || fail "valid-profile satisfied-predicate case should execute green: $us006_valid_output"
us006_valid_id=$(remember_campaign "$us006_valid_output")
grep -Fq 'PASS' "$TT_DIR/var/results/$us006_valid_id/report.txt" || fail "satisfied local case did not execute (PASS): $us006_valid_output"
if grep -Fq 'host-profile-missing' "$TT_DIR/var/results/$us006_valid_id/report.txt"; then
  fail "valid host profile spuriously produced host-profile-missing findings"
fi
pass "valid host profile with a satisfied predicate executes the case (no host-profile-missing)"

# A genuine unsatisfied predicate under a VALID profile stays NOT_RUN
# (predicate) — legitimate skip semantics, never host-profile-missing.
us006_unsat_manifest="$TEST_ROOT/manifests/us006-unsat.jsonl"
write_local_predicate_case "$us006_unsat_manifest" "US006-UNSAT"
us006_unsat_output=$("$CONTROLLER" --manifest "$us006_unsat_manifest" 2>&1) || true
us006_unsat_id=$(remember_campaign "$us006_unsat_output")
node --input-type=module - "$TT_DIR/var/results/$us006_unsat_id/state.json" <<'NODE' || fail "genuine predicate skip was not preserved"
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const item = state.cases[0];
if (item.outcome !== 'NOT_RUN' || item.reason?.category !== 'predicate') {
  throw new Error(`genuine unsatisfied predicate must stay NOT_RUN(predicate): ${JSON.stringify(item)}`);
}
NODE
pass "valid profile: genuinely unsatisfied predicate stays NOT_RUN(predicate)"

# AC3: with NO case requiring the host profile (requires: {} everywhere), a
# MISSING host profile is irrelevant — campaign behavior is unchanged (green).
: > "$us006_local_manifest"
write_local_requires_case "$us006_local_manifest" "US006-NOREQ" '{}'
rm -f -- "$HOST_PROFILE"
us006_noneed_output=$("$CONTROLLER" --manifest "$us006_local_manifest" 2>&1)
us006_noneed_status=$?
[ "$us006_noneed_status" -eq 0 ] || fail "no case requires the host profile: campaign must be unchanged despite missing profile: $us006_noneed_output"
us006_noneed_id=$(remember_campaign "$us006_noneed_output")
grep -Fq 'GREEN (exit 0)' "$TT_DIR/var/results/$us006_noneed_id/report.txt" || fail "no-requires campaign with missing profile must stay GREEN"
write_satisfying_host_profile
pass "no case requires the host profile => campaign behavior unchanged (missing profile irrelevant)"

# ── MACP3 US-007: fail-closed predicate regression scenarios ────────
# Regression proofs that the US-006 fail-closed semantics are enforced. The
# analogous unit boundary lives in tt-report.test.mjs (pre-fix NOT_RUN
# (predicate) encoding => vacuous GREEN exit 0; fail-closed encoding => INFRA
# exit 2). Every scenario below asserts the post-fix contract directly, so it
# would FAIL under the pre-fix encoding: Scenario B asserts GREEN where
# pre-fix was already GREEN but for the wrong (vacuous) reason, and the scope
# scenario asserts INFRA exit 2 + host-profile-missing where pre-fix would
# have reported GREEN exit 0 with all predicate cells NOT_RUN-skipped.
write_satisfying_host_profile

# US-007 Scenario B (complete): VALID host profile + MIXED selection — one
# cell with an unsatisfiable requires (legit predicate skip on linux) and one
# cell whose predicates are satisfied and must EXECUTE (PASS). The legit skip
# is preserved as NOT_RUN(predicate), never host-profile-missing, and the
# combined selection stays GREEN exit 0 (the executing cell proves the
# verdict is not vacuous). This is the "combined with an otherwise green
# selection, verdict stays GREEN" acceptance criterion.
us007_mixed_manifest="$TEST_ROOT/manifests/us007-mixed-skip-run.jsonl"
: > "$us007_mixed_manifest"
write_local_requires_case "$us007_mixed_manifest" "US007-SKIP" '{"platform":"darwin"}'
write_local_requires_case "$us007_mixed_manifest" "US007-RUN" '{"toolchains":["node"]}'
us007_mixed_output=$("$CONTROLLER" --manifest "$us007_mixed_manifest" 2>&1)
us007_mixed_status=$?
[ "$us007_mixed_status" -eq 0 ] || fail "US-007 scenario B (valid profile, mixed skip+run) must stay GREEN exit 0: $us007_mixed_output"
us007_mixed_id=$(remember_campaign "$us007_mixed_output")
node --input-type=module - "$TT_DIR/var/results/$us007_mixed_id/state.json" <<'NODE' || fail "US-007 scenario B state contract violated"
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const byId = new Map(state.cases.map((item) => [item.id, item]));
const skip = byId.get('US007-SKIP');
if (!skip || skip.outcome !== 'NOT_RUN' || skip.reason?.category !== 'predicate') {
  throw new Error(`legit predicate skip not preserved as NOT_RUN(predicate): ${JSON.stringify(skip)}`);
}
const run = byId.get('US007-RUN');
if (!run || run.outcome !== 'PASS') {
  throw new Error(`predicate-satisfied cell did not execute PASS: ${JSON.stringify(run)}`);
}
if (state.cases.some((item) => item.reason?.category === 'host-profile-missing')) {
  throw new Error(`valid profile produced host-profile-missing findings: ${JSON.stringify(state.cases.map((i) => i.reason))}`);
}
NODE
grep -Fq 'GREEN (exit 0)' "$TT_DIR/var/results/$us007_mixed_id/report.txt" || fail "US-007 scenario B report must be GREEN (exit 0)"
grep -Fq 'NOT_RUN' "$TT_DIR/var/results/$us007_mixed_id/report.txt" || fail "US-007 scenario B report must list the legit predicate skip"
pass "US-007 scenario B: valid profile + unsatisfied requires stays NOT_RUN(predicate), combined selection stays GREEN"

# US-007 Scenario A/complement (fail-closed SCOPING): MISSING host profile +
# MIXED selection — one cell with `requires` and one cell with none. The
# require-carrying cell must be terminal TEST_INFRA_FAIL(host-profile-missing)
# => INFRA exit 2 (never NOT_RUN(predicate), never GREEN — pre-fix behavior),
# while the no-requires cell is UNAFFECTED and still executes PASS. This
# proves fail-closed fires precisely on predicate-bound cells and does not
# over-block non-requiring cells, while the campaign still reports the finding.
us007_scope_manifest="$TEST_ROOT/manifests/us007-missing-scope.jsonl"
: > "$us007_scope_manifest"
write_local_requires_case "$us007_scope_manifest" "US007-REQ" '{"toolchains":["node"]}'
write_local_requires_case "$us007_scope_manifest" "US007-PLAIN" '{}'
rm -f -- "$HOST_PROFILE"
set +e
us007_scope_output=$("$CONTROLLER" --manifest "$us007_scope_manifest" 2>&1)
us007_scope_status=$?
set -e
[ "$us007_scope_status" -eq 2 ] || fail "US-007 scenario A (missing profile, mixed) must exit 2 INFRA: $us007_scope_output"
us007_scope_id=$(remember_campaign "$us007_scope_output")
node --input-type=module - "$TT_DIR/var/results/$us007_scope_id/state.json" <<'NODE' || fail "US-007 scenario A state contract violated"
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const byId = new Map(state.cases.map((item) => [item.id, item]));
const req = byId.get('US007-REQ');
if (!req || req.outcome !== 'TEST_INFRA_FAIL' || req.reason?.category !== 'host-profile-missing') {
  throw new Error(`require-carrying cell is not TEST_INFRA_FAIL(host-profile-missing): ${JSON.stringify(req)}`);
}
if (req.outcome === 'NOT_RUN' && req.reason?.category === 'predicate') {
  throw new Error(`pre-fix NOT_RUN(predicate) encoding resurfaced: ${JSON.stringify(req.reason)}`);
}
if (typeof req.reason?.message !== 'string' || !/cannot load required host profile/.test(req.reason.message)) {
  throw new Error(`host-profile-missing reason must carry the underlying load error: ${JSON.stringify(req.reason)}`);
}
const plain = byId.get('US007-PLAIN');
if (!plain || plain.outcome !== 'PASS') {
  throw new Error(`no-requires cell must be unaffected by the missing profile and execute PASS: ${JSON.stringify(plain)}`);
}
NODE
grep -Fq 'INFRA FAILURES' "$TT_DIR/var/results/$us007_scope_id/report.txt" || fail "US-007 scenario A report must surface INFRA FAILURES"
grep -Fq 'INFRA_FAILURE (exit 2)' "$TT_DIR/var/results/$us007_scope_id/report.txt" || fail "US-007 scenario A report must carry INFRA_FAILURE (exit 2)"
write_satisfying_host_profile
pass "US-007 scenario A/complement: missing profile fail-closes only require-carrying cells (INFRA exit 2), no-requires cell unaffected"

# ── MACP3 US-008: bare-campaign vacuity guard ─────────────────────────────
# A bare (--scripted-only) campaign whose every scripted cell is skipped by
# an HONEST predicate (valid loaded host profile, unsatisfiable requires) with
# ZERO executions produces zero evidence. Post-US-008 that must be
# RED/FINDINGS (exit 1) with a machine-parseable vacuous-campaign finding,
# never GREEN — the vacuous-GREEN class that hid the a446deac Darwin defect
# through the predicate path. These scenarios run the controller in true bare
# mode (--scripted-only => execution_selection 'scripted-only') so the guard
# is exercised over the exact state shape it is wired for. Every scenario
# would FAIL under the pre-US-008 verdict logic, which rendered GREEN exit 0
# for an all-skipped bare campaign.
write_satisfying_host_profile

# US-008 red (real likelihood on linux): a manifest whose only scripted cells
# carry requires.{platform:darwin} is legitimately unsatisfiable here, so the
# cells are honest NOT_RUN(predicate) under a LOADED profile. Zero cells
# execute -> the campaign must FAIL closed with exit 1 and a vacuous-campaign
# finding, and the report must never render GREEN.
us008_all_skip_manifest="$TEST_ROOT/manifests/us008-all-skip.jsonl"
: > "$us008_all_skip_manifest"
write_local_requires_case "$us008_all_skip_manifest" "US008-SKIP-A" '{"platform":"darwin"}'
write_local_requires_case "$us008_all_skip_manifest" "US008-SKIP-B" '{"platform":"darwin"}'
set +e
us008_all_skip_output=$("$CONTROLLER" --manifest "$us008_all_skip_manifest" --scripted-only 2>&1)
us008_all_skip_status=$?
set -e
[ "$us008_all_skip_status" -eq 1 ] || fail "US-008 AC1: all-scripted-skipped bare campaign must exit 1 (FINDINGS): $us008_all_skip_output"
us008_all_skip_id=$(remember_campaign "$us008_all_skip_output")
node --input-type=module - "$TT_DIR/var/results/$us008_all_skip_id/state.json" "$TT_DIR/var/results/$us008_all_skip_id/report.json" <<'NODE' || fail "US-008 AC1 state/report contract violated"
import fs from 'node:fs';
const [statePath, reportPath] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
if ((state.options.execution_selection ?? '') !== 'scripted-only') {
  throw new Error(`expected scripted-only execution selection: ${JSON.stringify(state.options.execution_selection)}`);
}
for (const item of state.cases) {
  if (item.outcome !== 'NOT_RUN' || item.reason?.category !== 'predicate') {
    throw new Error(`all cells must be honest NOT_RUN(predicate) skips: ${JSON.stringify({id:item.id,outcome:item.outcome,reason:item.reason})}`);
  }
  if (item.attempts.length !== 0) throw new Error(`zero executions expected: ${JSON.stringify({id:item.id,attempts:item.attempts})}`);
}
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
if (report.verdict !== 'FINDINGS' || report.exit_code !== 1) {
  throw new Error(`report must be FINDINGS (exit 1): ${JSON.stringify({verdict:report.verdict,exit_code:report.exit_code})}`);
}
if (report.vacuity?.triggered !== true) throw new Error('vacuity guard must be the operative signal');
const vic = report.findings.find((f) => f.category === 'vacuous-campaign');
if (!vic) throw new Error('findings must contain a machine-parseable vacuous-campaign finding');
if (typeof vic.summary !== 'string' || !/executed zero scripted cells/.test(vic.summary)) {
  throw new Error(`vacuous-campaign summary must name the cause: ${JSON.stringify(vic)}`);
}
NODE
grep -Fq 'VACUOUS_CAMPAIGN' "$TT_DIR/var/results/$us008_all_skip_id/report.txt" \
  || fail "US-008 AC1 report.txt must list the vacuous-campaign finding"
grep -Fq 'FINDINGS (exit 1)' "$TT_DIR/var/results/$us008_all_skip_id/report.txt" \
  || fail "US-008 AC1 report.txt must carry FINDINGS (exit 1)"
if grep -Fq 'GREEN (exit 0)' "$TT_DIR/var/results/$us008_all_skip_id/report.txt"; then
  fail "US-008 AC1 all-skipped bare campaign must not render GREEN"
fi
pass "US-008 AC1: all-scripted-skipped bare campaign exits 1 with a vacuous-campaign finding (never GREEN)"

# US-008 green arm: at least one cell EXECUTES (satisfied requires -> PASS)
# alongside a legit predicate skip. The campaign stays GREEN exit 0 and the
# vacuity guard is silent — the combined-selection bound (US-007 Scenario B
# semantics) is preserved under the vacuity guard.
us008_mixed_manifest="$TEST_ROOT/manifests/us008-mixed.jsonl"
: > "$us008_mixed_manifest"
write_local_requires_case "$us008_mixed_manifest" "US008-RUN" '{"toolchains":["node"]}'
write_local_requires_case "$us008_mixed_manifest" "US008-SKIP" '{"platform":"darwin"}'
set +e
us008_mixed_output=$("$CONTROLLER" --manifest "$us008_mixed_manifest" --scripted-only 2>&1)
us008_mixed_status=$?
set -e
[ "$us008_mixed_status" -eq 0 ] || fail "US-008 AC2: bare campaign with an executing cell must stay GREEN exit 0: $us008_mixed_output"
us008_mixed_id=$(remember_campaign "$us008_mixed_output")
node --input-type=module - "$TT_DIR/var/results/$us008_mixed_id/report.json" <<'NODE' || fail "US-008 AC2 report contract violated"
import fs from 'node:fs';
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (report.verdict !== 'GREEN' || report.exit_code !== 0) {
  throw new Error(`expected GREEN exit 0: ${JSON.stringify({verdict:report.verdict,exit_code:report.exit_code})}`);
}
if (report.vacuity?.triggered === true) throw new Error('vacuity guard must be silent with >=1 executed cell');
if (report.findings.some((f) => f.category === 'vacuous-campaign')) {
  throw new Error('no vacuous-campaign finding expected when a cell executed');
}
NODE
grep -Fq 'GREEN (exit 0)' "$TT_DIR/var/results/$us008_mixed_id/report.txt" \
  || fail "US-008 AC2 report must be GREEN (exit 0)"
pass "US-008 AC2: bare campaign with >=1 executed scripted cell stays GREEN exit 0 (no vacuous finding)"

# US-008 infra precedence: a missing host profile fail-closes require-bound
# cells to TEST_INFRA_FAIL (US-006) => exit 2 INFRA. The infra RED explains
# the failure precisely; the vacuity guard must NOT add a vacuous-campaign
# finding or downgrade to a vacuity FINDINGS.
us008_precedence_manifest="$TEST_ROOT/manifests/us008-precedence.jsonl"
: > "$us008_precedence_manifest"
write_local_requires_case "$us008_precedence_manifest" "US008-REQ" '{"toolchains":["node"]}'
rm -f -- "$HOST_PROFILE"
set +e
us008_precedence_output=$("$CONTROLLER" --manifest "$us008_precedence_manifest" --scripted-only 2>&1)
us008_precedence_status=$?
set -e
[ "$us008_precedence_status" -eq 2 ] || fail "US-008 precedence: missing-profile bare campaign must exit 2 INFRA: $us008_precedence_output"
us008_precedence_id=$(remember_campaign "$us008_precedence_output")
node --input-type=module - "$TT_DIR/var/results/$us008_precedence_id/report.json" <<'NODE' || fail "US-008 precedence report contract violated"
import fs from 'node:fs';
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (report.verdict !== 'INFRA_FAILURE' || report.exit_code !== 2) {
  throw new Error(`infra must take precedence: ${JSON.stringify({verdict:report.verdict,exit_code:report.exit_code})}`);
}
if (report.vacuity?.triggered === true) {
  throw new Error('infra-driven campaign must not be flagged as the vacuity signal');
}
if (report.findings.some((f) => f.category === 'vacuous-campaign')) {
  throw new Error('infra-driven campaign must not carry a vacuous-campaign finding');
}
if (!Array.isArray(report.infra_failures) || report.infra_failures.length !== 1) {
  throw new Error(`expected 1 infra failure: ${JSON.stringify(report.infra_failures)}`);
}
NODE
grep -Fq 'INFRA_FAILURE (exit 2)' "$TT_DIR/var/results/$us008_precedence_id/report.txt" \
  || fail "US-008 precedence report must carry INFRA_FAILURE (exit 2)"
write_satisfying_host_profile
pass "US-008 precedence: infra failure masks the vacuity finding (INFRA exit 2, no vacuous-campaign)"

empty_requires="$TEST_ROOT/manifests/empty-requires.jsonl"
valid_case "PROFILE-NOT-REQUIRED" | sed 's/"requires":{"toolchains":\["node"\]}/"requires":{}/' > "$empty_requires"
empty_output=$(run_recorded_campaign "$CONTROLLER" --manifest "$empty_requires") || fail "empty requirements unexpectedly needed host profile: $empty_output"
remember_campaign "$empty_output" > /dev/null
pass "empty requires does not require host-profile.json"
write_satisfying_host_profile

# --- Harness capability predicate resolution (hermes/pi) ---

# Set up host profile with harness section for hermes (authenticated) + pi (authenticated)
harness_profile="$TEST_ROOT/manifests/harness-host-profile.json"
cat > "$HOST_PROFILE" <<'JSON'
{
  "platform": {"os": "linux", "label": "linux"},
  "containment": {"systemdUserScope": true, "procfs": true},
  "toolchains": {
    "node": {"present": true, "buildPassed": true, "testPassed": true}
  },
  "nodeRuntimes": [
    {"version": "v24.0.0", "major": 24, "sqliteAvailable": true}
  ],
  "harness": {
    "pi": {"authenticated": true},
    "hermes": {"authenticated": true}
  }
}
JSON

# Test: hermes capability satisfied when harness.hermes.authenticated is true
hermes_eligible="$TEST_ROOT/manifests/harness-hermes-eligible.jsonl"
valid_case "HERMES-ELIGIBLE" \
  | sed 's/"requires":{"toolchains":\["node"\]}/"requires":{"toolchains":["node"],"capabilities":["hermes"]}/' \
  > "$hermes_eligible"
hermes_eligible_output=$(run_recorded_campaign "$CONTROLLER" --manifest "$hermes_eligible") || fail "hermes eligible predicate failed: $hermes_eligible_output"
hermes_eligible_id=$(remember_campaign "$hermes_eligible_output")
node --input-type=module - "$TT_DIR/var/results/$hermes_eligible_id/state.json" <<'NODE'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const item = state.cases[0];
if (item.reason?.category === 'predicate' && item.reason?.evidence?.some(e => e.predicate === 'capabilities.hermes')) {
  throw new Error(`hermes capability was not satisfied: ${JSON.stringify(item.reason)}`);
}
NODE
pass "hermes capability satisfied when harness.hermes.authenticated is true"

# Test: hermes capability fails when harness.hermes.authenticated is false
cat > "$HOST_PROFILE" <<'JSON'
{
  "platform": {"os": "linux", "label": "linux"},
  "containment": {"systemdUserScope": true, "procfs": true},
  "toolchains": {
    "node": {"present": true, "buildPassed": true, "testPassed": true}
  },
  "nodeRuntimes": [
    {"version": "v24.0.0", "major": 24, "sqliteAvailable": true}
  ],
  "harness": {
    "pi": {"authenticated": true},
    "hermes": {"authenticated": false}
  }
}
JSON
hermes_excluded="$TEST_ROOT/manifests/harness-hermes-excluded.jsonl"
valid_case "HERMES-EXCLUDED" \
  | sed 's/"requires":{"toolchains":\["node"\]}/"requires":{"toolchains":["node"],"capabilities":["hermes"]}/' \
  > "$hermes_excluded"
hermes_excluded_output=$(run_recorded_campaign "$CONTROLLER" --manifest "$hermes_excluded") || fail "hermes excluded predicate failed: $hermes_excluded_output"
hermes_excluded_id=$(remember_campaign "$hermes_excluded_output")
node --input-type=module - "$TT_DIR/var/results/$hermes_excluded_id/state.json" <<'NODE'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const item = state.cases[0];
if (item.phase !== 'terminal' || item.outcome !== 'NOT_RUN' || item.reason?.category !== 'predicate') {
  throw new Error(`hermes excluded case is not terminal NOT_RUN: ${JSON.stringify(item)}`);
}
const evidence = new Map(item.reason.evidence.map(entry => [entry.predicate, entry]));
const entry = evidence.get('capabilities.hermes');
if (!entry || entry.expected !== true || entry.observed !== false) {
  throw new Error(`wrong hermes predicate evidence: ${JSON.stringify(entry)}`);
}
NODE
pass "hermes capability fails when harness.hermes.authenticated is false"

# Test: hermes capability fails when harness.hermes section is absent
cat > "$HOST_PROFILE" <<'JSON'
{
  "platform": {"os": "linux", "label": "linux"},
  "containment": {"systemdUserScope": true, "procfs": true},
  "toolchains": {
    "node": {"present": true, "buildPassed": true, "testPassed": true}
  },
  "nodeRuntimes": [
    {"version": "v24.0.0", "major": 24, "sqliteAvailable": true}
  ],
  "harness": {
    "pi": {"authenticated": true}
  }
}
JSON
hermes_absent="$TEST_ROOT/manifests/harness-hermes-absent.jsonl"
valid_case "HERMES-ABSENT" \
  | sed 's/"requires":{"toolchains":\["node"\]}/"requires":{"toolchains":["node"],"capabilities":["hermes"]}/' \
  > "$hermes_absent"
hermes_absent_output=$(run_recorded_campaign "$CONTROLLER" --manifest "$hermes_absent") || fail "hermes absent predicate failed: $hermes_absent_output"
hermes_absent_id=$(remember_campaign "$hermes_absent_output")
node --input-type=module - "$TT_DIR/var/results/$hermes_absent_id/state.json" <<'NODE'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const item = state.cases[0];
if (item.phase !== 'terminal' || item.outcome !== 'NOT_RUN' || item.reason?.category !== 'predicate') {
  throw new Error(`hermes absent case is not terminal NOT_RUN: ${JSON.stringify(item)}`);
}
const evidence = new Map(item.reason.evidence.map(entry => [entry.predicate, entry]));
const entry = evidence.get('capabilities.hermes');
if (!entry || entry.expected !== true || entry.observed !== null) {
  throw new Error(`wrong hermes absent evidence (expected null observed): ${JSON.stringify(entry)}`);
}
NODE
pass "hermes capability fails when harness.hermes section is absent"

# Test: hermes capability fails when harness section is entirely absent
cat > "$HOST_PROFILE" <<'JSON'
{
  "platform": {"os": "linux", "label": "linux"},
  "containment": {"systemdUserScope": true, "procfs": true},
  "toolchains": {
    "node": {"present": true, "buildPassed": true, "testPassed": true}
  },
  "nodeRuntimes": [
    {"version": "v24.0.0", "major": 24, "sqliteAvailable": true}
  ]
}
JSON
hermes_no_harness="$TEST_ROOT/manifests/harness-hermes-no-harness.jsonl"
valid_case "HERMES-NO-HARNESS" \
  | sed 's/"requires":{"toolchains":\["node"\]}/"requires":{"toolchains":["node"],"capabilities":["hermes"]}/' \
  > "$hermes_no_harness"
hermes_no_harness_output=$(run_recorded_campaign "$CONTROLLER" --manifest "$hermes_no_harness") || fail "hermes no-harness predicate failed: $hermes_no_harness_output"
hermes_no_harness_id=$(remember_campaign "$hermes_no_harness_output")
node --input-type=module - "$TT_DIR/var/results/$hermes_no_harness_id/state.json" <<'NODE'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const item = state.cases[0];
if (item.phase !== 'terminal' || item.outcome !== 'NOT_RUN' || item.reason?.category !== 'predicate') {
  throw new Error(`hermes no-harness case is not terminal NOT_RUN: ${JSON.stringify(item)}`);
}
NODE
pass "hermes capability fails when harness section is entirely absent"

# Test: pi capability satisfied when harness.pi.authenticated is true
cat > "$HOST_PROFILE" <<'JSON'
{
  "platform": {"os": "linux", "label": "linux"},
  "containment": {"systemdUserScope": true, "procfs": true},
  "toolchains": {
    "node": {"present": true, "buildPassed": true, "testPassed": true}
  },
  "nodeRuntimes": [
    {"version": "v24.0.0", "major": 24, "sqliteAvailable": true}
  ],
  "harness": {
    "pi": {"authenticated": true}
  }
}
JSON
pi_eligible="$TEST_ROOT/manifests/harness-pi-eligible.jsonl"
valid_case "PI-ELIGIBLE" \
  | sed 's/"requires":{"toolchains":\["node"\]}/"requires":{"toolchains":["node"],"capabilities":["pi"]}/' \
  > "$pi_eligible"
pi_eligible_output=$(run_recorded_campaign "$CONTROLLER" --manifest "$pi_eligible") || fail "pi eligible predicate failed: $pi_eligible_output"
pi_eligible_id=$(remember_campaign "$pi_eligible_output")
node --input-type=module - "$TT_DIR/var/results/$pi_eligible_id/state.json" <<'NODE'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const item = state.cases[0];
if (item.reason?.category === 'predicate' && item.reason?.evidence?.some(e => e.predicate === 'capabilities.pi')) {
  throw new Error(`pi capability was not satisfied: ${JSON.stringify(item.reason)}`);
}
NODE
pass "pi capability satisfied when harness.pi.authenticated is true"

# Test: pi capability fails when harness.pi.authenticated is false
cat > "$HOST_PROFILE" <<'JSON'
{
  "platform": {"os": "linux", "label": "linux"},
  "containment": {"systemdUserScope": true, "procfs": true},
  "toolchains": {
    "node": {"present": true, "buildPassed": true, "testPassed": true}
  },
  "nodeRuntimes": [
    {"version": "v24.0.0", "major": 24, "sqliteAvailable": true}
  ],
  "harness": {
    "pi": {"authenticated": false}
  }
}
JSON
pi_excluded="$TEST_ROOT/manifests/harness-pi-excluded.jsonl"
valid_case "PI-EXCLUDED" \
  | sed 's/"requires":{"toolchains":\["node"\]}/"requires":{"toolchains":["node"],"capabilities":["pi"]}/' \
  > "$pi_excluded"
pi_excluded_output=$(run_recorded_campaign "$CONTROLLER" --manifest "$pi_excluded") || fail "pi excluded predicate failed: $pi_excluded_output"
pi_excluded_id=$(remember_campaign "$pi_excluded_output")
node --input-type=module - "$TT_DIR/var/results/$pi_excluded_id/state.json" <<'NODE'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const item = state.cases[0];
if (item.phase !== 'terminal' || item.outcome !== 'NOT_RUN' || item.reason?.category !== 'predicate') {
  throw new Error(`pi excluded case is not terminal NOT_RUN: ${JSON.stringify(item)}`);
}
const evidence = new Map(item.reason.evidence.map(entry => [entry.predicate, entry]));
const entry = evidence.get('capabilities.pi');
if (!entry || entry.expected !== true || entry.observed !== false) {
  throw new Error(`wrong pi predicate evidence: ${JSON.stringify(entry)}`);
}
NODE
pass "pi capability fails when harness.pi.authenticated is false"

# Restore the vanilla satisfying host profile
write_satisfying_host_profile

duplicate="$TEST_ROOT/manifests/duplicate.jsonl"
{
  valid_case "DUPLICATE"
  valid_case "DUPLICATE"
} > "$duplicate"
expect_rejected "duplicate IDs are rejected" "$duplicate" 'line 2: duplicate id "DUPLICATE" (first declared on line 1)'

unsafe_task="$TEST_ROOT/manifests/unsafe-task.jsonl"
valid_case "UNSAFE-TASK" | sed 's#"tasks/W3.07.md"#"../outside.md"#' > "$unsafe_task"
expect_rejected "task path escape is rejected" "$unsafe_task" 'line 1: $.task: path escapes torture-test/'

unsafe_boundary="$TEST_ROOT/manifests/unsafe-boundary.jsonl"
valid_case "UNSAFE-BOUNDARY" | sed 's#"fixtures/tt-ts/src"#"/etc"#' > "$unsafe_boundary"
expect_rejected "absolute boundary path is rejected" "$unsafe_boundary" 'line 1: $.boundary_files[0]: path escapes torture-test/'

unsafe_hook="$TEST_ROOT/manifests/unsafe-hook.jsonl"
valid_case "UNSAFE-HOOK" | sed 's#"class":"verification"#"reset":{"executable":"../evil","args":[],"cwd":"."},"class":"verification"#' > "$unsafe_hook"
expect_rejected "hook executable escape is rejected" "$unsafe_hook" 'line 1: $.reset.executable: path escapes torture-test/'

nul_arg="$TEST_ROOT/manifests/nul-arg.jsonl"
write_local_case "$nul_arg" "NUL-ARG" real 0 0 "$TEST_ROOT/nul-arg-sentinel"
node --input-type=module - "$nul_arg" <<'NODE'
import fs from 'node:fs';
const manifest = process.argv[2];
const record = JSON.parse(fs.readFileSync(manifest, 'utf8'));
record.command.args.push('embedded\0nul');
fs.writeFileSync(manifest, `${JSON.stringify(record)}\n`);
NODE
expect_rejected "hook argv rejects embedded NUL before spawn" "$nul_arg" 'line 1: $.command.args'

contained_cwd="$TEST_ROOT/contained-cwd"
escaped_cwd="$(mktemp -d "${TMPDIR:-/tmp}/tt-controller-escape.XXXXXX")"
ESCAPED_CWD="$escaped_cwd"
swap_link="$TEST_ROOT/swapped-cwd"
mkdir -p "$contained_cwd"
ln -s "$contained_cwd" "$swap_link"
swap_manifest="$TEST_ROOT/manifests/swap-cwd.jsonl"
node --input-type=module - "$swap_manifest" "${swap_link#"$TT_DIR/"}" "$swap_link" "$escaped_cwd" <<'NODE'
import fs from 'node:fs';
const [manifest, commandCwd, swapLink, escapedCwd] = process.argv.slice(2);
const record = {
  id: 'SWAP-CWD', wave: 0, workflow: 'local', fixture: 'none', harness: 'local',
  task: 'tasks/W3.07.md', context: { execution_mode: 'real' },
  caps: { tokens: 0, wall_min: 5 }, requires: {}, boundary_files: [], forbidden: [],
  oracles: [], gates: [], chaos: null, shed_ok: false, mandatory: true, class: 'verification',
  reset: { executable: 'node', args: ['-e', `const fs=require('node:fs');fs.unlinkSync(${JSON.stringify(swapLink)});fs.symlinkSync(${JSON.stringify(escapedCwd)},${JSON.stringify(swapLink)})`], cwd: '.' },
  command: { executable: 'node', args: ['-e', "require('node:fs').writeFileSync('escaped-marker','escaped')"], cwd: commandCwd },
};
fs.writeFileSync(manifest, `${JSON.stringify(record)}\n`);
NODE
swap_output=$(run_recorded_campaign "$CONTROLLER" --manifest "$swap_manifest") || fail "swapped hook path should be recorded as case infrastructure evidence: $swap_output"
swap_id=$(remember_campaign "$swap_output")
node --input-type=module - "$TT_DIR/var/results/$swap_id/state.json" <<'NODE'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const item = state.cases[0];
if (item.phase !== 'terminal' || item.outcome !== 'TEST_INFRA_FAIL' || item.reason?.category !== 'local-command-launch-failed') throw new Error(`swapped cwd was not rejected at launch: ${JSON.stringify(item)}`);
NODE
[ ! -e "$escaped_cwd/escaped-marker" ] || fail "command escaped torture-test through a swapped cwd symlink"
rm -rf -- "$escaped_cwd"
ESCAPED_CWD=""
pass "hook paths are revalidated and pinned immediately before spawn"

dangling_link="$TT_DIR/var/controller-dangling-link-$$"
DANGLING_LINK="$dangling_link"
ln -s /tmp/controller-target-that-does-not-exist-$$ "$dangling_link"
unsafe_dangling="$TEST_ROOT/manifests/unsafe-dangling-symlink.jsonl"
valid_case "UNSAFE-DANGLING" | sed "s#\"tasks/W3.07.md\"#\"var/$(basename "$dangling_link")/file\"#" > "$unsafe_dangling"
expect_rejected "dangling symlink escape is rejected" "$unsafe_dangling" 'line 1: $.task: path escapes torture-test/'
rm -f -- "$dangling_link"
DANGLING_LINK=""

all_or_nothing="$TEST_ROOT/manifests/all-or-nothing.jsonl"
sentinel="$TEST_ROOT/hook-ran"
{
  valid_case "HOOK-FIRST" | sed "s#\"class\":\"verification\"#\"command\":{\"executable\":\"node\",\"args\":[\"-e\",\"require('node:fs').writeFileSync('$sentinel','bad')\"],\"cwd\":\".\"},\"class\":\"verification\"#"
  printf '%s\n' '{not-json}'
} > "$all_or_nothing"
expect_rejected "complete file is validated before hooks" "$all_or_nothing" 'line 2: invalid JSON'
[ ! -e "$sentinel" ] || fail "a hook ran before complete manifest validation"
pass "invalid later line prevents earlier hook execution"

tier0_selection_manifest="$TEST_ROOT/manifests/tier0-selection.jsonl"
tier0_scripted_sentinel="$TEST_ROOT/tier0-scripted-ran"
tier0_real_sentinel="$TEST_ROOT/tier0-real-ran"
tier0_legacy_real_sentinel="$TEST_ROOT/tier0-legacy-real-ran"
write_local_case "$tier0_selection_manifest" "TIER0-SCRIPTED" scripted 0 0 "$tier0_scripted_sentinel"
node --input-type=module - "$tier0_selection_manifest" "$tier0_scripted_sentinel" "$tier0_real_sentinel" "$tier0_legacy_real_sentinel" <<'NODE'
import fs from 'node:fs';
const [manifestPath, scriptedSentinel, realSentinel, legacyRealSentinel] = process.argv.slice(2);
const scripted = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
scripted.reset = null;
scripted.requires = { toolchains: ['node'] };
scripted.command.args = ['-e', `require('node:fs').writeFileSync(${JSON.stringify(scriptedSentinel)},'scripted')`];
const real = structuredClone(scripted);
real.id = 'TIER0-REAL';
real.context.execution_mode = 'real';
real.requires = { platform: 'darwin' };
real.command.args = ['-e', `require('node:fs').writeFileSync(${JSON.stringify(realSentinel)},'real')`];
const legacyReal = structuredClone(real);
legacyReal.id = 'TIER0-LEGACY-REAL';
legacyReal.context = {};
legacyReal.requires = {};
legacyReal.command.args = ['-e', `require('node:fs').writeFileSync(${JSON.stringify(legacyRealSentinel)},'legacy-real')`];
fs.writeFileSync(manifestPath, `${JSON.stringify(scripted)}\n${JSON.stringify(real)}\n${JSON.stringify(legacyReal)}\n`);
NODE

validate_before_count=$(find "$TT_DIR/var/results" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
validate_output=$("$CONTROLLER" --manifest "$tier0_selection_manifest" --validate-only 2>&1) \
  || fail "validate-only rejected a valid mixed manifest: $validate_output"
validate_after_count=$(find "$TT_DIR/var/results" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
[ "$validate_after_count" -eq "$validate_before_count" ] || fail "validate-only created a campaign"
[ ! -e "$tier0_scripted_sentinel" ] && [ ! -e "$tier0_real_sentinel" ] \
  && [ ! -e "$tier0_legacy_real_sentinel" ] \
  || fail "validate-only launched a case hook"
printf '%s' "$validate_output" | grep -Fq 'Validated 3 case(s)' \
  || fail "validate-only did not report every validated record: $validate_output"
pass "validate-only checks every mixed-manifest record without creating or launching a campaign"

validate_malformed="$TEST_ROOT/manifests/tier0-validate-malformed.jsonl"
{
  valid_case "VALIDATE-FIRST"
  printf '%s\n' '{not-json}'
} > "$validate_malformed"
set +e
validate_malformed_output=$("$CONTROLLER" --manifest "$validate_malformed" --validate-only 2>&1)
validate_malformed_status=$?
set -e
[ "$validate_malformed_status" -eq 2 ] \
  || fail "validate-only malformed manifest exited $validate_malformed_status instead of 2: $validate_malformed_output"
printf '%s' "$validate_malformed_output" | grep -Fq 'line 2: invalid JSON' \
  || fail "validate-only malformed error was not line-numbered: $validate_malformed_output"
pass "validate-only returns infrastructure exit 2 for malformed manifests"

set +e
tier0_selection_output=$("$CONTROLLER" --manifest "$tier0_selection_manifest" --scripted-only 2>&1)
tier0_selection_status=$?
set -e
[ "$tier0_selection_status" -eq 0 ] \
  || fail "scripted-only mixed campaign exited $tier0_selection_status: $tier0_selection_output"
tier0_selection_id=$(remember_campaign "$tier0_selection_output")
tier0_selection_dir="$TT_DIR/var/results/$tier0_selection_id"
[ -e "$tier0_scripted_sentinel" ] || fail "scripted-only campaign did not launch the scripted case"
[ ! -e "$tier0_real_sentinel" ] || fail "scripted-only campaign launched a real case"
[ ! -e "$tier0_legacy_real_sentinel" ] || fail "scripted-only campaign launched a legacy real case"
node --input-type=module - "$tier0_selection_dir/state.json" "$tier0_selection_dir/report.json" "$tier0_selection_dir/report.txt" <<'NODE'
import fs from 'node:fs';
const [statePath, reportPath, textPath] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const text = fs.readFileSync(textPath, 'utf8');
const byId = Object.fromEntries(state.cases.map(item => [item.id, item]));
if (state.options.execution_selection !== 'scripted-only') {
  throw new Error(`selection policy was not persisted: ${JSON.stringify(state.options)}`);
}
if (byId['TIER0-SCRIPTED']?.outcome !== 'PASS' || byId['TIER0-SCRIPTED'].attempts.length !== 1) {
  throw new Error(`scripted case did not execute once: ${JSON.stringify(byId['TIER0-SCRIPTED'])}`);
}
for (const id of ['TIER0-REAL', 'TIER0-LEGACY-REAL']) {
  const real = byId[id];
  if (real?.phase !== 'terminal' || real.outcome !== 'NOT_RUN'
      || real.reason?.category !== 'pending-real' || real.attempts.length !== 0) {
    throw new Error(`real case was not mechanically held pending: ${JSON.stringify(real)}`);
  }
}
if (report.verdict !== 'GREEN' || report.exit_code !== 0
    || report.pending_real?.length !== 2
    || report.pending_real.map(item => item.id).join(',') !== 'TIER0-REAL,TIER0-LEGACY-REAL'
    || report.not_run.length !== 0 || !text.includes('PENDING_REAL\n- TIER0-REAL: pending-real')) {
  throw new Error(`pending-real reporting changed the campaign verdict: ${JSON.stringify(report)}`);
}
NODE
pass "scripted-only executes scripted cases and reports real cases pending-real without changing verdict exits"

node --input-type=module - "$tier0_selection_dir/state.json" <<'NODE'
import fs from 'node:fs';
const statePath = process.argv[2];
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const real = state.cases.find(item => item.id === 'TIER0-REAL');
real.phase = 'pending';
delete real.outcome;
delete real.reason;
delete real.terminal_at;
state.updated_at = new Date().toISOString();
fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
NODE
tier0_resume_output=$(run_recorded_campaign "$CONTROLLER" --resume "$tier0_selection_id") \
  || fail "scripted-only resume failed: $tier0_resume_output"
[ ! -e "$tier0_real_sentinel" ] || fail "resume silently launched a previously pending real case"
[ ! -e "$tier0_legacy_real_sentinel" ] || fail "resume silently launched a legacy real case"
node --input-type=module - "$tier0_selection_dir/state.json" <<'NODE'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const real = state.cases.find(item => item.id === 'TIER0-REAL');
if (state.options.execution_selection !== 'scripted-only' || real?.outcome !== 'NOT_RUN'
    || real.reason?.category !== 'pending-real' || real.attempts.length !== 0) {
  throw new Error(`resume did not reapply its persisted selection policy: ${JSON.stringify({options:state.options,real})}`);
}
NODE
pass "resume reapplies the persisted scripted-only policy before scheduling"

cp "$tier0_selection_dir/state.json" "$TEST_ROOT/tier0-selection-valid-state.json"
for corruption in all-policy scripted-case real-attempt; do
  cp "$TEST_ROOT/tier0-selection-valid-state.json" "$tier0_selection_dir/state.json"
  node --input-type=module - "$tier0_selection_dir/state.json" "$corruption" <<'NODE'
import fs from 'node:fs';
const [statePath, corruption] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
if (corruption === 'all-policy') {
  state.options.execution_selection = 'all';
} else if (corruption === 'scripted-case') {
  const scripted = state.cases.find(item => item.id === 'TIER0-SCRIPTED');
  scripted.phase = 'terminal';
  scripted.outcome = 'NOT_RUN';
  scripted.reason = {category:'pending-real'};
  scripted.terminal_at = new Date().toISOString();
  scripted.attempts = [];
} else {
  const real = state.cases.find(item => item.id === 'TIER0-REAL');
  real.attempts = [{id:'forged-attempt',case_id:real.id,kind:'local',phase:'terminal',started_at:state.created_at,terminal_at:state.updated_at,outcome:'PASS'}];
}
fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
NODE
  set +e
  corruption_output=$("$CONTROLLER" --resume "$tier0_selection_id" 2>&1)
  corruption_status=$?
  set -e
  [ "$corruption_status" -eq 2 ] \
    || fail "$corruption pending-real state exited $corruption_status instead of 2: $corruption_output"
  printf '%s' "$corruption_output" | grep -Fq 'execution selection state is invalid' \
    || fail "$corruption pending-real state was not rejected clearly: $corruption_output"
done
cp "$TEST_ROOT/tier0-selection-valid-state.json" "$tier0_selection_dir/state.json"
pass "resume rejects pending-real state with the wrong policy, case mode, or attempt history"

help_output=$("$CONTROLLER" --help 2>&1) || fail "--help failed: $help_output"
for text in '--manifest <path>' '--resume <campaign-id>' '--validate-only' '--scripted-only' '--concurrency <count>' '--stagger <duration>' 'Duration examples: 250ms, 5s, 2m, 1h'; do
  printf '%s' "$help_output" | grep -Fq -- "$text" || fail "help omitted '$text': $help_output"
done
pass "help documents campaign and duration options"

expect_usage_error "unknown arguments are usage errors" --manifest "$CASES" --wat
expect_usage_error "concurrency must be an integer" --manifest "$CASES" --concurrency 1.5
expect_usage_error "concurrency must be positive" --manifest "$CASES" --concurrency 0
expect_usage_error "stagger requires a documented unit" --manifest "$CASES" --stagger 10
expect_usage_error "stagger rejects unsupported units" --manifest "$CASES" --stagger 2days
expect_usage_error "resume IDs cannot escape results" --resume ../outside
expect_usage_error "validate-only may be specified only once" --manifest "$CASES" --validate-only --validate-only
expect_usage_error "scripted-only may be specified only once" --manifest "$CASES" --scripted-only --scripted-only
expect_usage_error "validate-only rejects resume" --resume campaign-example --validate-only
expect_usage_error "validate-only rejects scripted selection" --manifest "$CASES" --validate-only --scripted-only
expect_usage_error "validate-only rejects scheduler options" --manifest "$CASES" --validate-only --concurrency 2
expect_usage_error "validate-only rejects stagger" --manifest "$CASES" --validate-only --stagger 1s

cap_interval_manifest="$TEST_ROOT/manifests/cap-interval.jsonl"
valid_case "CAP-INTERVAL" | sed 's/"requires":{"toolchains":\["node"\]}/"requires":{}/' > "$cap_interval_manifest"
for cap_interval_value in abc 0 -5 1.5; do
  set +e
  cap_interval_output=$(TT_CONTROLLER_CAP_CHECK_INTERVAL_MS="$cap_interval_value" \
    "$CONTROLLER" --manifest "$cap_interval_manifest" 2>&1)
  cap_interval_status=$?
  set -e
  [ "$cap_interval_status" -eq 2 ] \
    || fail "cap-check interval '$cap_interval_value' exited $cap_interval_status instead of 2: $cap_interval_output"
  printf '%s' "$cap_interval_output" | grep -Fq 'TT_CONTROLLER_CAP_CHECK_INTERVAL_MS must be a positive integer' \
    || fail "cap-check interval '$cap_interval_value' was not rejected clearly: $cap_interval_output"
  printf '%s' "$cap_interval_output" | grep -Fq 'Campaign: ' \
    && fail "cap-check interval '$cap_interval_value' launched a campaign despite failing validation"
  true
done
pass "cap-check interval is validated fail-fast (non-numeric or non-positive) before any launch"

campaign_manifest="$TEST_ROOT/manifests/campaign.jsonl"
valid_case "CAMPAIGN-STATE" > "$campaign_manifest"
before_count=$(find "$TT_DIR/var/results" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
campaign_output=$(run_recorded_campaign "$CONTROLLER" --manifest "$campaign_manifest" --concurrency 2 --stagger 1500ms) || fail "new campaign failed: $campaign_output"
campaign_id=$(remember_campaign "$campaign_output")
campaign_dir="$TT_DIR/var/results/$campaign_id"
state_file="$campaign_dir/state.json"
[ -f "$state_file" ] || fail "new campaign did not create state.json"
after_count=$(find "$TT_DIR/var/results" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
[ "$after_count" -eq $((before_count + 1)) ] || fail "new invocation did not create exactly one campaign directory"
node --input-type=module - "$state_file" "$campaign_id" <<'NODE'
import fs from 'node:fs';
const [statePath, campaignId] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
if (state.version !== 1) throw new Error(`unexpected state version: ${state.version}`);
if (state.campaign_id !== campaignId) throw new Error('campaign ID mismatch');
if (state.phase !== 'ready') throw new Error(`unexpected campaign phase: ${state.phase}`);
if (state.options.concurrency !== 2 || state.options.stagger_ms !== 1500) {
  throw new Error(`options were not persisted: ${JSON.stringify(state.options)}`);
}
if (!state.manifest.path.startsWith('var/tt-controller-test.') || !/^[a-f0-9]{64}$/.test(state.manifest.sha256)) {
  throw new Error(`immutable manifest metadata missing: ${JSON.stringify(state.manifest)}`);
}
if (!Array.isArray(state.cases) || state.cases.length !== 1
    || !(['pending', 'terminal'].includes(state.cases[0].phase))) {
  throw new Error(`case phase missing: ${JSON.stringify(state.cases)}`);
}
if (!Array.isArray(state.cases[0].attempts) || state.cases[0].attempts.length !== 0) {
  throw new Error('new case must have an empty attempts ledger');
}
for (const key of ['created_at', 'updated_at']) {
  const value = state[key];
  if (typeof value !== 'string' || new Date(value).toISOString() !== value || !value.endsWith('Z')) {
    throw new Error(`${key} is not UTC ISO-8601: ${value}`);
  }
}
NODE
if find "$campaign_dir" -mindepth 1 -maxdepth 1 -name '*.tmp' | grep -q .; then
  fail "atomic state writer left a temporary file behind"
fi
pass "new invocation atomically creates one versioned campaign state"

node --input-type=module - "$state_file" <<'NODE'
import fs from 'node:fs';
const statePath = process.argv[2];
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
delete state.options.execution_selection;
fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
NODE
set +e
selection_mismatch_output=$("$CONTROLLER" --resume "$campaign_id" --scripted-only 2>&1)
selection_mismatch_status=$?
set -e
[ "$selection_mismatch_status" -eq 2 ] \
  || fail "all-campaign scripted-only resume exited $selection_mismatch_status instead of 2: $selection_mismatch_output"
printf '%s' "$selection_mismatch_output" | grep -Fq 'execution selection does not match campaign state' \
  || fail "all-campaign scripted-only resume mismatch was unclear: $selection_mismatch_output"
pass "legacy all-policy state resumes as all and rejects scripted-only escalation"

resume_before_count=$(find "$TT_DIR/var/results" -mindepth 1 -maxdepth 1 -type d | wc -l)
resume_output=$(run_recorded_campaign "$CONTROLLER" --resume "$campaign_id" --manifest "$campaign_manifest") || fail "resume failed: $resume_output"
printf '%s' "$resume_output" | grep -Fq "Resumed campaign: $campaign_id" || fail "resume did not report campaign identity: $resume_output"
resume_after_count=$(find "$TT_DIR/var/results" -mindepth 1 -maxdepth 1 -type d | wc -l)
[ "$resume_after_count" -eq "$resume_before_count" ] || fail "resume created another campaign directory"
node --input-type=module - "$state_file" <<'NODE'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (state.resume_count !== 1) throw new Error(`resume_count was not persisted: ${state.resume_count}`);
if (!Array.isArray(state.resumed_at) || state.resumed_at.length !== 1) throw new Error('resume timestamp missing');
if (new Date(state.resumed_at[0]).toISOString() !== state.resumed_at[0]) throw new Error('resume timestamp is not ISO-8601');
NODE
pass "resume reuses and atomically updates the existing campaign"

set +e
missing_resume_output=$("$CONTROLLER" --resume "campaign-does-not-exist-$$" 2>&1)
missing_resume_status=$?
set -e
[ "$missing_resume_status" -eq 2 ] || fail "missing resume exited $missing_resume_status instead of 2: $missing_resume_output"
printf '%s' "$missing_resume_output" | grep -Fq 'cannot load campaign state' || fail "missing resume error was unclear: $missing_resume_output"
pass "missing resume is rejected"

corrupt_id="campaign-corrupt-$$"
corrupt_dir="$TT_DIR/var/results/$corrupt_id"
mkdir -p "$corrupt_dir"
printf '%s\n' '{not-json}' > "$corrupt_dir/state.json"
printf '%s\n' "$corrupt_dir" >> "$CAMPAIGN_DIRS_FILE"
set +e
corrupt_output=$("$CONTROLLER" --resume "$corrupt_id" 2>&1)
corrupt_status=$?
set -e
[ "$corrupt_status" -eq 2 ] || fail "corrupt resume exited $corrupt_status instead of 2: $corrupt_output"
printf '%s' "$corrupt_output" | grep -Fq 'cannot load campaign state' || fail "corrupt resume error was unclear: $corrupt_output"
pass "corrupt resume state is rejected"

semantic_corrupt_id="campaign-semantic-corrupt-$$"
semantic_corrupt_dir="$TT_DIR/var/results/$semantic_corrupt_id"
mkdir -p "$semantic_corrupt_dir"
node --input-type=module - "$state_file" "$semantic_corrupt_dir/state.json" "$semantic_corrupt_id" <<'NODE'
import fs from 'node:fs';
const [sourcePath, targetPath, campaignId] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
state.campaign_id = campaignId;
state.cases = [];
fs.writeFileSync(targetPath, `${JSON.stringify(state)}\n`);
NODE
printf '%s\n' "$semantic_corrupt_dir" >> "$CAMPAIGN_DIRS_FILE"
set +e
semantic_corrupt_output=$("$CONTROLLER" --resume "$semantic_corrupt_id" 2>&1)
semantic_corrupt_status=$?
set -e
[ "$semantic_corrupt_status" -eq 2 ] || fail "semantic corruption exited $semantic_corrupt_status instead of 2: $semantic_corrupt_output"
printf '%s' "$semantic_corrupt_output" | grep -Fq 'case ledger does not match immutable manifest metadata' || fail "semantic corruption error was unclear: $semantic_corrupt_output"
pass "resume rejects a case ledger inconsistent with immutable metadata"

symlink_state_id="campaign-symlink-state-$$"
symlink_state_dir="$TT_DIR/var/results/$symlink_state_id"
mkdir -p "$symlink_state_dir"
ln -s "$state_file" "$symlink_state_dir/state.json"
printf '%s\n' "$symlink_state_dir" >> "$CAMPAIGN_DIRS_FILE"
set +e
symlink_state_output=$("$CONTROLLER" --resume "$symlink_state_id" 2>&1)
symlink_state_status=$?
set -e
[ "$symlink_state_status" -eq 2 ] || fail "symlinked state exited $symlink_state_status instead of 2: $symlink_state_output"
printf '%s' "$symlink_state_output" | grep -Fq 'state.json is not a contained regular file' || fail "symlinked-state error was unclear: $symlink_state_output"
pass "resume rejects a symlinked state file"

printf '\n' >> "$campaign_manifest"
set +e
mismatch_output=$("$CONTROLLER" --resume "$campaign_id" 2>&1)
mismatch_status=$?
set -e
[ "$mismatch_status" -eq 2 ] || fail "manifest mismatch exited $mismatch_status instead of 2: $mismatch_output"
printf '%s' "$mismatch_output" | grep -Fq 'manifest does not match campaign state' || fail "manifest mismatch error was unclear: $mismatch_output"
pass "resume rejects changed manifest bytes"

node --test "$SCRIPT_DIR/tt-report.test.mjs" || fail "report unit tests failed"
pass "report builder renders deterministic persisted-evidence summaries"

report_green_manifest="$TEST_ROOT/manifests/report-green.jsonl"
write_local_case "$report_green_manifest" "REPORT-GREEN" real 0 0 "$TEST_ROOT/report-green-sentinel"
set +e
report_green_output=$("$CONTROLLER" --manifest "$report_green_manifest" 2>&1)
report_green_status=$?
set -e
[ "$report_green_status" -eq 0 ] || fail "green report campaign exited $report_green_status: $report_green_output"
report_green_id=$(remember_campaign "$report_green_output")
report_green_dir="$TT_DIR/var/results/$report_green_id"
node --input-type=module - "$report_green_dir/report.json" "$report_green_dir/report.txt" <<'NODE'
import fs from 'node:fs';
const [jsonPath, textPath] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const text = fs.readFileSync(textPath, 'utf8');
if (report.rows.length !== 1 || report.rows[0].id !== 'REPORT-GREEN'
    || report.rows[0].outcome !== 'PASS' || report.rows[0].attempts.length !== 1
    || report.outcome_totals.PASS !== 1 || report.verdict !== 'GREEN' || report.exit_code !== 0) {
  throw new Error(`green report JSON is incomplete: ${JSON.stringify(report)}`);
}
for (const heading of ['SCENARIO OUTCOMES', 'SPEND LEDGER', 'NOT_RUN', 'FINDINGS', 'VERDICT']) {
  if (!text.includes(heading)) throw new Error(`report.txt omitted ${heading}`);
}
NODE
pass "terminal campaign writes self-contained report.json and report.txt"

# A single REAL (hermes) case blocked by predicate while include-real is
# requested is exactly the zero-real-launches vacuous-GREEN defect US-005
# fixes: >0 real cases exist and 0 real cases launch, so the campaign must
# fail closed (exit 2, INFRA_FAILURE) naming the cause — NOT report a generic
# GREEN. The predicate NOT_RUN reason must still be recorded as evidence.
report_predicate_manifest="$TEST_ROOT/manifests/report-predicate.jsonl"
valid_case "REPORT-PREDICATE" | sed 's/"requires":{"toolchains":\["node"\]}/"requires":{"platform":"darwin"}/' > "$report_predicate_manifest"
set +e
report_predicate_output=$("$CONTROLLER" --manifest "$report_predicate_manifest" 2>&1)
report_predicate_status=$?
set -e
[ "$report_predicate_status" -eq 2 ] || fail "real predicate-only campaign exited $report_predicate_status instead of 2 (fail-closed): $report_predicate_output"
report_predicate_id=$(remember_campaign "$report_predicate_output")
grep -Fq -- '- REPORT-PREDICATE: predicate' "$TT_DIR/var/results/$report_predicate_id/report.txt" \
  || fail "predicate NOT_RUN reason missing from report.txt"
grep -Fq 'INFRA_FAILURE (exit 2)' "$TT_DIR/var/results/$report_predicate_id/report.txt" \
  || fail "real predicate-blocked campaign did not fail closed: $report_predicate_output"
grep -Fq 'Cause: include-real requested but zero real cases launched' "$TT_DIR/var/results/$report_predicate_id/report.txt" \
  || fail "fail-closed report did not name the zero-real-launch cause"

# A LOCAL (non-real) case blocked by predicate must NOT trigger fail-closed:
# with zero real cases in the manifest, a predicate NOT_RUN stays GREEN exit 0.
report_loc_predicate_manifest="$TEST_ROOT/manifests/report-local-predicate.jsonl"
write_local_predicate_case "$report_loc_predicate_manifest" "REPORT-LOCAL-PREDICATE"
set +e
report_loc_predicate_output=$("$CONTROLLER" --manifest "$report_loc_predicate_manifest" 2>&1)
report_loc_predicate_status=$?
set -e
[ "$report_loc_predicate_status" -eq 0 ] || fail "local predicate-only campaign exited $report_loc_predicate_status instead of 0: $report_loc_predicate_output"
report_loc_predicate_id=$(remember_campaign "$report_loc_predicate_output")
grep -Fq -- '- REPORT-LOCAL-PREDICATE: predicate' "$TT_DIR/var/results/$report_loc_predicate_id/report.txt" \
  || fail "local predicate NOT_RUN reason missing from report.txt"
grep -Fq 'GREEN (exit 0)' "$TT_DIR/var/results/$report_loc_predicate_id/report.txt" \
  || fail "local predicate-blocked campaign unexpectedly failed closed"

report_red_manifest="$TEST_ROOT/manifests/report-red.jsonl"
write_local_case "$report_red_manifest" "REPORT-RED" real 0 7 "$TEST_ROOT/report-red-sentinel"
set +e
report_red_output=$("$CONTROLLER" --manifest "$report_red_manifest" 2>&1)
report_red_status=$?
set -e
[ "$report_red_status" -eq 1 ] || fail "product-finding campaign exited $report_red_status instead of 1: $report_red_output"
report_red_id=$(remember_campaign "$report_red_output")
grep -Fq 'FINDINGS (exit 1)' "$TT_DIR/var/results/$report_red_id/report.txt" \
  || fail "product-finding verdict missing from report.txt"

report_infra_manifest="$TEST_ROOT/manifests/report-infra.jsonl"
write_local_case "$report_infra_manifest" "REPORT-INFRA" real 17 0 "$TEST_ROOT/report-infra-sentinel"
set +e
report_infra_output=$("$CONTROLLER" --manifest "$report_infra_manifest" 2>&1)
report_infra_status=$?
set -e
[ "$report_infra_status" -eq 2 ] || fail "infrastructure campaign exited $report_infra_status instead of 2: $report_infra_output"
report_infra_id=$(remember_campaign "$report_infra_output")
grep -Fq 'INFRA_FAILURE (exit 2)' "$TT_DIR/var/results/$report_infra_id/report.txt" \
  || fail "infrastructure verdict missing from report.txt"
pass "campaign verdict exits are 0 green/predicate, 1 finding, and 2 infrastructure"

smoke_manifest="$TT_DIR/cases/smoke.jsonl"
[ -f "$smoke_manifest" ] || fail "smoke.jsonl is missing"
golden_root="$TEST_ROOT/smoke-golden"
mkdir -p "$golden_root"
for fixture_name in tt-python tt-ts tt-go tt-java tt-rust tt-poly-lite tt-poly \
    "tt-selftest-a-$$" "tt-selftest-b-$$"; do
  fixture_path="$golden_root/$fixture_name.git"
  git init --bare --quiet "$fixture_path"
  git --git-dir="$fixture_path" symbolic-ref HEAD refs/heads/main
  fixture_tree=$(printf '' | git --git-dir="$fixture_path" mktree)
  fixture_commit=$(printf 'baseline\n' | GIT_AUTHOR_NAME='TT Selftest' GIT_AUTHOR_EMAIL='tt@example.invalid' \
    GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_NAME='TT Selftest' \
    GIT_COMMITTER_EMAIL='tt@example.invalid' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z' \
    git --git-dir="$fixture_path" commit-tree "$fixture_tree")
  git --git-dir="$fixture_path" update-ref refs/heads/main "$fixture_commit"
  printf 'BASELINE=%s\n' "$fixture_commit" > "$golden_root/$fixture_name.git.hashes"
done
set +e
smoke_output=$(TEST_GOLDEN_ROOT="$golden_root" "$CONTROLLER" --manifest "$smoke_manifest" 2>&1)
smoke_status=$?
set -e
[ "$smoke_status" -eq 0 ] || fail "zero-token smoke campaign exited $smoke_status: $smoke_output"
smoke_id=$(remember_campaign "$smoke_output")
smoke_dir="$TT_DIR/var/results/$smoke_id"
node --input-type=module - "$smoke_dir/state.json" "$smoke_dir/report.json" "$smoke_dir/report.txt" "$smoke_manifest" \
  "tt-selftest-a-$$.git" "tt-selftest-b-$$.git" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const [statePath, reportJsonPath, reportTextPath, manifestPath, ...expectedFixtures] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const report = JSON.parse(fs.readFileSync(reportJsonPath, 'utf8'));
const manifest = fs.readFileSync(manifestPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
if (state.cases.length !== 2 || state.cases.some(item => item.phase !== 'terminal' || item.outcome !== 'PASS')) {
  throw new Error(`smoke cases were not terminal PASS: ${JSON.stringify(state.cases)}`);
}
if (manifest.some(item => item.workflow !== 'local' || item.harness !== 'local'
    || item.caps.tokens !== 0 || item.command.executable === 'tamandua')) {
  throw new Error(`smoke manifest can launch a daemon, harness, or token spend: ${JSON.stringify(manifest)}`);
}
for (const item of state.cases) {
  const attempt = item.attempts[0];
  if (attempt?.kind !== 'local' || attempt.command?.argv?.[0] === 'tamandua') {
    throw new Error(`smoke launched a harness or allowed token spend: ${JSON.stringify(item)}`);
  }
}
const fixtureCase = state.cases.find(item => item.id === 'W0.fixture-baselines');
const fixtureAttempt = fixtureCase?.attempts?.[0];
const fixtureEvidence = JSON.parse(fs.readFileSync(path.join(path.dirname(statePath), fixtureAttempt.command.stdout), 'utf8'));
for (const expected of expectedFixtures) {
  if (!fixtureEvidence.fixtures.some(item => item.name === expected && item.result === 'PASS')) {
    throw new Error(`golden fixture was not mechanically checked: ${expected}: ${JSON.stringify(fixtureEvidence)}`);
  }
}
if (report.verdict !== 'GREEN' || report.exit_code !== 0
    || !fs.readFileSync(reportTextPath, 'utf8').includes('GREEN (exit 0)')) {
  throw new Error(`smoke report is incomplete: ${JSON.stringify(report)}`);
}
NODE
printf '%s\n' "$smoke_dir" >> "$CAMPAIGN_DIRS_FILE"
pass "smoke manifest checks W0.0 and every present golden fixture without a daemon or harness"

launcher_root="$TEST_ROOT/launcher-torture-test"
mkdir -p "$launcher_root/bin" "$launcher_root/cases" "$launcher_root/var/results/campaign-newest" \
  "$launcher_root/scenarios/lib" "$launcher_root/scenarios/example" "$launcher_root/oracles" \
  "$TEST_ROOT/workflows/do-now"
cp "$SCRIPT_DIR/tt-run" "$launcher_root/bin/tt-run"
cp "$SCRIPT_DIR/tt-tier0-assets" "$launcher_root/bin/tt-tier0-assets"
cp "$TT_DIR/scenarios/lib/validate-scenario.mjs" "$launcher_root/scenarios/lib/validate-scenario.mjs"
cp "$TT_DIR/scenarios/lib/tracked-tree.mjs" "$launcher_root/scenarios/lib/tracked-tree.mjs"
: > "$launcher_root/cases/smoke.jsonl"
cat > "$TEST_ROOT/workflows/do-now/workflow.yml" <<'YAML'
id: do-now
agents:
  - id: worker
steps:
  - id: work
    agent: worker
YAML
cat > "$launcher_root/scenarios/example/scenario.json" <<'JSON'
{"schema_version":1,"id":"launcher-example","workflow_base":"do-now","behaviors":"behaviors.json","command":"run.sh","expected_outcome":"completed","oracles":["O3z"]}
JSON
cat > "$launcher_root/scenarios/example/behaviors.json" <<'JSON'
{"heartbeatTokens":0,"defaultTokens":0,"agents":{"worker":{"output":"STATUS: done","tokens":0}}}
JSON
cat > "$launcher_root/scenarios/example/run.sh" <<'SH'
#!/usr/bin/env bash
exit 0
SH
cat > "$launcher_root/oracles/O3z" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$launcher_root/scenarios/example/run.sh" "$launcher_root/oracles/O3z"
cat > "$launcher_root/cases/tier0.jsonl" <<'JSONL'
{"id":"launcher-scripted","context":{"execution_mode":"scripted","scenario_id":"launcher-example","scenario_path":"scenarios/example"}}
{"id":"launcher-real-pi","context":{"execution_mode":"real"}}
{"id":"launcher-real-hermes","context":{"execution_mode":"real"}}
JSONL
cat > "$launcher_root/bin/tt-controller" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$TT_FAKE_CONTROLLER_LOG"
exit "${TT_FAKE_CONTROLLER_EXIT:-0}"
SH
cat > "$launcher_root/bin/tt-verify-environment" <<'SH'
#!/usr/bin/env bash
exit 99
SH
chmod +x "$launcher_root/bin/tt-controller" "$launcher_root/bin/tt-verify-environment"
# US-002: the tier asset validators require every manifest-referenced scenario
# dir to exist in the TRACKED TREE (git ls-files), not merely on disk. Make
# the launcher fixture a real git checkout so its scenarios/example cell is
# tracked — mirroring a merged-main checkout where only committed assets
# exist (an untracked-asset GREEN would now refuse).
git init -q "$launcher_root"
git -C "$launcher_root" add -A
launcher_log="$TEST_ROOT/launcher-controller-argv"
for expected_status in 0 1 2; do
  set +e
  TT_FAKE_CONTROLLER_LOG="$launcher_log" TT_FAKE_CONTROLLER_EXIT="$expected_status" \
    "$launcher_root/bin/tt-run" --smoke >"$TEST_ROOT/launcher-$expected_status.stdout" \
    2>"$TEST_ROOT/launcher-$expected_status.stderr"
  launcher_status=$?
  set -e
  [ "$launcher_status" -eq "$expected_status" ] \
    || fail "tt-run --smoke changed controller exit $expected_status to $launcher_status"
  launcher_argv=()
  while IFS= read -r launcher_arg || [ -n "${launcher_arg:-}" ]; do
    launcher_argv+=("$launcher_arg")
  done < "$launcher_log"
  [ "${#launcher_argv[@]}" -eq 2 ] && [ "${launcher_argv[0]}" = "--manifest" ] \
    && [ "${launcher_argv[1]}" = "$launcher_root/cases/smoke.jsonl" ] \
    || fail "tt-run --smoke did not delegate the smoke manifest: $(tr '\n' ' ' < "$launcher_log")"
done

launcher_help=$("$launcher_root/bin/tt-run" --help)
printf '%s' "$launcher_help" | grep -Eq -- '--tier0 .*\[available\]' \
  || fail "tt-run --help did not mark the validated Tier-0 assets available: $launcher_help"
printf '%s' "$launcher_help" | grep -Fq -- '--include-real' \
  || fail "tt-run --help did not name the Tier-0 real-case opt-in: $launcher_help"
printf '%s' "$launcher_help" | grep -Eq 'WARNING.*real.*tokens|real.*tokens.*WARNING' \
  || fail "tt-run --help did not prominently warn that the opt-in spends real tokens: $launcher_help"

for expected_status in 0 1 2; do
  set +e
  TT_FAKE_CONTROLLER_LOG="$launcher_log" TT_FAKE_CONTROLLER_EXIT="$expected_status" \
    "$launcher_root/bin/tt-run" --tier0 >"$TEST_ROOT/tier0-$expected_status.stdout" \
    2>"$TEST_ROOT/tier0-$expected_status.stderr"
  launcher_status=$?
  set -e
  [ "$launcher_status" -eq "$expected_status" ] \
    || fail "tt-run --tier0 changed controller exit $expected_status to $launcher_status"
  launcher_argv=()
  while IFS= read -r launcher_arg || [ -n "${launcher_arg:-}" ]; do
    launcher_argv+=("$launcher_arg")
  done < "$launcher_log"
  [ "${#launcher_argv[@]}" -eq 3 ] && [ "${launcher_argv[0]}" = "--manifest" ] \
    && [ "${launcher_argv[1]}" = "$launcher_root/cases/tier0.jsonl" ] \
    && [ "${launcher_argv[2]}" = "--scripted-only" ] \
    || fail "tt-run --tier0 did not enforce scripted-only routing: $(tr '\n' ' ' < "$launcher_log")"
done

TT_FAKE_CONTROLLER_LOG="$launcher_log" "$launcher_root/bin/tt-run" --tier0 --include-real
launcher_argv=()
while IFS= read -r launcher_arg || [ -n "${launcher_arg:-}" ]; do
  launcher_argv+=("$launcher_arg")
done < "$launcher_log"
[ "${#launcher_argv[@]}" -eq 2 ] && [ "${launcher_argv[0]}" = "--manifest" ] \
  && [ "${launcher_argv[1]}" = "$launcher_root/cases/tier0.jsonl" ] \
  || fail "tt-run --tier0 --include-real did not delegate the complete manifest: $(tr '\n' ' ' < "$launcher_log")"

for launcher_bad_args in \
  '--include-real' \
  '--tier0 --smoke' \
  '--smoke --include-real' \
  '--tier0 --include-real --report'; do
  read -r -a launcher_bad_argv <<< "$launcher_bad_args"
  set +e
  "$launcher_root/bin/tt-run" "${launcher_bad_argv[@]+"${launcher_bad_argv[@]}"}" >"$TEST_ROOT/launcher-bad.stdout" 2>"$TEST_ROOT/launcher-bad.stderr"
  launcher_status=$?
  set -e
  [ "$launcher_status" -eq 4 ] \
    || fail "tt-run accepted conflicting/unknown arguments '$launcher_bad_args' with exit $launcher_status"
done

chmod -x "$launcher_root/scenarios/example/run.sh"
launcher_help=$("$launcher_root/bin/tt-run" --help)
printf '%s' "$launcher_help" | grep -Eq -- '--tier0 .*\[NOT YET IMPLEMENTED\]' \
  || fail "tt-run --help advertised Tier-0 with an invalid scenario library: $launcher_help"
set +e
TT_FAKE_CONTROLLER_LOG="$launcher_log" "$launcher_root/bin/tt-run" --tier0 \
  >"$TEST_ROOT/tier0-unavailable.stdout" 2>"$TEST_ROOT/tier0-unavailable.stderr"
launcher_status=$?
set -e
[ "$launcher_status" -eq 3 ] || fail "unavailable Tier-0 assets exited $launcher_status instead of 3"
chmod +x "$launcher_root/scenarios/example/run.sh"

for required_asset in "$launcher_root/bin/tt-controller" "$launcher_root/cases/tier0.jsonl"; do
  mv "$required_asset" "$required_asset.missing"
  launcher_help=$("$launcher_root/bin/tt-run" --help)
  printf '%s' "$launcher_help" | grep -Eq -- '--tier0 .*\[NOT YET IMPLEMENTED\]' \
    || fail "tt-run --help advertised Tier-0 without required asset $required_asset: $launcher_help"
  mv "$required_asset.missing" "$required_asset"
done
pass "tt-run detects validated Tier-0 assets, defaults to zero-token routing, gates real cases, and preserves verdict exits"

printf 'controller-generated newest report\n' > "$launcher_root/var/results/campaign-newest/report.txt"
launcher_report=$("$launcher_root/bin/tt-run" --report)
printf '%s' "$launcher_report" | grep -Fq 'controller-generated newest report' \
  || fail "tt-run --report did not render controller report.txt: $launcher_report"
pass "tt-run delegates smoke with unchanged verdict exits and reports newest controller output"

printf 'RESULT: All tt-controller manifest and campaign state tests PASSED\n'
