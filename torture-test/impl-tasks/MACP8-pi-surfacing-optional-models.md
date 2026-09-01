# MACP8: pi credential surfacing must not require models.json (darwin parity)

On the mac, `tt-harness-auth-probe pi` fails fail-closed with
`missing surfaced file(s): .pi/agent/models.json` because
`tt-provision-home`'s pi enumeration requires `models.json` — but the mac's
real `~/.pi/agent/` legitimately has no `models.json` (linux does; pi runs
fine without it — it is an optional custom-models config, and the mac pi
answers correctly in interactive use). The enumeration treats an optional
pi config file as mandatory.

Fix: in the pi surfacing enumeration (tt-provision-home and any probe-side
mirror of the required-file list), classify `models.json` as
OPTIONAL-surface-if-present: when the real file exists it is surfaced
exactly as today; when absent, provisioning proceeds and the probe must
not name it missing. Genuinely required pi auth files (auth.json,
settings.json, and whatever else the enumeration correctly requires) stay
fail-closed exactly as today. Document the required-vs-optional split in
the enumeration's comment block.

Prove (zero real tokens beyond one probe answer leg):
- Red-arm self-test: a fixture HOME whose pi dir lacks models.json →
  pre-fix provisioning/probe fails with the exact missing-file message;
  post-fix both green; a fixture missing auth.json still fails closed
  with models.json absent AND present.
- On this host: `tt-provision-home` exit 0, then `tt-harness-auth-probe
  pi` OK (real answer leg).
- Full self-test battery green from repo root.

Hard constraints: files ONLY inside torture-test/. Never copy anything
from the operator's real HOME beyond the enumerated files; never touch
the live daemon; preserve all fail-closed semantics for required files.

## Closeout — required-vs-optional split and proof results

### The split (implemented US-001 + US-002)

- `torture-test/bin/tt-provision-home` enumerates pi surfaced files in two
  tiers: `PI_AGENT_FILES` (**REQUIRED** — `.pi/agent/settings.json`) and
  `PI_AGENT_OPTIONAL_FILES` (**OPTIONAL-surface-if-present** —
  `.pi/agent/models.json`). `surface_minimal_file` skips a missing operator
  source, so an absent `models.json` is never copied and never named missing;
  the required tiers stay fail-closed via `copy-missing:` DETAILS legs in
  `fail_closed_real_home`. `.pi/agent/auth.json` is **REQUIRED** and is
  produced by the env-key merge (operator `auth.json` base + operator API-key
  env vars).
- `torture-test/bin/tt-harness-auth-probe` mirrors the split in
  `present_files_for`: pi presence REQUIRES `.pi/agent/settings.json` +
  `.pi/agent/auth.json`; `models.json` is OPTIONAL-surface-if-present and the
  probe never names it missing. Hermes/dsh branches are unchanged.
- Both tools document the split in their header comment blocks and `usage()`.
- Spec 01 `TT_HOME provisioning checklist` now marks `settings.json` and
  `auth.json` **required** and `models.json` **OPTIONAL-surface-if-present**.

### Proof results (this host)

- `torture-test/bin/tt-provision-home` → exit **0**; `models.json` skipped with
  `(operator has no such file)` (the darwin operator shape), `settings.json`
  surfaced, pi `auth.json` materialized from env keys.
- `torture-test/bin/tt-harness-auth-probe pi` → exit **0**,
  `OK: pi can answer` (the single authorized real answer leg).
- Bin gates (run directly):
  - `torture-test/bin/tt-provision-home.test.sh` → **ALL TESTS PASSED** (exit 0)
  - `torture-test/bin/tt-provision-home-failclosed.test.sh` → **ALL TESTS PASSED** (exit 0)
  - `torture-test/bin/tt-harness-auth-probe.test.sh` → **ALL TESTS PASSED** (exit 0)
- Full self-test battery `torture-test/self-tests/run.sh` from repo root:
  **129 passed / 20 failed** (exit 1). All 20 failures are PRE-EXISTING
  host/environment failures on this darwin host, none caused by MACP8 (this
  story's changes are doc-only; the MACP8-specific gates below are all green):
  - 8 containment tests fail because the operator's real `~/.gitconfig` does
    not exist on this host (they hash it before/after to prove non-mutation);
    the MACP8 constraints forbid creating/modifying the operator's real HOME.
  - 3 scripted-runtime parity tests fail on `runtime-hermes.mjs` non-knob
    drift from FROZEN_SHA (pre-existing repo divergence, unrelated to pi).
  - `scripted-runtime-binding-proof` fails on an empty daemon-control-missing
    diagnostic (pre-existing).
  - 3 `tier1-e24-*` fixture/golden tests fail on missing generated goldens
    (`tt-java`, `tt-go.git`) that need a one-time `build-golden.sh` run.
  - `tier1-host-profile-daemon-scripted` AC1 asserts the real profile is the
    linux host; this host is darwin (pre-existing darwin gap).
  - 2 `tt-poly-*` tests fail on a missing polyglot golden repo (pre-existing).
  - 4 `tier2-*` tests fail on darwin procfs absence and missing tier2
    generated assets (pre-existing).
  The MACP8-specific self-test `tier1-macp8-pi-surfacing-optional-models.test.ts`
  (4/4), the three bin gates, and the on-host provision/probe legs are all green.
- Hard constraints verified: only files under `torture-test/` modified; only
  the enumerated files surfaced (settings.json, auth.json via env-key merge,
  hermes config.yaml/auth.json/.env); the live daemon untouched; required-file
  fail-closed semantics preserved (auth.json and settings.json still fail
  closed in both provision and probe).
