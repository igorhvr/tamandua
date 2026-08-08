# 01 — Environment & Isolation

## Host model: one campaign, one host

The campaign runs entirely on **the host it is launched on**. The spec
does not orchestrate machines: no remote transport, no cross-host
synchronization, no multi-machine schedule. Running the suite in several
environments means running the whole campaign several times — that
choice, and any comparison between the resulting reports, belongs to the
operator, outside this spec.

What the spec DOES own is host *adaptation*:

- **W0.0 emits `host-profile.json`** — platform (linux/darwin/other),
  init/containment facilities (systemd user scopes present or not),
  toolchains, node runtimes present, procfs
  availability, process-spawn speed class, disk headroom.

  **CANONICAL host-profile/predicate contract (the ONLY representation; never
  diverge):** toolchains are recorded as an OBJECT keyed by the real
  toolchain name (`python3`, `node`, `go`, `rust/cargo`, `java+maven`), and
  each toolchain's entry carries a **Boolean `present` leaf**,
  `toolchains.<name>.present === true` meaning the toolchain is available on
  this host. Harness capabilities `pi`/`hermes` are RECORDED as mechanical
  **presence** under `harness.<name>.present` (spec 01 makes pi/hermes
  operator-preconfigured: W0.0 records presence, it never installs them;
  the live `--spend` probes additionally record `authenticated` without
  overwriting the presence leaf).
- **Every manifest case may carry a `requires` predicate** (
  `platform` and/or `toolchains` and/or `capabilities`). Each toolchain
  predicate is satisfied **iff** `host-profile.json` records
  `toolchains.<name>.present === true`; a `capabilities` predicate entry
  (`pi`/`hermes`) is satisfied iff the profile records that harness's
  presence. Cases the host cannot honestly satisfy are recorded
  `NOT_RUN (predicate)` with expected/observed evidence — visible in the
  report, never silently skipped
  and never a failure. [darwin]-tagged scenarios in the wave files are
  exactly such predicates: the portability defect classes (DC30, DC44 —
  BSD userland, bash 3.2, `/var`→`/private/var` realpath, kernel-hidden
  env, launchd parenting, slow spawn, absent `/bin/false`) are real
  history and only testable where those conditions exist.
- **Tiers are capability profiles, not machine names.** Tier-1 requires
  {node ≥22, python3}; Tier-2 requires all five language toolchains
  (java+maven, rust, go, python3, node) passing W0.0's build+test probe.
  A host below the target tier either gets provisioned first (**P0** —
  pre-campaign work with its own acceptance test: all fixture baselines
  green twice in a row; toolchain bugs found during P0 are environment
  work, never campaign findings) or the campaign runs at the tier the
  host supports, with the descoped lanes recorded.

### Platform facts the scenarios encode (verify in W0.0, don't assume)

| Fact | Where it bites |
|------|----------------|
| systemd user scopes available (typical linux) | O5's kernel-owned leak census; absent → evidence-based census fallback |
| BSD userland / bash 3.2 / no `/bin/false` (typical darwin) | shim + shell-string scenarios, W4.21 |
| `/var` → `/private/var` realpath (darwin) | path-normalization scenarios W4.22, TSTX keying |
| kernel hides other processes' env (darwin) | recorder/census must use cmdline/cwd/lsof evidence, never env |
| slow process spawn (observed on darwin hosts) | serial-lane deadlines; W0.4 records per-suite durations and scales caps |
| multiple node runtimes coexisting (e.g. nix node 24 + a vendored v22) | W0.1 dual-runtime check, W4.23 runtime-swap scenario |
| node via version-manager shims keyed on HOME (Volta: `~/.volta/bin/node` resolves per-HOME; nvm similar) | the TT spawn env overrides HOME, so shims die ("Node is not available", rc=126) — env scripts pin the REAL node binary dir on PATH + export VOLTA_HOME (incident: 21 daemon-control self-test failures, 2026-07-31) |

### Nix-first self-provisioning (target end-state for P0)

The suite's only hard environment prerequisite should be **nix** (plus
git and a POSIX shell). W0.0 grows a `--provision` mode: instead of
merely FAILing missing-toolchain checks with a remedy string, it
installs them via nix from a **pinned declarative manifest**
(`torture-test/env/nix-prereqs`) — which thereby becomes the single
authoritative inventory of everything the suite needs. Fresh-environment
bring-up is then: install nix, clone, `run-torture-test`.
Ad-hoc installers (rustup, brew, apt) are not used by the suite; a
toolchain already present outside nix is accepted if its probe passes,
but the remedy for any gap is always the nix manifest.

