#!/usr/bin/env bash
# pty-selftest.sh — reject-before-trusting controls for pty-drive.py v4.
# Asserts RESULT-FILE content (verdict + reasons), never just driver exit status.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
DRIVE="$DIR/pty-drive.py"
T="$(mktemp -d /tmp/pty-selftest-XXXXXX)"
KEEP="${PTY_SELFTEST_KEEP:-0}"
trap 'if [ "$KEEP" = 1 ]; then echo "SELFTEST-KEPT $T"; else rm -rf "$T"; fi' EXIT
NONCE=$(python3 -c 'import os;print(os.urandom(6).hex())')
pass=0; fail=0
ck(){ if [ "$1" = "$2" ]; then echo "SELFTEST-OK $3"; pass=$((pass+1)); else echo "SELFTEST-BAD $3 (got [$1] want [$2])"; fail=$((fail+1)); fi; }
jq_(){ python3 -c "import json;d=json.load(open('$1'));print($2)"; }
run_case(){ python3 "$DRIVE" "$1" "$2" >/dev/null 2>&1; echo $?; }

# 1. computed marker, clean exit, terminal restored.
cat > "$T/c1.json" <<J
{"name":"coop","argv":["/bin/sh","-c","echo MARK-\$(python3 -c 'import os;print(os.urandom(6).hex())')-END; exit 0"],"timeout_s":20,"grace_s":5,
 "events":[{"wait_for":"MARK-[0-9a-f]{12}-END","regex":true,"timeout_s":10}]}
J
ck "$(run_case "$T/c1.json" "$T/o1")" 0 "cooperative-rc0"
ck "$(jq_ "$T/o1/coop.json" "d['verdict']")" "PASS" "cooperative-verdict"
ck "$(jq_ "$T/o1/coop.json" "d['terminal_restored']")" "True" "cooperative-terminal-restored"

# 2. missing required output.
cat > "$T/c2.json" <<'J'
{"name":"missing","argv":["/bin/sh","-c","echo hello; sleep 6; exit 0"],"timeout_s":20,"grace_s":9,
 "events":[{"wait_for":"NEVER-[0-9a-f]{8}-APPEARS","regex":true,"timeout_s":3}]}
J
ck "$(run_case "$T/c2.json" "$T/o2")" 1 "missing-output-rc1"
ck "$(jq_ "$T/o2/missing.json" "'required pattern' in d['fail_reasons'][0]")" "True" "missing-output-reason"

# 3. early exit before required output.
cat > "$T/c3.json" <<'J'
{"name":"early","argv":["/bin/sh","-c","exit 7"],"timeout_s":15,"grace_s":5,
 "events":[{"wait_for":"NEVER-APPEARS-XYZ","timeout_s":12}]}
J
ck "$(run_case "$T/c3.json" "$T/o3")" 1 "early-exit-rc1"
ck "$(jq_ "$T/o3/early.json" "d['exit_code']")" "7" "early-exit-code"
ck "$(jq_ "$T/o3/early.json" "bool(d['failed']) and any(('early-exit' in r) or ('never satisfied' in r) for r in d['fail_reasons'])")" "True" "early-exit-reason"

# 4. THE v4 FIX: child exits during a sleep; a LATER required observation must fail the case
#    (v3 passed this silently). Marker is computed-style (regex nonce) so the pre-check passes.
cat > "$T/c4.json" <<'J'
{"name":"exit-before-required","argv":["/bin/sh","-c","exit 0"],"timeout_s":20,"grace_s":6,
 "events":[{"sleep":1.5},{"wait_for":"LATE-[0-9a-f]{10}-MARK","regex":true,"timeout_s":4}]}
J
ck "$(run_case "$T/c4.json" "$T/o4")" 1 "exit-before-required-rc1"
ck "$(jq_ "$T/o4/exit-before-required.json" "bool(d['failed']) and any(('never satisfied' in r) or ('early-exit' in r) for r in d['fail_reasons'])")" "True" "exit-before-required-reason"

