/**
 * Shared harness token policy (tamandua-6sy.52).
 *
 * One definition — input + output + cache_write, cache_read EXCLUDED — must
 * drive per-call accounting for all three harnesses. This test pins that pi,
 * dsh and hermes produce the same number for the same components, so the
 * policy cannot silently drift back into a per-harness convention.
 *
 * Serial lane: importing dsh-usage.ts reaches node:child_process (the `zstd`
 * fallback spawner), so this file is listed in tests/serial-files.txt.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import {
  extractPerCallTokenTotal,
  sumBillableTokens,
} from "../dist/installer/token-usage-policy.js";
import { extractTokenUsage } from "../dist/installer/agent-scheduler.js";
import { sumUsageChunks } from "../dist/installer/dsh-usage.js";
import { lookupHermesSessionTokens } from "../dist/installer/hermes-usage.js";
import { auditPiSessionStore } from "../e2e-tests/helpers/e2e-helpers.ts";
import { createTempHome } from "./helpers/test-env.ts";

// Isolate the logger's state dir (hermes-usage logs warnings through lib/logger).
const isol = createTempHome("tamandua-token-policy-");
process.env.TAMANDUA_STATE_DIR = isol.tamanduaDir;

after(() => {
  fs.rmSync(isol.root, { recursive: true, force: true });
});

interface Components {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function makeTempDir(prefix: string): string {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", prefix));
  return root;
}

/** Seed a hermes state.db with a single session row. */
function seedHermesDb(hermesHome: string, sessionId: string, tokens: Components): void {
  const db = new DatabaseSync(path.join(hermesHome, "state.db"));
  try {
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
  } finally {
    db.close();
  }
}

/** A dsh session JSONL line carrying one assistant usage chunk. */
function dshUsageLine(usage: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
}): string {
  return (
    JSON.stringify({
      type: "assistant/chunk",
      seq: 0,
      time: 1_700_000_000_000,
      data: { turn: 0, step: 0, chunk: { type: "usage", usage } },
    }) + "\n"
  );
}

describe("shared harness token policy", () => {
  it("sumBillableTokens = input + output + cache_write (cache_read has no input)", () => {
    assert.equal(sumBillableTokens({ input: 10, output: 5, cacheWrite: 2 }), 17);
    assert.equal(sumBillableTokens({ input: 10, output: 5 }), 15);
    assert.equal(sumBillableTokens({}), 0);
    assert.equal(sumBillableTokens({ input: -5, output: 3 }), 3);
  });

  it("pi, dsh and hermes produce the same number for the same components", async () => {
    // cache_read is huge in every case and must be ignored everywhere.
    const components: Components = { input: 100, output: 50, cacheRead: 9_999, cacheWrite: 0 };
    const expected = 150;

    const pi = extractTokenUsage({
      input: components.input,
      output: components.output,
      cacheRead: components.cacheRead,
      cacheWrite: components.cacheWrite,
      totalTokens: components.input + components.output + components.cacheRead + components.cacheWrite,
    });
    assert.equal(pi, expected, "pi must exclude cache_read and ignore the cache-inclusive totalTokens");

    const dsh = sumUsageChunks(
      dshUsageLine({
        inputTokens: components.input,
        outputTokens: components.output,
        cacheReadTokens: components.cacheRead,
      }),
    );
    assert.equal(dsh, expected, "dsh must exclude cache_read");

    const hermesHome = makeTempDir("tamandua-token-policy-hermes-");
    try {
      seedHermesDb(hermesHome, "s1", components);
      const hermes = await lookupHermesSessionTokens("s1", { HERMES_HOME: hermesHome });
      assert.equal(hermes, expected, "hermes must exclude cache_read");
    } finally {
      fs.rmSync(hermesHome, { recursive: true, force: true });
    }
  });

  it("includes cache_write for pi and hermes (dsh exposes no cache_write component)", async () => {
    const expected = 175; // 100 + 50 + 25

    assert.equal(sumBillableTokens({ input: 100, output: 50, cacheWrite: 25 }), expected);
    assert.equal(
      extractTokenUsage({ input: 100, output: 50, cacheRead: 9_999, cacheWrite: 25, totalTokens: 10_174 }),
      expected,
    );

    const hermesHome = makeTempDir("tamandua-token-policy-hermes-cw-");
    try {
      seedHermesDb(hermesHome, "s2", { input: 100, output: 50, cacheRead: 9_999, cacheWrite: 25 });
      assert.equal(await lookupHermesSessionTokens("s2", { HERMES_HOME: hermesHome }), expected);
    } finally {
      fs.rmSync(hermesHome, { recursive: true, force: true });
    }
  });

  it("pi falls back to totalTokens only when no component fields are present", () => {
    assert.equal(extractTokenUsage({ totalTokens: 4_242 }), 4_242);
    assert.equal(extractTokenUsage({ input: 0, output: 0, cacheRead: 500, totalTokens: 500 }), 0);
  });
});

