# Implement `torture-test/bin/daemon-control` + TT_HOME provisioning (Phase A remainder)

Authoritative spec in this repo — READ first:
- `torture-test/tamandua-torture-test-spec/01-environment-and-isolation.md`
  (§Daemon containment, §TT_HOME provisioning checklist, §two-daemons,
  §production-daemon posture)
- `torture-test/tamandua-torture-test-spec/12-runner-automation.md`
  (§daemon-control component)
- Existing conventions: `torture-test/env/tt-env.sh`,
  `torture-test/env/tt-env-scripted.sh`, `torture-test/bin/tt-run`,
  `torture-test/bin/tt-verify-environment`.

## Deliverables

1. `torture-test/bin/tt-provision-home` — idempotently provisions
   `torture-test/var/home/` (real TT_HOME) and
   `torture-test/var/home-scripted/` per spec 01's checklist: `.gitconfig`
   (user.name/email, commit.gpgsign=false, init.defaultBranch=main,
   pull.ff=only), COPY (never symlink) of `~/.pi` and `~/.hermes` into the
   real TT_HOME (audit copies for absolute paths pointing at the real HOME
   and rewrite them; record what was rewritten to
   `torture-test/var/home/provision-audit.json`), NO `.ssh`. The scripted
   home gets only `.gitconfig` (scripted runtimes need no auth).
2. `torture-test/bin/daemon-control` — the ONLY sanctioned start/stop/
   restart/status path for TT daemons. Usage:
   `daemon-control <real|scripted> <start|stop|restart|status>`.
   - Applies the matching env script (`torture-test/env/tt-env.sh` or
     `tt-env-scripted.sh`) to spawned processes ONLY (never mutates the
     caller's env — see the two-envs rule in spec 01).
   - Where `systemd-run --user --scope` is available (check mechanically),
     starts the daemon inside a dedicated named scope and re-asserts
     cgroup membership after EVERY start/restart, recording
     pid/port/scope-unit provenance to
     `torture-test/var/daemon-control/<name>.json`. Without systemd,
     falls back to plain spawn with cmdline/cwd provenance recorded and
     the weaker guarantee noted in the provenance file.
   - `stop` uses the tamandua CLI's own daemon stop under the spawn env;
     escalates only after a timeout, and only to processes whose
     cwd/cmdline provenance proves they are TT-owned (never name-only
     matching).
   - Refuses ABSOLUTELY to touch anything on production ports
     3334/3338/3339 or the real `~/.tamandua` — check before every
     signal; targeting production is a hard error.
3. Smoke validation built into the tool: `daemon-control real start` on
   ports 43xx from the provisioned TT_HOME, then `tamandua status` and
   `tamandua doctor` under the spawn env, then `daemon-control real stop`
   — all leaving production state byte-untouched (verify: production DB
   sha256 identical before/after, no new listeners on 33xx).

## Hard constraints

- Files ONLY inside `torture-test/`. All state under `torture-test/var/`.
- Never start/stop/restart/signal the PRODUCTION daemon, dashboard, or
  MCP (the live instance scheduling you). The backstop refusal in the
  tamandua CLI ("Refusing to stop the daemon...") means you targeted the
  live instance — that must be unreachable through this tool by
  construction.
- No new npm dependencies; bash or node, matching existing torture-test
  tool style.
- The scripted daemon start MUST work even though the scripted harness
  runtimes do not exist yet (the daemon starts fine; harness resolution
  happens at dispatch time — document this in the tool's --help).

## Acceptance (verify before reporting done)

- `tt-provision-home` twice in a row: second run is a no-op (idempotent).
- `daemon-control real start && ... status && ... stop` round-trips green
  in the TT env; production snapshot byte-identical before/after
  (demonstrate in a `daemon-control.test.sh` you add next to it).
- `daemon-control scripted start/stop` round-trips on 53xx ports.
- Both daemons' provenance JSON files exist and parse.
