#!/usr/bin/env bash
set -euo pipefail

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
CAMPAIGN_DIRS_FILE="$TEST_ROOT/campaign-dirs"
HOST_PROFILE="$TT_DIR/var/w0/host-profile.json"
HOST_PROFILE_BACKUP="$TEST_ROOT/original-host-profile.json"
: > "$CAMPAIGN_DIRS_FILE"
mkdir -p "$(dirname "$HOST_PROFILE")"
if [ -f "$HOST_PROFILE" ]; then cp "$HOST_PROFILE" "$HOST_PROFILE_BACKUP"; fi
cleanup() {
  if [ -n "$INTERRUPTION_CONTROLLER_PID" ]; then
    kill -9 "$INTERRUPTION_CONTROLLER_PID" 2>/dev/null || true
  fi
  if [ -n "$INTERRUPTION_PID" ]; then
    kill -9 "$INTERRUPTION_PID" 2>/dev/null || true
    wait "$INTERRUPTION_PID" 2>/dev/null || true
  fi
  if [ "${#SMOKE_GOLDENS[@]}" -gt 0 ]; then
    rm -rf -- "${SMOKE_GOLDENS[@]}"
  fi
  if [ "${#ORACLE_TEST_FILES[@]}" -gt 0 ]; then
    rm -f -- "${ORACLE_TEST_FILES[@]}"
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
  printf '%s\n' "{\"id\":\"$id\",\"wave\":3,\"workflow\":\"bug-fix-merge-worktree\",\"fixture\":\"tt-ts\",\"harness\":\"hermes\",\"task\":\"tasks/W3.07.md\",\"context\":{},\"caps\":{\"tokens\":4000000,\"wall_min\":240},\"requires\":{\"toolchains\":[\"node\"]},\"boundary_files\":[\"fixtures/tt-ts/src\"],\"forbidden\":[],\"oracles\":[\"O1\",\"O2\"],\"gates\":[\"W2\"],\"chaos\":null,\"shed_ok\":false,\"mandatory\":true,\"class\":\"verification\"}"
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
import fs from 'node:fs';
import path from 'node:path';
const [statePath, campaignDir] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const byId = Object.fromEntries(state.cases.map(item => [item.id,item]));
const pass = byId['ORACLE-PASS'];
const result = pass.oracle_results?.[0];
if (pass.outcome !== 'PASS' || result?.status !== 'VALID' || result?.response?.result !== 'PASS'
    || result.exit_code !== 0 || !result.stdout || !result.stderr || !result.context
    || !/^[a-f0-9]{64}$/.test(result.stdout_sha256) || !/^[a-f0-9]{64}$/.test(result.stderr_sha256)) {
  throw new Error(`valid oracle evidence was not persisted: ${JSON.stringify(pass)}`);
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
  write_local_case "$isolated_manifest" "LOCAL-${execution_mode^^}" "$execution_mode" 0 0 "$shell_sentinel"
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
scheduler_output=$(run_recorded_campaign "$CONTROLLER" --manifest "$scheduler_manifest" --concurrency 2 --stagger 120ms) || fail "bounded scheduler failed: $scheduler_output"
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
  tokens_spent INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE steps (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL,
  agent_id TEXT NOT NULL, step_index INTEGER NOT NULL, status TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'single', current_story_id TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0, abandoned_count INTEGER NOT NULL DEFAULT 0,
  reroute_count INTEGER NOT NULL DEFAULT 0, claim_pid INTEGER,
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
  if [ "${CONTROLLER_WORKFLOW_MODE:-}" = "discovery" ]; then
    cat "$CONTROLLER_LIMITED_RUNS_JSON"
    exit 0
  fi
  printf '%s\n' '{"runs":[]}'
  exit 0
fi
if [ "${1:-}" = "workflow" ] && [ "${2:-}" = "status" ]; then
  case "${CONTROLLER_WORKFLOW_MODE:-stdout}" in
    stdout) printf '{"runId":"run-11111111-1111-4111-8111-111111111111","status":"completed","tokensSpent":0,"steps":[]}\n' ;;
    stderr) printf '{"runId":"run-22222222-2222-4222-8222-222222222222","status":"running","tokensSpent":0,"steps":[]}\n' ;;
    resume) printf '{"runId":"run-22222222-2222-4222-8222-222222222222","status":"completed","tokensSpent":7,"steps":[]}\n' ;;
    harvest-status) printf '{"runId":"run-aaaaaaaa-1111-4111-8111-111111111111","status":"completed","tokensSpent":13,"steps":[{"stepId":"step-status","stepIndex":0,"status":"done"}]}\n' ;;
    oracle-prose) printf '{"runId":"run-eeeeeeee-5555-4555-8555-555555555555","status":"completed","tokensSpent":0,"steps":[{"stepId":"step-oracle-prose","stepIndex":0,"status":"done","agentId":"developer","output":"AGENT_RESPONSE_SENTINEL STATUS: done","error":"AGENT_RESPONSE_SENTINEL failure prose"}]}\n' ;;
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
  if [ "${CONTROLLER_WORKFLOW_MODE:-}" = "resume" ]; then
    printf '{"runs":[{"runId":"%s","status":"completed"}],"timedOut":false}\n' "${3:-}"
    exit 0
  fi
  [ -f "$CONTROLLER_STOP_MARKER" ] || exit 44
  printf '{"runs":[{"runId":"%s","status":"canceled"}],"timedOut":false}\n' "${3:-}"
  exit 3