/** Write one pi session JSONL: a session header plus assistant message lines. */
function writePiSessionFile(
  homeDir: string,
  workdir: string,
  usages: Array<Record<string, unknown>>,
): void {
  const sessionDir = path.join(
    homeDir,
    ".pi",
    "agent",
    "sessions",
    "2026-09-13T00-00-00-000Z_test-session",
  );
  fs.mkdirSync(sessionDir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "session", cwd: workdir, timestamp: "2026-09-13T00:00:00.000Z" }),
    ...usages.map((usage) =>
      JSON.stringify({ type: "message", message: { role: "assistant", content: [], usage } }),
    ),
  ];
  fs.writeFileSync(path.join(sessionDir, "session.jsonl"), lines.join("\n") + "\n");
}

describe("shared usage-object extractor (parser + session-store audit)", () => {
  it("resolves camelCase/snake_case aliases and the totalTokens fallback", () => {
    assert.equal(
      extractPerCallTokenTotal({
        input: 100,
        output: 50,
        cacheRead: 9_999,
        cacheWrite: 25,
        totalTokens: 10_174,
      }),
      175,
    );
    assert.equal(
      extractPerCallTokenTotal({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 9_999,
        cache_write_tokens: 25,
      }),
      175,
    );
    assert.equal(extractPerCallTokenTotal({ prompt_tokens: 100, completion_tokens: 50 }), 150);
    assert.equal(extractPerCallTokenTotal({ totalTokens: 4_242 }), 4_242);
    assert.equal(extractPerCallTokenTotal({ total_tokens: "4242" }), 4_242);
    assert.equal(extractPerCallTokenTotal({ cacheRead: 9_999 }), null);
    assert.equal(extractPerCallTokenTotal({}), null);
    assert.equal(extractPerCallTokenTotal(null), null);
  });

  it("auditPiSessionStore applies the same extractor: aggregate-only session reconciles", () => {
    const homeDir = makeTempDir("tamandua-token-policy-pi-audit-");
    try {
      const workdir = path.join(homeDir, "workdir");
      fs.mkdirSync(workdir, { recursive: true });
      writePiSessionFile(homeDir, workdir, [
        { totalTokens: 4_242 }, // aggregate-only: no component fields
        {
          input_tokens: 100,
          output_tokens: 50,
          cache_write_tokens: 25,
          cache_read_tokens: 9_999,
        },
      ]);

      const audit = auditPiSessionStore({ homeDir, workdir });
      assert.equal(audit.sessions, 1);
      assert.equal(audit.usageCount, 2);
      // 4242 + (100 + 50 + 25); the old helper read only camelCase and
      // never applied the totalTokens fallback, so it returned 175.
      assert.equal(audit.policyTotal, 4_242 + 175);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("auditPiSessionStore sums every assistant message, not just the last", () => {
    const homeDir = makeTempDir("tamandua-token-policy-pi-sum-");
    try {
      const workdir = path.join(homeDir, "workdir");
      fs.mkdirSync(workdir, { recursive: true });
      writePiSessionFile(homeDir, workdir, [
        { input: 1_000, output: 10, cacheRead: 5_000, cacheWrite: 0 },
        { input: 2_000, output: 20, cacheRead: 5_000, cacheWrite: 0 },
        { input: 3_000, output: 30, cacheRead: 5_000, cacheWrite: 0 },
      ]);

      const audit = auditPiSessionStore({ homeDir, workdir });
      assert.equal(audit.policyTotal, 6_060);
      assert.notEqual(audit.policyTotal, 3_030); // NOT the last call alone
      assert.equal(audit.cacheInclusiveTotal, 21_060);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
