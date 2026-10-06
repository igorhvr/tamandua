# INTEGRATION-NOTES.md — MTLK-INTERACTIVE dependency contract

**Status:** FROZEN dependency contract for the MTLK-INTERACTIVE front-run
(`run-99dead97-9c0a-49c8-9db5-e3601538ba3c`, workflow
`feature-dev-merge-worktree`). This file is the INTEGRATION-NOTES.md deliverable
required by the run brief. It is a **contract document**: it writes no feature
code and maps every interactive-session requirement to either a shipped
slice-1 primitive (`file:line`) or an explicit provisional gap with the exact
minimal interim behavior and reconciliation instructions.

## 0. Metadata

- **Repository base commit:** `9f167705250e6c4b453ea4e42caaaddae703530d`
  (accepted iso-s1 tip; the single squash for this run is delivered on
  `integration/mtlk-interactive`).
- **Product branch for this run:** `feature/mtlk-interactive-sessions`
  (one squash, replayed onto `integration/mtlk-interactive`).
- **Spec (authoritative):**
  `/home/kaladin/matchlock-work/wave2/specs/matchlock-interactive-harness-proposal.md`
- **Spec sha256:** `753e179ff6891ac94aa83c4d01c426901c025140409108f062314207c2f328fd`
  — matches the entry in
  `/home/kaladin/matchlock-work/wave2/specs/manifest.sha256` (verified this run).
- **Designation:** synthetic implementation scope only. No requirement in this
  document constitutes real-VM qualification or acceptance.
- **Scope declaration:** this run implements the interactive-session feature in
  **synthetic** scope (fake RPC backend, test-owned capability probes). Real-VM
  PTY qualification with actual pi and Hermes remains deferred to the
  post-integration gate (SPEC-17, GAP-11). Nothing here may be described as
  "equivalent to iso-s2" or as clearing any iso gate.

The spec's sequencing preamble ("Implement this after both
`standard-image-in-matchlock-proposal.md` and
`matchlock-swap-default-proposal.md` are implemented, deployed and qualified")
is a **timing** requirement that Igor explicitly waived on 2026-10-02 for this
front-run. All behavioral and final-qualification requirements remain binding;
the waiver is recorded here so the reconciliation with the corrected iso line
is mechanical.

## 1. Base and shipped slice-1 surfaces

At base `9f167705250e6c4b453ea4e42caaaddae703530d` the shipped Matchlock
surfaces are the slice-1 set. The interactive feature reuses these without
creating a second policy version or a parallel image-selection path.

