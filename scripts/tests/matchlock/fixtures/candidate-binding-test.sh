#!/usr/bin/env bash
# =============================================================================
# candidate-binding-test.sh — no-VM negative controls for the suite's RUNTIME
# CANDIDATE BINDING path (SUITE-BRIDGE US-003, bead tamandua-qz4).
#
# WHAT THIS PROVES
#   The suite's resolution step (`mtlk_resolve_runtime` in lib/common.sh) plus
#   the environment it propagates SELECT the requested candidate at the launch
#   boundary, FAIL CLOSED on a bad explicitly requested candidate, and preserve
#   today's installed-runtime PATH fallback when no candidate was requested.
#   Every control drives the REAL `lib/common.sh`; only the launch boundary and
#   the two binaries are fixtures.
#
# WHAT THIS DOES **NOT** PROVE — READ THIS BEFORE CITING IT AS EVIDENCE
#   The two `boundary-*.sh` shims are SIMULATIONS. They stand in for the product
#   launcher (`tamandua matchlock …` selecting the matchlock rpc binary) and the
#   matchlock guest-init selection. Each resolves the SAME environment the
#   product reads (`TAMANDUA_MATCHLOCK_RPC_BIN` / `MATCHLOCK_GUEST_INIT`, else a
#   PATH lookup), journals the file it selected, and execs it. That makes them a
#   faithful SELECTION model and nothing more:
#     * they do NOT prove real guest execution, VM boot, image compatibility or
#       any matchlock behaviour;
#     * they do NOT prove the product launcher's internals beyond the documented
#       environment names it reads;
#     * the real-VM tiers (t2–t4) stay the only proof of real execution.
#
# No VM, no model, no network, no `dist/` dependency, no gate lock. Scratch is a
# fresh private `mktemp -d` (or `MTLK_CANDIDATE_FIXTURE_DIR` when the caller owns
# it) and the last line is always:
#
#   CANDIDATE-BINDING FIXTURES RESULT: pass=<n> fail=<n>
#
# Controls:
#   A1  suite-spelling (MTLK_MATCHLOCK_RPC_BIN) candidate with a PATH decoy
#   A2  product-spelling (TAMANDUA_MATCHLOCK_RPC_BIN) candidate, same decoy
#   B   explicit candidate path that does not exist -> fail closed, no launch
#   C   explicit candidate that is chmod -x, and a directory -> fail closed
#   D   no candidate requested -> the PATH (installed) runtime is selected
#   E   explicit guest-init under both spellings; missing/non-exec fail closed
#   R   a relative explicit candidate reaches the boundary as an absolute path
# =============================================================================
set -u

SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd)"
SUITE_DIR="$(cd -- "$SELF_DIR/.." && pwd)"
COMMON="$SUITE_DIR/lib/common.sh"

# Private scratch. `MTLK_CANDIDATE_FIXTURE_DIR` lets the calling test own (and
# clean up) the directory; otherwise this script creates and removes its own.
FIX_OWNED=0
if [ -n "${MTLK_CANDIDATE_FIXTURE_DIR:-}" ]; then
  FIX="$MTLK_CANDIDATE_FIXTURE_DIR"
  rm -rf "$FIX"
  mkdir -p "$FIX"
else
  FIX="$(mktemp -d -t mtlk-candidate-binding.XXXXXX 2>/dev/null || mktemp -d)"
  FIX_OWNED=1
fi

cleanup() {
  if [ "$FIX_OWNED" = "1" ] && [ -n "${FIX:-}" ]; then
    rm -rf "$FIX"
  fi
}
trap cleanup EXIT

FIX="$(cd -- "$FIX" && pwd)"
CAND="$FIX/candidate"
DECOY="$FIX/decoy"
BIN="$FIX/bin"
JOURNALS="$FIX/journals"
mkdir -p "$CAND" "$DECOY" "$BIN" "$JOURNALS"

# The base PATH (without the decoy) so the controls only need coreutils/bash.
BASE_PATH="${PATH:-/usr/bin:/bin}"

# -----------------------------------------------------------------------------
# Fixture binaries. A "shim" journals its own identity + argv, so the journal is
# the evidence of WHICH executable actually ran, not an echo of the env.
# -----------------------------------------------------------------------------

