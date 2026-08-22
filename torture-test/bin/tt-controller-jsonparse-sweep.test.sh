#!/usr/bin/env bash
# tt-controller-jsonparse-sweep.test.sh — S16 (US-004) sweep of the remaining
# JSON.parse-on-subprocess-output sites in tt-controller.
#
# US-003 hardened queryWorkflowStatus; this story sweeps the OTHER subprocess
# output parses so no raw SyntaxError can escape to crash the controller:
#   (a) queryWorkflowDatabaseEvidence's sqlite3 '-readonly -json' output
#       (was a raw JSON.parse with no try/catch — campaign-#8's crash class);
#   (b) runCaseO9TargetedProbes' o9-targeted-probes stdout (was wrapped, but
#       the wrapped error dropped the raw stdout);
#   (c) runCaseOracles' oracle response stdout (already converted to
#       record.status 'TEST_INFRA', but the raw stdout was not captured in
#       record.errors).
# The already-guarded sites (parseWaitJson / parseLocalCommandSummary /
# readRunEventStream) are audited in code comments and keep their behavior —
# the existing tt-controller.test.sh battery stays green (AC3).
#
# Arms (zero tokens, stub-based — same pattern as
# tt-controller-status-resilience.test.sh):
#   AC1 (a): stub 'tamandua' whose status succeeds once (monitor) then emits
#       non-JSON garbage (harvest status leg), plus a stub 'sqlite3' on PATH
#       emitting garbage -> the terminal-harvest path records the case
#       TEST_INFRA_FAIL 'workflow-status-query-failed' with the sqlite3 raw
#       output captured in the reason evidence (database_raw_output).
#   AC2: controller output contains no raw 'SyntaxError' across every arm.
#   AC3 (c): an oracle executable emitting garbage -> its oracle_results
#       record.status is 'TEST_INFRA' with the raw stdout captured in
#       record.errors; the controller survives and the case is terminal.
#   AC4 (b): a stub o9-targeted-probes (TT_CONTROLLER_O9_PROBES_PATH seam)
#       emitting garbage -> the case fails closed TEST_INFRA_FAIL and the
#       reason carries the raw probe stdout; no SyntaxError.
#
# Not part of `npm test` (torture-test/.sh self-tests are standalone).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TT_DIR="$(dirname "$SCRIPT_DIR")"
CONTROLLER="$SCRIPT_DIR/tt-controller"
RESULTS="$TT_DIR/var/results"
mkdir -p "$RESULTS"

TEST_ROOT="$(mktemp -d "$TT_DIR/var/controller-jsonparse-sweep.XXXXXX")"
STUB_DIR="$TEST_ROOT/stubs"
# The sqlite3 garbage stub lives in its OWN dir so it is prepended to PATH
# ONLY for the AC1 arm: the oracle/O9 arms must reach the REAL sqlite3
# (oracle-evidence-snapshot.mjs runs `sqlite3 -readonly <db> .backup`), and a
# garbage-emitting sqlite3 on PATH would break their snapshot machinery.
SQLITE3_STUB_DIR="$TEST_ROOT/sqlite3-stubs"
STATUS_COUNT_DIR="$TEST_ROOT/status-counts"
ORACLE_ROOT="$TEST_ROOT/self-test-oracles"
mkdir -p "$STUB_DIR" "$SQLITE3_STUB_DIR" "$STATUS_COUNT_DIR" "$TEST_ROOT/manifests" "$ORACLE_ROOT"

HOST_PROFILE="$TT_DIR/var/w0/host-profile.json"
HOST_PROFILE_BACKUP="$TEST_ROOT/original-host-profile.json"
mkdir -p "$(dirname "$HOST_PROFILE")"
if [ -f "$HOST_PROFILE" ]; then cp "$HOST_PROFILE" "$HOST_PROFILE_BACKUP"; fi

