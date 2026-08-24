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
