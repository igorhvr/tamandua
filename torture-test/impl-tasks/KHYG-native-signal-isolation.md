# KHYG: best-effort native signal isolation for each harness execution

## Coordinator clarification after story-plan review, 2026-09-05 UTC

These are clarifications of the original contract, not additional stories:

- The generated US-002 criteria contain conflicting shorthand. The invariant
  is AT MOST one actual harness execution. Success or safe fallback normally
  executes once; cancellation before release executes ZERO times. A setup
  failure before release may fall back once from the unchanged parent AFTER
  the setup attempt is settled. Missing/malformed readiness never authorizes
  release; it may qualify as a pre-release setup failure, not as evidence the
  harness ran. Once release may have been sent, NEVER retry unprotected.
- The generated US-002 shell snippet has a transcription typo: preserve the
  actual source's double-dollar PID expansion for TAMANDUA_WORKER_PGID, not
  a literal single dollar. Preserve behavior, not that erroneous snippet.
- The shared lock also covers focused MCP/get-ready tests and fast e2e, as
  stated below. The plan's generic focused-test exemption does not override
  those specifically identified cleanup-capable suites.
- Require ZERO unexpected test-isolation violations / enforced ledger entries.
  Deliberate isolated guard-negative tests can print expected violation text;
  a blind string search must not misclassify those as failed containment.
- Existing behavioral assertions stay intact. Necessary updates to structural
  spawn fakes for the new launch seam are not permission to weaken behavior.
  Fallback warnings need user-visible output as well as durable records;
  logger.warn alone only appends a file in the current implementation.

## Authorization and objective

Igor approved this product feature on 2026-09-05 and requested coordinator-run
manual experiments on BOTH hosts before implementation. Those experiments are
complete. Beads: tamandua-6sy.8. Implement through this Linux dsh workflow.

Create one fresh native signal-security domain for each harness invocation
(including the launch-time harness probe), inherited by every descendant. A
worker may signal its own execution's processes, but not another execution,
the scheduling daemon, or unrelated host processes. Apply to pi, Hermes, and
dsh through their common launch boundary, independent of shell or language.

Linux: Landlock SIGNAL scope, ABI at least 6. macOS: opportunistic Seatbelt via
the system sandbox-exec command. If unavailable or setup fails BEFORE any
harness work starts, prominently warn, durably record the exact unprotected
fallback and reason, and run normally. Do not make Tamandua unusable on older
or restricted systems. On our two rollout hosts protection must actually work;
fallback alone does not satisfy the coordinator's resume gate.

This is process-signal isolation, NOT filesystem protection. Igor knowingly
accepts the remaining removal risk. No file allowlists, disposable-directory
policy, command shims, shell replacements, container platform, or privilege
service. Keep the change small and comprehensible; no schema migration or
unrelated scheduler, cleanup-selection, retry, or workflow changes.

## Coordinator's actual manual evidence (not product acceptance)

Evidence directory on Linux, retained and safe to READ:
/home/igorhvr/idm/tamandua/torture-test/var/review-logs/native-signal-probes.DHNQbp

The C launcher and JavaScript drivers there are experiments, not production
code to import. Read linux-final-full.log, mac-final-full.log, and
linux-composition-full.log along with their drivers. Actual hosts:
Linux aarch64, kernel 7.0.0-27-generic, queried Landlock ABI 8;
macOS arm64 26.5.2, system sandbox-exec present. Final checks: Linux 33/33,
Mac 31/31; six Linux policy-composition cases also passed (two file operations
per case). Linux dsh headless help and Mac pi version worked under protection.

Proved with only fresh owned child fixtures: Node signal calls, the actual
Bash/sh/zsh built-ins, and external kill all refuse outside and independent
identical-policy sibling targets; owned children and their process groups work.
The unprotected parent can cancel its protected child. Nested domains work;
an orphaned/reparented descendant retains its outbound restriction. A random-port
outside network fixture remains reachable. Cross-directory hardlinks and renames
work with the compatible policy. Invalid Mac policy exits before its command.
No original incident commands or live service targets were executed.