# The hermes (real-env) cases read the contained workflow database for
# discovered-run reconciliation; back it up (incl. WAL side files) and seed an
# empty runs table so the healthy cases complete instead of failing on a
# missing inventory.
REAL_DB="$TT_DIR/var/home/.tamandua/tamandua.db"
REAL_DB_BACKUP="$TEST_ROOT/original-tamandua.db"
REAL_DB_WAL_BACKUP="$TEST_ROOT/original-tamandua.db-wal"
REAL_DB_SHM_BACKUP="$TEST_ROOT/original-tamandua.db-shm"
mkdir -p "$(dirname "$REAL_DB")"
if [ -f "$REAL_DB" ]; then mv "$REAL_DB" "$REAL_DB_BACKUP"; fi
if [ -f "$REAL_DB-wal" ]; then mv "$REAL_DB-wal" "$REAL_DB_WAL_BACKUP"; fi
if [ -f "$REAL_DB-shm" ]; then mv "$REAL_DB-shm" "$REAL_DB_SHM_BACKUP"; fi
node --input-type=module - "$REAL_DB" <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const database = new DatabaseSync(process.argv[2]);
database.exec(`CREATE TABLE runs (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, task TEXT NOT NULL,
  status TEXT NOT NULL, context TEXT NOT NULL DEFAULT '{}',
  tokens_spent INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`);
database.close();
NODE

CAMPAIGNS="$TEST_ROOT/campaign-dirs"
: > "$CAMPAIGNS"

cleanup() {
  trap - EXIT
  if [ -f "$HOST_PROFILE_BACKUP" ]; then
    cp "$HOST_PROFILE_BACKUP" "$HOST_PROFILE"
  else
    rm -f -- "$HOST_PROFILE"
  fi
  rm -f -- "$REAL_DB" "$REAL_DB-wal" "$REAL_DB-shm"
  if [ -f "$REAL_DB_BACKUP" ]; then mv "$REAL_DB_BACKUP" "$REAL_DB"; fi
  if [ -f "$REAL_DB_WAL_BACKUP" ]; then mv "$REAL_DB_WAL_BACKUP" "$REAL_DB-wal"; fi
  if [ -f "$REAL_DB_SHM_BACKUP" ]; then mv "$REAL_DB_SHM_BACKUP" "$REAL_DB-shm"; fi
  while IFS= read -r campaign_dir; do
    case "$campaign_dir" in
      "$RESULTS/"*) rm -rf -- "$campaign_dir" ;;
    esac
  done < "$CAMPAIGNS"
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }

# A satisfying host profile so a real (workflow) case passes the W0 gate.
cat > "$HOST_PROFILE" <<'JSON'
{"platform":{"os":"linux","label":"linux"},"containment":{"systemdUserScope":true,"procfs":true},"toolchains":{"node":{"present":true,"buildPassed":true,"testPassed":true}},"nodeRuntimes":[{"version":"v24.0.0","major":24,"sqliteAvailable":true}]}
JSON

# Ensure the tt-ts golden exists so fixture provisioning can clone it.
[ -d "$TT_DIR/var/fixtures/golden/tt-ts.git" ] \
  || node "$TT_DIR/bin/tt-golden-bootstrap.mjs" --fixture tt-ts >/dev/null 2>&1 \
  || fail "could not bootstrap the tt-ts golden for the jsonparse-sweep test"

