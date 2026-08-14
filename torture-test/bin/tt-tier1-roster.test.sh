#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TT_DIR="$(dirname "$SCRIPT_DIR")"
MANIFEST="$TT_DIR/cases/tier1.jsonl"
SCHEMA="$TT_DIR/cases/case.schema.json"
TIER1_ASSETS="$SCRIPT_DIR/tt-tier1-assets"

fail_count=0
total_count=0

fail() {
  echo "FAIL: $1" >&2
  fail_count=$((fail_count + 1))
}
pass() {
  echo "PASS: $1" >&2
}

# Check that case count is in the expected range
total_count=$((total_count + 1))
echo "--- Test: Tier-1 case count (W1+W2) ---" >&2
case_count=$(grep -c '^{' "$MANIFEST" || echo 0)
if [ "$case_count" -ge 26 ] && [ "$case_count" -le 30 ]; then
  pass "Tier-1 case count is $case_count (expected 26-30)"
else
  fail "Tier-1 case count is $case_count (expected 26-30)"
fi

# Check that each case has required fields
total_count=$((total_count + 1))
echo "--- Test: required fields on each Tier-1 case ---" >&2
all_ok=true
while IFS= read -r line; do
  [ -z "$line" ] && continue
  id=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.id||'');})" 2>/dev/null || true)
  for field in id wave workflow fixture harness task context caps requires boundary_files forbidden oracles gates shed_ok mandatory class; do
    val=$(echo "$line" | node -e "const j=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(String(j.$field ?? ''));" 2>/dev/null || true)
    if [ -z "$val" ]; then
      fail "case $id missing required field: $field"
      all_ok=false
    fi
  done
done < "$MANIFEST"
if $all_ok; then
  pass "all Tier-1 cases have required fields"
fi

# Check task files exist
total_count=$((total_count + 1))
echo "--- Test: task file existence ---" >&2
all_ok=true
while IFS= read -r line; do
  [ -z "$line" ] && continue
  task=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(typeof j.task==='string'?j.task:'');})" 2>/dev/null || true)
  id=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.id||'');})" 2>/dev/null || true)
  if [ -n "$task" ]; then
    if [ ! -f "$TT_DIR/$task" ]; then
      fail "case $id: task file '$task' not found"
      all_ok=false
    elif [ ! -s "$TT_DIR/$task" ]; then
      fail "case $id: task file '$task' is empty"
      all_ok=false
    fi
  fi
done < "$MANIFEST"
if $all_ok; then
  pass "all task files exist and are non-empty"
fi

# Check spec_ref on all cases
total_count=$((total_count + 1))
echo "--- Test: spec_ref field present and referencing valid wave docs ---" >&2
all_ok=true
while IFS= read -r line; do
  [ -z "$line" ] && continue
  id=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.id||'');})" 2>/dev/null || true)
  spec_ref=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(typeof j.spec_ref==='string'?j.spec_ref:'');})" 2>/dev/null || true)
  if [ -z "$spec_ref" ]; then
    fail "case $id: missing spec_ref"
    all_ok=false
  else
    wave=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(String(j.wave||''));})" 2>/dev/null || true)
    if [ "$wave" = "1" ]; then
      if echo "$spec_ref" | grep -qv '05-wave-1-language-smoke'; then
        fail "case $id (wave 1): spec_ref '$spec_ref' does not reference 05-wave-1-language-smoke"
        all_ok=false
      fi
    elif [ "$wave" = "2" ]; then
      if echo "$spec_ref" | grep -qv '06-wave-2-workflow-coverage'; then
        fail "case $id (wave 2): spec_ref '$spec_ref' does not reference 06-wave-2-workflow-coverage"
        all_ok=false
      fi
    elif [ "$wave" = "3" ]; then
      if echo "$spec_ref" | grep -qv '07-wave-3-harness-duel'; then
        fail "case $id (wave 3): spec_ref '$spec_ref' does not reference 07-wave-3-harness-duel"
        all_ok=false
      fi
    fi
  fi
done < "$MANIFEST"
if $all_ok; then
  pass "all cases have spec_ref referencing the correct wave doc"
fi

