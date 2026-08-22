#!/usr/bin/env bash
# tt-controller-deadline-sweep.test.sh — US-005 controller deadline-expiry
# sweep.
#
# Verifies that the independent deadline sweep terminally records any WORKFLOW
# attempt whose deadline_at expired — even when its monitor loop is degraded
# or the controller crashed mid-campaign (campaign #8 attempt-2 left
# W1.L3-python phase=running 3.5h past its 16:46Z 20-min deadline with the run
# completed and nobody watching):
#   * AC1. A fixture campaign state (case phase 'running', attempt deadline_at
#     in the past — the exact attempt-2 leftover shape) is swept on the RESUME
#     path: state.json records the attempt terminal with outcome
#     TEST_INFRA_FAIL and reason.category 'deadline-expired', with evidence
#     { deadline_at, expired_for_seconds, run_id, observed_at }.
#   * AC2. A case whose deadline_at is in the FUTURE is untouched by the sweep
#     and a healthy campaign still completes with unchanged outcomes.
#   * AC3. With a stub 'workflow status' that hangs (bounded, longer than the
#     deadline) for a run whose deadline expires mid-campaign, the sweep still
#     terminally records the case on its independent cadence
#     (TT_CONTROLLER_DEADLINE_SWEEP_INTERVAL_MS) — the monitor's status poll
#     is not required.
#   * AC4. A failing 'workflow stop' stub does not prevent the terminal record
#     and does not crash the controller (best-effort stop).
#   * AC5. The healthy tt-controller.test.sh battery still completes with
#     unchanged outcomes (run separately, serially).
#
# The launches are driven by a deterministic `tamandua` stub on PATH (zero
# real tokens, no model). The real-case campaign preflight (US-004) is
# disabled via TT_CONTROLLER_PREFLIGHT_DISABLED=1. The real contained spawn
# env (var/home) is used by the hermes cases; its workflow database is backed
# up + seeded with an empty runs table (the discovered-run reconciliation
# reads it) and restored in cleanup — exactly like the status-resilience test.
#
# This is NOT part of `npm test` (torture-test/.sh self-tests are standalone).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TT_DIR="$(dirname "$SCRIPT_DIR")"
CONTROLLER="$SCRIPT_DIR/tt-controller"
RESULTS="$TT_DIR/var/results"
mkdir -p "$RESULTS"

TEST_ROOT="$(mktemp -d "$TT_DIR/var/controller-deadline-sweep.XXXXXX")"
STUB_DIR="$TEST_ROOT/stubs"
mkdir -p "$STUB_DIR" "$TEST_ROOT/manifests"

HOST_PROFILE="$TT_DIR/var/w0/host-profile.json"
HOST_PROFILE_BACKUP="$TEST_ROOT/original-host-profile.json"
mkdir -p "$(dirname "$HOST_PROFILE")"
if [ -f "$HOST_PROFILE" ]; then cp "$HOST_PROFILE" "$HOST_PROFILE_BACKUP"; fi

# The hermes (real-env) cases read the contained workflow database for
# discovered-run reconciliation; back it up (incl. WAL side files) and seed an
# empty runs table so the healthy case completes instead of failing on a
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
  || fail "could not bootstrap the tt-ts golden for the deadline-sweep test"

