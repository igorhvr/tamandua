#!/usr/bin/env bash
# =============================================================================
# MTLK-INTERACTIVE-SUITE — per-case wrapper.
#
#   run-case.sh <case.json> <outdir> [matchlock-bin]
#
# Ported from the ACCEPTED W2 toolset `tools/run-case.sh` (v3, 2026-10-08).
# The semantics are preserved exactly; only configuration is rebound through
# `lib/common.sh` (paths, matchlock binary, workdir, VM registry) and the known
# wrong image-cache registry spelling is NOT copied.
#
# Guarantees (PROTECTED assertions — rebinding only, never weakening):
#
#   * FAIL-CLOSED inventory: `matchlock list` rc AND header are checked. An
#     invalid BEFORE inventory REFUSES the case before launch (exit 2) and the
#     driver is never invoked; an invalid AFTER inventory fails the case
#     (`cleanup_readable=false`, `cleanup_read=FAIL-CLOSED ...`) and never
#     treats an unreadable listing as empty. An unparsed row makes the listing
#     untrustworthy (fail-closed).
#   * CASE-SCOPED OWNERSHIP: a new VM row is owned only when (a) the case's own
#     captured output named the exact id, or (b) the stored config declares this
#     case's workdir as an EXACT guest mount DESTINATION and the row was created
#     inside this case's window. A substring/other-case mount is NOT ownership.
#     Unowned new rows are reported and NEVER removed; their presence fails the
#     case (incomplete cleanup is not success).
#   * MOUNT WRITE-THROUGH: when case["mntchk"] is true the host pre-deletes the
#     nonce file through the identical-path mount and, after the case, verifies
#     the file and its exact content (`MNTCHK-<tag>-<digits>`).
#
# Configuration bindings:
#   workdir        MTLK_WORKDIR (common.sh default)
#   matchlock bin  $3, else MTLK_MATCHLOCK_RPC_BIN, else `matchlock` on PATH
#   VM registry    $HOME/.matchlock/state.db, overridable via
#                  MTLK_MATCHLOCK_STATE_DB (fixtures)
#   driver         MTLK_DRIVER, else runner/pty-drive.py
#   case bindings  `{{MTLK_*}}` placeholders rendered from the environment into
#                  `<outdir>/case.rendered.json` (the source case is untouched)
#
# Gate lock: this wrapper never acquires the shared gate lock; the composed
# runner acquires it ONCE at its own layer (see lib/lock.sh).
# =============================================================================
set -u

SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd)"
SUITE_DIR="$(cd -- "$SELF_DIR/.." && pwd)"
# shellcheck source=../lib/common.sh
. "$SUITE_DIR/lib/common.sh"

CASE_ARG="${1:-}"
OUT="${2:-}"
if [ -z "$CASE_ARG" ] || [ -z "$OUT" ]; then
  printf 'usage: run-case.sh <case.json> <outdir> [matchlock-bin]\n' >&2
  exit 2
fi
ML="${3:-${MTLK_MATCHLOCK_RPC_BIN:-matchlock}}"

# Workdir binding (common.sh default) exported for the driver + embedded python.
WORKDIR="${MTLK_WORKDIR:-$SUITE_DIR/work}"
export MTLK_WORKDIR="$WORKDIR"

# VM REGISTRY: the matchlock state DB under `$HOME/.matchlock`. This is a
# DIFFERENT file from the image store's metadata.db; the historical scratch
# utility's image-cache registry spelling was a defect and is never used.
export MTLK_MATCHLOCK_STATE_DB="$(mtlk_matchlock_state_db)"

# The matchlock pair is recorded as evidence; it is never replaced.
export MTLK_MATCHLOCK_BIN="$ML"
MTLK_MATCHLOCK_SHA="$(mtlk_sha256 "$ML" 2>/dev/null || true)"
export MTLK_MATCHLOCK_SHA

DRIVER="${MTLK_DRIVER:-$SELF_DIR/pty-drive.py}"
if [ ! -f "$DRIVER" ]; then
  printf 'MTLK-ABORT driver-missing %s\n' "$DRIVER" >&2
  exit 2
fi
export MTLK_DRIVER="$DRIVER"

mkdir -p "$OUT" || exit 2

# Render the configuration-bound case into a private copy. The original case
# file is never modified; the rendered file is what the driver and the summary
# both consume.
RENDERED="$OUT/case.rendered.json"
mtlk_render_case "$CASE_ARG" "$RENDERED"
RRC=$?
[ "$RRC" = 0 ] || exit "$RRC"
CASE="$RENDERED"

# ---------------------------------------------------------------------------
# Phase 1 — fail-closed BEFORE inventory + mount pre-delete. Any refusal exits
# 2 BEFORE the driver is invoked.
# ---------------------------------------------------------------------------
python3 - "$CASE" "$OUT" "$ML" <<'PYP'
import json, os, re, subprocess, sys
case_p, out, ml = sys.argv[1], sys.argv[2], sys.argv[3]
case = json.load(open(case_p))
name = case["name"]
path = os.path.join(out, "matchlock-list-before.txt")
with open(path, "w") as fh:
    r = subprocess.run([ml, "list"], stdout=fh, stderr=subprocess.STDOUT)
