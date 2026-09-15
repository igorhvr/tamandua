import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripComments, assertsBuggyAddValue } from "../dist/lib/comment-blind.js";

// ── stripComments unit tests ────────────────────────────────────────────
// Ported from the inline describe("stripComments helper") block of
// e2e-tests/workflows-e2e.test.ts so the shared helper keeps its coverage
// in the fast (parallel) tier.
describe("stripComments helper", () => {
  it("removes // line comments", () => {
    const result = stripComments("const x = 1; // inline comment\nconst y = 2;");
    assert.equal(result, "const x = 1; \nconst y = 2;");
  });

  it("removes single-line /* */ block comments", () => {
    const result = stripComments("const x = /* value */ 1;");
    assert.equal(result, "const x =  1;");
  });

  it("removes multiline /* */ block comments", () => {
    const result = stripComments("before\n/* multi\nline\ncomment */\nafter");
    assert.equal(result, "before\n\nafter");
  });

  it("does NOT remove // inside string literals", () => {
    const result = stripComments('const url = "https://example.com";');
    assert.ok(result.includes("https://example.com"), `Expected // in string to be preserved, got: ${result}`);
    assert.ok(result.includes("//"), `// inside string should survive`);
  });

  it("does NOT remove /* inside string literals", () => {
    const result = stripComments('const pattern = "/*comment*/";');
    assert.ok(result.includes("/*comment*/"), `/* inside string should survive, got: ${result}`);
  });

  it("preserves // inside backtick template literals", () => {
    const result = stripComments("const s = `url: //path`;");
    assert.ok(result.includes("//path"), `// inside template literal should survive, got: ${result}`);
  });

  it("preserves /* inside backtick template literals", () => {
    const result = stripComments("const s = `/* not a comment */`;");
    assert.ok(result.includes("/* not a comment */"), `/* inside template literal should survive, got: ${result}`);
  });

  it("handles escaped quotes inside strings", () => {
    const result = stripComments('const s = "she said \\"hello\\""; // comment');
    // stripComments preserves source-level escapes: \" stays \"
    assert.ok(result.includes('she said \\"hello\\"'), `escaped quotes should be preserved, got: ${result}`);
    assert.ok(!result.includes("comment"), `line comment should be stripped`);
  });

  it("handles escaped backslash before quote", () => {
    const result = stripComments('const s = "path\\\\" + x;');
    assert.ok(result.includes('path\\\\'), `escaped backslash should be preserved`);
  });

  it("handles unclosed block comment — strips to end of source", () => {
    const result = stripComments("before /* open but no close");
    assert.equal(result, "before ");
  });

  it("handles nested /* — treats as part of outer block comment", () => {
    const result = stripComments("before /* outer /* inner */ still outer */ after");
    assert.equal(result, "before  after");
  });

  it("exact real-failure comment: exec() only in comment → absent after stripping", () => {
    const source = '// FIX: use fs.readFile() instead of shell exec() to prevent command injection.\nimport fs from "fs";\nfs.readFile(filename, "utf-8");';
    const stripped = stripComments(source);
    assert.ok(!stripped.includes("exec("), `exec() in comment should be stripped, got: ${stripped}`);
    assert.ok(stripped.includes("import fs"), `code after comment should survive`);
    assert.ok(stripped.includes("readFile"), `readFile call should survive`);
  });

  it("preserves exec() calls in actual code (not in comments)", () => {
    const source = 'exec("ls -la");';
    const stripped = stripComments(source);
    assert.ok(stripped.includes("exec(\""), `exec() call should survive, got: ${stripped}`);
  });

  it("block comment containing exec(", () => {
    const source = "/* this used exec() for shell commands */\nconst x = 1;";
    const stripped = stripComments(source);
    assert.ok(!stripped.includes("exec("), `exec() in block comment should be stripped, got: ${stripped}`);
    assert.ok(stripped.includes("const x = 1;"), `code after block comment should survive`);
  });

  it("mixed comments and code", () => {
    const source = [
      "// line comment",
      'const x = "// not a comment";',
      "/* block */ const y = 1; // trailing",
      "const z = 2;",
    ].join("\n");
    const stripped = stripComments(source);
    assert.ok(stripped.includes('const x = "// not a comment";'), `string with // should survive`);
    assert.ok(!stripped.includes("trailing"), `trailing comment should be stripped`);
    assert.ok(stripped.includes("const y = 1;"), `code around block comment should survive`);
    assert.ok(stripped.includes("const z = 2;"), `uncommented line should survive`);
  });

  it("comment-like patterns in double-quoted string are preserved", () => {
    const result = stripComments('const a = "/*"; const b = "*/";');
    assert.equal(result, 'const a = "/*"; const b = "*/";');
  });

  it("comment-like patterns in single-quoted string are preserved", () => {
    const result = stripComments("const a = '/*'; const b = '*/';");
    assert.equal(result, "const a = '/*'; const b = '*/';");
  });

  it("standalone // inside a string literal is not a comment start", () => {
    const source = 'const url = "https://example.com/path";\nconst next = 1;';
    const stripped = stripComments(source);
    assert.ok(stripped.includes('const url = "https://example.com/path";'), `full line should survive`);
  });

  it("mixed quotes: single-quoted // does not start comment", () => {
    const result = stripComments("const x = '//'; const y = 1; // real comment");
    assert.ok(result.includes("'//'"), `// inside single-quoted string should survive, got: ${result}`);
    assert.ok(!result.includes("real comment"), `real comment should be stripped`);
  });
});

