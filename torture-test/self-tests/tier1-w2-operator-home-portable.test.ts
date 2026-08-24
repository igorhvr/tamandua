// MACP4 US-004 — W2 scenario cells + env scripts: portable operator-home
// resolution (getent -> dscl -> eval-echo -> $HOME).
//
// getent is absent on Darwin, and inside a scenario child $HOME is the
// CONTAINED home (env/tt-env-scripted.sh sets HOME=TT_SCRIPTED_HOME), so
// the four W2 run.mjs cells (w2.21, w2.23a, w2.23b, w2.23c) and the spawn
// env scripts (env/tt-env.sh, env/tt-env-scripted.sh) must resolve the
// REAL operator home via the portable chain — never the contained home —
// so daemonEnv.HOME handed to daemon-control keeps its production-guard
// derivation (REAL_TAMANDUA_STATE) and the S24 operator-bin reorder
// correct on the mac.
//
// This test pins:
//   1. structural: every W2 cell imports the shared portable resolver
//      (scenarios/lib/operator-home.mjs) and wires its result into
//      daemonEnv.HOME; no local getent-only realAccountHome and no
//      Linux-ism `/home/$(id -un)` fallback anywhere;
//   2. structural: the shared resolver and both env scripts carry the
//      full getent -> dscl -> eval-echo -> $HOME chain;
//   3. behavioral: the fallback ORDER — getent present -> passwd home;
//      getent absent -> dscl NFSHomeDirectory; getent+dscl absent ->
//      shell tilde (ignores a contained/wrong $HOME); all absent +
//      unknown user -> $HOME last resort (PATH seams);
//   4. Darwin-simulated cell check: under a getent/dscl-absent seam with a
//      contained HOME, each cell's resolved daemonEnv.HOME is the REAL
//      operator home, never the contained home.
//   5. behavioral env scripts: sourcing env/tt-env.sh and
//      tt-env-scripted.sh under the seams resolves _tt_real_home through
//      the same chain (dscl arm and tilde arm), so VOLTA_HOME / node PATH
//      resolution survives the HOME override on Darwin.
//
// Hermetic: no daemon, no campaign machinery, no repo writes (temp dirs
// only); zero tokens. Picked up by self-tests/run.sh's tier1-*.test.ts
// glob — no run.sh edit needed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const libDir = path.join(ttRoot, "scenarios", "lib");
const sharedModule = path.join(libDir, "operator-home.mjs");
const envDir = path.join(ttRoot, "env");
const cells = ["w2.21", "w2.23a", "w2.23b", "w2.23c"].map((id) => ({
  id,
  dir: path.join(ttRoot, "scenarios", id),
  runMjs: path.join(ttRoot, "scenarios", id, "run.mjs"),
}));

// ── helpers ─────────────────────────────────────────────────────────────

/** Env for spawned children: strip NODE_TEST_CONTEXT (node:test
 *  auto-activates the isolation guard in every child) and disable the
 *  guard explicitly — the children operate on temp dirs only. */
function cleanEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  env.TAMANDUA_TEST_GUARD = "0";
  if (extra) Object.assign(env, extra);
  return env;
}

