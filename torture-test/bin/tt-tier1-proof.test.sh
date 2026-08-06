#!/usr/bin/env bash
# tt-tier1-proof.test.sh — Tier-1 idempotent zero-token validation proof
#
# Validates:
#   1. tt-tier1-assets + tt-controller --validate-only both exit 0
#   2. With a synthesized host-profile that forces NOT_RUN(predicate) on
#      scripted cases, the controller produces identical outcomes across
#      two consecutive runs — real cases NOT_RUN(pending-real), scripted
#      cases NOT_RUN(predicate) — with zero tokens spent.
#   3. All case paths stay within torture-test/; hygiene sweeps clean.
#
# All work inside torture-test/; zero tokens; no 33xx daemon access.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TT_DIR="$(dirname "$SCRIPT_DIR")"
MANIFEST="$TT_DIR/cases/tier1.jsonl"
CONTROLLER="$SCRIPT_DIR/tt-controller"
TIER1_ASSETS="$SCRIPT_DIR/tt-tier1-assets"
HOST_PROFILE="$TT_DIR/var/w0/host-profile.json"
HOST_PROFILE_BACKUP="$SCRIPT_DIR/.tt-tier1-proof-host-profile-backup"
CAMPAIGN_LIST="$SCRIPT_DIR/.tt-tier1-proof-campaigns"

fail_count=0
total_count=0

fail() { echo "FAIL: $1" >&2; fail_count=$((fail_count + 1)); }
pass() { echo "PASS: $1" >&2; }

# ── isolation: save / restore host-profile ────────────────────────
mkdir -p "$(dirname "$HOST_PROFILE")"
if [ -f "$HOST_PROFILE" ]; then
  cp "$HOST_PROFILE" "$HOST_PROFILE_BACKUP"
fi

cleanup() {
  if [ -f "$HOST_PROFILE_BACKUP" ]; then
    cp "$HOST_PROFILE_BACKUP" "$HOST_PROFILE"
    rm -f "$HOST_PROFILE_BACKUP"
  else
    rm -f "$HOST_PROFILE"
  fi
  if [ -f "$CAMPAIGN_LIST" ]; then
    while IFS= read -r d; do
      [ -n "$d" ] && [ -d "$d" ] && rm -rf "$d"
    done < "$CAMPAIGN_LIST"
    rm -f "$CAMPAIGN_LIST"
  fi
}
trap cleanup EXIT

# ── Test 1: tt-tier1-assets validates the manifest ─────────────────
total_count=$((total_count + 1))
echo "--- Test 1: tt-tier1-assets validates tier1.jsonl ---" >&2
if "$TIER1_ASSETS" "$MANIFEST" >/dev/null 2>&1; then
  pass "tt-tier1-assets exits 0"
else
  fail "tt-tier1-assets exits non-zero"
fi

# ── Test 2: tt-controller --validate-only passes ───────────────────
total_count=$((total_count + 1))
echo "--- Test 2: tt-controller --validate-only on tier1.jsonl ---" >&2
if "$CONTROLLER" --manifest "$MANIFEST" --validate-only >/dev/null 2>&1; then
  pass "tt-controller --validate-only exits 0"
else
  fail "tt-controller --validate-only exits non-zero"
fi

# ── Synthesize host-profile that yields NOT_RUN(predicate) ────────
# Scripted cases (W2.21, W2.23a/b/c) require node-sqlite capability.
# By omitting it, they become NOT_RUN(predicate).
# Real cases become NOT_RUN(pending-real) from --scripted-only policy.
# Net result: every case terminal, zero tokens spent.
cat > "$HOST_PROFILE" <<'JSON'
{
  "platform": {"os": "linux", "label": "linux"},
  "containment": {"systemdUserScope": true, "procfs": true},
  "toolchains": {
    "node": {"present": true, "buildPassed": true, "testPassed": true},
    "python3": {"present": true, "buildPassed": true, "testPassed": true}
  },
  "nodeRuntimes": [
    {"version": "v24.0.0", "major": 24, "sqliteAvailable": false}
  ],
  "capabilities": {},
  "harness": {
    "pi": {"authenticated": true},
    "hermes": {"authenticated": true}
  }
}
JSON

