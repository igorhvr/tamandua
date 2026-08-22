#!/usr/bin/env bash
# tt-daemon-up.test.sh — self-test for tt-daemon-up (E2.5 US-003).
#
# MACP3 US-004: every '/proc' hit in this harness is linux-only. All RUNTIME
# /proc reads are guarded by [ -d /proc/$pid ] and carry explicit inline
# 'MACP3 US-004 linux-only' comments; pass/fail prose mentioning /proc is
# documentation only, and '/proc' in 'daemon/process' is a substring of
# "process", not the procfs mount.
#
# Verifies the real TT daemon preflight lifecycle helper:
#   AC1. helper verifies/starts/stops the real TT daemon via daemon-control
#        real (43xx) under the contained env; --help documents it
#   AC2. with the daemon down & TT home provisioned, ensure-up starts the real
#        daemon and reports it up on 4339; a second ensure-up is a no-op
#   AC3. if the daemon cannot come up, ensure-up exits non-zero with the
#        distinct reason tt-daemon-down
#   AC4. after stop, no daemon/process remains and ports 43xx are free
#        ('daemon/process' — the '/proc' here is a substring of "process", no procfs
#        access; MACP3 US-004 linux-only doc note)
#   AC5. never touches the operator's 33xx ports or ~/.tamandua
#   AC6. (S12/E3.D US-009) ensure-up creates var/adapters-bin (empty,
#        idempotent), reports TT_DAEMON_PATH_PREPEND, and the started
#        daemon's real environment carries adapters-bin on PATH; an
#        already-up daemon whose PATH lacks the prepend is RESTARTED with
#        it (verified by PID change + new environ)
#   AC7. (S15 US-001 red) a mismatched expected build version (injected via
#        TT_DAEMON_EXPECTED_VERSION_FILE) on an already-UP daemon is NEVER
#        silently reused: the guard RESTARTS the daemon and, since the
#        restarted daemon still reports the real dist/version, FAILS CLOSED
#        with REASON: tt-daemon-stale on stderr, DETAILS carrying expected vs
#        observed versions, exit non-zero and no 'TT_DAEMON: up' line
#   AC8. (S15 US-001 green) a parity-matching daemon build version remains an
#        idempotent no-op ('already UP')
#   AC9. (S15 US-001 heal) a mismatched expected version whose restart HEALS
#        the skew (a stub contained daemon whose /control/health buildVersion
#        advances stale -> current across the guard's restart) exits 0 with
#        'TT_DAEMON: up' and the restarted daemon reports the expected build
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

# health_version: query a daemon's /control/health buildVersion (empty on
# failure) — used by the S15 build-version parity guard arms.
health_version() { # port
  node -e 'const p=Number(process.argv[1]);fetch(`http://127.0.0.1:${p}/control/health`).then(r=>r.json()).then(b=>process.stdout.write(String(b.buildVersion??""))).catch(()=>{})' "$1"
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
# S15 US-001: the parity guard compares the daemon's /control/health
# buildVersion against THIS worktree's dist/version, and daemon-control
# launches `tamandua` from the caller's PATH (which would otherwise resolve
# the OPERATOR's installed build). Prepend the worktree's own bin/ so the
# contained daemon runs THIS tree's build and parity matches deterministically
# in any environment (installed build in sync or not).
set +e
ENSURE_OUT="$(PATH="$TT_REPO_ROOT/bin:$PATH" "$HELPER" ensure-up 2>&1)"; ENSURE_RC=$?
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
# linux-only /proc/$STARTED_PID/environ read (MACP3 US-004): Darwin has no
# /proc — the [ -d "/proc/$STARTED_PID" ] guard above fails there, so this
# assertion falls to the else branch (fail) without reading procfs.
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
IDEM_OUT="$(PATH="$TT_REPO_ROOT/bin:$PATH" "$HELPER" ensure-up 2>&1)"; IDEM_RC=$?
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
# prepend — daemon-control composes PATH from its own env; the worktree
# bin/ is kept so the S15 parity guard still sees a matching build and the
# restart is triggered by the missing prepend, not a build skew), then
# ensure-up must detect the missing prepend and restart the daemon with it.
set +e
"$DC" real stop >/dev/null 2>&1
sleep 1
PATH="$TT_REPO_ROOT/bin:$PATH" "$DC" real start >/dev/null 2>&1
DIRECT_START_RC=$?
set -e
if [ "$DIRECT_START_RC" -eq 0 ]; then ok "AC6b direct daemon-control start (no prepend) exits 0"; else fail "AC6b direct start rc=$DIRECT_START_RC"; fi
STATE_DIR_LINE="$(env -i bash "$TT_REPO_ROOT/torture-test/env/tt-env.sh" print 2>/dev/null | grep '^TAMANDUA_STATE_DIR=' | head -n1)"
STATE_DIR="${STATE_DIR_LINE#TAMANDUA_STATE_DIR=}"
DIRECT_PID=""
if [ -n "$STATE_DIR" ] && [ -f "$STATE_DIR/tamandua.pid" ]; then
  DIRECT_PID="$(cat "$STATE_DIR/tamandua.pid")"
fi
# linux-only /proc/$DIRECT_PID/environ read (MACP3 US-004): Darwin has no
# /proc — guarded above; on Darwin this falls to the else fail branch.
if [ -n "$DIRECT_PID" ] && [ -d "/proc/$DIRECT_PID" ]; then
  DIRECT_PATH="$(tr '\0' '\n' < "/proc/$DIRECT_PID/environ" 2>/dev/null | grep '^PATH=' | head -n1 | cut -d= -f2-)"
  case ":$DIRECT_PATH:" in
    *":$ADAPTERS_BIN_DIR:"*) fail "AC6b direct-started daemon unexpectedly has the prepend (test setup broken)" ;;
    *) ok "AC6b direct-started daemon baseline lacks the prepend" ;;
  esac
