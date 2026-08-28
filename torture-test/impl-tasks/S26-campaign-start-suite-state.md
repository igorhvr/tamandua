# US-004: Guarantee campaign-start suite state — contained REAL daemon preflight fails closed on non-empty suite_results

S26 story US-004: tt-controller's real-daemon preflight (daemon-up path —
`runRealPreflight`'s daemon-up leg, `tt-daemon-up ensure-up`) must verify, at
FRESH campaign start, that the contained REAL daemon's `suite_results` table
is empty, failing closed with a precise machine-parseable STATUS line
(`REASON:` + `DETAILS` telling the operator how to reset), so attempt-1's
cross-campaign contamination (a contained-real-daemon DB carrying 106 rows
since 08-13 poisoned O10 AND O9) becomes impossible.

## Design decision: refuse + documented operator reset seam (fail closed)

The chosen design is **refuse + documented operator reset seam** — NOT an
automatic destructive reset. Rationale and safety argument:

1. **The real contained daemon deliberately has NO `reset-state`** (MACP7's
   asymmetry: `daemon-control reset-state` is scripted-only, refused for
   kind=real — `cmd_reset_state` guard 1, daemon-control). We do **NOT**
   weaken that asymmetry: a non-empty real `suite_results` ledger is prior
   REAL evidence (real test executions from an earlier campaign). Silently
   wiping it (or reusing it) would destroy/misattribute real evidence; the
   S13/S26 doctrine is that foreign/stale state is annotated and skipped at
   the oracle layer, and campaign-start hygiene is a refusal, never a
   surprise deletion. The scripted daemon's reset-state exists because the
   scripted state carries zero-token synthetic runs that are always safe to
   discard — the real contained state does not share that property.
2. **A restart cannot heal a dirty ledger.** The `suite_results` rows live in
   the persisted DB (`<TAMANDUA_STATE_DIR>/tamandua.db`); restarting the
   daemon leaves them in place, so the suite-state check runs AFTER all
   parity checks (build version, schema handshake, adapters-bin) and a
   failure is a hard refusal — no restart attempt, no `TT_DAEMON: up`.
3. **The operator reset seam is safe and documented:** (1) stop the contained
   daemon (`torture-test/bin/tt-daemon-up stop` — idempotent, provenance-
   scoped to this worktree); (2) remove the contained real state dir under
   `torture-test/var` (`<TAMANDUA_STATE_DIR>`, e.g. `rm -rf` the state dir —
   the operator's `~/.tamandua` and the 33xx daemon are never touched);
   (3) re-run — the next campaign's home-provision leg re-provisions the
   home and the daemon start (`daemon-control real start` mkdirs the state
   dir) recreates a fresh, migrated DB with an empty ledger. Stopping first
   is mandatory: the state dir must never be removed out from under a live
   daemon (the same fail-closed rule daemon-control's reset-state guard 3
   enforces for the scripted state).
4. **Gating (fresh-vs-resume).** Only the FRESH-campaign path threads the
   gate: `tt-controller startCampaign` calls `runRealPreflight(..., fresh =
   true)` → daemon-up leg `['ensure-up', '--fresh']`; `resumeCampaign` calls
   `runRealPreflight(..., fresh = false)` → daemon-up leg `['ensure-up']`
   (plain). A resume reconciles the persisted state from the previous attempt
   and must NOT require an empty suite — MACP7's per-campaign minimum
   (`resumeCampaign` never resets). `realPreflightRequired` gating is
   unchanged: scripted-only selections and `TT_DRY_RUN_REAL_LAUNCH` dry runs
   never engage the real preflight at all.
5. **Containment.** Every probe runs under the contained spawn env
   (`env/tt-env.sh`: HOME = `torture-test/var/home`, ports 4334/4338/4339);
   the probe's containment guard rejects any DB path outside
   `torture-test/var` before the DB is opened. The operator's live 33xx
   daemon and `~/.tamandua` are never touched.

## Implementation

- **New probe `torture-test/bin/tt-suite-probe.mjs`** — mirrors the
  `tt-schema-probe.mjs` seam: read-only `node:sqlite DatabaseSync(
  { readOnly: true })`, `TT_DAEMON_SUITE_PROBE_DB` test override, DB path
  default `${TAMANDUA_STATE_DIR}/tamandua.db` from the contained env, strict
  `torture-test/var` containment. Counts `suite_results` rows and prints:
  - `SUITE: ok` + `SUITE_ROWS: 0` (exit 0) — clean;
  - `SUITE: fail` + `REASON: suite-state-not-clean` + `SUITE_ROWS: N` +
    `DETAILS` (operator reset seam) (exit 1) — non-empty;
  - `SUITE: fail` + `REASON: containment-violation` (exit 2) — outside var;
  - `SUITE: fail` + `DETAILS` (exit 1) — unverifiable DB (unopenable,
    missing table — fail closed, never a silent pass).
- **`tt-daemon-up ensure-up --fresh`** — new flag. After every existing
  invariant (build-version parity, schema-handshake parity, adapters-bin
  PATH prepend) passes — on both the started path and the already-up no-op
  path — `verify_suite_state` runs the probe; a non-empty count fails closed
  with `REASON: suite-state-not-clean` on stderr, a `DETAILS` line carrying
  the operator reset seam, exit non-zero, and never a `TT_DAEMON: up` line.
  Plain `ensure-up` (no `--fresh`) is unchanged — the resume path.
- **`tt-controller` fresh-vs-resume threading** — `runRealPreflight(campaignDir,
  state, manifest, fresh)`; `startCampaign` passes `true` (→ `ensure-up
  --fresh`), `resumeCampaign` passes `false` (→ `ensure-up`). Usage text
  documents the gate.

## Tests (all zero-token, contained)

- `tt-daemon-up.test.sh` (AC10–AC14): probe unit arms (empty → ok; non-empty
  → `suite-state-not-clean` + `SUITE_ROWS`; containment → exit 2; read-only
  sha256 + no side files); `ensure-up --fresh` red arm over an already-up
  daemon (fail-closed, exact REASON, operator guidance, daemon NOT restarted
  — a dirty ledger is not healed by a restart); green arm (empty → idempotent
  no-op); resume arm (plain `ensure-up` with non-empty → no-op); down-daemon
  path (start-then-probe fails closed).
- `tt-controller-preflight.test.sh`: fresh campaign threads `ensure-up
  --fresh` (stub log assertion), resume threads plain `ensure-up` (no
  `--fresh`), and a REAL red-arm seeds the contained real DB with a
  `suite_results` row (backed up + restored) and pins the campaign aborting
  with `reason: "suite-state-not-clean"` on the preflight state (leg
  daemon-up) plus daemon teardown.
- Existing arms (AC1–AC9, schema legs, MACP7 scripted wiring) unchanged and
  green; the pi-manifest and idempotence suites' `ensure-up` prefix matches
  still pass (the `--fresh` suffix is additive).

## Safety checklist

- Files changed ONLY under `torture-test/` (probe, daemon-up, controller,
  two .sh self-tests, final-acceptance allowlist, this doc).
- Zero tokens; attempt-1/-2 evidence untouched; live 33xx daemon never
  touched; every probe runs under the contained spawn env.
- No `daemon-control real reset-state` was added — the scripted-only
  asymmetry is preserved and this doc explains why weakening it would be
  unsafe (real suite rows are real evidence; refusal is the safe direction).
