# Author the Tier-1 campaign: wave 1-3 case manifests + tier1 launcher wiring

The Tier-0 push gate is GREEN and every piece of machinery it needed is
proven: controller (launch/harvest/oracles/resume/report), 7-oracle
battery, fixtures + golden builders + held-out probes, scripted
runtimes, chaos operator, recorder. Tier-1 is the first REAL-run
campaign tier: ~40 token-bearing workflow runs against the fixtures.
Your job is to author its case manifests and wiring — NOT to execute
the campaign (that is an operator-triggered dress rehearsal later).

Authoritative spec — READ FIRST, binding:
- `torture-test/tamandua-torture-test-spec/README.md` §tiers (Tier-1:
  ~40 runs, ~15M tokens, ~24-30h, fixtures tt-ts/tt-python/
  tt-poly-lite)
- `.../05-wave-1-language-smoke.md` (wave 1 roster)
- `.../06-wave-2-workflow-coverage.md` (wave 2 roster; workflow x
  fixture matrix, verify_each legs, do-now legs)
- `.../07-wave-3-harness-duel.md` (wave 3: pi-vs-hermes A/B legs that
  fall within Tier-1's capability profile; hermes cases carry
  requires predicates)
- `.../03-oracles.md` + `torture-test/oracles/CONTRACT.md` (which
  oracles gate real runs: O1 O2 O4 O8 O9 O10 O11 + O16 held-out
  probes on fixer/feature cases; O17 on concession landings)
- `.../11-schedule-budget-abort.md` (per-case caps, tier budget
  ledger, abort ladder)
- `.../12-runner-automation.md` (case contract; real-run launch shape)
- `torture-test/cases/case.schema.json`, `cases/tier0.jsonl` (format
  reference — note how T0.real-* cases express real runs, harness,
  fixture, boundary_files, probes)

## Deliverables

1. `torture-test/cases/tier1.jsonl` — the full Tier-1 roster per spec
   waves 1-3 within the Tier-1 fixture set, each case with: workflow,
   fixture+seed ref, harness, task file reference (see 2), caps
   (tokens + wall per spec 11), requires predicates (hermes/java etc.),
   boundary_files, forbidden paths, oracles incl. the specific held-out
   probe ids (O16) for seeded-defect cases, gates, shed_ok/mandatory
   flags per spec 11's shed ladder.
2. `torture-test/cases/tasks/` — the per-case task prompt files the
   runs will receive (the text given to tamandua workflow run for each
   case), faithful to the spec's scenario descriptions: fix-bug tasks
   reference the seeded defect SYMPTOM (never the probe or fix),
   feature tasks state acceptance criteria from FIXTURE.md backlogs,
   scope-bait cases include the bait wording the spec mandates.
3. Manifest validation wiring: `tier_available tier1` flips when
   tier1.jsonl + tasks exist and validate; `--tier1` routes through
   tt-controller with the SAME pending-real/--include-real contract as
   tier0 (default: validate + report pending-real without spending
   tokens; --include-real executes). Countdown/estimate text stays
   accurate.
4. Proof (zero tokens): controller manifest-validation pass over
   tier1.jsonl (all cases schema-valid, task files resolve, probes
   referenced exist, predicates evaluate against host-profile),
   `./run-torture-test --tier1` (default, no --include-real) completes
   with a report listing every case as pending-real / NOT_RUN
   (predicate) correctly, twice consecutively. Hygiene sweeps clean.

## Hard constraints

- Files ONLY inside `torture-test/`.
- ZERO tokens spent: never launch a real workflow run; never touch the
  live daemon (33xx).
- Case counts and rosters must be traceable to the spec: include a
  `spec_ref` field per case pointing at the wave doc section, and note
  any spec scenario you had to exclude from Tier-1 (with reason) in
  your report — no silent scope trims.
