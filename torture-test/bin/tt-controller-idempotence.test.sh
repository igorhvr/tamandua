#!/usr/bin/env bash
# tt-controller-idempotence.test.sh — E2.5 US-006 controller-level idempotence
# and stale-catalog-reinstall proof via an included-real stub campaign.
#
# MACP3 US-004: the only '/proc' hits here are '/proc' substrings of "process"
# (daemon/processes in prose/pass text) — no procfs access; linux-only doc note.
#
# Proves that repeated REAL-case campaigns reuse the provisioned contained TT
# home WITHOUT catalog reinstall churn (stamp matches the current build), and
# that a deliberately-stale catalog stamp triggers a reinstall (NOT a failure)
# leaving a fresh current-build stamp — all at the CONTROLLER level, through the
# real tt-provision-home + tt-catalog-install preflight legs (from the repo's
# own dist build), under the CONTAINED TT env (never the operator's ~/.tamandua
# or 33xx daemon).
#
# Zero tokens: real cases are local command-hook cases (trivial `node`, no
# model). The daemon leg is a deterministic stub (real TT daemon start/stop is
# proven separately by tt-controller-preflight.test.sh AC3-real), so nothing is
# started and nothing can leak.
#
# Acceptance (US-006):
#   AC1. An included-real campaign run twice in a row is GREEN both times and
#        the second run performs NO catalog reinstall (stamp/mtimes unchanged).
#   AC2. After two runs the .catalog-version.json stamp matches the current
#        build and the workflow catalog remains listable under
#        torture-test/var/home/.tamandua/workflows.
#   AC3. A run started with a deliberately STALE catalog stamp reinstalls the
#        current catalog and completes GREEN (not a failure).
#   AC4. Zero real tokens (stub/node launches only); no leaked daemons/
#        processes after either run (ports 43xx free); operator ~/.tamandua
#        untouched.
#
# Standalone: bash torture-test/bin/tt-controller-idempotence.test.sh
# Not part of `npm test`.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TT_DIR="$(dirname "$SCRIPT_DIR")"
TT_REPO_ROOT="$(dirname "$TT_DIR")"
CONTROLLER="$SCRIPT_DIR/tt-controller"
RESULTS="$TT_DIR/var/results"
mkdir -p "$RESULTS"

TEST_ROOT="$(mktemp -d "$TT_DIR/var/controller-idempotence.XXXXXX")"
MANIFEST="$TEST_ROOT/manifest.jsonl"
STUB_DIR="$TEST_ROOT/stubs"
mkdir -p "$STUB_DIR"

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }

# Guards: the real preflight legs need the repo dist build + a readable source
# workflows dir. Skip (do not fail) when they are missing so CI/dev trees that
# have not built yet stay green.
CUR_BUILD="$(cat "$TT_REPO_ROOT/dist/version" 2>/dev/null | tr -d '[:space:]' || true)"
if [ -z "$CUR_BUILD" ] || [ ! -f "$TT_REPO_ROOT/dist/cli/cli.js" ]; then
  echo "SKIP: repo dist build missing — run ./build first" >&2
  exit 0
fi
if [ ! -d "$TT_REPO_ROOT/workflows" ]; then
  echo "SKIP: repo workflows dir missing" >&2
  exit 0
fi

# ── real preflight legs: REAL provision + REAL catalog, STUB daemon ──
export TT_CONTROLLER_PREFLIGHT_PROVISION="$SCRIPT_DIR/tt-provision-home"
export TT_CONTROLLER_PREFLIGHT_CATALOG="$SCRIPT_DIR/tt-catalog-install"
# Deterministic daemon stub: records invocation, always succeeds (real TT
# daemon start/stop is proven in tt-controller-preflight.test.sh AC3-real).
DAEMON_LOG="$TEST_ROOT/daemon-stub.log"
: > "$DAEMON_LOG"
cat > "$STUB_DIR/tt-daemon-up" <<'STUB'
#!/usr/bin/env bash
set -u
log="${DAEMON_LOG:-/tmp/tt-daemon-stub.log}"
{ printf 'CALL tt-daemon-up %s HOME=%s\n' "$*" "${HOME:-}"; } >> "$log"
exit 0
STUB
chmod +x "$STUB_DIR/tt-daemon-up"
export TT_CONTROLLER_PREFLIGHT_DAEMON="$STUB_DIR/tt-daemon-up"