| Shipped surface | Reference | What it provides |
|---|---|---|
| Standard image + provenance | `src/installer/matchlock/standard-image.ts:15`, `:18`, `:23` | `STANDARD_MATCHLOCK_IMAGE`, `MATCHLOCK_IMAGE_ENV`, `resolveMatchlockImageReference` (explicit > env > standard; never appends `:latest`) |
| Image identity pin/verify | `src/installer/matchlock/image.ts:59`, `:68`, `:96`, `:122`, `:165` | `validateResolvedImageIdentity`, `validatePinnedIdentity`, `verifyImageIdentity`, `resolveImageIdentity`, `resolveImageIdentityWithConfig` |
| Policy v3 | `src/installer/matchlock/policy.ts:79`, `:499`, `:908`, `:1148` | `MATCHLOCK_POLICY_VERSION = 3`, `buildMatchlockPolicy`, validation, parse; v3 fields include `requestedImageSource`, `rootUsageConsent`, `resourceLimits.swapMB` |
| pi config capture | `src/installer/matchlock/policy.ts:422`, `:429` | `resolvePiConfigRoot` (`PI_CODING_AGENT_DIR` or `~/.pi/agent`), `resolvePiConfigProfile` |
| Resource resolution | `src/installer/matchlock/resource-limits.ts:183`, `:226`, `:30-59`, `:337` | `parseSwapMB` (positive only, rejects `0`, cap `65536`), `resolveMatchlockResourceLimits` (flag > env > default; no-swap precedence; `TAMANDUA_MATCHLOCK_SWAP_MB=off`), defaults/env constants, `formatMatchlockResourceSummary` |
| Allow-private parsing | `src/installer/matchlock/allow-private.ts:135`, `:218`, `:238`, `:250` | `validateAllowPrivateEntry`, `normalizeAllowPrivateEntries`, `parseAllowPrivateEnv`, `assertAllowPrivateEntries` |
| Allow-private capability probe | `src/installer/matchlock/allow-private-support.ts:210` | `probeMatchlockAllowPrivateSupport` — bounded `matchlock run --help` pattern the R8 swap probe must mirror |
| Admission | `src/installer/matchlock/admission.ts:716`, `:885`, `:106`, `:135` | `admitMatchlockRun`, `admitHermesMatchlockRun`, `MatchlockAdmissionError`, `MatchlockAdmissionOptions` (including injected probes and `rpcBinaryPath`) |
| pi/dsh config branch | `src/installer/matchlock/admission.ts:754`, `:773-830` | hermetic pi config root existence + mountability checks; dsh frozen-home branch |
| Hermes selection | `src/installer/matchlock/hermes-adapter.ts:194`, `src/installer/matchlock/hermes-profile.ts:286`, `src/installer/matchlock/hermes-config.ts:460` | `resolveHermesAdapterPlan`, `resolveHermesProfile`, `assertLocalTerminalBackend` (non-local backend refuses before any VM) |
| Mount planning | `src/installer/matchlock/mount-plan.ts:581`, `:372`, `:353`, `:362`, `:424`, `:237`, `:291`, `:299`, `:792` | `buildMatchlockCreateConfig`, `placeMount`, broad-source refusal, protected-guest-root refusal, exact-destination normalization, `isBroadHostSource`, `shadowsProtectedGuestRoot`, `workMountToConfig`, `validateWorkMounts` |
| Repository scope | `src/installer/matchlock/repository-scope.ts:93`, `:198`, `:209`, `:233` | `resolveRepositoryScope` (plain checkout, linked worktree, separate-git-dir, bare), `isWithinPath`, `canonicalRealPath`, `admittedRootMatches` |
| Controller | `src/installer/matchlock/controller.ts:224`, `:250`, `:510`, `:615`, `:634`, `:642`, `:678` | `MatchlockController`, constructor (`requireHelperPack` option at `:110`/`:259`), `prepareAndCreate` (re-resolve + verify identity before `create`), `buildCreateParams`, `execStream`, `execPipe`, confirmed `close(timeoutSeconds)` |
| RPC transport | `src/installer/matchlock/rpc-client.ts:717`, `:731`, `:772`, `:780`, `:827`, `:239`, `:147` | `execStream`, `execPipe` (ready-gated stdin, byte-preserving base64, bounded), `cancel`, `cancelInFlightExecRequests`, `close`, frame routing, `EXEC_METHODS` |
| Wire types | `src/installer/matchlock/types.ts:78`, `:113`, `:135` | `MatchlockExecOptions` (command/working_dir/user), `MatchlockMountConfig` (`owner_uid`/`owner_gid` at `:119-120`), `MatchlockCreateParams` |
| Short-HOME alias isolation | `src/installer/matchlock/home-alias.ts:843`, `:992` | owner-aware alias resolution that must coexist with a live daemon |
| CLI conventions | `src/cli/cli.ts:17-64`, `src/cli/shared.ts:103`, `:115` | `get<Thing>Help` import/dispatch, `isTopLevelGroup`, `KNOWN_TOP_LEVEL` |
| Workflow option parsing (reference) | `src/cli/workflow-run-args.ts:56-60`, `:131`, `:154`, `:159`, `:325`, `:335` | existing `--matchlock-*` parsing, root override, swap/no-swap mutual exclusion, dependent-flag discipline |

## 2. Capability verification: exec_tty

Verification was performed against the **installed system runtime** and its
source in the local matchlock fork checkout. Evidence transcript (outside the
product tree):
`/home/kaladin/matchlock-work/wave2/mtlk-interactive-exec-tty-verification-99dead97.md`.

- Installed runtime: `/usr/local/bin/matchlock` →
  `matchlock 0.2.17 (commit: 6cddbd0, built: Wed Sep 23 09:34:18 UTC 2026)`,
  sha256 `a654eaeb0be5f164b6a0f4105ae95f9a90e9264330bc888298fedc450265e954`.
- Fork source for references: repository `/opt/matchlock`; the installed build
  commit `6cddbd0` is present there (`VERSION.txt` = `0.2.17`) and the cited
  line numbers hold at `6cddbd0`. The executed CLI is resolved from `PATH`,
  consistent with the MTLK-UNPIN contract (no runtime hash pins).

Every exec_tty frame — with its runtime source reference and the current
Tamandua client state:

| Frame | Direction | Runtime source reference (matchlock @ 6cddbd0, `/opt/matchlock`) | Current Tamandua client state at base |
|---|---|---|---|
| `exec_tty` request | host → runtime | `pkg/rpc/handler.go:306` (dispatch), `:851` `handleExecTTY`, `:874-890` params `command`/`working_dir`/`user`/`rows`/`cols`, `:924` `ExecInteractive`; sender `pkg/sdk/exec.go:317` | ABSENT — `src/installer/matchlock/rpc-client.ts:147` `EXEC_METHODS` excludes it; no `execTty` API (`:140-146`) |
| `exec_tty.ready` | runtime → host | `pkg/rpc/handler.go:914` `sendRequestNotification`; consumer `pkg/sdk/exec.go:298` | ABSENT — `toFrame` (`rpc-client.ts:239`) routes only `exec_pipe.*`/`exec_stream.*` |
| `exec_tty.stdout` | runtime → host | `pkg/rpc/handler.go:917` `streamWriter`; consumer `pkg/sdk/exec.go:300` | ABSENT — no `exec_tty.stdout` routing/decoder |
| `exec_tty.stdin` | host → runtime | `pkg/rpc/handler.go:312` (dispatch), `:991` `handleExecTTYStdin`; sender `pkg/sdk/exec.go:293` | ABSENT — no sender path |
| `exec_tty.stdin_eof` | host → runtime | `pkg/rpc/handler.go:314` (dispatch), `:1016` `handleExecTTYStdinEOF`; sender `pkg/sdk/exec.go:293` | ABSENT — no sender path |
| `exec_tty.resize` | host → runtime | `pkg/rpc/handler.go:316` (dispatch), `:1035` `handleExecTTYResize`; sender `pkg/sdk/exec.go:400` | ABSENT — no sender path |