// ── assertsBuggyAddValue unit tests ─────────────────────────────────────
describe("assertsBuggyAddValue", () => {
  // The two verbatim real-agent-written contents that caused the false
  // reds documented in bead tamandua-6sy.59: a correct assertion plus an
  // explanatory comment that mentions the buggy value 2.
  const realAgentContentRegressionComment = [
    'import assert from "node:assert/strict";',
    "import { add } from \"../src/math.js\";",
    "",
    "// Regression: add(5, 3) previously returned 2 (5 - 3) instead of 8.",
    'assert.equal(add(5, 3), 8);',
    "",
  ].join("\n");

  const realAgentContentDifferenceComment = [
    'import assert from "node:assert/strict";',
    "import { add } from \"../src/math.js\";",
    "",
    "// add(5, 3) previously returned 2 (the difference) instead of 8.",
    'assert.equal(add(5, 3), 8);',
    "",
  ].join("\n");

  const correctTestTitleMentioningTwo = [
    'import { describe, it } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { add } from "../src/math.js";',
    "",
    'describe("add", () => {',
    '  it("add(5, 3) returns 8, not 2", () => {',
    "    assert.equal(add(5, 3), 8);",
    "  });",
    "});",
    "",
  ].join("\n");

  it("returns false for the real-agent content with a regression comment", () => {
    assert.equal(assertsBuggyAddValue(realAgentContentRegressionComment), false);
  });

  it("returns false for the real-agent content with a 'difference' comment", () => {
    assert.equal(assertsBuggyAddValue(realAgentContentDifferenceComment), false);
  });

  it("returns false for a correct file whose test title mentions 2", () => {
    assert.equal(assertsBuggyAddValue(correctTestTitleMentioningTwo), false);
  });

  it("returns false for a correct assertion (8) with no stale mention", () => {
    assert.equal(assertsBuggyAddValue('assert.equal(add(5, 3), 8);'), false);
  });

  it("returns false when the stale assertion is commented out", () => {
    assert.equal(assertsBuggyAddValue("// assert.equal(add(5, 3), 2);"), false);
  });

  it("returns false when the stale assertion is inside a block comment", () => {
    assert.equal(assertsBuggyAddValue("/* assert.equal(add(5, 3), 2); */"), false);
  });

  it("returns false when the phrase 'expects subtraction' appears only in a comment", () => {
    assert.equal(assertsBuggyAddValue("// this test expects subtraction of the operands"), false);
  });

  it("returns true for assert.equal(add(5, 3), 2)", () => {
    assert.equal(assertsBuggyAddValue("assert.equal(add(5, 3), 2);"), true);
  });

  it("returns true for assert.strictEqual(add(5,3), 2)", () => {
    assert.equal(assertsBuggyAddValue("assert.strictEqual(add(5,3), 2);"), true);
  });

  it("returns true for assert.deepEqual(add(5, 3), 2)", () => {
    assert.equal(assertsBuggyAddValue("assert.deepEqual(add(5, 3), 2);"), true);
  });

  it("returns true for assert.deepStrictEqual(add(5, 3), 2)", () => {
    assert.equal(assertsBuggyAddValue("assert.deepStrictEqual(add(5, 3), 2);"), true);
  });

  it("returns true for expect(add(5, 3)).toBe(2)", () => {
    assert.equal(assertsBuggyAddValue("expect(add(5, 3)).toBe(2);"), true);
  });

  it("returns true for expect(add(5, 3)).toEqual(2)", () => {
    assert.equal(assertsBuggyAddValue("expect(add(5, 3)).toEqual(2);"), true);
  });

  it("returns true for a non-comment occurrence of 'expects subtraction' in a test title", () => {
    assert.equal(assertsBuggyAddValue('it("expects subtraction", () => {});'), true);
  });

  it("returns true for a stale assertion surrounded by explanatory comments", () => {
    const source = [
      "// This used to be the correct expectation.",
      "assert.equal(add(5, 3), 2);",
      "// (stale, should have been updated to 8)",
    ].join("\n");
    assert.equal(assertsBuggyAddValue(source), true);
  });
});