else
  fail "AC6b could not capture direct-started daemon PID"
fi
RESTART_OUT="$(PATH="$TT_REPO_ROOT/bin:$PATH" "$HELPER" ensure-up 2>&1)"; RESTART_RC=$?
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
# linux-only /proc/$NEW_PID/environ read (MACP3 US-004): Darwin has no /proc
# — guarded above; on Darwin this falls to the else fail branch.
if [ -n "$NEW_PID" ] && [ -d "/proc/$NEW_PID" ]; then
  NEW_PATH="$(tr '\0' '\n' < "/proc/$NEW_PID/environ" 2>/dev/null | grep '^PATH=' | head -n1 | cut -d= -f2-)"
  case ":$NEW_PATH:" in
    *":$ADAPTERS_BIN_DIR:"*) ok "AC6b restarted daemon's environment carries adapters-bin on PATH" ;;
    *) fail "AC6b restarted daemon PATH lacks adapters-bin: ${NEW_PATH:0:200}" ;;
  esac
else
  fail "AC6b cannot inspect restarted daemon environ"
fi

# ── AC7 (S15 US-001 red): a stale build version is NEVER silently reused ──
# The daemon is UP with the matching build + prepend (AC6b). Inject a
# mismatched expected version via the TT_DAEMON_EXPECTED_VERSION_FILE seam:
# the OLD pre-guard code would have taken the 'already UP -> no-op' branch
# and silently reused the stale daemon (campaign #8 attempt-1 controller
# crash); the guard must instead intercept, restart, and — since the
# restarted daemon still reports the real dist/version — FAIL CLOSED with
# the distinct reason tt-daemon-stale.
REAL_VERSION="$(tr -d '[:space:]' < "$TT_REPO_ROOT/dist/version")"
MISMATCH_VERSION="pre-WLST5-stale-$(date +%s)"
printf '%s\n' "$MISMATCH_VERSION" > "$TMP/expected-mismatch.txt"
STALE_PID_BEFORE=""
if [ -n "$STATE_DIR" ] && [ -f "$STATE_DIR/tamandua.pid" ]; then
  STALE_PID_BEFORE="$(cat "$STATE_DIR/tamandua.pid")"
fi
set +e
STALE_OUT="$(PATH="$TT_REPO_ROOT/bin:$PATH" TT_DAEMON_EXPECTED_VERSION_FILE="$TMP/expected-mismatch.txt" "$HELPER" ensure-up 2>&1)"; STALE_RC=$?
set -e
if [ "$STALE_RC" -ne 0 ]; then
  ok "AC7 mismatched expected version exits non-zero (rc=$STALE_RC)"
