#!/usr/bin/env bash
# tt-bare-tier1-nohome-proof.test.sh — E2.5 US-007 bare --tier1 stays GREEN with
# the real TT home deleted (local/scripted cases need no real daemon).
#
# Proves (zero tokens — bare --tier1 is --scripted-only, real cases become
# NOT_RUN pending-real):
#   1. With torture-test/var/home deleted (the CONTAINED real TT home) and any
#      real daemon state gone, `run-torture-test --tier1` exits GREEN twice in a
#      row.
#   2. Neither run engages the real-case preflight (US-004) — state.real_preflight
#      is null and execution_selection is 'scripted-only'.
#   3. Neither run recreates/provisions the real TT home (var/home stays absent).
#   4. No real daemon (43xx) is started: ports 4334/4338/4339 stay free, the
#      contained daemon's provenance PID is not alive, and no tt-controller /
#      tt-daemon-up / daemon-control / real tamandua daemon process leaks.
#   5. Local/scripted cases reach a terminal outcome (PASS or NOT_RUN(predicate))
#      without provisioning the real home; real cases stay NOT_RUN(pending-real).
#
# This is NOT part of `npm test` (torture-test/.sh self-tests are standalone).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TT_DIR="$(dirname "$SCRIPT_DIR")"          # torture-test/
REPO_ROOT="$(dirname "$TT_DIR")"           # repo root (holds run-torture-test)
RUNNER="$REPO_ROOT/run-torture-test"
RESULTS="$TT_DIR/var/results"
CONTAINED_HOME="$TT_DIR/var/home"
PROVENANCE_DIR="$TT_DIR/var/daemon-control"
MANIFEST="$TT_DIR/cases/tier1.jsonl"
mkdir -p "$RESULTS"

TEST_ROOT="$(mktemp -d "$TT_DIR/var/bare-tier1-nohome.XXXXXX")"
HOME_BACKUP="$TEST_ROOT/home-backup"
CAMPAIGN_LIST="$TEST_ROOT/campaigns"

fail_count=0
total_count=0
fail() { printf 'FAIL: %s\n' "$1" >&2; fail_count=$((fail_count + 1)); }
pass() { printf 'PASS: %s\n' "$1" >&2; }

ensure_ports_43xx_free() {
  local p
  for p in 4334 4338 4339; do
    if bash -c "echo >/dev/tcp/localhost/$p" 2>/dev/null; then
      return 1
    fi
  done
  return 0
}

# Is any REAL contained daemon alive right now? A real tamandua daemon started
# against the contained home would be a node daemon with a live PID recorded in
# the real provenance file; a port free is the strongest signal. We also refuse
# pre-existing leaks: the test must start from a clean 43xx.
real_daemon_alive() {
  # If the real provenance records a PID, and it is a live process, treat as alive.
  if [ -d "$PROVENANCE_DIR" ]; then
    for prov in "$PROVENANCE_DIR"/real.json; do
      [ -e "$prov" ] || continue
      pid="$(node -e "try{const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(String(j.pid??''))}catch(e){process.stdout.write('')}" "$prov" 2>/dev/null || true)"
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        return 0
      fi
    done
  fi
  return 1
}

snapshot_campaigns() {
  ls -1 "$RESULTS" 2>/dev/null | grep '^campaign-' | sort
}

# ── entry hygiene: start clean ────────────────────────────────────────
if ! ensure_ports_43xx_free; then
  fail "ports 43xx not free before the test (a stale real daemon is present)"
fi

# ── delete the real TT home (and any contained real daemon state) ─────
if [ -d "$CONTAINED_HOME" ]; then
  mv "$CONTAINED_HOME" "$HOME_BACKUP"
fi
if [ ! -d "$CONTAINED_HOME" ]; then
  pass "TC: real TT home deleted for the test"
else
  fail "real TT home still present before the test"
fi