# Deterministic real workflow cases (fixture tt-ts golden exists).
#   DEADLINE-SWEEP-MIDFLIGHT -> `workflow status` HANGS (bounded sleep longer
#                               than the deadline) so the monitor's status poll
#                               is effectively stuck while the deadline expires
#                               mid-campaign; the independent sweep must still
#                               terminally record the case (AC3).
#   DEADLINE-SWEEP-FUTURE    -> healthy control: status returns valid JSON
#                               immediately, deadline far in the future; the
#                               sweep must NOT touch it and the case completes
#                               PASS (AC2).
cat > "$TEST_ROOT/manifests/campaign-midflight.jsonl" <<'M'
{"id":"DEADLINE-SWEEP-MIDFLIGHT","wave":0,"workflow":"bug-fix-merge-worktree","fixture":"tt-ts","harness":"hermes","task":"tasks/W3.20.md","context":{},"caps":{"tokens":4000000,"wall_min":0.05},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
M

cat > "$TEST_ROOT/manifests/campaign-future.jsonl" <<'M'
{"id":"DEADLINE-SWEEP-FUTURE","wave":0,"workflow":"bug-fix-merge-worktree","fixture":"tt-ts","harness":"hermes","task":"tasks/W3.21.md","context":{},"caps":{"tokens":4000000,"wall_min":240},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
M

# ── AC1/AC4 fixture: a campaign state with a case phase 'running' and an
# attempt whose deadline_at is in the past (the exact campaign-#8 attempt-2
# leftover shape). The stub `workflow stop` FAILS (exit 1) so the best-effort
# stop is proven not to prevent the terminal record / crash the controller.
# ────────────────────────────────────────────────────────────────────────────
FIXTURE_MANIFEST="$TEST_ROOT/manifests/fixture-leftover.jsonl"
cat > "$FIXTURE_MANIFEST" <<'M'
{"id":"DEADLINE-SWEEP-LEFTOVER","wave":0,"workflow":"bug-fix-merge-worktree","fixture":"tt-ts","harness":"hermes","task":"tasks/W3.22.md","context":{},"caps":{"tokens":4000000,"wall_min":240},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
M

# ISO-8601 timestamps: deadline 10 minutes in the past, started 15 minutes ago.
PAST_DEADLINE="$(node -e 'process.stdout.write(new Date(Date.now() - 10*60*1000).toISOString())')"
PAST_STARTED="$(node -e 'process.stdout.write(new Date(Date.now() - 15*60*1000).toISOString())')"
MANIFEST_SHA="$(sha256sum "$FIXTURE_MANIFEST" | cut -d' ' -f1)"
# state.manifest.path is relative to TT_ROOT (the torture-test/ dir).
FIXTURE_MANIFEST_REL="${FIXTURE_MANIFEST#"$TT_DIR"/}"
FIXTURE_CAMPAIGN="campaign-deadline-sweep-fixture"
FIXTURE_DIR="$RESULTS/$FIXTURE_CAMPAIGN"
rm -rf -- "$FIXTURE_DIR"
mkdir -p "$FIXTURE_DIR"
printf '%s\n' "$FIXTURE_DIR" >> "$CAMPAIGNS"
cat > "$FIXTURE_DIR/state.json" <<JSON
{
  "version": 1,
  "campaign_id": "$FIXTURE_CAMPAIGN",
  "phase": "ready",
  "created_at": "$PAST_STARTED",
  "updated_at": "$PAST_STARTED",
  "resume_count": 0,
  "resumed_at": [],
  "real_preflight": null,
  "options": {
    "concurrency": 1,
    "stagger_ms": 0,
    "token_poll_interval_ms": 20,
    "cap_check_interval_ms": 20,
    "provider_retry_backoff_ms": 0,
    "execution_selection": "all"
  },
  "spend": { "tokens_observed": 0, "observations": [] },
  "discovered_runs": [],
  "manifest": {
    "path": "$FIXTURE_MANIFEST_REL",
    "sha256": "$MANIFEST_SHA",
    "case_count": 1,
    "case_ids": ["DEADLINE-SWEEP-LEFTOVER"]
  },
  "cases": [
    {
      "id": "DEADLINE-SWEEP-LEFTOVER",
      "wave": 0,
      "workflow": "bug-fix-merge-worktree",
      "fixture": "tt-ts",
      "harness": "hermes",
      "class": "verification",
      "replay_of": null,
      "production_duration_floor_ms": null,
      "expected_fast_failure": false,
      "phase": "running",
      "attempts": [
        {
          "id": "attempt-1",
          "case_id": "DEADLINE-SWEEP-LEFTOVER",
          "kind": "workflow",
          "phase": "running",
          "execution_mode": "real",
          "launch_intent_at": "$PAST_STARTED",
          "started_at": "$PAST_STARTED",
          "deadline_at": "$PAST_DEADLINE",
          "run_id": "run-aaaaaaaa-1111-4111-8111-111111111111"
        }
      ],
      "findings": [],
      "oracle_results": [],
      "spend": { "tokens_observed": 0, "observations": [] }
    }
  ]
}
JSON

# ── AC4 stub: `workflow stop` FAILS (exit 1, stderr) — best-effort stop must
# never prevent the terminal record and never crash the controller. Every
# other call is a no-op success (the resume path launches nothing).
cat > "$STUB_DIR/tamandua" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
if [ "${1:-}" = "workflow" ] && [ "${2:-}" = "stop" ]; then
  printf 'workflow stop failed (AC4 best-effort stub)\n' >&2
  exit 1
fi
exit 0
STUB
chmod +x "$STUB_DIR/tamandua"

set +e
FIXTURE_OUTPUT="$(env PATH="$STUB_DIR:$PATH" \
  TT_CONTROLLER_PREFLIGHT_DISABLED=1 \
  TT_CONTROLLER_DEADLINE_SWEEP_INTERVAL_MS=100 \
  "$CONTROLLER" --resume "$FIXTURE_CAMPAIGN" 2>&1)"
FIXTURE_STATUS=$?
set -e
# AC4: exit 2 (INFRA_FAILURE campaign report) — the controller did NOT crash.
[ "$FIXTURE_STATUS" -eq 2 ] \
  || fail "resume of the deadline-expired leftover exited $FIXTURE_STATUS instead of 2 (INFRA_FAILURE): $FIXTURE_OUTPUT"
node --input-type=module - "$FIXTURE_DIR/state.json" "$PAST_DEADLINE" <<'NODE'
import fs from 'node:fs';
const [statePath, pastDeadline] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const item = state.cases.find((c) => c.id === 'DEADLINE-SWEEP-LEFTOVER');
if (!item || item.phase !== 'terminal' || item.outcome !== 'TEST_INFRA_FAIL'
    || item.reason?.category !== 'deadline-expired') {
  throw new Error(`deadline-expired leftover was not swept terminal TEST_INFRA_FAIL deadline-expired: ${JSON.stringify(item)}`);
}
const reason = item.reason;
if (reason.deadline_at !== pastDeadline) {
  throw new Error(`deadline-expired evidence lacks the original deadline_at: ${JSON.stringify(reason)}`);
}
if (typeof reason.expired_for_seconds !== 'number' || reason.expired_for_seconds < 1
    || !Number.isSafeInteger(reason.expired_for_seconds)) {
  throw new Error(`deadline-expired evidence lacks a positive integer expired_for_seconds: ${JSON.stringify(reason)}`);
}
if (reason.run_id !== 'run-aaaaaaaa-1111-4111-8111-111111111111') {
  throw new Error(`deadline-expired evidence lacks the run_id: ${JSON.stringify(reason)}`);
}
if (typeof reason.observed_at !== 'string' || !reason.observed_at.endsWith('Z')) {
  throw new Error(`deadline-expired evidence lacks observed_at: ${JSON.stringify(reason)}`);
}
const attempt = item.attempts.at(-1);
if (!attempt || attempt.phase !== 'terminal' || attempt.outcome !== 'TEST_INFRA_FAIL'
    || attempt.terminal_at === undefined
    || attempt.classification_reason?.category !== 'deadline-expired') {
  throw new Error(`swept attempt is not terminal TEST_INFRA_FAIL deadline-expired: ${JSON.stringify(attempt)}`);
}
// AC4: the best-effort stop WAS attempted (hook state recorded synchronously
// by runHook) even though the stub fails — the terminal record still landed.
if (attempt['deadline_stop_attempt-1'] === undefined) {
  throw new Error(`best-effort deadline stop was not recorded on the attempt: ${JSON.stringify(attempt)}`);
}
NODE
pass "AC1+AC4: resume sweeps the deadline-expired leftover terminal TEST_INFRA_FAIL deadline-expired (evidence deadline_at/expired_for_seconds/run_id/observed_at) despite a failing workflow stop stub; controller exits the normal INFRA_FAILURE code (no crash)"

# ── AC3 stub: `workflow run` emits a run id and settles after 2s; `workflow
# status` HANGS (bounded 6s sleep — longer than the 3s deadline) then returns
# 'running', so the monitor's status poll is effectively stuck while the
# deadline expires; `workflow stop` is a no-op success. The independent sweep
# (100ms cadence) must terminally record the case WITHOUT the monitor's status
# poll.
RUN_SLEEP=2
STATUS_HANG_SLEEP=6
cat > "$STUB_DIR/tamandua" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
if [ "${1:-}" = "workflow" ] && [ "${2:-}" = "run" ]; then
  case "${5:-}" in
    tasks/W3.20.md) printf 'Run: run-eeeeeeee-5555-4555-8555-555555555555\n'; sleep "${RUN_SLEEP:-2}" ;;
    tasks/W3.21.md) printf 'Run: run-ffffffff-6666-4666-8666-666666666666\n'; sleep 0.5 ;;
  esac
  exit 0
fi
if [ "${1:-}" = "workflow" ] && [ "${2:-}" = "status" ]; then
  case "${3:-}" in
    run-eeeeeeee-5555-4555-8555-555555555555)
      # Bounded hang: sleeps LONGER than the case deadline (3s) so the
      # monitor's first status poll blocks past the deadline. The sweep fires
      # on its own cadence the moment the poll returns.
      sleep "${STATUS_HANG_SLEEP:-6}"
      printf '{"runId":"%s","status":"running","tokensSpent":0,"steps":[]}\n' "${3:-}"
      exit 0
      ;;
    *)
      printf '{"runId":"%s","status":"completed","tokensSpent":0,"steps":[]}\n' "${3:-}"
      exit 0
      ;;
  esac
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
  CONTROLLER_OUTPUT="$(env PATH="$STUB_DIR:$PATH" RUN_SLEEP="$RUN_SLEEP" STATUS_HANG_SLEEP="$STATUS_HANG_SLEEP" \
    TT_CONTROLLER_PREFLIGHT_DISABLED=1 \
    TT_CONTROLLER_POLL_INTERVAL_MS=20 TT_CONTROLLER_CAP_CHECK_INTERVAL_MS=20 \
    TT_CONTROLLER_DEADLINE_SWEEP_INTERVAL_MS=100 \
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

