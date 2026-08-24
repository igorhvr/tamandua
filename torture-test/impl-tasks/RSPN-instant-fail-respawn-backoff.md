# RSPN: instant-fail worker rounds respawn forever — add classification, backoff, escalation (authorized product fix)

Evidence: campaign #8 attempt-3, W3.23-token-saver. A broken worker
binary died in ~3ms (exit 1, zero output) and the motor relaunched it
every ~15s, ~40 identical rounds, no backoff, no escalation, no run
failure — until an external wall cap killed the run. The same behavior
would follow ANY fast-fail condition in production (deleted/broken
harness binary — the pi-update incident hit exactly this — bad PATH,
revoked credential, full disk), where no external cap stands behind the
run. Existing machinery does not catch it: worker-loss accounting sees a
"clean" exit; clean-exit-without-STATUS abandonment (8/8 ceiling) never
triggers because no story round starts.

1. **Classification.** At round completion, classify an instant-fail
   round CONSERVATIVELY: wall time below a small threshold (default
   ~2s) AND zero output bytes AND nonzero exit code. Track consecutive
   instant-fails per run (reset on any non-instant-fail round).
   Thresholds configurable (env/config), defaults conservative —
   legitimate short rounds (idle checks, no-op verifies) must not
   match (they exit 0 and/or produce output).
2. **Backoff.** After K consecutive (default 3), apply escalating
   delay between relaunches instead of the fixed tick.
3. **Escalation.** After N consecutive (default 10), force-fail the run
   with a precise reason (e.g. "worker instant-fail loop: 10 consecutive
   sub-2s exit-1 rounds; last command: ...") through the existing
   force-fail path, and emit a distinct event so consumers can react.
4. **Surfacing.** While in an instant-fail loop (>= K), `tamandua
   workflow status <run>` and the runs list must show it (the DDTH
   pattern: make the pathology visible before it is fatal).
5. **Tests.** Unit: classification boundaries (fast+exit0, fast+output,
   slow+exit1 all NOT classified). Integration: a stub harness binary
   that instant-fails — assert backoff kicks in at K, force-fail at N
   with the precise reason, status surfacing present; replay thresholds
   from the W3.23 evidence shape. Keep WLST5's ceiling_expiry /
   harness_lost counters untouched (instant-fail is a third, distinct
   class — additive fields only).

## Hard constraints
- Product code only (src/, tests/). No torture-test/ changes. Do not
  restart or reconfigure the live daemon (33xx).
- A concurrent product run (FFRC) owns the force-fail teardown,
  terminal-event/cache, and resume-registration code — you may CALL the
  existing force-fail path but do not modify its teardown internals;
  your surface is the round scheduler/launch loop, round classification,
  and status display.
