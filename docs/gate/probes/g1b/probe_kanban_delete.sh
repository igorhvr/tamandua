#!/bin/bash
# probe_kanban_delete.sh — G1-B US-005: the decisive delete-mode experiment for
# `kanban.db`, run against the PUBLISHED IMAGE's stock Hermes.
#
# `kanban.db` is the OPTIONAL kanban board store. It is gated by USE: a default
# session never touches it, so the writer must be the real trigger
# `hermes kanban create "<marker>"` (committing a task row). `kanban list` is
# NOT acceptable — it commits no record, so it could not support the bead's
# persistence assertion. The probe therefore creates TWO tasks with distinct
# marker titles and, after each writer closes, proves that exact task row exists
# through a SEPARATE read-only connection.
#
# Path resolution recorded by the probe (stage 0), because it decides where the
# fixture store must be placed:
#
#   kanban_home() = HERMES_KANBAN_HOME else get_default_hermes_root()
#   default board = <kanban_home>/kanban.db
#
# and the board root is shared across profiles BY DESIGN: a named profile's
# `HERMES_HOME=<root>/profiles/<name>` still resolves the board to
# `<root>/kanban.db` (resolving through the active profile would fork the board
# per profile and break the dispatcher/worker handoff). The probe uses a
# DEFAULT-PROFILE fixture root — `HERMES_HOME` IS the board root — so the store
# is `<fixture home>/kanban.db`, and it leaves `HERMES_KANBAN_HOME`,
# `HERMES_KANBAN_DB` and `HERMES_KANBAN_BOARD` unset so neither the override nor
# a non-default board can redirect it.
#
# The probe is fully containerized: one `mktemp -d /tmp/g1b-kanban-delete.XXXXXX`
# root is bind-mounted at /work and every command runs inside the image through
# the single `g1b_container_run` gateway. Per stage:
#
#   0. PATH      kanban path resolution proof (see above).
#   1. SEED      real WAL store via the real trigger under
#                `database.journal_mode: wal`; raw header bytes must be 2,2.
#   2. COPY      `cp -a` aside; sha256 + `cmp -s` prove byte identity.
#   3. CONVERT   `hermes sessions set-journal-mode delete --db <copy>` on the
#                COPY only; header must be 1,1 and the original sha256 unchanged.
#   4. DELETE    a fresh `cp -a` of the converted copy in a home whose config
#                resolves to delete; the real trigger runs TWICE with two
#                distinct markers. After EACH close the raw header must be 1,1,
#                all three sidecars must be absent, and a SEPARATE read-only
#                connection must find that run's `tasks` row (absent before it
#                ran).
#   5. CONTROL   the SAME converted copy under a config resolving to wal must
#                become 2,2 (proving delete was honoured, not immovable).
#
# Journal format is measured ONLY with read_header.py (raw header bytes 18/19).
# The read-only SQLite connections exist solely for the persistence assertion.
#
# Usage:
#   ./docs/gate/probes/g1b/probe_kanban_delete.sh
#
# Environment:
#   G1B_EVIDENCE_DIR       evidence directory (default docs/gate/evidence/g1b)
#   G1B_TMP_ROOT           scratch base (default /tmp); the scratch root is KEPT
#   G1B_KANBAN_RUNID       marker run id (default <utc timestamp>-<shell pid>)
#   G1B_KANBAN_DELETE_OUT  write the evidence to this path instead of the
#                          committed evidence file (re-verification without
#                          regenerating pinned evidence)
#
# Exit status: 0 only when the store is HONOURING and every assertion passed.
# A demonstrable NOT-HONOURING result is a BLOCKER: the scratch root is kept as
# the reproducer, the evidence records it, and the probe exits nonzero.

set -u

PROBES_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./g1b_common.sh
. "$PROBES_DIR/g1b_common.sh"

EVIDENCE_DIR="$G1B_EVIDENCE_DIR"
mkdir -p -- "$EVIDENCE_DIR"
OUT="${G1B_KANBAN_DELETE_OUT:-$EVIDENCE_DIR/kanban-delete.txt}"

: > "$OUT"
log() { printf '%s\n' "$*" | tee -a "$OUT"; }

