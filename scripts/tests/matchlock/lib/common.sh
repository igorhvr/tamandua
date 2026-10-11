#!/usr/bin/env bash
# =============================================================================
# MTLK-INTERACTIVE-SUITE — shared configuration, bindings and run identity.
#
# `lib/common.sh` is the ONE sourced configuration/identity module used by every
# script in the four-command interactive acceptance suite. It is a library: it
# deliberately does NOT build, boot, exec or delete anything on source. Callers
# invoke the functions below at the point where the contract says so.
#
# Contract (see scripts/tests/matchlock/README.md and US-003):
#
#   * Platform bindings are CONFIGURATION (env-overridable defaults), never
#     hardcoded assertions. The same case set must serve vaimetal (Linux/KVM)
#     and mac (macOS/VZ) and both matchlock backends.
#   * `MTLK_MATCHLOCK_RPC_BIN` and `MTLK_GUEST_INIT` are resolved by
#     `mtlk_resolve_runtime` BEFORE any PATH/HOME change.
#   * CANDIDATE mode builds this worktree and execs `<repo>/dist/cli/cli.js`;
#     INSTALLED mode execs the `tamandua` resolved from PATH and never rebuilds
#     or replaces what it verifies.
#   * The capability probe FAILS CLOSED (exit 3, exact line
#     `MTLK-CAPABILITY-UNAVAILABLE <reason>`) — a missing prerequisite is never
#     reported as success. A missing required digest refuses with the exact line
#     `MTLK-ABORT no-expected-digest`.
#   * The module never mutates the operator's live state, daemon, image store or
#     firewall. It only records bindings and refuses when it cannot proceed.
#
# Sourcing twice is a no-op (idempotent): the guard below returns before any
# assignment runs on the second source.
# =============================================================================