# write_shim <file> <identity>
write_shim() {
  local file="$1" identity="$2"
  cat >"$file" <<SHIM
#!/usr/bin/env bash
set -u
printf 'shim=%s self=%s argv=%s\\n' '$identity' "\$0" "\$*" >> "\${CANDIDATE_JOURNAL:?}"
exit 0
SHIM
  chmod 0755 "$file"
}

write_shim "$CAND/matchlock" candidate-matchlock
write_shim "$CAND/guest-init" candidate-guest-init
write_shim "$DECOY/matchlock" decoy-matchlock
write_shim "$DECOY/guest-init" decoy-guest-init

# -----------------------------------------------------------------------------
# SIMULATED launch boundaries (see the header). These are NOT the product
# launcher; they model only its selection step. Each journals the selected file
# and then execs it.
# -----------------------------------------------------------------------------
cat >"$BIN/boundary-matchlock.sh" <<'BOUNDARY'
#!/usr/bin/env bash
# SIMULATED launch boundary for the matchlock rpc binary. Resolves the SAME
# environment the product launcher reads, journals the selection, then execs it.
# This proves SELECTION only — never real guest execution.
set -u
journal="${CANDIDATE_JOURNAL:?}"
if [ -n "${TAMANDUA_MATCHLOCK_RPC_BIN:-}" ]; then
  source_scheme=product-env
  selected="$TAMANDUA_MATCHLOCK_RPC_BIN"
  case "$selected" in
    */*) ;;
    *) selected="$(command -v "$selected" 2>/dev/null || true)" ;;
  esac
else
  source_scheme=path
  selected="$(command -v matchlock 2>/dev/null || true)"
fi
printf 'boundary=matchlock source=%s selected=%s\n' "$source_scheme" "${selected:-<none>}" >>"$journal"
if [ -z "$selected" ] || [ ! -f "$selected" ] || [ ! -x "$selected" ]; then
  printf 'BOUNDARY-ERROR matchlock-not-executable %s\n' "${selected:-<none>}" >&2
  exit 2
fi
printf 'boundary-exec=matchlock selected=%s argv=%s\n' "$selected" "$*" >>"$journal"
exec "$selected" "$@"
BOUNDARY

cat >"$BIN/boundary-guest-init.sh" <<'BOUNDARY'
#!/usr/bin/env bash
# SIMULATED launch boundary for guest-init. Resolves the SAME environment the
# product/matchlock path reads, journals the selection, then execs it. This
# proves SELECTION only — never real guest execution.
set -u
journal="${CANDIDATE_JOURNAL:?}"
if [ -n "${MATCHLOCK_GUEST_INIT:-}" ]; then
  source_scheme=product-env
  selected="$MATCHLOCK_GUEST_INIT"
  case "$selected" in
    */*) ;;
    *) selected="$(command -v "$selected" 2>/dev/null || true)" ;;
  esac
else
  source_scheme=path
  selected="$(command -v guest-init 2>/dev/null || true)"
fi
printf 'boundary=guest-init source=%s selected=%s\n' "$source_scheme" "${selected:-<none>}" >>"$journal"
if [ -z "$selected" ] || [ ! -f "$selected" ] || [ ! -x "$selected" ]; then
  printf 'BOUNDARY-ERROR guest-init-not-executable %s\n' "${selected:-<none>}" >&2
  exit 2
fi
printf 'boundary-exec=guest-init selected=%s argv=%s\n' "$selected" "$*" >>"$journal"
exec "$selected" "$@"
BOUNDARY

chmod 0755 "$BIN/boundary-matchlock.sh" "$BIN/boundary-guest-init.sh"

# Non-executable / directory / missing fixtures for the fail-closed controls.
printf '#!/usr/bin/env bash\nexit 0\n' >"$FIX/nonexec-matchlock"
chmod 0644 "$FIX/nonexec-matchlock"
printf '#!/usr/bin/env bash\nexit 0\n' >"$FIX/nonexec-guest-init"
chmod 0644 "$FIX/nonexec-guest-init"
mkdir -p "$FIX/dir-matchlock"

