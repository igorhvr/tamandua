#!/bin/bash
# seed_stores.sh — G1-B US-002: in-image WAL seeding harness.
#
# Creates each of the four Hermes stores inside the PUBLISHED image under
# `database.journal_mode: wal`, using the store's REAL writer twice with two
# unique, identifiable markers, and records everything the later delete-mode
# probes need to prove PERSISTENCE OF SPECIFIC ROWS.
#
# Per store (all fixtures under one mktemp scratch root, never deleted):
#
#   1. fresh home with config.yaml `database.journal_mode: wal`
#      (verification_evidence.db's home additionally enables `agent.verify_on_stop`);
#   2. the store's real writer, run TWICE with markers
#      `g1b-<store>-<probe-runid>-1` and `-2`; the writer prints the marker and
#      the store's own record id (session id / event id / task id / project id);
#   3. raw header bytes 18/19 read ONLY by read_header.py after EACH writer close
#      (must be 2,2 -> wal), plus size, sha256 and all three sidecar states
#      (-wal, -shm, -journal);
#   4. a baseline read-only check: both written markers are present, and a marker
#      that was NEVER written is ABSENT;
#   5. the stock-purity check (Hermes revision unchanged, `git status --porcelain`
#      empty) around the runs.
#
# Journal format is measured from raw header bytes only.  The read-only SQLite
# connections exist solely for the persistence assertions.
#
# Usage:
#   ./docs/gate/probes/g1b/seed_stores.sh
#
# Environment:
#   G1B_EVIDENCE_DIR  evidence directory (default docs/gate/evidence/g1b)
#   G1B_TMP_ROOT      scratch base (default /tmp); the scratch root is KEPT
#   G1B_SEED_RUNID    marker run id (default <utc timestamp>-<shell pid>)
#
# Exit status: 0 only when every assertion passed.

set -u

PROBES_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./g1b_common.sh
. "$PROBES_DIR/g1b_common.sh"

EVIDENCE_DIR="$G1B_EVIDENCE_DIR"
mkdir -p -- "$EVIDENCE_DIR"
OUT="${G1B_SEED_OUT:-$EVIDENCE_DIR/store-seeding.txt}"

: > "$OUT"
log() { printf '%s\n' "$*" | tee -a "$OUT"; }

log "# G1-B US-002 — in-image WAL seeding harness with unique marker records"
log "# generated (UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
log ""

ROOT="$(g1b_scratch store-seeding)" || { printf 'g1b: cannot create scratch root\n' >&2; exit 2; }
g1b_refuse_real_home "$ROOT"
mkdir -p -- "$ROOT/tools" "$ROOT/logs"
log "SCRATCH_ROOT=$ROOT"
log "SCRATCH_ROOT_KEPT=yes (G1-B never deletes its fixtures)"
log ""

PROBE_RUNID="${G1B_SEED_RUNID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
log "PROBE_RUNID=$PROBE_RUNID"
log "MARKER_SCHEME=g1b-<store>-<probe-runid>-<n>"
log ""

# ---------------------------------------------------------------------------
# Artifact identity (must be the identified published image)
# ---------------------------------------------------------------------------
log "## Docker artifact"
log "IMAGE_REF=$IMAGE_REF"
host_image_id="$(g1b_image_id "$IMAGE_REF")"
host_arch="$(docker image inspect "$IMAGE_REF" --format '{{.Architecture}}' 2>/dev/null)"
host_os="$(docker image inspect "$IMAGE_REF" --format '{{.Os}}' 2>/dev/null)"
log "IMAGE_ID=$host_image_id"
log "ARCH=$host_arch"
log "OS=$host_os"
log "REQUIRED_IMAGE_ID=$REQUIRED_IMAGE_ID"
log "REQUIRED_HERMES_REVISION=$REQUIRED_HERMES_REVISION"
log "MATCHLOCK_ARTIFACT_ID=$MATCHLOCK_ARTIFACT_ID"
log "MATCHLOCK_ARTIFACT_RELATIONSHIP=UNVERIFIED (no equality claim)"
log ""
g1b_assert_eq "$REQUIRED_IMAGE_ID" "$host_image_id" "docker image Id matches the identified artifact"
g1b_assert_eq "$REQUIRED_ARCH" "$host_arch" "docker image architecture"
g1b_assert_eq "$REQUIRED_OS" "$host_os" "docker image OS"

# ---------------------------------------------------------------------------
# Tools: the raw-header reader plus this story's writers/checker, copied into
# the scratch root and pinned by sha256 against the repository copies.
# ---------------------------------------------------------------------------
log "## Probe tools (pinned by sha256)"
log ""
bootstrap_out="$(g1b_bootstrap_read_header "$ROOT" 2>&1)"
bootstrap_rc=$?
log "$bootstrap_out"
log "READ_HEADER_BOOTSTRAP_RC=$bootstrap_rc"
g1b_assert_eq "0" "$bootstrap_rc" "read_header.py bootstrap copy matches the parent file sha256"

