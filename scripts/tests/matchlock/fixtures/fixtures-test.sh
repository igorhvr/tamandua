#!/usr/bin/env bash
# =============================================================================
# fixtures-test.sh — behavioral negative/positive controls for the per-case
# wrapper (`runner/run-case.sh`) and the case-owned hygiene remover
# (`runner/hygiene.sh`).
#
# Ported from the frozen campaign's `fixtures/fixtures-test.sh` (41 controls).
# S/TOOLSET are rebound to this repo's suite: the controls copy NO scripts —
# they execute the real `runner/run-case.sh` and `runner/hygiene.sh` IN PLACE
# and inject a fake `matchlock` and a fake `pty-drive.py` through the documented
# seams (`$3` matchlock-bin, `MTLK_DRIVER`, `MTLK_MATCHLOCK_STATE_DB`). The
# scratch tree is a fresh private `mktemp -d` (or `MTLK_RUN_CASE_FIXTURE_DIR`
# when set and owned by the caller) — never a fixed path inside the repo.
#
# No VM, no model, no network. The last line is always:
#
#   RUN-CASE FIXTURES RESULT: pass=<n> fail=<n>
#
# Decisive controls include: invalid BEFORE inventory refuses before launch
# (rc=2, driver not invoked); invalid AFTER inventory is fail-closed (rc=1);
# mount write-through missing/bad-content refuses the case; mount precheck
# undeletable refuses before launch; case-scoped ownership correlation (real
# window+exact-mount destination vs a fake window); hygiene removes only owned
# ids and exits 3 on rm failure, leftover, malformed/unreadable inventory;
# unowned ids are reported and never removed.
# =============================================================================
set -u

SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd)"
SUITE_DIR="$(cd -- "$SELF_DIR/.." && pwd)"
TOOLSET="${1:-$SUITE_DIR}"
RUNNER_DIR="$TOOLSET/runner"
RUN_CASE="$RUNNER_DIR/run-case.sh"
HYGIENE="$RUNNER_DIR/hygiene.sh"
REAL_DRIVER="$RUNNER_DIR/pty-drive.py"

# Private scratch. `MTLK_RUN_CASE_FIXTURE_DIR` lets the calling test own (and
# clean up) the directory; otherwise this script creates and removes its own.
FIX_OWNED=0
if [ -n "${MTLK_RUN_CASE_FIXTURE_DIR:-}" ]; then
  FIX="$MTLK_RUN_CASE_FIXTURE_DIR"
  rm -rf "$FIX"
  mkdir -p "$FIX"
else
  FIX="$(mktemp -d -t mtlk-run-case.XXXXXX 2>/dev/null || mktemp -d)"
  FIX_OWNED=1
fi

cleanup() {
  if [ "$FIX_OWNED" = "1" ] && [ -n "${FIX:-}" ]; then
    rm -rf "$FIX"
  fi
}
trap cleanup EXIT

mkdir -p "$FIX/bin" "$FIX/tools" "$FIX/work" "$FIX/state"

# --- fake matchlock: `list` (counted, fail/malform knobs) + `rm` (rc knob) ---
cat > "$FIX/bin/matchlock" <<'EOF'
#!/bin/bash
ST="${FIX_STATE_DIR:?}"; mkdir -p "$ST"
case "${1:-}" in
  list)
    N=$(cat "$ST/count" 2>/dev/null || echo 0); N=$((N+1)); echo "$N" > "$ST/count"
    if [ "${FLIST_FAIL_FIRST:-0}" = 1 ] && [ "$N" = 1 ]; then echo "fake-list-failure" >&2; exit 1; fi
    if [ "${FLIST_FAIL_SECOND:-0}" = 1 ] && [ "$N" -ge 2 ]; then echo "fake-list-failure" >&2; exit 1; fi
    if [ "${FLIST_MALFORMED:-0}" = 1 ]; then echo "garbage without header"; exit 0; fi
    echo "ID           STATUS   IMAGE          CREATED           PID"
    if [ -n "${FLIST_ROWS_ALL:-}" ]; then printf '%s\n' "$FLIST_ROWS_ALL"
    elif [ "$N" = 1 ]; then printf '%s\n' "${FLIST_ROWS_BEFORE:-}"
    else printf '%s\n' "${FLIST_ROWS_AFTER:-}"; fi
    ;;
  rm) echo "fake-rm $2"; exit "${FLIST_RM_RC:-0}"; ;;
  version) echo "matchlock 0.2.17 (commit: 2afbca3, built: fake)"; ;;
  *) exit 0;;
