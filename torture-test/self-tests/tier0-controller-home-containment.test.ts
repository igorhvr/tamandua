// FIX10 US-003 gate: tt-controller and tt-hook-runner fail closed with a
// CONTAINED HOME for every spawn.
//
// Regression net for the 2026-08-05 breach: a torture-test hook ran
// `git config --global` with the REAL operator HOME in effect, rewriting the
// operator's ~/.gitconfig. US-002 made the hooks themselves refuse; US-003
// closes the CONTROLLER side: loadSpawnEnvironment throws when the resolved
// HOME escapes torture-test/var, a single assertContainedSpawnEnv choke-point
// guards every controller spawn (reset/command/launch/stop/oracle/probe/
// ledger/status), and tt-hook-runner refuses (exit 2) when its own
// process.env.HOME is the real operator home.
//
// Confined to torture-test/. Zero tokens: the runner success test uses a stub
// executable; the real ~/.gitconfig is only ever READ (sha256 snapshot) by
// this file and asserted unchanged after the run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const varRoot = path.join(ttRoot, "var");
const CONTROLLER = path.join(ttRoot, "bin", "tt-controller");
const HOOK_RUNNER = path.join(ttRoot, "bin", "tt-hook-runner");
const CONTAINMENT_MODULE = path.join(ttRoot, "bin", "tt-containment.mjs");

const operatorHome = os.homedir();
const realGitconfig = path.join(operatorHome, ".gitconfig");

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

type CommandResult = { status: number | null; stdout: string; stderr: string };

