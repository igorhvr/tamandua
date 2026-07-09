/**
 * Tests for src/suite/config.ts — TSTX configuration module.
 *
 * Constants are validated via dynamic import from the compiled dist;
 * values are also cross-checked with expected defaults inline to keep
 * the test self-documenting.
 */
import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";

// Inline expected defaults (compile-time constants cross-checked against
// the dynamic module import below).
const EXPECTED = {
  TTL_GREEN_MS: 24 * 60 * 60 * 1000,
  RED_CONTEXT_WINDOW_MS: 15 * 60 * 1000,
  FLAKE_WINDOW_MS: 24 * 60 * 60 * 1000,
  LEDGER_RETENTION_MS: 14 * 24 * 60 * 60 * 1000,
  CLAIM_TIMEOUT_MS: 30 * 60 * 1000,
  LOG_TAIL_KB: 20,
};

async function loadConfig(): Promise<Record<string, unknown>> {
  return await import("../../dist/suite/config.js");
}

describe("config constants", () => {
  let config: Record<string, any>;

  before(async () => {
    config = await loadConfig() as Record<string, any>;
  });

  // ── Time-based constants (in ms) ──

  it("TTL_GREEN_MS is 24 hours", () => {
    assert.strictEqual(config.TTL_GREEN_MS, EXPECTED.TTL_GREEN_MS);
  });

  it("RED_CONTEXT_WINDOW_MS is 15 minutes", () => {
    assert.strictEqual(config.RED_CONTEXT_WINDOW_MS, EXPECTED.RED_CONTEXT_WINDOW_MS);
  });

  it("FLAKE_WINDOW_MS is 24 hours", () => {
    assert.strictEqual(config.FLAKE_WINDOW_MS, EXPECTED.FLAKE_WINDOW_MS);
  });

  it("LEDGER_RETENTION_MS is 14 days", () => {
    assert.strictEqual(config.LEDGER_RETENTION_MS, EXPECTED.LEDGER_RETENTION_MS);
  });

  it("CLAIM_TIMEOUT_MS is 30 minutes", () => {
    assert.strictEqual(config.CLAIM_TIMEOUT_MS, EXPECTED.CLAIM_TIMEOUT_MS);
  });

  // ── Operational constants ──

  it("LOG_TAIL_KB is 20", () => {
    assert.strictEqual(config.LOG_TAIL_KB, EXPECTED.LOG_TAIL_KB);
  });

  // ── Positive / non-zero sanity ──

  it("all time constants are positive", () => {
    assert.ok(config.TTL_GREEN_MS > 0);
    assert.ok(config.RED_CONTEXT_WINDOW_MS > 0);
    assert.ok(config.FLAKE_WINDOW_MS > 0);
    assert.ok(config.CLAIM_TIMEOUT_MS > 0);
    assert.ok(config.LEDGER_RETENTION_MS > 0);
  });

  it("LOG_TAIL_KB is positive", () => {
    assert.ok(config.LOG_TAIL_KB > 0);
  });

  // ── Relative ordering ──

  it("RED_CONTEXT_WINDOW is shorter than TTL_GREEN", () => {
    assert.ok(config.RED_CONTEXT_WINDOW_MS < config.TTL_GREEN_MS);
  });

  it("CLAIM_TIMEOUT is shorter than TTL_GREEN", () => {
    assert.ok(config.CLAIM_TIMEOUT_MS < config.TTL_GREEN_MS);
  });

  // ── isTstxEnabled exists and is a function ──

  it("isTstxEnabled is a function", () => {
    assert.strictEqual(typeof config.isTstxEnabled, "function");
  });
});

describe("isTstxEnabled (env-var behavior)", () => {
  // Dynamic import with fresh module so env var takes effect.
  async function loadFresh(): Promise<{ isTstxEnabled: () => boolean }> {
    const mod = await import(`../../dist/suite/config.js?v=${Date.now()}`);
    return mod as { isTstxEnabled: () => boolean };
  }

  afterEach(() => {
    delete process.env.TAMANDUA_TSTX;
  });

  it("returns true when TAMANDUA_TSTX is unset", async () => {
    delete process.env.TAMANDUA_TSTX;
    const { isTstxEnabled } = await loadFresh();
    assert.strictEqual(isTstxEnabled(), true);
  });

  it("returns true when TAMANDUA_TSTX is 1", async () => {
    process.env.TAMANDUA_TSTX = "1";
    const { isTstxEnabled } = await loadFresh();
    assert.strictEqual(isTstxEnabled(), true);
  });

  it("returns true when TAMANDUA_TSTX is any non-zero string", async () => {
    process.env.TAMANDUA_TSTX = "yes";
    const { isTstxEnabled } = await loadFresh();
    assert.strictEqual(isTstxEnabled(), true);
  });

  it("returns false when TAMANDUA_TSTX is 0", async () => {
    process.env.TAMANDUA_TSTX = "0";
    const { isTstxEnabled } = await loadFresh();
    assert.strictEqual(isTstxEnabled(), false);
  });

  it("returns true when TAMANDUA_TSTX is 0 with leading/trailing chars", async () => {
    // Only exact "0" triggers passthrough — this is specified behavior.
    process.env.TAMANDUA_TSTX = " 0 ";
    const { isTstxEnabled } = await loadFresh();
    assert.strictEqual(isTstxEnabled(), true);
  });
});