**Carve-out — the harnesses.** `pi` and `hermes` can NOT be provisioned
by nix and are the operator's responsibility: the torture-test user MUST
pre-install and pre-configure both (binaries resolvable, credentials
valid) before any token-bearing tier. W0.0 verifies them (presence
mechanically; auth via the live `--spend` probes) but never installs or
configures them; a missing/unauthenticated harness is a hard REQUIRED
failure with a remedy that says "configure it yourself", not a
provisioning action. `--provision` therefore covers toolchains and
utilities only. (Motivating
incident: the first W0.0 execution found an x86_64 rustup cargo on an
arm64 host — dead weight nix replaced in one command.) Sequenced after
the core implementation phases; tracked in bd.

## The torture environment (TT env)

Never run the suite against the live install. Layout:

```
TT_ROOT   = ~/tamandua-torture           # all torture state
TT_HOME   = $TT_ROOT/home                # HOME for SPAWNED tamandua processes
fixtures  = $TT_ROOT/fixtures            # golden bares + working clones (02)
results   = $TT_ROOT/results/<wave>/     # harvested JSON, DB snapshots, logs
tasks     = spec repo tasks/             # task-text library (02)
```

### Two envs, not one (load-bearing distinction)

- **Spawn env** (`tt-env.sh`): applied to every tamandua daemon/CLI/harness
  process the controller launches. Overrides HOME.
- **Controller env**: the controller itself (and `tt-chaos`) runs under
  the REAL home — it needs its own tooling, profile hooks, and package
  manager paths — and passes the spawn env per-command
  (`env HOME=... TAMANDUA_...=... tamandua ...`). Sourcing `tt-env.sh` into
  the controller's own shell would sever the operator's profile hooks; the
  first draft of this spec made exactly that mistake.

`tt-env.sh` (spawn env):

```sh
export HOME="$TT_HOME"
export TAMANDUA_STATE_DIR="$TT_HOME/.tamandua"
# Do NOT also set TAMANDUA_DB_PATH / TAMANDUA_WORKTREE_ROOT: the code
# DERIVES them (db path, worktree root, pid/port files, daemon secret,
# lifecycle log all key on HOME/STATE_DIR). Setting both invites
# split-brain the day one is edited and the other isn't.
export TAMANDUA_CONTROL_PORT=4339
export TAMANDUA_MCP_PORT=4338
export TAMANDUA_DASHBOARD_PORT=4334
export HERMES_HOME="$TT_HOME/.hermes"
export TAMANDUA_TEST_GUARD=1   # see tripwire note below
```

### Two daemons, not one (scripted scenarios need their own)

There is **no per-run harness-binary override** — `TAMANDUA_PI_BINARY`/
`TAMANDUA_HERMES_BINARY` are resolved from the *daemon's* env at spawn
time. Scripted (zero-token, deterministic-agent) scenarios therefore
cannot share the real-harness daemon. The TT install runs TWO daemons:

- **Real daemon** — `tt-env.sh` above, ports 43xx, real pi/hermes.
- **Scripted daemon** — `tt-env-scripted.sh`: its own fake HOME + state
  dir, ports **5334/5338/5339**, `TAMANDUA_PI_BINARY` → the scripted-pi
  wrapper, `TAMANDUA_HERMES_BINARY` → scripted-hermes + its own fake
  `HERMES_HOME` state.db; during hermes-only scripted scenarios pin
  `TAMANDUA_PI_BINARY=/usr/bin/false` so accidental pi spawns fail loud.
  The scripted runtime `.mjs` files have no shebang — wrappers use
  absolute node paths (daemon PATH is not guaranteed).
- **Behaviors concurrency protocol:** the runtime reads ONE behaviors
  file fixed at daemon start, keyed by short agent id with shared
  counters — concurrent scripted scenarios on the same workflow would
  collide. Bootstrap installs **scenario-unique workflow copies**
  (`bfmw-w414`, `bfmw-w427`, …) into the scripted env and keys the merged
  behaviors file by full `<workflowId>_<agentId>`; no two scripted
  scenarios ever share a workflow id.
- **W0 binding proof (blocking):** one trivial scripted do-now on the
  scripted daemon must spend zero real tokens and match its behaviors
  file — a scripted daemon that silently resolved real pi would burn real
  tokens through every scripted scenario and invalidate them all.

### TT_HOME provisioning checklist

- `$TT_HOME/.gitconfig` — **required**: user.name/user.email,
  `commit.gpgsign=false`, `init.defaultBranch=main`, `pull.ff=only`.
  Without it every agent `git commit` dies at minute 20 of hour one
  ("Please tell me who you are"). Repo-local config in fixtures is a
  belt-and-suspenders addition, not a substitute.
- `$TT_HOME/.pi/` — copy (not symlink) of `~/.pi` (settings + auth), so
  agents cannot mutate the real one. Audit the copy for absolute paths
  pointing at the real HOME and rewrite them. Document each harness's
  actual install location and auth mechanism on THIS host in
  `results/manifest.json` BEFORE T+0 — "fix it in the copy" is not a
  procedure; W0.5 verifies but must not discover.