# Check execution_mode is valid (real or scripted)
total_count=$((total_count + 1))
echo "--- Test: execution_mode valid (real or scripted) ---" >&2
all_ok=true
while IFS= read -r line; do
  [ -z "$line" ] && continue
  id=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.id||'');})" 2>/dev/null || true)
  mode=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.context?.execution_mode||'');})" 2>/dev/null || true)
  if [ "$mode" != "real" ] && [ "$mode" != "scripted" ]; then
    fail "case $id: execution_mode is '$mode', expected 'real' or 'scripted'"
    all_ok=false
  fi
done < "$MANIFEST"
if $all_ok; then
  pass "all cases have valid execution_mode (real or scripted)"
fi

# Check bug-fix cases have probe_id and O16
total_count=$((total_count + 1))
echo "--- Test: bug-fix cases have probe_id and O16 ---" >&2
all_ok=true
while IFS= read -r line; do
  [ -z "$line" ] && continue
  id=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.id||'');})" 2>/dev/null || true)
  wf=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.workflow||'');})" 2>/dev/null || true)
  if [ "$wf" = "bug-fix" ]; then
    probe_id=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(typeof j.probe_id==='string'?j.probe_id:'');})" 2>/dev/null || true)
    if [ -z "$probe_id" ]; then
      fail "case $id: bug-fix workflow missing probe_id"
      all_ok=false
    else
      # Verify probe exists
      fixture=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.fixture||'');})" 2>/dev/null || true)
      probe_path="$TT_DIR/probes/$fixture/$probe_id/probe.sh"
      if [ ! -f "$probe_path" ]; then
        fail "case $id: probe_id '$probe_id' not found at $probe_path"
        all_ok=false
      fi
    fi
    # Verify O16 in oracles
    oracles=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(JSON.stringify(j.oracles||[]));})" 2>/dev/null || true)
    if echo "$oracles" | grep -qv 'O16'; then
      fail "case $id: bug-fix workflow missing O16 in oracles"
      all_ok=false
    fi
  fi
done < "$MANIFEST"
if $all_ok; then
  pass "all bug-fix cases have probe_id + O16 with existing probe"
fi

# Check requires predicates on all cases
total_count=$((total_count + 1))
echo "--- Test: requires predicates (node_min >= 22) ---" >&2
all_ok=true
while IFS= read -r line; do
  [ -z "$line" ] && continue
  id=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.id||'');})" 2>/dev/null || true)
  node_min=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(String(j.requires?.node_min??''));})" 2>/dev/null || true)
  if [ -z "$node_min" ] || [ "$node_min" -lt 22 ]; then
    fail "case $id: node_min $node_min is not >= 22"
    all_ok=false
  fi
done < "$MANIFEST"
if $all_ok; then
  pass "all Tier-1 cases have node_min >= 22"
fi

# Check hermes case has requires.capabilities:['hermes']
total_count=$((total_count + 1))
echo "--- Test: hermes case requires capabilities ---" >&2
hermes_count=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  harn=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.harness||'');})" 2>/dev/null || true)
  if [ "$harn" = "hermes" ]; then
    hermes_count=$((hermes_count + 1))
    caps=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(JSON.stringify(j.requires?.capabilities||[]));})" 2>/dev/null || true)
    if echo "$caps" | grep -qv 'hermes'; then
      id=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.id||'');})" 2>/dev/null || true)
      fail "case $id: hermes harness missing requires.capabilities:['hermes']"
      all_ok=false
    fi
  fi
done < "$MANIFEST"
if [ "$hermes_count" -ge 1 ]; then
  pass "hermes case(s) have requires.capabilities:['hermes'] ($hermes_count hermes case(s))"
else
  fail "no hermes cases found (expected W1.M1)"
fi

# Check python/tt-python cases have python3 toolchain
total_count=$((total_count + 1))
echo "--- Test: python cases require python3 toolchain ---" >&2
all_ok=true
while IFS= read -r line; do
  [ -z "$line" ] && continue
  id=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.id||'');})" 2>/dev/null || true)
  fixture=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.fixture||'');})" 2>/dev/null || true)
  if echo "$fixture" | grep -q '^tt-python'; then
    tcs=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(JSON.stringify(j.requires?.toolchains||[]));})" 2>/dev/null || true)
    if echo "$tcs" | grep -qv 'python3'; then
      fail "case $id: $fixture fixture missing requires.toolchains python3"
      all_ok=false
    fi
  fi
