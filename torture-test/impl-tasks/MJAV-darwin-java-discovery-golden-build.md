# MJAV: tt-java golden build fails on darwin — mvnw discovers Apple's java stub; env gate passes vacuously

Authorized scope: igorhvr's mac-torture directive (2026-09-01) — obvious mac-vs-linux differences, fix via
tamandua runs on the mac, bring back to linux. Suite files ONLY (torture-test/).

## Evidence (mac, 2026-09-02T00:58Z, ~/mac-torture-logs/v2b/PROVISION_FIXTURES.log)
- `run-torture-test --provision tier2 --rebuild-invalid`: tt-go/tt-poly/tt-rust built OK; **tt-java FAILED**
  `{"category":"golden-build-failed","message":"build-golden.sh exited non-zero","exit_code":1,
   "tail":["warning: templates not found in /dev/null", ...]}` — the tail carries no mvn/mvnw output.
- Host: `/usr/bin/java` and `/usr/bin/javac` are Apple's stubs ("The operation couldn't be completed. Unable to
  locate a Java Runtime."); `JAVA_HOME` unset; `mvn` is nix maven 3.9.16 whose wrapper bundles a Zulu JDK 21
  (`mvn -v` → "runtime: /nix/store/...zulu-ca-jdk-21.0.11/.../Contents/Home").
- `torture-test/fixtures-src/tt-java/build-golden.sh` runs `./mvnw -q -B ... test` (Maven WRAPPER); with
  JAVA_HOME unset mvnw discovers `java` on PATH → the stub → fails. Linux has a real `java` on PATH, so it passes.
- `tt-verify-environment` check `toolchain-java-maven` probes `mvn` (works via the bundled JDK) → PASS, so the
  environment gate certifies a host on which the fixture builder cannot run: a gate/builder mismatch.
- build-golden.sh captures `MVN_OUT="$(./mvnw ... 2>&1)"`, so the fail-closed reason never shows WHY mvnw failed.

## Fix (suite)
1. JDK discovery shared by the env gate and every mvnw-driven fixture builder (tt-java, tt-poly's java module,
   any other `mvnw` caller — grep torture-test/fixtures-src for mvnw): resolution order JAVA_HOME (if it points
   at a working `bin/java`) → the JDK `mvn -v` reports (parse the "runtime:" line) → `java` on PATH ONLY if it
   actually runs (`java -version` exit 0; Apple's stub exits non-zero). Export the resolved JAVA_HOME to mvnw.
   Put the resolver in ONE helper (e.g. torture-test/lib/jdk-discovery.sh) used by both sides.
2. `toolchain-java-maven` gate: probe the SAME path the builders use (the resolver + a tiny `mvnw`-equivalent
   compile/test in the probe dir), so the gate fails closed with a remedy (`export JAVA_HOME=...` or install a
   JDK via nix) when fixtures could not build. Record the resolved JDK path in host-profile.json.
3. build-golden.sh (and siblings): on mvnw failure include the LAST ~20 lines of mvnw stdout/stderr in the
   fail-closed reason `tail`, so the next darwin difference is diagnosable from the provision log alone.
4. Spec/README note for darwin operators: Apple ships a java stub; the suite resolves the JDK from maven or
   JAVA_HOME; nix `maven` alone is sufficient.

## Prove
- On this host (darwin): `./run-torture-test --provision tier2 --rebuild-invalid` → tt-java OK (built),
  hashes verified; `tt-verify-environment` java+maven check PASS with the resolved JDK path in the profile.
- Red-arm (scripted, portable): a fake PATH `java` that exits non-zero + a fake `mvn -v` reporting a runtime
  dir → resolver picks the mvn JDK; neither available → gate FAIL with remedy, builder fails closed with the
  mvnw tail visible.
- Full self-test battery green from repo root (darwin: pre-existing unrelated darwin failures listed in the
  MACP8 landing report may remain — name them explicitly; do not hide them).

## Story shape (mandatory — one gate per story; each proof story fits one worker round)

## Constraints
Files ONLY inside torture-test/. Never touch the live daemon or the operator's real HOME (no ~/.m2 pollution
beyond what mvnw already does — keep maven.repo.local under torture-test/var). No product code.
