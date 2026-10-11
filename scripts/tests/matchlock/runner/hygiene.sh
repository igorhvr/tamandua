#!/usr/bin/env bash
# =============================================================================
# MTLK-INTERACTIVE-SUITE — case-owned VM hygiene remover.
#
#   hygiene.sh <case-summary.json> [matchlock-bin]
#
# Ported from the ACCEPTED W2 toolset `tools/hygiene.sh`; semantics preserved,
# configuration rebound through `lib/common.sh`.
#
# Contract:
#   * Remove ONLY case-owned vm ids, by EXACT id (`owned_new_vms`). Never a glob,
#     never by image/name. Unowned ids (`unowned_new_vms`) are REPORTED and
#     NEVER removed; another agent's VM is never touched.
#   * Verify the removal with a validated `matchlock list` (rc + header + strict
#     row parse). An unreadable or malformed verification inventory is a
#     hygiene FAILURE — it is never silently treated as "nothing left".
#   * Exit 3 on any rm failure, any owned id still present, a malformed/unreadable
#     verification inventory, or an unreadable/malformed summary. A failed or
#     unknown removal RETAINS state and fails the step.
#   * Exit 0 when every owned id is gone (unowned-only is a clean hygiene step).
# =============================================================================
set -u

SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd)"
SUITE_DIR="$(cd -- "$SELF_DIR/.." && pwd)"
# shellcheck source=../lib/common.sh
. "$SUITE_DIR/lib/common.sh"

SUM="${1:-}"
if [ -z "$SUM" ]; then
  printf 'usage: hygiene.sh <case-summary.json> [matchlock-bin]\n' >&2
  exit 2
fi
ML="${2:-${MTLK_MATCHLOCK_RPC_BIN:-matchlock}}"

python3 - "$SUM" "$ML" <<'PYH'
import json, re, subprocess, sys
p, ml = sys.argv[1], sys.argv[2]
try:
    d = json.load(open(p))
    if not isinstance(d, dict):
        raise ValueError("summary-not-object")
except Exception as e:
    print("hygiene-read-fail", e)
    sys.exit(3)
owned = d.get("owned_new_vms") or []
unowned = d.get("unowned_new_vms") or []
bad = False
for v in owned:
    r = subprocess.run([ml, "rm", v], capture_output=True, text=True)
    print("hygiene-rm", v, "rc=", r.returncode, (r.stdout or r.stderr or "").strip()[:120])
    if r.returncode != 0: bad = True
if owned:
    r = subprocess.run([ml, "list"], capture_output=True, text=True)
    lines = [l for l in (r.stdout or "").splitlines() if l.strip()]
    valid = r.returncode == 0 and bool(lines) and re.match(r"^ID\s+STATUS\s+IMAGE\b", lines[0]) is not None
    rows = {}
    if valid:
        for l in lines[1:]:
            m = re.match(r"\s*(vm-[0-9a-f]{8})\s+(\S+)", l)
            if m:
                rows[m.group(1)] = m.group(2)
            else:
                valid = False
                break
    if not valid:
        print("hygiene-verify-inventory-invalid rc=%s" % r.returncode)
        bad = True
    else:
        left = [v for v in owned if v in rows]
        print("hygiene-verify-leftover", left)
        if left: bad = True
for v in unowned:
    print("hygiene-unowned-left", v)
sys.exit(3 if bad else 0)
PYH
