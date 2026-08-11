# Scripted Tier-0 scenario harness

Every workflow-backed scripted scenario is a directory containing:

- `scenario.json` — metadata validated before any daemon operation.
- A JSON behavior template named by `behaviors`.
- An executable scenario command named by `command`.

Run one scenario with:

```text
torture-test/scenarios/lib/run-scripted-scenario torture-test/scenarios/<wave>/<scenario>
```

## Tier-0 operator contract

`./run-torture-test --tier0` is the safe default push gate. It runs only the
scripted/local records, spends zero tokens, and retains the campaign state,
text/JSON reports, oracle verdicts, and snapshot evidence beneath
`torture-test/var/results/`. The report lists exactly two token-bearing records
as `NOT_RUN` with reason `pending-real`; neither pi nor Hermes is launched.

Validate all 35 records, including both pending real records, without creating a
campaign or launching work:

```text
torture-test/bin/tt-controller --manifest torture-test/cases/tier0.jsonl --validate-only
```

The separate `./run-torture-test --tier0 --include-real` operator opt-in launches
the pi bfmw and Hermes do-now canaries and spends real tokens. Use it only for an
explicitly approved dress rehearsal. The default command is the repeatable,
headless, zero-token acceptance path and must leave the scripted daemon stopped,
ports 5334/5338/5339 free, and transient scenario state removed.

## Metadata contract

`scenario.json` has exactly these required fields:

```json
{
  "schema_version": 1,
  "id": "w4.35-done-rebased-green",
  "workflow_base": "bug-fix-merge-worktree",
  "behaviors": "behaviors.json",
  "command": "run.sh",
  "expected_outcome": "completed",
  "oracles": ["O1", "O2", "O3z", "O8", "O9", "O10", "O11"]
}
```

`expected_outcome` is one of `completed`, `failed`, `canceled`, or `not_run`.
Every oracle must name an executable in `torture-test/oracles/`, and scripted
scenarios must include `O3z`. The workflow base must exist in the bundled
`workflows/` catalog. Relative paths may not escape the scenario directory.

W4.35 matrix cells additionally declare `workflow_id` (the static
`<workflow_base>-<scenario-id>` prefix), `task`, `matrix`, `expected_route`,
and `oracle_justification`. These fields are all-or-none. The validator pins
the implemented done/retry cell axes rather than allowing runtime prose to choose a route;
`expected_route` records terminal DB status, ref policy, evidence annotation,
retry/reroute/concession counts, merger/producer invocations, bounded feedback,
and zero system tokens. Retry cells identify the expects-accepted RTRV route
(including honest retry output without optional verdict keys); it is bounded
and forbids phantom completion.
The harness appends an invocation suffix to `workflow_id`, preserving unique
installed workflow IDs across cells and repeated executions.

A behavior template uses short agent IDs and must cover every agent in the base
workflow exactly once. The harness rewrites these to full
`<uniqueWorkflowId>_<agentId>` keys before daemon start. Tier-0 templates use
zero for every `tokens`, `heartbeatTokens`, and `defaultTokens` value:

```json
{
  "agents": {
    "doer": {
      "output": "STATUS: done\nREPORT: deterministic output",
      "tokens": 0
    }
  },
  "heartbeatTokens": 0,
  "defaultTokens": 0
}
```

Validate a scenario without side effects:

```text
node torture-test/scenarios/lib/validate-scenario.mjs <scenario-directory>
```

## W0.9 install-shape fidelity

`w0.9/` exercises the public remote installer against a scenario-owned
`file://` bare remote. It proves a depth-1 checkout, fresh `npm install`, build,
bundled workflow installation, and the installed `~/.local/bin/tamandua`
symlink before using that symlink for doctor and one zero-token scripted do-now.
It then advances the bare remote, requires `tamandua update` to fast-forward the
shallow checkout, dirties a tracked file and reruns the installer to prove its
`reset --hard` reinstall path, and invokes full uninstall. Product-owned
workflow artifacts are checked immediately after uninstall; scenario-owned
source and shell-link delivery artifacts are removed by the scenario teardown.
Every mutable path, including npm cache and temporary files, stays beneath the
disposable HOME or `torture-test/var`.

## W4.49 update-transaction failures

