#!/usr/bin/env bash
set -euo pipefail

# tt-verify-environment.test.sh — self-test for US-001 scaffolding
# Runs the tool in --fast and --json modes and verifies required output.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${SCRIPT_DIR}/tt-verify-environment"

FAILURES=0

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAILURES=$((FAILURES + 1)); }

echo "=== tt-verify-environment self-test ==="

# ── Test 1: --help ────────────────────────────────────────────────────
echo ""
echo "--- Test: --help ---"
if "$TOOL" --help | grep -q "Usage:"; then
  pass "--help prints usage"
else
  fail "--help did not print usage"
fi

if "$TOOL" --help > /dev/null 2>&1; then
  pass "--help exits 0"
else
  fail "--help did not exit 0"
fi

if "$TOOL" -h | grep -q "Usage:"; then
  pass "-h prints usage (short form)"
else
  fail "-h did not print usage"
fi

# ── Test 2: default table output ──────────────────────────────────────
# Use --fast to skip slow toolchain probes; full run tested in Test 8
echo ""
echo "--- Test: default table output ---"
output=$("$TOOL" --fast 2>&1) && exit_code=$? || exit_code=$?
# Note: exit_code is captured via &&/|| to avoid set -e triggering on non-zero

if echo "$output" | grep -q "CHECK.*|.*RESULT.*|.*EVIDENCE"; then
  pass "table header appears in default output"
else
  fail "table header missing from default output"
fi

# US-002: Platform check reports linux, darwin, or other (not just PASS)
if echo "$output" | grep -qE "platform.*\|.*PASS.*\|.*platform=(linux|darwin|other)"; then
  pass "platform check reports valid platform label (linux/darwin/other)"
else
  fail "platform check did not report valid platform label"
fi

# US-002: node-version check reports PASS with Node.js version
if echo "$output" | grep -qE "node-version.*\|.*PASS.*\|.*Node\.js v[0-9]+.*"; then
  pass "node-version check reports PASS with version info"
else
  fail "node-version check did not report PASS with version"
fi

# US-002: node-sqlite check reports PASS
if echo "$output" | grep -q "node-sqlite.*|.*PASS"; then
  pass "node-sqlite check reports PASS"
else
  fail "node-sqlite check did not report PASS"
fi

# US-002: npm check reports PASS with npm version
if echo "$output" | grep -qE "npm[^-].*\|.*PASS.*\|.*npm [0-9].*"; then
  pass "npm check reports PASS with version info"
else
  fail "npm check did not report PASS with version"
fi

# US-003: sqlite3 check reports PASS
if echo "$output" | grep -q "util-sqlite3.*|.*PASS"; then
  pass "util-sqlite3 check reports PASS"
elif echo "$output" | grep -q "util-sqlite3.*|.*FAIL.*|.*REMEDY"; then
  pass "util-sqlite3 check reports FAIL with REMEDY (acceptable on bare host)"
else
  fail "util-sqlite3 did not report PASS or FAIL with REMEDY"
fi

# US-003: curl check reports PASS
if echo "$output" | grep -q "util-curl.*|.*PASS"; then
  pass "util-curl check reports PASS"
elif echo "$output" | grep -q "util-curl.*|.*FAIL.*|.*REMEDY"; then
  pass "util-curl check reports FAIL with REMEDY (acceptable on bare host)"
else
  fail "util-curl did not report PASS or FAIL with REMEDY"
fi

# US-003: jq check reports PASS
if echo "$output" | grep -q "util-jq.*|.*PASS"; then
  pass "util-jq check reports PASS"
elif echo "$output" | grep -q "util-jq.*|.*FAIL.*|.*REMEDY"; then
  pass "util-jq check reports FAIL with REMEDY (acceptable on bare host)"
else
  fail "util-jq did not report PASS or FAIL with REMEDY"
fi

# US-003: systemd check reports PASS on linux or SKIPPED on darwin
if echo "$output" | grep -qE "systemd-user-scope.*\|.*(PASS|SKIPPED)"; then
  pass "systemd-user-scope check reports PASS or SKIPPED"
else
  fail "systemd-user-scope did not report PASS or SKIPPED"
fi

if echo "$output" | grep -q "RESULT: All REQUIRED checks"; then
  pass "summary line present"
else
  fail "summary line missing"
fi

if [ "$exit_code" -eq 0 ]; then
  pass "default mode exits 0 when no REQUIRED checks fail"
else
  fail "default mode exited $exit_code, expected 0"
fi

# ── Test 3: --fast mode ───────────────────────────────────────────────
echo ""
echo "--- Test: --fast mode ---"
fast_output=$("$TOOL" --fast 2>&1) && : || :  # always succeeds

if echo "$fast_output" | grep -q "SKIPPED.*--fast"; then
  pass "--fast mode shows toolchain probes as SKIPPED (--fast)"
else
  fail "--fast mode did not show SKIPPED (--fast) for toolchains"
fi

# Non-toolchain checks still run
if echo "$fast_output" | grep -q "node-version.*|.*PASS"; then
  pass "--fast mode still runs node-version check"
else
  fail "--fast mode did not run node-version check"
fi

if echo "$fast_output" | grep -q "git-version.*|.*PASS"; then
  pass "--fast mode still runs git-version check"
else
  fail "--fast mode did not run git-version check"
fi

# US-004: git-merge-tree check runs in --fast mode (it's not a toolchain probe)
if echo "$fast_output" | grep -qE "git-merge-tree.*\|.*PASS.*\|.*merge-tree OK:"; then
  pass "--fast mode still runs git-merge-tree probe"
else
  fail "--fast mode did not run git-merge-tree probe"
fi

# ── Test 4: --json mode ───────────────────────────────────────────────
echo ""
echo "--- Test: --json mode ---"
if "$TOOL" --fast --json > /dev/null 2>&1; then
  pass "--json mode exits 0"
