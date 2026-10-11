#!/usr/bin/env bash
# =============================================================================
# MTLK-INTERACTIVE-SUITE — the REQUESTED manifest.
#
# `lib/manifest.sh` records, BEFORE execution, exactly which tiers and cases a
# run REQUESTED, where each one's evidence will live, and its initial status.
# The receipt validator (`validator/validate-receipts.sh`) then checks the
# evidence against that recorded scope — never against an implicit
# "all seven cases" list and never against a marker word.
#
# Contract (see scripts/tests/matchlock/README.md and US-004):
#
#   * The manifest is written BEFORE any case executes. A tier or case that was
#     deliberately NOT requested is recorded with `requested=0` and status
#     `UNEXECUTED`; an unrequested entry is NEVER reported as `PASS`.
#   * Once a scope is recorded it may only GROW. A requested tier/case can be
#     added but never removed, and after `mtlk_manifest_freeze` the scope is
#     immutable ("the requested scope must never shrink after a failure").
#   * A requested required case that did not execute FAILS: `mtlk_manifest_
#     finalize` turns every still-UNEXECUTED requested required row into `FAIL`.
#     A requested optional tier that could not run (e.g. T3 without model
#     credentials) is recorded `NOTRUN` (declared), never `PASS`.
#
# File format: `<evdir>/manifest/requested.tsv`, tab-separated, one header row:
#
#   kind<TAB>tier<TAB>name<TAB>requested<TAB>required<TAB>evidence<TAB>status
#
#   kind        `tier` or `case`
#   tier        t1|t2|t3|t4
#   name        the case id, or `-` for a tier row
#   requested   1 when this run asked for it, 0 when deliberately not
#   required    1 when a missing/failed entry prevents success
#   evidence    evidence directory RELATIVE to <evdir> (case rows); `-` for tiers
#   status      UNEXECUTED|RUNNING|PASS|FAIL|NOTRUN
#
# A frozen run additionally writes `<evdir>/manifest/frozen` and
# `<evdir>/manifest/scope.version`; a request after freeze is refused.
#
# Sourcing twice is a no-op (`MTLK_MANIFEST_SOURCED` guard). The module never
# boots, execs or deletes anything; it only records/validates the request.
# =============================================================================

if [ "${MTLK_MANIFEST_SOURCED:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi
MTLK_MANIFEST_SOURCED=1

# Reuse the shared bindings/helpers when available (idempotent). The module is
# also usable standalone: the only helpers it needs are defined below.
_mtlk_manifest_self="${BASH_SOURCE[0]:-$0}"
_mtlk_manifest_dir="$(cd -- "$(dirname -- "$_mtlk_manifest_self")" && pwd)"
if [ "${MTLK_COMMON_SOURCED:-0}" != "1" ] && [ -f "$_mtlk_manifest_dir/common.sh" ]; then
  # shellcheck source=./common.sh
  . "$_mtlk_manifest_dir/common.sh"
fi
unset _mtlk_manifest_self _mtlk_manifest_dir

MTLK_MANIFEST_HEADER=$'kind\ttier\tname\trequested\trequired\tevidence\tstatus'
MTLK_MANIFEST_TIERS="${MTLK_TIERS:-t1 t2 t3 t4}"
MTLK_MANIFEST_STATUSES="UNEXECUTED RUNNING PASS FAIL NOTRUN"

# NOTE: MTLK_MANIFEST_SOURCED is deliberately NOT exported. The guard is only
# meant to make sourcing a no-op within the SAME shell; exporting it would make
# composed child scripts (separate processes that must load the module for
# themselves) skip it entirely and miss every function it defines.
export MTLK_MANIFEST_HEADER MTLK_MANIFEST_TIERS

# mtlk_manifest_abort <reason> — the fail-closed refusal line (never exits; the
# caller decides whether the refusal is fatal).
mtlk_manifest_abort() {
  printf 'MTLK-MANIFEST-ABORT %s\n' "$1"
  return 2
}

# mtlk_manifest_dir <evdir>
mtlk_manifest_dir() { printf '%s/manifest' "$1"; }

# mtlk_manifest_file <evdir>
mtlk_manifest_file() { printf '%s/manifest/requested.tsv' "$1"; }

# mtlk_manifest_is_frozen <evdir>
mtlk_manifest_is_frozen() { [ -f "$1/manifest/frozen" ]; }

# mtlk_manifest_tier_known <tier>
mtlk_manifest_tier_known() {
  local t
  for t in $MTLK_MANIFEST_TIERS; do
    [ "$t" = "$1" ] && return 0
  done
  return 1
}

# mtlk_manifest_tier_required <tier> — default required flag for a tier.
# T1/T2 are the mandatory mechanics tiers; T3 (live model) and T4 (scheduled
# spot-run) are declared-optional and env-gated.
mtlk_manifest_tier_required() {
  case "$1" in
    t1) printf '%s' "${MTLK_TIER_T1_REQUIRED:-1}" ;;
    t2) printf '%s' "${MTLK_TIER_T2_REQUIRED:-1}" ;;
    t3) printf '%s' "${MTLK_TIER_T3_REQUIRED:-0}" ;;
    t4) printf '%s' "${MTLK_TIER_T4_REQUIRED:-0}" ;;
    *) printf '0' ;;
  esac
}

