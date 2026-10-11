#!/usr/bin/env bash
# =============================================================================
# MTLK-INTERACTIVE-SUITE — private per-run matchlock image store seeding.
#
# `lib/image-store.sh` is a SOURCED library (it deliberately does nothing on
# source beyond defining functions). It produces a private, fully USABLE
# matchlock image store for a per-run private HOME from the operator's store
# (default `$HOME/.cache/matchlock`, override
# `TAMANDUA_GATE_OPERATOR_CACHE` / `MTLK_OPERATOR_CACHE`). Contract:
#
#   * The private store lives at `<privateHome>/.cache/matchlock` (matchlock's
#     HOME-derived store) and is seeded from the operator store.
#   * CONTENT-ADDRESSED blobs are hardlinked (`cp -al`) when the private store
#     is on the same device, with a `cp -a --reflink=auto` fallback and then a
#     plain `cp -a` fallback across devices. Blobs are immutable read-only
#     content; sharing them never mutates the operator store.
#   * MUTABLE METADATA (`metadata.db` / `-wal` / `-shm`) and `local/` are
#     COPIED, never hardlinked: matchlock needs to write them, and a hardlink
#     would let the private run mutate the operator's store.
#   * `kernels/` is seeded the same way: hardlinked kernel blobs, independent
#     metadata DB, so the per-run store is self-sufficient.
#   * A store is only "usable" when `images/metadata.db` exists AND
#     `kernels/` is populated; otherwise seeding FAILS CLOSED with exit 4 and
#     the exact line `MTLK-IMAGE-STORE-FAIL <reason>`. matchlock is NEVER
#     started against an empty/unseeded store.
#   * The operator store is READ-ONLY: this module never writes to it.
#
# Environment / bindings:
#   MTLK_OPERATOR_CACHE   operator store (set by lib/common.sh; falls back to
#                         TAMANDUA_GATE_OPERATOR_CACHE, then $HOME/.cache/matchlock)
#   MTLK_REQUIRE_KERNELS  default 1; when 0, a kernel-less operator store is
#                         tolerated (helper fixtures only, never a real host)
#
# The matchlock binary / guest-init pair must already be resolved (via
# `mtlk_resolve_runtime`) BEFORE the caller changes HOME/PATH — this module
# does not re-derive them from a mutated environment, it inherits the resolved
# `MTLK_MATCHLOCK_RPC_BIN` / `MTLK_GUEST_INIT` bindings.
# =============================================================================

