#!/usr/bin/env bash
set -euo pipefail
scenario_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Fail closed unless HOME is contained under torture-test/var (the shared
# scenario-containment guard; a direct invocation with the operator HOME
# must refuse instead of running against the real home).
source "$(cd "$scenario_dir/../.." && pwd)/lib/scenario-containment-guard.sh"
exec node "$scenario_dir/run-symlink-path-parity.mjs"
