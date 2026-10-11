#!/usr/bin/env bash
# =============================================================================
# MTLK-INTERACTIVE-SUITE — the one-command acceptance entrypoint.
#
#   run-interactive-suite.sh \
#     --tier t1|t2|t3|t4 (repeatable) \
#     --mode candidate|installed \
#     [--expect-digest <sha256:...>] \
#     [--evidence-dir DIR]
#
# SLOW REAL-VM GATE — DO NOT RUN BY DEFAULT
#
# This is the suite's single documented entrypoint. It is deliberately NOT at
# the repository root (the existing root runners are untouched) and it is never
# part of `npm test`.
#
# What it does:
#   1. resolves the matchlock pair and the CANDIDATE/INSTALLED mode BEFORE any
#      PATH/HOME change (see lib/common.sh);
#   2. fails closed with exit 3 and `MTLK-CAPABILITY-UNAVAILABLE <reason>` when
#      a requested VM tier cannot run here (missing/unusable /dev/kvm, missing
#      matchlock pair, missing python3/mktemp/curl) — never a fabricated pass;
#   3. creates a FRESH evidence directory (a new `mktemp -d`, never a reused
#      one; `--evidence-dir` is refused if it already holds a receipt);
#   4. for VM tiers: gives matchlock a PRIVATE, seeded image store and private
#      HOME/TMPDIR/TAMANDUA_STATE_DIR/workdir (the operator's store and live
#      state are never written), then acquires the shared gate lock EXACTLY ONCE
#      around the VM execution THIS script launches directly;
#   5. runs `runner/run-cases.sh` for the requested VM tiers and
#      `t1-fixtures.sh` for the no-VM T1 tier;
#   6. after a requested real-VM tier, invokes the shared no-fake-green guard
#      (`scripts/observed-rounds-guard.mjs`, zero-round PASS = exit 92);
#   7. propagates the component exit codes (no masking). T1-only runs take no
#      lock and boot no VM.
#
# Tiers:
#   t1  fixtures + frozen PTY driver self-test — NO VM, NO model (safe anywhere)
#   t2  real-VM mechanics M0-M4 — NO model
#   t3  live-model TUI turns M5/M6 — env-gated; absent credentials => declared
#       NOTRUN, never a pass (token spend disclosed)
#   t4  scheduled M7 spot-run — opt-in and bounded
#
# Exit codes:
#   0   every requested component passed
#   2   usage / missing required runner input / bad evidence dir
#   3   MTLK-CAPABILITY-UNAVAILABLE (a requested VM tier cannot run here)
#   4   MTLK-IMAGE-STORE-FAIL (the private image store could not be seeded)
#   6   MTLK-GATE-LOCK-FAIL (the shared gate lock could not be acquired)
#   92  ZERO-ROUND REFUSAL (a requested real-VM tier produced no VM round)
#   N   the failing component's exit code
# =============================================================================
set -u

SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd)"
SUITE_DIR="$SELF_DIR"

# shellcheck source=lib/common.sh
. "$SUITE_DIR/lib/common.sh"
# shellcheck source=lib/lock.sh
. "$SUITE_DIR/lib/lock.sh"
# shellcheck source=lib/image-store.sh
. "$SUITE_DIR/lib/image-store.sh"
# shellcheck source=lib/manifest.sh
. "$SUITE_DIR/lib/manifest.sh"

# The sourced modules export their own "already sourced" guard so a second
# source in the SAME shell is a no-op. Composed child scripts are separate
# processes that must load the modules for themselves, so those guards must not
# leak into their environment; this layer's functions/bindings are already
# defined and stay intact.
unset MTLK_COMMON_SOURCED MTLK_MANIFEST_SOURCED MTLK_LOCK_SOURCED MTLK_IMAGE_STORE_SOURCED

# Component paths are configuration so the entrypoint can be exercised with
# controls; they default to the in-repo suite scripts.
RUN_CASES_SH="${MTLK_RUN_CASES_SH:-$SUITE_DIR/runner/run-cases.sh}"
T1_FIXTURES_SH="${MTLK_T1_FIXTURES_SH:-$SUITE_DIR/t1-fixtures.sh}"
ROUNDS_GUARD="${MTLK_OBSERVED_ROUNDS_GUARD:-$MTLK_REPO_ROOT/scripts/observed-rounds-guard.mjs}"

