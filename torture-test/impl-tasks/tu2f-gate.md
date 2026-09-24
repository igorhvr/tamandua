# TU2F — US-004 gate run (self-tests-alone, guard + false harnesses, held flock)

Run: run-c13d1de8-be66-40eb-80f3-f88e66b5083d
Story: US-004 — Gates: run the torture self-tests each alone (guard + false harness) under the held flock
Date: 2026-09-18 (VM clock)
Branch: feature/tu2f-torture-union-leftovers-nf6
Gate HEAD: 0d3649b3 feat: US-004 - Gates: run the torture self-tests each alone (guard + false harness) under the held flock

## Verdict

```
self-tests-alone: 14/14 required entries exited 0 (verdict PASS)
  npf2: 2/2 (gating) PASS
  aged: 4/4 (gating) PASS
  o12: 8/8 (gating) PASS
  qualification: 1/1 (informational) PASS
guard_safe_repo_root: true
```

- Retained summary (machine-readable, in the persistent run worktree):
  `torture-test/var/results/self-tests-alone-20260918T183855Z.SdwLBf/self-tests-alone-summary.json`
  (absolute: `/home/kaladin/.tamandua/worktrees/tamandua-origin-o12-0ded2d74/40-c13d1de8/torture-test/var/results/self-tests-alone-20260918T183855Z.SdwLBf/self-tests-alone-summary.json`)
- `validateSelfTestsAloneSummary(...)` → `{ ok: true }`; the focused
  `self-tests-alone.test.mjs` retained-run assertions PASS (5/5, the retained
  run is validated, not skipped).
- `by_group` totals match `EXPECTED_COUNTS` (`npf2:2, aged:4, o12:8, qualification:1`); every gating entry exited 0.
- `results.tsv`, every `*.stdout.log`/`*.stderr.log`, and the summary are retained under that
  results dir; nothing disposed. The owned-copy v10 seed snapshot is retained at
  `torture-test/var/seed-snapshot-v10.sqlite`.

## Retention fix (retry)

The first US-004 attempt ran the gate in a detached worktree whose results dir was disposed
between rounds. This retry passes `--results-base <run-worktree>/torture-test/var/results` to the
gate runner so the summary, `results.tsv` and per-entry logs are written DIRECTLY into the
persistent run worktree's gitignored `torture-test/var/results/` (they survive rounds). The
owned-copy v10 seed snapshot is likewise materialised at
`<run-worktree>/torture-test/var/seed-snapshot-v10.sqlite` before the gate. The gate still RUNS
from a guard-safe detached worktree outside the real-state prefix; only the retained evidence is
routed into the persistent worktree.

## Gate environment (as run)

- Detached gate worktree: `/opt/tu2f-gate-0d3649b3` (detached HEAD `0d3649b3`), provisioned via
  `git worktree add --detach`, `node_modules` symlinked to the run worktree, `npm run build`
  (fresh `dist/`). Outside the host real-state prefix (`/home/kaladin/.tamandua`) and the VM
  `os.userInfo().homedir` prefix (`/root/.tamandua`).
- Command: `flock --exclusive <lock> node torture-test/self-tests/run-self-tests-alone.mjs
  --results-base <run-worktree>/torture-test/var/results` (the NPF-2 gate runner: NPF-2
  positive+negative, aged, O12, qualification; each entry in its own process).
- Gate env per entry (frozen by the runner): `TAMANDUA_TEST_GUARD=1`,
  `TAMANDUA_PI_BINARY=TAMANDUA_HERMES_BINARY=TAMANDUA_DSH_BINARY=/usr/bin/false`, private
  `TMPDIR`, no ambient `TAMANDUA_*` authority, zero model tokens.

## Host-path visibility facts and substitutions (recorded for the contract)

1. **Gate lock** — host `/home/kaladin/matchlock-work/vaivm-gate.lock` is not visible in the VM.
   Substituted with the VM-local lock `/tmp/vaivm-gate.lock`; the gate ran under
   `flock --exclusive /tmp/vaivm-gate.lock`.
2. **jq** — the VM image ships no `jq`; `torture-test/bin/daemon-control`'s `cmd_stop` reads its
   provenance with bare `jq -r ...` under `set -euo pipefail`, so a daemon stop without `jq`
   exits 127 ("owned daemon stop must succeed"). Installed `jq` (apt, `/usr/bin/jq`) for the
   gate environment; this is an environment repair, not a source change.
3. **O12 seed snapshot** — the immutable host seed snapshot at
   `/opt/tamandua-storm-seed.Hn3vQ8kL/torture-test/var/results/storm-aged.2026-09-15T05-25-19-366Z.8f48ed54.nVrXyi`
   is not visible in the VM. `o12.test.mjs`'s schema-pin assertion needs a user_version-10
   snapshot with `runs.matchlock_policy`; `o12-seed-snapshot.test.mjs` instead SKIPS its
   real-oracle path when that host path is absent (and its real-oracle path is pinned to the
   host snapshot's exact `SEED_SNAPSHOT_SHA256`, so it is not reconstructible in the VM).
   Substitution: an owned-copy v10 seed snapshot
   (`<run-worktree>/torture-test/var/seed-snapshot-v10.sqlite`, built with the repo's own v10
   DDL) is pointed at `o12.test.mjs` via `TAMANDUA_O12_SEED_SNAPSHOT`.
4. **Runner pass-through** — the gate runner previously stripped every `TAMANDUA_*` key and
   re-added only the gate keys, so `TAMANDUA_O12_SEED_SNAPSHOT` (the documented owned-copy
   override on `o12.test.mjs`) could not reach the o12 group. This commit adds a targeted
   pass-through for `TAMANDUA_O12_SEED_SNAPSHOT` to the o12 group only, mirroring the existing
   `TAMANDUA_O12_PROBE_DIST` pass-through. It is an evidence-location override, not run/work
   authority.

## Per-entry results (retained summary)

| group | entry | exit | duration |
|-------|-------|------|----------|
| npf2 | npf2-positive (P0/P1) | 0 | 168299 ms |
| npf2 | npf2-negative (P2a/P2) | 0 | 198182 ms |
| aged | aged-core.test.mjs | 0 | 10787 ms |
| aged | origin-pins.test.mjs | 0 | 1187 ms |
| aged | o12-content-pin.test.mjs | 0 | 641 ms |
| aged | seed-root-copy.test.mjs | 0 | 266 ms |
| o12 | o12.test.mjs | 0 | 20662 ms |
| o12 | o12-schema-version.test.mjs | 0 | 928 ms |
| o12 | o12-seed-snapshot.test.mjs | 0 | 297 ms |
| o12 | o12-gate-self-tests.test.mjs | 0 | 318 ms |
| o12 | o12-reserved-key-probe.mjs | 0 | 751 ms |
| o12 | o12-run-number-probe.mjs | 0 | 1066 ms |
| o12 | o12-run-number-allocator-calibration.mjs | 0 | 74 ms |
| o12 | generate-o12-fixtures.mjs | 0 | 1253 ms |
| qualification | seed-readiness.test.mjs (informational) | 0 | 423 ms |

## Files changed (this story)

- `torture-test/self-tests/run-self-tests-alone.mjs` — `gateEnv` gains a `seedSnapshot`
  parameter and re-adds `TAMANDUA_O12_SEED_SNAPSHOT` for the o12 group only; call site passes
  `process.env.TAMANDUA_O12_SEED_SNAPSHOT` for o12 entries.
- `torture-test/impl-tasks/tu2f-gate.md` — this record.

No file outside `torture-test/` is modified.
