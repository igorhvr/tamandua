# STORM-I interim contention slice — operator recipe (US-003 / STORM-I US-003)

This document is the safe operator sequence for the interim W3/W4 contention
slice: how to verify the host and pinned tree, prepare the input manifest,
launch the **existing** `tt-controller` with the recorded argv, attach the
strictly read-only `tt-contention-slice sample` observer, summarize honestly,
and retain every report/log artifact.

Scope and ownership:

- The controller (`torture-test/bin/tt-controller`) owns its ordinary case
  lifecycle: campaign state, per-attempt run ids (including replacement
  attempts), capability/functional-harness classification, terminal outcomes
  (including `NOT_RUN`), provisioning, and chaos execution.
- The helper (`torture-test/bin/tt-contention-slice`) only **prepares data**
  (copies the four canonical case rows byte-identical into a controller input
  manifest + provenance) and **observes it** (read-only samples + an honest
  summary). It never launches, stops, resumes, restarts, kills, deletes, or
  repairs a campaign.
- The real slice **spends tokens** (pi/hermes/dsh model invocations and the
  contained real daemon). The implementation tests under
  `torture-test/self-tests/tier2-contention-slice-*.test.ts` spend none and are
  hermetic (no daemons, no fixed shared ports, no models).
- The full W5 orchestrator and the true two-round W5 campaign remain pending;
  this recipe only covers the interim shared-daemon W3/W4 slice. Its shared
  daemon contention is useful interim evidence but does NOT prove the
  single-origin W5 union contract, its eight-run simultaneity, queue
  admission, or two-round chaos.

---

## 0. Canonical interim roster (prepared automatically, never hand-copied)

`tt-contention-slice prepare` reads the CURRENT source catalogs and copies
these rows complete and byte-identical, in this order (mix of harnesses and
pressure kinds; every row's caps, predicates, task, context, oracles, and
chaos definition is preserved):

| # | Case id | Catalog | Harness | Workflow pressure |
|---|---------|---------|---------|-------------------|
| 1 | W3.03-bfmw-hermes-ts | `cases/tier1.jsonl` | hermes | bug-fix-merge-worktree |
| 2 | W4.06-colleague-rebase | `cases/tier2.jsonl` | pi | feature-dev-merge-worktree (scoped colleague) |
| 3 | W4.09-pi-kill-harness | `cases/tier2.jsonl` | pi | bug-fix-merge-worktree (worker-kill chaos) |
| 4 | W4.dsh-bfmw | `cases/tier2.jsonl` | dsh | bug-fix-merge-worktree (lifecycle/gate + chaos) |

The harness field of every manifest row stays visible, so the controller's
normal capability/functional-harness classification is never hidden: if a
harness is unavailable the case is classified (e.g. `NOT_RUN`), never
silently replaced or relaxed. **Four selected cases with one `NOT_RUN` is not
a four-executed-case result** — read the summary's per-case executed /
`NOT_RUN` / terminal counts, not just the number of selected ids.

---

## 1. Preflight: pinned build/catalog and functional harnesses

Run these on the exact host that will run the slice, from the target tree
(this checkout; never the origin checkout):

1. **Pinned tree.** In the worktree/checkout that owns the campaign:
   `git status --porcelain` empty and note `git rev-parse HEAD`. After
   `prepare`, compare this commit against the provenance `source.commit`
   recorded next to the manifest. A dirty tree at prepare time is recorded
   (`pinned_clean_candidate: false`) and must not be presented as a pinned
   clean candidate.
2. **Pinned build/catalog.** Confirm the installed tamandua build matches the
   bundled catalog: compare the build version with the installed catalog
   stamp at `~/.tamandua/workflows/.catalog-version.json` (the `tamandua
   doctor` STALENESS check reports a mismatch; the remedy is `tamandua update
   --force` when the operator decides the installed catalog is stale). Do not
   rebuild the origin checkout or refresh its catalog from a worker.
3. **Host readiness.** Run `torture-test/bin/tt-verify-environment --fast`
   (no `--spend`): it checks platform, ports, disk headroom, and toolchains
   without binding anything and without spending tokens. The contained
   campaign ports (4334/4338/4339, 5334/5338/5339) must be free or owned by
   this suite's campaign; production ports (3334/3338/3339) are reported only.
4. **Functional harnesses.** The four rows need hermes (W3.03), pi
   (W4.06, W4.09) and dsh (W4.dsh-bfmw) plus the tamandua install they
   invoke. The full harness-auth verification is the controller's real-case
   preflight `harness-auth` leg (and, when the operator accepts token spend,
   `tt-verify-environment --spend`). A non-functional harness is surfaced by
   the controller as a classified case outcome — it is never silently
   swapped for a different harness.

## 2. Host exclusivity

Make sure **no other contained campaign is using this host** before launch:

