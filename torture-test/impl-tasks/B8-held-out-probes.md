# Build the held-out acceptance probes + three-arm validation (O16 substrate)

Authoritative spec in this repo — READ first:
- `torture-test/tamandua-torture-test-spec/02-fixture-projects.md`
  (§probes — held-out storage, `probe.sh <workspace> <base-ref> <scratch>`
  interface, three-arm validation, revert-probes for bug tasks, the
  ls-remote secrecy sweep)
- `torture-test/tamandua-torture-test-spec/03-oracles.md` (O16 — the
  consumer: per-task mechanical acceptance, gating)
- The merged fixtures under `torture-test/fixtures-src/` (tt-python,
  tt-ts, plus whatever else has merged) — their `seeds/` dirs contain
  the per-bug known-good fix patches your validation arms need.

## Deliverables

1. `torture-test/probes/<fixture>/<task-id>/probe.sh` — one mechanical
   probe per seeded bug and per feature task currently defined in the
   merged fixtures (enumerate what exists; SEEDS.md files are the
   index). Interface per spec 02: exit 0 = task genuinely accomplished
   in the given workspace, nonzero otherwise; no network; no agent
   prose; runtime < 60s each.
2. **Three-arm validation harness**:
   `torture-test/probes/validate-all.sh` — for every probe: arm 1 (base
   with seed applied → probe MUST fail), arm 2 (known-good fix applied →
   MUST pass), arm 3 (trivial gaming attempt, e.g. test deleted or
   assertion inverted per spec → MUST fail). Builds its arms in scratch
   clones under `torture-test/var/probes/` from the golden bares. A
   probe failing validation is listed and the harness exits nonzero.
3. **Secrecy sweep**: `torture-test/probes/secrecy-sweep.sh` — asserts
   via `git ls-remote` + tree grep that NO fixture golden/clone contains
   any probe content or `probes/` reference (the probes live only here,
   outside every agent-reachable fixture repo).
4. Revert-probes for bug tasks where spec 02 mandates them.

## Hard constraints

- Files ONLY inside `torture-test/`; generated state ONLY under
  `torture-test/var/`.
- Probes must never be copied into fixture repos by any script you
  write; the sweep is the proof.
- Probe verdicts purely mechanical (run the suite, grep structured
  output, diff behavior) — never parse agent reports.

## Acceptance

- `validate-all.sh` green for every probe (all three arms correct),
  twice consecutively; `secrecy-sweep.sh` green; total validation
  wall time < 15 min.