done < "$MANIFEST"
if $all_ok; then
  pass "all tt-python* cases require python3 toolchain"
fi

# Check W1.M1 ensures spec exists
total_count=$((total_count + 1))
echo "--- Test: W1.M1 case exists ---" >&2
if grep -q '"W1.M1-python"' "$MANIFEST"; then
  pass "W1.M1-python case present"
else
  fail "W1.M1-python case missing"
fi

# --- Wave-2 specific tests ---

# Check Wave-2 cases exist
total_count=$((total_count + 1))
echo "--- Test: Wave-2 case count ---" >&2
w2_count=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  wave=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(String(j.wave||''));})" 2>/dev/null || true)
  if [ "$wave" = "2" ]; then
    w2_count=$((w2_count + 1))
  fi
done < "$MANIFEST"
if [ "$w2_count" -eq 6 ]; then
  pass "Wave-2 has $w2_count cases (expected 6)"
else
  fail "Wave-2 has $w2_count cases (expected 6)"
fi

# Check Wave-2 specific case IDs exist
total_count=$((total_count + 1))
echo "--- Test: Wave-2 case IDs present ---" >&2
all_ok=true
for expected_id in "W2.21-admission" "W2.22-non-main-bfmw" "W2.23a-expects-regex" "W2.23b-retry-step" "W2.23c-missing-persona" "W2.24-docs-drift"; do
  if grep -q "\"$expected_id\"" "$MANIFEST"; then
    pass "  Wave-2 case $expected_id present"
  else
    fail "Wave-2 case $expected_id missing"
    all_ok=false
  fi
done

# Check Wave-2 scripted cases have tokens=0 caps and local harness
total_count=$((total_count + 1))
echo "--- Test: Wave-2 scripted cases have zero-token caps + local harness ---" >&2
all_ok=true
while IFS= read -r line; do
  [ -z "$line" ] && continue
  id=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.id||'');})" 2>/dev/null || true)
  wave=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(String(j.wave||''));})" 2>/dev/null || true)
  if [ "$wave" = "2" ]; then
    mode=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.context?.execution_mode||'');})" 2>/dev/null || true)
    harn=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.harness||'');})" 2>/dev/null || true)
    tokens=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(String(j.caps?.tokens??''));})" 2>/dev/null || true)
    if [ "$mode" = "scripted" ]; then
      if [ "$tokens" != "0" ]; then
        fail "case $id: scripted case has tokens=$tokens, expected 0"
        all_ok=false
      fi
      if [ "$harn" != "local" ]; then
        fail "case $id: scripted case has harness=$harn, expected local"
        all_ok=false
      fi
    fi
  fi
done < "$MANIFEST"
if $all_ok; then
  pass "all Wave-2 scripted cases have zero-token caps + local harness"
fi

# Check Wave-2 real cases have pi harness and real tokens > 0
total_count=$((total_count + 1))
echo "--- Test: Wave-2 real cases have pi harness + non-zero tokens ---" >&2
all_ok=true
while IFS= read -r line; do
  [ -z "$line" ] && continue
  id=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.id||'');})" 2>/dev/null || true)
  wave=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(String(j.wave||''));})" 2>/dev/null || true)
  if [ "$wave" = "2" ]; then
    mode=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.context?.execution_mode||'');})" 2>/dev/null || true)
    if [ "$mode" = "real" ]; then
      harn=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.harness||'');})" 2>/dev/null || true)
      if [ "$harn" != "pi" ]; then
        fail "case $id: real Wave-2 case has harness=$harn, expected pi"
        all_ok=false
      fi
      tokens=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(String(j.caps?.tokens??''));})" 2>/dev/null || true)
      if [ "$tokens" = "0" ]; then
        fail "case $id: real case has tokens=0, expected > 0"
        all_ok=false
      fi
    fi
  fi
done < "$MANIFEST"
if $all_ok; then
  pass "all Wave-2 real cases have pi harness + non-zero tokens"
fi

