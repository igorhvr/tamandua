#!/usr/bin/env bash
# tt-controller-preflight.test.sh — E2.5 US-004 controller preflight wiring test.
#
# Verifies that tt-controller runs the real-case preflight chain
# (home-provision -> catalog-install -> daemon-up) BEFORE any real case
# executes when the selection includes a real case, fails the campaign CLOSED
# with a DISTINCT reason when a leg cannot be established, stops the real
# daemon at campaign end/resume for hygiene, and never engages the preflight
# for scripted-only selections or TT_DRY_RUN_REAL_LAUNCH dry runs.
#
# The preflight helper paths are injected via TT_CONTROLLER_PREFLIGHT_* so the
# wiring is exercised with deterministic stub helpers (except the final
# real-daemon scenario, which uses the real helpers to prove the contained
# real daemon comes up and is stopped with ports 43xx free, no leaked process).
#
# This is NOT part of `npm test` (torture-test/.sh self-tests are standalone).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TT_DIR="$(dirname "$SCRIPT_DIR")"
CONTROLLER="$SCRIPT_DIR/tt-controller"
RESULTS="$TT_DIR/var/results"
mkdir -p "$RESULTS"

TEST_ROOT="$(mktemp -d "$TT_DIR/var/controller-preflight.XXXXXX")"
MANIFEST="$TEST_ROOT/manifest.jsonl"
STUB_DIR="$TEST_ROOT/stubs"
mkdir -p "$STUB_DIR"

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }

# ── shared resources (PFLOG/PFMODE avoid the TT_* strip in the spawn env) ──
PFLOG="$TEST_ROOT/preflight-helper.log"
PFMODE="$TEST_ROOT/pf-mode"
: > "$PFLOG"
: > "$PFMODE"

# A real (execution_mode=real) local case + a scripted local case. The real
# case is what forces the preflight to engage; both complete green via trivial
# node commands (no model, no stub tamandua needed).
cat > "$MANIFEST" <<EOF
{"id":"PF-REAL","wave":0,"workflow":"local","fixture":"none","harness":"local","task":"tasks/W3.07.md","context":{"execution_mode":"real"},"caps":{"tokens":0,"wall_min":5},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification","reset":{"executable":"node","args":["-e","1"],"cwd":"."},"command":{"executable":"node","args":["-e","require('node:fs').writeFileSync('$TEST_ROOT/command-ran','ran')"],"cwd":"."}}
{"id":"PF-SCRIPTED","wave":0,"workflow":"local","fixture":"none","harness":"local","task":"tasks/W3.07.md","context":{"execution_mode":"scripted"},"caps":{"tokens":0,"wall_min":5},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification","reset":{"executable":"node","args":["-e","1"],"cwd":"."},"command":{"executable":"node","args":["-e","require('node:fs').writeFileSync('$TEST_ROOT/command-ran2','ran')"],"cwd":"."}}
EOF

# Stub preflight helpers: record invocation (name, args, HOME) to $PFLOG and,
# when $PFMODE names a failure mode for this leg, fail closed with the DISTINCT
# REASON. Non TT_* env names survive the controller's spawn-env strip.
for helper in tt-provision-home tt-catalog-install tt-daemon-up; do
  cat > "$STUB_DIR/$helper" <<'STUB'
#!/usr/bin/env bash
set -u
name="$(basename "$0")"
log="${PFLOG:-/tmp/controller-preflight-helper.log}"
mode=""
[ -n "${PFMODE:-}" ] && [ -f "$PFMODE" ] && mode="$(cat "$PFMODE")"
{ printf 'CALL %s args=%s HOME=%s\n' "$name" "$*" "${HOME:-}"; } >> "$log"
case "$name" in
  tt-provision-home)
    [ "$mode" = "fail-provision" ] && { printf 'REASON: tt-home-unprovisioned\n' >&2; exit 1; }
    ;;
  tt-catalog-install)
    [ "$mode" = "fail-catalog" ] && { printf 'REASON: catalog-missing\n' >&2; exit 1; }
    ;;
  tt-daemon-up)
    [ "$mode" = "fail-daemon" ] && { printf 'REASON: tt-daemon-down\n' >&2; exit 1; }
    ;;
