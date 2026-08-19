#!/usr/bin/env bash
# tt-tier2-assets.test.sh — tests for bin/tt-tier2-assets (US-015).
#
# Mirrors tt-tier1-assets.test.sh (task containment, probe refs, requires
# shape, manifest location) and adds the Tier-2 authoring-layer contracts:
# seed-vs-SEEDS.md catalog validation (E3.A S2 arm) and requires.capabilities
# well-formedness (incl. the dsh capability).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TT_DIR="$(dirname "$SCRIPT_DIR")"
VALIDATOR="$SCRIPT_DIR/tt-tier2-assets"

TMP_CASES="$(mktemp -d "$TT_DIR/cases/tt-tier2-assets-test.XXXXXX")"
TASK_FILE="$TT_DIR/var/tier2-test-task-$$.md"
UNTRACKED_DIR="$TT_DIR/scenarios/tt-tier2-untracked-$$"
SCRATCH_REPO=""
UNTRACKED_DIR_CREATED=""

cleanup() {
  rm -rf -- "$TMP_CASES"
  rm -f -- "$TASK_FILE" "$TASK_FILE"2 "$TASK_FILE"3 "$TASK_FILE"4 "$TASK_FILE"5 \
    "$TASK_FILE"6 "$TASK_FILE"7 "$TASK_FILE"8 "$TASK_FILE"9 "$TASK_FILE"10 \
    "$TASK_FILE"11 "$TASK_FILE"12 "$TASK_FILE"13 "$TASK_FILE"14 \
    "$TASK_FILE"15 "$TASK_FILE"16 "$TASK_FILE"17 "$TASK_FILE"18 "$TASK_FILE"19 \
    "$TASK_FILE"20
  if [ -n "$UNTRACKED_DIR_CREATED" ]; then rm -rf -- "$UNTRACKED_DIR"; fi
  if [ -n "$SCRATCH_REPO" ]; then rm -rf -- "$SCRATCH_REPO"; fi
}
trap 'cleanup' EXIT

fail_count=0
total_count=0

pass() { total_count=$((total_count + 1)); echo "PASS: $1"; }
fail() { fail_count=$((fail_count + 1)); total_count=$((total_count + 1)); echo "FAIL: $1"; }

# Helper: create a valid task file (needed for many tests)
echo "# Test task content" > "$TASK_FILE"

# ---- Test 1: the real tier2 manifest validates (70 cases) ----
if "$VALIDATOR" "$TT_DIR/cases/tier2.jsonl" >/dev/null 2>&1; then
  pass "real cases/tier2.jsonl exits 0"
else
  fail "real cases/tier2.jsonl exits 0"
  "$VALIDATOR" "$TT_DIR/cases/tier2.jsonl" 2>&1 || true
fi