fi
case "${CONTROLLER_WORKFLOW_MODE:-stdout}" in
  stdout)
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
if (state.options.token_poll_interval_ms !== 300000) {
  throw new Error(`production token polling default is not five minutes: ${JSON.stringify(state.options)}`);
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

for harvest_mode in harvest-status harvest-db harvest-lie harvest-shifting-lie; do
  harvest_manifest="$TEST_ROOT/manifests/$harvest_mode.jsonl"
  valid_case "${harvest_mode^^}" \
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

oracle_prose_manifest="$TEST_ROOT/manifests/oracle-prose.jsonl"
valid_case "ORACLE-PROSE" \
  | sed 's/"requires":{"toolchains":\["node"\]}/"requires":{}/' \
  | sed 's/"oracles":\["O1","O2"\]/"oracles":["TT-ORACLE-NO-PROSE"]/' \
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
    || child.stop_reason?.cap !== 'wall_min') {
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
  valid_case "WORKFLOW-${cap_mode^^}" \
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
NODE
done
pass "workflow token and wall caps persist spend and enforce one stop plus terminal wait"

for workflow_mode in stderr conflict missing; do
  workflow_mode_manifest="$TEST_ROOT/manifests/workflow-$workflow_mode.jsonl"
  valid_case "WORKFLOW-${workflow_mode^^}" \
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
const values = schema.properties.class.enum;
if (JSON.stringify(values) !== JSON.stringify(['verification', 'characterization', 'exploratory'])) {
  throw new Error(`unexpected class enum: ${JSON.stringify(values)}`);
}
if (!schema.properties.caps.required.includes('tokens') || !schema.properties.caps.required.includes('wall_min')) {
  throw new Error('caps does not require tokens and wall_min');
}
NODE
pass "schema pins required fields, caps, and class taxonomy"

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
if (state.updated_at !== item.terminal_at || new Date(item.terminal_at).toISOString() !== item.terminal_at) {
  throw new Error(`terminal timestamp was not durably reflected: ${JSON.stringify(item)}`);
}
NODE
[ ! -e "$predicate_sentinel" ] || fail "predicate-excluded case executed a hook"
pass "failed and unavailable predicates persist terminal NOT_RUN evidence without executing hooks"

profile_required="$TEST_ROOT/manifests/profile-required.jsonl"
valid_case "PROFILE-REQUIRED" > "$profile_required"
rm -f -- "$HOST_PROFILE"
expect_rejected "missing host profile is infrastructure failure when requirements exist" "$profile_required" 'cannot load required host profile'
printf '%s\n' '{not-json}' > "$HOST_PROFILE"
expect_rejected "malformed host profile is infrastructure failure when requirements exist" "$profile_required" 'cannot load required host profile'

empty_requires="$TEST_ROOT/manifests/empty-requires.jsonl"
valid_case "PROFILE-NOT-REQUIRED" | sed 's/"requires":{"toolchains":\["node"\]}/"requires":{}/' > "$empty_requires"
empty_output=$(run_recorded_campaign "$CONTROLLER" --manifest "$empty_requires") || fail "empty requirements unexpectedly needed host profile: $empty_output"
remember_campaign "$empty_output" > /dev/null
pass "empty requires does not require host-profile.json"
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

help_output=$("$CONTROLLER" --help 2>&1) || fail "--help failed: $help_output"
for text in '--manifest <path>' '--resume <campaign-id>' '--concurrency <count>' '--stagger <duration>' 'Duration examples: 250ms, 5s, 2m, 1h'; do
  printf '%s' "$help_output" | grep -Fq -- "$text" || fail "help omitted '$text': $help_output"
done
pass "help documents campaign and duration options"

expect_usage_error "unknown arguments are usage errors" --manifest "$CASES" --wat
expect_usage_error "concurrency must be an integer" --manifest "$CASES" --concurrency 1.5
expect_usage_error "concurrency must be positive" --manifest "$CASES" --concurrency 0
expect_usage_error "stagger requires a documented unit" --manifest "$CASES" --stagger 10
expect_usage_error "stagger rejects unsupported units" --manifest "$CASES" --stagger 2days
expect_usage_error "resume IDs cannot escape results" --resume ../outside

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

report_predicate_manifest="$TEST_ROOT/manifests/report-predicate.jsonl"
valid_case "REPORT-PREDICATE" | sed 's/"requires":{"toolchains":\["node"\]}/"requires":{"platform":"darwin"}/' > "$report_predicate_manifest"
set +e
report_predicate_output=$("$CONTROLLER" --manifest "$report_predicate_manifest" 2>&1)
report_predicate_status=$?
set -e
[ "$report_predicate_status" -eq 0 ] || fail "predicate-only campaign exited $report_predicate_status: $report_predicate_output"
report_predicate_id=$(remember_campaign "$report_predicate_output")
grep -Fq -- '- REPORT-PREDICATE: predicate' "$TT_DIR/var/results/$report_predicate_id/report.txt" \
  || fail "predicate NOT_RUN reason missing from report.txt"

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
golden_root="$TT_DIR/var/fixtures/golden"
mkdir -p "$golden_root"
for fixture_name in "tt-selftest-a-$$" "tt-selftest-b-$$"; do
  fixture_path="$golden_root/$fixture_name.git"
  git init --bare --quiet "$fixture_path"
  git --git-dir="$fixture_path" symbolic-ref HEAD refs/heads/main
  fixture_tree=$(printf '' | git --git-dir="$fixture_path" mktree)
  fixture_commit=$(printf 'baseline\n' | GIT_AUTHOR_NAME='TT Selftest' GIT_AUTHOR_EMAIL='tt@example.invalid' \
    GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_NAME='TT Selftest' \
    GIT_COMMITTER_EMAIL='tt@example.invalid' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z' \
    git --git-dir="$fixture_path" commit-tree "$fixture_tree")
  git --git-dir="$fixture_path" update-ref refs/heads/main "$fixture_commit"
  SMOKE_GOLDENS+=("$fixture_path")
done
set +e
smoke_output=$("$CONTROLLER" --manifest "$smoke_manifest" 2>&1)
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
mkdir -p "$launcher_root/bin" "$launcher_root/cases" "$launcher_root/var/results/campaign-newest"
cp "$SCRIPT_DIR/tt-run" "$launcher_root/bin/tt-run"
: > "$launcher_root/cases/smoke.jsonl"
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
  mapfile -t launcher_argv < "$launcher_log"
  [ "${#launcher_argv[@]}" -eq 2 ] && [ "${launcher_argv[0]}" = "--manifest" ] \
    && [ "${launcher_argv[1]}" = "$launcher_root/cases/smoke.jsonl" ] \
    || fail "tt-run --smoke did not delegate the smoke manifest: $(tr '\n' ' ' < "$launcher_log")"
done
printf 'controller-generated newest report\n' > "$launcher_root/var/results/campaign-newest/report.txt"
launcher_report=$("$launcher_root/bin/tt-run" --report)
printf '%s' "$launcher_report" | grep -Fq 'controller-generated newest report' \
  || fail "tt-run --report did not render controller report.txt: $launcher_report"
pass "tt-run delegates smoke with unchanged verdict exits and reports newest controller output"

printf 'RESULT: All tt-controller manifest and campaign state tests PASSED\n'