esac
EOF
chmod +x "$FIX/bin/matchlock"

# --- fake PTY driver: writes the marker/mount nonce/vm row, then a result ---
cat > "$FIX/tools/pty-drive.py" <<'EOF'
#!/usr/bin/env python3
import json, os, sys, time
case = json.load(open(sys.argv[1])); out = sys.argv[2]
os.makedirs(out, exist_ok=True)
name = case["name"]
mk = os.environ.get("FDRV_MARKER")
if mk: open(mk, "a").write("invoked\n")
if os.environ.get("FDRV_WRITE_MNT", "0") == "1":
    tag = name.split("-")[0]
    wd = os.environ.get("MTLK_WORKDIR", "")
    content = os.environ.get("FDRV_MNT_CONTENT") or ("MNTCHK-%s-%d" % (tag, int(time.time())))
    with open(os.path.join(wd, ".mntchk-%s.txt" % tag), "w") as fh:
        fh.write(content)
if os.environ.get("FDRV_VMDB"):
    import sqlite3, datetime
    db = os.environ["FDRV_VMDB"]
    vid = os.environ.get("FDRV_VM_ID", "vm-aaaaaaaa")
    created = os.environ.get("FDRV_VM_CREATED") or datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    cfg = '{"vfs":{"exact_destinations":true,"mounts":{"%s":{"mode":"rw"}}}}' % os.environ.get("MTLK_WORKDIR", "")
    con = sqlite3.connect(db)
    con.execute("create table if not exists vms (id text, config_json blob, created_at text)")
    con.execute("insert into vms (id, config_json, created_at) values (?,?,?)", (vid, cfg.encode(), created))
    con.commit(); con.close()
# Retained interactive-session evidence simulation (the product's close path).
# OPT-IN only (FDRV_EVIDENCE=1): merely binding the observation root must never
# make the fake driver emit evidence, or the zero-round/stale controls would
# stop being zero. No swallowing here: a failed fixture setup must fail the
# control (the driver exits non-zero, so the case is recorded FAIL).
if os.environ.get("FDRV_EVIDENCE") == "1":
    er = os.environ["MTLK_INTERACTIVE_EVIDENCE_ROOT"]
    eid = os.environ.get("FDRV_EVIDENCE_ID", "vm-abcdef01")
    mode = os.environ.get("FDRV_EVIDENCE_MODE", "payload")
    if mode == "symlink":
        target = os.path.join(er, "._target-" + eid)
        os.makedirs(os.path.join(target, "logs"), exist_ok=True)
        with open(os.path.join(target, "logs", "vm.log"), "w") as fh:
            fh.write("payload behind a symlink\n")
        os.symlink(target, os.path.join(er, eid))
    else:
        d = os.path.join(er, eid)
        os.makedirs(d, exist_ok=True)
        if mode == "payload":
            # Linux (firecracker) observed shape: config.json + logs/.
            with open(os.path.join(d, "config.json"), "w") as fh:
                fh.write('{"boot-source": {}}\n')
            os.makedirs(os.path.join(d, "logs"), exist_ok=True)
            with open(os.path.join(d, "logs", "vm.log"), "w") as fh:
                fh.write("boot ok\n")
        elif mode == "logs-only":
            # macOS/VZ observed shape: logs/ only, no config.json.
            os.makedirs(os.path.join(d, "logs"), exist_ok=True)
            with open(os.path.join(d, "logs", "vm.log"), "w") as fh:
                fh.write("boot ok\n")
        # "empty": the directory alone is not evidence.
tp = os.environ.get("FDRV_TOUCH_EVIDENCE")
if tp:
    os.utime(tp, None)
rp = os.environ.get("FDRV_REPLACE_ROOT")
if rp:
    os.rename(rp, rp + ".old")
    os.makedirs(os.path.join(rp, "vm-feedface", "logs"), exist_ok=True)
    with open(os.path.join(rp, "vm-feedface", "config.json"), "w") as fh:
        fh.write('{"boot-source": {}}\n')
    with open(os.path.join(rp, "vm-feedface", "logs", "vm.log"), "w") as fh:
        fh.write("replaced root payload\n")
res = {"name": name, "verdict": os.environ.get("FDRV_VERDICT", "PASS"),
       "vm_ids_seen": json.loads(os.environ.get("FDRV_SEEN", "[]"))}
