#!/usr/bin/env bash
# tt-controller-status-resilience.test.sh — S16 (US-003) controller status-query
# resilience.
#
# Verifies that a `tamandua workflow status` query whose output is non-JSON /
# error text (the exact campaign-#8 crash shape: 'no such column:
# ceiling_expiry_count' -> JSON.parse SyntaxError -> whole controller died
# mid-campaign) is treated as a STRUCTURED failure with bounded retries:
#   * the case fails closed TEST_INFRA_FAIL with the distinct
#     'workflow-status-query-failed' category and the raw error text captured
#     in the reason evidence (attempt.status_query_error records the structured
#     kind + bounded raw output);
#   * the controller process does NOT crash — it exits with the normal
#     campaign-report exit code and state.json contains the terminal record;
#   * a second HEALTHY case in the same campaign (stub returns valid status
#     for its run) still executes and completes — the campaign continues past
#     the failed case;
#   * a status stub that fails for FEWER than the retry bound then succeeds is
#     absorbed by the bounded retries inside queryWorkflowStatus and the case
#     completes normally.
#
# The launches are driven by a deterministic `tamandua` stub on PATH (zero real
# tokens, no model). The real-case campaign preflight (US-004) is disabled via
# TT_CONTROLLER_PREFLIGHT_DISABLED=1 so this test needs no real daemon / 43xx
# ports. The real contained spawn env (var/home) is used by the hermes cases;
# its workflow database is backed up + seeded with an empty runs table (the
# discovered-run reconciliation reads it) and restored in cleanup.
#
# This is NOT part of `npm test` (torture-test/.sh self-tests are standalone).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TT_DIR="$(dirname "$SCRIPT_DIR")"
CONTROLLER="$SCRIPT_DIR/tt-controller"
RESULTS="$TT_DIR/var/results"
mkdir -p "$RESULTS"

TEST_ROOT="$(mktemp -d "$TT_DIR/var/controller-status-resilience.XXXXXX")"
STUB_DIR="$TEST_ROOT/stubs"
STATUS_COUNT_DIR="$TEST_ROOT/status-counts"
mkdir -p "$STUB_DIR" "$STATUS_COUNT_DIR" "$TEST_ROOT/manifests"

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
  || fail "could not bootstrap the tt-ts golden for the status-resilience test"

# Deterministic real workflow cases (fixture tt-ts golden exists).
#   STATUS-RESILIENCE-BAD    -> status emits garbage on STDOUT, exit 0
#                                (the exact campaign-#8 non-JSON crash shape)
#   STATUS-RESILIENCE-EXIT   -> status emits garbage on STDERR, exit 1
#                                (exit-nonzero kind)
#   STATUS-RESILIENCE-GOOD   -> status emits valid JSON (healthy control)
cat > "$TEST_ROOT/manifests/campaign1.jsonl" <<'M'
{"id":"STATUS-RESILIENCE-BAD","wave":0,"workflow":"bug-fix-merge-worktree","fixture":"tt-ts","harness":"hermes","task":"tasks/W3.07.md","context":{},"caps":{"tokens":4000000,"wall_min":240},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
{"id":"STATUS-RESILIENCE-EXIT","wave":0,"workflow":"bug-fix-merge-worktree","fixture":"tt-ts","harness":"hermes","task":"tasks/W3.08.md","context":{},"caps":{"tokens":4000000,"wall_min":240},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
{"id":"STATUS-RESILIENCE-GOOD","wave":0,"workflow":"bug-fix-merge-worktree","fixture":"tt-ts","harness":"hermes","task":"tasks/W3.09.md","context":{},"caps":{"tokens":4000000,"wall_min":240},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
M

cat > "$TEST_ROOT/manifests/campaign2.jsonl" <<'M'
{"id":"STATUS-RESILIENCE-TRANSIENT","wave":0,"workflow":"bug-fix-merge-worktree","fixture":"tt-ts","harness":"hermes","task":"tasks/W3.10.md","context":{},"caps":{"tokens":4000000,"wall_min":240},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
M

# tamandua stub: `workflow run` emits a case-specific full run id and then
# holds the launch open briefly so the monitor's first status poll lands
# mid-flight (the bounded-retry / fail-closed decision is exercised in the
# monitor path). `workflow status` switches on the run id: garbage (stdout,
# exit 0) for the non-JSON arm, garbage (stderr, exit 1) for the exit-nonzero
# arm, valid JSON for the healthy arm, and fails the first 2 invocations then
# succeeds for the transient arm (STATUS_COUNT_DIR counter). Zero tokens, no
# model.
cat > "$STUB_DIR/tamandua" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "workflow" ] && [ "${2:-}" = "run" ]; then
  case "${5:-}" in
    tasks/W3.07.md) printf 'Run: run-aaaaaaaa-1111-4111-8111-111111111111\n'; sleep "${RUN_SLEEP_BAD:-3}" ;;
    tasks/W3.08.md) printf 'Run: run-dddddddd-4444-4222-8222-444444444444\n'; sleep "${RUN_SLEEP_BAD:-3}" ;;
    tasks/W3.09.md) printf 'Run: run-bbbbbbbb-2222-4222-8222-222222222222\n'; sleep "${RUN_SLEEP_GOOD:-0.5}" ;;
    tasks/W3.10.md) printf 'Run: run-cccccccc-3333-4333-8333-333333333333\n'; sleep "${RUN_SLEEP_GOOD:-0.5}" ;;
  esac
  exit 0
