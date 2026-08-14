#!/usr/bin/env bash
# tt-daemon-up.test.sh — self-test for tt-daemon-up (E2.5 US-003).
#
# Verifies the real TT daemon preflight lifecycle helper:
#   AC1. helper verifies/starts/stops the real TT daemon via daemon-control
#        real (43xx) under the contained env; --help documents it
#   AC2. with the daemon down & TT home provisioned, ensure-up starts the real
#        daemon and reports it up on 4339; a second ensure-up is a no-op
#   AC3. if the daemon cannot come up, ensure-up exits non-zero with the
#        distinct reason tt-daemon-down
#   AC4. after stop, no daemon/process remains and ports 43xx are free
#   AC5. never touches the operator's 33xx ports or ~/.tamandua
#   AC6. (S12/E3.D US-009) ensure-up creates var/adapters-bin (empty,
#        idempotent), reports TT_DAEMON_PATH_PREPEND, and the started
#        daemon's real environment carries adapters-bin on PATH; an
#        already-up daemon whose PATH lacks the prepend is RESTARTED with
#        it (verified by PID change + new environ)
#
# Standalone: bash torture-test/bin/tt-daemon-up.test.sh
# Not part of `npm test`.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TT_DIR="$(dirname "$SCRIPT_DIR")"
TT_REPO_ROOT="$(dirname "$TT_DIR")"
HELPER="$SCRIPT_DIR/tt-daemon-up"
DC="$SCRIPT_DIR/daemon-control"
PROV_FILE="$TT_REPO_ROOT/torture-test/var/daemon-control/real.json"

PASS=0
FAIL=0
TMP="$(mktemp -d "${TMPDIR:-/tmp}/tt-daemon-up.test.XXXXXX")"
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

# ── AC1: helper exists, executable, --help documents it ──────────────
if [ -x "$HELPER" ]; then ok "AC1 helper is executable: $HELPER"; else fail "AC1 helper missing/not executable: $HELPER"; fi
HELP_OUT="$("$HELPER" --help 2>&1)"
if echo "$HELP_OUT" | grep -q "tt-daemon-down" && echo "$HELP_OUT" | grep -q "ensure-up" \
   && echo "$HELP_OUT" | grep -q "stop" && echo "$HELP_OUT" | grep -q "4339"; then
  ok "AC1 --help documents tt-daemon-down + ensure-up/stop + control port 4339"
else
  fail "AC1 --help documentation"
fi

# ── invalid action exits non-zero ─────────────────────────────────────
set +e
BAD_OUT="$("$HELPER" bogus 2>&1)"; BAD_RC=$?
set -e
if [ "$BAD_RC" -ne 0 ]; then ok "invalid action exits non-zero (rc=$BAD_RC)"; else fail "invalid action exited 0"; fi

# ── status is read-only (no side effects; must not start the daemon) ──
set +e
"$HELPER" status >/dev/null 2>&1; ST_RC=$?
set -e
if [ "$ST_RC" -eq 0 ]; then ok "AC1 status subcommand runs (read-only, exits 0)"; else fail "AC1 status rc=$ST_RC"; fi
# status must NOT have started the daemon (control port must still be free)
if port_state 4339 | grep -q '4339=F'; then
  ok "AC1 status did not start the daemon (4339 still free)"
else
  fail "AC1 status started the daemon (4339 already listening)"
fi

# ── AC2: ensure-up starts the real daemon and reports it up on 4339 ──
set +e
ENSURE_OUT="$("$HELPER" ensure-up 2>&1)"; ENSURE_RC=$?
set -e
if [ "$ENSURE_RC" -eq 0 ]; then
  ok "AC2 ensure-up with daemon down exits 0"
else
  fail "AC2 ensure-up rc=$ENSURE_RC"
  echo "$ENSURE_OUT" | tail -8
fi
if echo "$ENSURE_OUT" | grep -q "TT_DAEMON: up" && echo "$ENSURE_OUT" | grep -q "TT_DAEMON_PORT: 4339"; then
  ok "AC2 ensure-up reports TT daemon UP on control port 4339"
else
  fail "AC2 ensure-up did not report TT_DAEMON up on 4339"
  echo "$ENSURE_OUT" | grep -E 'TT_DAEMON|REASON' || true
fi
if port_state 4339 | grep -q '4339=L'; then
  ok "AC2 control port 4339 is listening after ensure-up"
else
  fail "AC2 control port 4339 not listening after ensure-up"
fi
DC_OUT="$("$DC" real status 2>&1)"
if echo "$DC_OUT" | grep -q 'STATUS: RUNNING'; then
  ok "AC2 daemon-control real status is RUNNING after ensure-up"
else
  fail "AC2 daemon-control real status not RUNNING: $(echo "$DC_OUT" | grep 'STATUS:' || echo none)"
fi

# Capture the started PID for the AC4 dead-process check.
STARTED_PID=""
if [ -f "$PROV_FILE" ] && command -v jq >/dev/null 2>&1; then
  STARTED_PID="$(jq -r '.pid // ""' "$PROV_FILE" 2>/dev/null || true)"
fi