# -----------------------------------------------------------------------------
# Assertion helpers.
# -----------------------------------------------------------------------------
PASSN=0
FAILN=0
okf() {
  PASSN=$((PASSN + 1))
  printf 'ok   - %s\n' "$1"
}
badf() {
  FAILN=$((FAILN + 1))
  printf 'FIXTURE-FAIL - %s\n' "$1"
}
# want_eq <got> <want> <label>
want_eq() {
  if [ "$1" = "$2" ]; then
    okf "$3"
  else
    badf "$3 (got '$1' want '$2')"
  fi
}
# want_contains <file> <needle> <label>
want_contains() {
  if [ -f "$1" ] && grep -Fq -- "$2" "$1" 2>/dev/null; then
    okf "$3"
  else
    badf "$3 (missing '$2' in $1)"
    if [ -f "$1" ]; then sed 's/^/    | /' "$1"; fi
  fi
}
# want_omits <file> <needle> <label>
want_omits() {
  if [ ! -f "$1" ] || ! grep -Fq -- "$2" "$1" 2>/dev/null; then
    okf "$3"
  else
    badf "$3 (unexpected '$2' in $1)"
    sed 's/^/    | /' "$1"
  fi
}
# want_journal_empty <file> <label>
want_journal_empty() {
  if [ -f "$1" ] && [ ! -s "$1" ]; then
    okf "$2"
  else
    badf "$2 (boundary journal is not empty)"
    if [ -f "$1" ]; then sed 's/^/    | /' "$1"; fi
  fi
}

# reset_runtime_env — clear every runtime-candidate spelling for one control.
# The variables are unset (not emptied) so no inherited explicit request leaks
# into a control that means to request nothing.
reset_runtime_env() {
  unset MTLK_COMMON_SOURCED MTLK_MATCHLOCK_RPC_BIN MTLK_GUEST_INIT
  unset TAMANDUA_MATCHLOCK_RPC_BIN MATCHLOCK_GUEST_INIT
  unset MTLK_REQUIRE_GUEST_INIT
}

# -----------------------------------------------------------------------------
# A1 — SUITE spelling candidate + PATH decoy: the candidate must be selected.
# -----------------------------------------------------------------------------
echo '--- A1 suite-spelling explicit candidate vs PATH decoy ---'
a1_j="$JOURNALS/a1.journal"
a1_o="$JOURNALS/a1.out"
: >"$a1_j"
(
  reset_runtime_env
  export PATH="$DECOY:$BASE_PATH"
  export CANDIDATE_JOURNAL="$a1_j"
  export MTLK_MATCHLOCK_RPC_BIN="$CAND/matchlock"
  # shellcheck source=../lib/common.sh
  . "$COMMON"
  mtlk_resolve_runtime || exit $?
  bash "$BIN/boundary-matchlock.sh" --probe A1
) >"$a1_o" 2>&1
a1_rc=$?
want_eq "$a1_rc" 0 'A1 rc=0'
want_contains "$a1_j" "boundary=matchlock source=product-env selected=$CAND/matchlock" \
  'A1 boundary selected the candidate (suite spelling)'
want_contains "$a1_j" "boundary-exec=matchlock selected=$CAND/matchlock" \
  'A1 boundary exec used the candidate'
want_contains "$a1_j" "shim=candidate-matchlock self=$CAND/matchlock" \
  'A1 candidate shim actually ran'
want_omits "$a1_j" 'decoy-matchlock' 'A1 PATH decoy never ran'
want_omits "$a1_j" "selected=$DECOY/matchlock" 'A1 boundary never selected the PATH decoy'

# -----------------------------------------------------------------------------
# A2 — PRODUCT spelling candidate + PATH decoy: same, via the name the launcher
# reads.
# -----------------------------------------------------------------------------
echo '--- A2 product-spelling explicit candidate vs PATH decoy ---'
a2_j="$JOURNALS/a2.journal"
a2_o="$JOURNALS/a2.out"
: >"$a2_j"
(
  reset_runtime_env
  export PATH="$DECOY:$BASE_PATH"
  export CANDIDATE_JOURNAL="$a2_j"
  export TAMANDUA_MATCHLOCK_RPC_BIN="$CAND/matchlock"
  # shellcheck source=../lib/common.sh
  . "$COMMON"
  mtlk_resolve_runtime || exit $?
  bash "$BIN/boundary-matchlock.sh" --probe A2
) >"$a2_o" 2>&1
a2_rc=$?
want_eq "$a2_rc" 0 'A2 rc=0'
want_contains "$a2_j" "boundary=matchlock source=product-env selected=$CAND/matchlock" \
  'A2 boundary selected the candidate (product spelling)'
