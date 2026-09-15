/**
 * Comment-blind source checks shared by the e2e suites.
 *
 * `stripComments` removes line comments (double-slash) and block comments
 * (slash-star to star-slash) from source code, while preserving those
 * character sequences inside string literals. It lets a caller assert on
 * code content without being tripped by an explanatory comment such as
 * `// FIX: use fs.readFile() instead of shell exec()`.
 *
 * `assertsBuggyAddValue` builds on it to detect the specific stale
 * "add(5, 3) === 2" expectation that the bug-fix e2e fixture must not
 * leave behind, while ignoring comments and test titles that merely
 * mention the buggy value.
 */

/**
 * stripComments removes line comments (double-slash) and block comments
 * (slash-star to star-slash) from source code, while preserving those
 * character sequences inside string literals.
 *
 * This allows assertions on source content (e.g. checking for exec()
 * calls) without being tripped by comment mentions like
 * "// FIX: use fs.readFile() instead of shell exec()".
 */
export function stripComments(source: string): string {
  const result: string[] = [];
  let i = 0;

  while (i < source.length) {
    // ── Check for the start of a string literal ─────────────────
    const quote = source[i];
    if (quote === "'" || quote === '"' || quote === "`") {
      result.push(quote);
      i++;
      // Consume until matching closing quote (handling escapes)
      while (i < source.length) {
        const ch = source[i];
        if (ch === "\\") {
          result.push(ch);
          i++;
          if (i < source.length) {
            result.push(source[i]);
            i++;
          }
        } else if (ch === quote) {
          result.push(ch);
          i++;
          break;
        } else {
          result.push(ch);
          i++;
        }
      }
      continue;
    }

    // ── Check for // line comment ──────────────────────────────
    if (source[i] === "/" && i + 1 < source.length && source[i + 1] === "/") {
      // Skip to end of line
      while (i < source.length && source[i] !== "\n") {
        i++;
      }
      continue;
    }

    // ── Check for /* block comment ─────────────────────────────
    if (source[i] === "/" && i + 1 < source.length && source[i + 1] === "*") {
      i += 2; // skip /*
      let depth = 1;
      // Scan for matching */, handling nested /* (increment depth)
      // and unclosed comments (strip to end of source)
      while (i < source.length && depth > 0) {
        if (source[i] === "/" && i + 1 < source.length && source[i + 1] === "*") {
          i += 2;
          depth++;
        } else if (source[i] === "*" && i + 1 < source.length && source[i + 1] === "/") {
          i += 2;
          depth--;
        } else {
          i++;
        }
      }
      continue;
    }

    // ── Regular code character ─────────────────────────────────
    result.push(source[i]);
    i++;
  }

  return result.join("");
}

/**
 * Assertion-form buggy `add(5, 3) === 2` expectation, e.g.
 * `assert.equal(add(5, 3), 2)` / `assert.strictEqual(add(5,3), 2)` /
 * `assert.deepEqual(add(5, 3), 2)` / `assert.deepStrictEqual(add(5, 3), 2)`.
 * Whitespace between tokens is flexible.
 */
const BUGGY_ASSERT_EQUAL_RE =
  /\bassert\s*\.\s*(?:equal|strictEqual|deepEqual|deepStrictEqual)\s*\(\s*add\s*\(\s*5\s*,\s*3\s*\)\s*,\s*2\s*\)/;

/**
 * Chai/Vitest/Jest-style buggy expectation, e.g.
 * `expect(add(5, 3)).toBe(2)` / `expect(add(5, 3)).toEqual(2)`.
 * Whitespace between tokens is flexible.
 */
const BUGGY_EXPECT_RE =
  /\bexpect\s*\(\s*add\s*\(\s*5\s*,\s*3\s*\)\s*\)\s*\.\s*(?:toBe|toEqual)\s*\(\s*2\s*\)/;

/**
 * Literal phrase used by the stale fixture, e.g. a test title that still
 * claims the fixture "expects subtraction". Case-insensitive.
 */
const EXPECTS_SUBTRACTION_RE = /expects\s+subtraction/i;

/**
 * Returns true when `source` still asserts the buggy `add(5, 3) === 2`
 * expectation or still carries the "expects subtraction" phrase.
 *
 * The check runs on comment-stripped content, so an explanatory comment
 * (or a commented-out stale assertion) never trips it, while a genuine
 * stale assertion in code still does.
 */
export function assertsBuggyAddValue(source: string): boolean {
  const code = stripComments(source);
  return (
    BUGGY_ASSERT_EQUAL_RE.test(code) ||
    BUGGY_EXPECT_RE.test(code) ||
    EXPECTS_SUBTRACTION_RE.test(code)
  );
}