Supporting runtime references: interactive VM interface
`pkg/rpc/handler.go:84-85` (`interactiveExecVM.ExecInteractive`); notification
routing `pkg/sdk/protocol.go:255`.

**Verdict:** exec_tty is **present** in the pinned runtime (all six frames), and
**absent** from the Tamandua client at base. This is not the "absent from BOTH"
stop condition, so the run proceeds. The missing client/controller surface is
recorded as provisional gap **GAP-03** (and the session controller as
**GAP-07**). No fake PTY path is introduced.

## 3. Requirement mapping

Dispositions: **SHIPPED** rows name the shipped primitive(s) with `file:line`;
**PROVISIONAL GAP** rows name the gap defined in §4.

| Requirement | Spec ref | Requirement (abridged) | Disposition / reference |
|---|---|---|---|
| SPEC-01 | L3 | Four commands `pi`, `pi-shell`, `hermes`, `hermes-shell`; foreground interactive sessions; dsh excluded | PROVISIONAL GAP GAP-06 |
| SPEC-02 | L5 | Reuse shared image selection, policy v3, resource resolution, capability checks and root-consent semantics; no second policy version; setup stays separate | SHIPPED `src/installer/matchlock/policy.ts:79`, `src/installer/matchlock/standard-image.ts:23`, `src/installer/matchlock/resource-limits.ts:226`, `src/installer/matchlock/allow-private-support.ts:210`; capability-check gap PROVISIONAL GAP GAP-02 |
| SPEC-03 | L16 | Default working directory to invoking cwd; resolve relative args against it; require existing admissible dir; require terminal stdin/stdout before VM create; `--help`/`-h` | PROVISIONAL GAP GAP-06 |
| SPEC-04 | L18 | Full shared option set (`--matchlock-image/-cpus/-memory/-disk/-swap/-no-swap`, repeatable `--matchlock-allow-private`, root override); bare `--matchlock` redundant but value-bearing form rejected; reject unknown options | PROVISIONAL GAP GAP-06; reuse `src/installer/matchlock/resource-limits.ts:226`, `:183`, `src/installer/matchlock/allow-private.ts:135`, `:218`, `src/installer/matchlock/standard-image.ts:23` |
| SPEC-05 | L20 | Image precedence explicit > env > `igorhvr/tamandua`; preserve bare ref; provenance; pin identity and verify before creation; missing standard names `tamandua matchlock setup`; missing explicit requires operator provisioning; no pull/build/install; no host fallback | SHIPPED `src/installer/matchlock/image.ts:122`, `:96`, `src/installer/matchlock/controller.ts:510` (verify before `create`), `src/installer/matchlock/standard-image.ts:23`; remedy wording PROVISIONAL GAP GAP-10 |
| SPEC-06 | L22 | Shared resource parsers/defaults/clamps/env precedence; swap default 8192 MB cap 65536 MB; disable via `--matchlock-no-swap` or env `off`; reject zero sizes and simultaneous swap/no-swap; CLI allow-private replaces env default; interception stays enabled | SHIPPED `src/installer/matchlock/resource-limits.ts:183`, `:226`, `:38`, `:43`; mutual exclusion pattern `src/cli/workflow-run-args.ts:335`; network block `src/installer/matchlock/mount-plan.ts:744` |
| SPEC-07 | L24 | Capture identity/HOME/cwd/config before mutating Matchlock env; reuse harness adapters and mount admission; mount whole effective pi config dir or selected Hermes home/profile RW; set `PI_CODING_AGENT_DIR`/`HERMES_HOME`; missing config / unsupported externals / non-local Hermes backend fail explicitly; never broaden mounts | SHIPPED `src/installer/matchlock/admission.ts:716`, `:885`, `src/installer/matchlock/hermes-adapter.ts:194`, `src/installer/matchlock/hermes-profile.ts:286`, `src/installer/matchlock/hermes-config.ts:460`; interactive create env PROVISIONAL GAP GAP-04 |
| SPEC-08 | L26 | Mount cwd RW at identical absolute path; reuse repo/linked-worktree scope incl. original repository and external Git/common metadata; preserve broad-source/symlink/collision/protected-root refusals; no clone/relocate/rewrite; never implicitly mount host HOME | SHIPPED `src/installer/matchlock/repository-scope.ts:93`, `src/installer/matchlock/mount-plan.ts:589-607`, `:237`, `:291`, `:424` |
| SPEC-09 | L28 | Set every `host_fs` mount `owner_uid`/`owner_gid` to caller numeric ids; exec with `user="<uid>:<gid>"`; ownership fields are guest-visible metadata, not host chown; never recursively chown/chmod host mounts | Fields shipped `src/installer/matchlock/types.ts:119-120`, exec `user` shipped `src/installer/matchlock/types.ts:81`; plumbing PROVISIONAL GAP GAP-08 |
| SPEC-10 | L30 | Root gate before any Matchlock interaction; refuse unless exact override supplied; session-scoped consent with shared warning; overridden root maps UID 0 (no sudo impersonation); never infer `SUDO_UID`; never silent escalation | PROVISIONAL GAP GAP-01 |
| SPEC-11 | L32 | In-guest passwd/group entries, writable guest-local HOME, missing guest parent dirs; no host supplementary privilege groups; preserve image PATH; set admitted config overrides; forward necessary terminal env; harness that cannot run as user fails clearly without install/root retry | PROVISIONAL GAP GAP-05; image PATH primitive `src/installer/matchlock/image.ts:38` |
| SPEC-12 | L34 | Launch image-provided pi/Hermes through `exec_tty` with explicit user/working_dir/dimensions; no workflow flags; RPC client/controller ready-gated input, byte-preserving output, backpressure, EOF, resize, cancellation; forward Ctrl-C; bounded teardown on termination/disconnect; restore host terminal on every catchable exit; no workflow-round deadline | PROVISIONAL GAP GAP-03 (client) and PROVISIONAL GAP GAP-07 (controller); existing discipline `src/installer/matchlock/rpc-client.ts:731`, `src/installer/matchlock/controller.ts:642`, `:678` |
| SPEC-13 | L36 | `-shell` variants identical but `exec_tty` an image-provided zsh; guest prepared exactly as for the harness; inherits image PATH and admitted config env; starts in harness guest working dir; zsh-less image fails explicitly with no substitution/install | PROVISIONAL GAP GAP-07 (shell wiring); shared prep via GAP-04/GAP-05 |
| SPEC-14 | L38 | Fresh VM and foreground session controller per invocation; bounded capability checks at admission and immediately before creation against the executable actually used, including swap even when disabled; short-HOME handling coexists with a live daemon; no scheduler/run rows/broker/ledger/token attribution | SHIPPED `src/installer/matchlock/controller.ts:224`, `:510`, `src/installer/matchlock/home-alias.ts:843`; swap check PROVISIONAL GAP GAP-02 |
| SPEC-15 | L40 | Pre-launch summary (resources, image provenance, pinned digests, guest uid/gid, resolved mount scope; shell variants name harness command); positively confirm closure/removal of only this session's VM then return launched exit status; infrastructure/unconfirmed cleanup non-success naming VM and retained diagnostics; killing RPC child is not proof | SHIPPED `src/installer/matchlock/controller.ts:678` (confirmed close), `src/installer/matchlock/resource-limits.ts:337`; summary/exit-status/UX PROVISIONAL GAP GAP-09 |
| SPEC-16 | L42 | Extend existing `matchlock` CLI group; orchestration under `src/installer/matchlock/`; share parsing/admission/mount planning/lifecycle primitives; do not adapt workflow-shaped single-shot runners | PROVISIONAL GAP GAP-06 (CLI group) and GAP-07 (controller); conventions `src/cli/shared.ts:103`, `:115` |
| SPEC-17 | L44 | Real-VM PTY qualification with actual pi/Hermes (flag/env parity, pinning, RAM/disk/swap, cwd, UID/GID, ownership, Git, persistence, resize, Ctrl-C, disconnect, cleanup, shell parity, zsh-less failure, concurrent sessions, supported architectures) | PROVISIONAL GAP GAP-11 (deferred to the post-integration gate; synthetic protocol tests are explicitly insufficient for final qualification) |
| SPEC-18 | L46 | Writable project/config mounts remain exposed; concurrent VMs do not isolate shared files; isolation is execution isolation, not mounted-data protection | PROVISIONAL GAP GAP-12 (documentation-only deliverable in README, US-015) |