if [ "${MTLK_COMMON_SOURCED:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi
MTLK_COMMON_SOURCED=1

# -----------------------------------------------------------------------------
# Repo root and the suite directory.
#
# MTLK_REPO_ROOT is derived from this file's own location
# (`<repo>/scripts/tests/matchlock/lib/common.sh` -> `<repo>`) and may be
# overridden by the env (used by unit tests and relocated checkouts). Deriving
# from BASH_SOURCE keeps the suite relocatable.
# -----------------------------------------------------------------------------
_mtlk_common_self="${BASH_SOURCE[0]:-$0}"
_mtlk_common_dir="$(cd -- "$(dirname -- "$_mtlk_common_self")" && pwd)"

if [ -n "${MTLK_REPO_ROOT:-}" ]; then
  _mtlk_repo_candidate="$MTLK_REPO_ROOT"
else
  _mtlk_repo_candidate="$_mtlk_common_dir/../../../.."
fi
MTLK_REPO_ROOT="$(cd -- "$_mtlk_repo_candidate" && pwd)"
MTLK_SUITE_DIR="$MTLK_REPO_ROOT/scripts/tests/matchlock"
unset _mtlk_repo_candidate

# -----------------------------------------------------------------------------
# Platform bindings (all env-overridable).
#
#   MTLK_WORKDIR        host scratch/workdir passed to the harness; the
#                       entrypoint overrides it with a private per-run path.
#   MTLK_UID/MTLK_GID   guest-relevant host ids used by case bindings.
#   MTLK_ALLOW_PRIVATE  space-separated `host[:port]` spellings passed to
#                       --matchlock-allow-private; default is the shared model
#                       endpoint. Never hardcode a backend/endpoint in cases.
#   MTLK_MODEL_ENDPOINT the model-service endpoint for T3/T4 (token-spending
#                       tiers); defaults to the allow-private spelling.
#   MTLK_EXPECT_DIGEST  REQUIRED runner input: the expected image digest, read
#                       from the local matchlock image store (never a constant).
#   MTLK_BACKEND        empty = matchlock default; e.g. `qemu` is honored and
#                       exported as MATCHLOCK_BACKEND by mtlk_export_backend.
#   MTLK_GATE_LOCK      the shared host gate lock (vaimetal convention). It is
#                       acquired by lib/lock.sh, at one layer only.
#   MTLK_TIMEOUT_*      bounded waits. They are configuration; the per-case
#                       assertion patterns stay exact.
#   MTLK_T3_ENABLED     whether the live-model tier (T3) may run. With no
#                       credentials present T3 records NOT-RUN, never a pass.
# -----------------------------------------------------------------------------
MTLK_UID="${MTLK_UID:-$(id -u)}"
MTLK_GID="${MTLK_GID:-$(id -g)}"
MTLK_WORKDIR="${MTLK_WORKDIR:-$MTLK_SUITE_DIR/work}"
# MTLK_CWD is the process working directory the tamandua CLI is launched from
# (case["cwd"]). It is configuration: CANDIDATE runs from this checkout,
# INSTALLED runs from the installed checkout.
MTLK_CWD="${MTLK_CWD:-$MTLK_REPO_ROOT}"
MTLK_ALLOW_PRIVATE="${MTLK_ALLOW_PRIVATE:-ai.iasylum.net:8888}"
MTLK_MODEL_ENDPOINT="${MTLK_MODEL_ENDPOINT:-ai.iasylum.net:8888}"
# Bare host of the model endpoint, for DNS diagnostics in the egress probe
# (`getent ahosts` takes a host, not `host:port`). Configuration; derived from
# MTLK_MODEL_ENDPOINT unless overridden.
MTLK_MODEL_HOST="${MTLK_MODEL_HOST:-${MTLK_MODEL_ENDPOINT%:*}}"
MTLK_EXPECT_DIGEST="${MTLK_EXPECT_DIGEST:-}"
MTLK_BACKEND="${MTLK_BACKEND:-}"
MTLK_MODE="${MTLK_MODE:-candidate}"
MTLK_GATE_LOCK="${MTLK_GATE_LOCK:-/home/kaladin/matchlock-work/vaivm-gate.lock}"

# The operator matchlock image store (HOME-derived) that lib/image-store.sh
# seeds a private, fully usable per-run store from. `TAMANDUA_GATE_OPERATOR_CACHE`
# is the existing root-runner spelling and wins when set; the store location is
# configuration, never hardcoded in an assertion. Resolve it while the caller's
# real HOME is still current (before the entrypoint switches HOME).
MTLK_OPERATOR_CACHE="${MTLK_OPERATOR_CACHE:-${TAMANDUA_GATE_OPERATOR_CACHE:-$HOME/.cache/matchlock}}"

MTLK_TIMEOUT_BOOT="${MTLK_TIMEOUT_BOOT:-300}"
MTLK_TIMEOUT_CASE="${MTLK_TIMEOUT_CASE:-900}"
MTLK_TIMEOUT_T3="${MTLK_TIMEOUT_T3:-900}"
MTLK_TIMEOUT_T4="${MTLK_TIMEOUT_T4:-2400}"
MTLK_TIMEOUT_TOTAL="${MTLK_TIMEOUT_TOTAL:-3600}"

# T3 credentials come from the environment; the names are configurable so the
# suite is not coupled to one provider spelling. Absent credentials => the
# caller records T3 NOT-RUN (declared), never a fabricated pass.
MTLK_T3_ENABLED="${MTLK_T3_ENABLED:-0}"
MTLK_T3_CREDENTIAL_ENV="${MTLK_T3_CREDENTIAL_ENV:-MTLK_MODEL_API_KEY TAMANDUA_MODEL_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY}"

# Host capability knobs. `MTLK_REQUIRE_KVM=auto` requires a usable KVM device
# on Linux unless the selected backend is qemu (TCG); macOS/VZ never requires
# /dev/kvm. `MTLK_REQUIRE_GUEST_INIT` requires the matchlock guest-init pair.
MTLK_KVM_DEVICE="${MTLK_KVM_DEVICE:-/dev/kvm}"
MTLK_REQUIRE_KVM="${MTLK_REQUIRE_KVM:-auto}"
MTLK_REQUIRE_GUEST_INIT="${MTLK_REQUIRE_GUEST_INIT:-1}"

# Node is needed to exec the CANDIDATE artifact and the installed tamandua shim.
MTLK_NODE_BIN="${MTLK_NODE_BIN:-$(command -v node 2>/dev/null || true)}"

# Matchlock runtime pair, resolved lazily by mtlk_resolve_runtime. The
# TAMANDUA_MATCHLOCK_RPC_BIN / MATCHLOCK_GUEST_INIT spellings are the repo's
# existing runner overrides and are honored as fallbacks.
MTLK_MATCHLOCK_RPC_BIN="${MTLK_MATCHLOCK_RPC_BIN:-${TAMANDUA_MATCHLOCK_RPC_BIN:-}}"
MTLK_GUEST_INIT="${MTLK_GUEST_INIT:-${MATCHLOCK_GUEST_INIT:-}}"

# Resolved by mtlk_resolve_mode; empty until then.
MTLK_TAMANDUA_BIN="${MTLK_TAMANDUA_BIN:-}"
MTLK_TAMANDUA_SHA="${MTLK_TAMANDUA_SHA:-}"
MTLK_TAMANDUA_ARGV0="${MTLK_TAMANDUA_ARGV0:-}"
MTLK_BUILD_PROVENANCE="${MTLK_BUILD_PROVENANCE:-}"

# NOTE: MTLK_COMMON_SOURCED is deliberately NOT exported. The guard is only
# meant to make sourcing a no-op within the SAME shell; exporting it would make
# composed child scripts (which are separate processes and must load the module
# for themselves) skip the module entirely and miss every function it defines.
export MTLK_REPO_ROOT MTLK_SUITE_DIR
export MTLK_UID MTLK_GID MTLK_WORKDIR MTLK_CWD MTLK_ALLOW_PRIVATE MTLK_MODEL_ENDPOINT
export MTLK_MODEL_HOST
export MTLK_EXPECT_DIGEST MTLK_BACKEND MTLK_MODE MTLK_GATE_LOCK
export MTLK_OPERATOR_CACHE
export MTLK_TIMEOUT_BOOT MTLK_TIMEOUT_CASE MTLK_TIMEOUT_T3 MTLK_TIMEOUT_T4 MTLK_TIMEOUT_TOTAL
export MTLK_T3_ENABLED MTLK_T3_CREDENTIAL_ENV
export MTLK_KVM_DEVICE MTLK_REQUIRE_KVM MTLK_REQUIRE_GUEST_INIT
export MTLK_NODE_BIN MTLK_MATCHLOCK_RPC_BIN MTLK_GUEST_INIT

# -----------------------------------------------------------------------------
# Small portable helpers.
# -----------------------------------------------------------------------------

# mtlk_is_truthy <value> — 0 for 1/true/yes/on (case-insensitive otherwise literal).
mtlk_is_truthy() {
  case "${1:-}" in
    1 | true | TRUE | yes | YES | on | ON) return 0 ;;
    *) return 1 ;;
  esac
}