log "# G1-B US-005 — offline conversion persistence for kanban.db (delete mode)"
log "# generated (UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "# store identity: kanban.db = OPTIONAL kanban board store, the DEFAULT board at kanban_home()/kanban.db"
log "# store path resolution: kanban_home() = HERMES_KANBAN_HOME else get_default_hermes_root(); the board root is shared across profiles BY DESIGN"
log "# store trigger: the real \`hermes kanban create \"<marker>\"\` (kanban list commits no record and is NOT the writer)"
log ""

ROOT="$(g1b_scratch kanban-delete)" || { printf 'g1b: cannot create scratch root\n' >&2; exit 2; }
g1b_refuse_real_home "$ROOT"
mkdir -p -- "$ROOT/tools" "$ROOT/logs"
log "SCRATCH_ROOT=$ROOT"
log "SCRATCH_ROOT_KEPT=yes (G1-B never deletes its fixtures; this is the reproducer on a BLOCKER)"
log ""

PROBE_RUNID="${G1B_KANBAN_RUNID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
MARK_SEED="g1b-kanban-$PROBE_RUNID-seed"
MARK1="g1b-kanban-$PROBE_RUNID-1"
MARK2="g1b-kanban-$PROBE_RUNID-2"
MARK_CONTROL="g1b-kanban-$PROBE_RUNID-control"
MARK_ABSENT="g1b-kanban-$PROBE_RUNID-never-written"
log "PROBE_RUNID=$PROBE_RUNID"
log "MARKER_SCHEME=g1b-kanban-<probe-runid>-{seed,1,2,control,never-written}"
log "MARKER_SEED=$MARK_SEED"
log "MARKER_1=$MARK1"
log "MARKER_2=$MARK2"
log "MARKER_CONTROL=$MARK_CONTROL"
log "MARKER_NEVER_WRITTEN=$MARK_ABSENT"
log ""

case "$MARK_SEED$MARK1$MARK2$MARK_CONTROL$MARK_ABSENT" in
  *[!A-Za-z0-9._-]*) printf 'g1b: marker contains unsafe characters\n' >&2; exit 2 ;;
esac

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
# Tools pinned by sha256 (read_header.py + this story's writers/checker/driver)
# ---------------------------------------------------------------------------
log ""
log "## Probe tools (pinned by sha256)"
log ""
bootstrap_out="$(g1b_bootstrap_read_header "$ROOT" 2>&1)"
bootstrap_rc=$?
log "$bootstrap_out"
log "READ_HEADER_BOOTSTRAP_RC=$bootstrap_rc"
g1b_assert_eq "0" "$bootstrap_rc" "read_header.py bootstrap copy matches the parent file sha256"

for tool in g1b_writers.py g1b_readonly.py g1b_kanban_delete_container.sh; do
  src="$PROBES_DIR/$tool"
  dest="$ROOT/tools/$tool"
  cp -- "$src" "$dest" || { g1b_assert_fail "copy $tool into the scratch root"; continue; }
  want="$(sha256sum -- "$src" | awk '{print $1}')"
  got="$(sha256sum -- "$dest" | awk '{print $1}')"
  log "TOOL $dest sha256=$got"
  g1b_assert_eq "$want" "$got" "$tool copy matches the repository file sha256"
done

# ---------------------------------------------------------------------------
# The single container run
# ---------------------------------------------------------------------------
container_log="$ROOT/logs/kanban-delete.container.log"
log ""
log "## Container run (single gateway)"
log "CONTAINER_LOG=$container_log"
log ""

g1b_container_run "$ROOT" \
  "bash /work/tools/g1b_kanban_delete_container.sh $MARK_SEED $MARK1 $MARK2 $MARK_CONTROL $MARK_ABSENT" \
  > "$container_log" 2>&1
container_rc=$?
log "CONTAINER_RC=$container_rc"
log ""
while IFS= read -r line; do
  [ -n "$line" ] && log "  $line"
done < "$container_log"
log ""

field() { grep -m1 "^$1=" "$container_log" | cut -d= -f2-; }

# ro_block <label> — the read-only checker output for one labelled check, from
# its `RO_<label>_CMD=` line through `RO_<label>_MATCHED_TABLES=`; used to pin
# the exact SQL text and the ?mode=ro open URI next to the count they produced.
ro_block() {
  awk -v start="RO_$1_CMD=" -v end="RO_$1_MATCHED_TABLES=" '
    index($0, start) == 1 { on = 1 }
    on { print }
    on && index($0, end) == 1 { exit }
  ' "$container_log"
}