esac
exit 0
STUB
  chmod +x "$STUB_DIR/$helper"
done

# Point the controller's preflight at the stubs (exported so they survive into
# the controller process env). TT_CONTROLLER_PREFLIGHT_* is read by the
# controller from process.env before stripping, so it is honored.
use_stubs() {
  export TT_CONTROLLER_PREFLIGHT_PROVISION="$STUB_DIR/tt-provision-home"
  export TT_CONTROLLER_PREFLIGHT_CATALOG="$STUB_DIR/tt-catalog-install"
  export TT_CONTROLLER_PREFLIGHT_DAEMON="$STUB_DIR/tt-daemon-up"
}
use_real() {
  unset TT_CONTROLLER_PREFLIGHT_PROVISION TT_CONTROLLER_PREFLIGHT_CATALOG TT_CONTROLLER_PREFLIGHT_DAEMON
}

# ── helpers ──────────────────────────────────────────────────────────
snapshot_campaigns() {
  ls -1 "$RESULTS" 2>/dev/null | grep '^campaign-' | sort
}

# run_controller <mode> [<extra-env...>] -- <controller args...>
# Extra env vars (KEY=VAL) are passed to the controller; everything after the
# first bare `--` is a controller argument.
run_controller() {
  local mode="$1"
  shift
  : > "$PFLOG"
  printf '%s' "$mode" > "$PFMODE"
  local -a spare=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --) shift; break ;;
      *) spare+=("$1"); shift ;;
    esac
  done
  local before
  before="$(mktemp)"
  snapshot_campaigns > "$before" || true
  set +e
  CONTROLLER_OUTPUT="$(env PFLOG="$PFLOG" PFMODE="$PFMODE" "${spare[@]}" \
    "$CONTROLLER" "$@" 2>&1)"
  CONTROLLER_STATUS=$?
  set -e
  CONTROLLER_CAMPAIGN="$(comm -13 "$before" <(snapshot_campaigns) | head -n1)"
  rm -f "$before"
}

ensure_ports_43xx_free() {
  local p
  for p in 4334 4338 4339; do
    if bash -c "echo >/dev/tcp/localhost/$p" 2>/dev/null; then
      return 1
    fi
  done
  return 0
}

state_pf() {
  node -e "const s=require('$RESULTS/$1/state.json');console.log(JSON.stringify(s.real_preflight ?? null))"
}

contained_home="$TT_DIR/var/home"

ensure_ports_43xx_free \
  || fail "contained real ports 43xx are not free before the test (stale daemon present)"

# ══ AC1+AC3+AC5: real selection runs home-provision -> catalog-install ->
# daemon-up BEFORE any case and stops the daemon at teardown, under CONTAINED home.
use_stubs
run_controller "" -- --manifest "$MANIFEST"
[ "$CONTROLLER_STATUS" -eq 0 ] || fail "AC1 real-selection campaign exited $CONTROLLER_STATUS: $CONTROLLER_OUTPUT"
[ -n "$CONTROLLER_CAMPAIGN" ] || fail "AC1 campaign not recorded"
ac1_campaign="$CONTROLLER_CAMPAIGN"

legs="$(grep '^CALL ' "$PFLOG" | sed -n 's/^CALL \([^ ]*\) .*/\1/p')"
[ "$(printf '%s\n' "$legs" | grep -c .)" -eq 4 ] || fail "AC1 expected 4 preflight calls, got: $(cat "$PFLOG")"
[ "$(printf '%s\n' "$legs" | sed -n 1p)" = "tt-provision-home" ] || fail "AC1 leg1 not home-provision: $(cat "$PFLOG")"
[ "$(printf '%s\n' "$legs" | sed -n 2p)" = "tt-catalog-install" ] || fail "AC1 leg2 not catalog-install: $(cat "$PFLOG")"
[ "$(printf '%s\n' "$legs" | sed -n 3p)" = "tt-daemon-up" ] || fail "AC1 leg3 not daemon-up: $(cat "$PFLOG")"
[ "$(printf '%s\n' "$legs" | sed -n 4p)" = "tt-daemon-up" ] || fail "AC1 leg4 (teardown) not daemon-up stop: $(cat "$PFLOG")"
grep -q '^CALL tt-daemon-up args=ensure-up' "$PFLOG" || fail "AC1 no ensure-up call: $(cat "$PFLOG")"
grep -q '^CALL tt-daemon-up args=stop ' "$PFLOG" || fail "AC1 no stop call at teardown: $(cat "$PFLOG")"
grep -q "HOME=$contained_home" "$PFLOG" || fail "AC5 preflight did not run under contained home: $(cat "$PFLOG")"