fi
if [ "${1:-}" = "workflow" ] && [ "${2:-}" = "status" ]; then
  case "${3:-}" in
    run-aaaaaaaa-1111-4111-8111-111111111111)
      printf 'no such column: ceiling_expiry_count\n'
      exit 0
      ;;
    run-dddddddd-4444-4222-8222-444444444444)
      printf 'no such column: ceiling_expiry_count\n' >&2
      exit 1
      ;;
    run-bbbbbbbb-2222-4222-8222-222222222222)
      printf '{"runId":"%s","status":"completed","tokensSpent":0,"steps":[]}\n' "${3:-}"
      exit 0
      ;;
    run-cccccccc-3333-4333-8333-333333333333)
      count_file="$STATUS_COUNT_DIR/transient"
      count=0
      [ ! -f "$count_file" ] || count="$(cat "$count_file")"
      count=$((count + 1))
      printf '%s' "$count" > "$count_file"
      if [ "$count" -le 2 ]; then
        printf 'no such column: ceiling_expiry_count\n'
        exit 0
      fi
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

# run_case <manifest> -> sets CONTROLLER_STATUS, CONTROLLER_OUTPUT,
# CONTROLLER_CAMPAIGN (dir under RESULTS)
run_case() {
  local manifest="$1"
  local before
  before="$(mktemp)"
  ls -1 "$RESULTS" 2>/dev/null | grep '^campaign-' | sort > "$before" || true
  set +e
  CONTROLLER_OUTPUT="$(env PATH="$STUB_DIR:$PATH" STATUS_COUNT_DIR="$STATUS_COUNT_DIR" \
    TT_CONTROLLER_PREFLIGHT_DISABLED=1 \
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

# ── AC1/AC2/AC3: bad status fails closed, controller survives, campaign continues ──
run_case "$TEST_ROOT/manifests/campaign1.jsonl"
# AC2: the controller does not crash — it exits with the normal campaign-report
# exit code for an infra-failed campaign (2 = INFRA_FAILURE) and its output
# carries no raw SyntaxError stack.
[ "$CONTROLLER_STATUS" -eq 2 ] \
  || fail "campaign exited $CONTROLLER_STATUS instead of the campaign-report 2 (INFRA_FAILURE): $CONTROLLER_OUTPUT"
case "$CONTROLLER_OUTPUT" in
  *SyntaxError*) fail "controller output leaked a raw SyntaxError: $CONTROLLER_OUTPUT" ;;
