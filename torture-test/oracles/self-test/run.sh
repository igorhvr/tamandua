#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
TT_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd -P)
VAR_ROOT="$TT_ROOT/var"

if [ "${TT_SELF_TEST_SINGLE_ROUND:-0}" != "1" ]; then
  suite_started_ms=$(node -e 'process.stdout.write(String(Date.now()))')
  for round in 1 2; do
    round_started_ms=$(node -e 'process.stdout.write(String(Date.now()))')
    TT_SELF_TEST_SINGLE_ROUND=1 "$0"
    round_finished_ms=$(node -e 'process.stdout.write(String(Date.now()))')
    printf 'self-test round %s PASS (%sms)\n' "$round" "$((round_finished_ms - round_started_ms))"
  done
  suite_finished_ms=$(node -e 'process.stdout.write(String(Date.now()))')
  printf 'self-test repeatability PASS (2 rounds, %sms total)\n' "$((suite_finished_ms - suite_started_ms))"
  exit 0
fi

mkdir -p -- "$VAR_ROOT"
workspace=$(mktemp -d "$VAR_ROOT/oracle-self-test.XXXXXX")
cleanup() {
  case "$workspace" in
    "$VAR_ROOT"/oracle-self-test.*)
      if [ "${TT_SELF_TEST_KEEP_WORKSPACE:-0}" != "1" ]; then
        rm -rf -- "$workspace"
      fi
      ;;
    *)
      printf 'refusing to clean unexpected workspace: %s\n' "$workspace" >&2
      return 1
      ;;
  esac
}
trap cleanup EXIT INT TERM

node "$SCRIPT_DIR/generate-fixtures.mjs" "$workspace"
node "$SCRIPT_DIR/generate-o1-fixtures.mjs" "$workspace"
node "$SCRIPT_DIR/generate-o2-fixtures.mjs" "$workspace"
node "$SCRIPT_DIR/generate-o3z-fixtures.mjs" "$workspace"
node "$SCRIPT_DIR/generate-o8-fixtures.mjs" "$workspace"
node "$SCRIPT_DIR/generate-o9-fixtures.mjs" "$workspace"
node "$SCRIPT_DIR/generate-o10-fixtures.mjs" "$workspace"
node "$SCRIPT_DIR/generate-o11-fixtures.mjs" "$workspace"
node "$SCRIPT_DIR/../calibration/generate-fixtures.mjs" "$workspace"
node --test "$TT_ROOT/bin/o9-mechanical-harvest.integration.test.mjs"
node "$SCRIPT_DIR/harness.mjs" --oracle "$workspace/oracle-pass" --context "$workspace/evidence/pass/context.json" --expected PASS
node "$SCRIPT_DIR/harness.mjs" --oracle "$workspace/oracle-fail" --context "$workspace/evidence/fail/context.json" --expected FAIL

for fixture in "$workspace"/o1-*; do
  expected=$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).expected)' "$fixture/expectation.json")
  node "$SCRIPT_DIR/harness.mjs" --oracle "$SCRIPT_DIR/../O1" --context "$fixture/evidence/context.json" --expected "$expected"
done

for fixture in "$workspace"/o2-*; do
  expected=$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).expected)' "$fixture/expectation.json")
  if [ "$expected" = "ERROR" ]; then
    oracle_started_ms=$(node -e 'process.stdout.write(String(Date.now()))')
    response_file="$fixture/oracle-response.json"
    if "$SCRIPT_DIR/../O2" "$fixture/evidence/context.json" >"$response_file"; then
      oracle_status=0
    else
      oracle_status=$?
    fi
    if [ "$oracle_status" -ne 2 ]; then
      printf 'expected ERROR but O2 exited %s for %s\n' "$oracle_status" "$fixture" >&2
      exit 1
    fi
    node -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(value.result!=="ERROR") process.exit(1)' "$response_file"
    oracle_finished_ms=$(node -e 'process.stdout.write(String(Date.now()))')
    oracle_elapsed_ms=$((oracle_finished_ms - oracle_started_ms))
    if [ "$oracle_elapsed_ms" -ge 10000 ]; then
      printf 'O2 ERROR fixture exceeded standalone 10-second limit (%sms)\n' "$oracle_elapsed_ms" >&2
      exit 1
    fi
    printf 'expected ERROR accepted for O2 (%sms)\n' "$oracle_elapsed_ms"
  else
    node "$SCRIPT_DIR/harness.mjs" --oracle "$SCRIPT_DIR/../O2" --context "$fixture/evidence/context.json" --expected "$expected"
  fi
done

for fixture in "$workspace"/o3z-*; do
  expected=$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).expected)' "$fixture/expectation.json")
  node "$SCRIPT_DIR/harness.mjs" --oracle "$SCRIPT_DIR/../O3z" --context "$fixture/evidence/context.json" --expected "$expected"
done

for fixture in "$workspace"/o8-*; do
  expected=$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).expected)' "$fixture/expectation.json")
  node "$SCRIPT_DIR/harness.mjs" --oracle "$SCRIPT_DIR/../O8" --context "$fixture/evidence/context.json" --expected "$expected"
done

for fixture in "$workspace"/o9-*; do
  expected=$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).expected)' "$fixture/expectation.json")
  node "$SCRIPT_DIR/harness.mjs" --oracle "$SCRIPT_DIR/../O9" --context "$fixture/evidence/context.json" --expected "$expected"
done

for fixture in "$workspace"/o10-*; do
  expected=$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).expected)' "$fixture/expectation.json")
  node "$SCRIPT_DIR/harness.mjs" --oracle "$SCRIPT_DIR/../O10" --context "$fixture/evidence/context.json" --expected "$expected"
done

for fixture in "$workspace"/o11-*; do
  expected=$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).expected)' "$fixture/expectation.json")
  node "$SCRIPT_DIR/harness.mjs" --oracle "$SCRIPT_DIR/../O11" --context "$fixture/evidence/context.json" --expected "$expected"
done

node "$SCRIPT_DIR/../calibration/run.mjs" "$workspace"

if node "$SCRIPT_DIR/harness.mjs" --oracle "$workspace/oracle-false-positive" --context "$workspace/evidence/false-positive/context.json" --expected FAIL >/dev/null 2>&1; then
  printf 'self-test harness accepted a false positive\n' >&2
  exit 1
fi
printf 'false positive rejected\n'

if node "$SCRIPT_DIR/harness.mjs" --oracle "$workspace/oracle-missed-violation" --context "$workspace/evidence/missed-violation/context.json" --expected PASS >/dev/null 2>&1; then
  printf 'self-test harness missed a violation\n' >&2
  exit 1
fi
printf 'missed violation rejected\n'
printf 'O1 terminal-state mutations PASS\n'
printf 'O2 merge-truth mutations PASS\n'
printf 'O3z token-gate mutations PASS\n'
printf 'O8 boundary-audit mutations PASS\n'
printf 'O9 ledger-replay mutations PASS\n'
printf 'O10 FMIS decision-table mutations PASS\n'
printf 'O11 output-contract/token-attribution mutations PASS\n'
printf 'O2/O9/O11 hard-case calibration pack PASS\n'
printf 'self-test harness PASS\n'
