#!/usr/bin/env bash
# tt-controller-infra-classify.test.sh — E2.5 US-005 launch-error classification.
#
# Verifies that a real-case launch whose stderr carries a DEFINITE
# infrastructure failure is classified TEST_INFRA_FAIL by its ACTUAL reason
# (never the generic workflow-run-identification / missing-run-identifier),
# and that a genuinely ambiguous launch (no captured run id AND no infra
# signature) KEEPS the legacy workflow-run-identification / missing-run-identifier
# classification.
#
# The launch is driven by a deterministic `tamandua` stub on PATH that emits the
# desired infra signature on stderr and exits non-zero (zero real tokens, no
# model). The real-case campaign preflight (US-004) is disabled via
# TT_CONTROLLER_PREFLIGHT_DISABLED=1 so this test stays focused on the launch
# classification branch and needs no real daemon / 43xx ports.
#
# This is NOT part of `npm test` (torture-test/.sh self-tests are standalone).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TT_DIR="$(dirname "$SCRIPT_DIR")"
CONTROLLER="$SCRIPT_DIR/tt-controller"
RESULTS="$TT_DIR/var/results"
mkdir -p "$RESULTS"

TEST_ROOT="$(mktemp -d "$TT_DIR/var/controller-infra-classify.XXXXXX")"
MANIFEST="$TEST_ROOT/manifest.jsonl"
STUB_DIR="$TEST_ROOT/stubs"
mkdir -p "$STUB_DIR" "$TEST_ROOT/manifests"

HOST_PROFILE="$TT_DIR/var/w0/host-profile.json"
HOST_PROFILE_BACKUP="$TEST_ROOT/original-host-profile.json"
mkdir -p "$(dirname "$HOST_PROFILE")"
if [ -f "$HOST_PROFILE" ]; then cp "$HOST_PROFILE" "$HOST_PROFILE_BACKUP"; fi

CAMPAIGNS="$TEST_ROOT/campaign-dirs"
: > "$CAMPAIGNS"

cleanup() {
  trap - EXIT
  if [ -f "$HOST_PROFILE_BACKUP" ]; then
    cp "$HOST_PROFILE_BACKUP" "$HOST_PROFILE"
  else
    rm -f -- "$HOST_PROFILE"
  fi
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

# A single deterministic real workflow case (fixture tt-ts golden exists).
cat > "$MANIFEST" <<'M'
{"id":"INFRA-CLASSIFY","wave":0,"workflow":"bug-fix-merge-worktree","fixture":"tt-ts","harness":"hermes","task":"tasks/W3.07.md","context":{},"caps":{"tokens":4000000,"wall_min":240},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
M

# tamandua stub: a `workflow run` launch emits the requested launch-stderr
# signature (via STUB_MODE) on stderr and exits non-zero. Every other call is
# a no-op success (the launch never captures a run id, so nothing else matters
# for this branch). Zero tokens, no model.
cat > "$STUB_DIR/tamandua" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "workflow" ] && [ "${2:-}" = "run" ]; then
  mode="$(cat "${STUB_MODE:?}")"
  case "$mode" in
    nospec)
      printf 'Error: No workflow.yml found in /var/home/.tamandua/workflows/do-now.\nExpected a workflow specification file.\n' >&2
      ;;
    enoent)
      printf 'Error: ENOENT: no such file or directory, scandir /var/home/.tamandua/workflows\n' >&2
      ;;
    ambiguous)
      printf 'launch ended before identifiers\n' >&2
      ;;
    *) printf 'unknown stub mode: %s\n' "$mode" >&2 ;;
  esac
  exit 1
fi
exit 0
STUB
chmod +x "$STUB_DIR/tamandua"

# run_case <mode> -> sets CONTROLLER_STATUS, CONTROLLER_CAMPAIGN (dir under RESULTS)
run_case() {
  local mode="$1"
  local mode_file="$TEST_ROOT/mode"
  printf '%s' "$mode" > "$mode_file"
  local before
  before="$(mktemp)"
  ls -1 "$RESULTS" 2>/dev/null | grep '^campaign-' | sort > "$before" || true
  set +e
  CONTROLLER_OUTPUT="$(env PATH="$STUB_DIR:$PATH" STUB_MODE="$mode_file" \
    TT_CONTROLLER_PREFLIGHT_DISABLED=1 "$CONTROLLER" --manifest "$MANIFEST" 2>&1)"
  CONTROLLER_STATUS=$?
  set -e
  CONTROLLER_CAMPAIGN="$(comm -13 "$before" <(ls -1 "$RESULTS" 2>/dev/null | grep '^campaign-' | sort) | head -n1)"
  rm -f "$before"
  [ -n "$CONTROLLER_CAMPAIGN" ] \
    || fail "controller did not record a campaign for mode '$mode': $CONTROLLER_OUTPUT"
  printf '%s/%s\n' "$RESULTS" "$CONTROLLER_CAMPAIGN" >> "$CAMPAIGNS"
}

# ── AC1/AC2: definite infra signatures are classified by their actual reason ──
for mode in nospec enoent; do
  expected_cat="workflow-spec-missing"
  [ "$mode" = "enoent" ] && expected_cat="workflow-dir-enoent"
  run_case "$mode"
  [ "$CONTROLLER_STATUS" -eq 2 ] \
    || fail "mode '$mode' launch exited $CONTROLLER_STATUS instead of 2: $CONTROLLER_OUTPUT"
  node --input-type=module - "$RESULTS/$CONTROLLER_CAMPAIGN/state.json" "$expected_cat" <<'NODE'
import fs from 'node:fs';
const [statePath, expectedCat] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const item = state.cases[0];
if (item.phase !== 'terminal' || item.outcome !== 'TEST_INFRA_FAIL'
    || item.reason?.category !== expectedCat
    || item.reason?.category === 'workflow-run-identification') {
  throw new Error(`infra launch not classified by its actual reason: ${JSON.stringify(item)}`);
}
if (typeof item.reason?.message !== 'string' || item.reason.message.length === 0
    || typeof item.reason?.signature !== 'string' || item.reason.signature.length === 0) {
  throw new Error(`infra launch did not surface the stderr evidence: ${JSON.stringify(item.reason)}`);
}
if (JSON.stringify(item.reason).indexOf('missing-run-identifier') !== -1) {
  throw new Error(`infra launch reason still names missing-run-identifier: ${JSON.stringify(item.reason)}`);
}
NODE
  pass "mode '$mode' launch classified by actual infra reason ($expected_cat), not missing-run-identifier"
done

# ── AC3: genuinely ambiguous launch keeps the legacy classification ──
run_case ambiguous
[ "$CONTROLLER_STATUS" -eq 2 ] \
  || fail "ambiguous launch exited $CONTROLLER_STATUS instead of 2: $CONTROLLER_OUTPUT"
node --input-type=module - "$RESULTS/$CONTROLLER_CAMPAIGN/state.json" <<'NODE'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const item = state.cases[0];
if (item.phase !== 'terminal' || item.outcome !== 'TEST_INFRA_FAIL'
    || item.reason?.category !== 'workflow-run-identification'
    || item.reason?.error?.category !== 'missing-run-identifier') {
  throw new Error(`ambiguous launch did not keep legacy classification: ${JSON.stringify(item)}`);
}
NODE
pass "ambiguous launch (no infra signature) keeps workflow-run-identification / missing-run-identifier"

# Hygiene: preflight disabled => no real daemon/43xx ports touched; nothing leaked.
pass "US-005 launch-error classification self-test complete"
