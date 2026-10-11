#!/usr/bin/env bash
# =============================================================================
# MTLK-INTERACTIVE-SUITE — sequential, manifest-aware tier driver.
#
#   run-cases.sh <evidence-dir> [tier...]
#
# SLOW REAL-VM GATE — DO NOT RUN BY DEFAULT
#
# Ported from the ACCEPTED W2 toolset `tools/run-cases.sh` (v3). The proven
# sequential semantics are preserved; scope and configuration are rebound
# through `lib/common.sh` and `lib/manifest.sh`:
#
#   * The REQUESTED manifest is recorded BEFORE anything executes, then frozen.
#     A tier that was not requested stays `UNEXECUTED` (never `PASS`); a
#     requested required case that cannot run becomes `FAIL`, never a silent
#     skip, and the requested scope is never shrunk after a failure.
#   * The frozen PTY driver self-test (`runner/pty-selftest.sh`, tier t1) runs
#     BEFORE any VM case, as a driver precondition.
#   * Each requested case runs `runner/run-case.sh` and then
#     `runner/hygiene.sh`; component exit codes are captured DIRECTLY
#     (`RC=$?`), never masked behind a pipeline. The FIRST nonzero component
#     halts the run, records `matrix/HALTED`, and stops — later cases are not
#     silently skipped, the failure is left visible.
#   * The phase-done marker is written ONLY when every requested case passed.
#   * The shared gate lock (`lib/lock.sh`) is acquired ONCE around the VM cases
#     THIS script launches directly. The T4 M7 spot-run acquires the lock at its
#     own layer, so it is released before M7 is invoked (single layer, never
#     nested). When an outer caller already holds it, acquisition is a SKIP.
#
# Tiers:
#   t1  frozen PTY driver self-test (no VM, no model)
#   t2  M0–M4 real-VM mechanics (no model)
#   t3  M5/M6 live-model TUI turns (env-gated; absent credentials => declared
#       NOTRUN, never PASS)
#   t4  M7 scheduled spot-run (acquires the gate lock itself)
#
# The tier -> case set is configuration (`MTLK_TIER_T2_CASES`,
# `MTLK_TIER_T3_CASES`); the runner reads the cases back from the frozen
# manifest rather than from argv.
# =============================================================================
set -u

SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd)"
SUITE_DIR="$(cd -- "$SELF_DIR/.." && pwd)"
# shellcheck source=../lib/common.sh
. "$SUITE_DIR/lib/common.sh"
# shellcheck source=../lib/manifest.sh
. "$SUITE_DIR/lib/manifest.sh"
# shellcheck source=../lib/lock.sh
. "$SUITE_DIR/lib/lock.sh"

EV="${1:-}"
if [ -z "$EV" ]; then
  printf 'usage: run-cases.sh <evidence-dir> [tier...]\n' >&2
  exit 2
fi
shift || true
REQUESTED_TIERS="$*"
if [ -z "$REQUESTED_TIERS" ]; then
  REQUESTED_TIERS="${MTLK_TIERS:-}"
fi
if [ -z "$REQUESTED_TIERS" ]; then
  printf 'MTLK-ABORT no-requested-tier\n' >&2
  exit 2
fi

mkdir -p "$EV" || {
  printf 'MTLK-ABORT cannot-create-evidence %s\n' "$EV" >&2
  exit 2
}
EV="$(cd -- "$EV" && pwd)"
MTX="$EV/matrix"
mkdir -p "$MTX" || {
  printf 'MTLK-ABORT cannot-create-matrix %s\n' "$MTX" >&2
  exit 2
}
LOG="$MTX/run-cases.log"
: >"$LOG"

# Component paths are configuration (a relocated checkout or a control can
# rebind them), defaulting to the in-repo suite scripts.
RUN_CASE="${MTLK_RUN_CASE_SH:-$SUITE_DIR/runner/run-case.sh}"
HYGIENE="${MTLK_HYGIENE_SH:-$SUITE_DIR/runner/hygiene.sh}"
SELFTEST="${MTLK_PTY_SELFTEST:-$SUITE_DIR/runner/pty-selftest.sh}"
M7_RUNNER="${MTLK_M7_RUNNER:-$SUITE_DIR/runner/m7-spot-run.sh}"
CASES_DIR="${MTLK_CASES_DIR:-$SUITE_DIR/cases}"

# The resolved matchlock binary (filled by mtlk_prepare). CANDIDATE/INSTALLED
# mode resolution and the runtime pair are owned by lib/common.sh.
ML=""

