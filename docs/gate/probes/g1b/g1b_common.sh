#!/bin/bash
# g1b_common.sh — shared constants and helpers for the G1-B stock-runtime
# qualification (bead tamandua-7p5.1.12).
#
# This file is sourced, never executed.  It owns every rule that binds the
# G1-B probes:
#
#   * the precisely identified DOCKER artifact (image ref, image id, platform);
#   * the single container gateway `g1b_container_run`, which ALWAYS passes
#     --rm --network none --platform linux/amd64 --user <uid>:<gid>
#     -v <scratch>:/work -w /work and runs `bash -c` (never `bash -lc`: a login
#     shell prints `/root/.bash_profile: Permission denied`);
#   * the scratch-root rule: `mktemp -d /tmp/g1b-<name>.XXXXXX`, never deleted
#     (every fixture stays in place as evidence);
#   * the refusal guard: exit 64 for any scratch path resolving to
#     /home/kaladin/.hermes or anything under it;
#   * pass/fail counters emitting `ASSERT PASS:` / `ASSERT FAIL:` lines;
#   * the read_header bootstrap that copies docs/gate/probes/read_header.py into
#     <scratch>/tools/ and asserts the copy's sha256 equals the parent file.
#
# Usage:
#   . "$(dirname "$0")/g1b_common.sh"
#
# Safety: the probes never modify, fork, patch or vendor Hermes (stock only),
# never install packages, never touch the real operator home, never reach the
# network (containers run with --network none), and never delete a
# pre-existing path.

set -u

# ---------------------------------------------------------------------------
# Artifact constants (US-001; do not re-derive)
# ---------------------------------------------------------------------------
IMAGE_REF="${G1B_IMAGE_REF:-igorhvr/tamandua:latest}"
REQUIRED_IMAGE_ID="sha256:d15b7b377d679c6561315f7054e16f0310b3956cff872c23818d90073b29934a"
REQUIRED_ARCH="amd64"
REQUIRED_OS="linux"
REQUIRED_PLATFORM="linux/${REQUIRED_ARCH}"

# The Matchlock artifact resolved by the Matchlock store for the same tag.  Its
# relationship to the Docker artifact above is UNVERIFIED — G1-B never claims
# the two are the same artifact.
MATCHLOCK_ARTIFACT_ID="sha256:9140629c9f408a6e9c285434eb6ab0cebd67db146c324db33e2798bac4fb7dff"

# The stock Hermes revision shipped inside the image (verified with
# `git -C /opt/src/hermes-agent rev-parse HEAD`).
REQUIRED_HERMES_REVISION="4d04303818b61bf3aa09278af48356315515965b"

# Paths inside the container.
G1B_CONTAINER_HERMES_SRC="/opt/src/hermes-agent"
G1B_CONTAINER_PYTHON="/opt/src/hermes-venv/bin/python"
G1B_CONTAINER_HERMES="/usr/local/bin/hermes"

# The real operator home: never read, never written, never mounted.
REAL_OPERATOR_HOME="/home/kaladin/.hermes"

# Repository root, derived from this file's location
# (<root>/docs/gate/probes/g1b/g1b_common.sh).
G1B_PROBES_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
G1B_GATE_DIR="$(cd -- "$G1B_PROBES_DIR/../.." && pwd)"
G1B_PROJECT_ROOT="$(cd -- "$G1B_GATE_DIR/../.." && pwd)"
G1B_PARENT_READ_HEADER="$G1B_PROBES_DIR/../read_header.py"
G1B_EVIDENCE_DIR="${G1B_EVIDENCE_DIR:-$G1B_GATE_DIR/evidence/g1b}"

# Scratch base.  Overridable only so a *test* can prove the refusal guard, or a
# caller can place fixtures under a short alternate temp base.
G1B_TMP_ROOT="${G1B_TMP_ROOT:-/tmp}"