cleanup() {
  # Restore the original contained real TT home if we moved it aside.
  if [ -d "$HOME_BACKUP" ]; then
    rm -rf "$CONTAINED_HOME"
    mv "$HOME_BACKUP" "$CONTAINED_HOME"
  fi
  # Remove the campaign dirs this test created (runtime hygiene).
  if [ -f "$CAMPAIGN_LIST" ]; then
    while IFS= read -r d; do
      [ -n "$d" ] && [ -d "$d" ] && rm -rf "$d"
    done < "$CAMPAIGN_LIST"
  fi
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT
: > "$CAMPAIGN_LIST"

# ── helper: run bare --tier1 once, asserting it stays GREEN ──────────
run_bare_tier1() {
  local label="$1"
  local before after new_campaign output status out statefile
  before="$(mktemp)"
  snapshot_campaigns > "$before" || true
  total_count=$((total_count + 1))
  printf -- '--- %s: run-torture-test --tier1 ---\n' "$label" >&2
  set +e
  output="$("$RUNNER" --tier1 2>&1)"
  status=$?
  set -e
  printf '%s\n' "$output" >&2
  if [ "$status" -eq 0 ]; then
    pass "$label: run-torture-test --tier1 exited GREEN (0)"
  else
    fail "$label: run-torture-test --tier1 exited non-zero ($status)"
    rm -f "$before"
    return
  fi
  after="$(mktemp)"
  snapshot_campaigns > "$after" || true
  new_campaign="$(comm -13 "$before" "$after" | head -n1)"
  rm -f "$before" "$after"
  if [ -n "$new_campaign" ] && [ -d "$RESULTS/$new_campaign" ]; then
    printf '%s\n' "$RESULTS/$new_campaign" >> "$CAMPAIGN_LIST"
    pass "$label: campaign recorded: $new_campaign"
  else
    fail "$label: no new campaign directory recorded"
    return
  fi
  statefile="$RESULTS/$new_campaign/state.json"
  out="$(node --input-type=module - "$statefile" <<'NODE'
import fs from 'node:fs';
const s = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const rows = s.cases.map(c => [c.id, c.outcome, c.reason?.category ?? '', c.phase].join('|'));
process.stdout.write(JSON.stringify({
  preflight: s.real_preflight ?? null,
  selection: s.options?.execution_selection ?? null,
  rows,
}));
NODE
)"
  local preflight selection rows
  preflight="$(printf '%s' "$out" | node --input-type=module -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);process.stdout.write(String(j.preflight))})")"
  selection="$(printf '%s' "$out" | node --input-type=module -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);process.stdout.write(String(j.selection))})")"
  total_count=$((total_count + 1))
  if [ "$preflight" = "null" ]; then
    pass "$label: real-case preflight NOT engaged (state.real_preflight is null)"
  else
    fail "$label: preflight engaged for scripted-only: $preflight"
  fi
  total_count=$((total_count + 1))
  if [ "$selection" = "scripted-only" ]; then
    pass "$label: execution_selection is scripted-only"
  else
    fail "$label: execution_selection is '$selection' (expected scripted-only)"
  fi
  # Every case terminal; real cases NOT_RUN pending-real; no infra reason on scripted cases.
  total_count=$((total_count + 1))
  local proof
  proof="$(node --input-type=module - "$statefile" "$MANIFEST" <<'NODE'