raw = open(path, errors="replace").read()
lines = [l for l in raw.splitlines() if l.strip()]
ok = (r.returncode == 0 and bool(lines) and re.match(r"^ID\s+STATUS\s+IMAGE\b", lines[0]) is not None)
if not ok:
    summary = {"case": name, "verdict": "FAIL", "fail_reasons": ["inventory-before-invalid"],
               "inventory_before_ok": False, "inventory_before_rc": r.returncode,
               "inventory_before_raw_tail": raw[-300:], "refused_before_launch": True}
    json.dump(summary, open(os.path.join(out, "case-summary.json"), "w"), indent=2)
    print(json.dumps(summary))
    sys.exit(2)
if case.get("mntchk"):
    tag = name.split("-")[0]
    mf = os.path.join(os.environ.get("MTLK_WORKDIR", ""), ".mntchk-" + tag + ".txt")
    try:
        os.remove(mf)
    except FileNotFoundError:
        pass
    except OSError as e:
        summary = {"case": name, "verdict": "FAIL", "fail_reasons": ["mount-precheck-undeletable"],
                   "refused_before_launch": True, "mount_write_through_file": mf,
                   "mount_precheck_error": str(e)}
        json.dump(summary, open(os.path.join(out, "case-summary.json"), "w"), indent=2)
        print(json.dumps(summary))
        sys.exit(2)
    if os.path.exists(mf):
        summary = {"case": name, "verdict": "FAIL", "fail_reasons": ["mount-precheck-still-present"],
                   "refused_before_launch": True, "mount_write_through_file": mf}
        json.dump(summary, open(os.path.join(out, "case-summary.json"), "w"), indent=2)
        print(json.dumps(summary))
        sys.exit(2)
sys.exit(0)
PYP
PRC=$?
[ "$PRC" = 0 ] || exit "$PRC"

# ---------------------------------------------------------------------------
# Phase 2 — run the frozen driver (exit code captured, never masked).
# ---------------------------------------------------------------------------
T0=$(date -u +%FT%TZ)
python3 "$DRIVER" "$CASE" "$OUT"; RC=$?
T1=$(date -u +%FT%TZ)

# ---------------------------------------------------------------------------
# Phase 3 — fail-closed AFTER inventory, case-scoped ownership, mount verify.
# ---------------------------------------------------------------------------
MTLK_CASE_T0="$T0" MTLK_CASE_T1="$T1" python3 - "$CASE" "$OUT" "$RC" "$ML" <<'PY'
import hashlib, json, os, re, sqlite3, subprocess, sys
case_p, out, rc, ml = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
case = json.load(open(case_p))
name = case["name"]
res_p = os.path.join(out, name + ".json")
try:
    driver_sha = hashlib.sha256(open(os.environ.get("MTLK_DRIVER", ""), "rb").read()).hexdigest()
except Exception:
    driver_sha = None
summary = {"case": name, "driver_rc": rc, "driver_sha256": driver_sha,
           "tamandua_bin": os.environ.get("MTLK_TAMANDUA_BIN"),
           "tamandua_sha256": os.environ.get("MTLK_TAMANDUA_SHA"),
           "matchlock_bin": os.environ.get("MTLK_MATCHLOCK_BIN"),
           "matchlock_bin_sha256": os.environ.get("MTLK_MATCHLOCK_SHA"),
           "host": os.uname().nodename}
try:
    res = json.load(open(res_p))
except Exception as e:
    summary["result_read"] = "FAIL " + str(e)
    res = None
if res:
    summary["verdict"] = res.get("verdict")
    summary["vm_ids_seen"] = res.get("vm_ids_seen", [])

def parse(raw):
    lines = [l for l in raw.splitlines() if l.strip()]
    ok = bool(lines) and re.match(r"^ID\s+STATUS\s+IMAGE\b", lines[0]) is not None
    rows = {}
    if ok:
        for l in lines[1:]:
            m = re.match(r"\s*(vm-[0-9a-f]{8})\s+(\S+)", l)
            if m:
                rows[m.group(1)] = m.group(2)
            else:
                ok = False  # unparsed row: the inventory is not trustworthy
                break
    return ok, rows

