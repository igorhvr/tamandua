# MACP5: real-Darwin W2 run exposed three defects — fallback spawn records a dead wrapper pid; /proc uuid; BSD sed

Mac validation at 3b7922d5 (campaign on the mac, newest tier1 dir): with
the regenerated host profile the four W2 cells EXECUTED on Darwin for the
first time — and all four PRODUCT_FAILed. Evidence
(evidence/W2.21-admission/attempt-1/command.stderr, same on all four):

1. **FATAL — fallback daemon pid is a dead wrapper.** daemon-control's
   plain-background (no-systemd) spawn started the daemon fine (ports
   5334/5338/5339 LISTENING) but recorded "daemon PID 88430" whose
   process is NOT alive afterwards ("pid alive: false, cmdline verified:
   false, ports active: true" -> "scripted daemon did not report
   RUNNING: STATUS: UNKNOWN" -> scenario aborts). On Darwin the
   nohup/background chain double-forks, so the recorded pid is a wrapper
   that exits while the real daemon lives. The status verifier failing
   closed is CORRECT — fix the recording, not the verifier: provenance
   must carry the REAL daemon pid on both paths. Robust approach: have
   the spawned daemon's own pidfile (it writes one — the state dir's
   tamandua.pid) be the authority the fallback start waits on and
   records, with identity verification (the E3.C.1/MACP4 identity tools)
   against that pid before writing provenance; or use a spawn mechanism
   that returns the final pid (node detached spawn already used in
   session-leader-spawn.mjs — reuse it for the daemon launch). Either
   way: identity-verify before recording; fail closed if unverifiable.
   Must remain correct on linux fallback AND systemd paths (regression:
   TT_FORCE_NO_SYSTEMD bare tier1 stays GREEN on linux).
2. **run-scripted-scenario line ~306 reads /proc/sys/kernel/random/uuid**
   ("No such file or directory" on Darwin) — a site both MACP3's sweep
   and MACP4 missed. Replace with the portable UUID helper MACP4 already
   introduced. Then re-run the procfs portability lint and figure out WHY
   it missed this site — extend the lint (G-gates) so /proc literals in
   scenarios/lib are caught; red-then-green the lint fix.
3. **BSD sed incompatibility**: "sed: 1: ... command i expects \ followed
   by text" — GNU-only `i` syntax in the scenario path. Fix portably
   (POSIX sed or a node/bash replacement), then sweep the scripted
   scenario path (scenarios/, env/, bin/ scripts reachable from
   run-scripted-scenario) for other GNU-isms: sed -i / sed i\ / grep -P /
   readlink -f / date %N / timeout / setsid (the last three were fixed by
   MACP4 — verify no stragglers). Add whatever lint arm makes this class
   mechanical (the bash32-compat lint is precedent).

Prove on linux: TT_FORCE_NO_SYSTEMD=1 bare ./run-torture-test --tier1
GREEN (fallback path with the new pid recording), normal bare --tier1
GREEN, full self-test battery green from repo root, lint red-then-green
for the /proc and GNU-ism arms. Document the expected mac outcome (the
operator re-runs bare tier1 on Darwin expecting GREEN with 4 executed
cells).

## Hard constraints
- Files ONLY inside torture-test/. Zero tokens. Live daemon (33xx)
  untouched. No concurrent runs expected; quiet-window discipline for
  campaign proofs. Do not weaken the status verifier's fail-closed
  behavior, the vacuity guard, or predicate semantics.