## 4. Provisional gaps and reconciliation

Each gap states the exact minimal interim behavior this run implements and the
reconciliation instruction for replay against the corrected iso line. The
interim behavior is **never** permissive admission, a silent skip, or an
assumed default.

**Implementation status (US-015, complete list).** Each gap carries a `Status`
line naming the story and file that implemented its interim behavior, or marking
it open/deferred. "Implemented (synthetic)" means the interim behavior exists
and is exercised by synthetic tests; it does NOT mean the gap is reconciled
against the corrected iso line (see each `Reconciliation` line) or that the real
launch path is available (see §5).

| Gap | Interim behavior shipped in this run | Status |
|---|---|---|
| GAP-01 | R13 root gate (`src/installer/matchlock/root-gate.ts`) | Implemented (synthetic), US-003 |
| GAP-02 | R8 swap-capability probe (`src/installer/matchlock/swap-support.ts`) | Implemented (synthetic), US-004 |
| GAP-03 | `exec_tty` client/controller API (`src/installer/matchlock/rpc-client.ts`) | Implemented (synthetic), US-009 |
| GAP-04 | Interactive create-config builder (`src/installer/matchlock/mount-plan.ts`) | Implemented (synthetic), US-005 |
| GAP-05 | In-guest preparation planner (`src/installer/matchlock/interactive-guest-prep.ts`) | Implemented (synthetic), US-006 |
| GAP-06 | `matchlock` CLI group + option parser (`src/cli/commands/matchlock.ts`, `src/cli/matchlock-interactive-args.ts`) | Implemented (synthetic), US-002/US-012 |
| GAP-07 | Foreground session controller (`src/installer/matchlock/interactive-session.ts`) | Implemented (synthetic), US-010/US-011 |
| GAP-08 | Numeric `owner_uid`/`owner_gid` + exec `user` plumbing | Implemented (synthetic), US-005/US-009/US-010 |
| GAP-09 | Pre-launch summary / exit status / confirmed-cleanup UX | Implemented (synthetic), US-013 |
| GAP-10 | Provenance-aware missing-image remedy | Implemented (synthetic), US-004 |
| GAP-11 | Real-VM PTY qualification | OPEN — deferred to the post-integration gate |
| GAP-12 | Synthetic-only / security-boundary documentation | Implemented (documentation), US-015 |