`w4.49/` contains three independent local-remote delivery fixtures. Each starts
from the checkout's old `dist`, advances a scenario-owned bare remote, and
triggers only after `git pull --ff-only` reaches the recorded target HEAD:

- `build-fails-after-pull` exits from an exact `BUILD_STARTED` marker, proves
  the old dist and scripted workflow remain usable, preserves a valid pre-fault
  catalog stamp, and then recovers with `update --force`. If doctor does not
  name the actual source/dist skew, the evidence records that missing product
  diagnosis explicitly as `PRODUCT_FINDING`; it never substitutes a
  scenario-created missing-stamp warning.
- `sigint-mid-build-install` pauses at `SIGINT_READY`, proves the detached
  update PID/PGID/start time, signals the foreground process group, and compares
  complete dist inventories before recovery.
- `workflow-install-post-stop` corrupts one bundled workflow, requires the
  failure after the `Stopping daemon` marker, compares the post-failure stamp
  with valid pre-fault bytes and timestamps, checks doctor's resulting
  diagnosis, and proves all previously running services restart through the
  update finally path before recovery. A premature stamp write or missing
  diagnosis is emitted as `PRODUCT_FINDING`, not hidden with a fixture guard.

The shared runner records target provenance inside its invocation directory,
uses only the 53xx scripted state, observes both token ledgers at zero, and
stops update-restarted daemon/dashboard/MCP processes before the harness removes
the fixture. No arm contacts pi or hermes.

## W4.25 aged-state, upgrade, downgrade, and re-upgrade legs

`w4.25/` pins the local `puma` tag to its expected commit and requires
`TT_COMMIT` to equal the checkout HEAD. It materializes both committed source
trees with `git archive`, copies the already-present dependency tree, and builds
two contained binaries without invoking a network-capable package or Git
operation. The developer checkout is read-only throughout.

The custom `puma-custom-probe` workflow uses only fields documented by puma's
versioned `docs/creating-workflows.md`. Its source bytes are pinned in
`custom-workflow.sha256`; puma must discover it in `workflow list`, accept it at
the normal install validation boundary, preserve the byte inventory, and run it
once with the deterministic scripted worker. Puma then creates separate
completed, paused, and failed history rows via `workflow run`, `workflow pause`,
and `workflow fail` rather than direct DB writes. The emitted evidence contains
both version identities, all run IDs and timestamps, custom hashes, and zeroed
run/system token ledgers.

The scenario command preserves that aged fixture long enough to swap the
contained `~/.local/bin/tamandua` symlink to the built `TT_COMMIT` tree and run
the normal `workflow install --all` bundled-catalog refresh. It proves the
refresh leaves the installed custom-workflow SHA-256 inventory unchanged, then
starts the TT_COMMIT daemon and requires doctor to report zero errors. Every old
run must agree byte-for-byte across `workflow status`, `workflow runs --json`,
the puma fixture inventory, and rendered logs. The timestamp check recognizes
the two historical UTC encodings emitted by puma (ISO milliseconds and SQLite
seconds), rejects unknown or invalid forms, proves creation ordering, and emits
the observed format inventory. It records puma's subsecond truncation delta and
rejects ordering skew of one second or more, so an upgrade-introduced skew
cannot hide behind the legacy precision difference.

The paused puma run is resumed with a zero-token TT_COMMIT behavior and must
complete, or the CLI must return the predeclared version/schema compatibility
diagnostic while leaving it paused. Finally TT_COMMIT lists and reinstalls the
puma-authored custom workflow as its validation boundary and completes it with
the deterministic worker. Evidence records both token ledgers at zero.

The forward runner then hands the same migrated state to the rollback runner.
At the forward, downgrade, and re-upgrade boundaries it records `user_version`,
the complete non-internal `sqlite_master` inventory, the historical run rows,
the forward-only step-column evidence, and the custom-workflow hashes. The
contained local-install symlink and scripted daemon are swapped back to puma.
Puma may either read the newer state without changing it or refuse with a
schema/version diagnostic. Any down-stamp, repeated DDL path, lost migration
evidence, schema change, historical-row change, or custom-byte mutation is
reported explicitly as `PRODUCT_FINDING`, never treated as compatible green.
The currently pinned puma/TT_COMMIT pair reproduces the known strict-equality
migration seam: puma silently stamps version 3 down to 2 while leaving the
version-3 column in place, so evidence records the down-stamp, repeated DDL
path, and erased migration provenance together.