# sidecars <prefix> — "-wal,-shm,-journal" states for one stage.
sidecars() {
  printf -- '-wal=%s,-shm=%s,-journal=%s' \
    "$(field "$1_SIDECAR_WAL_STATE")" \
    "$(field "$1_SIDECAR_SHM_STATE")" \
    "$(field "$1_SIDECAR_JOURNAL_STATE")"
}

g1b_assert_eq "0" "$container_rc" "kanban.db delete-mode container exit status"
g1b_assert_eq "$REQUIRED_HERMES_REVISION" "$(field STOCK_REVISION)" \
  "stock Hermes revision before the runs"
g1b_assert_eq "yes" "$(field STOCK_STATUS_PORCELAIN_EMPTY)" \
  "stock Hermes checkout clean before the runs"
g1b_assert_eq "$REQUIRED_HERMES_REVISION" "$(field STOCK_AFTER_REVISION)" \
  "stock Hermes revision unchanged after the runs"
g1b_assert_eq "yes" "$(field STOCK_AFTER_STATUS_PORCELAIN_EMPTY)" \
  "stock Hermes checkout still clean after the runs"
log "STOCK_PURITY revision=$(field STOCK_REVISION) porcelain_empty=$(field STOCK_STATUS_PORCELAIN_EMPTY) after_revision=$(field STOCK_AFTER_REVISION) after_porcelain_empty=$(field STOCK_AFTER_STATUS_PORCELAIN_EMPTY)"

# ---------------------------------------------------------------------------
# Stage 0 — kanban path resolution (recorded BEFORE any writer runs)
# ---------------------------------------------------------------------------
log ""
log "## Stage 0 — kanban path resolution (kanban_home() / get_default_hermes_root())"
log "KANBAN_RESOLUTION_RULE=kanban_home() = HERMES_KANBAN_HOME else get_default_hermes_root(); default board = <kanban_home>/kanban.db"
log "KANBAN_SHARED_ROOT_NUANCE=the board root is shared across profiles BY DESIGN: a named profile HERMES_HOME=<root>/profiles/<name> resolves the board to <root>/kanban.db, never a per-profile store"
log "KANBAN_FIXTURE_ROOT_KIND=default-profile fixture root (HERMES_HOME IS the board root)"
log "DEFAULT_PROFILE_HERMES_HOME=$(field SEED_HOME)"
log "DEFAULT_PROFILE_ROOT=$(field DEFAULT_PROFILE_PATH_ROOT)"
log "DEFAULT_PROFILE_KANBAN_HOME=$(field DEFAULT_PROFILE_PATH_KANBAN_HOME)"
log "DEFAULT_PROFILE_KANBAN_DB=$(field DEFAULT_PROFILE_PATH_DB)"
log "DEFAULT_PROFILE_BOARDS_ROOT=$(field DEFAULT_PROFILE_PATH_BOARDS_ROOT)"
log "DEFAULT_PROFILE_CURRENT_BOARD=$(field DEFAULT_PROFILE_PATH_CURRENT_BOARD)"
log "NAMED_PROFILE_HERMES_HOME=$(field PROFILE_HOME)"
log "NAMED_PROFILE_ROOT=$(field NAMED_PROFILE_PATH_ROOT)"
log "NAMED_PROFILE_KANBAN_HOME=$(field NAMED_PROFILE_PATH_KANBAN_HOME)"
log "NAMED_PROFILE_KANBAN_DB=$(field NAMED_PROFILE_PATH_DB)"
log "KANBAN_ENV_OVERRIDES_UNSET=$(field KANBAN_ENV_OVERRIDES_UNSET)"
log "KANBAN_FIXTURE_IS_DEFAULT_PROFILE_ROOT=$(field KANBAN_FIXTURE_IS_DEFAULT_PROFILE_ROOT)"
g1b_assert_eq "0" "$(field DEFAULT_PROFILE_PATH_PROBE_RC)" "default-profile path probe exit status"
g1b_assert_eq "$(field SEED_HOME)" "$(field DEFAULT_PROFILE_PATH_ROOT)" \
  "the default-profile fixture home IS its own default hermes root"
g1b_assert_eq "$(field SEED_HOME)" "$(field DEFAULT_PROFILE_PATH_KANBAN_HOME)" \
  "kanban_home() resolves to the default-profile fixture root"
