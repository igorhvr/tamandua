#!/usr/bin/env bash
# tt-controller-preflight.test.sh — E2.5 US-004 controller preflight wiring test.
#
# Verifies that tt-controller runs the real-case preflight chain
# (home-provision -> [harness-auth] -> catalog-install -> daemon-up) BEFORE
# any real case executes when the selection includes a real case, fails the
# campaign CLOSED with a DISTINCT reason when a leg cannot be established,
# stops the real daemon at campaign end/resume for hygiene, and never engages
# the preflight for scripted-only selections or TT_DRY_RUN_REAL_LAUNCH dry
# runs. The harness-auth leg (US-006) only runs when the current selection
# requires a real pi/hermes harness.
#
# MACP7 US-003 extends this file with the SCRIPTED-campaign preflight wiring:
# a FRESH --scripted-only campaign carrying a scripted WORKFLOW case resets
# the CONTAINED scripted state (daemon-control scripted reset-state) exactly
# once BEFORE case execution and then runs the scripted catalog install; a
# RESUME never resets; a failing reset aborts the campaign closed with the
# DISTINCT 'scripted-state-reset-failed' category and the daemon's stderr
# captured on the campaign preflight state.
#
# The preflight helper paths are injected via TT_CONTROLLER_PREFLIGHT_* so the
# wiring is exercised with deterministic stub helpers (except the final
# real-daemon scenarios, which use the real helpers to prove the contained
# real daemon comes up and is stopped with ports 43xx free, no leaked process).
#
# S26 US-004 extends this file with the campaign-start suite-state gate
# wiring: a FRESH real-campaign preflight threads `tt-daemon-up ensure-up
# --fresh` (the contained real daemon's suite_results ledger must be EMPTY),
# while a RESUME calls plain `ensure-up` (a resume reconciles prior state and
# never requires an empty suite). The real red-arm seeds the contained real DB
# with a suite_results row (backed up and restored) and pins the FAIL-CLOSED
# refusal: the campaign aborts with the DISTINCT machine-parseable reason
# 'suite-state-not-clean' recorded on the preflight state, and the daemon is
# stopped at teardown.
#
# This is NOT part of `npm test` (torture-test/.sh self-tests are standalone).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TT_DIR="$(dirname "$SCRIPT_DIR")"
TT_REPO_ROOT="$(dirname "$TT_DIR")"
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