# mtlk_sha256 <file> — hex sha256 via sha256sum (GNU/Linux) or shasum (macOS).
mtlk_sha256() {
  local f="$1"
  if [ ! -f "$f" ]; then
    return 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$f" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$f" | awk '{print $1}'
  else
    return 1
  fi
}

# mtlk_matchlock_state_db — the matchlock VM REGISTRY path.
#
# The registry is the matchlock state DB under `$HOME/.matchlock`. It is a
# DIFFERENT file from the image store's `metadata.db`, and the historical
# scratch utility's under-the-image-cache registry spelling was a known defect
# that must never be copied. Evaluated at call time (not source time) so the
# path follows the private HOME the entrypoint installs, and env-overridable so
# fixture controls can point ownership correlation at a synthetic registry.
mtlk_matchlock_state_db() {
  printf '%s\n' "${MTLK_MATCHLOCK_STATE_DB:-$HOME/.matchlock/state.db}"
}

# mtlk_render_case <src> <dst> — render `{{MTLK_*}}` placeholders in a case JSON
# from the environment into <dst>.
#
# The case files are configuration-bound: host paths, uid/gid, allow-private
# spellings and the expected digest are placeholders, never literals. A
# placeholder that names an UNSET `MTLK_*` variable fails closed (exit 2,
# `MTLK-ABORT case-bindings-unresolved ...`) so an unbound case can never run
# with a stale/empty value; non-`MTLK_*` `{{...}}` text is left untouched.
# Values are JSON-escaped and the rendered document is reloaded as JSON.
mtlk_render_case() {
  local src="$1" dst="$2"
  if [ ! -f "$src" ]; then
    printf 'MTLK-ABORT case-missing %s\n' "$src"
    return 2
  fi
  python3 - "$src" "$dst" <<'PYR'
import json
import os
import re
import sys

src, dst = sys.argv[1], sys.argv[2]
with open(src, encoding="utf-8") as fh:
    raw = fh.read()

missing = []


def sub(match):
    name = match.group(1)
    value = os.environ.get(name)
    if value is None:
        missing.append(name)
        return match.group(0)
    return json.dumps(value)[1:-1]


rendered = re.sub(r"\{\{(MTLK_[A-Za-z0-9_]*)\}\}", sub, raw)
if missing:
    sys.stderr.write(
        "MTLK-ABORT case-bindings-unresolved %s\n" % ",".join(sorted(set(missing)))
    )
    sys.exit(2)
try:
    json.loads(rendered)
except ValueError as exc:
    sys.stderr.write("MTLK-ABORT case-bindings-invalid-json %s\n" % exc)
    sys.exit(2)

tmp = dst + ".tmp"
with open(tmp, "w", encoding="utf-8") as fh:
    fh.write(rendered if rendered.endswith("\n") else rendered + "\n")
os.replace(tmp, dst)
PYR
}

