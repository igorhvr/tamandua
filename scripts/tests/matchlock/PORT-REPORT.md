# PORT-REPORT — MTLK-INTERACTIVE-SUITE-IMPL (tamandua-7f4)

Traceability report for the in-repo port of the proven M0–M7 interactive
Matchlock acceptance semantics into `scripts/tests/matchlock/` (beads
`tamandua-7f4`, successor of `tamandua-zb4`). It records what was ported, every
change relative to the frozen reference with its justification, every ADDITION,
what was deliberately **not** ported and why, the requested-vs-observed tier
matrix, the exact commands run, the recorded shas, residual risks and the
README/AGENTS.md additions. The reference materials live read-only at
`/home/kaladin/matchlock-work/mtlk-suites-reference/` and are PORT SOURCE, not a
runnable closure.

This report is the authoritative port record. The acceptance execution for this
host (tier-by-tier run + fixture-level negative controls) is produced by the
acceptance story (US-014) and refreshes §7; the report structure, shas and
per-case status here are committed with US-013.

## 1. Reference materials and shas

The reference directory is never modified. Its shas are the frozen port inputs:

| Reference artifact | sha256 |
| --- | --- |
| `sources/MTLK-INTERACTIVE-SUITE-SOURCES-20261009.tar.gz` (sources tarball) | `8c1101da1ef394ed1d6fd782a17330f5555ec44cd7aa151fa29e46ed35404782` |
| `driver/pty-drive.py` (frozen PTY driver v5.7) | `75667065ab885728365e985141345055fae2360d9978163479c4c1ad3f3a382d` |
| `driver/pty-selftest.sh` (driver self-test) | `2315ed7a50cd94260c427c0c86e3b15e779242f3585493c0bd0a0ea7decd80f8` |
| `toolsets/W2-toolsets-20261009.tar.gz` (accepted INSTALLED toolset) | `c9e93c41aef78f75b7df864858203a4762ad3ef0b4f40079840693c12ed456c8` |
| `toolsets/W1g-toolsets-20261009.tar.gz` (prior generation, provenance only) | `b70e1f8f4c9cf89f4cecd512ca44b3703db6d5d821a0717fb47e2a617ead6ef6` |
| `DESIGN.md` (design document) | `815770833f2306691e73309619c3d08810b3289c9bc6462a69fa9de63616e419` |

The accepted W2 assertion reference is the generated
`matrix-v2-w2/vaimetal/cases/M0.json` … `M6.json` (the executed baseline) plus
`matrix-v2-w2/vaimetal/tools/` and the curated
`templates/m7-spot-run-v2.sh` / `templates/validate-receipts.sh`. The three
required reference shas — sources tarball, driver and self-test — are exactly
the ones above; the W2 toolset sha is the assertion-generation reference. The
frozen driver and self-test were ported byte-for-byte (verified by
`tests/matchlock-interactive-driver-frozen.test.ts`).

## 2. Per-case port status (M0–M7)

All eight cases exist in-repo as configuration-bound JSON (`cases/M0.json` …
`M6.json`) or as the ported M7 runner (`runner/m7-spot-run.sh`). Host bindings
are `{{MTLK_*}}` placeholders rendered per run; no host path, backend name or
64-hex digest literal appears in any case. Status legend: **ported** = assertion
semantics preserved exactly (configuration rebound only).

### M0 — `M0-preflight-egress-tools` (T2)

- Ported: `cases/M0.json`. pi-shell boot; banner (no swap assertion); image
  provenance + identity (exact digest); guest identity (exact uid/gid); in-guest
  preflight tool-presence (`TOOL pi/hermes/zsh/curl/node/bash: /…` for all six)
  and an egress check against the model endpoint; host-mount write-through nonce;
  clean exit 0.
- **Assertion preserved:** the require set `{MNT-[0-9]+-END, EGRESS http=200,
  TOOL pi: /, TOOL hermes: /, TOOL zsh: /, TOOL curl: /, TOOL node: /, TOOL bash: /}`
  plus image provenance/identity, guest identity, exact-destination mount and
  exit 0. "Model-free" does not mean "offline": M0's egress probe still requires
  the model host (`{{MTLK_MODEL_HOST}}`) to answer http=200.

### M1 — `M1-pi-shell-mechanics` (T2)

- Ported: `cases/M1.json`. pi-shell boot; default-swap banner; PTY sizing
  (`stty size` = `24 80`) then a PTY RESIZE to 30×100 verified in-guest
  (`stty size` = `30 100`); in-guest `/proc/swaps` sum in the 8 GiB band;
  exact-destination mount write-through; clean exit 0.
- **Assertion preserved:** banner `swap=8192MB`, `stty size 24 80` then resize
  `[30,100]`, `/proc/swaps` pattern `SWAPCHK-8[0-9]{6}-END`, the mount nonce, and
  `expected_exit_code` 0, with terminal-attribute restoration required for the
  exact-exit case.

### M2 — `M2-hermes-shell-swap4096` (T2)

- Ported: `cases/M2.json`. hermes-shell with `--matchlock-swap 4096`; banner
  `swap=4096MB`; in-guest `/proc/swaps` sum in the 4096 MiB band;
  exact-destination mount write-through; clean exit 0.
- **Assertion preserved:** `--matchlock-swap 4096`, banner `swap=4096MB`,
  `/proc/swaps` pattern `SWAPCHK-4[0-9]{6}-END`, the mount nonce and exit 0.

### M3 — `M3-noswap-exit7` (T2)

- Ported: `cases/M3.json`. pi-shell with `--matchlock-no-swap`; banner
  `swap=off`; empty `/proc/swaps`; exact-destination mount write-through; a
  deliberate nonzero guest exit (`exit 7`) that must propagate as the CLI exit
  code 7.
- **Assertion preserved:** `--matchlock-no-swap`, banner `swap=off`,
  `/proc/swaps` pattern `SWAPCHK-0-END`, the mount nonce,
  `expected_exit_code: 7` and terminal-attribute restoration.