# Always release the lock on any exit path; release is idempotent and only
# closes a descriptor this layer actually owns.
trap 'mtlk_gate_lock_release >/dev/null 2>&1 || true' EXIT

# mtlk_log <line> — echo a line and append it to the matrix log.
mtlk_log() {
  printf '%s\n' "$1"
  printf '%s\n' "$1" >>"$LOG"
}

# mtlk_tier_requested <tier> — 0 when the tier is in the requested scope.
mtlk_tier_requested() {
  case " $REQUESTED_TIERS " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

# mtlk_tier_required <tier> — the manifest's required flag for a tier.
mtlk_tier_required() { mtlk_manifest_tier_required "$1"; }

# mtlk_vm_tier <tier> — 0 when the tier boots a real VM.
mtlk_vm_tier() {
  case "$1" in
    t2 | t3 | t4) return 0 ;;
    *) return 1 ;;
  esac
}

# mtlk_any_vm_tier_requested — 0 when any requested tier boots a VM.
mtlk_any_vm_tier_requested() {
  local tier
  for tier in $REQUESTED_TIERS; do
    mtlk_vm_tier "$tier" && return 0
  done
  return 1
}

# mtlk_any_run_case_tier_requested — 0 when a tier THIS script runs directly
# (run-case.sh + hygiene.sh under the gate lock) is requested. t4 is excluded:
# the M7 spot-run acquires the lock at its own layer.
mtlk_any_run_case_tier_requested() {
  local tier
  for tier in $REQUESTED_TIERS; do
    case "$tier" in
      t2 | t3) return 0 ;;
    esac
  done
  return 1
}

# mtlk_tier_cases <tier> — the run-case JSON ids a tier knows. t1 (driver
# self-test) and t4 (M7 spot-run) are whole-tier steps, so they contribute no
# run-case JSON set; t1 still records a `T1` case row so its tier is backed by
# evidence (the validator refuses an empty PASS tier).
mtlk_tier_cases() {
  case "$1" in
    t1) printf '%s' "${MTLK_TIER_T1_CASES:-T1}" ;;
    t2) printf '%s' "${MTLK_TIER_T2_CASES:-M0 M1 M2 M3 M4}" ;;
    t3) printf '%s' "${MTLK_TIER_T3_CASES:-M5 M6}" ;;
    *) printf '' ;;
  esac
}

# -----------------------------------------------------------------------------
# mtlk_prepare — resolve the runtime and mode BEFORE any PATH/HOME change, and
# fail closed on a missing runner input. VM capabilities are probed only when a
# VM tier is actually requested, so a t1-only run needs no hypervisor.
# -----------------------------------------------------------------------------
mtlk_prepare() {
  mtlk_resolve_runtime
  mtlk_require_digest
  if [ -z "${MTLK_TAMANDUA_BIN:-}" ]; then
    mtlk_resolve_mode || return 2
  fi
  if mtlk_any_vm_tier_requested; then
    mtlk_probe_capabilities || return 3
  fi
  ML="${MTLK_MATCHLOCK_RPC_BIN:-matchlock}"
  export MTLK_MATCHLOCK_BIN="$ML"
  return 0
}

# mtlk_record_requested_manifest <evdir> — the FIRST action of a run. Records
# every known tier (unrequested => UNEXECUTED), requests exactly the passed
# tiers, records their cases, then freezes the scope.
mtlk_record_requested_manifest() {
  local ev="$1" tier name req evidence
  mtlk_manifest_init "$ev" || return 2
  for tier in $REQUESTED_TIERS; do
    mtlk_manifest_tier_known "$tier" || {
      mtlk_manifest_abort "unknown-tier:$tier"
      return 2
    }
    mtlk_manifest_request_tier "$ev" "$tier" || return 2
    req="$(mtlk_tier_required "$tier")"
    # A requested OPTIONAL live-model tier with no credentials is declared
    # NOTRUN at the TIER level: its cases are deliberately not requested (a
    # requested case that never runs must fail, and stubbing a pass is
    # forbidden). A REQUIRED t3 still records its cases so the missing run
    # fails visibly.
    if [ "$tier" = "t3" ] && ! mtlk_t3_ready && [ "$req" != "1" ]; then
      continue
    fi
    for name in $(mtlk_tier_cases "$tier"); do
      if [ "$tier" = "t1" ]; then
        evidence="T1"
      else
        evidence="$tier/$name"
      fi
      mtlk_manifest_add_case "$ev" "$tier" "$name" "$req" "$evidence" || return 2
    done
  done
  mtlk_manifest_freeze "$ev" || return 2
  return 0
}