/** Create an executable shim named `name` in `dir` running `body`. */
function makeShim(dir: string, name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

/** The REAL operator home (passwd db — the chain's getent step on linux). */
function realOperatorHome(): string {
  const res = spawnSync("getent", ["passwd", String(process.getuid())], { encoding: "utf8" });
  if (res.status === 0) {
    const home = String(res.stdout).split(":")[5];
    if (home) return home;
  }
  return os.homedir();
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(file, args, { cwd: repoRoot, env, encoding: "utf8" });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

/** Run a node driver that imports the shared module (by absolute path —
 *  the exact file the cell's `../lib/operator-home.mjs` resolves to) and
 *  prints { home, envHome, daemonHome } — home from realAccountHome(),
 *  envHome the driver's $HOME, daemonHome the daemonEnv.HOME the cell
 *  builds (`HOME: accountHome`, PATH prepends repoRoot/bin). */
function runModuleDriver(modulePath: string, env: NodeJS.ProcessEnv): {
  home: string;
  envHome: string;
  daemonHome: string;
} {
  const driver = path.join(os.tmpdir(), `tt-w2-home-${process.pid}-${cryptoRandom()}.mjs`);
  try {
    fs.writeFileSync(driver, `import { pathToFileURL } from "node:url";\n` +
      `import path from "node:path";\n` +
      `const repoRoot = process.argv[2];\n` +
      `const mod = await import(pathToFileURL(process.argv[3]).href);\n` +
      `const accountHome = mod.realAccountHome();\n` +
      `const daemonEnv = { ...process.env, HOME: accountHome, PATH: \`\${path.join(repoRoot, "bin")}:\${process.env.PATH ?? ""}\` };\n` +
      `process.stdout.write(JSON.stringify({ home: accountHome, envHome: process.env.HOME, daemonHome: daemonEnv.HOME }));\n`);
    const result = run(process.execPath, [driver, repoRoot, modulePath], env);
    assert.equal(result.status, 0, `driver failed: ${result.stderr}`);
    return JSON.parse(result.stdout) as { home: string; envHome: string; daemonHome: string };
  } finally {
    fs.rmSync(driver, { force: true });
  }
}

function cryptoRandom(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Source an env script in a temp bash file under the given env and print
 *  _tt_real_home (and the script's own exported TT_HOME / TT_SCRIPTED_HOME
 *  for the contained-home comparison). */
function sourceEnvScript(envScript: string, env: NodeJS.ProcessEnv): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const file = path.join(os.tmpdir(), `tt-w2-env-${process.pid}-${cryptoRandom()}.sh`);
  try {
    fs.writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\nsource '${envScript}'\n` +
      `printf '%s\\n' "\${_tt_real_home:-}"\n` +
      `printf '%s\\n' "\${TT_HOME:-}\${TT_SCRIPTED_HOME:-}"\n`);
    return run("bash", [file], env);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

// ── structural pins ──────────────────────────────────────────────────────

describe("MACP4 US-004 — W2 cells + env scripts resolve the real operator home", () => {
  it("every W2 cell imports the shared portable resolver and wires it into daemonEnv.HOME (structural)", () => {
    for (const cell of cells) {
      const src = fs.readFileSync(cell.runMjs, "utf8");
      // The shared module is the ONLY home resolver the cell uses.
      assert.match(src, /import \{ realAccountHome \} from "\.\.\/lib\/operator-home\.mjs";/,
        `${cell.id}: must import the shared portable resolver`);
      assert.doesNotMatch(src, /function realAccountHome/, `${cell.id}: must not define a local realAccountHome`);
      assert.doesNotMatch(src, /\/home\/\$\(id -un\)/, `${cell.id}: must not fall back to the Linux-ism /home/$(id -un)`);
      // The resolved home feeds daemonEnv.HOME (never the contained HOME).
      assert.match(src, /const accountHome = realAccountHome\(\)/, `${cell.id}: must resolve the account home via the shared helper`);
      assert.match(src, /HOME: accountHome/, `${cell.id}: daemonEnv.HOME must be the resolved operator home`);
      // The cell's relative import resolves to the shared module.
      const resolved = path.resolve(cell.dir, "../lib/operator-home.mjs");
      assert.equal(resolved, sharedModule, `${cell.id}: ../lib/operator-home.mjs must resolve to the shared module`);
      assert.ok(fs.existsSync(sharedModule), "shared module must exist");
    }
  });

  it("the shared resolver and both env scripts carry the getent -> dscl -> eval-echo -> $HOME chain (structural)", () => {
    const moduleSrc = fs.readFileSync(sharedModule, "utf8");
    assert.match(moduleSrc, /getent passwd/, "chain step 1 must be getent passwd (linux passwd db)");
    assert.match(moduleSrc, /dscl \. -read/, "chain step 2 must be dscl . -read (macOS NFSHomeDirectory)");
    assert.match(moduleSrc, /eval echo ~/, "chain step 3 must be the shell tilde expansion (eval echo ~<user>)");
    assert.match(moduleSrc, /process\.env\.HOME \?\? ""/, "chain step 4 must be the $HOME last resort");
    assert.doesNotMatch(moduleSrc, /\/home\/\$\(id -un\)/, "the shared resolver must not fall back to the Linux-ism /home/$(id -un)");

    for (const envScript of ["tt-env.sh", "tt-env-scripted.sh"]) {
      const src = fs.readFileSync(path.join(envDir, envScript), "utf8");
      assert.match(src, /^resolve_operator_home\(\)/m, `${envScript}: must define resolve_operator_home()`);
      assert.match(src, /getent passwd/, `${envScript}: chain step 1 must be getent passwd`);
      assert.match(src, /dscl \. -read/, `${envScript}: chain step 2 must be dscl . -read (macOS NFSHomeDirectory)`);
      assert.match(src, /eval echo ~/, `${envScript}: chain step 3 must be the shell tilde expansion`);
      assert.match(src, /_tt_real_home="\$\(resolve_operator_home\)"/, `${envScript}: _tt_real_home must come from resolve_operator_home`);
      assert.doesNotMatch(src, /\/home\/\$\(id -un\)/, `${envScript}: must not fall back to the Linux-ism /home/$(id -un)`);
    }
  });

  // ── behavioral fallback order (unit) ────────────────────────────────

  it("the shared resolver falls back getent -> dscl -> shell-tilde -> $HOME in order (PATH seams)", () => {
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-w2-home-shim-"));
    try {
      // Step 1 (getent): real PATH — the linux passwd home.
      const getentHome = runModuleDriver(sharedModule, cleanEnv({ HOME: "/contained/home" }));
      assert.match(getentHome.home, /^\//, `getent must yield an absolute operator home: ${getentHome.home}`);
      assert.notEqual(getentHome.home, "/contained/home", "getent must not resolve the contained HOME");

      // Step 2 (dscl): getent absent -> dscl NFSHomeDirectory.
      makeShim(shimDir, "getent", "exit 1");
      makeShim(shimDir, "dscl", `printf 'NFSHomeDirectory: /Users/fakehome\\n'`);
      const dscl = runModuleDriver(sharedModule,
        cleanEnv({ PATH: `${shimDir}:${process.env.PATH ?? ""}`, HOME: "/contained/home" }));
      assert.equal(dscl.home, "/Users/fakehome", `dscl must resolve the macOS home: ${dscl.home}`);

      // Step 3 (shell tilde): getent AND dscl absent -> eval echo ~<user>
      // (libc passwd lookup — ignores a contained/wrong $HOME).
      const tildeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-w2-home-tilde-"));
      try {
        makeShim(tildeDir, "getent", "exit 1");
        makeShim(tildeDir, "dscl", "exit 1");
        const tilde = runModuleDriver(sharedModule,
          cleanEnv({ PATH: `${tildeDir}:${process.env.PATH ?? ""}`, HOME: "/tmp/contained-home" }));
        assert.match(tilde.home, /^\//, `shell tilde must yield an absolute home: ${tilde.home}`);
        assert.notEqual(tilde.home, "/tmp/contained-home", "the tilde step must ignore a contained/wrong $HOME");
        assert.equal(tilde.home, getentHome.home, "tilde expansion must equal the passwd home");
      } finally {
        fs.rmSync(tildeDir, { recursive: true, force: true });
      }

      // Step 4 ($HOME): getent/dscl absent AND an unknown user (tilde stays
      // literal) -> $HOME last resort.
      const fallbackDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-w2-home-fb-"));
      try {
        makeShim(fallbackDir, "getent", "exit 1");
        makeShim(fallbackDir, "dscl", "exit 1");
        makeShim(fallbackDir, "id", `if [ "$1" = "-un" ]; then printf 'nosuchuser999\\n'; else printf '99999\\n'; fi`);
        const fb = runModuleDriver(sharedModule,
          cleanEnv({ PATH: `${fallbackDir}:${process.env.PATH ?? ""}`, HOME: "/contained/fallback-home" }));
        assert.equal(fb.home, "/contained/fallback-home", `$HOME must be the last-resort home: ${fb.home}`);
      } finally {
        fs.rmSync(fallbackDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  // ── Darwin-simulated cell check ────────────────────────────────────

  it("each cell's daemonEnv.HOME is the REAL operator home under a Darwin simulation (getent/dscl absent), never the contained home", () => {
    // Darwin seam: getent absent (no passwd CLI on macOS), dscl absent
    // (worst case — the shell tilde arm must still resolve via libc), and
    // a contained $HOME like tt-env-scripted.sh sets.
    const seamDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-w2-home-darwin-"));
    try {
      makeShim(seamDir, "getent", "exit 1");
      makeShim(seamDir, "dscl", "exit 1");
      const containedHome = path.join(seamDir, "home-scripted");
      fs.mkdirSync(containedHome, { recursive: true });
      const env = cleanEnv({ PATH: `${seamDir}:${process.env.PATH ?? ""}`, HOME: containedHome });
      const operatorHome = realOperatorHome();
      assert.match(operatorHome, /^\//, "the test host must resolve a real operator home");

      for (const cell of cells) {
        const out = runModuleDriver(sharedModule, env);
        assert.equal(out.home, operatorHome,
          `${cell.id}: realAccountHome() must resolve the REAL operator home under the Darwin simulation (got ${out.home}, expected ${operatorHome})`);
        assert.notEqual(out.home, containedHome,
          `${cell.id}: the resolved home must never be the contained TT_SCRIPTED_HOME`);
        assert.equal(out.envHome, containedHome,
          `${cell.id}: the simulation must start with the contained HOME (test sanity)`);
        assert.equal(out.daemonHome, operatorHome,
          `${cell.id}: daemonEnv.HOME must be the operator home, never the contained home (got ${out.daemonHome})`);
        assert.notEqual(out.daemonHome, containedHome,
          `${cell.id}: daemonEnv.HOME must never equal the contained home`);
      }
    } finally {
      fs.rmSync(seamDir, { recursive: true, force: true });
    }
  });

  // ── behavioral env scripts ─────────────────────────────────────────

  it("env/tt-env.sh and env/tt-env-scripted.sh resolve _tt_real_home via the portable chain when getent is absent", () => {
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-w2-env-shim-"));
    try {
      // dscl arm: getent absent -> dscl NFSHomeDirectory.
      makeShim(shimDir, "getent", "exit 1");
      makeShim(shimDir, "dscl", `printf 'NFSHomeDirectory: /Users/fakehome\\n'`);
      const seamPath = `${shimDir}:${process.env.PATH ?? ""}`;
      for (const envScript of ["tt-env.sh", "tt-env-scripted.sh"]) {
        const out = sourceEnvScript(path.join(envDir, envScript),
          cleanEnv({ PATH: seamPath, HOME: "/contained/initial-home" }));
        assert.equal(out.status, 0, `${envScript}: sourcing failed: ${out.stderr}`);
        const lines = out.stdout.trim().split("\n");
        assert.equal(lines[0], "/Users/fakehome",
          `${envScript}: _tt_real_home must come from the dscl arm when getent is absent (got ${lines[0]})`);
        // The script's own contained home (TT_HOME / TT_SCRIPTED_HOME) must
        // never leak into _tt_real_home.
        const contained = lines[1] ?? "";
        assert.notEqual(lines[0], contained, `${envScript}: _tt_real_home must never equal the contained spawn home`);
      }

      // tilde arm: getent AND dscl absent -> eval echo ~<user> (libc),
      // ignoring the contained $HOME the script itself exports.
      const tildeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-w2-env-tilde-"));
      try {
        makeShim(tildeDir, "getent", "exit 1");
        makeShim(tildeDir, "dscl", "exit 1");
        const opHome = realOperatorHome();
        const tildeSeamPath = `${tildeDir}:${process.env.PATH ?? ""}`;
        for (const envScript of ["tt-env.sh", "tt-env-scripted.sh"]) {
          const out = sourceEnvScript(path.join(envDir, envScript),
            cleanEnv({ PATH: tildeSeamPath, HOME: "/contained/initial-home" }));
          assert.equal(out.status, 0, `${envScript}: tilde-arm sourcing failed: ${out.stderr}`);
          const lines = out.stdout.trim().split("\n");
          assert.equal(lines[0], opHome,
            `${envScript}: _tt_real_home must come from the shell tilde arm (libc) when getent/dscl are absent (got ${lines[0]}, expected ${opHome})`);
          const contained = lines[1] ?? "";
          assert.notEqual(lines[0], contained,
            `${envScript}: the tilde arm must ignore the script's own contained spawn home (${contained})`);
        }
      } finally {
        fs.rmSync(tildeDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });
});
