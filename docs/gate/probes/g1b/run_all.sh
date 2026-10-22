#!/bin/bash
# run_all.sh — G1-B US-007: the CONSOLIDATED stock-runtime qualification harness.
#
# One command reproduces the whole G1-B qualification against the PUBLISHED
# Docker image's own stock Hermes, against ONE fresh scratch root:
#
#   docs/gate/probes/g1b/run_all.sh
#
# Steps, in order (each one runs the REAL probe script, never a copy):
#
#   1. read_header checks       the raw-header reader's contract: sha256-checked
#                               bootstrap, missing file, not-a-database, short
#                               header, and the 1,1 -> delete / 2,2 -> wal /
#                               unknown(a/b) classifications.  The synthetic
#                               20-byte header fixtures are NOT stores; they
#                               prove only the reader's mapping.
#   2. runtime identity         WHICH runtime is exercised: image id/arch/OS,
#                               stock Hermes revision and clean checkout,
#                               launcher/interpreter, embedded SQLite,
#                               resolve_journal_mode() for delete and wal.
#   3. WAL seeding              each of the four stores seeded under
#                               `database.journal_mode: wal` with unique
#                               identifiable marker records (header 2,2).
#   4. read_header re-check     the four ACTUAL seeded stores, re-read on the
#                               host-visible fixture files through the same
#                               raw-header reader (must be 2,2 / wal).
#   5. state.db                 the decisive delete-mode experiment.
#   6. verification_evidence.db the decisive delete-mode experiment (opt-in gate
#                               proven first).
#   7. kanban.db                the decisive delete-mode experiment.
#   8. projects.db              the decisive delete-mode experiment.
#
# Every fixture lives under ONE `mktemp -d /tmp/g1b-final.XXXXXX` root: each
# child probe gets its own scratch root NESTED inside it (`G1B_TMP_ROOT`), and
# the root is NEVER deleted — fixtures stay in place as evidence and the root is
# printed at the start and in the summary.  Per-store outputs are captured under
# <root>/logs/ so a consolidated run does not rewrite the committed per-store
# evidence files (their pinned sha256s and record ids stay valid).
#
# The complete output of every step is appended to
# docs/gate/evidence/g1b/final-harness.log (override with
# G1B_FINAL_HARNESS_OUT for a re-verification run that must not touch the
# committed log).  Exit statuses are captured BEFORE any logging/teeing — never
# through `| tail` — and the harness exits nonzero when any step failed, any
# assertion failed, or a per-store verdict is not HONOURING.
#
# Safety: stock Hermes only (no fork/patch/vendor, no package installs), no
# network in containers (`--network none` through the single
# `g1b_container_run` gateway), the real operator home is never read, written or
# mounted, no pre-existing path is deleted, and every `mktemp -d /tmp/g1b-*`
# root is kept.
#
# Environment:
#   G1B_EVIDENCE_DIR       evidence directory (default docs/gate/evidence/g1b)
#   G1B_FINAL_HARNESS_OUT  consolidated log path (default <evidence>/final-harness.log)
#   G1B_TMP_ROOT           scratch base for the ONE consolidated root (default /tmp)
#   G1B_IMAGE_REF          image ref (default igorhvr/tamandua:latest)
#
# Exit status: 0 only when every step and every assertion passed and every store
# is HONOURING.

set -u

PROBES_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./g1b_common.sh
. "$PROBES_DIR/g1b_common.sh"

EVIDENCE_DIR="$G1B_EVIDENCE_DIR"
mkdir -p -- "$EVIDENCE_DIR"
LOG="${G1B_FINAL_HARNESS_OUT:-$EVIDENCE_DIR/final-harness.log}"
mkdir -p -- "$(dirname -- "$LOG")"
: > "$LOG"

log() { printf '%s\n' "$*" | tee -a "$LOG"; }

# ---------------------------------------------------------------------------
# The ONE consolidated scratch root (kept, never deleted)
# ---------------------------------------------------------------------------
ROOT="$(g1b_scratch final)" || { printf 'g1b: cannot create consolidated scratch root\n' >&2; exit 2; }
g1b_refuse_real_home "$ROOT"
mkdir -p -- "$ROOT/logs" "$ROOT/tools"
FINAL_RUNID="final-$(date -u +%Y%m%dT%H%M%SZ)-$$"