# Check W2.21 admission case specifics
# NOTE: W2.21 is a SCRIPTED (zero-token) admission case using harness 'local'
# and workflow 'local' (it exercises admission edge through the scripted daemon,
# not a real just-do-it run). O4 was removed from its oracles because O4 does not
# exist as a CONTRACT oracle executable — scripted scenarios use [O1, O3z, O11].
# See scenarios/w2.21/ and project history (US-002/US-005).
total_count=$((total_count + 1))
echo "--- Test: W2.21 admission edge case specifics ---" >&2
w2_21_line=$(grep '"W2.21-admission"' "$MANIFEST")
w2_21_wf=$(echo "$w2_21_line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.workflow||'');})" 2>/dev/null || true)
w2_21_harness=$(echo "$w2_21_line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.harness||'');})" 2>/dev/null || true)
w2_21_oracles=$(echo "$w2_21_line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(JSON.stringify(j.oracles||[]));})" 2>/dev/null || true)
all_ok=true
if [ "$w2_21_wf" != "local" ]; then
  fail "W2.21: workflow is '$w2_21_wf', expected local (scripted admission case)"
  all_ok=false
fi
if [ "$w2_21_harness" != "local" ]; then
  fail "W2.21: harness is '$w2_21_harness', expected local (scripted)"
  all_ok=false
fi
if echo "$w2_21_oracles" | grep -q 'O4'; then
  fail "W2.21: O4 present in oracles, but O4 is not a CONTRACT oracle (use O1/O3z/O11)"
  all_ok=false
fi
if echo "$w2_21_oracles" | grep -qv 'O1'; then
  fail "W2.21: missing O1 oracle"
  all_ok=false
fi
if $all_ok; then
  pass "W2.21 admission case is local/scripted with [O1,O3z,O11] oracles (no O4)"
fi

# Check W2.22 non-main bfmw case specifics
total_count=$((total_count + 1))
echo "--- Test: W2.22 non-main bfmw case specifics ---" >&2
w2_22_line=$(grep '"W2.22-non-main-bfmw"' "$MANIFEST")
w2_22_fixture=$(echo "$w2_22_line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.fixture||'');})" 2>/dev/null || true)
w2_22_wf=$(echo "$w2_22_line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.workflow||'');})" 2>/dev/null || true)
w2_22_caps=$(echo "$w2_22_line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(String(j.caps?.tokens||''));})" 2>/dev/null || true)
w2_22_oracles=$(echo "$w2_22_line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(JSON.stringify(j.oracles||[]));})" 2>/dev/null || true)
all_ok=true
if [ "$w2_22_fixture" != "tt-python@master" ]; then
  fail "W2.22: fixture is '$w2_22_fixture', expected tt-python@master"
  all_ok=false
fi
if [ "$w2_22_wf" != "bug-fix-merge-worktree" ]; then
  fail "W2.22: workflow is '$w2_22_wf', expected bug-fix-merge-worktree"
  all_ok=false
fi
if [ "$w2_22_caps" != "1000000" ]; then
  fail "W2.22: tokens is $w2_22_caps, expected 1000000 (bfmw p95 cap)"
  all_ok=false
fi
if echo "$w2_22_oracles" | grep -qv 'O2'; then
  fail "W2.22: missing O2 (merge truth) in oracles"
  all_ok=false
fi
if $all_ok; then
  pass "W2.22 non-main bfmw case: tt-python@master, bfmw workflow, 1M cap, O2 present"
fi

# Check shed_ok/mandatory on all Wave-2 cases
total_count=$((total_count + 1))
echo "--- Test: Wave-2 shed_ok/mandatory flags ---" >&2
all_ok=true
while IFS= read -r line; do
  [ -z "$line" ] && continue
  id=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.id||'');})" 2>/dev/null || true)
  wave=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(String(j.wave||''));})" 2>/dev/null || true)
  if [ "$wave" = "2" ]; then
    shed_ok=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(String(j.shed_ok??''));})" 2>/dev/null || true)
    mandatory=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(String(j.mandatory??''));})" 2>/dev/null || true)
    if [ "$shed_ok" != "false" ]; then
      fail "case $id: shed_ok is $shed_ok, expected false (Tier-1 edge cases are cheap, not shed-able)"
      all_ok=false
    fi
    if [ "$mandatory" != "true" ]; then
      fail "case $id: mandatory is $mandatory, expected true"
      all_ok=false
    fi
  fi