Mac profile actually tested, without importing a filesystem sandbox:

    (version 1)
    (allow default)
    (deny signal)
    (allow signal (target same-sandbox))

Linux subtlety: a bare scope-only domain with no filesystem policy anywhere
allowed renames here. The initial diagnostic expected denial and was WRONG;
the original red log is retained, not an implementation failure. However,
composing that domain BEFORE OR AFTER a filesystem Landlock domain caused
cross-directory link/rename EXDEV. Explicitly handling FS_REFER and granting
that right broadly at the filesystem root fixed BOTH composition orders.
Use the small compatibility allow rule, not file confinement. Keep other
filesystem/network rights unhandled and request only the SIGNAL scope.
Landlock still entails no-new-privileges, ptrace restrictions, and filesystem
policy-related mount limitations; document these honestly, not an assertion
that all privilege/mount operations remain unchanged. Never try to loosen an
outer sandbox. Single-threaded native startup before exec avoids thread-sync
requirements; do not raise the minimum to ABI 8 for this.

Primary references: docs.kernel.org/userspace-api/landlock.html and Linux
v6.12 security/landlock/{fs.c,ruleset.h,task.c}; the local kernel UAPI header.
The Mac policy language is not a supported stable third-party Apple API;
the installed Apple application profile uses target same-sandbox, and our
actual separate-instance behavior proof supplies the host evidence.

## Non-negotiable launch and fallback contract

- Apply restrictions in a fresh child only. Never sandbox the shared daemon.
  Each launch creates its OWN domain, not a cached shared domain or a single
  domain around the daemon. Preserve the existing detached process group and
  TAMANDUA_WORKER_PGID identity across exec.
- Keep the existing harness arguments, cwd, environment, stdin/stdout/stderr,
  parsing, usage attribution, STATUS contract, onSpawn bookkeeping, cancellation,
  and wall-limit behavior. No extra supervisor shell is needed for ancestry.
- Native setup and actual command execution need an explicit reliable boundary.
  Prefer a private control-channel readiness/release handshake: setup completes,
  parent records the effective mode and attaches normal handlers, then releases
  the actual harness exactly once. A setup child that never received release
  cannot have executed the harness. Account for cancellation during this phase.
- Safe fallback starts from an unchanged parent in a FRESH process, since a
  partially applied policy or no-new-privileges cannot be removed. Never use a
  generic 'sandboxed command failed, now run it unsandboxed' retry. Missing
  readiness, partial frames, delayed exit, and lost acknowledgments must not
  duplicate work. Treat any ambiguous post-release state as normal failure.
- A blocked signal is successful enforcement, not a setup failure. Harness
  nonzero exit, crashes, hangs, or signal death AFTER release MUST NOT cause an
  unprotected replay. A harness exiting with a helper-like exit code must not
  masquerade as a pre-execution setup failure. Test this explicitly.
- Probe native capability/behavior using bounded fresh owned fixtures, not
  models, real services, broad PID searches, or sensitive process arguments.
  Kernel version strings and sandbox-exec existence alone are insufficient.
  Reuse a capability result only where safe; each execution still enforces its
  own fresh domain. No optional audit feature should raise the minimum ABI.
- Record effective mode (landlock, seatbelt, unprotected-fallback), reason,
  run/execution identity and UTC time using existing lifecycle logging/events.
  Fallback warnings must be visible and durable, without dumping prompts or
  secrets. Do not add a database schema just for this metadata.
- Best effort is NOT a complete security boundary: unprotected senders can
  still signal protected targets; same-execution self-kills remain possible;
  filesystem writes and indirect service-control APIs remain out of scope.
  The separately filed daemon cleanup-selection bug RCOB is not fixed here.

## Bounded story plan: one verification gate per story

Use these six boundaries; do not turn this into a general sandbox framework.

### US-001 — Small native backends and optional build support

Implement the Linux startup helper and minimal Mac policy/startup bridge.
Handle ABI/capability errors without requiring new privilege or a daemon-wide
policy. Integrate a small optional native build artifact into existing builds;
missing compiler/headers or unsupported architecture must produce an explicit
unavailable backend, not a broken Tamandua installation or a stale binary silently
reused. Do not download binaries or introduce a Node native-addon dependency.
Gate: focused backend/setup tests (including preserved rename/link composition).

