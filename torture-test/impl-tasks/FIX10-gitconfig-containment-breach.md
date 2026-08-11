# FIX10: torture case escaped containment and overwrote the OPERATOR's ~/.gitconfig

CONFIRMED BREACH (evidence 2026-08-08): the operator's real
`~/.gitconfig` was modified in place at 2026-08-05 16:51 local —
during the first Tier-0 acceptance double-run — replacing user.name/
user.email with `Tamandua Tier-0 <tier0@tetradactyla.invalid>` while
preserving unrelated sections (signingkey, push, merge). 14 subsequent
dev-repo commits carry the wrong author. The operator identity has
been restored by hand; do NOT touch ~/.gitconfig in this task.

This is exactly the containment class spec 01 (TT_HOME isolation) and
the O18 hygiene canaries exist to prevent: a case/hook ran
`git config --global ...` with the REAL HOME in effect (or with
GIT_CONFIG_GLOBAL unset/mis-scoped).

## Work

1. Find the exact writer: audit every place under torture-test/ that
   runs `git config --global` or relies on GIT_CONFIG_GLOBAL /
   HOME containment (cases/hooks/run-w0.1 sets it correctly INSIDE
   its env — check who invokes hooks WITHOUT the contained HOME:
   tt-controller local-case env assembly, scenario setup scripts,
   daemon-control env_for_kind, self-tests). Correlate with what
   executed around 2026-08-05T16:31Z-19:51Z (tier0 campaigns
   campaign-20260805T140754Z and campaign-20260805T163154Z are in
   torture-test/var/results/ with per-case timing evidence). Name the
   culprit in your report with evidence.
2. Fix the leak: every spawned case/hook/scenario must get the
   contained HOME (and GIT_CONFIG_GLOBAL where git identity is
   needed) from the controller env — never the operator's. Fail
   closed: if the contained HOME cannot be established, the case must
   error, not fall through to real HOME.
3. Add the O18-style hygiene canary the spec calls for: before a
   campaign starts, snapshot hash of ~/.gitconfig (and a short list of
   other operator-identity files: ~/.ssh/config if present, crontab);
   after the campaign, verify unchanged; any diff = campaign-level
   FINDING (not silent). Wire it into the controller so every tier
   gets it automatically.
4. Prove: run `./run-torture-test --tier0` (scripted, zero tokens)
   and show the canary section in the report + ~/.gitconfig hash
   unchanged. Grep-prove no remaining `git config --global` in
   torture-test/ executes outside a contained-HOME env.

## Hard constraints

- Files ONLY inside torture-test/. Zero tokens. Live daemon untouched.
- Do not rewrite git history for the 14 mis-authored commits; note
  them and move on.

---

## FINDING (US-001 forensic audit, 2026-08-09)

### Exact writer

**`torture-test/cases/hooks/run-w0.1:24-26`** — the ONLY `git config
--global` write site in the entire torture-test tree:

```
24: git config --global user.name "Tamandua Tier-0"
25: git config --global user.email "tier0@tetradactyla.invalid"
26: git config --global commit.gpgsign false
```

This writes exactly the identity observed in the breach
(`Tamandua Tier-0 <tier0@tetradactyla.invalid>`), and `git config
--global` only rewrites the requested keys, preserving unrelated
sections (signingkey, push, merge) — matching the 2026-08-08 evidence
byte-for-byte. Grep proof (whole tree, var/ + node_modules excluded):

```
$ grep -rn "git config --global" torture-test/ | grep -v var/
torture-test/cases/hooks/run-w0.1:24:git config --global user.name "Tamandua Tier-0"
torture-test/cases/hooks/run-w0.1:25:git config --global user.email "tier0@tetradactyla.invalid"
torture-test/cases/hooks/run-w0.1:26:git config --global commit.gpgsign false
```

### Leak mechanism

`run-w0.1` sets (line 22) `export GIT_CONFIG_GLOBAL="$HOME/.gitconfig"`
(plus `GIT_CONFIG_NOSYSTEM=1`), then runs `git config --global ...`.
Git resolves the global-config write target to `$HOME/.gitconfig`.
Under the contained scripted HOME (`TT_SCRIPTED_HOME` from
`env/tt-env-scripted.sh`) the write lands in the contained home — safe.
Under the OPERATOR's real HOME the identical write lands in the real
`~/.gitconfig`, replacing exactly user.name/user.email and adding
`commit.gpgsign=false` while leaving every unrelated section intact.
**The hook contains NO guard against an uncontained HOME** — it is
fail-open by construction.