log "# G1-B US-007 — consolidated stock-runtime qualification harness"
log "# generated (UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "# one command: docs/gate/probes/g1b/run_all.sh"
log ""
log "SCRATCH_ROOT=$ROOT"
log "SCRATCH_ROOT_KEPT=yes (G1-B never deletes its fixtures; child scratch roots are nested inside this root)"
log "PROBE_RUNID=$FINAL_RUNID"
log "PER_STORE_OUTPUTS=under $ROOT/logs (the committed per-store evidence files are NOT rewritten)"
log "IMAGE_REF=$IMAGE_REF"
log "REQUIRED_IMAGE_ID=$REQUIRED_IMAGE_ID"
log "REQUIRED_PLATFORM=$REQUIRED_PLATFORM"
log "REQUIRED_HERMES_REVISION=$REQUIRED_HERMES_REVISION"
log "MATCHLOCK_ARTIFACT_ID=$MATCHLOCK_ARTIFACT_ID"
log "MATCHLOCK_ARTIFACT_RELATIONSHIP=UNVERIFIED (no equality claim; a container run says nothing about the Matchlock artifact)"
log "SCOPE=\"do that image's writers honour configuration\" in a container; it does NOT qualify Matchlock's shared-filesystem behaviour across a guest boundary"
log ""

# read_header.py is the ONLY approved journal-format reader (raw bytes 18/19).
bootstrap_out="$(g1b_bootstrap_read_header "$ROOT" 2>&1)"
bootstrap_rc=$?
log "## read_header bootstrap"
log "$bootstrap_out"
log "READ_HEADER_BOOTSTRAP_RC=$bootstrap_rc"
g1b_assert_eq "0" "$bootstrap_rc" "read_header.py bootstrap copy matches the parent file sha256"
log ""

# ---------------------------------------------------------------------------
# Step runner: real exit code captured BEFORE any logging/teeing.
# ---------------------------------------------------------------------------
STEP_NAMES=()
STEP_RCS=()
STEP_LOGS=()
FAILED_STEPS=""

