# Matchlock dsh Production Qualification Recipe

This document is the operator recipe for the **real** DeepSeek Harness (`dsh`)
under Matchlock (`--matchlock <image> --dsh-as-harness`) path delivered by the
MTLK-DSH-EXEC slice. It records the observed runtime identity (version and
sha256 hashes, unpinned), the exact
synthetic qualification already performed, the real-vs-synthetic coverage
boundary, and the work that remains before this path is production-qualified.

> **Status: synthetic-fixture qualified, NOT real-dsh acceptance.** The
> delivery so far passed an actual fresh-VM, ZERO-PROVIDER whole-path gate for
> both supported workflows using an image-provided dsh-shaped fixture and a
> test-only derived image. No real model, credential, provider or network call
> has been qualified. The real `igorhvr/bedlam-ubuntu` image/tag was never
> overwritten or replaced.

## 1. Supported scope in this build

| Axis | Supported |
|------|-----------|
| Opt-in | `--matchlock <image>` only (no env/YAML/agent-output/MCP/API activation) |
| Harnesses | `--pi-as-harness` (default), `--hermes-as-harness` and `--dsh-as-harness` are all admitted with `--matchlock` (MTLK-INTEGRATE union); this recipe covers the `--dsh-as-harness` slice |
| Workflows (this dsh slice) | `do-now`, `do-review-do-verify` |
| Isolation | one **fresh** Matchlock VM per launch probe and per work round |
| Guest harness | the **image's** dsh; no host dsh/findBinary/probe/spawn, no native fallback |
| Guest argv | `dsh --profile headless <prompt>`; stdin EOF; plain-text stdout; two `--` separators when the prompt starts with `-` |
| Guest env | `DSH_HOME=/workspace/config/dsh`, `DSH_PERMISSION_MODE` forced inside isolation |
| DSH_HOME (guest) | `/workspace/config/dsh` — unchanged |
| DSH_HOME mount | ONE `host_fs` RW destination at the guest root, sourced from the private per-run effective home (see §2): the private `profiles/` copy plus one real entry per durable host entry, so the home root is real, writable and fsync-able; boot siblings such as `profiles/node_modules.lock` are writable and private |
| Guest PATH | image's declared PATH preserved + only the helper-pack bin prepended |
| Usage | integer single count of `inputTokens + outputTokens`; `data.stream` mirror never summed; unavailable/ambiguous/truncated reported honestly, never fabricated as zero |

Explicitly **unsupported** in this build (refused before any VM/probe/native
harness starts): `just-do-it` child orchestration, PR/browser shapes,
quarantine, and every other workflow id outside the admitted set. Merge shapes
are additionally refused for the `dsh` and `hermes` harnesses; the `pi` harness
admits the four merge workflows. The two-workflow dsh milestone is not
completed overall workflow support.

## 2. Composed DSH_HOME mapping (DSH-PROFILE-OVERLAY / DSH-OVERLAY-FSYNC-FIX)

`DSH_HOME` is **unchanged** in the guest: it stays `/workspace/config/dsh`.
What changed is the host side: the guest home is mounted as **ONE** `host_fs`
read-write destination at the guest configuration root, sourced from a private,
host-attested per-run **effective home**. The effective home is a real host
directory carrying the private `profiles/` copy plus one real entry for every
durable top-level host entry, so the guest `$DSH_HOME` root itself has a real
host provider and every durable entry inside it is writable and `fsync`-able
(see "Why the previous mapping could not fsync").

### Final layout