# mtlk_resolve_runtime — fill MTLK_MATCHLOCK_RPC_BIN / MTLK_GUEST_INIT.
# MUST be called BEFORE any PATH/HOME change so the operator's tools are found.
mtlk_resolve_runtime() {
  if [ -z "${MTLK_MATCHLOCK_RPC_BIN:-}" ]; then
    MTLK_MATCHLOCK_RPC_BIN="$(command -v matchlock 2>/dev/null || true)"
  fi

  if [ -z "${MTLK_GUEST_INIT:-}" ] && [ -n "${MTLK_MATCHLOCK_RPC_BIN:-}" ]; then
    local bin_dir
    bin_dir="$(cd -- "$(dirname -- "$MTLK_MATCHLOCK_RPC_BIN")" 2>/dev/null && pwd)"
    if [ -n "$bin_dir" ] && [ -x "$bin_dir/guest-init" ]; then
      MTLK_GUEST_INIT="$bin_dir/guest-init"
    fi
  fi
  if [ -z "${MTLK_GUEST_INIT:-}" ]; then
    MTLK_GUEST_INIT="$(command -v guest-init 2>/dev/null || true)"
  fi

  export MTLK_MATCHLOCK_RPC_BIN MTLK_GUEST_INIT
}

# mtlk_export_backend — propagate the configured backend to matchlock.
# Empty MTLK_BACKEND means "leave MATCHLOCK_BACKEND to matchlock's default".
mtlk_export_backend() {
  if [ -n "${MTLK_BACKEND:-}" ]; then
    export MATCHLOCK_BACKEND="$MTLK_BACKEND"
  fi
}

# -----------------------------------------------------------------------------
# Fail-closed refusals.
# -----------------------------------------------------------------------------

# mtlk_cap_fail <reason> — the exact capability-unavailable line + exit 3.
mtlk_cap_fail() {
  printf 'MTLK-CAPABILITY-UNAVAILABLE %s\n' "$1"
  exit 3
}

# mtlk_require_digest — refuse before any execution when the runner input is
# missing. The image digest is read from the local store by the caller.
mtlk_require_digest() {
  if [ -z "${MTLK_EXPECT_DIGEST:-}" ]; then
    printf 'MTLK-ABORT no-expected-digest\n'
    exit 2
  fi
}