json.dump(res, open(os.path.join(out, name + ".json"), "w"))
sys.exit(int(os.environ.get("FDRV_RC", "0")))
EOF

# --- case under test: a configuration-bound {{MTLK_WORKDIR}} placeholder ---
cat > "$FIX/case.json" <<'EOF'
{"name":"M0-fixture","cwd":"{{MTLK_WORKDIR}}","argv":["true"],"env":{},"mntchk":true,
 "events":[{"send":"printf 'RDY-%s-%s-END\\n' \"$(uname -s)\" \"$$\"\n"},{"send":"exit\n"}]}
EOF

PASSN=0; FAILN=0
chk(){ local rc="$1" want="$2" name="$3"; if [ "$rc" = "$want" ]; then PASSN=$((PASSN+1)); echo "ok   - $name (rc=$rc)"; else FAILN=$((FAILN+1)); echo "FIXTURE-FAIL - $name rc=$rc want=$want"; fi; }
okc(){ if [ "$1" = "1" ]; then PASSN=$((PASSN+1)); echo "ok   - $2"; else FAILN=$((FAILN+1)); echo "FIXTURE-FAIL - $2"; fi; }

run_case(){ # <outdir> [scenario-env...]
  local out="$1"; shift
  rm -rf "$out"; rm -rf "$FIX/state"; mkdir -p "$FIX/state"
  env -i PATH="$PATH" HOME="${HOME:-$FIX/home}" FIX_STATE_DIR="$FIX/state" \
    MTLK_WORKDIR="$FIX/work" MTLK_DRIVER="$FIX/tools/pty-drive.py" \
    MTLK_INTERACTIVE_EVIDENCE_ROOT="$FIX/evroot" \
    FDRV_MARKER="$FIX/invoked" "$@" \
    bash "$RUN_CASE" "$FIX/case.json" "$out" "$FIX/bin/matchlock"
}

echo '--- S1 before-inventory invalid: refuse before launch, rc=2, driver NOT invoked ---'
rm -f "$FIX/invoked"
run_case "$FIX/out1" FLIST_FAIL_FIRST=1 > "$FIX/s1.log" 2>&1; chk $? 2 "s1 rc=2"
grep -q 'refused_before_launch' "$FIX/out1/case-summary.json" && okc 1 "s1 summary refused_before_launch" || okc 0 "s1 summary refused_before_launch"
[ ! -f "$FIX/invoked" ] && okc 1 "s1 driver not invoked" || okc 0 "s1 driver not invoked"

echo '--- S2 after-inventory invalid: rc=1, FAIL-CLOSED recorded ---'
run_case "$FIX/out2" FLIST_FAIL_SECOND=1 > "$FIX/s2.log" 2>&1; chk $? 1 "s2 rc=1"
grep -q 'FAIL-CLOSED' "$FIX/out2/case-summary.json" && okc 1 "s2 FAIL-CLOSED" || okc 0 "s2 FAIL-CLOSED"

echo '--- S3 malformed inventory: rc=2 (no header) ---'
run_case "$FIX/out3" FLIST_MALFORMED=1 > "$FIX/s3.log" 2>&1; chk $? 2 "s3 rc=2"

echo '--- S4 mount write-through missing: rc=1 ---'
run_case "$FIX/out4" FDRV_WRITE_MNT=0 > "$FIX/s4.log" 2>&1; chk $? 1 "s4 rc=1"
grep -q '"mount_write_through": "missing"' "$FIX/out4/case-summary.json" && okc 1 "s4 mount missing recorded" || okc 0 "s4 mount missing recorded"

echo '--- S4b mount content wrong (foreign token from another case): rc=1 ---'
run_case "$FIX/out4b" FDRV_WRITE_MNT=1 FDRV_MNT_CONTENT="MNTCHK-M1-1" > "$FIX/s4b.log" 2>&1; chk $? 1 "s4b rc=1"
grep -q '"mount_write_through": "bad-content"' "$FIX/out4b/case-summary.json" && okc 1 "s4b bad-content recorded" || okc 0 "s4b bad-content recorded"

echo '--- S4c mount precheck: undeletable stale file -> refuse before launch, rc=2 ---'
rm -rf "$FIX/work"; mkdir -p "$FIX/work/.mntchk-M0.txt"
run_case "$FIX/out4c" FDRV_WRITE_MNT=1 > "$FIX/s4c.log" 2>&1; chk $? 2 "s4c rc=2"
grep -q 'mount-precheck-undeletable' "$FIX/out4c/case-summary.json" && okc 1 "s4c refusal recorded" || okc 0 "s4c refusal recorded"
rm -rf "$FIX/work"; mkdir -p "$FIX/work"

