#!/bin/bash
# probe_runtime_identity.sh — G1-B US-001: stock-runtime identity.
#
# Proves WHICH runtime the later G1-B probes exercise: the Docker artifact
# (id, architecture, OS, repo digest), the stock Hermes revision inside it (and
# that the checkout is clean), the launcher/interpreter that actually works, the
# embedded SQLite version, and that `resolve_journal_mode()` resolves the two
# config values G1-B depends on (`delete` and `wal`).
#
# Everything container-side runs through `g1b_container_run` (see
# g1b_common.sh): --rm --network none --platform linux/amd64 --user <uid>:<gid>
# -v <scratch>:/work -w /work and `bash -c`.  Nothing is installed, nothing is
# patched, and the real operator home is never read or mounted.
#
# Usage:
#   ./docs/gate/probes/g1b/probe_runtime_identity.sh
#
# Environment:
#   G1B_EVIDENCE_DIR   evidence directory (default docs/gate/evidence/g1b)
#   G1B_TMP_ROOT       scratch base (default /tmp); the scratch root is kept
#
# Exit status: 0 only when every assertion passed.

set -u

PROBES_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./g1b_common.sh
. "$PROBES_DIR/g1b_common.sh"

EVIDENCE_DIR="$G1B_EVIDENCE_DIR"
mkdir -p -- "$EVIDENCE_DIR"
OUT="${G1B_RUNTIME_IDENTITY_OUT:-$EVIDENCE_DIR/runtime-identity.txt}"

: > "$OUT"
log() { printf '%s\n' "$*" | tee -a "$OUT"; }

log "# G1-B US-001 — stock-runtime identity"
log "# generated (UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
log ""

ROOT="$(g1b_scratch runtime-identity)" || { printf 'g1b: cannot create scratch root\n' >&2; exit 2; }
g1b_refuse_real_home "$ROOT"
log "SCRATCH_ROOT=$ROOT"
log "SCRATCH_ROOT_KEPT=yes (G1-B never deletes its fixtures)"
log ""

# ---------------------------------------------------------------------------
# Host-side: the docker artifact (tag -> image id mapping)
# ---------------------------------------------------------------------------
log "## Host-side docker artifact facts"
log ""
for ref in "$IMAGE_REF" "igorhvr/tamandua:amd64"; do
  facts="$(g1b_image_facts "$ref")"
  facts_rc=$?
  log "IMAGE_REF=$ref"
  log "TAG_MAPPING $ref -> $(g1b_image_id "$ref")"
  while IFS= read -r line; do
    [ -n "$line" ] && log "  $line"
  done <<< "$facts"
  log "  docker_image_inspect_rc=$facts_rc"
  log ""
done

host_image_id="$(g1b_image_id "$IMAGE_REF")"
host_arch="$(docker image inspect "$IMAGE_REF" --format '{{.Architecture}}' 2>/dev/null)"
host_os="$(docker image inspect "$IMAGE_REF" --format '{{.Os}}' 2>/dev/null)"
log "REQUIRED_IMAGE_ID=$REQUIRED_IMAGE_ID"
log "REQUIRED_ARCH=$REQUIRED_ARCH"
log "REQUIRED_OS=$REQUIRED_OS"
log "MATCHLOCK_ARTIFACT_ID=$MATCHLOCK_ARTIFACT_ID"
log "MATCHLOCK_ARTIFACT_RELATIONSHIP=UNVERIFIED (no equality claim)"
log ""

g1b_assert_eq "$REQUIRED_IMAGE_ID" "$host_image_id" "docker image Id matches the identified artifact"
g1b_assert_eq "$REQUIRED_ARCH" "$host_arch" "docker image architecture"
g1b_assert_eq "$REQUIRED_OS" "$host_os" "docker image OS"
g1b_assert_eq "$MATCHLOCK_ARTIFACT_ID" "$(g1b_image_id igorhvr/tamandua:amd64)" \
  "igorhvr/tamandua:amd64 resolves to the Matchlock artifact (recorded, relationship still UNVERIFIED)"

