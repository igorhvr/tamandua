# Post-batch hygiene sidecar contract (O5 / O6) — schema v1

Status: implemented in this torture-test slice (STORM-HYGIENE).
Owners of producer/consumer wiring: run 44 (storm engine/CLI) and 46 (aged
generator) consume the interface below; the coordinator owns Beads.

The per-case oracle contract (CONTRACT.md, `contract_version: 1`) carries a
fixed mechanical-evidence key set with **no slot for host process inventories,
listener censuses, managed-worktree disk/git metadata, or a campaign-wide
run_worktrees snapshot**. O5 (process & port hygiene) and O6 (worktree
bookkeeping) are **post-batch, campaign-wide** oracles (spec 03), so instead
of silently broadening the v1 context or the global evidence-key set (which
stays byte-identical), they consume a **narrow, explicitly versioned
companion input**:

```text
torture-test/oracles/O5 --contract-version 1 --sidecar <absolute-sidecar-path>
torture-test/oracles/O6 --contract-version 1 --sidecar <absolute-sidecar-path>
```

stdout carries the SAME version-1 oracle response shape and exit codes as the
per-case oracles (`contract_version: 1`, `oracle_id`, `result`,
`started_at`/`finished_at` UTC, `findings`, `evidence`, optional
`classification`; exit 0/1/2/3 for PASS/FAIL/ERROR/NOT_EVALUABLE). Evidence
paths resolve beneath `TT_ORACLE_EVIDENCE_DIR` when the controller supplies it,
else the sidecar file's own directory. stderr is diagnostic only.