# A real pi case + a scripted local case. The real pi case forces the preflight
# to engage AND forces the harness-auth leg (required harnesses = {pi}). The
# pi case is never actually launched: TT_CONTROLLER_DAEMON_CONTROL_PATH points
# at a missing path so executeEligibleCases marks it NOT_RUN
# (daemon-control-unavailable) instead of spawning tamandua/pi. The scripted
# case still completes green so the campaign reaches terminal reports.
PI_MANIFEST="$TEST_ROOT/manifest-pi.jsonl"
cat > "$PI_MANIFEST" <<EOF
{"id":"PF-PI","wave":0,"workflow":"tt-shim-probe","fixture":"none","harness":"pi","task":"tasks/W3.07.md","context":{"execution_mode":"real"},"caps":{"tokens":0,"wall_min":5},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
{"id":"PF-PI-SCRIPTED","wave":0,"workflow":"local","fixture":"none","harness":"local","task":"tasks/W3.07.md","context":{"execution_mode":"scripted"},"caps":{"tokens":0,"wall_min":5},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification","reset":{"executable":"node","args":["-e","1"],"cwd":"."},"command":{"executable":"node","args":["-e","require('node:fs').writeFileSync('$TEST_ROOT/command-ran-pi-scripted','ran')"],"cwd":"."}}
EOF

# Stub preflight helpers: record invocation (name, args, HOME) to $PFLOG and,
# when $PFMODE names a failure mode for this leg, fail closed with the DISTINCT
# REASON. Non TT_* env names survive the controller's spawn-env strip.
for helper in tt-provision-home tt-harness-auth-probe tt-catalog-install tt-daemon-up; do
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
  tt-harness-auth-probe)
    [ "$mode" = "fail-auth" ] && { printf 'REASON: harness-auth-missing: pi\n' >&2; exit 1; }
    ;;
  tt-catalog-install)
    [ "$mode" = "fail-catalog" ] && { printf 'REASON: catalog-missing\n' >&2; exit 1; }
    # S30 US-008: the workflow-spec preflight leg invokes the catalog helper
    # with --verify <workflow>...; a fail-workflow-spec mode mimics the real
    # refusal (workflow-spec-missing: <workflow>) so the wiring is pinned.
    if [ "${1:-}" = "--verify" ]; then
      [ "$mode" = "fail-workflow-spec" ] && { printf 'REASON: workflow-spec-missing: %s\n' "${2:-tt-shim-probe}" >&2; exit 1; }
    fi
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
  export TT_CONTROLLER_PREFLIGHT_AUTH="$STUB_DIR/tt-harness-auth-probe"
  export TT_CONTROLLER_PREFLIGHT_CATALOG="$STUB_DIR/tt-catalog-install"
  export TT_CONTROLLER_PREFLIGHT_DAEMON="$STUB_DIR/tt-daemon-up"
}
use_real() {
  unset TT_CONTROLLER_PREFLIGHT_PROVISION TT_CONTROLLER_PREFLIGHT_AUTH TT_CONTROLLER_PREFLIGHT_CATALOG TT_CONTROLLER_PREFLIGHT_DAEMON
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
  CONTROLLER_OUTPUT="$(env PFLOG="$PFLOG" PFMODE="$PFMODE" ${spare[@]+"${spare[@]}"} \
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
grep -q '^CALL tt-daemon-up args=ensure-up --fresh' "$PFLOG" || fail "AC1 no ensure-up --fresh call: $(cat "$PFLOG")"
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

# ══ AC1 (pi): a real pi selection runs harness-auth BETWEEN home-provision and
# catalog-install, then still reaches terminal reports. The pi case is NOT_RUN
# (daemon-control-unavailable via the injected missing path) so no tamandua/pi
# is spawned; the scripted case completes green.
use_stubs
run_controller "" TT_CONTROLLER_DAEMON_CONTROL_PATH="$TEST_ROOT/missing-daemon-control" -- --manifest "$PI_MANIFEST"
[ -n "$CONTROLLER_CAMPAIGN" ] || fail "AC1 pi campaign not recorded"
ac1pi_pf="$(state_pf "$CONTROLLER_CAMPAIGN")"
printf '%s' "$ac1pi_pf" | grep -q '"ok":true' || fail "AC1 pi preflight not ok: $ac1pi_pf"
printf '%s' "$ac1pi_pf" | grep -q '"leg":"harness-auth"' || fail "AC1 pi preflight missing harness-auth leg: $ac1pi_pf"
legs="$(grep '^CALL ' "$PFLOG" | sed -n 's/^CALL \([^ ]*\) .*/\1/p')"
[ "$(printf '%s\n' "$legs" | grep -c .)" -eq 6 ] || fail "AC1 pi expected 6 preflight calls, got: $(cat "$PFLOG")"
[ "$(printf '%s\n' "$legs" | sed -n 1p)" = "tt-provision-home" ] || fail "AC1 pi leg1 not home-provision: $(cat "$PFLOG")"
[ "$(printf '%s\n' "$legs" | sed -n 2p)" = "tt-harness-auth-probe" ] || fail "AC1 pi leg2 not harness-auth: $(cat "$PFLOG")"
[ "$(printf '%s\n' "$legs" | sed -n 3p)" = "tt-catalog-install" ] || fail "AC1 pi leg3 not catalog-install: $(cat "$PFLOG")"
# S30 US-008: the workflow-spec leg reuses the catalog-install helper with
# --verify <workflow>... and must sit BETWEEN catalog-install and daemon-up.
[ "$(printf '%s\n' "$legs" | sed -n 4p)" = "tt-catalog-install" ] || fail "AC1 pi leg4 not workflow-spec (catalog-install --verify): $(cat "$PFLOG")"
grep -q '^CALL tt-catalog-install args=--verify tt-shim-probe' "$PFLOG" || fail "AC1 pi workflow-spec leg did not verify tt-shim-probe: $(cat "$PFLOG")"
[ "$(printf '%s\n' "$legs" | sed -n 5p)" = "tt-daemon-up" ] || fail "AC1 pi leg5 not daemon-up: $(cat "$PFLOG")"
[ "$(printf '%s\n' "$legs" | sed -n 6p)" = "tt-daemon-up" ] || fail "AC1 pi leg6 (teardown) not daemon-up stop: $(cat "$PFLOG")"
grep -q '^CALL tt-harness-auth-probe args=pi ' "$PFLOG" || fail "AC1 pi did not probe pi harness: $(cat "$PFLOG")"
grep -q '^CALL tt-daemon-up args=ensure-up --fresh' "$PFLOG" || fail "AC1 pi daemon-up did not thread ensure-up --fresh (fresh campaign): $(cat "$PFLOG")"
pass "AC1 (pi): real pi selection runs provision->harness-auth->catalog->workflow-spec->daemon-up before cases"

# ══ AC2 (auth): failing harness-auth leg -> harness-auth-missing: pi.
run_controller "fail-auth" TT_CONTROLLER_DAEMON_CONTROL_PATH="$TEST_ROOT/missing-daemon-control" -- --manifest "$PI_MANIFEST"
printf '%s' "$CONTROLLER_OUTPUT" | grep -Fq 'harness-auth-missing: pi' \
  || fail "AC2 auth failure did not surface harness-auth-missing: pi: $CONTROLLER_OUTPUT"
[ "$CONTROLLER_STATUS" -ne 0 ] || fail "AC2 auth failure did not abort (exit 0)"
ac2a_pf="$(state_pf "$CONTROLLER_CAMPAIGN")"
printf '%s' "$ac2a_pf" | grep -q '"reason":"harness-auth-missing: pi"' || fail "AC2 auth reason not harness-auth-missing: pi: $ac2a_pf"
printf '%s' "$ac2a_pf" | grep -q '"stop_ok":true' || fail "AC2 auth daemon teardown did not run on preflight failure: $ac2a_pf"
pass "AC2: harness-auth-missing: pi leg aborts non-zero and records the DISTINCT reason"

# ══ AC2d (S30 US-008): failing workflow-spec leg -> workflow-spec-missing: <wf>.
# The real-case preflight's workflow-spec leg (catalog-install --verify
# <workflow>...) fails closed with the DISTINCT machine-parseable reason
# `workflow-spec-missing: <workflow>` BEFORE any launch when a selected case's
# declared workflow is absent from the installed catalog — the W4.14 defect
# class (`No workflow.yml found in .../workflows/<workflow>` at launch) is
# caught at preflight, never at launch.
# Remove the AC1 (pi) execution marker first — the earlier AC1(pi) stub
# scenario completed its scripted case, so the refusal must be proven against
# a FRESH marker state (the workflow-spec preflight must abort BEFORE any case
# execution creates a NEW marker).
rm -f "$TEST_ROOT/command-ran-pi-scripted"
run_controller "fail-workflow-spec" TT_CONTROLLER_DAEMON_CONTROL_PATH="$TEST_ROOT/missing-daemon-control" -- --manifest "$PI_MANIFEST"
printf '%s' "$CONTROLLER_OUTPUT" | grep -Fq 'workflow-spec-missing: tt-shim-probe'   || fail "AC2d workflow-spec failure did not surface workflow-spec-missing: tt-shim-probe: $CONTROLLER_OUTPUT"
[ "$CONTROLLER_STATUS" -ne 0 ] || fail "AC2d workflow-spec failure did not abort (exit 0)"
ac2d_pf="$(state_pf "$CONTROLLER_CAMPAIGN")"
printf '%s' "$ac2d_pf" | grep -q '"reason":"workflow-spec-missing: tt-shim-probe"'   || fail "AC2d workflow-spec reason not workflow-spec-missing: tt-shim-probe: $ac2d_pf"
printf '%s' "$ac2d_pf" | grep -q '"leg":"workflow-spec"'   || fail "AC2d failing leg not workflow-spec: $ac2d_pf"
printf '%s' "$ac2d_pf" | grep -q '"stop_ok":true'   || fail "AC2d daemon teardown did not run on workflow-spec refusal: $ac2d_pf"
[ ! -f "$TEST_ROOT/command-ran-pi-scripted" ]   || fail "AC2d workflow-spec refusal must happen BEFORE any case execution: $(cat "$PFLOG")"
pass "AC2d: workflow-spec-missing: tt-shim-probe leg aborts non-zero and records the DISTINCT reason (before any launch)"

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
grep -q '^CALL tt-daemon-up args=ensure-up ' "$PFLOG" || fail "AC3 resume did not re-verify daemon-up: $(cat "$PFLOG")"
if grep -q '^CALL tt-daemon-up args=ensure-up --fresh' "$PFLOG"; then
  fail "AC3 resume must NOT thread ensure-up --fresh (resume never requires an empty suite): $(cat "$PFLOG")"
else
  pass "AC3 resume calls plain ensure-up (no --fresh) — the suite-state gate is FRESH-campaign-only"
fi
grep -q '^CALL tt-daemon-up args=stop ' "$PFLOG" || fail "AC3 resume did not stop the daemon at end: $(cat "$PFLOG")"
pass "AC3: resume re-runs the preflight and stops the daemon at campaign end"

# ══ AC3 (real): real helpers bring the real daemon up and stop it; ports 43xx
# free afterwards, no leaked TT daemon process.
# S24/US-006: prepend THIS worktree's bin/ to PATH so daemon-control's
# reconstructed launch PATH resolves THIS tree's build (the S15 build-version
# parity guard compares the daemon's /control/health buildVersion against the
# worktree's dist/version — resolving the operator's installed build, which
# diverges after any worktree rebuild, fails closed tt-daemon-stale). Same
# note as tt-daemon-up.test.sh AC2.
use_real
ensure_ports_43xx_free || fail "real-daemon scenario: ports 43xx not free to start"
set +e
CONTROLLER_OUTPUT="$(PATH="$TT_REPO_ROOT/bin:$PATH" PFLOG="$PFLOG" PFMODE="$PFMODE" "$CONTROLLER" --manifest "$MANIFEST" 2>&1)"
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

# ══ MACP7 US-003: per-campaign scripted-state reset in the scripted preflight ══
# A FRESH --scripted-only campaign carrying a scripted WORKFLOW case must
# reset the CONTAINED scripted state (daemon-control scripted reset-state)
# exactly ONCE before case execution, then run the scripted catalog install
# into the fresh home; a RESUME must NOT reset (it reconciles the persisted
# state from the previous attempt). A failing reset aborts the campaign closed
# with the DISTINCT machine-parseable 'scripted-state-reset-failed' category
# and the daemon's stderr captured on the campaign preflight state.
#
# The scripted WORKFLOW case (harness scripted-pi, execution_mode scripted,
# fixture 'none', NO scenario cell) is hermetic: the launch/status polls go
# through a stub `tamandua` on PATH, and the daemon-control invocations go
# through a stub daemon-control inside torture-test/var (so
# daemonControlAvailable() resolves it). Zero tokens; the only real contained
# mutation is the catalog-install leg's `workflow install --all` into
# var/home-scripted/.tamandua, which is backed up and restored here.
WF_MANIFEST="$TEST_ROOT/manifest-scripted-wf.jsonl"
cat > "$WF_MANIFEST" <<EOF
{"id":"PF-SCRIPTED-WF","wave":4,"workflow":"bug-fix-merge-worktree","fixture":"none","harness":"scripted-pi","task":"tasks/W3.07.md","context":{"execution_mode":"scripted","test_cmd":"npm test"},"caps":{"tokens":0,"wall_min":5},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
EOF

# Stub `tamandua` on PATH (default stdout mode): `workflow run` prints the run
# id + terminal wait JSON, status polls return completed, runs return empty,
# stop/wait are no-ops — the same hermetic shape tt-controller.test.sh uses.
WF_BIN="$TEST_ROOT/wf-bin"
WF_EVENTS="$TEST_ROOT/wf-events.jsonl"
mkdir -p "$WF_BIN"
: > "$WF_EVENTS"
cat > "$WF_BIN/tamandua" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$(node -e 'process.stdout.write(JSON.stringify({argv:process.argv.slice(1),at:Date.now()}))' "$@")" >> "${CONTROLLER_WORKFLOW_EVENTS:-/tmp/controller-wf-events.jsonl}"
if [ "${1:-}" = "workflow" ] && [ "${2:-}" = "runs" ]; then printf '%s\n' '{"runs":[]}'; exit 0; fi
if [ "${1:-}" = "workflow" ] && [ "${2:-}" = "status" ]; then
  printf '{"runId":"run-11111111-1111-4111-8111-111111111111","status":"completed","tokensSpent":0,"steps":[]}\n'
  exit 0
fi
if [ "${1:-}" = "workflow" ] && [ "${2:-}" = "stop" ]; then exit 0; fi
if [ "${1:-}" = "workflow" ] && [ "${2:-}" = "wait" ]; then
  printf '{"runs":[{"runId":"%s","status":"completed"}],"timedOut":false}\n' "${3:-}"
  exit 0
fi
printf 'Run: run-11111111-1111-4111-8111-111111111111\n'
printf '{"status":"completed"}\n'
STUB
chmod +x "$WF_BIN/tamandua"

# Stub daemon-control (inside torture-test/var so daemonControlAvailable()
# resolves it): records every invocation to $DC_LOG. reset-state is
# RECORDING-ONLY here — the DESTRUCTIVE semantics (removal + recreation of
# the contained state dir) belong to daemon-control itself (US-001,
# daemon-control.test.sh) and to the scenario harness (US-002,
# scripted-scenario-harness.test.ts); this test pins the CONTROLLER wiring:
# exactly-once invocation before case execution, no reset on resume, and
# fail-closed on a failing reset. Keeping the state dir intact also lets the
# hermetic workflow case execute to terminal against the pre-seeded minimal
# DB (a real campaign gets its DB from the daemon start instead). A
# fail-reset mode prints the DISTINCT REASON and exits 1 so the campaign's
# fail-closed path is exercised.
DC_LOG="$TEST_ROOT/daemon-control-events.jsonl"
DC_MODE_FILE="$TEST_ROOT/dc-mode"
: > "$DC_LOG"
printf 'ok' > "$DC_MODE_FILE"
dc_stub="$STUB_DIR/daemon-control"
cat > "$dc_stub" <<'STUB'
#!/usr/bin/env bash
set -u
{ printf 'CALL daemon-control %s\n' "$*"; } >> "${DC_LOG:-/tmp/controller-dc.log}"
mode="ok"
[ -n "${DC_MODE_FILE:-}" ] && [ -f "$DC_MODE_FILE" ] && mode="$(cat "$DC_MODE_FILE")"
if [ "${1:-}" = "scripted" ] && [ "${2:-}" = "reset-state" ]; then
  if [ "$mode" = "fail-reset" ]; then
    printf 'REASON: scripted-state-reset-failed\n' >&2
    exit 1
  fi
  printf 'STATUS: RESET_STATE_OK\n'
  printf '  state_dir: %s\n' "${TAMANDUA_STATE_DIR:-}"
  exit 0
fi
exit 0
STUB
chmod +x "$dc_stub"

# Backup the CONTAINED scripted state around the campaign tests (the catalog-
# install leg mutates var/home-scripted/.tamandua), then seed a minimal
# runs/steps-schema DB so the hermetic workflow case's run-inventory query has
# a contained DB to read (history-independent — the same seed tt-controller
# .test.sh uses). Restored even on failure via the EXIT trap.
SCRIPTED_HOME="$TT_DIR/var/home-scripted"
SCRIPTED_STATE="$SCRIPTED_HOME/.tamandua"
SCRIPTED_STATE_BACKUP="$TEST_ROOT/original-scripted-state"
if [ -d "$SCRIPTED_STATE" ]; then mv "$SCRIPTED_STATE" "$SCRIPTED_STATE_BACKUP"; fi
mkdir -p "$SCRIPTED_STATE"
node --input-type=module - "$SCRIPTED_STATE/tamandua.db" <<'NODE'
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
restore_scripted_state() {
  rm -rf -- "$SCRIPTED_STATE"
  if [ -d "$SCRIPTED_STATE_BACKUP" ]; then mv "$SCRIPTED_STATE_BACKUP" "$SCRIPTED_STATE"; fi
}
trap restore_scripted_state EXIT

state_spf() {
  node -e "const s=require('$RESULTS/$1/state.json');console.log(JSON.stringify(s.scripted_preflight ?? null))"
}
dc_reset_count() { grep -c 'reset-state' "$DC_LOG" || true; }

# ══ AC1+AC4: a fresh --scripted-only campaign with a scripted WORKFLOW case
# invokes `daemon-control scripted reset-state` exactly once BEFORE case
# execution, then the scripted catalog install runs into the fresh home.
use_stubs
: > "$DC_LOG"
: > "$WF_EVENTS"
run_controller "" TT_CONTROLLER_DAEMON_CONTROL_PATH="$dc_stub" \
  DC_LOG="$DC_LOG" DC_MODE_FILE="$DC_MODE_FILE" \
  CONTROLLER_WORKFLOW_EVENTS="$WF_EVENTS" PATH="$WF_BIN:$PATH" -- \
  --manifest "$WF_MANIFEST" --scripted-only
[ "$CONTROLLER_STATUS" -eq 0 ] || fail "US-003 AC1 fresh scripted-only campaign failed: $CONTROLLER_OUTPUT"
[ -n "$CONTROLLER_CAMPAIGN" ] || fail "US-003 AC1 campaign not recorded"
ac1_wf_campaign="$CONTROLLER_CAMPAIGN"
[ "$(dc_reset_count)" -eq 1 ] || fail "US-003 AC1 reset-state not invoked exactly once: $(cat "$DC_LOG")"
[ "$(grep -c '^CALL daemon-control scripted stop' "$DC_LOG" || true)" -eq 2 ] \
  || fail "US-003 AC1 expected stop (preflight) + stop (teardown): $(cat "$DC_LOG")"
first_stop="$(grep -n '^CALL daemon-control scripted stop' "$DC_LOG" | head -n1 | cut -d: -f1)"
reset_line="$(grep -n 'reset-state' "$DC_LOG" | cut -d: -f1)"
[ -n "$reset_line" ] && [ "$reset_line" -gt "$first_stop" ] \
  || fail "US-003 AC1 reset-state must come after the preflight stop: $(cat "$DC_LOG")"
grep -q '"argv":\["workflow","run"' "$WF_EVENTS" \
  || fail "US-003 AC1 workflow case did not execute after the reset: $(cat "$WF_EVENTS")"
ac1_spf="$(state_spf "$ac1_wf_campaign")"
printf '%s' "$ac1_spf" | grep -q '"ok":true' || fail "US-003 AC1 scripted_preflight not ok: $ac1_spf"
printf '%s' "$ac1_spf" | grep -q '"stop_ok":true' || fail "US-003 AC1 preflight stop not recorded ok: $ac1_spf"
printf '%s' "$ac1_spf" | grep -q '"leg":"reset-state"' || fail "US-003 AC1 preflight leg not reset-state: $ac1_spf"
[ -d "$SCRIPTED_STATE/workflows" ] && [ -n "$(ls -A "$SCRIPTED_STATE/workflows" 2>/dev/null)" ] \
  || fail "US-003 AC4 scripted catalog install did not run after the reset: $SCRIPTED_STATE/workflows missing or empty"
pass "US-003 AC1+AC4: fresh scripted-only campaign resets the contained scripted state exactly once before cases, then installs the catalog"

# ══ AC2: a resumed campaign does NOT invoke reset-state (resume reconciles
# the persisted state from the previous attempt); it still reaches terminal.
: > "$DC_LOG"
run_controller "" TT_CONTROLLER_DAEMON_CONTROL_PATH="$dc_stub" \
  DC_LOG="$DC_LOG" DC_MODE_FILE="$DC_MODE_FILE" \
  CONTROLLER_WORKFLOW_EVENTS="$WF_EVENTS" PATH="$WF_BIN:$PATH" -- \
  --manifest "$WF_MANIFEST" --resume "$ac1_wf_campaign"
[ "$CONTROLLER_STATUS" -eq 0 ] || fail "US-003 AC2 resume failed: $CONTROLLER_OUTPUT"
[ "$(dc_reset_count)" -eq 0 ] || fail "US-003 AC2 resume must NOT reset-state: $(cat "$DC_LOG")"
[ "$(grep -c '^CALL daemon-control scripted stop' "$DC_LOG" || true)" -eq 1 ] \
  || fail "US-003 AC2 resume expected only the teardown stop: $(cat "$DC_LOG")"
pass "US-003 AC2: a resumed campaign does not invoke reset-state"

# ══ AC3: a failing reset-state aborts the campaign closed with the DISTINCT
# 'scripted-state-reset-failed' category and the daemon's stderr captured.
printf 'fail-reset' > "$DC_MODE_FILE"
: > "$DC_LOG"
: > "$WF_EVENTS"
run_controller "" TT_CONTROLLER_DAEMON_CONTROL_PATH="$dc_stub" \
  DC_LOG="$DC_LOG" DC_MODE_FILE="$DC_MODE_FILE" \
  CONTROLLER_WORKFLOW_EVENTS="$WF_EVENTS" PATH="$WF_BIN:$PATH" -- \
  --manifest "$WF_MANIFEST" --scripted-only
printf '%s' "$CONTROLLER_OUTPUT" | grep -Fq 'scripted-state-reset-failed' \
  || fail "US-003 AC3 reset failure did not surface scripted-state-reset-failed: $CONTROLLER_OUTPUT"
[ "$CONTROLLER_STATUS" -ne 0 ] || fail "US-003 AC3 reset failure did not abort (exit 0)"
[ -n "$CONTROLLER_CAMPAIGN" ] || fail "US-003 AC3 campaign not recorded"
ac3_spf="$(state_spf "$CONTROLLER_CAMPAIGN")"
printf '%s' "$ac3_spf" | grep -q '"ok":false' || fail "US-003 AC3 scripted_preflight not failed: $ac3_spf"
printf '%s' "$ac3_spf" | grep -q '"reason":"scripted-state-reset-failed"' \
  || fail "US-003 AC3 reason not scripted-state-reset-failed: $ac3_spf"
printf '%s' "$ac3_spf" | grep -q '"stderr_tail":' \
  || fail "US-003 AC3 daemon stderr not captured on the preflight state: $ac3_spf"
[ ! -s "$WF_EVENTS" ] || fail "US-003 AC3 case execution must not start after a failed reset: $(cat "$WF_EVENTS")"
pass "US-003 AC3: a failing reset-state aborts closed with scripted-state-reset-failed and captured stderr"

restore_scripted_state
trap - EXIT

# ══ S26 US-004 (real red-arm): a FRESH real-campaign preflight with a
# NON-EMPTY contained suite_results FAILS CLOSED with the DISTINCT
# machine-parseable reason 'suite-state-not-clean' (attempt-1's
# cross-campaign contamination is impossible). The contained real DB is
# seeded with one suite_results row (the pre-existing DB — if any — is backed
# up and restored around the scenario); the operator's ~/.tamandua and the
# 33xx daemon are untouched. The controller threads `ensure-up --fresh` on
# the FRESH path, the daemon-up leg probes the seeded ledger, refuses, and
# the campaign aborts with the reason recorded on the preflight state.
use_real
ensure_ports_43xx_free || fail "S26 red-arm: ports 43xx not free to start"
REAL_DB="$TT_DIR/var/home/.tamandua/tamandua.db"
REAL_DB_BACKUP="$TEST_ROOT/real-db.s26.backup"
if [ -f "$REAL_DB" ]; then cp "$REAL_DB" "$REAL_DB_BACKUP"; fi
mkdir -p "$(dirname "$REAL_DB")"
node -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.argv[1]);
  db.exec("CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, run_number INTEGER, workflow_id TEXT, task TEXT, status TEXT, context TEXT, created_at TEXT, updated_at TEXT, tokens_spent INTEGER, worker_lost_count INTEGER, ceiling_expiry_count INTEGER)");
  db.exec("CREATE TABLE IF NOT EXISTS steps (step_id TEXT PRIMARY KEY, agent_id TEXT, step_index INTEGER, status TEXT, type TEXT, current_story_id TEXT, retry_count INTEGER, abandoned_count INTEGER, reroute_count INTEGER, claim_pid INTEGER, claim_updated_at TEXT, updated_at TEXT)");
  db.exec("CREATE TABLE IF NOT EXISTS suite_results (id INTEGER PRIMARY KEY, origin_repo TEXT NOT NULL, tree_hash TEXT NOT NULL, cmd_hash TEXT NOT NULL, cmd_display TEXT NOT NULL, exit_code INTEGER NOT NULL, duration_ms INTEGER NOT NULL, log_tail TEXT, run_id TEXT, step_id TEXT, created_at TEXT NOT NULL)");
  db.prepare("INSERT INTO suite_results (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, run_id, step_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("stale-cross-campaign-repo", "tree", "cmd", "npm test", 0, 100, null, null, null, new Date().toISOString());
  db.close();
' "$REAL_DB" || fail "S26 red-arm: could not seed the contained real DB"
seeded_count="$(node -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1],{readOnly:true});let c="ERR";try{c=String(db.prepare("SELECT COUNT(*) AS c FROM suite_results").get().c)}catch(e){c="ERR:"+e.message}db.close();process.stdout.write(c)' "$REAL_DB")"
[ "$seeded_count" = "1" ] || fail "S26 red-arm: seeded DB has suite_rows=$seeded_count (want 1) at $REAL_DB"
restore_s26_db() {
  if [ -f "$REAL_DB_BACKUP" ]; then mv -f "$REAL_DB_BACKUP" "$REAL_DB"; else rm -f "$REAL_DB"; fi
  trap - EXIT
}
trap restore_s26_db EXIT
set +e
CONTROLLER_OUTPUT="$(PATH="$TT_REPO_ROOT/bin:$PATH" PFLOG="$PFLOG" PFMODE="$PFMODE" "$CONTROLLER" --manifest "$MANIFEST" 2>&1)"
CONTROLLER_STATUS=$?
set -e
[ "$CONTROLLER_STATUS" -ne 0 ] \
  || fail "S26 red-arm: a FRESH campaign with non-empty suite_results must fail closed (exit 0): $CONTROLLER_OUTPUT"
printf '%s' "$CONTROLLER_OUTPUT" | grep -Fq 'suite-state-not-clean' \
  || fail "S26 red-arm: controller did not surface suite-state-not-clean: $CONTROLLER_OUTPUT"
s26_campaign="$(snapshot_campaigns | tail -n1)"
[ -n "$s26_campaign" ] || fail "S26 red-arm: campaign not recorded"
s26_pf="$(state_pf "$s26_campaign")"
printf '%s' "$s26_pf" | grep -q '"reason":"suite-state-not-clean"' \
  || fail "S26 red-arm: state.real_preflight reason not suite-state-not-clean: $s26_pf"
printf '%s' "$s26_pf" | grep -q '"leg":"daemon-up"' \
  || fail "S26 red-arm: failing leg not daemon-up: $s26_pf"
printf '%s' "$s26_pf" | grep -q '"stop_ok":true' \
  || fail "S26 red-arm: daemon teardown did not run on the suite-state refusal: $s26_pf"
ensure_ports_43xx_free || fail "S26 red-arm: ports 43xx left occupied after the refusal"
pass "S26 (real red-arm): a FRESH campaign with a non-empty contained suite_results fails closed with suite-state-not-clean (daemon-up leg) + teardown"
restore_s26_db

printf 'RESULT: All tt-controller preflight wiring tests PASSED\n'