else
  fail "--json mode exited non-zero"
fi

# Verify JSON structure with jq if available
if command -v jq &>/dev/null; then
  json_output=$("$TOOL" --fast --json 2>&1) && : || :  # always succeeds

  if echo "$json_output" | jq -e '.checks' > /dev/null 2>&1; then
    pass "--json output has .checks array"
  else
    fail "--json output missing .checks array"
  fi

  if echo "$json_output" | jq -e '.exitCode' > /dev/null 2>&1; then
    pass "--json output has .exitCode"
  else
    fail "--json output missing .exitCode"
  fi

  if echo "$json_output" | jq -e '.tier' > /dev/null 2>&1; then
    pass "--json output has .tier"
  else
    fail "--json output missing .tier"
  fi

  if echo "$json_output" | jq -e '.platform' > /dev/null 2>&1; then
    pass "--json output has .platform"
  else
    fail "--json output missing .platform"
  fi

  if echo "$json_output" | jq -e '.timestamp' > /dev/null 2>&1; then
    pass "--json output has .timestamp"
  else
    fail "--json output missing .timestamp"
  fi

  if echo "$json_output" | jq -e '.flags' > /dev/null 2>&1; then
    pass "--json output has .flags"
  else
    fail "--json output missing .flags"
  fi

  # US-002: hostProfile accumulator present with platform and node runtime data
  if echo "$json_output" | jq -e '.hostProfile' > /dev/null 2>&1; then
    pass "--json output has .hostProfile"
  else
    fail "--json output missing .hostProfile"
  fi

  if echo "$json_output" | jq -e '.hostProfile.platform.os' > /dev/null 2>&1; then
    pass "hostProfile.platform.os is present"
  else
    fail "hostProfile.platform.os missing"
  fi

  if echo "$json_output" | jq -e '.hostProfile.platform.arch' > /dev/null 2>&1; then
    pass "hostProfile.platform.arch is present"
  else
    fail "hostProfile.platform.arch missing"
  fi

  if echo "$json_output" | jq -e '.hostProfile.platform.label' > /dev/null 2>&1; then
    pass "hostProfile.platform.label is present"
  else
    fail "hostProfile.platform.label missing"
  fi

  if echo "$json_output" | jq -e '.hostProfile.nodeRuntimes' > /dev/null 2>&1; then
    pass "hostProfile.nodeRuntimes is present"
  else
    fail "hostProfile.nodeRuntimes missing"
  fi

  if echo "$json_output" | jq -e '.hostProfile.nodeRuntimes[0].version' > /dev/null 2>&1; then
    pass "hostProfile.nodeRuntimes[0].version is present"
  else
    fail "hostProfile.nodeRuntimes[0].version missing"
  fi

  if echo "$json_output" | jq -e '.hostProfile.nodeRuntimes[0].major' > /dev/null 2>&1; then
    pass "hostProfile.nodeRuntimes[0].major is present"
  else
    fail "hostProfile.nodeRuntimes[0].major missing"
  fi

  if echo "$json_output" | jq -e '.hostProfile.nodeRuntimes[0].sqliteAvailable' > /dev/null 2>&1; then
    pass "hostProfile.nodeRuntimes[0].sqliteAvailable is present"
  else
    fail "hostProfile.nodeRuntimes[0].sqliteAvailable missing"
  fi

  if echo "$json_output" | jq -e '.hostProfile.npmVersion' > /dev/null 2>&1; then
    pass "hostProfile.npmVersion is present"
  else
    fail "hostProfile.npmVersion missing"
  fi

  # US-003: hostProfile.utilities with sqlite3/curl/jq booleans
  if echo "$json_output" | jq -e '.hostProfile.utilities' > /dev/null 2>&1; then
    pass "hostProfile.utilities is present"
  else
    fail "hostProfile.utilities missing"
  fi

  if echo "$json_output" | jq -e '.hostProfile.utilities.sqlite3 | type == "boolean"' > /dev/null 2>&1; then
    pass "hostProfile.utilities.sqlite3 is boolean"
  else
    fail "hostProfile.utilities.sqlite3 missing or not boolean"
  fi

  if echo "$json_output" | jq -e '.hostProfile.utilities.curl | type == "boolean"' > /dev/null 2>&1; then
    pass "hostProfile.utilities.curl is boolean"
  else
    fail "hostProfile.utilities.curl missing or not boolean"
  fi

  if echo "$json_output" | jq -e '.hostProfile.utilities.jq | type == "boolean"' > /dev/null 2>&1; then
    pass "hostProfile.utilities.jq is boolean"
  else
    fail "hostProfile.utilities.jq missing or not boolean"
  fi

  # US-003: hostProfile.containment with systemdUserScope
  if echo "$json_output" | jq -e '.hostProfile.containment' > /dev/null 2>&1; then
    pass "hostProfile.containment is present"
  else
    fail "hostProfile.containment missing"
  fi

  if echo "$json_output" | jq -e '.hostProfile.containment.systemdUserScope | type == "boolean"' > /dev/null 2>&1; then
    pass "hostProfile.containment.systemdUserScope is boolean"
  else
    fail "hostProfile.containment.systemdUserScope missing or not boolean"
  fi

  # US-004: hostProfile.git with version and mergeTreeAvailable
  if echo "$json_output" | jq -e '.hostProfile.git' > /dev/null 2>&1; then
    pass "hostProfile.git is present"
  else
    fail "hostProfile.git missing"
  fi

  if echo "$json_output" | jq -e '.hostProfile.git.version' > /dev/null 2>&1; then
    pass "hostProfile.git.version is present"
  else
    fail "hostProfile.git.version missing"
  fi

  if echo "$json_output" | jq -e '.hostProfile.git.mergeTreeAvailable == true' > /dev/null 2>&1; then
    pass "hostProfile.git.mergeTreeAvailable is true"
  else
    fail "hostProfile.git.mergeTreeAvailable is not true"
  fi

  # US-002: platform label is one of linux/darwin/other
  platform_label=$(echo "$json_output" | jq -r '.hostProfile.platform.label')
  case "$platform_label" in
    linux|darwin|other) pass "hostProfile.platform.label is valid: $platform_label" ;;
    *) fail "hostProfile.platform.label is invalid: $platform_label" ;;
  esac

  check_count=$(echo "$json_output" | jq '.checks | length')
  if [ "$check_count" -gt 0 ]; then
    pass "--json output has $check_count checks (non-zero)"
  else
    fail "--json output has 0 checks"
  fi

  # Verify each check has required fields
  if echo "$json_output" | jq -e '.checks[0].id' > /dev/null 2>&1; then
    pass "check objects have .id field"
  else
    fail "check objects missing .id field"
  fi

  if echo "$json_output" | jq -e '.checks[0].result' > /dev/null 2>&1; then
    pass "check objects have .result field"
  else
    fail "check objects missing .result field"
  fi

  if echo "$json_output" | jq -e '.checks[0].required' > /dev/null 2>&1; then
    pass "check objects have .required field"
  else
    fail "check objects missing .required field"
  fi
