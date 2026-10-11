# Matchlock interactive acceptance suite (MTLK-INTERACTIVE-SUITE)

Suite home for the in-repo, owned, repeatable real-VM acceptance gate for the four
foreground interactive Matchlock commands — `tamandua matchlock pi`, `pi-shell`,
`hermes`, `hermes-shell` — plus the swap surface and the scheduled spot-run.

This directory is the membership index for the suite. Every script that belongs to
the suite is listed exactly once in the membership table below. It is the in-repo
home for the ported M0–M7 semantics; it does **not** move or replace the existing
root-level `run-matchlock-*-e2e-test` runners (that is the separate
tamandua-79t SCRIPTS-REORG direction).

> **SLOW REAL-VM GATE — DO NOT RUN BY DEFAULT**
>
> Everything here is **on demand**. Nothing in this directory is included in
> `npm test` or any fast lane. The VM tiers (`t2`, `t3`, `t4`) boot real VMs on the
> shared vaimetal host and run under the shared gate lock
> (`flock --exclusive /home/kaladin/matchlock-work/vaivm-gate.lock`); the
> developer-agent sandbox (`NoNewPrivs: 1`, `CapEff: 0`) cannot boot a VM, so real
> tiers must be run by the operator outside that sandbox. Only `t1` (fixtures and
> the PTY driver self-test) is safe to run anywhere and touches no VM and no model.

The gate lock requires `flock(1)` (util-linux). macOS does not ship it — install it
once with `brew install flock`. Without the tool the lock fails closed
(`MTLK-GATE-LOCK-FAIL flock-missing`, exit 6) and never proceeds unlocked.

## One-command entrypoint

The single documented entrypoint is
`scripts/tests/matchlock/run-interactive-suite.sh`. Everything below is **on
demand**: nothing in this directory runs in `npm test` or any fast lane. Run it
from the repository root.

**T1 — fixtures + frozen PTY driver self-test (no VM, no model, no gate lock, no
digest). Safe to run anywhere, including inside the developer-agent sandbox:**

```bash
bash scripts/tests/matchlock/run-interactive-suite.sh --tier t1 --mode installed
```

**T2 — real-VM mechanics M0–M4 against the installed baseline (operator, outside
the developer-agent sandbox). The entrypoint acquires the shared gate lock itself,
exactly once — do NOT wrap this call in another `flock`:**

```bash
bash scripts/tests/matchlock/run-interactive-suite.sh \
  --tier t2 --mode installed \
  --expect-digest sha256:<digest-read-from-the-local-matchlock-store>
```

**T3 — live-model TUI turns M5/M6 (TOKEN-SPENDING, env-gated). Runs only when
`MTLK_T3_ENABLED` is truthy AND one of the credential variables in
`MTLK_T3_CREDENTIAL_ENV` (`MTLK_MODEL_API_KEY`, `TAMANDUA_MODEL_API_KEY`,
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) is exported; otherwise the tier is recorded
`NOTRUN` with a reason and is never a pass:**

```bash
MTLK_T3_ENABLED=1 OPENAI_API_KEY=... \
bash scripts/tests/matchlock/run-interactive-suite.sh \
  --tier t3 --mode installed --expect-digest sha256:<digest>
```

**T4 — bounded scheduled M7 spot-run (TOKEN-SPENDING, opt-in):**

```bash
bash scripts/tests/matchlock/run-interactive-suite.sh \
  --tier t4 --mode installed --expect-digest sha256:<digest>
```

Tiers compose (`--tier` is repeatable) and `--mode candidate` (the default) builds
this worktree and executes its `dist/cli/cli.js` instead of the installed binary:

```bash
bash scripts/tests/matchlock/run-interactive-suite.sh \
  --tier t2 --tier t3 --mode candidate --expect-digest sha256:<digest>
```

Flags:

- `--tier t1|t2|t3|t4` — repeatable; exactly the requested tiers execute. A tier
  that was not requested is recorded `UNEXECUTED` (never `passed`).
- `--mode candidate|installed` — `candidate` (default) builds this worktree and
  executes its `dist/cli/cli.js`; `installed` executes the `tamandua` resolved from
  `PATH` and never rebuilds it.
- `--expect-digest <sha256:...>` — **required for any VM tier** (`t2`/`t3`/`t4`);
  the image digest is a runner input read from the local matchlock image store,
  never a hardcoded constant. It is optional for a T1-only run (no VM, no image
  store).
