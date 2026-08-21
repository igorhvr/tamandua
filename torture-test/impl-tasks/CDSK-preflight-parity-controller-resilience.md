# CDSK: contained-daemon skew killed campaign #8 twice — preflight parity guard + controller error resilience (S15+S16)

Campaign #8 was killed twice by the same skew class:

- Attempt 1 (campaign-20260820T190812598Z): the daemon-up preflight leg
  ("ensure-up") happily REUSED a contained daemon running a pre-WLST5
  dist; tt-controller (current tree) issued a SELECT with
  ceiling_expiry_count -> sqlite error text -> queryWorkflowStatus
  (tt-controller ~3592/3701) tried JSON.parse on "no such column..." ->
  uncaught SyntaxError in monitorWorkflowRun (~4514) -> whole controller
  process died mid-campaign (4/28 done).
- Attempt 2 (campaign-20260821T162148475Z): contained daemon restarted on
  current dist, but the DB itself was unmigrated (see WLST5.1, being
  fixed separately in a parallel product run) -> same crash at first
  status poll, 4/28 done, case W1.L3-python left phase=running with its
  20-min deadline silently 3.5h expired; run bcbd1c66 actually completed
  in the contained daemon (89,548 tokens) with nobody watching.

Three suite deliverables:

1. **S15 preflight build/schema parity guard.** daemon-up must not
   blindly reuse a running contained daemon: verify the running daemon
   matches the current tree (e.g. daemon reports build/version via its
   control API compared against the tree's dist, AND a cheap schema
   handshake: the SQL surface tt-controller depends on must be
   satisfiable — a probe query of the columns it will SELECT). On
   mismatch: restart the daemon (or fail closed with a precise category
   like tt-daemon-stale if restart is impossible) — never proceed stale.
2. **S16 controller error resilience.** queryWorkflowStatus must treat
   non-JSON / error output as a structured failure (bounded retries, then
   the CASE fails closed as TEST_INFRA_FAIL with the raw error captured
   as evidence) — an infrastructure error on one case must NEVER take
   down the whole campaign controller. Sweep tt-controller for other
   JSON.parse-on-subprocess-output sites and harden them the same way.
3. **Deadline enforcement.** A case whose attempt deadline_at expires
   must be terminally recorded (TEST_INFRA_FAIL category deadline-expired
   or the existing cap category) even when the monitor loop is degraded —
   attempt-2 left W1.L3-python phase=running 3.5h past its 16:46Z
   deadline. Make deadline sweeping independent of the per-run polling
   happy path.

Prove: red-then-green for each (stale daemon reused -> guard fires;
injected non-JSON status output -> case TEST_INFRA_FAIL + campaign
continues; expired deadline -> terminal outcome). Full self-test battery
green from repo root. Bare `./run-torture-test --tier1` GREEN in a quiet
window (53xx free; wait if busy).

## Hard constraints

- Files ONLY inside torture-test/. Zero tokens. Live daemon (33xx)
  untouched. A concurrent product run (WLST5.1) owns src/db.ts and
  tests/ — touch NOTHING outside torture-test/. The contained TT daemon
  (43xx) may be restarted by your tests via daemon-control only.