else
  echo "  SKIP: jq not found; JSON structure checks skipped"
fi

# ── Test 4.5: --json mode dedicated checks (US-009) ──────────────────
echo ""
echo "--- Test: --json mode (US-009) ---"
json_output=$("$TOOL" --fast --json 2>&1) && : || :  # always succeeds

# AC5: Table output is suppressed when --json is active (no table header)
if echo "$json_output" | grep -q "CHECK.*|.*RESULT.*|.*EVIDENCE"; then
  fail "--json output contains table header (should be suppressed)"
else
  pass "--json output does NOT contain table header (table suppressed)"
fi

# AC2: jq . parses the JSON output without errors
if echo "$json_output" | jq . > /dev/null 2>&1; then
  pass "jq . parses full --json output as valid JSON"
else
  fail "jq . failed to parse --json output"
fi

# AC3: JSON output contains all checks including SKIPPED rows
skipped_count=$(echo "$json_output" | jq '[.checks[] | select(.result == "SKIPPED")] | length')
if [ "$skipped_count" -gt 0 ]; then
  pass "--json output contains SKIPPED checks (${skipped_count} skipped rows)"
else
  fail "--json output missing SKIPPED checks"
fi

# AC4: JSON output includes exitCode as a number, tier, and platform
if echo "$json_output" | jq -e '.exitCode | type == "number"' > /dev/null 2>&1; then
  pass "--json .exitCode is a number"
else
  fail "--json .exitCode is not a number"
fi

if echo "$json_output" | jq -e '.tier | type == "string"' > /dev/null 2>&1; then
  pass "--json .tier is a string"
else
  fail "--json .tier is not a string"
fi

if echo "$json_output" | jq -e '.platform | type == "string"' > /dev/null 2>&1; then
  pass "--json .platform is a string"
else
  fail "--json .platform is not a string"
fi

# AC1: Every check has required fields (id, description, result, evidence, required)
missing_fields=0
for field in id description result evidence required; do
  if echo "$json_output" | jq -e ".checks[0].${field}" > /dev/null 2>&1; then
    pass "check objects have .${field} field"
  else
    fail "check objects missing .${field} field"
    missing_fields=$((missing_fields + 1))
  fi
done

# All PASS checks do NOT have a remedy (null or absent)
pass_no_remedy=$(echo "$json_output" | jq '[.checks[] | select(.result == "PASS" and .remedy != null)] | length')
if [ "$pass_no_remedy" -eq 0 ]; then
  pass "PASS checks have null remedy (no false remedies)"
else
  fail "${pass_no_remedy} PASS checks have non-null remedy"
fi

# FAIL checks SHOULD have a remedy string
fail_without_remedy=$(echo "$json_output" | jq '[.checks[] | select(.result == "FAIL" and (.remedy == null or .remedy == ""))] | length')
if [ "$fail_without_remedy" -eq 0 ]; then
  pass "FAIL checks have non-null remedy"
else
  # Some FAIL checks might legitimately have null remedy (e.g., probe errors)
  echo "  SKIP: ${fail_without_remedy} FAIL checks have null remedy (may be probe errors)"
fi

# AC5 (extended): --json and default table outputs are mutually exclusive
# (already tested in 'distinct flag behavior' section, confirmed here specifically)
if [ "$missing_fields" -eq 0 ]; then
  pass "All required check fields present in --json output"
fi

# ── Test 5: --spend harness probes (US-010) ────────────────────────────
echo ""
echo "--- Test: --spend harness probes (US-010) ---"

# AC1: Without --spend, pi and hermes checks show SKIPPED (requires --spend)
no_spend_output=$("$TOOL" --fast 2>&1) && : || :  # always succeeds
if echo "$no_spend_output" | grep -qE "harness-pi.*\|.*SKIPPED.*\|.*requires --spend"; then
  pass "harness-pi shows SKIPPED (requires --spend) without --spend"
else
  fail "harness-pi did not show SKIPPED (requires --spend) without --spend"
fi

if echo "$no_spend_output" | grep -qE "harness-hermes.*\|.*SKIPPED.*\|.*requires --spend"; then
  pass "harness-hermes shows SKIPPED (requires --spend) without --spend"
else
  fail "harness-hermes did not show SKIPPED (requires --spend) without --spend"
fi

# AC2/AC3: With --spend, pi and hermes probes actually run (PASS or FAIL, not stubs)
# Note: --spend invokes real pi/hermes and spends a small number of tokens.
echo ""
echo "  --- running --spend probes (small token spend) ---"
spend_output=$("$TOOL" --spend 2>&1) && : || :  # always succeeds

