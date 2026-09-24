# tt-storm-aged — zero-token aged-state generator (STORM-AGED / W5)

Torture-only implementation owned by the STORM-AGED run.  Produces the W5
"aged-state seeding" corpus (spec `09-wave-5-storm.md` → "Pre-storm arming
(Zero tokens)") with **real product APIs** — never raw SQL seeding, never a
copied alternative state machine — and zero model invocations / zero tokens.

## What this directory contains

```
aged/
  README.md               this file
  docs/STORM-AGED-CONTRACT.md   exact callable APIs / inputs / snapshot outputs
                                (integration target for run39's tt-storm engine)
  manifest.mjs            owned seed-root allocation, identity pinning,
                          phase receipts, resume/reconcile (refuses mismatches)
  env.mjs                 containment env builder (private HOME/state/db/tmp,
                          guard=1, random ports, stripped parent authority,
                          credential-free neutral pi config)
  product.mjs             pinned product-dist resolution (default /opt/tamandua/dist)
  transport.mjs           LABELED non-dispatching registration-transport double
                          + RealControlFacade (real product pause/resume handlers)
  catalog.mjs             pinned bundled-catalog install into the private state
  fixture.mjs             owned tiny origin (pilot) / supplied origin handshake (full)
  origin-pins.mjs         verify + pin a supplied tt-poly origin against its
                          build-golden hash ledger (tt-poly.git.hashes) and
                          emit the durable storm-origin-pins manifest (US-002);
                          `--build-owned <dir>` builds a fresh OWNED origin
                          from the current fixtures-src when the supplied
                          material is unusable (US-003 fixtures-src drift)
  seedlib.mjs             real-API run lifecycle drivers (runWorkflow, claim/complete/
                          failStep, stopWorkflow, forceFailRun) + reserved-key baseline
  volume.mjs              volume-only synthetic events (real emitEvent; no forgeries)
  census.mjs              read-only DB/event/worktree/ref census + receipts
  snapshot.mjs            immutable DB (VACUUM INTO, chmod 0444) / event / ref snapshots
                          + host-owned O12 reserved-key baseline sidecar
  preflight.mjs           recording-only effect-adapter safety gate + durable
                          PASS/negative-trial evidence battery
  validate.mjs            seed-validation routing (9 gating oracles + O12) + O12 runner
  plan.mjs                pure corpus plan builders (pilot/full; importable,
                          deterministic, self-tested)
  phases.mjs              phase entrypoints (catalog/seed/volume/census-snapshot/validate)
  self-test/aged-core.test.mjs   focused node --test gate (run ONE file at a time)
  self-test/origin-pins.test.mjs origin-pins verification + owned-rebuild gate (US-002/US-003)
bin/tt-storm-aged         CLI entrypoint (explicit operations; --help/inspect inert)
```

## Invocation

```
torture-test/bin/tt-storm-aged --help
<torture-test/bin/tt-storm-aged allocate [--kind full|pilot] [--recipe FILE]  # owned seed
                                # root + executed-generator identity pin (no phase)
torture-test/bin/tt-storm-aged preflight [--root ROOT]     # recording-only gate
torture-test/bin/tt-storm-aged preflight-evidence <seed-root>  # persist PASS +
                                # negative-trial gate receipts (zero-effects
                                # fingerprints) under <root>/evidence/preflight
torture-test/bin/tt-storm-aged pilot [--root ROOT]         # real-API pilot corpus
torture-test/bin/tt-storm-aged full --origin <repo> ...    # full 5000/500000/200 seed
torture-test/bin/tt-storm-aged resume <seed-root>          # idempotent resume
torture-test/bin/tt-storm-aged census|snapshot|validate <seed-root>
torture-test/bin/tt-storm-aged volume <seed-root> --count N
```

Default entrypoint never starts a daemon/model/campaign.  Aged-state creation
and validation are explicit operations scoped by an owned manifest; there is
no `--allow-unqualified` shortcut.

## Phase pipeline (per owned seed root under `torture-test/var/results/`)

1. **catalog** — installs the PINNED bundled catalog (all workflow ids) into
   the private state via the real `tamandua workflow install --all` and
   verifies per-id `workflow.yml` hashes.  The executed generator identity
   (HEAD + working-tree cleanliness fingerprint) is pinned at allocation,
   BEFORE any effect.  The allocation itself is an explicit, side-effect-free
   entrypoint: `tt-storm-aged allocate --kind full` creates the owned root and
   pins the executed source without running any phase, so the recording-only
   `preflight --root ROOT` + `preflight-evidence ROOT` safety battery can be
   exercised against the exact root a later `full --root ROOT` seeds into.
2. **seed** — binds the non-dispatching transport double + the real control
   facade on random ports, then creates every run through the REAL
   `runWorkflow` and drives the disposition through REAL lifecycle functions:
   completed (claim→complete→advancePipeline), canceled (real
   `stopWorkflow`), failed (real `forceFailRun` and/or the real `failStep`
   retry-budget exhaustion driver, which awaits each `failStep`, re-claims
   between retries and asserts REAL retry_count progression), paused (REAL
   control-server pause handler, nonterminal, resume-safe).  Worktree
   workflows create REAL managed worktrees (rows + directories + metadata).
   Every run gets a host-owned reserved-key baseline record at creation.
   Entry dispositions are INTENT; the actual terminalization of every run
   (including any genuine force-fail fallback) is recorded in the per-run seed
   receipts and reconciled in the manifest/contract (see the retained root's
   `evidence/disposition-reconciliation.json`).
3. **volume** — volume-only synthetic events through the real `emitEvent`
   (explicit `aged.volume.seed`, non-lifecycle, unique per-run sequences).
4. **census-snapshot** — read-only census receipts, immutable DB snapshot,
   byte-exact event copies, git ref snapshots, O12 reserved-key sidecar
   (complete typed v2, written READ-ONLY 0o400 — the corrected O12 R4 fails
   closed on a writable baseline).  The host-mutation ledger is derived from
   the independently RECORDED native step operations (completed step outputs
   submitted through real completeStep, in pipeline order) and the product's
   known TEST_CMD normalization semantics, then verified against the final
   snapshot — NEVER granted from a bare final-context diff (an unexplained
   final difference stays an O12 overwrite).  A prior sidecar is archived to
   `o12-reserved-baseline.pre-<ts>.json` before a corrected one is written.
5. **validate** — seed-validation routing matrix over the corpus + real O12
   run over the snapshot under the accepted schema-9..13 O12 **content pin**
   `O12_PINNED_CONTENT_SHA256 = d50275466dcb…` (see `validate.mjs`); the pin is
   a SHA-256 over the O12 oracle CONTENT set (`torture-test/oracles/{O12,
   lib/o12.mjs, O12-CONTRACT.md, self-test/*}`), not a commit, so it survives
   merge-worktree squashes — a squash rewrites commit hashes but not the oracle
   bytes.  The provenance commit `7fe9f258…` (the run's base HEAD — never a
   pre-squash story commit) is recorded as provenance only (never resolved or
   compared as the pin; on the schema-13 TORTURE-PORT product it is declared
   `O12_PINNED_PROVENANCE_LEGACY` because it lives on the pre-port
   integration/o12-repin branch and is not an ancestor of HEAD);
   `materializePinnedOracle` materializes from
   HEAD and fails closed on content drift.  The pinned content covers
   `user_version 9, 10, 11, 12 and 13` (supported set `{9, 10, 11, 12, 13}`,
   fail-closed on unknown versions; v12 is dual-lineage main/matchlock and v13
   carries `runs.matchlock_policy`) and its acceptance status is stated
   explicitly in the report (`ROOT_ACCEPTED`; acceptance evidence under
   `torture-test/var/results/o12-owned-store-acceptance-*` and
   `o12-schema13-us0*`).  O1/O4 suite legs mirror the REAL oracle
   semantics (nonterminal steps judged on COMPLETED runs only; claim/dispatch
   evidence only — unclaimed waiting steps on failed/canceled runs are native
   leftovers, never corruption/dangling claims) and O3z is routed
   NOT_RUN/NOT_EVALUABLE (real-run tripwire mechanism inapplicable to a
   synthetic zero-token corpus — zero-token receipts stay attached as
   evidence, not as an O3z PASS).  Every matrix row carries
   `execution_kind`/`full_oracle_status` so custom seed-slice checks are never
   mistaken for full oracle execution.  Prior O12 runs under the superseded /
   prior pins (`eb953ca52e53…` — the run45 close head, schema-9-only and
   NOT_ROOT_ACCEPTED — and `62699fa25aec…`, `e8f912398b46…`) are preserved and
   labeled provisional, never rewritten.
 6. **re-validate on an owned copy (O12-REPIN US-006)** —
    `node torture-test/aged/seed-root-copy.mjs` builds an owned seed-root copy
    under `torture-test/var/results/` from the retained read-only root,
    rewrites ONLY the manifest ownership + snapshot/receipt references, and
    runs the real validate phase over it.  The live `getDb()` connection must
    live OUTSIDE the real-state prefix (`~/.tamandua`): the product isolation
    guard refuses a state path under it, and this worktree is itself under
    `~/.tamandua/worktrees/...`.  The helper therefore materializes a
    guard-safe DB copy in an owned directory outside that prefix while the
    seed-root copy (manifest, immutable snapshot + sidecar, event streams,
    census receipt) stays under `torture-test/var/results/`.  It retains the
    fresh `seed-validation-report.json`, a derived
    `seed-validation-classification.json`, and
    `o12-repin-seed-root-summary.json` under the copy's `evidence/` tree, and
    never writes into `/opt`.

Every effect is preceded by a durable journal/receipt entry; the manifest
records source/catalog/origin identities and refuses re-pinning on mismatch.
Partial seeds are retained and unqualified.

## Zero-token boundary

- The transport double answers only health/register/terminate/nudge with 2xx
  receipts and performs NO scheduling/admission/dispatch/harness probe; it
  fails closed (501) on pause/resume/suite endpoints (real transitions go
  through the real product control-server handler or real lifecycle
  functions).  The double is a transport stub — not a claim of motor
  qualification (CORE-MOTOR separately owns that).
- No provider/auth configuration is copied; `TAMANDUA_TEST_GUARD=1` is set in
  every phase; parent run/reporting authority is stripped; random listener
  ports only.
- `TAMANDUA_MAX_ACTIVE_TIMERS=0` is intentionally unused (source maps it to
  the default of 50 — it is not a disable switch).

## Honest status

A pilot that genuinely passes structural/safety checks is the gate before
full scale.  The full 5000-run / ≥500000-logical-event / 200-worktree corpus
requires a supplied owned/pinned tt-poly origin (storm assembly ownership)
and the full catalog/story-loop driver — see
`docs/STORM-AGED-CONTRACT.md` and `/root/matchlock-work/storm-aged-contract.json`.
