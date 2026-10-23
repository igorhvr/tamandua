/**
 * Tests for src/suite/exit-codes.ts — the side-effect-free home of the
 * dedicated tamandua-test exit codes (TSTX 86/87/88).
 *
 * The values are load-bearing: the shim exits with them and every consumer
 * distinguishes them from a test command's own exit status. They are asserted
 * against literal numbers (never against themselves) so a silent constant
 * change fails loudly instead of traveling unnoticed.
 *
 * The last block pins the lane classification: this file is pure (source text
 * + a pure dist module), so it must stay in the PARALLEL lane.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const EXIT_CODES_SRC = new URL("./exit-codes.ts", import.meta.url);
const SHIM_SRC = new URL("./shim.ts", import.meta.url);
const EXIT_CODES_DIST = new URL("../../dist/suite/exit-codes.js", import.meta.url);
const SERIAL_FILES = new URL("../../tests/serial-files.txt", import.meta.url);

const NAMES = [
  "TREE_DRIFT_EXIT_CODE",
  "INTERRUPTED_EXIT_CODE",
  "TREE_DIRTY_EXIT_CODE",
] as const;

type ExitCodesModule = Record<(typeof NAMES)[number], number>;

let codes: ExitCodesModule;

/** Remove block and line comments so a prose mention ("imports nothing") is
 *  not mistaken for code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function read(source: URL): string {
  return readFileSync(source, "utf8");
}

before(async () => {
  codes = (await import("../../dist/suite/exit-codes.js")) as ExitCodesModule;
});

describe("exit-codes values", () => {
  it("TREE_DRIFT_EXIT_CODE is 86", () => {
    assert.equal(codes.TREE_DRIFT_EXIT_CODE, 86);
  });

  it("INTERRUPTED_EXIT_CODE is 87", () => {
    assert.equal(codes.INTERRUPTED_EXIT_CODE, 87);
  });

  it("TREE_DIRTY_EXIT_CODE is 88", () => {
    assert.equal(codes.TREE_DIRTY_EXIT_CODE, 88);
  });

  it("each value is a positive integer that never aliases a generic shell code", () => {
    const generic = [0, 1, 2, 126, 127, 128, 130, 137, 143];
    const seen = new Set<number>();
    for (const name of NAMES) {
      const value = codes[name];
      assert.ok(Number.isInteger(value) && value > 0, `${name} must be a positive integer`);
      assert.ok(!generic.includes(value), `${name}=${value} must not collide with a generic shell code`);
      assert.ok(!seen.has(value), `${name}=${value} aliases another dedicated code`);
      seen.add(value);
    }
  });
});

describe("exit-codes module is side-effect free", () => {
  it("source contains no import statement, no require() and no re-export", () => {
    const code = stripComments(read(EXIT_CODES_SRC));
    assert.ok(!/^\s*import\b/m.test(code), "exit-codes.ts must not import anything");
    assert.ok(!/\brequire\s*\(/.test(code), "exit-codes.ts must not call require()");
    assert.ok(!/^\s*export\b[^;]*\bfrom\b/m.test(code), "exit-codes.ts must not re-export another module");
  });

  it("every statement in the source is an integer const declaration", () => {
    const statements = stripComments(read(EXIT_CODES_SRC))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    assert.ok(statements.length >= NAMES.length, "expected at least the three declarations");
    for (const statement of statements) {
      assert.match(
        statement,
        /^export const [A-Z][A-Z0-9_]* = -?\d+;$/,
        `unexpected non-constant statement in exit-codes.ts: ${statement}`,
      );
    }
  });

  it("compiled module is importless and never calls process.exit", () => {
    const compiled = read(EXIT_CODES_DIST);
    assert.ok(!/\brequire\s*\(/.test(compiled), "compiled exit-codes.js must not require anything");
    assert.ok(!/process\.exit/.test(compiled), "exit-codes.js must not exit the process");
    for (const name of NAMES) {
      assert.match(compiled, new RegExp(`\\b${name}\\b`), `compiled module must define ${name}`);
    }
  });

  it("importing the module does not start the tamandua-test shim", () => {
    assert.equal((codes as Record<string, unknown>).main, undefined);
  });
});

describe("shim.ts consumes the shared constants", () => {
  it("imports all three constants from ./exit-codes.js", () => {
    const source = read(SHIM_SRC);
    const importBlock = source.match(/import\s*\{[^}]*\}\s*from\s*"\.\/exit-codes\.js";/);
    assert.ok(importBlock, 'shim.ts must import from "./exit-codes.js"');
    for (const name of NAMES) {
      assert.ok(
        importBlock![0].includes(name),
        `shim.ts import must include ${name}, got: ${importBlock![0]}`,
      );
    }
  });

  it("declares none of the constants locally", () => {
    const source = read(SHIM_SRC);
    for (const name of NAMES) {
      const local = new RegExp(`^\\s*(?:export\\s+)?const\\s+${name}\\b`, "m");
      assert.ok(!local.test(source), `shim.ts must not declare ${name} locally`);
    }
  });

  it("still uses every constant after the import (no dead import)", () => {
    const source = read(SHIM_SRC);
    for (const name of NAMES) {
      const uses = source.split(name).length - 1;
      assert.ok(uses >= 2, `${name} must be imported and used at least once, saw ${uses} occurrences`);
    }
  });
});

describe("lane classification", () => {
  it("this test file is NOT listed in tests/serial-files.txt (pure, parallel lane)", () => {
    const listed = read(SERIAL_FILES)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    assert.ok(
      !listed.includes("src/suite/exit-codes.test.ts"),
      "src/suite/exit-codes.test.ts is pure (no spawn) and must stay in the parallel lane",
    );
  });
});