function run(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 60_000): CommandResult {
  const result = spawnSync(file, args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function baseEnv(): NodeJS.ProcessEnv {
  // Keep the operator env (the runner/controller read the real HOME only to
  // REFUSE it), but drop NODE_TEST_CONTEXT so node:test does not mark
  // spawned children as test processes.
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"));
}

function runnerConfig(dir: string, executable: string): string {
  const configPath = path.join(dir, "cfg.json");
  fs.writeFileSync(configPath, JSON.stringify({
    executable,
    args: [],
    cwd: dir,
    stdout_path: path.join(dir, "cmd.stdout"),
    stderr_path: path.join(dir, "cmd.stderr"),
    result_path: path.join(dir, "result.json"),
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
    evidence_limit_bytes: 1024 * 1024,
  }));
  return configPath;
}

// Slices the source between a top-level `function NAME(` declaration and the
// next top-level declaration (all tt-controller declarations are column-0).
function functionSlice(source: string, name: string): string {
  const lines = source.split(/\r?\n/);
  const declaration = new RegExp(`^(?:async )?function ${name}\\(`);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (declaration.test(lines[i])) { start = i; break; }
  }
  assert.ok(start >= 0, `function ${name} not found in tt-controller`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^(?:async )?function [A-Za-z_$][\w$]*\(/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join("\n");
}

let gitconfigBefore = "";
describe("FIX10 US-003 controller + tt-hook-runner contained-HOME fail-closed", () => {
  before(() => {
    fs.mkdirSync(varRoot, { recursive: true });
    gitconfigBefore = sha256(realGitconfig);
  });
  after(() => {
    assert.equal(sha256(realGitconfig), gitconfigBefore,
      "the real ~/.gitconfig hash changed during the test run — containment broke");
  });

  it("tt-hook-runner refuses with exit 2 when its process.env.HOME is the real operator home", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hook-runner-refuse-${process.pid}-`));
    const marker = path.join(dir, "spawned.marker");
    const executable = path.join(dir, "spawn-stub.sh");
    fs.writeFileSync(executable, `#!/usr/bin/env bash\ntouch "${marker}"\n`, { mode: 0o755 });
    try {
      const configPath = runnerConfig(dir, executable);
      const result = run(process.execPath, [HOOK_RUNNER, configPath], {
        ...baseEnv(), HOME: operatorHome,
      });
      assert.equal(result.status, 2,
        `expected refusal (exit 2), got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.match(result.stderr, /tt-hook-runner: containment violation/,
        "stderr must carry the tt-hook-runner containment marker");
      assert.match(result.stderr, new RegExp(operatorHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        "stderr must name the offending (real) HOME");
      assert.match(result.stderr, /torture-test[\\/]var/,
        "stderr must name the expected contained root (torture-test/var)");
      // Fail closed BEFORE any spawn or evidence-file side effect.
      assert.equal(fs.existsSync(marker), false, "the command executable must never be spawned");
      assert.equal(fs.existsSync(path.join(dir, "result.json")), false,
        "no result file may be written on refusal");
      assert.equal(fs.existsSync(path.join(dir, "cmd.stdout")), false,
        "no stdout evidence may be opened on refusal");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tt-hook-runner runs the command when its process.env.HOME is contained under torture-test/var", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hook-runner-ok-${process.pid}-`));
    const containedHome = fs.mkdtempSync(path.join(varRoot, `home-runner-ok-${process.pid}-`));
    const marker = path.join(dir, "spawned.marker");
    const executable = path.join(dir, "spawn-stub.sh");
    fs.writeFileSync(executable, `#!/usr/bin/env bash\ntouch "${marker}"\n`, { mode: 0o755 });
    try {
      const configPath = runnerConfig(dir, executable);
      const result = run(process.execPath, [HOOK_RUNNER, configPath], {
        ...baseEnv(), HOME: containedHome,
      });
      assert.equal(result.status, 0,
        `contained-HOME run failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.equal(fs.existsSync(marker), true, "the command must have been spawned");
      const outcome = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
      assert.equal(outcome.exit_code, 0);
      assert.equal(outcome.error, undefined);
      assert.equal(sha256(realGitconfig), gitconfigBefore);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(containedHome, { recursive: true, force: true });
    }
  });

  it("assertContainedHome (the shared choke-point primitive) rejects escaping HOME and accepts contained ones", async () => {
    const { assertContainedHome, isContainmentViolation, CONTAINMENT_VIOLATION_CODE } =
      await import(CONTAINMENT_MODULE);
    const rejects = (home: string, varRootInput: string, pattern: RegExp, label: string): void => {
      let caught: unknown = null;
      try {
        assertContainedHome(home, varRootInput);
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof Error, `${label}: expected a thrown violation`);
      assert.equal((caught as Error & { code?: string }).code, CONTAINMENT_VIOLATION_CODE,
        `${label}: expected code ${CONTAINMENT_VIOLATION_CODE}`);
      assert.match((caught as Error).message, pattern, `${label}: message mismatch`);
      assert.equal(isContainmentViolation(caught), true, `${label}: isContainmentViolation must hold`);
    };
    const accepts = (home: string): void => {
      let caught: unknown;
      try {
        assertContainedHome(home, varRoot);
      } catch (error) {
        caught = error;
      }
      assert.equal(caught, undefined, `contained HOME must pass: ${String(caught)}`);
    };

    // Real operator home — the 2026-08-05 breach surface.
    rejects(operatorHome, varRoot, /NOT strictly under torture-test\/var/, "real operator home");
    // var itself — must be a contained CHILD home, not var.
    rejects(varRoot, varRoot, /torture-test\/var itself/, "var itself");
    // A sibling outside var.
    const sibling = fs.mkdtempSync(path.join(os.tmpdir(), `home-outside-var-${process.pid}-`));
    try {
      rejects(sibling, varRoot, /NOT strictly under torture-test\/var/, "sibling outside var");
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
    // A nonexistent path under the operator home must NOT be judged by its
    // nearest existing ancestor (which is the operator home).
    rejects(path.join(operatorHome, `no-such-tt-dir-${process.pid}`), varRoot,
      /NOT strictly under torture-test\/var/, "nonexistent path under the operator home");
    // Unset HOME.
    rejects("", varRoot, /is unset or empty/, "unset HOME");
    // Missing containment root — fail closed, never silently pass.
    rejects(path.join(varRoot, "home-scripted"), path.join(varRoot, "no-such-root"),
      /cannot resolve containment root/, "missing containment root");

    // Contained HOME that already exists — and a symlink that resolves
    // inside var is contained too.
    const containedExisting = fs.mkdtempSync(path.join(varRoot, `home-unit-${process.pid}-`));
    const linkHome = path.join(os.tmpdir(), `tt-home-link-${process.pid}`);
    try {
      accepts(containedExisting);
      fs.symlinkSync(containedExisting, linkHome);
      accepts(linkHome);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        // Symlinks may be unavailable (e.g. some CI sandboxes); skip.
        return;
      }
      throw error;
    } finally {
      fs.rmSync(containedExisting, { recursive: true, force: true });
      fs.rmSync(linkHome, { force: true });
    }
    // Contained HOME that does NOT exist yet (fresh-checkout state: the
    // controller legitimately spawns children before home-scripted is
    // provisioned) — judged by its nearest existing ancestor (var).
    accepts(path.join(varRoot, `home-not-yet-${process.pid}`));
  });

  it("loadSpawnEnvironment asserts the merged HOME is contained (fail-closed spawn-environment)", () => {
    const source = fs.readFileSync(CONTROLLER, "utf8");
    const slice = functionSlice(source, "loadSpawnEnvironment");
    const lines = slice.split(/\r?\n/);
    const mergeIndex = lines.findIndex((line) => line.includes("parsePrintedEnvironment(result.stdout, scriptPath)"));
    const assertIndex = lines.findIndex((line) => line.includes("assertContainedHome(merged.HOME, VAR_ROOT"));
    assert.ok(mergeIndex >= 0, "loadSpawnEnvironment must merge the printed environment");
    assert.ok(assertIndex > mergeIndex,
      "loadSpawnEnvironment must assert the merged HOME AFTER the env merge (fail closed before any spawn)");
  });

  it("loadSpawnEnvironment forwards the TT_FORCE_NO_SYSTEMD operator override from the controller env (MACP4 US-008)", () => {
    // operatorEnvironmentWithoutRuntimeRouting strips every TT_* key from the
    // child spawn env, so an operator's `TT_FORCE_NO_SYSTEMD=1
    // ./run-torture-test --tier1` used to silently fall back to the SYSTEMD
    // path in the campaign (the forced-fallback campaign proof was actually
    // the normal path run twice). loadSpawnEnvironment must re-forward the
    // override from the controller's own env so daemon-control's
    // has_systemd_scope() sees it through the whole campaign spawn path.
    const source = fs.readFileSync(CONTROLLER, "utf8");
    const slice = functionSlice(source, "loadSpawnEnvironment");
    assert.match(slice, /process\.env\.TT_FORCE_NO_SYSTEMD/,
      "loadSpawnEnvironment must read TT_FORCE_NO_SYSTEMD from the controller's own env");
    assert.match(slice, /merged\.TT_FORCE_NO_SYSTEMD\s*=\s*process\.env\.TT_FORCE_NO_SYSTEMD/,
      "loadSpawnEnvironment must forward TT_FORCE_NO_SYSTEMD into the merged spawn env");
    // The forward must happen AFTER the operator env is stripped (the strip is
    // the fail-closed default, performed by operatorEnvironmentWithoutRuntime-
    // Routing which loadSpawnEnvironment calls first) and BEFORE the
    // containment assertion (the merged env is what every child receives).
    const lines = slice.split(/\r?\n/);
    const stripIndex = lines.findIndex((line) => line.includes("operatorEnvironmentWithoutRuntimeRouting()"));
    const forwardIndex = lines.findIndex((line) => line.includes("merged.TT_FORCE_NO_SYSTEMD"));
    assert.ok(stripIndex >= 0,
      "loadSpawnEnvironment must build the operator env via operatorEnvironmentWithoutRuntimeRouting (TT_* strip)");
    assert.ok(forwardIndex > stripIndex,
      "the TT_FORCE_NO_SYSTEMD forward must come AFTER the TT_* strip (explicit allowlist, not a blanket un-strip)");
  });

  it("every spawn site in tt-controller passes through the containment choke-point", () => {
    const source = fs.readFileSync(CONTROLLER, "utf8");
    const lines = source.split(/\r?\n/);
    // Every function that spawns a child must call assertContainedSpawnEnv.
    // loadSpawnEnvironment is the exception: its single spawn is the env-print
    // (bash tt-env.sh print) and it asserts via assertContainedHome inline.
    const spawnFunctions = new Set<string>();
    const assertFunctions = new Set<string>();
    let current: string | null = null;
    for (let i = 0; i < lines.length; i += 1) {
      const decl = /^(?:async )?function ([A-Za-z_$][\w$]*)/.exec(lines[i]);
      if (decl) current = decl[1];
      if (current === null) continue;
      if (/\bspawn(Sync)?\(/.test(lines[i])) spawnFunctions.add(current);
      if (/\bassertContainedSpawnEnv\(/.test(lines[i])) assertFunctions.add(current);
    }
    assert.ok(spawnFunctions.size >= 9,
      `expected at least 9 spawn sites across functions, found ${[...spawnFunctions].join(", ")}`);
    assert.ok(assertFunctions.size >= 8,
      `expected assertContainedSpawnEnv in every spawn function, found ${[...assertFunctions].join(", ")}`);
    for (const name of spawnFunctions) {
      if (name === "loadSpawnEnvironment") continue; // inline assertContainedHome, see test above
      assert.ok(assertFunctions.has(name),
        `function ${name} contains a spawn but no assertContainedSpawnEnv choke-point`);
    }
    // The choke-point functions are exactly the spawn-bearing ones plus the
    // helper — with ONE documented exception: preflightTokenSaverFlaggedLaunch
    // (S24/US-007) is a fail-closed LAUNCH GATE. It performs no spawn of its
    // own (the launch helpers manageTokenSaverStub / runHook / monitorWorkflowRun
    // are the spawn-bearing choke-pointed functions), but it MUST assert the
    // launch env is contained BEFORE any stub install or token-saver launch —
    // a non-contained env fails closed with 'token-saver-preflight-failed'
    // instead of reaching a spawn site. Treat it as a sanctioned non-spawn
    // assert site, not a containment gap.
    const NON_SPAWN_ASSERT_GATES = new Set(["preflightTokenSaverFlaggedLaunch"]);
    for (const name of assertFunctions) {
      assert.ok(name === "assertContainedSpawnEnv" || spawnFunctions.has(name)
        || NON_SPAWN_ASSERT_GATES.has(name),
      `function ${name} calls assertContainedSpawnEnv but contains no spawn`);
    }
    // The choke-point helper itself delegates to the shared primitive.
    const helper = functionSlice(source, "assertContainedSpawnEnv");
    assert.match(helper, /assertContainedHome\(childEnv\?\.HOME, VAR_ROOT/,
      "assertContainedSpawnEnv must delegate to the shared assertContainedHome");
  });

  it("a containment violation aborts the case as TEST_INFRA_FAIL with category 'containment-violation'", () => {
    const source = fs.readFileSync(CONTROLLER, "utf8");
    const slice = functionSlice(source, "executeEligibleCases");
    // S16 (US-003) restructured the scheduler catch into a classification
    // chain (containment-violation FIRST, then the structured status-query
    // failure, then the generic scheduler failure). The containment mapping
    // must stay the precise, precedence-first category.
    assert.match(slice,
      /if \(isContainmentViolation\(error\)\) \{[\s\S]{0,120}category: 'containment-violation'/,
      "executeEligibleCases must map a TT_CONTAINMENT_VIOLATION to the precise 'containment-violation' category");
    assert.match(slice, /'TEST_INFRA_FAIL'/,
      "a containment violation must abort the case as TEST_INFRA_FAIL");
  });

  it("tt-hook-runner asserts containment before its spawn and derives var from its own location", () => {
    const source = fs.readFileSync(HOOK_RUNNER, "utf8");
    const lines = source.split(/\r?\n/);
    const assertIndex = lines.findIndex((line) => line.includes("assertContainedHome(process.env.HOME, TT_VAR"));
    const spawnIndex = lines.findIndex((line) => /child = spawn\(/.test(line));
    assert.ok(assertIndex >= 0, "tt-hook-runner must call assertContainedHome on process.env.HOME");
    assert.ok(spawnIndex > assertIndex,
      "tt-hook-runner must assert containment BEFORE spawning config.executable");
    assert.match(source, /path\.resolve\(path\.dirname\(fileURLToPath\(import\.meta\.url\)\), '\.\.', 'var'\)/,
      "tt-hook-runner must derive torture-test/var from its own file location");
    assert.match(source, /process\.exit\(2\)/,
      "tt-hook-runner must hard-exit (2) on refusal so no spawn can follow");
  });
});