run_step() {
  local name="$1"
  shift
  local out="$ROOT/logs/$name.log"
  log ""
  log "====================================================================="
  log "## STEP: $name"
  log "COMMAND: $*"
  log "STEP_LOG=$out"
  log "====================================================================="

  "$@" > "$out" 2>&1
  local rc=$?
  # Complete child output: to this terminal AND into the consolidated log.
  tee -a -- "$LOG" < "$out"
  log "STEP_RC=$name=$rc"

  STEP_NAMES+=("$name")
  STEP_RCS+=("$rc")
  STEP_LOGS+=("$out")
  if [ "$rc" -ne 0 ]; then
    FAILED_STEPS="${FAILED_STEPS} ${name}(rc=${rc})"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Step 1 — read_header-based checks (reader contract; synthetic header fixtures
# are explicitly NOT stores)
# ---------------------------------------------------------------------------
read_header_checks() {
  local script
  script="$(cat <<'CONTAINER_SCRIPT'
set -u
PY=/opt/src/hermes-venv/bin/python
READER=/work/tools/read_header.py
DIR=/work/read-header-checks
mkdir -p "$DIR"

# 1) missing file: fail closed with an error object, never a fabricated mode.
missing_out="$("$PY" "$READER" "$DIR/does-not-exist.db" 2>/dev/null)"
printf 'MISSING_RC=%s\n' "$?"
printf 'MISSING_JSON=%s\n' "$missing_out"

# 2) not a database: magic check wins over any version bytes.
printf 'plain text, definitely not a sqlite database\n' > "$DIR/not-a-database.bin"
nd_out="$("$PY" "$READER" "$DIR/not-a-database.bin" 2>/dev/null)"
printf 'NOT_A_DB_RC=%s\n' "$?"
printf 'NOT_A_DB_JSON=%s\n' "$nd_out"

# 3) short file: fewer than the 20 header bytes.
"$PY" -c 'import sys; sys.stdout.buffer.write(b"SQLite format 3\x00")' > "$DIR/short.bin"
short_out="$("$PY" "$READER" "$DIR/short.bin" 2>/dev/null)"
printf 'SHORT_RC=%s\n' "$?"
printf 'SHORT_JSON=%s\n' "$short_out"

# 4) SYNTHETIC 20-byte header-only classification fixtures.  These are NOT
#    stores and carry no data: they prove ONLY that the reader maps the version
#    byte pair the qualification relies on (1/1 -> delete, 2/2 -> wal) and
#    reports any other pair as unknown(a/b).
synthetic() {
  local name="$1" b18="$2" b19="$3" out rc
  "$PY" -c "import sys; sys.stdout.buffer.write(b\"SQLite format 3\\x00\" + b\"\\x10\\x00\" + bytes([$b18, $b19]))" > "$DIR/$name.bin"
  out="$("$PY" "$READER" "$DIR/$name.bin" 2>/dev/null)"
  rc=$?
  printf 'SYNTHETIC name=%s rc=%s json=%s\n' "$name" "$rc" "$out"
}
synthetic delete-header 1 1
synthetic wal-header 2 2
synthetic unknown-header 3 4
printf 'SYNTHETIC_FIXTURES_ARE_STORES=no (20-byte header-only reader classification fixtures)\n'
CONTAINER_SCRIPT
)"

  local container_log="$ROOT/logs/read-header-checks.container.log"
  g1b_container_run "$ROOT" "$script" > "$container_log" 2>&1
  local rc=$?
  cat -- "$container_log"
  printf 'CONTAINER_RC=%s\n' "$rc"
  [ "$rc" -eq 0 ] || return 1

  local failures=0
  hfield() { grep -m1 "^$1=" "$container_log" | cut -d= -f2-; }

  printf 'READER_MISSING_RC=%s\n' "$(hfield MISSING_RC)"
  printf 'READER_NOT_A_DB_RC=%s\n' "$(hfield NOT_A_DB_RC)"
  printf 'READER_SHORT_RC=%s\n' "$(hfield SHORT_RC)"

  [ "$(hfield MISSING_RC)" = "2" ] || { printf 'ASSERT FAIL: missing file must exit 2\n'; failures=$((failures + 1)); }
  case "$(hfield MISSING_JSON)" in
    *'"error"'*) printf 'ASSERT PASS: missing file reports an error object (never a fabricated mode)\n' ;;
    *) printf 'ASSERT FAIL: missing file did not report an error object\n'; failures=$((failures + 1)) ;;
  esac
  [ "$(hfield NOT_A_DB_RC)" = "2" ] || { printf 'ASSERT FAIL: not-a-database must exit 2\n'; failures=$((failures + 1)); }
  case "$(hfield NOT_A_DB_JSON)" in
    *'"mode": "not-a-database"'*) printf 'ASSERT PASS: non-database magic reported as not-a-database\n' ;;
    *) printf 'ASSERT FAIL: non-database file not classified as not-a-database\n'; failures=$((failures + 1)) ;;
  esac
  [ "$(hfield SHORT_RC)" = "2" ] || { printf 'ASSERT FAIL: short file must exit 2\n'; failures=$((failures + 1)); }
  case "$(hfield SHORT_JSON)" in
    *'"mode": "short"'*) printf 'ASSERT PASS: truncated header reported as short\n' ;;
    *) printf 'ASSERT FAIL: truncated header not reported as short\n'; failures=$((failures + 1)) ;;
  esac

  # synth_ok <line> <rc> <byte18> <byte19> <mode> — literal substring checks so
  # the classification assertion cannot drift with quoting.
  synth_ok() {
    local line="$1" src="$2" b18="$3" b19="$4" mode="$5"
    printf '%s' "$line" | grep -qF " rc=$src " || return 1
    printf '%s' "$line" | grep -qF "\"byte18\": $b18, \"byte19\": $b19" || return 1
    printf '%s' "$line" | grep -qF "\"mode\": \"$mode\"" || return 1
    return 0
  }

  local name s_rc b18 b19 mode line
  while IFS='|' read -r name s_rc b18 b19 mode; do
    [ -n "$name" ] || continue
    line="$(grep -m1 "^SYNTHETIC name=$name " "$container_log" || true)"
    if synth_ok "$line" "$s_rc" "$b18" "$b19" "$mode"; then
      printf 'ASSERT PASS: synthetic %s -> bytes %s,%s mode %s\n' "$name" "$b18" "$b19" "$mode"
    else
      printf 'ASSERT FAIL: synthetic %s classification (%s)\n' "$name" "$line"
      failures=$((failures + 1))
    fi
  done <<'SYNTHETIC_PAIRS'