- No other `tt-controller` campaign is active: inspect
  `torture-test/var/results/` — a campaign directory whose `state.json`
  records `phase: "running"` cases means that campaign owns the host slot.
- No other contained real daemon is up on the suite's ports (the
  `tt-verify-environment --fast` port rows show this).
- Coordinate with other runs sharing the host. Never kill another run's
  processes or remove its scratch to free the slot; if the slot is busy,
  wait for the coordinator.

## 3. Prepare the input

From this checkout:

```bash
torture-test/bin/tt-contention-slice prepare
```

This reads the current catalogs, requires each selected id exactly once, and
writes a FRESH UNIQUE directory `torture-test/var/contention-slice-<ts>-<rand>/`
containing:

- `manifest.jsonl` — the four source rows, byte-identical, in roster order;
- `provenance.json` — selection ids/order, relative catalog paths and actual
  line numbers, catalog/row/task sha256 hashes, source commit and tracked-tree
  cleanliness, generated manifest sha256, the controller
  executable/cwd/argv, and the `--validate-only` result.

It prints the controller launch argv legibly and validates the generated
manifest through the real controller `--validate-only` (a manifest validation
failure returns non-zero and RETAINS the failure artifacts). It never
executes the campaign. Output is never written outside `torture-test/var`,
and a previous preparation/result directory is never overwritten or removed.

## 4. Launch the existing controller with the recorded argv

Do not extend the controller; run it with the recorded arguments exactly
(recorded in `provenance.json` → `controller.argv` / `controller.command`;
concurrency 4, stagger 10s):

```bash
cd torture-test
bin/tt-controller --manifest <var>/contention-slice-<ts>-<rand>/manifest.jsonl \
  --concurrency 4 --stagger 10s
```

The controller owns the case lifecycle from here: campaign state under
`torture-test/var/results/campaign-<ts>-<uuid>/` (`state.json` carries each
case's attempts with `run-<uuid>` ids and replacement attempts), the
contained campaign DB under `torture-test/var/home/.tamandua/tamandua.db`,
per-case outcomes (`PASS` / `PRODUCT_FAIL` / `AGENT_FLAKE` / … / `NOT_RUN`),
chaos, and terminal classification.

## 5. Attach the read-only observer

Once the campaign exists (state.json present and run ids being recorded),
start the observer in a second terminal. It is STRICTLY read-only: it opens
the campaign DB with `node:sqlite DatabaseSync({ readOnly: true })`, never
creates/migrates a DB, never binds or contacts a listener, never executes
workflow/control commands, and never stops/resumes/repairs the campaign.

```bash
torture-test/bin/tt-contention-slice sample \
  --prep <var>/contention-slice-<ts>-<rand> \
  --campaign <var>/results/campaign-<ts>-<uuid> \
  --db <var>/home/.tamandua/tamandua.db
```

Defaults: a sample every 15 seconds until the selected cases are terminal or
an explicit bounded window ends (`--window-ms <ms>`), writing
`samples.jsonl` + `observer.json` into a fresh unique
`torture-test/var/contention-observation-<ts>-<rand>/` directory. Start the
observer BEFORE the cases go terminal — an observer started after completion
cannot manufacture simultaneity proof. Every supplied path must be inside
`torture-test/var`; the observer never defaults to the operator's HOME. An
interruption (Ctrl-C) preserves the partial samples, records the
interruption, and exits non-zero without touching the campaign.

## 6. Summarize honestly

When the campaign's selected cases are terminal (or the observation window
ended), summarize the retained observation:

```bash
torture-test/bin/tt-contention-slice summarize \
  --prep <var>/contention-slice-<ts>-<rand> \
  --obs <var>/contention-observation-<ts>-<rand>
```

The report separates the CONFIGURED case concurrency (recorded controller
argv, `--concurrency 4`) from the OBSERVED claimed-step peak across the
samples (scoped to the recorded run ids only), reports per-case
executed/`NOT_RUN`/terminal counts and coverage gaps, and writes
`summary.json` + `summary.txt` INTO the observation directory. When the
observed peak is below three or the evidence is insufficient (late start,
gaps, corrupt/missing samples, UNKNOWN runs), the report says so explicitly
and contains no unqualified passed-storm claim.

## 7. Retain reports and logs

Keep the whole evidence chain — prep dir, observation dir, the controller
campaign dir under `var/results/`, and the controller/daemon/run logs — for
review and for the W5 milestone planning. All of it lives under
`torture-test/var/` (git-ignored); the tools never overwrite or delete a
previous preparation/observation/result, so retention is the default. Note
which cases executed, which were `NOT_RUN`, the observed peak, and the
coverage gaps in the campaign report. The real slice spends tokens; the
implementation tests do not. The full W5 orchestrator and the true two-round
campaign remain pending after this interim slice.
