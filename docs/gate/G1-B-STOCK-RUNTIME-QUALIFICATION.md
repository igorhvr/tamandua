# G1-B Stock-Runtime Qualification

## Status

**COMPLETE — US-001 … US-007 recorded. All four stores in the required set
(`state.db`, `verification_evidence.db`, `kanban.db`, `projects.db`) are
HONOURING, and the consolidated harness (US-007,
`docs/gate/probes/g1b/run_all.sh`) reproduces the whole qualification against
one fresh scratch root: the recorded run finished with
`FINAL_HARNESS_RESULT=PASS`, 633 assertions and 0 failures
(`docs/gate/evidence/g1b/final-harness.log`).**

**Scope of that COMPLETE status:** it completes the *container* qualification of
the Docker artifact's own stock writers. It does **not** qualify Matchlock's
shared-filesystem behaviour across a guest boundary, and it does **not**
establish the relationship between the Docker artifact and the Matchlock
artifact (both explicitly UNVERIFIED / unproven — see
[What remains unproven](#what-remains-unproven)).**

G1 proved, against a *dirty local checkout* of Hermes Agent
(`d623a66.dirty`, upstream `8b66a510`), that every store honours
`database.journal_mode: delete`. That result does **not** transfer to the
published image: the image ships stock Hermes
`4d04303818b61bf3aa09278af48356315515965b`, `resolve_journal_mode()` and
`sqlite_util.py` are textually identical but `apply_wal_with_fallback()` differs
(config-lock handling — it governs how the resolved mode is *applied*), and
`resolve_journal_mode()` itself delegates to the config loader. Identical
resolver text therefore does not prove identical managed-configuration
behaviour. G1-B re-runs the decisive experiment against the image's own stock
runtime.

Current status by store:

| Store | Verdict |
| --- | --- |
| `state.db` | **HONOURING** (US-003) |
| `verification_evidence.db` | **HONOURING** (US-004) |
| `kanban.db` | **HONOURING** (US-005) |
| `projects.db` | **HONOURING** (US-006) |

The consolidated re-run (US-007) reproduced all four verdicts in one harness
invocation — see
[Consolidated harness and per-store verdict table (US-007)](#consolidated-harness-and-per-store-verdict-table-us-007).

---

## Scope

**A container run answers "do that image's writers honour configuration". It
does NOT qualify Matchlock's shared-filesystem behaviour across a guest
boundary.** G1-B exercises the Docker artifact's own stock Hermes in a
disposable container with a bind-mounted scratch root; it says nothing about
whether a Matchlock guest sees a journal mode flip across a shared host/guest
filesystem, nor about cross-boundary page-cache or fsync semantics. Any
guest-boundary claim needs a separate, Matchlock-scoped qualification.

Per-store, the decisive experiment is:

1. seed a real store with the store's own writer under
   `database.journal_mode: wal` and assert header bytes `2,2`;
2. copy it aside and convert **only the copy** offline with the stock
   `hermes sessions set-journal-mode delete --db <copy>`, asserting `1,1` and
   that the original is byte-identical;
3. run the real writer **twice** under a config resolving to `delete`;
4. after each writer closes, prove with a **separate read-only** connection
   that a specific, identifiable record which did not exist before is present
   now;
5. read raw header bytes 18/19 and all three sidecars (`-wal`, `-shm`,
   `-journal`) after each close;
6. run the same converted copy under a config resolving to `wal` as the WAL
   control (must become `2,2`).

A listing that succeeds, an opener that returns normally, or unchanged header
bytes are **weaker** evidence and are never sufficient on their own. Reading
header bytes is not a substitute for the persistence assertion; they are
reported separately.

---

## Artifact Truth

### Docker artifact actually exercised

| Item | Value |
| --- | --- |
| Docker tag | `igorhvr/tamandua:latest` |
| Image Id | `sha256:d15b7b377d679c6561315f7054e16f0310b3956cff872c23818d90073b29934a` |
| Architecture | `amd64` |
| OS | `linux` |
| Platform flag | `--platform linux/amd64` |
| RepoDigest | `igorhvr/tamandua@sha256:d15b7b377d679c6561315f7054e16f0310b3956cff872c23818d90073b29934a` |
| Host | `vaimetal` |
| Stock Hermes revision inside the image | `4d04303818b61bf3aa09278af48356315515965b` |
| Stock checkout state | `git status --porcelain` **empty** (stock, unmodified) |
| Hermes launcher (CLI) | `/usr/local/bin/hermes` |
| Working Python | `/opt/src/hermes-venv/bin/python` (Python 3.14.7) |
| Embedded SQLite | 3.53.1 |
| `import hermes_state, sqlite3` | OK |

The bare store interpreter
(`/opt/src/hermes-root/tools/.../python3`) **cannot** import `hermes_state` and
is never used.

### Tag → image-id mapping (recorded)

```text
igorhvr/tamandua:latest -> sha256:d15b7b377d679c6561315f7054e16f0310b3956cff872c23818d90073b29934a
igorhvr/tamandua:amd64  -> sha256:9140629c9f408a6e9c285434eb6ab0cebd67db146c324db33e2798bac4fb7dff
```

### Relationship to the Matchlock artifact — UNVERIFIED

Matchlock resolves `igorhvr/tamandua` to
`sha256:9140629c9f408a6e9c285434eb6ab0cebd67db146c324db33e2798bac4fb7dff`,
while Docker reports
`sha256:d15b7b377d679c6561315f7054e16f0310b3956cff872c23818d90073b29934a`
for `igorhvr/tamandua:latest`. On this host the two tags resolve to two
*distinct* local image ids.

**The relationship between the Docker artifact qualified here and the Matchlock
artifact is UNVERIFIED — no equality claim is made.** G1-B qualifies the Docker
artifact precisely and labels the Matchlock relationship as unverified.

---

## Exercised Runtime (observed)

| Probe | Value |
| --- | --- |
| `git -C /opt/src/hermes-agent rev-parse HEAD` | `4d04303818b61bf3aa09278af48356315515965b` |
| `git -C /opt/src/hermes-agent status --porcelain` | empty |
| `/usr/local/bin/hermes --version` (first line) | `Hermes Agent v0.22.4 (2026.9.24) · stable` |
| `/opt/src/hermes-venv/bin/python --version` | `Python 3.14.7` |
| `sqlite3.sqlite_version` | `3.53.1` |
| `import hermes_state, sqlite3` | `IMPORT_OK` |
| `/proc/1/cgroup` | `0::/` |
| `resolve_journal_mode()` with `database.journal_mode: delete` | `delete` |
| `resolve_journal_mode()` with `database.journal_mode: wal` | `wal` |

The full captured output, including real exit codes, is
`docs/gate/evidence/g1b/runtime-identity.txt`. That file also records the
scratch root path (`/tmp/g1b-runtime-identity.*`), which is kept.

---

## Safety Protocol

These rules bind every G1-B probe and are encoded in
`docs/gate/probes/g1b/g1b_common.sh`, not left to reviewer discipline.

1. **Disposable scratch only.** Every probe creates a fresh root with
   `mktemp -d /tmp/g1b-<name>.XXXXXX`. No probe deletes a pre-existing path and
   no probe removes its own scratch root: every fixture stays in place as
   evidence and its path is recorded in the evidence file.
2. **Never the real operator home.** Any scratch path resolving to
   `/home/kaladin/.hermes` (or anything under it) is refused with exit code
   **64**, checked after `readlink -f` so a symlink or `..` spelling cannot
   reach the live stores. The real home is never read, written or mounted.
3. **One container gateway.** Every container invocation goes through
   `g1b_container_run`, which always passes `--rm --network none
   --platform linux/amd64 --user <uid>:<gid> -v <scratch>:/work -w /work` and
   `bash -c` (never `bash -lc`: a login shell prints
   `/root/.bash_profile: Permission denied`). `--user` keeps bind-mounted
   fixtures owned by the invoking user. The only mount is the scratch root.
4. **Stock Hermes only.** No probe modifies, forks, patches or vendors Hermes,
   and no probe installs a package (no `pip`, no `apt`, no `npm`). The stock
   revision and an empty `git status --porcelain` are recorded around the runs.
5. **Journal format from raw bytes only.** The journal mode is measured
   **only** by `docs/gate/probes/read_header.py` reading raw header bytes 18/19
   — never by a SQLite connection (even a read-only connection can checkpoint a
   WAL and change the bytes being measured). The bootstrap copies that one
   reader into `<scratch>/tools/` and asserts the copy's sha256 equals the
   parent file.
6. **Read-only persistence checks are separate and allowed.** The gate's
   "never open SQLite" rule binds the production observer, not these fixtures.
   Persistence is proven with short-lived `mode=ro` connections **after**
   writers quiesce; those connections never insert, update, delete, or read
   journal mode.
7. **No GitHub, no network.** No probe pushes, fetches, or installs anything;
   containers run with `--network none`. The real operator home is never
   touched.

---

## Harness (US-001)

`docs/gate/probes/g1b/g1b_common.sh` is the sourced shared library:

- **Constants** — `IMAGE_REF`, `REQUIRED_IMAGE_ID`, `REQUIRED_ARCH`,
  `REQUIRED_OS`, `REQUIRED_HERMES_REVISION`, `MATCHLOCK_ARTIFACT_ID`,
  in-container paths, `REAL_OPERATOR_HOME`.
- **`g1b_image_facts <ref>` / `g1b_image_id <ref>`** — read-only
  `docker image inspect` over `Id`, `Architecture`, `Os`, `RepoDigests`.
- **`g1b_container_run <scratch> <script>`** — the single container gateway
  described in Safety Protocol rule 3 (also exports `HOME` inside `/work` so
  the container's Hermes cannot use an image-baked `/root` home).
- **`g1b_scratch <name>`** — `mktemp -d /tmp/g1b-<name>.XXXXXX`, never removed;
  the refusal guard runs on the base *before* creation so nothing is ever
  created under the real home.
- **`g1b_refuse_real_home <path>`** — exit 64 guard.
- **`g1b_assert_pass` / `g1b_assert_fail` / `g1b_assert_eq` /
  `g1b_assert_contains` / `g1b_assert_nonempty` / `g1b_summary`** — counters
  emitting `ASSERT PASS:` / `ASSERT FAIL:` lines; `g1b_summary` returns driven
  by the fail count.
- **`g1b_bootstrap_read_header <scratch>`** — copies
  `docs/gate/probes/read_header.py` into `<scratch>/tools/` and asserts the
  sha256 matches the parent file.

`docs/gate/probes/g1b/probe_runtime_identity.sh` drives it and exits 0 only
when all 24 assertions pass. Its evidence is
`docs/gate/evidence/g1b/runtime-identity.txt`.

---

## Seeding harness (US-002)

The delete-mode probes need seeded stores whose committed rows are
*identifiable*, so persistence is proven for a specific record rather than for
an opener that merely returns. `docs/gate/probes/g1b/seed_stores.sh` provides
that harness; its evidence is
`docs/gate/evidence/g1b/store-seeding.txt` (147 assertions, 0 failures on the
run recorded there).

Per store it creates a fresh home under one kept `mktemp -d
/tmp/g1b-store-seeding.XXXXXX` root with `database.journal_mode: wal`, runs the
store's **real** writer twice with two unique markers
(`g1b-<store>-<probe-runid>-<n>`), and records:

- the marker and the **store's own record id** (session id / verification event
  id / `t_...` task id / `p_...` project id);
- raw header bytes 18/19 (via `read_header.py` only), size and sha256 after
  **each** writer close — all four stores came back `2,2` (`wal`);
- all three sidecar states (`-wal`, `-shm`, `-journal`) after each close;
- a **read-only** baseline: both written markers are present, and a marker that
  was never written is absent (`READONLY_NOTWRITTEN_TOTAL=0`);
- the stock-purity check (revision `4d04303818b61bf3aa09278af48356315515965b`,
  `git status --porcelain` empty) before **and** after the runs.

The seeding evidence never reads a journal mode through SQLite, and
`g1b_readonly.py` opens fixtures only with `file:<path>?mode=ro` (plus
`PRAGMA query_only=ON`), discovers table names from `sqlite_master`, and prints
the exact SQL text next to each marker-matched count.

---

## Store set and required-vs-optional (restated for the published image)

The database-layer rollout covers four stores. Each is only qualified for the
state G1-B actually exercises it in inside the **published image**:

| Store | Role in the image | Real writer exercised | Required vs optional |
| --- | --- | --- | --- |
| `state.db` | core session store, opened through the canonical `apply_wal_with_fallback()` path | `hermes_state.SessionDB()` + `create_session(session_id=<mark>)` | **REQUIRED core** — always present; the delete-mode rollout must hold for it unconditionally |
| `verification_evidence.db` | verify-on-stop evidence ledger | `agent.verification_evidence.record_verify_run(session_id=<mark>, ok=True)` | **optional / gated** — the ledger is opt-in: with the guard off it does not even exist and `record_verify_run()` returns `None`. G1-B enables it explicitly (`agent.verify_on_stop: true` in the fixture config and `HERMES_VERIFY_ON_STOP=1`, the env form) before asserting anything about it |
| `kanban.db` | kanban board store | `/usr/local/bin/hermes kanban create "<mark>" --json` | **optional / gated** — only exercised when the kanban feature is used. `kanban list` is not an acceptable writer (it commits no record); the seed names the task id/title, and the store path resolves through `kanban_home()` to the default board `<root>/kanban.db` |
| `projects.db` | project registry | `/usr/local/bin/hermes project create "<mark>" --slug <mark>` | **optional / gated** — only exercised when the project feature is used. `project list` is not an acceptable writer (it commits no record); the seed names the project id/slug. No folder/`--primary` is required by the stock trigger, so no scratch repository is involved |

A store that is *not triggered* in a given configuration is not evidence about
that store: the gated stores are seeded with their gate explicitly enabled, and
`state.db` is the one store every session writes.

---

## Offline conversion persistence for `state.db` (G1-B)

**Store identity.** `state.db` is the **core session store**: every session
writes it regardless of feature gates, and it is opened through the canonical
`apply_wal_with_fallback()` path. It is the REQUIRED core of the
`database.journal_mode: delete` rollout, so the delete-mode result for this
store must hold unconditionally.

Harness: `docs/gate/probes/g1b/probe_state_delete.sh` (host orchestrator, one
kept `mktemp -d /tmp/g1b-state-delete.XXXXXX` root, one container run through
the single `g1b_container_run` gateway) and
`docs/gate/probes/g1b/g1b_state_delete_container.sh` (container driver).
Evidence: `docs/gate/evidence/g1b/state-delete.txt` — **98 assertions, 0
failures**. Scratch root (kept as evidence):
`/tmp/g1b-state-delete.pIKCeK`, bind-mounted at `/work`.

Exercised runtime: Docker image
`sha256:d15b7b377d679c6561315f7054e16f0310b3956cff872c23818d90073b29934a`
(`igorhvr/tamandua:latest`, `linux/amd64`), stock Hermes revision
`4d04303818b61bf3aa09278af48356315515965b` with an empty
`git status --porcelain` before and after the runs, launcher
`/usr/local/bin/hermes`, runtime Python `/opt/src/hermes-venv/bin/python`.

### Exact commands

All commands run INSIDE the container; `HOME=/work/home`, and the only writable
location is the bind-mounted scratch root.

```text
# 1. seed a real WAL store (fixture config: database.journal_mode: wal)
/opt/src/hermes-venv/bin/python /work/tools/g1b_writers.py state g1b-state-<runid>-seed \
    --home /work/state-delete/seed-wal/home --scratch /work/scratch

# 2. copy it aside and prove byte identity
cp -a -- /work/state-delete/seed-wal/home/state.db /work/state-delete/conversion/state.db
sha256sum /work/state-delete/seed-wal/home/state.db /work/state-delete/conversion/state.db
cmp -s  /work/state-delete/seed-wal/home/state.db /work/state-delete/conversion/state.db

# 3. convert ONLY the copy, offline, with the stock conversion path
HERMES_HOME=/work/state-delete/seed-wal/home \
  /usr/local/bin/hermes sessions set-journal-mode delete \
  --db /work/state-delete/conversion/state.db

# 4. delete fixture: a fresh cp -a of the converted copy + delete-resolving config
cp -a -- /work/state-delete/conversion/state.db /work/state-delete/delete/home/state.db
/opt/src/hermes-venv/bin/python /work/tools/g1b_writers.py state g1b-state-<runid>-1 \
    --home /work/state-delete/delete/home --scratch /work/scratch
/opt/src/hermes-venv/bin/python /work/tools/g1b_writers.py state g1b-state-<runid>-2 \
    --home /work/state-delete/delete/home --scratch /work/scratch

# 5. WAL control: the SAME converted copy under a wal-resolving config
cp -a -- /work/state-delete/conversion/state.db /work/state-delete/wal-control/home/state.db
/opt/src/hermes-venv/bin/python /work/tools/g1b_writers.py state g1b-state-<runid>-control \
    --home /work/state-delete/wal-control/home --scratch /work/scratch
```

The resolved mode is read before every writer
(`resolve_journal_mode()` via `/opt/src/hermes-venv/bin/python`), and the real
writer is `hermes_state.SessionDB()` + `create_session(session_id=<marker>)`
(through `g1b_writers.py`); the session marker becomes `sessions.id`, so the
identifiable record is a primary key the probe chose.

### Per-stage table

Journal format is read ONLY from raw header bytes 18/19 (`read_header.py`).
`header 18/19` is reported separately from the sidecars, and none of these
values came from a SQLite connection.

| Stage | Path (container) | Size | sha256 | Header 18/19 | Mode | Sidecars (`-wal`,`-shm`,`-journal`) | Writer runs |
| --- | --- | --- | --- | --- | --- | --- | --- |
| seed WAL | `/work/state-delete/seed-wal/home/state.db` | 327680 | `78a6ebf8bc21dbe4e26554db3b918c738b773b228895e27b0de1b0e9a49bc79c` | 2,2 | wal | absent, absent, absent | 1 (seed writer) |
| copy before conversion | `/work/state-delete/conversion/state.db` | 327680 | `78a6ebf8bc21dbe4e26554db3b918c738b773b228895e27b0de1b0e9a49bc79c` | 2,2 | wal | absent, absent, absent | 0 |
| converted copy (offline) | `/work/state-delete/conversion/state.db` | 327680 | `8be9e501d3505d8d5b38eed17f9a0f204ff34031a41cdeb14bab2476be6379da` | 1,1 | delete | absent, absent, absent | 0 (offline conversion) |
| delete home before writers | `/work/state-delete/delete/home/state.db` | 327680 | `8be9e501d3505d8d5b38eed17f9a0f204ff34031a41cdeb14bab2476be6379da` | 1,1 | delete | absent, absent, absent | seed row carried over |
| delete home after run 1 | `/work/state-delete/delete/home/state.db` | 327680 | `c3d8545bbc1d5148002ffd12eaec48975e30d2c8b7b9b4d4561a0b44bc127bee` | 1,1 | delete | absent, absent, absent | 2 |
| delete home after run 2 | `/work/state-delete/delete/home/state.db` | 327680 | `fac035eb264f7c53d809f85d0f3cfb2cf755117149ff0cdb2213b85eb967e471` | 1,1 | delete | absent, absent, absent | 3 |
| wal control before writer | `/work/state-delete/wal-control/home/state.db` | 327680 | `8be9e501d3505d8d5b38eed17f9a0f204ff34031a41cdeb14bab2476be6379da` | 1,1 | delete | absent, absent, absent | seed row carried over |
| wal control after writer | `/work/state-delete/wal-control/home/state.db` | 327680 | `911d1c4ec7f253c375be1d7ee8dee8e0d2311ef85ffd0a698fb8da7c21cb7008` | 2,2 | wal | absent, absent, absent | 2 |

Both delete-mode header readings (after run 1 and after run 2) are `1,1`
(`delete`), and the header is re-read after each read-only persistence check
and is still `1,1` — the evidence records both readings.

**What these assertions would catch if the store had reverted to WAL:**

- *Seed stage* — if the seeded store were not really WAL, the experiment would
  start from the wrong state and a later "stays delete" reading would prove
  nothing; a `2,2` seed is the precondition that makes the 1,1 observations
  meaningful.
- *Copy stage* — if `cp -a` had produced a different file (or the original had
  been converted in place), the experiment would silently bundle conversion and
  writer effects; `sha256` equality plus `cmp -s` proves the copy is
  byte-identical and the original untransformed.
- *Conversion stage* — if the offline conversion had not written the header (or
  had touched the original), the `1,1` reading and the unchanged original
  sha256 are what fail.
- *Two delete-mode writer runs* — if the real writer re-opened the store in WAL
  (the reversion this bead is about), header bytes 18/19 would be `2,2` after a
  close and the sidecars would include a `-wal`/`-shm`; the assertions require
  `1,1` after EACH close and all three sidecars absent.
- *Persistence assertion* — if the store had reverted to WAL and then lost its
  un-checkpointed committed row (or the writer never committed), the read-only
  `sessions` count would stay `0` instead of flipping to `1`; unchanged header
  bytes alone could not distinguish "committed and persisted in delete mode"
  from "never committed".

### Identifiable-record assertion (the bead's heart)

After EACH writer closed, a **separate short-lived read-only connection**
(`sqlite3.connect('file:<path>?mode=ro', uri=True)` plus
`PRAGMA query_only=ON`, from `g1b_readonly.py`) asked whether that run's own
marker exists. It never reads a journal mode and cannot write a row.

Before run 1 both markers are absent; after run 1 close marker 1 is present and
marker 2 is still absent; before run 2 marker 1 is still present and marker 2 is
absent; after run 2 close both are present. The read-only SQL text is printed
next to each count by the checker (verbatim in the evidence):

```sql
SELECT COUNT(*) FROM "sessions" WHERE CAST("id" AS TEXT) = ? OR CAST("source" AS TEXT) = ? OR CAST("created_source" AS TEXT) = ? OR CAST("user_id" AS TEXT) = ? OR CAST("session_key" AS TEXT) = ? OR CAST("chat_id" AS TEXT) = ? OR CAST("chat_type" AS TEXT) = ? OR CAST("thread_id" AS TEXT) = ? OR CAST("display_name" AS TEXT) = ? OR CAST("origin_json" AS TEXT) = ? OR CAST("model" AS TEXT) = ? OR CAST("model_config" AS TEXT) = ? OR CAST("system_prompt" AS TEXT) = ? OR CAST("system_prompt_hash" AS TEXT) = ? OR CAST("parent_session_id" AS TEXT) = ? OR CAST("end_reason" AS TEXT) = ? OR CAST("cwd" AS TEXT) = ? OR CAST("git_branch" AS TEXT) = ? OR CAST("git_repo_root" AS TEXT) = ? OR CAST("billing_provider" AS TEXT) = ? OR CAST("billing_base_url" AS TEXT) = ? OR CAST("billing_mode" AS TEXT) = ? OR CAST("cost_status" AS TEXT) = ? OR CAST("cost_source" AS TEXT) = ? OR CAST("pricing_version" AS TEXT) = ? OR CAST("title" AS TEXT) = ? OR CAST("title_source" AS TEXT) = ? OR CAST("last_activity_description" AS TEXT) = ? OR CAST("last_activity_provenance" AS TEXT) = ? OR CAST("handoff_state" AS TEXT) = ? OR CAST("handoff_platform" AS TEXT) = ? OR CAST("handoff_error" AS TEXT) = ? OR CAST("compression_failure_error" AS TEXT) = ? OR CAST("profile_name" AS TEXT) = ? OR CAST("transport_profile" AS TEXT) = ? OR CAST("tool_names" AS TEXT) = ?
```

(Column list as printed by the checker; the `= ?` placeholders are bound to the
marker.) The observed counts, with the exact marker values
(`g1b-state-<runid>-1`, `g1b-state-<runid>-2`):

| Check | Marker | Before | After that run's close |
| --- | --- | --- | --- |
| run 1 persistence | `g1b-state-20261022T151541Z-2153421-1` | `sessions` count 0 | `sessions` count 1 |
| run 2 persistence | `g1b-state-20261022T151541Z-2153421-2` | `sessions` count 0 | `sessions` count 1 |
| never written | `g1b-state-20261022T151541Z-2153421-never-written` | — | total 0 (absent) |

The conversion itself preserved the seed row: the read-only check on the placed
converted copy found the seed marker (`sessions` count 1) before either writer
ran.

**What would fail on a WAL reversion:** the writers' rows would either vanish
(after a restart/checkpoint of an uncommitted `-wal`) or the store would report
`2,2` after close together with a non-empty `-wal`/`-shm`; neither the missing
row nor the WAL header/sidecar state can be explained away by a successful
opener.

### Sidecars after each writer close

| Run | `-wal` | `-shm` | `-journal` |
| --- | --- | --- | --- |
| after run 1 | absent | absent | absent |
| after run 2 | absent | absent | absent |

The assertions require all three to be absent after each close (no non-empty
`-wal`/`-shm` and no `-journal` file left behind). **What would fail on a WAL
reversion:** a re-opened WAL store leaves a `-wal` (and usually a `-shm`)
beside the database; a rollback journal left mid-transaction would show a
`-journal`, so "absent" is the observable that separates a clean delete-mode
close from both failure modes.

### WAL control

The SAME converted copy (byte-identical to the `1,1` artifact) was placed in a
home whose config resolves to `wal` and the real writer ran once:
`CONTROL_RESOLVED_MODE=wal`, pre-writer header `1,1`, post-writer header
**`2,2`** (`wal`), and the control marker was then present read-only. This
proves the delete-mode persistence above is **configuration-honouring, not
immovable**: the store is not a one-way converted file, and the resolver — not
the file's prior header — decides the next open.

**What would fail on a WAL reversion:** nothing here — the control is supposed
to go back to `2,2`. It is the observation that makes the `1,1` result
meaningful: if the control also stayed `1,1`, the writer would be ignoring the
`wal` configuration and the delete-mode result could not be attributed to the
configured mode.

### Verdict

Verdict: `state.db` HONOURING

`state.db` was seeded WAL (`2,2`), copied byte-identically, converted offline on
the copy (`1,1`, original sha256 unchanged), stayed `1,1` with all three
sidecars absent across TWO consecutive real writer runs under a
`delete`-resolving config, persisted a specific identifiable `sessions` row per
run (read-only absent→present), and returned to `2,2` only in the
`wal`-resolving control. The exercised runtime is the published image's stock
Hermes `4d04303818b61bf3aa09278af48356315515965b` with a clean checkout before
and after.

Scope restatement: this is a container result about the image's own writers. It
**does not** qualify Matchlock's shared-filesystem behaviour across a guest
boundary, and the relationship between this Docker artifact
(`sha256:d15b7b37…`) and the Matchlock artifact (`sha256:9140629c…`) remains
**UNVERIFIED**.

---

## Offline conversion persistence for `verification_evidence.db` (G1-B)

**Store identity.** `verification_evidence.db` is the **OPTIONAL verify-on-stop
evidence ledger**. Unlike `state.db` it is opt-in and gated: the writer checks
`agent.verification_evidence._ledger_enabled()` (which delegates to
`agent.verification_stop.verify_on_stop_enabled()`) *before* it ever connects,
so with the guard OFF nothing records, reads, or even creates the database and
`record_verify_run()` returns `None`. When the guard is enabled the store is
created/opened through `_connect()` → `hermes_cli.sqlite_util.open_db()` →
`apply_wal_with_fallback()` — the same canonical journal-mode apply path as the
other per-profile stores. The gate is enabled by `agent.verify_on_stop: true`
in the fixture config or by `HERMES_VERIFY_ON_STOP=1` (the documented env form);
the probe proves BOTH forms after proving the OFF case.

Harness: `docs/gate/probes/g1b/probe_verification_delete.sh` (host
orchestrator, one kept `mktemp -d /tmp/g1b-verification-delete.XXXXXX` root, one
container run through the single `g1b_container_run` gateway),
`docs/gate/probes/g1b/g1b_verification_delete_container.sh` (container driver)
and `docs/gate/probes/g1b/g1b_verify_gate.py` (the gate prover). Evidence:
`docs/gate/evidence/g1b/verification-delete.txt` — **128 assertions, 0
failures**. Scratch root (kept as evidence):
`/tmp/g1b-verification-delete.0lnpqn`, bind-mounted at `/work`.

Exercised runtime: Docker image
`sha256:d15b7b377d679c6561315f7054e16f0310b3956cff872c23818d90073b29934a`
(`igorhvr/tamandua:latest`, `linux/amd64`), stock Hermes revision
`4d04303818b61bf3aa09278af48356315515965b` with an empty
`git status --porcelain` before and after the runs, launcher
`/usr/local/bin/hermes`, runtime Python `/opt/src/hermes-venv/bin/python`.

### Opt-in gate proven BEFORE the experiment

A default session never touches this store, so a run without the gate proves
nothing about it. The probe therefore asserts all three states first:

| Gate case | Fixture config | Environment | Guard | `record_verify_run()` | `verification_evidence.db` |
| --- | --- | --- | --- | --- | --- |
| OFF | `database.journal_mode: delete` (no `agent.verify_on_stop`) | `HERMES_VERIFY_ON_STOP` unset | **disabled** | `None` | **ABSENT** before AND after the call |
| CONFIG ON | `database.journal_mode: delete` + `agent.verify_on_stop: true` | `HERMES_VERIFY_ON_STOP` unset | **enabled** | real event (`id=1`, `session_id` = the gate marker) | **APPEARS** (header `1,1`, all three sidecars absent) |
| ENV FORM | `database.journal_mode: delete` (no config key) | `HERMES_VERIFY_ON_STOP=1` | **enabled** | real event (`id=1`) | **APPEARS** (header `1,1`, all three sidecars absent) |

Exact gate commands (container):

```text
# OFF: no config key, no env var
/opt/src/hermes-venv/bin/python /work/tools/g1b_verify_gate.py \
    --home /work/verification-delete/gate-off/home \
    --workspace /work/verification-delete/gate-workspace \
    --marker g1b-verification-<runid>-seed-gate-off --expect disabled
# -> GATE_ENABLED=no  GATE_RECORD_IS_NONE=yes  GATE_DB_EXISTS_BEFORE=no  GATE_DB_EXISTS_AFTER=no

# CONFIG ON: agent.verify_on_stop: true in config.yaml, no env var
/opt/src/hermes-venv/bin/python /work/tools/g1b_verify_gate.py \
    --home /work/verification-delete/gate-on/home \
    --workspace /work/verification-delete/gate-workspace \
    --marker g1b-verification-<runid>-seed-gate-on --expect enabled
# -> GATE_ENABLED=yes  GATE_RECORD_IS_NONE=no  GATE_DB_EXISTS_AFTER=yes

# ENV FORM: no config key, HERMES_VERIFY_ON_STOP=1
HERMES_VERIFY_ON_STOP=1 /opt/src/hermes-venv/bin/python /work/tools/g1b_verify_gate.py \
    --home /work/verification-delete/gate-env/home \
    --workspace /work/verification-delete/gate-workspace \
    --marker g1b-verification-<runid>-seed-gate-env --expect enabled
# -> GATE_ENABLED=yes  GATE_RECORD_IS_NONE=no  GATE_DB_EXISTS_AFTER=yes
```

**Evidence table (discovered from `sqlite_master`, never assumed):** the gate-ON
store lists `meta,verification_events,verification_state`; the marker-matched
ledger table used by every persistence assertion below is
**`verification_events`** (columns include `created_at`, `session_id`, `cwd`,
`root`, `command`, `canonical_command`, `kind`, `scope`, `status`,
`output_summary`). `record_verify_run()` also projects one row into
`verification_state`, which is why a marker's total match across the store is
`2` while its `verification_events` count is `1`.

### Exact commands

All commands run INSIDE the container; `HOME=/work/home`, and the only writable
location is the bind-mounted scratch root. Every fixture home also carries
`agent.verify_on_stop: true` (the config form) while the writer additionally
sets `HERMES_VERIFY_ON_STOP=1` (the env form); the writer records
`SEED_VERIFY_ON_STOP=1` / `RUN1_VERIFY_ON_STOP=1` / `RUN2_VERIFY_ON_STOP=1`.

```text
# 1. seed a real WAL store (fixture config: database.journal_mode: wal + agent.verify_on_stop: true)
/opt/src/hermes-venv/bin/python /work/tools/g1b_writers.py verification g1b-verification-<runid>-seed \
    --home /work/verification-delete/seed-wal/home --scratch /work/scratch

# 2. copy it aside and prove byte identity
cp -a -- /work/verification-delete/seed-wal/home/verification_evidence.db \
        /work/verification-delete/conversion/verification_evidence.db
sha256sum /work/verification-delete/seed-wal/home/verification_evidence.db \
          /work/verification-delete/conversion/verification_evidence.db
cmp -s  /work/verification-delete/seed-wal/home/verification_evidence.db \
        /work/verification-delete/conversion/verification_evidence.db

# 3. convert ONLY the copy, offline, with the stock conversion path
HERMES_HOME=/work/verification-delete/seed-wal/home \
  /usr/local/bin/hermes sessions set-journal-mode delete \
  --db /work/verification-delete/conversion/verification_evidence.db

# 4. delete fixture: a fresh cp -a of the converted copy + delete-resolving config
cp -a -- /work/verification-delete/conversion/verification_evidence.db \
        /work/verification-delete/delete/home/verification_evidence.db
/opt/src/hermes-venv/bin/python /work/tools/g1b_writers.py verification g1b-verification-<runid>-1 \
    --home /work/verification-delete/delete/home --scratch /work/scratch
/opt/src/hermes-venv/bin/python /work/tools/g1b_writers.py verification g1b-verification-<runid>-2 \
    --home /work/verification-delete/delete/home --scratch /work/scratch

# 5. WAL control: the SAME converted copy under a wal-resolving config
cp -a -- /work/verification-delete/conversion/verification_evidence.db \
        /work/verification-delete/wal-control/home/verification_evidence.db
/opt/src/hermes-venv/bin/python /work/tools/g1b_writers.py verification g1b-verification-<runid>-control \
    --home /work/verification-delete/wal-control/home --scratch /work/scratch
```

The stock conversion path printed
`✓ /work/verification-delete/conversion/verification_evidence.db: journal_mode wal → delete (header verified).`
and warned that a config still saying `wal` would flip the file back on the
next open — which is exactly why the delete fixture home carries
`database.journal_mode: delete` (and the control home `wal`). The resolved
mode is read before every writer (`resolve_journal_mode()` via
`/opt/src/hermes-venv/bin/python`), never through SQLite. The real writer is
`agent.verification_evidence.record_verify_run(session_id=<marker>, ok=True)`
(through `g1b_writers.py`); the session marker becomes
`verification_events.session_id`, so the identifiable record is a value the
probe chose.

### Per-stage table

Journal format is read ONLY from raw header bytes 18/19 (`read_header.py`).
`header 18/19` is reported separately from the sidecars, and none of these
values came from a SQLite connection.

| Stage | Path (container) | Size | sha256 | Header 18/19 | Mode | Sidecars (`-wal`,`-shm`,`-journal`) | Writer runs |
| --- | --- | --- | --- | --- | --- | --- | --- |
| seed WAL | `/work/verification-delete/seed-wal/home/verification_evidence.db` | 32768 | `8b5372250c60a6af0ef1873036eb09007b99336c905bfa8f8ffd2febaae0b24a` | 2,2 | wal | absent, absent, absent | 1 (seed writer) |
| copy before conversion | `/work/verification-delete/conversion/verification_evidence.db` | 32768 | `8b5372250c60a6af0ef1873036eb09007b99336c905bfa8f8ffd2febaae0b24a` | 2,2 | wal | absent, absent, absent | 0 |
| converted copy (offline) | `/work/verification-delete/conversion/verification_evidence.db` | 32768 | `92e2d727f8de49087095be08a0d6e6fd4cba65968140289aaa28b59a89cbe205` | 1,1 | delete | absent, absent, absent | 0 (offline conversion) |
| delete home before writers | `/work/verification-delete/delete/home/verification_evidence.db` | 32768 | `92e2d727f8de49087095be08a0d6e6fd4cba65968140289aaa28b59a89cbe205` | 1,1 | delete | absent, absent, absent | seed row carried over |
| delete home after run 1 | `/work/verification-delete/delete/home/verification_evidence.db` | 32768 | `f8f9b6e04e16708a680f4708c094fed64aa5784a6accd34cf573557a243c98d9` | 1,1 | delete | absent, absent, absent | 2 |
| delete home after run 2 | `/work/verification-delete/delete/home/verification_evidence.db` | 32768 | `2678fa7e2a5db30ea007c61de8c41146ff587efcd7f862f6dfeebb5a75bc0703` | 1,1 | delete | absent, absent, absent | 3 |
| wal control before writer | `/work/verification-delete/wal-control/home/verification_evidence.db` | 32768 | `92e2d727f8de49087095be08a0d6e6fd4cba65968140289aaa28b59a89cbe205` | 1,1 | delete | absent, absent, absent | seed row carried over |
| wal control after writer | `/work/verification-delete/wal-control/home/verification_evidence.db` | 32768 | `266cc69417b9e6771d817ec1fc8ed5bd2cc2b88e55a86f7e525e0457a04988f9` | 2,2 | wal | absent, absent, absent | 2 |

Both delete-mode header readings (after run 1 and after run 2) are `1,1`
(`delete`), and the header is re-read after each read-only persistence check and
is still `1,1` — the evidence records both readings.

**What these assertions would catch if the store had reverted to WAL:**

- *Opt-in gate* — if the gate were not genuinely OFF in the first case, the
  "absent + `None`" observation would be meaningless (the store might simply
  not have been triggered); if it were not genuinely ON in the other two, a
  later "delete honoured" reading could be attributed to a store the writer
  never opened. The proof is that OFF leaves no file **and** returns `None`,
  while both ON forms create the file and return real event ids.
- *Seed stage* — if the seeded store were not really WAL, the experiment would
  start from the wrong state and a later "stays delete" reading would prove
  nothing; a `2,2` seed is the precondition that makes the 1,1 observations
  meaningful.
- *Copy stage* — if `cp -a` had produced a different file (or the original had
  been converted in place), the experiment would silently bundle conversion and
  writer effects; `sha256` equality plus `cmp -s` proves the copy is
  byte-identical and the original untransformed.
- *Conversion stage* — if the offline conversion had not written the header (or
  had touched the original), the `1,1` reading and the unchanged original
  sha256 are what fail.
- *Two delete-mode writer runs* — if the real writer re-opened the store in WAL
  (the reversion this bead is about), header bytes 18/19 would be `2,2` after a
  close and the sidecars would include a `-wal`/`-shm`; the assertions require
  `1,1` after EACH close and all three sidecars absent.
- *Persistence assertion* — if the store had reverted to WAL and then lost its
  un-checkpointed committed row (or the writer never committed), the read-only
  `verification_events` count would stay `0` instead of flipping to `1`;
  unchanged header bytes alone could not distinguish "committed and persisted in
  delete mode" from "never committed".

### Identifiable-record assertion (the bead's heart)

After EACH writer closed, a **separate short-lived read-only connection**
(`sqlite3.connect('file:<path>?mode=ro', uri=True)` plus
`PRAGMA query_only=ON`, from `g1b_readonly.py`) asked whether that run's own
marker exists in the discovered `verification_events` table. It never reads a
journal mode and cannot write a row.

Before run 1 both markers are absent; after run 1 close marker 1 is present and
marker 2 is still absent; before run 2 marker 1 is still present and marker 2 is
absent; after run 2 close both are present. The read-only SQL text is printed
next to each count by the checker (verbatim in the evidence):

```sql
SELECT COUNT(*) FROM "verification_events" WHERE CAST("created_at" AS TEXT) = ? OR CAST("session_id" AS TEXT) = ? OR CAST("cwd" AS TEXT) = ? OR CAST("root" AS TEXT) = ? OR CAST("command" AS TEXT) = ? OR CAST("canonical_command" AS TEXT) = ? OR CAST("kind" AS TEXT) = ? OR CAST("scope" AS TEXT) = ? OR CAST("status" AS TEXT) = ? OR CAST("output_summary" AS TEXT) = ?
```

(Column list as printed by the checker; the `= ?` placeholders are bound to the
marker. The exact text in the evidence is authoritative — it is printed
character-for-character by `g1b_readonly.py`.)

The observed counts, with the exact marker values (`g1b-verification-<runid>-1`,
`g1b-verification-<runid>-2`):

| Check | Marker | Before | After that run's close |
| --- | --- | --- | --- |
| run 1 persistence | `g1b-verification-20261022T160557Z-2309635-1` | `verification_events` count 0 | `verification_events` count 1 (`total` 2) |
| run 2 persistence | `g1b-verification-20261022T160557Z-2309635-2` | `verification_events` count 0 | `verification_events` count 1 (`total` 2) |
| never written | `g1b-verification-20261022T160557Z-2309635-never-written` | — | total 0 (absent) |

The `total` is the marker match across every table the checker discovered: one
`verification_events` row plus the `verification_state` projection, hence `2`
for an event count of `1`. The conversion itself preserved the seed row: the
read-only check on the placed converted copy found the seed marker
(`verification_events` count 1, `total` 2) before either writer ran.

**What would fail on a WAL reversion:** the writers' rows would either vanish
(after a restart/checkpoint of an uncommitted `-wal`) or the store would report
`2,2` after close together with a non-empty `-wal`/`-shm`; neither the missing
row nor the WAL header/sidecar state can be explained away by a successful
opener.

### Sidecars after each writer close

| Run | `-wal` | `-shm` | `-journal` |
| --- | --- | --- | --- |
| after run 1 | absent | absent | absent |
| after run 2 | absent | absent | absent |

The assertions require all three to be absent after each close (no non-empty
`-wal`/`-shm` and no `-journal` file left behind). **What would fail on a WAL
reversion:** a re-opened WAL store leaves a `-wal` (and usually a `-shm`)
beside the database; a rollback journal left mid-transaction would show a
`-journal`, so "absent" is the observable that separates a clean delete-mode
close from both failure modes.

### WAL control

The SAME converted copy (byte-identical to the `1,1` artifact) was placed in a
home whose config resolves to `wal` and the real writer ran once:
`CONTROL_RESOLVED_MODE=wal`, pre-writer header `1,1`, post-writer header
**`2,2`** (`wal`), and the control marker was then present read-only
(`verification_events` count 1). This proves the delete-mode persistence above
is **configuration-honouring, not immovable**: the store is not a one-way
converted file, and the resolver — not the file's prior header — decides the
next open.

**What would fail on a WAL reversion:** nothing here — the control is supposed
to go back to `2,2`. It is the observation that makes the `1,1` result
meaningful: if the control also stayed `1,1`, the writer would be ignoring the
`wal` configuration and the delete-mode result could not be attributed to the
configured mode.

### Verdict

Verdict: `verification_evidence.db` HONOURING

`verification_evidence.db` was proven gated (OFF: guard disabled,
`record_verify_run()` returns `None`, store absent before and after; CONFIG ON
and the `HERMES_VERIFY_ON_STOP=1` env form: guard enabled, real event returned,
store appears), seeded WAL (`2,2`), copied byte-identically, converted offline
on the copy (`1,1`, original sha256 unchanged), stayed `1,1` with all three
sidecars absent across TWO consecutive real writer runs under a
`delete`-resolving config, persisted a specific identifiable
`verification_events` row per run (read-only absent→present), and returned to
`2,2` only in the `wal`-resolving control. The exercised runtime is the
published image's stock Hermes
`4d04303818b61bf3aa09278af48356315515965b` with a clean checkout before and
after.

Scope restatement: this is a container result about the image's own writers. It
**does not** qualify Matchlock's shared-filesystem behaviour across a guest
boundary, and the relationship between this Docker artifact
(`sha256:d15b7b37…`) and the Matchlock artifact (`sha256:9140629c…`) remains
**UNVERIFIED**.

---

## Offline conversion persistence for `kanban.db` (G1-B)

**Store identity.** `kanban.db` is the **OPTIONAL kanban board store**: the
`default` board, opened by the real `hermes kanban` trigger. It is gated by
*use* (a default session never touches it), so the writer exercised here is the
real record-committing trigger `hermes kanban create "<marker>" --json` —
`kanban list` commits no record and is **not** an acceptable writer.

**Path resolution (recorded by the probe BEFORE any writer runs).**
`kanban_home()` is `HERMES_KANBAN_HOME` when set, otherwise
`hermes_constants.get_default_hermes_root()`, and the default board lives at
`<kanban_home>/kanban.db` (additional named boards live under
`<kanban_home>/kanban/boards`, selected by `<kanban_home>/kanban/current`). The
board root is **shared across profiles by design** — resolving through the
active profile's `HERMES_HOME` would fork the board per profile and break the
dispatcher/worker handoff — so a named profile's
`HERMES_HOME=<root>/profiles/<name>` still resolves the board to
`<root>/kanban.db`. The probe therefore uses a **default-profile fixture root**:
`HERMES_HOME` *is* the board root, so the store is
`<fixture home>/kanban.db`, and `HERMES_KANBAN_HOME`, `HERMES_KANBAN_DB` and
`HERMES_KANBAN_BOARD` are unset so neither the override nor a non-default board
can redirect it. Both resolutions are recorded as evidence:

| Path probe | `HERMES_HOME` | `get_default_hermes_root()` | `kanban_home()` | Resolved store |
| --- | --- | --- | --- | --- |
| default profile (the fixture) | `/work/kanban-delete/seed-wal/home` | `/work/kanban-delete/seed-wal/home` | `/work/kanban-delete/seed-wal/home` | `/work/kanban-delete/seed-wal/home/kanban.db` |
| named profile (shared-board proof) | `/work/kanban-delete/profile-resolution/profiles/named` | `/work/kanban-delete/profile-resolution` | `/work/kanban-delete/profile-resolution` | `/work/kanban-delete/profile-resolution/kanban.db` (NOT the profile home) |

The current board in the fixture resolves to `default`
(`DEFAULT_PROFILE_CURRENT_BOARD=default`), and `KANBAN_ENV_OVERRIDES_UNSET=yes`.

Harness: `docs/gate/probes/g1b/probe_kanban_delete.sh` (host orchestrator, one
kept `mktemp -d /tmp/g1b-kanban-delete.XXXXXX` root, one container run through
the single `g1b_container_run` gateway) and
`docs/gate/probes/g1b/g1b_kanban_delete_container.sh` (container driver).
Evidence: `docs/gate/evidence/g1b/kanban-delete.txt` — **112 assertions, 0
failures**. Scratch root (kept as evidence): `/tmp/g1b-kanban-delete.R1lAlg`,
bind-mounted at `/work`.

Exercised runtime: Docker image
`sha256:d15b7b377d679c6561315f7054e16f0310b3956cff872c23818d90073b29934a`
(`igorhvr/tamandua:latest`, `linux/amd64`), stock Hermes revision
`4d04303818b61bf3aa09278af48356315515965b` with an empty
`git status --porcelain` before and after the runs, launcher
`/usr/local/bin/hermes`, runtime Python `/opt/src/hermes-venv/bin/python`.

### Exact commands

All commands run INSIDE the container; `HOME=/work/home`,
`HERMES_KANBAN_HOME`/`HERMES_KANBAN_DB`/`HERMES_KANBAN_BOARD` are unset, and
the only writable location is the bind-mounted scratch root.

```text
# 1. seed a real WAL store (fixture config: database.journal_mode: wal)
/opt/src/hermes-venv/bin/python /work/tools/g1b_writers.py kanban g1b-kanban-<runid>-seed \
    --home /work/kanban-delete/seed-wal/home --scratch /work/scratch

# 2. copy it aside and prove byte identity
cp -a -- /work/kanban-delete/seed-wal/home/kanban.db \
        /work/kanban-delete/conversion/kanban.db
sha256sum /work/kanban-delete/seed-wal/home/kanban.db \
          /work/kanban-delete/conversion/kanban.db
cmp -s  /work/kanban-delete/seed-wal/home/kanban.db \
        /work/kanban-delete/conversion/kanban.db

# 3. convert ONLY the copy, offline, with the stock conversion path
HERMES_HOME=/work/kanban-delete/seed-wal/home \
  /usr/local/bin/hermes sessions set-journal-mode delete \
  --db /work/kanban-delete/conversion/kanban.db

# 4. delete fixture: a fresh cp -a of the converted copy + delete-resolving config
cp -a -- /work/kanban-delete/conversion/kanban.db \
        /work/kanban-delete/delete/home/kanban.db
/opt/src/hermes-venv/bin/python /work/tools/g1b_writers.py kanban g1b-kanban-<runid>-1 \
    --home /work/kanban-delete/delete/home --scratch /work/scratch
/opt/src/hermes-venv/bin/python /work/tools/g1b_writers.py kanban g1b-kanban-<runid>-2 \
    --home /work/kanban-delete/delete/home --scratch /work/scratch

# 5. WAL control: the SAME converted copy under a wal-resolving config
cp -a -- /work/kanban-delete/conversion/kanban.db \
        /work/kanban-delete/wal-control/home/kanban.db
/opt/src/hermes-venv/bin/python /work/tools/g1b_writers.py kanban g1b-kanban-<runid>-control \
    --home /work/kanban-delete/wal-control/home --scratch /work/scratch
```

Each `g1b_writers.py kanban` invocation runs `hermes kanban create "<marker>"
--json` with `HERMES_HOME` set to the fixture home and prints the store-assigned
task id (`t_xxxxxxxx`) plus the marker title. The stock conversion path printed
`✓ /work/kanban-delete/conversion/kanban.db: journal_mode wal → delete (header
verified).` and warned that a config still saying `wal` would switch the file
back on the next open (`Note: config.yaml has database.journal_mode: wal …`) —
which is exactly why the delete fixture home carries
`database.journal_mode: delete` (and the control home `wal`). The resolved mode
is read before every writer (`resolve_journal_mode()` via
`/opt/src/hermes-venv/bin/python`), never through SQLite.

### Per-stage table

Journal format is read ONLY from raw header bytes 18/19 (`read_header.py`).
`header 18/19` is reported separately from the sidecars, and none of these
values came from a SQLite connection.

| Stage | Path (container) | Size | sha256 | Header 18/19 | Mode | Sidecars (`-wal`,`-shm`,`-journal`) | Writer runs |
| --- | --- | --- | --- | --- | --- | --- | --- |
| seed WAL | `/work/kanban-delete/seed-wal/home/kanban.db` | 118784 | `1f957c3de65ad24fc025d0e7d95053ac70ab017ab9b0ce3f0ce52c60c83be230` | 2,2 | wal | absent, absent, absent | 1 (seed trigger) |
| copy before conversion | `/work/kanban-delete/conversion/kanban.db` | 118784 | `1f957c3de65ad24fc025d0e7d95053ac70ab017ab9b0ce3f0ce52c60c83be230` | 2,2 | wal | absent, absent, absent | 0 |
| converted copy (offline) | `/work/kanban-delete/conversion/kanban.db` | 118784 | `f3509acf0bb7e17622c9f51eaf7839c330331c377aca8c752a0871d453b86d1a` | 1,1 | delete | absent, absent, absent | 0 (offline conversion) |
| delete home before writers | `/work/kanban-delete/delete/home/kanban.db` | 118784 | `f3509acf0bb7e17622c9f51eaf7839c330331c377aca8c752a0871d453b86d1a` | 1,1 | delete | absent, absent, absent | seed task carried over |
| delete home after run 1 | `/work/kanban-delete/delete/home/kanban.db` | 118784 | `ab36e424825c089bc1b831b9a014f67e1341f25eebb229954412bca2fac19c41` | 1,1 | delete | absent, absent, absent | 2 |
| delete home after run 2 | `/work/kanban-delete/delete/home/kanban.db` | 118784 | `ffa43297d58c9de44183839ea54049ad69e2b1611be24d0f428065d7d57af48c` | 1,1 | delete | absent, absent, absent | 3 |
| wal control before writer | `/work/kanban-delete/wal-control/home/kanban.db` | 118784 | `f3509acf0bb7e17622c9f51eaf7839c330331c377aca8c752a0871d453b86d1a` | 1,1 | delete | absent, absent, absent | seed task carried over |
| wal control after writer | `/work/kanban-delete/wal-control/home/kanban.db` | 118784 | `8e2e01a175839017ca57e79985cd83777b9cfdbb91a61307428dc6723108583a` | 2,2 | wal | absent, absent, absent | 2 |

Both delete-mode header readings (after run 1 and after run 2) are `1,1`
(`delete`), and the header is re-read after each read-only persistence check and
is still `1,1` — the evidence records both readings. The board also drops a
zero-byte `kanban.db.init.lock` (an init lock, reported separately from the
journal sidecars); the three journal sidecars are absent at every stage.

**What these assertions would catch if the store had reverted to WAL:**

- *Path resolution* — if the fixture home were not the board root (e.g. a named
  profile that resolved somewhere else, or a stray `HERMES_KANBAN_HOME`), the
  writer would open a DIFFERENT file and every later header/persistence reading
  would describe a store the probe never converted; the recorded
  `kanban_home()`/store paths and the unset-override assertion are what fail.
- *Seed stage* — if the seeded store were not really WAL, the experiment would
  start from the wrong state and a later "stays delete" reading would prove
  nothing; a `2,2` seed is the precondition that makes the 1,1 observations
  meaningful.
- *Copy stage* — if `cp -a` had produced a different file (or the original had
  been converted in place), the experiment would silently bundle conversion and
  writer effects; `sha256` equality plus `cmp -s` proves the copy is
  byte-identical and the original untransformed.
- *Conversion stage* — if the offline conversion had not written the header (or
  had touched the original), the `1,1` reading and the unchanged original
  sha256 are what fail.
- *Two delete-mode writer runs* — if the real trigger re-opened the store in WAL
  (the reversion this bead is about), header bytes 18/19 would be `2,2` after a
  close and the sidecars would include a `-wal`/`-shm`; the assertions require
  `1,1` after EACH close and all three sidecars absent.
- *Persistence assertion* — if the store had reverted to WAL and then lost its
  un-checkpointed committed task row (or the trigger never committed), the
  read-only `tasks` count would stay `0` instead of flipping to `1`; unchanged
  header bytes alone could not distinguish "committed and persisted in delete
  mode" from "never committed".

### Identifiable-record assertion (the bead's heart)

After EACH writer closed, a **separate short-lived read-only connection**
(`sqlite3.connect('file:<path>?mode=ro', uri=True)` plus
`PRAGMA query_only=ON`, from `g1b_readonly.py`) asked whether that run's own
marker exists as a `tasks` row. The task table was reported by the stock writer
AND confirmed by the marker match discovered from `sqlite_master`
(`EVIDENCE_TABLE=tasks`); the identifiable row is `tasks.title = <marker>` (the
store assigns the primary key `t_…`). The checker never reads a journal mode
and cannot write a row.

Before run 1 both markers are absent; after run 1 close marker 1 is present and
marker 2 is still absent; before run 2 marker 1 is still present and marker 2 is
absent; after run 2 close both are present. The read-only SQL text is printed
next to each count by the checker (verbatim in the evidence):

```sql
SELECT COUNT(*) FROM "tasks" WHERE CAST("id" AS TEXT) = ? OR CAST("title" AS TEXT) = ? OR CAST("body" AS TEXT) = ? OR CAST("assignee" AS TEXT) = ? OR CAST("status" AS TEXT) = ? OR CAST("created_by" AS TEXT) = ? OR CAST("workspace_kind" AS TEXT) = ? OR CAST("workspace_path" AS TEXT) = ? OR CAST("branch_name" AS TEXT) = ? OR CAST("project_id" AS TEXT) = ? OR CAST("claim_lock" AS TEXT) = ? OR CAST("tenant" AS TEXT) = ? OR CAST("result" AS TEXT) = ? OR CAST("idempotency_key" AS TEXT) = ? OR CAST("last_failure_error" AS TEXT) = ? OR CAST("workflow_template_id" AS TEXT) = ? OR CAST("current_step_key" AS TEXT) = ? OR CAST("skills" AS TEXT) = ? OR CAST("model_override" AS TEXT) = ? OR CAST("provider_override" AS TEXT) = ? OR CAST("reasoning_effort" AS TEXT) = ? OR CAST("session_id" AS TEXT) = ? OR CAST("block_kind" AS TEXT) = ? OR CAST("completion_contract" AS TEXT) = ?
```

(Column list as printed by the checker; the `= ?` placeholders are bound to the
marker. The exact text in the evidence is authoritative — it is printed
character-for-character by `g1b_readonly.py`.)

The observed counts, with the exact marker values (`g1b-kanban-<runid>-1`,
`g1b-kanban-<runid>-2`) and task ids:

| Check | Marker | Row | Before | After that run's close |
| --- | --- | --- | --- | --- |
| run 1 persistence | `g1b-kanban-20261022T180904Z-2507659-1` | `tasks` id `t_67855fed`, title = marker | `tasks` count 0 | `tasks` count 1 (`total` 1) |
| run 2 persistence | `g1b-kanban-20261022T180904Z-2507659-2` | `tasks` id `t_e11cba74`, title = marker | `tasks` count 0 | `tasks` count 1 (`total` 1) |
| never written | `g1b-kanban-20261022T180904Z-2507659-never-written` | — | — | total 0 (absent) |

The conversion itself preserved the seed task: the read-only check on the
placed converted copy found the seed marker (`tasks` count 1, seed task id
`t_d15f61a4`) before either writer ran. A `tasks` marker matches exactly one row
in this store (the task table only), so `total` equals the per-table count.

**What would fail on a WAL reversion:** the writers' task rows would either
vanish (after a restart/checkpoint of an uncommitted `-wal`) or the store would
report `2,2` after close together with a non-empty `-wal`/`-shm`; neither the
missing row nor the WAL header/sidecar state can be explained away by a
successful opener.

### Sidecars after each writer close

| Run | `-wal` | `-shm` | `-journal` |
| --- | --- | --- | --- |
| after run 1 | absent | absent | absent |
| after run 2 | absent | absent | absent |

The assertions require all three to be absent after each close (no non-empty
`-wal`/`-shm` and no `-journal` file left behind). **What would fail on a WAL
reversion:** a re-opened WAL store leaves a `-wal` (and usually a `-shm`)
beside the database; a rollback journal left mid-transaction would show a
`-journal`, so "absent" is the observable that separates a clean delete-mode
close from both failure modes.

### WAL control

The SAME converted copy (byte-identical to the `1,1` artifact,
`sha256:f3509acf…`) was placed in a home whose config resolves to `wal` and the
real trigger ran once: `CONTROL_RESOLVED_MODE=wal`, pre-writer header `1,1`,
post-writer header **`2,2`** (`wal`), and the control task was then present
read-only (`tasks` count 1, id `t_78f4fd00`). This proves the delete-mode
persistence above is **configuration-honouring, not immovable**: the store is
not a one-way converted file, and the resolver — not the file's prior header —
decides the next open.

**What would fail on a WAL reversion:** nothing here — the control is supposed
to go back to `2,2`. It is the observation that makes the `1,1` result
meaningful: if the control also stayed `1,1`, the writer would be ignoring the
`wal` configuration and the delete-mode result could not be attributed to the
configured mode.

### Verdict

Verdict: `kanban.db` HONOURING

`kanban.db` was exercised through its real record-committing trigger
(`hermes kanban create "<marker>"`), with the store path resolved and recorded
first (default-profile fixture root; a named profile resolves to the shared
board root instead of a per-profile store), seeded WAL (`2,2`), copied
byte-identically, converted offline on the copy (`1,1`, original sha256
unchanged), stayed `1,1` with all three sidecars absent across TWO consecutive
real trigger runs under a `delete`-resolving config, persisted a specific
identifiable `tasks` row per run (read-only absent→present, exact task id and
title recorded), and returned to `2,2` only in the `wal`-resolving control. The
exercised runtime is the published image's stock Hermes
`4d04303818b61bf3aa09278af48356315515965b` with a clean checkout before and
after.

Scope restatement: this is a container result about the image's own writers. It
**does not** qualify Matchlock's shared-filesystem behaviour across a guest
boundary, and the relationship between this Docker artifact
(`sha256:d15b7b37…`) and the Matchlock artifact (`sha256:9140629c…`) remains
**UNVERIFIED**.

---

## Offline conversion persistence for `projects.db` (G1-B)

**Store identity.** `projects.db` is the **PER-PROFILE first-class Projects
store** (`hermes_cli/projects_db.py`), opened by the real
`hermes project` trigger. It is gated by *use* (a default session never touches
it), so the writer exercised here is the real record-committing trigger
`hermes project create "<marker>" --slug <marker>` — `project list` commits no
record and is **not** an acceptable writer. The trigger needs **no folder and
no `--primary` path**: the stock command creates the project row without one,
so no scratch repository (and never an operator path) is involved.

**Path resolution (recorded by the probe BEFORE any writer runs).**
`get_hermes_home()` is the context override, else the `HERMES_HOME` environment
variable, else the platform default; `projects_db_path()` is
`get_hermes_home() / "projects.db"`. `projects.db` is therefore **PER-PROFILE**:
unlike the kanban board store (whose root is shared across profiles by design),
a named profile with `HERMES_HOME=<root>/profiles/<name>` resolves its **own**
`<root>/profiles/<name>/projects.db`. There is **no projects-specific path
override environment variable** — only `HERMES_HOME` (or a context override)
moves the store. The fixture home *is* the profile home, so the store is
`<fixture home>/projects.db`. Both resolutions are recorded as evidence:

| Path probe | `HERMES_HOME` | `get_hermes_home()` | `projects_db_path()` |
| --- | --- | --- | --- |
| default profile (the fixture) | `/work/projects-delete/seed-wal/home` | `/work/projects-delete/seed-wal/home` | `/work/projects-delete/seed-wal/home/projects.db` |
| named profile (per-profile proof) | `/work/projects-delete/profile-resolution/profiles/named` | `/work/projects-delete/profile-resolution/profiles/named` | `/work/projects-delete/profile-resolution/profiles/named/projects.db` |

The probe records `PROJECTS_PATH_OVERRIDE_ENV=none` and
`PROJECTS_SLUG_NORMALIZATION`: `--slug` is lowercased by `normalize_slug()`
while the marker is stored verbatim as `projects.name`, which is the column the
read-only assertion matches. The project table was reported by the stock writer
and independently discovered from `sqlite_master` (`EVIDENCE_TABLE=projects`).

Harness: `docs/gate/probes/g1b/probe_projects_delete.sh` (host orchestrator, one
kept `mktemp -d /tmp/g1b-projects-delete.XXXXXX` root, one container run through
the single `g1b_container_run` gateway) and
`docs/gate/probes/g1b/g1b_projects_delete_container.sh` (container driver).
Evidence: `docs/gate/evidence/g1b/projects-delete.txt` — **114 assertions, 0
failures**. Scratch root (kept as evidence): `/tmp/g1b-projects-delete.iIrirJ`,
bind-mounted at `/work`.

Exercised runtime: Docker image
`sha256:d15b7b377d679c6561315f7054e16f0310b3956cff872c23818d90073b29934a`
(`igorhvr/tamandua:latest`, `linux/amd64`), stock Hermes revision
`4d04303818b61bf3aa09278af48356315515965b` with an empty
`git status --porcelain` before and after the runs, launcher
`/usr/local/bin/hermes`, runtime Python `/opt/src/hermes-venv/bin/python`.

### Exact commands

All commands run INSIDE the container; `HOME=/work/home` and the only writable
location is the bind-mounted scratch root.

```text
# 1. seed a real WAL store (fixture config: database.journal_mode: wal)
/opt/src/hermes-venv/bin/python /work/tools/g1b_writers.py projects g1b-projects-<runid>-seed \
    --home /work/projects-delete/seed-wal/home --scratch /work/scratch

# 2. copy it aside and prove byte identity
cp -a -- /work/projects-delete/seed-wal/home/projects.db \
        /work/projects-delete/conversion/projects.db
sha256sum /work/projects-delete/seed-wal/home/projects.db \
          /work/projects-delete/conversion/projects.db
cmp -s  /work/projects-delete/seed-wal/home/projects.db \
        /work/projects-delete/conversion/projects.db

# 3. convert ONLY the copy, offline, with the stock conversion path
HERMES_HOME=/work/projects-delete/seed-wal/home \
  /usr/local/bin/hermes sessions set-journal-mode delete \
  --db /work/projects-delete/conversion/projects.db

# 4. delete fixture: a fresh cp -a of the converted copy + delete-resolving config
cp -a -- /work/projects-delete/conversion/projects.db \
        /work/projects-delete/delete/home/projects.db
/opt/src/hermes-venv/bin/python /work/tools/g1b_writers.py projects g1b-projects-<runid>-1 \
    --home /work/projects-delete/delete/home --scratch /work/scratch
/opt/src/hermes-venv/bin/python /work/tools/g1b_writers.py projects g1b-projects-<runid>-2 \
    --home /work/projects-delete/delete/home --scratch /work/scratch

# 5. WAL control: the SAME converted copy under a wal-resolving config
cp -a -- /work/projects-delete/conversion/projects.db \
        /work/projects-delete/wal-control/home/projects.db
/opt/src/hermes-venv/bin/python /work/tools/g1b_writers.py projects g1b-projects-<runid>-control \
    --home /work/projects-delete/wal-control/home --scratch /work/scratch
```

Each `g1b_writers.py projects` invocation runs `hermes project create
"<marker>" --slug <marker>` with `HERMES_HOME` set to the fixture home and prints
the store-assigned project id (`p_xxxxxxxx`) plus the marker slug/name. The stock
conversion path printed `✓ /work/projects-delete/conversion/projects.db:
journal_mode wal → delete (header verified).` and warned that a config still
saying `wal` would switch the file back on the next open
(`Note: config.yaml has database.journal_mode: wal …`) — which is exactly why
the delete fixture home carries `database.journal_mode: delete` (and the control
home `wal`). The resolved mode is read before every writer
(`resolve_journal_mode()` via `/opt/src/hermes-venv/bin/python`), never through
SQLite.

### Per-stage table

Journal format is read ONLY from raw header bytes 18/19 (`read_header.py`).
`header 18/19` is reported separately from the sidecars, and none of these
values came from a SQLite connection.

| Stage | Path (container) | Size | sha256 | Header 18/19 | Mode | Sidecars (`-wal`,`-shm`,`-journal`) | Writer runs |
| --- | --- | --- | --- | --- | --- | --- | --- |
| seed WAL | `/work/projects-delete/seed-wal/home/projects.db` | 45056 | `fc925457ca0e6945ced9b69806ec5eda049798d0358de9bc1a58362d6407693c` | 2,2 | wal | absent, absent, absent | 1 (seed trigger) |
| copy before conversion | `/work/projects-delete/conversion/projects.db` | 45056 | `fc925457ca0e6945ced9b69806ec5eda049798d0358de9bc1a58362d6407693c` | 2,2 | wal | absent, absent, absent | 0 |
| converted copy (offline) | `/work/projects-delete/conversion/projects.db` | 45056 | `5f4c19f2dd9e2c012b78294cf816f18ddf68a2a3f0909b1bd7107244a28948c3` | 1,1 | delete | absent, absent, absent | 0 (offline conversion) |
| delete home before writers | `/work/projects-delete/delete/home/projects.db` | 45056 | `5f4c19f2dd9e2c012b78294cf816f18ddf68a2a3f0909b1bd7107244a28948c3` | 1,1 | delete | absent, absent, absent | seed project carried over |
| delete home after run 1 | `/work/projects-delete/delete/home/projects.db` | 45056 | `35f30141b7a828b51a610cdcf5f0edd420ca52b49937b27a7d5020c3b88c2090` | 1,1 | delete | absent, absent, absent | 2 |
| delete home after run 2 | `/work/projects-delete/delete/home/projects.db` | 45056 | `61099d9e8d49d406c6bcebc9653ea323e63533a2e4a62a8b8b266de7139fe5a7` | 1,1 | delete | absent, absent, absent | 3 |
| wal control before writer | `/work/projects-delete/wal-control/home/projects.db` | 45056 | `5f4c19f2dd9e2c012b78294cf816f18ddf68a2a3f0909b1bd7107244a28948c3` | 1,1 | delete | absent, absent, absent | seed project carried over |
| wal control after writer | `/work/projects-delete/wal-control/home/projects.db` | 45056 | `859a8cee0862bc23879ffb9307010514fb860994728f004acc0d763db829d2c2` | 2,2 | wal | absent, absent, absent | 2 |

Both delete-mode header readings (after run 1 and after run 2) are `1,1`
(`delete`), and the header is re-read after each read-only persistence check and
is still `1,1` — the evidence records both readings. The three journal sidecars
are absent at every stage.

**What these assertions would catch if the store had reverted to WAL:**

- *Path resolution* — if the fixture home were not the profile home the writer
  actually reads (e.g. a stray override or a resolver that stripped the profile
  suffix), the writer would open a DIFFERENT file and every later header /
  persistence reading would describe a store the probe never converted; the
  recorded `get_hermes_home()`/`projects_db_path()` values, the per-profile
  contrast and the unset-override note are what fail.
- *Seed stage* — if the seeded store were not really WAL, the experiment would
  start from the wrong state and a later "stays delete" reading would prove
  nothing; a `2,2` seed is the precondition that makes the 1,1 observations
  meaningful.
- *Copy stage* — if `cp -a` had produced a different file (or the original had
  been converted in place), the experiment would silently bundle conversion and
  writer effects; `sha256` equality plus `cmp -s` proves the copy is
  byte-identical and the original untransformed.
- *Conversion stage* — if the offline conversion had not written the header (or
  had touched the original), the `1,1` reading and the unchanged original
  sha256 are what fail.
- *Two delete-mode writer runs* — if the real trigger re-opened the store in WAL
  (the reversion this bead is about), header bytes 18/19 would be `2,2` after a
  close and the sidecars would include a `-wal`/`-shm`; the assertions require
  `1,1` after EACH close and all three sidecars absent.
- *Persistence assertion* — if the store had reverted to WAL and then lost its
  un-checkpointed committed project row (or the trigger never committed), the
  read-only `projects` count would stay `0` instead of flipping to `1`;
  unchanged header bytes alone could not distinguish "committed and persisted in
  delete mode" from "never committed".

### Identifiable-record assertion (the bead's heart)

After EACH writer closed, a **separate short-lived read-only connection**
(`sqlite3.connect('file:<path>?mode=ro', uri=True)` plus
`PRAGMA query_only=ON`, from `g1b_readonly.py`) asked whether that run's own
marker exists as a `projects` row. The project table was reported by the stock
writer AND confirmed by the marker match discovered from `sqlite_master`
(`EVIDENCE_TABLE=projects`); the identifiable row is `projects.name = <marker>`
(the `--slug` argument is normalized/lowercased, while the name is stored
verbatim, and the store assigns the primary key `p_…`). The checker never reads
a journal mode and cannot write a row.

Before run 1 both markers are absent; after run 1 close marker 1 is present and
marker 2 is still absent; before run 2 marker 1 is still present and marker 2 is
absent; after run 2 close both are present. The read-only SQL text is printed
next to each count by the checker (verbatim in the evidence):

```sql
SELECT COUNT(*) FROM "projects" WHERE CAST("id" AS TEXT) = ? OR CAST("slug" AS TEXT) = ? OR CAST("name" AS TEXT) = ? OR CAST("description" AS TEXT) = ? OR CAST("icon" AS TEXT) = ? OR CAST("color" AS TEXT) = ? OR CAST("board_slug" AS TEXT) = ? OR CAST("primary_path" AS TEXT) = ?
```

(Column list as printed by the checker; the `= ?` placeholders are bound to the
marker. The exact text in the evidence is authoritative — it is printed
character-for-character by `g1b_readonly.py`.)

The observed counts, with the exact marker values (`g1b-projects-<runid>-1`,
`g1b-projects-<runid>-2`) and project ids:

| Check | Marker | Row | Before | After that run's close |
| --- | --- | --- | --- | --- |
| run 1 persistence | `g1b-projects-20261022T190128Z-2747439-1` | `projects` id `p_80e276d1`, name = marker | `projects` count 0 | `projects` count 1 (`total` 1) |
| run 2 persistence | `g1b-projects-20261022T190128Z-2747439-2` | `projects` id `p_556afdd1`, name = marker | `projects` count 0 | `projects` count 1 (`total` 1) |
| never written | `g1b-projects-20261022T190128Z-2747439-never-written` | — | — | total 0 (absent) |

The conversion itself preserved the seed project: the read-only check on the
placed converted copy found the seed marker (`projects` count 1, seed project id
`p_369a7302`) before either writer ran. A `projects` marker matches exactly one
row in this store (the project table only), so `total` equals the per-table
count.

**What would fail on a WAL reversion:** the writers' project rows would either
vanish (after a restart/checkpoint of an uncommitted `-wal`) or the store would
report `2,2` after close together with a non-empty `-wal`/`-shm`; neither the
missing row nor the WAL header/sidecar state can be explained away by a
successful opener.

### Sidecars after each writer close

| Run | `-wal` | `-shm` | `-journal` |
| --- | --- | --- | --- |
| after run 1 | absent | absent | absent |
| after run 2 | absent | absent | absent |

The assertions require all three to be absent after each close (no non-empty
`-wal`/`-shm` and no `-journal` file left behind). **What would fail on a WAL
reversion:** a re-opened WAL store leaves a `-wal` (and usually a `-shm`)
beside the database; a rollback journal left mid-transaction would show a
`-journal`, so "absent" is the observable that separates a clean delete-mode
close from both failure modes.

### WAL control

The SAME converted copy (byte-identical to the `1,1` artifact,
`sha256:5f4c19f2…`) was placed in a home whose config resolves to `wal` and the
real trigger ran once: `CONTROL_RESOLVED_MODE=wal`, pre-writer header `1,1`,
post-writer header **`2,2`** (`wal`), and the control project was then present
read-only (`projects` count 1, id `p_23363eb1`). This proves the delete-mode
persistence above is **configuration-honouring, not immovable**: the store is
not a one-way converted file, and the resolver — not the file's prior header —
decides the next open.

**What would fail on a WAL reversion:** nothing here — the control is supposed
to go back to `2,2`. It is the observation that makes the `1,1` result
meaningful: if the control also stayed `1,1`, the writer would be ignoring the
`wal` configuration and the delete-mode result could not be attributed to the
configured mode.

### Verdict

Verdict: `projects.db` HONOURING

`projects.db` was exercised through its real record-committing trigger
(`hermes project create "<marker>" --slug <marker>`), with the store path
resolved and recorded first (per-profile: `projects_db_path()` =
`get_hermes_home()/projects.db`; a named profile resolves its OWN store rather
than a shared-root one), seeded WAL (`2,2`), copied byte-identically, converted
offline on the copy (`1,1`, original sha256 unchanged), stayed `1,1` with all
three sidecars absent across TWO consecutive real trigger runs under a
`delete`-resolving config, persisted a specific identifiable `projects` row per
run (read-only absent→present, exact project id and marker name recorded), and
returned to `2,2` only in the `wal`-resolving control. The exercised runtime is
the published image's stock Hermes
`4d04303818b61bf3aa09278af48356315515965b` with a clean checkout before and
after.

Scope restatement: this is a container result about the image's own writers. It
**does not** qualify Matchlock's shared-filesystem behaviour across a guest
boundary, and the relationship between this Docker artifact
(`sha256:d15b7b37…`) and the Matchlock artifact (`sha256:9140629c…`) remains
**UNVERIFIED**.

---

## Consolidated harness and per-store verdict table (US-007)

One command reproduces the entire G1-B qualification against the PUBLISHED
image's own stock Hermes:

```bash
docs/gate/probes/g1b/run_all.sh
```

It creates ONE fresh `mktemp -d /tmp/g1b-final.XXXXXX` root, gives every child
probe its own scratch root nested inside it (`G1B_TMP_ROOT`), tees the complete
output of every step into `docs/gate/evidence/g1b/final-harness.log`, and
**never** deletes the root — every fixture stays in place as evidence and the
root is printed at the start and in the summary. Per-store outputs are captured
under `<root>/logs/`, so a consolidated run does not rewrite the committed
per-store evidence files (their pinned sha256s and record ids stay valid).

Steps, each running the REAL probe script (never a copy):

| Step | What it runs | Assertions in the recorded run |
| --- | --- | --- |
| `read_header_checks` | the raw-header reader's contract: sha256-checked bootstrap, missing-file / not-a-database / short-header refusals, and the `1,1`→`delete`, `2,2`→`wal`, `unknown(3/4)` classifications on 20-byte header-only fixtures that are explicitly **NOT stores** | 6 |
| `runtime_identity` | `probe_runtime_identity.sh` | 24 |
| `seeding` | `seed_stores.sh` | 147 |
| `read_header_seeded` | raw-header re-read of the four ACTUAL seeded stores through the same reader (must be `2,2`/`wal`) | 4 |
| `state_delete` | `probe_state_delete.sh` | 98 |
| `verification_delete` | `probe_verification_delete.sh` | 128 |
| `kanban_delete` | `probe_kanban_delete.sh` | 112 |
| `projects_delete` | `probe_projects_delete.sh` | 114 |

Every step's exit status is captured **before** any logging/teeing (never
through `| tail`), and the harness exits nonzero when any step failed, any
assertion failed, or a per-store verdict is not `HONOURING` — in which case it
records the BLOCKER policy and the kept reproducer root.

### Recorded consolidated run

`docs/gate/evidence/g1b/final-harness.log` records one full run:

```text
FINAL_HARNESS_RESULT=PASS
TOTAL_ASSERT_PASS=633
TOTAL_ASSERT_FAIL=0
FAILED_STEPS=none
STEP_RC=read_header_checks=0        STEP_RC=runtime_identity=0
STEP_RC=seeding=0                   STEP_RC=read_header_seeded=0
STEP_RC=state_delete=0              STEP_RC=verification_delete=0
STEP_RC=kanban_delete=0             STEP_RC=projects_delete=0
FINAL_SCRATCH_ROOT=/tmp/g1b-final.a985bM (kept as evidence)
SCRATCH_ROOT_KEPT=yes
```

Exercised artifact in that run: image
`sha256:d15b7b377d679c6561315f7054e16f0310b3956cff872c23818d90073b29934a`,
architecture `amd64`, OS `linux` (`--platform linux/amd64`), stock Hermes
revision `4d04303818b61bf3aa09278af48356315515965b` with an empty
`git status --porcelain` before and after. The Matchlock artifact
(`sha256:9140629c9f408a6e9c285434eb6ab0cebd67db146c324db33e2798bac4fb7dff`)
relationship remains **UNVERIFIED**.

### Safety counts recorded by the harness

The consolidated log records the safety counts for the run itself:

```text
CONTAINER_INVOCATIONS=11
CONTAINER_HOME=/work/home (host path <scratch-root>/home, i.e. INSIDE the scratch root)
CONTAINER_HOME_INSIDE_SCRATCH_ROOT=yes (11/11 invocations)
CONTAINER_ONLY_MOUNT_IS_SCRATCH_ROOT=yes (11/11 invocations)
CONTAINER_MOUNTS_OUTSIDE_SCRATCH_ROOT=0
CONTAINER_MOUNTS_UNDER_REAL_OPERATOR_HOME=0
CONTAINER_MOUNTS_UNDER_HOME=0 (no /home/<operator> path is mounted)
CONTAINER_NETWORK_NONE=11/11
CONTAINER_USER_UID_GID=11/11
SAFETY_REAL_OPERATOR_HOME=/home/kaladin/.hermes
SAFETY_EVIDENCE_FILES_SCANNED=7
SAFETY_EVIDENCE_MENTIONS=0
SAFETY_OPENS_OR_WRITES_UNDER_REAL_OPERATOR_HOME=0
SAFETY_PROBE_FILES_NAMING_REAL_OPERATOR_HOME=1 (refusal guard: g1b_common.sh; a mention in a refusal guard is NOT an open or a write)
```

Every container invocation runs with `HOME=/work/home` (inside the mount), its
ONLY mount is its own scratch root (the consolidated root or a child root
nested inside it), `--network none` and the invoking `uid:gid`; no
`/home/<operator>` path is mounted. The scan of every g1b evidence file for the
real operator home reports **zero opens and zero writes**; the only mention in
the repository is the refusal guard in `g1b_common.sh`, which names the path
solely to REFUSE it. **A mention in a refusal guard is not an open or a write.**

### Consolidated per-store verdict table

| Store | Verdict | Identifiable-record assertion (separate read-only connection after the writer closed) | WAL control |
| --- | --- | --- | --- |
| `state.db` | **HONOURING** | run 1 `sessions` marker absent→present, run 2 marker absent→present | same converted copy under `wal` → header `2,2` |
| `verification_evidence.db` | **HONOURING** | run 1 `verification_events` marker absent→present, run 2 marker absent→present (opt-in gate proven on first) | same converted copy under `wal` → header `2,2` |
| `kanban.db` | **HONOURING** | run 1 `tasks` marker absent→present, run 2 marker absent→present | same converted copy under `wal` → header `2,2` |
| `projects.db` | **HONOURING** | run 1 `projects` marker absent→present, run 2 marker absent→present | same converted copy under `wal` → header `2,2` |

Every store also stayed at raw header bytes `1,1` after EACH writer close with
all three sidecars (`-wal`, `-shm`, `-journal`) absent; the per-stage tables and
verbatim read-only SQL are in the four per-store sections above and in the
per-store evidence files.

---

## What remains unproven

- **Matchlock guest-boundary shared-filesystem behaviour.** A container run
  does not qualify Matchlock's shared-filesystem behaviour across a guest
  boundary. Nothing here says whether a Matchlock guest sees the same journal
  mode across a shared host/guest filesystem, nor anything about cross-boundary
  page-cache or fsync semantics. That needs a separate, Matchlock-scoped
  qualification.
- **The artifact relationship.** The Docker artifact qualified here
  (`sha256:d15b7b37…`) and the artifact Matchlock resolves
  (`sha256:9140629c…`) are **not proven** to be the same; the relationship is
  explicitly UNVERIFIED. The consolidated harness records the Docker image id
  and cannot establish anything about the Matchlock artifact.
- **Concurrency / multiple simultaneous writers.** Every probe is single-writer
  and quiesced-writer: the persistence assertion is made after the writer
  closes, on one store at a time. Behaviour under concurrent writers on the same
  store (lock contention, retry, journal-mode races) is NOT exercised.
- **Stores/features not triggered.** Any store or writer path not exercised by
  the per-store probes stays unqualified. The gated stores
  (`verification_evidence.db` verify-on-stop ledger, `kanban.db` board,
  `projects.db` projects) are qualified only with their features ENABLED and
  their real triggers used; other Hermes stores and other code paths that call
  `apply_wal_with_fallback()` are out of scope for this bead.
- **Long-run / crash behaviour.** No crash, power-loss, or partially-written
  journal scenario is exercised; the experiment proves configuration honouring
  across a real committed write, not durability under failure.
- **The gate's production observer.** These read-only opening rules bind the
  fixtures only. The production observer's "never open SQLite" rule is
  unchanged and is not re-qualified here.

---

## BLOCKER policy

If a store's real writer demonstrably ignores `delete`, G1-B **stops**: preserve the reproducer
(the scratch root stays; the consolidated harness prints it and keeps it),
report a BLOCKER, and never exclude the store, weaken a refusal,
fabricate a verdict, or add exclusivity to force a pass. The consolidated
harness enforces the same rule mechanically: it exits nonzero when any step or
assertion failed or any per-store verdict is not `HONOURING`, and it writes the
BLOCKER policy and the kept reproducer root into the consolidated log.