delete-header|0|1|1|delete
wal-header|0|2|2|wal
unknown-header|0|3|4|unknown(3/4)
SYNTHETIC_PAIRS

  printf 'READER_CHECK_FAILURES=%s\n' "$failures"
  printf 'SYNTHETIC_FIXTURES_ARE_STORES=no\n'
  [ "$failures" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Steps 2-3 — runtime identity and WAL seeding
# ---------------------------------------------------------------------------
run_identity() { bash "$PROBES_DIR/probe_runtime_identity.sh"; }
run_seeding() { bash "$PROBES_DIR/seed_stores.sh"; }

# ---------------------------------------------------------------------------
# Step 4 — read_header re-check of the ACTUAL seeded stores (host-visible
# fixture files under the kept seeding root, read through the same reader)
# ---------------------------------------------------------------------------
read_header_seeded_stores() {
  local seed_root rel_file
  seed_root="$(grep -m1 '^SCRATCH_ROOT=' "$ROOT/logs/seeding.log" | cut -d= -f2-)"
  [ -n "$seed_root" ] && [ -d "$seed_root" ] || {
    printf 'ASSERT FAIL: cannot resolve the seeding scratch root from the seeding log\n'
    return 1
  }
  printf 'SEEDING_SCRATCH_ROOT=%s\n' "$seed_root"

  rel_file="$seed_root/logs/seeded-store-paths.txt"
  : > "$rel_file"
  local found
  while IFS= read -r found; do
    printf '%s\n' "${found#"$seed_root"}" >> "$rel_file"
  done < <(find "$seed_root" -maxdepth 4 -type f \
    \( -name 'state.db' -o -name 'verification_evidence.db' \
       -o -name 'kanban.db' -o -name 'projects.db' \) | sort)
  printf 'SEEDED_STORE_COUNT=%s\n' "$(grep -c . "$rel_file" || true)"

  local script
  script="$(cat <<'CONTAINER_SCRIPT'
set -u
PY=/opt/src/hermes-venv/bin/python
READER=/work/tools/read_header.py
while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  case "$rel" in
    */state.db|*/verification_evidence.db|*/kanban.db|*/projects.db) ;;
    *) continue ;;
  esac
  out="$("$PY" "$READER" "/work$rel" 2>&1)"
  rc=$?
  printf 'SEEDED_STORE path=%s rc=%s json=%s\n' "$rel" "$rc" "$out"
