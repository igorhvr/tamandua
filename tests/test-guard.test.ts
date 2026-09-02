/**
 * The test-isolation guard itself: under TAMANDUA_TEST_GUARD=1, binding a
 * production port or opening state under the REAL ~/.tamandua throws
 * loudly. Tamandua develops tamandua — without this, under-isolated tests
 * leak daemons onto production ports and pollute live state (both have
 * happened; see tests/MOTOR-CONTRACT.md quirks).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tamanduaTempRoot } from "../src/lib/temp-dir.ts";
import {
  assertPortIsolation,
  assertStatePathIsolation,
  testGuardActive,
} from "../dist/lib/test-guard.js";

let savedGuard: string | undefined;
let savedNodeTestContext: string | undefined;
let savedExpect: string | undefined;

beforeEach(() => {
  savedGuard = process.env.TAMANDUA_TEST_GUARD;
  savedNodeTestContext = process.env.NODE_TEST_CONTEXT;
  savedExpect = process.env.TAMANDUA_TEST_GUARD_EXPECT;
  // Every test in this file is a deliberate guard self-test: the
  // assert.throws/doesNotThrow calls below provoke (or deliberately avoid)
  // isolation violations on purpose. Mark the whole file expected so the
  // lane's ledger report filters these entries — this file contains NO real
  // leaks.
  process.env.TAMANDUA_TEST_GUARD_EXPECT = "1";
});

afterEach(() => {
  if (savedGuard === undefined) delete process.env.TAMANDUA_TEST_GUARD;
  else process.env.TAMANDUA_TEST_GUARD = savedGuard;
  if (savedNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
  else process.env.NODE_TEST_CONTEXT = savedNodeTestContext;
  if (savedExpect === undefined) delete process.env.TAMANDUA_TEST_GUARD_EXPECT;
  else process.env.TAMANDUA_TEST_GUARD_EXPECT = savedExpect;
});

describe("test-isolation guard", () => {
  it("blocks production ports (3334/3338/3339) when active", () => {
    process.env.TAMANDUA_TEST_GUARD = "1";
    for (const port of [3334, 3338, 3339]) {
      assert.throws(
        () => assertPortIsolation(port, "unit test"),
        /TEST ISOLATION VIOLATION.*production port/s,
        `port ${port} must be blocked`,
      );
    }
  });

  it("allows random ports when active", () => {
    process.env.TAMANDUA_TEST_GUARD = "1";
    assert.doesNotThrow(() => assertPortIsolation(39181, "unit test"));
    assert.doesNotThrow(() => assertPortIsolation(1, "unit test"));
  });

  it("blocks the real ~/.tamandua state dir when active — even if HOME is spoofed", () => {
    process.env.TAMANDUA_TEST_GUARD = "1";
    // The guard uses the OS account database, not the HOME env var, so a
    // test that forgot isolation cannot dodge it by accident.
    const realHome = os.userInfo().homedir;
    assert.throws(
      () => assertStatePathIsolation(path.join(realHome, ".tamandua", "tamandua.db"), "unit test"),
      /TEST ISOLATION VIOLATION.*real tamandua state/s,
    );
    assert.throws(
      () => assertStatePathIsolation(path.join(realHome, ".tamandua"), "unit test"),
      /TEST ISOLATION VIOLATION/,
    );
  });

  it("allows temp-dir state when active", () => {
    process.env.TAMANDUA_TEST_GUARD = "1";
    assert.doesNotThrow(() =>
      assertStatePathIsolation(path.join(tamanduaTempRoot(), "tamandua-x", ".tamandua", "tamandua.db"), "unit test"),
    );
  });

  it("is completely inert when TAMANDUA_TEST_GUARD=0 even with NODE_TEST_CONTEXT (explicit escape hatch)", () => {
    process.env.TAMANDUA_TEST_GUARD = "0";
    // NODE_TEST_CONTEXT is set by the test runner — keep it present to
    // prove the escape hatch overrides auto-activation.
    assert.equal(testGuardActive(), false);
    assert.doesNotThrow(() => assertPortIsolation(3334, "prod"));
    const realHome = os.userInfo().homedir;
    assert.doesNotThrow(() =>
      assertStatePathIsolation(path.join(realHome, ".tamandua", "tamandua.db"), "prod"),
    );
  });

  it("auto-activates when only NODE_TEST_CONTEXT is set (no TAMANDUA_TEST_GUARD)", () => {
    delete process.env.TAMANDUA_TEST_GUARD;
    process.env.NODE_TEST_CONTEXT = "child-v8";
    assert.equal(testGuardActive(), true);
    assert.throws(
      () => assertPortIsolation(3334, "auto-activated test"),
      /TEST ISOLATION VIOLATION/,
    );
  });

  it("TAMANDUA_TEST_GUARD=0 overrides NODE_TEST_CONTEXT (escape hatch disables the guard)", () => {
    process.env.TAMANDUA_TEST_GUARD = "0";
    process.env.NODE_TEST_CONTEXT = "child-v8";
    assert.equal(testGuardActive(), false);
    assert.doesNotThrow(() => assertPortIsolation(3334, "escape hatch"));
  });

  it("is a complete no-op when inactive — no throw, no logs, no ledger file", () => {
    const ledgerPath = path.join(
      tamanduaTempRoot(),
      `guard-ledger-noop-${process.pid}-${Date.now()}.jsonl`,
    );
    const savedLedger = process.env.TAMANDUA_TEST_GUARD_LEDGER;
    const savedExpect = process.env.TAMANDUA_TEST_GUARD_EXPECT;
    try {
      // Force the guard fully inactive: neither the explicit activation var
      // nor the node:test auto-activation trigger may be set, even though a
      // ledger path IS provided (the runner passes it on every lane).
      delete process.env.TAMANDUA_TEST_GUARD;
      delete process.env.NODE_TEST_CONTEXT;
      process.env.TAMANDUA_TEST_GUARD_LEDGER = ledgerPath;

      assert.equal(testGuardActive(), false);
      assert.doesNotThrow(() => assertPortIsolation(3334, "prod"));
      const realHome = os.userInfo().homedir;
      assert.doesNotThrow(() =>
        assertStatePathIsolation(path.join(realHome, ".tamandua", "tamandua.db"), "prod"),
      );
      assert.equal(
        fs.existsSync(ledgerPath),
        false,
        "inactive guard must not create a ledger file",
      );
    } finally {
      if (savedLedger === undefined) delete process.env.TAMANDUA_TEST_GUARD_LEDGER;
      else process.env.TAMANDUA_TEST_GUARD_LEDGER = savedLedger;
      if (savedExpect === undefined) delete process.env.TAMANDUA_TEST_GUARD_EXPECT;
      else process.env.TAMANDUA_TEST_GUARD_EXPECT = savedExpect;
      try {
        fs.rmSync(ledgerPath, { force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("TAMANDUA_TEST_GUARD_EXPECT=1 marks ledger entries expected; unset stays false", () => {
    // US-002: the deliberate guard self-tests set TAMANDUA_TEST_GUARD_EXPECT=1
    // so the lane's ledger report filters their entries. Prove the flag flips
    // expected on the JSONL entry and that an unmarked violation stays false.
    const ledgerPath = path.join(
      tamanduaTempRoot(),
      `guard-ledger-expect-${process.pid}-${Date.now()}.jsonl`,
    );
    const savedLedger = process.env.TAMANDUA_TEST_GUARD_LEDGER;
    const savedExpect = process.env.TAMANDUA_TEST_GUARD_EXPECT;
    try {
      process.env.TAMANDUA_TEST_GUARD = "1";
      process.env.TAMANDUA_TEST_GUARD_LEDGER = ledgerPath;

      // First provocation WITHOUT the marker → expected:false.
      delete process.env.TAMANDUA_TEST_GUARD_EXPECT;
      assert.throws(
        () => assertPortIsolation(3334, "expect-flag unit test"),
        /TEST ISOLATION VIOLATION.*production port/s,
      );

      // Second provocation WITH the marker → expected:true.
      process.env.TAMANDUA_TEST_GUARD_EXPECT = "1";
      const realHome = os.userInfo().homedir;
      assert.throws(
        () => assertStatePathIsolation(path.join(realHome, ".tamandua"), "expect-flag unit test"),
        /TEST ISOLATION VIOLATION/,
      );

      const lines = fs
        .readFileSync(ledgerPath, "utf-8")
        .split("\n")
        .filter((l) => l.trim() !== "");
      assert.equal(lines.length, 2, "exactly two ledger entries must be written");

      const unmarked = JSON.parse(lines[0]);
      assert.equal(unmarked.kind, "port-bind");
      assert.equal(unmarked.expected, false, "unmarked violation must be expected:false");

      const marked = JSON.parse(lines[1]);
      assert.equal(marked.kind, "state-path");
      assert.equal(marked.expected, true, "marked violation must be expected:true");
    } finally {
      if (savedLedger === undefined) delete process.env.TAMANDUA_TEST_GUARD_LEDGER;
      else process.env.TAMANDUA_TEST_GUARD_LEDGER = savedLedger;
      if (savedExpect === undefined) delete process.env.TAMANDUA_TEST_GUARD_EXPECT;
      else process.env.TAMANDUA_TEST_GUARD_EXPECT = savedExpect;
      try {
        fs.rmSync(ledgerPath, { force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("appends a ledger entry and still throws when active", () => {
    const ledgerPath = path.join(
      tamanduaTempRoot(),
      `guard-ledger-active-${process.pid}-${Date.now()}.jsonl`,
    );
    const savedLedger = process.env.TAMANDUA_TEST_GUARD_LEDGER;
    const savedExpect = process.env.TAMANDUA_TEST_GUARD_EXPECT;
    try {
      process.env.TAMANDUA_TEST_GUARD = "1";
      process.env.TAMANDUA_TEST_GUARD_LEDGER = ledgerPath;
      // This is a deliberate provocation (the guard's own self-test) — mark
      // it expected so the lane's ledger report filters it out.
      process.env.TAMANDUA_TEST_GUARD_EXPECT = "1";

      assert.throws(
        () => assertPortIsolation(3334, "ledger unit test"),
        /TEST ISOLATION VIOLATION.*production port/s,
      );

      const lines = fs
        .readFileSync(ledgerPath, "utf-8")
        .split("\n")
        .filter((l) => l.trim() !== "");
      assert.equal(lines.length, 1, "exactly one ledger entry must be written");

      const entry = JSON.parse(lines[0]);
      assert.equal(entry.kind, "port-bind");
      assert.equal(entry.path, "3334");
      assert.equal(entry.what, "ledger unit test");
      assert.equal(entry.expected, true);
      assert.ok(
        entry.testFile && entry.testFile.includes("test-guard.test.ts"),
        `testFile must point at the originating test file, got: ${entry.testFile}`,
      );
      assert.ok(
        Number.isInteger(entry.testLine) && entry.testLine > 0,
        `testLine must be a positive line number, got: ${entry.testLine}`,
      );
      assert.ok(Number.isInteger(entry.ts), "ts must be a timestamp");
    } finally {
      if (savedLedger === undefined) delete process.env.TAMANDUA_TEST_GUARD_LEDGER;
      else process.env.TAMANDUA_TEST_GUARD_LEDGER = savedLedger;
      if (savedExpect === undefined) delete process.env.TAMANDUA_TEST_GUARD_EXPECT;
      else process.env.TAMANDUA_TEST_GUARD_EXPECT = savedExpect;
      try {
        fs.rmSync(ledgerPath, { force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });
});