# mtlk_kvm_required — backend/platform-aware KVM requirement (never hostname).
mtlk_kvm_required() {
  case "${MTLK_REQUIRE_KVM:-auto}" in
    1 | true | TRUE | yes | YES) return 0 ;;
    0 | false | FALSE | no | NO) return 1 ;;
    *)
      [ "$(uname -s)" = "Linux" ] || return 1
      case "${MTLK_BACKEND:-}" in
        qemu) return 1 ;;
        *) return 0 ;;
      esac
      ;;
  esac
}

# mtlk_probe_capabilities — fail closed (exit 3, exact line) when a required
# host prerequisite is missing or unusable. Never report success on a miss.
mtlk_probe_capabilities() {
  local tool device
  for tool in python3 mktemp curl; do
    command -v "$tool" >/dev/null 2>&1 || mtlk_cap_fail "missing-tool:$tool"
  done

  if mtlk_kvm_required; then
    device="${MTLK_KVM_DEVICE:-/dev/kvm}"
    [ -c "$device" ] || mtlk_cap_fail "kvm-device-missing:$device"
    # `usable` means the device can actually be opened read-write: a node whose
    # permissions allow it but whose sandbox blocks the open is NOT usable.
    if ! (exec 3<>"$device") 2>/dev/null; then
      mtlk_cap_fail "kvm-device-not-usable:$device"
    fi
  fi

  [ -n "${MTLK_MATCHLOCK_RPC_BIN:-}" ] ||
    mtlk_cap_fail "no-matchlock"
  [ -x "$MTLK_MATCHLOCK_RPC_BIN" ] ||
    mtlk_cap_fail "matchlock-not-executable:$MTLK_MATCHLOCK_RPC_BIN"

  if mtlk_is_truthy "${MTLK_REQUIRE_GUEST_INIT:-1}"; then
    [ -n "${MTLK_GUEST_INIT:-}" ] ||
      mtlk_cap_fail "no-guest-init"
    [ -x "$MTLK_GUEST_INIT" ] ||
      mtlk_cap_fail "guest-init-not-executable:$MTLK_GUEST_INIT"
  fi
  return 0
}

# -----------------------------------------------------------------------------
# Mode resolution.
# -----------------------------------------------------------------------------

# mtlk_build_candidate — build this worktree's dist. MTLK_SKIP_BUILD=1 skips the
# build (used by unit tests that only check path resolution).
mtlk_build_candidate() {
  if mtlk_is_truthy "${MTLK_SKIP_BUILD:-0}"; then
    return 0
  fi
  if ! (cd -- "$MTLK_REPO_ROOT" && npm run build); then
    printf 'MTLK-ABORT candidate-build-failed %s\n' "$MTLK_REPO_ROOT"
    return 2
  fi
  return 0
}

