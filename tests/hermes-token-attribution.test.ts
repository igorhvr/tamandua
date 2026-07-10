/**
 * Hermes token attribution integration test.
 *
 * Verifies that hermes dispatch rounds with a captured sessionRef look up
 * token usage from hermes' state.db and attribute it to the run exactly
 * like pi rounds (incrementRunTokenSpend + emit run.tokens.updated).
 *
 * Null lookup (missing session, missing db, etc.) leaves tokens_spent
 * untouched and logs a warning — behavior identical to today.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { cleanChildEnv, createTempHome } from "./helpers/test-env.ts";

const repoRoot = process.cwd();


function seedHermesStateDb(
  hermesHome: string,
  sessionId: string,
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
): void {
  const dbPath = path.join(hermesHome, "state.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      estimated_cost_usd REAL
    )
  `);
  db.prepare(
    "INSERT INTO sessions (id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES (?, ?, ?, ?, ?)",
  ).run(sessionId, tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite);
  db.close();
}

function createFakeHermes(rootDir: string, sessionId: string): string {
  const binPath = path.join(rootDir, "fake-hermes");
  // Real hermes prints session_id to stderr, so the fake must match.
  // The adapter scans stderr first (primary source) then stdout (backward compat).
  fs.writeFileSync(
    binPath,
    `#!/usr/bin/env bash\necho "STATUS: done"\necho "session_id: ${sessionId}" >&2\n`,
    "utf-8",
  );
  fs.chmodSync(binPath, 0o755);
  return binPath;
}

function runHermesDispatchRound(
  homeDir: string,
  fakeHermes: string,
  runId: string,
  stepId: string,
  hermesHome: string,
): Record<string, unknown> {
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    import { executeDispatchRound } from "./dist/installer/agent-scheduler.js";
    import { getDb } from "./dist/db.js";

    const db = getDb();
    const runId = ${JSON.stringify(runId)};
    const now = new Date().toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-hermes', 'test', 'running', ?, 0, ?, ?)"
    ).run(runId, JSON.stringify({ harness_type: "hermes", working_directory_for_harness: process.cwd() }), now, now);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'work', 'wf-hermes_dev', 0, 'do work', 'STATUS', 'pending', ?, ?)"
    ).run(${JSON.stringify(stepId)}, runId, now, now);

    const job = {
      id: "job-hermes-attr",
      workflowId: "wf-hermes",
      agentId: "wf-hermes_dev",
      runId,
      harnessType: "hermes",
      timeoutSeconds: 30,
      workingDirectoryForHarness: process.cwd(),
      createdAt: now,
    };
    await executeDispatchRound(job, { id: "dev", role: "coding", workspace: { baseDir: process.cwd(), files: {} } });

    const run = db.prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId);
    const eventsPath = path.join(process.env.HOME, ".tamandua", "events", runId + ".jsonl");
    const events = fs.existsSync(eventsPath)
      ? fs.readFileSync(eventsPath, "utf-8").split(/\\r?\\n/).filter(Boolean).map((l) => JSON.parse(l))
      : [];
    const tokenEvent = events.find((e) => e.event === "run.tokens.updated");
    const tokenEventCount = events.filter((e) => e.event === "run.tokens.updated").length;
    console.log(JSON.stringify({
      tokensSpent: run.tokens_spent,
      tokenEventDelta: tokenEvent?.tokenDelta ?? null,
      tokenEventCount,
    }));
  `;

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repoRoot,
    env: cleanChildEnv({
      HOME: homeDir,
      TAMANDUA_HERMES_BINARY: fakeHermes,
      HERMES_HOME: hermesHome,
    }),
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`script failed (${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim().split(/\r?\n/).filter(Boolean).pop()!) as Record<string, unknown>;
}

describe("hermes token attribution", () => {
  it("attributes hermes tokens via state.db lookup", () => {
    const temp = createTempHome("tamandua-hermes-attribution-");
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const sessionId = "test-session-123";
    const hermesHome = path.join(temp.root, "hermes-data");
    fs.mkdirSync(hermesHome, { recursive: true });
      // Seed hermes state.db with a completed session worth 375 tokens
      seedHermesStateDb(hermesHome, sessionId, {
        input: 100,
        output: 200,
        cacheRead: 50,
        cacheWrite: 25,
      });

      const fakeHermes = createFakeHermes(temp.root, sessionId);
      const result = runHermesDispatchRound(temp.homeDir, fakeHermes, runId, stepId, hermesHome);

      assert.equal(result.tokensSpent, 325, "tokens_spent should be 325 (100+200+25 — cache_read excluded)");
      assert.equal(result.tokenEventDelta, 325, "tokenEventDelta should match token total (cache_read excluded)");
  });

  it("leaves tokens_spent untouched when session not found in state.db", () => {
    const temp = createTempHome("tamandua-hermes-attribution-");
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const hermesHome = path.join(temp.root, "hermes-data");
    fs.mkdirSync(hermesHome, { recursive: true });
      // Seed state.db but with a DIFFERENT session — the fake hermes
      // will report a session that doesn't exist in the DB.
      seedHermesStateDb(hermesHome, "some-other-session", {
        input: 100, output: 200, cacheRead: 50, cacheWrite: 25,
      });

      const fakeHermes = createFakeHermes(temp.root, "nonexistent-session");
      const result = runHermesDispatchRound(temp.homeDir, fakeHermes, runId, stepId, hermesHome);

      assert.equal(result.tokensSpent, 0, "tokens_spent must remain 0 when session not found");
      assert.equal(result.tokenEventDelta, null, "no token event should be emitted");
  });

  it("leaves tokens_spent untouched when state.db is missing entirely", () => {
    const temp = createTempHome("tamandua-hermes-attribution-");
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const sessionId = "test-session-no-db";
    // hermesHome is an empty dir with NO state.db
    const hermesHome = path.join(temp.root, "hermes-data");
    fs.mkdirSync(hermesHome, { recursive: true });
      const fakeHermes = createFakeHermes(temp.root, sessionId);
      const result = runHermesDispatchRound(temp.homeDir, fakeHermes, runId, stepId, hermesHome);

      assert.equal(result.tokensSpent, 0, "tokens_spent must remain 0 when state.db is missing");
      assert.equal(result.tokenEventDelta, null, "no token event should be emitted");
  });

  it("does not affect pi token path", () => {
    // Verify that the pi token path is untouched — a pi round with JSON
    // output still attributes tokens via parseWorkRoundMetadata, not
    // the hermes lookup path.
    const temp = createTempHome("tamandua-hermes-attribution-");
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const hermesHome = path.join(temp.root, "hermes-data");
    fs.mkdirSync(hermesHome, { recursive: true });
      // Seed a hermes state.db — but the round uses pi, so it should
      // NOT be consulted.
      seedHermesStateDb(hermesHome, "some-session", {
        input: 999, output: 999, cacheRead: 999, cacheWrite: 999,
      });

      // Create a fake pi binary that emits JSON with token usage
      const fakePi = path.join(temp.root, "fake-pi");
      fs.writeFileSync(
        fakePi,
        `#!/usr/bin/env bash\n` +
        `cat << 'JSON'\n` +
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "STATUS: done" }],
            api: "fake",
            provider: "fake",
            model: "fake",
            usage: {
              input: 10,
              output: 5,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 42,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 1777829458436,
            responseId: crypto.randomUUID(),
          },
        }) + `\nJSON\n`,
        "utf-8",
      );
      fs.chmodSync(fakePi, 0o755);

      const piScript = `
        import fs from "node:fs";
        import path from "node:path";
        import { executeDispatchRound } from "./dist/installer/agent-scheduler.js";
        import { getDb } from "./dist/db.js";

        const db = getDb();
        const runId = ${JSON.stringify(runId)};
        const now = new Date().toISOString();

        db.prepare(
          "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-pi-only', 'test', 'running', ?, 0, ?, ?)"
        ).run(runId, JSON.stringify({ harness_type: "pi", working_directory_for_harness: process.cwd() }), now, now);
        db.prepare(
          "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'work', 'wf-pi-only_dev', 0, 'do work', 'STATUS', 'pending', ?, ?)"
        ).run(${JSON.stringify(stepId)}, runId, now, now);

        const job = {
          id: "job-pi-only",
          workflowId: "wf-pi-only",
          agentId: "wf-pi-only_dev",
          runId,
          harnessType: "pi",
          timeoutSeconds: 30,
          workingDirectoryForHarness: process.cwd(),
          createdAt: now,
        };
        await executeDispatchRound(job, { id: "dev", role: "coding", workspace: { baseDir: process.cwd(), files: {} } });

        const run = db.prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId);
        console.log(JSON.stringify({ tokensSpent: run.tokens_spent }));
      `;

      const piResult = spawnSync(process.execPath, ["--input-type=module", "-e", piScript], {
        cwd: repoRoot,
        env: cleanChildEnv({
          HOME: temp.homeDir,
          TAMANDUA_PI_BINARY: fakePi,
          HERMES_HOME: hermesHome,
        }),
        encoding: "utf-8",
        maxBuffer: 16 * 1024 * 1024,
      });
      if (piResult.status !== 0) {
        throw new Error(`pi script failed (${piResult.status})\nSTDOUT:\n${piResult.stdout}\nSTDERR:\n${piResult.stderr}`);
      }
      const piData = JSON.parse(piResult.stdout.trim().split(/\r?\n/).filter(Boolean).pop()!) as Record<string, unknown>;

      // Pi token path should attribute 42 tokens from JSON parsing,
      // NOT 3996 from the hermes state.db.
      assert.equal(piData.tokensSpent, 42, "pi round must attribute tokens from JSON, not hermes state.db");
  });

  it("does not double count when hermes stdout carries pi-style JSON", () => {
    // Regression: hermes stdout carries no token usage by contract.
    // If an agent echoes pi-style JSON with totalTokens 99999 on stdout,
    // that must NOT be attributed — only the state.db-derived total counts.
    const temp = createTempHome("tamandua-hermes-attribution-");
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const sessionId = "test-session-contaminated";
    const hermesHome = path.join(temp.root, "hermes-data");
    fs.mkdirSync(hermesHome, { recursive: true });
      // Seed state.db — tokens total = 100 + 200 + 25 = 325 (cache_read excluded)
      seedHermesStateDb(hermesHome, sessionId, {
        input: 100,
        output: 200,
        cacheRead: 50,
        cacheWrite: 25,
      });

      // Fake hermes that prints STATUS: done PLUS pi-style JSON with
      // totalTokens 99999 on stdout, and session_id on stderr.
      // The message must carry role: "assistant" and text content —
      // parseWorkRoundMetadata only extracts usage from assistant
      // message_end events, so a role-less message would never be
      // attributed and the test would pass even without the hermes
      // stdout-attribution guard.
      const piStyleJson = JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "STATUS: done" }],
          usage: { input: 99999, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 99999 },
        },
      });
      const fakeHermes = path.join(temp.root, "fake-hermes-contaminated");
      fs.writeFileSync(
        fakeHermes,
        `#!/usr/bin/env bash
echo "STATUS: done"
echo '${piStyleJson}'
echo "session_id: ${sessionId}" >&2
`,
        "utf-8",
      );
      fs.chmodSync(fakeHermes, 0o755);

      const result = runHermesDispatchRound(temp.homeDir, fakeHermes, runId, stepId, hermesHome);

      // Must use state.db total (325), not the pi-style JSON total (99999)
      assert.equal(result.tokensSpent, 325, "tokens_spent must come from state.db (325), not stdout JSON (99999)");
      assert.equal(result.tokenEventDelta, 325, "tokenEventDelta must come from state.db (325)");
      assert.equal(result.tokenEventCount, 1, "exactly one run.tokens.updated event");
  });
});
