/**
 * IFLB US-007: launch-time harness probe support in the torture scripted
 * runtimes — recognition, real command execution, and the no-index /
 * no-journal rule.
 *
 * The product dispatch motor runs a launch-time harness probe at a run's
 * FIRST real dispatch (see src/installer/harness-probe.ts): the harness is
 * spawned with a probe prompt whose first line is the stable marker
 * `TAMANDUA_HARNESS_PROBE: skill-path`, followed by an instruction to run the
 * exact command `<launcher> skill-path` (an absolute CLI launcher path) and
 * reply with the PATH and nothing else. The torture scripted tiers drive real
 * tamandua runs whose harness is the forked scripted pi / hermes runtime
 * (torture-test/scripted-runtimes), so those runtimes must answer the probe —
 * otherwise every scenario run force-fails before its first work round.
 *
 * Verifies:
 *  1. runtime-shared.mjs probe helpers: marker recognition (first line only),
 *     quoted-command extraction, quote-aware argv split, and real execution
 *     of the exact `<launcher> skill-path` command returning its stdout path.
 *  2. The scripted-pi runtime answers a probe prompt in its own output
 *     contract (a pi-shaped message_end whose assistant text is the PATH,
 *     zero tokens), exits 0, and — critically — does NOT journal an
 *     invocation and does NOT consume a canned-behaviors work index (a
 *     subsequent work round for the same agent still starts at index 0).
 *  3. The scripted-hermes runtime answers a probe prompt as a plain-text
 *     PATH on stdout, exits 0, writes NO state.db session row and no
 *     session_id trailer, and equally never journals / never consumes a work
 *     index.
 *  4. A failing `<launcher> skill-path` command makes the runtime reply with
 *     the failure text and exit non-zero (the daemon turns that into a
 *     `FAILURE_CLASS: harness_unavailable` force-fail).
 *
 * Existing behaviors.json files and scenario-workflow-parity are unaffected:
 * the probe is not a work round, so no canned invocation index moves and no
 * invocation journal line is written.
 *
 * Picked up by self-tests/run.sh's `tier0-*.test.ts` glob (bounded, no
 * daemon, zero tokens — spawns only the scripted runtimes + a fake launcher
 * shim).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { tamanduaTempDir } from "../../src/lib/temp-dir.ts";

const sharedModulePath = path.resolve(
  process.cwd(),
  "torture-test/scripted-runtimes/runtime-shared.mjs",
);
const runtimePiPath = path.resolve(
  process.cwd(),
  "torture-test/scripted-runtimes/runtime-pi.mjs",
);
const runtimeHermesPath = path.resolve(
  process.cwd(),
  "torture-test/scripted-runtimes/runtime-hermes.mjs",
);

function makeTempDir(): string {
  return tamanduaTempDir("tier0-probe-runtime-");
}

function cleanup(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/**
 * Create a fake `<launcher>` shim that answers `skill-path` with an absolute
 * path under tmpDir. Mirrors the real CLI launcher the daemon quotes into the
 * probe prompt (never a bare `tamandua`). Returns { launcher, skillPath }.
 */
