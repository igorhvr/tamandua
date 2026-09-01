#!/usr/bin/env bash
# run.sh — self-tests for relocated torture-test files.
#
# Invokes all scripted-runtime and tt-poly test files that live under
# torture-test/self-tests/.  Each file is run serially via node --test
# (node >= 22 runs .ts directly; no build step, no new deps).  The
# script exits non-zero on any failure.
#
# Must pass twice consecutively (idempotent — each run uses fresh temp dirs).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SELF_DIR="$REPO_ROOT/torture-test/self-tests"
NODE_BIN="${TT_NODE_BIN:-$(command -v node)}"

cd "$REPO_ROOT"

PASS=0
FAIL=0

# --- helpers ---

red()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*" >&2; }

# ── Git status cleanliness guard ──────────────────────────────────
# Capture git status --porcelain BEFORE tests so we can detect any
# test that dirties the working tree (build artifacts, cache files,
# etc.).  If the tree is dirty when run.sh starts, the guard fails
# immediately so we never blame tests for pre-existing dirt.
GIT_BEFORE_FILE="$(mktemp "${TMPDIR:-/tmp}/run-sh-git-before.XXXXXX")"
GIT_AFTER_FILE="$(mktemp "${TMPDIR:-/tmp}/run-sh-git-after.XXXXXX")"

# EXIT trap MUST be set before any capture so the temp files are
# cleaned up even on early failure (set -e).
cleanup_git_snapshots() {
  rm -f -- "$GIT_BEFORE_FILE" "$GIT_AFTER_FILE"
}
trap cleanup_git_snapshots EXIT

git status --porcelain > "$GIT_BEFORE_FILE"
if [ -s "$GIT_BEFORE_FILE" ]; then
  red "ERROR: working tree is dirty before any tests ran.  Refusing to proceed."
  red "Dirty files:"
  cat "$GIT_BEFORE_FILE" >&2
  exit 1
fi