done < "$MANIFEST"
if $all_ok; then
  pass "all Wave-2 cases have shed_ok=false + mandatory=true"
fi

# --- Wave-3 specific tests ---

# Check Wave-3 case count
total_count=$((total_count + 1))
echo "--- Test: Wave-3 case count ---" >&2
w3_count=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  wave=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(String(j.wave||''));})" 2>/dev/null || true)
  if [ "$wave" = "3" ]; then
    w3_count=$((w3_count + 1))
  fi
done < "$MANIFEST"
if [ "$w3_count" -eq 12 ]; then
  pass "Wave-3 has $w3_count cases (expected 12)"
else
  fail "Wave-3 has $w3_count cases (expected 12)"
fi

# Check Wave-3 specific case IDs exist
total_count=$((total_count + 1))
echo "--- Test: Wave-3 case IDs present ---" >&2
all_ok=true
for expected_id in "W3.01-bfmw-pi-python" "W3.02-bfmw-pi-ts" "W3.03-bfmw-hermes-ts" "W3.04-fdmw-pi-ts" "W3.17a-marathon-natural" "W3.17b-marathon-chaos" "W3.18-pause-no-drain" "W3.19-pause-drain" "W3.20-cancel" "W3.21-fail-force-resume" "W3.22-daemon-restart" "W3.23-token-saver"; do
  if grep -q "\"$expected_id\"" "$MANIFEST"; then
    pass "  Wave-3 case $expected_id present"
  else
    fail "Wave-3 case $expected_id missing"
    all_ok=false
  fi
done

# Check Wave-3 hermes cases have requires.capabilities:['hermes']
total_count=$((total_count + 1))
echo "--- Test: Wave-3 hermes cases require capabilities ---" >&2
w3_hermes_count=0
w3_hermes_ok=true
while IFS= read -r line; do
  [ -z "$line" ] && continue
  id=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.id||'');})" 2>/dev/null || true)
  wave=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(String(j.wave||''));})" 2>/dev/null || true)
  harn=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.harness||'');})" 2>/dev/null || true)
  if [ "$wave" = "3" ] && [ "$harn" = "hermes" ]; then
    w3_hermes_count=$((w3_hermes_count + 1))
    caps=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(JSON.stringify(j.requires?.capabilities||[]));})" 2>/dev/null || true)
    if echo "$caps" | grep -qv 'hermes'; then
      fail "case $id: hermes harness missing requires.capabilities:['hermes']"
      w3_hermes_ok=false
    fi
  fi
done < "$MANIFEST"
if [ "$w3_hermes_count" -ge 3 ]; then
  pass "Wave-3 hermes case(s) have requires.capabilities:['hermes'] ($w3_hermes_count hermes case(s))"
else
  fail "Wave-3: expected >=3 hermes cases, found $w3_hermes_count"
  w3_hermes_ok=false
fi

# Check W3.17b chaos object is non-null (deterministic chaos)
total_count=$((total_count + 1))
echo "--- Test: W3.17b chaos object is non-null ---" >&2
w3_17b_line=$(grep '"W3.17b-marathon-chaos"' "$MANIFEST")
w3_17b_chaos=$(echo "$w3_17b_line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(JSON.stringify(j.chaos));})" 2>/dev/null || true)
if [ "$w3_17b_chaos" != "null" ] && [ -n "$w3_17b_chaos" ]; then
  pass "W3.17b has non-null chaos object: $w3_17b_chaos"
else
  fail "W3.17b chaos is null or empty (expected non-null chaos object for deterministic SIGSTOP)"
fi

# Check W3.17a chaos is null (natural marathon, advisory)
total_count=$((total_count + 1))
echo "--- Test: W3.17a chaos is null ---" >&2
w3_17a_line=$(grep '"W3.17a-marathon-natural"' "$MANIFEST")
w3_17a_chaos=$(echo "$w3_17a_line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(JSON.stringify(j.chaos));})" 2>/dev/null || true)
if [ "$w3_17a_chaos" = "null" ]; then
  pass "W3.17a chaos is null (natural marathon, advisory)"
else
  fail "W3.17a chaos is '$w3_17a_chaos' (expected null for natural marathon)"