g1b_assert_eq "$(field SEED_HOME)/kanban.db" "$(field DEFAULT_PROFILE_PATH_DB)" \
  "the default board store resolves to <fixture home>/kanban.db"
g1b_assert_eq "default" "$(field DEFAULT_PROFILE_PATH_CURRENT_BOARD)" \
  "the fixture board is the DEFAULT board (no board switch file needed)"
g1b_assert_eq "yes" "$(field KANBAN_FIXTURE_IS_DEFAULT_PROFILE_ROOT)" \
  "the fixture home is a default-profile root (not a named profile)"
g1b_assert_eq "yes" "$(field KANBAN_ENV_OVERRIDES_UNSET)" \
  "HERMES_KANBAN_HOME/HERMES_KANBAN_DB/HERMES_KANBAN_BOARD are unset (no override, no named board)"
g1b_assert_eq "0" "$(field NAMED_PROFILE_PATH_PROBE_RC)" "named-profile path probe exit status"
g1b_assert_eq "$(field NAMED_PROFILE_PATH_ROOT)" "$(field NAMED_PROFILE_PATH_KANBAN_HOME)" \
  "a named profile's board resolves to the SHARED root, not to the profile home"
if [ "$(field NAMED_PROFILE_PATH_KANBAN_HOME)" != "$(field PROFILE_HOME)" ]; then
  g1b_assert_pass "the named profile's kanban_home() is NOT the profile home ($(field NAMED_PROFILE_PATH_KANBAN_HOME) != $(field PROFILE_HOME))"
else
  g1b_assert_fail "the named profile's kanban_home() collapsed to the profile home"
fi

# ---------------------------------------------------------------------------
# Stage 1 — seed a real WAL store
# ---------------------------------------------------------------------------
log ""
log "## Stage 1 — seed a real WAL kanban.db (real \`hermes kanban create\` trigger)"
log "SEED_CMD=$(field SEED_CMD)"
g1b_assert_eq "wal" "$(field SEED_RESOLVED_MODE)" \
  "seed fixture config resolves to wal before the writer"
g1b_assert_eq "0" "$(field SEED_RESOLVED_MODE_RC)" "seed resolved-mode read exit status"
g1b_assert_eq "0" "$(field SEED_EXIT)" "seed real trigger exit status"
g1b_assert_eq "tasks" "$(field SEED_RECORD_TABLE)" "seed record table"
g1b_assert_nonempty "$(field SEED_RECORD_ID)" "seed identifiable record id (store-assigned t_...)"
g1b_assert_eq "$MARK_SEED" "$(field SEED_RECORD_TITLE)" "seed record title is the marker"
g1b_assert_eq "2" "$(field SEED_BYTE18)" "seed header byte18 (2 = wal)"
g1b_assert_eq "2" "$(field SEED_BYTE19)" "seed header byte19 (2 = wal)"
g1b_assert_eq "wal" "$(field SEED_MODE)" "seed raw header mode"
g1b_assert_nonempty "$(field SEED_SIZE)" "seed size recorded"
g1b_assert_nonempty "$(field SEED_SHA256)" "seed sha256 recorded"

# ---------------------------------------------------------------------------
# Stage 2 — cp -a copy, byte identity
# ---------------------------------------------------------------------------
log ""
log "## Stage 2 — cp -a copy of the WAL store"
log "COPY_CMD=$(field COPY_CMD)"
g1b_assert_eq "0" "$(field COPY_RC)" "cp -a of the WAL store exit status"
g1b_assert_eq "yes" "$(field COPY_BYTE_IDENTICAL)" \
  "copy is byte-identical to the original (sha256 equal)"
g1b_assert_eq "0" "$(field COPY_CMP_RC)" "cmp -s reports the copy equals the original"
g1b_assert_eq "2" "$(field COPY_BEFORE_BYTE18)" "copy header byte18 before conversion (2 = wal)"
g1b_assert_eq "2" "$(field COPY_BEFORE_BYTE19)" "copy header byte19 before conversion (2 = wal)"

# ---------------------------------------------------------------------------
# Stage 3 — offline conversion of the COPY only
# ---------------------------------------------------------------------------
log ""
log "## Stage 3 — offline conversion of the COPY only"
log "CONVERT_CMD=$(field CONVERT_CMD)"
g1b_assert_eq "0" "$(field CONVERT_EXIT)" "stock offline conversion command exit status"
g1b_assert_eq "1" "$(field CONVERTED_BYTE18)" "converted copy header byte18 (1 = delete)"
g1b_assert_eq "1" "$(field CONVERTED_BYTE19)" "converted copy header byte19 (1 = delete)"
g1b_assert_eq "delete" "$(field CONVERTED_MODE)" "converted copy raw header mode"
g1b_assert_eq "yes" "$(field CONVERSION_CHANGED_COPY)" \
  "conversion actually rewrote the copy (sha256 changed)"