# ---------------------------------------------------------------------------
# Fixture config homes (inside the scratch root; container path is /work/...)
# ---------------------------------------------------------------------------
mkdir -p -- "$ROOT/home" "$ROOT/home-delete" "$ROOT/home-wal"
printf 'database:\n  journal_mode: delete\n' > "$ROOT/home-delete/config.yaml"
printf 'database:\n  journal_mode: wal\n' > "$ROOT/home-wal/config.yaml"

# ---------------------------------------------------------------------------
# Container-side: the runtime that actually executes
# ---------------------------------------------------------------------------
log "## Container-side runtime identity"
log ""

container_script="$(cat <<'CONTAINER_SCRIPT'
set -u

git_rev="$(git -c safe.directory=/opt/src/hermes-agent -C /opt/src/hermes-agent rev-parse HEAD 2>&1)"
git_rev_rc=$?
printf 'GIT_REVISION=%s\n' "$git_rev"
printf 'GIT_REVISION_RC=%s\n' "$git_rev_rc"

git_status="$(git -c safe.directory=/opt/src/hermes-agent -C /opt/src/hermes-agent status --porcelain 2>&1)"
git_status_rc=$?
if [ -z "$git_status" ]; then
  printf 'GIT_STATUS_PORCELAIN_EMPTY=yes\n'
else
  printf 'GIT_STATUS_PORCELAIN_EMPTY=no\n'
  printf '%s\n' "$git_status"
fi
printf 'GIT_STATUS_RC=%s\n' "$git_status_rc"

hermes_version="$(/usr/local/bin/hermes --version 2>/dev/null)"
hermes_version_rc=$?
printf 'HERMES_VERSION=%s\n' "$(printf '%s\n' "$hermes_version" | head -n 1)"
printf 'HERMES_VERSION_RC=%s\n' "$hermes_version_rc"
printf 'HERMES_BIN=%s\n' "/usr/local/bin/hermes"
printf 'HERMES_BIN_EXISTS=%s\n' "$([ -x /usr/local/bin/hermes ] && echo yes || echo no)"

python_version="$(/opt/src/hermes-venv/bin/python --version 2>&1)"
python_version_rc=$?
printf 'PYTHON_VERSION=%s\n' "$python_version"
printf 'PYTHON_VERSION_RC=%s\n' "$python_version_rc"
printf 'PYTHON_BIN=%s\n' "/opt/src/hermes-venv/bin/python"

sqlite_version="$(/opt/src/hermes-venv/bin/python -c 'import sqlite3; print(sqlite3.sqlite_version)' 2>&1)"
sqlite_version_rc=$?
printf 'SQLITE_VERSION=%s\n' "$sqlite_version"
printf 'SQLITE_VERSION_RC=%s\n' "$sqlite_version_rc"

import_out="$(/opt/src/hermes-venv/bin/python -c 'import hermes_state, sqlite3; print("IMPORT_OK")' 2>&1)"
import_rc=$?
printf 'IMPORT_HERMES_STATE=%s\n' "$(printf '%s\n' "$import_out" | tail -n 1)"
printf 'IMPORT_HERMES_STATE_RC=%s\n' "$import_rc"

cgroup="$(cat /proc/1/cgroup 2>&1)"
printf 'PROC_1_CGROUP=%s\n' "$(printf '%s\n' "$cgroup" | tr '\n' ';')"

resolved_delete="$(HERMES_HOME=/work/home-delete /opt/src/hermes-venv/bin/python -c 'import hermes_state_wal as w; print(w.resolve_journal_mode())' 2>&1)"
resolved_delete_rc=$?
printf 'RESOLVED_DELETE=%s\n' "$(printf '%s\n' "$resolved_delete" | tail -n 1)"
printf 'RESOLVED_DELETE_RC=%s\n' "$resolved_delete_rc"

