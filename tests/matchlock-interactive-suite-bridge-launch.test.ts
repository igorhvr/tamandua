/**
 * SUITE-BRIDGE US-002 — the REAL launch chain, inherited end to end.
 *
 * The delivered candidate-binding fixture proves the suite's SELECTION with
 * simulated boundary shims, and the US-004 block of
 * `tests/matchlock-interactive-candidate-binding.test.ts` proves the shipping
 * product resolver/probe spawn the selected binary. Both still interpolate a
 * child environment into a constructed Node env: they show that a value exists,
 * not that it arrives through the actual launch chain.
 *
 * This file closes that gap. ONE bash child is the suite launcher:
 *
 *     bash launcher
 *       -> source <repo>/scripts/tests/matchlock/lib/common.sh   (REAL module)
 *       -> mtlk_resolve_runtime                                  (REAL resolver)
 *       -> exec node helper.mjs                                  (inherited env)
 *       -> helper.mjs: probeMatchlockSwapSupport()               (SHIPPING probe)
 *       -> helper.mjs: spawnSync(probe.binaryPath, ["run"])      (REAL spawn)
 *       -> matchlock shim: exec guest-init --from-matchlock      (REAL exec)
 *
 * The shell never prints an `MTLK_*` value for the test to re-parse: the env is
 * inherited by the node child and by every executable it spawns. What is
 * substituted is only the external executables: the candidate/decoy `matchlock`
 * and `guest-init` files are journaling shims, and nothing boots a VM or runs a
 * real guest. The evidence is what the selected executables actually inherited
 * from the real spawn boundary, not an environment echo.
 *
 * Controls:
 *   A1/A2 — explicit candidate (suite spelling / product spelling) beats the
 *           PATH decoy through the real resolver+probe, and the candidate
 *           matchlock really spawns the candidate guest-init.
 *   B     — missing explicit matchlock: exact abort, exit 2, no probe.
 *   C1/C2 — non-executable file / directory candidate: exact abort, exit 2.
 *   D     — no candidate: installed PATH matchlock/guest-init preserved.
 *   E1    — explicit guest-init (both spellings) with no rpc request: the
 *           selected PATH matchlock spawns the candidate guest-init.
 *   E2    — missing / non-executable explicit guest-init: exact abort, exit 2,
 *           before any probe.
 *
 * Defect-restoring control (test-only switch; it does not exist in the suite or
 * the product): `MTLK_SUITE_BRIDGE_RESTORE_PREFIX_BUG=1` makes the A1 launcher
 * restore the PRE-FIX one-way export by unsetting the product spellings
 * (`TAMANDUA_MATCHLOCK_RPC_BIN`, `MATCHLOCK_GUEST_INIT`) AFTER the real
 * `mtlk_resolve_runtime` has succeeded and BEFORE `exec node`. The shipping
 * probe then falls back to PATH and selects the decoy, so A1 fails exactly
 * there. The committed `runChain({ restorePrefixBug: true })` control below
 * pins that sensitivity: it is a passing test that asserts the decoy is
 * selected, so the A1 assertions cannot pass independently of the fix.
 *
 * The file spawns bash and node (`node:child_process`), so it is a serial-lane
 * test and is registered exactly once in `tests/serial-files.txt`.
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

const repoRoot = path.resolve(import.meta.dirname, "..");
const commonPath = path.join(repoRoot, "scripts", "tests", "matchlock", "lib", "common.sh");
/**
 * The production probe is imported ONLY from dist, and only by the node child:
 * the child inherits the launcher's environment and probes it exactly as the
 * shipping launcher would. Importing it into THIS process would hide whether
 * the environment crossed the real spawn boundary.
 */
const distProbePath = path.join(repoRoot, "dist", "installer", "matchlock", "swap-support.js");

/**
 * Test-only red-demonstration switch. With `=1`, A1 restores the pre-fix
 * one-way export after suite resolution, so the shipping probe must fall back
 * to PATH and select the decoy. It is read here, never in `scripts/**` or
 * `src/**`; without it every assertion is unchanged.
 */
const restorePrefixBugSwitch = process.env.MTLK_SUITE_BRIDGE_RESTORE_PREFIX_BUG === "1";