# ---------------------------------------------------------------------------
# Pass/fail counters
# ---------------------------------------------------------------------------
ASSERT_PASS="${ASSERT_PASS:-0}"
ASSERT_FAIL="${ASSERT_FAIL:-0}"

g1b_assert_pass() {
  ASSERT_PASS=$((ASSERT_PASS + 1))
  printf 'ASSERT PASS: %s\n' "$*"
}

g1b_assert_fail() {
  ASSERT_FAIL=$((ASSERT_FAIL + 1))
  printf 'ASSERT FAIL: %s\n' "$*"
}

# g1b_assert_eq <expected> <actual> <description>
g1b_assert_eq() {
  local expected="$1" actual="$2" what="$3"
  if [ "$expected" = "$actual" ]; then
    g1b_assert_pass "$what ($actual)"
  else
    g1b_assert_fail "$what (expected '$expected', got '$actual')"
  fi
}

# g1b_assert_contains <haystack> <needle> <description>
g1b_assert_contains() {
  local haystack="$1" needle="$2" what="$3"
  case "$haystack" in
    *"$needle"*) g1b_assert_pass "$what" ;;
    *) g1b_assert_fail "$what (missing '$needle')" ;;
  esac
}

# g1b_assert_nonempty <value> <description>
g1b_assert_nonempty() {
  if [ -n "$1" ]; then
    g1b_assert_pass "$2 ($1)"
  else
    g1b_assert_fail "$2 (empty)"
  fi
}