### GAP-01 — R13 root-usage gate is not shipped (only the consent field is)

- **Requirement:** SPEC-10 (spec L30); companion standard-image proposal R13.
- **Base reality:** policy v3 carries `rootUsageConsent`
  (`src/installer/matchlock/policy.ts:214`) and admission persists it
  (`src/installer/matchlock/admission.ts:840`), and the CLI parses the override
  (`src/cli/workflow-run-args.ts:131`, `:325`). No code path evaluates the
  submitting process effective uid; there is no `matchlock_root_usage_refused`
  code at base (verified by repo-wide search).
- **Minimal interim behavior:** add `src/installer/matchlock/root-gate.ts` with
  a pure, injectable-euid evaluator and `assertMatchlockRootUsageAllowed`. It
  refuses `euid 0` with the typed code `matchlock_root_usage_refused` naming the
  exact override flag unless that flag was supplied to this invocation; it is
  the FIRST Matchlock-related check (before any probe, image resolve, admission
  or VM create); consent is session-scoped and never inferred from `SUDO_UID`.
- **Status (US-003):** implemented (synthetic) in
  `src/installer/matchlock/root-gate.ts`; the canonical override flag is
  re-exported by the interactive parser so gate and parser cannot drift.
  Reconciled only when the corrected iso line ships its own R13 gate.
- **Reconciliation:** when the corrected iso line ships the R13 gate, delete the
  local `root-gate.ts` implementation and import the shipped gate; keep the
  interactive call site's ordering assertion (root gate before any probe) and
  the typed code so the behavioral contract is unchanged.

### GAP-02 — R8 swap-capability handshake is not shipped

- **Requirement:** SPEC-02/SPEC-14 (spec L5, L38); companion swap proposal R8.
- **Base reality:** swap size parsing/resolution is shipped
  (`src/installer/matchlock/resource-limits.ts:183`, `:226`) but there is no
  `swap-support.ts` probe and no `matchlock_swap_unsupported` refusal at base
  (verified by repo-wide search).
- **Minimal interim behavior:** add a bounded, side-effect-free
  `matchlock run --help` probe modeled on
  `src/installer/matchlock/allow-private-support.ts:210`, run at admission and
  immediately before creation against the binary actually used, for EVERY
  interactive invocation including swap-disabled ones. Failure to confirm
  refuses with `matchlock_swap_unsupported`, naming the resolved binary path and
  the `tamandua matchlock setup` remedy; never permissive, never skipped, never
  an assumed default.
- **Status (US-004):** implemented (synthetic) in
  `src/installer/matchlock/swap-support.ts`; `planInteractiveSession` runs the
  bounded probe for every invocation including swap-disabled ones and refuses
  typed `matchlock_swap_unsupported` on any unconfirmed result.
- **Reconciliation:** replace the local probe with the shipped
  `swap-support.ts` and wire the same two boundaries; the interactive path is
  in-process only (no daemon), so the companion proposal's daemon-side per-round
  check does not apply here and is not simulated.

### GAP-03 — Tamandua RPC client has no `exec_tty` API

- **Requirement:** SPEC-12 (spec L34); see §2 capability table.
- **Base reality:** `src/installer/matchlock/rpc-client.ts:147` excludes
  `exec_tty` from `EXEC_METHODS`; `toFrame` (`:239`) routes only `exec_pipe.*`
  and `exec_stream.*`; no `execTty` method exists.
- **Minimal interim behavior:** add `MatchlockRpcClient.execTty` mirroring the
  `execPipe` readiness discipline (`:731`): send the `exec_tty` request with
  `command`/`working_dir`/`user`/`rows`/`cols`; wait for `exec_tty.ready` before
  accepting stdin; expose `requestId`, `stdin.write`, `stdin.eof`,
  `resize(rows, cols)` and `result`; decode `exec_tty.stdout` base64
  byte-preservingly via the existing decoder; add `exec_tty` to the cancelable
  in-flight exec set; keep finite deadlines so no path can hang.