g1b_assert_eq "yes" "$(field SEED_UNCHANGED_BY_CONVERSION)" \
  "original WAL store sha256 unchanged by conversion of the copy"
g1b_assert_eq "$(field SEED_SHA256)" "$(field SEED_SHA256_AFTER_CONVERT)" \
  "original WAL store sha256 is identical before/after conversion"

# ---------------------------------------------------------------------------
# Stage 4 — two real trigger runs under delete
# ---------------------------------------------------------------------------
log ""
log "## Stage 4 — real \`hermes kanban create\` TWICE under database.journal_mode: delete"
log "DELETE_HOME=$(field DELETE_HOME)"
g1b_assert_eq "delete" "$(field DELETE_RESOLVED_MODE)" \
  "delete fixture config resolves to delete before any writer"
g1b_assert_eq "0" "$(field DELETE_RESOLVED_MODE_RC)" "delete resolved-mode read exit status"
g1b_assert_eq "1" "$(field DELETE_BEFORE_BYTE18)" "placed converted copy header byte18 before writers"
g1b_assert_eq "1" "$(field DELETE_BEFORE_BYTE19)" "placed converted copy header byte19 before writers"

# Persistence baseline: the conversion preserved the seed task row, and neither
# writer marker exists before its run. The task table is the one the stock
# writer reported AND the one the read-only marker match discovered.
g1b_assert_eq "tasks" "$(field EVIDENCE_TABLE)" \
  "task table discovered by the read-only marker match is tasks"
g1b_assert_eq "tasks" "$(field EVIDENCE_TABLE_WRITER_TABLE)" \
  "task table reported by the stock writer is tasks"
g1b_assert_eq "0" "$(field RO_DELETE_PRE_SEED_EXIT)" "pre-writer read-only check of the seeded task exit status"
g1b_assert_eq "1" "$(field RO_DELETE_PRE_SEED_TASK_COUNT)" \
  "seeded task row survived the offline conversion (read-only)"
g1b_assert_eq "0" "$(field RO_RUN1_BEFORE_MARK1_TASK_COUNT)" \
  "writer-run-1 task marker ABSENT before run 1 (read-only)"
g1b_assert_eq "0" "$(field RO_RUN1_BEFORE_MARK2_TASK_COUNT)" \
  "writer-run-2 task marker ABSENT before run 1 (read-only)"

g1b_assert_eq "0" "$(field RUN1_EXIT)" "real trigger run 1 exit status"
g1b_assert_eq "tasks" "$(field RUN1_RECORD_TABLE)" "run 1 record table"
g1b_assert_nonempty "$(field RUN1_RECORD_ID)" "run 1 store-assigned task id (t_...)"
g1b_assert_eq "$MARK1" "$(field RUN1_RECORD_TITLE)" "run 1 task title is the marker"
g1b_assert_eq "1" "$(field RUN1_BYTE18)" "header byte18 after writer run 1 close (1 = delete)"
g1b_assert_eq "1" "$(field RUN1_BYTE19)" "header byte19 after writer run 1 close (1 = delete)"
g1b_assert_eq "delete" "$(field RUN1_MODE)" "raw header mode after writer run 1 close"
g1b_assert_nonempty "$(field RUN1_SIZE)" "size after writer run 1"
g1b_assert_nonempty "$(field RUN1_SHA256)" "sha256 after writer run 1"
g1b_assert_eq "absent" "$(field RUN1_SIDECAR_WAL_STATE)" "-wal absent after writer run 1 close"
g1b_assert_eq "absent" "$(field RUN1_SIDECAR_SHM_STATE)" "-shm absent after writer run 1 close"
g1b_assert_eq "absent" "$(field RUN1_SIDECAR_JOURNAL_STATE)" "-journal absent after writer run 1 close"