# ── Helper: run controller --scripted-only, return campaign dir ────
: > "$CAMPAIGN_LIST"

run_tier1_campaign() {
  local output status campaign_id campaign_dir
  set +e
  output=$("$CONTROLLER" --manifest "$MANIFEST" --scripted-only 2>&1)
  status=$?
  set -e
  # Print controller output to stderr for visibility
  printf '%s\n' "$output" >&2
  if [ "$status" -gt 2 ]; then
    fail "controller exited $status (expected <=2)"
    return 1
  fi
  campaign_id="$(printf '%s\n' "$output" | sed -n 's/^Campaign: //p' | tail -1)"
  if [ -z "$campaign_id" ]; then
    fail "controller output did not identify campaign"
    return 1
  fi
  campaign_dir="$TT_DIR/var/results/$campaign_id"
  if [ ! -d "$campaign_dir" ]; then
    fail "campaign directory $campaign_dir does not exist"
    return 1
  fi
  printf '%s\n' "$campaign_dir" >> "$CAMPAIGN_LIST"
  # Only output campaign dir to stdout (for capture)
  printf '%s' "$campaign_dir"
}

# ── Test 3: First campaign run ─────────────────────────────────────
total_count=$((total_count + 1))
echo "--- Test 3: First tier1 campaign run (scripted-only) ---" >&2
campaign1=$(run_tier1_campaign)
if [ -n "$campaign1" ] && [ -d "$campaign1" ]; then
  pass "first campaign created: $(basename "$campaign1")"
else
  fail "first campaign did not produce a directory"
  campaign1=""
fi

# ── Test 4: Second campaign run (idempotency) ──────────────────────
total_count=$((total_count + 1))
echo "--- Test 4: Second tier1 campaign run (idempotency) ---" >&2
campaign2=$(run_tier1_campaign)
if [ -n "$campaign2" ] && [ -d "$campaign2" ]; then
  pass "second campaign created: $(basename "$campaign2")"
else
  fail "second campaign did not produce a directory"
  campaign2=""
fi

# ── Test 5: Outcomes identical across runs ─────────────────────────
total_count=$((total_count + 1))
echo "--- Test 5: Campaign outcomes are identical ---" >&2
if [ -n "$campaign1" ] && [ -n "$campaign2" ]; then
  outcomes1=$(node --input-type=module - "$campaign1/state.json" <<'NODE'
import fs from 'node:fs';
const s = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.stdout.write(JSON.stringify(s.cases.map(c => ({id:c.id,outcome:c.outcome,reason:c.reason?.category??null,tokens:c.spend?.tokens_observed??0}))));
NODE
)
  outcomes2=$(node --input-type=module - "$campaign2/state.json" <<'NODE'
import fs from 'node:fs';
const s = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.stdout.write(JSON.stringify(s.cases.map(c => ({id:c.id,outcome:c.outcome,reason:c.reason?.category??null,tokens:c.spend?.tokens_observed??0}))));
NODE
)
  if [ "$outcomes1" = "$outcomes2" ]; then
    pass "campaign outcomes are identical across two runs"
  else
    fail "campaign outcomes differ between runs"
  fi
else
  fail "skipped — campaign directories missing"
fi