echo '--- S5 driver verdict FAIL: rc=1 ---'
run_case "$FIX/out5" FDRV_VERDICT=FAIL FDRV_WRITE_MNT=1 > "$FIX/s5.log" 2>&1; chk $? 1 "s5 rc=1"

echo '--- S6 positive: all good, rc=0 ---'
run_case "$FIX/out6" FDRV_VERDICT=PASS FDRV_WRITE_MNT=1 > "$FIX/s6.log" 2>&1; chk $? 0 "s6 rc=0"
grep -q '"mount_write_through": "ok"' "$FIX/out6/case-summary.json" && okc 1 "s6 mount ok" || okc 0 "s6 mount ok"

echo '--- S6b case bindings rendered from {{MTLK_*}} placeholders ---'
grep -q "{{MTLK_WORKDIR}}" "$FIX/out6/case.rendered.json" && okc 0 "s6b placeholder replaced" || okc 1 "s6b placeholder replaced"
grep -q "\"cwd\":\"$FIX/work\"" "$FIX/out6/case.rendered.json" && okc 1 "s6b workdir bound" || okc 0 "s6b workdir bound"
grep -q "{{MTLK_WORKDIR}}" "$FIX/case.json" && okc 1 "s6b source case untouched" || okc 0 "s6b source case untouched"

echo '--- S6c unbound placeholder: refuse before launch, rc=2, driver NOT invoked ---'
cat > "$FIX/case-unbound.json" <<'EOF'
{"name":"M0-unbound","argv":["true"],"env":{},"mntchk":false,"x":"{{MTLK_NO_SUCH_BINDING}}"}
EOF
rm -f "$FIX/invoked"
rm -rf "$FIX/out-bound"
( env -i PATH="$PATH" HOME="${HOME:-$FIX/home}" MTLK_WORKDIR="$FIX/work" \
    MTLK_DRIVER="$FIX/tools/pty-drive.py" FDRV_MARKER="$FIX/invoked" \
    bash "$RUN_CASE" "$FIX/case-unbound.json" "$FIX/out-bound" "$FIX/bin/matchlock" > "$FIX/s6c.log" 2>&1 ); chk $? 2 "s6c unbound rc=2"
grep -q 'case-bindings-unresolved' "$FIX/s6c.log" && okc 1 "s6c unresolved reason" || okc 0 "s6c unresolved reason"
[ ! -f "$FIX/invoked" ] && okc 1 "s6c driver not invoked" || okc 0 "s6c driver not invoked"

echo '--- S7 hygiene: rm rc!=0 -> exit 3 ---'
cat > "$FIX/sum-own.json" <<'EOF'
{"case":"M0-fixture","owned_new_vms":["vm-aaaaaaaa"],"unowned_new_vms":[]}
EOF
rm -rf "$FIX/state"; mkdir -p "$FIX/state"
( FIX_STATE_DIR="$FIX/state" FLIST_RM_RC=1 FLIST_ROWS_ALL="vm-aaaaaaaa  stopped" bash "$HYGIENE" "$FIX/sum-own.json" "$FIX/bin/matchlock" > "$FIX/s7.log" 2>&1 ); chk $? 3 "s7 hygiene rm-fail rc=3"
echo '--- S8 hygiene: rm ok but row remains -> exit 3 ---'
rm -rf "$FIX/state"; mkdir -p "$FIX/state"
( FIX_STATE_DIR="$FIX/state" FLIST_RM_RC=0 FLIST_ROWS_ALL="vm-aaaaaaaa  stopped" bash "$HYGIENE" "$FIX/sum-own.json" "$FIX/bin/matchlock" > "$FIX/s8.log" 2>&1 ); chk $? 3 "s8 hygiene leftover rc=3"
echo '--- S9 hygiene: rm ok, row gone -> exit 0 ---'
rm -rf "$FIX/state"; mkdir -p "$FIX/state"
( FIX_STATE_DIR="$FIX/state" FLIST_RM_RC=0 FLIST_ROWS_ALL="" bash "$HYGIENE" "$FIX/sum-own.json" "$FIX/bin/matchlock" > "$FIX/s9.log" 2>&1 ); chk $? 0 "s9 hygiene clean rc=0"