ro1="$(ro_block RUN1_AFTER_MARK1)"
g1b_assert_contains "$ro1" "?mode=ro" "run 1 read-only check opens the fixture with mode=ro"
g1b_assert_contains "$ro1" 'READONLY_SQL table=tasks: SELECT COUNT(*) FROM "tasks"' \
  "run 1 read-only check records the exact SQL text"
g1b_assert_eq "0" "$(field RO_RUN1_AFTER_MARK1_EXIT)" "run 1 read-only check exit status"
g1b_assert_eq "1" "$(field RO_RUN1_AFTER_MARK1_TASK_COUNT)" \
  "run 1 identifiable tasks row PRESENT after run 1 close (read-only)"
g1b_assert_eq "0" "$(field RO_RUN1_AFTER_MARK2_TASK_COUNT)" \
  "writer-run-2 task marker still ABSENT after run 1 (read-only)"
g1b_assert_eq "1" "$(field RUN1_AFTER_READONLY_BYTE18)" \
  "header byte18 still 1 after the read-only check of run 1"
g1b_assert_eq "1" "$(field RUN1_AFTER_READONLY_BYTE19)" \
  "header byte19 still 1 after the read-only check of run 1"

g1b_assert_eq "1" "$(field RO_RUN2_BEFORE_MARK1_TASK_COUNT)" \
  "run 1 task still present before run 2 (read-only)"
g1b_assert_eq "0" "$(field RO_RUN2_BEFORE_MARK2_TASK_COUNT)" \
  "writer-run-2 task marker ABSENT before run 2 (read-only)"

g1b_assert_eq "0" "$(field RUN2_EXIT)" "real trigger run 2 exit status"
g1b_assert_nonempty "$(field RUN2_RECORD_ID)" "run 2 store-assigned task id (t_...)"
g1b_assert_eq "$MARK2" "$(field RUN2_RECORD_TITLE)" "run 2 task title is the marker"
g1b_assert_eq "1" "$(field RUN2_BYTE18)" "header byte18 after writer run 2 close (1 = delete)"
g1b_assert_eq "1" "$(field RUN2_BYTE19)" "header byte19 after writer run 2 close (1 = delete)"
g1b_assert_eq "delete" "$(field RUN2_MODE)" "raw header mode after writer run 2 close"
g1b_assert_nonempty "$(field RUN2_SIZE)" "size after writer run 2"
g1b_assert_nonempty "$(field RUN2_SHA256)" "sha256 after writer run 2"
g1b_assert_eq "absent" "$(field RUN2_SIDECAR_WAL_STATE)" "-wal absent after writer run 2 close"
g1b_assert_eq "absent" "$(field RUN2_SIDECAR_SHM_STATE)" "-shm absent after writer run 2 close"
g1b_assert_eq "absent" "$(field RUN2_SIDECAR_JOURNAL_STATE)" "-journal absent after writer run 2 close"

ro2="$(ro_block RUN2_AFTER_MARK2)"
g1b_assert_contains "$ro2" "?mode=ro" "run 2 read-only check opens the fixture with mode=ro"
g1b_assert_contains "$ro2" 'READONLY_SQL table=tasks: SELECT COUNT(*) FROM "tasks"' \
  "run 2 read-only check records the exact SQL text"
g1b_assert_eq "0" "$(field RO_RUN2_AFTER_MARK1_EXIT)" "run 2 read-only check (run 1 task) exit status"
g1b_assert_eq "1" "$(field RO_RUN2_AFTER_MARK1_TASK_COUNT)" \
  "run 1 task still present after run 2 (read-only)"
g1b_assert_eq "0" "$(field RO_RUN2_AFTER_MARK2_EXIT)" "run 2 read-only check (run 2 task) exit status"
g1b_assert_eq "1" "$(field RO_RUN2_AFTER_MARK2_TASK_COUNT)" \
  "run 2 identifiable tasks row PRESENT after run 2 close (read-only)"
g1b_assert_eq "1" "$(field RUN2_AFTER_READONLY_BYTE18)" \
  "header byte18 still 1 after the read-only check of run 2"
g1b_assert_eq "1" "$(field RUN2_AFTER_READONLY_BYTE19)" \
  "header byte19 still 1 after the read-only check of run 2"

g1b_assert_eq "0" "$(field RO_NEVER_WRITTEN_EXIT)" "never-written marker read-only check exit status"
g1b_assert_eq "0" "$(field RO_NEVER_WRITTEN_TOTAL)" \
  "never-written marker ABSENT from the store (read-only total)"

