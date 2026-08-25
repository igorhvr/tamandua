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
