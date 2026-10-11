#!/usr/bin/env bash
# =============================================================================
# MTLK-INTERACTIVE-SUITE — T4 M7 isolated scheduled `--matchlock` spot-run.
#
#   m7-spot-run.sh <evidence-dir> [repo]
#
# SLOW REAL-VM GATE — DO NOT RUN BY DEFAULT
#
# Ported from the ACCEPTED W2 toolset `tools/m7-spot-run.sh`
# (`W2-toolsets-20261009.tar.gz:matrix-v2-w2/vaimetal/tools/m7-spot-run.sh`) and
# the frozen `templates/m7-spot-run-v2.sh`. The proven semantics are preserved;
# only configuration is rebound through `lib/common.sh`:
#
#   * matchlock pair + PATH          resolved BEFORE any HOME/PATH change
#   * CANDIDATE / INSTALLED mode     `mtlk_resolve_mode` / `mtlk_run_tamandua`
#   * EXPECTED-DIGEST runner input   `MTLK_EXPECT_DIGEST`, never a literal
#   * allow-private list             configured hostname + resolved IPv4 spellings
#   * scratch state/work/ports       `MTLK_M7_*`, private TMPDIR
#   * the repo argument              `<repo>` / `MTLK_M7_REPO`
#
# ADDITION (tamandua-sus fix): the historical instrument enumerated "owned" VMs
# ONLY from diag-bundle `vmId` strings, so a STOPPED attempt-owned VM escaped
# detection. This port enumerates the matchlock VM registry `vms` table
# (`$(mtlk_matchlock_state_db)`, INCLUDING `status='stopped'`) and requires
# ownership evidence — creation inside the attempt window AND an exact
# workdir/config reference (or the run's own diag bundle naming the exact id) —
# before any exact-id `matchlock rm`. A failed/unknown removal RETAINS state and
# fails; an unrelated pre-existing VM is NEVER touched.
#
# BOUND VERDICT: the evaluated outcome is written to `$B/m7.verdict`, and the
# ABSOLUTE path of THAT invocation's file is recorded in
# `<evidence-dir>/M7/m7-verdict-path.txt`. The final gate reads the bound file,
# so a stray `M7-PASS` token in captured sub-output can never be the gate.
#
# GATE LOCK: acquired at ONE layer only through `lib/lock.sh`. When a composed
# runner already holds it (`MTLK_GATE_LOCK_HELD=1`) this script SKIPs
# acquisition (single-layer rule) and never nests a second acquisition.
#
# M7 CANNOT BE SKIPPED via inherited environment: a skip switch is ignored and a
# notice is recorded, and the spot-run still executes. A missing prerequisite
# fails closed instead of silently passing.
#
# The operator's HOME is deliberately NOT replaced by default (opt-in via
# `MTLK_M7_ISOLATE_HOME=1`): the do-now round needs the operator's model config
# and matchlock registry (`$HOME/.matchlock/state.db`) — the very registry the
# attempt-owned accounting above inspects. Only the tamandua state/DB/ports and
# TMPDIR are made private per run.
# =============================================================================
set -u

SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd)"
SUITE_DIR="$(cd -- "$SELF_DIR/.." && pwd)"
# shellcheck source=../lib/common.sh
. "$SUITE_DIR/lib/common.sh"
# shellcheck source=../lib/lock.sh
. "$SUITE_DIR/lib/lock.sh"
# shellcheck source=../lib/image-store.sh
. "$SUITE_DIR/lib/image-store.sh"

EV_ROOT="${1:-}"
REPO_ARG="${2:-}"
if [ -z "$EV_ROOT" ]; then
  printf 'usage: m7-spot-run.sh <evidence-dir> [repo]\n' >&2
  exit 2
fi
if [ ! -d "$EV_ROOT" ]; then
  mkdir -p "$EV_ROOT" || { printf 'M7-ABORT cannot-create-evidence %s\n' "$EV_ROOT"; exit 90; }
fi
EV_ROOT="$(cd -- "$EV_ROOT" && pwd)"
EVM7="$EV_ROOT/M7"
mkdir -p "$EVM7" || { printf 'M7-ABORT cannot-create-m7-evidence %s\n' "$EVM7"; exit 90; }

PYTHON="${MTLK_PYTHON:-python3}"

# -----------------------------------------------------------------------------
# M7 cannot be skipped via inherited environment.
#
# The composed wave runner must ALWAYS execute M7 when t4 is requested; a skip
# switch inherited from an unrelated environment must never turn the tier into a
# silent pass. We record the ignored switch and keep going.
# -----------------------------------------------------------------------------
mtlk_m7_skip_notice() {
  if [ -n "${MTLK_M7_SKIP:-}" ] || [ -n "${LI155_M7:-}" ] || [ -n "${MTLK_SKIP_M7:-}" ]; then
    printf 'M7-NOTICE skip-switch-ignored (M7 cannot be skipped via inherited environment)\n'
  fi
}
mtlk_m7_skip_notice