The checkers write their own summary evidence (`o5-summary.json`,
`o6-summary.json`, `o6-prune-probe-plan.json`) into that evidence directory
(exclusive create). Sidecar-declared raw captures (`sidecar.evidence_files`)
are additionally cited as response evidence when they are reachable from the
evidence directory — e.g. the recommended layout where
`TT_ORACLE_EVIDENCE_DIR` is a campaign evidence dir that CONTAINS the sidecar
package: the cited path is then relative to the evidence dir. A raw capture
outside the evidence dir is not cited (it stays declared + hash-verified in
the sidecar's own `evidence_files`); citing it would be a broken reference.
Controllers that want raw captures cited should therefore point
`TT_ORACLE_EVIDENCE_DIR` at (or above) the sidecar package, never at a
disjoint directory.

## The sidecar file

A **post-batch hygiene sidecar** (`schema_version: 1`,
`sidecar_kind: "post-batch-hygiene"`) is produced by the input recorders
(`torture-test/oracles/lib/o5-capture.mjs` for O5, `lib/o6-capture.mjs` for
O6) and consumed read-only by the checkers (`lib/o5.mjs`, `lib/o6.mjs`).
Validator/loader: `lib/hygiene-sidecar.mjs` (`loadHygieneSidecar`).

Common envelope fields:

| field | type | meaning |
|---|---|---|
| `schema_version` | 1 | sidecar schema version (this document is v1) |
| `sidecar_kind` | `"post-batch-hygiene"` | fixed |
| `oracle_id` | `"O5"` \| `"O6"` | which checker this sidecar feeds |
| `produced_at` | UTC | capture finish time |
| `producer` | `{name, version}` | recorder identity |
| `campaign` | object | `id`; `run_ids` (full canonical `run-…` ids, no duplicates); `window {start_utc, end_utc}` — the independently admitted campaign lifetime; `host {platform, scope_layer, scope_pattern}` |
| `evidence_files` | array | raw capture artifacts: `{path, sha256, kind, captured_at?, tool?, exit_code?}` — portable relative paths beneath the sidecar's own directory; the loader hash-verifies every entry and the checker cites them as response evidence |
| `diagnostics` | string[] | recorder warnings (EPERM, truncated output, timeouts) — never verdicts |

`campaign.host.scope_layer` is one of `systemd-user-scope` (kernel-owned
containment available), `none` (darwin-style: no layer-1 census; layers 2–4
carry the weaker guarantee) or `unavailable` (could not be determined). A host
with `scope_layer: "none"` MUST record `o5.coverage.scope.status` as
`not_applicable` — any other claim is the finding `O5_FALSE_SCOPE_CLAIM`
(Linux fixtures are never dressed up as a real Mac run, and vice versa).

## O5 section (`sidecar.o5`)

```jsonc
{
  "scope": {
    "contained_paths": ["/abs/…"],           // campaign-owned roots (TT roots)
    "host_admitted_paths": [                  // explicit shared-path mappings
      {"path": "/abs/shared-origin-or-config", "owner": "shared-origin|config", "admitted": true}
    ],
    "cgroup_pattern": "…scope pattern… | null",
    "daemon_restarts": [                      // every daemon start AND restart
      {"instance": "daemon-1", "pid": 1234, "pgid": 1234, "start_identity": "proc:…",
       "started_at": "…Z", "scope_membership_observed": true}
    ]
  },
  "admissions": [                             // the COMPLETE admitted scope (census denominator)
    {"id": "…", "kind": "run-worker|daemon|listener|toolchain", "run_id": "run-… | null",
     "pid": 123, "pgid": 123, "start_identity": "proc:…|darwin:…|null",
     "cwd_prefix": "…|null", "cmdline_prefix": "…|null",
     "toolchain": "…|null", "expect": "gone|alive_current",
     "required_layers": ["scope","pgid-ancestry","path-fd","start-window"],
     "listen_specs": [{"protocol":"tcp","address":"127.0.0.1","port":4334}] | null}
  ],
  "coverage": {                               // per-layer recorded status
    "scope":       {"status": "available|partial|unavailable|not_applicable", "note": "…|null"},
    "pgid-ancestry": {"status": "…", "note": "…|null"},
    "path-fd":     {"status": "…", "note": "…|null"},
    "start-window": {"status": "…", "note": "…|null"}
  },
  "observations": {
    "scope_members":    {"rows": [{"pid","pgid","start_identity","cgroup","ts"}], "exact_count": n, "capped": false, "tool": {"name","exit_code"}, "spans": [{"start","end"}]},
    "processes":        {"rows": [{"pid","pgid","ppid","state","start_identity","cgroup","cwd","cmdline","ts"}], …},
    "listeners":        {"rows": [{"pid","pgid","start_identity","protocol","local_address","local_port","ts"}], …},
    "shared_toolchain": {"rows": [{"toolchain","pid","start_identity","state","ts"}], …}
  },
  "census": {"complete": true|false, "notes": []}
}
```

Rules (all encoded in `lib/o5.mjs`, never relaxed):

1. **Coverage, not empty.** An admission `expect: gone` is certified dead only
   when the census is complete, no pid/pgid-reuse row (same numeric id, DIFFERENT
   start identity) exists, and every layer in its `required_layers` is
   available. Otherwise the admission is UNRESOLVED: PID reuse, EPERM, missing
   sampler spans, observation timeouts, malformed/incomplete inventories and
   absent tools are **never proof of process death or port release**. An
   unresolved admission (with no failing finding) yields NOT_EVALUABLE
   (`classification.ambiguous.category`: `pid-reuse` or `census-incomplete`),
   never PASS. Any failing finding beats NOT_EVALUABLE.
2. **Identity, not pid.** `claim_pid` is the daemon, NOT the harness;
   `claim_pgid` plus current process birth/ancestry corroboration
   (`start_identity`, recorded at claim time) is the worker identity the
   recorder snapshots. A declared `alive_current` survivor that is not observed
   is informational `O5_DECLARED_SURVIVOR_UNOBSERVED` ONLY when the census is
   complete; under an INCOMPLETE census it is UNRESOLVED (census-incomplete) —
   an incomplete census can never certify that a survivor stopped.
3. **Containment without guessing.** A process under an explicitly shared
   original repository/config path is campaign-legitimate when
   `scope.host_admitted_paths` admits it — `host_admitted_paths`, not
   substring guesses, decide. A process whose cwd lives under an admitted
   campaign path but matches no admission identity and no shared mapping is
   `O5_FOREIGN_RUN_CONTAINMENT`. Unrelated operator processes are counted and
   ignored. Scope census rows carry no cwd, so a scope member is judged by
   ADMITTED NUMERIC ANCHOR: a pid in the campaign's own scope census that
   matches no admission pid/pgid, no daemon-restart provenance and no declared
   shared-toolchain pid is a foreign process inside the campaign's own kernel
   containment — `O5_FOREIGN_RUN_CONTAINMENT` (the strongest layer must never
   fail open). A row whose anchor matches but whose identity differs is an ABA
   reuse suspicion owned by the disposition machinery, never clean foreign.
4. **Restart provenance is a fact.** A new pid after a restart does NOT inherit
   a cgroup by assumption. On a `systemd-user-scope` host every daemon restart
   must carry `scope_membership_observed: true` (the wrapper's re-assertion);
   a restart without it, or a scope-layer claim on a host without one, is the
   finding `O5_FALSE_SCOPE_CLAIM`.
5. **Honesty is enforced from the data, not producer discipline.** Every layer
   is cross-checked against the census data that underpins it: a failed
   inventory tool (exit != 0) makes the layer `unavailable` and a capped
   (sampled) inventory makes it `partial` regardless of the producer's
   coverage claim or `census.complete`. `scope` is underpinned by the
   scope_members census, `pgid-ancestry` by the processes census, and
   `path-fd` by the processes census plus the listeners census when the
   admission declares listen specs (a failed `lsof` cannot certify port
   release). The effective states are recorded in the summary's
   `effective_layer_profile` next to the raw `layer_profile`.
6. **Dispositions.** Live leftover (`O5_LEFTOVER_PROCESS`,
   `O5_DAEMON_LEFT_RUNNING`), zombie (`O5_ZOMBIE_LEFTOVER`), leftover/mismatched
   listeners (`O5_LEFTOVER_LISTENER`, `O5_LISTENER_OWNER_MISMATCH`,
   `O5_UNLISTED_LISTENER`), undeclared toolchain daemons
   (`O5_UNDECLARED_TOOLCHAIN_DAEMON`) and >1 survivor per declared toolchain
   (`O5_TOOLCHAIN_SURVIVOR_LIMIT`, the W6 ≤1-per-toolchain allowance) are
   failing findings. Declared current survivors and shared daemons are listed
   for disposition as informational findings. Duplicate admission ids are
   `O5_INVENTORY_DUPLICATE_ADMISSION`. Informational (non_failing) findings are
   emitted ONLY on a PASS result — a NOT_EVALUABLE result may not carry
   findings (output contract), and the shared wrapper additionally strips any
   stray non_failing finding before response validation so a clean-but-
   unresolved analysis is NOT_EVALUABLE (exit 3), never ERROR.
7. The evaluator never kills, reaps, cleans or mutates; the recorder gathers
   bounded read-only snapshots only inside the explicit allowed scope; never
   env, never credentials; public cmdline fields are bounded (≤512 chars) and
   redacted (`lib/o5-capture.mjs` `redactCmdline`).

Darwin hosts: no env inspection; layer 1 not applicable; layers 2–4 recorded
via ps/lsof/identity evidence with the weaker guarantee reported on PASS as
`O5_HOST_WEAKER_GUARANTEE`.

**Listener-capture contract (recorder side, `lib/o5-capture.mjs`
`snapshotOwnedListeners`).** Strengthened after the root capture probe
(`o5-o6-root-capture-probe-20260909`, which showed lsof exit-1 errors,
malformed stdout, an out-of-scope port selector and exit-0 warnings all
producing a false successful empty census):

- **Strict COMPLETE preflight of every input BEFORE any tool call.** Ports are
  admitted only as finite safe integers in 1..65535. A range (`'1-65535'`), a
  string, a float, zero/negative or any other out-of-scope entry makes **NO
  tool call** and returns a mechanically non-success inventory
  (`tool.exit_code` 2, `preflight_rejected: true`, bounded `diagnostics`).
- **lsof `-F` framing is validated, not skimmed.** Every field line must be a
  single-letter `-F` code, pids must be positive integers, and every
  address/port name record must parse AND name the requested port. Malformed
  framing (`not-lsof-output`, unframed lines, non-numeric pids, unparseable or
  wrong-port names) is a bounded diagnostic, never a silently-empty census.
- **Clean no-match is DISTINGUISHED from tool failure.** lsof exit 1 with
  EMPTY stdout AND EMPTY stderr is the positive absence observation and
  normalizes to aggregate `tool.exit_code` 0 (port release evidence). lsof
  exit 1 carrying stderr or stdout content, exit 0 with any stderr warning
  (even with rows — rows are kept as evidence but the port is not certified
  clean), exit outside {0,1}, spawn failure, timeout and maxBuffer/unknown
  outcomes are mechanically NON-SUCCESS (rows only when genuinely parsed,
  bounded `diagnostics`/`port_outcomes`, non-zero aggregate exit) so the O5
  evaluator's data-driven layer downgrade applies — a recorder failure can
  never present as a complete empty census, and O5 propagates it to
  NOT_EVALUABLE (never PASS).
- Duplicate admitted ports never double-count rows (per-`pid:port` dedupe).
- **Empty port list = VACUOUS clean census; `port_outcomes` is the per-port
  proof artifact.** `snapshotOwnedListeners([])` — or any capture over a
  valid-but-empty port set — makes no tool call and returns
  `rows [] / exact_count 0 / tool.exit_code 0` WITHOUT `port_outcomes`: such an
  inventory certifies NOTHING, because no port was probed. Every port the
  recorder actually probed is accounted for one-to-one in `port_outcomes`
  (`clean` / `listening` / `listening-with-diagnostic` / `malformed` /
  `tool-error` / `rejected-input`). Producers (44/46) and consumers must treat a
  listeners inventory that carries no per-port proof for an admission that
  declares `listen_specs` as MISSING port-release evidence, never as a clean
  census. `lib/o5.mjs` does not consume `port_outcomes` yet, so this gap is
  recorded here: the checker-side cross-check — every admitted
  `listen_spec.port` must have a matching `port_outcomes` (or listener-row)
  entry, otherwise the path-fd layer degrades to partial → NOT_EVALUABLE — is a
  REQUIRED change at the next O5 modification (the 44/46 integration or a later
  slice), and intentionally does not touch the recorder contract above.
- **The exit-1-empty clean normalization is LINUX-VERIFIED only.** The rule
  "lsof exit 1 with EMPTY stdout AND EMPTY stderr normalizes to success" is
  validated against this host's Linux lsof (live proof + hermetic
  calibration). It must be re-validated against a real Darwin/BSD lsof before
  the Mac leg: there a no-match may exit 0 with empty output, which this code
  classifies as `malformed` → conservative NOT_EVALUABLE (never a false
  absence). The residual risk is therefore false negatives on a future real Mac
  run, never false success; the assumption must not be mistaken for a portable
  fact.

## O6 section (`sidecar.o6`)

```jsonc
{
  "database": {"path": "db/database.sqlite", "sha256": "…", "schema": "native-run_worktrees-v1"},
  "roots": {
    "worktree_root": "/abs/managed-root",     // native resolveWorktreeRoot (env-derived, explicit)
    "origins": [{"repository": "/abs/origin", "git_common_dir": "/abs/origin/.git",
                 "admitted_branch_roots": ["refs/heads/feature", "refs/heads/fix"]}]
  },
  "disk": {"entries": [{"path": "/abs/…", "kind": "dir|file|symlink-dir", "git_worktree": bool}],
           "exact_count": n, "capped": bool, "tool": {"name", "exit_code"}},
  "git": {"origins": [{
    "origin_index": 0,
    "worktree_list":       {"rows": [{"worktree_path","gitdir_path","branch","detached","locked","prunable"}], "exact_count": n, "capped": bool, "tool": {"name","exit_code"}},
    "worktrees_metadata":  {"rows": [{"gitdir_path","name","gitdir_target","worktree_path"}], …},
    "branches":            {"rows": [{"full_ref","object_sha","type"}], "exact_count": n, "capped": bool, "tool": …}
  }]},
  "prune": {"executed": false, "refusal": "…", "plan": {"clone_root": "…", "closed_scope": true}}
}
```

The DB file is a **read-only snapshot** (mode 0400; the loader verifies the
sha256). The checker opens it read-only and reconciles BOTH directions:

- rows → run statuses (orphan row = no runs row), disk paths, git list,
  .git/worktrees metadata, branch inventory;
- disk/git/metadata → rows (orphan dir, orphan metadata, unmanaged entries).

Findings: `O6_ORPHAN_ROW`, `O6_ORPHAN_DIRECTORY`, `O6_ORPHAN_METADATA`,
`O6_OUT_OF_BAND_DELETION`, `O6_PATH_NOT_GIT_WORKTREE`,
`O6_METADATA_MISMATCH`, `O6_DUPLICATE_BINDING`, `O6_WRONG_ORIGIN`,
`O6_WRONG_ROOT`, `O6_INVALID_ROW_DATA`, `O6_INCONSISTENT_STATE`,
`O6_REMOVED_BUT_PRESENT`.

> There is **no `O6_MISSING_WORKTREE` id** (an earlier doc draft listed it):
> a ready row whose path is gone is `O6_OUT_OF_BAND_DELETION`, and a ready row
> whose directory is present but not a git worktree is
> `O6_PATH_NOT_GIT_WORKTREE`. Consumers must not wait for a never-emitted id.
> There is also **no `O6_BRANCH_INCONSISTENCY`**: see the branch rule below —
> retained refs are origin inventory and are always characterization, never a
> corruption FAIL.

Policy/UX characterization is reported **separately from corruption**
(informational, non-failing, and emitted ONLY on a PASS result — a
NOT_EVALUABLE result may not carry findings): each row's OWN `cleanup_policy`
is applied with current native semantics — default `keep` (the
`createRunWorktree` default) means retained-after-terminal is CORRECT
(`O6_RETAINED_BY_POLICY`); normal retained size and non-merged
`feature/*`/`fix/*` branches are never deletion-worthy defects.
`remove_on_success`/`remove_on_terminal` are not auto-enforced by native
run-terminal code in this snapshot (only `worktree remove`, `workflow delete`,
`worktree prune` remove worktrees), so a remove_on_* row still `ready` after a
terminal run is `O6_POLICY_CHARACTERIZATION` — a product policy gap, never
corruption.

**Branch rule (reconciled with the policy model).** Native lifecycle in this
snapshot never deletes refs: worktree removal removes the worktree and its
`.git/worktrees` metadata but leaves the origin repository's `refs/heads`
inventory untouched, and run worktrees are created **detached** at an existing
origin ref (`original_branch` records the origin's checked-out branch,
generally a shared base). A retained ref under an explicitly admitted branch
root is therefore origin-repository inventory, never corruption. Its owning
row's `cleanup_policy` describes WORKTREE (not ref) lifecycle, so a retained
branch whose owning run is `remove_on_*` is the *same* auto-enforcement gap as
the worktree-level `O6_POLICY_CHARACTERIZATION` — reported as
`O6_BRANCH_RETENTION_CHARACTERIZATION`, never a deletion-worthy defect.

Counts: exact counts always ride the inventory (`exact_count`, `capped`); the
checker never derives totals from a capped array and an absence in a capped or
failed capture is never proof of absence. Invalid/unusable input never becomes
PASS (NOT_EVALUABLE / ERROR), and a concrete finding on one leg is preserved
even when another leg is missing (FAIL beats NOT_EVALUABLE). The same
discipline applies to the git leg: a ready row whose origin git worktree-list
capture is capped or failed leaves the row<->git reconciliation UNRESOLVED
(NOT_EVALUABLE, `classification.ambiguous.category:
reconciliation-incomplete`), never PASS — absence from a sample or a failed
tool is not a fact. Informational per-row and branch characterizations are
emitted ONLY on a PASS result (a NOT_EVALUABLE result may not carry findings);
the summary evidence always carries the collected rows regardless of result.

**Prune/age leg:** native prune/removal is an explicit SEPARATE behavioral leg.
This read-only slice never executes it; the sidecar MUST carry
`prune.executed: false` with a clone-only probe plan (a cloned DB that still
points at original worktrees is NOT isolation — the clone must remap the
disposable root/DB/path set). The O6 response records the leg as
`O6_PRUNE_LEG_NOT_RUN` (informational) and writes `o6-prune-probe-plan.json`
into evidence. Full O6 acceptance (including prune characterization) stays
open until the coordinator independently reviews the exact disposable
root/DB/path set and code.

**Fixture DB writer is NEW-only (`lib/o6-capture.mjs`
`createNativeFixtureDatabase`).** The writer never pre-deletes and never opens
over an existing path: it refuses (throwing, touching nothing) when the target
already exists as a file, directory or symlink, requires the caller's freshly
owned fixture root directory, and exclusively reserves a fresh regular file
(`O_EXCL`) before sqlite touches it — an existing caller-supplied file's bytes,
inode and hash are preserved untouched (negative tests pin all three). A source
comment is not the boundary; every caller hands over a fresh path inside a root
it owns, and no recursive cleanup exists anywhere in the fixture writer.

**Prune/age behavioral plan (future bounded native-prune stage — NOT_RUN,
never executed in this stage).** The coordinator-gated proof must be wholly
independent and closed-scoped, and must characterize — not change — native
semantics:

- Native removal entry points and their exact path/API effects (all read from
  the pinned source, never invoked here):
  - `src/installer/worktree-manager.ts` `removeRunWorktree(runId, {force})`:
    reads the `run_worktrees` row (none → throw; `removed` → idempotent
    no-op); if the worktree path exists it (a) calls
    `sweepRunProcesses(runId, worktreePath, {excludePgids})`
    (`src/installer/run-cleanup.ts`, process scope = the exact disposable root;
    `excludePgids` = the run's own `steps.claim_pgid`), (b) refuses dirty
    non-forced removal (`git status --porcelain` in the worktree), (c) runs
    `git -C <origin> worktree remove [--force --force] <worktreePath>`; then
    `UPDATE run_worktrees SET status='removed', removed_at=?`. Effects: the
    worktree directory AND its `<common>/worktrees/<name>` metadata disappear
    via git; the DB row is retained as `removed` (never deleted); origin
    `refs/heads` are never touched.
  - `src/cli/commands/worktree.ts` `tamandua worktree prune --completed
    --older-than <duration>`: selects completed/failed runs older than the
    duration and calls `removeRunWorktree` per candidate — same path effects
    behind an age predicate.
  - `src/installer/status.ts` `deleteWorkflow` (full delete: cancel + forced
    `removeRunWorktree` + row deletes) is the delete path, a separate followup
    from prune/age.
- The future proof must: create a wholly independent fresh origin + managed
  root + DB + branch metadata + process scope under one NEW mkdtemp; prove
  every removal target is inside that root (row paths, disk worktrees,
  `.git/worktrees` metadata, sweep process cwd/pgid scope) BEFORE invoking any
  removal API; never clone only the DB while leaving original live worktree
  paths behind and then call native prune; retain all created repos/worktrees
  and record exact before/after disk + git + DB evidence. It does NOT broaden
  this stage and is not authorized by any generic root-approval file created by
  the doer.

**Native-writer live leg (verification-item-3).** The bounded proof that the
REAL native run/worktree writers (not fixture DDL helpers or hand-inserted
lifecycle rows) create the fixture run and managed worktree(s) is executed by
`torture-test/oracles/self-test/native-writer-leg.mjs` (gate:
`self-test/run-o5-o6-native-writer.sh`): a strictly private, retained
HOME/STATE/DB/TMPDIR + tiny OWNED origin git repo + a clearly labeled
NON-DISPATCHING registration-transport stub on a random loopback port (no real
agents/providers; zero dispatch). The run row/`run_number` allocation, the
`run_worktrees` row (native default `cleanup_policy` = `keep`, `status ready`,
detached at the origin ref with `original_branch` recorded), the real managed
worktree on disk, the `.git/worktrees` metadata and the retained origin branch
inventory all come from `/opt/tamandua/dist` (stable matched product build,
verified against the candidate/stage sources BEFORE any effect). The exact
native terminal writer (`forceFailRun`) marks the run failed while the ready
`keep` worktree stays in place — retained-after-terminal is the CURRENT native
contract, characterized, never called corrupt. O5/O6 evidence is captured via
the CORRECTED recorders and driven through the ACTUAL `oracles/O5`/`oracles/O6`
executables (O5 FAIL while the owned stub listener is alive → PASS after exact
release; O6 PASS pre-terminal and post-terminal with `O6_RETAINED_BY_POLICY` +
`O6_PRUNE_LEG_NOT_RUN`). Exact owned listener/DB handles are closed and
positively observed. Nothing is pruned or removed; the whole leg workspace is
retained.

## Capture/checker interface (for producers 44/46)

```text
capture  lib/o5-capture.mjs  snapshotOwnedProcesses(pids, {spans})   -> o5.observations.processes
                             snapshotOwnedListeners(ports, {spans})  -> o5.observations.listeners
                               (strict port preflight: finite safe ints 1..65535, NO tool call on
                               invalid scope; validated lsof -F framing; clean no-match exit 1 w/
                               empty stdout+stderr normalized to success [linux-verified only —
                               re-validate against a real Darwin lsof before the Mac leg]; every
                               other outcome = non-success rows[]+diagnostics+non-zero exit —
                               never a false empty census; empty ports[] is a VACUOUS clean census
                               and port_outcomes is the per-port proof artifact — see the
                               listener-capture contract bullets above)
                             snapshotProcessRow(pid)                  -> one bounded process row
                             redactCmdline(str)                       -> bounded/redacted cmdline
         lib/o6-capture.mjs  readRunWorktreesSnapshot(dbPath)         -> {available, rows, runs|reason}
                             captureGitWorktreeList(originRepo)       -> git.origins[].worktree_list
                             captureGitWorktreesMetadata(gitCommonDir)-> git.origins[].worktrees_metadata
                             captureBranches(originRepo)              -> git.origins[].branches
                             captureManagedRootListing(worktreeRoot)  -> disk
                             createNativeFixtureDatabase(dbPath,…)    -> FIXTURE-ONLY writer, NEW-only:
                               never pre-deletes/overwrites; rejects an existing file/directory/
                               symlink; exclusive O_EXCL reserve inside the caller's owned fixture root
check    lib/o5.mjs          evaluateO5(invocation) -> {result, findings, evidence, classification?}
         lib/o6.mjs          evaluateO6(invocation) -> {…}
load     lib/hygiene-sidecar.mjs loadHygieneSidecar(path, {verifyEvidence})
run      oracles/O5|O6 --contract-version 1 --sidecar <abs-path>
```

`invocation` is the frozen object from `loadHygieneSidecar` plus `evidenceDir`
(the wrapper supplies it). Evidence files written by the checkers
(`o5-summary.json`, `o6-summary.json`, `o6-prune-probe-plan.json`) use the
shared exclusive-create helpers and never overwrite controller evidence.

## Calibration

`torture-test/oracles/self-test/generate-o5-fixtures.mjs`,
`generate-o6-fixtures.mjs`, `o5.test.mjs`, `o6.test.mjs` — one focused
calibration suite per checker, run serially file-by-file (`node --test
torture-test/oracles/self-test/o5.test.mjs`, then `o6.test.mjs`). Positive
controls + malformed/absent/partial/mismatched-identity/stale-birth/PID-reuse/
wrong-run/path/symlink/incomplete-scope/duplicate-id/unavailable-layer/
shared-daemon and every cleanup-policy shape plus 7+ orphan negatives; wrapper
parsing and exit codes are asserted (the real `oracles/O5`/`O6` executables
and the real exported implementations, never a parallel mock checker).

Regression pins added in the review round:

- O5: declared alive_current survivor stopped under a COMPLETE census (PASS +
  `O5_DECLARED_SURVIVOR_UNOBSERVED`) vs NOT observed under an INCOMPLETE
  census (NOT_EVALUABLE, zero findings — never a positive 'it has stopped',
  never ERROR); foreign process inside the campaign's own scope census
  (`O5_FOREIGN_RUN_CONTAINMENT`); listener census tool failure while
  coverage.path-fd claims available (`NOT_EVALUABLE`, data-driven downgrade);
  capped processes census with `census.complete: true` (`NOT_EVALUABLE`).
- O6: terminal keep row with disk+git legs down (NOT_EVALUABLE, zero findings —
  the old ERROR escalation); ready row whose origin git worktree-list capture
  is capped (NOT_EVALUABLE, `reconciliation-incomplete`); sidecar
  `evidence_files` coverage — present-and-valid (PASS, raw captures cited),
  missing file / hash mismatch / symlink (ERROR from the read-only loader);
  `TT_ORACLE_EVIDENCE_DIR` divergence (parent-of-sidecar => raw captures cited
  relative to the evidence dir; disjoint => omitted, never a broken reference);
  remove_on_* retention with a retained branch (PASS, characterization —
  branch and worktree policy reconciled).

Live proofs (bounded, isolated, retained): O5 records an EXACT OWNED child and
a bind-to-0 listener through the real capture module, observes them
alive/listening (FAIL), then shuts them down EXACTLY (identity-verified reap /
close of the exact handle) and observes clean (PASS). O6 creates a REAL git
origin + REAL managed worktree under a fresh private retained workspace via
`git worktree add` and reconciles it through the real capture module + real
checker (PASS). The verification-item-3 bounded NATIVE-writer live leg (real
product run/worktree writers against a private HOME/STATE/DB/TMPDIR + owned
origin + non-dispatching registration stub) is executed by
`native-writer-leg.mjs`/`native-writer-leg.test.mjs` against the stable matched
`/opt/tamandua/dist` — see "Native-writer live leg" above. The fixture DB
writer is NEW-only (existing bytes/inode preserved; fresh exclusive reserve),
and the O5 listener capture is hardened (strict port preflight + lsof framing
validation; hermetic injected-output tests for every root counterexample plus
genuine clean no-match and listener positives, and real-wrapper propagation of
recorder failures to NOT_EVALUABLE / PASS / FAIL). The prune/age behavioral leg
remains NOT_RUN with the exact plan above — full O6 acceptance stays open on
that leg.