# The operator HOME is captured BEFORE any private HOME is installed: it seeds
# the private image store, the pi configuration directory and the default
# private run/evidence roots. `lib/common.sh` already binds the operator image
# cache from this same HOME while it was current.
MTLK_OPERATOR_HOME="${MTLK_OPERATOR_HOME:-$HOME}"
export MTLK_OPERATOR_HOME

usage() {
  cat >&2 <<'USAGE'
usage: run-interactive-suite.sh --tier t1|t2|t3|t4 (repeatable)
                                --mode candidate|installed
                                [--expect-digest <sha256:...>]
                                [--evidence-dir DIR]

  --tier          requested tier (repeatable). Unrequested tiers are recorded
                  UNEXECUTED and are never reported as passed.
  --mode          candidate (default) builds this worktree and execs its
                  dist/cli/cli.js; installed execs the `tamandua` on PATH and
                  never rebuilds it.
  --expect-digest expected image digest, a RUNNER INPUT read from the local
                  matchlock image store. Required for any VM tier (t2/t3/t4);
                  optional for a T1-only run.
  --evidence-dir  use DIR as the evidence dir. It must be fresh (no receipt from
                  a previous run); otherwise a new `mktemp -d` is created.
USAGE
}

TIERS=""
MODE_ARG=""
DIGEST_ARG=""
EV_ARG=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tier)
      shift
      [ "$#" -gt 0 ] || { usage; exit 2; }
      TIERS="$TIERS $1"
      shift
      ;;
    --tier=*)
      TIERS="$TIERS ${1#--tier=}"
      shift
      ;;
    --mode)
      shift
      [ "$#" -gt 0 ] || { usage; exit 2; }
      MODE_ARG="$1"
      shift
      ;;
    --mode=*)
      MODE_ARG="${1#--mode=}"
      shift
      ;;
    --expect-digest)
      shift
      [ "$#" -gt 0 ] || { usage; exit 2; }
      DIGEST_ARG="$1"
      shift
      ;;
    --expect-digest=*)
      DIGEST_ARG="${1#--expect-digest=}"
      shift
      ;;
    --evidence-dir)
      shift
      [ "$#" -gt 0 ] || { usage; exit 2; }
      EV_ARG="$1"
      shift
      ;;
    --evidence-dir=*)
      EV_ARG="${1#--evidence-dir=}"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf 'MTLK-ABORT unknown-argument %s\n' "$1" >&2
      usage
      exit 2
      ;;
  esac
done

[ -n "$TIERS" ] || { usage; exit 2; }

# Validate the requested tiers and split them into the no-VM T1 tier and the
# real-VM tiers this entrypoint composes.
T1_REQ=0
VM_TIERS=""
for _tier in $TIERS; do
  mtlk_manifest_tier_known "$_tier" || {
    printf 'MTLK-ABORT unknown-tier %s\n' "$_tier" >&2
    exit 2
  }
  case "$_tier" in
    t1) T1_REQ=1 ;;
    t2 | t3 | t4) VM_TIERS="$VM_TIERS $_tier" ;;
  esac
done
unset _tier

# -----------------------------------------------------------------------------
# Resolve the runtime and mode BEFORE any PATH/HOME change. A VM tier requires
# the runner input digest and a working host capability set; a T1-only run needs
# neither a hypervisor nor an image digest.
# -----------------------------------------------------------------------------
mtlk_resolve_runtime

if [ -n "$MODE_ARG" ]; then
  MTLK_MODE="$MODE_ARG"
  export MTLK_MODE
fi
case "${MTLK_MODE:-candidate}" in
  candidate | installed) : ;;
  *)
    printf 'MTLK-ABORT unknown-mode %s\n' "${MTLK_MODE:-}" >&2
    exit 2
    ;;
esac

if [ -n "$DIGEST_ARG" ]; then
  MTLK_EXPECT_DIGEST="$DIGEST_ARG"
  export MTLK_EXPECT_DIGEST
fi

# NEED_VM_EXEC is true only when a requested VM tier will actually execute a
# VM: t2/t4 always, t3 only when its credential gate is satisfied. A t3 request
# whose credentials are absent is a DECLARED NOTRUN at the tier level (never a
# pass), so it requires no hypervisor, no image store and no round evidence.
NEED_VM_EXEC=0
for _tier in $VM_TIERS; do
  case "$_tier" in
    t2 | t4) NEED_VM_EXEC=1 ;;
    t3)
      if mtlk_t3_ready; then NEED_VM_EXEC=1; fi
      ;;
  esac