# ── AC3: deadline expires mid-campaign; the independent sweep records it ──
run_case "$TEST_ROOT/manifests/campaign-midflight.jsonl"
[ "$CONTROLLER_STATUS" -eq 2 ] \
  || fail "midflight deadline-expired campaign exited $CONTROLLER_STATUS instead of 2 (INFRA_FAILURE): $CONTROLLER_OUTPUT"
node --input-type=module - "$RESULTS/$CONTROLLER_CAMPAIGN/state.json" <<'NODE'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const item = state.cases.find((c) => c.id === 'DEADLINE-SWEEP-MIDFLIGHT');
if (!item || item.phase !== 'terminal' || item.outcome !== 'TEST_INFRA_FAIL'
    || item.reason?.category !== 'deadline-expired') {
  throw new Error(`midflight deadline-expired case was not swept terminal TEST_INFRA_FAIL deadline-expired: ${JSON.stringify(item)}`);
}
if (typeof item.reason?.deadline_at !== 'string'
    || typeof item.reason?.expired_for_seconds !== 'number'
    || item.reason?.run_id !== 'run-eeeeeeee-5555-4555-8555-555555555555'
    || typeof item.reason?.observed_at !== 'string') {
  throw new Error(`midflight deadline-expired evidence is incomplete: ${JSON.stringify(item.reason)}`);
}
NODE
pass "AC3: mid-campaign deadline expiry is terminally recorded by the independent sweep (monitor's status poll hung past the deadline)"