echo '--- S10 hygiene: malformed verification inventory -> exit 3 ---'
rm -rf "$FIX/state"; mkdir -p "$FIX/state"
( FIX_STATE_DIR="$FIX/state" FLIST_RM_RC=0 FLIST_MALFORMED=1 bash "$HYGIENE" "$FIX/sum-own.json" "$FIX/bin/matchlock" > "$FIX/s10.log" 2>&1 ); chk $? 3 "s10 hygiene malformed rc=3"

echo '--- S11 hygiene: unparsed row in verification inventory -> exit 3 ---'
rm -rf "$FIX/state"; mkdir -p "$FIX/state"
( FIX_STATE_DIR="$FIX/state" FLIST_RM_RC=0 FLIST_ROWS_ALL="this is not a row" bash "$HYGIENE" "$FIX/sum-own.json" "$FIX/bin/matchlock" > "$FIX/s11.log" 2>&1 ); chk $? 3 "s11 hygiene unparsed row rc=3"

echo '--- S12 hygiene: unreadable summary -> exit 3 ---'
rm -rf "$FIX/state"; mkdir -p "$FIX/state"
echo 'not json' > "$FIX/sum-bad.json"
( FIX_STATE_DIR="$FIX/state" bash "$HYGIENE" "$FIX/sum-bad.json" "$FIX/bin/matchlock" > "$FIX/s12.log" 2>&1 ); chk $? 3 "s12 hygiene unreadable summary rc=3"

echo '--- S13 hygiene: unowned ids are reported but never removed ---'
echo '{"case":"M0-fixture","owned_new_vms":[],"unowned_new_vms":["vm-bbbbbbbb"]}' > "$FIX/sum-uno.json"
rm -rf "$FIX/state"; mkdir -p "$FIX/state"
( FIX_STATE_DIR="$FIX/state" FLIST_RM_RC=9 bash "$HYGIENE" "$FIX/sum-uno.json" "$FIX/bin/matchlock" > "$FIX/s13.log" 2>&1 ); chk $? 0 "s13 unowned-only rc=0"
{ grep -q 'hygiene-unowned-left vm-bbbbbbbb' "$FIX/s13.log" && [ ! -s "$FIX/state/count" ]; } && okc 1 "s13 unowned reported, rm never called" || okc 0 "s13 unowned reported, rm never called"

echo ""
echo '=== REAL-DRIVER ACCEPTANCE FIXTURES (egress + tools) ==='
DRV="$REAL_DRIVER"
cat > "$FIX/drv-egress-pos.json" <<'J'
{"name":"egress-pos","argv":["/bin/sh","-c","printf 'EGRESS http=200 time=0.7s\\n'"],"timeout_s":20,"grace_s":5,"final_wait_s":3,"events":[],"require":["EGRESS http=200"]}
J
python3 "$DRV" "$FIX/drv-egress-pos.json" "$FIX/drv-out1" > "$FIX/s14.log" 2>&1; chk $? 0 "s14 egress-pos rc=0"
chk "$(python3 -c "import json;print(json.load(open('$FIX/drv-out1/egress-pos.json'))['verdict'])" 2>/dev/null)" "PASS" "s14 egress-pos verdict"

cat > "$FIX/drv-egress-neg.json" <<'J'
{"name":"egress-neg","argv":["/bin/sh","-c","printf 'EGRESS http=000 time=0.3s\\n'"],"timeout_s":20,"grace_s":5,"final_wait_s":3,"events":[],"require":["EGRESS http=200"]}
J
python3 "$DRV" "$FIX/drv-egress-neg.json" "$FIX/drv-out2" > "$FIX/s15.log" 2>&1; chk $? 1 "s15 egress-neg rc=1"
chk "$(python3 -c "import json;d=json.load(open('$FIX/drv-out2/egress-neg.json'));print(d['verdict']+'/'+('req-pattern' if any('required end-state pattern' in r for r in d['fail_reasons']) else 'other'))" 2>/dev/null)" "FAIL/req-pattern" "s15 egress-neg refusal"

cat > "$FIX/drv-tools-neg.json" <<'J'
{"name":"tools-neg","argv":["/bin/sh","-c","printf 'TOOL pi: MISSING\\n'"],"timeout_s":20,"grace_s":5,"final_wait_s":3,"events":[],"require":["TOOL pi: /"]}
J
python3 "$DRV" "$FIX/drv-tools-neg.json" "$FIX/drv-out3" > "$FIX/s16.log" 2>&1; chk $? 1 "s16 tools-neg rc=1"