done
unset _tier

if [ -n "$VM_TIERS" ]; then
  mtlk_require_digest
fi
mtlk_resolve_mode || exit $?
if [ "$NEED_VM_EXEC" = "1" ]; then
  mtlk_probe_capabilities || exit $?
  mtlk_export_backend
fi

# -----------------------------------------------------------------------------
# Fresh evidence directory. Never reuse a receipt from a previous run.
# -----------------------------------------------------------------------------
if [ -n "$EV_ARG" ]; then
  EV="$EV_ARG"
  if [ -e "$EV/manifest/requested.tsv" ] || [ -f "$EV/identity.txt" ]; then
    printf 'MTLK-ABORT evidence-dir-not-fresh %s\n' "$EV" >&2
    exit 2
  fi
  mkdir -p "$EV" || {
    printf 'MTLK-ABORT cannot-create-evidence %s\n' "$EV" >&2
    exit 2
  }
else
  # The default evidence dir must live OUTSIDE the guest's protected OS roots
  # (`/tmp` and `/var` are protected): the per-case harness workdir is a host
  # MOUNT SOURCE whose guest destination mirrors its host path, and tamandua
  # refuses a workdir under a protected guest root. A `mktemp -d` under the
  # operator HOME also keeps the private HOME short enough for the matchlock
  # vsock `sun_path` budget. Override the base with `MTLK_EVIDENCE_ROOT`.
  MTLK_EVIDENCE_ROOT="${MTLK_EVIDENCE_ROOT:-$MTLK_OPERATOR_HOME/.cache/tamandua-mtlk}"
  mkdir -p "$MTLK_EVIDENCE_ROOT" 2>/dev/null || true
  EV="$(mktemp -d "$MTLK_EVIDENCE_ROOT/mtlk.XXXXXX" 2>/dev/null ||
    mktemp -d -t mtlk-interactive.XXXXXX 2>/dev/null ||
    mktemp -d)" || {
    printf 'MTLK-ABORT mktemp-failed\n' >&2
    exit 2
  }
fi
EV="$(cd -- "$EV" && pwd)"
mkdir -p "$EV/matrix" || {
  printf 'MTLK-ABORT cannot-create-evidence %s\n' "$EV" >&2
  exit 2
}
printf 'interactive suite evidence dir: %s\n' "$EV"

# Always release a lock THIS layer acquired, on any exit path. Release is
# idempotent and only closes a descriptor this layer owns.
trap 'mtlk_gate_lock_release >/dev/null 2>&1 || true' EXIT

# -----------------------------------------------------------------------------
# Private per-run state for VM tiers. The operator image store is seeded into a
# private HOME (resolved before this switch) and the operator's store/live state
# is never written. The interactive commands also require a host pi
# configuration DIRECTORY (`$HOME/.pi/agent`) to mount read-write; the private
# HOME must carry a usable copy (the same binding the M7 runner applies when it
# isolates HOME), otherwise tamandua refuses to substitute an image default
# before it ever reaches matchlock.
# -----------------------------------------------------------------------------
mtlk_pi_agent_seed() {
  local private_home="$1" operator_home="$2"
  [ -n "$operator_home" ] || return 0
  if [ -d "$operator_home/.pi/agent" ]; then
    mkdir -p "$private_home/.pi" || return 1
    cp -a "$operator_home/.pi/agent" "$private_home/.pi/agent" || return 1
  else
    # No operator configuration: provide the directory tamandua requires so the
    # private HOME is usable. The model tiers stay credential-gated separately.
    mkdir -p "$private_home/.pi/agent" || return 1
  fi
  return 0
}

if [ -n "$VM_TIERS" ]; then
  mkdir -p "$EV/home" "$EV/tmp" "$EV/state" "$EV/work" || {
    printf 'MTLK-ABORT cannot-create-private-state %s\n' "$EV" >&2
    exit 2
  }
  # Capture the operator HOME BEFORE it is switched to the private one.
  MTLK_OPERATOR_HOME="${MTLK_OPERATOR_HOME:-$HOME}"
  export MTLK_OPERATOR_HOME
  export HOME="$EV/home"
  export TMPDIR="$EV/tmp"
  export TAMANDUA_STATE_DIR="$EV/state"
  export MTLK_WORKDIR="$EV/work"
  if [ "$NEED_VM_EXEC" = "1" ]; then
    mtlk_image_store_seed "$HOME" || exit $?
    mtlk_pi_agent_seed "$HOME" "$MTLK_OPERATOR_HOME" || {
      printf 'MTLK-ABORT pi-config-seed-failed %s\n' "$MTLK_OPERATOR_HOME/.pi/agent" >&2
      exit 2
    }
  fi
