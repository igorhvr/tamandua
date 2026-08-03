# Build the Tier-0 push gate: scripted scenario library + tier wiring

Phase E begins. Everything Tier-0 needs already exists as machinery:
controller (cases/schema/oracles hooks), 7-oracle battery, scripted
pi/hermes runtimes with fault knobs + install-scenario-workflows +
binding-proof (Phase D), daemon-control for the scripted daemon
(ports 53xx) and real TT daemon (43xx), fixtures + probes. What is
MISSING is the scenario content and the launcher wiring. Build it.

Authoritative spec — READ FIRST, these are binding:
- `torture-test/tamandua-torture-test-spec/README.md` §tiers (Tier-0
  contract: <=3h, <=2M tokens)
- `.../11-schedule-budget-abort.md` §Tier-0 per push: delivery-corridor
  scenarios W0.9/W4.49/W4.25 + the scripted verdict matrix + one real
  bfmw + one hermes do-now, headless, gates auto-evaluated
- `.../04-wave-0-preflight.md` (W0.9 install-shape fidelity)
- `.../08-wave-4-fault-injection.md` (W4.25 upgrade/downgrade/custom-
  workflow legs, W4.49 update-transaction failures; the scripted
  verdict matrix scenarios and injection discipline)
- `.../10-defect-traceability.md` (DC mappings these scenarios cover)
- `.../12-runner-automation.md` (runner/case contract)
- `torture-test/cases/case.schema.json` + `cases/smoke.jsonl` (format)
- `torture-test/oracles/CONTRACT.md` (which oracles gate which cases)

## Deliverables

1. **Scripted scenario library** under `torture-test/scenarios/`
   (new): for each Tier-0 scripted scenario (verdict matrix + W0.9 +
   W4.49 + W4.25 legs), a scenario dir with its behaviors file(s) for
   the scripted runtimes, any per-scenario workflow copies via
   `scripted-runtimes/install-scenario-workflows`, setup/teardown
   glue driven through `torture-test/bin/daemon-control` (SCRIPTED
   daemon, ports 53xx, home-scripted), and the oracle list per
   CONTRACT.md. Scenarios must be zero-token (O3z gates them) and
   leave no processes or dirty state behind (hermetic like FIX6/FIX7).
2. **Case manifest** `torture-test/cases/tier0.jsonl` — all scripted
   scenarios above PLUS the two real cases (one bfmw run on a fixture,
   one hermes do-now), with correct requires predicates, caps
   (aggregate within Tier-0's <=3h/<=2M), boundary_files, oracles,
   gates. Schema-valid (controller validates on load).
3. **Launcher wiring** in `torture-test/bin/tt-run`: flip
   `tier_available tier0` to real detection (controller + tier0.jsonl
   + scenario library present), route `--tier0` through tt-controller
   with the manifest, keep exit-code contract. Smoke stays as-is.
4. **Proof**: execute the SCRIPTED subset end-to-end on this machine
   (controller-run, zero tokens, oracles evaluated) and show the
   campaign report; validate (dry-run/manifest-validate, do NOT spend
   tokens) the two real cases. The full token-bearing Tier-0 dress
   rehearsal is a SEPARATE later step run by the operator — do not
   launch real pi/hermes work from this task.

## Hard constraints

- Files ONLY inside `torture-test/`.
- Zero tokens spent by anything you execute (scripted daemon only);
  never touch the live daemon (ports 33xx) — isolation per spec 01.
- Hermetic: `git status --porcelain` empty after your runs; no leaked
  processes (prove with pgrep sweep); scripted daemon stopped in
  teardown even on failure.
- Full `npm test` green before merge if you touched anything under
  src/ (you should not need to).

## Acceptance (verify before reporting done)

- `./run-torture-test --tier0` shows available in `--help`; running it
  executes the scripted subset green and cleanly reports the two real
  cases as pending-real (or executes them ONLY if the operator flag
  you document is set — default must not spend tokens) — pick the
  cleaner contract per spec 12 and document it in the report.
- Scripted subset: campaign report GREEN, all oracle verdicts PASS,
  zero tokens observed, twice consecutively.
- Leak/hygiene sweeps clean after both executions.