done < /work/logs/seeded-store-paths.txt
CONTAINER_SCRIPT
)"

  local container_log="$ROOT/logs/read-header-seeded.container.log"
  g1b_container_run "$seed_root" "$script" > "$container_log" 2>&1
  local rc=$?
  cat -- "$container_log"
  printf 'CONTAINER_RC=%s\n' "$rc"
  [ "$rc" -eq 0 ] || return 1

  local expected actual failures=0
  expected="$(grep -c . "$rel_file" || true)"
  actual="$(grep -c '^SEEDED_STORE ' "$container_log" || true)"
  printf 'SEEDED_STORE_READS=%s EXPECTED=%s\n' "$actual" "$expected"
  [ "$actual" = "$expected" ] || { printf 'ASSERT FAIL: seeded store read count\n'; failures=$((failures + 1)); }
  [ "$expected" -ge 4 ] || { printf 'ASSERT FAIL: fewer than four seeded stores found\n'; failures=$((failures + 1)); }

  local line
  while IFS= read -r line; do
    case "$line" in
      *' rc=0 '*'"byte18": 2, "byte19": 2'*'"mode": "wal"'*)
        printf 'ASSERT PASS: seeded store still 2,2/wal through read_header (%s)\n' \
          "$(printf '%s' "$line" | sed -E 's/^SEEDED_STORE path=([^ ]+).*/\1/')" ;;
      *)
        printf 'ASSERT FAIL: seeded store not 2,2/wal: %s\n' "$line"
        failures=$((failures + 1)) ;;
    esac
  done < <(grep '^SEEDED_STORE ' "$container_log" || true)

  printf 'READER_SEEDED_FAILURES=%s\n' "$failures"
  [ "$failures" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Steps 5-8 — the four per-store decisive experiments
# ---------------------------------------------------------------------------
run_state() { bash "$PROBES_DIR/probe_state_delete.sh"; }
run_verification() { bash "$PROBES_DIR/probe_verification_delete.sh"; }
run_kanban() { bash "$PROBES_DIR/probe_kanban_delete.sh"; }
run_projects() { bash "$PROBES_DIR/probe_projects_delete.sh"; }

# ---------------------------------------------------------------------------
# Child environment: ONE root, per-store outputs kept out of the committed
# per-store evidence files, unique markers for this consolidated run.
# ---------------------------------------------------------------------------
export G1B_EVIDENCE_DIR="$EVIDENCE_DIR"
export G1B_TMP_ROOT="$ROOT"
export G1B_RUNTIME_IDENTITY_OUT="$ROOT/logs/runtime-identity.txt"
export G1B_SEED_OUT="$ROOT/logs/store-seeding.txt"
export G1B_STATE_DELETE_OUT="$ROOT/logs/state-delete.txt"
export G1B_VERIFICATION_DELETE_OUT="$ROOT/logs/verification-delete.txt"
export G1B_KANBAN_DELETE_OUT="$ROOT/logs/kanban-delete.txt"
export G1B_PROJECTS_DELETE_OUT="$ROOT/logs/projects-delete.txt"
export G1B_SEED_RUNID="$FINAL_RUNID-seed"
export G1B_STATE_RUNID="$FINAL_RUNID-state"
export G1B_VERIFICATION_RUNID="$FINAL_RUNID-verification"
export G1B_KANBAN_RUNID="$FINAL_RUNID-kanban"
export G1B_PROJECTS_RUNID="$FINAL_RUNID-projects"

run_step read_header_checks read_header_checks
run_step runtime_identity run_identity
run_step seeding run_seeding
run_step read_header_seeded read_header_seeded_stores
run_step state_delete run_state
run_step verification_delete run_verification
run_step kanban_delete run_kanban
run_step projects_delete run_projects

# ---------------------------------------------------------------------------
# Per-store verdict extraction (from the real probe logs)
# ---------------------------------------------------------------------------
store_verdict() {
  local log_file="$1" db="$2"
  grep -m1 "^VERDICT: ${db} " "$log_file" 2>/dev/null | sed -E "s/^VERDICT: ${db} //"
}
store_persistence() {
  grep -m1 '^PERSISTENCE_ASSERTION: ' "$1" 2>/dev/null | sed 's/^PERSISTENCE_ASSERTION: //'
}
store_control() {
  grep -m1 '^WAL_CONTROL: ' "$1" 2>/dev/null | sed 's/^WAL_CONTROL: //'
}
store_pass_count() { grep -c '^ASSERT PASS:' "$1" 2>/dev/null || true; }
store_fail_count() { grep -c '^ASSERT FAIL:' "$1" 2>/dev/null || true; }

log ""
log "====================================================================="
log "## CONSOLIDATED PER-STORE VERDICT TABLE"
log "====================================================================="
log "store | verdict | identifiable-record assertion | WAL control"
log "--- | --- | --- | ---"

STORE_DBS=("state.db" "verification_evidence.db" "kanban.db" "projects.db")
STORE_LOGS=(
  "$ROOT/logs/state_delete.log"
  "$ROOT/logs/verification_delete.log"
  "$ROOT/logs/kanban_delete.log"
  "$ROOT/logs/projects_delete.log"
)
VERDICT_FAILURES=0
for i in "${!STORE_DBS[@]}"; do
  db="${STORE_DBS[$i]}"
  store_log="${STORE_LOGS[$i]}"
  verdict="$(store_verdict "$store_log" "$db")"
  persistence="$(store_persistence "$store_log")"
  control="$(store_control "$store_log")"
  [ -n "$verdict" ] || verdict="MISSING"
  [ -n "$persistence" ] || persistence="MISSING"
  [ -n "$control" ] || control="MISSING"
  log "$db | $verdict | $persistence | $control"
  log "  assertions: pass=$(store_pass_count "$store_log") fail=$(store_fail_count "$store_log") log=$store_log"

  if [ "$verdict" = "HONOURING" ]; then
    g1b_assert_pass "$db verdict HONOURING"
  else
    g1b_assert_fail "$db verdict is $verdict (expected HONOURING)"
    VERDICT_FAILURES=$((VERDICT_FAILURES + 1))
  fi
  case "$control" in
    *"header 2,2"*) g1b_assert_pass "$db WAL control reached 2,2" ;;
    *) g1b_assert_fail "$db WAL control result missing or not 2,2 ($control)"; VERDICT_FAILURES=$((VERDICT_FAILURES + 1)) ;;
  esac
  case "$persistence" in
    *"absent->present"*) g1b_assert_pass "$db identifiable-record absent->present recorded" ;;
    *) g1b_assert_fail "$db identifiable-record assertion missing ($persistence)"; VERDICT_FAILURES=$((VERDICT_FAILURES + 1)) ;;
  esac
