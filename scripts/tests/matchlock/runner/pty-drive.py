#!/usr/bin/env python3
"""pty-drive.py v5 — drive one interactive command under a fresh PTY; evidence-first, fail-closed.

v5 closes the macOS observation hole in v4 and adds end-state assertions:
  SUPERVISOR SESSION: on macOS, after the session-leader process exits, slave-side terminal
  attributes become UNREADABLE (ENOTTY) to any process outside the session, so a driver reading
  them from outside can never observe restoration — treating unreadable as pass-or-fail would
  both be wrong. v5 forks a SUPERVISOR that owns the session for the whole case:
    driver -> supervisor (setsid, owns the pty slave; ignores SIGINT/TERM/HUP/QUIT so
    terminal signals reach only the target) -> target (the command under test; inherits the
    slave as controlling tty).
  The supervisor waits for the target, THEN reads the terminal attributes from INSIDE the
  session (readable on every platform) and reports {target status, attrs} to the driver over a
  pipe. No report => the case FAILS (fail-closed). The supervisor never edits terminal state.
  SHARED REPORT STATE: report lines are read once into a shared holder (target_pid line and the
  final {status, attrs} line), so a fast target can never have its final report consumed early.
  END-STATE REQUIRE ASSERTIONS: case["require"] = [regex,...] must ALL be present in the full
  captured output at verdict time; each require pattern is also echo-satisfiability-checked.

Retained from v4: echo-satisfiability pre-check for wait_for (computed markers), required-
observation ledger reconciled after target exit, strict full-attribute terminal comparison,
forbid guards, vm-id extraction, single-owner child status, atomic result writes, hard monotonic
deadline, process-group kill on deadline, post-exit lingering-descendant probe (survivor after
target exit FAILS the case, is reaped, and recorded).

Case JSON: name; argv; cwd?; env?; term?; rows/cols?; timeout_s (HARD); grace_s; expected_exit_code
 OR expected_exit_codes (negative = signal); any_exit; require_terminal_restored (default true);
 forbid: [regex,...]; require: [regex,...]; allow_echo_match (default false); events[] of:
  {"wait_for": str, "regex": bool?, "timeout_s": n, "required": bool? (default true)}
  {"send": str} {"send_ctrl": "C"|"D"} {"sleep": sec} {"resize": [rows, cols]}
  {"close_master": true} {"signal": "TERM"|"INT"|"HUP"|...} (sent to the target pid)

v5.7 (case-blocking collector fix; sanctioned under the v5.6 freeze — mac M0):
  * LATE-FINAL-REPORT WAIT: after the events, wait up to case final_wait_s (default 90 s) and
    never past the hard deadline for the target's final report BEFORE the leak probe and ack.
    Cause: darwin matchlock VM teardown lags the guest shell exit by ~25-30 s, so the report
    can arrive long after any fixed short drain window; v5.6 misread that as "no supervisor
    report" (fail-closed false negative). The probe-before-ack order (v5.2) is preserved, so
    the leak nets still run while the session is live; missing reports / forced kills /
    unobservable terminal state still FAIL.

v5.6 refinements (INSTRUMENT FREEZE — no further revisions unless a case is BLOCKED):
  * PENDIN/FLUSHO MASK: the terminal-restoration comparison ignores the kernel-managed
    lflag bits PENDIN and FLUSHO (macOS sets PENDIN after re-typed input), which otherwise
    produced a false "terminal not restored" on the Mac; real ECHO/ICANON changes still fail.

v5.5 refinements:
  * EPERM-SAFE GROUP CLEANUP: macOS denies killpg(SIGKILL) after the group's session leader
    exits; kill_group() falls back to per-member pid kills (same-uid kill remains allowed),
    every killpg site routes through it, and the leak verdict keys are written
    unconditionally (a cleanup failure can never lose the result fields again).

v5.4 refinements:
  * TARGET-EXIT AWARENESS WITHOUT RACING THE ACK: wait/sleep loops poll the report pipe
    (poll_reports) and fail fast with the specific "early-exit before required pattern" /
    "never satisfied (target exited first)" messages as soon as the target's final report
    arrives, instead of waiting out the full per-event timeout while the supervisor holds
    the session for the ack.

v5.2 refinements:
  * ACKed SUPERVISOR EXIT: the supervisor holds the session open until the driver acks, so the
    kernel's session-leader-exit SIGHUP cannot mask leaked descendants from the leak probe.
  * LEAK PROBE BEFORE ACK: the process-group leak probe runs while the session is still live.
  * TARGET SIGNAL DEFAULTING: the target resets INT/TERM/HUP/QUIT to SIG_DFL (the supervisor's
    ignores must not swallow Ctrl-C/external TERM intended for the command under test).

Driver exit: 0 = PASS, 1 = FAIL. Result: OUTDIR/<name>.json (+ raw log; case copy).
"""
import fcntl, json, os, pty, re, select, shutil, signal, struct, subprocess, sys, time, termios, traceback

