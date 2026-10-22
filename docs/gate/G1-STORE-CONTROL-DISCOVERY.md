# G1 Store-Control Discovery

## Status

**COMPLETE — G1 store-control discovery closed (US-001 through US-007).**

Final answer: every store the selected Hermes runtime opens honours
`database.journal_mode: delete`, both when created fresh and after an offline
conversion of an existing WAL store. `state.db`, `verification_evidence.db`,
`kanban.db`, and `projects.db` all produced raw header bytes `1,1` under a
resolved `delete` config, kept `1,1` across **two consecutive real
writer/trigger runs** after an offline `hermes sessions set-journal-mode delete`
conversion, and flipped back to `2,2` only in the `wal` controls. There is
**no compatibility blocker** and **no store that cannot be converted**.

Required vs optional, derived from observed runtime behaviour: only `state.db`
is core. `verification_evidence.db` is optional (verify-on-stop gated),
`kanban.db` is optional (kanban-feature gated), and `projects.db` is optional
(project-feature gated). Missing optional stores are not refusals; optional
stores are checked only when present.

The final gate policy is in [Gate Implications](#gate-implications). The
consolidated evidence is `docs/gate/evidence/final-harness.log`, produced by
`docs/gate/probes/run_all.sh` (exit 0), which runs the raw-header unit test and
every probe in a fresh scratch root and records **zero** opens of any path under
`/home/kaladin/.hermes`.

Measurement context (unchanged across US-005/US-006/US-007): Hermes
`d623a6607e385d9d8024ce960234be47536351f2` (`d623a66.dirty`), Python 3.14.7,
SQLite 3.53.3, native execution (`/proc/1/cgroup` = `0::/init.scope`). The
US-007 consolidation parent was commit
`aaf61c1ddca8fc939f16c548219309087c399bc8`, tree
`ef15bd7adf52ae9e261d0d2ce6d46adcd086ce81`, captured
`2026-10-22T07:47:12Z`.

This is a bounded investigation. It changes no production code, installs
nothing, deploys nothing, pushes nothing, does not touch `aasylum`, and never
opens or writes `/home/kaladin/.hermes` or any real operator store.

---

## Artifact Truth

All values below were captured in the worktree before any G1 file was created.
The evidence block is reproduced verbatim in the [Command Appendix](#command-appendix).

| Item | Value |
| --- | --- |
| Repository worktree | `/home/kaladin/.tamandua/worktrees/tamandua-origin-dev16-afd82b30/168-2869e550` |
| Starting commit | `f2f34c9177ec28a51ae89a48e612baff2b1892b3` |
| Starting tree | `ebb0bd1b882167f3fbab28e92f8f80c21428fa0c` |
| US-007 consolidation parent commit | `aaf61c1ddca8fc939f16c548219309087c399bc8` |
| US-007 consolidation parent tree | `ef15bd7adf52ae9e261d0d2ce6d46adcd086ce81` |
| US-007 consolidation captured at (UTC) | `2026-10-22T07:47:12Z` |
| Branch | `feature/g1-store-control-discovery` |
| Captured at (UTC) | `2026-10-21T23:22:42Z` (`Wed Oct 21 11:22:42 PM UTC 2026`) |
| Host | `vaimetal` |
| Kernel | `Linux vaimetal 7.0.0-38-generic #38-Ubuntu SMP PREEMPT_DYNAMIC Fri Sep  4 09:10:14 UTC 2026 x86_64 GNU/Linux` |
| Execution context | **Native** — `/proc/1/cgroup` is `0::/init.scope`; neither `/.dockerenv` nor `/run/.containerenv` exists. Probes run directly on this host, not in a container. |
| `strace` | `/usr/bin/strace` |
| `sha256sum` | `/usr/bin/sha256sum` |
| `xxd` | `/usr/bin/xxd` |
| `python3` | `/usr/bin/python3` |

### Exercised runtime

The exercised runtime is the installed Hermes runtime at
`/home/kaladin/hermes-agent`, invoked only through its venv binaries:

```text
$ /home/kaladin/hermes-agent/venv/bin/hermes --version
Hermes Agent vgit.d623a66.dirty (2026.9.24) · upstream 8b66a510 · local d623a660 (+131 carried commits)
Install directory: /home/kaladin/hermes-agent
Install method: git
Python: 3.14.7
OpenAI SDK: 2.24.0
Update available — run 'hermes update'

$ /home/kaladin/hermes-agent/venv/bin/python --version
Python 3.14.7

$ /home/kaladin/hermes-agent/venv/bin/python -c '<sqlite version query>'
sqlite_version: 3.53.3
sqlite_source_id: 2026-06-26 20:14:12 d4c0e51e4aeb96955b99185ab9cde75c339e2c29c3f3f12428d364a10d78alt1

$ git -C /home/kaladin/hermes-agent rev-parse HEAD
d623a6607e385d9d8024ce960234be47536351f2

$ git -C /home/kaladin/hermes-agent describe --tags --always
d623a6607

$ git -C /home/kaladin/hermes-agent status --porcelain
 M acp_adapter/commands.py
 M build-and-install
```

Hermes revision: `d623a6607e385d9d8024ce960234be47536351f2` (`d623a66`), with two
pre-existing local modifications carried in the install (`acp_adapter/commands.py`,
`build-and-install`). Those modifications are not from this investigation and
were not changed by it.

**Launcher constraint.** `/home/kaladin/.local/bin/hermes` was **not executed**.
Its launcher execs `/home/kaladin/.hermes/bin/hermes_bootstrap_main.py`, which
would violate the no-real-home constraint. Every documented Hermes invocation
in this investigation uses `/home/kaladin/hermes-agent/venv/bin/hermes` through
`docs/gate/probes/hermes_scratch.sh`.

**No production source changed.** `git status --porcelain -- src` was empty at
capture time and remains the acceptance check for the investigation.

---

## Safety Protocol

The following rules are binding on every probe in this investigation. They are
encoded in the harness rather than left to reviewer discipline.

1. **Disposable homes only.** Every probe creates a fresh home with
   `mktemp -d /tmp/g1-*`. No probe reads, opens, copies from, or writes
   `/home/kaladin/.hermes` or any other real operator store.
2. **One gateway for Hermes.** Every Hermes invocation goes through
   `docs/gate/probes/hermes_scratch.sh`. The wrapper:
   - requires `HERMES_HOME` to be set and absolute;
   - resolves it with `readlink -f` (so `..` and symlinks cannot disguise the
     destination);
   - refuses `/home/kaladin/.hermes` and every path beneath it **before** any
     exec;
   - refuses any path not under `/tmp/g1-*`;
   - defaults `HERMES_BIN` to `/home/kaladin/hermes-agent/venv/bin/hermes`;
   - prints `hermes_scratch: HERMES_HOME=...` and `hermes_scratch: exec ...`
     to stderr, then `exec`s with the caller's arguments.
3. **Offline conversions happen only on copies.** The live/original store is
   preserved and its SHA-256 is recorded before any copy is altered. An
   original is never converted in place.
4. **Original files are SHA-256-preserved.** Every measurement records the
   `sha256` of the file it inspected, and the original's digest must be
   unchanged after a conversion of a copy.
5. **Journal format is read from raw bytes 18/19 only.** The only permitted
   reader is `docs/gate/probes/read_header.py`. It opens the file in binary,
   reads exactly the first 20 bytes, and never imports or connects through the
   SQLite library. A database connection can checkpoint a WAL and change the
   thing being measured, so “checking” a mode with SQL is forbidden.
6. **No real process is stopped.** If the offline conversion command refuses
   because of a holder, only scratch-scoped PIDs may be identified and stopped.
7. **No production edits.** `src/` is not modified. Hermes' database subsystem
   is not modified. No install/deploy/publish/push is performed.
8. **`aasylum` is never touched.**

The header reader classifies a file as follows:

| Byte 18 | Byte 19 | `mode` | Exit |
| --- | --- | --- | --- |
| `1` | `1` | `delete` | 0 |
| `2` | `2` | `wal` | 0 |
| any other pair on a valid container | | `unknown(a/b)` | 0 |
| valid container, fewer than 20 bytes | | `short` | 2 |
| 16-byte magic is not `SQLite format 3\0` | | `not-a-database` | 2 |

## Method

US-001 establishes the measurement apparatus; later stories apply it.

**Artifact truth.** Values were captured with the commands in the
[Command Appendix](#command-appendix). The worktree's `HEAD` and tree are the
starting point for every later claim.

**Header measurement.** `read_header.py` reads the two SQLite format-version
bytes at 0-based offsets 18 and 19 (the SQLite file-format convention: bytes
0–15 are the magic and 16–17 are the page size). It also emits the full file
size and the SHA-256 of the entire file, so each measurement carries
preservation evidence. Its stdlib unit test (`test_read_header.py`) uses
synthetic 100-byte fixtures for `1/1`, `2/2`, short, bad-magic, and unknown
pairs, and asserts both the mode string and the exit status. The test also
statically asserts the reader does not import the database module.

US-001's first revision read offsets 17/18, which are a page-size byte and the
write-version byte, not the version pair. US-003 corrected both the reader and
its fixtures after validating against synthetic SQLite files: a real
`PRAGMA journal_mode=wal` database has `2,2` at offsets 18/19 and a real
`PRAGMA journal_mode=delete` database has `1,1`. Every reading in this document
comes from the corrected reader; the correction was verified with
`test_read_header.py` and with three real stores created by Hermes itself.

**Wrapper smoke checks.** This story exercised the wrapper with the stub
`HERMES_BIN=/bin/true` only. It never ran the real Hermes runtime: the
`/tmp/g1-*` acceptance path printed the resolved command, while
`HERMES_HOME=/home/kaladin/.hermes` and a non-scratch path both exited 64 with
`REFUSED` before exec.

**Application (US-002 onward).** Config resolution is probed in-process
against fresh scratch homes (US-002); the store inventory is derived from
command/trigger behaviour plus `strace` logs (US-003); fresh-store headers under
`delete` with a `wal` control are measured per store (US-004); and
offline-conversion persistence is measured on copies across the next writer
(US-005/US-006). US-007 closes the remaining gap by applying the same
copy/convert/two-writer measurement to `kanban.db` and `projects.db`, then runs
the whole investigation end to end with `docs/gate/probes/run_all.sh` and
records the consolidated evidence in
`docs/gate/evidence/final-harness.log`. The installed Hermes source was read
(read-only) to locate the canonical paths:

- `hermes_state_wal.resolve_journal_mode()` — resolves the configured mode
  (`wal` default; invalid values fail safe to `wal`).
- `hermes_state_wal.apply_wal_with_fallback()` — the canonical setter; its
  docstring states it never live-downgrades an existing WAL database.
- `hermes_cli/sessions_cmd_journal_mode.py` — the offline
  `hermes sessions set-journal-mode delete|wal --db <path>` path.

The source map is context for the probes, **not** a finding. Every verdict must
come from measured output.

## Store Inventory

**Measured by US-003.** The store set was derived by running triggers in
separate disposable homes and enumerating every SQLite file that appeared; it
was **not** assumed from a list of `*.db` filenames. The full probe output is
`docs/gate/evidence/store-inventory.txt`, produced by
`docs/gate/probes/probe_store_inventory.sh` (exit 0). Every home was a fresh
`mktemp -d /tmp/g1-*` directory, `HOME` was redirected into the same scratch
tree so no `Path.home()/.hermes` fallback existed, and every Hermes CLI call
went through `hermes_scratch.sh`.

### Trigger → store evidence

Each row is a separate fresh home. "SQLite store" means a file that begins with
the 16-byte `SQLite format 3\0` magic; the probe enumerates `*.db`/`*-wal`/`*-shm`
and the investigation additionally scanned every other file in every home for
that magic. Only the four stores below matched.

| Trigger (fresh home each) | Exit | Store(s) created | Captured result / evidence |
| --- | --- | --- | --- |
| `hermes doctor` | 1 (two setup issues: no `.env`, no API keys) | none | Reports `state.db not created yet (will be created on first session)`; strace recorded 0 database-path opens. `evidence/store-open-doctor.txt` |
| `hermes sessions list` | 0 | none | Prints `No sessions found.`; it is explicitly observational (`_OBSERVATIONAL_DB_ACTIONS`) and opens `state.db` `O_RDONLY` only. Strace shows `state.db` → `ENOENT`, never `O_CREAT`. `evidence/store-open-sessions.txt` |
| `hermes kanban list` | 0 | `kanban.db` (118,784 B; header `2,2` WAL) | Creates and initializes the board DB. `evidence/store-open-kanban.txt` |
| `hermes projects list` | 2 | none | **Not a command in this revision**: `hermes: 'projects' is not a hermes command. Did you mean: project, pets?` The real command is singular. Recorded verbatim; no store asserted. |
| `hermes project list` | 0 | `projects.db` (45,056 B; header `2,2` WAL) | Creates the per-profile projects store on first use. `evidence/store-open-project.txt` |
| `hermes cron list` | 0 | none | Cron jobs live in `$HERMES_HOME/cron/jobs.json`, not SQLite. |
| `SessionDB()` + `create_session()` | 0 | `state.db` (274,432 B; header `2,2` WAL) | Direct writer probe. There is no sidecar after a clean close. `evidence/store-open-state-sessiondb.txt` |
| `record_verify_run(..., ok=True)`, verify-on-stop **OFF** | 0 | none | Returns `None`; `_ledger_enabled()` is false, so the DB is not even created. |
| `record_verify_run(..., ok=True)`, `HERMES_VERIFY_ON_STOP=1` | 0 | `verification_evidence.db` (32,768 B; header `2,2` WAL) | Returns event id `1`; one row recorded. |

### Store Inventory table

| Store (relative to `HERMES_HOME`) | Trigger / opener | Created on fresh home? | Required-or-optional hypothesis | Opener path | Evidence |
| --- | --- | --- | --- | --- | --- |
| `state.db` | Any writing session path: `SessionDB()` + `create_session()` (chat/agent first write). **Not** created by `hermes sessions list` (read-only) or `hermes doctor`. | Yes, only on first write | **Required** core session store; a brand-new profile legitimately has none until the first session | `hermes_state.py:795` calls `apply_wal_with_fallback()` — **canonical** | `store-inventory.txt`; `store-open-state-sessiondb.txt` |
| `verification_evidence.db` | `agent.verification_evidence.record_verify_run()` **only when verify-on-stop is enabled** (`HERMES_VERIFY_ON_STOP` truthy or `agent.verify_on_stop: true`) | Yes, only when the gate is on | **Optional**, gated on `verify_on_stop_enabled()` (default OFF) | `agent/verification_evidence.py:130-133` → `open_db(..., wal=True)` → `apply_wal_with_fallback()` — **canonical** | `store-inventory.txt` |
| `kanban.db` | `hermes kanban list` (and any kanban command / dispatcher); lazily initialized on first kanban operation | Yes | **Optional**, feature-gated on kanban use | `hermes_cli/kanban_db_connect.py:639-647` calls `apply_wal_with_fallback()` — **canonical** | `store-inventory.txt`; `store-open-kanban.txt` |
| `projects.db` | `hermes project list` (and any project command); lazily initialized on first project operation | Yes | **Optional**, feature-gated on project use | `hermes_cli/projects_db.py:133` → `open_db(..., wal=True)` → `apply_wal_with_fallback()` — **canonical** | `store-inventory.txt`; `store-open-project.txt` |

`cron/jobs.json` is not a SQLite store and is therefore not in the table;
`hermes cron list` created no database at all. Logs, cache files, `SOUL.md`, and
bootstrap install records created by the CLI are likewise not stores.

### Path-resolution nuance: kanban.db can be shared

`state.db`, `verification_evidence.db`, and `projects.db` are resolved through
`get_hermes_home()`, so they are per-profile. `kanban.db` is resolved through
`hermes_cli.kanban_db.kanban_home()`, which uses `get_default_hermes_root()`:
for the default profile that is the same directory, but for a named profile
(`$ROOT/profiles/<name>`) the board DB lives at `$ROOT/kanban.db` and is shared
across profiles **by design** (the dispatcher/worker handoff must not fork per
profile). The probe observed it at `<HERMES_HOME>/kanban.db` because each
scratch home was a root, not a `profiles/<name>` home. The launch gate must
therefore resolve the kanban path with the same rule, not assume
`$HERMES_HOME/kanban.db` for every profile.

### Opener path: canonical setter vs raw pragma

Source inspection (`grep -R "apply_wal_with_fallback\|PRAGMA journal_mode"
/home/kaladin/hermes-agent --include=*.py`, read-only) maps every inventoried
store to the canonical setter:

| Store | Production open path | Journal-mode decision |
| --- | --- | --- |
| `state.db` | `SessionDB._open_writer_conn()` | `apply_wal_with_fallback()` (canonical) |
| `verification_evidence.db` | `_connect()` → `open_db()` | `open_db` default `wal=True` → `apply_wal_with_fallback()` (canonical) |
| `kanban.db` | `kanban_db_connect._open_configured()` | `apply_wal_with_fallback()` (canonical) |
| `projects.db` | `projects_db.connect()` → `open_db()` | `open_db` default `wal=True` → `apply_wal_with_fallback()` (canonical) |

**No production path issues a raw `PRAGMA journal_mode=WAL` outside the
canonical setter.** The only writer of that pragma is
`hermes_state_wal._enable_wal()` (which is the body of
`apply_wal_with_fallback`), and the only direct non-WAL setter is
`_set_journal_mode_no_wait()` / the offline
`hermes sessions set-journal-mode delete` command. The other `PRAGMA
journal_mode` occurrences are reads used for health/diagnostics
(`kanban_db_connect.py:1137`, `session_recovery.py:300`,
`hermes_state_dbfile.py:790`, `hermes_state_repair.py:777`), not setters. This
matters for US-004–US-006: a probe must exercise these real openers, not assume
that every `*.db` consumer goes through the canonical path.

### Strace evidence

Every log below is a filtered `strace -f -e trace=openat,open,creat` capture of
one representative trigger against a fresh scratch home. The filter keeps opens
under that home and normalises the scratch prefix; the log's header records the
total syscall lines, the database-path open lines, and the count of opens under
`/home/kaladin/.hermes` (which must be zero).

| Evidence log | Trigger | Traced syscall lines | Scratch-home open lines | DB-path open lines | Real-home opens |
| --- | --- | --- | --- | --- | --- |
| `evidence/store-open-kanban.txt` | `hermes kanban list` | 7,097 | 26 | 8 | **0** |
| `evidence/store-open-project.txt` | `hermes project list` | 7,062 | 22 | 4 | **0** |
| `evidence/store-open-sessions.txt` | `hermes sessions list` | 7,127 | 17 | 1 (read-only `ENOENT`) | **0** |
| `evidence/store-open-doctor.txt` | `hermes doctor` | 14,031 | 188 | 0 | **0** |
| `evidence/store-open-state-sessiondb.txt` | `SessionDB()` + `create_session()` | 3,746 | 16 | 8 | **0** |

Representative store-open lines (the kanban log shows the main file plus the
`-wal`/`-shm` sidecars created during WAL setup; the state log shows the
`state.db-journal` probe that SQLite performs before switching to WAL):

```text
openat(AT_FDCWD, "<scratch>/kanban.db", O_RDWR|O_CREAT|O_NOFOLLOW|O_CLOEXEC, 0644) = 7
openat(AT_FDCWD, "<scratch>/kanban.db-wal", O_RDWR|O_CREAT|O_NOFOLLOW|O_CLOEXEC, 0644) = 8
openat(AT_FDCWD, "<scratch>/kanban.db-shm", O_RDWR|O_CREAT|O_NOFOLLOW|O_CLOEXEC, 0644) = 9
openat(AT_FDCWD, "<scratch>/state.db", O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC, 0600) = 4
```

### Reconciliation with the supplied live measurement

The prior evidence supplied with this task (vaimetal, 2026-10-21) found exactly
two live stores under the operator home:

- `~/.hermes/state.db` — 6748 KB, header `2,2` (WAL), non-empty `-wal`/`-shm`
- `~/.hermes/verification_evidence.db` — 88 KB, header `2,2` (WAL), no sidecars
- no `kanban.db`

That measurement was **not re-run**: `/home/kaladin/.hermes` was never opened by
this investigation. The derived inventory is a **superset** of the live set
because store creation is lazy and feature-gated, not because the live
measurement was wrong:

- `state.db` and `verification_evidence.db` were present because that profile
  had a writing session and verify-on-stop enabled. A fresh home with the same
  verify-on-stop gate off produced no `verification_evidence.db` at all (probe
  row above), so the live file proves the gate was on, not that the store is
  mandatory.
- `kanban.db` was absent because no kanban command or dispatcher had ever run in
  that profile. On a fresh home, `hermes kanban list` creates it; without that
  trigger it is not created. This is the behaviour the gate must model: kanban
  is a lazily-created optional store, not a missing required store.
- `projects.db` was likewise absent because no project command had run. The
  supplied live measurement named only the two stores it found; the project
  store is a separate, lazily-created optional store observed here.
- The sidecar difference is consistent with a live holder: the supplied
  `state.db` had non-empty `-wal`/`-shm` (a connection was open), while the
  supplied `verification_evidence.db` had no sidecars (it had been closed
  cleanly). The fresh stores in this probe also had no sidecars after a clean
  close, and their headers remained `2,2`.

The important reconciliation for the gate is therefore: **the live set is an
exercised-feature snapshot, while the derived set is the superset a profile can
open.** Missing optional stores cannot be treated as corruption or as a missing
required store; they must be checked only when their feature is enabled or when
they are present.

### Provisional required-vs-optional input (final classification in US-006/US-007)

- `state.db` — core session store. It is created on the first writing session,
  so a brand-new profile may legitimately have none; the gate must check its
  header when it exists. Treat it as the only **required** store in the
  inventory hypothesis.
- `verification_evidence.db` — **optional**, derived from the observed
  verify-on-stop gate (off by default).
- `kanban.db` — **optional**, derived from the observed kanban trigger.
- `projects.db` — **optional**, derived from the observed project trigger.

US-006 tightens the verification-evidence classification from behaviour, and
US-007 turns this into the gate's final required-vs-optional policy.

## Config Resolution

**Measured by US-002** with `docs/gate/probes/probe_config.py` (full stdout in
`docs/gate/evidence/config-resolution.txt`, reproduced in
[Command Appendix F](#f-config-resolution-probe-us-002)). Every scenario used
a fresh disposable `HERMES_HOME` under a `mktemp -d /tmp/g1-*` base. No command
in this section opened, read, or wrote `/home/kaladin/.hermes`.

A full `strace -f -e trace=openat,open,creat` of the probe (including its
in-process Hermes imports and its `hermes config path` subprocess) recorded
38,784 syscall lines and **zero** opens of any path containing
`/home/kaladin/.hermes`; see `docs/gate/evidence/config-resolution-strace.txt`.

### Where the path comes from

`hermes_cli.config.get_config_path()` is exactly:

```python
def get_config_path() -> Path:
    """Get the main config file path."""
    return get_hermes_home() / "config.yaml"
```

`hermes_cli.config.get_hermes_home()` resolves, in order, the context-local
override, `$HERMES_HOME`, then the platform default. In every scenario the
probe set `HERMES_HOME` to an absolute scratch directory and resolved it with
`os.path.realpath` (the same result as `readlink -f`) before use.
`hermes config path` (run through `hermes_scratch.sh`) printed exactly the same
file as the in-process `get_config_path()` for all five scenarios, and the
config `realpath` was identical to the path because each scratch home is a real
directory (no symlink). The path/realpath pair is therefore:

```text
path      = $HERMES_HOME/config.yaml
realpath  = $(readlink -f "$HERMES_HOME")/config.yaml
```

The config-shaped decisions are made by `hermes_state_wal.resolve_journal_mode()`,
which calls `load_config_readonly()` and classifies the value (`delete`/`wal`
only; anything else becomes `wal`). `load_config_readonly()` builds the
effective config as:

```text
DEFAULT_CONFIG (database.journal_mode = "wal")
  -> deep-merged user $HERMES_HOME/config.yaml
  -> env-var expansion of the user values
  -> managed-scope config.yaml overlaid LAST (managed wins per leaf)
```

The managed overlay is applied after user expansion on purpose: a user
`${VAR}` cannot shadow an administrator literal
(`hermes_cli/config.py` `_merge_managed_overlay`, "Managed wins at the leaf
and is applied AFTER user expansion"). The environment variable
`HERMES_JOURNAL_MODE` is **not** a config layer: the only occurrence in the
installed tree is a test that asserts it does not override the file
(`tests/hermes_state/test_journal_mode_config.py`).

### Host managed scope

Observed on vaimetal during this story:

```text
$ ls -ld /etc/hermes
ls: cannot access '/etc/hermes': No such file or directory
$ printenv HERMES_MANAGED_DIR
(no output = unset)
$ python -c 'import hermes_cli.managed_scope as m; print(m.get_managed_dir())'
None
```

So on this host no managed keys are pinned by default, and
`database.journal_mode` is **not** managed unless an administrator installs a
managed `config.yaml`. When the probe injects one (scenario 5),
`managed_config_keys()` reports `['database.journal_mode']` and the managed
value wins. `managed_scope.get_managed_dir()` is the single seam for the
location (`$HERMES_MANAGED_DIR` when set and the directory exists, otherwise
`/etc/hermes` when it exists, otherwise `None`); the probe monkeypatches that
seam to a scratch directory and never creates a real managed/system config.

### Config Resolution table

Captured run: scratch base `/tmp/g1-config-1ta71rqz` (disposable; removed after
the probe). Full JSON is in `docs/gate/evidence/config-resolution.txt`.

| Scenario | Config file path | Realpath | Raw user value | Managed overlay value | Resolved value | Winning layer |
| --- | --- | --- | --- | --- | --- | --- |
| default, no `database` section | `/tmp/g1-config-1ta71rqz/scenario-1/hermes-home/config.yaml` | `/tmp/g1-config-1ta71rqz/scenario-1/hermes-home/config.yaml` | absent | none | `wal` | `DEFAULT_CONFIG` default (`database.journal_mode: wal`) |
| user config `delete` | `/tmp/g1-config-1ta71rqz/scenario-2/hermes-home/config.yaml` | `/tmp/g1-config-1ta71rqz/scenario-2/hermes-home/config.yaml` | `delete` | none | `delete` | user config (`$HERMES_HOME/config.yaml`) |
| invalid value `bogus` | `/tmp/g1-config-1ta71rqz/scenario-3/hermes-home/config.yaml` | `/tmp/g1-config-1ta71rqz/scenario-3/hermes-home/config.yaml` | `bogus` | none | `wal` | fail-safe default (`resolve_journal_mode` discards invalid values) |
| `HERMES_JOURNAL_MODE=delete` with user `wal` | `/tmp/g1-config-1ta71rqz/scenario-4/hermes-home/config.yaml` | `/tmp/g1-config-1ta71rqz/scenario-4/hermes-home/config.yaml` | `wal` | none | `wal` | user config; the env var is not a layer |
| managed overlay `delete` over user `wal` | `/tmp/g1-config-1ta71rqz/scenario-5/hermes-home/config.yaml` | `/tmp/g1-config-1ta71rqz/scenario-5/hermes-home/config.yaml` | `wal` | `delete` | `delete` | managed-scope overlay (admin `config.yaml`) |

All five assertions passed and `hermes config path` matched
`get_config_path()` in every row. Scenarios 1–4 monkeypatched
`get_managed_dir` to `None` so each layer was measured in isolation from any
host managed policy (the observed host value was already `None`); scenario 5
monkeypatched it to the scratch managed directory.

### Gate implication

The gate must evaluate the value Hermes **actually resolves**, not merely
grep `$HERMES_HOME/config.yaml`:

1. Start from the default `wal`.
2. Apply the user `$HERMES_HOME/config.yaml` value.
3. Apply the administrator managed-scope `config.yaml` last, if a managed scope
   is present — a managed `delete` overrides a user `wal`, and a managed `wal`
   overrides a user `delete`.
4. Treat any value other than `wal`/`delete` (including a missing, non-string,
   or malformed value) as the fail-safe `wal`, exactly as
   `resolve_journal_mode()` does. Raw YAML text is not trustworthy.

A gate that only reads the user config can disagree with the writer in both
directions (false refusal when the admin pinned `wal`, false acceptance when
the admin pinned `delete` over a user `wal`) and can be fooled by an invalid
value that Hermes silently maps to `wal`.

## Per-Store Findings

### Consolidated per-store verdicts (US-007)

One row per store, each backed by the exact command output recorded in the
linked subsection and saved evidence log. **No store is left as UNKNOWN**:
US-004 measured fresh creation for all four, US-005/US-006 measured offline
conversion persistence for `state.db` and `verification_evidence.db`, and
US-007 measured it for `kanban.db` and `projects.db`.

| Store | Verdict | Fresh creation under resolved `delete` (US-004) | Offline conversion + next writer (US-005/006/007) | Required? | Evidence |
| --- | --- | --- | --- | --- | --- |
| `state.db` | **HONOURING** | header `1,1`; WAL control `2,2` — [US-004](#fresh-creation-under-databasejournal_mode-delete-us-004) | `hermes sessions set-journal-mode delete` → `1,1`; two real writer runs stayed `1,1`; WAL control `2,2` — [US-005](#offline-conversion-persistence-for-statedb-us-005) | **Required (core)** | `evidence/fresh-store-modes.txt`, `evidence/conversion-persistence.txt` |
| `verification_evidence.db` | **HONOURING** | header `1,1`; WAL control `2,2` — [US-004](#fresh-creation-under-databasejournal_mode-delete-us-004) | `1,1`; two real writer runs and the read paths stayed `1,1`; WAL control `2,2` — [US-006](#offline-conversion-persistence-for-verification_evidencedb-us-006) | Optional (verify-on-stop gated) | `evidence/fresh-store-modes.txt`, `evidence/verification-conversion-persistence.txt` |
| `kanban.db` | **HONOURING** | header `1,1`; WAL control `2,2` — [US-004](#fresh-creation-under-databasejournal_mode-delete-us-004) | `1,1`; two real `hermes kanban list` opens stayed `1,1`; WAL control `2,2` — [US-007](#offline-conversion-persistence-for-kanbandb-and-projectsdb-us-007) | Optional (kanban gated) | `evidence/fresh-store-modes.txt`, `evidence/optional-conversion-persistence.txt` |
| `projects.db` | **HONOURING** | header `1,1`; WAL control `2,2` — [US-004](#fresh-creation-under-databasejournal_mode-delete-us-004) | `1,1`; two real `hermes project list` opens stayed `1,1`; WAL control `2,2` — [US-007](#offline-conversion-persistence-for-kanbandb-and-projectsdb-us-007) | Optional (project gated) | `evidence/fresh-store-modes.txt`, `evidence/optional-conversion-persistence.txt` |

**Verdict definition.** HONOURING means both measurements pass: a fresh store
under resolved `delete` has raw bytes `1,1` with a `wal` control at `2,2`, and
a store converted offline on a copy stays `1,1` across two consecutive real
writer/trigger runs under resolved `delete` while the same converted copy flips
to `2,2` under a `wal` control. A reversal, or any missing measurement, would
be NOT-HONOURING or UNKNOWN and would be named; no store falls into either
category.

### Fresh creation under `database.journal_mode: delete` (US-004)

**Measured by US-004** with `docs/gate/probes/probe_fresh_modes.sh` (exit 0).
Full stdout is `docs/gate/evidence/fresh-store-modes.txt`; a filtered syscall
capture is `docs/gate/evidence/fresh-store-modes-strace.txt`. Every row is a
**fresh** disposable home; no existing store and no real operator store was
used.

For each store the probe created two homes from one `mktemp -d /tmp/g1-*`
scratch root, `<store>-delete/home` and `<store>-wal/home`, each containing
only a `config.yaml` with `database.journal_mode` set to the directory's mode.
It then:

1. confirmed the home **resolved** to the intended mode before the writer ran
   (`hermes_state_wal.resolve_journal_mode()` in the venv Python, `cwd` the
   installed Hermes tree);
2. ran the store's real writer — `SessionDB()` + `create_session()` for
   `state.db`, `record_verify_run(...)` with `HERMES_VERIFY_ON_STOP=1` for
   `verification_evidence.db`, `hermes kanban list` for `kanban.db`, and
   `hermes project list` for `projects.db` — and waited for it to close;
3. read the file's journal format **only** with `read_header.py` (raw header
   bytes 18/19). No SQLite connection was opened to read a journal mode; a
   checkpoint would change the bytes being measured.

Every home is a real directory, so for each row `config.yaml`'s path equals its
`readlink -f` realpath:

| Store | Config mode | `config.yaml` path (= realpath) | Resolved before writer |
| --- | --- | --- | --- |
| `state.db` | `delete` | `/tmp/g1-fresh.bVfXCg/state-delete/home/config.yaml` | `delete` |
| `state.db` | `wal` | `/tmp/g1-fresh.bVfXCg/state-wal/home/config.yaml` | `wal` |
| `verification_evidence.db` | `delete` | `/tmp/g1-fresh.bVfXCg/verification_evidence-delete/home/config.yaml` | `delete` |
| `verification_evidence.db` | `wal` | `/tmp/g1-fresh.bVfXCg/verification_evidence-wal/home/config.yaml` | `wal` |
| `kanban.db` | `delete` | `/tmp/g1-fresh.bVfXCg/kanban-delete/home/config.yaml` | `delete` |
| `kanban.db` | `wal` | `/tmp/g1-fresh.bVfXCg/kanban-wal/home/config.yaml` | `wal` |
| `projects.db` | `delete` | `/tmp/g1-fresh.bVfXCg/projects-delete/home/config.yaml` | `delete` |
| `projects.db` | `wal` | `/tmp/g1-fresh.bVfXCg/projects-wal/home/config.yaml` | `wal` |

The scratch root above was created by the evidence run and is disposable. The
config path rule is the US-002 finding: `hermes_cli.config.get_config_path()`
returns `get_hermes_home() / "config.yaml"`, and the probe's in-process
`resolve_journal_mode()` read the same file the writer reads.

**Header measurement.** `size` and `sha256` are the whole-file values emitted by
`read_header.py`; `header` is the raw `(byte18, byte19)` pair. "Sidecars" is the
post-close listing of `<store>-wal`, `<store>-shm`, and `<store>-journal` in the
home. No store/config pair was excluded.

| Store | Config mode | Size (bytes) | sha256 | Header bytes (18/19) | Observed mode | Sidecars after close | Fresh-creation verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `state.db` | `delete` | 274,432 | `43e51474b83bc0ebe565358da578a60495efd9dc7d4c83740e2f140177553069` | `1,1` | `delete` | none | **HONOURING** |
| `state.db` | `wal` | 274,432 | `492a579abe6cbbae29669fb192264c8448db1ee02b483de3ba522b4037e5bff0` | `2,2` | `wal` | none | control (expected `2,2`) |
| `verification_evidence.db` | `delete` | 32,768 | `a7a2ea628c41c8d1912d91d3c2278142d80db222c6e90afe4d6590a1e8f3770d` | `1,1` | `delete` | none | **HONOURING** |
| `verification_evidence.db` | `wal` | 32,768 | `f79f95cc0a39760d71d40759d9c41384489271d510bb1f2f4fe5fe3956724969` | `2,2` | `wal` | none | control (expected `2,2`) |
| `kanban.db` | `delete` | 118,784 | `e8ce52281798e509d324262a269c5732a2ab1c5b721b216cf49e2d08ff5d15ae` | `1,1` | `delete` | none | **HONOURING** |
| `kanban.db` | `wal` | 118,784 | `1a119305a0a4fc10af8f81b4555af51f8834feec07c6ba135e4d66a244359b52` | `2,2` | `wal` | none | control (expected `2,2`) |
| `projects.db` | `delete` | 45,056 | `be5297cecf6c2ea9b023e494f3e51a460007de9f6c9b9a2446c23e3bd9a02862` | `1,1` | `delete` | none | **HONOURING** |
| `projects.db` | `wal` | 45,056 | `e710b33f6a2ea7b406f778192b38a2c78bb03ff1d146494a1782e525e67e3f80` | `2,2` | `wal` | none | control (expected `2,2`) |

**Per-store fresh-creation verdict** (HONOURING requires both: delete home
header `1,1` **and** WAL control `2,2`):

| Store | delete-home header | WAL-control header | Fresh-creation verdict |
| --- | --- | --- | --- |
| `state.db` | `1,1` | `2,2` | **HONOURING** |
| `verification_evidence.db` | `1,1` | `2,2` | **HONOURING** |
| `kanban.db` | `1,1` | `2,2` | **HONOURING** |
| `projects.db` | `1,1` | `2,2` | **HONOURING** |

**Finding.** With `database.journal_mode: delete`, every inventoried store's
real writer created the store in rollback-journal format (`1,1`) on a fresh
home, and the same writer created the WAL control in `2,2`. The writer therefore
honours the configured `delete` on fresh creation for all four stores. No store
is NOT-HONOURING or UNKNOWN for this scenario.

**Syscall corroboration.** The strace capture shows the mechanism independently
of the configured value: in every delete home the writer opens `<store>.db` and
a transient `<store>.db-journal`, and **never** `<store>.db-wal` or
`<store>.db-shm`; in every WAL control the writer also opens `<store>.db-wal`
and `<store>.db-shm`. The rollback journal is removed on close, which is why
the sidecar column is empty after the opener closes. The capture recorded 0
opens under `/home/kaladin/.hermes`.

**Scope limit — this is not the conversion-persistence answer.** US-004 measures
only stores created from scratch under the configured mode. `apply_wal_with_fallback()`
has an explicit never-live-downgrade branch for a store whose on-disk header is
already WAL, so an existing WAL store converted offline is a different case.
US-005 measured that next-writer behaviour for `state.db` and found it
HONOURING (below); US-006 measures it for `verification_evidence.db`. An
offline conversion that the next writer reverses must be reported as a failure
there, not inferred from this fresh-creation result.

### Offline conversion persistence for `state.db` (US-005)

**Measured by US-005** with `docs/gate/probes/probe_conversion_persistence.sh`
(exit 0). Full stdout is `docs/gate/evidence/conversion-persistence.txt`; the
captured scratch root is `/tmp/g1-conversion.zzGFo1` (disposable). Every home is
under that root, `HOME` is redirected into it, and every Hermes CLI call goes
through `hermes_scratch.sh`; no real operator store was opened or altered.

The probe performs these steps, in order:

1. **Seed a real WAL store.** In `seed-wal/home` configured
   `database.journal_mode: wal`, run the real writer
   `SessionDB()` + `create_session(session_id="g1-conversion-seed")`, close it,
   and read the header with `read_header.py`. Result: `2,2` (`wal`). Record the
   original sha256.
2. **Copy byte-identically.** `cp -a` the store to
   `conversion/state.db`, then assert both the sha256 equality and `cmp -s`
   against the original before touching the copy.
3. **Convert the copy offline.** Run the supported command
   `hermes sessions set-journal-mode delete --db <copy>`, capture its full
   stdout/stderr, and read the copy's header again. Result: `1,1` (`delete`).
   Re-hash the **original** and assert it is unchanged.
4. **Next writer, twice, under `delete`.** Place the converted copy as
   `delete/home/state.db` in a home configured `database.journal_mode: delete`,
   confirm the resolved mode before writing, and run
   `SessionDB()` + `create_session(...)` twice, reading the header after each
   close. Both reads must be `1,1`.
5. **WAL control.** Place the same converted copy as
   `wal-control/home/state.db` in a home configured `database.journal_mode: wal`,
   run the writer once, and read the header. It must return to `2,2`.
6. **Integrity.** Re-hash the conversion source copy and the original seed
   store after every writer; both must be unchanged.

**Exact conversion invocation and output** (from
`docs/gate/evidence/conversion-persistence.txt`):

```text
$ HERMES_HOME=/tmp/g1-conversion.zzGFo1/seed-wal/home \
    ./docs/gate/probes/hermes_scratch.sh sessions set-journal-mode delete \
    --db /tmp/g1-conversion.zzGFo1/conversion/state.db
hermes_scratch: HERMES_HOME=/tmp/g1-conversion.zzGFo1/seed-wal/home
hermes_scratch: exec /home/kaladin/hermes-agent/venv/bin/hermes sessions set-journal-mode delete --db /tmp/g1-conversion.zzGFo1/conversion/state.db
✓ /tmp/g1-conversion.zzGFo1/conversion/state.db: journal_mode wal → delete (header verified).
  Note: config.yaml has database.journal_mode: wal — the next open would switch the file back. Set `database.journal_mode: delete` in config.yaml to keep it.
conversion_exit: 0
```

The command's own note is the warning that the *seed* home is configured `wal`;
it is not a statement that conversion is impossible. Step 4 is the test of that
warning under a `delete` home.

**Measurement.** `size` and `sha256` are the whole-file values emitted by
`read_header.py`; "Header" is the raw `(byte18, byte19)` pair. "Sidecars" is the
post-close listing of `state.db-wal`, `state.db-shm`, and `state.db-journal`.
`sha256` changes between stages because each writer records its session; the
header bytes are the measurement, and the conversion **source** copy is proven
stable separately.

| Stage | Artifact path (under `/tmp/g1-conversion.zzGFo1`) | Size (bytes) | sha256 | Header (18/19) | Mode | Sidecars after close | Writer runs |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Seed WAL store | `seed-wal/home/state.db` | 274,432 | `a2e4c5028d134406feff2af8b90c154cf6d2fa7f8888ccb45d2b8785075fb591` | `2,2` | `wal` | none | 1 (create) |
| `cp -a` copy before conversion | `conversion/state.db` | 274,432 | `a2e4c5028d134406feff2af8b90c154cf6d2fa7f8888ccb45d2b8785075fb591` | `2,2` | `wal` | none | 0 |
| Offline-converted copy | `conversion/state.db` | 274,432 | `19ea36ec3855e13ee8f697f967687808d5adc91437912139702129dc959c3b04` | `1,1` | `delete` | none | offline |
| Converted copy under `delete`, after run 1 | `delete/home/state.db` | 274,432 | `c90e5abef331fa9981604600ce1e2549581b14bf1dee42ea391b54968478824e` | `1,1` | `delete` | none | 2 total |
| Converted copy under `delete`, after run 2 | `delete/home/state.db` | 274,432 | `af6e1b2ca7894e98e1bc81a362f5d05625649ac4ec98a28d092d911e9c39eb48` | `1,1` | `delete` | none | 2 total |
| Converted copy under `wal` control, after run | `wal-control/home/state.db` | 274,432 | `bc029bee3e2fffe76e19421d795f1211addc0f45b78809c00bebc0fec6619234` | `2,2` | `wal` | none | 1 |

**Original-store integrity.** The original WAL store's sha256 was
`a2e4c5028d134406feff2af8b90c154cf6d2fa7f8888ccb45d2b8785075fb591` before
conversion, immediately after conversion, and at the end of the probe — the
offline conversion changed only the copy. The conversion source copy also
remained `19ea36ec3855e13ee8f697f967687808d5adc91437912139702129dc959c3b04`
after both writer homes ran, because each writer home received its own `cp -a`.
The copy stage itself was proven with both sha256 equality and `cmp -s`.

**Verdict: `state.db` HONOURING.** The offline conversion produced `1,1`, and
two consecutive real writer runs under `database.journal_mode: delete` both left
the header at `1,1`. `state.db` does **not** reverse a correct offline
conversion when the resolved config says `delete`.

**The WAL control is config-driven, not a delete-mode failure.** The control
placed the *same* converted `1,1` copy in a home whose resolved
`database.journal_mode` was `wal`. Its writer emitted:

```text
state.db: on-disk journal_mode was delete and has been switched to WAL. This rewrites the database header and persists after this process exits. ... every open re-applies the configured mode. Set `database.journal_mode: delete` in config.yaml to make it stick. This message fires once per process per database.
```

and the header became `2,2`. This is exactly what the source predicts:
`apply_wal_with_fallback()` resolves the configured mode first, then reads the
on-disk mode. The never-live-downgrade branch fires only when
**on-disk is already WAL and configured is `delete`** — which is why the offline
`set-journal-mode` conversion is required in the first place. Once the file is
`1,1`, configured `delete` takes the `_set_journal_mode_no_wait(conn, "DELETE")`
branch and verifies `delete`, while configured `wal` takes `_enable_wal()` and
flips the file back to `2,2`. The control therefore proves the configured value
decides the next open; it is not evidence against `delete` mode.

**Gate consequence for `state.db` (incorporated into the final Gate
Implications).** A
converted `state.db` is stable only while the resolved `database.journal_mode`
remains `delete`. The gate must check the resolved config **and** raw bytes
`1,1`; checking only bytes would miss a `wal` config that will flip the store on
the next open, and checking only config would miss an existing WAL file that
hermes refuses to live-downgrade. Conversion of `state.db` is viable.

### Offline conversion persistence for `verification_evidence.db` (US-006)

**Measured by US-006** with
`docs/gate/probes/probe_verification_conversion.sh` (exit 0). Full stdout is
`docs/gate/evidence/verification-conversion-persistence.txt`; the captured
scratch root is `/tmp/g1-verification.yqQ8Zz` (disposable). Every home is under
that root, `HOME` is redirected into it, and every Hermes CLI call goes through
`hermes_scratch.sh`; no real operator store was opened or altered. The captured
run recorded `/proc/1/cgroup` = `0::/init.scope` (native), Python 3.14.7, and
Hermes `vgit.d623a66.dirty` (2026.9.24). The run's parent commit was
`829414985f7441865497b60979b2c1ce95a3dbde` (tree
`b7b28d18c3b1b6ab34a11735312952ae2264338c`). Journal format was read **only**
with `read_header.py` (raw bytes 18/19); no SQLite connection was opened to
inspect a journal mode, because a connection/checkpoint would change the bytes
being measured.

#### Optionality boundary: verify-on-stop gates the store

`agent/verification_stop.py:verify_on_stop_enabled()` has this precedence, and
`agent/verification_evidence.py:_ledger_enabled()` delegates to it:

1. `HERMES_VERIFY_ON_STOP` environment variable, when set — any value except
   `0`/`false`/`no`/`off` is truthy;
2. `agent.verify_on_stop` in the resolved config (`true`/`false`, or the legacy
   `auto` surface-aware mode);
3. otherwise **OFF** (opt-in).

When the gate is off, `record_verify_run()` returns `None` from
`_ledger_enabled()` before any `_connect()`, so `verification_evidence.db` is
never created. The probe measured that boundary in fresh homes:

| Scenario | Config / env | `verify_on_stop_enabled()` | `record_verify_run()` | Store |
| --- | --- | --- | --- | --- |
| Default (off) | `config.yaml`: `database.journal_mode: wal` only; no env | `false` | `None` | **absent** |
| Env override on | same config; `HERMES_VERIFY_ON_STOP=1` | `true` | — (precedence check only) | n/a |
| Config on | `agent.verify_on_stop: true`; no env | `true` | event id `1` | created, `32,768` B, header `2,2` (`wal`) |
| Env override off | `agent.verify_on_stop: true`; `HERMES_VERIFY_ON_STOP=0` | `false` | — (precedence check only) | n/a |

Exact evidence lines:

```text
config_contents: database:|  journal_mode: wal|
ASSERT PASS: optionality-off (no env) verify_on_stop_enabled()=false
ASSERT PASS: optionality-off + HERMES_VERIFY_ON_STOP=1 verify_on_stop_enabled()=true
writer_stdout: record_verify_run_return: None|event_id: None|
ASSERT PASS: record_verify_run() returned None with verify-on-stop off
ASSERT PASS: verification_evidence.db is absent when verify-on-stop is off

config_contents: database:|  journal_mode: wal|agent:|  verify_on_stop: true|
ASSERT PASS: optionality-on (config true) verify_on_stop_enabled()=true
ASSERT PASS: optionality-on + HERMES_VERIFY_ON_STOP=0 verify_on_stop_enabled()=false
writer_stdout: record_verify_run_return: {'id': 1, ...}|event_id: 1|
ASSERT PASS: record_verify_run() recorded an event (id 1) with verify-on-stop on
```

The store is therefore **optional and feature-gated**, not a required store:
its absence is the correct state when verify-on-stop is off. When the gate is
on, the first `record_verify_run()` creates it.

#### Seed, copy, and offline conversion

1. **Seed a real WAL store.** In `seed-wal/home` configured
   `database.journal_mode: wal` + `agent.verify_on_stop: true`, run
   `record_verify_run(root=workspace, session_id="g1-verification-seed",
   ok=True)`. It returned event id `1`; the store was `32,768` B with header
   `2,2` (`wal`), sha256
   `9750cf6d72b29e7a0384caa3cc3986f40394d1b4022c81e66d6b77db738c4b4b`.
2. **Copy byte-identically.** `cp -a` to
   `conversion/verification_evidence.db`; both sha256 equality and `cmp -s`
   against the original were asserted before conversion. The copy sha256 was
   the same `9750cf...`.
3. **Convert the copy offline.** Run the supported command
   `hermes sessions set-journal-mode delete --db <copy>`:

```text
$ HERMES_HOME=/tmp/g1-verification.yqQ8Zz/seed-wal/home \
    ./docs/gate/probes/hermes_scratch.sh sessions set-journal-mode delete \
    --db /tmp/g1-verification.yqQ8Zz/conversion/verification_evidence.db
hermes_scratch: HERMES_HOME=/tmp/g1-verification.yqQ8Zz/seed-wal/home
hermes_scratch: exec /home/kaladin/hermes-agent/venv/bin/hermes sessions set-journal-mode delete --db /tmp/g1-verification.yqQ8Zz/conversion/verification_evidence.db
✓ /tmp/g1-verification.yqQ8Zz/conversion/verification_evidence.db: journal_mode wal → delete (header verified).
  Note: config.yaml has database.journal_mode: wal — the next open would switch the file back. Set `database.journal_mode: delete` in config.yaml to keep it.
conversion_exit: 0
```

The converted copy was header `1,1` (`delete`), sha256
`27cb270327a9438e63047c316760872961b102a4cdb458c52e67b3f2069019f0`. The
original WAL store's sha256 before and after conversion was still
`9750cf6d72b29e7a0384caa3cc3986f40394d1b4022c81e66d6b77db738c4b4b` — only
the copy changed.

#### Next writer, twice, under `database.journal_mode: delete`

`delete/home` was configured `database.journal_mode: delete` +
`agent.verify_on_stop: true`; the probe confirmed `resolve_journal_mode()` gave
`delete` and `verify_on_stop_enabled()` gave `true` **before** writing, then
placed its own `cp -a` of the converted copy as
`delete/home/verification_evidence.db` and ran the real writer twice.

| Stage | Artifact path (under `/tmp/g1-verification.yqQ8Zz`) | Size (bytes) | sha256 | Header (18/19) | Mode | Sidecars after close | Event id |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Seed WAL store | `seed-wal/home/verification_evidence.db` | 32,768 | `9750cf6d72b29e7a0384caa3cc3986f40394d1b4022c81e66d6b77db738c4b4b` | `2,2` | `wal` | none | 1 |
| `cp -a` copy before conversion | `conversion/verification_evidence.db` | 32,768 | `9750cf6d72b29e7a0384caa3cc3986f40394d1b4022c81e66d6b77db738c4b4b` | `2,2` | `wal` | none | 1 (copied) |
| Offline-converted copy | `conversion/verification_evidence.db` | 32,768 | `27cb270327a9438e63047c316760872961b102a4cdb458c52e67b3f2069019f0` | `1,1` | `delete` | none | 1 (copied) |
| Converted copy under `delete`, after run 1 | `delete/home/verification_evidence.db` | 32,768 | `d06c77ca7ae7f0077f21e48212937e8b0723a5a4414152b86c275581fb7b5917` | `1,1` | `delete` | none | 2 |
| Converted copy under `delete`, after run 2 | `delete/home/verification_evidence.db` | 32,768 | `7e88e4eed99605724f72805a0fcd16ad78b87d827e10ebb8cbb28c2104651af4` | `1,1` | `delete` | none | 3 |
| Converted copy under `wal` control, after run | `wal-control/home/verification_evidence.db` | 32,768 | `7697058a661885d4aaf92e1785b26cbbe1d7fc71ac8bf2ec5f0acbb5bf22ba05` | `2,2` | `wal` | none | 2 |

The whole-file sha256 changes between writer runs because each run inserts a
verification event (`event_id` 2 then 3); the measurement that matters is the
raw header pair, which stayed `1,1` after both closes. The evidence log also
records the full writer stdout for each run
(`record_verify_run_return: {'id': 2, ...}` / `{'id': 3, ...}`) and the empty
sidecar listing after each close.

**Verdict: `verification_evidence.db` HONOURING.** The offline conversion
produced `1,1`, and two consecutive real writer runs under
`database.journal_mode: delete` both left the header at `1,1`. The store does
**not** reverse a correct offline conversion when the resolved config says
`delete`.

**No compatibility blocker.** Because the converted copy stayed `1,1` across
both writer runs, `verification_evidence.db` is **not** a store that "cannot be
converted". It is not silently excluded from the gate: it is an optional store
that converts cleanly once hermes is configured for `delete`.

#### Read-only paths do not flip the store

The same converted copy was placed in `read-path/home` (configured
`database.journal_mode: delete`, verify-on-stop on) and both application read
paths were exercised:

| Read path | Result | Header after (18/19) | sha256 after |
| --- | --- | --- | --- |
| `verification_status(session_id="g1-verification-seed", cwd=<workspace>)` | resolved the recorded seed event as `passed` | `1,1` (`delete`) | `31d9cd322c766c26b57582de0ac5fd84ab451bf653a87689da62754a7511102e` |
| `_connect()` + `SELECT COUNT(*) FROM verification_events` | event count `1` | `1,1` (`delete`) | `eea73d05ecd8b8c09db20fa5d1c78891f34ae9aa5e2f234f0a689ece9a539f5f` |

Partial output:

```text
ASSERT PASS: read_path_before_reads header is 1,1 (mode delete)
verification_status_stdout: verification_status: {"changed_paths": [], "evidence": {"canonical_command": "hermes verify", ... "status": "passed"}, "root": "/tmp/g1-verification.yqQ8Zz/workspace", "session_id": "g1-verification-seed", "status": "passed"}|
ASSERT PASS: verification_status() resolved the recorded seed event as passed
ASSERT PASS: read_path_after_verification_status header is 1,1 (mode delete)
connect_read_stdout: connect_read_event_count: 1|
ASSERT PASS: read_path_after_connect header is 1,1 (mode delete)
```

Both paths go through `_connect()` → `open_db(..., initialize=_ensure_schema)`,
which re-applies the configured `delete` and executes the idempotent
`CREATE TABLE IF NOT EXISTS` / `INSERT OR REPLACE` schema bootstrap. They are
"read paths" in caller intent, not zero-write paths; the measured point is that
neither one changes the journal format. The header stayed `1,1` through both.

#### The WAL control is config-driven

The same converted `1,1` copy placed in `wal-control/home` (configured
`database.journal_mode: wal`, verify-on-stop on) produced header `2,2` after one
writer run and emitted hermes' own warning:

```text
verification_evidence.db: on-disk journal_mode was delete and has been switched to WAL. This rewrites the database header and persists after this process exits. ... Set `database.journal_mode: delete` in config.yaml to make it stick. This message fires once per process per database.
```

This is the same mechanism as `state.db` (US-005): `apply_wal_with_fallback()`
resolves the configured mode, then the on-disk mode. Configured `delete` takes
the `_set_journal_mode_no_wait(conn, "DELETE")` branch and verifies `delete`;
configured `wal` takes `_enable_wal()` and flips the file back. The control
proves the configured value decides the next open; it is **not** evidence that
`verification_evidence.db` rejects conversion.

#### Integrity

The conversion source copy stayed
`27cb270327a9438e63047c316760872961b102a4cdb458c52e67b3f2069019f0` before and
after all writer/read/control homes ran, and the original WAL store stayed
`9750cf6d72b29e7a0384caa3cc3986f40394d1b4022c81e66d6b77db738c4b4b` through
the end. The probe recorded `real_home=/home/kaladin/.hermes (never opened by
design)`; no command touched it.

**Gate consequence for `verification_evidence.db` (incorporated into the final
Gate Implications).** Because the store is optional, the gate must not refuse a
missing store when verify-on-stop is off. When the store exists (the live
operator home has one) the gate must still check both the resolved
`database.journal_mode` and raw bytes `1,1`, exactly as for `state.db`.
Conversion is viable; configuration must stay `delete` to keep it that way.

### Offline conversion persistence for `kanban.db` and `projects.db` (US-007)

**Measured by US-007** with
`docs/gate/probes/probe_optional_conversion.sh` (exit 0). Full stdout is
`docs/gate/evidence/optional-conversion-persistence.txt`; the captured
scratch root is `/tmp/g1-optional.D9v9Sw` (disposable). Every home is under that
root, `HOME` is redirected into it, and every Hermes CLI call goes through
`hermes_scratch.sh`; no real operator store was opened or altered. Journal
format was read **only** with `read_header.py` (raw bytes 18/19); no SQLite
connection was opened to inspect a journal mode.

This closes the two remaining optional stores so the per-store table has no
UNKNOWN. The probe seeds each store through its real trigger under
`database.journal_mode: wal`, copies it with `cp -a` (sha256 equality plus
`cmp -s`), converts the copy offline with `hermes sessions set-journal-mode
delete --db <copy>`, then places separate `cp -a` copies in a
`database.journal_mode: delete` home and a `wal` control home. The delete home
runs the real trigger twice; the control runs once. The original seed store is
re-hashed after every stage.

**Exact conversion invocation and output** (from
`docs/gate/evidence/optional-conversion-persistence.txt`; the
`projects.db` run is identical in shape):

```text
$ HERMES_HOME=/tmp/g1-optional.D9v9Sw/kanban/seed-wal/home \
    ./docs/gate/probes/hermes_scratch.sh sessions set-journal-mode delete \
    --db /tmp/g1-optional.D9v9Sw/kanban/conversion/kanban.db
hermes_scratch: HERMES_HOME=/tmp/g1-optional.D9v9Sw/kanban/seed-wal/home
hermes_scratch: exec /home/kaladin/hermes-agent/venv/bin/hermes sessions set-journal-mode delete --db /tmp/g1-optional.D9v9Sw/kanban/conversion/kanban.db
✓ /tmp/g1-optional.D9v9Sw/kanban/conversion/kanban.db: journal_mode wal → delete (header verified).
  Note: config.yaml has database.journal_mode: wal — the next open would switch the file back. Set `database.journal_mode: delete` in config.yaml to keep it.
conversion_exit: 0
```

The command's note refers to the **seed** home's `wal` config. The delete home
below is the test of that warning, and it does not switch the file back.

| Store | Stage | Artifact path (under `/tmp/g1-optional.D9v9Sw`) | Size (bytes) | sha256 | Header (18/19) | Mode | Sidecars after close | Trigger runs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `kanban.db` | Seed WAL | `kanban/seed-wal/home/kanban.db` | 118,784 | `1a119305a0a4fc10af8f81b4555af51f8834feec07c6ba135e4d66a244359b52` | `2,2` | `wal` | none | 1 (create) |
| `kanban.db` | `cp -a` copy before conversion | `kanban/conversion/kanban.db` | 118,784 | `1a119305a0a4fc10af8f81b4555af51f8834feec07c6ba135e4d66a244359b52` | `2,2` | `wal` | none | 0 |
| `kanban.db` | Offline-converted copy | `kanban/conversion/kanban.db` | 118,784 | `f94d6e92ba2780d5a7665f31173c9fabc8ff1f1fbd1918b396acb8749b286131` | `1,1` | `delete` | none | offline |
| `kanban.db` | Converted copy under `delete`, after run 1 | `kanban/delete/home/kanban.db` | 118,784 | `f94d6e92ba2780d5a7665f31173c9fabc8ff1f1fbd1918b396acb8749b286131` | `1,1` | `delete` | none | 2 total |
| `kanban.db` | Converted copy under `delete`, after run 2 | `kanban/delete/home/kanban.db` | 118,784 | `f94d6e92ba2780d5a7665f31173c9fabc8ff1f1fbd1918b396acb8749b286131` | `1,1` | `delete` | none | 2 total |
| `kanban.db` | Converted copy under `wal` control, after run | `kanban/wal-control/home/kanban.db` | 118,784 | `01a2197a9795c3d4115060405c19f8d26b52aa973465694bf27555920cde6492` | `2,2` | `wal` | none | 1 |
| `projects.db` | Seed WAL | `projects/seed-wal/home/projects.db` | 45,056 | `e710b33f6a2ea7b406f778192b38a2c78bb03ff1d146494a1782e525e67e3f80` | `2,2` | `wal` | none | 1 (create) |
| `projects.db` | `cp -a` copy before conversion | `projects/conversion/projects.db` | 45,056 | `e710b33f6a2ea7b406f778192b38a2c78bb03ff1d146494a1782e525e67e3f80` | `2,2` | `wal` | none | 0 |
| `projects.db` | Offline-converted copy | `projects/conversion/projects.db` | 45,056 | `91aa3cd406cc51558a1ce60253023a68bc35375c36831c9d3a043c32dedf7071` | `1,1` | `delete` | none | offline |
| `projects.db` | Converted copy under `delete`, after run 1 | `projects/delete/home/projects.db` | 45,056 | `91aa3cd406cc51558a1ce60253023a68bc35375c36831c9d3a043c32dedf7071` | `1,1` | `delete` | none | 2 total |
| `projects.db` | Converted copy under `delete`, after run 2 | `projects/delete/home/projects.db` | 45,056 | `91aa3cd406cc51558a1ce60253023a68bc35375c36831c9d3a043c32dedf7071` | `1,1` | `delete` | none | 2 total |
| `projects.db` | Converted copy under `wal` control, after run | `projects/wal-control/home/projects.db` | 45,056 | `8e074bff26e929b555d1d5be7d319dbcd3d6383d02c1f89383348ef2e097e736` | `2,2` | `wal` | none | 1 |

The `kanban.db` writer was `hermes kanban list` and the `projects.db` writer was
`hermes project list` — the same real triggers that created the stores in
US-003/US-004. Neither trigger adds rows to these fixture stores, so the
post-conversion sha256 is identical after both runs; the measured invariant is
the raw header pair, which stayed `1,1`. The WAL controls changed the same
converted copies back to header `2,2`, proving the configured value decides the
next open exactly as it does for `state.db` and `verification_evidence.db`.

**Integrity.** The original `kanban.db` stayed
`1a119305a0a4fc10af8f81b4555af51f8834feec07c6ba135e4d66a244359b52` before
conversion, immediately after, and at the end; its conversion source stayed
`f94d6e92ba2780d5a7665f31173c9fabc8ff1f1fbd1918b396acb8749b286131` through the
writer/control homes. The original `projects.db` stayed
`e710b33f6a2ea7b406f778192b38a2c78bb03ff1d146494a1782e525e67e3f80` through the
end; its conversion source stayed
`91aa3cd406cc51558a1ce60253023a68bc35375c36831c9d3a043c32dedf7071`.

**Verdicts: `kanban.db` HONOURING; `projects.db` HONOURING.** Both optional
stores convert offline and keep the rollback journal across two consecutive
real trigger opens under resolved `database.journal_mode: delete`. Their WAL
controls flip back to `2,2`, which is config-driven, not a delete-mode failure.
There is no store in this investigation that cannot be converted.

## Required vs Optional

**Final per-store classification derived from observed runtime behaviour** —
not from `*.db` filenames. The classification below is the gate's missing-store
policy.

| Store | Classification | Behavioural evidence | Gate handling |
| --- | --- | --- | --- |
| `state.db` | **Required (core)** | Created by the first **writing** session (`SessionDB()` + `create_session()`); `hermes sessions list` and `hermes doctor` leave it absent because they are read-only. A profile that has ever written a session has it. | **Refuse when missing.** A launch is itself a writing session, so an absent core store cannot be verified. When present, require resolved `database.journal_mode: delete` + raw bytes `1,1`. |
| `verification_evidence.db` | **Optional — verify-on-stop gated** | `record_verify_run()` returns `None` and the store is **absent** when verify-on-stop is off; with `agent.verify_on_stop: true` (or `HERMES_VERIFY_ON_STOP=1`) the first event creates it. Precedence measured: env → config → default OFF. | **Check only when present.** Absence is never a refusal, even when verify-on-stop is on (the first event will create it). |
| `kanban.db` | **Optional — kanban-feature gated** | Created by `hermes kanban list`; no kanban command means no store (the supplied live profile had none). | **Check only when present.** Resolve the path with `kanban_home()` / `get_default_hermes_root()` for named profiles. |
| `projects.db` | **Optional — project-feature gated** | Created by `hermes project list`; no project command means no store | **Check only when present.** |

Only `state.db` is core. The other three are created lazily by their feature
triggers; treating every `*.db` name ever mentioned in the source as a required
store would make the gate refuse healthy profiles. `verification_evidence.db`,
`kanban.db`, and `projects.db` are explicitly **not** compatibility blockers:
they are optional, and when present they convert and stay converted under
`database.journal_mode: delete` (US-006/US-007 measurements above). The live
measurement supplied with the task — `state.db` and `verification_evidence.db`
in WAL, no `kanban.db` — is exactly the exercised-feature snapshot this policy
predicts.

## Gate Implications

**Final policy for the hermes-into-Matchlock launch gate.** This section is the
actionable conclusion of G1. The gate itself is not implemented here (this is a
bounded investigation and changes no production code).

A launch is allowed only when **both** checks pass for every store the gate must
inspect:

1. **The resolved config is `delete`.** The gate must resolve the profile's
   `database.journal_mode` with Hermes' own layer order: `DEFAULT_CONFIG`
   (`wal`) → user `$HERMES_HOME/config.yaml` → managed-scope `config.yaml`
   applied last; invalid, non-string, or missing values fail safe to `wal`
   (US-002). The resolved value must be exactly `delete`. Grepping the user
   YAML alone is unsound because a managed overlay can win in either direction.
2. **Raw header bytes 18 and 19 are `1` and `1`.** The gate opens the store in
   binary, reads the first 20 bytes, and requires the SQLite format-version pair
   `1,1`. It must **never** open the store with SQLite or issue `PRAGMA
   journal_mode` to check the mode: a connection or checkpoint can change the
   thing being measured. Every measurement in this investigation used
   `docs/gate/probes/read_header.py` only.

Both checks are mandatory because either alone is unsound:

- **Config-only** would accept an existing WAL store. Hermes never
  live-downgrades an existing WAL store, so the offline conversion is required;
  the config says what the next open will do, not what is on disk now.
- **Bytes-only** would accept a `1,1` store whose resolved config is `wal`.
  Every WAL control in US-005/US-006/US-007 flipped the same converted `1,1`
  file back to `2,2` on the next writer open.

### Store set and missing-store policy

The gate's store universe is the behaviourally derived set (US-003), not every
`*.db` name in the source:

| Store | Gate requirement | Missing-store policy | Present-store policy |
| --- | --- | --- | --- |
| `state.db` | **Required (core)** | **Refuse.** The launch itself is a writing session, so an absent core store cannot be verified. The refusal must name the store path and tell the operator to create/convert it under `delete` config. | Require resolved `delete` + raw bytes `1,1`. |
| `verification_evidence.db` | Optional (verify-on-stop gated) | Accept absence; do not refuse, even when verify-on-stop is on, because the first verification event creates it. | Check only when present: require resolved `delete` + raw bytes `1,1`. |
| `kanban.db` | Optional (kanban gated) | Accept absence. | Check only when present. Resolve the path with `kanban_home()` / `get_default_hermes_root()` so a named profile's shared-root board is found rather than assuming `$HERMES_HOME/kanban.db`. |
| `projects.db` | Optional (project gated) | Accept absence. | Check only when present. |

No other SQLite file appeared in any probe home, and `cron/jobs.json` is JSON,
not a SQLite store. The gate must not refuse a profile merely because an
optional feature store has never been created — that is the correct state for an
unused feature and is exactly what the supplied live measurement showed for
`kanban.db`.

### Conversion / remediation

If a required store (or a present optional store) is WAL (`2,2`) while the
resolved config is `delete`, the gate refuses. The supported remediation is the
offline conversion that was measured end to end:

```text
hermes sessions set-journal-mode delete --db <store>
```

Then the gate re-reads raw bytes `1,1`. All four stores keep the conversion
across subsequent writer opens (US-005/US-006/US-007), so the gate does **not**
need an "unconvertible store" exemption. **No store cannot be converted.**
Setting `database.journal_mode` alone is not remediation for an existing WAL
store (never-live-downgrade), and converting the bytes alone is not durable
unless the resolved config stays `delete`.

### What the gate must never do

- Never open a store through SQLite to "check" its journal mode.
- Never treat a missing optional store as a missing required store.
- Never trust raw user YAML without resolving the managed overlay and the
  invalid-value fail-safe.
- Never infer safety from the config alone or from the bytes alone.
- Never enumerate stores by guessed `*.db` filenames; use the derived required
  set, and the optional stores only when present.

## Command Appendix

### A. Artifact truth (captured before any G1 file was created)

```text
$ git rev-parse HEAD
f2f34c9177ec28a51ae89a48e612baff2b1892b3
$ git rev-parse HEAD^{tree}
ebb0bd1b882167f3fbab28e92f8f80c21428fa0c
$ git branch --show-current
feature/g1-store-control-discovery
$ date -u
Wed Oct 21 11:22:42 PM UTC 2026
$ uname -a
Linux vaimetal 7.0.0-38-generic #38-Ubuntu SMP PREEMPT_DYNAMIC Fri Sep  4 09:10:14 UTC 2026 x86_64 GNU/Linux
$ hostname
vaimetal
$ cat /proc/1/cgroup
0::/init.scope
$ ls -d /.dockerenv /run/.containerenv 2>/dev/null
(no output = no container marker)
$ command -v strace sha256sum xxd python3
/usr/bin/strace
/usr/bin/sha256sum
/usr/bin/xxd
/usr/bin/python3
$ git status --porcelain -- src
(empty)
```

### B. Runtime versions

```text
$ /home/kaladin/hermes-agent/venv/bin/hermes --version
Hermes Agent vgit.d623a66.dirty (2026.9.24) · upstream 8b66a510 · local d623a660 (+131 carried commits)
Install directory: /home/kaladin/hermes-agent
Install method: git
Python: 3.14.7
OpenAI SDK: 2.24.0
Update available — run 'hermes update'
$ /home/kaladin/hermes-agent/venv/bin/python --version
Python 3.14.7
$ /home/kaladin/hermes-agent/venv/bin/python -c 'import sqlite3; con = sqlite3.connect(":memory:"); ...'
sqlite_version: 3.53.3
sqlite_source_id: 2026-06-26 20:14:12 d4c0e51e4aeb96955b99185ab9cde75c339e2c29c3f3f12428d364a10d78alt1
$ git -C /home/kaladin/hermes-agent rev-parse HEAD
d623a6607e385d9d8024ce960234be47536351f2
$ git -C /home/kaladin/hermes-agent describe --tags --always
d623a6607
$ git -C /home/kaladin/hermes-agent status --porcelain
 M acp_adapter/commands.py
 M build-and-install
```

### C. Header-reader unit test

```text
$ /home/kaladin/hermes-agent/venv/bin/python docs/gate/probes/test_read_header.py
test_bad_magic_exits_2 ... ok
test_delete_header_is_1_1 ... ok
test_missing_file_exits_2 ... ok
test_probe_does_not_import_the_database_module ... ok
test_probe_does_not_resolve_a_database_connection ... ok
test_short_file_exits_2 ... ok
test_unknown_version_pair_is_reported_on_valid_container ... ok
test_wal_header_is_2_2 ... ok

Ran 8 tests in 0.956s

OK
(exit 0)
```

### D. Wrapper smoke checks (stub binary; no real Hermes invocation)

```text
$ scratch="$(mktemp -d /tmp/g1-smoke.XXXXXX)"; mkdir -p "$scratch/home"
$ HERMES_HOME="$scratch/home" HERMES_BIN=/bin/true ./docs/gate/probes/hermes_scratch.sh config path
hermes_scratch: HERMES_HOME=/tmp/g1-smoke.fm68CL/home
hermes_scratch: exec /bin/true config path
(exit 0)

$ HERMES_HOME=/home/kaladin/.hermes HERMES_BIN=/bin/true ./docs/gate/probes/hermes_scratch.sh config path
hermes_scratch: REFUSED: HERMES_HOME resolves to the real operator home: /home/kaladin/.hermes
(exit 64)

$ HERMES_HOME=/tmp/not-g1-xyz HERMES_BIN=/bin/true ./docs/gate/probes/hermes_scratch.sh config path
hermes_scratch: REFUSED: HERMES_HOME must be under /tmp/g1-* (got: /tmp/not-g1-xyz)
(exit 64)
```

### E. Harness paths

| Path | Purpose |
| --- | --- |
| `docs/gate/probes/read_header.py` | Raw-bytes-18/19 header reader; JSON report; no database connection. |
| `docs/gate/probes/test_read_header.py` | Stdlib unittest over synthetic fixtures. |
| `docs/gate/probes/hermes_scratch.sh` | Scratch-home-only gateway for every Hermes invocation. |
| `docs/gate/probes/probe_config.py` | US-002 config-layer probe; five asserted scenarios; scratch homes only. |
| `docs/gate/probes/probe_store_inventory.sh` | US-003 inventory probe; nine triggers in separate fresh homes; asserts each store is attributable to a trigger. |
| `docs/gate/probes/probe_fresh_modes.sh` | US-004 fresh-store-as-`delete` probe with a `wal` control for every store. |
| `docs/gate/probes/probe_conversion_persistence.sh` | US-005 `state.db` offline-conversion persistence across two writers + `wal` control. |
| `docs/gate/probes/probe_verification_conversion.sh` | US-006 `verification_evidence.db` optionality and conversion persistence. |
| `docs/gate/probes/probe_optional_conversion.sh` | US-007 `kanban.db`/`projects.db` offline-conversion persistence + `wal` controls. |
| `docs/gate/probes/run_all.sh` | US-007 consolidated harness: header unit test + every probe in one fresh scratch root, strace safety scan, exit nonzero on any failure. |
| `docs/gate/evidence/config-resolution.txt` | US-002 probe stdout (raw JSON per scenario + pass summary). |
| `docs/gate/evidence/config-resolution-strace.txt` | US-002 strace summary: zero opens under the real operator home. |
| `docs/gate/evidence/store-inventory.txt` | US-003 inventory probe stdout: trigger results, file listings, raw header JSON, assertions. |
| `docs/gate/evidence/store-open-*.txt` | US-003 filtered strace captures (kanban, project, sessions, doctor, state-sessiondb); each header records zero real-home opens. |
| `docs/gate/evidence/fresh-store-modes*.txt` | US-004 probe stdout and filtered syscall capture. |
| `docs/gate/evidence/conversion-persistence.txt` | US-005 `state.db` probe stdout (conversion, writers, controls, digests). |
| `docs/gate/evidence/verification-conversion-persistence.txt` | US-006 verification-evidence optionality/conversion probe stdout. |
| `docs/gate/evidence/optional-conversion-persistence.txt` | US-007 kanban/projects conversion probe stdout. |
| `docs/gate/evidence/final-harness.log` | US-007 consolidated harness log: every step's exit, safety counts, final PASS. |

### F. Config-resolution probe (US-002)

Exact invocation (cwd is the installed Hermes tree; the venv Python is the
exercised interpreter). Full stdout is saved verbatim at
`docs/gate/evidence/config-resolution.txt`.

```text
$ cd /home/kaladin/hermes-agent
$ /home/kaladin/hermes-agent/venv/bin/python \
      /home/kaladin/.tamandua/worktrees/tamandua-origin-dev16-afd82b30/168-2869e550/docs/gate/probes/probe_config.py
... one JSON record per scenario ...
{"all_passed": true, "cwd": "/home/kaladin/hermes-agent", "hermes_bin": "/home/kaladin/hermes-agent/venv/bin/hermes", "hermes_src": "/home/kaladin/hermes-agent", "host_managed_dir_note": "get_managed_dir() with this process environment; scenarios 1-4 patch it to None so each layer is measured in isolation, and scenario 5 patches it to a scratch dir", "host_managed_dir_observed": null, "probe": "US-002 config resolution", "python": "3.14.7", "scenarios": ["default-no-database-section", "user-config-delete", "invalid-value-bogus", "env-var-does-not-override", "managed-overlay-wins"], "scratch_base": "/tmp/g1-config-1ta71rqz"}
probe_config: all 5 scenarios passed
(exit 0)
```

Representative scenario record (the managed-overlay case; every other record
has the same shape):

```json
{"checks": {"cli_exit_zero": true, "cli_path_matches_in_process": true, "managed_key_present": true, "resolved_matches_expected": true}, "cli": {"argv": ["/bin/bash", "/home/kaladin/.tamandua/worktrees/tamandua-origin-dev16-afd82b30/168-2869e550/docs/gate/probes/hermes_scratch.sh", "config", "path"], "exit": 0, "hermes_home": "/tmp/g1-config-1ta71rqz/scenario-5/hermes-home", "stderr": "hermes_scratch: HERMES_HOME=/tmp/g1-config-1ta71rqz/scenario-5/hermes-home\nhermes_scratch: exec /home/kaladin/hermes-agent/venv/bin/hermes config path", "stdout": "/tmp/g1-config-1ta71rqz/scenario-5/hermes-home/config.yaml"}, "cli_realpath": "/tmp/g1-config-1ta71rqz/scenario-5/hermes-home/config.yaml", "config_exists": true, "config_path": "/tmp/g1-config-1ta71rqz/scenario-5/hermes-home/config.yaml", "config_realpath": "/tmp/g1-config-1ta71rqz/scenario-5/hermes-home/config.yaml", "config_sha256": "98762c48b618a4bfb35f8f738b4b296ee22d650bb1d6a00e4233ca03cbd508cd", "expected": "delete", "hermes_home": "/tmp/g1-config-1ta71rqz/scenario-5/hermes-home", "hermes_home_realpath": "/tmp/g1-config-1ta71rqz/scenario-5/hermes-home", "managed_overlay_keys": ["database.journal_mode"], "managed_overlay_value": "delete", "raw_user_value": "wal", "resolved": "delete", "scenario": "managed-overlay-wins", "winning_layer": "managed-scope overlay (admin config.yaml over user config)"}
```

Source evidence for the resolution pipeline (read-only inspection of the
installed runtime, not a verdict substitute):

```text
$ grep -n "def get_config_path" -A2 /home/kaladin/hermes-agent/hermes_cli/config.py
436:def get_config_path() -> Path:
437-    """Get the main config file path."""
438-    return get_hermes_home() / "config.yaml"

$ grep -n "Managed wins at the leaf" -A1 /home/kaladin/hermes-agent/hermes_cli/config.py
2316:    Managed wins at the leaf and is applied AFTER user expansion so a user ``${VAR}`` cannot shadow
2317-    a managed literal: managed values expand only against the process environment. This

$ grep -n "def resolve_journal_mode" -A12 /home/kaladin/hermes-agent/hermes_state_wal.py
157:def resolve_journal_mode() -> str:
158-    """The configured ``database.journal_mode`` (``wal`` default; ``delete`` for filesystems without WAL-safe
159-    durability: macOS virtiofs, NFS, SMB). Invalid values fail safe to ``wal``."""
160-    try:
161-        from hermes_cli.config import load_config_readonly
162-        database = (load_config_readonly() or {}).get("database", {})
163-        raw = database.get("journal_mode", "wal") if isinstance(database, dict) else "wal"
164-    except Exception:
165-        return "wal"
166-    mode = raw.strip().lower() if isinstance(raw, str) else ""
167-    return mode if mode in ("wal", "delete") else "wal"

$ grep -rn "HERMES_JOURNAL_MODE" --include=*.py /home/kaladin/hermes-agent
/home/kaladin/hermes-agent/tests/hermes_state/test_journal_mode_config.py:101:    monkeypatch.setenv("HERMES_JOURNAL_MODE", "delete")

$ ls -ld /etc/hermes
ls: cannot access '/etc/hermes': No such file or directory
$ printenv HERMES_MANAGED_DIR
(no output = unset)
$ cd /home/kaladin/hermes-agent
$ /home/kaladin/hermes-agent/venv/bin/python -c 'import hermes_cli.managed_scope as m; print(m.get_managed_dir())'
None
```

The probe's own safety checks refuse to run if its scratch base resolves to
`/home/kaladin/.hermes` or inside it, and assert every home begins with
`/tmp/g1-`. The probe creates no managed/system config; scenario 5 writes only
inside the disposable scratch tree.


### G. Store-inventory probe (US-003)

Exact invocation (the probe creates and removes its own `/tmp/g1-*` root unless
`G1_KEEP_SCRATCH=1`; the captured run kept the root so the raw header readings
could be re-checked):

```text
$ cd /home/kaladin/.tamandua/worktrees/tamandua-origin-dev16-afd82b30/168-2869e550
$ G1_KEEP_SCRATCH=1 ./docs/gate/probes/probe_store_inventory.sh
probe_store_inventory: scratch_root=/tmp/g1-inv.FByi7k
probe_store_inventory: hermes_src=/home/kaladin/hermes-agent
probe_store_inventory: python=Python 3.14.7
probe_store_inventory: real_home=/home/kaladin/.hermes (never opened by design)
...
ASSERT PASS: SessionDB() direct writer exists
ASSERT PASS: hermes sessions list (read-only) did not create sessions-list/home/state.db
ASSERT PASS: record_verify_run with verify-on-stop OFF did not create verification-off/home/verification_evidence.db
ASSERT PASS: record_verify_run with verify-on-stop ON exists
ASSERT PASS: hermes kanban list exists
ASSERT PASS: hermes project list exists
ASSERT PASS: hermes cron list (jobs.json, not SQLite) did not create cron-list/home/cron.db
ASSERT PASS: hermes doctor (read-only health check) did not create doctor/home/state.db
RESULT: PASS (all stores attributable; read-only triggers created no store)
(exit 0)
```

The complete stdout (every trigger's exit code, first stdout line, file listing,
and raw header JSON) is saved at `docs/gate/evidence/store-inventory.txt`.

Header-offset validation that corrected US-001's reader. Synthetic SQLite files
were created through the SQLite library, closed, and then read as raw bytes only:

```text
set wal -> ('wal',)
wal header offsets 18,19: 2 2
wal header offsets 17,18: 0 2
set delete -> ('delete',)
delete header offsets 18,19: 1 1
delete header offsets 17,18: 0 1
```

So the SQLite file-format version pair is at offsets 18/19 (not 17/18), and the
corrected reader reports `wal`/`delete` for the real stores created by Hermes.
The reader's own test is still green:

```text
$ /home/kaladin/hermes-agent/venv/bin/python docs/gate/probes/test_read_header.py
Ran 8 tests in 0.967s
OK
```

Representative strace capture (the other four are the same shape, one per
trigger; the filtered results are under `docs/gate/evidence/`):

```text
$ scratch="$(mktemp -d /tmp/g1-strace.XXXXXX)"
$ mkdir -p "$scratch/operator-home" "$scratch/kanban/home"
$ env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$scratch/operator-home" \
      HERMES_HOME="$scratch/kanban/home" \
      strace -f -e trace=openat,open,creat -o "$scratch/kanban.raw" \
      -- docs/gate/probes/hermes_scratch.sh kanban list
$ grep -F -- "$scratch/kanban/home" "$scratch/kanban.raw" | grep -E '\.(db|db-wal|db-shm)'
openat(AT_FDCWD, "<scratch>/kanban/home/kanban.db", O_RDWR|O_CREAT|O_NOFOLLOW|O_CLOEXEC, 0644) = 7
openat(AT_FDCWD, "<scratch>/kanban/home/kanban.db-wal", O_RDWR|O_CREAT|O_NOFOLLOW|O_CLOEXEC, 0644) = 8
openat(AT_FDCWD, "<scratch>/kanban/home/kanban.db-shm", O_RDWR|O_CREAT|O_NOFOLLOW|O_CLOEXEC, 0644) = 9
$ grep -F -- '/home/kaladin/.hermes' "$scratch/kanban.raw" | wc -l
0
```

The `sessions list` capture is the strongest read-only evidence: it shows the
single `state.db` open as `O_RDONLY` returning `ENOENT`, with no `O_CREAT`, so
the absent store is deliberate rather than an unmeasured path. The `doctor`
capture has zero database-path opens at all. All five logs report
`real_operator_home_open_lines: 0`.

Source mapping commands (read-only inspection of the installed runtime):

```text
$ cd /home/kaladin/hermes-agent
$ grep -n "apply_wal_with_fallback" hermes_state.py hermes_cli/kanban_db_connect.py
hermes_state.py:795:            mode = apply_wal_with_fallback(conn, db_label="state.db")
hermes_cli/kanban_db_connect.py:647:            apply_wal_with_fallback(conn, db_label=f"kanban.db ({path.name})")
$ grep -n "open_db(" hermes_cli/projects_db.py agent/verification_evidence.py
hermes_cli/projects_db.py:133:    return open_db(path, db_label="projects.db", foreign_keys=True, initialize=_initialize)
agent/verification_evidence.py:133:    return open_db(_db_path(), db_label="verification_evidence.db", initialize=_ensure_schema)
$ grep -rn -iE "pragma[[:space:]]+journal_mode" --include=*.py . | grep -v '/tests/' | grep -v '/evals/'
./hermes_cli/kanban_db_connect.py:1137:        row = conn.execute("PRAGMA journal_mode").fetchone()
./hermes_cli/session_recovery.py:300:    row = conn.execute("PRAGMA journal_mode").fetchone()
./hermes_cli/sqlite_util.py:36:    ... a raw ``PRAGMA journal_mode=WAL`` bypasses all three.
./hermes_state_dbfile.py:790:        jm = _scalar("PRAGMA journal_mode")
./hermes_state_repair.py:777:            conn.execute("PRAGMA journal_mode").fetchone()
./hermes_state_wal.py:336:        mode = _mode_from_row(conn.execute("PRAGMA journal_mode=WAL").fetchone())
./hermes_state_wal.py:412:        return _mode_from_row(conn.execute(f"PRAGMA journal_mode={mode}").fetchone())
```

The only WAL-setting execution is inside `hermes_state_wal._enable_wal()` (the
canonical setter body); the other listed occurrences are reads, apart from
`_set_journal_mode_no_wait()` at line 412, which is the explicit
`delete`/`wal` switch used by the canonical setter and the offline
`hermes sessions set-journal-mode` path. No production caller sets WAL directly.

### H. Fresh-store-mode probe (US-004)

Exact invocation (the probe creates and removes its own `/tmp/g1-*` root unless
`G1_KEEP_SCRATCH=1`; the captured run kept the root so the raw header readings
could be re-checked):

```text
$ cd /home/kaladin/.tamandua/worktrees/tamandua-origin-dev16-afd82b30/168-2869e550
$ G1_KEEP_SCRATCH=1 ./docs/gate/probes/probe_fresh_modes.sh
probe_fresh_modes: scratch_root=/tmp/g1-fresh.bVfXCg
probe_fresh_modes: hermes_src=/home/kaladin/hermes-agent
probe_fresh_modes: python=Python 3.14.7
probe_fresh_modes: real_home=/home/kaladin/.hermes (never opened by design)
...
ASSERT PASS: state.db fresh delete header is 1,1 and wal control is 2,2
ASSERT PASS: verification_evidence.db fresh delete header is 1,1 and wal control is 2,2
ASSERT PASS: kanban.db fresh delete header is 1,1 and wal control is 2,2
ASSERT PASS: projects.db fresh delete header is 1,1 and wal control is 2,2

== Summary table ==
store                        config_mode   header_bytes  observed_mode fresh_verdict
state.db                     delete        1 1           delete        HONOURING
state.db                     wal           2 2           wal           control
verification_evidence.db     delete        1 1           delete        HONOURING
verification_evidence.db     wal           2 2           wal           control
kanban.db                    delete        1 1           delete        HONOURING
kanban.db                    wal           2 2           wal           control
projects.db                  delete        1 1           delete        HONOURING
projects.db                  wal           2 2           wal           control

RESULT: PASS (every delete home created its store at 1,1; every wal control at 2,2)
(exit 0)
```

The complete stdout — every writer's exit code/stdout/stderr, config
path/realpath, resolved mode, store size, sha256, raw byte pair, sidecar
listing, and `related_files` listing — is saved verbatim at
`docs/gate/evidence/fresh-store-modes.txt`.

Representative `read_header.py` records from that log:

```text
{"path": ".../state-delete/home/state.db", "size": 274432, "sha256": "43e51474b83bc0ebe565358da578a60495efd9dc7d4c83740e2f140177553069", "byte18": 1, "byte19": 1, "mode": "delete"}
{"path": ".../state-wal/home/state.db", "size": 274432, "sha256": "492a579abe6cbbae29669fb192264c8448db1ee02b483de3ba522b4037e5bff0", "byte18": 2, "byte19": 2, "mode": "wal"}
{"path": ".../verification_evidence-delete/home/verification_evidence.db", "size": 32768, "sha256": "a7a2ea628c41c8d1912d91d3c2278142d80db222c6e90afe4d6590a1e8f3770d", "byte18": 1, "byte19": 1, "mode": "delete"}
{"path": ".../verification_evidence-wal/home/verification_evidence.db", "size": 32768, "sha256": "f79f95cc0a39760d71d40759d9c41384489271d510bb1f2f4fe5fe3956724969", "byte18": 2, "byte19": 2, "mode": "wal"}
{"path": ".../kanban-delete/home/kanban.db", "size": 118784, "sha256": "e8ce52281798e509d324262a269c5732a2ab1c5b721b216cf49e2d08ff5d15ae", "byte18": 1, "byte19": 1, "mode": "delete"}
{"path": ".../kanban-wal/home/kanban.db", "size": 118784, "sha256": "1a119305a0a4fc10af8f81b4555af51f8834feec07c6ba135e4d66a244359b52", "byte18": 2, "byte19": 2, "mode": "wal"}
{"path": ".../projects-delete/home/projects.db", "size": 45056, "sha256": "be5297cecf6c2ea9b023e494f3e51a460007de9f6c9b9a2446c23e3bd9a02862", "byte18": 1, "byte19": 1, "mode": "delete"}
{"path": ".../projects-wal/home/projects.db", "size": 45056, "sha256": "e710b33f6a2ea7b406f778192b38a2c78bb03ff1d146494a1782e525e67e3f80", "byte18": 2, "byte19": 2, "mode": "wal"}
```

Representative syscall corroboration (full filtered summary in
`docs/gate/evidence/fresh-store-modes-strace.txt`; 81,379 traced syscall lines,
`real_operator_home_open_lines: 0`):

```text
## state-delete   (rollback journal only; no -wal/-shm)
openat(AT_FDCWD, "<scratch>/state-delete/home/state.db", O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC, 0600) = 4
openat(AT_FDCWD, "<scratch>/state-delete/home/state.db-journal", O_RDWR|O_CREAT|O_NOFOLLOW|O_CLOEXEC, 0600) = 5
## state-wal      (WAL sidecars present)
openat(AT_FDCWD, "<scratch>/state-wal/home/state.db-wal", O_RDWR|O_CREAT|O_NOFOLLOW|O_CLOEXEC, 0600) = 5
openat(AT_FDCWD, "<scratch>/state-wal/home/state.db-shm", O_RDWR|O_CREAT|O_NOFOLLOW|O_CLOEXEC, 0600) = 6
```

The same delete-only-journal / WAL-sidecar split repeats for
`verification_evidence.db`, `kanban.db`, and `projects.db` in the evidence
file. `read_header.py` was the only journal-format reader; no SQLite mode query
was issued by any probe in this story.

### I. Offline-conversion-persistence probe (US-005)

Exact invocation (the probe creates and removes its own `/tmp/g1-*` root unless
`G1_KEEP_SCRATCH=1`; the captured run kept the root so the raw readings could be
re-checked):

```text
$ cd /home/kaladin/.tamandua/worktrees/tamandua-origin-dev16-afd82b30/168-2869e550
$ G1_KEEP_SCRATCH=1 ./docs/gate/probes/probe_conversion_persistence.sh
probe_conversion_persistence: scratch_root=/tmp/g1-conversion.zzGFo1
probe_conversion_persistence: hermes_src=/home/kaladin/hermes-agent
probe_conversion_persistence: python=Python 3.14.7
probe_conversion_persistence: hermes=Hermes Agent vgit.d623a66.dirty (2026.9.24) · upstream 8b66a510 · local d623a660 (+131 carried commits)
probe_conversion_persistence: real_home=/home/kaladin/.hermes (never opened by design)
probe_conversion_persistence: header_reader=.../read_header.py (raw bytes 18/19 only; no SQLite connection)
...
ASSERT PASS: seed_wal_state_db header is 2,2 (mode wal)
ASSERT PASS: copy equals original before conversion (sha256 a2e4c5028d134406feff2af8b90c154cf6d2fa7f8888ccb45d2b8785075fb591)
ASSERT PASS: converted_copy header is 1,1 (mode delete)
ASSERT PASS: original WAL store sha256 is unchanged by conversion of the copy
ASSERT PASS: delete resolves database.journal_mode=delete before the writer
ASSERT PASS: delete_run_1 header is 1,1 (mode delete)
ASSERT PASS: delete_run_2 header is 1,1 (mode delete)
ASSERT PASS: wal-control resolves database.journal_mode=wal before the writer
ASSERT PASS: wal_control_run header is 2,2 (mode wal)
ASSERT PASS: conversion source copy was untouched by both writer homes
ASSERT PASS: original WAL store sha256 is still unchanged at the end

== state.db offline-conversion persistence verdict ==
stage                          bytes      mode       writer_runs  result
seed WAL                       2,2        wal        1 (create)   control baseline
converted copy                 1,1        delete     offline      converted
delete home after run 1        1,1        delete     2            kept rollback
delete home after run 2        1,1        delete     2            kept rollback
wal control after run          2,2        wal        1            config-driven

STATE.DB VERDICT: HONOURING
RESULT: PASS (state.db conversion persists across two delete-mode writer runs; WAL control flips to 2,2)
(exit 0)
```

The complete stdout — every writer's exit code/stdout/stderr, config
path/realpath, resolved mode, store size, sha256, raw byte pair, sidecar
listing, and related-file listing — is saved verbatim at
`docs/gate/evidence/conversion-persistence.txt`, including the full
`set-journal-mode` output and the WAL control's mode-switch warning. No real
operator store was read or written; the seed store, the conversion copy, and all
writer homes are under `/tmp/g1-conversion.zzGFo1`.

### J. Verification-evidence optionality/conversion probe (US-006)

Exact invocation (the probe creates and removes its own `/tmp/g1-*` root unless
`G1_KEEP_SCRATCH=1`; the captured run kept the root so the raw readings could be
re-checked):

```text
$ cd /home/kaladin/.tamandua/worktrees/tamandua-origin-dev16-afd82b30/168-2869e550
$ G1_KEEP_SCRATCH=1 ./docs/gate/probes/probe_verification_conversion.sh
probe_verification_conversion: scratch_root=/tmp/g1-verification.yqQ8Zz
probe_verification_conversion: hermes_src=/home/kaladin/hermes-agent
probe_verification_conversion: python=Python 3.14.7
probe_verification_conversion: hermes=Hermes Agent vgit.d623a66.dirty (2026.9.24) · upstream 8b66a510 · local d623a660 (+131 carried commits)
probe_verification_conversion: real_home=/home/kaladin/.hermes (never opened by design)
probe_verification_conversion: header_reader=.../read_header.py (raw bytes 18/19 only; no SQLite connection)
probe_verification_conversion: host_native=/proc/1/cgroup=0::/init.scope
...
ASSERT PASS: optionality-off (no env) verify_on_stop_enabled()=false
ASSERT PASS: record_verify_run() returned None with verify-on-stop off
ASSERT PASS: verification_evidence.db is absent when verify-on-stop is off
ASSERT PASS: optionality-on (config true) verify_on_stop_enabled()=true
ASSERT PASS: record_verify_run() recorded an event (id 1) with verify-on-stop on
ASSERT PASS: seed_wal_verification_evidence_db header is 2,2 (mode wal)
ASSERT PASS: copy equals original before conversion (sha256 9750cf6d72b29e7a0384caa3cc3986f40394d1b4022c81e66d6b77db738c4b4b)
ASSERT PASS: converted_copy header is 1,1 (mode delete)
ASSERT PASS: original WAL store sha256 is unchanged by conversion of the copy
ASSERT PASS: delete-home resolves database.journal_mode=delete before the writer
ASSERT PASS: delete_run_1 header is 1,1 (mode delete)
ASSERT PASS: delete_run_2 header is 1,1 (mode delete)
ASSERT PASS: read_path_after_verification_status header is 1,1 (mode delete)
ASSERT PASS: verification_status() resolved the recorded seed event as passed
ASSERT PASS: read_path_after_connect header is 1,1 (mode delete)
ASSERT PASS: wal_control_run header is 2,2 (mode wal)
ASSERT PASS: conversion source copy was untouched by the delete/read/control homes
ASSERT PASS: original WAL store sha256 is still unchanged at the end

== verification_evidence.db optionality + conversion-persistence verdict ==
stage                              header    mode     writer_runs   result
verify OFF                         absent    -        0             optional store not created
verify ON (config)                 2,2       wal      1 (create)    optional store created
seed WAL                           2,2       wal      1 (create)    control baseline
converted copy                     1,1       delete   offline       converted
delete home after run 1            1,1       delete   1             next-writer result
delete home after run 2            1,1       delete   2             next-writer result
read path (status + connect)       1,1       delete   0             reads did not flip
wal control after run              2,2       wal      1             config-driven

VERIFICATION_EVIDENCE.DB VERDICT: HONOURING
RESULT: PASS (verification_evidence.db conversion persists across two delete-mode writer runs; reads do not flip it)
(exit 0)
```

The complete stdout — every writer's exit code/stdout/stderr, config
path/realpath/contents, resolved mode, `verify_on_stop_enabled()` result, store
size, sha256, raw byte pair, sidecar listing, related-file listing,
`verification_status()` JSON, and `_connect()` event count — is saved verbatim
at `docs/gate/evidence/verification-conversion-persistence.txt`. No real
operator store was read or written; the seed store, the conversion copy, and all
writer/read/control homes are under `/tmp/g1-verification.yqQ8Zz`.

### K. Optional-store conversion probe (US-007)

Exact invocation (the probe creates and removes its own `/tmp/g1-*` root unless
`G1_KEEP_SCRATCH=1`; the captured run kept the root so the raw readings could be
re-checked):

```text
$ cd /home/kaladin/.tamandua/worktrees/tamandua-origin-dev16-afd82b30/168-2869e550
$ G1_KEEP_SCRATCH=1 ./docs/gate/probes/probe_optional_conversion.sh
probe_optional_conversion: scratch_root=/tmp/g1-optional.D9v9Sw
probe_optional_conversion: hermes_src=/home/kaladin/hermes-agent
probe_optional_conversion: python=Python 3.14.7
probe_optional_conversion: hermes=Hermes Agent vgit.d623a66.dirty (2026.9.24) · upstream 8b66a510 · local d623a660 (+131 carried commits)
probe_optional_conversion: real_home=/home/kaladin/.hermes (never opened by design)
probe_optional_conversion: header_reader=.../read_header.py (raw bytes 18/19 only; no SQLite connection)
probe_optional_conversion: host_native=/proc/1/cgroup=0::/init.scope
...
ASSERT PASS: copy equals original before conversion (sha256 1a119305a0a4fc10af8f81b4555af51f8834feec07c6ba135e4d66a244359b52)
ASSERT PASS: converted_copy_kanban header is 1,1 (mode delete)
ASSERT PASS: original WAL store sha256 is unchanged by conversion of the copy
ASSERT PASS: delete_run_1_kanban header is 1,1 (mode delete)
ASSERT PASS: delete_run_2_kanban header is 1,1 (mode delete)
ASSERT PASS: wal_control_run_kanban header is 2,2 (mode wal)
ASSERT PASS: copy equals original before conversion (sha256 e710b33f6a2ea7b406f778192b38a2c78bb03ff1d146494a1782e525e67e3f80)
ASSERT PASS: converted_copy_projects header is 1,1 (mode delete)
ASSERT PASS: delete_run_1_projects header is 1,1 (mode delete)
ASSERT PASS: delete_run_2_projects header is 1,1 (mode delete)
ASSERT PASS: wal_control_run_projects header is 2,2 (mode wal)

== optional-store offline-conversion persistence verdict ==
store            header     mode       next_writers result
kanban.db        1,1        delete     2            kept rollback
projects.db      1,1        delete     2            kept rollback
both WAL controls 2,2        wal        1            config-driven

KANBAN.DB VERDICT: HONOURING
PROJECTS.DB VERDICT: HONOURING
RESULT: PASS (kanban.db and projects.db conversions persist across two delete-mode trigger runs; WAL controls flip to 2,2)
(exit 0)
```

The complete stdout is saved verbatim at
`docs/gate/evidence/optional-conversion-persistence.txt`. It includes each
store's seed/copy/converted/next-writer/control raw header JSON, sizes, sha256
values, sidecar listings, `cp -a` identity proof, and the full offline
conversion command output. No real operator store was read or written; all
homes are under `/tmp/g1-optional.D9v9Sw`.

### L. Consolidated harness (US-007)

Exact invocation (the default log destination is
`docs/gate/evidence/final-harness.log`; `G1_KEEP_SCRATCH=1` retained the scratch
root for inspection):

```text
$ cd /home/kaladin/.tamandua/worktrees/tamandua-origin-dev16-afd82b30/168-2869e550
$ G1_KEEP_SCRATCH=1 ./docs/gate/probes/run_all.sh
G1 consolidated harness
harness=.../docs/gate/probes/run_all.sh
scratch_root=/tmp/g1-final.UH1CKD
hermes_src=/home/kaladin/hermes-agent
python=Python 3.14.7
hermes=Hermes Agent vgit.d623a66.dirty (2026.9.24) · upstream 8b66a510 · local d623a660 (+131 carried commits)
real_home=/home/kaladin/.hermes (never opened by design; opens are counted below)
host_native=/proc/1/cgroup=0::/init.scope
date_utc=2026-10-22T07:51:45Z
...
STEP RESULT: PASS (01-header-unit-test exited 0)
SAFETY: 01-header-unit-test traced_lines=1742 real_home_open_lines=0
STEP RESULT: PASS (02-config-resolution exited 0)
SAFETY: 02-config-resolution traced_lines=38817 real_home_open_lines=0
STEP RESULT: PASS (03-store-inventory exited 0)
SAFETY: 03-store-inventory traced_lines=63753 real_home_open_lines=0
STEP RESULT: PASS (04-fresh-store-modes exited 0)
SAFETY: 04-fresh-store-modes traced_lines=82092 real_home_open_lines=0
STEP RESULT: PASS (05-state-conversion exited 0)
SAFETY: 05-state-conversion traced_lines=45995 real_home_open_lines=0
STEP RESULT: PASS (06-verification-conversion exited 0)
SAFETY: 06-verification-conversion traced_lines=81612 real_home_open_lines=0
STEP RESULT: PASS (07-optional-conversion exited 0)
SAFETY: 07-optional-conversion traced_lines=104906 real_home_open_lines=0

===== safety summary =====
SAFETY SUMMARY: steps=7 straced_steps=7
SAFETY SUMMARY: raw_strace_real_home_open_lines=0
SAFETY SUMMARY: evidence_text_files=14 saved_log_real_home_open_lines=0
SAFETY RESULT: PASS — no open of any path under /home/kaladin/.hermes in the harness strace or saved logs

RESULT: PASS (all G1 probes and assertions passed; no real-home opens)
(exit 0)
```

The complete log is saved verbatim at
`docs/gate/evidence/final-harness.log`. The harness runs the raw-header unit test
and all six probe scripts, tees every step's output to that log, and exits
nonzero if any step exits nonzero or prints `ASSERT FAIL`, or if the safety scan
finds a real-home open.

**No real-home access, proved from the harness log and all saved logs:**

```text
$ grep -Ec 'open(at)?\(.*"/home/kaladin/\.hermes' docs/gate/evidence/final-harness.log
0
$ grep -Ec 'open(at)?\(.*"/home/kaladin/\.hermes' docs/gate/evidence/*.txt docs/gate/evidence/*.log
docs/gate/evidence/config-resolution-strace.txt:0
docs/gate/evidence/config-resolution.txt:0
docs/gate/evidence/conversion-persistence.txt:0
docs/gate/evidence/fresh-store-modes-strace.txt:0
docs/gate/evidence/fresh-store-modes.txt:0
docs/gate/evidence/optional-conversion-persistence.txt:0
docs/gate/evidence/store-inventory.txt:0
docs/gate/evidence/store-open-doctor.txt:0
docs/gate/evidence/store-open-kanban.txt:0
docs/gate/evidence/store-open-project.txt:0
docs/gate/evidence/store-open-sessions.txt:0
docs/gate/evidence/store-open-state-sessiondb.txt:0
docs/gate/evidence/verification-conversion-persistence.txt:0
docs/gate/evidence/final-harness.log:0
```

A textual mention such as `real_home=/home/kaladin/.hermes (never opened by
design)` is a safety note, not an `open` syscall, and is not counted. The
`strace` raw files stayed in the disposable scratch root; only the per-step
counts are committed in the log. All probe homes are under
`/tmp/g1-final.UH1CKD` (or the per-story scratch roots recorded above); the
real operator home was never opened, read, copied from, or written.