### M4 — `M4-disconnect` (T2)

- Ported: `cases/M4.json`. pi-shell; default-swap banner; provenance/identity;
  guest identity; write-through nonce; then the driver closes the PTY MASTER
  mid-session (`close_master`, no `exit`). The accepted baseline is deliberately
  permissive about the final state.
- **Assertion preserved:** `close_master` disconnect, `any_exit: true`,
  `require_terminal_restored: false`, the mount nonce, and the documented
  permissiveness (not proof of any particular post-disconnect outcome).
  Ownership/cleanup evidence is still required by the wrapper.

### M5 — `M5-pi-TUI-modelturn` (T3)

- Ported: `cases/M5.json`. pi TUI; waits for the mode indicator `(auto)`; sends
  the prompt as ONE burst plus a single CR; requires the GENERATED answer pattern
  `ZX\s*-\s*333`; `any_exit: true`. Live model call (env-gated, token spend
  disclosed).
- **Assertion preserved:** the `(auto)` wait, ONE-burst + CR send, the
  `ZX\s*-\s*333` require, `any_exit: true` and the shared forbid list
  (`panicked`, `Unhandled [Ee]rror`).

### M6 — `M6-hermes-TUI-modelturn` (T3)

- Ported: `cases/M6.json`. hermes TUI; settles the optional telemetry-consent
  screen with Enter (deterministic when absent); waits for the prompt character
  U+276F; SPLIT-SEND convention (text, ~2.5 s pause, CR as a separate write);
  requires `ZX\s*-\s*333`; `any_exit: true`. Live model call (env-gated).
- **Assertion preserved:** the optional consent screen (Enter settles it),
  U+276F prompt codepoint 0x276f, the split-send 2.5 s pause, the
  `ZX\s*-\s*333` require, `any_exit: true` and the shared forbid list.

### M7 — `runner/m7-spot-run.sh` (T4)

- Ported: `runner/m7-spot-run.sh <evidence-dir> [repo]`. Isolated daemon with
  private state/DB and control/dashboard/MCP ports
  (`tamandua workflow run do-now --matchlock`); bounded (~40 min) run; artifact
  `spot.txt == 'spot-ok'`; the run's own diag bundle
  `resolvedImageDigest == expected` (image binding); strict BEFORE/AFTER VM
  inventory; a non-empty attempt-owned set; the BOUND verdict file.
- **Assertion preserved:** run completion, `spot.txt == 'spot-ok'`,
  `resolvedImageDigest == expected`, strict inventory snapshots, positive
  teardown, and the bound verdict file (`<ev>/M7/m7-verdict-path.txt` →
  this invocation's `$B/m7.verdict`, which must literally contain `PASS`, so a
  stray `M7-PASS` token in captured sub-output can never be the gate).

### Harness machinery

The real campaign deliverable — the driver and its self-test — was ported
byte-for-byte (`runner/pty-drive.py`, `runner/pty-selftest.sh`). The per-case
wrapper (`runner/run-case.sh`), hygiene remover (`runner/hygiene.sh`), sequential
driver (`runner/run-cases.sh`), receipt validator
(`validator/validate-receipts.sh`) and their fixture controls
(`fixtures/fixtures-test.sh`, `fixtures/fixtures-validator.sh`) were ported with
configuration rebound through `lib/common.sh`.

## 3. Changes vs the reference (with justification)

Every deviation from the frozen reference is listed here with its
justification. Configuration rebinding is allowed; assertions were not weakened.