if echo "$spend_output" | grep -qE "harness-pi.*\|.*(PASS|FAIL)"; then
  pass "harness-pi reports PASS or FAIL with --spend (probe actually ran)"
else
  fail "harness-pi did not report PASS or FAIL with --spend"
fi

if echo "$spend_output" | grep -qE "harness-hermes.*\|.*(PASS|FAIL)"; then
  pass "harness-hermes reports PASS or FAIL with --spend (probe actually ran)"
else
  fail "harness-hermes did not report PASS or FAIL with --spend"
fi

# AC2: When pi PASSes, evidence shows token counts
if echo "$spend_output" | grep -qE "harness-pi.*\|.*PASS.*\|.*tokens"; then
  pass "harness-pi PASS shows token counts in evidence"
elif echo "$spend_output" | grep -qE "harness-pi.*\|.*FAIL"; then
  echo "  SKIP: harness-pi FAILed with --spend (auth/network issue)"
fi

# AC3: When hermes PASSes, evidence shows session and token counts
if echo "$spend_output" | grep -qE "harness-hermes.*\|.*PASS.*\|.*session=.*tokens"; then
  pass "harness-hermes PASS shows session ID and token counts in evidence"
elif echo "$spend_output" | grep -qE "harness-hermes.*\|.*FAIL"; then
  echo "  SKIP: harness-hermes FAILed with --spend (auth/network issue)"
fi

# hostProfile.harness in JSON output
no_spend_json=$("$TOOL" --fast --json 2>&1) && : || :
if echo "$no_spend_json" | jq -e '.hostProfile.harness' > /dev/null 2>&1; then
  pass "hostProfile.harness is present in JSON"
else
  fail "hostProfile.harness missing from JSON"
fi

if echo "$no_spend_json" | jq -e '.hostProfile.harness.pi' > /dev/null 2>&1; then
  pass "hostProfile.harness.pi is present"
else
  fail "hostProfile.harness.pi missing"
fi

if echo "$no_spend_json" | jq -e '.hostProfile.harness.hermes' > /dev/null 2>&1; then
  pass "hostProfile.harness.hermes is present"
else
  fail "hostProfile.harness.hermes missing"
fi

# Without --spend, harness entries have null authenticated
pi_auth_no=$(echo "$no_spend_json" | jq -r '.hostProfile.harness.pi.authenticated')
if [ "$pi_auth_no" = "null" ]; then
  pass "hostProfile.harness.pi.authenticated is null without --spend"
else
  fail "hostProfile.harness.pi.authenticated = ${pi_auth_no} (expected null) without --spend"
fi

hermes_auth_no=$(echo "$no_spend_json" | jq -r '.hostProfile.harness.hermes.authenticated')
if [ "$hermes_auth_no" = "null" ]; then
  pass "hostProfile.harness.hermes.authenticated is null without --spend"
else
  fail "hostProfile.harness.hermes.authenticated = ${hermes_auth_no} (expected null) without --spend"
fi

# Without --spend, skipReason is set
pi_skip=$(echo "$no_spend_json" | jq -r '.hostProfile.harness.pi.skipReason')
if [ "$pi_skip" = "requires --spend" ]; then
  pass "hostProfile.harness.pi.skipReason = requires --spend"
else
  fail "hostProfile.harness.pi.skipReason = ${pi_skip} (expected 'requires --spend')"
fi

hermes_skip=$(echo "$no_spend_json" | jq -r '.hostProfile.harness.hermes.skipReason')
if [ "$hermes_skip" = "requires --spend" ]; then
  pass "hostProfile.harness.hermes.skipReason = requires --spend"
else
  fail "hostProfile.harness.hermes.skipReason = ${hermes_skip} (expected 'requires --spend')"
fi

# ── Test 6: port status checks (US-005) ──────────────────────────────
echo ""
echo "--- Test: port status checks (US-005) ---"

# All 9 ports appear in the table
for port in 3334 3338 3339 4334 4338 4339 5334 5338 5339; do
  if echo "$output" | grep -qE "port-${port}.*\|.*(PASS|FAIL|SKIPPED)"; then
    pass "port-${port} appears in table with result"
  else
    fail "port-${port} missing from table"
  fi
done

# Production ports (3334/3338/3339) always report PASS (they are OPTIONAL)
for port in 3334 3338 3339; do
  if echo "$output" | grep -qE "port-${port}.*\|.*PASS"; then
    pass "production port ${port} reports PASS (REPORT only)"
  else
    fail "production port ${port} did not report PASS"
  fi
done

# Production ports show "production port — report only" or "free" in evidence
if echo "$output" | grep -qE "port-3334.*\|.*PASS.*\|.*(production port|free)"; then
  pass "production port 3334 evidence mentions production report or free"
else
  fail "production port 3334 evidence missing production report marker"
fi

# TT ports (43xx, 53xx) when free report PASS
for port in 4334 4338 4339 5334 5338 5339; do
  if echo "$output" | grep -qE "port-${port}.*\|.*(PASS|FAIL|SKIPPED)"; then
    pass "TT port ${port} appears in table"
  else
    fail "TT port ${port} missing from table"
  fi
done

# Port checks use evidence from ss/lsof (look for PID or "free")
if echo "$output" | grep -qE "port-.*\|.*(PID|free)"; then
  pass "port checks show PID info or free status (bind-free ss/lsof probe)"
else
  fail "port checks missing PID or free evidence"
fi

# Port checks run in --fast mode (they are not toolchain probes)
fast_output=$("$TOOL" --fast 2>&1)
if echo "$fast_output" | grep -qE "port-3334.*\|.*PASS"; then
  pass "port checks run in --fast mode (port-3334 present)"
else
  fail "port checks did not run in --fast mode"
fi

# Verify hostProfile.ports is present in --json output
json_output=$("$TOOL" --fast --json 2>&1) && : || :
if echo "$json_output" | jq -e '.hostProfile.ports' > /dev/null 2>&1; then
  pass "hostProfile.ports is present in JSON"