# ---- Test 2: well-formed manifest with a valid seed + dsh capability exits 0 ----
echo "# Test task valid" > "$TASK_FILE"2
cat > "$TMP_CASES/pass-seed-dsh.jsonl" <<JSONL
{"id":"T2-PASS-001","wave":4,"workflow":"bug-fix-merge-worktree","fixture":"tt-ts","seed":"BUG-T1","harness":"dsh","task":"var/tier2-test-task-$$.md2","context":{"execution_mode":"real"},"caps":{"tokens":0,"wall_min":1},"requires":{"capabilities":["dsh"],"node_min":22},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
JSONL

if "$VALIDATOR" "$TMP_CASES/pass-seed-dsh.jsonl" >/dev/null 2>&1; then
  pass "valid seed + dsh capability exits 0"
else
  fail "valid seed + dsh capability exits 0"
  "$VALIDATOR" "$TMP_CASES/pass-seed-dsh.jsonl" 2>&1 || true
fi

# ---- Test 3: poly-lite composite seed (storm) exits 0 ----
echo "# Test task storm" > "$TASK_FILE"3
cat > "$TMP_CASES/pass-storm.jsonl" <<JSONL
{"id":"T2-PASS-002","wave":5,"workflow":"feature-dev-merge-worktree","fixture":"tt-poly-lite","seed":"storm","harness":"pi","task":"var/tier2-test-task-$$.md3","context":{"execution_mode":"real"},"caps":{"tokens":0,"wall_min":1},"requires":{"toolchains":["node","python3"]},"boundary_files":[],"forbidden":[],"oracles":[],"gates":["TIER2","W5"],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
JSONL

if "$VALIDATOR" "$TMP_CASES/pass-storm.jsonl" >/dev/null 2>&1; then
  pass "poly-lite composite seed (storm) exits 0"
else
  fail "poly-lite composite seed (storm) exits 0"
  "$VALIDATOR" "$TMP_CASES/pass-storm.jsonl" 2>&1 || true
fi

# ---- Test 4: valid requires with all allowed fields + capability pattern ----
echo "# Test task reqs" > "$TASK_FILE"4
cat > "$TMP_CASES/pass-reqs.jsonl" <<JSONL
{"id":"T2-PASS-003","wave":4,"workflow":"bug-fix-merge-worktree","fixture":"tt-ts","harness":"pi","task":"var/tier2-test-task-$$.md4","context":{"execution_mode":"real"},"caps":{"tokens":0,"wall_min":1},"requires":{"platform":"linux","toolchains":["node","python3"],"capabilities":["pi","hermes","dsh","node-runtimes-2"],"containment":["systemd-user-scope"],"node_min":22},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
JSONL

if "$VALIDATOR" "$TMP_CASES/pass-reqs.jsonl" >/dev/null 2>&1; then
  pass "valid requires predicates (incl. dsh capability) exits 0"
else
  fail "valid requires predicates (incl. dsh capability) exits 0"
  "$VALIDATOR" "$TMP_CASES/pass-reqs.jsonl" 2>&1 || true
fi

# ---- Test 5: no seed at all (optional field) exits 0 ----
echo "# Test task no-seed" > "$TASK_FILE"5
cat > "$TMP_CASES/pass-no-seed.jsonl" <<JSONL
{"id":"T2-PASS-004","wave":4,"workflow":"bug-fix-merge-worktree","fixture":"tt-ts","harness":"pi","task":"var/tier2-test-task-$$.md5","context":{"execution_mode":"real"},"caps":{"tokens":0,"wall_min":1},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
JSONL

if "$VALIDATOR" "$TMP_CASES/pass-no-seed.jsonl" >/dev/null 2>&1; then
  pass "no seed field exits 0"
else
  fail "no seed field exits 0"
  "$VALIDATOR" "$TMP_CASES/pass-no-seed.jsonl" 2>&1 || true
fi

# ---- Test 6: multiple cases ----
echo "# Test task multi" > "$TASK_FILE"6
cat > "$TMP_CASES/pass-multi-case.jsonl" <<JSONL
{"id":"T2-PASS-005a","wave":4,"workflow":"bug-fix-merge-worktree","fixture":"tt-ts","harness":"pi","task":"var/tier2-test-task-$$.md6","context":{"execution_mode":"real"},"caps":{"tokens":0,"wall_min":1},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
{"id":"T2-PASS-005b","wave":4,"workflow":"bug-fix-merge-worktree","fixture":"tt-poly","seed":"POLY-BUG-T1","harness":"pi","task":"var/tier2-test-task-$$.md6","context":{"execution_mode":"real"},"caps":{"tokens":0,"wall_min":1},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
JSONL

if "$VALIDATOR" "$TMP_CASES/pass-multi-case.jsonl" >/dev/null 2>&1; then
  pass "multiple cases exits 0"
else
  fail "multiple cases exits 0"
  "$VALIDATOR" "$TMP_CASES/pass-multi-case.jsonl" 2>&1 || true
fi

# ---- Test 7: seed NOT in the fixture's SEEDS.md catalog -> exit non-zero ----
echo "# Test task bad seed" > "$TASK_FILE"7
cat > "$TMP_CASES/fail-bad-seed.jsonl" <<JSONL
{"id":"T2-FAIL-001","wave":4,"workflow":"bug-fix-merge-worktree","fixture":"tt-ts","seed":"BUG-ZZ-NOT-A-SEED","harness":"pi","task":"var/tier2-test-task-$$.md7","context":{"execution_mode":"real"},"caps":{"tokens":0,"wall_min":1},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
JSONL

if ! "$VALIDATOR" "$TMP_CASES/fail-bad-seed.jsonl" >/dev/null 2>&1; then
  pass "seed not in SEEDS.md catalog exits non-zero"
else
  fail "seed not in SEEDS.md catalog exits non-zero"
fi

# ---- Test 8: seed on a fixture-less (none) row -> exit non-zero ----
echo "# Test task none seed" > "$TASK_FILE"8
cat > "$TMP_CASES/fail-none-seed.jsonl" <<JSONL
{"id":"T2-FAIL-002","wave":4,"workflow":"local","fixture":"none","seed":"BUG-T1","harness":"local","task":"var/tier2-test-task-$$.md8","context":{"execution_mode":"scripted"},"caps":{"tokens":0,"wall_min":1},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
JSONL

if ! "$VALIDATOR" "$TMP_CASES/fail-none-seed.jsonl" >/dev/null 2>&1; then
  pass "seed on fixture-less row exits non-zero"
else
  fail "seed on fixture-less row exits non-zero"
fi

# ---- Test 9: malformed capability entry (bad pattern) -> exit non-zero ----
echo "# Test task bad cap" > "$TASK_FILE"9
cat > "$TMP_CASES/fail-bad-cap.jsonl" <<JSONL
{"id":"T2-FAIL-003","wave":4,"workflow":"bug-fix-merge-worktree","fixture":"tt-ts","harness":"pi","task":"var/tier2-test-task-$$.md9","context":{"execution_mode":"real"},"caps":{"tokens":0,"wall_min":1},"requires":{"capabilities":["bad cap!"]},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
JSONL

if ! "$VALIDATOR" "$TMP_CASES/fail-bad-cap.jsonl" >/dev/null 2>&1; then
  pass "malformed requires.capabilities entry exits non-zero"
else
  fail "malformed requires.capabilities entry exits non-zero"
fi

# ---- Test 10: empty capability entry -> exit non-zero ----
echo "# Test task empty cap" > "$TASK_FILE"10
cat > "$TMP_CASES/fail-empty-cap.jsonl" <<JSONL
{"id":"T2-FAIL-004","wave":4,"workflow":"bug-fix-merge-worktree","fixture":"tt-ts","harness":"pi","task":"var/tier2-test-task-$$.md10","context":{"execution_mode":"real"},"caps":{"tokens":0,"wall_min":1},"requires":{"capabilities":[""]},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
JSONL

if ! "$VALIDATOR" "$TMP_CASES/fail-empty-cap.jsonl" >/dev/null 2>&1; then
  pass "empty requires.capabilities entry exits non-zero"
else
  fail "empty requires.capabilities entry exits non-zero"
fi

# ---- Test 11: invalid requires key -> exit non-zero ----
echo "# Test task bad req" > "$TASK_FILE"11
cat > "$TMP_CASES/fail-bad-req-key.jsonl" <<JSONL
{"id":"T2-FAIL-005","wave":4,"workflow":"bug-fix-merge-worktree","fixture":"tt-ts","harness":"pi","task":"var/tier2-test-task-$$.md11","context":{"execution_mode":"real"},"caps":{"tokens":0,"wall_min":1},"requires":{"bogus_key":true},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
JSONL

if ! "$VALIDATOR" "$TMP_CASES/fail-bad-req-key.jsonl" >/dev/null 2>&1; then
  pass "invalid requires key exits non-zero"
else
  fail "invalid requires key exits non-zero"
fi

# ---- Test 12: missing task file -> exit non-zero ----
cat > "$TMP_CASES/fail-missing-task.jsonl" <<JSONL
{"id":"T2-FAIL-006","wave":4,"workflow":"bug-fix-merge-worktree","fixture":"tt-ts","harness":"pi","task":"var/nonexistent-tier2-$$.md","context":{"execution_mode":"real"},"caps":{"tokens":0,"wall_min":1},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
JSONL

if ! "$VALIDATOR" "$TMP_CASES/fail-missing-task.jsonl" >/dev/null 2>&1; then
  pass "missing task file exits non-zero"
else
  fail "missing task file exits non-zero"
fi

# ---- Test 13: missing probe.sh -> exit non-zero ----
echo "# Test task bad probe" > "$TASK_FILE"13
cat > "$TMP_CASES/fail-missing-probe.jsonl" <<JSONL
{"id":"T2-FAIL-007","wave":4,"workflow":"bug-fix-merge-worktree","fixture":"tt-ts","harness":"pi","task":"var/tier2-test-task-$$.md13","context":{"execution_mode":"real"},"caps":{"tokens":0,"wall_min":1},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification","probe_id":"NONEXISTENT-PROBE-ZZ"}
JSONL

if ! "$VALIDATOR" "$TMP_CASES/fail-missing-probe.jsonl" >/dev/null 2>&1; then
  pass "missing probe.sh exits non-zero"
else
  fail "missing probe.sh exits non-zero"
fi

# ---- Test 14: not JSON -> exit non-zero ----
echo 'not valid json at all' > "$TMP_CASES/fail-bad-json.jsonl"

if ! "$VALIDATOR" "$TMP_CASES/fail-bad-json.jsonl" >/dev/null 2>&1; then
  pass "invalid JSON line exits non-zero"
else
  fail "invalid JSON line exits non-zero"
fi

# ---- Test 15: manifest outside cases/ -> exit non-zero ----
echo "# Test task outside" > "$TASK_FILE"14
OUTSIDE_MANIFEST="$(mktemp "$TT_DIR/var/tier2-outside-$$.XXXXXX.jsonl")"
printf '{"id":"T2-FAIL-008","wave":4,"workflow":"bug-fix-merge-worktree","fixture":"tt-ts","harness":"pi","task":"var/tier2-test-task-$$.md14","context":{"execution_mode":"real"},"caps":{"tokens":0,"wall_min":1},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}\n' > "$OUTSIDE_MANIFEST"

if ! "$VALIDATOR" "$OUTSIDE_MANIFEST" >/dev/null 2>&1; then
  pass "manifest outside cases/ exits non-zero"
else
  fail "manifest outside cases/ exits non-zero"
fi
rm -f -- "$OUTSIDE_MANIFEST"

# ---- Test 16: empty manifest -> exit non-zero ----
printf '' > "$TMP_CASES/fail-empty.jsonl"

if ! "$VALIDATOR" "$TMP_CASES/fail-empty.jsonl" >/dev/null 2>&1; then
  pass "empty manifest exits non-zero"
else
  fail "empty manifest exits non-zero"
fi

# ---- Test 17: red arm — scenario dir on disk but ABSENT from git ls-files ----
# US-002: an untracked scenario dir (present on disk, no tracked file under
# it) must make the availability gate refuse AND name the dir — filesystem
# existence alone must never satisfy the check.
echo "# Test task untracked" > "$TASK_FILE"17
mkdir -p "$UNTRACKED_DIR"
UNTRACKED_DIR_CREATED=1
echo "untracked marker" > "$UNTRACKED_DIR/marker.txt"
cat > "$TMP_CASES/fail-untracked-scenario.jsonl" <<JSONL
{"id":"T2-FAIL-009","wave":4,"workflow":"bug-fix-merge-worktree","fixture":"tt-ts","harness":"pi","task":"var/tier2-test-task-$$.md17","context":{"execution_mode":"scripted","scenario_id":"zz-untracked","scenario_path":"scenarios/tt-tier2-untracked-$$"},"caps":{"tokens":0,"wall_min":1},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
JSONL

if ! "$VALIDATOR" "$TMP_CASES/fail-untracked-scenario.jsonl" >"$TMP_CASES/untracked.stdout" 2>"$TMP_CASES/untracked.stderr" \
   && grep -q "tt-tier2-untracked-$$" "$TMP_CASES/untracked.stderr"; then
  pass "untracked scenario dir (on disk, absent from git ls-files) exits non-zero naming the dir"
else
  fail "untracked scenario dir (on disk, absent from git ls-files) exits non-zero naming the dir"
  cat "$TMP_CASES/untracked.stderr" 2>/dev/null || true
fi

# ---- Test 18: red arm — local-cell command arg scenarios/<dir> untracked ----
# The guard also covers command.args entries of the form scenarios/<dir>
# (the W4.27/W4.11/W4.12/W4.19-style local cells).
cat > "$TMP_CASES/fail-untracked-command-arg.jsonl" <<JSONL
{"id":"T2-FAIL-010","wave":4,"workflow":"local","fixture":"none","harness":"local","task":"var/tier2-test-task-$$.md17","context":{"execution_mode":"scripted"},"caps":{"tokens":0,"wall_min":1},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification","command":{"executable":"scenarios/lib/run-scripted-scenario","args":["scenarios/tt-tier2-untracked-$$"],"cwd":"."}}
JSONL

if ! "$VALIDATOR" "$TMP_CASES/fail-untracked-command-arg.jsonl" >"$TMP_CASES/untracked-cmd.stdout" 2>"$TMP_CASES/untracked-cmd.stderr" \
   && grep -q "tt-tier2-untracked-$$" "$TMP_CASES/untracked-cmd.stderr"; then
  pass "untracked scenario dir via command arg exits non-zero naming the dir"
else
  fail "untracked scenario dir via command arg exits non-zero naming the dir"
  cat "$TMP_CASES/untracked-cmd.stderr" 2>/dev/null || true
fi

# ---- Test 19: green arm — a TRACKED scenario dir reference exits 0 ----
echo "# Test task tracked" > "$TASK_FILE"19
cat > "$TMP_CASES/pass-tracked-scenario.jsonl" <<JSONL
{"id":"T2-PASS-006","wave":4,"workflow":"bug-fix-merge-worktree","fixture":"tt-ts","harness":"pi","task":"var/tier2-test-task-$$.md19","context":{"execution_mode":"scripted","scenario_id":"w4.21-bare-noninteractive-launch","scenario_path":"scenarios/w4.21/bare-noninteractive-launch"},"caps":{"tokens":0,"wall_min":1},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
JSONL

if "$VALIDATOR" "$TMP_CASES/pass-tracked-scenario.jsonl" >/dev/null 2>&1; then
  pass "tracked scenario dir reference exits 0"
else
  fail "tracked scenario dir reference exits 0"
  "$VALIDATOR" "$TMP_CASES/pass-tracked-scenario.jsonl" 2>&1 || true
fi

# ---- Test 20: red-then-green — delete one tracked scenario in a scratch copy ----
# A scratch copy of the tree (own git checkout) with ONE tracked scenario
# dropped from the index must make the gate refuse naming the dir; restoring
# it must pass again.
SCRATCH_REPO="$(mktemp -d "${TMPDIR:-/tmp}/tt-tier2-tracked-scratch.XXXXXX")"
mkdir -p "$SCRATCH_REPO/bin" "$SCRATCH_REPO/cases" "$SCRATCH_REPO/var" \
  "$SCRATCH_REPO/scenarios/lib"
cp "$VALIDATOR" "$SCRATCH_REPO/bin/tt-tier2-assets"
cp "$TT_DIR/scenarios/lib/tracked-tree.mjs" "$SCRATCH_REPO/scenarios/lib/tracked-tree.mjs"
cp -r "$TT_DIR/scenarios/w4.21" "$SCRATCH_REPO/scenarios/w4.21"
git init -q "$SCRATCH_REPO"
git -C "$SCRATCH_REPO" add -A
echo "# scratch task" > "$SCRATCH_REPO/var/tier2-scratch-task.md"
cat > "$SCRATCH_REPO/cases/scratch.jsonl" <<JSONL
{"id":"T2-SCRATCH","wave":4,"workflow":"bug-fix-merge-worktree","fixture":"tt-ts","harness":"pi","task":"var/tier2-scratch-task.md","context":{"execution_mode":"scripted","scenario_id":"w4.21-bare-noninteractive-launch","scenario_path":"scenarios/w4.21"},"caps":{"tokens":0,"wall_min":1},"requires":{},"boundary_files":[],"forbidden":[],"oracles":[],"gates":[],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification"}
JSONL

if "$SCRATCH_REPO/bin/tt-tier2-assets" "$SCRATCH_REPO/cases/scratch.jsonl" >/dev/null 2>&1; then
  pass "scratch copy with a tracked scenario passes"
else
  fail "scratch copy with a tracked scenario passes"
  "$SCRATCH_REPO/bin/tt-tier2-assets" "$SCRATCH_REPO/cases/scratch.jsonl" 2>&1 || true
fi

git -C "$SCRATCH_REPO" rm -r -q --cached scenarios/w4.21
if ! "$SCRATCH_REPO/bin/tt-tier2-assets" "$SCRATCH_REPO/cases/scratch.jsonl" \
     >"$SCRATCH_REPO/red.stdout" 2>"$SCRATCH_REPO/red.stderr" \
   && grep -q "scenarios/w4.21" "$SCRATCH_REPO/red.stderr"; then
  pass "deleting one tracked scenario in the scratch copy refuses naming the dir"
else
  fail "deleting one tracked scenario in the scratch copy refuses naming the dir"
  cat "$SCRATCH_REPO/red.stderr" 2>/dev/null || true
fi

git -C "$SCRATCH_REPO" add scenarios/w4.21
if "$SCRATCH_REPO/bin/tt-tier2-assets" "$SCRATCH_REPO/cases/scratch.jsonl" >/dev/null 2>&1; then
  pass "restoring the tracked scenario in the scratch copy passes again"
else
  fail "restoring the tracked scenario in the scratch copy passes again"
  "$SCRATCH_REPO/bin/tt-tier2-assets" "$SCRATCH_REPO/cases/scratch.jsonl" 2>&1 || true
fi

echo ""
echo "---"
echo "Results: $total_count tests, $((total_count - fail_count)) passed, $fail_count failed"
echo "---"

[ "$fail_count" -eq 0 ] || exit 1
