/**
 * SUITE-BRIDGE US-003 — runtime candidate-binding negative controls.
 *
 * `scripts/tests/matchlock/fixtures/candidate-binding-test.sh` drives the REAL
 * `scripts/tests/matchlock/lib/common.sh` resolution step and a SIMULATED launch
 * boundary to prove the suite's candidate selection cannot silently fall back to
 * an installed binary:
 *
 *   - A1/A2: an explicitly requested candidate (suite spelling and product
 *     spelling) is what the boundary selects and execs, while a different
 *     `matchlock` shim sits FIRST on PATH;
 *   - B: a requested path that does not exist fails closed (nonzero, names the
 *     requested path) and invokes no boundary at all;
 *   - C: a present but chmod -x file, and a directory, fail closed the same way;
 *   - D: with no candidate requested, the PATH-resolved installed runtime is
 *     still selected and invoked exactly as before;
 *   - E: guest-init selection covers both spellings plus missing/non-executable
 *     fail-closed behaviour;
 *   - R: a relative explicit candidate reaches the boundary as an absolute path.
 *
 * HONESTY: the boundary shims in the fixture are simulations. They model the
 * product launcher's SELECTION step (resolve the documented env names, else a
 * PATH lookup) and journal + exec the selected file. They do NOT prove real
 * guest execution, VM boot or matchlock behaviour; the real-VM tiers remain the
 * only proof of that. This test therefore pins selection, nothing more.
 *
 * The fixture spawns `bash` (node:child_process) through this test, so this file
 * is classified in the serial lane and registered exactly once in
 * tests/serial-files.txt.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
// The REAL product resolution/probe path. `dist/` is built before the test
// lane runs (`./build`), exactly like every other `dist/`-importing suite
// test; importing the module directly keeps this regression tied to the
// shipping resolver instead of a suite-side re-implementation.
import {
  MATCHLOCK_RPC_BIN_ENV,
  probeMatchlockSwapSupport,
  resolveMatchlockSwapBinaryPath,
} from "../dist/installer/matchlock/swap-support.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const fixturePath = path.join(
  repoRoot,
  "scripts",
  "tests",
  "matchlock",
  "fixtures",
  "candidate-binding-test.sh",
);
const commonPath = path.join(repoRoot, "scripts", "tests", "matchlock", "lib", "common.sh");

/**
 * The decisive controls the fixture must report as `ok`. The matching assertion
 * lives inside the fixture; these labels keep the suite honest about which
 * negative control actually ran.
 */
const DECISIVE_CONTROLS = [
  // A1 — suite spelling vs PATH decoy
  "A1 rc=0",
  "A1 boundary selected the candidate (suite spelling)",
  "A1 boundary exec used the candidate",
  "A1 candidate shim actually ran",
  "A1 PATH decoy never ran",
  "A1 boundary never selected the PATH decoy",
  // A2 — product spelling vs PATH decoy
  "A2 rc=0",
  "A2 boundary selected the candidate (product spelling)",
  "A2 boundary exec used the candidate",
  "A2 candidate shim actually ran",
  "A2 PATH decoy never ran",
  // B — missing explicit candidate
  "B rc=2 (missing explicit candidate)",
  "B error names the requested missing path",
  "B boundary never invoked (no PATH fallback)",
  // C — non-executable + directory candidates
  "C1 rc=2 (non-executable candidate)",
  "C1 error names the non-executable file",
  "C1 boundary never invoked",
  "C2 rc=2 (directory candidate)",
  "C2 directory rejected as not-a-file",
  "C2 boundary never invoked",
  // D — no candidate: installed PATH runtime preserved
  "D rc=0 (no candidate)",
  "D PATH matchlock resolved (installed runtime preserved)",
  "D boundary exec used the PATH matchlock",
  "D PATH matchlock shim ran",
  "D guest-init boundary exec used the PATH guest-init",
  "D PATH guest-init shim ran",
  "D candidate matchlock never used",
  "D candidate guest-init never used",
  // E — guest-init selection + fail closed
  "E1 rc=0",
  "E1 guest boundary selected the candidate guest-init",
  "E1 candidate guest-init shim ran",
  "E1 PATH decoy guest-init never ran",
  "E2 rc=0",
  "E2 guest boundary selected the candidate guest-init",
  "E2 PATH decoy guest-init never ran",
  "E3 rc=2 (missing explicit guest-init)",
  "E3 error names the requested missing guest-init",
  "E3 guest boundary never invoked",
  "E4 rc=2 (non-executable guest-init)",
  "E4 error names the non-executable guest-init",
  "E4 guest boundary never invoked",
  // R — relative candidate absolutized at the boundary
  "R rc=0",
  "R relative candidate normalized to an absolute path",
  "R boundary received the absolute candidate",
  "R candidate shim ran",
] as const;