- `$TT_HOME/.hermes/` — copy of `~/.hermes`; `probeHermesStateContract()`
  must pass in W0. Hermes attribution reads `$HERMES_HOME/state.db`
  (input+output+cache_write; cache_read excluded).
- No `$TT_HOME/.ssh` unless a scenario explicitly needs one (fixtures are
  local-only; the unreachable-origin scenario W4.26 wants ssh to FAIL).

### Known knobs and traps

- **HOME override is the primary isolation mechanism** — several
  resolutions are HOME-keyed, not `TAMANDUA_STATE_DIR`-keyed. Overriding
  only TAMANDUA_* vars is insufficient.
- **`get-ready` ignores `TAMANDUA_DASHBOARD_PORT`** (it calls the dashboard
  starter with a hardcoded 3334 argument, and the explicit arg outranks the
  env var — verified in source; daemon and MCP honor their env vars). This
  is a pre-registered product finding (DC45-adjacent; file it) AND an
  operational hazard: under TT env, get-ready will collide with, or worse
  *bind*, production's 3334. Procedure: run `get-ready`, then under the
  spawn env `tamandua dashboard stop || true` followed by a small retry
  loop around `tamandua dashboard start --port 4334` (the get-ready-spawned
  dashboard may still be initializing and slow to stop; a bare
  `stop && start` chain can wedge on that race), then verify nothing
  TT-owned listens on 3334.
- **TAMANDUA_TEST_GUARD=1 as a free tripwire:** the guard trips on opening
  the real `~/.tamandua` (it checks `os.userInfo().homedir`, deliberately
  not `$HOME`) and on production-port binds — converting any isolation leak
  into a loud error instead of silent contamination. Caveat verified in
  W0.6: confirm it does not false-positive on TT paths (TT_ROOT lives
  under the real home) and that the get-ready dashboard workaround above
  still functions under the guard. If the guard proves too aggressive for
  production-shaped operation, drop it and rely on O15 — record the
  decision in the manifest.
- `TAMANDUA_MAX_ACTIVE_TIMERS` is env-settable (default 50) — the storm
  pins it (09).

## Build & install discipline

Historical incidents: stale `dist/` killed a run with 1.56M tokens of pure
expects rejections; a frozen installed catalog ran May YAML in July while
printing "installed".

Mandatory on the host before W0 and after any mid-campaign fix
(never mid-run):

1. Source checkout clean (`git status`); record `TT_COMMIT` in
   `results/manifest.json`.
2. `./build` → `npm test` (either fails → abort; this is the product's own
   gate, not ours).
3. Spawn-env `tamandua get-ready` (+ dashboard port workaround above);
   catalog stamp must equal `TT_COMMIT`'s build version, else
   `tamandua update --force`.
4. `tamandua doctor` in TT env → zero errors (warnings triaged, logged).
5. Kill zombie tamandua/pi/hermes processes from previous campaigns —
   evidence-based match (cwd/cmdline under `$TT_ROOT`), never name-only.

### Production-daemon posture (decide and record before T+0)

Preferred: **stop the host's production daemon for the campaign**
(production runs quiesced first — no running/scheduling rows). This
upgrades O15 to strict zero-write checking. If it must stay up, O15
runs in logical-comparison mode; the decision is recorded in
`results/manifest.json`. Shared harness config (`~/.pi` originals, real
`~/.hermes`) is snapshotted at W0 as part of the O15 surface regardless.

### Daemon containment

Where the host provides systemd user scopes, the TT daemons start inside
dedicated `systemd-run --user --scope` units via the controller's
`daemon-control` wrapper — O5's kernel-owned leak census depends on it,
and the wrapper is the ONLY sanctioned start/restart path (a bare
`tamandua restart`, including the storm's chaos restart, would detach the
new daemon from the scope and silently void the containment layer; the
wrapper re-asserts cgroup membership after every start). Hosts without a
scope layer (e.g. darwin) fall back to cmdline/cwd/lsof evidence — the
weaker guarantee is recorded in the host profile.

## Isolation probe (blocking gate, W0.6)

1. Snapshot the host's production state: sha256 of
   `~/.tamandua/tamandua.db`, byte counts + mtimes of events/log files,
   production pi/hermes PID list, listeners on 3334/3338/3339.
2. Run one scripted-agent workflow inside the TT env (zero tokens).
3. Re-snapshot: byte-identical DB, no new events, no log growth from the TT
   run, no signals to production daemons, zero TT-owned listeners or
   connections on production ports.
4. Any drift → campaign blocked; the leak is itself a product bug (DC27).

## Provider reality

- Provider failures (rate limit / 5xx / auth) classify `PROVIDER_FAIL`
  (03): one retry after backoff, excluded from stats, never a strike.
- Launch stagger ≥60s within a wave (except W5, where the burst is the
  point). Outage playbook in 11.