- `--evidence-dir DIR` — optional; otherwise a fresh `mktemp -d` evidence directory
  is created per run and never reused.

The entrypoint records the REQUESTED scope before execution, seeds a private image
store and private `HOME`/`TMPDIR`/`TAMANDUA_STATE_DIR` for VM tiers, acquires the
shared gate lock exactly once around the VM execution it launches directly, runs the
shared `scripts/observed-rounds-guard.mjs` after a real-VM tier (zero-round PASS =
exit 92), and propagates the component exit codes. A T1-only request takes no lock
and boots no VM; an unavailable host capability refuses with exit 3 and
`MTLK-CAPABILITY-UNAVAILABLE` (never a fake pass).

### Tier / model / token disclosure

| Tier | Real VM | Model tokens | Gate lock | Credentials |
| --- | --- | --- | --- | --- |
| `t1` | no | none | no | none |
| `t2` | yes (M0–M4) | none | yes (acquired by the entrypoint, once) | none |
| `t3` | yes (M5/M6) | **yes** — billed to the operator; `TOKEN-SPEND-DISCLOSURE tier=t3 endpoint=…` is recorded; absent credentials ⇒ declared `NOTRUN` | yes | `MTLK_T3_ENABLED=1` plus a credential from `MTLK_T3_CREDENTIAL_ENV` |
| `t4` | yes (M7 spot-run) | **yes** — the spot-run's model rounds are billed to the operator | yes | model credentials for the in-guest workflow |

The model endpoint is `MTLK_MODEL_ENDPOINT` (default `ai.iasylum.net:8888`) and is
reachable from the guest only when the configured `MTLK_ALLOW_PRIVATE` spellings
are passed to `--matchlock-allow-private`.

## Tiers

| Tier | Scope | VM | Model tokens |
| --- | --- | --- | --- |
| `t1` | Fixture controls + frozen PTY driver self-test (`pty-selftest.sh`, `fixtures-test.sh`, `fixtures-validator.sh`) | no | none |
| `t2` | Real-VM mechanics M0–M4 (boot, banner, image provenance/identity, guest identity, mount write-through, swap variants, PTY resize, exit-code propagation, disconnect) | yes | none |
| `t3` | Live-model TUI turns M5/M6 (pi + hermes); env-gated on credentials | yes | yes (disclosed) |
| `t4` | Scheduled `tamandua workflow run --matchlock` spot-run M7; opt-in and bounded | yes | yes (disclosed) |

## T2 mechanics cases (`cases/M0`–`M4`)

`cases/M0.json` … `cases/M4.json` are the configuration-bound T2 mechanics cases
(boot, banner, image provenance/identity, guest identity, exact-destination mount
write-through, swap variants, PTY resize, exit-code propagation, disconnect). They
are a faithful port of the ACCEPTED W2 `vaimetal` case JSONs; every `require`,
`forbid`, `wait_for` pattern, swap spelling, exit code and resize is preserved
exactly. Host bindings are `{{MTLK_*}}` placeholders rendered per run by
`lib/common.sh` (`mtlk_render_case`) into a private `case.rendered.json` — the
source case is never modified. The bound placeholders are:

- `{{MTLK_TAMANDUA_ARGV0}}` — the resolved tamandua executable token (INSTALLED
  `tamandua`; CANDIDATE the built `<repo>/dist/cli/cli.js`, which the build marks
  executable and which carries a node shebang because the PTY driver execs
  `argv[0]` directly).
- `{{MTLK_CWD}}` — the working directory the CLI is launched from.
- `{{MTLK_WORKDIR}}` — the harness workdir (also the mount write-through
  destination).
- `{{MTLK_ALLOW_PRIVATE}}` — the `--matchlock-allow-private` spelling, also used
  for the in-guest egress URL.
- `{{MTLK_MODEL_HOST}}` — the bare model-endpoint host for the DNS diagnostic.
- `{{MTLK_EXPECT_DIGEST}}` — the image digest read from the local store (a runner
  input, never a literal).
- `{{MTLK_UID}}` / `{{MTLK_GID}}` — the guest identity the harness propagates.

The historical per-case `env` block is intentionally dropped: the runner owns the
environment so the private per-run `HOME`/`TMPDIR`/`TAMANDUA_STATE_DIR`/`PATH` is
never clobbered. No backend name appears in any assertion.

