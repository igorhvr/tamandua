// runtime-switch-env.mjs — the daemon-cross-runtime-restart (W4.23)
// runtime-switch corridor helper (T2.2 US-004).
//
// daemon-control (torture-test/bin/daemon-control) reconstructs the
// contained launch PATH itself (contained_path_for_kind, S24/US-006):
// var/adapters-bin FIRST, the env-script PATH next, the caller PATH last
// with operator bin dirs reordered — and spawns via
// `env -i $(env_for_kind ...) PATH=<reconstructed>`. A caller-PATH prepend
// of a second node runtime's bin dir is therefore DROPPED and the daemon
// stays on the env script's node. The sanctioned way to land the daemon on
// a DIFFERENT node runtime is daemon-control's TT_DC_ENV_SCRIPTED
// env-script seam (the MACP7 US-001 test seam daemon-control.test.sh uses):
// point it at a CONTAINED env-script VARIANT that sources the bundled
// scripted env and pins TT_NODE_BIN / TT_NODE_BIN_DIR + the printed PATH to
// the target runtime; contained_path_for_kind then carries the target
// runtime's node dir in the env-script leg, ahead of every caller-PATH
// component, so the launcher's `exec node` lands on it.
//
// This module owns the variant's generation so the W4.23 scenario and the
// regression self-test exercise EXACTLY the same corridor (the self-test
// would drift from the scenario if it replicated the logic).
//
// Zero side effects outside the caller-provided invocationDir (the caller
// asserts it stays under torture-test/var); zero tokens; no daemon access.
import fs from "node:fs";
import path from "node:path";

/**
 * Write the contained runtime-B env-script variant under invocationDir and
 * return its absolute path.
 *
 * @param {object} opts
 * @param {string} opts.invocationDir  absolute dir (MUST stay under
 *   torture-test/var — the caller's containment contract)
 * @param {string} opts.repoRoot       absolute repo root
 * @param {string} opts.runtimeBBin    absolute path of runtime B's node binary
 * @returns {string} the variant's absolute path
 */
export function writeRuntimeBEnvScript({ invocationDir, repoRoot, runtimeBBin }) {
  const variantPath = path.join(invocationDir, "runtime-b-env-scripted.sh");
  const baseEnvScript = path.join(repoRoot, "torture-test", "env", "tt-env-scripted.sh");
  const runtimeBNodeDir = path.dirname(runtimeBBin);
  const variant = `#!/usr/bin/env bash
# W4.23 runtime-B env-script variant — generated at scenario time, CONTAINED
# under torture-test/var. Sources the bundled scripted env, then pins node
# to runtime B so a daemon-control scripted start under
# TT_DC_ENV_SCRIPTED=<this file> lands the daemon on runtime B's node (the
# daemon-control-sanctioned runtime switch; contained_path_for_kind honors
# the env-script PATH, dropping any caller-PATH prepend).
set -euo pipefail
BASE_ENV=${JSON.stringify(baseEnvScript)}
RUNTIME_B_BIN=${JSON.stringify(runtimeBBin)}
RUNTIME_B_DIR=${JSON.stringify(runtimeBNodeDir)}
if [ "\${1:-}" = "print" ]; then
  base_out="$(bash "$BASE_ENV" print)" || exit 1
  while IFS= read -r line; do
    case "$line" in
      TT_NODE_BIN=*) printf 'TT_NODE_BIN=%s\\n' "$RUNTIME_B_BIN" ;;
      TT_NODE_BIN_DIR=*) printf 'TT_NODE_BIN_DIR=%s\\n' "$RUNTIME_B_DIR" ;;
      PATH=*) printf 'PATH=%s:%s\\n' "$RUNTIME_B_DIR" "\${line#PATH=}" ;;
      *) printf '%s\\n' "$line" ;;
    esac
  done <<< "$base_out"
fi
`;
  fs.writeFileSync(variantPath, variant, { mode: 0o755 });
  return variantPath;
}