# ── Test 6: All cases are NOT_RUN (pending-real or predicate) ──────
total_count=$((total_count + 1))
echo "--- Test 6: Every case is pending-real or NOT_RUN(predicate) ---" >&2
if [ -n "$campaign1" ]; then
  proof_out=$(node --input-type=module - "$campaign1/state.json" "$MANIFEST" <<'NODE'
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const manifestText = fs.readFileSync(process.argv[3], 'utf8');
const manifestLines = manifestText.trim().split('\n').filter(l => l.trim());
const caseMeta = new Map();
for (const line of manifestLines) {
  const rec = JSON.parse(line);
  caseMeta.set(rec.id, { mode: rec.context?.execution_mode || 'real', wave: rec.wave, spec_ref: rec.spec_ref || '' });
}
const failures = [];
let ok = 0;
for (const c of state.cases) {
  const meta = caseMeta.get(c.id);
  if (c.phase !== 'terminal') { failures.push(`${c.id}: phase=${c.phase}`); continue; }
  if (c.outcome !== 'NOT_RUN') { failures.push(`${c.id}: outcome=${c.outcome}`); continue; }
  const cat = c.reason?.category;
  if (meta && meta.mode === 'real' && cat !== 'pending-real') failures.push(`${c.id}: real case — expected pending-real, got ${cat}`);
  else if (meta && meta.mode === 'scripted' && cat !== 'predicate') failures.push(`${c.id}: scripted case — expected predicate, got ${cat}`);
  else if (!meta) failures.push(`${c.id}: not found in manifest`);
  else ok++;
}
if (failures.length === 0 && ok === state.cases.length) {
  console.log(`PASS_PROOF: ${ok}/${state.cases.length} cases correct`);
} else {
  console.log(`FAIL_PROOF: ${failures.length} failures, ${ok} ok`);
  for (const f of failures) console.log(`  ${f}`);
}
NODE
  )
  if echo "$proof_out" | grep -q '^PASS_PROOF:'; then
    pass "$(echo "$proof_out" | head -1)"
  else
    fail "$proof_out"
  fi
else
  fail "skipped — campaign directory missing"
fi

# ── Test 7: Zero tokens spent ──────────────────────────────────────
total_count=$((total_count + 1))
echo "--- Test 7: Zero tokens spent ---" >&2
if [ -n "$campaign1" ] && [ -n "$campaign2" ]; then
  t1=$(node --input-type=module -e "import fs from 'node:fs';const s=JSON.parse(fs.readFileSync('$campaign1/state.json','utf8'));process.stdout.write(String(s.spend?.tokens_observed??'ERR'))" 2>/dev/null)
  t2=$(node --input-type=module -e "import fs from 'node:fs';const s=JSON.parse(fs.readFileSync('$campaign2/state.json','utf8'));process.stdout.write(String(s.spend?.tokens_observed??'ERR'))" 2>/dev/null)
  all_zero=true
  if [ "$t1" != "0" ]; then fail "campaign 1 tokens=$t1 (expected 0)"; all_zero=false; fi
  if [ "$t2" != "0" ]; then fail "campaign 2 tokens=$t2 (expected 0)"; all_zero=false; fi
  if $all_zero; then pass "both campaigns spent zero tokens"; fi
else
  fail "skipped — campaign directories missing"
fi

# ── Test 8: Per-case zero tokens ───────────────────────────────────
total_count=$((total_count + 1))
echo "--- Test 8: Per-case zero tokens ---" >&2
if [ -n "$campaign1" ]; then
  per_case_result=$(node --input-type=module - "$campaign1/state.json" <<'NODE'
import fs from 'node:fs';
const s = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const violators = s.cases.filter(c => (c.spend?.tokens_observed ?? 0) !== 0);
if (violators.length === 0) console.log('ALL_ZERO');
else console.log('VIOLATIONS: ' + violators.map(c => c.id + '=' + (c.spend?.tokens_observed ?? 0)).join(', '));
NODE
  )
  if echo "$per_case_result" | grep -q '^ALL_ZERO$'; then
    pass "all cases have zero tokens_observed"
  else
    fail "$per_case_result"
  fi
else
  fail "skipped — campaign directory missing"
fi