## T3 live-model cases (`cases/M5`–`M6`)

`cases/M5.json` (pi) and `cases/M6.json` (hermes) are the T3 TUI model-turn
cases. They use the same `{{MTLK_*}}` bindings as T2 and preserve the accepted
W2 semantics exactly:

- M5 waits for the `(auto)` mode indicator, sends the prompt as **one burst plus
  a single CR**, and requires `ZX\s*-\s*333`.
- M6 settles the optional telemetry-consent screen with Enter (deterministic when
  absent), waits for the prompt character U+276F, and uses a **split send** (text,
  a ~2.5s pause, then CR as a separate write) before requiring `ZX\s*-\s*333`.
- Both declare `any_exit: true` and the shared forbid list (`panicked`,
  `Unhandled [Ee]rror`); neither names a backend or a host literal.

T3 is **env-gated**: it runs only when `MTLK_T3_ENABLED` is truthy **and** one of
the configured credential variables (`MTLK_T3_CREDENTIAL_ENV`) is set in the
environment. `lib/common.sh`'s `mtlk_t3_gate` records a declared
`verdict=NOTRUN` with a reason (`t3-disabled:…` / `t3-credentials-absent:…`)
when either is missing — absent credentials is **never** a pass. When T3 does
execute, `mtlk_t3_disclosure` records an explicit
`TOKEN-SPEND-DISCLOSURE tier=t3 …` line naming the endpoint (token spend is
billed to the operator's credentials). The model endpoint comes from
`MTLK_MODEL_ENDPOINT` and is passed via `--matchlock-allow-private` in the
configured `{{MTLK_ALLOW_PRIVATE}}` spelling.

## T4 scheduled spot-run (`runner/m7-spot-run.sh`)

`runner/m7-spot-run.sh <evidence-dir> [repo]` is the T4 M7 isolated scheduled
`tamandua workflow run do-now --matchlock` spot-run. It is a faithful port of the
ACCEPTED W2 toolset `tools/m7-spot-run.sh` and the frozen
`templates/m7-spot-run-v2.sh`, rebound through `lib/common.sh` (mode, matchlock
pair, `MTLK_EXPECT_DIGEST`, allow-private spellings, scratch state/work/ports,
repo argument).

- **Isolated daemon**: private `TAMANDUA_STATE_DIR`/DB and control/dashboard/MCP
  ports; the live daemon is never touched. The stop is ownership-verified (the
  pidfile PID must be alive AND verifiably this attempt's).
- **Protected predicates**: run completion, `spot.txt == 'spot-ok'`, the run's own
  diag `resolvedImageDigest == expected`, strict BEFORE/AFTER inventory snapshots,
  and a non-empty attempt-owned set.
- **BOUND verdict**: the result is written to `$B/m7.verdict`; the absolute path
  of that invocation's file is recorded in `<evidence-dir>/M7/m7-verdict-path.txt`
  and the final gate reads that file (`PASS log=… verdict-file=…` appended to
  `<evidence-dir>/M7/m7.log`). A stray `M7-PASS` token in captured sub-output can
  never be the gate.
- **tamandua-sus fix (ADDITION)**: attempt-owned VMs are enumerated from the
  matchlock VM registry `vms` table (`$(mtlk_matchlock_state_db)`, including
  `status='stopped'` rows), not only from diag-bundle `vmId` strings. Any
  exact-id `matchlock rm` requires ownership evidence — creation inside the
  attempt window AND an exact workdir/config reference (or the run's own diag
  naming the exact id). A failed or unknown removal RETAINS state and fails; an
  unrelated pre-existing VM is never touched.
- **Single-layer gate lock**: acquired through `lib/lock.sh`; when the composed
  runner already holds it (`MTLK_GATE_LOCK_HELD=1`), acquisition is skipped.
- **Cannot be skipped**: an inherited skip switch (`MTLK_M7_SKIP`, `LI155_M7`) is
  ignored and only a notice is recorded; the spot-run still executes.

## Membership

Each row is a script that is part of the suite; the table is the authoritative
membership list. "Harness" is the runtime a script needs; "Real VM" and "Token
spend" describe the scope of what the script itself drives (not what a tier may
compose around it).

| Path | What it pins | Harness | Real VM | Token spend | Evidence location |
| --- | --- | --- | --- | --- | --- |
| `README.md` | The suite index and this explicit membership table | markdown | no | none | n/a (committed) |
| `run-interactive-suite.sh` | The one-command entrypoint: tiers, mode, required digest, fresh evidence dir, private HOME/TMPDIR/state, single-layer gate lock, observed-rounds guard | bash | yes (t2/t3/t4) | t3/t4 only | fresh `mktemp -d` evidence dir (or `--evidence-dir`) |
| `t1-fixtures.sh` | T1 no-VM runner: driver self-test + run-case/hygiene + validator fixture controls, non-zero on any fail | bash + python3 | no | none | `<evidence-dir>/T1/` |
| `lib/common.sh` | Platform bindings, capability probe (fail-closed), CANDIDATE/INSTALLED mode resolution, run identity, T3 credential gate + token-spend disclosure | bash (sourced) | no | none | `<evidence-dir>/identity.txt`, `<evidence-dir>/T3/` |
| `lib/manifest.sh` | The REQUESTED manifest recorded before execution; tier/case status is `UNEXECUTED`/`PASS`/`FAIL` | bash (sourced) | no | none | `<evidence-dir>/manifest/` |
| `lib/image-store.sh` | Private, fully usable per-run matchlock image store seeded from the operator store (hardlinked blobs, independent mutable metadata) | bash (sourced) | no | none | `<evidence-dir>/image-store/` |
| `lib/lock.sh` | The shared gate lock acquired at one layer only (`MTLK_GATE_LOCK_HELD` handshake, no nesting) | bash (sourced) | no | none | `<evidence-dir>/lock.txt` |
| `runner/pty-drive.py` | The frozen PTY driver v5.7 (sha256 `75667065ab885728365e985141345055fae2360d9978163479c4c1ad3f3a382d`); no node port | python3 | yes (t2/t3/t4) | none | `<evidence-dir>/<case>/driver.log` |
| `runner/pty-selftest.sh` | The driver behavioral self-test (fixture processes only) | bash + python3 | no | none | `<evidence-dir>/T1/pty-selftest.log` |
| `runner/run-case.sh` | Per-case wrapper: fail-closed BEFORE/AFTER inventory, case-scoped ownership, exact-destination mount write-through, `case-summary.json` | bash | yes (t2/t3/t4) | none | `<evidence-dir>/<case>/` |
| `runner/run-cases.sh` | Sequential manifest-aware orchestration: pty-selftest first, per-case hygiene, `HALTED` on first failure, `MATRIX-PHASE-DONE` only on full requested success | bash | yes (t2/t3/t4) | none | `<evidence-dir>/matrix/` |
| `runner/hygiene.sh` | Exact-owned-id removal only; reports but never removes unowned ids; retains state on failure | bash | yes (t2/t3/t4) | none | `<evidence-dir>/hygiene/` |
| `runner/m7-spot-run.sh` | T4 scheduled spot-run M7: isolated daemon, ownership-verified stop, bound verdict file, stopped-VM accounting fix (tamandua-sus) | bash | yes (t4) | t4 | `<evidence-dir>/M7/` |
| `fixtures/fixtures-test.sh` | Run-case/hygiene negative controls (inventory fail-closed, mount missing/bad, ownership fake, hygiene leftovers) | bash | no | none | `<evidence-dir>/T1/fixtures-test.log` |
| `fixtures/fixtures-validator.sh` | Tier-aware validator negative controls (missing case, unrequested tier, failed verdict, unowned VM, contradictory markers, identity mismatch, M7 binding, HALTED) | bash | no | none | `<evidence-dir>/T1/fixtures-validator.log` |
| `validator/validate-receipts.sh` | The tier-aware fail-closed receipt validator reading evidence FILES only | bash | no | none | `<evidence-dir>/validation.txt` |

## Conventions

- Follows the existing root-rank gate pattern: a "SLOW REAL-VM GATE — DO NOT RUN BY
  DEFAULT" header, build-first in CANDIDATE mode, fresh `mktemp -d` evidence dirs,
  private `HOME`/`TMPDIR`/`TAMANDUA_STATE_DIR`, component exit-code propagation, and
  `scripts/observed-rounds-guard.mjs` (zero-round PASS = exit 92) after a real-VM
  tier.
- The gate lock is acquired at **one layer only**: if a composed runner already
  holds it, nested acquisition is refused via the `MTLK_GATE_LOCK_HELD` handshake.
- The suite qualifies code; it never publishes or deploys. It never mutates the
  operator's image store, live daemon, or firewall.
