/**
 * --no-hurry-please-save-tokens-mode → pi-token-saver harness preference.
 *
 * No-hurry runs prefer a `pi-token-saver` command from PATH over `pi` for
 * every work spawn. Resolution happens PER INVOCATION, so installing
 * pi-token-saver mid-run takes effect on the next round; when absent, `pi`
 * is used as usual. TAMANDUA_PI_BINARY (the config/test seam) always wins.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import path from "node:path";
import { findPiBinary, executeDispatchRound } from "../dist/installer/agent-scheduler.js";

let tempDir: string;
let savedPath: string | undefined;
let savedPiBinary: string | undefined;
let savedHome: string | undefined;
let savedStateDir: string | undefined;
let savedDbPath: string | undefined;

function makeExecutable(dir: string, name: string, body = "#!/bin/sh\nexit 0\n"): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, { mode: 0o755 });
  return p;
}

beforeEach(() => {
  tempDir = tamanduaTempDir("tamandua-token-saver-");
  savedPath = process.env.PATH;
  savedPiBinary = process.env.TAMANDUA_PI_BINARY;
  savedHome = process.env.HOME;
  savedStateDir = process.env.TAMANDUA_STATE_DIR;
  savedDbPath = process.env.TAMANDUA_DB_PATH;
  delete process.env.TAMANDUA_PI_BINARY;
});

afterEach(() => {
  process.env.PATH = savedPath!;
  if (savedPiBinary === undefined) delete process.env.TAMANDUA_PI_BINARY;
  else process.env.TAMANDUA_PI_BINARY = savedPiBinary;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
  else process.env.TAMANDUA_STATE_DIR = savedStateDir;
  if (savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
  else process.env.TAMANDUA_DB_PATH = savedDbPath;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("findPiBinary pi-token-saver preference", () => {
  it("prefers pi-token-saver over pi when preferTokenSaver is set and both exist", async () => {
    const binDir = path.join(tempDir, "bin");
    fs.mkdirSync(binDir);
    const pi = makeExecutable(binDir, "pi");
    const saver = makeExecutable(binDir, "pi-token-saver");
    process.env.PATH = binDir;

    assert.equal(await findPiBinary({ preferTokenSaver: true }), saver);
    assert.equal(await findPiBinary({ preferTokenSaver: false }), pi);
    assert.equal(await findPiBinary(), pi);
  });

  it("falls back to pi when pi-token-saver is not installed", async () => {
    const binDir = path.join(tempDir, "bin");
    fs.mkdirSync(binDir);
    const pi = makeExecutable(binDir, "pi");
    process.env.PATH = binDir;

    assert.equal(await findPiBinary({ preferTokenSaver: true }), pi);
  });

  it("picks up pi-token-saver appearing on PATH mid-run (per-invocation resolution)", async () => {
    const binDir = path.join(tempDir, "bin");
    fs.mkdirSync(binDir);
    const pi = makeExecutable(binDir, "pi");
    process.env.PATH = binDir;

    assert.equal(await findPiBinary({ preferTokenSaver: true }), pi);

    // "Install" pi-token-saver between rounds — the next resolution must find it.
    const saver = makeExecutable(binDir, "pi-token-saver");
    assert.equal(await findPiBinary({ preferTokenSaver: true }), saver);
  });

  it("TAMANDUA_PI_BINARY overrides pi-token-saver preference (test/config seam)", async () => {
    const binDir = path.join(tempDir, "bin");
    fs.mkdirSync(binDir);
    makeExecutable(binDir, "pi");
    makeExecutable(binDir, "pi-token-saver");
    const pinned = makeExecutable(tempDir, "pinned-pi");
    process.env.PATH = binDir;
    process.env.TAMANDUA_PI_BINARY = pinned;

    assert.equal(await findPiBinary({ preferTokenSaver: true }), pinned);
  });

  it("throws when neither pi nor pi-token-saver exists", async () => {
    process.env.PATH = path.join(tempDir, "empty");
    await assert.rejects(() => findPiBinary({ preferTokenSaver: true }), /pi binary not found/);
  });
});

describe("dispatch round spawns pi-token-saver for no-hurry runs", () => {
  it("no-hurry run context routes the work spawn to pi-token-saver; normal runs use pi", async () => {
    const homeDir = path.join(tempDir, "home");
    const stateDir = path.join(homeDir, ".tamandua");
    const workdir = path.join(tempDir, "work");
    const binDir = path.join(tempDir, "bin");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(workdir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });

    const piMarker = path.join(tempDir, "pi-invocations.log");
    const saverMarker = path.join(tempDir, "saver-invocations.log");
    makeExecutable(binDir, "pi", `#!/bin/sh\necho x >> "${piMarker}"\necho "NO_WORK_AVAILABLE"\n`);
    makeExecutable(binDir, "pi-token-saver", `#!/bin/sh\necho x >> "${saverMarker}"\necho "NO_WORK_AVAILABLE"\n`);

    process.env.PATH = binDir;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
    delete process.env.TAMANDUA_PI_BINARY;

    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const now = new Date().toISOString();

    const seedRun = (runId: string, noHurry: boolean) => {
      db.prepare(
        "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-saver', 'task', 'running', ?, 0, ?, ?)",
      ).run(runId, JSON.stringify({ no_hurry_save_tokens_mode: String(noHurry) }), now, now);
      db.prepare(
        "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'work', 'wf-saver_dev', 0, 'work', '', 'pending', ?, ?)",
      ).run(`${runId}-step`, runId, now, now);
    };

    const round = (runId: string) =>
      executeDispatchRound(
        {
          id: `job-${runId}`,
          workflowId: "wf-saver",
          agentId: "wf-saver_dev",
          runId,
          timeoutSeconds: 30,
          workingDirectoryForHarness: workdir,
          createdAt: now,
        },
        { id: "dev", role: "coding", workspace: { baseDir: workdir } },
      );

    // DB fixtures use bare IDs; run- is the external typed-ID prefix and is
    // stripped by executeDispatchRound's step lookup.
    seedRun("no-hurry", true);
    await round("no-hurry");
    assert.ok(fs.existsSync(saverMarker), "no-hurry run should spawn pi-token-saver");
    assert.ok(!fs.existsSync(piMarker), "no-hurry run should not spawn pi when the saver exists");

    seedRun("normal", false);
    await round("normal");
    assert.ok(fs.existsSync(piMarker), "normal run should spawn pi");
    assert.equal(
      fs.readFileSync(saverMarker, "utf-8").trim().split("\n").length,
      1,
      "normal run must not add pi-token-saver invocations",
    );
  });
});