describe("Matchlock candidate-binding negative controls (SUITE-BRIDGE US-003)", () => {
  it("ships the candidate-binding fixture suite", () => {
    assert.ok(existsSync(fixturePath), `missing ${fixturePath}`);
  });

  it("passes every candidate-binding control with fail=0", () => {
    const tmp = tamanduaTempDir("mtlk-candidate-binding-");
    try {
      const script = [
        `export MTLK_CANDIDATE_FIXTURE_DIR='${tmp}'`,
        `exec bash '${fixturePath}'`,
      ].join("\n");
      const result = spawnSync("bash", ["-c", script], {
        cwd: repoRoot,
        encoding: "utf-8",
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      assert.equal(
        result.error,
        undefined,
        `failed to spawn the fixture: ${result.error?.message ?? "unknown"}`,
      );
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

      assert.equal(result.status, 0, `fixture suite failed (exit ${result.status}):\n${output}`);
      assert.ok(
        !output.includes("FIXTURE-FAIL"),
        `the fixture reported a failing control:\n${output}`,
      );

      const summary = output.match(/CANDIDATE-BINDING FIXTURES RESULT: pass=(\d+) fail=0/);
      assert.ok(summary, `expected a 'CANDIDATE-BINDING FIXTURES RESULT: pass=N fail=0' line:\n${output}`);
      assert.ok(
        Number(summary[1]) >= DECISIVE_CONTROLS.length,
        `expected at least ${DECISIVE_CONTROLS.length} passing controls, got ${summary[1]}`,
      );

      for (const label of DECISIVE_CONTROLS) {
        assert.ok(
          output.includes(`ok   - ${label}`),
          `decisive control did not pass: ${label}\n${output}`,
        );
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("labels its launch-boundary shims as simulations (selection only)", () => {
    // The fixture must never claim real guest execution from a simulated
    // boundary; the disclaimer is part of the contract.
    const text = readFileSync(fixturePath, "utf-8");
    assert.match(text, /SIMULATIONS/);
    assert.match(text, /do NOT prove real guest execution/i);
    assert.match(text, /t2–t4|t2-t4/, "the header must defer real execution to the VM tiers");
  });
});

// =============================================================================
// SUITE-BRIDGE US-004 — the REAL product resolver/probe at the launch boundary.
//
// US-003 proves the suite's selection with SIMULATED boundary shims. This
// block closes the remaining gap: the suite-resolved environment is fed into
// the SHIPPING product resolver (`resolveMatchlockSwapBinaryPath`) and the
// SHIPPING probe (`probeMatchlockSwapSupport`), which really spawns the
// selected binary. A real spawn is what makes the evidence "the launch
// boundary selected X", not merely "an env var was set".
//
// WHAT THIS STILL DOES NOT PROVE: no VM is booted and no guest executes. The
// matchlock/guest-init binaries here are journaling shims, so this regression
// proves SELECTION + real subprocess spawning only. Real guest execution stays
// the job of the t2–t4 VM tiers.
// =============================================================================

/** Single-quote a value for safe interpolation into a `bash -c` script. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readJournal(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf-8") : "";
}

/**
 * Write an executable `matchlock` shim. It journals every invocation (so the
 * journal — not an env echo — is the evidence of which binary ran) and answers
 * the two invocations the real probe makes: `run --help` advertises `--swap`
 * (so a correctly selected candidate is reported supported) and `--version`.
 */
function writeMatchlockShim(file: string, journal: string, identity: string): void {
  writeFileSync(
    file,
    `#!/usr/bin/env bash
set -u
printf 'shim=${identity} self=%s argv=%s\\n' "$0" "$*" >> ${shq(journal)}
case "$*" in
  *"run --help"*) printf 'Usage:\\n  matchlock run [flags]\\n      --swap int   swap size\\n'; exit 0 ;;
  --version) printf 'matchlock 9.9.9 (journaling test shim)\\n'; exit 0 ;;
esac
exit 0
`,
    "utf-8",
  );
  chmodSync(file, 0o755);
}

/** Write an executable `guest-init` shim that journals its own invocation. */
function writeGuestInitShim(file: string, journal: string, identity: string): void {
  writeFileSync(
    file,
    `#!/usr/bin/env bash
set -u
printf 'guest-init-shim=${identity} self=%s argv=%s\\n' "$0" "$*" >> ${shq(journal)}
exit 0
`,
    "utf-8",
  );
  chmodSync(file, 0o755);
}

interface SuiteResolution {
  status: number | null;
  output: string;
  /** Values printed by a CHILD bash after resolution, under both schemes. */
  vars: Record<string, string>;
}

describe("Matchlock candidate binding through the REAL product resolver (SUITE-BRIDGE US-004)", () => {
  let tmp = "";
  let candidateDir = "";
  let decoyDir = "";
  let basePath = "";
  let candidateJournal = "";
  let decoyJournal = "";
  let candidateGuestJournal = "";
  let decoyGuestJournal = "";
  let candidateMatchlock = "";
  let candidateGuestInit = "";
  let decoyMatchlock = "";
  let decoyGuestInit = "";

  function suitePath(): string {
    return `${decoyDir}:${basePath}`;
  }

  /**
   * Source the REAL `lib/common.sh`, call `mtlk_resolve_runtime`, then print
   * the resolved runtime from a CHILD bash so the values are proven to cross a
   * process boundary (not just a same-shell assignment). Runtime spellings are
   * unset first so no ambient request can leak into a control.
   */
  function resolveViaSuite(request: {
    spelling?: "suite" | "product";
    rpc?: string;
    guestInit?: string;
  }): SuiteResolution {
    const spelling = request.spelling ?? "suite";
    const lines = [
      "set -u",
      "unset MTLK_COMMON_SOURCED MTLK_MATCHLOCK_RPC_BIN MTLK_GUEST_INIT",
      "unset TAMANDUA_MATCHLOCK_RPC_BIN MATCHLOCK_GUEST_INIT MTLK_REQUIRE_GUEST_INIT",
      `export PATH=${shq(suitePath())}`,
      // A private HOME keeps common.sh's source-time defaults away from the
      // operator's real cache; it is not otherwise used by the controls.
      `export HOME=${shq(path.join(tmp, "home"))}`,
      request.rpc !== undefined
        ? `export ${spelling === "product" ? "TAMANDUA_MATCHLOCK_RPC_BIN" : "MTLK_MATCHLOCK_RPC_BIN"}=${shq(request.rpc)}`
        : "",
      request.guestInit !== undefined
        ? `export ${spelling === "product" ? "MATCHLOCK_GUEST_INIT" : "MTLK_GUEST_INIT"}=${shq(request.guestInit)}`
        : "",
      `source ${shq(commonPath)}`,
      "mtlk_resolve_runtime || exit $?",
      // Printed by a child process: this is the environment a launched child
      // inherits, both spellings, after the suite's export block.
      `bash -c ${shq(
        'printf "MTLK_RPC=%s\\n" "${MTLK_MATCHLOCK_RPC_BIN:-}"; ' +
          'printf "PRODUCT_RPC=%s\\n" "${TAMANDUA_MATCHLOCK_RPC_BIN:-}"; ' +
          'printf "MTLK_GUEST=%s\\n" "${MTLK_GUEST_INIT:-}"; ' +
          'printf "PRODUCT_GUEST=%s\\n" "${MATCHLOCK_GUEST_INIT:-}"',
      )}`,
    ].filter((line) => line !== "");

    const result = spawnSync("bash", ["-c", lines.join("\n")], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(
      result.error,
      undefined,
      `failed to spawn bash: ${result.error?.message ?? "unknown"}`,
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const vars: Record<string, string> = {};
    for (const line of (result.stdout ?? "").split(/\r?\n/)) {
      const idx = line.indexOf("=");
      if (idx > 0) vars[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return { status: result.status, output, vars };
  }

  /** The product-named environment a launched child would hand the resolver. */
  function productEnvFromSuite(resolved: SuiteResolution): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { PATH: suitePath() };
    if (resolved.vars.PRODUCT_RPC) env[MATCHLOCK_RPC_BIN_ENV] = resolved.vars.PRODUCT_RPC;
    if (resolved.vars.PRODUCT_GUEST) env.MATCHLOCK_GUEST_INIT = resolved.vars.PRODUCT_GUEST;
    return env;
  }

  function prepareScenario(): void {
    tmp = tamanduaTempDir("mtlk-real-product-binding-");
    candidateDir = path.join(tmp, "candidate");
    decoyDir = path.join(tmp, "decoy");
    const journals = path.join(tmp, "journals");
    mkdirSync(candidateDir, { recursive: true });
    mkdirSync(decoyDir, { recursive: true });
    mkdirSync(journals, { recursive: true });
    mkdirSync(path.join(tmp, "home"), { recursive: true });
    basePath = process.env.PATH ?? "/usr/bin:/bin";

    candidateJournal = path.join(journals, "candidate-matchlock.journal");
    decoyJournal = path.join(journals, "decoy-matchlock.journal");
    candidateGuestJournal = path.join(journals, "candidate-guest-init.journal");
    decoyGuestJournal = path.join(journals, "decoy-guest-init.journal");

    candidateMatchlock = path.join(candidateDir, "matchlock");
    candidateGuestInit = path.join(candidateDir, "guest-init");
    decoyMatchlock = path.join(decoyDir, "matchlock");
    decoyGuestInit = path.join(decoyDir, "guest-init");

    writeMatchlockShim(candidateMatchlock, candidateJournal, "candidate-matchlock");
    writeGuestInitShim(candidateGuestInit, candidateGuestJournal, "candidate-guest-init");
    // The decoy directory is FIRST on PATH in every control.
    writeMatchlockShim(decoyMatchlock, decoyJournal, "decoy-matchlock");
    writeGuestInitShim(decoyGuestInit, decoyGuestJournal, "decoy-guest-init");
  }

  function cleanupScenario(): void {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }

  it("pins the product env name the suite propagates to", () => {
    // If the product ever renames the override, the suite's dual-scheme
    // propagation would silently stop reaching the launcher again.
    assert.equal(MATCHLOCK_RPC_BIN_ENV, "TAMANDUA_MATCHLOCK_RPC_BIN");
  });

  it("A1: suite-spelling candidate beats a PATH decoy through the REAL resolver + probe", async () => {
    prepareScenario();
    try {
      const resolved = resolveViaSuite({ spelling: "suite", rpc: candidateMatchlock });
      assert.equal(resolved.status, 0, resolved.output);
      assert.equal(resolved.vars.MTLK_RPC, candidateMatchlock);
      assert.equal(resolved.vars.PRODUCT_RPC, candidateMatchlock);

      const env = productEnvFromSuite(resolved);
      // PATH still has the decoy first; only the propagated override can make
      // the product choose the candidate.
      assert.equal(resolveMatchlockSwapBinaryPath(env), candidateMatchlock);

      const probe = await probeMatchlockSwapSupport({ env, timeoutMs: 20_000 });
      assert.equal(probe.binaryPath, candidateMatchlock, "the real probe must spawn the candidate");
      assert.equal(probe.supported, true, probe.reason ?? "candidate shim advertises --swap");

      const candidateRan = readJournal(candidateJournal);
      assert.match(candidateRan, /shim=candidate-matchlock/, "the candidate shim must actually run");
      assert.ok(candidateRan.includes("run --help"), `probe argv missing:\n${candidateRan}`);
      assert.equal(readJournal(decoyJournal), "", "the PATH decoy must never be spawned");
    } finally {
      cleanupScenario();
    }
  });

  it("A2: product-spelling candidate beats a PATH decoy through the REAL resolver + probe", async () => {
    prepareScenario();
    try {
      const resolved = resolveViaSuite({ spelling: "product", rpc: candidateMatchlock });
      assert.equal(resolved.status, 0, resolved.output);
      assert.equal(resolved.vars.PRODUCT_RPC, candidateMatchlock);
      assert.equal(resolved.vars.MTLK_RPC, candidateMatchlock);

      const env = productEnvFromSuite(resolved);
      assert.equal(resolveMatchlockSwapBinaryPath(env), candidateMatchlock);

      const probe = await probeMatchlockSwapSupport({ env, timeoutMs: 20_000 });
      assert.equal(probe.binaryPath, candidateMatchlock);
      assert.equal(probe.supported, true, probe.reason ?? "candidate shim advertises --swap");

      assert.match(readJournal(candidateJournal), /shim=candidate-matchlock/);
      assert.equal(readJournal(decoyJournal), "", "the PATH decoy must never be spawned");
    } finally {
      cleanupScenario();
    }
  });

  it("B: a missing explicit candidate aborts before any probe (decoy never invoked)", async () => {
    prepareScenario();
    try {
      const missing = path.join(tmp, "does-not-exist-matchlock");
      const resolved = resolveViaSuite({ spelling: "suite", rpc: missing });
      assert.equal(resolved.status, 2, resolved.output);
      assert.ok(
        resolved.output.includes(`MTLK-ABORT matchlock-candidate-missing ${missing}`),
        `expected the requested path in the abort:\n${resolved.output}`,
      );
      assert.equal(resolved.vars.PRODUCT_RPC, undefined, "no product value may be fabricated");
      assert.equal(readJournal(decoyJournal), "", "no probe may reach the PATH decoy");
      assert.equal(readJournal(candidateJournal), "");
    } finally {
      cleanupScenario();
    }
  });

  it("C1: a non-executable explicit candidate aborts before any probe", async () => {
    prepareScenario();
    try {
      const nonexec = path.join(tmp, "nonexec-matchlock");
      writeFileSync(nonexec, "#!/usr/bin/env bash\nexit 0\n", "utf-8");
      chmodSync(nonexec, 0o644);

      const resolved = resolveViaSuite({ spelling: "suite", rpc: nonexec });
      assert.equal(resolved.status, 2, resolved.output);
      assert.ok(
        resolved.output.includes(`MTLK-ABORT matchlock-candidate-not-executable ${nonexec}`),
        `expected the non-executable path in the abort:\n${resolved.output}`,
      );
      assert.equal(resolved.vars.PRODUCT_RPC, undefined);
      assert.equal(readJournal(decoyJournal), "", "no probe may reach the PATH decoy");
    } finally {
      cleanupScenario();
    }
  });

  it("C2: a directory candidate aborts as not-a-file before any probe", async () => {
    prepareScenario();
    try {
      const dirCandidate = path.join(tmp, "dir-matchlock");
      mkdirSync(dirCandidate, { recursive: true });

      const resolved = resolveViaSuite({ spelling: "suite", rpc: dirCandidate });
      assert.equal(resolved.status, 2, resolved.output);
      assert.ok(
        resolved.output.includes(`MTLK-ABORT matchlock-candidate-not-a-file ${dirCandidate}`),
        `expected not-a-file in the abort:\n${resolved.output}`,
      );
      assert.equal(readJournal(decoyJournal), "");
    } finally {
      cleanupScenario();
    }
  });

  it("D: with no candidate the REAL resolver and probe use the installed PATH runtime", async () => {
    prepareScenario();
    try {
      const resolved = resolveViaSuite({});
      assert.equal(resolved.status, 0, resolved.output);
      // The suite's own resolution still finds the PATH runtime and propagates
      // it under both schemes (US-002), which is the installed-runtime path.
      assert.equal(resolved.vars.MTLK_RPC, decoyMatchlock);
      assert.equal(resolved.vars.PRODUCT_RPC, decoyMatchlock);
      assert.equal(resolved.vars.MTLK_GUEST, decoyGuestInit);
      assert.equal(resolved.vars.PRODUCT_GUEST, decoyGuestInit);

      // Suite-propagated environment.
      assert.equal(
        resolveMatchlockSwapBinaryPath(productEnvFromSuite(resolved)),
        decoyMatchlock,
      );
      // Installed behaviour in its purest form: PATH only, no override at all.
      const installedEnv: NodeJS.ProcessEnv = { PATH: suitePath() };
      assert.equal(resolveMatchlockSwapBinaryPath(installedEnv), decoyMatchlock);

      const probe = await probeMatchlockSwapSupport({ env: installedEnv, timeoutMs: 20_000 });
      assert.equal(probe.binaryPath, decoyMatchlock);
      assert.equal(probe.supported, true, probe.reason ?? "decoy shim advertises --swap");
      assert.match(readJournal(decoyJournal), /shim=decoy-matchlock/);
      assert.equal(readJournal(candidateJournal), "", "no candidate was requested, so none may run");
    } finally {
      cleanupScenario();
    }
  });

  it("E: guest-init selection crosses a SIMULATED matchlock child boundary", () => {
    // HONESTY: the child below is a SIMULATION of the matchlock launch step —
    // it only reads the inherited guest-init override and execs it. This does
    // NOT boot a VM and does NOT prove real guest execution.
    prepareScenario();
    try {
      const resolved = resolveViaSuite({ spelling: "suite", guestInit: candidateGuestInit });
      assert.equal(resolved.status, 0, resolved.output);
      assert.equal(resolved.vars.MTLK_GUEST, candidateGuestInit);
      assert.equal(resolved.vars.PRODUCT_GUEST, candidateGuestInit);

      const simulatedChild = path.join(tmp, "simulated-matchlock-child.sh");
      const childJournal = path.join(tmp, "journals", "simulated-child.journal");
      writeFileSync(
        simulatedChild,
        `#!/usr/bin/env bash
# SIMULATED matchlock launch step: reads the inherited guest-init override and
# execs it. No VM, no real guest execution.
set -u
selected="\${MATCHLOCK_GUEST_INIT:-}"
printf 'simulated-matchlock-child selected=%s\\n' "\${selected:-<unset>}" >> ${shq(childJournal)}
[ -n "$selected" ] || exit 2
exec "$selected" --guest-probe
`,
        "utf-8",
      );
      chmodSync(simulatedChild, 0o755);

      // The child inherits the PRODUCT spelling exactly as the suite exported
      // it; the suite spelling is passed too so a mismatch would show up.
      const childEnv: NodeJS.ProcessEnv = {
        PATH: suitePath(),
        [MATCHLOCK_RPC_BIN_ENV]: resolved.vars.PRODUCT_RPC ?? "",
        MATCHLOCK_GUEST_INIT: resolved.vars.PRODUCT_GUEST,
        MTLK_GUEST_INIT: resolved.vars.MTLK_GUEST,
      };
      const child = spawnSync("bash", [simulatedChild, "--guest-probe"], {
        env: childEnv,
        encoding: "utf-8",
        timeout: 60_000,
      });
      assert.equal(child.error, undefined, child.error?.message);
      assert.equal(child.status, 0, `simulated child failed: ${child.stdout}${child.stderr}`);

      assert.match(readJournal(childJournal), /selected=/);
      assert.ok(
        readJournal(childJournal).includes(`selected=${candidateGuestInit}`),
        "the simulated child must inherit the candidate guest-init",
      );
      assert.match(
        readJournal(candidateGuestJournal),
        /guest-init-shim=candidate-guest-init/,
        "the candidate guest-init must be the one the simulated child execs",
      );
      assert.equal(readJournal(decoyGuestJournal), "", "the PATH decoy guest-init must never run");
    } finally {
      cleanupScenario();
    }
  });
});