fi

# Check Wave-3 bfmw/fdmw merge cases have O2 + O9 + O10 + O11 in oracles
total_count=$((total_count + 1))
echo "--- Test: Wave-3 merge cases have O2/O9/O10/O11 oracle set ---" >&2
all_ok=true
merge_wfs="bug-fix-merge-worktree feature-dev-merge-worktree"
while IFS= read -r line; do
  [ -z "$line" ] && continue
  id=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.id||'');})" 2>/dev/null || true)
  wave=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(String(j.wave||''));})" 2>/dev/null || true)
  wf=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.workflow||'');})" 2>/dev/null || true)
  if [ "$wave" = "3" ]; then
    # Cases that should have merge oracles (all merge workflows + lifecycle fdmw probes)
    if echo "$merge_wfs" | grep -qw "$wf"; then
      oracles=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(JSON.stringify(j.oracles||[]));})" 2>/dev/null || true)
      for o in O2 O9 O10 O11; do
        if echo "$oracles" | grep -qv "\"$o\""; then
          # W3.20 (cancel) and W3.22 (daemon restart) legitimately omit merge oracles
          if [ "$id" != "W3.20-cancel" ] && [ "$id" != "W3.22-daemon-restart" ]; then
            fail "case $id ($wf): missing $o in oracles"
            all_ok=false
          fi
        fi
      done
    fi
  fi
done < "$MANIFEST"
if $all_ok; then
  pass "all Wave-3 merge cases have O2/O9/O10/O11 oracle set (except cancel and daemon-restart)"
fi

# Check Wave-3 bfmw/fdmw seeded cases have probe_id + O16
total_count=$((total_count + 1))
echo "--- Test: Wave-3 bfmw/fdmw cases with probe_id have O16 ---" >&2
all_ok=true
while IFS= read -r line; do
  [ -z "$line" ] && continue
  id=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.id||'');})" 2>/dev/null || true)
  wave=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(String(j.wave||''));})" 2>/dev/null || true)
  if [ "$wave" = "3" ]; then
    probe_id=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(typeof j.probe_id==='string'?j.probe_id:'');})" 2>/dev/null || true)
    if [ -n "$probe_id" ]; then
      oracles=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(JSON.stringify(j.oracles||[]));})" 2>/dev/null || true)
      if echo "$oracles" | grep -qv 'O16'; then
        fail "case $id: has probe_id '$probe_id' but missing O16 in oracles"
        all_ok=false
      fi
      # Verify probe exists
      fixture=$(echo "$line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.fixture||'');})" 2>/dev/null || true)
      probe_path="$TT_DIR/probes/$fixture/$probe_id/probe.sh"
      if [ ! -f "$probe_path" ]; then
        fail "case $id: probe_id '$probe_id' not found at $probe_path"
        all_ok=false
      fi
    fi
  fi
done < "$MANIFEST"
if $all_ok; then
  pass "all Wave-3 cases with probe_id have O16 + existing probe"
fi

# Check Wave-3 lifecycle probe specific requirements
total_count=$((total_count + 1))
echo "--- Test: Wave-3 lifecycle probe case specifics ---" >&2
all_ok=true

# W3.18 is pause-no-drain on fdmw pi
w3_18_line=$(grep '"W3.18-pause-no-drain"' "$MANIFEST")
w3_18_wf=$(echo "$w3_18_line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.workflow||'');})" 2>/dev/null || true)
w3_18_harness=$(echo "$w3_18_line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.harness||'');})" 2>/dev/null || true)
w3_18_fixture=$(echo "$w3_18_line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.fixture||'');})" 2>/dev/null || true)
if [ "$w3_18_wf" != "feature-dev-merge-worktree" ]; then
  fail "W3.18: expected fdmw workflow, got $w3_18_wf"
  all_ok=false
fi
if [ "$w3_18_harness" != "pi" ]; then
  fail "W3.18: expected pi harness, got $w3_18_harness"
  all_ok=false
fi
if [ "$w3_18_fixture" != "tt-ts" ]; then
  fail "W3.18: expected tt-ts fixture, got $w3_18_fixture"
  all_ok=false
fi

