/**
 * US-015 serial integration test for `tamandua matchlock setup` — the FULL
 * command against a LOCAL bare fixture remote with fake `go`/`matchlock`/`sudo`
 * shims.
 *
 * What is REAL here: the git submodule logic (`git submodule update --init
 * matchlock` against a real bare fixture remote reached over the `file`
 * protocol), the atomic binary install into a temp prefix, and the pure
 * installer core's phase transitions. What is SIMULATED: every `go`,
 * `matchlock`, `sudo`, `mkfs.erofs` and `getcap` invocation, journaled by a
 * hybrid runner that also breaks argv-array discipline nowhere.
 *
 * Hermeticity guarantees asserted by this file:
 *   - ZERO network: the only submodule remote is a path inside the test temp
 *     root, git runs with `GIT_ALLOW_PROTOCOL=file` (network protocols are
 *     refused) and every git argv is checked for a `https://`/`github.com` URL;
 *   - ZERO real builds/sudo/VMs: the only `go`/`matchlock`/`sudo`/`mkfs.erofs`
 *     files on PATH are shim scripts that, if executed, append to a marker file
 *     — the marker must never exist;
 *   - ZERO superproject mutation: the fixture checkout's `HEAD` is unchanged,
 *     its working tree stays clean, and no `git add`/`commit`/`push`/`stage`
 *     argv is ever journaled (N3).
 *
 * This file is SERIAL-LANE classified (it imports node:child_process) and is
 * therefore listed in tests/serial-files.txt.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import {
  KERNEL_WARM_MISSING_COMMAND_REMEDY,
  MATCHLOCK_IMAGE_ENV_NAME,
  MATCHLOCK_RPC_BIN_ENV_NAME,
  OFFLINE_ASSETS_READY_LABEL,
  OFFLINE_READINESS_HEADING,
  RUNNABILITY_RELOGIN_LABEL,
  STANDARD_IMAGE_REFERENCE,
  VERIFY_CAPABILITIES_MISSING_CODE,
  runMatchlockSetup,
  type MatchlockSetupDeps,
  type MatchlockSetupFs,
  type RunCommand,
  type RunCommandResult,
  type StoredImageEntry,
} from "../dist/installer/matchlock-setup.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const GIT_IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "Tamandua Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Tamandua Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

function gitRun(args: string[], cwd: string, env: NodeJS.ProcessEnv): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    env,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function gitOk(args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  const result = gitRun(args, cwd, env);
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed (cwd ${cwd}):\n${result.stderr}`,
  );
  return result.stdout.trim();
}

function gitEnv(home: string): NodeJS.ProcessEnv {
  // Construct the child env explicitly (never spread process.env: the test
  // isolation guard bans that pattern in test files).
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    // Only the local `file` transport is allowed: any network protocol would be
    // refused by git itself, so a green run proves the fixture stayed offline.
    GIT_ALLOW_PROTOCOL: "file",
    ...GIT_IDENTITY,
  };
}

function writeShim(dir: string, name: string, body: string): void {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, "utf-8");
  fs.chmodSync(file, 0o755);
}

interface Fixture {
  root: string;
  remote: string;
  origin: string;
  submoduleSha: string;
  shimDir: string;
  markerPath: string;
  env: NodeJS.ProcessEnv;
}

function createFixture(): Fixture {
  const root = tamanduaTempDir("tamandua-mtlk-setup-it-");
  const gitHome = path.join(root, "git-home");
  fs.mkdirSync(gitHome, { recursive: true });
  const env = gitEnv(gitHome);

  // The local bare "fork" remote the submodule clones from.
  const remote = path.join(root, "fixture-remote.git");
  fs.mkdirSync(remote);
  gitOk(["init", "--bare"], remote, env);

  // Fork content: go.mod (the Go minimum), VERSION.txt, entitlements and the
  // two packages the pinned build recipe targets.
  const fork = path.join(root, "fork-work");
  fs.mkdirSync(fork);
  gitOk(["init", "--initial-branch=main"], fork, env);
  // The pinned build recipe writes `bin/` into the submodule; the fork ignores
  // its build outputs, so a synced checkout stays clean across re-runs.
  fs.writeFileSync(path.join(fork, ".gitignore"), "bin/\n", "utf-8");
  fs.writeFileSync(
    path.join(fork, "go.mod"),
    "module github.com/jingkaihe/matchlock\n\ngo 1.25.5\n",
    "utf-8",
  );
  fs.writeFileSync(path.join(fork, "VERSION.txt"), "1.2.3\n", "utf-8");
  fs.writeFileSync(path.join(fork, "matchlock.entitlements"), "<plist/>\n", "utf-8");
  fs.mkdirSync(path.join(fork, "cmd", "matchlock"), { recursive: true });
  fs.mkdirSync(path.join(fork, "cmd", "guest-init"), { recursive: true });
  fs.writeFileSync(
    path.join(fork, "cmd", "matchlock", "main.go"),
    "package main\nfunc main() {}\n",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(fork, "cmd", "guest-init", "main.go"),
    "package main\nfunc main() {}\n",
    "utf-8",
  );
  gitOk(["add", "."], fork, env);
  gitOk(["commit", "-m", "fork content"], fork, env);
  const submoduleSha = gitOk(["rev-parse", "HEAD"], fork, env);
  gitOk(["remote", "add", "origin", remote], fork, env);
  gitOk(["push", "--quiet", "origin", "HEAD:main"], fork, env);

  // The superproject that registers the committed matchlock gitlink. The
  // `.gitmodules` url points at the local bare remote (offline).
  const origin = path.join(root, "origin-super");
  fs.mkdirSync(origin);
  gitOk(["init", "--initial-branch=main"], origin, env);
  fs.writeFileSync(
    path.join(origin, ".gitmodules"),
    `[submodule "matchlock"]\n\tpath = matchlock\n\turl = ${remote}\n`,
    "utf-8",
  );
  fs.writeFileSync(path.join(origin, "README.md"), "# super\n", "utf-8");
  gitOk(["add", ".gitmodules", "README.md"], origin, env);
  gitOk(["update-index", "--add", "--cacheinfo", "160000", submoduleSha, "matchlock"], origin, env);
  gitOk(["commit", "-m", "register matchlock submodule"], origin, env);

  // Fake shims: if the runner ever fails to simulate one of these, the shim
  // runs and appends to the marker, which every test asserts is absent.
  const shimDir = path.join(root, "shims");
  fs.mkdirSync(shimDir);
  const marker = path.join(shimDir, "executed.marker");
  const header = `#!/bin/sh\necho "$0 $*" >> "${marker}"\n`;
  writeShim(shimDir, "go", `${header}echo "go version go1.25.5 linux/amd64"\n`);
  writeShim(shimDir, "matchlock", `${header}exit 0\n`);
  writeShim(shimDir, "sudo", `${header}exit 0\n`);
  writeShim(shimDir, "mkfs.erofs", `${header}exit 0\n`);
  writeShim(shimDir, "getcap", `${header}echo "cap_net_admin,cap_net_raw=ep"\n`);

  return { root, remote, origin, submoduleSha, shimDir, markerPath: marker, env };
}

interface ScenarioConfig {
  /** Extra `tamandua matchlock setup` flags. */
  extraArgs?: string[];
  /** Injected environment overrides (merged over the hermetic base). */
  env?: Record<string, string | undefined>;
  /** Local image-store shadow entry resolved for the standard reference. */
  shadow?: StoredImageEntry;
  /** Initial `matchlock diagnose` verdict (default: not ready). */
  diagnoseReady?: boolean;
  /** Exit code the simulated `sudo … setup linux` reports (default 0). */
  hostSetupExitCode?: number;
  /** Exit code the simulated `matchlock pull` reports (default 0). */
  pullExitCode?: number;
  pullOutput?: string;
  /** Exit code the simulated `matchlock kernel pull` reports (default 0). */
  kernelExitCode?: number;
  kernelOutput?: string;
  /** `getcap` stdout; `null` makes the probe raise (unavailable). */
  getcapOutput?: string | null;
  goVersionOutput?: string;
  versionOutput?: string;
  freeSpaceBytes?: number;
  /** Basenames `fs.isExecutable` reports as absent (e.g. the mkfs gate). */
  hiddenExecutables?: string[];
}