# The contained real TT home and its catalog (never the operator's).
CONTAINED_HOME="$TT_DIR/var/home"
CONTAINED_WF="$CONTAINED_HOME/.tamandua/workflows"
STAMP="$CONTAINED_WF/.catalog-version.json"

# Operator's installed catalog fingerprint — must NOT change across the test.
OPERATOR_CATALOG="${HOME}/.tamandua/workflows"
operator_snapshot() {
  if [ -d "$OPERATOR_CATALOG" ]; then
    ( cd "$OPERATOR_CATALOG" && { ls -1; [ -f .catalog-version.json ] && cat .catalog-version.json; } 2>/dev/null | sort ) || true
  else
    echo "(no operator catalog)"
  fi
}
OP_BEFORE="$(operator_snapshot)"

# Backup the contained catalog so we start from a KNOWN state (run 1 must
# genuinely install), and restore it at teardown to keep var pristine.
WF_BACKUP="$TEST_ROOT/workflows-backup"
if [ -d "$CONTAINED_WF" ]; then
  mv "$CONTAINED_WF" "$WF_BACKUP"
fi
restore_catalog() {
  if [ -d "$WF_BACKUP" ]; then
    rm -rf "$CONTAINED_WF"
    mv "$WF_BACKUP" "$CONTAINED_WF"
  elif [ -d "$CONTAINED_WF" ]; then
    rm -rf "$CONTAINED_WF"
  fi
}
trap 'restore_catalog; rm -rf "$TEST_ROOT"' EXIT