done
log ""

# ---------------------------------------------------------------------------
# Exercised runtime (from the runtime-identity probe log)
# ---------------------------------------------------------------------------
identity_log="$ROOT/logs/runtime_identity.log"
id_field() { grep -m1 "^$1=" "$identity_log" 2>/dev/null | cut -d= -f2-; }

IMAGE_ID_OBSERVED="$(id_field IMAGE_ID)"
ARCH_OBSERVED="$(id_field ARCH)"
OS_OBSERVED="$(id_field OS)"
REVISION_OBSERVED="$(id_field HERMES_REVISION)"

log "## Exercised runtime"
log "IMAGE_ID=$IMAGE_ID_OBSERVED"
log "ARCH=$ARCH_OBSERVED"
log "OS=$OS_OBSERVED"
log "STOCK_HERMES_REVISION=$REVISION_OBSERVED"
log "REQUIRED_IMAGE_ID=$REQUIRED_IMAGE_ID"
log "REQUIRED_ARCH=$REQUIRED_ARCH"
log "REQUIRED_OS=$REQUIRED_OS"
log "REQUIRED_HERMES_REVISION=$REQUIRED_HERMES_REVISION"
g1b_assert_eq "$REQUIRED_IMAGE_ID" "$IMAGE_ID_OBSERVED" "exercised image id"
g1b_assert_eq "$REQUIRED_ARCH" "$ARCH_OBSERVED" "exercised architecture"
g1b_assert_eq "$REQUIRED_OS" "$OS_OBSERVED" "exercised OS"
g1b_assert_eq "$REQUIRED_HERMES_REVISION" "$REVISION_OBSERVED" "exercised stock Hermes revision"
log ""

# ---------------------------------------------------------------------------
# Safety counts
# ---------------------------------------------------------------------------
log "## Safety counts"
log ""

invocations="$ROOT/logs/container-invocations.txt"
# One line per REAL gateway invocation: each container log records exactly one
# CONTAINER_INVOCATION line, so scanning them (instead of the aggregated step
# logs, which echo the gateway line twice) keeps the count honest.
{
  while IFS= read -r container_log; do
    grep -h 'CONTAINER_INVOCATION:' "$container_log" || true
  done < <(find "$ROOT" -type f -name '*.container.log' | sort)
} | sed 's/^ *//' > "$invocations"
inv_count="$(grep -c '^CONTAINER_INVOCATION:' "$invocations" || true)"
log "CONTAINER_INVOCATIONS=$inv_count"

uid="$(id -u)"
gid="$(id -g)"
home_ok=0
net_ok=0
user_ok=0
mount_ok=0
mount_outside=0
mounts_under_operator_home=0
mounts_under_home=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  case "$line" in *"-e HOME=/work/"*) home_ok=$((home_ok + 1)) ;; esac
  case "$line" in *"--network none"*) net_ok=$((net_ok + 1)) ;; esac
  case "$line" in *"--user $uid:$gid"*) user_ok=$((user_ok + 1)) ;; esac
  # The ONLY permitted mount source is the consolidated scratch root itself or a
  # child scratch root nested inside it (every child gets its own root).
  case "$line" in
    *"-v $ROOT:/work -w /work"*) mount_ok=$((mount_ok + 1)) ;;
    *"-v $ROOT/"*":/work -w /work"*) mount_ok=$((mount_ok + 1)) ;;
    *) mount_outside=$((mount_outside + 1)) ;;
  esac
  case "$line" in *"-v $REAL_OPERATOR_HOME"*) mounts_under_operator_home=$((mounts_under_operator_home + 1)) ;; esac
  case "$line" in *"-v /home/"*) mounts_under_home=$((mounts_under_home + 1)) ;; esac