# mtlk_manifest_init <evdir> — create the manifest and record every known tier
# as NOT requested / UNEXECUTED. Refuses to re-create an existing manifest so a
# recorded scope is never silently rewritten.
mtlk_manifest_init() {
  local ev="$1"
  local f="$ev/manifest/requested.tsv"
  if [ -e "$f" ]; then
    mtlk_manifest_abort "manifest-exists:$f"
    return 2
  fi
  mkdir -p "$ev/manifest" || {
    mtlk_manifest_abort "cannot-create:$ev/manifest"
    return 2
  }
  printf '%s\n' "$MTLK_MANIFEST_HEADER" >"$f"
  local tier req
  for tier in $MTLK_MANIFEST_TIERS; do
    req="$(mtlk_manifest_tier_required "$tier")"
    printf 'tier\t%s\t-\t0\t%s\t-\tUNEXECUTED\n' "$tier" "$req" >>"$f"
  done
  printf '1\n' >"$ev/manifest/scope.version"
  return 0
}

# mtlk_manifest_request_tier <evdir> <tier> — mark a tier requested. Idempotent;
# refused once the scope is frozen.
mtlk_manifest_request_tier() {
  local ev="$1" tier="$2" f
  f="$(mtlk_manifest_file "$ev")"
  [ -f "$f" ] || { mtlk_manifest_abort "missing-manifest:$f"; return 2; }
  mtlk_manifest_tier_known "$tier" || { mtlk_manifest_abort "unknown-tier:$tier"; return 2; }
  if mtlk_manifest_is_frozen "$ev"; then
    mtlk_manifest_abort "scope-frozen:$tier"
    return 2
  fi
  awk -F'\t' -v OFS='\t' -v t="$tier" '
    NR == 1 { print; next }
    { if ($1 == "tier" && $2 == t) { $4 = "1" } print }
  ' "$f" >"$f.tmp" && mv "$f.tmp" "$f"
  return 0
}

# mtlk_manifest_add_case <evdir> <tier> <case> [required] [evidence]
# Record a requested case. Adding the same case again is idempotent but may only
# strengthen it (requested 0->1, required 0->1); evidence defaults to the case
# name and is not silently changed once set.
mtlk_manifest_add_case() {
  local ev="$1" tier="$2" case_id="$3"
  local required="${4:-1}" evidence="${5:-$3}" f
  f="$(mtlk_manifest_file "$ev")"
  [ -f "$f" ] || { mtlk_manifest_abort "missing-manifest:$f"; return 2; }
  mtlk_manifest_tier_known "$tier" || { mtlk_manifest_abort "unknown-tier:$tier"; return 2; }
  [ -n "$case_id" ] && [ "$case_id" != "-" ] ||
    { mtlk_manifest_abort "empty-case-id"; return 2; }
  if mtlk_manifest_is_frozen "$ev"; then
    mtlk_manifest_abort "scope-frozen:$tier/$case_id"
    return 2
  fi

  printf '%s' "$required" | grep -Eq '^[01]$' || { mtlk_manifest_abort "bad-required:$required"; return 2; }

  local existing
  existing="$(awk -F'\t' -v t="$tier" -v n="$case_id" '$1=="case" && $2==t && $3==n {print $4"\t"$5"\t"$6}' "$f")"
  if [ -n "$existing" ]; then
    # Strengthen only: never flip requested/required back to 0 and never
    # rewrite an already-recorded evidence path.
    awk -F'\t' -v OFS='\t' -v t="$tier" -v n="$case_id" -v r="$required" -v e="$evidence" '
      NR == 1 { print; next }
      {
        if ($1 == "case" && $2 == t && $3 == n) {
          $4 = "1"
          if ($5 != "1") { $5 = r }
          if ($6 == "-") { $6 = e }
        }
        print
      }
    ' "$f" >"$f.tmp" && mv "$f.tmp" "$f"
    return 0
  fi
  printf 'case\t%s\t%s\t1\t%s\t%s\tUNEXECUTED\n' "$tier" "$case_id" "$required" "$evidence" >>"$f"
  return 0
}