# ---------------------------------------------------------------------------
# Stage 5 — WAL control: same converted copy, config resolving to wal
# ---------------------------------------------------------------------------
log ""
log "## Stage 5 — WAL control: SAME converted copy under database.journal_mode: wal"
log "CONTROL_HOME=$(field CONTROL_HOME)"
g1b_assert_eq "wal" "$(field CONTROL_RESOLVED_MODE)" \
  "wal-control fixture config resolves to wal before the writer"
g1b_assert_eq "0" "$(field CONTROL_RESOLVED_MODE_RC)" "wal-control resolved-mode read exit status"
g1b_assert_eq "1" "$(field CONTROL_BEFORE_BYTE18)" "control copy is still 1 before the control writer"
g1b_assert_eq "1" "$(field CONTROL_BEFORE_BYTE19)" "control copy is still 1 before the control writer"
g1b_assert_eq "0" "$(field RO_CONTROL_BEFORE_MARK_TASK_COUNT)" \
  "control marker ABSENT before the control writer (read-only)"
g1b_assert_eq "0" "$(field CONTROL_EXIT)" "wal-control real trigger exit status"
g1b_assert_eq "2" "$(field CONTROL_BYTE18)" "wal control header byte18 (2 = wal)"
g1b_assert_eq "2" "$(field CONTROL_BYTE19)" "wal control header byte19 (2 = wal)"
g1b_assert_eq "wal" "$(field CONTROL_MODE)" "wal control raw header mode"
ro3="$(ro_block CONTROL_AFTER_MARK)"
g1b_assert_contains "$ro3" "?mode=ro" "wal-control read-only check opens the fixture with mode=ro"
g1b_assert_eq "1" "$(field RO_CONTROL_AFTER_MARK_TASK_COUNT)" \
  "control task PRESENT after the control writer (read-only)"
g1b_assert_eq "2" "$(field CONTROL_AFTER_READONLY_BYTE18)" \
  "wal control header byte18 still 2 after the read-only check"
g1b_assert_eq "2" "$(field CONTROL_AFTER_READONLY_BYTE19)" \
  "wal control header byte19 still 2 after the read-only check"

# ---------------------------------------------------------------------------
# Integrity
# ---------------------------------------------------------------------------
log ""
log "## Integrity"
g1b_assert_eq "yes" "$(field CONVERSION_SOURCE_UNTOUCHED)" \
  "conversion source copy untouched by both writer homes"
g1b_assert_eq "yes" "$(field SEED_UNCHANGED_AT_END)" \
  "original WAL store sha256 unchanged at the end"

# ---------------------------------------------------------------------------
# Per-stage table
# ---------------------------------------------------------------------------
log ""
log "## Per-stage table"
log "stage | path | size | sha256 | header18/19 | mode | sidecars | writer_runs"
stage_row() {
  local label="$1" prefix="$2" runs="$3"
  log "$label | $(field "${prefix}_PATH") | $(field "${prefix}_SIZE") | $(field "${prefix}_SHA256") | $(field "${prefix}_BYTE18"),$(field "${prefix}_BYTE19") | $(field "${prefix}_MODE") | $(sidecars "$prefix") | $runs"
}
stage_row "seed WAL" SEED "1 (seed trigger)"
stage_row "copy before conversion" COPY_BEFORE "0"
stage_row "converted copy" CONVERTED "0 (offline conversion)"
stage_row "delete home before writers" DELETE_BEFORE "1 (seed task carried over)"
stage_row "delete home after run 1" RUN1 "2"
stage_row "delete home after run 2" RUN2 "3"
stage_row "wal control before writer" CONTROL_BEFORE "1 (seed task carried over)"
stage_row "wal control after writer" CONTROL "2"

