/**
 * Unit tests for the shared dashboard-port resolver (WAVE-A.1 US-007).
 *
 * resolveDashboardPort is the single source of truth that get-ready.ts and
 * dashboard-standalone.ts use to turn TAMANDUA_DASHBOARD_PORT into a real
 * listening port. These tests pin the exact dashboard-standalone.ts env-parse
 * semantics (base-10 int, valid 1..65535, fallback 3334) so the two callers
 * cannot drift apart.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DASHBOARD_PORT,
  resolveDashboardPort,
} from "../../dist/server/dashboard-port.js";

describe("resolveDashboardPort (shared TAMANDUA_DASHBOARD_PORT resolver)", () => {
  it("the shared default port is 3334", () => {
    assert.equal(DEFAULT_DASHBOARD_PORT, 3334);
  });

  it("returns the parsed port for a valid TAMANDUA_DASHBOARD_PORT value", () => {
    assert.equal(resolveDashboardPort("8080"), 8080);
    assert.equal(resolveDashboardPort("1"), 1);
    assert.equal(resolveDashboardPort("65535"), 65535);
    assert.equal(resolveDashboardPort("3334"), 3334);
  });

  it("accepts parseInt-style input with surrounding whitespace or a trailing suffix", () => {
    // Mirrors dashboard-standalone.ts's historical `parseInt(env, 10)` parsing:
    // the leading integer part wins ("33a4" -> 33), exactly like the
    // standalone server's own env tier.
    assert.equal(resolveDashboardPort(" 8080 "), 8080);
    assert.equal(resolveDashboardPort("9000abc"), 9000);
    assert.equal(resolveDashboardPort("33a4"), 33);
  });

  it("falls back to 3334 when TAMANDUA_DASHBOARD_PORT is unset", () => {
    assert.equal(resolveDashboardPort(undefined), 3334);
  });

  it("falls back to 3334 when TAMANDUA_DASHBOARD_PORT is empty", () => {
    assert.equal(resolveDashboardPort(""), 3334);
    assert.equal(resolveDashboardPort("   "), 3334);
  });

  it("falls back to 3334 when TAMANDUA_DASHBOARD_PORT is not a number", () => {
    assert.equal(resolveDashboardPort("abc"), 3334);
    assert.equal(resolveDashboardPort("not-a-port"), 3334);
  });

  it("falls back to 3334 when TAMANDUA_DASHBOARD_PORT is out of range", () => {
    assert.equal(resolveDashboardPort("0"), 3334);
    assert.equal(resolveDashboardPort("-1"), 3334);
    assert.equal(resolveDashboardPort("65536"), 3334);
    assert.equal(resolveDashboardPort("99999"), 3334);
  });

  it("honors an explicit fallback when provided", () => {
    assert.equal(resolveDashboardPort("abc", 0), 0);
    assert.equal(resolveDashboardPort(undefined, 0), 0);
    assert.equal(resolveDashboardPort("8080", 0), 8080);
  });
});
