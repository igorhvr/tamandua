# MACP1: Darwin parity — bash-3.2 sweep, old-pip bootstrap, builder error surfacing, tier scoping, provision entry point

Mac parity validation (macOS 26.5.2, /bin/bash 3.2.57, system pip
21.2.4) of current main found five suite defects. npm test is GREEN on
the mac — these are all torture-suite portability/UX issues. Root
causes were diagnosed LIVE on the mac; fix blind here (linux), the
operator validates on the mac after merge.

1. **bash 3.2 sweep.** (a) `tt-run:145` `"${case_args[@]}"` on an
   empty array under `set -u` → "unbound variable" on bash 3.2; fix
   with `${case_args[@]+"${case_args[@]}"}` (probe-verified on the
   mac). (b) `declare -A` (associative arrays, bash 4+) breaks:
   fixtures-src/tt-ts/build-golden.sh:120, tt-java/build-golden.sh,
   tt-java/validate-e2e.sh, tt-python/validate-e2e.sh,
   bin/verify-builder-determinism.test.sh — rewrite with 3.2-safe
   constructs (parallel arrays / case tables). (c) Add a lint
   self-test (new file) grepping the tracked shell surface for the
   unsafe patterns (declare -A, mapfile/readarray, ${var,,}/${var^^},
   unguarded [@]-expansion of possibly-empty arrays under set -u) so
   the class cannot regress.
2. **Old-pip editable-install failure** (kills tt-python golden build
   AND tt-poly-lite Phase 6 [6a] python check): fixture `bootstrap`
   scripts run `pip install -e .` against a pyproject-only tree;
   pip < 21.3 (mac system python3) cannot. Fix inside the venv
   bootstrap: upgrade pip in the venv first (pinned floor, e.g.
   `python -m pip install -q 'pip>=23'`) or switch to a
   non-editable/PEP517 install — pick the option that keeps the
   COMMITTED golden trees byte-identical (venv is an arming artifact,
   not committed; prove determinism: 2 consecutive builds identical
   hashes on linux).
3. **Builder error surfacing.** tt-python/build-golden.sh:202 runs
   bootstrap `>/dev/null 2>&1` then prints only "✗ bootstrap failed";
   tt-poly-lite's [6a] similarly swallows the python error. Fail-
   closed paths must capture and print the failing command's last ~20
   stderr/stdout lines. Audit all fixtures-src builders for the same
   swallow pattern.
4. **tt-verify-environment tier scoping.** On a tier1 host it FAILS
   REQUIRED checks for java/maven, rust/cargo, go — but spec 04 defines
   T1={node,python3} (the other toolchains are Tier-2 capabilities).
   Scope REQUIRED-vs-INFO checks by the requested tier; tier1 must
   pass on a node+python3-only host. Keep honest reporting of absent
   tier2 toolchains as informational.
5. **Single provision entry point.** Add `tt-run --provision [tier]`
   (or tt-provision-host): runs verify-environment for the tier +
   golden bootstrap for that tier's fixtures, idempotent, fail-closed
   with per-asset reasons. Document in the tt-run help text.

Proof (all zero-token, linux): lint self-test green; builder
determinism 2x identical; bare `./run-torture-test --tier1` GREEN x2;
`--provision tier1` idempotent second invocation no-op; hygiene canary
UNCHANGED. Darwin validation is the operator's post-merge step — do
not attempt to reach any remote host.

## Hard constraints

- Files ONLY inside torture-test/. Zero tokens. Live daemon untouched.
- Do not touch self-tests kill-path files (E3.C.1 may still be in
  flight); your lint/self-tests are NEW files.
- Golden determinism is sacred: hashes files regenerate only if the
  committed trees legitimately change (they should NOT for this task).