import fs from 'node:fs';
const s = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
// Execution mode must be derived from the MANIFEST (state cases do not
// carry context.execution_mode). Mirror caseUsesScriptedEnvironment.
const mode = new Map();
for (const line of fs.readFileSync(process.argv[3],'utf8').trim().split('\n')) {
  if (!line.trim()) continue;
  const r = JSON.parse(line);
  const sc = r.harness === 'scripted-pi' || r.harness === 'scripted-hermes' || r.context?.execution_mode === 'scripted';
  mode.set(r.id, sc ? 'scripted' : 'real');
}
const failures=[];
let ok=0;
for (const c of s.cases) {
  const m = mode.get(c.id) || 'real';
  if (c.phase !== 'terminal') { failures.push(`${c.id}: phase=${c.phase}`); continue; }
  if (m === 'real') {
    if (c.outcome !== 'NOT_RUN' || c.reason?.category !== 'pending-real')
      failures.push(`${c.id}: real case expected NOT_RUN pending-real, got ${c.outcome}/${c.reason?.category}`);
    else ok++;
  } else {
    if (!['PASS','NOT_RUN'].includes(c.outcome))
      failures.push(`${c.id}: scripted outcome=${c.outcome} cat=${c.reason?.category}`);
    else ok++;
  }
}
if (failures.length === 0) process.stdout.write(`PROOF_OK ${ok}/${s.cases.length}`);
else process.stdout.write(`PROOF_FAIL ${failures.join(';')}`);
NODE
)"
  if printf '%s' "$proof" | grep -q '^PROOF_OK'; then
    pass "$label: all cases terminal; real cases NOT_RUN(pending-real); scripted cases PASS/NOT_RUN ($proof)"
  else
    fail "$label: $proof"
  fi
}

# ── core proof: bare --tier1 stays GREEN with home deleted, twice ─────
run_bare_tier1 "RUN-1"

# Home must still be absent after run 1 (nothing provisioned the real TT home).
total_count=$((total_count + 1))
if [ ! -d "$CONTAINED_HOME" ]; then
  pass "RUN-1: real TT home still absent (scripted cases did not provision it)"
else
  fail "RUN-1: real TT home was re-created by a scripted-only run"
fi

# No real daemon / no leaked process after run 1.
total_count=$((total_count + 1))
if ensure_ports_43xx_free; then
  pass "RUN-1: ports 43xx free (no real daemon started)"
else
  fail "RUN-1: a 43xx port is occupied"
fi
total_count=$((total_count + 1))
if ! real_daemon_alive; then
  pass "RUN-1: no live contained real-daemon process"
else
  fail "RUN-1: a contained real daemon PID is still alive"
fi

run_bare_tier1 "RUN-2"

total_count=$((total_count + 1))
if [ ! -d "$CONTAINED_HOME" ]; then
  pass "RUN-2: real TT home still absent after second run"
else
  fail "RUN-2: real TT home was re-created by a scripted-only run"
fi
total_count=$((total_count + 1))
if ensure_ports_43xx_free; then
  pass "RUN-2: ports 43xx free (no real daemon started)"
else
  fail "RUN-2: a 43xx port is occupied"
fi
total_count=$((total_count + 1))
if ! real_daemon_alive; then
  pass "RUN-2: no live contained real-daemon process"
else
  fail "RUN-2: a contained real daemon PID is still alive"
fi
total_count=$((total_count + 1))
# Final sweep: no leftover tt-controller / tt-daemon-up / daemon-control procs
# (the .test.sh's own pid is excluded by the [x] bracket trick).
# US-012: match the TT binaries as standalone cmdline tokens — a naive
# substring pgrep false-positives on coordination watcher loops from OTHER
# agents whose pgrep PATTERNS merely contain "tt-controller"/"daemon-control"
# as quoted literals (e.g. pgrep -f ".../bin/tt-controller"). Real workers
# always carry the binary name followed by a space (argv) or end-of-cmdline,
# so the anchored pattern below still catches every actual leak.
leaked="$(pgrep -af '(^|[ /])(tt-controller|tt-daemon-up|daemon-control)( |$)' || true)"
if [ -n "$leaked" ]; then
  fail "leaked torture-test/tamandua worker process after the runs: $(printf '%s' "$leaked" | tr '\n' ';')"
else
  pass "no leaked torture-test/tamandua worker processes after the runs"
fi

printf '\n--- Results: %d/%d passed ---\n' "$((total_count - fail_count))" "$total_count" >&2
[ "$fail_count" -eq 0 ] && exit 0 || exit 1