if [ "${MTLK_IMAGE_STORE_SOURCED:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi
MTLK_IMAGE_STORE_SOURCED=1

# Source the shared configuration/bindings (idempotent; a no-op if the caller
# already sourced it). Deriving the path from BASH_SOURCE keeps the suite
# relocatable.
_mtlk_is_self="${BASH_SOURCE[0]:-$0}"
_mtlk_is_dir="$(cd -- "$(dirname -- "$_mtlk_is_self")" && pwd)"
# shellcheck source=./common.sh
. "$_mtlk_is_dir/common.sh"
unset _mtlk_is_self _mtlk_is_dir

# -----------------------------------------------------------------------------
# Fail-closed refusal.
# -----------------------------------------------------------------------------

# mtlk_image_store_fail <reason> — exact refusal line + exit 4. Non-zero so a
# `mtlk_image_store_seed ... || ...` caller can also branch on the failure.
mtlk_image_store_fail() {
  printf 'MTLK-IMAGE-STORE-FAIL %s\n' "$1" >&2
  exit 4
}

# -----------------------------------------------------------------------------
# Paths.
# -----------------------------------------------------------------------------

# mtlk_image_store_dir <privateHome> — echo the private store path for a HOME.
# The store is HOME-derived (`<privateHome>/.cache/matchlock`); there is no
# separate override so the seeded store and the HOME matchlock runs with can
# never drift apart.
mtlk_image_store_dir() {
  printf '%s/.cache/matchlock\n' "$1"
}

# mtlk_operator_cache_dir — echo the operator store path (never the private one).
mtlk_operator_cache_dir() {
  if [ -n "${MTLK_OPERATOR_CACHE:-}" ]; then
    printf '%s\n' "$MTLK_OPERATOR_CACHE"
  elif [ -n "${TAMANDUA_GATE_OPERATOR_CACHE:-}" ]; then
    printf '%s\n' "$TAMANDUA_GATE_OPERATOR_CACHE"
  else
    printf '%s/.cache/matchlock\n' "$HOME"
  fi
}

# -----------------------------------------------------------------------------
# Portable copies (shared by the blobs/ and kernels/ seeding).
# -----------------------------------------------------------------------------

# _mtlk_link_or_copy_dir <srcDir> <dstDir> <label> — hardlink the directory
# tree when possible, else copy. Prints the exact error line and returns 1 on
# failure. Never uses `cp -al` in a way that would silently fall back to a
# hardlink of a MUTABLE file: callers pass content-addressed trees only.
_mtlk_link_or_copy_dir() {
  local from="$1" to="$2" label="$3" err rc
  if [ ! -d "$from" ]; then
    printf 'MTLK-IMAGE-STORE-FAIL missing-%s-source:%s\n' "$label" "$from" >&2
    return 1
  fi
  err="$(mktemp "${TMPDIR:-/tmp}/mtlk-seed.XXXXXX" 2>/dev/null)" || {
    printf 'MTLK-IMAGE-STORE-FAIL mktemp-failed\n' >&2
    return 1
  }
  if cp -al "$from" "$to" 2>"$err"; then
    rm -f "$err"
    return 0
  fi
  # The hardlink attempt may have left a partial target (e.g. across devices).
  # Remove it before retrying so the fallback copies cleanly.
  rm -rf "$to"
  rc=1
  if cp -a --reflink=auto "$from" "$to" 2>>"$err"; then
    rc=0
  else
    rm -rf "$to"
    if cp -a "$from" "$to" 2>>"$err"; then
      rc=0
    fi
  fi
  if [ "$rc" -ne 0 ]; then
    printf 'MTLK-IMAGE-STORE-FAIL seed-%s-failed:%s\n' "$label" \
      "$(tr '\n' ' ' <"$err" 2>/dev/null || true)" >&2
  fi
  rm -f "$err"
  return "$rc"
}

# -----------------------------------------------------------------------------
# Seeding.
# -----------------------------------------------------------------------------

# mtlk_image_store_seed <privateHome> — seed a private, usable matchlock store
# under <privateHome>/.cache/matchlock. Returns 0 on success, exits 4 on any
# refusal (missing operator store, missing metadata DB, missing kernels).
mtlk_image_store_seed() {
  local home="${1:-}"
  [ -n "$home" ] || mtlk_image_store_fail "usage:mtlk_image_store_seed <privateHome>"
  case "$home" in
    /*) : ;;
    *) mtlk_image_store_fail "private-home-not-absolute:$home" ;;
  esac

  local src dst
  src="$(mtlk_operator_cache_dir)"
  dst="$(mtlk_image_store_dir "$home")"

  [ -d "$src" ] || mtlk_image_store_fail "operator-store-missing:$src"
  [ -d "$src/images" ] || mtlk_image_store_fail "operator-images-missing:$src/images"
  [ -f "$src/images/metadata.db" ] ||
    mtlk_image_store_fail "operator-images-metadata-db-missing:$src/images/metadata.db"

  # Refuse to seed a store onto itself: the private store must never BE the
  # operator store (that would let matchlock mutate the operator's metadata).
  if [ "$src" = "$dst" ]; then
    mtlk_image_store_fail "private-store-equals-operator-store:$dst"
  fi

  mkdir -p "$dst/images" || mtlk_image_store_fail "mkdir-failed:$dst/images"

  # 1. content-addressed image blobs: hardlink when possible.
  if [ -d "$src/images/blobs" ]; then
    if [ -e "$dst/images/blobs" ]; then
      rm -rf "$dst/images/blobs" || mtlk_image_store_fail "rm-failed:$dst/images/blobs"
    fi
    _mtlk_link_or_copy_dir "$src/images/blobs" "$dst/images/blobs" "images-blobs" ||
      mtlk_image_store_fail "seed-images-blobs-failed"
  fi

  # 2. mutable image metadata: independent COPIES (never hardlinks). Removing a
  #    stale private copy first keeps re-seeding idempotent.
  local meta
  for meta in metadata.db metadata.db-wal metadata.db-shm; do
    if [ -f "$src/images/$meta" ]; then
      rm -f "$dst/images/$meta" || mtlk_image_store_fail "rm-failed:$dst/images/$meta"
      cp -a "$src/images/$meta" "$dst/images/$meta" ||
        mtlk_image_store_fail "copy-images-$meta-failed"
    fi
  done

  # 3. local/durable image records: copy (mutable), never hardlink.
  if [ -e "$src/images/local" ]; then
    rm -rf "$dst/images/local" || mtlk_image_store_fail "rm-failed:$dst/images/local"
    cp -a "$src/images/local" "$dst/images/local" ||
      mtlk_image_store_fail "copy-images-local-failed"
  fi

  # 4. kernels: hardlink the kernel payloads, copy the mutable metadata DB.
  [ -d "$src/kernels" ] || mtlk_image_store_fail "operator-kernels-missing:$src/kernels"
  mkdir -p "$dst/kernels" || mtlk_image_store_fail "mkdir-failed:$dst/kernels"
  local entry base
  for entry in "$src"/kernels/*; do
    [ -e "$entry" ] || continue
    base="$(basename -- "$entry")"
    case "$base" in
      metadata.db | metadata.db-wal | metadata.db-shm | metadata.db.init.lock) continue ;;
    esac
    if [ -e "$dst/kernels/$base" ]; then
      rm -rf "$dst/kernels/$base" || mtlk_image_store_fail "rm-failed:$dst/kernels/$base"
    fi
    if [ -d "$entry" ]; then
      _mtlk_link_or_copy_dir "$entry" "$dst/kernels/$base" "kernels-$base" ||
        mtlk_image_store_fail "seed-kernels-$base-failed"
    else
      cp -a "$entry" "$dst/kernels/$base" ||
        mtlk_image_store_fail "copy-kernels-$base-failed"
    fi
  done
  for meta in metadata.db metadata.db-wal metadata.db-shm; do
    if [ -f "$src/kernels/$meta" ]; then
      rm -f "$dst/kernels/$meta" || mtlk_image_store_fail "rm-failed:$dst/kernels/$meta"
      cp -a "$src/kernels/$meta" "$dst/kernels/$meta" ||
        mtlk_image_store_fail "copy-kernels-$meta-failed"
    fi
  done

  # 5. POINT OF NO RETURN: validate the private store is fully usable. A
  #    requested (or merely configured) store that is empty/incomplete fails
  #    closed; matchlock must never start against it.
  [ -f "$dst/images/metadata.db" ] ||
    mtlk_image_store_fail "seeded-store-images-metadata-db-missing:$dst/images/metadata.db"
  if mtlk_is_truthy "${MTLK_REQUIRE_KERNELS:-1}"; then
    [ -d "$dst/kernels" ] ||
      mtlk_image_store_fail "seeded-store-kernels-missing:$dst/kernels"
    if ! ls -A "$dst/kernels" 2>/dev/null | grep -q .; then
      mtlk_image_store_fail "seeded-store-kernels-empty:$dst/kernels"
    fi
  fi

  printf 'MTLK-IMAGE-STORE-SEEDED %s\n' "$dst"
  return 0
}

# mtlk_image_store_verify <privateHome> — re-validate an already-seeded private
# store (e.g. a pre-existing store handed in via --evidence-dir). FAILS CLOSED
# with the same exit 4 when it is not usable.
mtlk_image_store_verify() {
  local home="${1:-}" dst
  [ -n "$home" ] || mtlk_image_store_fail "usage:mtlk_image_store_verify <privateHome>"
  dst="$(mtlk_image_store_dir "$home")"
  [ -f "$dst/images/metadata.db" ] ||
    mtlk_image_store_fail "store-images-metadata-db-missing:$dst/images/metadata.db"
  if mtlk_is_truthy "${MTLK_REQUIRE_KERNELS:-1}"; then
    [ -d "$dst/kernels" ] || mtlk_image_store_fail "store-kernels-missing:$dst/kernels"
    if ! ls -A "$dst/kernels" 2>/dev/null | grep -q .; then
      mtlk_image_store_fail "store-kernels-empty:$dst/kernels"
    fi
  fi
  return 0
}
