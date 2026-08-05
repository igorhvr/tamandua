#!/usr/bin/env bash
set -euo pipefail
scenario_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$scenario_dir/../run-update-arm.mjs"