# ── Deterministic real workflow cases ───────────────────────────────────────
#   JSONPARSE-DB-BAD   -> status succeeds ONCE (monitor poll) then emits
#                         non-JSON garbage (harvest status leg); sqlite3 stub
#                         emits garbage -> DB-fallback structured failure.
#   JSONPARSE-DB-GOOD  -> status always valid (healthy control, same campaign).
#   JSONPARSE-ORACLE   -> status always valid; oracle O1 emits garbage stdout
#                         -> record.status TEST_INFRA with raw stdout captured.
#   JSONPARSE-O9       -> status always valid; oracles [O9] + o9_special_exits
#                         -> stub o9-targeted-probes emits garbage stdout.
cat > "$TEST_ROOT/manifests/campaign1.jsonl" <<'M'
{"id":"JSONPARSE-DB-BAD","wave":0,"workflow":"bug-fix-merge-worktree","fixture":"tt-ts","harness":"hermes","task":"tasks/W3.07.md","context":{},"caps":{"tokens":4000000,"wall_min":240},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
{"id":"JSONPARSE-DB-GOOD","wave":0,"workflow":"bug-fix-merge-worktree","fixture":"tt-ts","harness":"hermes","task":"tasks/W3.08.md","context":{},"caps":{"tokens":4000000,"wall_min":240},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
M
cat > "$TEST_ROOT/manifests/campaign2.jsonl" <<'M'
{"id":"JSONPARSE-ORACLE","wave":0,"workflow":"bug-fix-merge-worktree","fixture":"tt-ts","harness":"hermes","task":"tasks/W3.09.md","context":{},"caps":{"tokens":4000000,"wall_min":240},"requires":{},"boundary_files":[],"forbidden":[],"oracles":["O1"],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
M
cat > "$TEST_ROOT/manifests/campaign3.jsonl" <<'M'
{"id":"JSONPARSE-O9","wave":0,"workflow":"bug-fix-merge-worktree","fixture":"tt-ts","harness":"hermes","task":"tasks/W3.10.md","context":{"o9_special_exits":true},"caps":{"tokens":4000000,"wall_min":240},"requires":{},"boundary_files":[],"forbidden":[],"oracles":["O9"],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
M

# ── tamandua stub ───────────────────────────────────────────────────────────
# `workflow run` emits a case-specific full run id then holds the launch open
# briefly so the monitor's first status poll lands mid-flight. `workflow
# status` switches on the run id: valid JSON for the healthy arms; for the
# DB-BAD arm a STATUS_COUNT_DIR counter makes the FIRST invocation valid
# (monitor poll sees terminal) and every subsequent invocation garbage (the
# terminal-harvest status leg exhausts its bounded retries and falls back to
# the readonly-DB probe). Zero tokens, no model.
cat > "$STUB_DIR/tamandua" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "workflow" ] && [ "${2:-}" = "run" ]; then
  case "${5:-}" in
    tasks/W3.07.md) printf 'Run: run-aaaaaaaa-1111-4111-8111-111111111111\n'; sleep "${RUN_SLEEP_BAD:-0.5}" ;;
    tasks/W3.08.md) printf 'Run: run-bbbbbbbb-2222-4222-8222-222222222222\n'; sleep "${RUN_SLEEP_GOOD:-0.5}" ;;
    tasks/W3.09.md) printf 'Run: run-cccccccc-3333-4333-8333-333333333333\n'; sleep "${RUN_SLEEP_GOOD:-0.5}" ;;
    tasks/W3.10.md) printf 'Run: run-dddddddd-4444-4444-8444-444444444444\n'; sleep "${RUN_SLEEP_GOOD:-0.5}" ;;
  esac
  exit 0
fi
if [ "${1:-}" = "workflow" ] && [ "${2:-}" = "status" ]; then
  case "${3:-}" in
    run-aaaaaaaa-1111-4111-8111-111111111111)
      count_file="$STATUS_COUNT_DIR/db-bad"
      count=0
      [ ! -f "$count_file" ] || count="$(cat "$count_file")"
      count=$((count + 1))
      printf '%s' "$count" > "$count_file"
      if [ "$count" -le 1 ]; then
        printf '{"runId":"%s","status":"completed","tokensSpent":0,"steps":[]}\n' "${3:-}"
        exit 0
      fi
      printf 'no such column: ceiling_expiry_count\n'
      exit 0
      ;;
    run-bbbbbbbb-2222-4222-8222-222222222222)
      printf '{"runId":"%s","status":"completed","tokensSpent":0,"steps":[]}\n' "${3:-}"
      exit 0
      ;;
    run-cccccccc-3333-4333-8333-333333333333)
      printf '{"runId":"%s","status":"completed","tokensSpent":0,"steps":[]}\n' "${3:-}"
      exit 0
      ;;
    run-dddddddd-4444-4444-8444-444444444444)
      printf '{"runId":"%s","status":"completed","tokensSpent":0,"steps":[]}\n' "${3:-}"
      exit 0
      ;;
  esac
  printf '{"runId":"%s","status":"completed","tokensSpent":0,"steps":[]}\n' "${3:-}"
  exit 0
fi
exit 0
STUB
chmod +x "$STUB_DIR/tamandua"

# ── sqlite3 stub (AC1 arm): always emits non-JSON garbage, exit 0 ───────────
cat > "$SQLITE3_STUB_DIR/sqlite3" <<'STUB'
#!/usr/bin/env bash
printf 'sqlite3-garbage: this is not json {"broken":\n'
exit 0
STUB
chmod +x "$SQLITE3_STUB_DIR/sqlite3"