esac
node --input-type=module - "$RESULTS/$CONTROLLER_CAMPAIGN/state.json" <<'NODE'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const bad = state.cases.find((c) => c.id === 'STATUS-RESILIENCE-BAD');
if (!bad || bad.phase !== 'terminal' || bad.outcome !== 'TEST_INFRA_FAIL'
    || bad.reason?.category !== 'workflow-status-query-failed') {
  throw new Error(`non-JSON status did not fail the case closed TEST_INFRA_FAIL workflow-status-query-failed: ${JSON.stringify(bad)}`);
}
if (!JSON.stringify(bad.reason).includes('no such column: ceiling_expiry_count')) {
  throw new Error(`workflow-status-query-failed reason lacks the raw error text: ${JSON.stringify(bad.reason)}`);
}
const badAttempt = bad.attempts.at(-1);
if (!badAttempt || badAttempt.phase !== 'terminal' || badAttempt.status_query_error?.kind !== 'non-json'
    || !JSON.stringify(badAttempt.status_query_error).includes('no such column: ceiling_expiry_count')) {
  throw new Error(`attempt status_query_error evidence is missing or misclassified: ${JSON.stringify(badAttempt?.status_query_error)}`);
}
const badExit = state.cases.find((c) => c.id === 'STATUS-RESILIENCE-EXIT');
if (!badExit || badExit.phase !== 'terminal' || badExit.outcome !== 'TEST_INFRA_FAIL'
    || badExit.reason?.category !== 'workflow-status-query-failed'
    || badExit.reason?.kind !== 'exit-nonzero'
    || badExit.reason?.exit_code !== 1
    || !JSON.stringify(badExit.reason).includes('no such column: ceiling_expiry_count')) {
  throw new Error(`exit-nonzero status did not fail closed with kind/exit_code/raw text: ${JSON.stringify(badExit?.reason)}`);
}
// AC3: the healthy case in the SAME campaign still executes and completes.
const good = state.cases.find((c) => c.id === 'STATUS-RESILIENCE-GOOD');
if (!good || good.phase !== 'terminal' || good.outcome !== 'PASS') {
  throw new Error(`healthy case did not complete PASS in the same campaign: ${JSON.stringify(good)}`);
}
NODE
pass "non-JSON + exit-nonzero status outputs fail their cases closed TEST_INFRA_FAIL workflow-status-query-failed (raw text captured); controller survives (no SyntaxError); healthy case still PASSes in the same campaign"

# ── AC4: a status stub that fails fewer than the retry bound then succeeds ──
run_case "$TEST_ROOT/manifests/campaign2.jsonl"
[ "$CONTROLLER_STATUS" -eq 0 ] \
  || fail "transient-failure campaign exited $CONTROLLER_STATUS instead of 0 (GREEN): $CONTROLLER_OUTPUT"
transient_count=0
[ ! -f "$STATUS_COUNT_DIR/transient" ] || transient_count="$(cat "$STATUS_COUNT_DIR/transient")"
[ "$transient_count" -ge 3 ] \
  || fail "transient stub was not retried (status invocations = $transient_count, expected >= 3): $CONTROLLER_OUTPUT"
node --input-type=module - "$RESULTS/$CONTROLLER_CAMPAIGN/state.json" <<'NODE'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const item = state.cases.find((c) => c.id === 'STATUS-RESILIENCE-TRANSIENT');
if (!item || item.phase !== 'terminal' || item.outcome !== 'PASS') {
  throw new Error(`transient status failures were not absorbed by the bounded retries: ${JSON.stringify(item)}`);
}
NODE
pass "status stub failing 2x then succeeding is absorbed by the bounded retries; the case completes PASS"

# Hygiene: preflight disabled => no real daemon/43xx ports touched; nothing leaked.
pass "S16 US-003 controller status-query resilience self-test complete"