# mtlk_write_t1_summary <evdir> <verdict> — record the driver self-test as the
# t1 case's evidence (verdict from the selftest exit code, never a marker word).
mtlk_write_t1_summary() {
  local ev="$1" verdict="$2" reasons="$3"
  mkdir -p "$ev/T1" || return 2
  printf '{"case":"T1","verdict":"%s","fail_reasons":%s,"unowned_new_vms":[]}\n' \
    "$verdict" "$reasons" >"$ev/T1/case-summary.json"
  return 0
}

# mtlk_halt <name> <rc> <hygiene-rc> — the first-failure stop: record the
# offending case and halt (later requested cases are left visibly unexecuted).
mtlk_halt() {
  local name="$1" crc="$2" hrc="$3"
  printf '%s\n' "$name" >"$MTX/HALTED"
  mtlk_log "MATRIX-HALT $name rc=$crc hy=$hrc"
  return 1
}

# mtlk_run_pty_selftest <evdir> — run the frozen driver self-test FIRST.
mtlk_run_pty_selftest() {
  local ev="$1" rc
  mtlk_log "== pty-selftest =="
  mkdir -p "$ev/T1" || return 2
  if [ ! -f "$SELFTEST" ]; then
    mtlk_write_t1_summary "$ev" FAIL '["pty-selftest-missing"]'
    mtlk_log "PTY-SELFTEST rc=92"
    return 92
  fi
  bash "$SELFTEST" >"$ev/T1/pty-selftest.log" 2>&1
  rc=$?
  mtlk_log "PTY-SELFTEST rc=$rc"
  tail -n 2 "$ev/T1/pty-selftest.log" 2>/dev/null || true
  if [ "$rc" = 0 ]; then
    mtlk_write_t1_summary "$ev" PASS '[]'
  else
    mtlk_write_t1_summary "$ev" FAIL '["pty-selftest-rc"]'
  fi
  return "$rc"
}

# mtlk_run_one_case <tier> <name> <evidence> — one run-case.sh + hygiene.sh
# pair. Component exit codes propagate; the first nonzero halts.
mtlk_run_one_case() {
  local tier="$1" name="$2" evidence="$3"
  local casejson="$CASES_DIR/$name.json"
  local out="$EV/$evidence"
  local rlog="$MTX/$tier-$name.runner.log"
  local hlog="$MTX/$tier-$name.hygiene.log"
  local rc hy

  mkdir -p "$out" || return 1
  if [ ! -f "$casejson" ]; then
    mtlk_log "MATRIX-CASE-MISSING $tier/$name"
    mtlk_manifest_mark "$EV" "$tier" "$name" FAIL >/dev/null 2>&1 || true
    mtlk_halt "$name" 92 0
    return 1
  fi

  mtlk_log "MATRIX-CASE-START $tier/$name $(date -u +%FT%TZ)"
  bash "$RUN_CASE" "$casejson" "$out" "$ML" >"$rlog" 2>&1
  rc=$?
  mtlk_log "MATRIX-CASE-RC $tier/$name rc=$rc"

  bash "$HYGIENE" "$out/case-summary.json" "$ML" >"$hlog" 2>&1
  hy=$?
  mtlk_log "MATRIX-CASE-HYGIENE $tier/$name rc=$hy"

  if [ "$rc" != 0 ] || [ "$hy" != 0 ]; then
    mtlk_manifest_mark "$EV" "$tier" "$name" FAIL >/dev/null 2>&1 || true
    mtlk_halt "$name" "$rc" "$hy"
    return 1
  fi
  mtlk_manifest_mark "$EV" "$tier" "$name" PASS >/dev/null 2>&1 || true
  return 0
}

# mtlk_run_manifest_tier <tier> — execute every REQUESTED case of a run-case
# tier, read back from the frozen manifest (not from argv), halting on the
# first failure.
mtlk_run_manifest_tier() {
  local tier="$1" name evidence

  if [ "$tier" = "t3" ]; then
    if ! mtlk_t3_gate "$EV"; then
      if [ "$(mtlk_tier_required t3)" = "1" ]; then
        mtlk_manifest_mark "$EV" t3 - FAIL >/dev/null 2>&1 || true
        mtlk_log "MATRIX-TIER-FAIL t3 required-but-not-ready"
        return 1
      fi
      mtlk_manifest_mark "$EV" t3 - NOTRUN >/dev/null 2>&1 || true
      return 0
    fi
  fi

  while IFS=$'\t' read -r name evidence; do
    [ -n "$name" ] || continue
    mtlk_run_one_case "$tier" "$name" "$evidence" || return 1
  done <<EOF
$(awk -F'\t' -v t="$tier" 'NR > 1 && $1 == "case" && $2 == t && $4 == "1" { print $3 "\t" $6 }' "$(mtlk_manifest_file "$EV")")
EOF

  mtlk_manifest_mark "$EV" "$tier" - PASS >/dev/null 2>&1 || true
  return 0
}