# ── oracle O1 stub (AC3 arm): emits non-JSON garbage stdout ─────────────────
cat > "$ORACLE_ROOT/O1" <<'STUB'
#!/usr/bin/env node
console.log('oracle-garbage-not-json {broken');
process.exit(0);
STUB
chmod +x "$ORACLE_ROOT/O1"
# The O9 gating oracle must EXIST for completeCaseOracleSnapshot to arm the
# targeted-probe leg; its own response is never reached (the probe fails
# first), so a VALID oracle keeps the snapshot machinery happy.
cat > "$ORACLE_ROOT/O9" <<'STUB'
#!/usr/bin/env node
const now = new Date().toISOString();
console.log(JSON.stringify({ contract_version: 1, oracle_id: 'O9', result: 'PASS', started_at: now, finished_at: now, findings: [], evidence: [] }));
process.exit(0);
STUB
chmod +x "$ORACLE_ROOT/O9"

# ── o9-targeted-probes stub (AC4 arm): emits non-JSON garbage stdout ────────
cat > "$TEST_ROOT/o9-probes-garbage.mjs" <<'STUB'
#!/usr/bin/env node
// Stub o9-targeted-probes that emits NON-JSON stdout (the injected garbage
// for the S16 US-004 (b) arm). The controller spawns it via process.execPath
// with --repo/--run/--step-prefix/--shim args, all ignored here.
console.log('o9-probes-garbage: not json {');
STUB
chmod +x "$TEST_ROOT/o9-probes-garbage.mjs"

# run_case <manifest> [sqlite3-stub] -> sets CONTROLLER_STATUS,
# CONTROLLER_OUTPUT, CONTROLLER_CAMPAIGN (dir under RESULTS). The optional
# second arg "sqlite3-stub" prepends the garbage-emitting sqlite3 stub to PATH
# (AC1 arm only — the oracle/O9 arms need the REAL sqlite3).
run_case() {
  local manifest="$1"
  local with_sqlite3_stub="${2:-0}"
  local path_prefix="$STUB_DIR"
  if [ "$with_sqlite3_stub" = "sqlite3-stub" ]; then
    path_prefix="$SQLITE3_STUB_DIR:$STUB_DIR"
  fi
  local before
  before="$(mktemp)"
  ls -1 "$RESULTS" 2>/dev/null | grep '^campaign-' | sort > "$before" || true
  set +e
  CONTROLLER_OUTPUT="$(env PATH="$path_prefix:$PATH" STATUS_COUNT_DIR="$STATUS_COUNT_DIR" \
    TT_CONTROLLER_PREFLIGHT_DISABLED=1 \
    TT_CONTROLLER_SELF_TEST=1 TT_CONTROLLER_SELF_TEST_ORACLES_ROOT="$ORACLE_ROOT" \
    TT_CONTROLLER_O9_PROBES_PATH="$TEST_ROOT/o9-probes-garbage.mjs" \
    TT_CONTROLLER_POLL_INTERVAL_MS=20 TT_CONTROLLER_CAP_CHECK_INTERVAL_MS=20 \
    TT_CONTROLLER_TRUTH_RECHECK_MS=20 TT_CONTROLLER_TOKEN_SETTLE_MS=50 \
    "$CONTROLLER" --manifest "$manifest" 2>&1)"
  CONTROLLER_STATUS=$?
  set -e
  CONTROLLER_CAMPAIGN="$(comm -13 "$before" <(ls -1 "$RESULTS" 2>/dev/null | grep '^campaign-' | sort) | head -n1)"
  rm -f "$before"
  [ -n "$CONTROLLER_CAMPAIGN" ] \
    || fail "controller did not record a campaign: $CONTROLLER_OUTPUT"
  printf '%s/%s\n' "$RESULTS" "$CONTROLLER_CAMPAIGN" >> "$CAMPAIGNS"
}

no_syntax_error() {
  case "$CONTROLLER_OUTPUT" in
    *SyntaxError*) fail "controller output leaked a raw SyntaxError: $CONTROLLER_OUTPUT" ;;
  esac
}