| Real top-level entry | Host source (per-run effective home) | Guest destination | Writable / `fsync`-able |
|----------------------|-------------------------------------|-------------------|-------------------------|
| `$DSH_HOME` root | `<overlayRoot>` — the ONE mounted source | `/workspace/config/dsh` | **yes** — the single mount source is a real host directory, so `fsync`/`fdatasync` on the opened home root succeeds |
| `.credentials.yaml` | hard link `<overlayRoot>/.credentials.yaml` → `<hostHome>/.credentials.yaml` (byte copy with the source's mode on cross-device `EXDEV`/`EPERM`/`EACCES`/`EMLINK`) | `/workspace/config/dsh/.credentials.yaml` | **yes** — regular host-backed file; guest refreshes write through the shared inode and are published back |
| `.anonymous-user-id` | hard link/copy `<overlayRoot>/.anonymous-user-id` | `/workspace/config/dsh/.anonymous-user-id` | **yes** |
| `sessions/` | EMPTY real directory `<overlayRoot>/sessions` — host session contents are never read or copied | `/workspace/config/dsh/sessions/` | **yes** — real directory; new `sessions/<projectKey>/session-<uuid>/session.v3.jsonl.zstd` artifacts are merged back to the host after the round |
| `storages/` | EMPTY real directory `<overlayRoot>/storages` — host caches are never read or copied | `/workspace/config/dsh/storages/` | **yes** — real directory; new `storages/session_projcache/sessions/session-<uuid>.json` records are merged back |
| any other durable top-level entry (`credentials/`, unknown files and directories) | recursively hard-linked (copy fallback) `<overlayRoot>/<entry>` | `/workspace/config/dsh/<entry>` | **yes** |
| the **whole** `profiles/` directory | **private** per-run staged overlay copy `<overlayRoot>/profiles` (durable config staged, install-derived dirs empty); the host `profiles/` tree is never mounted, read or written | `/workspace/config/dsh/profiles/` | **yes** — real directory; the guest heals the farm and creates the sibling `profiles/node_modules.lock` privately |

`prepareDshProfileOverlay` stages the effective home before the VM is created
and `planDshHomeMounts` emits exactly that ONE destination.
`cleanupDshProfileOverlay` removes exactly that attested root only after a
wire-confirmed VM close (best-effort on dispose). After the close,
`publishDshHomeOverlayToHost` merges every durable effective-home entry EXCEPT
`profiles/` back to the real host home, so the host-side pre/post session
inventory sees the round's new records. Only the `profiles/` tree is private
and never host-published.

The private effective home is deterministic and host-attested:

```text
<liveStateRoot>/matchlock/dsh-profile-overlays/<bareRunId>/
    .credentials.yaml                  # hard link / copy of the durable host file
    .anonymous-user-id                 # hard link / copy of the durable host file
    sessions/                          # EMPTY at boot; guest-created records merge back
    storages/                          # EMPTY at boot; guest-created records merge back
    <any other durable entry>          # recursive hard-linked tree (copy fallback)
    profiles/                          # private per-run copy: the ONE profiles/ source
        node_modules/                  # EMPTY at boot; the guest heals it from its own install
        node_modules.lock              # dsh's transient boot writer lock (guest-created)
        <profile>/
            package.json               # durable config, copied byte-identically from the host
            cordis.patch.yml           # durable config, copied byte-identically from the host
            pnpm-workspace.yaml        # durable config, copied byte-identically from the host
            node_modules/              # EMPTY at boot; guest-owned
            .dsh-module-fallback/      # EMPTY at boot; guest-owned
                node_modules/          # EMPTY at boot; guest-owned
```

`prepareDshProfileOverlay` stages that effective home **before** the VM is
created: every durable host profile file is copied byte-identically, every
install-derived directory is created EMPTY and never descended into, a host
without a `profiles/` directory still yields a real empty private `profiles/`,
host durable top-level entries are hard-linked (or copied), and
`sessions/`/`storages/` become empty real directories. A symlinked or special
host/staged entry is refused fail-closed. Because the private install-derived
dirs are empty at boot, the guest's own dsh heals them from the guest install
(`composeProfile` → `healProfilesModuleFallback`), so its links resolve inside
the VM.

### Why the previous mapping could not fsync

The #34 plan emitted five per-durable-entry destinations directly under
`guestConfigurationRoot` (`.anonymous-user-id`, `.credentials.yaml`,
`profiles`, `sessions`, `storages`). Matchlock promotes the PARENT of every
single-FILE `host_fs` destination to a FUSE mountpoint
(`exactFUSEMountpoints`: `filepath.Dir(guestPath)`) and then
`selectNonNestedMountpoints` keeps only the shallowest, so the whole
`/workspace/config/dsh` became ONE synthetic FUSE MountRouter root. That
synthetic directory has no real host provider, so dsh's
`syncDirPosix(dirname(sessionsRoot))` → `fsync(<DSH_HOME>)` returned `ENOENT`
on the home root.

The exact failing syscall was captured in a contained VM against a real-layout
`DSH_HOME` (the vaimetal run #35 shape) with dsh boot instrumented by a Node
`fs` interposer (guest `strace -f` is present but `PTRACE_TRACEME` is denied in
the qualified guest):

| Field | Value |
|-------|-------|
| Syscall | `fsync` |
| fd | `26` |
| errno | `ENOENT` |
| Exact guest path | `/workspace/config/dsh` (the `$DSH_HOME` ROOT itself) |
| Trace method | `guest-node-fs-shim` (`strace` probe recorded as `PTRACE_TRACEME: Operation not permitted`) |
| Observed guest mount table | ONE `matchlock` FUSE mount at `/workspace/config/dsh` |
| Plan reconciliation | 5 per-entry destinations → `planReconciliation.matches=false` |

The diagnosis JSON is retained outside the repo at
`/home/kaladin/matchlock-work/dsh-fsync-diagnosis.json`; the trace and full
mount table are under
`/home/kaladin/matchlock-work/evidence/dsh-fsync-diagnosis-20260917T202158Z/`.

### The fix (why the shipped mapping is ONE root mount)

A per-entry plan cannot be repaired by adding a destination for the home root
itself: nested destinations are runtime-rejected (matchlock 0.2.17 `create`
refuses `mount destination %q collides with (is nested inside) %q`, even for
same-source nesting and even when the outer destination is `type:"memory"`).
The only runtime-valid shape is **ONE real host-backed root mount**:

- `prepareDshProfileOverlay` stages the per-run EFFECTIVE HOME under
  `<liveStateRoot>/matchlock/dsh-profile-overlays/<bareRunId>` (hard-linked
  durable files, empty `sessions/`/`storages/` real directories, the private
  `profiles/` copy);
- `planDshHomeMounts` emits exactly ONE
  `{ guestConfigurationRoot -> overlayRoot }` `host_fs` RW destination, so the
  home root has a real provider and `fsync` succeeds while the private
  `profiles/` copy inside it is still the only profiles source;
- `publishDshHomeOverlayToHost` merges guest-written durable entries (never
  `profiles/`) back to the real host home on teardown.

Two host-side properties are pinned without a VM: `fs.openSync(dir, "r")` +
`fs.fsyncSync(fd)` succeeds on the effective-home root and a fresh
subdirectory, and the host `profiles/` tree is byte-identical before/after
`prepare`+`plan`.

### Why #34's gates missed the home-root `fsync`

The #34 real-boot gate staged the minimal zero-provider `stageGateOwnedDshHome`
fixture, whose `.credentials.yaml` was mode 0644 with a flat `providers: {}`
document. dsh's `credentials-local` boot rejects that as the pre-release flat
layout (and refuses a credentials file readable beyond its owner), so the boot
died at the credentials check BEFORE ever reaching the profile/session phase
that performs `fsync(<DSH_HOME>)`; the per-entry plan's synthetic home root was
therefore never exercised. The real operator home has the full layout (many
`sessions/<cwd-hash>/` directories, `storages/`, the profile module farm and a
valid 0600 `.credentials.yaml`). US-004 now stages an operator-shaped
real-layout fixture with a 0600 comment-only credentials store, so the boot
reaches the home-root `fsync` and the gate can assert it no longer fails.

### Every path dsh touches under `profiles/`

Read from dsh's own profile module on this host
(`~/idm/deepseek-harness/packages/boot/app-boot/src/profile.ts`
`composeProfile` → `healProfilesModuleFallback` → `healProfileModuleFallback`,
and `packages/util/atomic-write/src/index.ts` `withFileLock`):

| Path under `$DSH_HOME` | Who writes it | Kind |
|------------------------|---------------|------|
| `profiles/` | `resolveProfileDir` / `join(home, PROFILES_DIR)` | directory |
| `profiles/node_modules` | `healProfilesModuleFallback` (`mkdirSync(..., {recursive:true})`) | install-derived symlink farm |
| `profiles/node_modules.lock` | `withFileLock(modulesDir)` — a `wx`, mode `0o600` sibling `${filename}.lock`, removed in its `finally` | transient boot lock |
| `profiles/<profile>/` | `resolveProfileDir(name)` | profile directory |
| `profiles/<profile>/package.json` | `readProfileManifest` / `writeProfileManifest` | durable config |
| `profiles/<profile>/cordis.patch.yml` | `PROFILE_PATCH_FILENAME` user patch layer | durable config |
| `profiles/<profile>/pnpm-workspace.yaml` | pnpm workspace settings read by the profile loader | durable config |
| `profiles/<profile>/node_modules` | `healProfileModuleFallback` (`mkdirSync(..., {recursive:true})`) | pnpm-managed + projected links |
| `profiles/<profile>/.dsh-module-fallback/` | `PROFILE_MODULE_FALLBACK_DIR` (`mkdirSync`) | install-derived |
| `profiles/<profile>/.dsh-module-fallback/node_modules` | `healProfileModuleFallback` (`mkdirSync`) | install-derived |

### Why the private `profiles/` copy covers every path

Every one of those paths is an entry of, or a sibling inside, the single
`profiles/` directory. That ONE directory is a real, writable, fsync-able
directory inside the mounted effective-home root, so the guest can:

- create `profiles/node_modules` and every profile-relative install-derived
  directory (they are ordinary entries of the writable private tree);
- create and lock the SIBLING `profiles/node_modules.lock` — the exact write
  that failed vaimetal run #32 — because the parent `profiles/` is a real,
  writable guest directory owned by the private overlay (not merely guest-only
  scaffolding for a nested mount, and not a read-only host-backed parent);
- keep the durable config files visible at their host-identical contents while
  every write stays private.

The #31 plan emitted only per-child destinations (`profiles/node_modules`,
`profiles/<profile>/node_modules`, `profiles/<profile>/<config>` …) and never a
destination for `profiles/` itself, so the sibling lock path had no writable
private parent: run #32's real dsh boot died with
`Error: ENOENT: no such file or directory, open '/workspace/config/dsh/profiles/node_modules.lock'`
(`withFileLock` → `writeFile` → `open`, after
`healProfilesModuleFallback`'s own `mkdirSync(profiles/node_modules)`).

The #34 fix made the WHOLE `profiles/` directory its own writable destination.
The DSH-OVERLAY-FSYNC-FIX single effective-home root mount subsumes that: the
private `profiles/` tree is still a real writable directory inside the mounted
root, so the #32 sibling lock keeps working while the #35 home-root `fsync`
also succeeds.

### Why the design doc permits a private copy

The design doc forbids **omitting** profile files: "Do not mount only pi's
settings file, dsh's `headless` profile, or Hermes's YAML file. Do not omit
hidden files, other sessions, or unfamiliar entries from the selected
directory." A staged private copy does not omit anything — every durable
profile entry (hidden files included) is materialized at its host-identical
guest path, so the whole `profiles/` directory is still "mounted" as the doc
requires; only its install-derived writers are redirected. The doc's
installation-link guidance also records that `DSH_HOME/profiles/node_modules`
is re-pointed by every boot and that "guest-created paths persist on the host"
under a direct RW mount; keeping that one install-derived subtree off the host
is exactly the correction the doc asks for ("qualify that behavior … do not hide
the problem by mounting host code, replacing the full home with a snapshot").
Host **durable** categories are host-backed: `credentials/`,
`.credentials.yaml`, `.anonymous-user-id`, `sessions/`, `storages/` and unknown
top-level entries are materialized in the effective home (hard links or empty
real directories) and published back to the host home after the round. Only the
`profiles/` tree is private and never host-published.

### Root cause (why the farm is private)

dsh keeps `$DSH_HOME/profiles/node_modules` as a symlink farm and every boot
re-points it at the **running** install's dependency closure
(`healProfilesModuleFallback`). Host dsh lives under the operator's checkout;
the guest's dsh lives under `/opt/dsh`. With the old single whole-home
read-write mount, each guest boot flipped the farm to guest paths and each
native boot flipped it back. The headless request-extension provider resolves
plugins through that farm at the **first LLM request**, so a request landing
between two flips failed with
`dsh: REQUEST_EXTENSION: DeepSeek request extension preparation failed`
(run #10, reproduced by #26). The operator's own dsh home was churned by every
in-VM round.

### Isolation guarantee

- The guest can **never** flip the host farm: the host `profiles/` tree is not
  mounted at all — the single root destination is the staged private per-run
  effective home (whose `profiles/` entry is that private copy), so guest
  writes land only there (or in the host-published durable entries).
- A **native** dsh boot cannot break a concurrent in-VM round: the host world
  and the guest world heal independent profile trees (the host's own and the
  guest's private copy), so the cross-world ping-pong is impossible.
- The host farm **and the host lock** are byte-identical before and after an in-VM round:
  the private copy contains no host lock (a lock created at
  `profiles/node_modules.lock` exists only in the guest's private tree). The
  invocation path records presence-only pre/post farm snapshots as bounded
  evidence (counts only) and never fails a round on a difference — a concurrent
  native boot legitimately heals the host farm. The controlled gates
  (`e2e-tests/matchlock-dsh-profile-overlay-gate.test.ts` via
  `./run-matchlock-dsh-profile-overlay-e2e-test`, and the real-dsh
  `e2e-tests/matchlock-dsh-real-boot-gate.test.ts` via
  `./run-matchlock-dsh-real-boot-gate-e2e-test`) alternate a native zero-provider
  boot and a real in-VM round (synthetic and real dsh respectively) and assert
  equality.

### Why #31's gates missed the boot-lock failure

The #31 overlay change shipped with a green-looking gate set, but its focused
in-VM gate never executed a single round and its synthetic probe never touched
the failing path:

1. **Both #31 profile-overlay gate runs failed at VM creation.** The two
   retained runs end at the first in-VM round with `matchlock rpc error -32000:
   create VM: create TAP device: TUNSETIFF: operation not permitted`, so the
   synthetic first-request probe never ran inside a VM at all:
   - `/home/kaladin/matchlock-work/evidence/dsh-profile-overlay-20260916T193304Z/gate-run.log` — `rc=1`, assertion `round 1: direct invocation rejected: runMatchlockInvocation: matchlock rpc error -32000: create VM: create TAP device: TUNSETIFF: operation not permitted`;
   - `/home/kaladin/matchlock-work/evidence/dsh-profile-overlay-20260916T221513Z/gate-run.log` — `rc=1`, the identical assertion.
   Both are the developer sandbox's suppressed `cap_net_admin,cap_net_raw` (the
   operator/tester must run real-VM gates outside that sandbox), but the gate
   reported the failure only as a round-rejection assertion — the overlay path
   it was meant to cover was never exercised.
2. **The synthetic first-request probe never attempted the sibling lock.** At
   `434771eb`, `e2e-tests/dsh-fixture/fake-dsh.mjs`'s `runFirstRequestProbe`
   only called `mkdirSync(<DSH_HOME>/profiles/node_modules)` (a path that WAS
   already a mount destination under the per-child plan) and wrote guest
   symlinks into it. It never `open(..., "wx")`ed the SIBLING
   `<profiles>/node_modules.lock` that real dsh's `healProfilesModuleFallback`
   → `withFileLock(modulesDir)` creates, so a missing or non-writable
   `profiles/` parent was invisible to the probe — the probe passed even though
   the sibling lock path was unwritable.
3. **The real-dsh gate was not part of #31's required gate set.** #31's
   required gates were `npm test` and the two synthetic gates
   (`./run-matchlock-dsh-gate-e2e-test`,
   `./run-matchlock-dsh-profile-overlay-e2e-test`), all driven by the
   zero-provider `fake-dsh.mjs` fixture. The real-token real-dsh gate
   (`e2e-tests/matchlock-dsh-real-gate.test.ts`,
   `./run-matchlock-dsh-real-gate-e2e-test`) that actually boots the image's
   real `healProfilesModuleFallback`/`withFileLock` code was not among them, so
   the real boot path was never exercised before vaimetal run #32 hit it. The
   committed regression is the #34 US-005 real-dsh contained boot gate
   (`e2e-tests/matchlock-dsh-real-boot-gate.test.ts`).

### Known limitation

Arbitrary **new** files the guest creates inside `profiles/` are **not**
host-persisted: the whole directory is a private per-run copy, so guest-created
profile content lives only in that overlay. Durable state that must survive
across rounds belongs in the whole-directory durable entries (`sessions/`,
`storages/`, `credentials/`, `.credentials.yaml`, unknown top-level entries).

## 3. Observed runtime identity (unpinned)

The gates are **unpinned**: qualification uses whatever `matchlock` resolves on
`PATH` (the system `/usr/local/bin/matchlock` on vaimetal) and lets matchlock
resolve its own guest-init. `TAMANDUA_MATCHLOCK_RPC_BIN` /
`MATCHLOCK_GUEST_INIT` / `MATCHLOCK_GUEST_FUSED` are **optional overrides**;
an unset guest-init is not a failure. No runner refuses on a hash mismatch.

Each runner records the observed `matchlock --version` and the sha256 of every
resolved binary in `<TAMANDUA_GATE_EVIDENCE_DIR>/runtime-observed.txt` (also
echoed into the gate log), so the exact runtime used by a qualification run is
reproducible from the retained evidence rather than pinned in the scripts.

> **DSH-OVERLAY-FSYNC-FIX US-007 note.** The three gates this round requires
> (`run-matchlock-synthetic-e2e-test`,
> `run-matchlock-dsh-profile-overlay-e2e-test`,
> `run-matchlock-dsh-real-boot-gate-e2e-test`) no longer enforce these pins:
> they resolve the SYSTEM `matchlock`/`guest-init` pair from `PATH` (the
> `TAMANDUA_MATCHLOCK_RPC_BIN` / `MATCHLOCK_GUEST_INIT` /
> `MATCHLOCK_GUEST_FUSED` overrides still win), because vaimetal's qualification
> runtime is the system pair and the legacy accepted-hash pins refused it before
> any VM booted (the #34 `REFUSED-BY-LEGACY-HASH-PINS` finding). The hashes
> above remain the qualification record, and the other legacy runners still
> enforce them.

### Zero-round refusal (observed_rounds)

A green `node --test` is not qualification evidence: a gate whose VMs never
booted, or whose launch probe failed before any work round, can exit 0 without
exercising a single round (the #31 hollow-green failure). Every
`run-matchlock-*` / `run-hermes-synthetic-e2e-test` driver therefore writes an
`observed-rounds.json` evidence file through
`e2e-tests/helpers/matchlock-gate-rounds.ts` — the gate label, the number of
observed VM rounds (`observed_rounds`), and the distinct `vm-<8 lowercase
hex>` ids (`observed_vm_ids`) — and invokes `scripts/observed-rounds-guard.mjs`
after `node --test`.

The guard reads the count **strictly** from the retained evidence file; it
never fabricates, defaults, or infers a round count. `observed_rounds > 0`
prints `observed-rounds-guard: PASS` with the gate label, the observed count
and the distinct VM ids, and exits 0. A missing, unreadable, or malformed
evidence file, or `observed_rounds === 0`, prints the exact line
`no VM round observed (VM creation or probe failed before any round)` plus a
bounded summary and exits **92**, so a run that booted no VM can never be
reported as PASS. The real-boot, profile-overlay and synthetic whole-path
gates above all carry this guard, and the observed VM ids are the same
exact-owned VMs each gate positively closes and removes.

## 4. Synthetic whole-path gate (already run, reproducible)

The on-demand gate drives the real production daemon → scheduler → dsh
invocation runner → fresh VMs:

```bash
./run-matchlock-dsh-gate-e2e-test
```

It is deliberately **not** part of `npm test`, `./run-all-e2e-tests`, the smoke
lane or the scripted lane. It builds first, resolves the runtime from PATH,
records the observed version/hashes (see section 3), creates a fresh
never-reused evidence directory
(`/root/matchlock-work/evidence/dsh-exec-<UTC-Z ts>/`), tees the log and
propagates the real exit code (including cleanup failures).

The fixture image (`e2e-tests/dsh-fixture/Dockerfile.synthetic-dsh`,
tag `tamandua-synthetic-dsh:gate-fixture`) is a clearly labeled TEST-ONLY
derived image (`FROM node:22-bookworm-slim`) providing `fake-dsh.mjs`, which
implements the `dsh --profile headless <prompt>` contract with ZERO provider
calls. `igorhvr/bedlam-ubuntu` is a preference for the real operator image and
is never overwritten.

The focused profile-overlay regression gate is a separate on-demand runner:

```bash
./run-matchlock-dsh-profile-overlay-e2e-test
```

It alternates a host-side native zero-provider `dsh` boot and a real in-VM dsh
round (the production invocation runner) and asserts the host install-derived
farm never flips, the guest creates its `profiles/node_modules.lock` inside the
private per-run `profiles/` copy, and the guest's first request resolves through
that private copy. It is likewise in no default lane.

The real-dsh contained boot gate is the closing regression for the #31 gate
gap (see §2):

```bash
./run-matchlock-dsh-real-boot-gate-e2e-test
```

It stages a gate-owned `DSH_HOME` with the real headless profile layout and
placeholder credentials, boots the REAL image dsh through the production
invocation runner, and asserts the real `withFileLock` sibling
`profiles/node_modules.lock` is created inside the private overlay with no
run-#32 ENOENT while the host `profiles/` tree (files and links) stays
byte-identical. It also asserts the home root itself is fsync-able (no run-#35
`ENOENT ... fsync`). It, too, is in no default lane.

## 5. Real-vs-synthetic coverage boundary

**Covered synthetically (actual fresh VMs, zero providers):**

- both supported workflows to real completion (do-now: 1 probe + 1 work;
  do-review-do-verify: 1 probe + 4 work), exact run/step/host-suite-row/usage
  binding;
- one distinct fresh VM per probe and per work round, with an exact-owned
  positive-close ledger;
- composed `DSH_HOME` persistence across two actual VMs: the ONE effective-home
  mount's whole-directory durable categories (`sessions/`, `storages/`,
  `credentials/`, unknown
  top-level entries) persist and are observed by the second VM, while each VM
  gets its own private `profiles/` copy under the per-run overlay and the host
  `profiles/` snapshot stays byte-identical before and after both VMs;
- default, relative and custom captured-home mapping;
- nonstandard image PATH (only the helper-pack prepend);
- missing-harness refusal (no fabricated success/session/usage, VM positively
  closed);
- same-home/same-cwd concurrent new roots → honest `ambiguous`, never
  newest-mtime, never borrowed;
- real-image dsh boot/profile-link characterization with a fresh synthetic
  config: the guest's private per-run copy carries guest-install links, the
  host `profiles/` snapshot is byte-identical after the round, and the private
  overlay root is removed after the confirmed close;
- alternating native-boot / in-VM-round profile-overlay gate
  (`e2e-tests/matchlock-dsh-profile-overlay-gate.test.ts`, run by
  `./run-matchlock-dsh-profile-overlay-e2e-test`): the host `profiles/` never
  flips and the in-VM first-request path resolves through the private copy;
- the real-dsh contained boot regression
  (`e2e-tests/matchlock-dsh-real-boot-gate.test.ts`, run by
  `./run-matchlock-dsh-real-boot-gate-e2e-test`): the real
  `healProfilesModuleFallback`→`withFileLock` sibling
  `profiles/node_modules.lock` is created inside the private overlay with no
  run-#32 ENOENT, and the host `profiles/` tree (and any host lock) is
  byte-identical before and after each round;
- v2 session usage integrity (mirror never double counted;
  malformed/fractional/overflowing/ambiguous inputs unavailable or incomplete).

**NOT covered (real dsh work that remains):**

- real `dsh` model-backed rounds with real provider credentials;
- real image PATH/profile/model qualification for the operator's image;
- full generic workflow support (merge shapes, `just-do-it` child
  orchestration, PR/browser shapes);
- live platform parity beyond the linux/amd64 synthetic fixture;
- platform/root acceptance and the `DSV2` native-reader decision
  (`src/installer/dsh-usage.ts` is intentionally unchanged in this slice).

Two synthetic gate items were blocked with retained diagnostics and must not be
read as green:

1. **Nonstandard-image-PATH positive** — a relocated-dsh image failed inside
   the guest with
   `failed to start command: fork/exec /proc/self/exe: no such file or directory`
   (guest-agent sandbox re-exec), even though `dsh` resolved only through the
   image's declared non-default PATH. Retained receipt:
   `/root/matchlock-work/evidence/dsh-exec-20260910T014511Z/nonstandard-path-invocation.json`.
2. **Real-dsh boot characterization** — the historical real-dsh test-only image
   import could not complete under host-concurrent disk pressure
   (`mkfs.erofs ... No space left on device`). The superseding committed
   regression is the real-dsh contained boot gate
   (`e2e-tests/matchlock-dsh-real-boot-gate.test.ts`, run by
   `./run-matchlock-dsh-real-boot-gate-e2e-test`); it must be run by an
   operator/tester on a host whose VM-create capabilities are live (it is
   environment-blocked in the developer sandbox, exactly like the two #31
   gate runs above).

### 5.1 Per-run dsh profile-overlay lifecycle race (overlapping rounds)

The dsh profile-overlay root is derived from the RUN id
(`<liveStateRoot>/matchlock/dsh-profile-overlays/<bareRunId>`), while the
controller that stages and removes it is created per INVOCATION. The scheduler
can start the next round of a run before the previous round's teardown settles
(the union-final union tree showed overlapping `Work round start` /
`Work round complete` pairs seconds apart for one run), so two invocations
share one overlay root and the earlier invocation's `cleanupDshProfileOverlay`
removes it while the later invocation's VM is still mounted on it. The guest
then finds `$DSH_HOME` (`/workspace/config/dsh`) gone:
`lstat('/workspace/config/dsh')` -> `ENOENT`, so
`mkdir('<DSH_HOME>/sessions/<key>/session-<id>', {recursive:true})` fails with
`ENOTDIR` and the harness exits without a report.

Roles whose step allows a retry recover on the following round; the
`finalize_merge` step has `maxRetries: 0`, so the whole-path dsh merge-worktree
gate (`e2e-tests/matchlock-dsh-merge-worktree-gate.test.ts`, run by
`./run-matchlock-dsh-merge-worktree-e2e-test`) cannot land: it reroutes to
`test` and exhausts the reroute budget. The retained per-round component
diagnostic (produced with a temporary instrumented fixture) is
`/home/kaladin/matchlock-work/union-final-matchlock-gates/us012/dsh-merge-mkdir-diag.txt`
(`/workspace/config/dsh -> stat:ENOENT`). This is a pre-existing union-port
overlay-lifecycle limitation, not a regression of the three landings; the pi
merge-worktree gate (no dsh overlay) is unaffected.

## 6. Real production recipe (operator)

1. **Provide an image with real dsh.** The operator supplies
   `--matchlock <image>`; Tamandua never installs dsh on the host for an
   opted-in run. The image must already contain the `dsh` executable plus its
   runtime (`node`, etc.) on its declared `PATH`, and must not require a
   provider call merely to boot.
2. **Select the effective DSH_HOME at submission.** Run the CLI from the
   account whose dsh config should be used. The submitting process captures
   `HOME`, `DSH_HOME` (if set) and cwd; the default is `<captured home>/.dsh`.
   Its durable entries (`credentials/`, `.credentials.yaml`,
   `.anonymous-user-id`, `sessions/`, `storages/`, unknown top-level entries)
   are materialized in a private per-run effective home, and that home is
   mounted RW as **ONE** host-backed root at `/workspace/config/dsh` — writes
   to those entries are published back to the host and are accepted as damage
   the user authorized. The whole `profiles/` directory is instead a
   **private per-run staged copy** inside that home (durable config files
   copied byte-identically, install-derived directories empty), so the guest's
   farm heal and its `profiles/node_modules.lock` boot lock never reach the
   host home or the host farm (see §2).
3. **Opt in explicitly:**

   ```bash
   tamandua workflow run do-now "<task>" --dsh-as-harness --matchlock <image>
   tamandua workflow run do-review-do-verify "<task>" --dsh-as-harness --matchlock <image>
   ```

   Only `do-now` and `do-review-do-verify` are admitted; everything else
   refuses loudly before effects.
4. **Supply real credentials in the image/config only if** the coordinator has
   accepted the boundary. The synthetic gates read no real credentials.
5. **Verify** the run: `runs.tokens_spent` should match the v2 session usage
   totals; a moved image tag must fail closed (the persisted content+config pin
   is never re-resolved); every VM must be positively closed.
6. **Retain evidence** under a fresh
   `/root/matchlock-work/evidence/dsh-exec-<UTC-Z ts>/` directory with the
   tee'd log, command, exit code, retained VM/session/profile/usage/suite
   receipts. Never pre-clean or reuse an evidence directory and never delete
   old failed/aborted/successful evidence.

## 7. Focused committed-source regression

On the committed tree (no full `npm test`, no real E2E, no live campaign):

```bash
TAMANDUA_TEST_GUARD=1 TAMANDUA_PI_BINARY=/usr/bin/false TAMANDUA_DSH_BINARY=/usr/bin/false \
  node --experimental-test-module-mocks --test --test-concurrency=1 \
  $(find src/installer/matchlock -maxdepth 1 -name '*.test.ts' ! -name 'pi-invocation-runner.test.ts' | sort) \
  src/installer/agent-scheduler-matchlock.test.ts \
  src/installer/agent-scheduler-dsh-routing.test.ts \
  src/installer/agent-scheduler-dsh-tokens.test.ts \
  src/installer/dsh-resolver.test.ts \
  src/installer/dsh-usage.test.ts
```

Plus `npm run build` (typecheck) and the serial-lane classification guards
`tests/serial-classification-guard.test.ts` /
`tests/serial-files-integrity.test.ts`. The pure
`src/installer/matchlock/dsh-*.ts` module graph stays process-spawn-free
(parallel lane); `dsh-scheduler-seam.test.ts` is serial-classified; the
real-VM gate is in no default lane.

## 8. Retained evidence conventions

- Fresh `mkdtemp`-style, never-reused evidence root with private
  HOME/STATE/DB/TMPDIR; `TAMANDUA_TEST_GUARD=1`; random ports only; schema10
  candidate state only (never the live schema9 DB).
- **Short HOME path (sockaddr_un / SUN_LEN): Tamandua handles this.** Matchlock
  binds its per-VM Firecracker API unix socket under
  `$HOME/.matchlock/vms/vm-<8hex>/socket.sock`; Linux caps a `sockaddr_un` path
  at 107 usable bytes, so a long HOME would otherwise make every `create` fail
  closed with `VM failed to become ready` while `matchlock log <vm>` shows
  Firecracker exiting with `path must be shorter than SUN_LEN`. Tamandua gives
  EVERY Matchlock control process it spawns a verified short HOME alias
  (`/tmp/tamandua/<uid>/h`) and refuses, before any RPC/VM effect, when even
  that path would exceed the 107-byte limit. Because the alias is a **symlink
  whose target is the real HOME**, the image cache, kernel cache and VM
  registry stay shared — `matchlock list/rm/gc` see the same VMs and the state
  stays physically under the real HOME. Operators no longer need to keep the
  private HOME short. Escape hatch: `TAMANDUA_MATCHLOCK_HOME_ALIAS` disables the
  alias (`off` or `0` — the real HOME is passed through unchanged) or points it
  at another short absolute directory; the override, like the default, is
  verified on every use and an untrustworthy alias refuses the launch loudly.
- Step reporting only via the stable `/opt/tamandua/bin/tamandua`.
- No recursive state deletion; no `rm -rf`/preclean/globs/cache purge/git
  reset/clean/prune/gc/worktree removal; exact currently owned VM ids only;
  failed/unknown teardown makes the gate non-green; inventory failure is never
  treated as empty.
- Evidence is metadata-only: no raw prompts, private reasoning, assistant
  bodies or secrets.

## 9. Launch-time harness probe cost (accepted by design)

Every opted-in `--matchlock` run performs exactly **one launch-time harness
probe** before the first work round. The probe is **one real model round** run
in a fresh Matchlock VM; it proves that the image's guest harness is reachable
and can answer the `<launcher> skill-path` contract before any real work is
attempted. It is a deliberate part of the design and it is **not free**.

Measured probe cost from the real-model qualification (run #70 /
`real-qual-BhVnIV`), tokens per probe:

| Harness | Probe tokens (approx.) |
|---------|------------------------|
| `pi` | ~1.7k |
| `dsh` | ~6.8k |
| `hermes` | ~9.2k |

Each probe also **boots one fresh Matchlock VM** (`create` + boot + teardown)
on top of the tokens. Probe tokens are real model tokens and are **attributed
to the run** (`run.tokens.updated` deltas and the `run.harness_probe_ok`
`probeTokens` field), so they appear in `runs.tokens_spent` alongside the work
rounds.

This cost is **accepted by design**: one extra model round plus one VM boot per
run is the price of proving the isolated harness works before the run's real
work is dispatched. The probe cost does not scale with workflow length — it is
once per run, not once per round — and it is distinct from the zero-provider
synthetic gates, which use an image-provided fixture and spend no model tokens.
