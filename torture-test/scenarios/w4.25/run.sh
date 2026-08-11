#!/usr/bin/env bash
set -euo pipefail
scenario_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# FIX10 US-004: fail closed unless HOME is contained under torture-test/var
# (the harness sources env/tt-env-scripted.sh; a direct invocation with
# the operator HOME must refuse instead of running against the real home).
source "$(cd "$scenario_dir/.." && pwd)/lib/scenario-containment-guard.sh"
exec node "$scenario_dir/run-downgrade-reupgrade.mjs"
