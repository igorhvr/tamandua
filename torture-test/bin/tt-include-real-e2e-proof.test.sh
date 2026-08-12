#!/usr/bin/env bash
# tt-include-real-e2e-proof.test.sh — E2.5 US-008 zero-token end-to-end proof.
#
# ONE included-real pass (the controller's `--include-real` arm: an
# execution_selection=all campaign driving a REAL workflow case through the
# actual `workflow run` launch path) proving the full real-case chain with the
# CONTAINED TT home deleted first:
#
#   AC1. TT home provisioned + bundled catalog installed under the contained
#        home (workflows listable under torture-test/var/home/.tamandua/workflows;
#        stamp version == current repo build).
#   AC2. The REAL contained TT daemon is UP on control port 4339 DURING the run
#        (observed by an in-campaign TCP probe) and is STOPPED at campaign end:
#        ports 43xx free, daemon-control real status STOPPED, no TT-owned
#        daemon/controller process leaked.
#   AC3. The first real case's recorded launch reaches an actual `workflow run`
#        invocation with a CAPTURED RUN ID from the argv-recording stub.
#   AC4. The operator hygiene canary (real ~/.gitconfig identity) is UNCHANGED
#        vs baseline; no HYGIENE_* finding; operator ~/.tamandua untouched.
#   AC5. ZERO real tokens consumed (the launch is served by the stub; the daemon
#        is the real tamandua via daemon-delegation, but no model is invoked).
#
# ZERO tokens by construction: a stub `tamandua` on PATH answers the controller's
# `workflow run/status/stop/wait` calls (recording the launch argv and emitting a
# run id) and DELEGATES `daemon/dashboard/mcp` subcommands to the repo's own dist
# build so the REAL contained TT daemon genuinely comes up on 43xx and is stopped
# at campaign end. All state stays under torture-test/var (never the operator's
# ~/.tamandua or 33xx daemon).
#
# Standalone: bash torture-test/bin/tt-include-real-e2e-proof.test.sh
# Not part of `npm test`.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TT_DIR="$(dirname "$SCRIPT_DIR")"            # torture-test/
TT_REPO_ROOT="$(dirname "$TT_DIR")"          # repo root
CONTROLLER="$SCRIPT_DIR/tt-controller"
DAEMON_CONTROL="$SCRIPT_DIR/daemon-control"
RESULTS="$TT_DIR/var/results"
CONTAINED_HOME="$TT_DIR/var/home"
CONTAINED_WF="$CONTAINED_HOME/.tamandua/workflows"
STAMP="$CONTAINED_WF/.catalog-version.json"
mkdir -p "$RESULTS" "$TT_DIR/var"

TEST_ROOT="$(mktemp -d "$TT_DIR/var/include-real-e2e.XXXXXX")"
STUB_DIR="$TEST_ROOT/stubs"
MANIFEST="$TEST_ROOT/manifest.jsonl"
ARGV_LOG="$TEST_ROOT/launch-argv.jsonl"
DAEMON_PROBE_LOG="$TEST_ROOT/daemon-probe.log"
mkdir -p "$STUB_DIR"

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }

# ── guards: need the repo dist build + bundled workflows (skip, not fail) ──
CUR_BUILD="$(cat "$TT_REPO_ROOT/dist/version" 2>/dev/null | tr -d '[:space:]' || true)"
if [ -z "$CUR_BUILD" ] || [ ! -f "$TT_REPO_ROOT/dist/cli/cli.js" ]; then
  echo "SKIP: repo dist build missing — run ./build first" >&2
  exit 0
fi
if [ ! -d "$TT_REPO_ROOT/workflows" ]; then
  echo "SKIP: repo workflows dir missing" >&2
  exit 0
fi

# ── must NOT run with the operator's 33xx daemon / ~/.tamandua context ──
ensure_ports_43xx_free() {
  local p
  for p in 4334 4338 4339; do
    if bash -c "echo >/dev/tcp/localhost/$p" 2>/dev/null; then
      return 1
    fi
  done
  return 0
}

# Clean the contained real daemon state so the proof starts from a known point.
"$DAEMON_CONTROL" real stop >/dev/null 2>&1 || true
sleep 1
rm -f "$TT_DIR/var/daemon-control/real.json"
ensure_ports_43xx_free || fail "contained real ports 43xx not free before the test (stale daemon present)"