# 5. echo-satisfiable case REFUSED before spawn (pattern appears in a sent string).
cat > "$T/c5.json" <<J
{"name":"echo-refuse","argv":["/bin/sh","-c","sleep 30"],"timeout_s":10,"grace_s":3,
 "events":[{"send":"echo TELLTALE-MARKER-ABC"},{"wait_for":"TELLTALE-MARKER-ABC","timeout_s":3}]}
J
ck "$(run_case "$T/c5.json" "$T/o5")" 1 "echo-satisfiable-refused-rc1"
ck "$(jq_ "$T/o5/echo-refuse.json" "d['refused_echo_satisfiable']")" "TELLTALE-MARKER-ABC" "echo-refusal-recorded"

# 6. forbid guard: crash token in output fails an any_exit case.
cat > "$T/c6.json" <<'J'
{"name":"forbid","argv":["/bin/sh","-c","echo 'Unhandled error: boom'; exit 0"],"timeout_s":15,"grace_s":5,
 "events":[{"wait_for":"Unhandled","timeout_s":5},{"sleep":0.3}],"any_exit":true,
 "forbid":["Unhandled error"],"allow_echo_match":false}
J
ck "$(run_case "$T/c6.json" "$T/o6")" 1 "forbid-guard-rc1"
ck "$(jq_ "$T/o6/forbid.json" "'forbidden pattern' in d['fail_reasons'][-1]")" "True" "forbid-guard-reason"

# 7. hang with descendant: group-kill reaps both; killed+leaked recorded.
cat > "$T/c7.json" <<J
{"name":"hang","argv":["/bin/sh","-c","python3 -c 'import time;time.sleep(300)' PTV4-$NONCE & wait"],"timeout_s":4,"grace_s":3,
 "events":[{"wait_for":"NEVER-[0-9a-f]{6}","regex":true,"timeout_s":3}]}
J
ck "$(run_case "$T/c7.json" "$T/o7")" 1 "hang-rc1"
ck "$(jq_ "$T/o7/hang.json" "d['killed_after_timeout'] and d['leaked']")" "True" "hang-killed-and-leaked"
sleep 0.7
ck "$(pgrep -f "PTV4-$NONCE" | wc -l | tr -d ' ')" "0" "grandchild-group-killed"

# 8. terminal left broken -> driver FAILS (full-attrs comparison).
cat > "$T/c8.json" <<'J'
{"name":"break","argv":["/bin/sh","-c","stty -echo -icanon; exit 3"],"timeout_s":15,"grace_s":5,
 "events":[{"sleep":0.8}],"expected_exit_code":3}
J
ck "$(run_case "$T/c8.json" "$T/o8")" 1 "terminal-break-rc1"
ck "$(jq_ "$T/o8/break.json" "'terminal not restored' in d['fail_reasons'][0]")" "True" "terminal-break-reason"

# 9. honest restore -> PASS.
cat > "$T/c9.json" <<'J'
{"name":"restore","argv":["/bin/sh","-c","stty -echo; stty echo; exit 0"],"timeout_s":15,"grace_s":5,
 "events":[{"sleep":0.8}]}
J
ck "$(run_case "$T/c9.json" "$T/o9")" 0 "restore-rc0"
ck "$(jq_ "$T/o9/restore.json" "d['terminal_restored']")" "True" "restore-proven"

# 10. resize propagation (computed stty size after WINCH).
cat > "$T/c10.json" <<'J'
{"name":"resize","argv":["/bin/sh","-c","trap 'stty size' WINCH; trap 'exit 0' INT; echo READY-MARK; while :; do sleep 0.2; done"],"timeout_s":20,"grace_s":5,
 "events":[{"wait_for":"READY-MARK","timeout_s":5},{"resize":[30,100]},{"wait_for":"30 100","timeout_s":5},{"send_ctrl":"C"}]}
J
ck "$(run_case "$T/c10.json" "$T/o10")" 0 "resize-rc0"
ck "$(jq_ "$T/o10/resize.json" "d['verdict']")" "PASS" "resize-verdict"