function createFakeLauncher(tmpDir: string): { launcher: string; skillPath: string } {
  const binDir = path.join(tmpDir, "launcher-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const launcher = path.join(binDir, "tamandua");
  const skillPath = path.join(tmpDir, "skills", "tamandua-agents");
  fs.writeFileSync(
    launcher,
    `#!/usr/bin/env bash
# Fake tamandua launcher — only skill-path is probed.
if [ "$1" = "skill-path" ]; then
  printf '%s\\n' "${skillPath}"
  exit 0
fi
exit 1
`,
    { mode: 0o755 },
  );
  fs.chmodSync(launcher, 0o755);
  return { launcher, skillPath };
}

/** Build the exact probe prompt the daemon produces. */
function buildProbePrompt(launcher: string): string {
  return `TAMANDUA_HARNESS_PROBE: skill-path\nRun the exact command "${launcher} skill-path" and reply with the PATH and nothing else.`;
}

/**
 * Create a mock tamandua CLI that answers step peek / claim / complete with
 * canned outputs (used by work-round spawns so the runtime can complete the
 * step protocol). Returns the path to the script.
 */
function createMockCli(tmpDir: string): string {
  const cliPath = path.join(tmpDir, "bin", "tamandua");
  const capturePath = path.join(tmpDir, "cli-calls.jsonl");
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  fs.writeFileSync(
    cliPath,
    `#!/usr/bin/env bash
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> ${JSON.stringify(capturePath)}
case "$1" in
  peek|"step")
    if [ "$1" = "peek" ] || ([ "$1" = "step" ] && [ "$2" = "peek" ]); then
      echo "HAS_WORK"
      exit 0
    fi
    if [ "$1" = "step" ] && [ "$2" = "claim" ]; then
      echo '{"stepId":"step-00000000-0000-0000-0000-000000000001","runId":"run-a1c557f2-ba6e-4088-ae59-0d8892ce6e32","input":"TEST_TASK: probe no-index work round\\n"}'
      exit 0
    fi
    if [ "$1" = "step" ] && ([ "$2" = "complete" ] || [ "$2" = "fail" ]); then
      exit 0
    fi
    ;;
esac
exit 0
`,
    "utf-8",
  );
  fs.chmodSync(cliPath, 0o755);
  return cliPath;
}

/** Build a synthetic work prompt the runtimes can parse. */
function buildWorkPrompt(cliPath: string): string {
  return `You are agent "developer" for workflow "test-wf", agent "test-wf_developer", run "run-a1c557f2-ba6e-4088-ae59-0d8892ce6e32".

CLAIM:
"${cliPath}" step claim "test-wf_developer" --run-id "a1c557f2-ba6e-4088-ae59-0d8892ce6e32"
`;
}

function createBehaviorsFile(tmpDir: string, agents: Record<string, unknown>): string {
  const config = { agents, heartbeatTokens: 17, defaultTokens: 111 };
  const behaviorsPath = path.join(tmpDir, "behaviors.json");
  fs.writeFileSync(behaviorsPath, JSON.stringify(config), "utf-8");
  return behaviorsPath;
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** Spawn a runtime .mjs with the given argv; returns stdout/stderr/exitCode. */
function spawnRuntime(
  runtimePath: string,
  argv: string[],
  env: Record<string, string>,
  timeoutMs = 15000,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runtimePath, ...argv], {
      encoding: "utf-8",
      cwd: path.dirname(runtimePath),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data: string) => {
      stdout += data;
    });
    child.stderr.on("data", (data: string) => {
      stderr += data;
    });
    child.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
    child.on("error", (err) => {
      resolve({ stdout, stderr: String(err), exitCode: null });
    });
  });
}

/** State-dir side-effect helper: any workcount or invocation journal file? */
function stateDirArtifacts(stateDir: string): string[] {
  try {
    return fs.readdirSync(stateDir).sort();
  } catch {
    return [];
  }
}

/** Parse NDJSON message_end assistant text (pi output contract). */
function parsePiMessageEnd(output: string): { text: string; totalTokens: number } | null {
  for (const line of output.split("\n")) {
    let parsed: any = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed?.type === "message_end") {
      const text = parsed?.message?.content?.[0]?.text ?? "";
      const totalTokens = parsed?.message?.usage?.totalTokens ?? 0;
      return { text, totalTokens };
    }
  }
  return null;
}

/** Read the last journaled work round of invocations.jsonl (if any). */
function lastJournaledWorkIndex(stateDir: string): number | null {
  const journalPath = path.join(stateDir, "invocations.jsonl");
  if (!fs.existsSync(journalPath)) return null;
  const lines = fs
    .readFileSync(journalPath, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry?.phase === "work" && typeof entry?.workIndex === "number") {
        return entry.workIndex;
      }
    } catch {
      // ignore malformed journal lines
    }
  }
  return null;
}