fi

mtlk_write_identity "$EV/identity.txt"

# -----------------------------------------------------------------------------
# Observed-rounds evidence (no-fake-green). The shared guard reads
# `<ev>/observed-rounds.json`; the case harness' own evidence is authoritative,
# so the entrypoint only derives it when the run did not already produce it.
# The count is derived from real observed/owned VM ids in the case summaries and
# the M7 ownership log — it is never fabricated.
# -----------------------------------------------------------------------------
mtlk_derive_observed_rounds() {
  local ev="$1"
  [ -f "$ev/observed-rounds.json" ] && return 0
  python3 - "$ev" <<'PY'
import glob
import json
import os
import re
import sys

ev = os.path.abspath(sys.argv[1])
ids = set()
vm_re = re.compile(r"^vm-[0-9a-f]{8}$")
# `vm-00000000` is matchlock's documented PLACEHOLDER id (it appears in the
# longest-socket-path pre-flight error), never a real VM. The frozen driver's
# vm-id scan can pick it out of that error text, so exclude the sentinel: a
# no-fake-green round must come from a real registry-backed id.
SENTINEL_IDS = frozenset({"vm-00000000"})


def add(seq):
    if not seq:
        return
    for value in seq:
        if isinstance(value, str) and vm_re.match(value) and value not in SENTINEL_IDS:
            ids.add(value)


for path in glob.glob(os.path.join(ev, "**", "case-summary.json"), recursive=True):
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        continue
    add(data.get("owned_new_vms"))
    add(data.get("vm_ids_seen"))

m7_log = os.path.join(ev, "M7", "m7.log")
if os.path.isfile(m7_log):
    try:
        text = open(m7_log, encoding="utf-8", errors="replace").read()
    except OSError:
        text = ""
    for match in re.finditer(r"owned=\[([^\]]*)\]", text):
        add(match.group(1).split())

with open(os.path.join(ev, "observed-rounds.json"), "w", encoding="utf-8") as fh:
    json.dump(
        {
            "gate": "interactive",
            "observed_rounds": len(ids),
            "observed_vm_ids": sorted(ids),
        },
        fh,
        indent=2,
        sort_keys=True,
    )
PY
}

# -----------------------------------------------------------------------------
# Execute the requested tiers. The VM tiers run under the shared lock, then the
# no-fake-green guard, then the no-VM T1 tier (which a composed VM run also
# exercises as its driver precondition).
# -----------------------------------------------------------------------------
T1_RC=0
VM_RC=0
GUARD_RC=0

if [ -n "$VM_TIERS" ]; then
  mtlk_gate_lock_acquire >>"$EV/lock.txt" 2>&1
  bash "$RUN_CASES_SH" "$EV" $VM_TIERS
  VM_RC=$?
  mtlk_gate_lock_release >/dev/null 2>&1 || true

  if [ "$NEED_VM_EXEC" = "1" ]; then
    mtlk_derive_observed_rounds "$EV"
    node "$ROUNDS_GUARD" --dir "$EV" --gate interactive >>"$EV/guard.log" 2>&1
    GUARD_RC=$?
  else
    printf 'MTLK-GUARD-SKIPPED no-VM-execution (declared NOTRUN tier)\n' >>"$EV/guard.log"
  fi
fi

if [ "$T1_REQ" = "1" ]; then
  bash "$T1_FIXTURES_SH" "$EV"
  T1_RC=$?
fi

if [ "$T1_RC" != 0 ]; then
  exit "$T1_RC"
fi
if [ "$GUARD_RC" = 92 ]; then
  printf 'ZERO-ROUND REFUSAL: no VM round observed (VM creation or probe failed before any round)\n' >&2
  exit 92
fi
if [ "$GUARD_RC" != 0 ]; then
  exit "$GUARD_RC"
fi
exit "$VM_RC"