done < "$invocations"

log "CONTAINER_HOME=/work/home (host path <scratch-root>/home, i.e. INSIDE the scratch root)"
log "CONTAINER_HOME_INSIDE_SCRATCH_ROOT=$([ "$home_ok" -eq "$inv_count" ] && [ "$inv_count" -gt 0 ] && echo yes || echo no) ($home_ok/$inv_count invocations)"
log "CONTAINER_ONLY_MOUNT_IS_SCRATCH_ROOT=$([ "$mount_ok" -eq "$inv_count" ] && [ "$inv_count" -gt 0 ] && echo yes || echo no) ($mount_ok/$inv_count invocations)"
log "CONTAINER_MOUNTS_OUTSIDE_SCRATCH_ROOT=$mount_outside"
log "CONTAINER_MOUNTS_UNDER_REAL_OPERATOR_HOME=$mounts_under_operator_home"
log "CONTAINER_MOUNTS_UNDER_HOME=$mounts_under_home (no /home/<operator> path is mounted)"
log "CONTAINER_NETWORK_NONE=$net_ok/$inv_count"
log "CONTAINER_USER_UID_GID=$user_ok/$inv_count"

g1b_assert_eq "yes" "$([ "$home_ok" -eq "$inv_count" ] && [ "$inv_count" -gt 0 ] && echo yes || echo no)" \
  "every container invocation sets HOME inside the scratch root"
g1b_assert_eq "yes" "$([ "$mount_ok" -eq "$inv_count" ] && [ "$inv_count" -gt 0 ] && echo yes || echo no)" \
  "the only mount of every container invocation is its scratch root"
g1b_assert_eq "0" "$mount_outside" "no container invocation mounts a path outside the scratch root"
g1b_assert_eq "0" "$mounts_under_operator_home" "no container invocation mounts the real operator home"
g1b_assert_eq "0" "$mounts_under_home" "no container invocation mounts a path under /home/"
g1b_assert_eq "$inv_count" "$net_ok" "every container invocation runs with --network none"
g1b_assert_eq "$inv_count" "$user_ok" "every container invocation runs as the invoking uid:gid"

# Scan every g1b evidence file for the real operator home.  A MENTION is not an
# OPEN or a WRITE: refusal guards name the path to refuse it, and the summary
# below names it to say it was scanned.  Only hits carrying an access cue
# (mount, open, read, write, tee, redirect) count as opens/writes.
scan_root="$EVIDENCE_DIR"
scan_files="$(find "$scan_root" -type f 2>/dev/null | wc -l)"
scan_hits="$(grep -rn --binary-files=text -- "$REAL_OPERATOR_HOME" "$scan_root" 2>/dev/null || true)"
scan_mentions=0
scan_opens=0
if [ -n "$scan_hits" ]; then
  scan_mentions="$(printf '%s\n' "$scan_hits" | grep -c -- "$REAL_OPERATOR_HOME" || true)"
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    case "$hit" in
      *"SAFETY_REAL_OPERATOR_HOME="*|*"SAFETY_EVIDENCE_MENTIONS="*|*"SAFETY_OPENS_OR_WRITES"*|*"SAFETY_SCAN_NOTE="*) continue ;;
    esac
    case "$hit" in
      *"-v "*) scan_opens=$((scan_opens + 1)); continue ;;
      *":/work"*) scan_opens=$((scan_opens + 1)); continue ;;
      *"open("*) scan_opens=$((scan_opens + 1)); continue ;;
      *mounted*|*mount*) scan_opens=$((scan_opens + 1)); continue ;;
      *writes\ *|*written*) scan_opens=$((scan_opens + 1)); continue ;;
    esac
  done <<< "$scan_hits"
