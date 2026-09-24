#!/usr/bin/env bash
# run-o5-o6-native-writer.sh — focused committed-source O5/O6 gate + the REAL
# native-writer live leg (STORM-HYGIENE-CAPTURE).
#
# Runs, SERIALLY, one file at a time:
#   1. o5.test.mjs                — O5 calibration over generated sidecars + the
#                                   recorder capture hardening (strict port
#                                   preflight + lsof framing) + counterexample
#                                   propagation through the real O5 wrapper.
#   2. o6.test.mjs                — O6 calibration + the NEW-only fixture DB
#                                   writer admission tests.
#   3. native-writer-leg.test.mjs — the real native run/worktree writer live
#                                   leg (private HOME/STATE/DB/TMPDIR + owned
#                                   origin + non-dispatching stub) driven
#                                   through the actual O5/O6 wrappers.
# It never runs a native daemon, never prunes/removes anything and spends zero
# model tokens. Full logs + source hashes land under TT_GATE_LOG_DIR when set
# (else a fresh retained mktemp dir). The actual producer exits gate the run
# (set -euo pipefail).
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
NODE_BIN="${TT_NODE_BIN:-$(command -v node)}"
GATE_LOG_DIR="${TT_GATE_LOG_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/o5-o6-native-writer-gate.XXXXXX")}"
mkdir -p "$GATE_LOG_DIR"

sha256sum \
  "$SCRIPT_DIR/o5.test.mjs" \
  "$SCRIPT_DIR/o6.test.mjs" \
  "$SCRIPT_DIR/native-writer-leg.mjs" \
  "$SCRIPT_DIR/native-writer-leg.test.mjs" \
  "$SCRIPT_DIR/generate-o5-fixtures.mjs" \
  "$SCRIPT_DIR/generate-o6-fixtures.mjs" \
  "$SCRIPT_DIR/../lib/o5-capture.mjs" \
  "$SCRIPT_DIR/../lib/o6-capture.mjs" \
  "$SCRIPT_DIR/../lib/o5.mjs" \
  "$SCRIPT_DIR/../lib/o6.mjs" \
  "$SCRIPT_DIR/../lib/hygiene-sidecar.mjs" \
  "$SCRIPT_DIR/../lib/post-batch.mjs" \
  > "$GATE_LOG_DIR/source-hashes.txt"

"$NODE_BIN" --test --test-timeout=180000 "$SCRIPT_DIR/o5.test.mjs" 2>&1 | tee "$GATE_LOG_DIR/o5.tap.log"
"$NODE_BIN" --test --test-timeout=180000 "$SCRIPT_DIR/o6.test.mjs" 2>&1 | tee "$GATE_LOG_DIR/o6.tap.log"
"$NODE_BIN" --test --test-timeout=300000 "$SCRIPT_DIR/native-writer-leg.test.mjs" 2>&1 | tee "$GATE_LOG_DIR/native-writer-leg.tap.log"

printf 'O5/O6 calibration + native-writer live leg gate PASS (logs: %s)\n' "$GATE_LOG_DIR"
