#!/usr/bin/env bash
# tt-daemon-up-schema.test.sh — self-test for the S15 US-002 schema-handshake
# parity leg of tt-daemon-up (the contained TT daemon preflight helper).
#
# Verifies that ensure-up NEVER reuses a contained daemon whose DB does not
# satisfy the SQL surface tt-controller's status queries depend on (the
# runs/steps columns its SELECTs carry, e.g. ceiling_expiry_count):
#   AC1. (red) an already-UP daemon with a stale-schema fixture DB (missing
#        runs.ceiling_expiry_count, injected via the TT_DAEMON_SCHEMA_PROBE_DB
#        seam) is NEVER silently reused: the guard intercepts BEFORE the
#        no-op reuse branch, restarts the daemon, re-probes, and FAILS CLOSED
#        with REASON: tt-daemon-stale on stderr, DETAILS naming the missing
#        column, exit non-zero and no 'TT_DAEMON: up' line
#   AC2. (green) a full-schema fixture DB (via the same seam) over an
#        already-UP daemon is an idempotent no-op ('already UP', exit 0,
#        'TT_DAEMON: up') — the daemon is reused
#   AC3. the probe is READ-ONLY: the fixture DB bytes are unchanged after
#        ensure-up runs against them (sha256 before == sha256 after), and no
#        -wal/-shm/-journal side files appear
#   AC4. (containment) a DB path outside torture-test/var is rejected by the
#        probe (REASON: containment-violation, exit 2) — never probed
#   AC5. the TT_DAEMON_SCHEMA_PROBE_COLUMNS_FILE seam drives the probe: a
#        required-columns JSON naming a missing column / missing table makes
#        the probe report exactly that item
#   AC6. (down-daemon path) ensure-up with the daemon down and a stale-schema
#        fixture starts the daemon, probes the schema AFTER the start, and
#        fails closed tt-daemon-stale (no TT_DAEMON: up)
#   AC7. operator ~/.tamandua and the 33xx production ports are untouched;
#        final sweep leaves the 43xx contained ports free
#
# Standalone: bash torture-test/bin/tt-daemon-up-schema.test.sh
# Not part of `npm test`. Zero tokens; the real contained daemon (43xx) is
# managed ONLY via daemon-control; the live 33xx daemon is never touched.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TT_DIR="$(dirname "$SCRIPT_DIR")"
TT_REPO_ROOT="$(dirname "$TT_DIR")"
HELPER="$SCRIPT_DIR/tt-daemon-up"
PROBE="$SCRIPT_DIR/tt-schema-probe.mjs"
DC="$SCRIPT_DIR/daemon-control"
PROV_FILE="$TT_REPO_ROOT/torture-test/var/daemon-control/real.json"

PASS=0
FAIL=0
TMP="$(mktemp -d "${TMPDIR:-/tmp}/tt-daemon-up-schema.test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

ok()   { PASS=$((PASS + 1)); printf 'ok   - %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL - %s\n' "$*"; }

REAL_PORTS="4334 4338 4339"
PROD_PORTS="3334 3338 3339"

# ── Guard: needs the repo dist build (daemon-control launches real tamandua) ──
if [ ! -f "$TT_REPO_ROOT/dist/cli/cli.js" ] || [ -z "$(cat "$TT_REPO_ROOT/dist/version" 2>/dev/null | tr -d '[:space:]')" ]; then
  echo "SKIP: repo dist build missing — run ./build first" >&2
  exit 0
fi

port_state() { # args: ports...
  local s=""
  for p in "$@"; do
    if timeout 1 bash -c "echo >/dev/tcp/localhost/$p" 2>/dev/null; then s="$s:$p=L"; else s="$s:$p=F"; fi
  done
  printf '%s' "$s"
}

# ── Fixture DBs (stale-schema + full-schema) INSIDE torture-test/var ────
# The probe's containment guard rejects DB paths outside var, so the fixture
# dir lives under var (gitignored, cleaned by the trap) — the real contained
# DB at var/home/.tamandua/tamandua.db is never touched.
FIXTURE_DIR="$(mktemp -d "$TT_REPO_ROOT/torture-test/var/tt-schema-fixture.XXXXXX")"
STALE_DB="$FIXTURE_DIR/stale.db"
FULL_DB="$FIXTURE_DIR/full.db"

