#!/usr/bin/env node

// operator-home — portable REAL operator-home resolution for the W2
// scripted scenario cells (MACP4 US-004).
//
// getent is absent on Darwin, and inside a scenario child $HOME is the
// CONTAINED home (env/tt-env-scripted.sh sets HOME=TT_SCRIPTED_HOME), so a
// naive getent -> process.env.HOME fallback would hand daemon-control the
// contained home — its production-guard derivation (REAL_TAMANDUA_STATE)
// and the S24 operator-bin reorder would then silently misclassify the
// real ~/.tamandua. This resolver follows the tt-provision-home
// convention — the same getent -> dscl -> shell-tilde -> $HOME chain as
// daemon-control's resolve_operator_home() and the harness's ACCOUNT_HOME
// (each tool keeps its own copy; they are not sourced together):
//   1. getent passwd <uid>            (linux passwd db)
//   2. dscl . -read /Users/<user> NFSHomeDirectory
//                                     (macOS directory service — getent absent)
//   3. shell tilde expansion of the named user (`eval echo ~<user>`)
//                                     (works with no getent AND no dscl)
//   4. $HOME last resort
// Every step fails closed to the next. The probes shell out to bash so a
// PATH seam can shadow getent/dscl/id in hermetic tests (the same seam the
// bash chains use) — on Darwin the dscl step (or the tilde step when dscl
// is also absent) resolves the TRUE operator home, so the contained $HOME
// is never reached.
//
// Imported by scenarios/w2.21/run.mjs, w2.23a/run.mjs, w2.23b/run.mjs and
// w2.23c/run.mjs.
//
// Zero tokens; confined to torture-test/.

import { spawnSync } from "node:child_process";

// realAccountHome() — resolve the operator's REAL home directory via the
// portable getent -> dscl -> eval-echo -> $HOME chain.
export function realAccountHome() {
  // 1. getent passwd <uid> — the linux passwd db.
  const getentHome = homeProbe('getent passwd "$(id -u)" | cut -d: -f6');
  if (getentHome) return getentHome;

  // 2. dscl . -read /Users/<user> NFSHomeDirectory — macOS directory
  //    service (getent is absent on Darwin).
  const dsclHome = homeProbe(
    'dscl . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null | awk \'{print $2}\'',
  );
  if (dsclHome) return dsclHome;

  // 3. Shell tilde expansion of the named user — works with no getent AND
  //    no dscl (bash resolves ~<user> via the passwd database, ignoring a
  //    contained/wrong $HOME). An unknown user leaves the literal
  //    `~<user>`; only a real absolute home is accepted.
  const tildeHome = homeProbe('eval echo ~"$(id -un)"');
  if (tildeHome && !tildeHome.startsWith("~")) return tildeHome;

  // 4. $HOME last resort (on a normal Darwin this is unreachable — steps 2
  //    or 3 resolve the true operator home first).
  return process.env.HOME ?? "";
}

// homeProbe(command) — run a bash one-liner and return its trimmed stdout,
// or "" when the command fails (every step fails closed to the next).
function homeProbe(command) {
  const result = spawnSync("bash", ["-c", command], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.status !== 0) return "";
  return String(result.stdout ?? "").trim();
}