pass() { green "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { red "  FAIL: $1"; FAIL=$((FAIL + 1)); }

# ═══════════════════════════════════════════════════════════════════
# Heavy campaign tests (moved OUT of run.sh into isolated invocations)
# ───────────────────────────────────────────────────────────────────
# These tests drive full multi-hour scripted-daemon / real-flag campaigns and
# are NOT time-bounded: tier0-repeatability runs two full scripted-daemon
# campaigns, tier1-repeatability / tier1-real-case-proof / tier1-include-
# real-proof / tier1-zero-real-launch-infra / tier1-case-filter spawn real
# campaign machinery, and scripted-scenario-harness drives scenario harness
# plumbing — a single one can legitimately exceed 60+ min of ACTIVE progress
# (writing scenario git objects) on a contended machine. Running them inside
# run.sh's serial loop made run.sh's closure UNBOUNDED: when an aggregate
# deadline fired it SIGTERM'd run.sh but ORPHANED the campaign's
# daemon/tt-controller grandchildren (reparented to init), which kept running,
# leaked ports (5334/5338/5339), and broke sibling tests with EADDRINUSE.
#
# They are therefore EXCLUDED here so run.sh completes in a bounded window
# regardless of machine load, and are executed INDIVIDUALLY — each as its own
# `node --test` process under its own generous timeout (no aggregate deadline
# over the concatenation) — by bin/verify-heavy-campaign-tests.test.sh, the
# exact verify-builder-determinism.test.sh pattern. No repetition oracle is
# weakened: every test still runs, just isolated.
#
# This list MUST stay in lock-step with bin/verify-heavy-campaign-tests.test.sh
# and with self-tests/e2e-golden-integrity.test.ts (which pins the invariant).
HEAVY_CAMPAIGN_TESTS=(
    'scripted-scenario-harness.test.ts'
    'tier0-repeatability.test.ts'
    'tier1-case-filter.test.ts'
    # MACP3 US-009: the bare-vacuity red-then-green proof drives a REAL bare
    # tier1 control campaign (scripted daemon, 4 local cells execute) — the
    # same unbounded campaign class as the other heavy proofs, so it is
    # isolated here with its own ceiling.
    'tier1-bare-vacuity-red-green.test.ts'
    'tier1-e26-real-launch-proof.test.ts'
    'tier1-include-real-proof.test.ts'
    'tier1-real-case-proof.test.ts'
    'tier1-repeatability.test.ts'
    'tier1-scripted-probe-battery.test.ts'
    'tier1-kill-sentinel-survival.test.ts'
    'tier1-zero-real-launch-infra.test.ts'
    # MACP7 US-006: the stale-state hygiene red-then-green proof drives real
    # scripted-scenario executions (RED + GREEN arms against a pre-seeded
    # synthetic stale run) plus a pre-polluted bare tier1 campaign — the same
    # unbounded campaign class as the other heavy proofs, so it is isolated
    # here with its own ceiling.
    'tier1-macp7-scripted-state-hygiene.test.ts'
    # MACP4 US-007: the W2 dual-path proof drives 8 real scripted-scenario
    # executions (4 cells x systemd + forced-fallback) plus two bare tier1
    # campaigns — the same unbounded campaign class as the other heavy
    # proofs, so it is isolated here with its own ceiling.
    'tier1-w2-darwin-capable-proof.test.ts'
    # US-016: tier2-repeatability drives full tier2/tier1 controller campaigns
    # (bare --tier2 x2 + dry-run over the whole roster + no-regression) and
    # rewrites the SHARED var/w0/host-profile.json — heavy/isolated exactly
    # like the tier1 campaign proofs.
    'tier2-repeatability.test.ts'
    # US-004 (T2.1): tier2-scripted-behaviors-materialization drives the real
    # controller + scripted daemon with pinned harness binaries to prove the
    # controller materializes TAMANDUA_SCRIPTED_BEHAVIORS from the scenario cell
    # (step output matches the cell's canned output) — heavy/isolated like the
    # tier1 scripted battery.
    'tier2-scripted-behaviors-materialization.test.ts'
    # US-002 (S29): tier2-s29-fired-trigger-corridor drives the real controller
    # + scripted daemon with pinned harness binaries to prove a probe armed on
    # the US-002-calibrated step:fixer:running trigger genuinely FIRES and
    # executes its action (pause / restart_daemon) with recorded probe
    # evidence — heavy/isolated like the tier1 scripted battery.
    'tier2-s29-fired-trigger-corridor.test.ts'
    # US-010 (S44b): tier2-s44-operator-seam-corridors drives the real
    # controller + scripted daemon with pinned harness binaries to prove the
    # FIVE operator-seam cells' wired actions (restart_contained_daemon on the
    # kill-daemon cells, the during_hold restart/update on W4.33a/W4.33b, the
    # invalidate/restore credential corridor on W4.47) provably fire at their
    # declared triggers with per-action evidence and the contained runs
    # recover — heavy/isolated like the tier1 scripted battery.
    'tier2-s44-operator-seam-corridors.test.ts'
    # US-004 (S29): tier2-s29-premise-redesign-corridor drives the real
    # controller + scripted daemon with pinned harness binaries to prove the
    # REDESIGNED premise is genuinely reachable — the typed move-branch chaos
    # makes event:run.failed (W4.33d reroute exhaustion) and
    # event:merge.target_moved (W4.48b) fire, and the probe actions armed on
    # them (resume / pause) execute with recorded probe evidence —
    # heavy/isolated like the tier1 scripted battery.
    'tier2-s29-premise-redesign-corridor.test.ts'
)

# is_heavy <base> — 0 if <base> is a heavy campaign test (isolated elsewhere), else 1.
is_heavy() {
    local base="$1"
    local t
    for t in "${HEAVY_CAMPAIGN_TESTS[@]}"; do
        [ "$t" = "$base" ] && return 0
    done
    return 1
}

# --- test runner ---

run_test_file() {
  local label="$1" file="$2"

  if [ ! -f "$file" ]; then
    fail "$label" "file not found: $file"
    return 1
  fi

  if "$NODE_BIN" --test "$file" 2>&1; then
    pass "$label"
    return 0
  else
    fail "$label" "node --test exited non-zero"
    return 1
  fi
}

# ═══════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════

echo "=== run.sh — torture-test self-tests ==="
echo ""

# ── Scripted-runtime tests ────────────────────────────────────────
echo "--- scripted-runtime tests ---"
for file in "$SELF_DIR"/scripted-runtime-*.test.ts; do
  if [ ! -f "$file" ]; then
    fail "scripted-runtime glob" "no files matching $SELF_DIR/scripted-runtime-*.test.ts"
    break
  fi
  base="$(basename "$file")"
  run_test_file "scripted-runtime $base" "$file" || true
done

# ── Scripted-scenario harness tests ───────────────────────────────
echo ""
echo "--- scripted-scenario tests ---"
for file in "$SELF_DIR"/scripted-scenario-*.test.ts; do
  if [ ! -f "$file" ]; then
    fail "scripted-scenario glob" "no files matching $SELF_DIR/scripted-scenario-*.test.ts"
    break
  fi
  base="$(basename "$file")"
  if is_heavy "$base"; then
    green "  skip (heavy/isolated): $base"
    continue
  fi
  run_test_file "scripted-scenario $base" "$file" || true
done

# ── Tier-0 manifest and repeatability acceptance tests ────────────
echo ""
echo "--- tier0 tests ---"
for file in "$SELF_DIR"/tier0-*.test.ts; do
  if [ ! -f "$file" ]; then
    fail "tier0 glob" "no files matching $SELF_DIR/tier0-*.test.ts"
    break
  fi
  base="$(basename "$file")"
  if is_heavy "$base"; then
    green "  skip (heavy/isolated): $base"
    continue
  fi
  run_test_file "tier0 $base" "$file" || true
done

# ── Tier-1 manifest and repeatability acceptance tests ────────────
echo ""
echo "--- tier1 tests ---"
for file in "$SELF_DIR"/tier1-*.test.ts; do
  if [ ! -f "$file" ]; then
    fail "tier1 glob" "no files matching $SELF_DIR/tier1-*.test.ts"
    break
  fi
  base="$(basename "$file")"
  if is_heavy "$base"; then
    green "  skip (heavy/isolated): $base"
    continue
  fi
  run_test_file "tier1 $base" "$file" || true
done

# ── FIX10 audit tests ──────────────────────────────────────────────
echo ""
echo "--- fix10 audit tests ---"
for file in "$SELF_DIR"/fix10-*.test.ts; do
  if [ ! -f "$file" ]; then
    fail "fix10 glob" "no files matching $SELF_DIR/fix10-*.test.ts"
    break
  fi
  base="$(basename "$file")"
  run_test_file "fix10 audit $base" "$file" || true
done

# ── tt-poly tests ─────────────────────────────────────────────────
echo ""
echo "--- tt-poly tests ---"
for file in "$SELF_DIR"/tt-poly-*.test.ts; do
  if [ ! -f "$file" ]; then
    fail "tt-poly glob" "no files matching $SELF_DIR/tt-poly-*.test.ts"
    break
  fi
  base="$(basename "$file")"
  run_test_file "tt-poly $base" "$file" || true
done

# ── Tier-2 manifest and dsh-lane acceptance tests ────────────────────
echo ""
echo "--- tier2 tests ---"
for file in "$SELF_DIR"/tier2-*.test.ts; do
  if [ ! -f "$file" ]; then
    fail "tier2 glob" "no files matching $SELF_DIR/tier2-*.test.ts"
    break
  fi
  base="$(basename "$file")"
  if is_heavy "$base"; then
    green "  skip (heavy/isolated): $base"
    continue
  fi
  run_test_file "tier2 $base" "$file" || true
done

# ── Git status cleanliness check ─────────────────────────────────
echo ""
echo "--- git status cleanliness ---"

git status --porcelain > "$GIT_AFTER_FILE"
if diff -q "$GIT_BEFORE_FILE" "$GIT_AFTER_FILE" > /dev/null 2>&1; then
  green "Working tree: clean"
else
  red "ERROR: working tree is DIRTY after test run — tests wrote build artifacts"
  red "Files that appeared or changed during the run:"
  diff "$GIT_BEFORE_FILE" "$GIT_AFTER_FILE" >&2 || true
  FAIL=$((FAIL + 1))
fi

# ── Summary ───────────────────────────────────────────────────────
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
