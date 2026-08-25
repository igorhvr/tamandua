# MACP7: stale contained scripted state leaks across campaign attempts — mac W2 runs collide with yesterday's backlog

Mac tier1 at 550b4c50: the MACP6 shim fix WORKS (the scripted daemon log
shows stale runs from the PREVIOUS attempt now completing cleanly:
"pi launched ... pi completed exitCode 0 ... Work round complete" for
run e2589c60, a run id from the 2026-08-24 attempt). The four W2 cells
still PRODUCT_FAIL because each scenario's freshly-registered run never
reaches terminal state: the contained scripted state dir
(torture-test/var/home-scripted/.tamandua) PERSISTS across campaign
attempts, so the restarted scripted daemon recovers yesterday's orphaned
runs — and new registrations collide ("control-server: register-run
failed ... harness workdir is already set", seen for both ed17cd65 and
e2589c60 in the 2026-08-24 log) while the motor chews stale backlog.
Linux never showed this because cells always completed, leaving no
backlog. This is the scripted-state cousin of S21 (cross-attempt ledger
leak) and of CDSK (stale contained daemon).

1. **Scenario-level state hygiene.** Each scripted scenario cell (or at
   minimum each campaign) must start from a KNOWN-CLEAN contained
   scripted state: reset/provision var/home-scripted/.tamandua (DB,
   events, run bookkeeping) at scripted-daemon start in the scenario
   harness path — through the existing containment choke-points (the
   provisioning machinery already owns home-scripted creation; reuse it,
   do not ad-hoc rm). Decide and document the right granularity
   (per-cell reset is the safest against intra-campaign leakage from a
   crashed cell; per-campaign minimum). The daemon-control
   production-guard/provenance discipline must be preserved — reset only
   the CONTAINED scripted state, verified by path containment before any
   destructive operation (fail closed if the path is not under
   torture-test/var/).