### Invocation correlation — who ran the hook with the real HOME

The controller paths were ALREADY HOME-contained at breach time
(commit `a2ecb49c`, 2026-08-05 11:07 — the same day as the breach):

- `tt-controller.loadSpawnEnvironment()` strips `HOME` (and
  `TT_*`/`TAMANDUA_*`/`HERMES_*`) from the operator env and re-adds the
  contained `TT_SCRIPTED_HOME` from `env/tt-env-scripted.sh`; the
  `print` contract FAILS CLOSED if HOME/TAMANDUA_STATE_DIR are absent.
- `executeLocalCase`/`runDurableLocalCommand` spawn `tt-hook-runner`
  with `env: childEnv` (contained); `tt-hook-runner` forwards
  `env: process.env` to the hook child — contained when reached via the
  controller, **fail-open when the runner is invoked outside it**.
- `runHook` (reset/launch/pre-command hooks) spawns directly with the
  same contained `childEnv`.
- Campaigns run through `run-torture-test → tt-run → tt-controller`
  (also from `tier0-repeatability.test.ts`, which passes the operator
  env to the LAUNCHER — the controller re-contains before any hook).

Therefore no controller-spawned campaign could have written the real
`~/.gitconfig`; the writer must have executed outside the controller's
env assembly. The fail-open surfaces are:

1. **Direct developer invocation** of the hook — `bash
   torture-test/cases/hooks/run-w0.1` from an operator shell. The FIX8
   task (`impl-tasks/FIX8-sweep-timer-test-home-sensitivity.md`)
   explicitly instructs this as the acceptance proof ("the case hook
   `bash torture-test/cases/hooks/run-w0.1` exiting 0 in a contained
   HOME (you may reuse the controller's contained-home pattern)") —
   the "contained HOME" is left to the invoker; the hook itself never
   verifies it. **Most plausible culprit.**
2. `tt-hook-runner` spawned standalone with the operator env
   (`env: process.env`).
3. Secondary, same-class hygiene gaps (not the writer): the scripted
   scenario harness hands `daemon-control` `HOME=$ACCOUNT_HOME`
   (real home) — re-contained by `daemon-control`'s `env -i`
   `env_for_kind` before any daemon spawn, and `daemon-control` itself
   never runs `git config`; `tt-golden-bootstrap` runs
   `fixtures-src/*/build-golden.sh` with the caller's env, but those
   scripts use only repo-local `git config` (no `--global`), so they
   cannot write `~/.gitconfig`.

Timing evidence:

- Breach evidence: `~/.gitconfig` mtime 2026-08-05 16:51 local
  (last write); the tier0 identity was ALREADY in effect at
  16:28:27 local — `d2a272b1` ("US-001 - Guard removeRunCrons ...") is
  authored `Tamandua Tier-0 <tier0@tetradactyla.invalid>`, i.e. the
  FIRST wrong-author commit predates the observed mtime; 16:51 is a
  re-write from repeated gate/hook re-execution.
- Both mis-authored FIX8-side commits (`d2a272b1` 16:28,
  `2041ae29` 17:23, `2ae67695` 17:26) fall inside the FIX8 work window
  (task `c4d9e9ce` committed 15:58 local; the sweep-timer fix landed
  2026-08-06 00:12/00:14) — i.e. the window in which the developer
  re-ran the tier0 gate/hook to reproduce and verify the W0.1
  HOME-sensitivity failure.
- The two acceptance campaigns (`campaign-20260805T140754Z`,
  `campaign-20260805T163154Z`) bracket the window (the second,
  started 13:31:54 local, was still running during the FIX8 work), but
  **per-case timing evidence is UNAVAILABLE in this checkout**:
  `torture-test/var/` is gitignored and `var/results/` is absent
  (only `baseline-failures.txt` present); the campaign dirs live on
  the operator's machine. Correlation above rests on campaign names +
  commit timestamps, not per-case evidence. If the campaign dirs are
  recovered, the W0.1 evidence timestamps under each campaign will
  pin the exact run; the mechanism is identical either way.

### Containment inventory (grep, var/ + node_modules excluded)

| Site | Command | Global write? | Containment |
|---|---|---|---|
| `cases/hooks/run-w0.1:24-26` | `git config --global user.name/user.email/commit.gpgsign` | **YES** | Controller-contained ONLY; **fail-open under direct invocation / uncontained HOME** — the breach writer |
| `cases/hooks/run-w0.1:22-23` | `GIT_CONFIG_GLOBAL=$HOME/.gitconfig`, `GIT_CONFIG_NOSYSTEM=1` | (scoping) | Write target follows `$HOME`; harmless iff HOME is contained |
| `fixtures-src/tt-go/build-golden.sh:69-72` | `git config user.name/user.email/commit.gpgsign/tag.gpgsign` | no (repo-local) | Can only write the fixture repo's `.git/config`; invoked via `tt-golden-bootstrap` (inherits caller env — same-class gap, cannot reach `~/.gitconfig`) |
| `fixtures-src/tt-python/build-golden.sh:80-84` | same, repo-local | no | same |
| `fixtures-src/tt-python@master/build-golden.sh:74-77` | same, repo-local | no | same |
| `fixtures-src/tt-rust/build-golden.sh:68-71` | same, repo-local | no | same |
| `bin/tt-chaos.test.sh` (×4 blocks) | `git config user.name/user.email` | no (repo-local) | ephemeral test repos under test isolation |
| `bin/regenerate-fix-patch.test.sh` (×9 blocks) | `git config user.name/user.email` | no (repo-local) | ephemeral test repos under test isolation |
| `bin/tt-provision-home` | writes `$TT_HOME/.gitconfig` via heredoc (no `git config`) | — | writes only the contained TT home by construction |
| `oracles/lib/git.mjs:38-53`, `oracles/lib/o8.mjs:174` | pins `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG=/dev/null` | — | fail-closed: no oracle git run can read/write any global config |
| `scenarios/w4.25/*.mjs` (3 sites) | pins `GIT_CONFIG_GLOBAL: "/dev/null"` | — | fail-closed daemon spawn env |

### The 14 mis-authored commits (NOT rewritten)

The dev-repo main line carries 14 commits authored
`Tamandua Tier-0 <tier0@tetradactyla.invalid>` (2026-08-06 00:12 →
2026-08-07 21:40): `bac0bee6, 84eac93d, dfffa00c, 2d3a48ed,
f12f9411, 0eace5fb, 86729269, 3ab960f4, 92494f54, fe1fe74c,
dafab91b, 1742f9c2, 4075a53a, 8399c89e`. The FIX8 side branch
(`feature/fix-sweep-timer-leak-fresh-home`) additionally carries
`d2a272b1, 2041ae29, 2ae67695, 0d1c08c9`. Per the FIX10 hard
constraints these commits are NOT rewritten; the operator identity was
restored by hand (`~/.gitconfig` mtime 2026-08-07 21:46:18, matching
FIX10 task creation `5c2aa8fa` at 21:46:42; `f3406994` (2026-08-09)
is authored correctly). `~/.gitconfig` must never be touched by this
work.

### US-002 hardening (2026-08-09): tier0 hooks now fail closed unless HOME is contained

The historical inventory above is preserved verbatim (it describes the
breach-time state). Since US-002, the leak surface is closed:

- New shared guard `torture-test/cases/hooks/containment-guard.sh`: asserts
  `$HOME` is a real (realpath-resolved) directory STRICTLY inside
  `torture-test/var`; on violation prints a loud, HOME-naming
  `CONTAINMENT VIOLATION` error and exits 2 — before any seeding, any git
  config write, or any `npm run build`/`npm test` (zero tokens).
- `cases/hooks/run-w0.1` and `cases/hooks/run-w0.2` both `source` the guard
  immediately after their env-unset block. The `--global` git-config writes
  moved from lines 24-26 to lines 50-52 of run-w0.1 (the guard sits above
  them; ordering is pinned by self-test).
- Belt-and-suspenders in run-w0.1 after the guard: `GIT_CONFIG_GLOBAL`
  parent must resolve inside var; a `.gitconfig` that is a symlink escaping
  var (e.g. to the real `~/.gitconfig`) or not a regular file aborts the
  hook with the same loud error.
- Direct developer invocation (`bash torture-test/cases/hooks/run-w0.1`)
  — the FIX8 acceptance path that exposed the breach — now refuses to run
  with the operator's real HOME instead of writing to `~/.gitconfig`.
- New self-test `torture-test/self-tests/tier0-hook-home-containment.test.ts`
  (6 tests, wired into `self-tests/run.sh` via the existing `tier0-*.test.ts`
  glob): real-HOME refusal for both hooks, contained-HOME success (stub
  npm, zero tokens), guard ordering, guard unit cases (var itself, sibling
  outside var), and the symlink/non-file belt-and-suspenders refusals.
  The test snapshots the real `~/.gitconfig` sha256 before and after and
  asserts it is unchanged.

### US-003 hardening (2026-08-09): controller and tt-hook-runner fail closed with a contained HOME for every spawn

US-002 closed the HOOK side (run-w0.1/run-w0.2 refuse under an uncontained
HOME). US-003 closes the CONTROLLER side so a misconfigured env can never
silently hand the operator's real HOME to any spawned child:

- New shared choke-point primitive `torture-test/bin/tt-containment.mjs`
  (`assertContainedHome`): asserts a HOME resolves (realpath) STRICTLY inside
  `torture-test/var` — mirrors the US-002 bash guard semantics, including
  the not-yet-provisioned-home case (a fresh checkout spawns children before
  `var/home-scripted` exists; the nearest existing ancestor is judged, which
  is still `var`). Any violation throws an error with
  `code = TT_CONTAINMENT_VIOLATION`.
- `tt-controller loadSpawnEnvironment` now asserts the merged printed env's
  HOME after the merge; a violation throws and the existing callers convert
  it to `TEST_INFRA_FAIL` category `spawn-environment` (fail closed, never
  fall through).
- Single choke-point `assertContainedSpawnEnv(childEnv)` guards EVERY spawn
  site: `runHook` (reset/command/launch/stop/wait/oracle hooks),
  `runDurableLocalCommand` (durable command runner), `runCaseO9TargetedProbes`,
  `runCaseOracles` (oracle executables), `initializeLocalTokenLedger`,
  `resolveShortRunId`, `queryWorkflowStatus`, and
  `queryWorkflowDatabaseEvidence`. A violation aborts the case as
  `TEST_INFRA_FAIL` with the precise category `containment-violation`
  (mapped in `executeEligibleCases`). The controller's OWN process still
  runs under the real home (spec 01) — only spawned children are constrained.
- `tt-hook-runner` derives `torture-test/var` from its own file location and
  refuses (exit 2, clear stderr message naming the offending HOME) when its
  `process.env.HOME` is not contained — closing the fail-open path where the
  runner is invoked outside the controller (direct developer invocation).
- New self-test `torture-test/self-tests/tier0-controller-home-containment.test.ts`
  (7 tests, auto-wired via the `tier0-*.test.ts` glob): runner refusal with
  the real HOME (exit 2, no spawn, no evidence side effects), runner success
  with a contained HOME, unit tests of `assertContainedHome`
  (operator home / var itself / sibling / nonexistent-under-operator /
  unset / missing root rejected; existing + not-yet-existing + symlink
  contained homes accepted), and static proofs that `loadSpawnEnvironment`
  asserts after the env merge, every spawn-bearing function in the controller
  passes through the choke-point, and the runner asserts before its spawn.
  The test snapshots the real `~/.gitconfig` sha256 before and after and
  asserts it is unchanged.

### US-004 hardening (2026-08-09): scenario setup scripts and daemon-control containment

US-002/US-003 closed the hook and controller sides. US-004 closes the
SCENARIO and daemon-control side so scenario-based cases can never hand the
real operator HOME to anything that could write git identity:

- New shared guard `torture-test/scenarios/lib/scenario-containment-guard.sh`
  (self-locating var root, realpath comparison, mirrors the US-002 bash
  guard): refuses (exit 2, HOME-naming error) unless `$HOME` is a real
  directory STRICTLY inside `torture-test/var`.
- Every `scenarios/*/run.sh` (33 files: w0.9, w2.21, w2.23a/b/c, w4.25,
  all 24 w4.35 cells, all 3 w4.49 arms) sources the guard before `exec` — a
  scenario invoked OUTSIDE the harness (direct developer invocation with the
  operator HOME) now fails closed instead of running against the real home.
- `run-scripted-scenario`'s command child wrapper sources the same guard
  before executing scenario code (belt-and-suspenders at scenario-code-run
  time), and the harness still fails any scenario whose env script resolves
  HOME outside `torture-test/var` before any command/daemon work.
- `bin/daemon-control` gains `guard_kind_containment`: before ANY operation
  it resolves the kind's HOME and `TAMANDUA_STATE_DIR` (from `env_for_kind`,
  realpath, walking up to the nearest existing ancestor for
  not-yet-provisioned fresh-checkout homes) and refuses — fail closed —
  unless both are STRICTLY inside `torture-test/var`; var itself as a live
  HOME is refused. Wired into `main()` after `guard_kind_cwd`.
- The real-HOME handoff in `daemon_control()` (and the scenario executables'
  daemon-control calls) is DOCUMENTED AS SAFE in `run-scripted-scenario` and
  `scenarios/README.md`: daemon-control uses the operator HOME only for its
  production-guard derivation (`REAL_TAMANDUA_STATE`, `is_production_cwd`),
  performs no git/config writes itself (grep-verified), spawns every child
  under `env -i $(env_for_kind <kind>)` (contained env), and now refuses
  kinds whose spawn env escapes var.
- `scenarios/w0.9/run-install-shape.mjs` daemon-control stop now passes the
  operator home (like every other scenario + the harness) so the local
  barrier actually works instead of silently no-op'ing under daemon-control's
  fail-closed refusal with the contained HOME.
- New self-test `torture-test/self-tests/tier0-scenario-containment.test.ts`
  (7 tests, auto-wired via the `tier0-*.test.ts` glob): guard unit cases
  (operator home / var itself / sibling / unset refused; contained accepted),
  harness refusal of an escaping-HOME env script before any command/daemon
  work, harness success with a contained HOME, static proof that the command
  child wrapper and every scenario run.sh source the guard before exec,
  functional `guard_kind_containment` probes (escaping HOME / escaping state
  dir / var itself refused; contained + not-yet-provisioned accepted),
  static proof that `main()` wires the guard after `guard_kind_cwd`, and the
  `daemon_control()` safety-invariant documentation. The test snapshots the
  real `~/.gitconfig` sha256 before and after and asserts it is unchanged.
- `bin/daemon-control.test.sh` gained source-level assertions for
  `guard_kind_containment`, `resolve_contained_dir`, the `main()` wiring, the
  HOME/TAMANDUA_STATE_DIR loop, the fail-closed `refuse_production` path, and
  the var-itself refusal. Existing scenario self-tests
  (`scripted-scenario-harness.test.ts` 8/8, `scripted-scenario-w4.49-update-transaction.test.ts`
  6/6) keep passing with the new assertions; `npm run build` (tsc) exits 0.

### US-005 hardening (2026-08-10): O18-style operator-identity hygiene canary wired into the controller

US-002/US-003/US-004 made the failure modes LOUD at the point of violation
(guards refuse before any git-config write). US-005 adds the campaign-level
detection net the spec calls for: even a containment leak that slips past a
guard (or a future code path that never got one) becomes a loud
campaign-level FINDING instead of silent contamination.

- New module `torture-test/bin/tt-hygiene-canary.mjs`:
  - Resolves the REAL operator home via `os.userInfo().homedir` —
    deliberately NOT `$HOME`, mirroring the product test guard (spec 01).
    Failure to resolve the home fails closed (throws), never silent.
  - Snapshots sha256 HASHES ONLY (never file contents — privacy) of
    `~/.gitconfig` (required), `~/.ssh/config` if present, and the current
    crontab (`crontab -l`; absent = null).
  - `verifyHygieneCanary(before, after)` returns per-file status
    (UNCHANGED/CHANGED/ABSENT) and HYGIENE_* diffs
    (HYGIENE_GITCONFIG / HYGIENE_SSH_CONFIG / HYGIENE_CRONTAB).
  - Test-only override `TT_HYGIENE_CANARY_HOME` is honored ONLY under
    `TT_CONTROLLER_SELF_TEST=1` (mirrors `resolveOraclesRoot`), so
    self-tests can simulate a breach deterministically.
- `tt-controller` wiring:
  - `startCampaign` AND `resumeCampaign` arm the canary BEFORE case
    execution: `ensureHygieneCanaryBefore(state)` snapshots into
    `state.hygiene_canary.before` and persists. A resumed campaign keeps
    its ORIGINAL baseline (the canary covers the whole campaign lifetime,
    including across resume sessions).
  - `writeTerminalCampaignReports` verifies AFTER every case is terminal:
    recompute the hashes, compare, record `state.hygiene_canary.statuses`
    + `state.hygiene_canary.diffs`, persist, then build the reports. A
    campaign that reaches terminal without a baseline fails closed with a
    `HYGIENE_CANARY_NOT_ARMED` finding.
  - Any hygiene diff forces `verdictExitCode` to FINDINGS (exit 1) — never
    silent. Infra failure (exit 2) still outranks a hygiene finding.
- Reports (`tt-report.mjs`): `report.json` carries a `hygiene_canary`
  object (home, per-file before/after hashes + status, diffs, verified_at);
  `report.txt` renders a `HYGIENE CANARY` section listing each watched
  file's status and any FINDING lines.
- New self-test `torture-test/self-tests/tier0-hygiene-canary.test.ts`
  (10 tests, auto-wired via the `tier0-*.test.ts` glob): module unit tests
  (hashes-only privacy, default-home read-only resolution, ungated override
  refusal, UNCHANGED/CHANGED/ABSENT + HYGIENE_* diffs), report-module tests
  (hygiene diff => FINDINGS exit 1, HYGIENE CANARY section rendering), and
  FUNCTIONAL controller campaigns: a focused scripted campaign with the
  canary armed stays GREEN exit 0 with `gitconfig: UNCHANGED`, and a
  simulated breach (a case command rewriting the watched `.gitconfig`
  mid-campaign) yields FINDINGS exit 1 with a `HYGIENE_GITCONFIG` finding —
  while the case itself PASSes, proving the canary, not the case, trips the
  verdict. Static wiring proofs pin start/resume arming order and the
  terminal verify. The test snapshots the real `~/.gitconfig` sha256
  before/after and asserts it is unchanged (only ever READ).

### US-006 hardening (2026-08-11): grep-proof + tier0 double-gate proof

US-002..US-005 closed every known leak. US-006 adds the MECHANICAL PROOF the
spec's Work item 4 calls for: (a) a grep-proof self-test proving no
`git config --global` executes outside a contained-HOME guard anywhere in
torture-test/, and (b) a full scripted tier0 double-gate showing the HYGIENE
CANARY section with the real `~/.gitconfig` hash byte-identical before and
after.

#### (a) Grep-proof self-test — `self-tests/tier0-gitconfig-containment.test.ts`

New self-test (4 tests, auto-wired via the existing `tier0-*.test.ts` glob in
`self-tests/run.sh`):

1. **Executable-scan proof**: walks every executable file under torture-test/
   (var/, node_modules/, .git/, self-tests/ and documentation/data files —
   .md/.json/.jsonl/.yml/.txt/... — are excluded: docs quote the literal for
   the forensic record but can never execute it) and asserts the ONLY file
   carrying the literal `git config --global` is `cases/hooks/run-w0.1`, with
   exactly the three identity writes observed in the breach.
2. **Ordering proof**: run-w0.1 sources `containment-guard.sh` BEFORE its first
   `--global` write (guard line < write line < `npm run build` line),
   `GIT_CONFIG_NOSYSTEM=1` is set, the write target belt-and-suspenders check
   exists, and the guard file itself never contains the literal.
3. **GIT_CONFIG_GLOBAL assignment proof**: every assignment site in executable
   code is either `/dev/null` (oracles/lib/git.mjs, oracles/lib/o8.mjs,
   bin/tt-verify-environment, all three scenarios/w4.25 spawns) or run-w0.1's
   guarded `$HOME/.gitconfig` (guard sourced before the assignment) — i.e.
   every assignment either points at /dev/null or resolves under var by
   construction.
4. **Functional proof**: run-w0.1 under a contained var home with a stub `npm`
   (zero tokens): exit 0, the tier0 identity lands in the CONTAINED
   `.gitconfig` under torture-test/var, and the real `~/.gitconfig` sha256 is
   byte-identical before/after.

Result: **4/4 PASS** (fresh runs; snapshot of the real `~/.gitconfig` before
and after the whole file asserts zero touch).

#### (b) Tier0 double-gate proof (scripted, zero tokens) — 2026-08-11

The `tier0-repeatability` acceptance now also asserts, per gate, that the
retained report carries the `hygiene_canary` object with `gitconfig` status
`UNCHANGED` (before==after, no diffs) and that report.txt renders the HYGIENE
CANARY section with `- gitconfig: UNCHANGED`; the double-gate additionally
snapshots the REAL `~/.gitconfig` sha256 across both gates and asserts
byte-identity. Ran to completion:

- **Gate 1**: `campaign-20260811T015214173Z-00551540-04d8-4ceb-8f58-88248199d7cf`
  — **GREEN exit 0**, 33 PASS + 2 pending-real, **0 tokens** (wall ~2.4h).
  report.json `hygiene_canary`: gitconfig `UNCHANGED`
  `37efbe30aeb76ac16f9e11c0d2fa3da5b3c133e5c89ba601732d80432d95efa6` ==
  same; ssh_config `UNCHANGED`; crontab `ABSENT`; diffs `[]`. report.txt
  renders the HYGIENE CANARY section before VERDICT.
- **Gate 2**: `campaign-20260811T041638702Z-ab717e36-668b-46e2-96c5-cfdbd4b880f8`
  — **GREEN exit 0**, 33 PASS + 2 pending-real, **0 tokens** (wall ~2.4h).
  Same canary result: gitconfig `UNCHANGED` with the same hash both sides,
  diffs `[]`.

Real `~/.gitconfig` sha256 — recorded before the marathon
(`37efbe30aeb76ac16f9e11c0d2fa3da5b3c133e5c89ba601732d80432d95efa6`), after
gate 1, and after gate 2: **byte-identical in all three snapshots**
(`sha256sum ~/.gitconfig` verified; also asserted by the marathon itself).

#### Regression sweep for the US-006 changes

- New `tier0-gitconfig-containment.test.ts`: 4/4.
- `tier0-repeatability.test.ts`: double-gate marathon 1/1 (~4.8h, GREEN);
  fast assertions 2/2.
- FIX10-related self-tests re-run GREEN: fix10 audit 8/8,
  tier0-hook-home-containment 6/6, tier0-controller-home-containment 7/7,
  tier0-scenario-containment 7/7, tier0-hygiene-canary 10/10,
  tier0-case-manifest 5/5, tier0-doc-host-adaptation-contract 5/5,
  tier0-dry-run-argv-recording 2/2, w4.25-aged-state-fixture 4/4,
  tt-report 10/10, scripted-scenario 14/14, tier1-case-filter 7/7,
  tier1-repeatability 1/1, tier1-controller-provisioning-wiring 3/3,
  tier1-zero-real-launch-infra 1/1, tier1-teardown-policy 9/9,
  tier1-golden-bootstrap 8/8, tier1-fixture-provision 7/7,
  tier1-fixture-probe 1/1, tier1-seed-schema 4/4.
  (The two tier1 failures observed while the npm test ran concurrently pass
   standalone — the same concurrency-interference class documented under
   US-005; not regressions.)
- Full `npm test` via the tamandua-test shim (fresh, non-cached run on the
  US-006 tree): serial + parallel lanes PASSED, 2117 tests / 2115 pass /
  0 fail / 2 skipped.
- `npm run build` (tsc + version injection) exits 0 — typecheck passes.
- Environment after the double gate: no stray controllers/daemons, TT ports
  free, working tree clean, real `~/.gitconfig` untouched.