# W3.19 is pause --drain on hermes fdmw
w3_19_line=$(grep '"W3.19-pause-drain"' "$MANIFEST")
w3_19_harness=$(echo "$w3_19_line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.harness||'');})" 2>/dev/null || true)
w3_19_caps_hermes=$(echo "$w3_19_line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(JSON.stringify(j.requires?.capabilities||[]));})" 2>/dev/null || true)
if [ "$w3_19_harness" != "hermes" ]; then
  fail "W3.19: expected hermes harness, got $w3_19_harness"
  all_ok=false
fi
if echo "$w3_19_caps_hermes" | grep -qv 'hermes'; then
  fail "W3.19: missing requires.capabilities:['hermes']"
  all_ok=false
fi

# W3.23 is a do-now token-saver smoke on pi
w3_23_line=$(grep '"W3.23-token-saver"' "$MANIFEST")
w3_23_wf=$(echo "$w3_23_line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.workflow||'');})" 2>/dev/null || true)
if [ "$w3_23_wf" != "do-now" ]; then
  fail "W3.23: expected do-now workflow, got $w3_23_wf"
  all_ok=false
fi
# S12/E3.D US-009: the token-saver paired-launch signal must be present
w3_23_signal=$(echo "$w3_23_line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(String(j.context?.token_saver_control ?? ''));})" 2>/dev/null || true)
if [ "$w3_23_signal" != "true" ]; then
  fail "W3.23: missing context.token_saver_control=true, got '$w3_23_signal'"
  all_ok=false
fi

if $all_ok; then
  pass "Wave-3 lifecycle probes have correct workflows/harness/fixtures"
fi

# Check W3.17 marathon cases have hermes harness, 8M token cap, tt-poly-lite fixture
total_count=$((total_count + 1))
echo "--- Test: W3.17 marathon case specifics ---" >&2
all_ok=true
for marathon_id in "W3.17a-marathon-natural" "W3.17b-marathon-chaos"; do
  marathon_line=$(grep "\"$marathon_id\"" "$MANIFEST")
  marathon_wf=$(echo "$marathon_line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.workflow||'');})" 2>/dev/null || true)
  marathon_harness=$(echo "$marathon_line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.harness||'');})" 2>/dev/null || true)
  marathon_fixture=$(echo "$marathon_line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(j.fixture||'');})" 2>/dev/null || true)
  marathon_tokens=$(echo "$marathon_line" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);process.stdout.write(String(j.caps?.tokens||''));})" 2>/dev/null || true)
  if [ "$marathon_wf" != "feature-dev-merge-worktree" ]; then
    fail "$marathon_id: expected fdmw workflow, got $marathon_wf"
    all_ok=false
  fi
  if [ "$marathon_harness" != "hermes" ]; then
    fail "$marathon_id: expected hermes harness, got $marathon_harness"
    all_ok=false
  fi
  if [ "$marathon_fixture" != "tt-poly-lite" ]; then
    fail "$marathon_id: expected tt-poly-lite fixture, got $marathon_fixture"
    all_ok=false
  fi
  if [ "$marathon_tokens" != "8000000" ]; then
    fail "$marathon_id: expected 8M token cap, got $marathon_tokens"
    all_ok=false
  fi
done
if $all_ok; then
  pass "W3.17 marathon cases: fdmw workflow, hermes harness, tt-poly-lite, 8M cap"
fi

# Run tt-controller --validate-only
total_count=$((total_count + 1))
echo "--- Test: tt-controller --validate-only on tier1.jsonl ---" >&2
if "$TT_DIR/bin/tt-controller" --manifest "$MANIFEST" --validate-only >/dev/null 2>&1; then
  pass "tt-controller --validate-only exits 0"
else
  fail "tt-controller --validate-only exits non-zero"
fi

# Run tt-tier1-assets
total_count=$((total_count + 1))
echo "--- Test: tt-tier1-assets on tier1.jsonl ---" >&2
if "$TIER1_ASSETS" "$MANIFEST" >/dev/null 2>&1; then
  pass "tt-tier1-assets exits 0"
else
  fail "tt-tier1-assets exits non-zero"
fi

echo ""
echo "--- Results: $((total_count - fail_count))/$total_count passed ---"
[ "$fail_count" -eq 0 ] && exit 0 || exit 1