# mtlk_resolve_mode — resolve the executable this run qualifies and record its
# identity. CANDIDATE (default) builds the worktree and binds
# `<repo>/dist/cli/cli.js`; INSTALLED binds `tamandua` from PATH and performs no
# build and no replacement. Records MTLK_TAMANDUA_BIN / MTLK_TAMANDUA_SHA /
# MTLK_TAMANDUA_ARGV0 / MTLK_BUILD_PROVENANCE.
mtlk_resolve_mode() {
  case "${MTLK_MODE:-candidate}" in
    candidate)
      mtlk_build_candidate || return 2
      MTLK_TAMANDUA_BIN="$MTLK_REPO_ROOT/dist/cli/cli.js"
      if [ ! -f "$MTLK_TAMANDUA_BIN" ]; then
        printf 'MTLK-ABORT candidate-artifact-missing %s\n' "$MTLK_TAMANDUA_BIN"
        return 2
      fi
      MTLK_TAMANDUA_SHA="$(mtlk_sha256 "$MTLK_TAMANDUA_BIN")" || MTLK_TAMANDUA_SHA="unavailable"
      local head tree
      head="$(git -C "$MTLK_REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
      tree="$(git -C "$MTLK_REPO_ROOT" rev-parse 'HEAD^{tree}' 2>/dev/null || true)"
      [ -n "$head" ] || head="unknown"
      [ -n "$tree" ] || tree="unknown"
      # The case `argv[0]` is the executable the PTY driver execs directly
      # (`os.execvpe(argv[0], argv, ...)`), so CANDIDATE must bind the built
      # cli.js itself (it carries a `#!/usr/bin/env node` shebang and the build
      # marks it executable). Binding plain `node` as argv[0] would make the
      # driver run `node matchlock …` and fail with MODULE_NOT_FOUND.
      MTLK_TAMANDUA_ARGV0="$MTLK_TAMANDUA_BIN"
      MTLK_BUILD_PROVENANCE="mode=candidate repo=$MTLK_REPO_ROOT head=$head tree=$tree dist=$MTLK_TAMANDUA_BIN dist_sha256=$MTLK_TAMANDUA_SHA"
      ;;
    installed)
      MTLK_TAMANDUA_BIN="$(command -v tamandua 2>/dev/null || true)"
      if [ -z "$MTLK_TAMANDUA_BIN" ]; then
        printf 'MTLK-ABORT no-installed-tamandua\n'
        return 2
      fi
      MTLK_TAMANDUA_SHA="$(mtlk_sha256 "$MTLK_TAMANDUA_BIN")" || MTLK_TAMANDUA_SHA="unavailable"
      MTLK_TAMANDUA_ARGV0="tamandua"
      MTLK_BUILD_PROVENANCE="mode=installed path=$MTLK_TAMANDUA_BIN sha256=$MTLK_TAMANDUA_SHA no-build"
      ;;
    *)
      printf 'MTLK-ABORT unknown-mode %s\n' "${MTLK_MODE:-}"
      return 2
      ;;
  esac

  export MTLK_TAMANDUA_BIN MTLK_TAMANDUA_SHA MTLK_TAMANDUA_ARGV0 MTLK_BUILD_PROVENANCE
  return 0
}

# mtlk_run_tamandua <args...> — exec the resolved artifact. CANDIDATE runs it
# through node; INSTALLED runs the PATH-resolved binary directly.
mtlk_run_tamandua() {
  case "${MTLK_MODE:-candidate}" in
    candidate)
      "${MTLK_NODE_BIN:-node}" "$MTLK_TAMANDUA_BIN" "$@"
      ;;
    installed)
      "$MTLK_TAMANDUA_BIN" "$@"
      ;;
    *)
      printf 'MTLK-ABORT unknown-mode %s\n' "${MTLK_MODE:-}"
      return 2
      ;;
  esac
}

# -----------------------------------------------------------------------------
# T3 (live-model) gating.
# -----------------------------------------------------------------------------

# mtlk_t3_credentials_present — 0 when any configured credential env var is set.
mtlk_t3_credentials_present() {
  local name value
  for name in ${MTLK_T3_CREDENTIAL_ENV:-}; do
    value="${!name:-}"
    if [ -n "$value" ]; then
      return 0
    fi
  done
  return 1
}

# mtlk_t3_ready — T3 runs only when explicitly enabled AND credentials exist.
# Anything else is a declared NOT-RUN, never a pass.
mtlk_t3_ready() {
  mtlk_is_truthy "${MTLK_T3_ENABLED:-0}" || return 1
  mtlk_t3_credentials_present || return 1
  return 0
}

# mtlk_t3_notrun_reason — the declared, secret-free reason T3 cannot execute.
# Returns 0 and prints a stable reason token when T3 is not ready; returns 1
# (prints nothing) when T3 is ready. Never names a credential VALUE.
mtlk_t3_notrun_reason() {
  if ! mtlk_is_truthy "${MTLK_T3_ENABLED:-0}"; then
    printf 't3-disabled:MTLK_T3_ENABLED-not-set'
    return 0
  fi
  if ! mtlk_t3_credentials_present; then
    printf 't3-credentials-absent:%s' "${MTLK_T3_CREDENTIAL_ENV:-none}"
    return 0
  fi
  return 1
}