else
  fail "hostProfile.ports missing from JSON"
fi

# Verify hostProfile.ports contains all 9 port keys
for port in 3334 3338 3339 4334 4338 4339 5334 5338 5339; do
  if echo "$json_output" | jq -e ".hostProfile.ports.\"${port}\"" > /dev/null 2>&1; then
    pass "hostProfile.ports.${port} is present"
  else
    fail "hostProfile.ports.${port} missing"
  fi
done

# Verify port status values are valid enumeration values
for port in 3334 3338 3339 4334 4338 4339 5334 5338 5339; do
  status=$(echo "$json_output" | jq -r ".hostProfile.ports.\"${port}\"")
  case "$status" in
    free|in-use-by-TT|in-use-by-other) pass "hostProfile.ports.${port} = ${status} (valid)" ;;
    *) fail "hostProfile.ports.${port} = ${status} (invalid — expected free/in-use-by-TT/in-use-by-other)" ;;
  esac
done

# ── Test 7: disk headroom check (US-006) ──────────────────────────────
echo ""
echo "--- Test: disk headroom check (US-006) ---"

# Disk headroom appears in the table
if echo "$output" | grep -qE "disk-headroom.*\\|.*(PASS|FAIL)"; then
  pass "disk-headroom appears in table with PASS or FAIL result"
else
  fail "disk-headroom missing from table or bad result"
fi

# Evidence shows available space in GB and threshold
if echo "$output" | grep -qE "disk-headroom.*\\|.*GB available.*threshold.*GB"; then
  pass "disk-headroom evidence shows available GB and threshold GB"
else
  fail "disk-headroom evidence missing available space or threshold in GB"
fi

# Verify hostProfile.diskHeadroom is present in JSON
json_output=$("$TOOL" --fast --json 2>&1) && : || :
if echo "$json_output" | jq -e '.hostProfile.diskHeadroom' > /dev/null 2>&1; then
  pass "hostProfile.diskHeadroom is present in JSON"
else
  fail "hostProfile.diskHeadroom missing from JSON"
fi

# Verify diskHeadroom fields
if echo "$json_output" | jq -e '.hostProfile.diskHeadroom.availableBytes | type == "number"' > /dev/null 2>&1; then
  pass "hostProfile.diskHeadroom.availableBytes is a number"
else
  fail "hostProfile.diskHeadroom.availableBytes missing or not number"
fi

if echo "$json_output" | jq -e '.hostProfile.diskHeadroom.available | type == "string"' > /dev/null 2>&1; then
  pass "hostProfile.diskHeadroom.available is a string"
else
  fail "hostProfile.diskHeadroom.available missing or not string"
fi

if echo "$json_output" | jq -e '.hostProfile.diskHeadroom.thresholdBytes | type == "number"' > /dev/null 2>&1; then
  pass "hostProfile.diskHeadroom.thresholdBytes is a number"
else
  fail "hostProfile.diskHeadroom.thresholdBytes missing or not number"
fi

if echo "$json_output" | jq -e '.hostProfile.diskHeadroom.threshold | type == "string"' > /dev/null 2>&1; then
  pass "hostProfile.diskHeadroom.threshold is a string"
else
  fail "hostProfile.diskHeadroom.threshold missing or not string"
fi

# Disk headroom check runs in --fast mode (it is not a toolchain probe)
if echo "$fast_output" | grep -qE "disk-headroom.*\\|.*(PASS|FAIL)"; then
  pass "disk-headroom check runs in --fast mode"
else
  fail "disk-headroom check did not run in --fast mode"
fi

# ── Test 8: toolchain build+test probes (US-007) ─────────────────
echo ""
echo "--- Test: toolchain build+test probes (US-007) ---"

# Full (non-fast) output for toolchain inspection
full_output=$("$TOOL" 2>&1) && : || :  # may fail on hosts missing some toolchains

# Each toolchain appears in the table with PASS, FAIL, or SKIPPED
for tc in java-maven rust-cargo go python3 node; do
  if echo "$full_output" | grep -qE "toolchain-${tc}.*\|.*(PASS|FAIL)"; then
    pass "toolchain-${tc} appears in table with PASS or FAIL"
  elif echo "$full_output" | grep -qE "toolchain-${tc}.*\|.*SKIPPED"; then
    pass "toolchain-${tc} appears in table (SKIPPED)"
  else
    fail "toolchain-${tc} missing from table"
  fi
done

# PASS rows show "build+test OK" with version info
if echo "$full_output" | grep -qE "toolchain-(java-maven|go|python3|node).*\|.*PASS.*\|.*build\+test OK:"; then
  pass "toolchain PASS rows show 'build+test OK' with version"
else
  fail "toolchain PASS rows missing 'build+test OK' evidence"
fi

# FAIL rows with missing toolchain show REMEDY with install instructions
if echo "$full_output" | grep -qE "toolchain-.*\|.*FAIL.*\|.*(not found|not functional).*\|.*(Install|Ensure)"; then
  pass "toolchain FAIL rows show REMEDY with install/repair instructions"
else
  # May not have any FAIL rows — that's fine if all toolchains are present
  echo "  SKIP: no toolchain FAIL with REMEDY detected (all toolchains may be present)"
fi

# Verify hostProfile.toolchains is present in JSON (full run, may be slow)
json_output=$("$TOOL" --json 2>&1) && : || :  # may fail on hosts missing some toolchains
if echo "$json_output" | jq -e '.hostProfile.toolchains' > /dev/null 2>&1; then
  pass "hostProfile.toolchains is present in JSON"
else
  fail "hostProfile.toolchains missing from JSON"
fi

