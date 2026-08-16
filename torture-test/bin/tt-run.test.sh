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