- **Status (US-009):** implemented (synthetic). `MatchlockRpcClient.execTty`
  sends the exact wire frames and `MatchlockController.execTty` requires an
  admitted VM; `exec_tty` is in the cancelable `EXEC_METHODS` set. A US-014 e2e
  exposed and fixed a ready-frame delivery bug in `rpc-client.ts` (`kind ===
  "ready"` resolved the ready waiters but did not call `pending.notify(frame)`),
  so the foreground controller now opens its stdin gate on the real transport.
- **Reconciliation:** the runtime wire contract is fixed (see §2 references);
  keep method and frame spellings exactly `exec_tty` / `exec_tty.ready` /
  `exec_tty.stdout` / `exec_tty.stdin` / `exec_tty.stdin_eof` /
  `exec_tty.resize` so no translation layer is needed after reconciliation.

### GAP-04 — No interactive create-config builder

- **Requirement:** SPEC-07/SPEC-12 (spec L24, L34).
- **Base reality:** `buildMatchlockCreateConfig`
  (`src/installer/matchlock/mount-plan.ts:581`) is workflow-shaped: it REQUIRES
  `helperPackHostPath`, mounts the RO guest helper pack at
  `MATCHLOCK_GUEST_RUNTIME_ROOT` (`:95`), accepts a progress resource (`:99`),
  and its non-dsh env is always `PI_CODING_AGENT_DIR`
  (`src/installer/matchlock/mount-plan.ts:716`) — it never emits `HERMES_HOME`.
- **Minimal interim behavior:** refactor the shared mount/work/repository/Git
  planning into reusable helpers and add an interactive create-config builder
  that: mounts cwd, the original repository and external Git/common metadata RW
  at identical absolute paths; mounts the whole effective pi config dir or
  Hermes home/profile RW at the approved guest override; emits
  `PI_CODING_AGENT_DIR` for pi and `HERMES_HOME` for hermes; sets every
  `host_fs` mount `owner_uid`/`owner_gid` to the caller numeric ids; omits the
  helper pack and progress resource; and preserves every existing refusal in
  `mount-plan.ts:237`, `:291`, `:353`, `:362`, `:424`.
- **Status (US-005):** implemented (synthetic) as
  `buildInteractiveSessionCreateConfig` in
  `src/installer/matchlock/mount-plan.ts`, sharing the internal
  `placeWorkScopeMounts` / `placeConfigurationMount` / `composeCreateParams`
  helpers with the workflow builder (workflow output stays byte-compatible).
- **Reconciliation:** keep the shared `placeMount`/normalization primitives as
  the single implementation and express the interactive builder as parameters,
  never a second mount planner; when the iso line lands, the workflow builder
  and interactive builder must converge on the same shared helper calls.

### GAP-05 — No in-guest user preparation planner

- **Requirement:** SPEC-11 (spec L32).
- **Base reality:** no module produces uid/gid passwd/group/home/parent-dir
  preparation; existing runners assume the image's configured user/home.
- **Minimal interim behavior:** add a pure (no `child_process`) planner that
  emits an ordered, deterministic list of in-guest commands and environment for
  the selected numeric uid/gid: add passwd/group entries only when absent,
  create a writable guest-local HOME, create missing guest parent dirs. No
  command recursively chowns/chmods a host mount and none targets a host path.
  Missing configuration and unsupported external dependencies are typed
  refusals; an image whose harness cannot run as the selected user fails
  clearly with no install and no root retry.
- **Status (US-006):** implemented (synthetic) in
  `src/installer/matchlock/interactive-guest-prep.ts`; pure/injectable over an
  observed guest-facts report, ownership applied at creation with `install -d`
  only (no `chown`/`chmod`, no recursion), and absent/non-runnable image
  harness or `zsh` facts refuse fail-closed.
- **Reconciliation:** keep the planner pure and data-shaped so it can be
  re-expressed over the shipped guest-preparation machinery; do not add a
  second execution path.

### GAP-06 — No `matchlock` interactive CLI group or option parser

- **Requirement:** SPEC-01/SPEC-03/SPEC-04/SPEC-16 (spec L3, L16, L18, L42).
- **Base reality:** there is no `src/cli/commands/matchlock.ts`; `matchlock` is
  absent from `src/cli/shared.ts:103` and `:115`; the only `--matchlock-*`
  parsing is the workflow-shaped `src/cli/workflow-run-args.ts`.
- **Minimal interim behavior:** add
  `src/cli/matchlock-interactive-args.ts` exporting
  `parseInteractiveSessionArgs` for the four subcommands, which REUSES
  `resolveMatchlockImageReference`, `resolveMatchlockResourceLimits`,
  `parseSwapMB`, `validateAllowPrivateEntry` and
  `normalizeAllowPrivateEntries` rather than reimplementing them; and add
  `src/cli/commands/matchlock.ts` with `getMatchlockHelp` plus the four
  subcommand help functions, wired into `src/cli/cli.ts` and
  `src/cli/shared.ts` following the existing `get<Thing>Help` + dispatch
  conventions. Unknown options, value-bearing `--matchlock`, duplicate
  singletons, swap+no-swap and zero sizes are refused.