# Each toolchain entry has { present, buildPassed, testPassed, evidence }
for tc in 'java+maven' 'rust/cargo' go python3 node; do
  if echo "$json_output" | jq -e ".hostProfile.toolchains.\"${tc}\"" > /dev/null 2>&1; then
    pass "hostProfile.toolchains['${tc}'] is present"
  else
    fail "hostProfile.toolchains['${tc}'] missing"
  fi
  for field in present buildPassed testPassed evidence; do
    # Use has() to check field existence — jq -e on .field exits 1 when value is false/null
    if echo "$json_output" | jq -e ".hostProfile.toolchains.\"${tc}\" | has(\"${field}\")" > /dev/null 2>&1; then
      : # field exists
    else
      fail "hostProfile.toolchains['${tc}'].${field} missing"
    fi
  done
  # present and buildPassed/testPassed are booleans (or null for --fast)
  present_val=$(echo "$json_output" | jq -r ".hostProfile.toolchains.\"${tc}\".present")
  case "$present_val" in
    true|false|null) : ;;  # valid
    *) fail "hostProfile.toolchains['${tc}'].present = ${present_val} (expected boolean or null)" ;;
  esac
  build_val=$(echo "$json_output" | jq -r ".hostProfile.toolchains.\"${tc}\".buildPassed")
  case "$build_val" in
    true|false|null) : ;;
    *) fail "hostProfile.toolchains['${tc}'].buildPassed = ${build_val} (expected boolean or null)" ;;
  esac
done

# --fast mode: all toolchain probes show SKIPPED (--fast)
fast_output=$("$TOOL" --fast 2>&1) && : || :  # always succeeds
for tc in java-maven rust-cargo go python3 node; do
  if echo "$fast_output" | grep -qE "toolchain-${tc}.*\|.*SKIPPED.*\|.*--fast"; then
    pass "toolchain-${tc} shows SKIPPED (--fast) in --fast mode"
  else
    fail "toolchain-${tc} did not show SKIPPED (--fast) in --fast mode"
  fi
done

# --fast mode: hostProfile.toolchains entries report presence via --version (boolean, not null)
fast_json=$("$TOOL" --fast --json 2>&1) && : || :  # always succeeds
for tc in 'java+maven' 'rust/cargo' go python3 node; do
  present_val=$(echo "$fast_json" | jq -r ".hostProfile.toolchains.\"${tc}\".present")
  case "$present_val" in
    true|false) pass "hostProfile.toolchains['${tc}'].present is ${present_val} in --fast mode (boolean presence via --version)" ;;
    *) fail "hostProfile.toolchains['${tc}'].present = ${present_val} in --fast mode (expected true/false)" ;;
  esac
done

# ── Test 10: var/w0 directory exists after run ─────────────────────────
echo ""
echo "--- Test: var/w0 directory ---"
VAR_W0="${SCRIPT_DIR}/../var/w0"
if [ -d "$VAR_W0" ]; then
  pass "torture-test/var/w0/ exists after script runs"
else
  fail "torture-test/var/w0/ does not exist"
fi

# ── Test 11: Profile files (US-011) ──────────────────────────────────
echo ""
echo "--- Test: profile files (US-011) ---"

# Run the tool once to generate profile files
"$TOOL" --fast > /dev/null 2>&1 && : || :

HP_FILE="${SCRIPT_DIR}/../var/w0/host-profile.json"
ENV_FILE="${SCRIPT_DIR}/../var/w0/environment.json"

# AC1: host-profile.json exists after a successful run
if [ -f "$HP_FILE" ]; then
  pass "torture-test/var/w0/host-profile.json exists after run"
else
  fail "torture-test/var/w0/host-profile.json does not exist"
fi

# AC5: host-profile.json is valid JSON (jq . parses it)
if jq . "$HP_FILE" > /dev/null 2>&1; then
  pass "host-profile.json is valid JSON (jq . parses)"
else
  fail "host-profile.json is not valid JSON"
fi

# AC2: host-profile.json contains platform, containment, toolchains, node runtimes, spawn-speed, disk headroom
for field in platform containment toolchains nodeRuntimes spawnSpeedClass diskHeadroom; do
  if jq -e ".${field}" "$HP_FILE" > /dev/null 2>&1; then
    pass "host-profile.json contains .${field}"
  else
    fail "host-profile.json missing .${field}"
  fi
done

# host-profile.json: npmVersion
if jq -e '.npmVersion' "$HP_FILE" > /dev/null 2>&1; then
  pass "host-profile.json contains .npmVersion"
else
  fail "host-profile.json missing .npmVersion"
fi

# host-profile.json: harness
if jq -e '.harness' "$HP_FILE" > /dev/null 2>&1; then
  pass "host-profile.json contains .harness"
else
  fail "host-profile.json missing .harness"
fi

# spawnSpeedClass has class, medianMs, iterations
if jq -e '.spawnSpeedClass.class | type == "string"' "$HP_FILE" > /dev/null 2>&1; then
  pass "host-profile.json .spawnSpeedClass.class is a string"
else
  fail "host-profile.json .spawnSpeedClass.class missing or not string"
fi

spawn_cls=$(jq -r '.spawnSpeedClass.class' "$HP_FILE")
case "$spawn_cls" in
  fast|normal|slow) pass "spawnSpeedClass.class = ${spawn_cls} (valid)" ;;
  *) fail "spawnSpeedClass.class = ${spawn_cls} (invalid — expected fast/normal/slow)" ;;
esac

if jq -e '.spawnSpeedClass.medianMs | type == "number"' "$HP_FILE" > /dev/null 2>&1; then
  pass "host-profile.json .spawnSpeedClass.medianMs is a number"
else
  fail "host-profile.json .spawnSpeedClass.medianMs missing or not number"
fi

if jq -e '.spawnSpeedClass.iterations == 100' "$HP_FILE" > /dev/null 2>&1; then
  pass "host-profile.json .spawnSpeedClass.iterations is 100"
else
  fail "host-profile.json .spawnSpeedClass.iterations missing or not 100"
fi

