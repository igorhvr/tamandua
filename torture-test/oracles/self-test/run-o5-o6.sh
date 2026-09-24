#!/usr/bin/env bash
# run-o5-o6.sh — focused O5/O6 post-batch hygiene calibration gate
# (STORM-HYGIENE).
#
# Runs the two calibration suites SERIALLY, one file at a time, with the real
# oracles/O5 and oracles/O6 executables and the real exported implementations.
# This is the designated focused gate for the O5/O6 calibration slice; it never
# runs a native daemon, never prunes/removes anything and spends zero model
# tokens. The EXTENDED gate adding the real native run/worktree writer live
# leg is run-o5-o6-native-writer.sh (o5 + o6 + native-writer-leg.test.mjs).
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
NODE_BIN="${TT_NODE_BIN:-$(command -v node)}"

"$NODE_BIN" --test --test-timeout=180000 "$SCRIPT_DIR/o5.test.mjs"
"$NODE_BIN" --test --test-timeout=180000 "$SCRIPT_DIR/o6.test.mjs"

printf 'O5/O6 post-batch hygiene calibration gate PASS\n'