# mtlk_manifest_freeze <evdir> — close the requested scope. After this, the
# manifest is immutable for the lifetime of the run.
mtlk_manifest_freeze() {
  local ev="$1" f requested
  f="$(mtlk_manifest_file "$ev")"
  [ -f "$f" ] || { mtlk_manifest_abort "missing-manifest:$f"; return 2; }
  if mtlk_manifest_is_frozen "$ev"; then
    mtlk_manifest_abort "already-frozen"
    return 2
  fi
  requested="$(awk -F'\t' 'NR>1 && $4=="1" {n++} END {print n+0}' "$f")"
  if [ "$requested" = "0" ]; then
    mtlk_manifest_abort "empty-scope"
    return 2
  fi
  printf '1\n' >"$ev/manifest/scope.version"
  printf 'scope=%s\n' "$requested" >"$ev/manifest/scope.count"
  : >"$ev/manifest/frozen"
  return 0
}

# mtlk_manifest_status <evdir> <tier> <case|-> — print a row's status.
mtlk_manifest_status() {
  local ev="$1" tier="$2" name="$3" f
  f="$(mtlk_manifest_file "$ev")"
  [ -f "$f" ] || return 1
  awk -F'\t' -v t="$tier" -v n="$name" '
    $1 == "case" && $2 == t && $3 == n { print $7; found=1 }
    $1 == "tier" && $2 == t && n == "-" { print $7; found=1 }
    END { exit(found ? 0 : 1) }
  ' "$f"
}

# mtlk_manifest_mark <evdir> <tier> <case|-> <status> — update a row's status.
# Refused before freeze (the scope is recorded first, then execution updates
# it) and refused for a downgrade from a terminal PASS/FAIL back to a
# pending state.
mtlk_manifest_mark() {
  local ev="$1" tier="$2" name="$3" status="$4" f cur
  f="$(mtlk_manifest_file "$ev")"
  [ -f "$f" ] || { mtlk_manifest_abort "missing-manifest:$f"; return 2; }
  mtlk_manifest_is_frozen "$ev" || { mtlk_manifest_abort "not-frozen"; return 2; }
  case " $MTLK_MANIFEST_STATUSES " in
    *" $status "*) : ;;
    *) mtlk_manifest_abort "bad-status:$status"; return 2 ;;
  esac
  cur="$(mtlk_manifest_status "$ev" "$tier" "$name")" ||
    { mtlk_manifest_abort "no-row:$tier/$name"; return 2; }
  case "$cur" in
    PASS | FAIL)
      case "$status" in
        UNEXECUTED | RUNNING)
          mtlk_manifest_abort "downgrade:$tier/$name:$cur->$status"
          return 2
          ;;
      esac
      ;;
  esac
  awk -F'\t' -v OFS='\t' -v t="$tier" -v n="$name" -v s="$status" '
    NR == 1 { print; next }
    {
      if ($1 == "case" && $2 == t && $3 == n) { $7 = s }
      if ($1 == "tier" && $2 == t && n == "-") { $7 = s }
      print
    }
  ' "$f" >"$f.tmp" && mv "$f.tmp" "$f"
  return 0
}

# mtlk_manifest_finalize <evdir> — fold a completed run back into the manifest.
# Every still-pending REQUESTED row becomes FAIL (required) or NOTRUN (optional,
# declared). Unrequested rows are left UNEXECUTED. The input scope is never
# changed — only statuses.
mtlk_manifest_finalize() {
  local ev="$1" f
  f="$(mtlk_manifest_file "$ev")"
  [ -f "$f" ] || { mtlk_manifest_abort "missing-manifest:$f"; return 2; }
  mtlk_manifest_is_frozen "$ev" || { mtlk_manifest_abort "not-frozen"; return 2; }
  awk -F'\t' -v OFS='\t' '
    NR == 1 { print; next }
    {
      if ($4 == "1" && ($7 == "UNEXECUTED" || $7 == "RUNNING")) {
        if ($5 == "1") { $7 = "FAIL" } else { $7 = "NOTRUN" }
      }
      print
    }
  ' "$f" >"$f.tmp" && mv "$f.tmp" "$f"

  local n pass fail notrun unexec
  n="$(awk -F'\t' 'NR>1 && $4=="1" {c++} END {print c+0}' "$f")"
  pass="$(awk -F'\t' 'NR>1 && $4=="1" && $7=="PASS" {c++} END {print c+0}' "$f")"
  fail="$(awk -F'\t' 'NR>1 && $4=="1" && $7=="FAIL" {c++} END {print c+0}' "$f")"
  notrun="$(awk -F'\t' 'NR>1 && $4=="1" && $7=="NOTRUN" {c++} END {print c+0}' "$f")"
  unexec="$(awk -F'\t' 'NR>1 && $4=="0" && $7=="UNEXECUTED" {c++} END {print c+0}' "$f")"
  printf 'MTLK-MANIFEST-FINAL requested=%s pass=%s fail=%s notrun=%s unrequested_unexecuted=%s\n' \
    "$n" "$pass" "$fail" "$notrun" "$unexec"
  return 0
}

# mtlk_manifest_show <evdir> — dump the recorded scope (diagnostics).
mtlk_manifest_show() {
  local f
  f="$(mtlk_manifest_file "$1")"
  [ -f "$f" ] || return 1
  cat "$f"
}