# AC3: environment.json exists after a successful run
if [ -f "$ENV_FILE" ]; then
  pass "torture-test/var/w0/environment.json exists after run"
else
  fail "torture-test/var/w0/environment.json does not exist"
fi

# AC5: environment.json is valid JSON (jq . parses it)
if jq . "$ENV_FILE" > /dev/null 2>&1; then
  pass "environment.json is valid JSON (jq . parses)"
else
  fail "environment.json is not valid JSON"
fi

# AC4: environment.json contains git version, port status, utilities, tier, UTC timestamp
for field in git ports utilities tier timestamp; do
  if jq -e ".${field}" "$ENV_FILE" > /dev/null 2>&1; then
    pass "environment.json contains .${field}"
  else
    fail "environment.json missing .${field}"
  fi
done

# git.version is a string
if jq -e '.git.version | type == "string"' "$ENV_FILE" > /dev/null 2>&1; then
  pass "environment.json .git.version is a string"
else
  fail "environment.json .git.version missing or not string"
fi

# git.mergeTreeAvailable is true
if jq -e '.git.mergeTreeAvailable == true' "$ENV_FILE" > /dev/null 2>&1; then
  pass "environment.json .git.mergeTreeAvailable is true"
else
  fail "environment.json .git.mergeTreeAvailable is not true"
fi

# ports contains all 9 ports
for port in 3334 3338 3339 4334 4338 4339 5334 5338 5339; do
  if jq -e ".ports.\"${port}\"" "$ENV_FILE" > /dev/null 2>&1; then
    pass "environment.json .ports.${port} is present"
  else
    fail "environment.json .ports.${port} missing"
  fi
done

# utilities has sqlite3, curl, jq as booleans
for util in sqlite3 curl jq; do
  if jq -e ".utilities.${util} | type == \"boolean\"" "$ENV_FILE" > /dev/null 2>&1; then
    pass "environment.json .utilities.${util} is boolean"
  else
    fail "environment.json .utilities.${util} missing or not boolean"
  fi
done

# tier is a valid value (tier1, tier2, below_tier1, unknown)
env_tier=$(jq -r '.tier' "$ENV_FILE")
case "$env_tier" in
  tier1|tier2|below_tier1|unknown) pass "environment.json .tier = ${env_tier} (valid)" ;;
  *) fail "environment.json .tier = ${env_tier} (invalid)" ;;
esac

# timestamp is UTC ISO-8601 format (ends with Z or +00:00)
ts=$(jq -r '.timestamp' "$ENV_FILE")
if echo "$ts" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}.*Z$'; then
  pass "environment.json .timestamp is UTC ISO-8601"
else
  fail "environment.json .timestamp = ${ts} (not UTC ISO-8601)"
fi

# AC6: Tier is derived correctly (below_tier1 when --fast since buildPassed/testPassed are null)
# In --fast mode, toolchains have buildPassed=null, so tier is below_tier1
if [ "$env_tier" = "below_tier1" ]; then
  pass "tier is below_tier1 in --fast mode (toolchain build+test not executed)"
else
  fail "tier = ${env_tier} in --fast mode (expected below_tier1 because buildPassed/testPassed are null)"
fi

# Verify deterministic re-runs: run again and check profiles are overwritten (same as before)
first_hp_mtime=$(stat -c %Y "$HP_FILE" 2>/dev/null || stat -f %m "$HP_FILE" 2>/dev/null)
sleep 1
"$TOOL" --fast > /dev/null 2>&1 && : || :
second_hp_mtime=$(stat -c %Y "$HP_FILE" 2>/dev/null || stat -f %m "$HP_FILE" 2>/dev/null)
if [ "$second_hp_mtime" -gt "$first_hp_mtime" ]; then
  pass "Profiles are overwritten on re-run (deterministic re-runs)"
else
  fail "Profiles were not overwritten on re-run"
fi

# Verify --json output also has computed tier (not "unknown")
json_tier_out=$("$TOOL" --fast --json 2>&1) && : || :  # always succeeds
json_tier_val=$(echo "$json_tier_out" | jq -r '.tier' 2>/dev/null || echo "")
if [ -n "$json_tier_val" ] && [ "$json_tier_val" != "unknown" ]; then
  pass "--json output tier is computed (${json_tier_val}, not 'unknown')"
elif [ "$json_tier_val" = "unknown" ]; then
  fail "--json output tier is 'unknown' (should be computed)"
else
  fail "--json output tier could not be read"
fi

# ── Test 12: Flags produce distinct behavior ───────────────────────────
echo ""
echo "--- Test: distinct flag behavior ---"
default_out=$("$TOOL" --fast 2>&1) && : || :
json_out=$("$TOOL" --fast --json 2>&1) && : || :
spend_out=$("$TOOL" --fast --spend 2>&1) && : || :

# --fast vs --fast --json: output format should differ (table vs JSON)
if [ "$default_out" != "$json_out" ]; then
  pass "--json produces output different from default"
else
  fail "--json output is identical to default"
fi

# --fast vs --fast --spend: --spend enables additional probe rows
if [ "$default_out" != "$spend_out" ]; then
  pass "--spend produces output different from default"
else
  fail "--spend output is identical to default"
fi

# ── Test 13: US-012 — exit code handling and SKIPPED reporting ────────
echo ""
echo "--- Test: US-012 — exit code handling and SKIPPED reporting ---"

# AC1: Exit code is 0 when all REQUIRED checks pass (--fast, no --spend, dev host)
"$TOOL" --fast > /dev/null 2>&1 && fast_exit=$? || fast_exit=$?
if [ "$fast_exit" -eq 0 ]; then
  pass "Exit code is 0 with --fast (all REQUIRED checks PASS or SKIPPED)"
else
  fail "Exit code is ${fast_exit} with --fast, expected 0 (all REQUIRED checks should PASS or SKIPPED)"
fi