want_contains "$a2_j" "boundary-exec=matchlock selected=$CAND/matchlock" \
  'A2 boundary exec used the candidate'
want_contains "$a2_j" "shim=candidate-matchlock self=$CAND/matchlock" \
  'A2 candidate shim actually ran'
want_omits "$a2_j" 'decoy-matchlock' 'A2 PATH decoy never ran'

# -----------------------------------------------------------------------------
# B — explicit candidate path that does not exist: fail closed, never launch.
# -----------------------------------------------------------------------------
echo '--- B missing explicit candidate fails closed (no PATH fallback) ---'
b_j="$JOURNALS/b.journal"
b_o="$JOURNALS/b.out"
: >"$b_j"
b_missing="$FIX/missing-matchlock"
(
  reset_runtime_env
  export PATH="$DECOY:$BASE_PATH"
  export CANDIDATE_JOURNAL="$b_j"
  export MTLK_MATCHLOCK_RPC_BIN="$b_missing"
  # shellcheck source=../lib/common.sh
  . "$COMMON"
  mtlk_resolve_runtime || exit $?
  echo 'UNEXPECTED-RESOLVE-SUCCESS'
  bash "$BIN/boundary-matchlock.sh" --probe B
) >"$b_o" 2>&1
b_rc=$?
want_eq "$b_rc" 2 'B rc=2 (missing explicit candidate)'
want_contains "$b_o" "MTLK-ABORT matchlock-candidate-missing $b_missing" \
  'B error names the requested missing path'
want_journal_empty "$b_j" 'B boundary never invoked (no PATH fallback)'

# -----------------------------------------------------------------------------
# C — explicit candidate that is present but not executable, and a directory.
# -----------------------------------------------------------------------------
echo '--- C non-executable and directory candidates fail closed ---'
c1_j="$JOURNALS/c1.journal"
c1_o="$JOURNALS/c1.out"
: >"$c1_j"
(
  reset_runtime_env
  export PATH="$DECOY:$BASE_PATH"
  export CANDIDATE_JOURNAL="$c1_j"
  export MTLK_MATCHLOCK_RPC_BIN="$FIX/nonexec-matchlock"
  # shellcheck source=../lib/common.sh
  . "$COMMON"
  mtlk_resolve_runtime || exit $?
  echo 'UNEXPECTED-RESOLVE-SUCCESS'
  bash "$BIN/boundary-matchlock.sh" --probe C1
) >"$c1_o" 2>&1
c1_rc=$?
want_eq "$c1_rc" 2 'C1 rc=2 (non-executable candidate)'
want_contains "$c1_o" "MTLK-ABORT matchlock-candidate-not-executable $FIX/nonexec-matchlock" \
  'C1 error names the non-executable file'
want_journal_empty "$c1_j" 'C1 boundary never invoked'

c2_j="$JOURNALS/c2.journal"
c2_o="$JOURNALS/c2.out"
: >"$c2_j"
(
  reset_runtime_env
  export PATH="$DECOY:$BASE_PATH"
  export CANDIDATE_JOURNAL="$c2_j"
  export MTLK_MATCHLOCK_RPC_BIN="$FIX/dir-matchlock"
  # shellcheck source=../lib/common.sh
  . "$COMMON"
  mtlk_resolve_runtime || exit $?
  echo 'UNEXPECTED-RESOLVE-SUCCESS'
  bash "$BIN/boundary-matchlock.sh" --probe C2
) >"$c2_o" 2>&1
c2_rc=$?
want_eq "$c2_rc" 2 'C2 rc=2 (directory candidate)'
want_contains "$c2_o" "MTLK-ABORT matchlock-candidate-not-a-file $FIX/dir-matchlock" \
  'C2 directory rejected as not-a-file'
want_journal_empty "$c2_j" 'C2 boundary never invoked'