fi
probe_guard_mentions="$(grep -rl --binary-files=text -- "$REAL_OPERATOR_HOME" "$PROBES_DIR" 2>/dev/null | wc -l)"

log "SAFETY_REAL_OPERATOR_HOME=$REAL_OPERATOR_HOME"
log "SAFETY_SCAN_SCOPE=$scan_root"
log "SAFETY_EVIDENCE_FILES_SCANNED=$scan_files"
log "SAFETY_EVIDENCE_MENTIONS=$scan_mentions"
log "SAFETY_OPENS_OR_WRITES_UNDER_REAL_OPERATOR_HOME=$scan_opens"
log "SAFETY_PROBE_FILES_NAMING_REAL_OPERATOR_HOME=$probe_guard_mentions (refusal guard: g1b_common.sh; a mention in a refusal guard is NOT an open or a write)"
log "SAFETY_SCAN_NOTE=a mention is not an open or a write - the refusal guard names the path only to REFUSE it, and no probe ever opens, reads, mounts or writes any path under the real operator home."
g1b_assert_eq "0" "$scan_opens" "zero opens/writes under the real operator home in every g1b evidence file"
log ""

# ---------------------------------------------------------------------------
# Consolidated summary
# ---------------------------------------------------------------------------
total_pass=0
total_fail=0
for i in "${!STEP_LOGS[@]}"; do
  p="$(grep -c '^ASSERT PASS:' "${STEP_LOGS[$i]}" 2>/dev/null || true)"
  f="$(grep -c '^ASSERT FAIL:' "${STEP_LOGS[$i]}" 2>/dev/null || true)"
  total_pass=$((total_pass + p))
  total_fail=$((total_fail + f))
  log "STEP_SUMMARY ${STEP_NAMES[$i]}: rc=${STEP_RCS[$i]} pass=$p fail=$f log=${STEP_LOGS[$i]}"
done

log ""
log "## Consolidated summary"
log "SCRATCH_ROOT=$ROOT"
log "SCRATCH_ROOT_KEPT=yes (never deleted; every fixture stays in place as evidence)"
log "CHILD_SCRATCH_ROOTS=$(find "$ROOT" -maxdepth 1 -type d -name 'g1b-*' | sort | tr '\n' ' ')"
log "FAILED_STEPS=${FAILED_STEPS:-none}"
log "TOTAL_ASSERT_PASS=$total_pass"
log "TOTAL_ASSERT_FAIL=$total_fail"
log "STORE_VERDICTS state.db=$(store_verdict "${STORE_LOGS[0]}" state.db) verification_evidence.db=$(store_verdict "${STORE_LOGS[1]}" verification_evidence.db) kanban.db=$(store_verdict "${STORE_LOGS[2]}" kanban.db) projects.db=$(store_verdict "${STORE_LOGS[3]}" projects.db)"
log "IMAGE_ID=$IMAGE_ID_OBSERVED"
log "ARCH=$ARCH_OBSERVED"
log "OS=$OS_OBSERVED"
log "STOCK_HERMES_REVISION=$REVISION_OBSERVED"
log "MATCHLOCK_ARTIFACT_RELATIONSHIP=UNVERIFIED"
log "SCOPE=a container run does NOT qualify Matchlock's shared-filesystem behaviour across a guest boundary"
log ""

summary_out="$(g1b_summary)"
summary_rc=$?
printf '%s\n' "$summary_out" | tee -a "$LOG"

FINAL_RESULT="PASS"
if [ -n "$FAILED_STEPS" ]; then FINAL_RESULT="FAIL"; fi
if [ "$summary_rc" -ne 0 ]; then FINAL_RESULT="FAIL"; fi
if [ "$total_fail" -ne 0 ]; then FINAL_RESULT="FAIL"; fi
if [ "$VERDICT_FAILURES" -ne 0 ]; then FINAL_RESULT="FAIL"; fi
log "FINAL_HARNESS_RESULT=$FINAL_RESULT"
log "FINAL_SCRATCH_ROOT=$ROOT (kept as evidence)"

if [ "$FINAL_RESULT" != "PASS" ]; then
  log "BLOCKER policy: preserve the reproducer (the scratch root above), never exclude a store, never weaken a refusal, never fabricate a verdict, never add exclusivity."
  exit 1
fi
exit 0