# ── Test 9: Case path containment ──────────────────────────────────
total_count=$((total_count + 1))
echo "--- Test 9: All case paths within torture-test/ ---" >&2
path_out=$(node --input-type=module - "$MANIFEST" "$TT_DIR" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const manifestPath = process.argv[2];
const ttRoot = fs.realpathSync(process.argv[3]);
const text = fs.readFileSync(manifestPath, 'utf8');
const lines = text.trim().split('\n').filter(l => l.trim());
const violations = [];
for (const line of lines) {
  const rec = JSON.parse(line);
  if (rec.task) {
    const r = path.resolve(ttRoot, rec.task);
    if (!r.startsWith(ttRoot + path.sep) && r !== ttRoot) violations.push(`${rec.id}: task ${rec.task}`);
  }
  for (const bf of (rec.boundary_files || [])) {
    const r = path.resolve(ttRoot, bf);
    if (!r.startsWith(ttRoot + path.sep) && r !== ttRoot) violations.push(`${rec.id}: boundary_file ${bf}`);
  }
  for (const f of (rec.forbidden || [])) {
    const r = path.resolve(ttRoot, f);
    if (!r.startsWith(ttRoot + path.sep) && r !== ttRoot) violations.push(`${rec.id}: forbidden ${f}`);
  }
}
if (violations.length === 0) console.log('PATHS_OK');
else { console.log('PATHS_FAIL'); for (const v of violations) console.log(v); }
NODE
)
if echo "$path_out" | grep -q '^PATHS_OK$'; then
  pass "all case paths contained within torture-test/"
else
  fail "$path_out"
fi

# ── Test 10: probes/validate-all.sh hygiene sweep ──────────────────
total_count=$((total_count + 1))
echo "--- Test 10: probes/validate-all.sh exits clean ---" >&2
PROBE_VALIDATE="$TT_DIR/probes/validate-all.sh"
if [ -x "$PROBE_VALIDATE" ]; then
  # Golden bares must exist for validate-all.sh to be meaningful;
  # skip the assertion when they are absent (infrastructure issue).
  golden_dir="$TT_DIR/var/fixtures/golden"
  if [ -d "$golden_dir" ] && ls -A "$golden_dir"/*.git >/dev/null 2>&1; then
    set +e
    probe_out=$("$PROBE_VALIDATE" 2>&1)
    probe_ec=$?
    set -e
    if [ "$probe_ec" -eq 0 ]; then
      pass "probes/validate-all.sh exits 0"
    else
      fail "probes/validate-all.sh exited $probe_ec"
    fi
  else
    pass "probes/validate-all.sh (golden bares not built — skipped)"
  fi
else
  pass "probes/validate-all.sh (not executable — skipped)"
fi

# ── Test 11: probes/secrecy-sweep.sh hygiene sweep ─────────────────
total_count=$((total_count + 1))
echo "--- Test 11: probes/secrecy-sweep.sh exits clean ---" >&2
SECRECY_SWEEP="$TT_DIR/probes/secrecy-sweep.sh"
if [ -x "$SECRECY_SWEEP" ]; then
  # secrecy-sweep.sh also requires golden bares; skip if absent.
  golden_dir="$TT_DIR/var/fixtures/golden"
  if [ -d "$golden_dir" ]; then
    set +e
    secrecy_out=$("$SECRECY_SWEEP" 2>&1)
    secrecy_ec=$?
    set -e
    if [ "$secrecy_ec" -eq 0 ]; then
      pass "probes/secrecy-sweep.sh exits 0"
    else
      fail "probes/secrecy-sweep.sh exited $secrecy_ec"
    fi
  else
    pass "probes/secrecy-sweep.sh (golden bares not built — skipped)"
  fi
else
  pass "probes/secrecy-sweep.sh (not executable — skipped)"
fi

echo ""
echo "--- Results: $((total_count - fail_count))/$total_count passed ---"
[ "$fail_count" -eq 0 ] && exit 0 || exit 1