| # | Change | Reference | Change made | Justification |
| --- | --- | --- | --- | --- |
| C1 | Config rebinding | Machine-specific literals (host paths, uid/gid, digest, argv, allow-private spellings, endpoint) baked into generated cases/scripts | `{{MTLK_*}}` placeholders rendered per run by `lib/common.sh` (`mtlk_render_case`) into `<outdir>/case.rendered.json`; source case is never modified | The brief requires ONE case set to serve all platforms; the digest is a runner input, never a hardcoded constant; assertions stay byte-identical after rebinding |
| C2 | Corrected VM registry path | A scratch utility used the image-store cache's `state.db` (under `~/.cache/matchlock`) as the VM registry | The VM registry is `<HOME>/.matchlock/state.db` (env-overridable `MTLK_MATCHLOCK_STATE_DB`); the wrong spelling appears nowhere | Known defect called out in the brief/README; the image-store cache is not the VM registry and must not be copied |
| C3 | No node port | Python `pty-drive.py` v5.7 + `pty-selftest.sh` | Kept the frozen Python driver byte-for-byte | The brief freezes the proven driver; no node port. Pinned by `tests/matchlock-interactive-driver-frozen.test.ts` |
| C4 | Backend-agnostic | The historical campaign was executed on one backend | No backend name (firecracker/qemu) appears in any assertion; `MTLK_BACKEND` is configuration exported as `MATCHLOCK_BACKEND`, and timeouts are configurable | The brief requires the same case set to run under the default backend AND `MATCHLOCK_BACKEND=qemu`; a future gate re-runs for parity |
| C5 | Single-layer gate lock | Campaign scripts each acquired the shared lock / left it implicit | `lib/lock.sh` does ONE blocking `flock --exclusive -w 3600` and exports `MTLK_GATE_LOCK_HELD=1`; composed layers SKIP via the handshake | The brief forbids nested acquisition; acquire at exactly one layer |
| C6 | Tier-aware manifest + validator | An all-seven-cases validator assumed every case always ran | `lib/manifest.sh` records the REQUESTED manifest before execution; the validator is tier/manifest-aware and reads evidence FILES only | The brief replaces the all-cases validator with a fail-closed, tier-aware, file-only one; unrequested tier ≠ passed; requested-not-executed = FAIL |
| C7 | Digest as runner input | Generated `EXPECTED-DIGEST.txt` embedded the historical digest | `--expect-digest` is a required input for VM tiers, read from the local matchlock image store; `mtlk_require_digest` refuses without it | The brief makes the image digest a runner input, never a constant |
| C8 | Private image store isolation | Campaign scripts ran against the operator store | `lib/image-store.sh` seeds a private, fully usable per-run store: hardlinked content-addressed blobs + COPIED mutable metadata/`images/local`/`kernels` | Matchlock needs a writable store; the operator store must stay byte-unchanged and mutable files must be genuinely independent |
| C9 | Per-case `env` block dropped | Generated cases carried a host `env` block | The case JSON no longer carries `env`; the runner owns the environment | The runner must keep its private per-run `HOME`/`TMPDIR`/`TAMANDUA_STATE_DIR`/`PATH`; the accepted assertions were proven identical by an inverse-rebind round-trip against the W2 source |
| C10 | Placement | Campaign scripts lived outside the repo | Suite lives under `scripts/tests/matchlock/` with an index README; the existing root runners are untouched | Approved tamandua-79t direction; no new root-level runner; the root runners' own reorg is 79t's future work |
| C11 | Wrapper/Hygiene rebinding | Fixed scratch paths and the wrong registry | `runner/run-case.sh`/`runner/hygiene.sh` rebind workdir, matchlock pair and registry through `lib/common.sh`; VM registry is `$HOME/.matchlock/state.db` | Same as C1/C2; fail-closed BEFORE/AFTER inventory and case-scoped ownership preserved |
| C12 | M7 hardening | Template `m7-spot-run-v2.sh` had the bound verdict file + strict snapshots but the stopped-VM blind spot | Bound verdict binding and strict snapshots kept; stopped-VM accounting added (see A1) | Retain the accepted M7 semantics and close the known tamandua-sus detection gap |
| C13 | Runner paths | Coordinator-owned paths | Scripts resolve `lib/`/`runner/` relative to `SELF_DIR`; all bindings env-overridable | Relocatable, testable, no machine-specific path |
| C14 | Entrypoint | No single documented command | `run-interactive-suite.sh` under the suite dir, with `--tier/--mode/--expect-digest/--evidence-dir` | The brief requires one documented one-command entrypoint, never at the repo root |
| C15 | Private-HOME pi configuration | The reference case `env` block implied the operator's `~/.pi/agent` was present | The entrypoint seeds `$MTLK_OPERATOR_HOME/.pi/agent` into the private HOME (copy when present, otherwise an empty directory); a missing config dir otherwise makes tamandua refuse with `Selected host pi configuration source is not an existing DIRECTORY` BEFORE any matchlock call | US-014 exposed this: the private HOME under requirement #8 must still be a *usable* HOME. Same binding the M7 runner applies when it isolates HOME. Configuration, not an assertion change |
| C16 | Default evidence root | The entrypoint created its evidence dir with `mktemp -d` under the platform temp dir | Default root is `$MTLK_OPERATOR_HOME/.cache/tamandua-mtlk` (`MTLK_EVIDENCE_ROOT` override); `--evidence-dir` still honored | `/tmp` and `/var` are PROTECTED guest OS roots: the harness workdir is a mount source and tamandua refuses a guest destination under them (`Guest mount destination ... shadows a protected guest OS root`). US-014 hit this with the default flow; the new root is short enough for the matchlock vsock `sun_path` budget and outside the protected roots |
| C17 | CANDIDATE `argv[0]` | Candidate bound `node` as the tamandua token | CANDIDATE binds the built `<repo>/dist/cli/cli.js` (executable, node shebang) | The frozen PTY driver `execvpe(argv[0], argv)`s directly, so `node` as `argv[0]` made it run `node matchlock …` and fail `MODULE_NOT_FOUND`; US-014 proved the candidate artifact end-to-end after the fix |
| C18 | M7 repo argument | `run-cases.sh` always passed the worktree repo to M7 | The repo argument is passed only in CANDIDATE mode; INSTALLED runs M7 without it | M7 requires an explicitly passed repo to contain the resolved tamandua realpath; the PATH-installed tamandua is not under the worktree, so T4 aborted `M7-ABORT tamandua-resolve` before the spot-run. US-014 fix |
| C19 | M7 matchlock provenance | `M7-IDENTITY` read an unset `MTLK_MATCHLOCK_SHA` | The sha is computed from the resolved matchlock binary before the identity line | Provenance requirement: the matchlock pair sha must be recorded in the M7 evidence, not left blank |

The per-case inverse-rebind round-trip proved that after rebinding, the only
field differing from the accepted W2 `vaimetal` case is the intentionally
dropped `env` block.

## 4. ADDITIONS

Additions go BEYOND the reference; they are flagged as required by the brief.
Each is labelled `ADDITION` in the sources/README and out-of-scope only if the
brief says so.

- **ADDITION — tamandua-sus stopped-VM accounting fix**: M7 enumerates
  attempt-owned VMs from the matchlock registry `vms` table (including
  `status='stopped'` rows, which the historical diag-only enumeration missed),
  requires creation-window + exact workdir/config ownership evidence before any
  exact-id `matchlock rm`, and RETAINS state + fails on a failed/unknown removal.
  Closes the documented cleanup-detection gap that made the historical M7
  "functional success with a detection gap". Exercised by
  `tests/matchlock-interactive-m7-contract.test.ts`.
- **ADDITION — capability probe (fail-closed)**: `lib/common.sh`'s
  `mtlk_probe_capabilities` checks `python3`/`mktemp`/`curl`, an openable
  `/dev/kvm` (backend-aware), the matchlock pair and `guest-init`, and refuses
  with exit 3 + `MTLK-CAPABILITY-UNAVAILABLE <reason>` — never a fabricated
  pass. A missing digest refuses earlier with `MTLK-ABORT no-expected-digest`.