ac1_pf="$(state_pf "$CONTROLLER_CAMPAIGN")"
printf '%s' "$ac1_pf" | grep -q '"ok":true' || fail "AC1 state.real_preflight not ok: $ac1_pf"
printf '%s' "$ac1_pf" | grep -q '"stop_ok":true' || fail "AC3 daemon stop not recorded ok: $ac1_pf"
printf '%s' "$ac1_pf" | grep -q '"engaged":true' || fail "AC1 state.real_preflight not engaged: $ac1_pf"
[ -f "$TEST_ROOT/command-ran" ] && [ -f "$TEST_ROOT/command-ran2" ] \
  || fail "AC1 real/scripted cases did not both execute after the preflight"
pass "AC1+AC3+AC5: real selection runs provision->catalog->daemon-up before cases, stops daemon at teardown, under the contained home"

# ══ AC2a: failing catalog leg aborts the campaign closed with catalog-missing.
run_controller "fail-catalog" -- --manifest "$MANIFEST"
printf '%s' "$CONTROLLER_OUTPUT" | grep -Fq 'catalog-missing' \
  || fail "AC2 catalog failure did not surface catalog-missing: $CONTROLLER_OUTPUT"
[ "$CONTROLLER_STATUS" -ne 0 ] || fail "AC2 catalog failure did not abort (exit 0)"
[ -n "$CONTROLLER_CAMPAIGN" ] || fail "AC2 campaign not recorded"
ac2_pf="$(state_pf "$CONTROLLER_CAMPAIGN")"
printf '%s' "$ac2_pf" | grep -q '"reason":"catalog-missing"' || fail "AC2 recorded reason not catalog-missing: $ac2_pf"
printf '%s' "$ac2_pf" | grep -q '"stop_ok":true' || fail "AC2 daemon teardown did not run on preflight failure: $ac2_pf"
pass "AC2: catalog-missing leg aborts non-zero and records the DISTINCT reason (not run-identification)"

# ══ AC2b: failing provision leg -> tt-home-unprovisioned.
run_controller "fail-provision" -- --manifest "$MANIFEST"
printf '%s' "$CONTROLLER_OUTPUT" | grep -Fq 'tt-home-unprovisioned' \
  || fail "AC2 provision failure did not surface tt-home-unprovisioned: $CONTROLLER_OUTPUT"
[ "$CONTROLLER_STATUS" -ne 0 ] || fail "AC2 provision failure did not abort (exit 0)"
ac2b_pf="$(state_pf "$CONTROLLER_CAMPAIGN")"
printf '%s' "$ac2b_pf" | grep -q '"reason":"tt-home-unprovisioned"' || fail "AC2 provision reason not tt-home-unprovisioned: $ac2b_pf"
pass "AC2: tt-home-unprovisioned leg aborts non-zero and records the DISTINCT reason"

# ══ AC2c: failing daemon leg -> tt-daemon-down.
run_controller "fail-daemon" -- --manifest "$MANIFEST"
printf '%s' "$CONTROLLER_OUTPUT" | grep -Fq 'tt-daemon-down' \
  || fail "AC2 daemon failure did not surface tt-daemon-down: $CONTROLLER_OUTPUT"
[ "$CONTROLLER_STATUS" -ne 0 ] || fail "AC2 daemon failure did not abort (exit 0)"
ac2c_pf="$(state_pf "$CONTROLLER_CAMPAIGN")"
printf '%s' "$ac2c_pf" | grep -q '"reason":"tt-daemon-down"' || fail "AC2 daemon reason not tt-daemon-down: $ac2c_pf"
pass "AC2: tt-daemon-down leg aborts non-zero and records the DISTINCT reason"