# 11. disconnect: master closed; child finishes; disconnect semantics recorded.
cat > "$T/c11.json" <<'J'
{"name":"disconnect","argv":["/bin/sh","-c","sleep 2; exit 0"],"timeout_s":15,"grace_s":6,
 "events":[{"sleep":0.5},{"close_master":true}],"any_exit":true,"require_terminal_restored":false}
J
ck "$(run_case "$T/c11.json" "$T/o11")" 0 "disconnect-rc0"
ck "$(jq_ "$T/o11/disconnect.json" "d['disconnected'] and d['terminal_restored'] is None")" "True" "disconnect-semantics"

# 12. expected exit propagation (non-zero code honored).
cat > "$T/c12.json" <<'J'
{"name":"exit5","argv":["/bin/sh","-c","exit 5"],"timeout_s":15,"grace_s":5,
 "events":[{"sleep":0.5}],"expected_exit_code":5}
J
ck "$(run_case "$T/c12.json" "$T/o12")" 0 "exit-propagation-rc0"
ck "$(jq_ "$T/o12/exit5.json" "d['exit_code']")" "5" "exit-propagation-code"

# 13. v5 signal event targets the TARGET pid (external-termination scenario).
cat > "$T/c13.json" <<'J'
{"name":"signal-target","argv":["/bin/sh","-c","trap 'echo GOT-TERM; exit 42' TERM; echo READY-T13; while :; do sleep 0.2; done"],"timeout_s":20,"grace_s":6,"expected_exit_code":42,
 "events":[{"wait_for":"READY-T13","timeout_s":5},{"signal":"TERM"},{"sleep":0.8}]}
J
ck "$(run_case "$T/c13.json" "$T/o13")" 0 "signal-target-rc0"
ck "$(jq_ "$T/o13/signal-target.json" "d['exit_code']")" "42" "signal-target-exit"
ck "$(jq_ "$T/o13/signal-target.json" "d['terminal_restored']")" "True" "signal-target-terminal"

# 14. lingering descendant after target exit -> FAIL + reaped (invocation-owned cleanup control).
cat > "$T/c14.json" <<'J'
{"name":"linger","argv":["/bin/sh","-c","sleep 300 & echo STARTED-T14; exit 0"],"timeout_s":25,"grace_s":8,
 "events":[{"wait_for":"STARTED-T14","timeout_s":5}]}
J
ck "$(run_case "$T/c14.json" "$T/o14")" 1 "linger-rc1"
ck "$(jq_ "$T/o14/linger.json" "any('descendant survived' in r for r in d['fail_reasons'])")" "True" "linger-reason"
ck "$(jq_ "$T/o14/linger.json" "d['pgroup_still_alive_after_kill']")" "False" "linger-reaped"

# 15. optional send after natural exit -> recorded skip, case PASSES.
cat > "$T/c15.json" <<'J'
{"name":"opt-skip","argv":["/bin/sh","-c","echo RDY-OPT15; sleep 1.2; exit 0"],"timeout_s":20,"grace_s":8,
 "events":[{"wait_for":"RDY-OPT15","timeout_s":5},{"sleep":1.8},{"send":"late-optional\n","optional":true}]}
J
ck "$(run_case "$T/c15.json" "$T/o15")" 0 "optional-send-rc0"
ck "$(jq_ "$T/o15/opt-skip.json" "d['verdict']")" "PASS" "optional-send-verdict"

# 16. REQUIRED send after natural exit -> case FAILS (the discriminator).
cat > "$T/c16.json" <<'J'
{"name":"req-fail","argv":["/bin/sh","-c","echo RDY-OPT16; sleep 1.2; exit 0"],"timeout_s":20,"grace_s":8,
 "events":[{"wait_for":"RDY-OPT16","timeout_s":5},{"sleep":1.8},{"send":"late-required\n"}]}