# g1b_summary — print counters and return nonzero when any assertion failed.
g1b_summary() {
  printf 'ASSERT SUMMARY: pass=%s fail=%s\n' "$ASSERT_PASS" "$ASSERT_FAIL"
  [ "$ASSERT_FAIL" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Safety guards
# ---------------------------------------------------------------------------

# g1b_refuse_real_home <path>
#
# Resolve symlinks and '..' before comparing: the guard must inspect the real
# location a process would use, not the caller's spelling of it.  Exits 64 so
# "refused for safety" is distinguishable from an ordinary probe failure.
g1b_refuse_real_home() {
  local raw="${1:-}" resolved
  [ -n "$raw" ] || { printf 'g1b_common: REFUSED: empty path\n' >&2; exit 64; }
  resolved="$(readlink -f -- "$raw" 2>/dev/null)" || resolved="$raw"
  [ -n "$resolved" ] || resolved="$raw"
  case "$resolved" in
    "$REAL_OPERATOR_HOME"|"$REAL_OPERATOR_HOME"/*)
      printf 'g1b_common: REFUSED: path resolves into the real operator home (%s): %s\n' \
        "$REAL_OPERATOR_HOME" "$resolved" >&2
      exit 64
      ;;
  esac
}

# g1b_scratch <name>
#
# Create and print a disposable scratch root: mktemp -d under the scratch base.
# The root is NEVER removed — every fixture stays in place as evidence and the
# caller records its path.  The refusal guard runs on the base BEFORE creating
# anything, so a base spelling that resolves into the real operator home
# creates nothing there.
g1b_scratch() {
  local name="${1:-probe}" root
  case "$name" in
    *[!A-Za-z0-9._-]*) printf 'g1b_common: invalid scratch name: %s\n' "$name" >&2; return 2 ;;
  esac
  g1b_refuse_real_home "$G1B_TMP_ROOT"
  root="$(mktemp -d "$G1B_TMP_ROOT/g1b-$name.XXXXXX")" || return 2
  g1b_refuse_real_home "$root"
  printf '%s\n' "$root"
}

# ---------------------------------------------------------------------------
# Docker artifact facts
# ---------------------------------------------------------------------------

# g1b_image_id <ref> — image Id (sha256:...) or empty when unavailable.
g1b_image_id() {
  docker image inspect "${1:-$IMAGE_REF}" --format '{{.Id}}' 2>/dev/null
}

# g1b_image_facts <ref> — key=value lines for Id/Architecture/Os/RepoDigests.
g1b_image_facts() {
  local ref="${1:-$IMAGE_REF}"
  docker image inspect "$ref" \
    --format 'Id={{.Id}}
Architecture={{.Architecture}}
Os={{.Os}}
RepoDigests={{json .RepoDigests}}' 2>&1
}

# ---------------------------------------------------------------------------
# The one container gateway
# ---------------------------------------------------------------------------

# g1b_container_run <scratch-root> <bash-script>
#
# Every G1-B container invocation goes through here.  The flag set is fixed:
#   --rm                      no container survives the run
#   --network none            no network egress
#   --platform linux/amd64    the required platform
#   --user <uid>:<gid>        bind-mounted fixtures stay owned by the caller
#   -v <scratch>:/work        the ONLY mount, exactly the scratch root
#   -w /work
#   bash -c                   never `bash -lc` (login shell is unusable here)
#
# HOME points inside the scratch mount so the container's Hermes can never
# wander into an image-baked /root home.  G1B_CONTAINER_HOME may override it,
# but only with a path inside /work.
g1b_container_run() {
  local scratch="${1:-}" script="${2:-}"
  [ -n "$scratch" ] || { printf 'g1b_common: container_run requires a scratch root\n' >&2; return 2; }
  [ -n "$script" ] || { printf 'g1b_common: container_run requires a script\n' >&2; return 2; }
  [ -d "$scratch" ] || { printf 'g1b_common: scratch root does not exist: %s\n' "$scratch" >&2; return 2; }
  g1b_refuse_real_home "$scratch"

  local container_home="${G1B_CONTAINER_HOME:-/work/home}"
  case "$container_home" in
    /work|/work/*) ;;
    *) printf 'g1b_common: G1B_CONTAINER_HOME must be inside /work (got %s)\n' "$container_home" >&2; return 2 ;;
  esac

  # docker does not create the HOME destination; make it under the scratch root.
  local host_home="$scratch${container_home#/work}"
  mkdir -p -- "$host_home"

  printf 'CONTAINER_INVOCATION: docker run --rm --network none --platform %s --user %s:%s -v %s:/work -w /work -e HOME=%s %s bash -c <script>\n' \
    "$REQUIRED_PLATFORM" "$(id -u)" "$(id -g)" "$scratch" "$container_home" "$IMAGE_REF" >&2

  docker run --rm --network none --platform "$REQUIRED_PLATFORM" \
    --user "$(id -u):$(id -g)" \
    -e HOME="$container_home" \
    -v "$scratch:/work" -w /work \
    "$IMAGE_REF" bash -c "$script"
}

# ---------------------------------------------------------------------------
# read_header bootstrap
# ---------------------------------------------------------------------------

# g1b_bootstrap_read_header <scratch-root>
#
# Copy the single approved raw-header reader into <scratch>/tools/ and prove the
# copy is byte-identical to the parent file.  Journal format is measured ONLY
# with this reader's raw bytes 18/19 — never with a SQLite connection.
g1b_bootstrap_read_header() {
  local scratch="${1:-}" source want got
  source="$G1B_PARENT_READ_HEADER"
  [ -f "$source" ] || { printf 'g1b_common: read_header.py missing at %s\n' "$source" >&2; return 2; }
  [ -n "$scratch" ] && [ -d "$scratch" ] || { printf 'g1b_common: invalid scratch root\n' >&2; return 2; }

  mkdir -p -- "$scratch/tools"
  cp -- "$source" "$scratch/tools/read_header.py" || return 2
  want="$(sha256sum -- "$source" | awk '{print $1}')"
  got="$(sha256sum -- "$scratch/tools/read_header.py" | awk '{print $1}')"
  if [ "$want" != "$got" ]; then
    printf 'g1b_common: read_header bootstrap sha256 mismatch (parent %s, copy %s)\n' "$want" "$got" >&2
    return 2
  fi
  printf 'read_header bootstrap: %s sha256=%s\n' "$scratch/tools/read_header.py" "$got"
}