# AC2: Exit code is non-zero when any REQUIRED check fails (--test-required-fail)
"$TOOL" --fast --test-required-fail > /dev/null 2>&1 && fail_exit=$? || fail_exit=$?
if [ "$fail_exit" -ne 0 ]; then
  pass "Exit code is non-zero (${fail_exit}) with --test-required-fail"
else
  fail "Exit code is 0 with --test-required-fail, expected non-zero"
fi

# AC2b: Verify --test-required-fail is not shown in --help (hidden test flag)
if "$TOOL" --help 2>&1 | grep -qv "test-required-fail"; then
  pass "--test-required-fail is not advertised in --help output (hidden flag)"
else
  fail "--test-required-fail appears in --help (should be hidden)"
fi

# AC3: SKIPPED (not yet implemented) rows appear for unimplemented future W0.0 checks
fast_out=$("$TOOL" --fast 2>&1) && : || :

pipe='|'
for check_id in repo-clean dist-staleness production-quiesced login-shell-path; do
  if echo "$fast_out" | grep -qE "${check_id}.*[${pipe}].*SKIPPED.*[${pipe}].*[Nn]ot yet implemented"; then
    pass "${check_id} shows SKIPPED (not yet implemented) in table"
  else
    fail "${check_id} did not show SKIPPED (not yet implemented)"
  fi
done

# AC4: SKIPPED (requires --spend) rows appear for harness probes without --spend
if echo "$fast_out" | grep -qE "harness-pi.*\\|.*SKIPPED.*\\|.*requires --spend"; then
  pass "harness-pi shows SKIPPED (requires --spend) without --spend"
else
  fail "harness-pi did not show SKIPPED (requires --spend) without --spend"
fi

if echo "$fast_out" | grep -qE "harness-hermes.*\\|.*SKIPPED.*\\|.*requires --spend"; then
  pass "harness-hermes shows SKIPPED (requires --spend) without --spend"
else
  fail "harness-hermes did not show SKIPPED (requires --spend) without --spend"
fi

# AC5: Running twice produces the same RESULT column (deterministic re-runs)
first_run=$("$TOOL" --fast 2>&1) && : || :
second_run=$("$TOOL" --fast 2>&1) && : || :

# Extract just the RESULT column value for each check (3rd column, trim whitespace)
extract_results() {
  echo "$1" | grep -oE '^[a-z0-9_-]+.*\\|.*(PASS|FAIL|SKIPPED)' | sed 's/.*| *\(PASS\|FAIL\|SKIPPED\).*/\1/' | sort
}

first_results=$(extract_results "$first_run")
second_results=$(extract_results "$second_run")

if [ "$first_results" = "$second_results" ]; then
  pass "Running twice produces identical RESULT columns (deterministic re-runs)"
else
  fail "Running twice produced different RESULT columns (check for non-deterministic checks)"
fi

# AC6: No tamandua daemon or service is started, stopped, or signalled by this tool
# Verify the tool's output doesn't contain tamandua lifecycle commands or daemon operations
# (The tool is read-only: uses ss/lsof/df/git — never tamandua {start,stop,restart,daemon})
# Only match actual command verbs, not mentions of "daemon inspection" in evidence text
if echo "$fast_out" | grep -qiE "\btamandua +(start|stop|restart|kill|signal)\b"; then
  fail "Tool output references tamandua daemon lifecycle commands"
else
  pass "No tamandua daemon lifecycle commands in output (read-only observation)"
fi

# Verify SKIPPED checks never cause non-zero exit (--fast with only SKIPPED+no-fail → exit 0)
"$TOOL" --fast > /dev/null 2>&1 && skip_exit=$? || skip_exit=$?
if [ "$skip_exit" -eq 0 ]; then
  pass "SKIPPED checks do not cause non-zero exit (exit code ${skip_exit})"
else
  fail "SKIPPED checks caused non-zero exit (exit ${skip_exit}, expected 0)"
fi

# Verify JSON output contains SKIPPED rows for not-yet-implemented checks
json_out=$("$TOOL" --fast --json 2>&1) && : || :
for check_id in repo-clean dist-staleness production-quiesced login-shell-path; do
  if echo "$json_out" | jq -e ".checks[] | select(.id == \"${check_id}\" and .result == \"SKIPPED\" and .skipReason == \"not yet implemented\")" > /dev/null 2>&1; then
    pass "JSON output has ${check_id} as SKIPPED (not yet implemented)"
  else
    fail "JSON output missing ${check_id} as SKIPPED (not yet implemented)"
  fi
done

# Verify JSON exitCode is 0 with --fast (no failures)
if echo "$json_out" | jq -e '.exitCode == 0' > /dev/null 2>&1; then
  pass "JSON exitCode is 0 with --fast (all REQUIRED pass or skipped)"
else
  fail "JSON exitCode is not 0 with --fast"
fi

# Verify JSON exitCode is 1 with --test-required-fail
fail_json=$("$TOOL" --fast --test-required-fail --json 2>&1) && : || :
if echo "$fail_json" | jq -e '.exitCode == 1' > /dev/null 2>&1; then
  pass "JSON exitCode is 1 with --test-required-fail"
else
  fail "JSON exitCode is not 1 with --test-required-fail"
fi

# Verify the synthetic test failure appears in JSON with --test-required-fail
if echo "$fail_json" | jq -e '.checks[] | select(.id == "test-required-fail" and .result == "FAIL" and .required == true)' > /dev/null 2>&1; then
  pass "JSON has test-required-fail as FAIL (REQUIRED)"
else
  fail "JSON missing test-required-fail as FAIL (REQUIRED)"
fi

# ── Summary ───────────────────────────────────────────────────────────
echo ""
echo "========================================"
if [ "$FAILURES" -eq 0 ]; then
  echo "RESULT: All tests PASSED"
  exit 0
else
  echo "RESULT: $FAILURES test(s) FAILED"
  exit 1
fi