cat > "$FIX/drv-tools-pos.json" <<'J'
{"name":"tools-pos","argv":["/bin/sh","-c","printf 'TOOL pi: /usr/local/bin/pi\\n'"],"timeout_s":20,"grace_s":5,"final_wait_s":3,"events":[],"require":["TOOL pi: /"]}
J
python3 "$DRV" "$FIX/drv-tools-pos.json" "$FIX/drv-out4" > "$FIX/s17.log" 2>&1; chk $? 0 "s17 tools-pos rc=0"

echo ""
echo '=== OWNERSHIP CORRELATION FIXTURES (case-scoped: window + workdir config) ==='
rm -f "$FIX/vmdb.sqlite"
run_case "$FIX/out18" MTLK_MATCHLOCK_STATE_DB="$FIX/vmdb.sqlite" FDRV_VMDB="$FIX/vmdb.sqlite" FDRV_WRITE_MNT=1 FLIST_ROWS_AFTER="vm-aaaaaaaa  stopped" > "$FIX/s18.log" 2>&1; chk $? 0 "s18 correlated-owned rc=0"
chk "$(python3 -c "import json;d=json.load(open('$FIX/out18/case-summary.json'));print('Y' if 'vm-aaaaaaaa' in d.get('owned_new_vms',[]) and d.get('correlated_new_vms') else 'N')" 2>/dev/null)" "Y" "s18 correlated ownership recorded"
rm -rf "$FIX/state"; mkdir -p "$FIX/state"
( FIX_STATE_DIR="$FIX/state" FLIST_RM_RC=0 bash "$HYGIENE" "$FIX/out18/case-summary.json" "$FIX/bin/matchlock" > "$FIX/s18h.log" 2>&1 ); chk $? 0 "s18 hygiene rc=0"
grep -q 'hygiene-rm vm-aaaaaaaa rc= 0' "$FIX/s18h.log" && okc 1 "s18 correlated VM removed" || okc 0 "s18 correlated VM removed"

rm -f "$FIX/vmdb.sqlite"
run_case "$FIX/out19" MTLK_MATCHLOCK_STATE_DB="$FIX/vmdb.sqlite" FDRV_VMDB="$FIX/vmdb.sqlite" FDRV_VM_CREATED="2020-01-01T00:00:00Z" FDRV_WRITE_MNT=1 FLIST_ROWS_AFTER="vm-aaaaaaaa  stopped" > "$FIX/s19.log" 2>&1; chk $? 1 "s19 uncorrelated rc=1 (fail-closed)"
chk "$(python3 -c "import json;d=json.load(open('$FIX/out19/case-summary.json'));print('Y' if d.get('unowned_new_vms')==['vm-aaaaaaaa'] and not d.get('owned_new_vms') else 'N')" 2>/dev/null)" "Y" "s19 unowned recorded, not owned"

echo ""
echo '=== RETAINED INTERACTIVE-SESSION EVIDENCE FIXTURES (fresh, case-owned only) ==='
EVR="$FIX/evroot"

echo '--- S20 fresh session-evidence dir created during the case is counted ---'
rm -rf "$EVR"
run_case "$FIX/out20" FDRV_EVIDENCE=1 FDRV_EVIDENCE_ID=vm-abcdef01 FDRV_WRITE_MNT=1 > "$FIX/s20.log" 2>&1; chk $? 0 "s20 rc=0"
chk "$(python3 -c "import json;d=json.load(open('$FIX/out20/case-summary.json'));print(','.join(d.get('interactive_evidence_new_vms',[])))" 2>/dev/null)" "vm-abcdef01" "s20 fresh evidence counted"
chk "$(python3 -c "import json;d=json.load(open('$FIX/out20/case-summary.json'));print(d.get('interactive_evidence',{}).get('status'))" 2>/dev/null)" "ok" "s20 evidence status ok"
chk "$(python3 -c "import json;d=json.load(open('$FIX/out20/case-summary.json'));print('empty' if not d.get('owned_new_vms') else d.get('owned_new_vms'))" 2>/dev/null)" "empty" "s20 evidence is not cleanup authority"