# ══ AC4: scripted-only selection never engages the preflight / daemon.
use_stubs
run_controller "" -- --manifest "$MANIFEST" --scripted-only
[ "$CONTROLLER_STATUS" -eq 0 ] || fail "AC4 scripted-only campaign failed: $CONTROLLER_OUTPUT"
[ -n "$CONTROLLER_CAMPAIGN" ] || fail "AC4 scripted-only campaign not recorded"
ac4_pf="$(state_pf "$CONTROLLER_CAMPAIGN")"
[ "$ac4_pf" = "null" ] || fail "AC4 scripted-only engaged the preflight: $ac4_pf"
[ ! -s "$PFLOG" ] || fail "AC4 scripted-only invoked preflight helpers: $(cat "$PFLOG")"
pass "AC4: scripted-only performs NO preflight / daemon start-stop and passes"

# ══ AC4: TT_DRY_RUN_REAL_LAUNCH dry run never engages the preflight / daemon.
run_controller "" TT_DRY_RUN_REAL_LAUNCH="$TEST_ROOT/dryrun-argv.jsonl" -- --manifest "$MANIFEST"
[ "$CONTROLLER_STATUS" -eq 0 ] || fail "AC4 dry-run campaign failed: $CONTROLLER_OUTPUT"
[ -n "$CONTROLLER_CAMPAIGN" ] || fail "AC4 dry-run campaign not recorded"
ac4d_pf="$(state_pf "$CONTROLLER_CAMPAIGN")"
[ "$ac4d_pf" = "null" ] || fail "AC4 dry-run engaged the preflight: $ac4d_pf"
pass "AC4: TT_DRY_RUN_REAL_LAUNCH dry run performs NO preflight / daemon start-stop and passes"

# ══ AC3: resume also verifies the preflight and stops the daemon at end.
run_controller "" -- --manifest "$MANIFEST" --resume "$ac1_campaign"
[ "$CONTROLLER_STATUS" -eq 0 ] || fail "AC3 resume failed: $CONTROLLER_OUTPUT"
grep -q '^CALL tt-daemon-up args=ensure-up' "$PFLOG" || fail "AC3 resume did not re-verify daemon-up: $(cat "$PFLOG")"
grep -q '^CALL tt-daemon-up args=stop ' "$PFLOG" || fail "AC3 resume did not stop the daemon at end: $(cat "$PFLOG")"
pass "AC3: resume re-runs the preflight and stops the daemon at campaign end"

# ══ AC3 (real): real helpers bring the real daemon up and stop it; ports 43xx
# free afterwards, no leaked TT daemon process.
use_real
ensure_ports_43xx_free || fail "real-daemon scenario: ports 43xx not free to start"
set +e
CONTROLLER_OUTPUT="$(PFLOG="$PFLOG" PFMODE="$PFMODE" "$CONTROLLER" --manifest "$MANIFEST" 2>&1)"
CONTROLLER_STATUS=$?
set -e
[ "$CONTROLLER_STATUS" -eq 0 ] || fail "real-daemon controller campaign failed: $CONTROLLER_OUTPUT"
real_campaign="$(snapshot_campaigns | tail -n1)"
real_pf="$(state_pf "$real_campaign")"
printf '%s' "$real_pf" | grep -q '"ok":true' || fail "real-daemon preflight did not succeed: $real_pf"
printf '%s' "$real_pf" | grep -q '"stop_ok":true' || fail "real-daemon stop not recorded ok: $real_pf"
ensure_ports_43xx_free || fail "AC3 real-daemon campaign left ports 43xx occupied (leaked daemon)"
# No lingering TT-owned daemon PID in daemon-control provenance remains alive.
if [ -d "$TT_DIR/var/daemon-control" ]; then
  for prov in "$TT_DIR/var/daemon-control"/*.json; do
    [ -e "$prov" ] || continue
    pid="$(node -e "try{const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(String(j.pid??''))}catch(e){process.stdout.write('')}" "$prov" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      fail "real-daemon campaign leaked a live TT-owned daemon PID $pid ($prov)"
    fi
  done
fi
pass "AC3 (real): controller brought the real TT daemon up and stopped it; ports 43xx free, no leaked daemon"

printf 'RESULT: All tt-controller preflight wiring tests PASSED\n'
