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
#      (`scripts/observed-rounds-guard.mjs`, zero-round PASS = exit 92), then a
#      per-case attribution audit for t3 (every requested case must show its
#      OWN observed VM round; refusal = exit 93);
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
#   93  T3-ATTRIBUTION REFUSAL (a requested T3 case has no attributable VM
#       round, or one observed VM is claimed by two cases)
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
  # A previous run's OBSERVATION outputs must never be re-consumed: the derive
  # step reads every `**/case-summary.json` plus `M7/m7.log`, and the guard
  # reads the derived `observed-rounds.json`, so a reused dir holding any of
  # them would let this run report rounds it never observed. The policy is
  # explicit and fail-closed:
  #   - genuine absence (ENOENT) is the only "clean" outcome; any inspection
  #     failure, an unreadable directory, or a symlinked directory refuses
  #     (freshness must be PROVEN, never assumed);
  #   - reserved observation names count as stale whether they are files or
  #     directories;
  #   - seeded config and a pre-existing private state / retained-session tree
  #     stay allowed: they are inputs, not observations.
  # The derive step below (`mtlk_derive_observed_rounds`) reads the same tree
  # later with a recursive trailing-`**` glob, whose symlink traversal is
  # version-dependent (on the suite's interpreter it DOES descend symlinked
  # directories): rather than encode glob quirks, a symlinked directory is
  # refused here — the walk must be able to SEE everything the glob could
  # consume.
  STALE_RC=0
  python3 - "$EV" <<'PYADM' || STALE_RC=$?
import os
import stat
import sys

ev = os.path.abspath(sys.argv[1])
stale = []
problems = []

try:
    root_st = os.lstat(ev)
except FileNotFoundError:
    root_st = None  # genuine absence: nothing to reuse (created below)
except OSError as err:
    print("inspect-failed: " + str(err))
    sys.exit(2)

if root_st is not None:
    if stat.S_ISLNK(root_st.st_mode) or not stat.S_ISDIR(root_st.st_mode):
        # A symlinked or non-directory evidence path cannot be PROVEN clean
        # (and `mkdir -p` would fail closed anyway): refuse explicitly.
        print("inspect-failed: evidence path is not a real directory: " + ev)
        sys.exit(2)

    # Reserved observation outputs: ANY entry (file, dir or symlink) is stale.
    for rel in ("observed-rounds.json", os.path.join("M7", "m7.log")):
        p = os.path.join(ev, rel)
        try:
            os.lstat(p)
        except FileNotFoundError:
            continue
        except OSError as err:
            problems.append(str(err))
            continue
        stale.append(p)

    # Checked walk (NO link-following: a symlinked directory is an unprovable
    # surface and refuses; fresh dirs contain none, and the trailing-glob
    # derive must not be pointed at whatever a link hides).
    def onerror(err):
        problems.append(str(err))

    for dirpath, dirnames, filenames in os.walk(ev, onerror=onerror):
        for name in dirnames:
            p = os.path.join(dirpath, name)
            try:
                st = os.lstat(p)
            except OSError as err:
                problems.append(str(err))
                continue
            if stat.S_ISLNK(st.st_mode):
                problems.append("symlinked directory: " + p)
            if name == "case-summary.json":
                stale.append(p)
        for name in filenames:
            if name == "case-summary.json":
                stale.append(os.path.join(dirpath, name))

for p in problems[:5]:
    print("inspect-failed: " + p)
sys.exit(2 if problems else (1 if stale else 0))
PYADM
  if [ "$STALE_RC" = 1 ]; then
    printf 'MTLK-ABORT evidence-dir-not-fresh %s (stale observation artifacts present)\n' "$EV" >&2
    exit 2
  elif [ "$STALE_RC" != 0 ]; then
    printf 'MTLK-ABORT evidence-dir-not-fresh %s (uninspectable: cannot prove it holds no previous observations)\n' "$EV" >&2
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