# -----------------------------------------------------------------------------
# Preflight: resolve the runtime + mode + required digest BEFORE any PATH/HOME
# change, then bind the repo and the configured scratch inputs.
# -----------------------------------------------------------------------------
mtlk_resolve_runtime
mtlk_probe_capabilities
mtlk_require_digest
mtlk_resolve_mode || exit $?

REPO="${REPO_ARG:-${MTLK_M7_REPO:-$MTLK_REPO_ROOT}}"
REPO="$(cd -- "$REPO" 2>/dev/null && pwd)" || {
  printf 'M7-ABORT bad-repo %s\n' "${REPO_ARG:-}"
  exit 90
}

case "${MTLK_MODE:-candidate}" in
  candidate)
    if [ "$REPO" != "$MTLK_REPO_ROOT" ]; then
      printf 'M7-ABORT candidate-repo-mismatch %s\n' "$REPO"
      exit 90
    fi
    BH="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || true)"
    [ -n "$BH" ] || { printf 'M7-ABORT repo-head-unknown %s\n' "$REPO"; exit 90; }
    [ "$(git -C "$REPO" status --porcelain | wc -l | tr -d ' ')" = "0" ] ||
      { printf 'M7-ABORT repo-dirty %s\n' "$REPO"; exit 90; }
    [ -f "$REPO/dist/cli/cli.js" ] || { printf 'M7-ABORT no-cli at %s\n' "$REPO"; exit 90; }
    ;;
  installed)
    TBM="$(command -v tamandua 2>/dev/null || true)"
    [ -n "$TBM" ] || { printf 'M7-ABORT no-tamandua-on-PATH\n'; exit 90; }
    TRM="$("$PYTHON" -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$TBM" 2>/dev/null || true)"
    if [ -n "${REPO_ARG:-}" ]; then
      case "$TRM" in
        "$REPO"/*) : ;;
        *) printf 'M7-ABORT tamandua-resolve tb=%s tr=%s repo=%s\n' "$TBM" "$TRM" "$REPO"; exit 90 ;;
      esac
    fi
    BH="installed"
    ;;
esac

ML="${MTLK_MATCHLOCK_RPC_BIN:-matchlock}"

# Matchlock provenance (PROTECTED assertion, configuration-bindable): the
# accepted release baseline's matchlock binary contains the build commit. The
# needle is a binding — override only when the operator deliberately targets a
# different accepted build — never dropped, so an unrelated binary cannot
# silently qualify the tier.
MATCHLOCK_VERSION_NEEDLE="${MTLK_M7_MATCHLOCK_VERSION:-2afbca3}"
VER="$("$ML" version 2>&1 | head -1)"
case "$VER" in
  *"$MATCHLOCK_VERSION_NEEDLE"*) : ;;
  *) printf 'M7-ABORT matchlock-version: %s\n' "$VER"; exit 90 ;;
esac

# Digest preflight against the local matchlock image store (a RUNNER INPUT, not
# a constant). The exact ref is configuration; a missing expected ref or a
# digest mismatch fails closed before any VM boots.
EXP="${MTLK_EXPECT_DIGEST:-}"
STORE_DB="${MTLK_M7_STORE_DB:-$MTLK_OPERATOR_CACHE/images/metadata.db}"
IMAGE_REF="${MTLK_M7_IMAGE_REF:-igorhvr/tamandua}"
"$PYTHON" - "$EXP" "$STORE_DB" "$IMAGE_REF" <<'PYD'
import sqlite3, sys
exp, db, ref = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    con = sqlite3.connect('file:%s?mode=ro' % db, uri=True)
    rows = list(con.execute("select tag, digest from images where tag like ?", (ref + '%',)))
    con.close()
except Exception as e:
    print("M7-STORE-READ-FAIL", e); sys.exit(1)
print("store rows:", rows)
exact = [d for t, d in rows if t == ref]
if not exact:
    print("M7-STORE-REF-MISSING exact ref %r absent (fail-closed)" % ref); sys.exit(1)
if exact[0] != exp:
    print("M7-IMAGE-DIGEST-MISMATCH exact-ref got", exact[0], "want", exp); sys.exit(1)
print("M7-IMAGE-DIGEST-OK (exact ref %s == expected)" % ref)
PYD
[ "$?" -eq 0 ] || { printf 'M7-FAIL digest-preflight\n'; exit 1; }

# -----------------------------------------------------------------------------
# Per-run scratch: private state DB/ports/TMPDIR and a fresh evidence binding.
# -----------------------------------------------------------------------------
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE="${MTLK_M7_BASE:-}"
if [ -z "$BASE" ]; then
  BASE="$(mktemp -d "${TMPDIR:-/tmp}/mtlk-m7.XXXXXX")" || {
    printf 'M7-ABORT mktemp-failed\n'
    exit 90
  }
fi
B="$BASE/$STAMP"
STATE="$B/state"
WORK="$B/work"
PRIVATE_TMP="$B/tmp"
mkdir -p "$STATE" "$WORK" "$PRIVATE_TMP" || { printf 'M7-ABORT mkdir-failed %s\n' "$B"; exit 90; }
export TMPDIR="$PRIVATE_TMP"

# The attempt's matchlock VM REGISTRY. It is the matchlock state DB under the
# (possibly private) HOME — NOT the image store's metadata.db. Overridable for
# fixture controls.
STATE_DB="$(mtlk_matchlock_state_db)"

# BOUND verdict path: record THIS invocation's evaluated verdict file so receipt
# validation can never pick up a stale attempt's m7.verdict.
VERDICT_FILE="$B/m7.verdict"
printf '%s\n' "$VERDICT_FILE" >"$EVM7/m7-verdict-path.txt"

PORT_BASE="${MTLK_M7_PORT_BASE:-42201}"
case "$PORT_BASE" in
  '' | *[!0-9]*) printf 'M7-ABORT bad-port-base %s\n' "$PORT_BASE"; exit 90 ;;
esac
CTRL="${MTLK_M7_CTRL_PORT:-$PORT_BASE}"
DASH="${MTLK_M7_DASHBOARD_PORT:-$((PORT_BASE + 1))}"
MCP="${MTLK_M7_MCP_PORT:-$((PORT_BASE + 2))}"

# VM tooling must be reachable even when the caller's PATH is minimal (mke2fs
# needs /usr/sbin; the guest build needs go under /usr/local/go/bin).
case ":$PATH:" in
  *:/usr/sbin:*) : ;;
  *) export PATH="$PATH:/usr/sbin" ;;
esac
if [ -d /usr/local/go/bin ]; then
  case ":$PATH:" in
    *:/usr/local/go/bin:*) : ;;
    *) export PATH="$PATH:/usr/local/go/bin" ;;
  esac
fi

export TAMANDUA_STATE_DIR="$STATE"
export TAMANDUA_DB_PATH="$STATE/tamandua.db"
export TAMANDUA_CONTROL_PORT="$CTRL"
export TAMANDUA_DASHBOARD_PORT="$DASH"
export TAMANDUA_MCP_PORT="$MCP"
export TAMANDUA_TEST_GUARD="${MTLK_M7_TEST_GUARD:-0}"

# Optional private HOME: seed a fully usable private image store from the
# operator store and carry the model config over. OFF by default so the do-now
# round keeps the operator's model config + matchlock registry (the reference
# semantics); opt in with MTLK_M7_ISOLATE_HOME=1.
OPERATOR_HOME="$HOME"
if mtlk_is_truthy "${MTLK_M7_ISOLATE_HOME:-0}"; then
  PRIVATE_HOME="$B/home"
  mkdir -p "$PRIVATE_HOME" || { printf 'M7-ABORT cannot-create-private-home\n'; exit 90; }
  mtlk_image_store_seed "$PRIVATE_HOME" || { printf 'M7-ABORT image-store-seed-failed\n'; exit 90; }
  if [ -d "$OPERATOR_HOME/.pi/agent" ]; then
    mkdir -p "$PRIVATE_HOME/.pi" && cp -a "$OPERATOR_HOME/.pi/agent" "$PRIVATE_HOME/.pi/agent"
  fi
  export HOME="$PRIVATE_HOME"
fi

# Allow-private entries: cover BOTH the configured hostname spelling AND the
# IPv4 literal(s) the guest resolves it to (the model config may use either).
# Resolution is best-effort; an unresolvable host still keeps the hostname.
resolve_allow_list() {
  local list="${MTLK_M7_ALLOW_PRIVATE:-${MTLK_ALLOW_PRIVATE:-}}"
  local host="${MTLK_MODEL_HOST:-}" port="${MTLK_MODEL_ENDPOINT##*:}"
  case "$port" in
    '' | *[!0-9]*) port="" ;;
  esac
  local ip
  for ip in $("$PYTHON" - "$host" <<'PYIP'
import socket, sys
try:
    infos = socket.getaddrinfo(sys.argv[1], None, socket.AF_INET)
except Exception:
    sys.exit(0)
seen = []
for info in infos:
    addr = info[4][0]
    if addr not in seen:
        seen.append(addr)
print(" ".join(seen))
PYIP
  ); do
    [ -n "$ip" ] || continue
    if [ -n "$port" ]; then
      list="$list $ip:$port"
    else
      list="$list $ip"
    fi
  done
  printf '%s\n' "$list"
}
ALLOW_LIST="$(resolve_allow_list)"
ALLOW_FLAGS=""
for entry in $ALLOW_LIST; do
  ALLOW_FLAGS="$ALLOW_FLAGS --matchlock-allow-private $entry"
done

# Single-layer gate lock: HELD when this script owns it, SKIP when the composed
# runner already holds it. Never nests a second acquisition.
mtlk_gate_lock_acquire >"$EVM7/lock.txt" 2>&1 || { printf 'M7-ABORT gate-lock-failed\n'; exit 6; }
cat "$EVM7/lock.txt"

# -----------------------------------------------------------------------------
# Ownership-verified daemon stop: only a daemon whose pidfile PID is alive AND
# verifiably THIS attempt's is stopped. The gate lock is released here too.
# -----------------------------------------------------------------------------
attempt_daemon_stopped=0
stop_attempt_daemon() {
  if [ "${attempt_daemon_stopped:-0}" = "1" ]; then
    mtlk_gate_lock_release || true
    return 0
  fi
  attempt_daemon_stopped=1
  (
    if [ -f "$STATE/tamandua.pid" ]; then
      DP="$(cat "$STATE/tamandua.pid" 2>/dev/null || true)"
      OURS=0
      if [ -n "$DP" ] && kill -0 "$DP" 2>/dev/null; then
        if [ -r "/proc/$DP/environ" ]; then
          tr '\0' '\n' <"/proc/$DP/environ" 2>/dev/null | grep -qx "TAMANDUA_STATE_DIR=$STATE" && OURS=1
        else
          CMD="$(ps -p "$DP" -o command= 2>/dev/null || true)"
          case "$CMD" in *dist/server/daemon.js*) OURS=1 ;; *) OURS=0 ;; esac
          CPP="$(cat "$STATE/control-plane-port" 2>/dev/null || true)"
          [ "$CPP" = "$CTRL" ] || OURS=0
        fi
      fi
      if [ "$OURS" = 1 ]; then
        mtlk_run_tamandua daemon stop || true
      else
        printf 'attempt pid (%s) not verifiably ours; not stopping anything\n' "$DP"
      fi
    else
      printf 'no attempt pidfile; not stopping anything\n'
    fi
  ) 2>/dev/null || true
  mtlk_gate_lock_release || true
}
trap stop_attempt_daemon EXIT

# -----------------------------------------------------------------------------
# Strict inventory parse (header + EVERY row). An unparsed row makes the listing
# untrustworthy (fail-closed), so a malformed snapshot can never become evidence
# that an owned VM disappeared.
# -----------------------------------------------------------------------------
mtlk_m7_parse_inventory() {
  local raw="$1" ids_out="$2" status_out="$3"
  "$PYTHON" - "$raw" "$ids_out" "$status_out" <<'PYPARSE'
import re, sys
raw, ids_out, status_out = sys.argv[1], sys.argv[2], sys.argv[3]
lines = [l for l in open(raw, errors="replace").read().splitlines() if l.strip()]
if not lines or re.match(r"^ID\s+STATUS\s+IMAGE\b", lines[0]) is None:
    raise SystemExit("header-invalid:" + raw)
rows = []
for l in lines[1:]:
    m = re.match(r"\s*(vm-[0-9a-f]{8})\s+(\S+)", l)
    if not m:
        raise SystemExit("row-unparsed:%s:%s" % (raw, l[:80]))
    rows.append((m.group(1), m.group(2)))
with open(status_out, "w") as fh:
    for vid, st in rows:
        fh.write("%s %s\n" % (vid, st))
with open(ids_out, "w") as fh:
    fh.write("\n".join(sorted(r[0] for r in rows)) + ("\n" if rows else ""))
print("inventory-ok rows=%d" % len(rows))
PYPARSE
}

# -----------------------------------------------------------------------------
# The spot-run proper (captured into the M7 invocation log).
# -----------------------------------------------------------------------------
run_spot() {
  echo "M7-START $(date -u +%FT%TZ) mode=${MTLK_MODE:-} repo=$REPO matchlock=$ML state=$STATE state_db=$STATE_DB work=$WORK"
  MTLK_MATCHLOCK_SHA="${MTLK_MATCHLOCK_SHA:-$(mtlk_sha256 "$ML" 2>/dev/null || true)}"
  echo "M7-IDENTITY tamandua_sha=${MTLK_TAMANDUA_SHA:-} matchlock_sha=${MTLK_MATCHLOCK_SHA:-}"
  echo "M7-ALLOW ${ALLOW_LIST:-}"
  echo "-- install do-now:"
  mtlk_run_tamandua workflow install do-now >"$B/install.txt" 2>&1
  IRC=$?
  tail -3 "$B/install.txt"
  echo "install-rc=$IRC"
  [ "$IRC" -eq 0 ] || { echo "M7-ABORT install-rc=$IRC"; return 91; }

  echo "-- daemon start:"
  mtlk_run_tamandua daemon start >"$B/daemon-start.txt" 2>&1
  DRC=$?
  tail -3 "$B/daemon-start.txt"
  echo "daemon-start-rc=$DRC"
  [ "$DRC" -eq 0 ] || { echo "M7-ABORT daemon-start-rc=$DRC"; return 92; }
  sleep "${MTLK_M7_DAEMON_SETTLE_S:-4}"
  mtlk_run_tamandua daemon status >"$B/daemon-status.txt" 2>&1
  tail -8 "$B/daemon-status.txt"

  [ -f "$STATE/tamandua.pid" ] || { echo "M7-ABORT no-attempt-pidfile"; return 98; }
  DPID="$(cat "$STATE/tamandua.pid" 2>/dev/null || true)"
  kill -0 "$DPID" 2>/dev/null || { echo "M7-ABORT pidfile-pid-not-alive ($DPID)"; return 98; }
  if [ -r "/proc/$DPID/environ" ]; then
    ENVF="$(tr '\0' '\n' <"/proc/$DPID/environ" 2>/dev/null)"
    echo "$ENVF" | grep -qx "TAMANDUA_STATE_DIR=$STATE" || { echo "M7-ABORT pid-environ-state-mismatch"; return 98; }
    echo "$ENVF" | grep -qx "TAMANDUA_DB_PATH=$STATE/tamandua.db" || { echo "M7-ABORT pid-environ-db-mismatch"; return 98; }
  else
    CMD="$(ps -p "$DPID" -o command= 2>/dev/null || true)"
    case "$CMD" in
      *dist/server/daemon.js*) : ;;
      *) echo "M7-ABORT pid-command-mismatch"; return 98 ;;
    esac
  fi
  CPP="$(cat "$STATE/control-plane-port" 2>/dev/null || true)"
  [ "$CPP" = "$CTRL" ] || { echo "M7-ABORT control-plane-port-mismatch ($CPP vs $CTRL)"; return 98; }
  echo "attempt-pidfile=$STATE/tamandua.pid pid=$DPID control-plane-port=$CPP"

  HC="$(curl -m 6 -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$CTRL/control/health" 2>/dev/null || echo 000)"
  echo "control-health http=$HC"
  [ "$HC" = "200" ] || { echo "M7-ABORT control-health=$HC"; return 94; }

  # Attempt window opens before the first possible VM creation.
  T0="$(date -u +%FT%TZ)"

  "$ML" list >"$B/ml-before.txt" 2>&1 || { echo "M7-ABORT matchlock-list-failed"; return 97; }
  head -8 "$B/ml-before.txt"
  mtlk_m7_parse_inventory "$B/ml-before.txt" "$B/ids-before.txt" "$B/status-before.txt" ||
    { echo "M7-ABORT inventory-before-strict-parse-failed"; return 97; }

  echo "-- run:"
  OUT="$(mtlk_run_tamandua workflow run do-now 'Create a file named spot.txt in the current working directory containing exactly: spot-ok' \
    --matchlock $ALLOW_FLAGS \
    --working-directory-for-harness "$WORK" 2>&1)"
  RRC=$?
  echo "run-rc=$RRC"
  printf '%s\n' "$OUT" | head -40
  RID="$(printf '%s' "$OUT" | grep -oE 'run-[0-9a-f]{8}-[0-9a-f-]{27}' | head -1)"
  [ -n "$RID" ] || { echo "M7-FAIL no-rid"; return 95; }
  echo "rid=$RID"

  DEADLINE=$(($(date +%s) + ${MTLK_TIMEOUT_T4:-2400}))
  STATUS=""
  while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    ST="$(mtlk_run_tamandua workflow status "$RID" --json 2>/dev/null | "$PYTHON" -c 'import json,sys
try:
  d=json.load(sys.stdin); print(d.get("status") or d.get("runStatus") or (d.get("run") or {}).get("status") or "")
except Exception: print("")')"
    [ -n "$ST" ] && STATUS="$ST"
    case "$ST" in
      completed | failed | canceled) break ;;
    esac
    sleep 15
  done
  if [ -z "$STATUS" ] || [ "$STATUS" = "running" ] || [ "$STATUS" = "pending" ]; then
    echo "-- TIMEOUT: stopping exact run $RID"
    mtlk_run_tamandua workflow stop "$RID" >"$B/stop.txt" 2>&1
    echo "stop-rc=$?"
    tail -3 "$B/stop.txt"
    i=0
    while [ "$i" -lt 8 ]; do
      i=$((i + 1))
      ST="$(mtlk_run_tamandua workflow status "$RID" --json 2>/dev/null | "$PYTHON" -c 'import json,sys
try:
  d=json.load(sys.stdin); print(d.get("status") or d.get("runStatus") or (d.get("run") or {}).get("status") or "")
except Exception: print("")')"
      case "$ST" in
        completed | failed | canceled) STATUS=$ST; break ;;
      esac
      sleep 10
    done
    case "$STATUS" in
      completed | failed | canceled) : ;;
      *) echo "M7-FAIL stop-uncertain status=$STATUS"; return 96 ;;
    esac
  fi
  echo "final-status=$STATUS"
  mtlk_run_tamandua workflow status "$RID" 2>&1 | tail -30
  mtlk_run_tamandua run diagnose "$RID" --out "$B/diag" >/dev/null 2>&1 && echo "diag-bundle=$B/diag"

  BIND=1
  if [ -d "$B/diag" ]; then
    "$PYTHON" - "$B/diag" "$EXP" <<'PYB'
import glob, json, os, sys
root, exp = sys.argv[1], sys.argv[2]
cands = []
for p in glob.glob(os.path.join(root, '**', 'matchlock.json'), recursive=True):
    try:
        d = json.load(open(p))
    except Exception:
        continue
    pol = d.get('policy') or {}
    got = pol.get('resolvedImageDigest')
    if got:
        cands.append((p, got, d.get('status')))
if not cands:
    print("M7-IMAGE-BINDING-FAIL: no resolvedImageDigest recorded in the run's diag matchlock.json"); sys.exit(1)
bad = False
for p, got, st in cands:
    print("run-image-digest:", got, "status:", st, "src:", p)
    if st != "present" or got != exp:
        bad = True
if bad:
    print("M7-IMAGE-BINDING-FAIL want", exp); sys.exit(1)
print("M7-IMAGE-BINDING-OK: the run's own resolvedImageDigest == expected")
PYB
    BIND=$?
  else
    echo "M7-IMAGE-BINDING-FAIL: no diag bundle produced"
  fi
  echo "image-binding-rc=$BIND"

  "$ML" list >"$B/ml-after.txt" 2>&1 || { echo "M7-ABORT matchlock-list-after-failed"; return 97; }
  mtlk_m7_parse_inventory "$B/ml-after.txt" "$B/ids-after.txt" "$B/status-after.txt" ||
    { echo "M7-ABORT inventory-after-strict-parse-failed"; return 97; }
  T1="$(date -u +%FT%TZ)"

  # ---------------------------------------------------------------------------
  # Attempt-owned accounting (tamandua-sus fix). Enumerate the registry `vms`
  # table INCLUDING stopped rows; require creation-window + exact
  # workdir/config reference (or the run's own diag naming the exact id) before
  # any exact-id removal. Anything unproven stays unowned and is never removed.
  # ---------------------------------------------------------------------------
  "$PYTHON" - "$STATE_DB" "$WORK" "$STATE" "$T0" "$T1" "$B/ids-before.txt" "$B/ids-after.txt" \
    "$B/diag" "$B/ownership.json" "$B/owned-present.txt" "$B/owned-all.txt" "$B/unowned-new.txt" <<'PYOWN'
import glob, json, os, re, sqlite3, sys
db, work, state, t0, t1, before_p, after_p, diag_dir, json_p, present_p, owned_p, unowned_p = sys.argv[1:13]


def read_ids(p):
    try:
        return [l.strip() for l in open(p, errors="replace") if l.strip()]
    except OSError:
        return []


def mount_match(cfg_s, wd):
    """True only when wd is EXACTLY a declared GUEST destination in the stored
    config (the fork stores mounts[spec.GuestPath] = mount). A substring or a
    source-side path is not ownership; None when the config cannot prove it."""
    try:
        d = json.loads(cfg_s)
    except Exception:
        return None
    vfs = d.get("vfs")
    if not isinstance(vfs, dict):
        return None
    mounts = vfs.get("mounts")
    dests = set()
    if isinstance(mounts, dict):
        dests.update(k for k in mounts.keys() if isinstance(k, str))
    elif isinstance(mounts, list):
        for m in mounts:
            if isinstance(m, dict):
                for kk in ("destination", "guest", "guest_path"):
                    if isinstance(m.get(kk), str):
                        dests.add(m[kk])
    else:
        return None
    return wd in dests


before = set(read_ids(before_p))
after = read_ids(after_p)
after_set = set(after)

diag_ids = set()
if diag_dir and os.path.isdir(diag_dir):
    for p in glob.glob(os.path.join(diag_dir, "**", "*"), recursive=True):
        try:
            if not os.path.isfile(p) or os.path.getsize(p) > 8_000_000:
                continue
            text = open(p, errors="replace").read()
        except OSError:
            continue
        diag_ids.update(re.findall(r"vm-[0-9a-f]{8}", text))

# Registry read (READ-ONLY): the FULL `vms` table, INCLUDING status='stopped'.
rows = {}
read_ok = True
read_err = ""
try:
    con = sqlite3.connect("file:%s?mode=ro" % db, uri=True)
    try:
        cur = con.execute("SELECT id, status, created_at, config_json FROM vms")
    except sqlite3.OperationalError:
        cur = con.execute("SELECT id, status, created_at, '' FROM vms")
    for vid, status, created, cfg in cur:
        if isinstance(cfg, (bytes, bytearray)):
            cfg_s = cfg.decode("utf-8", "replace")
        else:
            cfg_s = str(cfg or "")
        rows[str(vid)] = (str(status or ""), str(created or ""), cfg_s)
    con.close()
except Exception as exc:
    read_ok = False
    read_err = str(exc)


def evidence_for(vid):
    row = rows.get(vid)
    if not row:
        return None
    status, created, cfg = row
    created_s = created.split(".")[0] + "Z" if "." in created else created
    window_ok = bool(t0 and t1 and created_s and (t0 <= created_s <= t1))
    ref_ok = (bool(work) and mount_match(cfg, work) is True) or (bool(state) and state in cfg)
    diag_ok = vid in diag_ids
    ev = []
    if window_ok:
        ev.append("created-in-attempt-window")
    if ref_ok:
        ev.append("exact-workdir/config-reference")
    if diag_ok:
        ev.append("diag-bundle-named-id")
    if window_ok and (ref_ok or diag_ok):
        return {"status": status, "created_at": created, "evidence": ev}
    return None


owned = {}
unowned_new = []
for vid in after:
    if vid in before:
        continue
    ev = evidence_for(vid)
    if ev is None:
        unowned_new.append(vid)
    else:
        owned[vid] = ev

# The tamandua-sus blind spot: a STOPPED attempt-owned row that never appeared
# in the diag bundle. It is already absent from the after inventory, but it is
# still accounted (recorded) so the gap cannot recur silently.
for vid in rows:
    if vid in owned or vid in before or vid in after_set:
        continue
    status = rows[vid][0]
    if status != "stopped":
        continue
    ev = evidence_for(vid)
    if ev is not None:
        ev["evidence"] = list(ev["evidence"]) + ["stopped-row"]
        owned[vid] = ev

present_owned = sorted(v for v in owned if v in after_set)
open(present_p, "w").write("\n".join(present_owned) + ("\n" if present_owned else ""))
open(owned_p, "w").write("\n".join(sorted(owned)) + ("\n" if owned else ""))
open(unowned_p, "w").write("\n".join(sorted(unowned_new)) + ("\n" if unowned_new else ""))
json.dump(
    {
        "read_ok": read_ok,
        "read_err": read_err,
        "state_db": db,
        "workdir": work,
        "state_dir": state,
        "window": [t0, t1],
        "owned": owned,
        "present_owned": present_owned,
        "unowned_new": sorted(unowned_new),
        "diag_ids": sorted(diag_ids),
        "before": sorted(before),
        "after": sorted(after),
    },
    open(json_p, "w"),
    indent=2,
    sort_keys=True,
)
print(
    "ownership rows=%d owned=%d present_owned=%d unowned_new=%d read_ok=%s"
    % (len(rows), len(owned), len(present_owned), len(unowned_new), read_ok)
)
sys.exit(0 if read_ok else 1)
PYOWN
ORC=$?
echo "ownership-rc=$ORC"
if [ "$ORC" -ne 0 ]; then
  echo "M7-FAIL ownership-enumeration-failed (state DB unreadable; state retained)"
  echo "FAIL" >"$VERDICT_FILE"
  return 0
fi

OWNED_ALL="$(tr '\n' ' ' <"$B/owned-all.txt" 2>/dev/null || true)"
OWNED_PRESENT="$(tr '\n' ' ' <"$B/owned-present.txt" 2>/dev/null || true)"
UNOWNED_NEW="$(tr '\n' ' ' <"$B/unowned-new.txt" 2>/dev/null || true)"
echo "owned=[$OWNED_ALL] owned_present=[$OWNED_PRESENT] unowned_new=[$UNOWNED_NEW]"

# Remove ONLY attempt-owned VMs, by EXACT id. Never a glob, never by image.
RM_FAILED=0
if [ -n "$OWNED_PRESENT" ]; then
  for v in $OWNED_PRESENT; do
    "$ML" rm "$v" >"$B/rm-$v.txt" 2>&1
    RR=$?
    printf 'owned-removal %s rc=%s %s\n' "$v" "$RR" "$(tail -1 "$B/rm-$v.txt" 2>/dev/null || true)"
    [ "$RR" -eq 0 ] || RM_FAILED=1
  done
else
  echo "owned-removal: no attempt-owned VM present in the after inventory"
fi

# Verify with a STRICT inventory. An unreadable/malformed verification listing
# is a failure (state retained), never "nothing left".
VERIFY_OK=1
"$ML" list >"$B/ml-verify.txt" 2>&1 || VERIFY_OK=0
if [ "$VERIFY_OK" = 1 ]; then
  mtlk_m7_parse_inventory "$B/ml-verify.txt" "$B/ids-verify.txt" "$B/status-verify.txt" || VERIFY_OK=0
fi
OWNED_REMAIN=0
if [ "$VERIFY_OK" = 1 ]; then
  for v in $OWNED_ALL; do
    if grep -qx "$v" "$B/ids-verify.txt" 2>/dev/null; then
      OWNED_REMAIN=$((OWNED_REMAIN + 1))
      echo "owned-remaining $v"
    fi
  done
fi
echo "verify-ok=$VERIFY_OK owned_remaining=$OWNED_REMAIN rm_failed=$RM_FAILED (state retained on failure)"

LEFT=""
if [ "$VERIFY_OK" = 1 ]; then
  LEFT="$("$PYTHON" - "$B/ids-before.txt" "$B/status-verify.txt" <<'PYL'
import sys
before = set(l.split()[0] for l in open(sys.argv[1], errors="replace") if l.strip())
try:
    rows = [l.split() for l in open(sys.argv[2], errors="replace") if l.strip()]
except OSError:
    rows = []
left = sorted(v for v, st in rows if st == "running" and v not in before)
print(" ".join(left))
PYL
)"
fi
echo "unexpected-remaining-running: [$LEFT]"

echo "-- artifact: [$(cat "$WORK/spot.txt" 2>/dev/null || echo MISSING)] sha=$( { sha256sum "$WORK/spot.txt" 2>/dev/null || shasum -a 256 "$WORK/spot.txt" 2>/dev/null || echo none; } | awk '{print $1}')"
echo "-- attempt-db: $(ls -la "$STATE/tamandua.db" 2>/dev/null || echo ABSENT)"
echo "-- events tail:"
mtlk_run_tamandua logs "$RID" --tail 60 2>&1 | tail -60

ART_OK=no
[ "$(cat "$WORK/spot.txt" 2>/dev/null)" = "spot-ok" ] && ART_OK=yes
echo "M7-VERDICT mode=${MTLK_MODE:-} status=$STATUS artifact_ok=$ART_OK run_rc=$RRC owned=[$OWNED_ALL] owned_remaining=$OWNED_REMAIN unowned_new=[$UNOWNED_NEW] leftover=[$LEFT] image_binding_rc=$BIND verify_ok=$VERIFY_OK rm_failed=$RM_FAILED"
if [ "$STATUS" = "completed" ] && [ "$ART_OK" = "yes" ] && [ "$RRC" -eq 0 ] && \
  [ "$BIND" = "0" ] && [ -z "$LEFT" ] && [ -n "$(echo $OWNED_ALL)" ] && \
  [ "$OWNED_REMAIN" = "0" ] && [ "$RM_FAILED" = "0" ] && [ "$VERIFY_OK" = "1" ] && \
  [ -z "$UNOWNED_NEW" ]; then
  echo "PASS" >"$VERDICT_FILE"
  echo "M7-PASS"
else
  echo "FAIL" >"$VERDICT_FILE"
  echo "M7-FAIL status=$STATUS artifact_ok=$ART_OK run_rc=$RRC owned_remaining=$OWNED_REMAIN unowned_new=[$UNOWNED_NEW] leftover=[$LEFT] image_binding_rc=$BIND verify_ok=$VERIFY_OK rm_failed=$RM_FAILED"
fi
  echo "M7-END $(date -u +%FT%TZ)"
  return 0
}

LOG="$EVM7/m7.log"
run_spot >"$LOG" 2>&1
SRC=$?
[ -f "$VERDICT_FILE" ] || printf 'FAIL\n' >"$VERDICT_FILE"

# The gate is the BOUND verdict FILE, never a stray M7-PASS token in the log.
M7V="$(cat "$VERDICT_FILE" 2>/dev/null || echo MISSING)"
if [ "$SRC" -ne 0 ] && [ "$M7V" = "PASS" ]; then
  M7V="FAIL"
  printf 'FAIL\n' >"$VERDICT_FILE"
fi
FINAL="FAIL"
[ "$M7V" = "PASS" ] && FINAL="PASS"
printf '%s log=%s verdict-file=%s\n' "$FINAL" "$LOG" "$M7V" >>"$LOG"
printf '%s log=%s verdict-file=%s\n' "$FINAL" "$LOG" "$M7V"
if [ "$M7V" = "PASS" ]; then
  exit 0
fi
exit 1