resolved_wal="$(HERMES_HOME=/work/home-wal /opt/src/hermes-venv/bin/python -c 'import hermes_state_wal as w; print(w.resolve_journal_mode())' 2>&1)"
resolved_wal_rc=$?
printf 'RESOLVED_WAL=%s\n' "$(printf '%s\n' "$resolved_wal" | tail -n 1)"
printf 'RESOLVED_WAL_RC=%s\n' "$resolved_wal_rc"
CONTAINER_SCRIPT
)"

container_log="$ROOT/runtime-identity.container.log"
g1b_container_run "$ROOT" "$container_script" > "$container_log" 2>&1
container_rc=$?

while IFS= read -r line; do
  [ -n "$line" ] && log "$line"
done < "$container_log"
log "CONTAINER_RC=$container_rc"
log ""

field() {
  grep -m1 "^$1=" "$container_log" | cut -d= -f2-
}

g1b_assert_eq "0" "$container_rc" "container runtime-identity run exit status"

git_revision="$(field GIT_REVISION)"
g1b_assert_eq "$REQUIRED_HERMES_REVISION" "$git_revision" "stock Hermes revision inside the image"
g1b_assert_eq "0" "$(field GIT_REVISION_RC)" "git rev-parse exit status"

g1b_assert_eq "yes" "$(field GIT_STATUS_PORCELAIN_EMPTY)" "stock Hermes checkout is clean (git status --porcelain empty)"
g1b_assert_eq "0" "$(field GIT_STATUS_RC)" "git status exit status"

hermes_version="$(field HERMES_VERSION)"
g1b_assert_contains "$hermes_version" "Hermes Agent" "hermes --version reports Hermes Agent"
g1b_assert_eq "0" "$(field HERMES_VERSION_RC)" "hermes --version exit status"
g1b_assert_eq "yes" "$(field HERMES_BIN_EXISTS)" "/usr/local/bin/hermes launcher exists and is executable"

python_version="$(field PYTHON_VERSION)"
g1b_assert_contains "$python_version" "Python 3." "venv python version"
g1b_assert_eq "0" "$(field PYTHON_VERSION_RC)" "python --version exit status"

sqlite_version="$(field SQLITE_VERSION)"
g1b_assert_nonempty "$sqlite_version" "embedded sqlite3 version"
g1b_assert_eq "0" "$(field SQLITE_VERSION_RC)" "sqlite version query exit status"

g1b_assert_eq "IMPORT_OK" "$(field IMPORT_HERMES_STATE)" "venv python can import hermes_state and sqlite3"
g1b_assert_eq "0" "$(field IMPORT_HERMES_STATE_RC)" "import exit status"

g1b_assert_nonempty "$(field PROC_1_CGROUP)" "/proc/1/cgroup recorded (execution context)"

g1b_assert_eq "delete" "$(field RESOLVED_DELETE)" "resolve_journal_mode() under database.journal_mode: delete"
g1b_assert_eq "0" "$(field RESOLVED_DELETE_RC)" "resolve_journal_mode(delete) exit status"
g1b_assert_eq "wal" "$(field RESOLVED_WAL)" "resolve_journal_mode() under database.journal_mode: wal"
g1b_assert_eq "0" "$(field RESOLVED_WAL_RC)" "resolve_journal_mode(wal) exit status"

# ---------------------------------------------------------------------------
# read_header bootstrap (journal format is read ONLY from raw header bytes)
# ---------------------------------------------------------------------------
log "## read_header bootstrap"
bootstrap_out="$(g1b_bootstrap_read_header "$ROOT" 2>&1)"
bootstrap_rc=$?
log "$bootstrap_out"
log "READ_HEADER_BOOTSTRAP_RC=$bootstrap_rc"
log ""
g1b_assert_eq "0" "$bootstrap_rc" "read_header.py bootstrap copy matches the parent file sha256"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
log "## Summary"
log "IMAGE_ID=$host_image_id"
log "ARCH=$host_arch"
log "OS=$host_os"
log "HERMES_REVISION=$git_revision"
log "SCRATCH_ROOT=$ROOT"
log "SCRATCH_ROOT_KEPT=yes"
log ""

if g1b_summary | tee -a "$OUT"; then
  exit 0
fi
exit 1