else
  fail "AC7 mismatched expected version should exit non-zero"
  echo "$STALE_OUT" | tail -8
fi
if echo "$STALE_OUT" | grep -q "REASON: tt-daemon-stale"; then
  ok "AC7 failure emits distinct reason tt-daemon-stale"
else
  fail "AC7 missing REASON: tt-daemon-stale"; echo "$STALE_OUT" | grep -E 'REASON|DETAILS' || true
fi
if echo "$STALE_OUT" | grep -q "TT_DAEMON: up"; then
  fail "AC7 stale guard must NOT print TT_DAEMON: up"
else
  ok "AC7 no 'TT_DAEMON: up' on stale fail-closed"
fi
if echo "$STALE_OUT" | grep -q "already UP"; then
  fail "AC7 guard must intercept BEFORE the no-op reuse branch"
else
  ok "AC7 guard intercepted before the no-op reuse branch"
fi
if echo "$STALE_OUT" | grep -q "$MISMATCH_VERSION" && echo "$STALE_OUT" | grep -q "$REAL_VERSION"; then
  ok "AC7 DETAILS carry expected vs observed versions"
else
  fail "AC7 DETAILS missing expected/observed versions"; echo "$STALE_OUT" | grep 'DETAILS' || true
fi
STALE_PID_AFTER=""
if [ -n "$STATE_DIR" ] && [ -f "$STATE_DIR/tamandua.pid" ]; then
  STALE_PID_AFTER="$(cat "$STATE_DIR/tamandua.pid")"
fi
if [ -n "$STALE_PID_BEFORE" ] && [ -n "$STALE_PID_AFTER" ] && [ "$STALE_PID_BEFORE" != "$STALE_PID_AFTER" ]; then
  ok "AC7 guard RESTARTED the daemon (pid $STALE_PID_BEFORE -> $STALE_PID_AFTER)"
else
  fail "AC7 daemon not restarted by the guard (pid $STALE_PID_BEFORE -> ${STALE_PID_AFTER:-none})"
fi

# ── AC8 (S15 US-001 green): a parity-matching daemon is an idempotent no-op ──
# With the expected version back at the real dist/version, the daemon's
# reported buildVersion matches and ensure-up reuses it (no restart).
PARITY_OUT="$(PATH="$TT_REPO_ROOT/bin:$PATH" TT_DAEMON_EXPECTED_VERSION_FILE="$TT_REPO_ROOT/dist/version" "$HELPER" ensure-up 2>&1)"; PARITY_RC=$?
if [ "$PARITY_RC" -eq 0 ] && echo "$PARITY_OUT" | grep -q "already UP"; then
  ok "AC8 parity-matching daemon is an idempotent no-op (already UP)"
else
  fail "AC8 parity no-op (rc=$PARITY_RC)"; echo "$PARITY_OUT" | tail -6
fi
if echo "$PARITY_OUT" | grep -q "TT_DAEMON: up"; then
  ok "AC8 parity no-op reports TT_DAEMON: up"
else
  fail "AC8 parity no-op missing TT_DAEMON: up"
fi

