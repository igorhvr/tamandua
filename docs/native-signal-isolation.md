# Per-Execution Signal Isolation (Automatic)

Tamandua runs each harness execution — every pi, Hermes or dsh work round,
**and** the launch-time harness probe — inside its own fresh native
signal-security domain. A worker can signal its own execution's processes,
but not another execution, the scheduling daemon, or unrelated host
processes. This is process-**signal** isolation only: it is NOT a
filesystem sandbox, and it is deliberately not a complete security
boundary (see [Limits](#limits)).

The behavior is automatic. There are no new user-facing knobs; protection
is applied at the shared launch boundary that every harness invocation
already flows through, independent of shell or language.

## What happens on each host

### Linux — Landlock SIGNAL scope

Each launch creates a fresh child process that restricts itself with a
Landlock ruleset (`LANDLOCK_SCOPE_SIGNAL`) before any harness work starts.
The child reports READY over a private control channel, the parent records
the effective mode, and the harness is released exactly once.

- **Minimum kernel ABI:** 6 (the release that introduced
  `LANDLOCK_SCOPE_SIGNAL`). Older kernels fall back (see
  [Fallback](#fallback)).
- **Honest caveats:** applying a Landlock ruleset entails
  `no_new_privileges`, the usual Landlock ptrace restrictions, and
  filesystem-policy-related mount limitations once a ruleset is applied.
  Tamandua handles only the `FS_REFER` right (with one small compatibility
  allow rule granting it at the filesystem root so cross-directory
  hardlink/rename keeps working) — no file confinement, no other
  filesystem or network rights are handled. It never tries to loosen an
  outer sandbox.

### macOS — opportunistic sandbox-exec with a Seatbelt profile

macOS uses the system `sandbox-exec` command (itself deprecated by Apple)
with the bundled Seatbelt profile:

```
(version 1) (allow default) (deny signal) (allow signal (target same-sandbox))
```

This is **opportunistic**: it is used when `/usr/bin/sandbox-exec` is
present and usable, and it degrades to the normal fallback otherwise.
Because Apple has deprecated `sandbox-exec` (and the Seatbelt profile
language is not a supported stable API), Tamandua treats this backend as a
best-effort mechanism, never as a hard requirement.

## Fallback

When no backend is available (unsupported platform, kernel below ABI 6,
Landlock disabled, missing `sandbox-exec`, an artifact that failed to
build, or a native setup failure **before** any harness work starts),
Tamandua:

1. warns prominently, and
2. durably records `mode=unprotected-fallback` with the machine-readable
   reason, run/execution identity, and a UTC timestamp — through the
   normal lifecycle logging/event stream (visible in `tamandua logs`,
   `logs-tail`, and the dashboard), and
3. runs the harness normally, unprotected.

The warning never dumps prompts or secrets, and an ambiguous
post-release outcome is never replayed as an unprotected retry. If the
backend is unavailable, Tamandua still runs your workflow — protection is
best-effort and must never make Tamandua unusable on older or restricted
systems.

Because no-backend is a property of the host (not of each round), the
unprotected-fallback warning and its `run.harness_isolation` record are
written **once per run per daemon start** — on the first fallback execution.
Later fallback rounds in the same run log the same fields at debug level and
emit no further event, so a long run does not produce hundreds of duplicate
warnings. Protected (`landlock`/`seatbelt`) records are unaffected: they are
still emitted once per harness execution.

## Limits

Best effort is **not** a complete security boundary:

- Unprotected senders can still signal protected targets.
- Same-execution self-kills remain possible.
- This feature does not protect files: it cannot prevent file writes,
  deletions, or other filesystem effects, and it offers no file allowlists,
  disposable-directory policy, command shims, shell replacements,
  containers, or privilege services.
- Indirect service-control APIs remain out of scope.

## Requirements

- **Linux (Landlock):** the helper is built locally during `npm run build`
  (`scripts/build-native.mjs`), which needs a working C compiler and a
  `linux/landlock.h` UAPI header that defines `LANDLOCK_SCOPE_SIGNAL` at
  build time — a sufficient kernel ABI alone does not supply the helper.
  At runtime the kernel must expose Landlock ABI ≥ 6.
- **macOS:** the system `sandbox-exec` command for the (opportunistic)
  Seatbelt backend.
- On hosts where no backend can be built or applied, Tamandua runs with the
  durable `unprotected-fallback` mode described above.