# mtlk_run_m7 <evdir> — the t4 whole-tier step. m7-spot-run.sh acquires the
# shared gate lock at its own layer, so this caller never wraps it.
#
# The optional M7 repo argument is passed ONLY in CANDIDATE mode: its presence
# makes the M7 runner require the resolved tamandua realpath to live under that
# repo. In INSTALLED mode the qualified binary is the one on PATH, which is not
# under the worktree, so passing the repo would abort with `tamandua-resolve`
# before the spot-run ever starts.
mtlk_run_m7() {
  local rc
  mtlk_log "== M7 spot-run =="
  if [ "${MTLK_MODE:-candidate}" = "candidate" ]; then
    bash "$M7_RUNNER" "$EV" "${MTLK_M7_REPO:-$MTLK_REPO_ROOT}" >"$MTX/m7-spot-run.log" 2>&1
  else
    bash "$M7_RUNNER" "$EV" >"$MTX/m7-spot-run.log" 2>&1
  fi
  rc=$?
  mtlk_log "MATRIX-M7-RC rc=$rc"
  if [ "$rc" != 0 ]; then
    mtlk_manifest_mark "$EV" t4 - FAIL >/dev/null 2>&1 || true
    return 1
  fi
  mtlk_manifest_mark "$EV" t4 - PASS >/dev/null 2>&1 || true
  return 0
}

# mtlk_run_requested_tiers — the ordered execution:
#   (1) driver self-test before any VM case;
#   (2) t2/t3 cases under the lock this layer directly acquires;
#   (3) t4 M7, which acquires the lock at its own layer.
mtlk_run_requested_tiers() {
  local tier rc

  mtlk_run_pty_selftest "$EV"
  rc=$?
  if [ "$rc" != 0 ]; then
    if mtlk_tier_requested t1; then
      mtlk_manifest_mark "$EV" t1 - FAIL >/dev/null 2>&1 || true
      mtlk_manifest_mark "$EV" t1 T1 FAIL >/dev/null 2>&1 || true
    fi
    mtlk_halt "pty-selftest" "$rc" 0
    return 1
  fi
  if mtlk_tier_requested t1; then
    mtlk_manifest_mark "$EV" t1 - PASS >/dev/null 2>&1 || true
    mtlk_manifest_mark "$EV" t1 T1 PASS >/dev/null 2>&1 || true
  fi

  if mtlk_any_run_case_tier_requested; then
    mtlk_gate_lock_acquire >>"$MTX/lock.txt" 2>&1
    for tier in $REQUESTED_TIERS; do
      case "$tier" in
        t2 | t3)
          mtlk_run_manifest_tier "$tier" || {
            mtlk_gate_lock_release >/dev/null 2>&1 || true
            return 1
          }
          ;;
      esac
    done
    mtlk_gate_lock_release >/dev/null 2>&1 || true
  fi

  if mtlk_tier_requested t4; then
    mtlk_run_m7 || return 1
  fi
  return 0
}

# mtlk_finish <rc> — fold the manifest back into a terminal verdict and write
# the phase-done marker ONLY when the run succeeded and nothing halted.
mtlk_finish() {
  local rc="${1:-0}"
  mtlk_manifest_finalize "$EV" >>"$LOG" 2>&1 || true
  if [ "$rc" = 0 ] && [ ! -f "$MTX/HALTED" ]; then
    mtlk_log "MATRIX-PHASE-DONE $(date -u +%FT%TZ)"
  fi
  return 0
}

main() {
  local rc=0
  mtlk_prepare || exit $?
  mtlk_record_requested_manifest "$EV" || exit $?
  if [ ! -f "$EV/identity.txt" ]; then
    mtlk_write_identity "$EV/identity.txt"
  fi
  mtlk_run_requested_tiers || rc=$?
  mtlk_finish "$rc"
  return "$rc"
}

main
exit $?