# ── AC9 (S15 US-001 heal): a restart that heals the skew reports up ──
# A stale daemon cannot exist with the REAL contained daemon (it always runs
# the current dist). To exercise the heal path deterministically we start a
# STUB contained daemon — a fake `tamandua` first on PATH, daemon-control
# managed exactly like the AC3 failure stub — whose /control/health
# buildVersion advances stale -> current across each `daemon start` (the
# phase file survives the guard's restart): the guard's restart then HEALS
# the skew and ensure-up exits 0 with 'TT_DAEMON: up'.
STUBBIN="$TMP/stubbin"
mkdir -p "$STUBBIN"
STALE_VERSION="pre-WLST5-daemon-$(date +%s)"
printf '%s\n' "$STALE_VERSION" > "$TMP/stub-phase"
cat > "$STUBBIN/stub-config.sh" <<EOF
STUB_PHASE_FILE="$TMP/stub-phase"
STUB_STALE_VERSION="$STALE_VERSION"
STUB_CURRENT_VERSION="$REAL_VERSION"
EOF
cat > "$STUBBIN/tamandua" <<'EOF'
#!/usr/bin/env bash
# Stub tamandua CLI for the AC9 heal arm (S15 US-001): a minimal fake daemon
# whose /control/health buildVersion advances stale -> current across each
# `daemon start`, so the guard's restart can HEAL the skew. Managed through
# daemon-control exactly like any contained daemon. The daemon PID recorded
# by daemon-control is the health-server node process; its script name
# contains 'tamandua' so /proc/<pid>/cmdline satisfies daemon-control's
# cmdline verification. Stub config (phase file + versions) is read from a
# config file NEXT TO the stub (env -i drops caller env vars).
#
# dashboard/mcp spawn DETACHED placeholder servers and return immediately —
# exactly like the product's startDashboardStandalone/startMcp (src/server/
# daemonctl.ts: detached: true + unref), because daemon-control's
# `systemd-run --user --scope` launch is SYNCHRONOUS: a blocking last command
# would hang daemon-control forever. The placeholder servers exit on their
# own once the recorded daemon PID (state-dir tamandua.pid) dies.
set -uo pipefail
STUB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$STUB_DIR/stub-config.sh" ] && . "$STUB_DIR/stub-config.sh"
STATE_DIR="${TAMANDUA_STATE_DIR:?}"
CTRL_PORT="${TAMANDUA_CONTROL_PORT:-4339}"
DASH_PORT="${TAMANDUA_DASHBOARD_PORT:-4334}"
MCP_PORT="${TAMANDUA_MCP_PORT:-4338}"
case "${1:-}" in
  daemon)
    case "${2:-}" in
      start)
        # Report the current phase version, then advance the phase so the
        # NEXT start (the guard's restart) reports the healed version.
        VER="$(cat "$STUB_PHASE_FILE" 2>/dev/null || echo "${STUB_STALE_VERSION:-stale}")"
        printf '%s\n' "${STUB_CURRENT_VERSION:-current}" > "$STUB_PHASE_FILE"
        node "$STUB_DIR/tamandua-daemon-health.mjs" "$CTRL_PORT" "$VER" >/dev/null 2>&1 &
        echo $! > "$STATE_DIR/tamandua.pid"
        exit 0
        ;;
      stop)
        if [ -f "$STATE_DIR/tamandua.pid" ]; then
          kill "$(cat "$STATE_DIR/tamandua.pid")" 2>/dev/null || true
        fi
        exit 0
        ;;
    esac
    ;;
  dashboard)
    node "$STUB_DIR/tamandua-dummy-server.mjs" "$DASH_PORT" "$STATE_DIR/tamandua.pid" >/dev/null 2>&1 &
    exit 0
    ;;
  mcp)
    node "$STUB_DIR/tamandua-dummy-server.mjs" "$MCP_PORT" "$STATE_DIR/tamandua.pid" >/dev/null 2>&1 &
    exit 0
    ;;
esac
exit 0
EOF
cat > "$STUBBIN/tamandua-daemon-health.mjs" <<'EOF'
// Stub contained-daemon health server (S15 US-001 heal arm). Serves
// /control/health with a fixed buildVersion (argv[2]) — the version the
// current "daemon build" reports. Auth-exempt, exactly like the product's
// control-plane health endpoint (src/server/control-server.ts).
import http from "node:http";
const [portStr, version] = process.argv.slice(2);
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/control/health" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", pid: process.pid, timestamp: new Date().toISOString(), buildVersion: version }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});
server.listen(Number(portStr), "127.0.0.1");
EOF
cat > "$STUBBIN/tamandua-dummy-server.mjs" <<'EOF'
// Stub contained-daemon dashboard/MCP port placeholder. Binds the port so
// daemon-control's port-wait succeeds, and exits once the recorded daemon
// PID (state-dir tamandua.pid) dies — so a stop never leaks the port.
import http from "node:http";
import fs from "node:fs";
const [portStr, pidFile] = process.argv.slice(2);
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
server.listen(Number(portStr), "127.0.0.1");
const iv = setInterval(() => {
  let pid = 0;
  try { pid = Number(fs.readFileSync(pidFile, "utf8").trim() || "0"); } catch { pid = 0; }
  if (pid > 0) {
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    if (!alive) {
      clearInterval(iv);
      server.close(() => process.exit(0));
    }
  }
}, 500);
EOF
chmod +x "$STUBBIN/tamandua"