# ── operator hygiene + ~/.tamandua snapshot (AC4) ──────────────────────
OPERATOR_HOME="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)"
[ -n "$OPERATOR_HOME" ] && [ -d "$OPERATOR_HOME" ] || OPERATOR_HOME="${HOME:-$OPERATOR_HOME}"
gitconfig_hash() { sha256sum "$1" 2>/dev/null | awk '{print $1}'; }
OP_GITCONFIG="$OPERATOR_HOME/.gitconfig"
OP_GIT_BEFORE="$(gitconfig_hash "$OP_GITCONFIG")"
OPERATOR_CATALOG="$OPERATOR_HOME/.tamandua/workflows"
operator_catalog_snapshot() {
  if [ -d "$OPERATOR_CATALOG" ]; then
    ( cd "$OPERATOR_CATALOG" && { ls -1; [ -f .catalog-version.json ] && cat .catalog-version.json; } 2>/dev/null | sort ) || true
  else
    echo "(no operator catalog)"
  fi
}
OP_CATALOG_BEFORE="$(operator_catalog_snapshot)"

# ── back the contained home aside so we start UNPROVISIONED (AC1) ──────
HOME_BACKUP="$TEST_ROOT/home-backup"
if [ -d "$CONTAINED_HOME" ]; then
  mv "$CONTAINED_HOME" "$HOME_BACKUP"
fi
restore_home() {
  if [ -d "$HOME_BACKUP" ]; then
    rm -rf "$CONTAINED_HOME"
    mv "$HOME_BACKUP" "$CONTAINED_HOME"
  elif [ -d "$CONTAINED_HOME" ]; then
    rm -rf "$CONTAINED_HOME"
  fi
}
cleanup() {
  restore_home
  rm -rf "$TEST_ROOT"
}
trap 'cleanup' EXIT

# ── argv-recording launch stub (AC3) + real-daemon delegate (AC2) ──────
STUB_RUN_ID="run-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
cat > "$STUB_DIR/tamandua" <<STUB
#!/usr/bin/env bash
# US-008 argv-recording launch stub + run-id emitter + daemon delegate.
set -uo pipefail
REAL_CLI="$TT_REPO_ROOT/dist/cli/cli.js"
ARGV_LOG="$ARGV_LOG"
RUNID="$STUB_RUN_ID"
case "\${1:-}" in
  daemon|dashboard|mcp)
    exec node "\$REAL_CLI" "\$@"
    ;;
  workflow)
    case "\${2:-}" in
      run)
        { printf 'LAUNCH %s\n' "\$*"; } >> "\$ARGV_LOG"
        { printf 'ARGV %s\n' "\${*:3}"; } >> "\$ARGV_LOG"
        echo "Run: \$RUNID"
        printf '{"runs":[{"runId":"%s","status":"done","tokensSpent":0,"steps":[]}]}\n' "\$RUNID"
        exit 0
        ;;
      status)
        printf '{"runId":"%s","status":"done","tokensSpent":0,"steps":[{"step_id":"s1","step_index":0,"status":"done","type":"implement"}]}\n' "\${3:-\$RUNID}"
        exit 0
        ;;
      stop)
        exit 0
        ;;
      wait)
        printf '{"runId":"%s","status":"done","tokensSpent":0,"steps":[]}\n' "\${3:-\$RUNID}"
        exit 0
        ;;
    esac
    ;;
esac
exit 0
STUB
chmod +x "$STUB_DIR/tamandua"