# mtlk_t3_gate <evdir> — decide whether the live-model tier (T3) may execute.
#
#   * ready   -> records the token-spend disclosure under <evdir>/T3/ and prints
#                `T3-READY endpoint=<endpoint>`, returning 0;
#   * not ready -> records the declared NOT-RUN reason under <evdir>/T3/ and
#                prints `T3-NOTRUN <reason>`, returning 1.
#
# Absent enablement or credentials is a declared NOT-RUN and can NEVER be turned
# into a pass. `evdir` is optional (omitting it only skips the evidence write).
mtlk_t3_gate() {
  local ev="${1:-}" reason
  if mtlk_t3_ready; then
    mtlk_t3_disclosure "$ev" >/dev/null
    printf 'T3-READY endpoint=%s\n' "${MTLK_MODEL_ENDPOINT:-}"
    return 0
  fi
  reason="$(mtlk_t3_notrun_reason)" || reason='t3-not-ready'
  if [ -n "$ev" ]; then
    mkdir -p "$ev/T3" 2>/dev/null || true
    printf 'verdict=NOTRUN\nreason=%s\n' "$reason" >"$ev/T3/t3-notrun.txt"
  fi
  printf 'T3-NOTRUN %s\n' "$reason"
  return 1
}

# mtlk_t3_disclosure_line — the explicit per-run token-spend disclosure that is
# recorded whenever T3 actually executes. It names the endpoint and the paying
# credential set but never a secret value.
mtlk_t3_disclosure_line() {
  printf 'TOKEN-SPEND-DISCLOSURE tier=t3 endpoint=%s cases=M5,M6 billed=operator-credentials\n' \
    "${MTLK_MODEL_ENDPOINT:-}"
}

# mtlk_t3_disclosure <evdir> — record the token-spend disclosure line. Called by
# the runner immediately before executing a live-model T3 case; also records it
# under <evdir>/T3/token-spend.txt when `evdir` is given.
mtlk_t3_disclosure() {
  local ev="${1:-}" line
  line="$(mtlk_t3_disclosure_line)"
  if [ -n "$ev" ]; then
    mkdir -p "$ev/T3" 2>/dev/null || true
    printf '%s\n' "$line" >"$ev/T3/token-spend.txt"
  fi
  printf '%s\n' "$line"
}

# -----------------------------------------------------------------------------
# Run identity.
# -----------------------------------------------------------------------------

# mtlk_identity_lines — the deterministic identity block every suite script can
# record as evidence. It never contains secrets.
mtlk_identity_lines() {
  printf 'mtlk_identity_version=1\n'
  printf 'mode=%s\n' "${MTLK_MODE:-}"
  printf 'repo_root=%s\n' "${MTLK_REPO_ROOT:-}"
  printf 'suite_dir=%s\n' "${MTLK_SUITE_DIR:-}"
  printf 'tamandua_bin=%s\n' "${MTLK_TAMANDUA_BIN:-}"
  printf 'tamandua_sha256=%s\n' "${MTLK_TAMANDUA_SHA:-}"
  printf 'build_provenance=%s\n' "${MTLK_BUILD_PROVENANCE:-}"
  printf 'matchlock_bin=%s\n' "${MTLK_MATCHLOCK_RPC_BIN:-}"
  printf 'guest_init=%s\n' "${MTLK_GUEST_INIT:-}"
  printf 'backend=%s\n' "${MTLK_BACKEND:-default}"
  printf 'expect_digest=%s\n' "${MTLK_EXPECT_DIGEST:-}"
  printf 'allow_private=%s\n' "${MTLK_ALLOW_PRIVATE:-}"
  printf 'model_endpoint=%s\n' "${MTLK_MODEL_ENDPOINT:-}"
  printf 'uid=%s gid=%s\n' "${MTLK_UID:-}" "${MTLK_GID:-}"
  printf 't3_enabled=%s\n' "${MTLK_T3_ENABLED:-0}"
  printf 'gate_lock=%s\n' "${MTLK_GATE_LOCK:-}"
}

# mtlk_write_identity <file> — write the identity block to an evidence file.
mtlk_write_identity() {
  mtlk_identity_lines >"$1"
}