summary["cleanup_ok"] = None
summary["cleanup_readable"] = False
try:
    ok_b, before = parse(open(os.path.join(out, "matchlock-list-before.txt"), errors="replace").read())
    ap = os.path.join(out, "matchlock-list-after.txt")
    with open(ap, "w") as fh:
        ra = subprocess.run([ml, "list"], stdout=fh, stderr=subprocess.STDOUT)
    raw_a = open(ap, errors="replace").read()
    ok_a, after = parse(raw_a)
    if ra.returncode != 0 or not ok_a:
        raise RuntimeError("inventory-after-invalid rc=%s: %s" % (ra.returncode, raw_a[-200:]))
    if not ok_b:
        raise RuntimeError("inventory-before-invalid (unexpected at this stage)")
    new_ids = sorted(k for k in after if k not in before)
    seen = set(summary.get("vm_ids_seen") or [])
    # Case-scoped ownership (2026-10-09 repair): a new VM row is owned ONLY by
    #   (a) the case's own captured output naming the exact id, or
    #   (b) STRUCTURAL correlation: the stored config declares THIS case's workdir
    #       as an EXACT mount destination, AND the row was created inside this
    #       case's window (corroboration).
    # A substring/mount-mismatch is NOT ownership; anything unproven stays
    # unowned (reported, never removed) and FAILS the case. We never remove
    # another agent's VM to make a test pass.
    t0 = os.environ.get("MTLK_CASE_T0") or ""
    t1 = os.environ.get("MTLK_CASE_T1") or ""
    workdir = os.environ.get("MTLK_WORKDIR") or ""
    dbp = os.environ.get("MTLK_MATCHLOCK_STATE_DB") or os.path.expanduser("~/.matchlock/state.db")

    def mount_match(cfg_s, wd):
        """True only when wd is EXACTLY a declared GUEST destination in the stored
        config. Destinations are the mounts-map KEYS (the fork stores
        mounts[spec.GuestPath] = mount); a list-shaped fallback accepts only an
        exact `destination`/`guest`/`guest_path` field. Source-side fields never
        count. None when the config cannot prove it (fail-closed)."""
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

    correlated = {}
    unowned = []
    for vid in new_ids:
        if vid in seen:
            continue
        row = None
        try:
            con = sqlite3.connect("file:%s?mode=ro" % dbp, uri=True)
            row = con.execute("select config_json, created_at from vms where id=?", (vid,)).fetchone()
            con.close()
        except Exception:
            row = None
        ok_own = False
        if row:
            cfg, created = row
            cfg_s = cfg.decode("utf-8", "replace") if isinstance(cfg, (bytes, bytearray)) else str(cfg)
            created_s = created or ""
            if "." in created_s:
                created_s = created_s.split(".")[0] + "Z"
            mm = mount_match(cfg_s, workdir) if workdir else None
            if mm is True and t0 and t1 and created_s and (t0 <= created_s <= t1):
                correlated[vid] = {"created_at": created,
                                   "evidence": "config-mount(exact):" + workdir + " + created-in-case-window"}
                ok_own = True
        if not ok_own:
            unowned.append(vid)
    owned = [k for k in new_ids if (k in seen or k in correlated)]
    live = [k for k in new_ids if after[k] != "stopped"]
    summary["new_vms_after"] = new_ids
    summary["owned_new_vms"] = owned
    summary["correlated_new_vms"] = correlated
    summary["unowned_new_vms"] = unowned
    summary["new_live_vms"] = live
    summary["cleanup_ok"] = (len(new_ids) == 0)
    summary["removal_ok"] = (len(new_ids) == 0)
    summary["known_gap"] = "interactive close() keeps the VM row (record-removal gap; bead tamandua-n5c / 6sy.33.33 class)" if owned else ""
    summary["cleanup_readable"] = True  # only now, after the FULL assessment (incl. ownership) completed
except Exception as e:
    summary["cleanup_read"] = "FAIL-CLOSED " + str(e)

if case.get("mntchk"):
    tag = name.split("-")[0]
    mnt_file = os.path.join(os.environ.get("MTLK_WORKDIR", ""), ".mntchk-" + tag + ".txt")
    pattern = r"^MNTCHK-%s-[0-9]+$" % tag
    verdict = "missing"; content = ""
    try:
        content = open(mnt_file, errors="replace").read().strip()
        verdict = "ok" if re.match(pattern, content) else "bad-content"
    except FileNotFoundError:
        verdict = "missing"
    except Exception as e:
        verdict = "read-error " + str(e)
    summary["mount_write_through"] = verdict
    if content:
        summary["mount_write_through_content"] = content[:80]
    if verdict != "ok":
        summary["mount_write_through_file"] = mnt_file

driver_verdict = summary.get("verdict")
summary["driver_verdict"] = driver_verdict
reasons = []
if driver_verdict != "PASS":
    reasons.append("driver-verdict:" + str(driver_verdict))
if summary.get("cleanup_readable") is not True:
    reasons.append("cleanup-inventory-unreadable:" + str(summary.get("cleanup_read", ""))[:160])
if summary.get("new_live_vms"):
    reasons.append("live-vm-left:" + ",".join(summary["new_live_vms"]))
if summary.get("unowned_new_vms"):
    reasons.append("unowned-new-vm:" + ",".join(summary["unowned_new_vms"]))
if rc != 0:
    reasons.append("driver-rc:" + str(rc))
mw = summary.get("mount_write_through", "ok")
if mw != "ok":
    reasons.append("mount-write-through:" + str(mw))
summary["fail_reasons"] = reasons
summary["verdict"] = "PASS" if not reasons else "FAIL"
json.dump(summary, open(os.path.join(out, "case-summary.json"), "w"), indent=2)
print(json.dumps(summary))
sys.exit(0 if not reasons else 1)
PY
exit $?
