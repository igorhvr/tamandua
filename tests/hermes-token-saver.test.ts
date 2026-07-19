/**
 * --no-hurry-please-save-tokens-mode → hermes-token-saver harness preference.
 *
 * No-hurry runs prefer a `hermes-token-saver` command from PATH over `hermes` for
 * every work spawn. Resolution happens PER INVOCATION, so installing
 * hermes-token-saver mid-run takes effect on the next round; when absent, `hermes`
 * is used as usual. TAMANDUA_HERMES_BINARY (the config/test seam) always wins.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import path from "node:path";
import { getHarnessAdapter } from "../dist/installer/harness-adapter.js";
import { executeDispatchRound } from "../dist/installer/agent-scheduler.js";

let tempDir: string;
let savedPath: string | undefined;
let savedHermesBinary: string | undefined;
let savedHome: string | undefined;
let savedStateDir: string | undefined;
let savedDbPath: string | undefined;

function makeExecutable(dir: string, name: string, body = "#!/bin/sh\nexit 0\n"): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, { mode: 0o755 });
  return p;
}

beforeEach(() => {
  tempDir = tamanduaTempDir("tamandua-hermes-token-saver-");
  savedPath = process.env.PATH;
  savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
  savedHome = process.env.HOME;
  savedStateDir = process.env.TAMANDUA_STATE_DIR;
  savedDbPath = process.env.TAMANDUA_DB_PATH;
  delete process.env.TAMANDUA_HERMES_BINARY;
});

afterEach(() => {
  process.env.PATH = savedPath!;
  if (savedHermesBinary === undefined) delete process.env.TAMANDUA_HERMES_BINARY;
  else process.env.TAMANDUA_HERMES_BINARY = savedHermesBinary;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
  else process.env.TAMANDUA_STATE_DIR = savedStateDir;
  if (savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
  else process.env.TAMANDUA_DB_PATH = savedDbPath;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("findBinary hermes-token-saver preference", () => {
  it("prefers hermes-token-saver over hermes when preferTokenSaver is set and both exist", async () => {
    const binDir = path.join(tempDir, "bin");
    fs.mkdirSync(binDir);
    const hermes = makeExecutable(binDir, "hermes");
    const saver = makeExecutable(binDir, "hermes-token-saver");
    process.env.PATH = binDir;

    const adapter = getHarnessAdapter("hermes");
    assert.equal(await adapter.findBinary({ preferTokenSaver: true }), saver);
    assert.equal(await adapter.findBinary({ preferTokenSaver: false }), hermes);
    assert.equal(await adapter.findBinary(), hermes);
  });

  it("falls back to hermes when hermes-token-saver is not installed", async () => {
    const binDir = path.join(tempDir, "bin");
    fs.mkdirSync(binDir);
    const hermes = makeExecutable(binDir, "hermes");
    process.env.PATH = binDir;

    const adapter = getHarnessAdapter("hermes");
    assert.equal(await adapter.findBinary({ preferTokenSaver: true }), hermes);
  });

  it("picks up hermes-token-saver appearing on PATH mid-run (per-invocation resolution)", async () => {
    const binDir = path.join(tempDir, "bin");
    fs.mkdirSync(binDir);
    const hermes = makeExecutable(binDir, "hermes");
    process.env.PATH = binDir;

    const adapter = getHarnessAdapter("hermes");
    assert.equal(await adapter.findBinary({ preferTokenSaver: true }), hermes);

    // "Install" hermes-token-saver between rounds — the next resolution must find it.
    const saver = makeExecutable(binDir, "hermes-token-saver");
    assert.equal(await adapter.findBinary({ preferTokenSaver: true }), saver);
  });

  it("TAMANDUA_HERMES_BINARY overrides hermes-token-saver preference (test/config seam)", async () => {
    const binDir = path.join(tempDir, "bin");
    fs.mkdirSync(binDir);
    makeExecutable(binDir, "hermes");
    makeExecutable(binDir, "hermes-token-saver");
    const pinned = makeExecutable(tempDir, "pinned-hermes");
    process.env.PATH = binDir;
    process.env.TAMANDUA_HERMES_BINARY = pinned;

    const adapter = getHarnessAdapter("hermes");
    assert.equal(await adapter.findBinary({ preferTokenSaver: true }), pinned);
  });

  it("throws when neither hermes nor hermes-token-saver exists", async () => {
    process.env.PATH = path.join(tempDir, "empty");
    const adapter = getHarnessAdapter("hermes");
    await assert.rejects(() => adapter.findBinary({ preferTokenSaver: true }), /hermes binary not found/);
  });
});

describe("dispatch round spawns hermes-token-saver for no-hurry runs", () => {
  it("no-hurry run context routes the work spawn to hermes-token-saver; normal runs use hermes", async () => {
    const homeDir = path.join(tempDir, "home");
    const stateDir = path.join(homeDir, ".tamandua");
    const workdir = path.join(tempDir, "work");
    const binDir = path.join(tempDir, "bin");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(workdir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });

    const hermesMarker = path.join(tempDir, "hermes-invocations.log");
    const saverMarker = path.join(tempDir, "saver-invocations.log");
    makeExecutable(binDir, "hermes", `#!/bin/sh\necho x >> "${hermesMarker}"\necho "NO_WORK_AVAILABLE"\n`);
    makeExecutable(binDir, "hermes-token-saver", `#!/bin/sh\necho x >> "${saverMarker}"\necho "NO_WORK_AVAILABLE"\n`);

    process.env.PATH = binDir;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_STATE_DIR = stateDir;
    process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
    delete process.env.TAMANDUA_HERMES_BINARY;

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
          harnessType: "hermes",
          createdAt: now,
        },
        { id: "dev", role: "coding", workspace: { baseDir: workdir } },
      );

    // DB fixtures use bare IDs; run- is the external typed-ID prefix and is
    // stripped by executeDispatchRound's step lookup.
    seedRun("no-hurry", true);
    await round("no-hurry");
    assert.ok(fs.existsSync(saverMarker), "no-hurry run should spawn hermes-token-saver");
    assert.ok(!fs.existsSync(hermesMarker), "no-hurry run should not spawn hermes when the saver exists");

    seedRun("normal", false);
    await round("normal");
    assert.ok(fs.existsSync(hermesMarker), "normal run should spawn hermes");
    assert.equal(
      fs.readFileSync(saverMarker, "utf-8").trim().split("\n").length,
      1,
      "normal run must not add hermes-token-saver invocations",
    );
  });
});