make_fixture_db() { # path with_ceiling(0|1)
  # NOTE: with `node -e`, process.argv[1] is the FIRST argument after the
  # script text (there is no argv slot for the script itself) — so the DB
  # path is argv[1] and the with_ceiling flag is argv[2] (slice(1)).
  node -e '
    const { DatabaseSync } = require("node:sqlite");
    const [dbPath, withCeiling] = process.argv.slice(1);
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, run_number INTEGER, workflow_id TEXT, task TEXT, status TEXT, context TEXT, created_at TEXT, updated_at TEXT, tokens_spent INTEGER, worker_lost_count INTEGER"
      + (withCeiling === "1" ? ", ceiling_expiry_count INTEGER" : "") + ")");
    db.exec("CREATE TABLE steps (step_id TEXT PRIMARY KEY, agent_id TEXT, step_index INTEGER, status TEXT, type TEXT, current_story_id TEXT, retry_count INTEGER, abandoned_count INTEGER, reroute_count INTEGER, claim_pid INTEGER, claim_updated_at TEXT, updated_at TEXT)");
    db.close();
  ' "$1" "$2"
}
make_fixture_db "$STALE_DB" 0
make_fixture_db "$FULL_DB" 1

sha256_of() { sha256sum "$1" 2>/dev/null | awk '{print $1}'; }
STALE_HASH_BEFORE="$(sha256_of "$STALE_DB")"
FULL_HASH_BEFORE="$(sha256_of "$FULL_DB")"

# Snapshot operator state we must NOT touch.
OPERATOR_CATALOG="${HOME}/.tamandua/workflows"
operator_snapshot() {
  if [ -d "$OPERATOR_CATALOG" ]; then
    ( cd "$OPERATOR_CATALOG" && { ls -1; [ -f .catalog-version.json ] && cat .catalog-version.json; } 2>/dev/null | sort ) || true
  else
    echo "(no operator catalog)"
  fi
}
OP_BEFORE="$(operator_snapshot)"
PROD_BEFORE="$(port_state $PROD_PORTS)"

# ── Start from a deterministic "daemon down" baseline ───────────────────
set +e
"$DC" real stop >/dev/null 2>&1
sleep 1
set -e

# ── AC4 (containment): a DB path outside torture-test/var is rejected ──
set +e
CONT_OUT="$(TT_DAEMON_SCHEMA_PROBE_DB="$TMP/outside-$$.db" node "$PROBE" 2>&1)"; CONT_RC=$?
set -e
if [ "$CONT_RC" -eq 2 ]; then
  ok "AC4 probe rejects a DB path outside torture-test/var (exit 2)"
else
  fail "AC4 containment guard exit code (got rc=$CONT_RC, want 2)"
fi
if echo "$CONT_OUT" | grep -q "REASON: containment-violation"; then
  ok "AC4 probe emits REASON: containment-violation"
else
  fail "AC4 missing REASON: containment-violation"; echo "$CONT_OUT" | head -4
fi
if echo "$CONT_OUT" | grep -q "DETAILS:"; then
  ok "AC4 probe DETAILS names the rejected path"
else
  fail "AC4 missing DETAILS"
fi
# The rejected DB must never have been opened/created.
if [ ! -e "$TMP/outside-$$.db" ]; then
  ok "AC4 rejected path was never created/opened"
else
  fail "AC4 rejected DB path was touched"
fi

# ── AC5 (columns-file seam): the probe honors the required-columns JSON ──
printf '%s\n' '{"runs": ["id", "ceiling_expiry_count", "bogus_col"], "steps": ["step_id"]}' > "$TMP/cols-bogus.json"
set +e
COLS_OUT="$(TT_DAEMON_SCHEMA_PROBE_DB="$FULL_DB" TT_DAEMON_SCHEMA_PROBE_COLUMNS_FILE="$TMP/cols-bogus.json" node "$PROBE" 2>&1)"; COLS_RC=$?
set -e
if [ "$COLS_RC" -ne 0 ] && echo "$COLS_OUT" | grep -q "missing column: runs.bogus_col"; then
  ok "AC5 columns-file seam: probe reports the injected missing column (runs.bogus_col)"