# ── AC2: a future deadline is untouched; the healthy campaign completes ──
run_case "$TEST_ROOT/manifests/campaign-future.jsonl"
[ "$CONTROLLER_STATUS" -eq 0 ] \
  || fail "healthy future-deadline campaign exited $CONTROLLER_STATUS instead of 0 (GREEN): $CONTROLLER_OUTPUT"
node --input-type=module - "$RESULTS/$CONTROLLER_CAMPAIGN/state.json" <<'NODE'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const item = state.cases.find((c) => c.id === 'DEADLINE-SWEEP-FUTURE');
if (!item || item.phase !== 'terminal' || item.outcome !== 'PASS') {
  throw new Error(`healthy future-deadline case did not complete PASS: ${JSON.stringify(item)}`);
}
if (JSON.stringify(item).includes('deadline-expired')) {
  throw new Error(`healthy case was touched by the deadline sweep: ${JSON.stringify(item)}`);
}
const attempt = item.attempts.at(-1);
if (!attempt || attempt.outcome !== 'PASS') {
  throw new Error(`healthy attempt did not complete PASS: ${JSON.stringify(attempt)}`);
}
NODE
pass "AC2: a future deadline is untouched by the sweep; the healthy campaign completes PASS"

# Hygiene: preflight disabled => no real daemon/43xx ports touched; nothing leaked.
pass "US-005 deadline-expiry sweep self-test complete"