# ── included-real manifest: ONE real workflow case (fixture tt-ts, golden
#    present on host; workflow do-now; no oracles) → forces the preflight to
#    engage AND reaches the real `workflow run` launch path via the stub. ──
cat > "$MANIFEST" <<MAN
{"id":"US008-E2E","wave":0,"workflow":"do-now","fixture":"tt-ts","harness":"pi","task":"tasks/US008.md","context":{"execution_mode":"real"},"caps":{"tokens":200000,"wall_min":5},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification","reset":null,"command":null}
MAN

# ── run the included-real (execution_selection=all) campaign ──────────
# Launch the controller in the BACKGROUND so the test can probe 4339 DURING
# the run (AC2: daemon genuinely up on the control port), then wait for exit.
snapshot_campaigns_before="$(mktemp)"
ls -1 "$RESULTS" 2>/dev/null | grep '^campaign-' | sort > "$snapshot_campaigns_before" || true

: > "$DAEMON_PROBE_LOG"
set +e
env PATH="$STUB_DIR:$PATH" \
  TT_CONTROLLER_TOKEN_SETTLE_MS=1500 TT_CONTROLLER_TRUTH_RECHECK_MS=500 \
  "$CONTROLLER" --manifest "$MANIFEST" > "$TEST_ROOT/controller.out" 2>&1 &
CONTROLLER_PID=$!
set -e

# AC2 evidence: probe 4339 while the campaign is running (the real daemon
# comes up during the preflight daemon-up leg and stays up for the run).
PROBE_SEEN_UP=0
PROBE_DEADLINE=$(( $(date +%s) + 180 ))
while kill -0 "$CONTROLLER_PID" 2>/dev/null; do
  if [ "$PROBE_SEEN_UP" -eq 0 ] && bash -c "echo >/dev/tcp/localhost/4339" 2>/dev/null; then
    PROBE_SEEN_UP=1
    echo "4339 listening at $(date -u +%H:%M:%S.%3NZ)" >> "$DAEMON_PROBE_LOG"
  fi
  if [ "$(date +%s)" -gt "$PROBE_DEADLINE" ]; then
    kill -9 "$CONTROLLER_PID" 2>/dev/null || true
    break
  fi
  sleep 0.05
done

set +e
wait "$CONTROLLER_PID"
CONTROLLER_STATUS=$?
set -e

# ── collect the campaign produced by this run ──────────────────────────
CONTROLLER_CAMPAIGN="$(comm -13 "$snapshot_campaigns_before" <(ls -1 "$RESULTS" 2>/dev/null | grep '^campaign-' | sort) | head -n1)"
rm -f "$snapshot_campaigns_before"

[ "$CONTROLLER_STATUS" -eq 0 ] || { echo "controller output:"; sed -n '1,200p' "$TEST_ROOT/controller.out"; fail "included-real campaign exited $CONTROLLER_STATUS (not 0)"; }
[ -n "$CONTROLLER_CAMPAIGN" ] || fail "included-real campaign not recorded in $RESULTS"
STATE="$RESULTS/$CONTROLLER_CAMPAIGN/state.json"
REPORT="$RESULTS/$CONTROLLER_CAMPAIGN/report.json"
[ -f "$STATE" ] && [ -f "$REPORT" ] || fail "campaign state/report missing"

read_state() { node -e "const s=require('$STATE');const k=process.argv[1];console.log(JSON.stringify(k.split('.').reduce((o,p)=>o?.[p],s)))" "$1" 2>/dev/null; }
read_report() { node -e "const s=require('$REPORT');const k=process.argv[1];console.log(JSON.stringify(k.split('.').reduce((o,p)=>o?.[p],s)))" "$1" 2>/dev/null; }

# ── AC1: preflight engaged + home + catalog ────────────────────────────
PF="$(read_state 'real_preflight')"
printf '%s' "$PF" | grep -q '"engaged":true' || fail "AC1 preflight not engaged: $PF"
printf '%s' "$PF" | grep -q '"ok":true' || fail "AC1 preflight not ok: $PF"
[ -d "$CONTAINED_HOME" ] || fail "AC1 TT home not provisioned under torture-test/var/home"
[ -d "$CONTAINED_WF" ] || fail "AC1 catalog not installed under torture-test/var/home/.tamandua/workflows"
[ -f "$STAMP" ] || fail "AC1 catalog stamp missing"
STAMP_VER="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\(.*\)",\?$/\1/p' "$STAMP" | head -n1)"
[ "$STAMP_VER" = "$CUR_BUILD" ] || fail "AC1 catalog stamp version != current build ($STAMP_VER)"
[ -d "$CONTAINED_WF/do-now" ] && [ -f "$CONTAINED_WF/do-now/workflow.yml" ] \
  || fail "AC1 bundled 'do-now' workflow not present under the contained catalog"
WF_COUNT="$(find "$CONTAINED_WF" -mindepth 1 -maxdepth 1 -type d -name '[^.]*' 2>/dev/null | wc -l)"
[ "$WF_COUNT" -ge 1 ] || fail "AC1 no workflow dirs listable under the contained catalog"
WF_LIST="$(ls -1 "$CONTAINED_WF" | grep -v '^\.catalog-version\.json$' | tr '\n' ' ')"
pass "AC1: TT home provisioned; contained catalog installed + listable ($WF_COUNT workflows incl. do-now); stamp == current build"

# ── AC2: real daemon UP on 4339 during the run, STOPPED at end, nothing leaked ──
[ "$PROBE_SEEN_UP" -eq 1 ] || fail "AC2 port 4339 never observed listening DURING the campaign ($(cat "$DAEMON_PROBE_LOG" 2>/dev/null; echo '(no probe captured)'))"
printf '%s' "$PF" | grep -q '"stop_ok":true' || fail "AC2 daemon stop not recorded ok: $PF"
ensure_ports_43xx_free || fail "AC2 ports 43xx not free after the campaign (leaked daemon)"
DC_STATUS="$("$DAEMON_CONTROL" real status 2>/dev/null | grep '^STATUS:' | head -n1)"
[ "$DC_STATUS" = "STATUS: STOPPED" ] || fail "AC2 daemon-control real status is not STOPPED after campaign: $DC_STATUS"
# No live TT-owned daemon PID from provenance remains.
if [ -d "$TT_DIR/var/daemon-control" ]; then
  for prov in "$TT_DIR/var/daemon-control"/*.json; do
    [ -e "$prov" ] || continue
    pid="$(node -e "try{const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(String(j.pid??''))}catch(e){process.stdout.write('')}" "$prov" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      fail "AC2 leaked a live TT-owned daemon PID $pid ($prov)"
    fi
  done
fi
# No leaked controller process.
if kill -0 "$CONTROLLER_PID" 2>/dev/null; then
  fail "AC2 leaked a live tt-controller process $CONTROLLER_PID"
fi
echo "AC2 probe evidence (4339 up during run): $(cat "$DAEMON_PROBE_LOG" 2>/dev/null)"
pass "AC2: real daemon UP on 4339 during the run and STOPPED at campaign end; ports 43xx free, no leaked daemon/controller"

# ── AC3: real case reached `workflow run` + captured run id from the stub ──
verdict="$(read_report 'verdict')"
[ "$verdict" = '"GREEN"' ] || { echo "report:"; cat "$REPORT"; fail "AC3 campaign report verdict not GREEN: $verdict"; }
CS="$(read_state 'cases.0')"
printf '%s' "$CS" | grep -q '"outcome":"PASS"' || fail "AC3 real case did not PASS: $CS"
RUN_ID="$(read_state 'cases.0.attempts.0.run_id')"
RUN_SRC="$(read_state 'cases.0.attempts.0.run_id_source')"
[ "$RUN_ID" = "\"$STUB_RUN_ID\"" ] || {
  # fall back to reading a bare string field
  RUN_ID="$(node -e "const s=require('$STATE');process.stdout.write(s.cases[0].attempts[0].run_id||'')")"
  [ "$RUN_ID" = "$STUB_RUN_ID" ] || fail "AC3 captured run id '$RUN_ID' != stub '$STUB_RUN_ID'"
  RUN_SRC="$(node -e "const s=require('$STATE');process.stdout.write(s.cases[0].attempts[0].run_id_source||'')")"
}
[ -n "$RUN_SRC" ] || fail "AC3 no run_id_source recorded"
[ -f "$ARGV_LOG" ] || fail "AC3 launch argv log not written by the stub"
grep -q "workflow run do-now" "$ARGV_LOG" || { cat "$ARGV_LOG" >&2; fail "AC3 stub did not record a 'workflow run' invocation: $(cat "$ARGV_LOG")"; }
grep -q "$STUB_RUN_ID" <(grep '^Run:' "$ARGV_LOG" 2>/dev/null) 2>/dev/null || true
pass "AC3: first real case's launch reached 'workflow run do-now ... ' with captured run id $STUB_RUN_ID (source=$RUN_SRC): $(head -n1 "$ARGV_LOG")"

# ── AC5: zero real tokens ──────────────────────────────────────────────
TOKENS="$(read_report 'spend.tokens_observed')"
[ "$TOKENS" = "0" ] || fail "AC5 tokens observed != 0: $TOKENS"
pass "AC5: zero real tokens consumed (report spend.tokens_observed = 0)"

# ── AC4: operator hygiene canary unchanged + ~/.tamandua untouched ─────
[ "$(gitconfig_hash "$OP_GITCONFIG")" = "$OP_GIT_BEFORE" ] || fail "AC4 operator ~/.gitconfig changed during the campaign (hygiene canary diff)"
CANARY_DIFFS="$(node -e "const s=require('$STATE');process.stdout.write(JSON.stringify(s.hygiene_canary?.diffs??[]))" 2>/dev/null)"
[ "$CANARY_DIFFS" = "[]" ] || fail "AC4 hygiene canary reported a HYGIENE diff: $CANARY_DIFFS"
CANARY_STATUSES="$(node -e "const s=require('$STATE');console.log((s.hygiene_canary?.statuses??[]).map(x=>x.status).join(','))" 2>/dev/null)"
case ",$CANARY_STATUSES," in
  *,CHANGED,*) fail "AC4 hygiene canary shows a CHANGED operator identity file: $CANARY_STATUSES" ;;
esac
[ "$(operator_catalog_snapshot)" = "$OP_CATALOG_BEFORE" ] || fail "AC4 operator ~/.tamandua catalog changed"
pass "AC4: operator hygiene canary (gitconfig identity) unchanged; no HYGIENE finding; operator ~/.tamandua untouched"

printf 'RESULT: All US-008 included-real end-to-end zero-token proof assertions PASSED\n'