J
ck "$(run_case "$T/c16.json" "$T/o16")" 1 "required-send-rc1"
ck "$(jq_ "$T/o16/req-fail.json" "d['failed'] and any(('impossible after target exit' in r) or ('after target exit' in r) for r in d['fail_reasons'])")" "True" "required-send-reason"

# 17. PENDIN/FLUSHO volatility mask unit control (kernel bits do not count as breakage).
python3 - "$DRIVE" <<'PY' > "$T/pendin-mask.out" 2>&1
import importlib.util, sys, termios
spec = importlib.util.spec_from_file_location("pd", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
P = getattr(termios, "PENDIN", 0); F = getattr(termios, "FLUSHO", 0)
base = {"iflag": 1, "oflag": 2, "cflag": 3, "lflag": 1483, "cc": [1, 2, 3]}
vol  = {"iflag": 1, "oflag": 2, "cflag": 3, "lflag": 1483 | P | F, "cc": [1, 2, 3]}
brk  = {"iflag": 1, "oflag": 2, "cflag": 3, "lflag": 1483 & ~termios.ECHO, "cc": [1, 2, 3]}
print("mask-volatile", m.same_terminal(base, vol))
print("catch-break", m.same_terminal(base, brk))
print("consts", P, F)
PY
ck "$(awk '/mask-volatile/{print $2}' "$T/pendin-mask.out")" "True" "pendin-volatile-masked"
ck "$(awk '/catch-break/{print $2}' "$T/pendin-mask.out")" "False" "pendin-break-still-caught"

# 18. v5.7 LATE-FINAL-REPORT WAIT: a clean target whose exit lags the old fixed window
#     (sleep 8 > the old ~5 s window) must still PASS with its real exit code + attrs, and
#     the leak probe must have run for it (enumeration ok). Pre-v5.7 this FAILED as
#     "no supervisor report" (the mac M0 reproduction control).
cat > "$T/c18.json" <<'J'
{"name":"late-clean","argv":["/bin/sh","-c","echo LATE18-READY; sleep 8; exit 0"],"timeout_s":60,"grace_s":10,
 "events":[{"wait_for":"LATE18-READY","timeout_s":10}]}
J
ck "$(run_case "$T/c18.json" "$T/o18")" 0 "late-clean-rc0"
ck "$(jq_ "$T/o18/late-clean.json" "d['verdict']")" "PASS" "late-clean-verdict"
ck "$(jq_ "$T/o18/late-clean.json" "d['exit_code']")" "0" "late-clean-exit-code"
ck "$(jq_ "$T/o18/late-clean.json" "d['terminal_restored']")" "True" "late-clean-terminal"
ck "$(jq_ "$T/o18/late-clean.json" "d['pgroup_enumeration_ok']")" "True" "late-clean-probe-ran"

# 19. LATE + nonzero exit: the real exit code is still enforced (7 != expected 0 => FAIL).
cat > "$T/c19.json" <<'J'
{"name":"late-badexit","argv":["/bin/sh","-c","echo LATE19-READY; sleep 6; exit 7"],"timeout_s":60,"grace_s":10,
 "events":[{"wait_for":"LATE19-READY","timeout_s":10}]}
J
ck "$(run_case "$T/c19.json" "$T/o19")" 1 "late-badexit-rc1"
ck "$(jq_ "$T/o19/late-badexit.json" "d['exit_code']")" "7" "late-badexit-code"
ck "$(jq_ "$T/o19/late-badexit.json" "any('exit code 7 not in expected' in r for r in d['fail_reasons'])")" "True" "late-badexit-reason"

# 20. LATE + lingering descendant: the probe must run for late reports too — a descendant that
#     a post-ack SIGHUP would mask must still FAIL the case and be reaped.
cat > "$T/c20.json" <<'J'
{"name":"late-linger","argv":["/bin/sh","-c","sleep 300 & echo LATE20-READY; sleep 6; exit 0"],"timeout_s":60,"grace_s":10,
 "events":[{"wait_for":"LATE20-READY","timeout_s":10}]}
J
ck "$(run_case "$T/c20.json" "$T/o20")" 1 "late-linger-rc1"
ck "$(jq_ "$T/o20/late-linger.json" "any('descendant survived' in r for r in d['fail_reasons'])")" "True" "late-linger-reason"
ck "$(jq_ "$T/o20/late-linger.json" "d['pgroup_still_alive_after_kill']")" "False" "late-linger-reaped"

# 21. The wait stays BOUNDED: a target that never exits still hits the hard deadline and is
#     killed (timeout_s remains a true ceiling; the report wait never extends past it).
cat > "$T/c21.json" <<'J'
{"name":"late-until-deadline","argv":["/bin/sh","-c","echo LATE21-READY; sleep 300"],"timeout_s":8,"grace_s":3,
 "events":[{"wait_for":"LATE21-READY","timeout_s":4}]}
J
ck "$(run_case "$T/c21.json" "$T/o21")" 1 "late-until-deadline-rc1"
ck "$(jq_ "$T/o21/late-until-deadline.json" "d['killed_after_timeout']")" "True" "late-until-deadline-killed"
ck "$(jq_ "$T/o21/late-until-deadline.json" "any('hard deadline' in r for r in d['fail_reasons'])")" "True" "late-until-deadline-reason"

# 22. STRICT CEILING: a target that exits just AFTER timeout_s FAILS deterministically even
#     though its report eventually arrives (the late report can never flip the verdict).
#     Pre-v5.7 this raced: usually an ugly FAIL, but arbitrarily PASS-able under a hitch.
cat > "$T/c22.json" <<'J'
{"name":"late-after-deadline","argv":["/bin/sh","-c","echo LATE22-READY; sleep 10; exit 0"],"timeout_s":8,"grace_s":3,
 "events":[{"wait_for":"LATE22-READY","timeout_s":4}]}
J
ck "$(run_case "$T/c22.json" "$T/o22")" 1 "deadline-ceiling-rc1"
ck "$(jq_ "$T/o22/late-after-deadline.json" "d['verdict']")" "FAIL" "deadline-ceiling-verdict"
ck "$(jq_ "$T/o22/late-after-deadline.json" "any('hard deadline' in r for r in d['fail_reasons'])")" "True" "deadline-ceiling-reason"

# 23. v5.8 OSC-STRIP (wait side): a receipt-shaped string that exists ONLY inside an OSC
#     window-title sequence must NOT satisfy a wait_for. Pre-v5.8 the title matched at
#     ~t+0.1 s and this case PASSED; the strip makes it a deterministic FAIL (and the raw
#     log must still keep the title bytes).
cat > "$T/c23.json" <<J
{"name":"osc-title-wait","argv":["/bin/sh","-c","printf '\u001b]2;GHOST-$NONCE-END\u0007'; sleep 3; exit 0"],"timeout_s":15,"grace_s":5,
 "events":[{"wait_for":"GHOST-$NONCE-END","timeout_s":2}],"expected_exit_code":0}
J
ck "$(run_case "$T/c23.json" "$T/o23")" 1 "osc-title-wait-rc1"
ck "$(jq_ "$T/o23/osc-title-wait.json" "any('not found within' in r for r in d['fail_reasons'])")" "True" "osc-title-wait-reason"
ck "$(grep -c "$(printf '\033]2;GHOST-')" "$T/o23/osc-title-wait.log" | awk '{print ($1>=1)?"yes":"no"}')" "yes" "osc-title-raw-log-kept"

# 24. v5.8 OSC-STRIP (no over-strip): the SAME receipt printed for real must still match,
#     and NOT be matched from the title: at_s >= 0.9 s discriminates early-title matching.
cat > "$T/c24.json" <<J
{"name":"osc-title-real","argv":["/bin/sh","-c","printf '\u001b]2;REAL-$NONCE-END\u0007'; sleep 1; printf 'REAL-$NONCE-END\n'; exit 0"],"timeout_s":15,"grace_s":5,
 "events":[{"wait_for":"REAL-$NONCE-END","timeout_s":5}],"expected_exit_code":0}
J
ck "$(run_case "$T/c24.json" "$T/o24")" 0 "osc-title-real-rc0"
ck "$(jq_ "$T/o24/osc-title-real.json" "d['verdict']=='PASS' and d['osc_stripped']>=1 and d['events'][0]['at_s']>=0.9")" "True" "osc-title-real-neither-early-nor-lost"

# 25. v5.8 OSC-STRIP (require side): a string that exists ONLY in a title must NOT satisfy
#     a case["require"] pattern (pre-v5.8 the require scan read raw text and PASSED).
cat > "$T/c25.json" <<J
{"name":"osc-title-req","argv":["/bin/sh","-c","printf '\u001b]2;REQONLY-$NONCE-END\u0007'; printf 'OK-REQ\n'; exit 0"],"timeout_s":15,"grace_s":5,
 "events":[{"wait_for":"OK-REQ","timeout_s":5}],"require":["REQONLY-$NONCE-END"],"expected_exit_code":0}
J
ck "$(run_case "$T/c25.json" "$T/o25")" 1 "osc-title-req-rc1"
ck "$(jq_ "$T/o25/osc-title-req.json" "any('required end-state pattern' in r for r in d['fail_reasons'])")" "True" "osc-title-req-reason"

# 26. v5.8 FORBID CONTROL: forbid patterns keep reading the RAW text (a forbidden token in
#     a title still FAILS the case) — the strip must not neuter forbid teeth.
cat > "$T/c26.json" <<J
{"name":"osc-forbid","argv":["/bin/sh","-c","printf '\u001b]2;Unhandled error\u0007'; printf 'OK-FORBID\n'; exit 0"],"timeout_s":15,"grace_s":5,
 "events":[{"wait_for":"OK-FORBID","timeout_s":5}],"forbid":["Unhandled error"],"expected_exit_code":0}
J
ck "$(run_case "$T/c26.json" "$T/o26")" 1 "osc-forbid-rc1"
ck "$(jq_ "$T/o26/osc-forbid.json" "any('forbidden pattern' in r for r in d['fail_reasons'])")" "True" "osc-forbid-reason"

# 27. v5.8 strip_osc unit controls: split-read sequences (BEL and ST forms), CSI
#     preservation, split ESC into a CSI, and the dropped-sequence counter.
python3 - "$DRIVE" <<'PY' > "$T/osc-unit.out" 2>&1
import importlib.util, sys
spec = importlib.util.spec_from_file_location("pd", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
st = {"mode": b"", "osc_len": 0, "count": 0}
a = m.strip_osc(b"pre\x1b]2;g", st) + m.strip_osc(b"host\x07post", st)
b2 = m.strip_osc(b"A\x1b]0;x", st) + m.strip_osc(b"\x1b\\B", st)
c = m.strip_osc(b"E\x1b[31mF", st)
d = m.strip_osc(b"G\x1b", st) + m.strip_osc(b"[1mH", st)
print("osc-split-bel", a)
print("osc-split-st", b2)
print("csi-keep", c)
print("esc-split-csi", d)
print("count", st["count"])
PY
ck "$(awk '/^osc-split-bel/{print $2}' "$T/osc-unit.out")" "b'prepost'" "osc-unit-split-bel"
ck "$(awk '/^osc-split-st/{print $2}' "$T/osc-unit.out")" "b'AB'" "osc-unit-split-st"
ck "$(awk '/^csi-keep/{print $2}' "$T/osc-unit.out")" "b'E\\x1b[31mF'" "osc-unit-csi-kept"
ck "$(awk '/^esc-split-csi/{print $2}' "$T/osc-unit.out")" "b'G\\x1b[1mH'" "osc-unit-esc-split-csi"
ck "$(awk '/^count/{print $2}' "$T/osc-unit.out")" "2" "osc-unit-count"

echo "PTY-SELFTEST-SUMMARY pass=$pass fail=$fail"
echo "PTY-SELFTEST-SHA $(sha256sum "$DRIVE" | cut -d' ' -f1)"
[ "$fail" = 0 ] || exit 1