else
  fail "AC5 columns-file missing-column arm (rc=$COLS_RC)"; echo "$COLS_OUT" | head -4
fi
printf '%s\n' '{"ghost_table": ["id"]}' > "$TMP/cols-ghost.json"
set +e
GHOST_OUT="$(TT_DAEMON_SCHEMA_PROBE_DB="$FULL_DB" TT_DAEMON_SCHEMA_PROBE_COLUMNS_FILE="$TMP/cols-ghost.json" node "$PROBE" 2>&1)"; GHOST_RC=$?
set -e
if [ "$GHOST_RC" -ne 0 ] && echo "$GHOST_OUT" | grep -q "missing table: ghost_table"; then
  ok "AC5 columns-file seam: probe reports the injected missing table (ghost_table)"
else
  fail "AC5 columns-file missing-table arm (rc=$GHOST_RC)"; echo "$GHOST_OUT" | head -4
fi
# The full fixture alone (default required columns) must PASS — sanity for
# the green arm's fixture.
set +e
FULL_OUT="$(TT_DAEMON_SCHEMA_PROBE_DB="$FULL_DB" node "$PROBE" 2>&1)"; FULL_RC=$?
set -e
if [ "$FULL_RC" -eq 0 ] && echo "$FULL_OUT" | grep -q "^SCHEMA: ok"; then
  ok "AC5 full-schema fixture passes the default probe (SCHEMA: ok)"
else
  fail "AC5 full fixture should pass (rc=$FULL_RC)"; echo "$FULL_OUT" | head -4
fi

# ── Bring the REAL contained daemon up (matching build + adapters-bin) ──
# S15 US-001: prepend the worktree's own bin/ so the contained daemon runs
# THIS tree's build and the build-version parity guard matches
# deterministically (see tt-daemon-up.test.sh AC2 note).
set +e
ENSURE_OUT="$(PATH="$TT_REPO_ROOT/bin:$PATH" "$HELPER" ensure-up 2>&1)"; ENSURE_RC=$?
set -e
if [ "$ENSURE_RC" -eq 0 ] && echo "$ENSURE_OUT" | grep -q "TT_DAEMON: up"; then
  ok "baseline ensure-up brings the real daemon up (schema probe passed on the real DB)"
else
  fail "baseline ensure-up rc=$ENSURE_RC"; echo "$ENSURE_OUT" | tail -8
fi
STATE_DIR_LINE="$(env -i bash "$TT_REPO_ROOT/torture-test/env/tt-env.sh" print 2>/dev/null | grep '^TAMANDUA_STATE_DIR=' | head -n1)"
STATE_DIR="${STATE_DIR_LINE#TAMANDUA_STATE_DIR=}"

# ── AC1 (S15 US-002 red): a stale-schema DB is NEVER silently reused ────
# The daemon is UP with the matching build + adapters-bin + real DB (full
# schema). Inject the stale-schema fixture via the TT_DAEMON_SCHEMA_PROBE_DB
# seam: the OLD pre-guard code would have taken the 'already UP -> no-op'
# branch and silently reused the daemon against an unmigrated DB (campaign #8
# attempt-2 controller crash at the first status poll); the guard must
# instead intercept, restart, re-probe, and FAIL CLOSED with tt-daemon-stale.
SCHEMA_PID_BEFORE=""
if [ -n "$STATE_DIR" ] && [ -f "$STATE_DIR/tamandua.pid" ]; then
  SCHEMA_PID_BEFORE="$(cat "$STATE_DIR/tamandua.pid")"
fi
set +e
STALE_OUT="$(PATH="$TT_REPO_ROOT/bin:$PATH" TT_DAEMON_SCHEMA_PROBE_DB="$STALE_DB" "$HELPER" ensure-up 2>&1)"; STALE_RC=$?
set -e
if [ "$STALE_RC" -ne 0 ]; then
  ok "AC1 stale-schema DB exits non-zero (rc=$STALE_RC)"
else
  fail "AC1 stale-schema DB should exit non-zero"
  echo "$STALE_OUT" | tail -8
fi
if echo "$STALE_OUT" | grep -q "REASON: tt-daemon-stale"; then
  ok "AC1 failure emits distinct reason tt-daemon-stale"