# Baseline: stop the real daemon, then pre-start the STUB daemon (reports the
# STALE version) via daemon-control with the stub first on PATH.
set +e
"$DC" real stop >/dev/null 2>&1
sleep 2
( cd "$TT_REPO_ROOT" && PATH="$STUBBIN:$PATH" TT_DAEMON_PORT_WAIT_SECONDS=3 "$DC" real start >/dev/null 2>&1 ); STUB_START_RC=$?
set -e
if [ "$STUB_START_RC" -eq 0 ]; then ok "AC9 stub daemon pre-start exits 0"; else fail "AC9 stub pre-start rc=$STUB_START_RC"; fi
sleep 1
STUB_PID_BEFORE=""
if [ -n "$STATE_DIR" ] && [ -f "$STATE_DIR/tamandua.pid" ]; then STUB_PID_BEFORE="$(cat "$STATE_DIR/tamandua.pid")"; fi
HEALTH_BEFORE="$(health_version 4339)"
if [ "$HEALTH_BEFORE" = "$STALE_VERSION" ]; then
  ok "AC9 stub daemon reports the STALE build version pre-guard"
else
  fail "AC9 stub health pre-guard: got '${HEALTH_BEFORE:-<none>}', want '$STALE_VERSION'"
fi

# The guard must see the mismatch, restart the daemon, and heal: the
# restarted stub reports the CURRENT (expected) build version -> TT_DAEMON: up.
set +e
HEAL_OUT="$(cd "$TT_REPO_ROOT" && PATH="$STUBBIN:$PATH" TT_DAEMON_EXPECTED_VERSION_FILE="$TT_REPO_ROOT/dist/version" "$HELPER" ensure-up 2>&1)"; HEAL_RC=$?
set -e
if [ "$HEAL_RC" -eq 0 ]; then ok "AC9 heal-arm ensure-up exits 0 (rc=$HEAL_RC)"; else fail "AC9 heal-arm ensure-up rc=$HEAL_RC"; echo "$HEAL_OUT" | tail -10; fi
if echo "$HEAL_OUT" | grep -q "TT_DAEMON: up"; then ok "AC9 heal-arm reports TT_DAEMON: up"; else fail "AC9 heal-arm missing TT_DAEMON: up"; echo "$HEAL_OUT" | grep -E 'TT_DAEMON|REASON' || true; fi
if echo "$HEAL_OUT" | grep -q "stopping to restart"; then ok "AC9 heal-arm guard detected the skew and restarted"; else fail "AC9 heal-arm missing restart log"; echo "$HEAL_OUT" | grep -E 'stopping|MISMATCH|parity' || true; fi
STUB_PID_AFTER=""
if [ -n "$STATE_DIR" ] && [ -f "$STATE_DIR/tamandua.pid" ]; then STUB_PID_AFTER="$(cat "$STATE_DIR/tamandua.pid")"; fi
if [ -n "$STUB_PID_BEFORE" ] && [ -n "$STUB_PID_AFTER" ] && [ "$STUB_PID_BEFORE" != "$STUB_PID_AFTER" ]; then
  ok "AC9 heal-arm daemon was RESTARTED (pid $STUB_PID_BEFORE -> $STUB_PID_AFTER)"
else
  fail "AC9 heal-arm daemon not restarted (pid $STUB_PID_BEFORE -> ${STUB_PID_AFTER:-none})"
fi
HEALTH_AFTER="$(health_version 4339)"
if [ "$HEALTH_AFTER" = "$REAL_VERSION" ]; then
  ok "AC9 restarted daemon reports the EXPECTED build version (healed)"
else
  fail "AC9 post-heal health: got '${HEALTH_AFTER:-<none>}', want '$REAL_VERSION'"
fi

# Cleanup: stop the stub daemon so no fake daemon leaks into AC4/AC5.
( cd "$TT_REPO_ROOT" && PATH="$STUBBIN:$PATH" "$DC" real stop >/dev/null 2>&1 ) || true

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
# linux-only /proc/$STARTED_PID existence check (MACP3 US-004): Darwin has no
# procfs — /proc/$STARTED_PID never exists there, so this 'no longer alive'
# branch wins (conservative pass-by-note), never a read/hard-fail.
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