echo '--- S20b logs-only shape (observed on macOS/VZ) is counted too ---'
rm -rf "$EVR"
run_case "$FIX/out20b" FDRV_EVIDENCE=1 FDRV_EVIDENCE_ID=vm-1234abcd FDRV_EVIDENCE_MODE=logs-only FDRV_WRITE_MNT=1 > "$FIX/s20b.log" 2>&1; chk $? 0 "s20b rc=0"
chk "$(python3 -c "import json;d=json.load(open('$FIX/out20b/case-summary.json'));print(','.join(d.get('interactive_evidence_new_vms',[])))" 2>/dev/null)" "vm-1234abcd" "s20b logs-only evidence counted"

echo '--- S21 pre-existing (stale) evidence dir is NEVER counted ---'
rm -rf "$EVR"; mkdir -p "$EVR/vm-0000beef/logs"
printf 'stale\n' > "$EVR/vm-0000beef/logs/vm.log"
printf '{}\n' > "$EVR/vm-0000beef/config.json"
run_case "$FIX/out21" FDRV_WRITE_MNT=1 > "$FIX/s21.log" 2>&1; chk $? 0 "s21 rc=0"
chk "$(python3 -c "import json;d=json.load(open('$FIX/out21/case-summary.json'));print(len(d.get('interactive_evidence_new_vms',[])))" 2>/dev/null)" "0" "s21 stale evidence not counted"

echo '--- S21b a stale dir whose contents are touched during the case stays excluded ---'
rm -rf "$EVR"; mkdir -p "$EVR/vm-0000cafe/logs"
printf 'stale\n' > "$EVR/vm-0000cafe/logs/vm.log"
printf '{}\n' > "$EVR/vm-0000cafe/config.json"
run_case "$FIX/out21b" FDRV_WRITE_MNT=1 FDRV_TOUCH_EVIDENCE="$EVR/vm-0000cafe/logs/vm.log" > "$FIX/s21b.log" 2>&1; chk $? 0 "s21b rc=0"
chk "$(python3 -c "import json;d=json.load(open('$FIX/out21b/case-summary.json'));print(len(d.get('interactive_evidence_new_vms',[])))" 2>/dev/null)" "0" "s21b touched stale evidence not counted"

echo '--- S22 a fresh but EMPTY dir (no payload) is not evidence ---'
rm -rf "$EVR"
run_case "$FIX/out22" FDRV_EVIDENCE=1 FDRV_EVIDENCE_ID=vm-00c0ffee FDRV_EVIDENCE_MODE=empty FDRV_WRITE_MNT=1 > "$FIX/s22.log" 2>&1; chk $? 0 "s22 rc=0"
chk "$(python3 -c "import json;d=json.load(open('$FIX/out22/case-summary.json'));e=d.get('interactive_evidence',{});print(','.join(i['reason'] for i in e.get('ignored',[])) or 'none')" 2>/dev/null)" "no-retained-payload" "s22 empty dir rejected"

echo '--- S23 a fresh SYMLINKED dir is not evidence ---'
rm -rf "$EVR"
run_case "$FIX/out23" FDRV_EVIDENCE=1 FDRV_EVIDENCE_ID=vm-00feed01 FDRV_EVIDENCE_MODE=symlink FDRV_WRITE_MNT=1 > "$FIX/s23.log" 2>&1; chk $? 0 "s23 rc=0"
chk "$(python3 -c "import json;d=json.load(open('$FIX/out23/case-summary.json'));e=d.get('interactive_evidence',{});print([i['reason'] for i in e.get('ignored',[]) if i['name']=='vm-00feed01'][0])" 2>/dev/null)" "not-a-real-directory" "s23 symlinked dir rejected"

echo '--- S24 the vm-00000000 placeholder sentinel is never counted ---'
rm -rf "$EVR"
run_case "$FIX/out24" FDRV_EVIDENCE=1 FDRV_EVIDENCE_ID=vm-00000000 FDRV_WRITE_MNT=1 > "$FIX/s24.log" 2>&1; chk $? 0 "s24 rc=0"
chk "$(python3 -c "import json;d=json.load(open('$FIX/out24/case-summary.json'));e=d.get('interactive_evidence',{});print([i['reason'] for i in e.get('ignored',[]) if i['name']=='vm-00000000'][0])" 2>/dev/null)" "placeholder-sentinel" "s24 sentinel rejected"