- **ADDITION — tier-aware validator**: `validator/validate-receipts.sh` is a
  rewrite of the all-seven-cases validator; it validates only the REQUESTED
  scope, reads evidence FILES (never marker words), and fails closed on a missing
  required case, a FAIL verdict, `unowned_new_vms`, contradictory
  `HALTED`/`WAVE-FAILED` markers, an identity mismatch, or an M7 verdict
  binding/file mismatch. Fixture controls in
  `fixtures/fixtures-validator.sh`.
- **ADDITION — requested manifest**: `lib/manifest.sh` records the REQUESTED
  scope BEFORE execution (`manifest/requested.tsv`), is append-only after
  `mtlk_manifest_freeze`, keeps an unrequested tier `UNEXECUTED` (never
  `passed`), and finalizes a still-pending requested row as FAIL (required) or
  NOTRUN (declared optional).
- **ADDITION — model-endpoint configuration**: the endpoint is
  `MTLK_MODEL_ENDPOINT` (default `ai.iasylum.net:8888`) and the
  `--matchlock-allow-private` spelling is `MTLK_ALLOW_PRIVATE`, both
  configuration rather than literals, so the hostname (vaimetal) and reachable
  IPv4 (mac) spellings are one case set.
- **ADDITION — T3 credential gate + token-spend disclosure**: `mtlk_t3_gate`
  records a declared `NOTRUN` (with reason) when `MTLK_T3_ENABLED` or credentials
  are absent and never a pass; when T3 executes, `mtlk_t3_disclosure` records a
  `TOKEN-SPEND-DISCLOSURE tier=t3 endpoint=…` line.
- **ADDITION — private image-store seeding**: `lib/image-store.sh` seeds the
  private store (hardlinked blobs, copied mutable metadata), refuses an empty
  operator store with exit 4 + `MTLK-IMAGE-STORE-FAIL`, and never starts
  matchlock against an unseeded store.
- **ADDITION — single-layer gate-lock handshake**: the `MTLK_GATE_LOCK_HELD`
  handshake in `lib/lock.sh` makes a composed inner layer skip acquisition so a
  VM-booting invocation is guarded at exactly one layer (ownership-scoped
  release).
- **ADDITION — observed-rounds guard wiring**: after a requested real-VM tier
  the entrypoint invokes `scripts/observed-rounds-guard.mjs --gate interactive`
  (zero-round PASS = exit 92) and derives `observed-rounds.json` from real
  case/M7 evidence only.
- **ADDITION — one-command entrypoint**: `run-interactive-suite.sh` (under the
  suite dir) with fresh `mktemp -d` evidence, private
  `HOME`/`TMPDIR`/`TAMANDUA_STATE_DIR`, single-layer lock, and component
  exit-code propagation.
- **ADDITION — T1 no-VM runner**: `t1-fixtures.sh` runs the three fixture-level
  controls (driver self-test, run-case/hygiene, validator) and exits nonzero on
  any fail.
- **ADDITION — port-report test**: `tests/matchlock-interactive-port-report.test.ts`
  pins this report's required headings, reference shas, ADDITIONS and per-case
  assertion-preservation notes so the record cannot silently drift.