# ── AC1/AC2: sqlite3 garbage -> terminal-harvest TEST_INFRA_FAIL with raw output ──
run_case "$TEST_ROOT/manifests/campaign1.jsonl" sqlite3-stub
# AC2: the controller does not crash and no raw SyntaxError stack escapes.
no_syntax_error
[ "$CONTROLLER_STATUS" -eq 2 ] \
  || fail "campaign exited $CONTROLLER_STATUS instead of the campaign-report 2 (INFRA_FAILURE): $CONTROLLER_OUTPUT"
node --input-type=module - "$RESULTS/$CONTROLLER_CAMPAIGN/state.json" <<'NODE'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const bad = state.cases.find((c) => c.id === 'JSONPARSE-DB-BAD');
if (!bad || bad.phase !== 'terminal' || bad.outcome !== 'TEST_INFRA_FAIL'
    || bad.reason?.category !== 'workflow-status-query-failed') {
  throw new Error(`sqlite3 garbage did not fail the case closed TEST_INFRA_FAIL workflow-status-query-failed: ${JSON.stringify(bad)}`);
}
if (!JSON.stringify(bad.reason).includes('sqlite3-garbage: this is not json')) {
  throw new Error(`workflow-status-query-failed reason lacks the raw sqlite3 output (database_raw_output): ${JSON.stringify(bad.reason)}`);
}
if (bad.reason?.kind !== 'non-json') {
  throw new Error(`sqlite3 structured failure kind is not non-json: ${JSON.stringify(bad.reason)}`);
}
const good = state.cases.find((c) => c.id === 'JSONPARSE-DB-GOOD');
if (!good || good.phase !== 'terminal' || good.outcome !== 'PASS') {
  throw new Error(`healthy case did not complete PASS in the same campaign: ${JSON.stringify(good)}`);
}
NODE
pass "AC1/AC2: stub sqlite3 garbage -> terminal-harvest TEST_INFRA_FAIL workflow-status-query-failed with raw sqlite3 output in the reason; healthy case still PASSes; no SyntaxError"

# ── AC3: oracle garbage stdout -> TEST_INFRA record with raw stdout ─────────
run_case "$TEST_ROOT/manifests/campaign2.jsonl"
no_syntax_error
node --input-type=module - "$RESULTS/$CONTROLLER_CAMPAIGN/state.json" <<'NODE'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const item = state.cases.find((c) => c.id === 'JSONPARSE-ORACLE');
if (!item || item.phase !== 'terminal') {
  throw new Error(`oracle-garbage case did not reach a terminal phase: ${JSON.stringify(item)}`);
}
const oracle = item.oracle_results?.find((r) => r.oracle_id === 'O1');
if (!oracle || oracle.status !== 'TEST_INFRA') {
  throw new Error(`garbage oracle did not record TEST_INFRA: ${JSON.stringify(oracle)}`);
}
if (!JSON.stringify(oracle.errors ?? []).includes('oracle-garbage-not-json')) {
  throw new Error(`garbage oracle record.errors lack the raw stdout: ${JSON.stringify(oracle?.errors)}`);
}
NODE
pass "AC3: garbage oracle stdout -> oracle_results TEST_INFRA with the raw stdout captured in record.errors; controller survives (no SyntaxError)"

# ── AC4: o9-targeted-probes garbage stdout -> TEST_INFRA_FAIL w/ raw output ─
run_case "$TEST_ROOT/manifests/campaign3.jsonl"
no_syntax_error
node --input-type=module - "$RESULTS/$CONTROLLER_CAMPAIGN/state.json" <<'NODE'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const item = state.cases.find((c) => c.id === 'JSONPARSE-O9');
if (!item || item.phase !== 'terminal' || item.outcome !== 'TEST_INFRA_FAIL') {
  throw new Error(`garbage o9 probes did not fail the case closed TEST_INFRA_FAIL: ${JSON.stringify(item)}`);
}
const reasonText = JSON.stringify(item.reason ?? {});
if (!reasonText.includes('o9-probes-garbage: not json')) {
  throw new Error(`o9-probes failure reason lacks the raw probe stdout: ${reasonText}`);
}
NODE
pass "AC4: stub o9-targeted-probes garbage -> case TEST_INFRA_FAIL with the raw probe stdout in the reason; no SyntaxError"

# Hygiene: preflight disabled => no real daemon/43xx ports touched; nothing leaked.
pass "S16 US-004 JSON.parse sweep self-test complete"