echo '--- S25 a root REPLACED during the case is fail-closed (never "all new") ---'
rm -rf "$EVR"; mkdir -p "$EVR"
run_case "$FIX/out25" FDRV_REPLACE_ROOT="$EVR" FDRV_WRITE_MNT=1 > "$FIX/s25.log" 2>&1; chk $? 1 "s25 replaced-root rc=1"
grep -q 'interactive-evidence-unreadable:' "$FIX/out25/case-summary.json" && grep -q 'evidence-root-replaced' "$FIX/out25/case-summary.json" && okc 1 "s25 replaced-root fail-closed" || okc 0 "s25 replaced-root fail-closed"
chk "$(python3 -c "import json;d=json.load(open('$FIX/out25/case-summary.json'));print(','.join(d.get('interactive_evidence_new_vms',[])))" 2>/dev/null)" "" "s25 replaced-root counts nothing"

echo '--- S26 a non-directory root refuses BEFORE launch ---'
rm -rf "$EVR"; : > "$EVR"
rm -f "$FIX/invoked"
run_case "$FIX/out26" FDRV_WRITE_MNT=1 > "$FIX/s26.log" 2>&1; chk $? 2 "s26 file-root rc=2"
grep -q 'interactive-evidence-before-invalid:not-a-directory' "$FIX/out26/case-summary.json" && okc 1 "s26 file-root refusal recorded" || okc 0 "s26 file-root refusal recorded"
[ ! -f "$FIX/invoked" ] && okc 1 "s26 driver not invoked" || okc 0 "s26 driver not invoked"
rm -f "$EVR"

echo '--- S27 a symlinked root refuses BEFORE launch ---'
rm -rf "$EVR" "$FIX/evtarget"; mkdir -p "$FIX/evtarget"; ln -s "$FIX/evtarget" "$EVR"
rm -f "$FIX/invoked"
run_case "$FIX/out27" FDRV_WRITE_MNT=1 > "$FIX/s27.log" 2>&1; chk $? 2 "s27 symlink-root rc=2"
grep -q 'interactive-evidence-before-invalid:symlink-root' "$FIX/out27/case-summary.json" && okc 1 "s27 symlink-root refusal recorded" || okc 0 "s27 symlink-root refusal recorded"
[ ! -f "$FIX/invoked" ] && okc 1 "s27 driver not invoked" || okc 0 "s27 driver not invoked"
rm -f "$EVR"; rm -rf "$FIX/evtarget"

echo '--- S28 a malformed identity with a trailing newline is never a vm id ---'
rm -rf "$EVR"
run_case "$FIX/out28" FDRV_EVIDENCE=1 FDRV_EVIDENCE_ID=$'vm-00db00db\n' FDRV_WRITE_MNT=1 > "$FIX/s28.log" 2>&1; chk $? 0 "s28 rc=0"
chk "$(python3 -c "import json;d=json.load(open('$FIX/out28/case-summary.json'));print(','.join(d.get('interactive_evidence_new_vms',[])) or 'none')" 2>/dev/null)" "none" "s28 newline id not counted"
chk "$(python3 -c "import json;d=json.load(open('$FIX/out28/case-summary.json'));e=d.get('interactive_evidence',{});print([i['reason'] for i in e.get('ignored',[]) if i['name'].startswith('vm-00db00db')][0])" 2>/dev/null)" "not-a-vm-id" "s28 newline id rejected as malformed"
rm -rf "$EVR"

echo '--- S29 sequential cases: the second case counts only its OWN new dir ---'
rm -rf "$EVR"
run_case "$FIX/out29a" FDRV_EVIDENCE=1 FDRV_EVIDENCE_ID=vm-11112222 FDRV_WRITE_MNT=1 > "$FIX/s29a.log" 2>&1; chk $? 0 "s29a rc=0"
chk "$(python3 -c "import json;d=json.load(open('$FIX/out29a/case-summary.json'));print(','.join(d.get('interactive_evidence_new_vms',[])))" 2>/dev/null)" "vm-11112222" "s29a first-case evidence counted"
run_case "$FIX/out29b" FDRV_EVIDENCE=1 FDRV_EVIDENCE_ID=vm-33334444 FDRV_EVIDENCE_MODE=logs-only FDRV_WRITE_MNT=1 > "$FIX/s29b.log" 2>&1; chk $? 0 "s29b rc=0"
chk "$(python3 -c "import json;d=json.load(open('$FIX/out29b/case-summary.json'));print(','.join(d.get('interactive_evidence_new_vms',[])))" 2>/dev/null)" "vm-33334444" "s29b second-case evidence counted (logs-only, prior dir excluded)"
rm -rf "$EVR"

echo ""
echo "RUN-CASE FIXTURES RESULT: pass=$PASSN fail=$FAILN"
[ "$FAILN" = 0 ]