- **Status (US-002/US-012):** implemented (synthetic).
  `src/cli/matchlock-interactive-args.ts` reuses the shipped resolver/validator
  primitives, and `src/cli/commands/matchlock.ts` provides
  `getMatchlockHelp` plus the four subcommand help renderers, wired into
  `src/cli/cli.ts` and `src/cli/shared.ts`.
- **Reconciliation:** keep the parser output shape aligned with
  `MatchlockAdmissionOptions` so the interactive path reuses
  `admitMatchlockRun` unchanged; when iso lands, no parser logic is duplicated.

### GAP-07 — No interactive foreground session controller

- **Requirement:** SPEC-12/SPEC-13/SPEC-16 (spec L34, L36, L42).
- **Base reality:** `MatchlockController` (`src/installer/matchlock/controller.ts:224`)
  and the invocation runners are workflow-shaped/single-shot; there is no
  foreground PTY controller that owns host terminal state.
- **Minimal interim behavior:** add
  `src/installer/matchlock/interactive-session.ts` with a foreground controller
  that constructs one `MatchlockController` (`requireHelperPack: false`), creates
  one fresh VM from the pinned identity, runs the guest prep plan, and launches
  the harness or shell through `execTty` with explicit `user`, `working_dir`,
  `rows`, `cols`; forwards host stdin after readiness with bounded backpressure;
  writes guest stdout byte-preservingly; sends stdin EOF on host EOF; forwards
  `SIGWINCH` as resize and Ctrl-C as byte `0x03`; applies no workflow-round
  deadline; and requires a positively confirmed VM close before success. Host
  terminal and signal hooks are injectable. Killing the RPC child alone is never
  treated as proof of VM termination.
- **Status (US-010/US-011):** implemented (synthetic) in
  `src/installer/matchlock/interactive-session.ts`; one owned backend, ordered
  prep, `exec_tty` launch with `user="<uid>:<gid>"`, raw-mode restore on every
  catchable exit, SIGWINCH -> resize, Ctrl-C -> byte `0x03`, and a bounded
  cancel-then-close teardown that requires a positively confirmed VM close.
- **Reconciliation:** keep the controller's teardown as cancel-then-close over
  the shipped `controller.ts:678` `close`, and keep the execution state machine
  injectable so the real-VM PTY gate can drive it unchanged.

### GAP-08 — `owner_uid`/`owner_gid` and exec `user` are not plumbed

- **Requirement:** SPEC-09 (spec L28).
- **Base reality:** `MatchlockMountConfig` carries `owner_uid`/`owner_gid`
  (`src/installer/matchlock/types.ts:119-120`) and `MatchlockExecOptions`
  carries `user` (`:80`), but `workMountToConfig`
  (`src/installer/matchlock/mount-plan.ts:299`) and the configuration/helper
  mounts never set owner fields, and no shipped exec passes an explicit user.
- **Minimal interim behavior:** in the interactive builder set every `host_fs`
  mount's `owner_uid`/`owner_gid` to the caller's numeric ids and launch the
  harness/zsh with `user="<uid>:<gid>"`. Ownership fields are metadata only:
  never a host chown/chmod, and no recursive chown/chmod of a host mount.
- **Status (US-005/US-009/US-010):** implemented (synthetic). The interactive
  builder stamps `owner_uid`/`owner_gid` on every `host_fs` mount (after
  destination normalization), `MatchlockExecOptions.user` is plumbed through
  `execTty`, and the controller launches with `user="<uid>:<gid>"`.
- **Reconciliation:** the fields already match the runtime wire shape; keep the
  numeric-id plumbing in the shared create-params builder so the workflow and
  interactive paths converge without a second mapping.

### GAP-09 — No interactive pre-launch summary / exit-status / confirmed-cleanup UX

- **Requirement:** SPEC-15 (spec L40).
- **Base reality:** the confirmed close exists
  (`src/installer/matchlock/controller.ts:678`) and
  `formatMatchlockResourceSummary` exists
  (`src/installer/matchlock/resource-limits.ts:337`), but there is no
  interactive pre-launch summary, no propagation of the launched process exit
  status as the CLI exit status, and no interactive cleanup-failure UX naming
  the VM and retained diagnostics.
- **Minimal interim behavior:** before entering the TUI/shell print the shared
  resource summary, image provenance, pinned digests, guest uid/gid and resolved
  mount scope; the shell variants also name the harness command to run inside.
  On exit positively confirm closure/removal of only this session's VM, then
  return the launched exit status. Infrastructure failure or unconfirmed cleanup
  returns non-success naming the VM and retained diagnostics.
- **Reconciliation:** reuse the shipped summary formatter and confirmed close
  rather than a new reporting path; the UX strings are additive and can be
  merged mechanically.
- **Status (US-013):** implemented by
  `src/installer/matchlock/interactive-session-orchestration.ts`
  (`runInteractiveSession` / `formatInteractiveSessionPrelaunch`), which reuses
  `formatMatchlockResourceSummary` and the controller's positively confirmed
  `close`. The pre-launch summary and exit-status propagation are covered
  synthetically; real-VM UX qualification stays deferred (GAP-11).

