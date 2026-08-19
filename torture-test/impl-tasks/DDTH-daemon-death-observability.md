# DDTH: silent daemon deaths are invisible — add lifecycle observability (product fix, authorized)

Two SIGKILL-class silent daemon deaths were observed (2026-08-08 and
2026-08-12): tamandua.log stops mid-operation with no stack trace (despite
stderr→log wiring) and no shutdown lifecycle entry of any kind. Recovery on
restart was flawless both times, but the deaths were only detected by an
external port monitor. The daemon has no way to tell an operator "I died
uncleanly at T, here is what I know".

Deliverables (product code, src/):

1. **Durable lifecycle journal entries.** On startup: a `daemon.start`
   entry (pid, version, config fingerprint). On every catchable
   termination path (SIGTERM, SIGINT, fatal error, clean exit): a
   `daemon.shutdown` entry with reason/signal. Use the existing
   lifecycle.log / event vocabulary conventions — extend, don't fork.
2. **Unclean-death detection.** SIGKILL can't be caught, so detect it
   after the fact: maintain a small heartbeat marker (pidfile + periodic
   timestamp, or equivalent) that a clean shutdown removes/finalizes. On
   next startup, if the marker shows a prior instance that never wrote
   `daemon.shutdown`, emit a `daemon.uncleanExit` entry carrying the
   prior pid, its start time, and the last-heartbeat age — so the outage
   window is bounded from the journal alone.
3. **Surfacing.** `tamandua status` (and the dashboard if it has a
   natural slot) must show the most recent daemon death (clean or
   unclean) with its timestamp. An unclean death that has not been seen
   before should be visually distinct.
4. **Tests.** Unit tests for the marker lifecycle; an integration test
   that SIGKILLs a test daemon instance and proves the next startup
   journals `daemon.uncleanExit` with correct prior-instance facts.
   Heartbeat interval must be configurable/short in tests.

## Hard constraints

- PARKED-MERGE DISCIPLINE: a torture campaign is running against the
  production install. Your merge target is the staging branch this run
  was launched against (NOT main) — never push, merge, or otherwise
  mutate main or the installed catalog during this run.
- Do not restart, signal, or reconfigure the LIVE daemon (33xx) — all
  daemon-death testing happens against throwaway test instances on
  ephemeral ports.
- Keep the heartbeat cheap: no busy polling, interval >= 10s in
  production defaults, and writes must be tiny (single small file).