def set_winsize(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

def attrs(fd):
    """Full raw-mode-sensitive terminal attribute snapshot; {'error': ...} when unreadable."""
    try:
        a = termios.tcgetattr(fd)
        iflag, oflag, cflag, lflag = a[0], a[1], a[2], a[3]
        cc = []
        for c in (a[6] if len(a) > 6 else []):
            if isinstance(c, int):
                cc.append(c)
            elif isinstance(c, (bytes, bytearray)):
                cc.append(int.from_bytes(bytes(c), "little") if len(c) else -1)
            else:
                cc.append(-1)
        return {"iflag": iflag, "oflag": oflag, "cflag": cflag, "lflag": lflag,
                "cc": cc,
                "echo": bool(lflag & termios.ECHO), "icanon": bool(lflag & termios.ICANON)}
    except Exception as e:
        return {"error": str(e)}

_VOLATILE_LFLAG = getattr(termios, "PENDIN", 0) | getattr(termios, "FLUSHO", 0)

def same_terminal(a, b):
    """Raw-mode-sensitive terminal comparison. Kernel-managed lflag bits that do NOT
    indicate raw mode are masked: PENDIN (re-typed input pending; macOS sets this after a
    session's input continues) and FLUSHO (output being flushed). A REAL ECHO/ICANON or cc
    difference is still caught (unit control in the selftest + the terminal-break case)."""
    if not a or not b or "error" in a or "error" in b:
        return False
    for k in ("iflag", "oflag", "cflag", "cc"):
        if a.get(k) != b.get(k):
            return False
    if (a.get("lflag") & ~_VOLATILE_LFLAG) != (b.get("lflag") & ~_VOLATILE_LFLAG):
        return False
    return True


def group_alive(pgid):
    """Platform-independent group-existence probe: killpg(,0). After the supervisor is
    reaped, a surviving group can only hold OTHER members (a zombie counts until reaped;
    callers retry with delays). This is the primary leak verdict; ps enumeration is
    diagnostic detail."""
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True

def pgroup_members(pgid, exclude=()):
    """Enumerate live process-group members as (pid, state) via ps — portable Linux/macOS.
    Pids in `exclude` are omitted (the supervisor is a member of its own group while it
    holds the session for the ack). Returns (members, ok): ok=False means EVERY ps form
    failed (vacuous enumeration must never masquerade as an empty group); the killpg
    group_alive verdict covers the leak decision regardless."""
    for args in (["ps", "-eo", "pid=,pgid=,stat="],
                 ["ps", "ax", "-o", "pid=,pgid=,stat="],
                 ["ps", "-A", "-o", "pid=,pgid=,stat="]):
        try:
            r = subprocess.run(args, capture_output=True, text=True, timeout=15)
        except Exception:
            continue
        if r.returncode != 0 or not (r.stdout or "").strip():
            continue
        members = []
        for line in r.stdout.splitlines():
            parts = line.split(None, 3)
            if len(parts) < 3 or parts[0] == "PID":
                continue
            try:
                mpid, mpgid = int(parts[0]), int(parts[1])
            except ValueError:
                continue
            if mpgid == pgid and mpid not in exclude:
                members.append((mpid, parts[2]))
        return members, True
    return [], False

def kill_group(pgid, exclude=()):
    """Owned-group cleanup that works where killpg(SIGKILL) is DENIED: macOS refuses
    killpg(SIGKILL) once the group's session leader is gone (EPERM). Try killpg first,
    then kill each enumerated member by pid (same-uid per-pid kill remains permitted).
    Returns True when the group is gone or every kill attempt succeeded; on a still-
    alive group after attempts, returns False. Callers re-check group_alive()."""
    try:
        os.killpg(pgid, signal.SIGKILL)
        return not group_alive(pgid)
    except ProcessLookupError:
        return True
    except PermissionError:
        pass
    mem, _ok = pgroup_members(pgid, exclude=exclude)
    if not mem:
        return not group_alive(pgid)
    for mpid, _st in mem:
        try:
            os.kill(mpid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except PermissionError:
            pass
    return not group_alive(pgid)

def main():
    case = json.load(open(sys.argv[1]))
    outdir = sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    name = case["name"]
    logp = os.path.join(outdir, name + ".log")
    jsonp = os.path.join(outdir, name + ".json")
    tmpp = jsonp + ".tmp"
    try:
        shutil.copyfile(sys.argv[1], os.path.join(outdir, name + ".case.json"))
    except Exception:
        pass

    res = {"name": name, "argv": case["argv"], "cwd": case.get("cwd"), "failed": False,
           "fail_reasons": [], "events": [],
           "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}

    def fail(reason):
        res["failed"] = True
        res["fail_reasons"].append(reason)

    def write_result():
        try:
            json.dump(res, open(tmpp, "w"), indent=2)
            os.replace(tmpp, jsonp)
            return True
        except Exception as e:
            sys.stderr.write("PTY-DRIVE RESULT-WRITE-FAILED %s: %r\n" % (jsonp, e))
            sys.stderr.write("PTY-DRIVE RESULT-FALLBACK " + json.dumps(res) + "\n")
            return False

    def note(evt):
        evt["at_s"] = round(time.monotonic() - t0, 2)
        res["events"].append(evt)

    # ---- (A) echo-satisfiability pre-check: refuse before spawning ------------------
    # Applies to wait_for AND require patterns: a string we SEND could be echoed back by the
    # terminal and satisfy either kind of assertion. Markers must be computed.
    sends = [ev["send"] for ev in case.get("events", []) if "send" in ev]
    sent_concat = "\n".join(sends).encode()
    if not case.get("allow_echo_match", False):
        checks = [("wait_for", ev["wait_for"], bool(ev.get("regex")))
                  for ev in case.get("events", []) if "wait_for" in ev]
        checks += [("require", pat, True) for pat in (case.get("require") or [])]
        for kind, pat, is_re in checks:
            try:
                rx = re.compile(pat.encode()) if is_re else re.compile(re.escape(pat).encode())
                if rx.search(sent_concat):
                    res["refused_echo_satisfiable"] = pat
                    fail(f"refused: {kind} pattern {pat!r} can be satisfied by terminal echo of a sent string "
                         "(markers must be computed; bypass with allow_echo_match:true and disclose)")
                    res["verdict"] = "FAIL"
                    write_result()
                    print(json.dumps({"name": name, "verdict": "FAIL", "refused_echo_satisfiable": pat}))
                    sys.exit(1)
            except re.error as e:
                fail(f"invalid {kind} pattern {pat!r}: {e}")
                res["verdict"] = "FAIL"
                write_result()
                print(json.dumps({"name": name, "verdict": "FAIL", "fail_reasons": res["fail_reasons"]}))
                sys.exit(1)

    t0 = time.monotonic()
    hard_end = t0 + float(case.get("timeout_s", 300))
    rows, cols = case.get("rows", 24), case.get("cols", 80)
    ok_codes = case.get("expected_exit_codes")
    if ok_codes is None:
        ok_codes = [case.get("expected_exit_code", 0)]
    any_exit = bool(case.get("any_exit", False))
    require_restore = bool(case.get("require_terminal_restored", True))

    master, slave = pty.openpty()
    set_winsize(slave, rows, cols)
    res["termios_before"] = attrs(slave)
    rep_r, rep_w = os.pipe()
    ctl_r, ctl_w = os.pipe()
    pid = os.fork()
    if pid == 0:  # SUPERVISOR: owns the session across the target's whole lifetime.
        try:
            os.close(master)
            os.close(rep_r)
            os.close(ctl_w)
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            os.dup2(slave, 0)
            os.dup2(slave, 1)
            os.dup2(slave, 2)
            if slave > 2:
                os.close(slave)
            # Terminal-generated signals belong to the target, not the observer.
            for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGQUIT):
                try:
                    signal.signal(sig, signal.SIG_IGN)
                except Exception:
                    pass
            tpid = os.fork()
            if tpid == 0:  # TARGET: the command under test.
                try:
                    # v5.1: ignored signal dispositions PERSIST across fork+exec, so the
                    # supervisor ignoring SIGINT/TERM/HUP/QUIT (so it survives to observe the
                    # session) would otherwise leave the TARGET unable to ever receive them —
                    # Ctrl-C via the line discipline and external TERM would be swallowed.
                    # The target gets DEFAULT dispositions; the observer keeps its ignores.
                    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGQUIT):
                        try:
                            signal.signal(sig, signal.SIG_DFL)
                        except Exception:
                            pass
                    if case.get("cwd"):
                        os.chdir(case["cwd"])
                    env = dict(os.environ)
                    env.update(case.get("env") or {})
                    env["TERM"] = case.get("term", "xterm-256color")
                    os.execvpe(case["argv"][0], case["argv"], env)
                except Exception as e:
                    try:
                        os.write(2, ("EXEC-FAIL %s\n" % e).encode())
                    finally:
                        os._exit(127)
            os.write(rep_w, (json.dumps({"target_pid": tpid}) + "\n").encode())
            _, st = os.waitpid(tpid, 0)
            # INSIDE the session: the terminal is readable here on every platform.
            report = {"target_pid": tpid, "status": st, "attrs_after": attrs(1)}
            try:
                os.write(rep_w, (json.dumps(report) + "\n").encode())
            finally:
                os.close(rep_w)
            # v5.2: hold the session open until the driver acknowledges. Exiting as the
            # session leader would make the kernel send SIGHUP/SIGCONT to the terminal's
            # foreground process group, which can kill leaked descendants and MASK them
            # from the driver's leak probe.
            try:
                select.select([ctl_r], [], [], 120)
                os.read(ctl_r, 1)
            except OSError:
                pass
            os._exit(0)
        except Exception:
            os._exit(126)

    os.close(rep_w)
    os.close(ctl_r)
    # Nonblocking master AFTER spawn: reads never block; writes are bounded by write_all.
    nonblock_ok = False
    try:
        fl = fcntl.fcntl(master, fcntl.F_GETFL)
        fcntl.fcntl(master, fcntl.F_SETFL, fl | os.O_NONBLOCK)
        nonblock_ok = True
    except OSError:
        pass
    res["nonblock_master"] = nonblock_ok
    res["supervisor_pid"] = pid

    # ---- shared report state: every parsed line lands here exactly once -------------
    report_state = {"target_pid": None, "final": None, "buf": b""}

    def _ingest_report_chunk(chunk):
        report_state["buf"] += chunk
        while b"\n" in report_state["buf"]:
            line, report_state["buf"] = report_state["buf"].split(b"\n", 1)
            if not line.strip():
                continue
            try:
                d = json.loads(line)
            except Exception:
                res.setdefault("report_unparsed", []).append(line.decode("utf-8", "replace")[:200])
                continue
            if isinstance(d, dict) and d.get("status") is not None:
                report_state["final"] = d
            if isinstance(d, dict) and d.get("target_pid"):
                report_state["target_pid"] = int(d["target_pid"])

    def read_reports(wait_s, want_final=False):
        end = time.monotonic() + wait_s
        while time.monotonic() < end:
            if report_state["target_pid"] is not None and (report_state["final"] is not None or not want_final):
                # got what was asked; brief grace for the other piece
                end = min(end, time.monotonic() + 0.3)
            r, _, _ = select.select([rep_r], [], [], 0.2)
            if not r:
                if report_state["target_pid"] is not None and not want_final:
                    break
                continue
            try:
                chunk = os.read(rep_r, 65536)
            except OSError:
                break
            if not chunk:
                break
            _ingest_report_chunk(chunk)
        return report_state

    def poll_reports():
        """One nonblocking ingest of report bytes already available (v5.4): lets wait/sleep
        loops observe the TARGET's exit without racing the supervisor's ack."""
        try:
            r, _, _ = select.select([rep_r], [], [], 0.0)
        except (OSError, ValueError):
            return
        if not r:
            return
        try:
            chunk = os.read(rep_r, 65536)
        except OSError:
            return
        if chunk:
            _ingest_report_chunk(chunk)

    def target_exited():
        """The target's final report {status, attrs} has arrived (v5.4)."""
        poll_reports()
        return report_state["final"] is not None

    res["child_pid"] = None
    buf = bytearray()
    log = open(logp, "wb")
    search_from = 0
    master_open = True
    disconnected = False
    status_holder = {"val": None, "known": False}
    killed = False

    def peek_status():
        if status_holder["known"]:
            return True
        try:
            wpid, st = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            status_holder["val"] = None
            status_holder["known"] = True
            return True
        if wpid == pid:
            status_holder["val"] = st
            status_holder["known"] = True
            return True
        return False

    def pump(tmo):
        nonlocal master_open
        if not master_open:
            time.sleep(min(tmo, 0.2))
            return
        try:
            r, _, _ = select.select([master], [], [], tmo)
        except (OSError, ValueError):
            master_open = False
            return
        if not r:
            return
        try:
            data = os.read(master, 65536)
        except BlockingIOError:
            return
        except OSError:
            return
        if data:
            buf.extend(data)
            log.write(data)
            log.flush()

    def drain_quiet(max_s, hard_clip=True):
        end = time.monotonic() + max_s
        if hard_clip:
            end = min(end, hard_end)
        quiet = 0.0
        while time.monotonic() < end and quiet < 0.35:
            n0 = len(buf)
            pump(0.1)
            quiet = 0.0 if len(buf) > n0 else quiet + 0.1

    def match_from_buffer(pat, rx):
        nonlocal search_from
        hay = bytes(buf[search_from:])
        if rx:
            m = rx.search(hay)
            if m:
                search_from += m.end()
                return True
            return False
        i = hay.find(pat.encode())
        if i >= 0:
            search_from += i + len(pat.encode())
            return True
        return False

    def write_all(data, label, per_write_cap=15.0):
        """Bounded, partial-write-safe sender. Nonblocking master: EAGAIN backs off while
        continuing to service readable output; caps and the hard deadline bound every path."""
        end = min(time.monotonic() + per_write_cap, hard_end)
        off = 0
        while off < len(data):
            if time.monotonic() >= end:
                fail(f"{label}: write incomplete ({off}/{len(data)} bytes) within bound")
                return False
            if target_exited():
                fail(f"{label}: target exited during write ({off}/{len(data)} bytes sent)")
                return False
            try:
                n = os.write(master, data[off:])
                off += n
            except BlockingIOError:
                pump(0.05)
            except OSError as e:
                fail(f"{label}: write failed: {e}")
                return False
        return True

    try:
        if not nonblock_ok:
            fail("could not set nonblocking master; write bounds not enforceable — refusing case")
        read_reports(5.0)
        if report_state["target_pid"] is None:
            fail("supervisor did not report a target pid within 5s")
        else:
            res["target_pid"] = report_state["target_pid"]
        events = case.get("events", [])
        idx = 0
        while idx < len(events) and not res["failed"]:
            ev = events[idx]
            if target_exited():
                drain_quiet(3.0)
                for j in range(idx, len(events)):
                    rem = events[j]
                    if "wait_for" in rem:
                        rx = re.compile(rem["wait_for"].encode()) if rem.get("regex") else None
                        matched = match_from_buffer(rem["wait_for"], rx)
                        note({"wait_for": rem["wait_for"], "found": matched, "post_exit": True})
                        if matched:
                            continue
                        if rem.get("required", True):
                            fail(f"required observation {rem['wait_for']!r} never satisfied (target exited first)")
                        else:
                            note({"optional_skipped": rem["wait_for"]})
                    elif rem.get("optional", False):
                        note({"optional_skipped_after_exit": j})
                    else:
                        kind = next((k for k in ("send", "send_ctrl", "resize", "close_master", "signal") if k in rem), "sleep")
                        if kind == "sleep":
                            note({"sleep_after_exit": rem.get("sleep")})
                        else:
                            fail(f"event #{j} ({kind}) impossible after target exit")
                break
            if time.monotonic() >= hard_end:
                fail(f"hard deadline reached before event #{idx} {ev}")
                break
            if "wait_for" in ev:
                pat = ev["wait_for"]
                rx = re.compile(pat.encode()) if ev.get("regex") else None
                lit = None if rx else pat.encode()
                wdl = min(time.monotonic() + float(ev.get("timeout_s", 60)), hard_end)
                found = False
                early = False
                while time.monotonic() < wdl:
                    pump(0.4)
                    hay = bytes(buf[search_from:])
                    if rx:
                        m = rx.search(hay)
                        if m:
                            found = True
                            search_from += m.end()
                            break
                    else:
                        i = hay.find(lit)
                        if i >= 0:
                            found = True
                            search_from += i + len(lit)
                            break
                    if target_exited():
                        early = True
                        break
                if found:
                    note({"wait_for": pat, "found": True})
                else:
                    note({"wait_for": pat, "found": False})
                    if early:
                        fail(f"early-exit before required pattern {pat!r}")
                    elif ev.get("required", True):
                        fail(f"required pattern {pat!r} not found within {ev.get('timeout_s', 60)}s")
                    else:
                        note({"optional_missing": pat})
                if res["failed"]:
                    break
            elif "send" in ev:
                if not master_open or target_exited():
                    if ev.get("optional", False):
                        note({"optional_skipped_after_exit": ev.get("send", "")[:60]})
                    else:
                        fail("send after target exit/disconnect")
                        break
                elif not write_all(ev["send"].encode(), "send"):
                    note({"send_incomplete": True})
                    break
                else:
                    note({"send": ev["send"][:120]})
            elif "send_ctrl" in ev:
                if not master_open or target_exited():
                    if ev.get("optional", False):
                        note({"optional_skipped_after_exit": "ctrl:" + str(ev.get("send_ctrl"))})
                    else:
                        fail("send_ctrl after target exit/disconnect")
                        break
                else:
                    c = {"C": b"\x03", "D": b"\x04"}.get(ev["send_ctrl"], b"")
                    if not write_all(c, "send_ctrl"):
                        break
                    note({"send_ctrl": ev["send_ctrl"]})
            elif "signal" in ev:
                tp = report_state["target_pid"]
                if tp is None:
                    fail("signal event before target pid was reported")
                    break
                signame = "SIG" + str(ev["signal"]).upper()
                signum = getattr(signal, signame, None)
                if signum is None:
                    fail(f"unknown signal {ev['signal']}")
                    break
                try:
                    os.kill(tp, signum)
                    note({"signal": ev["signal"], "to": "target"})
                except ProcessLookupError:
                    fail("target already gone at signal")
                    break
            elif "sleep" in ev:
                end = min(time.monotonic() + float(ev["sleep"]), hard_end)
                while time.monotonic() < end and not res["failed"]:
                    pump(0.4)
                    if target_exited():
                        break
                note({"sleep": ev["sleep"]})
            elif "resize" in ev:
                r2, c2 = ev["resize"]
                try:
                    set_winsize(slave, r2, c2)
                    note({"resize": [r2, c2]})
                except OSError as e:
                    fail(f"resize failed: {e}")
                    break
            elif "close_master" in ev:
                try:
                    os.close(master)
                except OSError:
                    pass
                master_open = False
                disconnected = True
                note({"close_master": True})
            idx += 1

        # FINAL: bounded WAIT for the target's final report, THEN probe + ack (v5.7
        # LATE-FINAL-REPORT WAIT — sanctioned case-blocking fix under the v5.6 freeze).
        # The supervisor writes the report only after the target exits, and some targets tear
        # down long after their guest shell exits (darwin matchlock VM teardown measured ~25-30 s),
        # far beyond any fixed short window — previously misread as "no supervisor report" on a
        # clean exit (mac M0 reproduction). Waiting here (a) keeps the v5.2 order intact: the leak
        # probe still runs BEFORE the ack, while the session is live, so a session-leader-exit
        # SIGHUP can never mask a leaked descendant; and (b) still yields the real target status +
        # terminal snapshot. Bounded by case final_wait_s (default 90 s) AND the hard deadline; a
        # target that never exits still reaches the kill path below (=> FAIL, never a false pass).
        fw_end = min(time.monotonic() + float(case.get("final_wait_s", 90)), hard_end)
        while report_state["final"] is None and time.monotonic() < fw_end:
            pump(min(0.2, max(0.0, fw_end - time.monotonic())))
            poll_reports()
        poll_reports()  # final nonblocking sweep: a report landing in the last pump window
                        # must be seen before the strict-ceiling decision below. Every pump
                        # above is clipped to the remaining budget (fw_end <= hard_end), so a
                        # report first observed here can overshoot the deadline by at most one
                        # select cycle (~0.2 s) — a hang can never ride it, and a clean exit
                        # within timeout_s is still captured.
        if report_state["final"] is None and time.monotonic() >= hard_end:
            # timeout_s is a STRICT ceiling: a target that had not completed by the deadline
            # FAILS deterministically, even when its late report lands during the bounded
            # cleanup below (fail() is sticky, so a late report can never flip the verdict).
            fail("hard deadline reached before target exit (no final report by timeout_s)")
        drain_quiet(2.0, hard_clip=False)
        read_reports(1.0, want_final=True)

        # ---- leak probe WHILE the session is still live (v5.2/v5.3) -----------------
        # Probe before the supervisor exits: its exit as session leader would trigger the
        # kernel's SIGHUP/SIGCONT to the foreground group and could hide leaked members.
        # The supervisor itself is excluded (it is a member of its own group while it
        # holds the session); zombie-only membership is transient (init reaps reparented
        # descendants) and is not a live leak. A force-killed case has no final report and
        # skips the probe — its cleanup is the killpg rescue path.
        target_reported = report_state["final"] is not None
        live_members = []
        enum_ok = False
        if target_reported:
            mem, enum_ok = pgroup_members(pid, exclude=(pid,))
            live_members = [m for m in mem if not m[1].startswith("Z")]
            if live_members:
                time.sleep(1.2)
                mem, enum_ok = pgroup_members(pid, exclude=(pid,))
                live_members = [m for m in mem if not m[1].startswith("Z")]
        res["pgroup_enumeration_ok"] = enum_ok
        res["pgroup_members_live"] = [[m[0], m[1]] for m in live_members]

        # ---- ack the supervisor, then bounded reap ----------------------------------
        try:
            os.write(ctl_w, b"x")
        except OSError:
            pass
        grace_end = min(time.monotonic() + float(case.get("grace_s", 60)), hard_end)
        while not peek_status() and time.monotonic() < grace_end:
            pump(0.4)
        if not peek_status() and time.monotonic() >= hard_end:
            fail("hard deadline expired with the supervisor alive")
        if not peek_status():
            kill_group(pid)
            rescue_end = time.monotonic() + 8
            while not peek_status() and time.monotonic() < rescue_end:
                pump(0.2)
            killed = True
            res["killed_after_timeout"] = True
            res["leaked"] = True
            fail("killed after hard deadline; owned VM may need explicit cleanup")
        else:
            res["killed_after_timeout"] = False

        # ---- lingering-descendant verdict (dual net) --------------------------------
        # Net 1: ps-enumerated live members observed BEFORE the ack (supervisor still
        # holds the session, so no session-leader exit SIGHUP could have masked them).
        # Net 2: post-reap killpg(,0) — supervisor is reaped, so any surviving member is
        # a leaked descendant; catches cases enumeration missed. Either net => FAIL.
        post_reap_alive = group_alive(pid)
        leak = bool(target_reported and (live_members or post_reap_alive))
        res["pgroup_cleaned"] = None
        res["pgroup_still_alive_after_kill"] = None
        if leak:
            fail(f"descendant survived target exit (process-group leak): members={res['pgroup_members_live']} "
                 f"post_reap_alive={post_reap_alive}")
            try:
                res["pgroup_cleaned"] = kill_group(pid)
                sleep_until = time.monotonic() + 3.0
                while time.monotonic() < sleep_until and group_alive(pid):
                    time.sleep(0.1)
                res["pgroup_still_alive_after_kill"] = group_alive(pid)
            except Exception as e:  # never let cleanup lose the verdict keys
                res["pgroup_cleanup_error"] = repr(e)
                res["pgroup_still_alive_after_kill"] = group_alive(pid)
        else:
            res["pgroup_cleaned"] = False
            res["pgroup_still_alive_after_kill"] = False

        res["disconnected"] = disconnected
        rep = report_state["final"]
        if rep is not None:
            tst = rep.get("status")
            code = os.waitstatus_to_exitcode(tst) if tst is not None else None
            res["exit_code"] = code
            if code is not None and code < 0:
                res["terminated_by_signal"] = -code
            if not any_exit and code not in ok_codes:
                fail(f"target exit code {code} not in expected {ok_codes}")
        else:
            res["exit_code"] = None
            if not killed and not res["failed"]:
                fail("no supervisor report; target status unknown (fail-closed)")

        # ---- terminal-restoration assertion (inside-session snapshot) --------------
        if disconnected:
            res["terminal_restored"] = None
            res["termios_after"] = {"note": "terminal destroyed (disconnect case); restoration not observable through it"}
        elif killed:
            res["terminal_restored"] = None
            res["termios_after"] = (rep or {}).get("attrs_after")
        else:
            after = (rep or {}).get("attrs_after")
            res["termios_after"] = after
            if not after or "error" in after:
                fail("terminal state unobservable after target exit (no inside-session snapshot) — fail-closed")
                res["terminal_restored"] = None
            else:
                restored = same_terminal(res["termios_before"], after)
                res["terminal_restored"] = restored
                if require_restore and not restored:
                    b, a = res["termios_before"], after
                    fail(f"terminal not restored (before lflag={b.get('lflag')} cc={str(b.get('cc'))[:60]}; "
                         f"after lflag={a.get('lflag')} cc={str(a.get('cc'))[:60]})")
    except Exception:
        fail("driver exception: " + traceback.format_exc().splitlines()[-1])
        res["exception_trace"] = traceback.format_exc()
        try:
            if not peek_status():
                kill_group(pid)
                rescue_end = time.monotonic() + 8
                while not peek_status() and time.monotonic() < rescue_end:
                    pump(0.2)
                killed = True
            kill_group(pid)
        except Exception:
            pass
    finally:
        try:
            if not status_holder["known"]:
                peek_status()
        except Exception:
            pass
        # ---- forbid + require + VM ids + verdict -----------------------------------
        try:
            text = bytes(buf).decode("utf-8", "replace")
            for pat in case.get("forbid", []) or []:
                try:
                    if re.search(pat, text):
                        fail(f"forbidden pattern {pat!r} present in output")
                except re.error as e:
                    fail(f"invalid forbid pattern {pat!r}: {e}")
            for pat in case.get("require", []) or []:
                try:
                    if not re.search(pat, text):
                        fail(f"required end-state pattern {pat!r} absent from output")
                except re.error as e:
                    fail(f"invalid require pattern {pat!r}: {e}")
            res["vm_ids_seen"] = sorted(set(re.findall(r"vm-[0-9a-f]{8}", text)))
            res["tail"] = text[-1200:]
        except Exception:
            pass
        res["duration_s"] = round(time.monotonic() - t0, 2)
        res["output_bytes"] = len(buf)
        res["verdict"] = "PASS" if not res["failed"] else "FAIL"
        try:
            log.close()
        except Exception:
            pass
        try:
            os.close(slave)
        except OSError:
            pass
        if master_open:
            try:
                os.close(master)
            except OSError:
                pass
        try:
            os.close(rep_r)
        except OSError:
            pass
        try:
            os.close(ctl_w)
        except OSError:
            pass
        wrote = write_result()
        print(json.dumps({"name": name, "verdict": res["verdict"], "exit_code": res.get("exit_code"),
                          "terminal_restored": res.get("terminal_restored"),
                          "duration_s": res["duration_s"], "fail_reasons": res["fail_reasons"]}))
        sys.exit(0 if (not res["failed"] and wrote) else 1)

if __name__ == "__main__":
    main()