- **ADDITION — observed-rounds placeholder-id exclusion**: the entrypoint's
  `observed-rounds.json` derivation ignores matchlock's documented placeholder id
  `vm-00000000` (it appears inside the longest-socket-path pre-flight error text,
  and the frozen driver's vm-id scan can pick it up). US-014 observed a
  no-real-VM run whose only "round" was that placeholder; excluding it keeps the
  no-fake-green guard from treating an error string as a VM. Real registry-backed
  ids (verified against the private registry) are unaffected.
- **ADDITION — US-014 acceptance execution record**: §7 records the requested vs
  observed tier matrix for the executed acceptance run, the exact environment
  blockers per tier, the fixture-level negative controls captured red, and the
  operator's outside-sandbox re-run command. Pinned by
  `tests/matchlock-interactive-acceptance.test.ts`.

## 5. Protected assertions preserved

**No protected assertion was weakened.** The port rebounds configuration
(paths, uid/gid, allow-private spellings, digest, endpoint) and adds
capability/tier gating, but the accepted `require`/`forbid`/`wait_for` patterns,
swap spellings, resize dimensions, exit codes and M7 predicates are preserved
exactly. This is enforced by the per-case contract tests
(`tests/matchlock-interactive-case-contract.test.ts`,
`tests/matchlock-interactive-t3-contract.test.ts`,
`tests/matchlock-interactive-m7-contract.test.ts`) and by the per-case
`Assertion preserved:` notes in §2. Where the brief explicitly required
STRENGTHENING (the tamandua-sus fix in A1) the change is flagged as an ADDITION,
not a silent substitution.

The inverse-rebind round-trip against the accepted W2 `vaimetal` case JSONs
proved the only difference is the intentionally dropped host `env` block; every
protected predicate is byte-identical.

## 6. Not ported (and why)

- **Campaign coordinators** — `w2-run.sh`, `w2-reattach.sh`, `w2-signoff.sh`,
  `w2-cleanup.sh`, `w2-chain2.sh`, `warmplan.py` from the W2 toolset. These are
  campaign orchestration/coordination, explicitly reference-only, never launch
  them. Port scope is the driver / cases / fixtures / receipts set.
- **Machine-specific scratch utilities** — `generator/w2-retarget.py`,
  `generator/matrix-retarget-v2.py` and `fixtures/fixtures-run.sh`. They depend
  on sibling campaign fixtures and the operator image store and are generation
  machinery, not part of the owned suite; the generated cases/tools are the
  port source. The scratch utility that used the wrong VM-registry path
  (the image-store cache's `state.db`) is explicitly not copied.
- **Historical-only case variants** — `cases-src/M5b.json`, `M6b.json`,
  `M6c.json`, `SPK-PI-V1.json`, `SPK-PI-V2.json`, `SPK-HERMES-V1.json`,
  `SPK-HERMES-V2.json`, `SPK-SHELL-V1.json`, `SPK-SHELL-HO.json`. These are
  earlier experimental variants kept for provenance; they are not
  interchangeable with the accepted baseline and are not authoritative for any
  assertion.
- **Root-runners move** — the existing root-level
  `run-matchlock-*-e2e-test` runners are deliberately untouched; relocating them
  is the separate tamandua-79t SCRIPTS-REORG direction, not this port.
- **Product-side changes** — none were required for the suite to function; the
  product is being changed separately in this cycle.

## 7. Requested vs observed tier matrix

Requested scope is recorded BEFORE execution by `lib/manifest.sh`; an
unrequested tier is `UNEXECUTED` and never `passed`. "Observed" below is the
state for this worktree/commit as produced during the port; the acceptance
story (US-014) re-ran and refreshed it. It is never a fabricated success.

### US-014 acceptance execution — 2026-10-11, `vaimetal`, INSTALLED baseline

Executed from this worktree with the one-command entrypoint. The digest is the
runner input read from the local matchlock image store
(`sha256:145fe73e…`, tag `igorhvr/tamandua`). The developer-agent sandbox has
`NoNewPrivs: 1` / `CapEff: 0`, so every VM-booting case reaches the real
matchlock create and fails closed on the TAP-device syscall; no pass is faked.
Acceptance root: `/home/kaladin/matchlock-work/mtlk-acceptance-4c42e8cc`.

| Tier | Requested | Required? | Observed result | Evidence dir / decisive line |
| --- | --- | --- | --- | --- |
| `t1` | yes | required (fast lane) | **PASS** (exit 0) | `<accept>/t1-final`: `PTY-SELFTEST-SUMMARY pass=56 fail=0`, `RUN-CASE FIXTURES RESULT: pass=41 fail=0`, `VALIDATOR FIXTURES RESULT: pass=45 fail=0`, `T1 FIXTURES RESULT: pass=142 fail=0` |
| `t2` (installed) | yes | required for acceptance | **NOT-RUN / ENVIRONMENT** (exit 1) | `<accept>/t2` and `/home/kaladin/.cache/tamandua-mtlk/mtlk.MEGCrK`: `Error: Interactive session failed: create VM: create TAP device: TUNSETIFF: operation not permitted`; the M0 summary records an owned stopped VM row whose exact-id removal then fails `reconcile nftables rule: netlink receive: operation not permitted` |
| `t2` (candidate) | yes (binding proof) | n/a | **NOT-RUN / ENVIRONMENT** (exit 1) | `/home/kaladin/.cache/tamandua-mtlk/mtlk.v9O2YJ`: the same TUNSETIFF line; `identity.txt` binds `dist/cli/cli.js` (`build_provenance=mode=candidate … dist_sha256=…`) |
| `t3` | yes (declared) | env-gated; optional when credentials absent | **NOT-RUN (declared)** (exit 0) | `/home/kaladin/.cache/tamandua-mtlk/mtlk.MMCBKm`: `T3-NOTRUN t3-disabled:MTLK_T3_ENABLED-not-set`; the manifest keeps `t3 NOTRUN` |
| `t4` (installed) | opt-in | optional | **NOT-RUN / ENVIRONMENT** (exit 1) | `/home/kaladin/.cache/tamandua-mtlk/mtlk.hmrDT4`: M7 reached the real run and recorded `STDERR_TAIL: … create TAP device: TUNSETIFF: operation not permitted`; stopped-VM accounting found `owned=1 present_owned=1 unowned_new=0`, exact-id removal failed `netlink receive: operation not permitted`, and state was retained (`rm_failed=1`) |

No tier was observed PASS beyond `t1`; `t3` is a declared NOTRUN, never a pass.

Fixes the acceptance execution required to make the suite FUNCTION (recorded as
C15–C19; no assertion was weakened): the private HOME now carries `~/.pi/agent`
(C15); the default evidence root is outside the protected guest roots (C16);
CANDIDATE binds the executable `dist/cli/cli.js` as the case `argv[0]` (C17);
M7 receives the repo argument only in CANDIDATE mode (C18); M7 records the
matchlock sha (C19).

### Fixture-level negative controls (captured red)

The T1 fixture controls assert each refusal, and the raw refusal artifacts are
preserved because `MTLK_RUN_CASE_FIXTURE_DIR` / `MTLK_VALIDATOR_FIXTURE_DIR`
point inside the T1 evidence dir:

| Control | Red artifact (under `<accept>/t1-final`) |
| --- | --- |
| inventory fail-closed | `scratch/run-case/s1.log` → `refused_before_launch: true`, `inventory_before_rc: 1` (driver never invoked); `scratch/run-case/s2.log` → `FAIL-CLOSED inventory-after-invalid`; `s3.log` → malformed header refused |
| mount write-through missing | `scratch/run-case/s4.log` → `mount_write_through: "missing"` |
| mount write-through bad content | `scratch/run-case/s4b.log` → `mount_write_through: "bad-content"` |
| ownership correlation fake | `scratch/run-case/s19.log` → `unowned_new_vms: ["vm-aaaaaaaa"]`, `fail_reasons: ["unowned-new-vm:vm-aaaaaaaa"]` (fake creation window) |
| validator mismatch | `scratch/validator/n1.log` `VALIDATION-FAIL missing-case-summary:M3`; `n2.log` `case-verdict:M2=FAIL`; `n6.log` `identity-digest`; `n7.log` `m7-verdict-file`; `n8.log` `m7-binding-missing` |

All 142 T1 controls pass (`fail=0`); each negative control above is the
corresponding refusal captured while the positive path stays green.

### Operator re-run (outside the developer-agent sandbox)

The entrypoint acquires the shared gate lock itself (single layer), so the
canonical invocation is the bare entrypoint:

```bash
bash scripts/tests/matchlock/run-interactive-suite.sh \
  --tier t2 --tier t3 --tier t4 --mode installed \
  --expect-digest sha256:145fe73eeefadf0a5350febadbab3f9dc2af06335a07d6e36c7f6dbfe036c622
# gate lock: /home/kaladin/matchlock-work/vaivm-gate.lock (held once by the entrypoint)
```

If you compose something that does NOT hold the lock itself, wrap it with ONE
blocking acquisition — never nested:

```bash
flock --exclusive -w 3600 /home/kaladin/matchlock-work/vaivm-gate.lock \
  bash scripts/tests/matchlock/run-interactive-suite.sh --tier t2 --tier t3 --tier t4 \
    --mode installed --expect-digest sha256:145fe73eeefadf0a5350febadbab3f9dc2af06335a07d6e36c7f6dbfe036c622
```

Caveat: `--evidence-dir` is honored verbatim and the private HOME is
`<ev>/home`, so keep that path short enough for the 107-byte AF_UNIX `sun_path`
limit; the default evidence root is sized for this.

## 8. Exact commands run

Reference/digest/identity gathering (read-only):

```bash
# image digest, a runner input read from the local image store (never a constant)
sqlite3 ~/.cache/matchlock/images/metadata.db \
  "select digest from images where scope='registry' and tag='igorhvr/tamandua';"
# -> sha256:145fe73eeefadf0a5350febadbab3f9dc2af06335a07d6e36c7f6dbfe036c622

sha256sum /usr/local/bin/matchlock /usr/local/bin/guest-init
sha256sum "$(command -v tamandua)"
/usr/local/bin/matchlock version
sha256sum scripts/tests/matchlock/lib/*.sh scripts/tests/matchlock/runner/* \
  scripts/tests/matchlock/validator/*.sh scripts/tests/matchlock/*.sh \
  scripts/tests/matchlock/fixtures/*.sh scripts/tests/matchlock/cases/M*.json
```

T1 (no VM, no model, safe anywhere):

```bash
bash scripts/tests/matchlock/run-interactive-suite.sh --tier t1 --mode installed
```

Capability probe (why T2/T4 are NOT-RUN in the developer sandbox):

```bash
bash -c '. scripts/tests/matchlock/lib/common.sh; mtlk_resolve_runtime; mtlk_probe_capabilities'
# probe exits 0 here (the sandbox can OPEN /dev/kvm) but the VM create fails
# with TUNSETIFF: operation not permitted (CapEff=0, NoNewPrivs=1)
```

Operator real-VM run (outside the developer-agent sandbox; the entrypoint itself
acquires the shared gate lock exactly once, so nothing wraps it):

```bash
bash scripts/tests/matchlock/run-interactive-suite.sh \
  --tier t2 --tier t3 --tier t4 --mode installed \
  --expect-digest sha256:145fe73eeefadf0a5350febadbab3f9dc2af06335a07d6e36c7f6dbfe036c622
```

US-014 acceptance execution (exact commands; `<accept>` =
`/home/kaladin/matchlock-work/mtlk-acceptance-4c42e8cc`):

```bash
# image digest, a runner input read from the local image store (never a constant)
sqlite3 ~/.cache/matchlock/images/metadata.db \
  "select digest from images where scope='registry' and tag='igorhvr/tamandua';"
# -> sha256:145fe73eeefadf0a5350febadbab3f9dc2af06335a07d6e36c7f6dbfe036c622

# T1 (green) with the fixture scratch preserved so the negative controls stay red
MTLK_RUN_CASE_FIXTURE_DIR=<accept>/t1-final/scratch/run-case \
MTLK_VALIDATOR_FIXTURE_DIR=<accept>/t1-final/scratch/validator \
  bash scripts/tests/matchlock/run-interactive-suite.sh --tier t1 --mode installed \
    --evidence-dir <accept>/t1-final

# T2 INSTALLED attempt (reaches the real matchlock create -> TUNSETIFF EPERM)
bash scripts/tests/matchlock/run-interactive-suite.sh --tier t2 --mode installed \
  --expect-digest sha256:145fe73eeefadf0a5350febadbab3f9dc2af06335a07d6e36c7f6dbfe036c622 \
  --evidence-dir <accept>/t2

# CANDIDATE binding proof (builds the worktree and reaches the same VM-create blocker)
bash scripts/tests/matchlock/run-interactive-suite.sh --tier t2 --mode candidate \
  --expect-digest sha256:145fe73eeefadf0a5350febadbab3f9dc2af06335a07d6e36c7f6dbfe036c622

# T3 declared NOTRUN (no credentials)
bash scripts/tests/matchlock/run-interactive-suite.sh --tier t3 --mode installed \
  --expect-digest sha256:145fe73eeefadf0a5350febadbab3f9dc2af06335a07d6e36c7f6dbfe036c622

# T4 M7 spot-run attempt (bounded)
timeout 1500 bash scripts/tests/matchlock/run-interactive-suite.sh --tier t4 --mode installed \
  --expect-digest sha256:145fe73eeefadf0a5350febadbab3f9dc2af06335a07d6e36c7f6dbfe036c622

# sandbox capability facts behind every NOT-RUN above
grep -E '^(CapEff|NoNewPrivs):' /proc/self/status  # CapEff 0000000000000000, NoNewPrivs 1
```

Tier contract checks (the touched-package tests during development):

```bash
node --test tests/matchlock-interactive-port-report.test.ts \
  tests/matchlock-interactive-acceptance.test.ts
node --test tests/matchlock-interactive-case-contract.test.ts \
  tests/matchlock-interactive-t3-contract.test.ts \
  tests/matchlock-interactive-m7-contract.test.ts \
  tests/matchlock-interactive-driver-frozen.test.ts \
  tests/matchlock-interactive-common-config.test.ts
npm run build
```

Full acceptance goes through the mandated `TEST_CMD` shim (never `npm test`
directly in this workflow).

## 9. Recorded shas

Suite files (in the worktree at this commit):

| Suite file | sha256 |
| --- | --- |
| `lib/common.sh` | `556d5f6e2594a3a8e768af40136b8ffbc6ce7abfd41455fc836ee86658cbaa21` |
| `lib/manifest.sh` | `80bfe072dbccfe1abf9e548aaf8d650deff3bdd69b4d6bcfd51812d0ff50753e` |
| `lib/image-store.sh` | `6be7da8b969fcb87763a54b720391bd1037baeef0dd95074da5ea408eda7a59d` |
| `lib/lock.sh` | `d95c4eeb7ebfd4e9f1058c143bef23feadfcbfb60340a4f56b6b234de8c6499e` |
| `runner/pty-drive.py` | `75667065ab885728365e985141345055fae2360d9978163479c4c1ad3f3a382d` |
| `runner/pty-selftest.sh` | `2315ed7a50cd94260c427c0c86e3b15e779242f3585493c0bd0a0ea7decd80f8` |
| `runner/run-case.sh` | `d2942ddfa8255b0c97b7a32b1fdda75cc9a5f6492549fee77fe81a6e42de400f` |
| `runner/run-cases.sh` | `e4ab774acd52033c2bf12a58751a2205e2845add7364d395224c35cbf95c35f3` |
| `runner/hygiene.sh` | `92ec96cf10f7cda5390f96eec431bc4a403857d63daec7bdda6543d462260f95` |
| `runner/m7-spot-run.sh` | `a995fbdfbe3d0a04da19d429bc1bb0bd89fa66e9118a18708109db159ea0428d` |
| `validator/validate-receipts.sh` | `9de774873cce815f4f6a748e8861a6e53f65ae9628c9627f275dec34b8a2ccc6` |
| `run-interactive-suite.sh` | `306522727f4617134ec26d8f5e278696d1a512d2a915bdc68ebfba8e08a5afe3` |
| `t1-fixtures.sh` | `b84d9b82ee405e98068e533300c7ef9346e9f0c7512134337b03c242706bcd49` |
| `fixtures/fixtures-test.sh` | `f3ee27b0b52599e81887fee950b16610b5c54ccb8ca38a99b2b7a117b742d6f2` |
| `fixtures/fixtures-validator.sh` | `2f28bcb026ecc71f40da006733cc89e0ed9b904885129e4d383516fd9184ae3b` |
| `cases/M0.json` | `10ee54f5196b4f85ced1a9fe46d41e4e41e496560efedfb0736153cf9b74724d` |
| `cases/M1.json` | `6e690fd953b6917d43999fb0afa3cf5d640c48ec082b004f1449d279a492eabc` |
| `cases/M2.json` | `c20b265ca8d4f0606382186e8838918e4fe4ee18b9d58655036ce3dba19401cc` |
| `cases/M3.json` | `99e7dd692f5faefd0bd93e0cb6115cdea66b9c2d03669caf7f1d4cef532818d0` |
| `cases/M4.json` | `8c8f82ccdb04f9a3969ff6e66e7ecee48b40239e50740eb416022e234fe74321` |
| `cases/M5.json` | `c2b3d85fbf8a6b0943a56bc22f47ee3d15679ec445fe8db2145c106c4deded9c` |
| `cases/M6.json` | `a1b98d73dcb933201b495f8179d71d761ddad22d66335dc9e57302daf6996862` |

Host binaries (do NOT replace or reinstall; the matchlock pair is at
`/usr/local/bin/`, `tamandua` from PATH):

| Binary | sha256 |
| --- | --- |
| `tamandua` (PATH) | `aca99c3c9e10b3942933a96cdb1a3ba4febf428f1bf0dc89c7eb7c083d3d0456` |
| `/usr/local/bin/matchlock` | `94ae192cc669412ea0d24b4da5370224bc2f4d05d1b35948964833b96c5d7083` |
| `/usr/local/bin/guest-init` | `07826705e0abf015ac20ee38aff23dde794eb48a518a9e9be4f7e33d518ea72d` |
| `matchlock version` | `matchlock 0.2.17 (commit: 2afbca3, built: Thu Oct 08 10:57:41 UTC 2026)` |

Image digest (read from the local matchlock image store; the seed image is
`igorhvr/tamandua`):

| Input | Value |
| --- | --- |
| Standard image digest | `sha256:145fe73eeefadf0a5350febadbab3f9dc2af06335a07d6e36c7f6dbfe036c622` |
| Image store | `~/.cache/matchlock` (HOME-derived; seeded private per run) |
| VM registry | `~/.matchlock/state.db` (never the image-store cache's `state.db` under `~/.cache/matchlock`) |

Environment: Linux `vaimetal` x86_64, Node `v24.21.0`.

## 10. Residual risks

- **Developer-sandbox VM blocker**: real VM creates fail here
  (`NoNewPrivs: 1`, `CapEff: 0`); T2/T4 are operator-run. This is an
  environment limit, not a suite defect.
- **Model-endpoint availability**: T3 and the T2 in-guest egress probe depend on
  `ai.iasylum.net:8888`. An endpoint outage is recorded NOT-RUN with the exact
  DNS-vs-TCP-vs-service distinction; it is never a pass or a product defect.
- **Backend parity**: the suite is designed to run under `MATCHLOCK_BACKEND=qemu`,
  but this port's live execution is on the default backend; parity is a future
  gate.
- **Token spend**: T3/M7 spend real model tokens billed to the operator;
  disclosure lines are recorded and the tiers stay opt-in/env-gated.
- **Image-store seeding cost**: the private store hardlinks blobs but copies the
  mutable metadata and `kernels/`; a very large operator store still needs disk
  headroom.
- **M4 permissiveness**: the accepted disconnect case deliberately accepts any
  exit and does not require terminal restoration — it is not proof of a specific
  post-disconnect outcome.
- **Stopped-VM accounting scope**: the tamandua-sus fix enumerates the matchlock
  registry `vms` table including `status='stopped'`; it covers VMs registered by
  matchlock, not arbitrary processes.
- **Shared gate lock**: the lock is shared with other agents/workflows on the
  host; runs may wait up to the configured timeout.
- **Frozen reference drift**: the reference directory is read-only; this report
  pins its shas so any drift is detectable.
- **Long `--evidence-dir` shortens the sun_path budget**: the private HOME is
  `<ev>/home`, and matchlock's longest socket path adds 43 bytes; an
  `--evidence-dir` longer than ~64 bytes overflows the 107-byte AF_UNIX limit and
  tamandua refuses with `matchlock cannot create a VM with HOME …`. The default
  root (C16) is sized for this; use a short path when overriding.
- **Protected guest roots**: `/tmp`, `/var`, `/usr`, … are protected guest OS
  roots; the harness workdir (a mount source) must not live under them. The
  default evidence root (C16) is outside them; an `--evidence-dir` under `/tmp`
  fails with `Guest mount destination … shadows a protected guest OS root`.
- **Private-HOME pi configuration**: the private HOME receives a COPY of the
  operator `~/.pi/agent` (when present). That directory may contain model
  credentials (`auth.json`); the copy lives under the per-run evidence dir and is
  subject to the same trust boundary as the M7 isolate-HOME path.
- **VM-row removal in the sandbox**: exact-id `matchlock rm` fails here
  (`reconcile nftables rule: netlink receive: operation not permitted`), so the
  attempt-owned stopped row is RETAINED and the run fails closed. This is the
  documented retain-on-failure behavior, not a leaked VM; the row is in the
  private registry (`<ev>/home/.matchlock/state.db`), never the operator's.
- **Placeholder-id hardening**: the observed-rounds derivation excludes
  `vm-00000000` (matchlock's longest-socket-path placeholder). A real registry
  id that happened to hash to that value is not expected, but the exclusion is a
  sentinel match, not a registry lookup.

## 11. README / AGENTS.md additions

- `scripts/tests/matchlock/README.md` (new): the suite index with the explicit
  membership table (bidirectional: every suite script has exactly one row and
  every row names an existing file), the "SLOW REAL-VM GATE — DO NOT RUN BY
  DEFAULT" header, the one-command entrypoint with the exact T1–T4 invocations
  and both modes, the tier/model/token disclosure table, the T2/T3 case
  placeholder documentation and the T4 M7 semantics.
- `README.md` (US-012): the `###### Interactive sessions` H6 now documents the
  in-repo on-demand real-VM acceptance suite
  (`scripts/tests/matchlock/run-interactive-suite.sh`), its `--tier t1|t2|t3|t4`
  and `--mode candidate|installed` flags, the T1–T4 scope and the operator-run
  procedure, and no longer claims real-VM PTY qualification is deferred. The
  pinned H5/H6 structure is preserved.
- `AGENTS.md` (US-001 + US-012): a "Matchlock interactive acceptance suite
  (MTLK-INTERACTIVE-SUITE)" pointer to the suite README with the exact
  entrypoint invocations, the tier definitions and modes, the digest-as-input
  rule, the shared-gate-lock rule and the sandbox limitation. The example
  invocation was corrected so T1 needs no digest and VM tiers are
  operator-run with `--expect-digest`.
- `skills/tamandua-agents/SKILL.md`: the interactive status points at the
  on-demand in-repo suite instead of calling real-VM qualification deferred.

## 12. Sign-off

- Reference shas cited: sources tarball, driver, selftest and W2 toolset — §1.
- Per-case port status M0–M7 with an `Assertion preserved:` note each — §2.
- Every change vs the reference with justification — §3.
- Every ADDITION flagged — §4.
- Explicit confirmation that no protected assertion was weakened — §5.
- What was not ported and why — §6.
- Requested vs observed tier matrix — §7.
- Exact commands run — §8.
- Recorded shas (suite, tamandua, matchlock pair, image digest) — §9.
- Residual risks — §10.
- README/AGENTS.md additions — §11.

## 13. US-015 final quality gate

The final story is the quality/version-control wrap; it adds no new suite
behavior and weakens no assertion. The sweep executed before landing:

- `npm test` (build + syntax gate + serial lane + parallel lane) exits 0 on the
  landed tree: serial lane 5601 tests / 5587 pass / 0 fail / 14 skipped;
  parallel lane 5096 tests / 5091 pass / 0 fail / 5 skipped. The run's mandated
  `tamandua-test` wrapper refuses a dirty tree (`FAILURE_CLASS: tree_dirty`) and
  replays only a recorded green result for the exact tree.
- `npx tsx scripts/syntax-check-tests.ts` parses 484 test files cleanly.
- `npm run build` (`tsc -p tsconfig.json` + native build) exits 0.
- Hygiene sweep: no reference-host path, no scratch campaign path and no
  wrong-registry literal appears anywhere under `scripts/tests/matchlock/`; the
  corrected VM registry binding is `~/.matchlock/state.db` (§3 C15).
- Placement: no root-level `run-*interactive*` runner was added; the suite
  entrypoint lives under `scripts/tests/matchlock/`, and the suite README
  membership table stays bidirectional.
- Lane classification: every new spawn-capable interactive test is registered
  exactly once (in ascending order) in `tests/serial-files.txt`; every pure-fs
  interactive test is absent. `tests/serial-classification-guard.test.ts` and
  `tests/matchlock-gate-observation-wiring.test.ts` both pass, and the sweep is
  pinned by `tests/matchlock-interactive-final-gate.test.ts` (pure-fs, parallel
  lane).
- Version control: all story work is committed on the provisioned
  `feature/mtlk-interactive-suite-impl` HEAD with a clean working tree; no
  ref-moving command (`worktree`/`checkout`/`switch`/`reset`/`branch -f`) and no
  push, merge or finalize was run.