else
  fail "AC1 missing REASON: tt-daemon-stale"; echo "$STALE_OUT" | grep -E 'REASON|DETAILS' || true
fi
if echo "$STALE_OUT" | grep -q "ceiling_expiry_count"; then
  ok "AC1 DETAILS name the missing column (runs.ceiling_expiry_count)"
else
  fail "AC1 DETAILS missing the column name"; echo "$STALE_OUT" | grep 'DETAILS' || true
fi
if echo "$STALE_OUT" | grep -q "TT_DAEMON: up"; then
  fail "AC1 stale guard must NOT print TT_DAEMON: up"
else
  ok "AC1 no 'TT_DAEMON: up' on schema fail-closed"
fi
if echo "$STALE_OUT" | grep -q "already UP"; then
  fail "AC1 guard must intercept BEFORE the no-op reuse branch"
else
  ok "AC1 guard intercepted before the no-op reuse branch"
fi
if echo "$STALE_OUT" | grep -q "schema-handshake parity: FAIL"; then
  ok "AC1 schema probe ran and reported the parity failure"
else
  fail "AC1 missing schema-handshake parity failure log"; echo "$STALE_OUT" | grep -i 'schema' || true
fi
SCHEMA_PID_AFTER=""
if [ -n "$STATE_DIR" ] && [ -f "$STATE_DIR/tamandua.pid" ]; then
  SCHEMA_PID_AFTER="$(cat "$STATE_DIR/tamandua.pid")"
fi
if [ -n "$SCHEMA_PID_BEFORE" ] && [ -n "$SCHEMA_PID_AFTER" ] && [ "$SCHEMA_PID_BEFORE" != "$SCHEMA_PID_AFTER" ]; then
  ok "AC1 guard RESTARTED the daemon (pid $SCHEMA_PID_BEFORE -> $SCHEMA_PID_AFTER)"
else
  fail "AC1 daemon not restarted by the guard (pid $SCHEMA_PID_BEFORE -> ${SCHEMA_PID_AFTER:-none})"
fi

# ── AC3 (read-only probe): fixture DB bytes unchanged, no side files ────
STALE_HASH_AFTER="$(sha256_of "$STALE_DB")"
if [ -n "$STALE_HASH_BEFORE" ] && [ "$STALE_HASH_BEFORE" = "$STALE_HASH_AFTER" ]; then
  ok "AC3 stale fixture DB bytes unchanged after ensure-up (sha256 stable)"
else
  fail "AC3 stale fixture DB changed ($STALE_HASH_BEFORE -> $STALE_HASH_AFTER)"
fi
if [ -z "$(ls -A "$FIXTURE_DIR" 2>/dev/null | grep -E '\.(wal|shm|journal)$' || true)" ]; then
  ok "AC3 probe left no -wal/-shm/-journal side files"
else
  fail "AC3 probe created side files: $(ls -A "$FIXTURE_DIR" | grep -E '\.(wal|shm|journal)$' || true)"
fi

# ── AC2 (S15 US-002 green): a full-schema DB is an idempotent no-op ─────
FULL_HASH_BEFORE2="$(sha256_of "$FULL_DB")"
set +e
GREEN_OUT="$(PATH="$TT_REPO_ROOT/bin:$PATH" TT_DAEMON_SCHEMA_PROBE_DB="$FULL_DB" "$HELPER" ensure-up 2>&1)"; GREEN_RC=$?
set -e
if [ "$GREEN_RC" -eq 0 ] && echo "$GREEN_OUT" | grep -q "already UP"; then
  ok "AC2 full-schema DB is an idempotent no-op (already UP, daemon reused)"
else
  fail "AC2 green no-op (rc=$GREEN_RC)"; echo "$GREEN_OUT" | tail -6
fi
if echo "$GREEN_OUT" | grep -q "TT_DAEMON: up"; then
  ok "AC2 green no-op reports TT_DAEMON: up"
else
  fail "AC2 green no-op missing TT_DAEMON: up"
fi
GREEN_PID=""
if [ -n "$STATE_DIR" ] && [ -f "$STATE_DIR/tamandua.pid" ]; then
  GREEN_PID="$(cat "$STATE_DIR/tamandua.pid")"