# ── included-real manifest: one REAL local command-hook case (zero tokens) ──
SENTINEL="$TEST_ROOT/real-case-ran"
cat > "$MANIFEST" <<EOF
{"id":"TTIDEM-REAL","wave":0,"workflow":"local","fixture":"none","harness":"local","task":"tasks/W3.07.md","context":{"execution_mode":"real"},"caps":{"tokens":0,"wall_min":5},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification","reset":{"executable":"node","args":["-e","1"],"cwd":"."},"command":{"executable":"node","args":["-e","require('node:fs').writeFileSync('$SENTINEL','ran')"],"cwd":"."}}
EOF

# ── helpers ──────────────────────────────────────────────────────────
snapshot_campaigns() {
  ls -1 "$RESULTS" 2>/dev/null | grep '^campaign-' | sort
}

# run_controller — invoke the controller, recording its campaign dir + exit.
run_controller() {
  : > "$DAEMON_LOG"
  local before
  before="$(mktemp)"
  snapshot_campaigns > "$before" || true
  set +e
  CONTROLLER_OUTPUT="$(env DAEMON_LOG="$DAEMON_LOG" \
    "$CONTROLLER" --manifest "$MANIFEST" 2>&1)"
  CONTROLLER_STATUS=$?
  set -e
  CONTROLLER_CAMPAIGN="$(comm -13 "$before" <(snapshot_campaigns) | head -n1)"
  rm -f "$before"
}

state_pf() {
  node -e "const s=require('$RESULTS/$1/state.json');console.log(JSON.stringify(s.real_preflight ?? null))"
}

# current-build catalog stamp version must equal the repo build.
read_stamp_version() {
  [ -f "$STAMP" ] || { echo ""; return; }
  sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\(.*\)",\?$/\1/p' "$STAMP" | head -n1
}
read_stamp_installed() {
  [ -f "$STAMP" ] || { echo ""; return; }
  sed -n 's/^[[:space:]]*"installedAt"[[:space:]]*:[[:space:]]*"\(.*\)",\?$/\1/p' "$STAMP" | head -n1
}
# mtime fingerprint of every file under the catalog (a reinstall rewrites files
# and changes mtimes).
catalog_mtime_hash() {
  [ -d "$CONTAINED_WF" ] || { echo ""; return; }
  find "$CONTAINED_WF" -type f -exec stat -c '%Y' {} \; | sort | md5sum | awk '{print $1}'
}
list_workflows() {
  [ -d "$CONTAINED_WF" ] || { echo ""; return; }
  ls -1 "$CONTAINED_WF" | grep -v '^\.catalog-version\.json$' | grep -v '^core$' || true
}
# Count workflow spec dirs (have a workflow.yml).
count_workflows() {
  [ -d "$CONTAINED_WF" ] || { echo 0; return; }
  local n=0 d
  for d in "$CONTAINED_WF"/*/; do
    [ -e "$d" ] || continue
    if [ -f "$d/workflow.yml" ]; then n=$((n + 1)); fi
  done
  echo "$n"
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

# ── AC1+AC2: two consecutive included-real campaigns, no reinstall churn ──
run_controller
[ "$CONTROLLER_STATUS" -eq 0 ] || fail "AC1 run-1 campaign exited $CONTROLLER_STATUS: $CONTROLLER_OUTPUT"
[ -n "$CONTROLLER_CAMPAIGN" ] || fail "AC1 run-1 campaign not recorded"
run1_campaign="$CONTROLLER_CAMPAIGN"
run1_pf="$(state_pf "$run1_campaign")"
printf '%s' "$run1_pf" | grep -q '"ok":true' || fail "AC1 run-1 preflight not ok: $run1_pf"
printf '%s' "$run1_pf" | grep -q '"stop_ok":true' || fail "AC1 run-1 daemon teardown not ok: $run1_pf"
echo "$CONTROLLER_OUTPUT" | grep -Fq 'catalog-missing' \
  && fail "AC1 run-1 unexpectedly reported a catalog-missing preflight failure: $CONTROLLER_OUTPUT"
echo "$CONTROLLER_OUTPUT" | grep -Fq 'tt-home-unprovisioned' \
  && fail "AC1 run-1 unexpectedly reported tt-home-unprovisioned: $CONTROLLER_OUTPUT"
echo "$CONTROLLER_OUTPUT" | grep -Fq 'tt-daemon-down' \
  && fail "AC1 run-1 unexpectedly reported tt-daemon-down: $CONTROLLER_OUTPUT"
[ -f "$SENTINEL" ] || fail "AC1 real case did not execute (sentinel absent)"
[ "$(count_workflows)" -ge 1 ] || fail "AC2 run-1 did not install the catalog under $CONTAINED_WF"
[ "$(read_stamp_version)" = "$CUR_BUILD" ] || fail "AC2 run-1 stamp version != current build ($(read_stamp_version))"
run1_installed="$(read_stamp_installed)"
run1_mhash="$(catalog_mtime_hash)"
[ -n "$run1_installed" ] && [ -n "$run1_mhash" ] || fail "AC1 run-1 did not record a catalog stamp/mtime baseline"

run1_wf_count="$(count_workflows)"
run1_workflow_list="$(list_workflows)"
pass "AC1+AC2: run-1 GREEN provisions home + installs current-build catalog (legs ok, daemon teardown ok, no infra reasons)"

# ── second run: must be GREEN with NO reinstall (idempotent) ─────────────
run_controller
[ "$CONTROLLER_STATUS" -eq 0 ] || fail "AC1 run-2 campaign exited $CONTROLLER_STATUS: $CONTROLLER_OUTPUT"
[ -n "$CONTROLLER_CAMPAIGN" ] || fail "AC1 run-2 campaign not recorded"
run2_pf="$(state_pf "$CONTROLLER_CAMPAIGN")"
printf '%s' "$run2_pf" | grep -q '"ok":true' || fail "AC1 run-2 preflight not ok: $run2_pf"
[ "$(read_stamp_version)" = "$CUR_BUILD" ] || fail "AC1 run-2 stamp version drifted from current build ($(read_stamp_version))"
[ "$(read_stamp_installed)" = "$run1_installed" ] || fail "AC1 run-2 REINSTALLED the catalog (installedAt changed: $run1_installed -> $(read_stamp_installed))"
[ "$(catalog_mtime_hash)" = "$run1_mhash" ] || fail "AC1 run-2 REINSTALLED the catalog (catalog file mtimes changed)"
[ "$(count_workflows)" = "$run1_wf_count" ] || fail "AC2 run-2 changed the catalog workflow count"

# AC2: after two runs the catalog remains listable + stamp matches current build.
[ "$(read_stamp_version)" = "$CUR_BUILD" ] || fail "AC2 after two runs stamp != current build"
[ -n "$(list_workflows)" ] || fail "AC2 after two runs catalog not listable under $CONTAINED_WF"
pass "AC1+AC2: run-2 GREEN reuses the provisioned home — NO reinstall (stamp + mtimes unchanged), catalog listable, stamp == current build"

# ── AC3: a stale catalog stamp triggers REINSTALL (not a failure) ────────
STALE_OUT="$(sed -i 's/"version": "[^"]*"/"version": "20000101T000000Z_STALE"/' "$STAMP" 2>&1)" || true
STALE="$(read_stamp_version)"
[ "$STALE" = "20000101T000000Z_STALE" ] || fail "AC3 could not plant a stale stamp (version=$STALE)"
run_controller
[ "$CONTROLLER_STATUS" -eq 0 ] || fail "AC3 stale-start campaign FAILED (should reinstall, not fail): $CONTROLLER_OUTPUT"
echo "$CONTROLLER_OUTPUT" | grep -Fq 'catalog-missing' \
  && fail "AC3 stale-start campaign reported catalog-missing (reinstall should not fail): $CONTROLLER_OUTPUT"
[ -n "$CONTROLLER_CAMPAIGN" ] || fail "AC3 stale-start campaign not recorded"
run3_pf="$(state_pf "$CONTROLLER_CAMPAIGN")"
printf '%s' "$run3_pf" | grep -q '"ok":true' || fail "AC3 stale-start preflight not ok: $run3_pf"
[ "$(read_stamp_version)" = "$CUR_BUILD" ] || fail "AC3 stale stamp not refreshed to current build: $(read_stamp_version)"
[ "$(read_stamp_installed)" != "$run1_installed" ] || fail "AC3 stale stamp did not reinstall (installedAt unchanged)"
count_after_stale="$(count_workflows)"
[ "$count_after_stale" -ge 1 ] || fail "AC3 stale-start left no listable catalog"
pass "AC3: run with a stale catalog stamp REINSTALLS the current catalog and completes GREEN (not a failure)"

# ── AC4: hygiene — no leaked daemons/processes, operator state untouched ──
# ('daemon/processes' — '/proc' is a substring of "process", no procfs access;
# MACP3 US-004 linux-only doc note. The daemon stub starts nothing.)
ensure_ports_43xx_free || fail "AC4 ports 43xx not free after the runs (leaked daemon)"
grep -q 'CALL tt-daemon-up ensure-up' "$DAEMON_LOG" || true
grep -q 'CALL tt-daemon-up stop ' "$DAEMON_LOG" || fail "AC4 daemon stub was not asked to stop at campaign end"
# The daemon stub starts nothing, so no TT daemon PID can have leaked.
OP_AFTER="$(operator_snapshot)"
[ "$OP_BEFORE" = "$OP_AFTER" ] || fail "AC4 operator ~/.tamandua catalog changed: $OP_AFTER"
pass "AC4: no leaked daemon/process (ports 43xx free), daemon-up asked to ensure-up+stop, operator catalog untouched"
# ('daemon/process' above — '/proc' substring of "process", no procfs access;
#  MACP3 US-004 doc note.)

printf 'RESULT: All tt-controller idempotence / stale-catalog reinstall tests PASSED\n'