### US-002 — Shared harness integration and exact-once launch

Wire all three adapters and harness probes through the minimal shared launch
mechanism. Preserve worker identity and existing output/cancellation contracts.
Implement the safe pre-execution fallback boundary and durable mode reporting.
Gate: focused adapter/launch regression tests, with real execution counters and
pre-setup failure versus post-release failure/cancellation cases.

### US-003 — Real owned-fixture signal boundary regressions

Add portable behavior tests runnable on Linux and actual Mac: own child and
group positive controls, unrelated owned fixture and independent same-policy
sibling negatives, shell built-ins/external kill and Node calls, inheritance
across exec/reparenting, ordinary parent cancellation and no fallback on denial.
All PIDs must come from fresh owned handles; use harmless caught signals first.
No broad live process selectors. Unsupported CI hosts report honest capability
skips; on our two available hosts these tests MUST execute, not skip.
Gate: the focused native signal-boundary test suite.

### US-004 — Compatibility, packaging, and concise user documentation

Cover argv boundaries, output/stdin forwarding, normal file and network access,
backend-unavailable fallback, and build/install artifact resolution without cwd
assumptions. Document automatic behavior, prominent fallback, minimum Linux ABI,
Mac deprecation, and the stated limits. Review README/AGENTS and applicable CLI
help for changed interfaces; prefer no new knobs unless strictly necessary.
Gate: focused compatibility/install tests on isolated fixtures.

### US-005 — Regular product regression gate

Run the unchanged npm test command, both lanes, with zero isolation violations.
Use the exact shared Linux lock below. Keep complete evidence, actual tree and
exit status; a cached ledger row is not a fresh test. Never weaken a failure.
Gate: npm test only, with adequate command-level wall budget (at least 30 min).

### US-006 — Full fast pipeline regression gate

Run ./run-all-e2e-tests (smoke plus scripted, zero model tokens) through this
worktree's own built product. Preserve native enforcement and actual lifecycle
coverage; do not globally disable the feature to make tests pass.
Gate: the fast e2e runner only. No paid real e2e/campaign in this implementation
run; the coordinator owns independent Linux/Mac and staged rollout acceptance.

## Operational boundaries for EVERY worker

This run uses a separate coordinator-owned Tamandua state directory and a
manually tested native dsh launcher. That temporary protection is NOT evidence
that the new product code works. Keep test controls capable of detecting an
absent inner per-execution boundary despite the outer worker boundary.

All product/suite implementation must occur in this run's worktree. Do not build
the origin checkout, refresh either live installation, change host dotfiles or
harness permission profiles, stop a live daemon, resume other runs, or push any
remote. The coordinator will perform both-host verification, deployment, and
resume the four held runs AFTER acceptance. Use normal step APIs only; no direct
run/story/counter/context database edits or replacement runs to erase failures.

Use the scheduling instance's launcher for step reporting; use this worktree's
built launcher only for isolated tests. Never substitute the user's live CLI
state. Tests get isolated home/state/database and random ports with guards on.
Register spawn-capable test files in tests/serial-files.txt per AGENTS.md.

All full npm, focused MCP/get-ready, and fast e2e gates MUST acquire the existing
shared flock lock around the normal tamandua-test gate:
/home/igorhvr/idm/tamandua/torture-test/var/review-logs/suite-cleanup-prefix-5nLG3O/linux-npm.lock
Do not unlink or recreate the lock. Commit before ledger gates and do not edit
the tree while a gate is running. Test command fields remain exactly npm test.

Preserve evidence and all existing directories. Fresh uniquely allocated scratch
only, no fixed-path pre-cleaning, recursive ad-hoc removal, forced worktree
removal, pruning, or name/pattern kills. Existing test-owned cleanup is allowed
only within its proven isolated fixtures; new diagnostics are retained. No
torture battery or tier campaigns in this run. No unrelated TSCP/RCOB/DRVP fixes.
If a safe minimal implementation cannot meet the stated boundary, report the
specific blocker rather than quietly weakening protection or expanding scope.

Test command: npm test