# ── AC6 (US-009): adapters-bin on the contained daemon PATH ─────────
ADAPTERS_BIN_DIR="$TT_REPO_ROOT/torture-test/var/adapters-bin"
if echo "$ENSURE_OUT" | grep -q "TT_DAEMON_PATH_PREPEND: $ADAPTERS_BIN_DIR"; then
  ok "AC6 ensure-up reports TT_DAEMON_PATH_PREPEND pointing at var/adapters-bin"
else
  fail "AC6 missing/correct TT_DAEMON_PATH_PREPEND line"
  echo "$ENSURE_OUT" | grep -E 'TT_DAEMON' || true
fi
if [ -d "$ADAPTERS_BIN_DIR" ] && [ -z "$(ls -A "$ADAPTERS_BIN_DIR" 2>/dev/null)" ]; then
  ok "AC6 adapters-bin exists and is EMPTY after preflight (inert when empty)"
else
  fail "AC6 adapters-bin missing or not empty"
fi
if [ -n "$STARTED_PID" ] && [ "$STARTED_PID" -gt 0 ] 2>/dev/null && [ -d "/proc/$STARTED_PID" ]; then
  DAEMON_PATH="$(tr '\0' '\n' < "/proc/$STARTED_PID/environ" 2>/dev/null | grep '^PATH=' | head -n1 | cut -d= -f2-)"
  case ":$DAEMON_PATH:" in
    *":$ADAPTERS_BIN_DIR:"*)
      ok "AC6 running daemon's real environment carries adapters-bin on PATH" ;;
    *)
      fail "AC6 running daemon PATH lacks adapters-bin: ${DAEMON_PATH:0:200}" ;;
  esac
else
  fail "AC6 cannot inspect daemon environ (no PID / no /proc)"
fi

# ── AC2(idempotence): second ensure-up is a no-op (no re-start) ─────
IDEM_OUT="$("$HELPER" ensure-up 2>&1)"; IDEM_RC=$?
if [ "$IDEM_RC" -eq 0 ] && echo "$IDEM_OUT" | grep -q "already UP"; then
  ok "AC2 second ensure-up is an idempotent no-op (already up)"
else
  fail "AC2 second ensure-up not idempotent (rc=$IDEM_RC)"
fi
if echo "$IDEM_OUT" | grep -q "TT_DAEMON_PATH_PREPEND: $ADAPTERS_BIN_DIR"; then
  ok "AC6 idempotent no-op still reports the PATH prepend seam"
else
  fail "AC6 idempotent no-op missing TT_DAEMON_PATH_PREPEND"
fi

# ── AC6b: an already-up daemon WITHOUT the prepend gets restarted ────
# Stop the prepended daemon, start one DIRECTLY via daemon-control (no
# prepend — daemon-control composes PATH from its own env), then ensure-up
# must detect the missing prepend and restart the daemon with it.
set +e
"$DC" real stop >/dev/null 2>&1
sleep 1
"$DC" real start >/dev/null 2>&1
DIRECT_START_RC=$?
set -e
if [ "$DIRECT_START_RC" -eq 0 ]; then ok "AC6b direct daemon-control start (no prepend) exits 0"; else fail "AC6b direct start rc=$DIRECT_START_RC"; fi
STATE_DIR_LINE="$(env -i bash "$TT_REPO_ROOT/torture-test/env/tt-env.sh" print 2>/dev/null | grep '^TAMANDUA_STATE_DIR=' | head -n1)"
STATE_DIR="${STATE_DIR_LINE#TAMANDUA_STATE_DIR=}"
DIRECT_PID=""
if [ -n "$STATE_DIR" ] && [ -f "$STATE_DIR/tamandua.pid" ]; then
  DIRECT_PID="$(cat "$STATE_DIR/tamandua.pid")"
fi
if [ -n "$DIRECT_PID" ] && [ -d "/proc/$DIRECT_PID" ]; then
  DIRECT_PATH="$(tr '\0' '\n' < "/proc/$DIRECT_PID/environ" 2>/dev/null | grep '^PATH=' | head -n1 | cut -d= -f2-)"
  case ":$DIRECT_PATH:" in
    *":$ADAPTERS_BIN_DIR:"*) fail "AC6b direct-started daemon unexpectedly has the prepend (test setup broken)" ;;
    *) ok "AC6b direct-started daemon baseline lacks the prepend" ;;
  esac
else
  fail "AC6b could not capture direct-started daemon PID"
fi
RESTART_OUT="$("$HELPER" ensure-up 2>&1)"; RESTART_RC=$?
if [ "$RESTART_RC" -eq 0 ]; then ok "AC6b ensure-up over an unprepended daemon exits 0"; else fail "AC6b ensure-up restart rc=$RESTART_RC"; echo "$RESTART_OUT" | tail -8; fi
if echo "$RESTART_OUT" | grep -q "TT_DAEMON: up" && echo "$RESTART_OUT" | grep -q "TT_DAEMON_PATH_PREPEND: $ADAPTERS_BIN_DIR"; then
  ok "AC6b restart reports up + prepend seam"