### GAP-10 — Missing-image remedy is not distinguished by provenance

- **Requirement:** SPEC-05 (spec L20).
- **Base reality:** image resolution/pinning/verification is shipped
  (`src/installer/matchlock/image.ts:122`, `:96`), but the admission error for a
  missing image is the generic `image_unusable`
  (`src/installer/matchlock/admission.ts:650`); the `tamandua matchlock setup`
  remedy currently appears only in CLI help and README
  (`src/cli/commands/workflow.ts:252`, `:335`).
- **Minimal interim behavior:** the interactive admission branches on the
  resolved `MatchlockImageSource` (`standard` vs `explicit`): a missing standard
  image refuses with a typed error naming `tamandua matchlock setup` as the
  remedy; a missing explicit image requires operator provisioning. Tamandua
  never pulls, builds or installs during launch and never falls back to host
  execution.
- **Status (US-004):** implemented (synthetic) in
  `src/installer/matchlock/interactive-session-plan.ts`; image failures from
  admission are re-classified by provenance (standard ->
  `matchlock_standard_image_missing` naming `tamandua matchlock setup`; explicit
  -> `matchlock_explicit_image_missing`).
- **Reconciliation:** replace the local branch with the shipped provenance-aware
  refusal when iso lands; keep the two remedy strings and the typed source as
  the stable contract.

### GAP-11 — Real-VM PTY qualification is deferred

- **Requirement:** SPEC-17 (spec L44).
- **Base reality:** this run is authorized for implementation + synthetic test
  qualification ONLY.
- **Minimal interim behavior:** provide synthetic protocol tests (fake tty
  backend) covering option/env precedence, root gate, admission, mount plans,
  the controller state machine, resize/Ctrl-C/EOF/backpressure/disconnect,
  teardown, terminal restore and cleanup-confirmation failure. No real VM, real
  model call, or real matchlock invocation beyond test-owned capability probes.
- **Status (US-015):** **OPEN — deferred.** This run authored synthetic
  protocol tests only (fake tty/RPC backend, test-owned capability probes): no
  real VM create, no real PTY, no real harness launch. The delivered tree must
  be handed to the post-integration gate; clean-refusal scaffolding is not
  feature completion (see §5).
- **Reconciliation:** hand the delivered tree to the post-integration gate for
  the full real-VM PTY qualification listed in SPEC-17; that gate validates flag
  /env parity, pinning, resources, ownership, Git, persistence, resize, Ctrl-C,
  disconnect, confirmed cleanup, shell parity, zsh-less failure, concurrent
  sessions and supported architectures.

### GAP-12 — Security-boundary and synthetic-only disclosure is documentation-only

- **Requirement:** SPEC-18 (spec L46).
- **Base reality:** no user-facing documentation of the interactive command set
  or its security boundary exists yet.
- **Minimal interim behavior:** README documents the four commands, shared
  option set, root gate, pinning, mounts, numeric uid/gid mapping, pre-launch
  summary and confirmed cleanup, and states explicitly that qualification is
  synthetic only with the real-VM PTY gate deferred. The security caveat
  (writable mounts remain exposed; concurrent VMs do not isolate shared files)
  is stated verbatim in effect.
- **Status (US-015):** implemented (documentation) — the README "Interactive
  sessions" subsection documents the four commands, the shared option set, the
  root gate, image/identity pinning, the configuration and working-directory
  mounts, numeric uid/gid mapping, the pre-launch summary and confirmed cleanup,
  and states the synthetic-only qualification with the deferred real-VM PTY
  gate, including the writable-mount / non-isolation security caveat.
- **Reconciliation:** re-check the README against the iso line's final
  capability wording; this is documentation only and carries no behavior.

## 5. Explicitly unavailable real launch paths

Pending corrected dependencies, the following real launch paths remain
**unavailable** in this delivery. Clean-refusal scaffolding is NOT feature
completion:

1. Real-VM interactive `pi` / `pi-shell` / `hermes` / `hermes-shell` sessions
   (no real VM create, no real PTY, no real harness launch). All four commands
   are exercised synthetically against a test-owned fake tty backend.
2. The R8 swap capability handshake against the real installed matchlock binary
   (synthetic probe only; no real `matchlock run --help` invocation in the test
   suite).
3. The R13 root gate against a real root euid (unit-tested via an injected
   euid; no real root process).
4. Real-VM PTY qualification with actual pi and Hermes, including resize,
   Ctrl-C, disconnect and confirmed cleanup (deferred to the post-integration
   gate; SPEC-17/GAP-11).
5. Any claim of standard-image / swap / interactive acceptance, deployment,
   publication or mainline landing.

Documentation of the interactive command surface is delivered by US-015 in
`README.md` (the "Interactive sessions" subsection) and
`skills/tamandua-agents/SKILL.md` (Command overview + the interactive Matchlock
paragraph). That documentation is explicitly **synthetic-only** and does not
qualify any real launch path above; the reconciliation instructions in §4 are
the hand-off for replaying each provisional gap against the corrected iso line.
