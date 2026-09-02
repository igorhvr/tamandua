# MDUP: tt-daemon-up cannot verify a running contained real daemon on darwin (GNU `timeout` + `localhost` probe); tt-recorder port evidence is procfs-only

Authorized scope: igorhvr's mac-torture directive (2026-09-01) — obvious mac-vs-linux differences, fix via mac
runs, bring back to linux. Suite files ONLY (torture-test/).

## Evidence (mac, 2026-09-02 08:00Z, ~/mac-torture-logs/v2/s2-REAL_DAEMON_FRESH.log)
- `tt-daemon-up ensure-up --fresh` → "real TT daemon not verified up (status 'STATUS: RUNNING') — starting via
  daemon-control real ... rc=0" → 40 s later `REASON: tt-daemon-down`. Yet `daemon-control real status` = RUNNING
  with ports 4334/4338/4339 LISTENING, provenance written, `/control/health` answers
  `{"status":"ok","pid":42960,"buildVersion":"20260902T073943Z_ef15c1a6..."}` == dist/version. The daemon is fine;
  the VERIFIER is wrong on darwin. Reproducible: plain `ensure-up` gives the same false negative.
- Cause: `torture-test/bin/tt-daemon-up` `is_port_listening()` = `timeout 1 bash -c "echo >/dev/tcp/localhost/$port"`.
  (a) `timeout(1)` is GNU coreutils — absent on stock macOS (command not found ⇒ non-zero ⇒ "not listening");
  (b) `localhost` may resolve to ::1 on darwin while the daemon binds 127.0.0.1. `wait_for_daemon_up` requires
  `dc_status == RUNNING && is_port_listening`, so the second conjunct can never be true ⇒ every real-case
  preflight fails closed on darwin (tt-controller calls tt-daemon-up in preflight ⇒ NO real campaign can start).
  daemon-control already has a portable node-based `port_probe` (MACP4 US-001); tt-daemon-up kept its own probe.
  The procfs lint covers tt-daemon-up, the GNU-ism lint does not cover this `timeout` use.
- Also on the stage-2 path: `torture-test/bin/tt-recorder` port evidence reads /proc/net/tcp + /proc/<pid>/fd
  (linux-only) — verify `tt-recorder start --interval 30` on darwin and make its evidence portable (lsof arm),
  or degrade to an explicit, logged "port evidence unavailable on this platform" without failing.

## Fix (suite)
1. tt-daemon-up: replace `is_port_listening`/`ports_free` with the SAME portable probe daemon-control uses
   (node-based connect to 127.0.0.1:<port>, bounded timeout in-process; no `timeout(1)`, no `localhost`).
   Prefer sharing one helper (e.g. torture-test/lib/port-probe.sh sourced by both) over a copy.
2. Sweep tt-daemon-up, tt-controller's real-case preflight path, tt-recorder, tt-provision-home,
   tt-harness-auth-probe for remaining GNU/linux-isms that the existing lints miss (`timeout`, `ss`, `/dev/tcp/localhost`,
   `stat -c`, `date -d`, `readlink -f`, `setsid`) and either port them or add them to the GNU-ism lint's banned list
   with the darwin-capable alternative; extend tier0-gnu-portability-lint to cover `timeout` in bin/*.
3. tt-recorder: darwin-capable port/fd evidence (lsof) or explicit logged degradation; never fail the recorder
   start on a /proc-less host.
4. Red-arm self-tests (linux-runnable): fake `timeout`-less PATH → old probe fails, new probe passes against a
   listening 127.0.0.1 socket; ::1-only listener is NOT reported as listening on 127.0.0.1 (probe is address-exact).

## Prove
- On this host (darwin): `./torture-test/bin/tt-daemon-up ensure-up --fresh` → `TT_DAEMON: up` (fresh contained
  real daemon verified on 4339, build parity + schema handshake + empty suite ledger legs all pass);
  `./torture-test/bin/tt-recorder start --interval 30` OK; `./torture-test/bin/tt-daemon-up stop` clean.
- GNU-ism lint red-arm + green; full self-test battery from repo root (name pre-existing darwin-only failures
  explicitly; do not hide them).

## Story shape (mandatory — one gate per story; each proof story fits one worker round)

## Constraints
Files ONLY inside torture-test/. Never touch the live daemon (33xx) or the operator's real HOME. Kill only pids you
spawned (never by name/pattern) — the contained real daemon may be stopped only via daemon-control real stop.
