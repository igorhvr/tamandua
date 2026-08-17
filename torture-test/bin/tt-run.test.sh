#!/usr/bin/env bash
# tt-run.test.sh — tests for --tier1/--tier2 routing and arg dispatch in tt-run
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TT_RUN="$SCRIPT_DIR/tt-run"

fail_count=0
total_count=0

fail() { echo "FAIL: $1" >&2; fail_count=$((fail_count + 1)); }
pass() { echo "PASS: $1" >&2; }

# ---------------------------------------------------------------------------
# Build a standalone functions file that has all tt-run functions but no
# main body (no countdown, no arg dispatch).  We source it inside a
# controlled bash -c so we can test individual functions.
# ---------------------------------------------------------------------------
FUNCTIONS_FILE=$(mktemp)
trap "rm -f $FUNCTIONS_FILE" EXIT

# Copy variable setup and all function defs, stopping before the main
# if/elif block that starts with: if [ "$#" -eq 0 ]; then
awk '
  /^if \[ "\$#"/ { exit }
  { print }
' "$TT_RUN" > "$FUNCTIONS_FILE"

# Make sure the snippet is valid bash by adding a trailing :
echo ': dummy end-of-functions' >> "$FUNCTIONS_FILE"

_run_fn() {
  # Run a shell function defined in FUNCTIONS_FILE in a clean bash.
  # Override exec with echo so run_tier doesn't actually exec anything.
  bash -c "
    set -euo pipefail
    exec() { echo \"\$@\"; }
    exit() { echo \"EXIT:\$*\" >&2; return 0; }
    . '$FUNCTIONS_FILE'
    $1
  " 2>&1 || true
}

# ---------------------------------------------------------------------------
# Test: tier_info tier1 unchanged
# ---------------------------------------------------------------------------
total_count=$((total_count + 1))
echo "--- Test: tier_info tier1 estimate unchanged ---" >&2
tier1_info=$(_run_fn 'tier_info tier1')
if echo "$tier1_info" | grep -q '15M' && echo "$tier1_info" | grep -qE '24.*30h' && echo "$tier1_info" | grep -qE '40.*run'; then
  pass "tier_info tier1: ~15M / ~24-30h / ~40 runs"
else
  fail "tier_info tier1: got '$tier1_info'"
fi

# ---------------------------------------------------------------------------
# Test: tier_info tier0 unchanged (regression)
# ---------------------------------------------------------------------------
total_count=$((total_count + 1))
echo "--- Test: tier_info tier0 unchanged ---" >&2
tier0_info=$(_run_fn 'tier_info tier0')
if echo "$tier0_info" | grep -q '~2M tokens' && echo "$tier0_info" | grep -q 'push gate'; then
  pass "tier_info tier0 unchanged (~2M tokens, push gate)"
else
  fail "tier_info tier0 changed: '$tier0_info'"
fi

# ---------------------------------------------------------------------------
# Test: usage() documents --tier1 + --include-real
# ---------------------------------------------------------------------------
total_count=$((total_count + 1))
echo "--- Test: usage() documents --tier1 [--include-real] ---" >&2
usage_text=$(_run_fn 'usage')
all_ok=true
if echo "$usage_text" | grep -q 'tier1.*reports.*validates.*pending-real.*zero tokens'; then
  pass "  usage: tier1 zero-token default"
else
  fail "usage missing tier1 zero-token default"
  all_ok=false
fi
if echo "$usage_text" | grep -q 'tier1.*include-real.*full Tier-1 campaign'; then
  pass "  usage: tier1 --include-real"
else
  fail "usage missing tier1 --include-real text"
  all_ok=false
fi
if echo "$usage_text" | grep -q 'Usage:.*--tier1'; then
  pass "  usage: synopsis mentions --tier1"
else
  fail "usage synopsis missing --tier1"
  all_ok=false
fi
if echo "$usage_text" | grep -q 'WARNING:.*include-real'; then
  pass "  usage: real-token warning present"
else
  fail "usage missing real-token warning"
  all_ok=false
fi
if $all_ok; then pass "usage() documents --tier1 [--include-real]"; fi

# ---------------------------------------------------------------------------
# Test: run_tier tier1 default => --scripted-only
# ---------------------------------------------------------------------------
# Need fake binaries so tier_available succeeds
FAKE_HOME=$(mktemp -d)
trap "rm -rf $FAKE_HOME; rm -f $FUNCTIONS_FILE" EXIT

mkdir -p "$FAKE_HOME/bin" "$FAKE_HOME/cases"
# Minimal tier1.jsonl for availability check
echo '{"id":"dummy"}' > "$FAKE_HOME/cases/tier1.jsonl"

cat > "$FAKE_HOME/bin/tt-controller" <<'EOS'
#!/usr/bin/env bash
exit 0
EOS
chmod +x "$FAKE_HOME/bin/tt-controller"

cat > "$FAKE_HOME/bin/tt-tier1-assets" <<'EOS'
#!/usr/bin/env bash
exit 0
EOS
chmod +x "$FAKE_HOME/bin/tt-tier1-assets"

# A copy of tt-run inside the fake tree resolves TT_BIN_DIR/TT_DIR to the fake
# tree, so whole-script dispatch tests exec the RECORDING stub controller below
# (never the real controller / never a real campaign). The stub echoes its
# argv so the tests can assert the exact routing.
cp "$TT_RUN" "$FAKE_HOME/bin/tt-run"
cat > "$FAKE_HOME/bin/tt-controller" <<'EOS'
#!/usr/bin/env bash
echo "CONTROLLER_ARGS:$*"
exit 0
EOS
chmod +x "$FAKE_HOME/bin/tt-controller"

total_count=$((total_count + 1))
echo "--- Test: run_tier tier1 default uses --scripted-only ---" >&2
tier1_def=$(_run_fn "
  TT_BIN_DIR='$FAKE_HOME/bin'
  TT_DIR='$FAKE_HOME'
  export TT_BIN_DIR TT_DIR
  export PATH=\"\$TT_BIN_DIR:\$PATH\"
  run_tier tier1 false
")
if echo "$tier1_def" | grep -q 'scripted-only' && echo "$tier1_def" | grep -q 'cases/tier1.jsonl'; then
  pass "run_tier tier1 default: --scripted-only + tier1.jsonl"
else
  fail "run_tier tier1 default: got '$tier1_def'"
fi

# ---------------------------------------------------------------------------
# Test: run_tier tier1 include_real => NO --scripted-only
# ---------------------------------------------------------------------------
total_count=$((total_count + 1))
echo "--- Test: run_tier tier1 --include-real excludes --scripted-only ---" >&2
tier1_real=$(_run_fn "
  TT_BIN_DIR='$FAKE_HOME/bin'
  TT_DIR='$FAKE_HOME'
  export TT_BIN_DIR TT_DIR
  export PATH=\"\$TT_BIN_DIR:\$PATH\"
  run_tier tier1 true
")
if echo "$tier1_real" | grep -qv 'scripted-only' && echo "$tier1_real" | grep -q 'cases/tier1.jsonl'; then
  pass "run_tier tier1 true: no --scripted-only + tier1.jsonl"
else
  fail "run_tier tier1 true: got '$tier1_real'"
fi

# ---------------------------------------------------------------------------
# Test: tier0 routing unchanged (regression)
# ---------------------------------------------------------------------------
echo '{"id":"dummy"}' > "$FAKE_HOME/cases/tier0.jsonl"
cat > "$FAKE_HOME/bin/tt-tier0-assets" <<'EOS'
#!/usr/bin/env bash
exit 0
EOS
chmod +x "$FAKE_HOME/bin/tt-tier0-assets"

total_count=$((total_count + 1))
echo "--- Test: tier0 routing unchanged ---" >&2
tier0_def=$(_run_fn "
  TT_BIN_DIR='$FAKE_HOME/bin'
  TT_DIR='$FAKE_HOME'
  export TT_BIN_DIR TT_DIR
  export PATH=\"\$TT_BIN_DIR:\$PATH\"
  run_tier tier0 false
")
if echo "$tier0_def" | grep -q 'scripted-only' && echo "$tier0_def" | grep -q 'cases/tier0.jsonl'; then
  pass "run_tier tier0 default unchanged"
else
  fail "run_tier tier0 default changed: '$tier0_def'"
fi

tier0_real=$(_run_fn "
  TT_BIN_DIR='$FAKE_HOME/bin'
  TT_DIR='$FAKE_HOME'
  export TT_BIN_DIR TT_DIR
  export PATH=\"\$TT_BIN_DIR:\$PATH\"
  run_tier tier0 true
")
if echo "$tier0_real" | grep -qv 'scripted-only' && echo "$tier0_real" | grep -q 'cases/tier0.jsonl'; then
  pass "run_tier tier0 --include-real unchanged"
else
  fail "run_tier tier0 --include-real changed: '$tier0_real'"
fi

# ---------------------------------------------------------------------------
# Test: --tier1 --include-real dispatches (top-level arg parsing)
# ---------------------------------------------------------------------------
total_count=$((total_count + 1))
echo "--- Test: --tier1 --include-real arg dispatch ---" >&2
dispatch_out=$(bash "$FAKE_HOME/bin/tt-run" --tier1 --include-real 2>&1) || true
# Runs the FAKE tree (copied tt-run + recording stub controller), so this is
# hermetic: the assertion is that --tier1 --include-real reaches the
# controller WITHOUT --scripted-only (not a usage error exit 4).
if echo "$dispatch_out" | grep -q 'CONTROLLER_ARGS' && echo "$dispatch_out" | grep -q 'tier1.jsonl' && echo "$dispatch_out" | grep -qv 'scripted-only'; then
  pass "--tier1 --include-real reaches the controller without --scripted-only"
else
  fail "--tier1 --include-real: got '$dispatch_out'"
fi

# ---------------------------------------------------------------------------
# Test: invalid combinations exit 4
# ---------------------------------------------------------------------------
total_count=$((total_count + 1))
echo "--- Test: invalid arg combinations exit 4 ---" >&2
all_ok=true

# --tier1 --bogus
set +e
bash "$TT_RUN" --tier1 --bogus >/dev/null 2>&1
ec=$?
set -e
if [ "$ec" -eq 4 ]; then
  pass "  --tier1 --bogus exits 4"
else
  fail "--tier1 --bogus exited $ec, expected 4"
  all_ok=false
fi

# --tier1 --tier0 (conflicting tiers)
set +e
bash "$TT_RUN" --tier1 --tier0 >/dev/null 2>&1
ec=$?
set -e
if [ "$ec" -eq 4 ]; then
  pass "  --tier1 --tier0 exits 4"
else
  fail "--tier1 --tier0 exited $ec, expected 4"
  all_ok=false
fi

# unknown flag
set +e
bash "$TT_RUN" --tier99 >/dev/null 2>&1
ec=$?
set -e
if [ "$ec" -eq 4 ]; then
  pass "  --tier99 exits 4"
else
  fail "--tier99 exited $ec, expected 4"
  all_ok=false
fi

if $all_ok; then pass "invalid combinations exit 4 with usage"; fi

# ---------------------------------------------------------------------------
# Test: max_available_tier picks tier1 when available
# ---------------------------------------------------------------------------
total_count=$((total_count + 1))
echo "--- Test: max_available_tier selects tier1 ---" >&2
max_tier=$(_run_fn "
  TT_BIN_DIR='$FAKE_HOME/bin'
  TT_DIR='$FAKE_HOME'
  export TT_BIN_DIR TT_DIR
  export PATH=\"\$TT_BIN_DIR:\$PATH\"
  max_available_tier
")
if [ "$max_tier" = "tier1" ]; then
  pass "max_available_tier returns tier1"
else
  fail "max_available_tier returned '$max_tier', expected tier1"
fi

# ---------------------------------------------------------------------------
# Test: --tier1 (single arg) default dispatch
# ---------------------------------------------------------------------------
total_count=$((total_count + 1))
echo "--- Test: --tier1 default => --scripted-only ---" >&2
dispatch_def=$(bash "$FAKE_HOME/bin/tt-run" --tier1 2>&1) || true
# Hermetic FAKE-tree dispatch (see the --tier1 --include-real test): the
# assertion is that bare --tier1 reaches the controller WITH --scripted-only.
if echo "$dispatch_def" | grep -q 'CONTROLLER_ARGS' && echo "$dispatch_def" | grep -q 'scripted-only' && echo "$dispatch_def" | grep -q 'tier1.jsonl'; then
  pass "--tier1 default: controller invoked with --scripted-only + tier1.jsonl"
else
  fail "--tier1 default: got '$dispatch_def'"
fi

# ===========================================================================
# US-001: bash 3.2 empty-array guard for ${case_args[@]}
#
# On macOS /bin/bash 3.2.57, a bare "${case_args[@]}" command-argument
# expansion of an EMPTY array under `set -u` aborts with "unbound variable".
# Every expansion site in tt-run must use the guarded form
# ${case_args[@]+"${case_args[@]}"}, which is a no-op for empty arrays and
# byte-equivalent to the bare form for non-empty arrays on bash 4/5.
# ===========================================================================

# ---------------------------------------------------------------------------
# Test: source-level assertion — every "${case_args[@]}" expansion site in
# tt-run carries the + guard; zero bare (unguarded) expansions remain.
# ---------------------------------------------------------------------------
total_count=$((total_count + 1))
echo '--- Test: tt-run uses guarded ${case_args[@]} expansion everywhere ---' >&2
# Every quoted expansion site must be the guarded form. A BARE expansion is a
# `"${case_args[@]}"` whose opening quote is NOT preceded by `+` (the guarded
# form embeds the quoted expansion right after the `+` alternate marker).
guarded_lines=$(grep -Fc '${case_args[@]+"${case_args[@]}"}' "$TT_RUN" || true)
quoted_lines=$(grep -Fc '"${case_args[@]}"' "$TT_RUN" || true)
bare_lines=$(grep -cE '(^|[^+])"\$\{case_args\[@\]\}"' "$TT_RUN" || true)
if [ "$guarded_lines" -ge 1 ] && [ "$quoted_lines" -eq "$guarded_lines" ] && [ "$bare_lines" -eq 0 ]; then
  pass "tt-run: $guarded_lines guarded sites, $bare_lines bare expansions"
else
  fail "tt-run guard: guarded=$guarded_lines quoted=$quoted_lines bare=$bare_lines (expect guarded>=1, quoted==guarded, bare==0)"
fi

# ---------------------------------------------------------------------------
# Test: bash -n tt-run — syntax valid on every bash
# ---------------------------------------------------------------------------
total_count=$((total_count + 1))
echo "--- Test: bash -n tt-run exits 0 ---" >&2
if bash -n "$TT_RUN"; then
  pass "bash -n $TT_RUN"
else
  fail "bash -n $TT_RUN failed"
fi

# ---------------------------------------------------------------------------
# Test: functional — run_tier with an EMPTY case_id under set -u delegates the
# correct command line (no --case, no unbound-variable error). Exercises the
# guarded expansion through the awk-extracted functions harness with exec
# overridden, exactly the path that aborted on bash 3.2.
# ---------------------------------------------------------------------------
total_count=$((total_count + 1))
echo "--- Test: run_tier empty case_args under set -u (no unbound variable, no --case) ---" >&2
tier1_empty=$(_run_fn "
  TT_BIN_DIR='$FAKE_HOME/bin'
  TT_DIR='$FAKE_HOME'
  export TT_BIN_DIR TT_DIR
  export PATH=\"\$TT_BIN_DIR:\$PATH\"
  run_tier tier1 false ''
")
if echo "$tier1_empty" | grep -q 'scripted-only' \
  && echo "$tier1_empty" | grep -q 'cases/tier1.jsonl' \
  && ! echo "$tier1_empty" | grep -q -- '--case' \
  && ! echo "$tier1_empty" | grep -q 'unbound variable'; then
  pass "run_tier tier1 (empty case_args): --scripted-only + tier1.jsonl, no --case, no unbound-variable error"
else
  fail "run_tier tier1 (empty case_args): got '$tier1_empty'"
fi

# ---------------------------------------------------------------------------
# Test: functional — run_tier with a NON-EMPTY case_id still passes --case
# through (guarded form is byte-equivalent for non-empty arrays).
# ---------------------------------------------------------------------------
total_count=$((total_count + 1))
echo "--- Test: run_tier non-empty case_args passes --case through ---" >&2
tier1_case=$(_run_fn "
  TT_BIN_DIR='$FAKE_HOME/bin'
  TT_DIR='$FAKE_HOME'
  export TT_BIN_DIR TT_DIR
  export PATH=\"\$TT_BIN_DIR:\$PATH\"
  run_tier tier1 false 'CASE-1'
")
if echo "$tier1_case" | grep -q -- '--case CASE-1' && echo "$tier1_case" | grep -q 'cases/tier1.jsonl'; then
  pass "run_tier tier1 (case_id=CASE-1): --case CASE-1 + tier1.jsonl"
else
  fail "run_tier tier1 (case_id=CASE-1): got '$tier1_case'"
fi

# ===========================================================================
# US-015: the --tier2 ladder rung
# ===========================================================================

# ---------------------------------------------------------------------------
# Test: tier_info tier2 unchanged
# ---------------------------------------------------------------------------
total_count=$((total_count + 1))
echo "--- Test: tier_info tier2 estimate unchanged ---" >&2
tier2_info=$(_run_fn 'tier_info tier2')
if echo "$tier2_info" | grep -q '50M' && echo "$tier2_info" | grep -q '48h' && echo "$tier2_info" | grep -q 'storm'; then
  pass "tier_info tier2: ~50M / ~48h / storm"
else
  fail "tier_info tier2: got '$tier2_info'"
fi

# ---------------------------------------------------------------------------
# Test: usage() documents --tier2 pending-real default + --include-real
# ---------------------------------------------------------------------------
total_count=$((total_count + 1))
echo "--- Test: usage() documents --tier2 [--include-real] ---" >&2
usage_text=$(_run_fn 'usage')
all_ok=true
if echo "$usage_text" | grep -q 'tier2.*reports.*validates.*pending-real.*zero tokens'; then
  pass "  usage: tier2 zero-token default"
else
  fail "usage missing tier2 zero-token default"
  all_ok=false
fi
if echo "$usage_text" | grep -q 'tier2.*include-real.*full Tier-2 campaign'; then
  pass "  usage: tier2 --include-real"
else
  fail "usage missing tier2 --include-real text"
  all_ok=false
fi
if echo "$usage_text" | grep -q 'Usage:.*--tier2'; then
  pass "  usage: synopsis mentions --tier2"
else
  fail "usage synopsis missing --tier2"
  all_ok=false
fi
if echo "$usage_text" | grep -q 'WARNING:.*include-real'; then
  pass "  usage: real-token warning present"
else
  fail "usage missing real-token warning"
  all_ok=false
fi
if $all_ok; then pass "usage() documents --tier2 [--include-real]"; fi

# ---------------------------------------------------------------------------
# Test: run_tier tier2 default => --scripted-only (FAKE_HOME stubs)
# ---------------------------------------------------------------------------
# Extend the FAKE_HOME with a tt-tier2-assets stub + minimal tier2.jsonl so
# tier_available tier2 flips to available.
cat > "$FAKE_HOME/bin/tt-tier2-assets" <<'EOS'
#!/usr/bin/env bash
exit 0
EOS
chmod +x "$FAKE_HOME/bin/tt-tier2-assets"
echo '{"id":"dummy"}' > "$FAKE_HOME/cases/tier2.jsonl"

total_count=$((total_count + 1))
echo "--- Test: run_tier tier2 default uses --scripted-only ---" >&2
tier2_def=$(_run_fn "
  TT_BIN_DIR='$FAKE_HOME/bin'
  TT_DIR='$FAKE_HOME'
  export TT_BIN_DIR TT_DIR
  export PATH=\"\$TT_BIN_DIR:\$PATH\"
  run_tier tier2 false
")
if echo "$tier2_def" | grep -q 'scripted-only' && echo "$tier2_def" | grep -q 'cases/tier2.jsonl'; then
  pass "run_tier tier2 default: --scripted-only + tier2.jsonl"
else
  fail "run_tier tier2 default: got '$tier2_def'"
fi

# ---------------------------------------------------------------------------
# Test: run_tier tier2 include_real => NO --scripted-only
# ---------------------------------------------------------------------------
total_count=$((total_count + 1))
echo "--- Test: run_tier tier2 --include-real excludes --scripted-only ---" >&2
tier2_real=$(_run_fn "
  TT_BIN_DIR='$FAKE_HOME/bin'
  TT_DIR='$FAKE_HOME'
  export TT_BIN_DIR TT_DIR
  export PATH=\"\$TT_BIN_DIR:\$PATH\"
  run_tier tier2 true
")
if echo "$tier2_real" | grep -qv 'scripted-only' && echo "$tier2_real" | grep -q 'cases/tier2.jsonl'; then
  pass "run_tier tier2 true: no --scripted-only + tier2.jsonl"
else
  fail "run_tier tier2 true: got '$tier2_real'"
fi

# ---------------------------------------------------------------------------
# Test: tier_available tier2 flips to available; max_available_tier picks tier2
# ---------------------------------------------------------------------------
total_count=$((total_count + 1))
echo "--- Test: tier_available tier2 available + max_available_tier picks tier2 ---" >&2
t2_avail=$(_run_fn "
  TT_BIN_DIR='$FAKE_HOME/bin'
  TT_DIR='$FAKE_HOME'
  export TT_BIN_DIR TT_DIR
  export PATH=\"\$TT_BIN_DIR:\$PATH\"
  if tier_available tier2; then echo AVAILABLE; else echo UNAVAILABLE; fi
  max_available_tier
")
if echo "$t2_avail" | grep -q 'AVAILABLE' && echo "$t2_avail" | grep -q '^tier2$'; then
  pass "tier_available tier2 available; max_available_tier returns tier2"
else
  fail "tier_available tier2: got '$t2_avail'"
fi

# ---------------------------------------------------------------------------
# Test: --tier2 --include-real whole-script dispatch (FAKE tree, fast)
# ---------------------------------------------------------------------------
# Uses the FAKE tree set up for the --tier1 dispatch tests (copied tt-run +
# recording stub controller), so the arg parser ACCEPTS --include-real with
# --tier2 and the routing drops --scripted-only — never a real campaign.
total_count=$((total_count + 1))
echo "--- Test: --tier2 --include-real dispatches (not usage error) ---" >&2
dispatch_t2=$(bash "$FAKE_HOME/bin/tt-run" --tier2 --include-real 2>&1) || true
if echo "$dispatch_t2" | grep -q 'CONTROLLER_ARGS' && echo "$dispatch_t2" | grep -qv 'scripted-only' && echo "$dispatch_t2" | grep -q 'tier2.jsonl'; then
  pass "--tier2 --include-real reaches the controller without --scripted-only"
else
  fail "--tier2 --include-real: got '$dispatch_t2'"
fi

total_count=$((total_count + 1))
echo "--- Test: --tier2 (bare) whole-script dispatch passes --scripted-only ---" >&2
dispatch_t2_bare=$(bash "$FAKE_HOME/bin/tt-run" --tier2 2>&1) || true
if echo "$dispatch_t2_bare" | grep -q 'scripted-only' && echo "$dispatch_t2_bare" | grep -q 'tier2.jsonl'; then
  pass "--tier2 bare: controller invoked with --scripted-only + tier2.jsonl"
else
  fail "--tier2 bare: got '$dispatch_t2_bare'"
fi

# ---------------------------------------------------------------------------
# Test: --tier2 invalid combinations exit 4 (mirror tier1)
# ---------------------------------------------------------------------------
total_count=$((total_count + 1))
echo "--- Test: --tier2 invalid combinations exit 4 ---" >&2
all_ok=true

set +e
bash "$TT_RUN" --tier2 --bogus >/dev/null 2>&1
ec=$?
set -e
if [ "$ec" -eq 4 ]; then
  pass "  --tier2 --bogus exits 4"
else
  fail "--tier2 --bogus exited $ec, expected 4"
  all_ok=false
fi

set +e
bash "$TT_RUN" --tier2 --tier1 >/dev/null 2>&1
ec=$?
set -e
if [ "$ec" -eq 4 ]; then
  pass "  --tier2 --tier1 (conflicting tiers) exits 4"
else
  fail "--tier2 --tier1 exited $ec, expected 4"
  all_ok=false
fi

if $all_ok; then pass "--tier2 invalid combinations exit 4 with usage"; fi

# ===========================================================================
# US-009: --provision [tier] single provision entry point
#
# --provision is an exclusive mode (parallel to --report): it runs
# tt-verify-environment --tier <tier> (gate, fail-closed on non-zero), then
# tt-golden-bootstrap --fixture <fixture> for every fixture in the tier's set
# (tier1 -> tt-python, tt-ts, tt-poly-lite, tt-python@master; tier2 -> all
# eight KNOWN_FIXTURES). Idempotent: valid goldens are a no-op (never
# rebuilt). Fail-closed: any fixture failure prints the per-asset reason and
# the run exits non-zero. Combining --provision with tier flags,
# --include-real, --case, or --report exits 4 with a usage error.
# ===========================================================================

# Recording fakes: tt-verify-environment logs its argv to verify-calls.log;
# tt-golden-bootstrap logs its argv to provision-calls.log. This is the same
# recording-stub pattern used for tt-controller above — the assertions prove
# the exact delegation without launching anything.
cat > "$FAKE_HOME/bin/tt-verify-environment" <<EOS
#!/usr/bin/env bash
echo "VERIFY_ARGS:\$*" >> "$FAKE_HOME/verify-calls.log"
echo "VERIFY_ARGS:\$*"
exit 0
EOS
chmod +x "$FAKE_HOME/bin/tt-verify-environment"
cat > "$FAKE_HOME/bin/tt-golden-bootstrap.mjs" <<EOS
#!/usr/bin/env bash
echo "\$*" >> "$FAKE_HOME/provision-calls.log"
echo '{"ok":true,"built":false}'
exit 0
EOS
chmod +x "$FAKE_HOME/bin/tt-golden-bootstrap.mjs"

# ---------------------------------------------------------------------------
# Test: the REAL provision target exists (regression guard). The delegation
# tests below use a FAKE tt-run copied into $FAKE_HOME/bin (so TT_BIN_DIR
# resolves to the fake dir and they can only prove delegation, never that the
# real target exists). This assertion pins the real binary name tt-run must
# invoke — tt-golden-bootstrap.mjs — so a rename/regression cannot silently
# break `--provision` against the real entry point.
# ---------------------------------------------------------------------------
total_count=$((total_count + 1))
echo "--- Test: real tt-golden-bootstrap.mjs exists and tt-run invokes it ---" >&2
all_ok=true
if [ -x "$SCRIPT_DIR/tt-golden-bootstrap.mjs" ]; then
  pass "  real torture-test/bin/tt-golden-bootstrap.mjs exists and is executable"
else
  fail "  real torture-test/bin/tt-golden-bootstrap.mjs missing or not executable"
  all_ok=false
fi
if grep -Fq -- 'tt-golden-bootstrap.mjs' "$TT_RUN"; then
  pass "  tt-run source references tt-golden-bootstrap.mjs"
else
  fail "  tt-run source never references tt-golden-bootstrap.mjs"
  all_ok=false
fi
if grep -Fq -- 'tt-golden-bootstrap"' "$TT_RUN"; then
  fail "  tt-run still invokes the bare tt-golden-bootstrap (no .mjs)"
  all_ok=false
else
  pass "  tt-run has no bare tt-golden-bootstrap invocation (always .mjs)"
fi
if $all_ok; then pass "real tt-golden-bootstrap.mjs exists and tt-run invokes it"; fi

# ---------------------------------------------------------------------------
# Test: usage() documents --provision with its optional tier argument (AC1)
# ---------------------------------------------------------------------------
total_count=$((total_count + 1))
echo "--- Test: usage() documents --provision [tier1|tier2] (AC1) ---" >&2
usage_text=$(_run_fn 'usage')
all_ok=true
if echo "$usage_text" | grep -Fq -- '--provision'; then
  pass "  usage mentions --provision"
else
  fail "usage missing --provision"
  all_ok=false
fi
if echo "$usage_text" | grep -Fq 'tier1|tier2'; then
  pass "  usage documents the optional tier argument (tier1|tier2)"
else
  fail "usage missing the --provision tier argument"
  all_ok=false
fi
if echo "$usage_text" | grep -Fq 'defaults to tier1'; then
  pass "  usage documents the bare --provision default (tier1)"
else
  fail "usage missing the bare --provision default"
  all_ok=false
fi
if $all_ok; then pass "usage() documents --provision [tier1|tier2]"; fi

# ---------------------------------------------------------------------------
# Test: --provision tier1 delegates tt-verify-environment --tier tier1 and
# tt-golden-bootstrap --fixture for each tier1 fixture, verify before
# bootstrap, and never bootstraps tier2-only fixtures (AC2).
# ---------------------------------------------------------------------------
total_count=$((total_count + 1))
echo "--- Test: --provision tier1 delegates verify + the tier1 fixture set (AC2) ---" >&2
rm -f "$FAKE_HOME/verify-calls.log" "$FAKE_HOME/provision-calls.log"
set +e
prov1=$(bash "$FAKE_HOME/bin/tt-run" --provision tier1 2>&1)
prov1_ec=$?
set -e
all_ok=true
if [ "$prov1_ec" -eq 0 ]; then
  pass "  --provision tier1 exits 0"
else
  fail "--provision tier1 exited $prov1_ec: $(echo "$prov1" | tail -3)"
  all_ok=false
fi
if [ -f "$FAKE_HOME/verify-calls.log" ] && grep -Fq -- '--tier tier1' "$FAKE_HOME/verify-calls.log"; then
  pass "  delegates tt-verify-environment --tier tier1"
else
  fail "  verify delegation missing (log: $(cat "$FAKE_HOME/verify-calls.log" 2>/dev/null))"
  all_ok=false
fi
for fixture in tt-python tt-ts tt-poly-lite tt-python@master; do
  if [ -f "$FAKE_HOME/provision-calls.log" ] && grep -Fxq -- "--fixture $fixture" "$FAKE_HOME/provision-calls.log"; then
    pass "  delegates tt-golden-bootstrap --fixture $fixture"
  else
    fail "  bootstrap delegation missing for $fixture"
    all_ok=false
  fi
done
for fixture in tt-go tt-java tt-rust tt-poly; do
  if [ -f "$FAKE_HOME/provision-calls.log" ] && grep -Fxq -- "--fixture $fixture" "$FAKE_HOME/provision-calls.log"; then
    fail "  tier1 provision must NOT bootstrap $fixture"
    all_ok=false
  fi
done
verify_line=$(echo "$prov1" | grep -n 'VERIFY_ARGS' | head -1 | cut -d: -f1 || true)
first_prov_line=$(echo "$prov1" | grep -n '\[provision\]' | head -1 | cut -d: -f1 || true)
if [ -n "$verify_line" ] && [ -n "$first_prov_line" ] && [ "$verify_line" -lt "$first_prov_line" ]; then
  pass "  environment gate runs before any fixture bootstrap"
else
  fail "  gate/bootstrap ordering wrong (verify_line=$verify_line first_prov_line=$first_prov_line)"
  all_ok=false
fi
if $all_ok; then pass "--provision tier1 delegates verify + the tier1 fixture set"; fi

# ---------------------------------------------------------------------------
# Test: bare --provision defaults to tier1 (documented default).
# ---------------------------------------------------------------------------
total_count=$((total_count + 1))
echo "--- Test: bare --provision defaults to tier1 ---" >&2
rm -f "$FAKE_HOME/verify-calls.log" "$FAKE_HOME/provision-calls.log"
set +e
prov_bare=$(bash "$FAKE_HOME/bin/tt-run" --provision 2>&1)
prov_bare_ec=$?
set -e
all_ok=true
if [ "$prov_bare_ec" -eq 0 ] && grep -Fq -- '--tier tier1' "$FAKE_HOME/verify-calls.log" 2>/dev/null; then
  pass "  bare --provision delegates --tier tier1"
else
  fail "  bare --provision: exit=$prov_bare_ec verify_log=$(cat "$FAKE_HOME/verify-calls.log" 2>/dev/null)"
  all_ok=false
fi
for fixture in tt-python tt-ts tt-poly-lite tt-python@master; do
  if ! grep -Fxq -- "--fixture $fixture" "$FAKE_HOME/provision-calls.log" 2>/dev/null; then
    fail "  bare --provision missing $fixture"
    all_ok=false
  fi
done
if ! grep -Fxq -- '--fixture tt-go' "$FAKE_HOME/provision-calls.log" 2>/dev/null; then
  pass "  bare --provision does not bootstrap tier2-only fixtures"
else
  fail "  bare --provision bootstrapped a tier2-only fixture"
  all_ok=false
fi
if $all_ok; then pass "bare --provision defaults to tier1"; fi

# ---------------------------------------------------------------------------
# Test (US-005): --provision --rebuild-invalid passes the flag through to each
# per-fixture tt-golden-bootstrap.mjs call, and the per-asset OK label
# distinguishes a rebuilt-invalid golden from a plain build.
# ---------------------------------------------------------------------------
total_count=$((total_count + 1))
echo "--- Test: --provision --rebuild-invalid delegates the flag per fixture (US-005) ---" >&2
rm -f "$FAKE_HOME/verify-calls.log" "$FAKE_HOME/provision-calls.log"
set +e
prov_ri=$(bash "$FAKE_HOME/bin/tt-run" --provision tier1 --rebuild-invalid 2>&1)
prov_ri_ec=$?
set -e
all_ok=true
if [ "$prov_ri_ec" -eq 0 ]; then
  pass "  --provision tier1 --rebuild-invalid exits 0"
else
  fail "--provision tier1 --rebuild-invalid exited $prov_ri_ec: $(echo "$prov_ri" | tail -3)"
  all_ok=false
fi
for fixture in tt-python tt-ts tt-poly-lite tt-python@master; do
  if [ -f "$FAKE_HOME/provision-calls.log" ] && grep -Fxq -- "--fixture $fixture --rebuild-invalid" "$FAKE_HOME/provision-calls.log"; then
    pass "  delegates tt-golden-bootstrap --fixture $fixture --rebuild-invalid"
  else
    fail "  --rebuild-invalid delegation missing for $fixture (log: $(cat "$FAKE_HOME/provision-calls.log" 2>/dev/null))"
    all_ok=false
  fi
done
if $all_ok; then pass "--provision --rebuild-invalid delegates the flag per fixture"; fi

# ---------------------------------------------------------------------------
# Test (US-005): a rebuilt-invalid verdict is labelled OK (rebuilt-invalid),
# distinct from a plain build / no-rebuild no-op.
# ---------------------------------------------------------------------------
cat > "$FAKE_HOME/bin/tt-golden-bootstrap.mjs" <<EOS
#!/usr/bin/env bash
echo "\$*" >> "$FAKE_HOME/provision-calls.log"
if printf '%s' "\$*" | grep -q -- '--rebuild-invalid'; then
  echo '{"ok":true,"built":true,"rebuiltInvalid":true,"invalidReason":"golden-hash-file-missing"}'
else
  echo '{"ok":true,"built":false}'
fi
exit 0
EOS
chmod +x "$FAKE_HOME/bin/tt-golden-bootstrap.mjs"

total_count=$((total_count + 1))
echo "--- Test: rebuilt-invalid fixture labelled OK (rebuilt-invalid) (US-005) ---" >&2
rm -f "$FAKE_HOME/verify-calls.log" "$FAKE_HOME/provision-calls.log"
set +e
prov_ri2=$(bash "$FAKE_HOME/bin/tt-run" --provision tier1 --rebuild-invalid 2>&1)
prov_ri2_ec=$?
set -e
all_ok=true
if [ "$prov_ri2_ec" -eq 0 ] && [ "$(echo "$prov_ri2" | grep -c 'OK (rebuilt-invalid)' || true)" -eq 4 ]; then
  pass "  4x OK (rebuilt-invalid) for the self-healed fixtures"
else
  fail "  expected 4x OK (rebuilt-invalid), exit=$prov_ri2_ec: $(echo "$prov_ri2" | tail -6)"
  all_ok=false
fi
if [ "$(echo "$prov_ri2" | grep -c 'OK (built)' || true)" -eq 0 ]; then
  pass "  no plain OK (built) label when every fixture was rebuilt-invalid"
else
  fail "  unexpected OK (built) labels: $(echo "$prov_ri2" | grep 'OK (built)')"
  all_ok=false
fi
if $all_ok; then pass "rebuilt-invalid fixture labelled OK (rebuilt-invalid)"; fi

# Restore the plain recording fake for the remaining provision tests.
cat > "$FAKE_HOME/bin/tt-golden-bootstrap.mjs" <<EOS
#!/usr/bin/env bash
echo "\$*" >> "$FAKE_HOME/provision-calls.log"
echo '{"ok":true,"built":false}'
exit 0
EOS
chmod +x "$FAKE_HOME/bin/tt-golden-bootstrap.mjs"

# ---------------------------------------------------------------------------
# Test (US-005): usage() documents --rebuild-invalid; the flag requires
# --provision and cannot be combined with tier flags.
# ---------------------------------------------------------------------------
total_count=$((total_count + 1))
echo "--- Test: usage() documents --rebuild-invalid (US-005) ---" >&2
usage_text=$(_run_fn 'usage')
all_ok=true
if echo "$usage_text" | grep -Fq -- '--rebuild-invalid'; then
  pass "  usage mentions --rebuild-invalid"
else
  fail "usage missing --rebuild-invalid"
  all_ok=false
fi
if echo "$usage_text" | grep -Fq 'rebuilt from scratch'; then
  pass "  usage describes the self-heal (rebuilt from scratch)"
else
  fail "usage missing the self-heal description"
  all_ok=false
fi
if $all_ok; then pass "usage() documents --rebuild-invalid"; fi

total_count=$((total_count + 1))
echo "--- Test: --rebuild-invalid without --provision / with tier flags exits 4 (US-005) ---" >&2
all_ok=true
for combo in "--rebuild-invalid" "--tier1 --rebuild-invalid" "--rebuild-invalid --tier1"; do
  set +e
  bash "$TT_RUN" $combo >/dev/null 2>&1
  ec=$?
  set -e
  if [ "$ec" -eq 4 ]; then
    pass "  '$combo' exits 4"
  else
    fail "'$combo' exited $ec, expected 4"
    all_ok=false
  fi
done
if $all_ok; then pass "--rebuild-invalid misuse exits 4 with usage"; fi

# ---------------------------------------------------------------------------
# Test: --provision tier2 delegates all eight KNOWN_FIXTURES (tier2 set).
# ---------------------------------------------------------------------------
total_count=$((total_count + 1))
echo "--- Test: --provision tier2 delegates all eight fixtures ---" >&2
rm -f "$FAKE_HOME/verify-calls.log" "$FAKE_HOME/provision-calls.log"
set +e
prov2=$(bash "$FAKE_HOME/bin/tt-run" --provision tier2 2>&1)
prov2_ec=$?
set -e
all_ok=true
if [ "$prov2_ec" -eq 0 ] && grep -Fq -- '--tier tier2' "$FAKE_HOME/verify-calls.log" 2>/dev/null; then
  pass "  --provision tier2 delegates --tier tier2"
else
  fail "  --provision tier2: exit=$prov2_ec"
  all_ok=false
fi
for fixture in tt-go tt-java tt-poly tt-poly-lite tt-python tt-python@master tt-rust tt-ts; do
  if ! grep -Fxq -- "--fixture $fixture" "$FAKE_HOME/provision-calls.log" 2>/dev/null; then
    fail "  --provision tier2 missing $fixture"
    all_ok=false
  fi
done
if [ "$(grep -c '^--fixture ' "$FAKE_HOME/provision-calls.log" 2>/dev/null || true)" -eq 8 ]; then
  pass "  --provision tier2 bootstraps exactly 8 fixtures"
else
  fail "  --provision tier2 fixture count != 8"
  all_ok=false
fi
if $all_ok; then pass "--provision tier2 delegates all eight fixtures"; fi

# ---------------------------------------------------------------------------
# Test: a fake failing fixture yields the per-asset fail-closed reason and a
# non-zero exit, while every other fixture still reports (AC3).
# ---------------------------------------------------------------------------
cat > "$FAKE_HOME/bin/tt-golden-bootstrap.mjs" <<EOS
#!/usr/bin/env bash
echo "\$*" >> "$FAKE_HOME/provision-calls.log"
if [ "\$2" = "tt-ts" ]; then
  echo '{"ok":false,"reason":{"category":"golden-ref-mismatch","message":"golden ref does not match recorded hash","fixture":"tt-ts"}}'
  exit 1
fi
echo '{"ok":true,"built":false}'
exit 0
EOS
chmod +x "$FAKE_HOME/bin/tt-golden-bootstrap.mjs"

total_count=$((total_count + 1))
echo "--- Test: failing fixture => per-asset reason + non-zero exit (AC3) ---" >&2
rm -f "$FAKE_HOME/verify-calls.log" "$FAKE_HOME/provision-calls.log"
set +e
prov_fail=$(bash "$FAKE_HOME/bin/tt-run" --provision tier1 2>&1)
prov_fail_ec=$?
set -e
all_ok=true
if [ "$prov_fail_ec" -ne 0 ]; then
  pass "  --provision with a failing fixture exits non-zero ($prov_fail_ec)"
else
  fail "  expected non-zero exit, got 0"
  all_ok=false
fi
if echo "$prov_fail" | grep -q 'PROVISION FAILED'; then
  pass "  output contains PROVISION FAILED"
else
  fail "  no PROVISION FAILED line: $(echo "$prov_fail" | tail -5)"
  all_ok=false
fi
if echo "$prov_fail" | grep -q 'golden-ref-mismatch' && echo "$prov_fail" | grep -q 'golden ref does not match recorded hash'; then
  pass "  per-asset fail-closed reason surfaced"
else
  fail "  per-asset reason missing: $(echo "$prov_fail" | tail -8)"
  all_ok=false
fi
if echo "$prov_fail" | grep -q 'tt-ts'; then
  pass "  failing fixture named"
else
  fail "  failing fixture not named"
  all_ok=false
fi
if [ "$(grep -c '^--fixture ' "$FAKE_HOME/provision-calls.log" 2>/dev/null || true)" -eq 4 ]; then
  pass "  all tier1 fixtures were attempted (failures reported per-asset)"
else
  fail "  fixture attempt count != 4 (log: $(cat "$FAKE_HOME/provision-calls.log" 2>/dev/null))"
  all_ok=false
fi
if $all_ok; then pass "failing fixture => per-asset reason + non-zero exit"; fi

# ---------------------------------------------------------------------------
# Test: a second --provision tier1 invocation with goldens present performs no
# rebuild (idempotent no-op) (AC4). The fake golden store builds on the first
# call per fixture (built:true) and no-ops on later calls (built:false).
# ---------------------------------------------------------------------------
mkdir -p "$FAKE_HOME/state"
cat > "$FAKE_HOME/bin/tt-golden-bootstrap.mjs" <<EOS
#!/usr/bin/env bash
fixture="\$2"
marker="$FAKE_HOME/state/\$fixture.ok"
if [ -f "\$marker" ]; then
  echo '{"ok":true,"built":false}'
else
  touch "\$marker"
  echo '{"ok":true,"built":true}'
fi
exit 0
EOS
chmod +x "$FAKE_HOME/bin/tt-golden-bootstrap.mjs"

total_count=$((total_count + 1))
echo "--- Test: second --provision tier1 is an idempotent no-op (AC4) ---" >&2
rm -rf "$FAKE_HOME/state"; mkdir -p "$FAKE_HOME/state"
set +e
prov_first=$(bash "$FAKE_HOME/bin/tt-run" --provision tier1 2>&1)
prov_first_ec=$?
prov_second=$(bash "$FAKE_HOME/bin/tt-run" --provision tier1 2>&1)
prov_second_ec=$?
set -e
all_ok=true
if [ "$prov_first_ec" -eq 0 ] && [ "$prov_second_ec" -eq 0 ]; then
  pass "  both invocations exit 0"
else
  fail "  exit codes: first=$prov_first_ec second=$prov_second_ec"
  all_ok=false
fi
first_built=$(echo "$prov_first" | grep -c 'OK (built)' || true)
first_norebuild=$(echo "$prov_first" | grep -c 'OK (present, no rebuild)' || true)
second_built=$(echo "$prov_second" | grep -c 'OK (built)' || true)
second_norebuild=$(echo "$prov_second" | grep -c 'OK (present, no rebuild)' || true)
if [ "$first_built" -eq 4 ] && [ "$first_norebuild" -eq 0 ]; then
  pass "  first invocation builds every fixture (4x OK (built))"
else
  fail "  first invocation: built=$first_built norebuild=$first_norebuild"
  all_ok=false
fi
if [ "$second_built" -eq 0 ] && [ "$second_norebuild" -eq 4 ]; then
  pass "  second invocation performs no rebuild (4x OK (present, no rebuild))"
else
  fail "  second invocation: built=$second_built norebuild=$second_norebuild"
  all_ok=false
fi
if $all_ok; then pass "second --provision tier1 is an idempotent no-op"; fi

# ---------------------------------------------------------------------------
# Test: --provision combined with a tier flag, --include-real, --case, or
# --report exits 4 with a usage error (AC5); an invalid tier value also exits
# 4.
# ---------------------------------------------------------------------------
total_count=$((total_count + 1))
echo "--- Test: --provision conflicts exit 4 (AC5) ---" >&2
all_ok=true
for combo in "--provision --tier1" "--provision tier1 --tier2" "--provision --include-real" "--provision --case CASE-1" "--provision --report" "--tier1 --provision" "--report --provision" "--include-real --provision" "--provision bogus"; do
  set +e
  bash "$TT_RUN" $combo >/dev/null 2>&1
  ec=$?
  set -e
  if [ "$ec" -eq 4 ]; then
    pass "  '$combo' exits 4"
  else
    fail "'$combo' exited $ec, expected 4"
    all_ok=false
  fi
done
if $all_ok; then pass "--provision conflicts exit 4 with usage"; fi

# ---------------------------------------------------------------------------
# Test: a non-zero environment gate surfaces the verify failure and exits
# non-zero WITHOUT invoking any bootstrap (fail-closed at the gate).
# ---------------------------------------------------------------------------
cat > "$FAKE_HOME/bin/tt-verify-environment" <<'EOS'
#!/usr/bin/env bash
echo "VERIFY_ARGS:$*"
echo "REQUIRED check failed: toolchain-java-maven not found on PATH (tier2)"
exit 1
EOS
chmod +x "$FAKE_HOME/bin/tt-verify-environment"

total_count=$((total_count + 1))
echo "--- Test: failing environment gate => surfaced + non-zero, no bootstrap ---" >&2
rm -f "$FAKE_HOME/provision-calls.log"
set +e
prov_gate=$(bash "$FAKE_HOME/bin/tt-run" --provision tier2 2>&1)
prov_gate_ec=$?
set -e
all_ok=true
if [ "$prov_gate_ec" -ne 0 ]; then
  pass "  failing gate => non-zero exit ($prov_gate_ec)"
else
  fail "  expected non-zero exit, got 0"
  all_ok=false
fi
if echo "$prov_gate" | grep -q 'REQUIRED check failed' && echo "$prov_gate" | grep -q 'PROVISION FAILED'; then
  pass "  verify failure surfaced (tool output + PROVISION FAILED)"
else
  fail "  verify failure not surfaced: $(echo "$prov_gate" | tail -5)"
  all_ok=false
fi
if [ ! -s "$FAKE_HOME/provision-calls.log" ]; then
  pass "  no bootstrap invoked after a failed gate"
else
  fail "  bootstrap invoked despite gate failure"
  all_ok=false
fi
if $all_ok; then pass "failing environment gate => surfaced + non-zero, no bootstrap"; fi

# ---------------------------------------------------------------------------
# Test: E2.2 fail-closed — a manifest copy with an impossible predicate under
# --tier2 --include-real exits 2 naming the cause; bare --tier2 stays GREEN
# (pending-real). Runs the REAL tt-run + REAL tt-controller against a
# temporarily-swapped cases/tier2.jsonl (only real rows, each carrying an
# impossible capability) under a synthesized host-profile, with preflight
# disabled and harness binaries pinned to /bin/false — zero tokens, zero
# launches, everything restored in the EXIT trap.
# ---------------------------------------------------------------------------
TT_DIR="$(dirname "$SCRIPT_DIR")"
REAL_MANIFEST="$TT_DIR/cases/tier2.jsonl"
HOST_PROFILE="$TT_DIR/var/w0/host-profile.json"
T2_BACKUP="$(mktemp)"
PROFILE_BACKUP="$(mktemp)"
# var/w0 is normally created by tt-verify-environment; create it here so this
# test is hermetic on a fresh tree (the E2.2 section writes into it below).
mkdir -p "$TT_DIR/var/w0"
cp "$REAL_MANIFEST" "$T2_BACKUP"
if [ -f "$HOST_PROFILE" ]; then cp "$HOST_PROFILE" "$PROFILE_BACKUP"; else rm -f "$PROFILE_BACKUP"; fi

E2E2_ENV="TT_CONTROLLER_PREFLIGHT_DISABLED=1 TAMANDUA_PI_BINARY=/bin/false TAMANDUA_HERMES_BINARY=/bin/false TAMANDUA_DSH_BINARY=/bin/false"

e2e2_cleanup() {
  # Restore FIRST (the backups are the only copies of the originals), then
  # remove the scratch artifacts.
  cp "$T2_BACKUP" "$REAL_MANIFEST"
  if [ -f "$PROFILE_BACKUP" ]; then cp "$PROFILE_BACKUP" "$HOST_PROFILE"; else rm -f "$HOST_PROFILE"; fi
  rm -rf "$FAKE_HOME" "$T2_BACKUP" "$PROFILE_BACKUP"
  rm -f "$FUNCTIONS_FILE"
}
trap e2e2_cleanup EXIT

# Swap the manifest: keep ONLY the real rows (scripted rows are dropped so the
# fail-closed verdict is exercised without running the scripted battery) and
# give every real row an impossible capability so applyHostRequirements gates
# each one NOT_RUN(predicate) — zero real launches.
node -e '
const fs = require("fs");
const rows = fs.readFileSync(process.argv[1], "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
const real = rows.filter((r) => r.context && r.context.execution_mode === "real");
if (real.length === 0) { console.error("no real rows in manifest"); process.exit(2); }
for (const r of real) {
  r.requires = r.requires || {};
  r.requires.capabilities = [...(r.requires.capabilities || []), "definitely-absent-capability"];
}
fs.writeFileSync(process.argv[2], real.map((r) => JSON.stringify(r)).join("\n") + "\n");
' "$T2_BACKUP" "$REAL_MANIFEST"

# Synthesized host profile satisfying every real row's toolchain/harness
# predicate EXCEPT the impossible capability (restored in the trap).
cat > "$HOST_PROFILE" <<'EOF'
{
  "platform": { "os": "linux", "arch": "arm64", "release": "0.0.0", "label": "linux" },
  "containment": { "systemdUserScope": true },
  "toolchains": {
    "node": { "present": true, "buildPassed": null, "testPassed": null, "evidence": "synthesized" },
    "python3": { "present": true, "buildPassed": null, "testPassed": null, "evidence": "synthesized" },
    "go": { "present": true, "buildPassed": null, "testPassed": null, "evidence": "synthesized" },
    "rust/cargo": { "present": true, "buildPassed": null, "testPassed": null, "evidence": "synthesized" },
    "java+maven": { "present": true, "buildPassed": null, "testPassed": null, "evidence": "synthesized" }
  },
  "capabilities": { "node-runtimes-2": true },
  "nodeRuntimes": [{ "version": "v24.0.0", "major": 24, "minor": 0, "patch": 0, "sqliteAvailable": true }],
  "harness": {
    "pi": { "present": true, "authenticated": null, "skipReason": "synthesized" },
    "hermes": { "present": true, "authenticated": null, "skipReason": "synthesized" },
    "dsh": { "present": true, "authenticated": null, "skipReason": "synthesized" }
  }
}
EOF

total_count=$((total_count + 1))
echo "--- Test: E2.2 fail-closed — --tier2 --include-real with an impossible predicate exits 2 naming the cause ---" >&2
set +e
e2e2_out=$(env $E2E2_ENV timeout 180 bash "$TT_RUN" --tier2 --include-real 2>&1)
e2e2_ec=$?
set -e
if [ "$e2e2_ec" -eq 2 ]; then
  pass "  --include-real exits 2 (INFRA_FAILURE, 0 real launched)"
else
  fail "--include-real exited $e2e2_ec, expected 2: $(echo "$e2e2_out" | tail -3)"
fi
if echo "$e2e2_out" | grep -q '^Campaign:'; then
  pass "  --include-real campaign completed (report rendered)"
else
  fail "  --include-real output missing the campaign line: $(echo "$e2e2_out" | tail -5)"
fi
e2e2_campaign=$(echo "$e2e2_out" | sed -n 's/^Campaign: //p' | head -1)
if [ -n "$e2e2_campaign" ] && [ -f "$TT_DIR/var/results/$e2e2_campaign/report.txt" ]; then
  if grep -q 'Cause: include-real requested but zero real cases launched' "$TT_DIR/var/results/$e2e2_campaign/report.txt"; then
    pass "  report.txt names the zero-real-launches cause"
  else
    fail "  report.txt missing the zero-real-launches cause"
  fi
  if grep -q 'INFRA_FAILURE (exit 2)' "$TT_DIR/var/results/$e2e2_campaign/report.txt"; then
    pass "  report.txt VERDICT is INFRA_FAILURE (exit 2)"
  else
    fail "  report.txt VERDICT not INFRA_FAILURE (exit 2)"
  fi
else
  fail "  could not locate the campaign report (campaign='$e2e2_campaign')"
fi

total_count=$((total_count + 1))
echo "--- Test: E2.2 bare mode keeps pending-real GREEN on the same manifest copy ---" >&2
set +e
bare_out=$(env $E2E2_ENV timeout 180 bash "$TT_RUN" --tier2 2>&1)
bare_ec=$?
set -e
if [ "$bare_ec" -eq 0 ]; then
  pass "  bare --tier2 exits 0 (GREEN pending-real)"
else
  fail "bare --tier2 exited $bare_ec, expected 0: $(echo "$bare_out" | tail -3)"
fi
bare_campaign=$(echo "$bare_out" | sed -n 's/^Campaign: //p' | head -1)
if [ -n "$bare_campaign" ] && [ -f "$TT_DIR/var/results/$bare_campaign/report.txt" ]; then
  if grep -q 'GREEN (exit 0)' "$TT_DIR/var/results/$bare_campaign/report.txt" && grep -q 'pending-real' "$TT_DIR/var/results/$bare_campaign/report.txt"; then
    pass "  bare report.txt is GREEN with pending-real rows"
  else
    fail "  bare report.txt not GREEN pending-real"
  fi
else
  fail "  could not locate the bare campaign report (campaign='$bare_campaign')"
fi

# Restore the real manifest + host profile NOW (trap is the safety net).
cp "$T2_BACKUP" "$REAL_MANIFEST"
if [ -f "$PROFILE_BACKUP" ]; then cp "$PROFILE_BACKUP" "$HOST_PROFILE"; else rm -f "$HOST_PROFILE"; fi

total_count=$((total_count + 1))
echo "--- Test: original cases/tier2.jsonl restored byte-identical ---" >&2
if cmp -s "$REAL_MANIFEST" "$T2_BACKUP"; then
  pass "cases/tier2.jsonl restored byte-identical"
else
  fail "cases/tier2.jsonl NOT restored byte-identical"
fi

echo ""
echo "--- Results: $((total_count - fail_count))/$total_count passed ---"
[ "$fail_count" -eq 0 ] && exit 0 || exit 1