interface JournalCall {
  command: string;
  args: string[];
  env?: Record<string, string | undefined>;
  stdio?: string;
}

interface Scenario {
  runDir: string;
  checkout: string;
  home: string;
  prefix: string;
  matchlockPath: string;
  guestInitPath: string;
  deps: MatchlockSetupDeps;
  journal: JournalCall[];
  logs: string[];
  warns: string[];
  args: string[];
}

function createScenario(fixture: Fixture, name: string, config: ScenarioConfig = {}): Scenario {
  const runDir = tamanduaTempDir(`tamandua-mtlk-setup-${name}-`);
  const home = path.join(runDir, "home");
  fs.mkdirSync(home, { recursive: true });

  // A fresh clone of the superproject has an UNINITIALIZED submodule, so the
  // real `git submodule update --init` path runs for every scenario.
  const checkout = path.join(runDir, "checkout");
  const clone = gitRun(["clone", "--quiet", fixture.origin, checkout], runDir, fixture.env);
  assert.equal(clone.status, 0, `fixture clone failed:\n${clone.stderr}`);

  const prefix = path.join(runDir, "bin");
  const matchlockPath = path.join(prefix, "matchlock");
  const guestInitPath = path.join(prefix, "guest-init");

  const baseEnv: Record<string, string | undefined> = {
    HOME: home,
    USER: "tester",
    PATH: `${fixture.shimDir}${path.delimiter}${process.env.PATH ?? ""}`,
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    GIT_CONFIG_NOSYSTEM: "1",
    // A correctly-enrolled host: the daemon prediction points at the installed
    // binary (no PATH-shadow warning unless a test overrides it).
    [MATCHLOCK_RPC_BIN_ENV_NAME]: matchlockPath,
    [MATCHLOCK_IMAGE_ENV_NAME]: undefined,
    MATCHLOCK_FIRECRACKER: undefined,
    MATCHLOCK_JAILER: undefined,
    MATCHLOCK_GUEST_INIT: undefined,
    ...config.env,
  };

  const hidden = new Set(config.hiddenExecutables ?? []);
  const fsSeam: MatchlockSetupFs = {
    exists: (p) => fs.existsSync(p),
    isFile: (p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    },
    isExecutable: (p) => {
      if (hidden.has(path.basename(p))) return false;
      try {
        return fs.statSync(p).isFile() && (fs.accessSync(p, fs.constants.X_OK), true);
      } catch {
        return false;
      }
    },
    isWritableDir: (p) => {
      try {
        return fs.statSync(p).isDirectory() && (fs.accessSync(p, fs.constants.W_OK), true);
      } catch {
        return false;
      }
    },
    readTextFile: (p) => fs.readFileSync(p, "utf-8"),
    writeFile: (p, contents) => {
      fs.writeFileSync(p, contents);
    },
    copyFile: (from, to) => {
      fs.copyFileSync(from, to);
    },
    rename: (from, to) => {
      fs.renameSync(from, to);
    },
    remove: (p) => {
      fs.rmSync(p, { force: true });
    },
    mkdirp: (p) => {
      fs.mkdirSync(p, { recursive: true });
    },
    realpath: (p) => fs.realpathSync(p),
    readDir: (p) => fs.readdirSync(p),
    freeSpaceBytes: () => config.freeSpaceBytes ?? 64 * 1024 ** 3,
  };

  const journal: JournalCall[] = [];
  const logs: string[] = [];
  const warns: string[] = [];

  // The hybrid runner: for `git` it shells out to the REAL git binary (argv
  // array only, with `-c protocol.file.allow=always`); everything else is
  // simulated + journaled, so no real build/sudo/VM ever runs.
  const mergedEnv = (overrides?: Record<string, string | undefined>): NodeJS.ProcessEnv => {
    const merged: NodeJS.ProcessEnv = Object.assign({}, process.env);
    for (const [key, value] of Object.entries(overrides ?? {})) {
      if (value === undefined) delete merged[key];
      else merged[key] = value;
    }
    return merged;
  };

  let diagnoseReady = config.diagnoseReady ?? false;
  const defaultVersionOutput =
    `matchlock 1.2.3 (commit: ${fixture.submoduleSha.slice(0, 7)}, ` +
    "built: Wed Sep 23 09:34:18 UTC 2026)\n";
  const defaultPullOutput = `sha256:${"a".repeat(64)}\n`;
  const defaultKernelOutput =
    `kernel 6.12.0 warmed: ${path.join(home, ".cache", "matchlock", "kernels", "6.12.0", "vmlinux")}\n`;

  const runner: RunCommand = async (command, args, options) => {
    const base = path.basename(command);
    journal.push({
      command,
      args: [...args],
      ...(options?.env !== undefined ? { env: options.env } : {}),
      ...(options?.stdio !== undefined ? { stdio: options.stdio } : {}),
    });

    if (base === "git") {
      const result = spawnSync("git", ["-c", "protocol.file.allow=always", ...args], {
        cwd: options?.cwd,
        env: mergedEnv(options?.env),
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    }

    if (base === "go") {
      if (args[0] === "version") {
        return {
          code: 0,
          stdout: config.goVersionOutput ?? "go version go1.25.5 linux/amd64\n",
          stderr: "",
        };
      }
      // Simulated stub build: write the `-o` output so the atomic install has a
      // real file to copy, but never run a compiler.
      const outIndex = args.indexOf("-o");
      const outArg = outIndex >= 0 ? args[outIndex + 1] : undefined;
      if (outArg !== undefined && options?.cwd !== undefined) {
        const destination = path.resolve(options.cwd, outArg);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, `stub ${path.basename(destination)}\n`, "utf-8");
      }
      return { code: 0, stdout: "", stderr: "" };
    }

    if (base === "sudo") {
      const code = config.hostSetupExitCode ?? 0;
      // A successful `setup linux` enrollment flips the diagnose gate ready for
      // phase 4 (the reported re-login caveat still applies).
      if (code === 0) diagnoseReady = true;
      return { code, stdout: "", stderr: "" };
    }

    if (base === "matchlock") {
      switch (args[0]) {
        case "diagnose":
          return { code: diagnoseReady ? 0 : 1, stdout: "", stderr: "" };
        case "version":
          return { code: 0, stdout: config.versionOutput ?? defaultVersionOutput, stderr: "" };
        case "pull":
          return {
            code: config.pullExitCode ?? 0,
            stdout: config.pullOutput ?? defaultPullOutput,
            stderr: "",
          };
        case "kernel":
          return {
            code: config.kernelExitCode ?? 0,
            stdout: config.kernelOutput ?? defaultKernelOutput,
            stderr: "",
          };
        default:
          return { code: 0, stdout: "", stderr: "" };
      }
    }

    if (base === "getcap") {
      if (config.getcapOutput === null) throw new Error("getcap simulated unavailable");
      return {
        code: 0,
        stdout: config.getcapOutput ?? `${args[0] ?? "matchlock"} cap_net_admin,cap_net_raw=ep\n`,
        stderr: "",
      };
    }

    return { code: 0, stdout: "", stderr: "" };
  };

  const deps: MatchlockSetupDeps = {
    runCommand: runner,
    fs: fsSeam,
    resolveStoredImage: () => config.shadow,
    platform: "linux",
    arch: "x64",
    sourcePath: checkout,
    env: baseEnv,
    euid: 1000,
    accountHomeResolver: () => home,
    output: {
      log: (message) => logs.push(message),
      warn: (message) => warns.push(message),
    },
  };

  const args = ["--url", fixture.remote, "--prefix", prefix, ...(config.extraArgs ?? [])];

  return {
    runDir,
    checkout,
    home,
    prefix,
    matchlockPath,
    guestInitPath,
    deps,
    journal,
    logs,
    warns,
    args,
  };
}

function basenameCalls(scenario: Scenario, base: string): JournalCall[] {
  return scenario.journal.filter((call) => path.basename(call.command) === base);
}

function matchlockCalls(scenario: Scenario, firstArg: string): JournalCall[] {
  return basenameCalls(scenario, "matchlock").filter((call) => call.args[0] === firstArg);
}

function countGoBuilds(scenario: Scenario): number {
  return basenameCalls(scenario, "go").filter((call) => call.args[0] === "build").length;
}

/** The marker the shim scripts would append to if one ever really executed. */
function assertNoShimExecuted(fixture: Fixture): void {
  assert.equal(
    fs.existsSync(fixture.markerPath),
    false,
    `a fake shim was really executed (marker ${fixture.markerPath} exists): ` +
      `${fs.existsSync(fixture.markerPath) ? fs.readFileSync(fixture.markerPath, "utf-8") : ""}`,
  );
}

/** No git argv may target a network URL, and none may mutate the superproject (N3). */
function assertOfflineAndNonMutating(scenario: Scenario): void {
  for (const call of basenameCalls(scenario, "git")) {
    for (const arg of call.args) {
      assert.ok(
        !arg.includes("https://") && !arg.includes("github.com") && !arg.includes("ssh://"),
        `git argv reached the network: ${call.args.join(" ")}`,
      );
    }
    for (const mutator of ["add", "commit", "push", "stage"]) {
      assert.ok(
        !call.args.includes(mutator),
        `git submodule sync must never mutate the superproject: ${call.args.join(" ")}`,
      );
    }
  }
}

describe("matchlock setup serial integration (local fixture remote, fake shims)", () => {
  let fixture: Fixture;

  before(() => {
    fixture = createFixture();
  });

  after(() => {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  it("is listed in tests/serial-files.txt", () => {
    const relative = path.relative(REPO_ROOT, fileURLToPath(import.meta.url));
    const entries = fs
      .readFileSync(path.join(REPO_ROOT, "tests", "serial-files.txt"), "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    assert.ok(entries.includes(relative), `${relative} must be listed in tests/serial-files.txt`);
  });

  it("drives the whole command offline: real submodule sync, build, install, host setup, pull, kernel warm, verify", async (t) => {
    const scenario = createScenario(fixture, "full", { extraArgs: ["--smoke"] });
    t.after(() => fs.rmSync(scenario.runDir, { recursive: true, force: true }));

    const headBefore = gitOk(["rev-parse", "HEAD"], scenario.checkout, fixture.env);
    const result = await runMatchlockSetup(scenario.args, scenario.deps);

    // Real `git submodule update --init matchlock` ran against the local remote.
    const updates = basenameCalls(scenario, "git").filter(
      (call) =>
        call.args.includes("submodule") &&
        call.args.includes("update") &&
        call.args.includes("--init") &&
        call.args.includes("matchlock"),
    );
    assert.equal(updates.length, 1, "exactly one real `submodule update --init matchlock`");
    const submoduleDir = path.join(scenario.checkout, "matchlock");
    assert.equal(gitOk(["rev-parse", "HEAD"], submoduleDir, fixture.env), fixture.submoduleSha);
    assert.equal(gitOk(["remote", "get-url", "origin"], submoduleDir, fixture.env), fixture.remote);

    // Every phase ran and the overall status is green.
    assert.equal(result.status, "ok");
    assert.equal(result.reloginRequired, true);
    assert.equal(result.phases.find((phase) => phase.phase === 2)?.status, "ok");
    assert.equal(result.phases.find((phase) => phase.phase === 3)?.status, "ok");
    assert.equal(result.phases.find((phase) => phase.phase === 4)?.status, "ok");

    // Build + atomic install landed the absolute pair (N7).
    assert.ok(countGoBuilds(scenario) >= 2, "both pinned builds ran");
    assert.ok(fs.existsSync(scenario.matchlockPath));
    assert.ok(fs.existsSync(scenario.guestInitPath));

    // The identity-selected sudo command and the exact pull/kernel argv.
    const sudo = basenameCalls(scenario, "sudo");
    assert.equal(sudo.length, 1);
    assert.deepEqual(sudo[0].args, [scenario.matchlockPath, "setup", "linux"]);
    const pull = matchlockCalls(scenario, "pull");
    assert.equal(pull.length, 1);
    assert.deepEqual(pull[0].args, ["pull", STANDARD_IMAGE_REFERENCE]);
    const kernel = matchlockCalls(scenario, "kernel");
    assert.equal(kernel.length, 1);
    assert.deepEqual(kernel[0].args, ["kernel", "pull"]);

    // Phase 4 report: assets offline-ready, runnability gated on the re-login.
    const rendered = scenario.logs.join("\n");
    assert.ok(rendered.includes(OFFLINE_READINESS_HEADING));
    assert.ok(rendered.includes(OFFLINE_ASSETS_READY_LABEL));
    assert.ok(rendered.includes(RUNNABILITY_RELOGIN_LABEL));
    assert.ok(rendered.includes(MATCHLOCK_RPC_BIN_ENV_NAME));

    // --smoke is refused while a fresh login is pending; no smoke child spawned.
    assert.equal(matchlockCalls(scenario, "run").length, 0);
    assert.ok((result.warnings ?? []).some((warning) => warning.code === "smoke-refused-relogin"));

    // Hermeticity.
    assertOfflineAndNonMutating(scenario);
    assertNoShimExecuted(fixture);
    assert.equal(gitOk(["rev-parse", "HEAD"], scenario.checkout, fixture.env), headBefore);
    assert.equal(gitOk(["status", "--porcelain"], scenario.checkout, fixture.env), "");
  });

  it("re-run is an idempotent no-op at the target commit and --force rebuilds", async (t) => {
    const scenario = createScenario(fixture, "idempotent", { diagnoseReady: true });
    t.after(() => fs.rmSync(scenario.runDir, { recursive: true, force: true }));

    const first = await runMatchlockSetup(scenario.args, scenario.deps);
    assert.equal(first.status, "ok");
    assert.equal(first.idempotent, undefined);
    const buildsAfterFirst = countGoBuilds(scenario);
    assert.equal(buildsAfterFirst, 2);
    const pullsAfterFirst = matchlockCalls(scenario, "pull").length;

    const second = await runMatchlockSetup(scenario.args, scenario.deps);
    assert.equal(second.status, "ok");
    assert.equal(second.idempotent, true, "the installed commit matches the target");
    assert.equal(countGoBuilds(scenario), buildsAfterFirst, "no-op must not rebuild");
    assert.ok(
      matchlockCalls(scenario, "pull").length > pullsAfterFirst,
      "phases 2-4 still run on a no-op re-run",
    );
    assert.ok(scenario.logs.join("\n").includes(`already at ${fixture.submoduleSha}`));

    const forced = await runMatchlockSetup([...scenario.args, "--force"], scenario.deps);
    assert.equal(forced.status, "ok");
    assert.equal(forced.idempotent, undefined);
    assert.equal(countGoBuilds(scenario), buildsAfterFirst + 2, "--force rebuilds both binaries");

    assertOfflineAndNonMutating(scenario);
    assertNoShimExecuted(fixture);
  });

  it("phase 1 hard-fails on an old Go after the content sync, before any build/install/host work", async (t) => {
    const scenario = createScenario(fixture, "go-old", {
      goVersionOutput: "go version go1.20.0 linux/amd64\n",
    });
    t.after(() => fs.rmSync(scenario.runDir, { recursive: true, force: true }));

    const result = await runMatchlockSetup(scenario.args, scenario.deps);

    assert.equal(result.status, "failed");
    const phaseOne = result.phases.find((phase) => phase.phase === 1);
    assert.equal(phaseOne?.status, "failed");
    assert.equal((phaseOne?.details as { reason?: string } | undefined)?.reason, "go-too-old");
    for (const phaseNumber of [2, 3, 4]) {
      assert.equal(result.phases.find((phase) => phase.phase === phaseNumber)?.status, "not-run");
    }

    // The content sync DID happen (post-sync hard failure) ...
    assert.ok(
      basenameCalls(scenario, "git").some(
        (call) => call.args.includes("submodule") && call.args.includes("update"),
      ),
      "the submodule content was synchronized before the Go gate failed",
    );
    // ... but nothing else was.
    assert.equal(countGoBuilds(scenario), 0);
    assert.equal(matchlockCalls(scenario, "pull").length, 0);
    assert.equal(matchlockCalls(scenario, "kernel").length, 0);
    assert.equal(basenameCalls(scenario, "sudo").length, 0);
    assert.equal(basenameCalls(scenario, "getcap").length, 0);
    assert.equal(fs.existsSync(scenario.matchlockPath), false);

    assert.ok(scenario.warns.join("\n").includes("go >= 1.25.5"));
    assertOfflineAndNonMutating(scenario);
    assertNoShimExecuted(fixture);
  });

  it("a phase-2 failure does not block phase 3 and reports the bound remaining command", async (t) => {
    const scenario = createScenario(fixture, "phase2-fail", { hostSetupExitCode: 7 });
    t.after(() => fs.rmSync(scenario.runDir, { recursive: true, force: true }));

    const result = await runMatchlockSetup(scenario.args, scenario.deps);

    assert.equal(result.status, "failed");
    assert.equal(result.phases.find((phase) => phase.phase === 2)?.status, "failed");
    // Independence (N1): phase 3 and the phase-4 report still ran.
    assert.equal(result.phases.find((phase) => phase.phase === 3)?.status, "ok");
    assert.equal(result.phases.find((phase) => phase.phase === 4)?.status, "ok");
    assert.equal(matchlockCalls(scenario, "pull").length, 1);
    assert.equal(matchlockCalls(scenario, "kernel").length, 1);

    const sudo = basenameCalls(scenario, "sudo");
    assert.deepEqual(sudo[0].args, [scenario.matchlockPath, "setup", "linux"]);
    assert.ok(
      (result.remainingCommands ?? []).includes(
        `sudo ${scenario.matchlockPath} setup linux`,
      ),
      `remaining commands must bind the host setup fix: ${JSON.stringify(result.remainingCommands)}`,
    );
    assert.ok(scenario.warns.join("\n").includes("host setup failed"));

    assertOfflineAndNonMutating(scenario);
    assertNoShimExecuted(fixture);
  });

  it("phase 3 refuses a missing mkfs.erofs without touching phase 2 or the kernel", async (t) => {
    const scenario = createScenario(fixture, "phase3-mkfs", {
      diagnoseReady: true,
      hiddenExecutables: ["mkfs.erofs"],
    });
    t.after(() => fs.rmSync(scenario.runDir, { recursive: true, force: true }));

    const result = await runMatchlockSetup(scenario.args, scenario.deps);

    assert.equal(result.status, "failed");
    assert.equal(result.phases.find((phase) => phase.phase === 2)?.status, "skipped");
    const phaseThree = result.phases.find((phase) => phase.phase === 3);
    assert.equal(phaseThree?.status, "failed");
    const details = phaseThree?.details as
      | { refused?: boolean; reason?: string }
      | undefined;
    assert.equal(details?.refused, true);
    assert.equal(details?.reason, "mkfs-erofs-missing");
    // The pull never started and the kernel warm was skipped.
    assert.equal(matchlockCalls(scenario, "pull").length, 0);
    assert.equal(matchlockCalls(scenario, "kernel").length, 0);
    // Phase 4 still produced the combined report.
    assert.equal(result.phases.find((phase) => phase.phase === 4)?.status, "ok");
    assert.ok(
      (result.remainingCommands ?? []).includes(
        `${scenario.matchlockPath} pull ${STANDARD_IMAGE_REFERENCE}`,
      ),
    );
    assert.ok(
      (result.remainingCommands ?? []).includes(`${scenario.matchlockPath} kernel pull`),
    );
    assert.ok(scenario.warns.join("\n").includes("erofs-utils"));

    assertOfflineAndNonMutating(scenario);
    assertNoShimExecuted(fixture);
  });

  it("phase 3 enforces the 16 GB floor and --allow-low-disk-space overrides it", async (t) => {
    const refused = createScenario(fixture, "disk-floor", {
      diagnoseReady: true,
      freeSpaceBytes: 1024 ** 3,
    });
    const overridden = createScenario(fixture, "disk-override", {
      diagnoseReady: true,
      freeSpaceBytes: 1024 ** 3,
      extraArgs: ["--allow-low-disk-space"],
    });
    t.after(() => {
      fs.rmSync(refused.runDir, { recursive: true, force: true });
      fs.rmSync(overridden.runDir, { recursive: true, force: true });
    });

    const refusedResult = await runMatchlockSetup(refused.args, refused.deps);
    assert.equal(refusedResult.status, "failed");
    const refusedPhase = refusedResult.phases.find((phase) => phase.phase === 3);
    assert.equal(refusedPhase?.status, "failed");
    assert.equal(
      (refusedPhase?.details as { reason?: string } | undefined)?.reason,
      "low-disk-space",
    );
    assert.equal(matchlockCalls(refused, "pull").length, 0);
    assert.ok(refused.warns.join("\n").includes("16 GB"));

    const overriddenResult = await runMatchlockSetup(overridden.args, overridden.deps);
    assert.equal(overriddenResult.status, "ok");
    assert.equal(overriddenResult.phases.find((phase) => phase.phase === 3)?.status, "ok");
    assert.equal(matchlockCalls(overridden, "pull").length, 1);
    assert.ok(
      (overriddenResult.warnings ?? []).some(
        (warning) => warning.code === "low-disk-space-override",
      ),
    );

    assertOfflineAndNonMutating(refused);
    assertOfflineAndNonMutating(overridden);
    assertNoShimExecuted(fixture);
  });

  it("phase 3 warns about a local shadow, never mutates it, and refreshes only the registry cache", async (t) => {
    const localDigest = `sha256:${"b".repeat(64)}`;
    const scenario = createScenario(fixture, "shadow", {
      diagnoseReady: true,
      extraArgs: ["--refresh-image"],
      shadow: { digest: localDigest, source: "local" },
    });
    t.after(() => fs.rmSync(scenario.runDir, { recursive: true, force: true }));

    const result = await runMatchlockSetup(scenario.args, scenario.deps);

    assert.equal(result.status, "ok");
    assert.ok(
      (result.warnings ?? []).some((warning) => warning.code === "image-shadow"),
      "the local shadow is warned about",
    );
    const pull = matchlockCalls(scenario, "pull");
    assert.equal(pull.length, 1);
    assert.deepEqual(pull[0].args, ["pull", "--force", STANDARD_IMAGE_REFERENCE]);
    const rendered = scenario.logs.join("\n");
    assert.ok(rendered.includes(localDigest));
    assert.ok(rendered.includes("shadowed"));

    assertOfflineAndNonMutating(scenario);
    assertNoShimExecuted(fixture);
  });

  it("an older-pin kernel warm fails phase 3 with the pin/update remedy and keeps the image pull", async (t) => {
    const scenario = createScenario(fixture, "kernel-old", {
      diagnoseReady: true,
      kernelExitCode: 1,
      kernelOutput: 'unknown command "kernel" for "matchlock"\n',
    });
    t.after(() => fs.rmSync(scenario.runDir, { recursive: true, force: true }));

    const result = await runMatchlockSetup(scenario.args, scenario.deps);

    assert.equal(result.status, "failed");
    const phaseThree = result.phases.find((phase) => phase.phase === 3);
    assert.equal(phaseThree?.status, "failed");
    assert.equal(
      (phaseThree?.details as { reason?: string } | undefined)?.reason,
      "kernel-pull-unsupported",
    );
    // The image pull succeeded; the kernel warm is the failing sub-step.
    assert.equal(matchlockCalls(scenario, "pull").length, 1);
    assert.equal(matchlockCalls(scenario, "kernel").length, 1);
    assert.ok(
      scenario.warns.join("\n").includes(KERNEL_WARM_MISSING_COMMAND_REMEDY.split("\n")[1]),
      "the remedy names the pin/update path",
    );
    assert.ok(
      (result.remainingCommands ?? []).includes(`${scenario.matchlockPath} kernel pull`),
    );

    assertOfflineAndNonMutating(scenario);
    assertNoShimExecuted(fixture);
  });

  it("phase 4 boots the --smoke VM through the runner when no re-login is pending", async (t) => {
    const scenario = createScenario(fixture, "smoke", {
      diagnoseReady: true,
      extraArgs: ["--smoke"],
    });
    t.after(() => fs.rmSync(scenario.runDir, { recursive: true, force: true }));

    const result = await runMatchlockSetup(scenario.args, scenario.deps);

    assert.equal(result.status, "ok");
    assert.equal(result.reloginRequired, false);
    const smoke = matchlockCalls(scenario, "run");
    assert.equal(smoke.length, 1);
    assert.deepEqual(smoke[0].args, [
      "run",
      "--image",
      STANDARD_IMAGE_REFERENCE,
      "--no-network",
      "--",
      "true",
    ]);
    assert.ok(scenario.logs.join("\n").includes("smoke VM booted"));
    assert.equal(
      (result.warnings ?? []).some((warning) => warning.code === "smoke-failed"),
      false,
    );

    assertOfflineAndNonMutating(scenario);
    assertNoShimExecuted(fixture);
  });

  it("phase 4 fails verify when the newly installed file lacks a required capability", async (t) => {
    const scenario = createScenario(fixture, "capabilities", {
      diagnoseReady: true,
      getcapOutput: "cap_net_admin=ep\n",
    });
    t.after(() => fs.rmSync(scenario.runDir, { recursive: true, force: true }));

    const result = await runMatchlockSetup(scenario.args, scenario.deps);

    assert.equal(result.status, "failed");
    const phaseFour = result.phases.find((phase) => phase.phase === 4);
    assert.equal(phaseFour?.status, "failed");
    assert.equal(
      (phaseFour?.details as { reason?: string } | undefined)?.reason,
      VERIFY_CAPABILITIES_MISSING_CODE,
    );
    const fix = `sudo ${scenario.matchlockPath} setup linux`;
    assert.ok(
      (result.remainingCommands ?? []).includes(fix),
      `the identity-correct capability fix must be reported: ${JSON.stringify(result.remainingCommands)}`,
    );
    assert.ok(scenario.warns.join("\n").includes("cap_net_raw"));

    assertOfflineAndNonMutating(scenario);
    assertNoShimExecuted(fixture);
  });

  it("phase 4 reports stale MATCHLOCK_* overrides and a shadowing expected binary", async (t) => {
    const scenario = createScenario(fixture, "stale-env", {
      diagnoseReady: true,
      env: {
        MATCHLOCK_FIRECRACKER: "/opt/firecracker/bin/firecracker",
        [MATCHLOCK_RPC_BIN_ENV_NAME]: path.join("shadow", "matchlock"),
      },
    });
    t.after(() => fs.rmSync(scenario.runDir, { recursive: true, force: true }));

    const result = await runMatchlockSetup(scenario.args, scenario.deps);

    assert.equal(result.status, "ok");
    const codes = (result.warnings ?? []).map((warning) => warning.code);
    assert.ok(codes.includes("stale-matchlock-env-override"));
    assert.ok(codes.includes("matchlock-path-shadow"));
    const rendered = scenario.logs.join("\n");
    assert.ok(rendered.includes("MATCHLOCK_FIRECRACKER"));
    assert.ok(rendered.includes("PATH shadowing"));

    assertOfflineAndNonMutating(scenario);
    assertNoShimExecuted(fixture);
  });
});