fi
if [ -n "$SCHEMA_PID_AFTER" ] && [ -n "$GREEN_PID" ] && [ "$SCHEMA_PID_AFTER" = "$GREEN_PID" ]; then
  ok "AC2 daemon was NOT restarted (same pid $GREEN_PID)"
else
  fail "AC2 daemon was restarted on the green arm ($SCHEMA_PID_AFTER -> ${GREEN_PID:-none})"
fi
FULL_HASH_AFTER="$(sha256_of "$FULL_DB")"
if [ -n "$FULL_HASH_BEFORE2" ] && [ "$FULL_HASH_BEFORE2" = "$FULL_HASH_AFTER" ]; then
  ok "AC3 full fixture DB bytes unchanged after the green-arm ensure-up (sha256 stable)"
else
  fail "AC3 full fixture DB changed ($FULL_HASH_BEFORE2 -> $FULL_HASH_AFTER)"
fi

# ── AC6 (down-daemon path): start then probe; stale schema fails closed ─
set +e
"$DC" real stop >/dev/null 2>&1
sleep 1
set -e
set +e
DOWN_OUT="$(PATH="$TT_REPO_ROOT/bin:$PATH" TT_DAEMON_SCHEMA_PROBE_DB="$STALE_DB" "$HELPER" ensure-up 2>&1)"; DOWN_RC=$?
set -e
if [ "$DOWN_RC" -ne 0 ]; then
  ok "AC6 down-daemon + stale schema exits non-zero (rc=$DOWN_RC)"
else
  fail "AC6 down-daemon + stale schema should exit non-zero"
  echo "$DOWN_OUT" | tail -8
fi
if echo "$DOWN_OUT" | grep -q "REASON: tt-daemon-stale"; then
  ok "AC6 down path fails closed with REASON: tt-daemon-stale"
else
  fail "AC6 missing REASON: tt-daemon-stale"; echo "$DOWN_OUT" | grep -E 'REASON|DETAILS' || true
fi
if echo "$DOWN_OUT" | grep -q "starting via daemon-control" && echo "$DOWN_OUT" | grep -q "schema-handshake parity: FAIL"; then
  ok "AC6 probe ran AFTER starting the down daemon"
else
  fail "AC6 missing start-then-probe sequence"; echo "$DOWN_OUT" | grep -E 'starting|schema' || true
fi
if echo "$DOWN_OUT" | grep -q "TT_DAEMON: up"; then
  fail "AC6 down path must NOT print TT_DAEMON: up"
else
  ok "AC6 no 'TT_DAEMON: up' on the down-path fail-closed"
fi

# Cleanup: stop the real daemon so no contained daemon leaks.
set +e
"$HELPER" stop >/dev/null 2>&1 || "$DC" real stop >/dev/null 2>&1
sleep 1
set -e

# ── AC7: operator ~/.tamandua and 33xx ports untouched ────────────────
OP_AFTER="$(operator_snapshot)"
if [ "$OP_BEFORE" = "$OP_AFTER" ]; then
  ok "AC7 operator ~/.tamandua untouched"
else
  fail "AC7 operator ~/.tamandua changed"
fi
PROD_AFTER="$(port_state $PROD_PORTS)"
if [ "$PROD_BEFORE" = "$PROD_AFTER" ]; then
  ok "AC7 operator 33xx ports untouched"
else
  fail "AC7 operator 33xx ports changed ($PROD_BEFORE -> $PROD_AFTER)"
fi

# ── final sweep: no leaked daemon on 43xx ────────────────────────────
if port_state $REAL_PORTS | grep -q '4334=L\|4338=L\|4339=L'; then
  fail "final sweep: ports 43xx not free: $(port_state $REAL_PORTS)"
else
  ok "final sweep: ports 43xx free, no leaked daemon"
fi

# Remove the fixture dir (inside var) — gitignored, but clean anyway.
rm -rf "$FIXTURE_DIR" 2>/dev/null || true

echo ""
echo "---------------------------------------------"
echo "RESULT: $PASS passed, $FAIL failed"
echo "---------------------------------------------"
if [ "$FAIL" -eq 0 ]; then
  echo "ALL TESTS PASSED"
  exit 0
else
  echo "SOME TESTS FAILED"
  exit 1
fi