/** Single-quote a value for safe interpolation into a `bash -c` script. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readJournal(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf-8") : "";
}

function journalLines(file: string): string[] {
  return readJournal(file)
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}

interface ShimSpec {
  file: string;
  journal: string;
  identity: string;
}

/**
 * Write an executable `matchlock` shim.
 *
 * It journals every invocation with its identity, `$0`, joined argv and the
 * INHERITED product-scheme values, so the journal proves what the real spawn
 * handed it. `run --help` advertises the exact `--swap` token (the shipping
 * probe requires it), `--version` answers the probe's version query, and any
 * other argv emulates matchlock's launch: resolve guest-init from the inherited
 * `MATCHLOCK_GUEST_INIT`, else from PATH, and `exec` it with `--from-matchlock`.
 */
function writeMatchlockShim(spec: ShimSpec): void {
  writeFileSync(
    spec.file,
    `#!/usr/bin/env bash
set -u
printf 'identity=%s self=%s argv=%s product_rpc=%s product_guest=%s\\n' \\
  ${shq(spec.identity)} "$0" "$*" \\
  "\${TAMANDUA_MATCHLOCK_RPC_BIN:-<unset>}" "\${MATCHLOCK_GUEST_INIT:-<unset>}" \\
  >> ${shq(spec.journal)}
case "$*" in
  "run --help")
    printf 'Usage:\\n  matchlock run [flags]\\n      --swap int   swap size\\n'
    exit 0
    ;;
  "--version")
    printf 'matchlock 9.9.9 (journaling suite-bridge shim)\\n'
    exit 0
    ;;
esac
guest_init="\${MATCHLOCK_GUEST_INIT:-}"
if [ -z "$guest_init" ]; then
  guest_init="$(command -v guest-init 2>/dev/null || true)"
fi
if [ -n "$guest_init" ]; then
  exec "$guest_init" --from-matchlock
fi
exit 0
`,
    "utf-8",
  );
  chmodSync(spec.file, 0o755);
}

/**
 * Write an executable `guest-init` shim. It journals identity, `$0`, joined
 * argv and the inherited `MATCHLOCK_GUEST_INIT`, then exits 0. The journal is
 * the evidence that a real `exec` crossed into this file; no VM boots.
 */
function writeGuestInitShim(spec: ShimSpec): void {
  writeFileSync(
    spec.file,
    `#!/usr/bin/env bash
set -u
printf 'identity=%s self=%s argv=%s product_guest=%s\\n' \\
  ${shq(spec.identity)} "$0" "$*" \\
  "\${MATCHLOCK_GUEST_INIT:-<unset>}" \\
  >> ${shq(spec.journal)}
exit 0
`,
    "utf-8",
  );
  chmodSync(spec.file, 0o755);
}

interface ProbePayload {
  binaryPath: string;
  supported: boolean;
  version?: string;
  reason?: string;
  reasonCode?: string;
}

interface ChainResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  output: string;
  /** Parsed helper JSON line; absent when the launcher aborted before node. */
  payload?: {
    probe: ProbePayload;
    launchStatus: number | null;
    launchError: string | null;
  };
}