# -----------------------------------------------------------------------------
# D — no candidate requested: the installed PATH runtime is selected exactly as
# before. The decoy directory stands in for the installed matchlock/guest-init
# pair (the only ones on PATH for this control).
# -----------------------------------------------------------------------------
echo '--- D no candidate requested: PATH/installed runtime preserved ---'
d_j="$JOURNALS/d.journal"
d_o="$JOURNALS/d.out"
: >"$d_j"
(
  reset_runtime_env
  export PATH="$DECOY:$BASE_PATH"
  export CANDIDATE_JOURNAL="$d_j"
  # shellcheck source=../lib/common.sh
  . "$COMMON"
  mtlk_resolve_runtime || exit $?
  printf 'resolved-matchlock=%s\n' "$MTLK_MATCHLOCK_RPC_BIN"
  printf 'resolved-guest-init=%s\n' "$MTLK_GUEST_INIT"
  bash "$BIN/boundary-matchlock.sh" --probe D
  bash "$BIN/boundary-guest-init.sh" --probe D-guest
) >"$d_o" 2>&1
d_rc=$?
want_eq "$d_rc" 0 'D rc=0 (no candidate)'
want_contains "$d_o" "resolved-matchlock=$DECOY/matchlock" \
  'D PATH matchlock resolved (installed runtime preserved)'
want_contains "$d_o" "resolved-guest-init=$DECOY/guest-init" \
  'D sibling PATH guest-init resolved'
want_contains "$d_j" "boundary-exec=matchlock selected=$DECOY/matchlock" \
  'D boundary exec used the PATH matchlock'
want_contains "$d_j" "shim=decoy-matchlock self=$DECOY/matchlock" \
  'D PATH matchlock shim ran'
want_contains "$d_j" "boundary-exec=guest-init selected=$DECOY/guest-init" \
  'D guest-init boundary exec used the PATH guest-init'
want_contains "$d_j" "shim=decoy-guest-init self=$DECOY/guest-init" \
  'D PATH guest-init shim ran'
want_omits "$d_j" 'candidate-matchlock' 'D candidate matchlock never used'
want_omits "$d_j" 'candidate-guest-init' 'D candidate guest-init never used'

# -----------------------------------------------------------------------------
# E — guest-init selection and fail-closed behaviour.
# -----------------------------------------------------------------------------
echo '--- E1 suite-spelling explicit guest-init vs PATH decoy ---'
e1_j="$JOURNALS/e1.journal"
e1_o="$JOURNALS/e1.out"
: >"$e1_j"
(
  reset_runtime_env
  export PATH="$DECOY:$BASE_PATH"
  export CANDIDATE_JOURNAL="$e1_j"
  export MTLK_GUEST_INIT="$CAND/guest-init"
  # shellcheck source=../lib/common.sh
  . "$COMMON"
  mtlk_resolve_runtime || exit $?
  printf 'resolved-guest-init=%s\n' "$MTLK_GUEST_INIT"
  bash "$BIN/boundary-guest-init.sh" --probe E1
) >"$e1_o" 2>&1
e1_rc=$?
want_eq "$e1_rc" 0 'E1 rc=0'
want_contains "$e1_o" "resolved-guest-init=$CAND/guest-init" \
  'E1 suite-spelling guest-init candidate resolved'
want_contains "$e1_j" "boundary-exec=guest-init selected=$CAND/guest-init" \
  'E1 guest boundary selected the candidate guest-init'
want_contains "$e1_j" "shim=candidate-guest-init self=$CAND/guest-init" \
  'E1 candidate guest-init shim ran'
want_omits "$e1_j" 'decoy-guest-init' 'E1 PATH decoy guest-init never ran'

echo '--- E2 product-spelling explicit guest-init vs PATH decoy ---'
e2_j="$JOURNALS/e2.journal"
e2_o="$JOURNALS/e2.out"
: >"$e2_j"
(
  reset_runtime_env
  export PATH="$DECOY:$BASE_PATH"
  export CANDIDATE_JOURNAL="$e2_j"
  export MATCHLOCK_GUEST_INIT="$CAND/guest-init"
  # shellcheck source=../lib/common.sh
  . "$COMMON"
  mtlk_resolve_runtime || exit $?
  printf 'resolved-guest-init=%s\n' "$MTLK_GUEST_INIT"
  bash "$BIN/boundary-guest-init.sh" --probe E2
) >"$e2_o" 2>&1
e2_rc=$?
want_eq "$e2_rc" 0 'E2 rc=0'
want_contains "$e2_o" "resolved-guest-init=$CAND/guest-init" \
  'E2 product-spelling guest-init candidate resolved'