# ---------------------------------------------------------------------------
# Identifiable-record assertion summary (the bead's heart)
# ---------------------------------------------------------------------------
log ""
log "## Identifiable-record assertion (read-only, after each writer close)"
log "EVIDENCE_TABLE=$(field EVIDENCE_TABLE) (confirmed by the read-only marker match AND reported by the stock writer; the identifiable row is tasks.title = the marker)"
log "RUN1 record table=$(field RUN1_RECORD_TABLE) task_id=$(field RUN1_RECORD_ID) title=$MARK1"
log "  before run 1: tasks count=$(field RO_RUN1_BEFORE_MARK1_TASK_COUNT) total=$(field RO_RUN1_BEFORE_MARK1_TOTAL)"
log "  after run 1 close: tasks count=$(field RO_RUN1_AFTER_MARK1_TASK_COUNT) total=$(field RO_RUN1_AFTER_MARK1_TOTAL)"
log "  exact SQL: $(printf '%s\n' "$ro1" | grep -m1 "^READONLY_SQL table=tasks:")"
log "RUN2 record table=$(field RUN2_RECORD_TABLE) task_id=$(field RUN2_RECORD_ID) title=$MARK2"
log "  before run 2: tasks count=$(field RO_RUN2_BEFORE_MARK2_TASK_COUNT) total=$(field RO_RUN2_BEFORE_MARK2_TOTAL)"
log "  after run 2 close: tasks count=$(field RO_RUN2_AFTER_MARK2_TASK_COUNT) total=$(field RO_RUN2_AFTER_MARK2_TOTAL)"
log "  exact SQL: $(printf '%s\n' "$ro2" | grep -m1 "^READONLY_SQL table=tasks:")"
log "NEVER-WRITTEN marker $MARK_ABSENT: total=$(field RO_NEVER_WRITTEN_TOTAL) (must be 0)"
log ""

# ---------------------------------------------------------------------------
# Verdict + BLOCKER policy
# ---------------------------------------------------------------------------
delete_headers_kept=1
for label in RUN1 RUN2; do
  [ "$(field "${label}_BYTE18")" = "1" ] && [ "$(field "${label}_BYTE19")" = "1" ] || delete_headers_kept=0
done

if [ "$delete_headers_kept" -ne 1 ]; then
  VERDICT="NOT-HONOURING"
  BLOCKER=1
elif [ "$ASSERT_FAIL" -eq 0 ]; then
  VERDICT="HONOURING"
  BLOCKER=0
else
  VERDICT="UNKNOWN"
  BLOCKER=0
fi

log "## Verdict"
log "STORE=kanban.db"
log "STORE_IDENTITY=OPTIONAL kanban board store: the DEFAULT board at kanban_home()/kanban.db, kanban_home() = HERMES_KANBAN_HOME else get_default_hermes_root()"
log "PATH_RESOLUTION=default-profile fixture root (HERMES_HOME IS the board root); the board root is shared across profiles BY DESIGN (a named profile resolves the board to the shared root, never a per-profile store); HERMES_KANBAN_HOME/HERMES_KANBAN_DB/HERMES_KANBAN_BOARD unset"
log "TRIGGER=real /usr/local/bin/hermes kanban create \"<marker>\" --json (kanban list commits no record and is NOT the writer)"
log "EVIDENCE_TABLE=$(field EVIDENCE_TABLE) (identifiable row = tasks.title marker; store-assigned id t_... recorded per run)"
log "VERDICT: kanban.db $VERDICT"
log "VERDICT_LINE: Verdict: \`kanban.db\` $VERDICT"
log "WAL_CONTROL: converted copy under database.journal_mode: wal -> header $(field CONTROL_BYTE18),$(field CONTROL_BYTE19) (mode $(field CONTROL_MODE))"
log "PERSISTENCE_ASSERTION: run 1 task marker absent->present, run 2 task marker absent->present (separate read-only connections)"
log "SCOPE: a container run answers \"do that image's writers honour configuration\"; it does NOT qualify Matchlock's shared-filesystem behaviour across a guest boundary."
log "MATCHLOCK_ARTIFACT_RELATIONSHIP=UNVERIFIED"
log "SCRATCH_ROOT=$ROOT (kept as evidence$( [ "$BLOCKER" -eq 1 ] && printf '/BLOCKER reproducer' ))"
log "IMAGE_ID=$host_image_id"
log "ARCH=$host_arch"
log "STOCK_HERMES_REVISION=$(field STOCK_REVISION)"
log ""

summary_out="$(g1b_summary)"
summary_rc=$?
printf '%s\n' "$summary_out" | tee -a "$OUT"

if [ "$BLOCKER" -eq 1 ]; then
  log "BLOCKER: kanban.db did NOT keep delete mode across a real writer run."
  log "Reproducer preserved at $ROOT (container log: $container_log)."
  log "G1-B stops here for this store: no exclusion, no weakened refusal, no exclusivity."
  exit 1
fi
if [ "$summary_rc" -ne 0 ]; then
  exit 1
fi
exit 0