# The interactive Hermes commands mount the ENTIRE effective Hermes
# configuration directory (`HERMES_HOME`, else `<private home>/.hermes`) at the
# approved guest HERMES_HOME and refuse an image-default substitution when it is
# missing (by design). A genuinely ABSENT config.yaml under a VALID directory is
# the SDK-tested built-in local-backend default, so an EMPTY private `.hermes`
# is exactly what these cases need -- never copy operator state or credentials
# into the private evidence HOME.
mtlk_hermes_home_seed() {
  local private_home="$1"
  [ -n "$private_home" ] || return 0
  mkdir -p "$private_home/.hermes" || return 1
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
  # The retained-evidence observation root is FORCED to the private per-run
  # state root (never inherited from the caller): acceptance counting must
  # never read unrelated operator state, and the product's own close path
  # writes exactly there (`<TAMANDUA_STATE_DIR>/matchlock/interactive-sessions`).
  export MTLK_INTERACTIVE_EVIDENCE_ROOT="$TAMANDUA_STATE_DIR/matchlock/interactive-sessions"
  if [ "$NEED_VM_EXEC" = "1" ]; then
    mtlk_image_store_seed "$HOME" || exit $?
    mtlk_pi_agent_seed "$HOME" "$MTLK_OPERATOR_HOME" || {
      printf 'MTLK-ABORT pi-config-seed-failed %s\n' "$MTLK_OPERATOR_HOME/.pi/agent" >&2
      exit 2
    }
    mtlk_hermes_home_seed "$HOME" || {
      printf 'MTLK-ABORT hermes-config-seed-failed %s\n' "$HOME/.hermes" >&2
      exit 2
    }
  fi
fi

mtlk_write_identity "$EV/identity.txt"

# -----------------------------------------------------------------------------
# Observed-rounds evidence (no-fake-green). The shared guard reads
# `<ev>/observed-rounds.json`; the case harness' own evidence is authoritative,
# so the entrypoint only derives it when the run did not already produce it.
# The count is derived from real observed/owned VM ids in the case summaries —
# `owned_new_vms`/`vm_ids_seen` plus the per-case RETAINED-EVIDENCE ids
# (`interactive_evidence_new_vms`: dirs that appeared under the private
# interactive-sessions root during that case's own window with a real retained
# payload) — and the M7 ownership log. Pre-existing session dirs are never
# counted: the per-case wrapper diffs against its own before-snapshot. It is
# never fabricated.
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
vm_re = re.compile(r"vm-[0-9a-f]{8}")
# `vm-00000000` is matchlock's documented PLACEHOLDER id (it appears in the
# longest-socket-path pre-flight error), never a real VM. The frozen driver's
# vm-id scan can pick it out of that error text, so exclude the sentinel: a
# no-fake-green round must come from a real registry-backed id.
SENTINEL_IDS = frozenset({"vm-00000000"})


def add(seq):
    if not seq:
        return
    for value in seq:
        # fullmatch, not match: `$` would accept a trailing newline, letting a
        # malformed value pass as a vm id (and evade the sentinel check).
        if isinstance(value, str) and vm_re.fullmatch(value) and value not in SENTINEL_IDS:
            ids.add(value)


for path in glob.glob(os.path.join(ev, "**", "case-summary.json"), recursive=True):
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        continue
    add(data.get("owned_new_vms"))
    add(data.get("vm_ids_seen"))
    # Case-owned retained interactive-session evidence: only the ids the
    # per-case wrapper observed as NEW during that case's own window (never a
    # pre-existing/stale session dir).
    add(data.get("interactive_evidence_new_vms"))

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

# mtlk_check_case_attribution <evdir> <tier> <requested-tiers> — per-case
# completeness for a live-model tier (the E7 requirement is per COMMAND: every
# requested case must show its OWN genuine VM round; the run-level guard above
# only floors the whole tier, so one observed round would mask a case that
# observed none). Reads the expected cases from the FROZEN manifest (never from
# a guess), and for each requested case requires: exactly one case-summary.json
# whose parent directory carries the case name, at the exact evidence path the
# manifest recorded; verdict PASS; and at least one id from the STRONG channels
# (fresh retained interactive evidence / case-scoped registry ownership; the
# terminal-text channel stays diagnostics - ambiguity checks and run-level
# consistency - and is never sole proof). One VM id attributed (by any
# channel) to two cases is ambiguous and
# refuses. Also refuses (fail-closed) a header mismatch, a malformed or
# duplicate-case-row manifest, a missing freeze marker, a manifest whose
# requested-row count drifted from the freeze-time scope.count snapshot, and a
# passed tier with no recorded case rows; a tier DECLARED NOTRUN is skipped
# (a declared non-success state is never judged as an observation); when the
# tier is the ONLY requested VM tier, every run-level observed id must be
# attributed to some case (no stray evidence). Exit 93 on refusal (distinct
# from the guard's zero-round 92).
mtlk_check_case_attribution() {
  local ev="$1" tier="$2" tiers="${3:-}"
  python3 - "$ev" "$tier" "$tiers" <<'PY'
import glob
import json
import os
import re
import sys

ev = os.path.abspath(sys.argv[1])
tier = sys.argv[2]
tier_set = set((sys.argv[3] if len(sys.argv) > 3 else "").split())
manifest = os.path.join(ev, "manifest", "requested.tsv")
vm_re = re.compile(r"vm-[0-9a-f]{8}")
# `vm-00000000` is matchlock's documented placeholder id, never a real VM.
SENTINEL_IDS = frozenset({"vm-00000000"})
# STRONG channels are sufficient per-case proof of a case's own VM round
# (fresh retained evidence, or registry ownership correlated to the case).
# TERMINAL_TEXT is diagnostics only: it feeds the ambiguity check and the
# run-level consistency check, but a case whose ONLY id comes from terminal
# text is refused - a displayed id is not proof of a fresh launch.
STRONG_FIELDS = ("interactive_evidence_new_vms", "owned_new_vms")
DIAG_FIELDS = ("vm_ids_seen",)


def fail(lines):
    for line in lines:
        print("%s-attribution: FAIL %s" % (tier, line))
    sys.exit(93)


try:
    with open(manifest, encoding="utf-8", errors="replace") as fh:
        rows = [ln.rstrip("\r\n").split("\t") for ln in fh]
except OSError:
    fail(["manifest-unreadable: " + manifest])

HEADER = ["kind", "tier", "name", "requested", "required", "evidence", "status"]
if not rows or rows[0] != HEADER:
    fail(["manifest-header-mismatch"])
data_rows = rows[1:]
malformed = [i + 2 for i, cols in enumerate(data_rows) if len(cols) != 7]
if malformed:
    fail(["malformed-manifest-rows: " + ",".join(str(i) for i in malformed)])
if not os.path.exists(os.path.join(ev, "manifest", "frozen")):
    fail(["manifest-not-frozen"])

# Reconcile the CURRENT manifest against the pre-execution scope SNAPSHOT:
# mtlk_manifest_freeze recorded the number of requested rows BEFORE anything
# ran; requested-row COUNT drift after freeze (a row removed, added or
# un-requested) refuses here. This is a COUNT check: it does not catch a
# same-count identity swap, which the per-case obligations below still have to
# satisfy row-by-row against each recorded evidence path.
try:
    with open(
        os.path.join(ev, "manifest", "scope.count"), encoding="utf-8", errors="replace"
    ) as fh:
        scope_line = fh.read().strip()
except OSError:
    fail(["manifest-scope-unreadable"])
if not scope_line.startswith("scope=") or not scope_line[6:].isdigit():
    fail(["manifest-scope-unreadable: " + scope_line[:60]])
snapshot = int(scope_line[6:])
now = sum(1 for cols in data_rows if cols[3] == "1")
if snapshot != now:
    fail(["manifest-scope-mismatch: scope.count=%d, requested-now=%d" % (snapshot, now)])

tier_rows = [cols for cols in data_rows if cols[0] == "tier" and cols[1] == tier]
if len(tier_rows) != 1:
    fail(["%s-tier-row-missing (rows=%d)" % (tier, len(tier_rows))])
tier_cols = tier_rows[0]
if tier_cols[3] != "1":
    fail(["%s-tier-not-requested-in-manifest" % tier])
tier_status = tier_cols[6]
if tier_status == "NOTRUN":
    # A declared non-success state is skipped ONLY when it cannot contradict
    # the evidence tree: a NOTRUN tier that still carries requested case rows
    # or case summaries claiming execution is a contradiction and refuses.
    conflict_rows = [
        cols[2]
        for cols in data_rows
        if cols[0] == "case" and cols[1] == tier and cols[3] == "1"
    ]
    tier_dir = os.path.join(ev, tier)
    conflict_files = []
    if os.path.isdir(tier_dir):
        conflict_files = glob.glob(
            os.path.join(tier_dir, "**", "case-summary.json"), recursive=True
        )
    if conflict_rows or conflict_files:
        fail(
            [
                "tier-NOTRUN-with-case-records: rows=[%s] files=[%s]"
                % (
                    ",".join(conflict_rows) or "-",
                    ",".join(os.path.relpath(p, ev) for p in conflict_files[:5]) or "-",
                )
            ]
        )
    print(
        "%s-attribution: SKIP %s declared NOTRUN (a declared non-success state; no case execution to audit)"
        % (tier, tier)
    )
    sys.exit(0)
if tier_status != "PASS":
    fail(["%s-tier-status=%s (expected PASS or NOTRUN)" % (tier, tier_status)])

requested = [
    (cols[2], cols[5], cols[6])
    for cols in data_rows
    if cols[0] == "case" and cols[1] == tier and cols[3] == "1"
]
names = [name for name, _, _ in requested]
if len(names) != len(set(names)):
    fail(["duplicate-case-rows"])
if not requested:
    fail(["tier-executed-but-no-requested-case-rows"])

try:
    with open(os.path.join(ev, "observed-rounds.json"), encoding="utf-8") as fh:
        observed_raw = json.load(fh)
    observed = set(observed_raw.get("observed_vm_ids") or [])
except (OSError, ValueError) as err:
    fail(["observed-rounds-unreadable: " + str(err)[:120]])

# One unambiguous summary per requested case: exactly one case-summary.json
# whose parent directory carries the case's name, and it must live at the
# evidence path the frozen manifest recorded. Identity is compared with
# samefile (not a string compare): the darwin guest evidence runs on a
# case-insensitive filesystem where the recorded spelling and the on-disk
# spelling can differ in case while naming the same file.
sums_by_name = {}
for path in glob.glob(os.path.join(ev, "**", "case-summary.json"), recursive=True):
    sums_by_name.setdefault(os.path.basename(os.path.dirname(path)), []).append(path)

ev_real = os.path.realpath(ev)


def same_file(left, right):
    try:
        return os.path.samefile(left, right)
    except OSError:
        return os.path.realpath(left) == os.path.realpath(right)


def attribution_ids(summary, fields):
    ids = set()
    for field in fields:
        seq = summary.get(field)
        if isinstance(seq, list):
            for value in seq:
                if isinstance(value, str) and vm_re.fullmatch(value) and value not in SENTINEL_IDS:
                    ids.add(value)
    return ids


problems = []
claimed = {}
allids = {}
for name, evidence, row_status in requested:
    if row_status != "PASS":
        problems.append("%s: manifest-case-status=%s (must be PASS)" % (name, row_status))
        continue
    expected = os.path.join(ev, evidence, "case-summary.json")
    exp_real = os.path.realpath(expected)
    if not (exp_real == ev_real or exp_real.startswith(ev_real + os.sep)):
        problems.append("%s: evidence-path-outside-root [%s]" % (name, evidence))
        continue
    candidates = sorted(sums_by_name.get(name, []))
    if len(candidates) > 1:
        problems.append(
            "%s: duplicate-summaries [%s]"
            % (name, ", ".join(os.path.relpath(p, ev) for p in candidates))
        )
        continue
    if not candidates or not same_file(candidates[0], expected):
        problems.append("%s: missing-summary at %s" % (name, os.path.relpath(expected, ev)))
        continue
    try:
        with open(expected, encoding="utf-8") as fh:
            summary = json.load(fh)
    except (OSError, ValueError) as err:
        problems.append("%s: summary-unreadable %s" % (name, str(err)[:120]))
        continue
    if not isinstance(summary, dict) or summary.get("verdict") != "PASS":
        verdict = summary.get("verdict") if isinstance(summary, dict) else "(malformed)"
        problems.append("%s: verdict=%s (must be PASS)" % (name, verdict))
        continue
    strong = attribution_ids(summary, STRONG_FIELDS)
    diag = attribution_ids(summary, DIAG_FIELDS)
    if not strong:
        if diag:
            problems.append(
                "%s: no fresh retained-evidence or case-scoped ownership observation"
                " (terminal-text ids: %s)" % (name, ",".join(sorted(diag)))
            )
        else:
            problems.append("%s: no observed VM round (every attribution channel is empty)" % name)
        continue
    claimed[name] = sorted(strong)
    allids[name] = sorted(strong | diag)

# Cross-case reuse: one VM id must never be attributed to two cases, by ANY
# channel (a case whose text names its sibling's id stays suspicious even
# though text alone is not sufficient proof).
owner = {}
for name in sorted(allids):
    for vm_id in allids[name]:
        if vm_id in owner:
            problems.append(
                "ambiguous-attribution: %s claimed by %s and %s" % (vm_id, owner[vm_id], name)
            )
        else:
            owner[vm_id] = name

# Backing: every per-case claim must appear in the run-level evidence the
# guard passed on; when this tier is the ONLY requested VM tier, nothing may
# appear there that no case attributed (stray evidence is a refusal).
unbacked = sorted(v for v in owner if v not in observed)
if unbacked:
    problems.append("claimed-but-not-observed: " + ",".join(unbacked))
if tier_set == {"t3"}:
    stray = sorted(v for v in observed if v not in owner)
    if stray:
        problems.append("observed-but-unattributed: " + ",".join(stray))

if problems:
    fail(problems)
print(
    "%s-attribution: OK cases=%s ids=%s"
    % (tier, ",".join(names), ",".join(sorted(owner)))
)
sys.exit(0)
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
ATTR_RC=0

if [ -n "$VM_TIERS" ]; then
  mtlk_gate_lock_acquire >>"$EV/lock.txt" 2>&1
  bash "$RUN_CASES_SH" "$EV" $VM_TIERS
  VM_RC=$?
  mtlk_gate_lock_release >/dev/null 2>&1 || true

  if [ "$NEED_VM_EXEC" = "1" ]; then
    mtlk_derive_observed_rounds "$EV"
    node "$ROUNDS_GUARD" --dir "$EV" --gate interactive >>"$EV/guard.log" 2>&1
    GUARD_RC=$?
    # Per-case completeness for t3 (E7 requirement: every requested live-model
    # case must show its OWN genuine VM round). Runs only when the run-level
    # guard PASSED and every component succeeded, so a zero-round refusal
    # keeps its exact 92 semantics and a failed run keeps its component rc.
    if [ "$GUARD_RC" = 0 ] && [ "$VM_RC" = 0 ]; then
      case " $VM_TIERS " in
        *" t3 "*)
          mtlk_check_case_attribution "$EV" t3 "$VM_TIERS" >>"$EV/attribution.log" 2>&1
          ATTR_RC=$?
          ;;
      esac
    fi
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
if [ "$ATTR_RC" != 0 ]; then
  printf 'T3-ATTRIBUTION REFUSAL: the t3 per-case attribution audit refused (details: %s/attribution.log)\n' "$EV" >&2
  exit "$ATTR_RC"
fi
exit "$VM_RC"