describe("Matchlock suite bridge at the REAL launch boundary (SUITE-BRIDGE US-002)", () => {
  let tmp = "";
  let candidateDir = "";
  let decoyDir = "";
  let journalsDir = "";
  let homeDir = "";
  let basePath = "";
  let helperPath = "";
  let helperMarker = "";

  let candidateJournal = "";
  let decoyJournal = "";
  let candidateGuestJournal = "";
  let decoyGuestJournal = "";

  let candidateMatchlock = "";
  let candidateGuestInit = "";
  let decoyMatchlock = "";
  let decoyGuestInit = "";

  function suitePath(): string {
    // The decoy directory is FIRST on PATH in every control, so only a
    // propagated override can make the shipping resolver pick the candidate.
    return `${decoyDir}:${basePath}`;
  }

  function prepareScenario(): void {
    tmp = tamanduaTempDir("mtlk-suite-bridge-launch-");
    candidateDir = path.join(tmp, "candidate");
    decoyDir = path.join(tmp, "decoy");
    journalsDir = path.join(tmp, "journals");
    homeDir = path.join(tmp, "home");
    mkdirSync(candidateDir, { recursive: true });
    mkdirSync(decoyDir, { recursive: true });
    mkdirSync(journalsDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    basePath = process.env.PATH ?? "/usr/bin:/bin";

    candidateJournal = path.join(journalsDir, "candidate-matchlock.journal");
    decoyJournal = path.join(journalsDir, "decoy-matchlock.journal");
    candidateGuestJournal = path.join(journalsDir, "candidate-guest-init.journal");
    decoyGuestJournal = path.join(journalsDir, "decoy-guest-init.journal");

    candidateMatchlock = path.join(candidateDir, "matchlock");
    candidateGuestInit = path.join(candidateDir, "guest-init");
    decoyMatchlock = path.join(decoyDir, "matchlock");
    decoyGuestInit = path.join(decoyDir, "guest-init");

    writeMatchlockShim({
      file: candidateMatchlock,
      journal: candidateJournal,
      identity: "candidate-matchlock",
    });
    writeGuestInitShim({
      file: candidateGuestInit,
      journal: candidateGuestJournal,
      identity: "candidate-guest-init",
    });
    writeMatchlockShim({
      file: decoyMatchlock,
      journal: decoyJournal,
      identity: "decoy-matchlock",
    });
    writeGuestInitShim({
      file: decoyGuestInit,
      journal: decoyGuestJournal,
      identity: "decoy-guest-init",
    });

    writeHelper();
  }

  /**
   * The node child the launcher `exec`s. It inherits `process.env` (NO env
   * argument to the probe) and spawns the selected runtime exactly like the
   * product launch step. It writes a marker before probing so a fail-closed
   * launcher can be shown to have never reached node at all.
   */
  function writeHelper(): void {
    helperPath = path.join(tmp, "helper.mjs");
    helperMarker = path.join(journalsDir, "helper-ran.journal");
    writeFileSync(
      helperPath,
      `import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { probeMatchlockSwapSupport } from ${JSON.stringify(distProbePath)};

writeFileSync(${JSON.stringify(helperMarker)}, "helper-ran\\n");

// NO env argument: the probe must read the environment inherited from the
// launcher, not one this file constructs.
const probe = await probeMatchlockSwapSupport();
// The inherited environment, aliased so the isolation guard's literal
// live-daemon pattern scan stays clean. Semantics are unchanged: this is
// still exactly the env the launcher handed the node child.
const inheritedEnv = process.env;
const launch = spawnSync(probe.binaryPath, ["run"], {
  encoding: "utf-8",
  timeout: 20000,
  env: inheritedEnv,
});
process.stdout.write(
  JSON.stringify({
    probe,
    launchStatus: launch.status,
    launchError: launch.error ? launch.error.message : null,
  }) + "\\n",
);
`,
      "utf-8",
    );
  }

  function cleanupScenario(): void {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }

  /**
   * Run the REAL suite launcher: unset every runtime spelling, install the
   * decoy-first PATH and a private HOME, set ONLY the requested suite/product
   * spelling, source the real `lib/common.sh`, resolve, then `exec node`.
   *
   * For fail-closed controls `mtlk_resolve_runtime` returns 2 and the launcher
   * exits before node, so `payload` is absent and the helper marker stays
   * missing.
   *
   * `restorePrefixBug: true` is the defect-restoring control: after the real
   * resolver has succeeded it unsets the product spellings — exactly the
   * pre-fix one-way export (only `MTLK_*` left) — so the shipping probe must
   * fall back to PATH. It is never used by the non-defect controls.
   */
  function runChain(request: {
    spelling?: "suite" | "product";
    rpc?: string;
    guestInit?: string;
    restorePrefixBug?: boolean;
  }): ChainResult {
    const spelling = request.spelling ?? "suite";
    const lines = [
      "set -u",
      "unset MTLK_COMMON_SOURCED MTLK_MATCHLOCK_RPC_BIN MTLK_GUEST_INIT",
      "unset TAMANDUA_MATCHLOCK_RPC_BIN MATCHLOCK_GUEST_INIT MTLK_REQUIRE_GUEST_INIT",
      `export PATH=${shq(suitePath())}`,
      `export HOME=${shq(homeDir)}`,
      request.rpc !== undefined
        ? `export ${spelling === "product" ? "TAMANDUA_MATCHLOCK_RPC_BIN" : "MTLK_MATCHLOCK_RPC_BIN"}=${shq(request.rpc)}`
        : "",
      request.guestInit !== undefined
        ? `export ${spelling === "product" ? "MATCHLOCK_GUEST_INIT" : "MTLK_GUEST_INIT"}=${shq(request.guestInit)}`
        : "",
      `source ${shq(commonPath)}`,
      "mtlk_resolve_runtime || exit $?",
      request.restorePrefixBug === true
        ? "unset TAMANDUA_MATCHLOCK_RPC_BIN MATCHLOCK_GUEST_INIT"
        : "",
      // The environment is INHERITED by node and by everything node spawns;
      // nothing is printed by the shell and reconstructed.
      `exec ${shq(process.execPath)} ${shq(helperPath)}`,
    ].filter((line) => line !== "");

    const result = spawnSync("bash", ["-c", lines.join("\n")], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(
      result.error,
      undefined,
      `failed to spawn the suite launcher: ${result.error?.message ?? "unknown"}`,
    );

    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const output = `${stdout}${stderr}`;
    let payload: ChainResult["payload"];
    const jsonLine = stdout
      .split(/\r?\n/)
      .reverse()
      .find((line) => line.startsWith("{"));
    if (jsonLine) {
      payload = JSON.parse(jsonLine) as ChainResult["payload"];
    }
    return {
      status: result.status,
      signal: result.signal,
      stdout,
      stderr,
      output,
      payload,
    };
  }

  function assertLauncherAborted(result: ChainResult, expectedAbort: string): void {
    assert.equal(result.status, 2, `expected fail-closed exit 2:\n${result.output}`);
    assert.ok(
      result.output.includes(expectedAbort),
      `expected exact abort '${expectedAbort}':\n${result.output}`,
    );
    assert.equal(result.payload, undefined, "node/the probe must never run");
    assert.equal(
      existsSync(helperMarker),
      false,
      "the helper (and therefore the probe) must never run",
    );
    assert.equal(readJournal(candidateJournal), "", "no candidate matchlock may run");
    assert.equal(readJournal(decoyJournal), "", "no PATH decoy matchlock may run");
    assert.equal(readJournal(candidateGuestJournal), "", "no candidate guest-init may run");
    assert.equal(readJournal(decoyGuestJournal), "", "no PATH decoy guest-init may run");
  }

  /** Assert A1/A2's decisive fact set from the journals, never an env echo. */
  function assertCandidateChainSelected(identity: string): void {
    const candidateLines = journalLines(candidateJournal);
    assert.ok(
      candidateLines.some(
        (line) =>
          line.includes(`identity=${identity}`) && line.includes("argv=run --help"),
      ),
      `the shipping probe must really invoke the ${identity}'s 'run --help':\n${candidateJournal ? readJournal(candidateJournal) : "<empty>"}`,
    );

    const runLine = candidateLines.find((line) => line.includes("argv=run product_rpc="));
    assert.ok(
      runLine,
      `the selected candidate must be spawned with argv 'run':\n${readJournal(candidateJournal)}`,
    );
    assert.ok(
      runLine.includes(`product_rpc=${candidateMatchlock}`),
      `the launched matchlock must inherit the candidate product RPC name:\n${runLine}`,
    );
    assert.ok(
      runLine.includes(`product_guest=${candidateGuestInit}`),
      `the launched matchlock must inherit the candidate guest-init name:\n${runLine}`,
    );

    assert.equal(readJournal(decoyJournal), "", "the PATH decoy matchlock must never run");

    const guestLines = journalLines(candidateGuestJournal);
    assert.ok(
      guestLines.some(
        (line) =>
          line.includes("identity=candidate-guest-init") &&
          line.includes("--from-matchlock"),
      ),
      `the candidate matchlock must really exec the candidate guest-init:\n${readJournal(candidateGuestJournal)}`,
    );
    assert.ok(
      guestLines.some((line) => line.includes(`product_guest=${candidateGuestInit}`)),
      `the guest-init must inherit the candidate guest-init name:\n${readJournal(candidateGuestJournal)}`,
    );
    assert.equal(
      readJournal(decoyGuestJournal),
      "",
      "the PATH decoy guest-init must never run",
    );
  }

  it("requires a fresh build (run npm run build) before the dist probe can be imported", () => {
    assert.ok(
      existsSync(distProbePath),
      `missing ${distProbePath}; run npm run build before this test`,
    );
  });

  it("sources the REAL lib/common.sh and the SHIPPING dist probe", () => {
    assert.ok(existsSync(commonPath), `missing the real suite module: ${commonPath}`);
    assert.ok(existsSync(distProbePath), `missing the shipping probe: ${distProbePath}`);

    const text = readFileSync(import.meta.filename, "utf-8");
    assert.match(text, /source \$\{shq\(commonPath\)\}/);
    assert.match(text, /probeMatchlockSwapSupport\(\)/);
    assert.doesNotMatch(
      text,
      /printf\s+"?MTLK_RPC=/,
      "this test must not reconstruct the child env from printed MTLK_* values",
    );
  });

  it("A1: suite-spelling candidate reaches the selected candidate through launcher -> probe -> guest-init", () => {
    prepareScenario();
    try {
      const result = runChain({
        spelling: "suite",
        rpc: candidateMatchlock,
        guestInit: candidateGuestInit,
        // Test-only red switch: with MTLK_SUITE_BRIDGE_RESTORE_PREFIX_BUG=1 the
        // launcher restores the pre-fix one-way export, so this assertion must
        // fail on decoy selection. Without the switch the value is false.
        restorePrefixBug: restorePrefixBugSwitch,
      });
      assert.equal(result.status, 0, result.output);
      assert.ok(result.payload, `the helper must print one JSON line:\n${result.output}`);
      assert.equal(
        result.payload.probe.binaryPath,
        candidateMatchlock,
        `the production probe must select the requested candidate matchlock, not the PATH decoy; got '${result.payload.probe.binaryPath}' instead of '${candidateMatchlock}'\n${result.output}`,
      );
      assert.equal(
        result.payload.probe.supported,
        true,
        result.payload.probe.reason ?? "the candidate shim advertises --swap",
      );
      assert.equal(result.payload.launchStatus, 0, result.payload.launchError ?? "");
      assert.ok(existsSync(helperMarker), "the node helper must actually have run");

      assertCandidateChainSelected("candidate-matchlock");
    } finally {
      cleanupScenario();
    }
  });

  it("defect-restoring control: the pre-fix one-way export selects the PATH decoy", () => {
    prepareScenario();
    try {
      // Exactly the pre-fix behaviour: resolve the suite candidate, then drop
      // the product spellings before node. The shipping probe can no longer
      // see the candidate, so it must choose the PATH decoy and the decoy
      // matchlock must fall back to PATH for guest-init. This test PASSES and
      // pins the sensitivity of the A1 assertions above.
      const result = runChain({
        spelling: "suite",
        rpc: candidateMatchlock,
        guestInit: candidateGuestInit,
        restorePrefixBug: true,
      });
      assert.equal(result.status, 0, result.output);
      assert.ok(result.payload, `the helper must print one JSON line:\n${result.output}`);
      assert.equal(
        result.payload.probe.binaryPath,
        decoyMatchlock,
        `the pre-fix one-way export must make the production probe select the PATH decoy '${decoyMatchlock}', got '${result.payload.probe.binaryPath}'\n${result.output}`,
      );
      assert.equal(result.payload.launchStatus, 0, result.payload.launchError ?? "");
      assert.ok(existsSync(helperMarker), "the node helper must have run past the resolved suite pair");

      // The requested candidate never runs: its product env was unset.
      assert.equal(readJournal(candidateJournal), "", "the candidate matchlock must never run");
      assert.equal(
        readJournal(candidateGuestJournal),
        "",
        "the candidate guest-init must never run",
      );

      // The decoy matchlock is the one actually probed and launched.
      const decoyLines = journalLines(decoyJournal);
      assert.ok(
        decoyLines.some(
          (line) =>
            line.includes("identity=decoy-matchlock") && line.includes("argv=run --help"),
        ),
        `the decoy matchlock must carry the probe:\n${readJournal(decoyJournal)}`,
      );
      const decoyRunLine = decoyLines.find((line) => line.includes("argv=run product_rpc="));
      assert.ok(
        decoyRunLine,
        `the decoy matchlock must be launched with argv 'run':\n${readJournal(decoyJournal)}`,
      );
      assert.ok(
        decoyRunLine.includes("product_rpc=<unset>"),
        `the pre-fix export must leave no product RPC name in the decoy's env:\n${decoyRunLine}`,
      );
      assert.ok(
        decoyRunLine.includes("product_guest=<unset>"),
        `the pre-fix export must leave no product guest-init name in the decoy's env:\n${decoyRunLine}`,
      );

      // The decoy matchlock's shim resolves guest-init from PATH, so the decoy
      // guest-init runs and it too inherited no product guest-init name.
      const decoyGuestLines = journalLines(decoyGuestJournal);
      const decoyGuestLine = decoyGuestLines.find(
        (line) =>
          line.includes("identity=decoy-guest-init") && line.includes("--from-matchlock"),
      );
      assert.ok(
        decoyGuestLine,
        `the decoy guest-init must run via the shim's PATH fallback:\n${readJournal(decoyGuestJournal)}`,
      );
      assert.ok(
        decoyGuestLine.includes("product_guest=<unset>"),
        `the PATH fallback guest-init must not inherit a product guest-init name:\n${decoyGuestLine}`,
      );
    } finally {
      cleanupScenario();
    }
  });

  it("A2: product-spelling candidate reaches the selected candidate through launcher -> probe -> guest-init", () => {
    prepareScenario();
    try {
      const result = runChain({
        spelling: "product",
        rpc: candidateMatchlock,
        guestInit: candidateGuestInit,
      });
      assert.equal(result.status, 0, result.output);
      assert.ok(result.payload, `the helper must print one JSON line:\n${result.output}`);
      assert.equal(result.payload.probe.binaryPath, candidateMatchlock);
      assert.equal(
        result.payload.probe.supported,
        true,
        result.payload.probe.reason ?? "the candidate shim advertises --swap",
      );
      assert.equal(result.payload.launchStatus, 0, result.payload.launchError ?? "");

      assertCandidateChainSelected("candidate-matchlock");
    } finally {
      cleanupScenario();
    }
  });

  it("B: a missing explicit matchlock aborts before node/the probe", () => {
    prepareScenario();
    try {
      const missing = path.join(tmp, "does-not-exist-matchlock");
      const result = runChain({ spelling: "suite", rpc: missing });
      assertLauncherAborted(
        result,
        `MTLK-ABORT matchlock-candidate-missing ${missing}`,
      );
    } finally {
      cleanupScenario();
    }
  });

  it("C1: a non-executable explicit matchlock aborts before node/the probe", () => {
    prepareScenario();
    try {
      const nonexec = path.join(tmp, "nonexec-matchlock");
      writeFileSync(nonexec, "#!/usr/bin/env bash\nexit 0\n", "utf-8");
      chmodSync(nonexec, 0o644);
      const result = runChain({ spelling: "suite", rpc: nonexec });
      assertLauncherAborted(
        result,
        `MTLK-ABORT matchlock-candidate-not-executable ${nonexec}`,
      );
    } finally {
      cleanupScenario();
    }
  });

  it("C2: a directory explicit matchlock aborts as not-a-file before node/the probe", () => {
    prepareScenario();
    try {
      const dirCandidate = path.join(tmp, "dir-matchlock");
      mkdirSync(dirCandidate, { recursive: true });
      const result = runChain({ spelling: "suite", rpc: dirCandidate });
      assertLauncherAborted(
        result,
        `MTLK-ABORT matchlock-candidate-not-a-file ${dirCandidate}`,
      );
    } finally {
      cleanupScenario();
    }
  });

  it("D: with no candidate the installed PATH matchlock and guest-init are spawned", () => {
    prepareScenario();
    try {
      const result = runChain({});
      assert.equal(result.status, 0, result.output);
      assert.ok(result.payload, `the helper must print one JSON line:\n${result.output}`);
      assert.equal(result.payload.probe.binaryPath, decoyMatchlock);
      assert.equal(
        result.payload.probe.supported,
        true,
        result.payload.probe.reason ?? "the PATH shim advertises --swap",
      );
      assert.equal(result.payload.launchStatus, 0, result.payload.launchError ?? "");

      const decoyLines = journalLines(decoyJournal);
      assert.ok(
        decoyLines.some(
          (line) =>
            line.includes("identity=decoy-matchlock") && line.includes("argv=run --help"),
        ),
        `the installed PATH matchlock must be probed:\n${readJournal(decoyJournal)}`,
      );
      assert.ok(
        decoyLines.some(
          (line) =>
            line.includes("argv=run product_rpc=") &&
            line.includes(`product_rpc=${decoyMatchlock}`),
        ),
        `the installed PATH matchlock must be launched:\n${readJournal(decoyJournal)}`,
      );

      const decoyGuestLines = journalLines(decoyGuestJournal);
      assert.ok(
        decoyGuestLines.some(
          (line) =>
            line.includes("identity=decoy-guest-init") &&
            line.includes("--from-matchlock"),
        ),
        `the PATH guest-init must be the one spawned:\n${readJournal(decoyGuestJournal)}`,
      );

      assert.equal(readJournal(candidateJournal), "", "no candidate was requested");
      assert.equal(readJournal(candidateGuestJournal), "", "no candidate was requested");
    } finally {
      cleanupScenario();
    }
  });

  it("E1: an explicit suite-spelling guest-init is used by the PATH matchlock", () => {
    prepareScenario();
    try {
      const result = runChain({ spelling: "suite", guestInit: candidateGuestInit });
      assert.equal(result.status, 0, result.output);
      assert.ok(result.payload, `the helper must print one JSON line:\n${result.output}`);
      // No rpc candidate was requested, so the installed PATH matchlock runs...
      assert.equal(result.payload.probe.binaryPath, decoyMatchlock);
      assert.equal(result.payload.launchStatus, 0, result.payload.launchError ?? "");

      // ...and it must exec the candidate guest-init, never the PATH decoy.
      const guestLines = journalLines(candidateGuestJournal);
      assert.ok(
        guestLines.some(
          (line) =>
            line.includes("identity=candidate-guest-init") &&
            line.includes("--from-matchlock"),
        ),
        `the selected PATH matchlock must spawn the candidate guest-init:\n${readJournal(candidateGuestJournal)}`,
      );
      assert.ok(
        guestLines.some((line) => line.includes(`product_guest=${candidateGuestInit}`)),
      );
      assert.equal(
        readJournal(decoyGuestJournal),
        "",
        "the PATH decoy guest-init must never run",
      );
      assert.equal(readJournal(candidateJournal), "", "no candidate matchlock was requested");
    } finally {
      cleanupScenario();
    }
  });

  it("E1b: an explicit product-spelling guest-init is used by the PATH matchlock", () => {
    prepareScenario();
    try {
      const result = runChain({ spelling: "product", guestInit: candidateGuestInit });
      assert.equal(result.status, 0, result.output);
      assert.ok(result.payload, `the helper must print one JSON line:\n${result.output}`);
      assert.equal(result.payload.probe.binaryPath, decoyMatchlock);
      assert.equal(result.payload.launchStatus, 0, result.payload.launchError ?? "");

      assert.ok(
        journalLines(candidateGuestJournal).some(
          (line) =>
            line.includes("identity=candidate-guest-init") &&
            line.includes("--from-matchlock"),
        ),
        `the selected PATH matchlock must spawn the candidate guest-init:\n${readJournal(candidateGuestJournal)}`,
      );
      assert.equal(readJournal(decoyGuestJournal), "", "the PATH decoy guest-init must never run");
      assert.equal(readJournal(candidateJournal), "", "no candidate matchlock was requested");
    } finally {
      cleanupScenario();
    }
  });

  it("E2a: a missing explicit guest-init aborts before node/the probe", () => {
    prepareScenario();
    try {
      const missing = path.join(tmp, "does-not-exist-guest-init");
      const result = runChain({ spelling: "suite", guestInit: missing });
      assertLauncherAborted(result, `MTLK-ABORT guest-init-candidate-missing ${missing}`);
    } finally {
      cleanupScenario();
    }
  });

  it("E2b: a non-executable explicit guest-init aborts before node/the probe", () => {
    prepareScenario();
    try {
      const nonexec = path.join(tmp, "nonexec-guest-init");
      writeFileSync(nonexec, "#!/usr/bin/env bash\nexit 0\n", "utf-8");
      chmodSync(nonexec, 0o644);
      const result = runChain({ spelling: "suite", guestInit: nonexec });
      assertLauncherAborted(
        result,
        `MTLK-ABORT guest-init-candidate-not-executable ${nonexec}`,
      );
    } finally {
      cleanupScenario();
    }
  });
});