else
  fail "AC6b restart output contract"
fi
NEW_PID=""
if [ -n "$STATE_DIR" ] && [ -f "$STATE_DIR/tamandua.pid" ]; then
  NEW_PID="$(cat "$STATE_DIR/tamandua.pid")"
fi
if [ -n "$DIRECT_PID" ] && [ -n "$NEW_PID" ] && [ "$DIRECT_PID" != "$NEW_PID" ]; then
  ok "AC6b daemon was RESTARTED (pid $DIRECT_PID -> $NEW_PID)"
else
  fail "AC6b daemon not restarted (pid $DIRECT_PID -> ${NEW_PID:-none})"
fi
if [ -n "$NEW_PID" ] && [ -d "/proc/$NEW_PID" ]; then
  NEW_PATH="$(tr '\0' '\n' < "/proc/$NEW_PID/environ" 2>/dev/null | grep '^PATH=' | head -n1 | cut -d= -f2-)"
  case ":$NEW_PATH:" in
    *":$ADAPTERS_BIN_DIR:"*) ok "AC6b restarted daemon's environment carries adapters-bin on PATH" ;;
    *) fail "AC6b restarted daemon PATH lacks adapters-bin: ${NEW_PATH:0:200}" ;;
  esac
else
  fail "AC6b cannot inspect restarted daemon environ"
fi

# ── AC4: stop cleans up — no process remains, ports 43xx free ───────
STOP_OUT="$("$HELPER" stop 2>&1)"; STOP_RC=$?
if [ "$STOP_RC" -eq 0 ]; then
  ok "AC4 stop exits 0"
else
  fail "AC4 stop rc=$STOP_RC"
  echo "$STOP_OUT" | tail -6
fi
if echo "$STOP_OUT" | grep -q "TT_DAEMON: down"; then
  ok "AC4 stop reports TT_DAEMON down"
else
  fail "AC4 stop did not report TT_DAEMON down"
fi
sleep 1
if port_state $REAL_PORTS | grep -q '4334=L\|4338=L\|4339=L'; then
  fail "AC4 ports 43xx still listening after stop: $(port_state $REAL_PORTS)"
else
  ok "AC4 ports 43xx free after stop (sweep verified)"
fi
if [ -n "$STARTED_PID" ] && [ "$STARTED_PID" -gt 0 ] 2>/dev/null; then
  if [ -d "/proc/$STARTED_PID" ]; then
    fail "AC4 started daemon PID $STARTED_PID still alive after stop"
  else
    ok "AC4 started daemon PID $STARTED_PID no longer alive after stop"
  fi
else
  ok "AC4 no provenanced PID captured (nothing to assert) — ports check above still authoritative"
fi

# ── AC3: fail closed with distinct reason tt-daemon-down ─────────────
# With the daemon now down, force a start failure by putting a failing
# `tamandua` stub first on PATH (daemon-control launches `tamandua` via the
# caller's PATH, so the stub makes the daemon fail to come up).
STUBBIN="$TMP/bin"; mkdir -p "$STUBBIN"
printf '#!/usr/bin/env bash\nexit 1\n' > "$STUBBIN/tamandua"
chmod +x "$STUBBIN/tamandua"
set +e
FAIL_OUT="$(PATH="$STUBBIN:$PATH" "$HELPER" ensure-up 2>&1)"; FAIL_RC=$?
set -e
if [ "$FAIL_RC" -ne 0 ]; then
  ok "AC3 cannot-come-up exits non-zero (rc=$FAIL_RC)"
else
  fail "AC3 cannot-come-up should exit non-zero"
fi
if echo "$FAIL_OUT" | grep -q "REASON: tt-daemon-down"; then
  ok "AC3 failure emits distinct reason tt-daemon-down"
else
  fail "AC3 missing REASON: tt-daemon-down in output"
fi
# The failed start must not leave a daemon/ports busy.
sleep 1
if port_state $REAL_PORTS | grep -q '4334=L\|4338=L\|4339=L'; then
  fail "AC3 failed start left ports busy: $(port_state $REAL_PORTS)"
else
  ok "AC3 failed start left ports 43xx free"
fi

# ── AC5: operator ~/.tamandua and 33xx ports untouched ──────────────
OP_AFTER="$(operator_snapshot)"
if [ "$OP_BEFORE" = "$OP_AFTER" ]; then
  ok "AC5 operator ~/.tamandua untouched"
else
  fail "AC5 operator ~/.tamandua changed"
fi
PROD_AFTER="$(port_state $PROD_PORTS)"
if [ "$PROD_BEFORE" = "$PROD_AFTER" ]; then
  ok "AC5 operator 33xx ports untouched"
else
  fail "AC5 operator 33xx ports changed ($PROD_BEFORE -> $PROD_AFTER)"
fi

# ── final sweep: no leaked daemon on 43xx ────────────────────────────
if port_state $REAL_PORTS | grep -q '4334=L\|4338=L\|4339=L'; then
  fail "final sweep: ports 43xx not free: $(port_state $REAL_PORTS)"
else
  ok "final sweep: ports 43xx free, no leaked daemon"
fi

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