want_contains "$e2_j" "boundary-exec=guest-init selected=$CAND/guest-init" \
  'E2 guest boundary selected the candidate guest-init'
want_omits "$e2_j" 'decoy-guest-init' 'E2 PATH decoy guest-init never ran'

echo '--- E3 missing explicit guest-init fails closed even when not required ---'
e3_j="$JOURNALS/e3.journal"
e3_o="$JOURNALS/e3.out"
: >"$e3_j"
e3_missing="$FIX/missing-guest-init"
(
  reset_runtime_env
  export PATH="$DECOY:$BASE_PATH"
  export CANDIDATE_JOURNAL="$e3_j"
  export MTLK_REQUIRE_GUEST_INIT=0
  export MTLK_GUEST_INIT="$e3_missing"
  # shellcheck source=../lib/common.sh
  . "$COMMON"
  mtlk_resolve_runtime || exit $?
  echo 'UNEXPECTED-RESOLVE-SUCCESS'
  bash "$BIN/boundary-guest-init.sh" --probe E3
) >"$e3_o" 2>&1
e3_rc=$?
want_eq "$e3_rc" 2 'E3 rc=2 (missing explicit guest-init)'
want_contains "$e3_o" "MTLK-ABORT guest-init-candidate-missing $e3_missing" \
  'E3 error names the requested missing guest-init'
want_journal_empty "$e3_j" 'E3 guest boundary never invoked'

echo '--- E4 non-executable explicit guest-init fails closed ---'
e4_j="$JOURNALS/e4.journal"
e4_o="$JOURNALS/e4.out"
: >"$e4_j"
(
  reset_runtime_env
  export PATH="$DECOY:$BASE_PATH"
  export CANDIDATE_JOURNAL="$e4_j"
  export MTLK_GUEST_INIT="$FIX/nonexec-guest-init"
  # shellcheck source=../lib/common.sh
  . "$COMMON"
  mtlk_resolve_runtime || exit $?
  echo 'UNEXPECTED-RESOLVE-SUCCESS'
  bash "$BIN/boundary-guest-init.sh" --probe E4
) >"$e4_o" 2>&1
e4_rc=$?
want_eq "$e4_rc" 2 'E4 rc=2 (non-executable guest-init)'
want_contains "$e4_o" "MTLK-ABORT guest-init-candidate-not-executable $FIX/nonexec-guest-init" \
  'E4 error names the non-executable guest-init'
want_journal_empty "$e4_j" 'E4 guest boundary never invoked'

# -----------------------------------------------------------------------------
# R — a RELATIVE explicit candidate reaches the boundary as an ABSOLUTE path
# (the product path.resolve()s an override instead of searching PATH).
# -----------------------------------------------------------------------------
echo '--- R relative explicit candidate is absolute at the boundary ---'
r_j="$JOURNALS/r.journal"
r_o="$JOURNALS/r.out"
: >"$r_j"
(
  reset_runtime_env
  export PATH="$DECOY:$BASE_PATH"
  export CANDIDATE_JOURNAL="$r_j"
  cd "$FIX" || exit 1
  export MTLK_MATCHLOCK_RPC_BIN="candidate/matchlock"
  # shellcheck source=../lib/common.sh
  . "$COMMON"
  mtlk_resolve_runtime || exit $?
  printf 'resolved-matchlock=%s\n' "$MTLK_MATCHLOCK_RPC_BIN"
  bash "$BIN/boundary-matchlock.sh" --probe REL
) >"$r_o" 2>&1
r_rc=$?
want_eq "$r_rc" 0 'R rc=0'
want_contains "$r_o" "resolved-matchlock=$CAND/matchlock" \
  'R relative candidate normalized to an absolute path'
want_contains "$r_j" "boundary=matchlock source=product-env selected=$CAND/matchlock" \
  'R boundary received the absolute candidate'
want_contains "$r_j" "shim=candidate-matchlock self=$CAND/matchlock" \
  'R candidate shim ran'

# -----------------------------------------------------------------------------
# Terminal result line (always the last line).
# -----------------------------------------------------------------------------
printf 'CANDIDATE-BINDING FIXTURES RESULT: pass=%s fail=%s\n' "$PASSN" "$FAILN"
[ "$FAILN" = 0 ]