for tool in g1b_writers.py g1b_readonly.py g1b_seed_container.sh; do
  src="$PROBES_DIR/$tool"
  dest="$ROOT/tools/$tool"
  cp -- "$src" "$dest" || { g1b_assert_fail "copy $tool into the scratch root"; continue; }
  want="$(sha256sum -- "$src" | awk '{print $1}')"
  got="$(sha256sum -- "$dest" | awk '{print $1}')"
  log "TOOL $dest sha256=$got"
  g1b_assert_eq "$want" "$got" "$tool copy matches the repository file sha256"
done
log ""

# ---------------------------------------------------------------------------
# Per-store seeding
# ---------------------------------------------------------------------------
STORE_KEYS=(state verification kanban projects)
store_db_name() {
  case "$1" in
    state) echo "state.db" ;;
    verification) echo "verification_evidence.db" ;;
    kanban) echo "kanban.db" ;;
    projects) echo "projects.db" ;;
    *) return 1 ;;
  esac
}

for store in "${STORE_KEYS[@]}"; do
  db="$(store_db_name "$store")" || { g1b_assert_fail "unknown store key $store"; continue; }
  marker1="g1b-$store-$PROBE_RUNID-1"
  marker2="g1b-$store-$PROBE_RUNID-2"
  absent="g1b-$store-$PROBE_RUNID-never-written"

  case "$marker1$marker2$absent" in
    *[!A-Za-z0-9._-]*) g1b_assert_fail "marker contains characters unsafe for the container argv"; continue ;;
  esac

  container_log="$ROOT/logs/$store.container.log"

  log ""
  log "## Store $db"
  log ""
  log "STORE_KEY=$store"
  log "STORE_HOME=$ROOT/homes/$store (container /work/homes/$store)"
  log "CONFIG_EXPECTED=database.journal_mode: wal"
  log "MARKER_1=$marker1"
  log "MARKER_2=$marker2"
  log "NOT_WRITTEN_MARKER=$absent"
  log "CONTAINER_LOG=$container_log"
  log ""

  g1b_container_run "$ROOT" \
    "bash /work/tools/g1b_seed_container.sh $store $db $marker1 $marker2 $absent" \
    > "$container_log" 2>&1
  container_rc=$?
  log "CONTAINER_RC=$container_rc"
  log ""
  while IFS= read -r line; do
    [ -n "$line" ] && log "  $line"
  done < "$container_log"
  log ""

  field() { grep -m1 "^$1=" "$container_log" | cut -d= -f2-; }

  log "STORE_SUMMARY $db:"
  log "  RECORD_1 table=$(field RECORD1_TABLE) column=$(field RECORD1_COLUMN) id=$(field RECORD1_ID) title=$(field RECORD1_TITLE) slug=$(field RECORD1_SLUG)"
  log "  RECORD_2 table=$(field RECORD2_TABLE) column=$(field RECORD2_COLUMN) id=$(field RECORD2_ID) title=$(field RECORD2_TITLE) slug=$(field RECORD2_SLUG)"
  log "  HEADER_AFTER_RUN_1 bytes=$(field SEED1_BYTE18),$(field SEED1_BYTE19) mode=$(field SEED1_MODE) size=$(field SEED1_SIZE) sha256=$(field SEED1_SHA256)"
  log "  HEADER_AFTER_RUN_2 bytes=$(field SEED2_BYTE18),$(field SEED2_BYTE19) mode=$(field SEED2_MODE) size=$(field SEED2_SIZE) sha256=$(field SEED2_SHA256)"
  log "  SIDECARS_AFTER_RUN_1 -wal=$(field SEED1_SIDECAR_WAL_STATE) -shm=$(field SEED1_SIDECAR_SHM_STATE) -journal=$(field SEED1_SIDECAR_JOURNAL_STATE)"
  log "  SIDECARS_AFTER_RUN_2 -wal=$(field SEED2_SIDECAR_WAL_STATE) -shm=$(field SEED2_SIDECAR_SHM_STATE) -journal=$(field SEED2_SIDECAR_JOURNAL_STATE)"
  log "  STOCK_PURITY revision=$(field STOCK_REVISION) porcelain_empty=$(field STOCK_STATUS_PORCELAIN_EMPTY) after_revision=$(field STOCK_AFTER_REVISION) after_porcelain_empty=$(field STOCK_AFTER_STATUS_PORCELAIN_EMPTY)"
  log ""

  g1b_assert_eq "0" "$container_rc" "$db seeding container exit status"
  g1b_assert_eq "wal" "$(field RESOLVED_MODE)" "$db fixture config resolves to wal before any writer"
  g1b_assert_eq "0" "$(field RESOLVED_MODE_RC)" "$db resolved-mode read exit status"

  g1b_assert_eq "yes" "$(field SEED1_EXISTS)" "$db exists after real writer run 1"
  g1b_assert_eq "0" "$(field WRITER1_EXIT)" "$db real writer run 1 exit status"
  g1b_assert_eq "yes" "$(field SEED2_EXISTS)" "$db exists after real writer run 2"
  g1b_assert_eq "0" "$(field WRITER2_EXIT)" "$db real writer run 2 exit status"

  g1b_assert_eq "2" "$(field SEED1_BYTE18)" "$db header byte18 after writer run 1 (2 = wal)"
  g1b_assert_eq "2" "$(field SEED1_BYTE19)" "$db header byte19 after writer run 1 (2 = wal)"
  g1b_assert_eq "wal" "$(field SEED1_MODE)" "$db raw header mode after writer run 1"
  g1b_assert_eq "2" "$(field SEED2_BYTE18)" "$db header byte18 after writer run 2 (2 = wal)"
  g1b_assert_eq "2" "$(field SEED2_BYTE19)" "$db header byte19 after writer run 2 (2 = wal)"
  g1b_assert_eq "wal" "$(field SEED2_MODE)" "$db raw header mode after writer run 2"

  g1b_assert_nonempty "$(field SEED1_SIZE)" "$db size recorded after writer run 1"
  g1b_assert_nonempty "$(field SEED1_SHA256)" "$db sha256 recorded after writer run 1"
  g1b_assert_nonempty "$(field SEED2_SIZE)" "$db size recorded after writer run 2"
  g1b_assert_nonempty "$(field SEED2_SHA256)" "$db sha256 recorded after writer run 2"

  for sidecar in WAL SHM JOURNAL; do
    g1b_assert_nonempty "$(field SEED1_SIDECAR_${sidecar}_STATE)" "$db -${sidecar,,} sidecar state recorded after run 1"
    g1b_assert_nonempty "$(field SEED2_SIDECAR_${sidecar}_STATE)" "$db -${sidecar,,} sidecar state recorded after run 2"
  done

  g1b_assert_nonempty "$(field RECORD1_ID)" "$db identifiable record id from writer run 1"
  g1b_assert_nonempty "$(field RECORD2_ID)" "$db identifiable record id from writer run 2"
  g1b_assert_nonempty "$(field RECORD1_TABLE)" "$db identifiable record table from writer run 1"

  g1b_assert_eq "0" "$(field READONLY_MARK1_EXIT)" "$db read-only marker-1 connection exit status"
  g1b_assert_eq "1" "$(field READONLY_MARK1_TABLE_COUNT)" \
    "$db marker 1 row count in $(field RECORD1_TABLE) (read-only)"
  g1b_assert_eq "0" "$(field READONLY_MARK2_EXIT)" "$db read-only marker-2 connection exit status"
  g1b_assert_eq "1" "$(field READONLY_MARK2_TABLE_COUNT)" \
    "$db marker 2 row count in $(field RECORD2_TABLE) (read-only)"
  g1b_assert_eq "0" "$(field READONLY_NOTWRITTEN_TOTAL)" \
    "$db not-yet-written marker is ABSENT (read-only baseline)"

  g1b_assert_eq "$REQUIRED_HERMES_REVISION" "$(field STOCK_REVISION)" \
    "$db stock Hermes revision before the writer runs"
  g1b_assert_eq "yes" "$(field STOCK_STATUS_PORCELAIN_EMPTY)" \
    "$db stock Hermes checkout clean before the writer runs"
  g1b_assert_eq "$REQUIRED_HERMES_REVISION" "$(field STOCK_AFTER_REVISION)" \
    "$db stock Hermes revision unchanged after the writer runs"
  g1b_assert_eq "yes" "$(field STOCK_AFTER_STATUS_PORCELAIN_EMPTY)" \
    "$db stock Hermes checkout still clean after the writer runs"
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
log ""
log "## Summary"
log "SCRATCH_ROOT=$ROOT"
log "SCRATCH_ROOT_KEPT=yes"
log "PROBE_RUNID=$PROBE_RUNID"
log "STORES_SEEDED=${STORE_KEYS[*]}"
log "IMAGE_ID=$host_image_id"
log "ARCH=$host_arch"
log "OS=$host_os"
log ""

summary_out="$(g1b_summary)"
summary_rc=$?
printf '%s\n' "$summary_out" | tee -a "$OUT"
if [ "$summary_rc" -eq 0 ]; then
  exit 0
fi
exit 1