describe("IFLB US-007: scripted runtime launch-time harness probe support", () => {
  describe("runtime-shared.mjs probe helpers", () => {
    it("isHarnessProbePrompt recognizes the marker as the first line only", async () => {
      const mod = await import(sharedModulePath);
      const launcher = "/abs/path/tamandua";
      const probePrompt = buildProbePrompt(launcher);
      assert.equal(mod.isHarnessProbePrompt(probePrompt), true);
      assert.equal(
        mod.isHarnessProbePrompt(
          'workflow "test-wf", agent "test-wf_developer", run "run-x"\n"/abs/tamandua" step claim',
        ),
        false,
        "work prompts are not probes",
      );
      assert.equal(
        mod.isHarnessProbePrompt(
          `lead-in line\n${probePrompt}`,
        ),
        false,
        "marker must be the first line",
      );
      assert.equal(mod.isHarnessProbePrompt(""), false);
    });

    it("parseHarnessProbeCommand extracts the exact quoted command", async () => {
      const mod = await import(sharedModulePath);
      const cmd = mod.parseHarnessProbeCommand(buildProbePrompt("/abs/launcher"));
      assert.equal(cmd, "/abs/launcher skill-path");
      assert.equal(
        mod.parseHarnessProbeCommand('workflow "x", agent "y", run "z"'),
        null,
        "non-probe prompts return null",
      );
    });

    it("splitProbeCommand is quote-aware", async () => {
      const mod = await import(sharedModulePath);
      assert.deepEqual(mod.splitProbeCommand("/abs/launcher skill-path"), [
        "/abs/launcher",
        "skill-path",
      ]);
      assert.deepEqual(mod.splitProbeCommand('"/dir with spaces/tamandua" skill-path'), [
        "/dir with spaces/tamandua",
        "skill-path",
      ]);
    });

    it("execHarnessProbe runs the exact quoted command for real and returns its stdout path", async () => {
      const mod = await import(sharedModulePath);
      const tmp = makeTempDir();
      try {
        const { launcher, skillPath } = createFakeLauncher(tmp);
        const result = mod.execHarnessProbe(buildProbePrompt(launcher));
        assert.equal(result.ok, true);
        assert.equal(result.path, skillPath);
        assert.equal(result.exitCode, 0);
        assert.equal(result.signal, null);
      } finally {
        cleanup(tmp);
      }
    });

    it("execHarnessProbe returns ok:false for a failing command and a non-probe prompt", async () => {
      const mod = await import(sharedModulePath);
      const tmp = makeTempDir();
      try {
        const { launcher } = createFakeLauncher(tmp);
        const bad = path.join(tmp, "bad-launcher");
        fs.writeFileSync(bad, "#!/usr/bin/env bash\nexit 3\n", { mode: 0o755 });
        const dead = mod.execHarnessProbe(buildProbePrompt(bad));
        assert.equal(dead.ok, false);
        assert.equal(dead.exitCode, 3);
        assert.equal(dead.path, "");
        const nonProbe = mod.execHarnessProbe('workflow "x", agent "y", run "z"');
        assert.equal(nonProbe.ok, false);
        assert.equal(nonProbe.exitCode, 2);
        // Sanity: the good launcher still works (control).
        const good = mod.execHarnessProbe(buildProbePrompt(launcher));
        assert.equal(good.ok, true);
      } finally {
        cleanup(tmp);
      }
    });
  });

  describe("scripted pi runtime probe answer", () => {
    it("answers with the PATH in a message_end, exits 0, and never journals or consumes a work index", async () => {
      const tmp = makeTempDir();
      try {
        const { launcher, skillPath } = createFakeLauncher(tmp);
        const cliPath = createMockCli(tmp);
        const behaviorsPath = createBehaviorsFile(tmp, {
          "test-wf_developer": { output: "STATUS: done\nCHANGES: probe test" },
        });
        const stateDir = path.join(tmp, "state");
        fs.mkdirSync(stateDir, { recursive: true });
        const baseEnv: Record<string, string> = {
          PATH: `${path.join(tmp, "bin")}:${process.env.PATH ?? ""}`,
          TAMANDUA_SCRIPTED_BEHAVIORS: behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: stateDir,
        };

        // 1) Probe round: pi-shaped message_end carrying the PATH, exit 0.
        const probe = await spawnRuntime(runtimePiPath, ["--print", "--mode", "json", buildProbePrompt(launcher)], baseEnv);
        assert.equal(probe.exitCode, 0, `probe should exit 0; stderr: ${probe.stderr.slice(0, 500)}`);
        const msg = parsePiMessageEnd(probe.stdout);
        assert.ok(msg, `expected a message_end event, got stdout: ${probe.stdout.slice(0, 500)}`);
        assert.equal(msg!.text, skillPath, "message_end assistant text must be the PATH");
        assert.equal(msg!.totalTokens, 0, "probe reply must carry zero tokens");
        assert.equal(probe.stderr, "", "no stderr expected on a successful probe");
        assert.deepEqual(
          stateDirArtifacts(stateDir),
          [],
          "probe answer must not journal an invocation or create a workcount file",
        );

        // 2) Work round in the SAME state dir: must start at work index 0 —
        //    the probe did not consume a canned-behaviors invocation index.
        const work = await spawnRuntime(runtimePiPath, ["--print", "--mode", "json", buildWorkPrompt(cliPath)], baseEnv);
        assert.equal(work.exitCode, 0, `work round should exit 0; stderr: ${work.stderr.slice(0, 500)}`);
        assert.equal(
          lastJournaledWorkIndex(stateDir),
          0,
          "first work round after a probe must still be index 0 (no index consumption)",
        );
      } finally {
        cleanup(tmp);
      }
    });

    it("exits non-zero with a failure reply when the quoted command fails", async () => {
      const tmp = makeTempDir();
      try {
        const stateDir = path.join(tmp, "state");
        fs.mkdirSync(stateDir, { recursive: true });
        const bad = path.join(tmp, "bad-launcher");
        fs.writeFileSync(bad, "#!/usr/bin/env bash\necho 'boom' >&2\nexit 7\n", { mode: 0o755 });
        const result = await spawnRuntime(
          runtimePiPath,
          ["--print", "--mode", "json", buildProbePrompt(bad)],
          { TAMANDUA_SCRIPTED_STATE: stateDir },
        );
        assert.notEqual(result.exitCode, 0, "failing probe command must exit non-zero");
        const msg = parsePiMessageEnd(result.stdout);
        assert.ok(msg, "expected a message_end failure reply");
        assert.match(msg!.text, /^probe command failed/);
        assert.deepEqual(stateDirArtifacts(stateDir), [], "no journal/index on a failed probe");
      } finally {
        cleanup(tmp);
      }
    });
  });

  describe("scripted hermes runtime probe answer", () => {
    it("answers with the PATH on stdout, exits 0, writes no session row, and never journals or consumes a work index", async () => {
      const tmp = makeTempDir();
      try {
        const { launcher, skillPath } = createFakeLauncher(tmp);
        const cliPath = createMockCli(tmp);
        const behaviorsPath = createBehaviorsFile(tmp, {
          "test-wf_developer": { output: "STATUS: done" },
        });
        const stateDir = path.join(tmp, "state");
        const hermesHome = path.join(tmp, "hermes_home");
        fs.mkdirSync(stateDir, { recursive: true });
        fs.mkdirSync(hermesHome, { recursive: true });
        const baseEnv: Record<string, string> = {
          PATH: `${path.join(tmp, "bin")}:${process.env.PATH ?? ""}`,
          TAMANDUA_SCRIPTED_BEHAVIORS: behaviorsPath,
          TAMANDUA_SCRIPTED_STATE: stateDir,
          HERMES_HOME: hermesHome,
        };

        // 1) Probe round: plain-text PATH on stdout, exit 0, no session trailer.
        const probe = await spawnRuntime(
          runtimeHermesPath,
          ["chat", "--max-turns", "8192", "--yolo", "-Q", "-q", buildProbePrompt(launcher)],
          baseEnv,
        );
        assert.equal(probe.exitCode, 0, `probe should exit 0; stderr: ${probe.stderr.slice(0, 500)}`);
        assert.equal(probe.stdout.trim(), skillPath, "stdout must be exactly the PATH");
        assert.ok(
          !probe.stderr.includes("session_id:"),
          "probe answer must not emit a session_id trailer",
        );
        assert.equal(
          fs.existsSync(path.join(hermesHome, "state.db")),
          false,
          "probe answer must not write a state.db session row",
        );
        assert.deepEqual(
          stateDirArtifacts(stateDir),
          [],
          "probe answer must not journal an invocation or create a workcount file",
        );

        // 2) Work round in the SAME state dir: still starts at work index 0.
        const work = await spawnRuntime(
          runtimeHermesPath,
          ["chat", "--max-turns", "8192", "--yolo", "-Q", "-q", buildWorkPrompt(cliPath)],
          baseEnv,
        );
        assert.equal(work.exitCode, 0, `work round should exit 0; stderr: ${work.stderr.slice(0, 500)}`);
        assert.equal(
          lastJournaledWorkIndex(stateDir),
          0,
          "first work round after a probe must still be index 0 (no index consumption)",
        );
      } finally {
        cleanup(tmp);
      }
    });

    it("exits non-zero with a failure reply when the quoted command fails", async () => {
      const tmp = makeTempDir();
      try {
        const stateDir = path.join(tmp, "state");
        const hermesHome = path.join(tmp, "hermes_home");
        fs.mkdirSync(stateDir, { recursive: true });
        fs.mkdirSync(hermesHome, { recursive: true });
        const bad = path.join(tmp, "bad-launcher");
        fs.writeFileSync(bad, "#!/usr/bin/env bash\nexit 9\n", { mode: 0o755 });
        const result = await spawnRuntime(
          runtimeHermesPath,
          ["chat", "--max-turns", "8192", "--yolo", "-Q", "-q", buildProbePrompt(bad)],
          { TAMANDUA_SCRIPTED_STATE: stateDir, HERMES_HOME: hermesHome },
        );
        assert.notEqual(result.exitCode, 0, "failing probe command must exit non-zero");
        assert.match(result.stdout, /^probe command failed/);
        assert.ok(!result.stderr.includes("session_id:"), "no session trailer on a failed probe");
        assert.equal(fs.existsSync(path.join(hermesHome, "state.db")), false);
        assert.deepEqual(stateDirArtifacts(stateDir), [], "no journal/index on a failed probe");
      } finally {
        cleanup(tmp);
      }
    });
  });
});
