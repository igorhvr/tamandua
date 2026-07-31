# Implement `torture-test/bin/tt-verify-environment` (torture-test W0.0 assumption gate)

You are implementing one component of the tamandua torture-test suite. The
authoritative specification lives in this repository at
`torture-test/tamandua-torture-test-spec/` — READ these files before writing
any code:

- `04-wave-0-preflight.md` — the W0.0 row is the requirements list for this tool.
- `01-environment-and-isolation.md` — host model, capability profile,
  `host-profile.json` contract, tier definitions, the two-daemon port plan.
- `12-runner-automation.md` — design rules (mechanical checks only, no prose
  interpretation; UTC ISO-8601 timestamps).

## Deliverable

An executable `torture-test/bin/tt-verify-environment` (node, plain
JavaScript or TypeScript compiled nowhere — it must run directly with the
system `node`, no build step, no new npm dependencies) that:

1. Runs every W0.0 check it can implement mechanically today, printing a
   table `CHECK | RESULT | EVIDENCE | REMEDY` (REMEDY only on failure).
   Checks marked REQUIRED that fail => non-zero exit. Checks that need
   not-yet-built torture components (scripted daemon binding, fixture
   baselines, harness auth probes that would SPEND tokens) are printed as
   `SKIPPED (not yet implemented)` or `SKIPPED (requires --spend)` — never
   silently omitted.
2. Emits `torture-test/var/w0/host-profile.json` and
   `torture-test/var/w0/environment.json` per spec 01/04: platform,
   systemd-user-scope availability, per-language toolchains (java+maven via
   a real hello-world BUILD+TEST probe in a temp dir under
   `torture-test/var/`, same for rust/go/python3/node — NOT `--version`),
   node runtimes found, `node:sqlite` loads, git version >= 2.38 with a
   `merge-tree --write-tree` probe on a scratch repo, disk headroom, port
   status for 3334/3338/3339 (production, report only) and
   4334/4338/4339 + 5334/5338/5339 (torture, must be free or owned by TT),
   sqlite3/curl/jq presence, and the derived tier (tier1/tier2) the host
   supports.
3. Supports `--fast` (the ~30s wave-boundary subset per spec: skip the
   toolchain build probes, keep auth/disk/port/clock checks) and `--json`
   (machine-readable full output to stdout).
4. Live harness auth probes (pi/hermes 1-prompt) are implemented but only
   run under an explicit `--spend` flag; without it they report
   `SKIPPED (requires --spend)`.

## Hard constraints

- Create/modify files ONLY inside `torture-test/`. Nothing outside it —
  no package.json edits, no src/ changes, no docs changes.
- All runtime/temp output goes under `torture-test/var/` (gitignored).
- The tool must not start, stop, restart, or signal ANY tamandua daemon or
  service — it only observes (port checks are bind-free: read /proc or use
  lsof/ss).
- Deterministic, side-effect-free re-runs: running it twice in a row must
  produce the same RESULT column (temp probe dirs cleaned or re-created).

## Acceptance (verify before reporting done)

- `torture-test/bin/tt-verify-environment` exits 0 on this host and prints
  the table; `--fast` completes in under ~30s; `--json` output parses with
  `jq .`.
- `torture-test/var/w0/host-profile.json` exists, parses, and correctly
  reports this host's five toolchains and platform.
- Add a small self-test script `torture-test/bin/tt-verify-environment.test.sh`
  that runs the tool in --fast and --json modes and greps for required
  table rows / JSON keys; it must exit 0. (This is the component's own
  test; the repo's main `npm test` must remain untouched and green.)
