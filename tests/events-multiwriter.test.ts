/**
 * EVTA US-008 — cross-process append integrity for the shared all.jsonl.
 *
 * Two independent writer processes each emit many events whose `detail`
 * fields exceed 4 KiB (well past PIPE_BUF, where a single O_APPEND write is
 * no longer guaranteed atomic by POSIX). The per-file advisory lock plus the
 * one-O_APPEND-write-per-line append must leave a file in which EVERY line is
 * a complete, parseable JSON object, every expected event is present exactly
 * once, and no lock is left behind.
 *
 * Serial lane: this file spawns child processes, so it is registered in
 * tests/serial-files.txt.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { tamanduaTempDir } from "../src/lib/temp-dir.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const EVENTS_MODULE_URL = pathToFileURL(
  path.join(REPO_ROOT, "dist", "installer", "events.js"),
).href;

/**
 * Writer child. Emits EVTA_WORKER_COUNT events into all.jsonl (and its own
 * run-scoped file) with a > 4 KiB detail, yielding between batches so the two
 * processes genuinely overlap.
 */
const WORKER_SOURCE = `
const eventsUrl = process.env.EVTA_EVENTS_MODULE_URL;
const workerId = process.env.EVTA_WORKER_ID;
const count = Number(process.env.EVTA_WORKER_COUNT);
const detailLen = Number(process.env.EVTA_DETAIL_LEN);
const { emitEvent } = await import(eventsUrl);
for (let i = 0; i < count; i++) {
  emitEvent({
    ts: new Date().toISOString(),
    event: "multiwriter.event",
    runId: "run-mw-" + workerId,
    detail: workerId + ":" + i + ":" + "x".repeat(detailLen),
  });
  if (i % 5 === 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
`;

function runWriter(env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", WORKER_SOURCE], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`event writer exited with ${code}: ${stderr}`));
    });
  });
}

describe("events multiwriter (EVTA US-008)", () => {
  it("two processes interleaving >4 KiB lines leave only complete parseable JSONL lines", async () => {
    const stateDir = tamanduaTempDir("tamandua-evta-multiwriter-");
    const COUNT = 60;
    const DETAIL_LEN = 5000;
    try {
      // Build the child env EXPLICITLY (never spread the whole process env):
      // only the isolated state/db paths plus the EVTA knobs the writer needs.
      const baseEnv: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: stateDir,
        TAMANDUA_TEST_GUARD: "1",
        TAMANDUA_TEST_GUARD_LEDGER: process.env.TAMANDUA_TEST_GUARD_LEDGER,
        TAMANDUA_STATE_DIR: stateDir,
        TAMANDUA_DB_PATH: path.join(stateDir, "tamandua.db"),
        TAMANDUA_EVENT_LOCK_TIMEOUT_MS: "10000",
        EVTA_EVENTS_MODULE_URL: EVENTS_MODULE_URL,
        EVTA_WORKER_COUNT: String(COUNT),
        EVTA_DETAIL_LEN: String(DETAIL_LEN),
      };

      await Promise.all([
        runWriter({ ...baseEnv, EVTA_WORKER_ID: "A" }),
        runWriter({ ...baseEnv, EVTA_WORKER_ID: "B" }),
      ]);

      const allFile = path.join(stateDir, "events", "all.jsonl");
      const raw = fs.readFileSync(allFile, "utf-8");

      // A torn last line would either lack the final newline or fail JSON.parse.
      assert.equal(raw[raw.length - 1], "\n", "all.jsonl must end with a newline");
      const complete = raw.split("\n").slice(0, -1);
      assert.equal(complete.length, COUNT * 2, "every emitted event must be present exactly once");

      const perWorker = new Map<string, number>();
      for (const line of complete) {
        assert.ok(
          Buffer.byteLength(line) > 4096,
          `every line must exceed 4 KiB (got ${Buffer.byteLength(line)})`,
        );
        // JSON.parse throws on any torn / concatenated line.
        const parsed = JSON.parse(line);
        assert.equal(parsed.event, "multiwriter.event");
        const workerId = String(parsed.runId).replace("run-mw-", "");
        perWorker.set(workerId, (perWorker.get(workerId) ?? 0) + 1);
      }
      assert.equal(perWorker.get("A"), COUNT, "worker A events must all be present");
      assert.equal(perWorker.get("B"), COUNT, "worker B events must all be present");

      // The advisory lock must have been released by every writer.
      assert.ok(!fs.existsSync(`${allFile}.lock`), "advisory lock must be released");

      // Run-scoped files honour the single-writer-per-run contract too.
      for (const workerId of ["A", "B"]) {
        const runFile = path.join(stateDir, "events", `run-mw-${workerId}.jsonl`);
        const runLines = fs.readFileSync(runFile, "utf-8").split("\n").slice(0, -1);
        assert.equal(runLines.length, COUNT, `run-mw-${workerId} must have ${COUNT} lines`);
        for (const line of runLines) JSON.parse(line);
      }
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
