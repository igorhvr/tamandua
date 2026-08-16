#!/usr/bin/env bash
set -euo pipefail
scenario_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$(cd "$scenario_dir/../.." && pwd)/lib/scenario-containment-guard.sh"
exec node "$scenario_dir/run-provider-error.mjs" "$scenario_dir"
