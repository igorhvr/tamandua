#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TT_DIR="$(dirname "$SCRIPT_DIR")"
VALIDATOR="$SCRIPT_DIR/tt-tier1-assets"

TMP_CASES="$(mktemp -d "$TT_DIR/cases/tt-tier1-assets-test.XXXXXX")"
TASK_FILE="$TT_DIR/var/tier1-test-task-$$.md"

cleanup() {
  rm -rf -- "$TMP_CASES"
  rm -f -- "$TASK_FILE" "$TASK_FILE"2 "$TASK_FILE"3 "$TASK_FILE"4 "$TASK_FILE"5 \
    "$TASK_FILE"6 "$TASK_FILE"7 "$TASK_FILE"8 "$TASK_FILE"9 "$TASK_FILE"10 \
    "$TASK_FILE"11 "$TASK_FILE"12
}
trap 'cleanup' EXIT

fail_count=0
total_count=0

pass() { total_count=$((total_count + 1)); echo "PASS: $1"; }
fail() { fail_count=$((fail_count + 1)); total_count=$((total_count + 1)); echo "FAIL: $1"; }

# Helper: create a valid task file (needed for many tests)
echo "# Test task content" > "$TASK_FILE"

# ---- Test 1: well-formed manifest exits 0 ----
cat > "$TMP_CASES/pass.jsonl" <<JSONL
{"id":"T1-PASS-001","wave":1,"workflow":"fdmw","fixture":"tt-ts","harness":"pi","task":"var/tier1-test-task-$$.md","context":{"execution_mode":"real"},"caps":{"tokens":0,"wall_min":1},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification","probe_id":"BUG-T1"}
JSONL

if "$VALIDATOR" "$TMP_CASES/pass.jsonl" >/dev/null 2>&1; then
  pass "valid manifest exits 0"
else
  fail "valid manifest exits 0"
  "$VALIDATOR" "$TMP_CASES/pass.jsonl" 2>&1 || true
fi

# ---- Test 2: poly-lite probe layout ----
echo "# Test task poly" > "$TASK_FILE"2
cat > "$TMP_CASES/pass-poly.jsonl" <<JSONL
{"id":"T1-PASS-002","wave":1,"workflow":"fdmw","fixture":"tt-poly-lite","harness":"pi","task":"var/tier1-test-task-$$.md2","context":{"execution_mode":"real"},"caps":{"tokens":0,"wall_min":1},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification","probe_id":"POLY-BUG-P1"}
JSONL

if "$VALIDATOR" "$TMP_CASES/pass-poly.jsonl" >/dev/null 2>&1; then
  pass "poly-lite probe exits 0"
else
  fail "poly-lite probe exits 0"
  "$VALIDATOR" "$TMP_CASES/pass-poly.jsonl" 2>&1 || true
fi

# ---- Test 3: multiple probes (probe_id + probes array) ----
echo "# Test task multi" > "$TASK_FILE"3
cat > "$TMP_CASES/pass-multi-probes.jsonl" <<JSONL
{"id":"T1-PASS-003","wave":1,"workflow":"fdmw","fixture":"tt-ts","harness":"pi","task":"var/tier1-test-task-$$.md3","context":{"execution_mode":"real"},"caps":{"tokens":0,"wall_min":1},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification","probe_id":"BUG-T1","probes":["BUG-T2"]}
JSONL

if "$VALIDATOR" "$TMP_CASES/pass-multi-probes.jsonl" >/dev/null 2>&1; then
  pass "multiple probes exits 0"
else
  fail "multiple probes exits 0"
  "$VALIDATOR" "$TMP_CASES/pass-multi-probes.jsonl" 2>&1 || true
fi

# ---- Test 4: valid requires with all allowed fields ----
echo "# Test task reqs" > "$TASK_FILE"4
cat > "$TMP_CASES/pass-reqs.jsonl" <<JSONL
{"id":"T1-PASS-004","wave":1,"workflow":"fdmw","fixture":"tt-ts","harness":"pi","task":"var/tier1-test-task-$$.md4","context":{"execution_mode":"real"},"caps":{"tokens":0,"wall_min":1},"requires":{"platform":"linux","toolchains":["node","python3"],"capabilities":["hermes","pi"],"containment":["systemd-user-scope"],"node_min":22},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
JSONL

if "$VALIDATOR" "$TMP_CASES/pass-reqs.jsonl" >/dev/null 2>&1; then
  pass "valid requires predicates exits 0"
else
  fail "valid requires predicates exits 0"
  "$VALIDATOR" "$TMP_CASES/pass-reqs.jsonl" 2>&1 || true
fi

# ---- Test 5: multiple cases ----
echo "# Test task multi" > "$TASK_FILE"5
cat > "$TMP_CASES/pass-multi-case.jsonl" <<JSONL
{"id":"T1-PASS-005a","wave":1,"workflow":"fdmw","fixture":"tt-ts","harness":"pi","task":"var/tier1-test-task-$$.md5","context":{"execution_mode":"real"},"caps":{"tokens":0,"wall_min":1},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
{"id":"T1-PASS-005b","wave":1,"workflow":"fdmw","fixture":"tt-ts","harness":"pi","task":"var/tier1-test-task-$$.md5","context":{"execution_mode":"real"},"caps":{"tokens":0,"wall_min":1},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
JSONL

if "$VALIDATOR" "$TMP_CASES/pass-multi-case.jsonl" >/dev/null 2>&1; then
  pass "multiple cases exits 0"
else
  fail "multiple cases exits 0"
  "$VALIDATOR" "$TMP_CASES/pass-multi-case.jsonl" 2>&1 || true
fi

# ---- Test 6: no probes at all (optional field) ----
echo "# Test task no-probe" > "$TASK_FILE"6
cat > "$TMP_CASES/pass-no-probe.jsonl" <<JSONL
{"id":"T1-PASS-006","wave":1,"workflow":"fdmw","fixture":"tt-ts","harness":"pi","task":"var/tier1-test-task-$$.md6","context":{"execution_mode":"real"},"caps":{"tokens":0,"wall_min":1},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
JSONL

if "$VALIDATOR" "$TMP_CASES/pass-no-probe.jsonl" >/dev/null 2>&1; then
  pass "no probe fields exits 0"
else
  fail "no probe fields exits 0"
  "$VALIDATOR" "$TMP_CASES/pass-no-probe.jsonl" 2>&1 || true
fi

# ---- Test 7: platform array ----
echo "# Test task plat-arr" > "$TASK_FILE"7
cat > "$TMP_CASES/pass-plat-arr.jsonl" <<JSONL
{"id":"T1-PASS-007","wave":1,"workflow":"fdmw","fixture":"tt-ts","harness":"pi","task":"var/tier1-test-task-$$.md7","context":{"execution_mode":"real"},"caps":{"tokens":0,"wall_min":1},"requires":{"platform":["linux","darwin"]},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
JSONL

if "$VALIDATOR" "$TMP_CASES/pass-plat-arr.jsonl" >/dev/null 2>&1; then
  pass "valid platform array exits 0"
else
  fail "valid platform array exits 0"
  "$VALIDATOR" "$TMP_CASES/pass-plat-arr.jsonl" 2>&1 || true
fi

# ---- Test 8: missing task file → exit non-zero ----
echo '{"id":"T1-FAIL-001","wave":1,"workflow":"fdmw","fixture":"tt-ts","harness":"pi","task":"var/nonexistent-$$.md","context":{"execution_mode":"real"},"caps":{"tokens":0,"wall_min":1},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}' > "$TMP_CASES/fail-missing-task.jsonl"

if ! "$VALIDATOR" "$TMP_CASES/fail-missing-task.jsonl" >/dev/null 2>&1; then
  pass "missing task file exits non-zero"
else
  fail "missing task file exits non-zero"
fi

# ---- Test 9: missing probe.sh → exit non-zero ----
echo "# Test task bad probe" > "$TASK_FILE"9
echo '{"id":"T1-FAIL-002","wave":1,"workflow":"fdmw","fixture":"tt-ts","harness":"pi","task":"var/tier1-test-task-$$.md9","context":{"execution_mode":"real"},"caps":{"tokens":0,"wall_min":1},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification","probe_id":"NONEXISTENT-PROBE-ZZ"}' > "$TMP_CASES/fail-missing-probe.jsonl"

if ! "$VALIDATOR" "$TMP_CASES/fail-missing-probe.jsonl" >/dev/null 2>&1; then
  pass "missing probe.sh exits non-zero"
else
  fail "missing probe.sh exits non-zero"
fi

# ---- Test 10: not JSON → exit non-zero ----
echo 'not valid json at all' > "$TMP_CASES/fail-bad-json.jsonl"

if ! "$VALIDATOR" "$TMP_CASES/fail-bad-json.jsonl" >/dev/null 2>&1; then
  pass "invalid JSON line exits non-zero"
else
  fail "invalid JSON line exits non-zero"
fi

# ---- Test 11: invalid requires key → exit non-zero ----
echo "# Test task bad req" > "$TASK_FILE"11
echo '{"id":"T1-FAIL-003","wave":1,"workflow":"fdmw","fixture":"tt-ts","harness":"pi","task":"var/tier1-test-task-$$.md11","context":{"execution_mode":"real"},"caps":{"tokens":0,"wall_min":1},"requires":{"bogus_key":true},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}' > "$TMP_CASES/fail-bad-req-key.jsonl"

if ! "$VALIDATOR" "$TMP_CASES/fail-bad-req-key.jsonl" >/dev/null 2>&1; then
  pass "invalid requires key exits non-zero"
else
  fail "invalid requires key exits non-zero"
fi

# ---- Test 12: invalid platform value → exit non-zero ----
echo "# Test task bad plat" > "$TASK_FILE"12
echo '{"id":"T1-FAIL-004","wave":1,"workflow":"fdmw","fixture":"tt-ts","harness":"pi","task":"var/tier1-test-task-$$.md12","context":{"execution_mode":"real"},"caps":{"tokens":0,"wall_min":1},"requires":{"platform":"windows"},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}' > "$TMP_CASES/fail-bad-platform.jsonl"

if ! "$VALIDATOR" "$TMP_CASES/fail-bad-platform.jsonl" >/dev/null 2>&1; then
  pass "invalid platform value exits non-zero"
else
  fail "invalid platform value exits non-zero"
fi

# ---- Test 13: invalid platform array value → exit non-zero ----
echo "# Test task bad plat-arr" > "$TT_DIR/var/tier1-test-bad-plat-arr-$$.md"
echo "{\"id\":\"T1-FAIL-005\",\"wave\":1,\"workflow\":\"fdmw\",\"fixture\":\"tt-ts\",\"harness\":\"pi\",\"task\":\"var/tier1-test-bad-plat-arr-$$.md\",\"context\":{\"execution_mode\":\"real\"},\"caps\":{\"tokens\":0,\"wall_min\":1},\"requires\":{\"platform\":[\"linux\",\"freebsd\"]},\"boundary_files\":[],\"forbidden\":[],\"oracles\":[],\"gates\":[],\"chaos\":null,\"shed_ok\":false,\"mandatory\":true,\"class\":\"verification\"}" > "$TMP_CASES/fail-bad-plat-arr.jsonl"
rm -f "$TT_DIR/var/tier1-test-bad-plat-arr-$$.md"

if ! "$VALIDATOR" "$TMP_CASES/fail-bad-plat-arr.jsonl" >/dev/null 2>&1; then
  pass "invalid platform array value exits non-zero"
else
  fail "invalid platform array value exits non-zero"
fi

# ---- Test 14: negative node_min → exit non-zero ----
echo "# Test task bad node-min" > "$TASK_FILE"10
echo "{\"id\":\"T1-FAIL-006\",\"wave\":1,\"workflow\":\"fdmw\",\"fixture\":\"tt-ts\",\"harness\":\"pi\",\"task\":\"var/tier1-test-task-$$.md10\",\"context\":{\"execution_mode\":\"real\"},\"caps\":{\"tokens\":0,\"wall_min\":1},\"requires\":{\"node_min\":-1},\"boundary_files\":[],\"forbidden\":[],\"oracles\":[],\"gates\":[],\"chaos\":null,\"shed_ok\":false,\"mandatory\":true,\"class\":\"verification\"}" > "$TMP_CASES/fail-bad-node-min.jsonl"

if ! "$VALIDATOR" "$TMP_CASES/fail-bad-node-min.jsonl" >/dev/null 2>&1; then
  pass "negative node_min exits non-zero"
else
  fail "negative node_min exits non-zero"
fi

# ---- Test 15: absolute task path → exit non-zero ----
echo '{"id":"T1-FAIL-007","wave":1,"workflow":"fdmw","fixture":"tt-ts","harness":"pi","task":"/etc/passwd","context":{"execution_mode":"real"},"caps":{"tokens":0,"wall_min":1},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}' > "$TMP_CASES/fail-abs-task.jsonl"

if ! "$VALIDATOR" "$TMP_CASES/fail-abs-task.jsonl" >/dev/null 2>&1; then
  pass "absolute task path exits non-zero"
else
  fail "absolute task path exits non-zero"
fi

# ---- Test 16: empty manifest → exit non-zero ----
printf '' > "$TMP_CASES/fail-empty.jsonl"

if ! "$VALIDATOR" "$TMP_CASES/fail-empty.jsonl" >/dev/null 2>&1; then
  pass "empty manifest exits non-zero"
else
  fail "empty manifest exits non-zero"
fi

# ---- Test 17: requires capabilities with invalid entry (empty string) ----
echo "# Test task bad cap" > "$TT_DIR/var/tier1-test-bad-cap-$$.md"
echo "{\"id\":\"T1-FAIL-008\",\"wave\":1,\"workflow\":\"fdmw\",\"fixture\":\"tt-ts\",\"harness\":\"pi\",\"task\":\"var/tier1-test-bad-cap-$$.md\",\"context\":{\"execution_mode\":\"real\"},\"caps\":{\"tokens\":0,\"wall_min\":1},\"requires\":{\"capabilities\":[\"\"]},\"boundary_files\":[],\"forbidden\":[],\"oracles\":[],\"gates\":[],\"chaos\":null,\"shed_ok\":false,\"mandatory\":true,\"class\":\"verification\"}" > "$TMP_CASES/fail-bad-cap.jsonl"
rm -f "$TT_DIR/var/tier1-test-bad-cap-$$.md"

if ! "$VALIDATOR" "$TMP_CASES/fail-bad-cap.jsonl" >/dev/null 2>&1; then
  pass "empty requires.capabilities entry exits non-zero"
else
  fail "empty requires.capabilities entry exits non-zero"
fi

echo ""
echo "---"
echo "Results: $total_count tests, $((total_count - fail_count)) passed, $fail_count failed"
echo "---"

[ "$fail_count" -eq 0 ] || exit 1