The final swap restores TT_COMMIT over that exact state. The runner compares
the recovered schema, old rows, and custom hashes to the original forward
boundary, opens the database a second time to prove migration idempotence,
requires zero-error doctor output, and renders every historical run through
list/status/logs. It then lists, validates, and executes the custom workflow
again with zero-token behaviors before teardown.

The setup resets only `home-scripted`, starts and stops puma and TT_COMMIT through
`daemon-control scripted` with the contained puma binary first on PATH, restores
the operator HOME for daemon-control's production guard, and uses distinct
contained harness directories for each run. Teardown removes the aged state
after the re-upgrade leg and requires all 53xx ports free after every version
process stops, so consecutive executions begin from the same version-shaped
baseline.

## Command environment and ownership

The command runs in its own process group under `env/tt-env-scripted.sh` and
receives:

- `TT_SCENARIO_ID`
- `TT_SCENARIO_INVOCATION_ID`
- `TT_SCENARIO_WORKFLOW_ID`
- `TT_SCENARIO_STATE_DIR`
- `TT_SCENARIO_EXPECTED_OUTCOME`
- `TAMANDUA_SCRIPTED_BEHAVIORS`
- `TAMANDUA_SCRIPTED_STATE`

Each invocation gets a unique workflow copy, behavior file, and work-count
directory under `torture-test/var/scenarios/`. The harness serializes ownership
of the single scripted daemon because its behavior binding is fixed at startup.
All lifecycle calls go through `bin/daemon-control scripted`; the scripted env
is sourced only inside child processes. Daemon control receives the checkout's
`bin/` first on PATH so the scenario cannot accidentally test an unrelated
installed Tamandua build. EXIT, SIGINT, SIGTERM, and SIGHUP traps
stop the contained daemon, terminate only the recorded process group after PID
start-time verification, remove the exact invocation workflow copy, and delete
only invocation-owned state. Tool-path overrides are rejected outside explicit
self-test mode.

## HOME containment (FIX10 US-004)

Scenario code — and the scenario daemon it manages — must NEVER run with the
OPERATOR's real HOME, because a git-identity write under an uncontained HOME is
exactly the 2026-08-05 `~/.gitconfig` breach (a torture-test hook rewrote the
operator's real git config). Three layers enforce this for scenarios:

1. **Harness command child**: `run-scripted-scenario` sources
   `env/tt-env-scripted.sh` into every command child (contained
   `TT_SCRIPTED_HOME`), and the child wrapper sources
   `scenarios/lib/scenario-containment-guard.sh` before executing scenario
   code — the guard refuses (exit 2) unless `$HOME` is a real directory
   STRICTLY inside `torture-test/var`.
2. **Every scenario entry point**: each `scenarios/*/run.sh` sources the same
   guard, so a scenario invoked OUTSIDE the harness (direct developer
   invocation with the operator HOME) fails closed instead of running against
   the real home.
3. **daemon-control**: `guard_kind_containment` refuses to operate a kind
   whose resolved HOME or `TAMANDUA_STATE_DIR` escapes `torture-test/var`,
   and every daemon child is spawned under `env -i $(env_for_kind <kind>)`
   with the contained env — the operator HOME never reaches a daemon child.

### daemon-control real-HOME handoff (safe by invariant)

The harness `daemon_control()` and the scenario executables pass
`HOME=<operator home>` to `bin/daemon-control`. This is SAFE and required:

- daemon-control uses the operator HOME ONLY for its production-guard
  derivation (`REAL_TAMANDUA_STATE`, `is_production_cwd`). With the contained
  scripted HOME it cannot distinguish the real production state from TT state
  and refuses everything (fail closed — which is why scenario-local
  `daemon-control` calls must use the operator home to actually work).
- daemon-control itself performs NO git/config writes and no HOME-side
  effects (grep-verified).
- Every process daemon-control spawns (daemon, dashboard, mcp, stop-path
  CLI) is launched under `env -i $(env_for_kind <kind>)` — the contained
  HOME + `TAMANDUA_STATE_DIR` from `tt-env-scripted.sh`.
- daemon-control `guard_kind_containment` additionally fails closed if the
  KIND's resolved HOME or state dir escapes `torture-test/var`, so even a
  tampered env script cannot hand the operator HOME to a spawned daemon.
