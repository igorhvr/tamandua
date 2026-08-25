# MACP6: scripted harness shims hardcode the linux volta node path — mac W2 cells instant-fail

Mac tier1 at d64cd36a: MACP5's pid fix works (daemon starts,
identity-verified), but all four W2 cells still PRODUCT_FAIL one layer
deeper — the scripted runs never reach terminal state because every
worker round instant-fails in ~49ms:

  scripted-pi: node binary not found at
  /home/igorhvr/.volta/tools/image/node/24.18.0/bin/node
  Set TT_NODE_BIN to the absolute path of the node binary.

(Bonus: the mac's scripted daemon log shows the RSPN fix catching this
live — "Worker round classified as instant fail ... backing off
relaunch".)

Root cause: torture-test/scripted-runtimes/bin/scripted-pi line ~15
defaults NODE_BIN to a hardcoded, machine-specific linux volta path
("discovered at build time"); TT_NODE_BIN is the only escape. The same
pattern presumably exists in the sibling shims (scripted-hermes,
scripted-dsh, any token-saver variants) — audit them all.

1. Portable node resolution in every scripted shim, fail-closed:
   TT_NODE_BIN (if set) → `command -v node` from the shim's own PATH →
   otherwise the existing clear error. Keep the error text and the
   TT_NODE_BIN contract. The "daemon PATH is not guaranteed" concern is
   real — so ALSO have the contained env scripts (env/tt-env-scripted.sh
   and the daemon-launch env composition in daemon-control, whichever
   actually feeds the shims' PATH/env) export TT_NODE_BIN resolved from
   the launching host's real node (the env scripts already resolve
   node/volta paths — reuse that). Result must work on: linux volta
   (unchanged behavior), mac nix node, and any PATH-only host.
2. Remove the machine-specific absolute path from the TRACKED tree
   entirely (no /home/igorhvr literals in scripted-runtimes/bin) and add
   a lint arm (the GNU-ism/procfs lint pattern) banning absolute
   /home/<user> or /Users/<user> literals in tracked torture-test
   scripts — red-then-green with a SYNTHETIC fixture (per MACP5.1: no
   history-dependent red arms).
3. Update the shim self-tests (scripted-runtime-wrappers.test.ts pins
   the TT_NODE_BIN override behavior — keep it; add the command -v
   fallback case and the env-script export case).

Prove on linux: full battery green from repo root; bare --tier1 GREEN on
BOTH paths (normal + TT_FORCE_NO_SYSTEMD=1); a shim smoke test with
volta masked from PATH (PATH without volta, TT_NODE_BIN unset →
command -v node resolution) green. Document expected mac outcome (bare
tier1 GREEN, 4 executed cells).

## Hard constraints
- Files ONLY inside torture-test/. Zero tokens. Live daemon (33xx)
  untouched. A concurrent run (MACP5.1) owns
  torture-test/self-tests/tier0-gnu-portability-lint.test.ts,
  tier0-macp5-gnu-ism-sweep.test.ts, tier0-procfs-portability-lint.test.ts
  and shared red-arm helpers — put the new lint arm in its OWN self-test
  file and touch none of those three.

---

# LANDING REPORT (US-004 — linux proof battery + expected mac outcome)

## What shipped (US-001/002/003)

- **US-001** — `scripted-pi` / `scripted-hermes` no longer embed the
  machine-specific linux volta node path. Both shims now resolve node
  fail-closed: `TT_NODE_BIN` (if set) → `command -v node` from the shim's
  own PATH → the preserved clear error ("node binary not found at ..." +
  "Set TT_NODE_BIN to the absolute path of the node binary."), exit 1.
  Sibling-shim audit: no `scripted-dsh` shim exists; the token-saver stub
  installs a PATH-resolved `#!/usr/bin/env node` stub into
  var/adapters-bin (not a node-exec shim) — nothing else to fix.
- **US-002** — `env/tt-env-scripted.sh` now exports `TT_NODE_BIN`
  (absolute, executable node from the launching host) whenever its
  existing node/volta resolution chain succeeds, and `print` emits it.
  Because daemon-control's `env_for_kind('scripted')` is exactly
  `env -i bash tt-env-scripted.sh print` and `run_under_env` applies that
  env to the contained scripted daemon, every worker round the daemon
  spawns carries a correct `TT_NODE_BIN` — zero daemon-control source
  changes. The shims' `command -v node` fallback covers any residual
  PATH-only host.
- **US-003** — new self-contained lint arm
  `tier0-home-literal-portability-lint.test.ts` (own file, own
  collectShellFiles/maskLine helpers, synthetic red-then-green, no
  git-history resolution) bans machine-specific absolute home literals
  (`/home/<user>/`, `/Users/<user>/`) in tracked torture-test shell
  scripts — the defect class that instant-failed the mac's W2 cells can
  never be reintroduced.

## Linux proof battery (all zero tokens)

- **Volta-masked shim smoke (US-004 AC2):** with `TT_NODE_BIN` unset and a
  PATH that excludes volta but contains a node dir first, both shims reach
  and exec their runtime `.mjs` via `command -v node` (proven with a
  recording wrapper node on PATH: the wrapper is invoked and its $0 is the
  PATH-resolved path — no hardcoded volta path anywhere). With a fully
  node-free controlled PATH (env -i, only bash+dirname symlinks), both
  shims exit 1 with the exact preserved error and never a shell
  "command not found".
- **Full self-test battery (AC1):** `torture-test/self-tests/run.sh` from
  repo root — **115 passed / 3 failed**, working tree clean before and
  after. The only 3 failures are the three MACP5.1-owned git-history red
  arms (tier0-gnu-portability-lint, tier0-macp5-gnu-ism-sweep,
  tier0-procfs-portability-lint), which fail **byte-identically on the
  base commit 8216f3c7** (verified by running them on a detached base
  worktree) and are owned by the concurrent MACP5.1 run — this branch
  must not touch those files. Every test this run owns is green,
  including all golden-fixture tests (tier1-e24-baseline-verifier-expect,
  tier1-e24-regenerated-goldens, tt-poly-a5-seed-and-sentinel,
  tt-poly-end-to-end-verification), which required provisioning the eight
  var/fixtures/golden bares (gitignored state; all 8 verify byte-exact
  against their hash ledgers). One transient battery run showed an
  additional tier2-dsh-host-profile failure caused by the concurrent
  MACP5.1 run holding scripted port 5339 for its own tier1 campaign; with
  ports free the file passes 5/5 (the failure is an environment conflict,
  not a regression).
- **Bare tier1 on BOTH daemon paths (AC3/AC4):**
  - `./run-torture-test --tier1` (normal systemd path) → **exit 0 GREEN**,
    report verdict GREEN / exit_code 0, vacuity silent, zero tokens. The
    campaign evidence shows the `using systemd scope:` daemon-control
    marker and the 4 W2 scripted cells (W2.21-admission,
    W2.23a-expects-regex, W2.23b-retry-step, W2.23c-missing-persona) all
    PASS (0 tokens each); the 24 real pi/hermes cells stay pending-real.
  - `TT_FORCE_NO_SYSTEMD=1 ./run-torture-test --tier1` (forced
    plain-background fallback path) → **exit 0 GREEN**, same verdict, same
    4 executed cells PASS, zero tokens; the campaign evidence shows the
    `systemd not available — using plain background spawn` marker and no
    systemd marker, proving the override reached daemon-control through
    the whole campaign spawn path.

## Expected mac outcome (Darwin)

On Darwin, bare `./run-torture-test --tier1` is **expected GREEN** with
the **4 W2 scripted cells executed** (W2.21-admission,
W2.23a-expects-regex, W2.23b-retry-step, W2.23c-missing-persona), for
two independent reasons:

1. **`tt-env-scripted.sh` resolves `TT_NODE_BIN` from the mac's real
   node.** The launching host's env script already walks the portable
   node chain (`command -v volta && volta which node || command -v node`,
   with the `.volta/bin/node` → `$VOLTA_HOME/bin/node` mapping) and now
   exports the resolved absolute executable path into the contained
   scripted daemon env. On the mac (nix node, no linux volta path) the
   chain resolves the nix-provided node, so every worker round the
   scripted daemon spawns receives a valid `TT_NODE_BIN` — the shims
   never fall through to the (previously hardcoded, linux-only) path.
2. **The shims additionally fall back to `command -v node`** on their own
   PATH, so even a host where the env composition somehow did not carry
   `TT_NODE_BIN` still resolves a node portably, and only a genuinely
   node-free host gets the clear fail-closed error.

The pre-fix failure mode — every worker round instant-failing in ~49ms
with `scripted-pi: node binary not found at
/home/igorhvr/.volta/tools/image/node/24.18.0/bin/node` — is structurally
impossible now: that literal exists nowhere in the tracked tree, is
banned by the new home-literal lint, and is never the fallback of any
shim. Expected verdict on the mac campaign: bare tier1 GREEN, 4 executed
cells, zero tokens.