2. **Registration collision must be loud.** A register-run failure
   ("harness workdir is already set" class) must surface in the scenario
   as a distinct, immediate failure (category like
   scripted-run-registration-failed with the daemon's error captured) —
   not a generic did-not-reach-terminal timeout burned minutes later.
3. **Root-cause note:** explain in your report why the linux proof
   batteries (many W2 campaign passes, incl. dual-path) never tripped
   this — and add the guard that would have caught it: a self-test that
   runs a W2 cell against a contained scripted state PRE-SEEDED with a
   stale incomplete run (synthetic fixture, history-independent) and
   asserts the cell still passes (hygiene works) with the stale run
   neither resumed nor colliding.

Prove on linux: that new red-then-green self-test; full battery green
from repo root; bare --tier1 GREEN on BOTH paths (normal +
TT_FORCE_NO_SYSTEMD=1), plus one run where the contained scripted state
is deliberately pre-polluted before the campaign (stale-run fixture) and
bare tier1 STILL goes GREEN. Document expected mac outcome.

## Hard constraints
- Files ONLY inside torture-test/. Zero tokens. Live daemon (33xx) and
  the REAL contained daemon state (var/home/.tamandua) untouched — this
  task is about home-scripted only. No concurrent runs expected;
  quiet-window discipline for campaign proofs. Preserve all fail-closed
  verifier/guard semantics.

## Resolution (US-001..US-006)

The leak was closed with five implementation stories plus the mechanical
guard that would have caught MACP7 before it reached the mac:

- **US-001** added a containment-verified `reset-state` operation to
  `torture-test/bin/daemon-control` (valid ONLY for kind=scripted; real
  refused). It resolves the state dir from the spawn env, re-asserts
  containment strictly inside torture-test/var before any destructive
  operation, refuses while the scripted daemon is RUNNING, and leaves an
  empty recreated state dir with the machine-parseable
  `STATUS: RESET_STATE_OK` marker.
- **US-002** wired a per-cell reset into the scenario harness
  (`torture-test/scenarios/lib/run-scripted-scenario`): tolerant stop ->
  `daemon-control scripted reset-state` -> workflow install -> daemon
  start. Granularity decision: per-cell reset at harness ENTRY only;
  mid-cell daemon restarts inside a scenario (w2.21 Step 4 / w2.23c Step
  5) intentionally do NOT reset so a run created mid-cell survives.
- **US-003** added the per-campaign minimum in tt-controller's
  scripted-only preflight (before the catalog install): ensure the
  scripted daemon is stopped, reset through daemon-control, fail closed
  with the distinct `scripted-state-reset-failed` category. A resumed
  campaign NEVER resets.
- **US-004** made the registration collision loud: the shared
  terminal-wait helper (`torture-test/scenarios/lib/terminal-wait.mjs`,
  `waitForTerminalRun`) fails IMMEDIATELY with the machine-parseable
  marker `SCRIPTED_RUN_REGISTRATION_FAILED: <daemon error>` when
  scheduling_status='error' — instead of a status-only poll spinning the
  full 120s budget on the collision class (the register-run failure is
  INVISIBLE to status-only waits: control-server sets
  scheduling_status='error' but leaves status 'running').
- **US-005** reclassified a scripted local-command failure carrying the
  register-run signature as TEST_INFRA_FAIL with the DISTINCT category
  `scripted-run-registration-failed` and the daemon's error captured.
- **US-006** (this guard): the red-then-green stale-state hygiene
  self-test `torture-test/self-tests/tier1-macp7-scripted-state-hygiene.test.ts`.

### ROOT-CAUSE NOTE (why linux proof batteries never tripped this)

Every linux W2 cell always ran to completion, leaving NO orphaned backlog
in the contained scripted state — a restarted daemon had nothing to
recover, so no registration ever collided. Only an INTERRUPTED campaign
attempt (the mac's first attempt, killed mid-run) leaves stale
status='running' runs for the next attempt's restarted daemon to recover.
A stale-incomplete-run fixture is therefore REQUIRED to reproduce the
class; a clean-state proof battery can never trip it. The guard (US-006)
pre-seeds a SYNTHETIC stale incomplete run (direct SQLite writes into the
contained scripted state: a runs row status='running'
scheduling_status='active' carrying the harness workdir = the repo root,
one steps row, and a run-scoped events jsonl — history-independent, no
real runs needed) and proves the cell still passes with the stale run
neither resumed nor colliding.

### Heavy-campaign self-tests (THREE lock-step lists)

A self-test under `torture-test/self-tests/` that drives REAL scripted
daemons / real `tt-controller` campaigns (fixed TT ports 5334/5338/5339,
zero tokens) belongs to the heavy-campaign class. It is EXCLUDED from the
bounded `self-tests/run.sh` battery (run.sh must complete in a bounded
window and never orphan a campaign on timeout) and executed individually
by `bin/verify-heavy-campaign-tests.test.sh`. Registering a new heavy
file requires touching **THREE lists in lock-step** or
`self-tests/e2e-golden-integrity.test.ts` AC5 fails:

1. `torture-test/self-tests/run.sh` -> `HEAVY_CAMPAIGN_TESTS` array
2. `torture-test/bin/verify-heavy-campaign-tests.test.sh` -> `HEAVY_TESTS`
3. `torture-test/self-tests/e2e-golden-integrity.test.ts` ->
   `HEAVY_CAMPAIGN_TESTS` const (AC5 also pins that the file exists and
   that run.sh filters heavy tests via `is_heavy`)

Quiet-window discipline (stop stray daemon + assert ports free
before/after), `TAMANDUA_TEST_GUARD=0` + dropping `NODE_TEST_CONTEXT` in
the campaign env, `TAMANDUA_PI_BINARY`/`TAMANDUA_HERMES_BINARY`
backstops to `/bin/false`, and a git-cleanliness snapshot before/after
each leg are the house pattern (mirror
`tier1-w2-darwin-capable-proof.test.ts`). The scenario harness's
`TT_SCENARIO_TEST_MODE=1` + `TT_SCENARIO_DAEMON_CONTROL` seam lets a test
inject a daemon-control shim (e.g. bypass `reset-state` to reproduce
stale state) while every other operation delegates to the real
daemon-control.
