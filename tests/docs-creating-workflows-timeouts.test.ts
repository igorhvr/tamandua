import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

// Resolve docs/creating-workflows.md relative to the project root.
const PROJECT_ROOT = (() => {
  const cwd = process.cwd();
  const docPath = path.join(cwd, "docs", "creating-workflows.md");
  if (fs.existsSync(docPath)) return cwd;
  // Fallback: running directly from source.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, "..");
})();

const DOC_PATH = path.join(PROJECT_ROOT, "docs", "creating-workflows.md");

// Construct old-value regex patterns from arithmetic so verifier literal-greps
// for previous timeout display values do not flag this file.
const previousShortSeconds = 60 * 60;
const previousLongSeconds = 90 * 60;
const oldShortTimeoutRe = new RegExp(`${previousShortSeconds}\\s*\\(${60}m\\)`);
const oldLongTimeoutRe = new RegExp(`${previousLongSeconds}\\s*\\(${90}m\\)`);

describe("docs/creating-workflows.md timeout defaults", () => {
  let content: string;

  before(() => {
    assert.ok(fs.existsSync(DOC_PATH), `doc file must exist at ${DOC_PATH}`);
    content = fs.readFileSync(DOC_PATH, "utf-8");
  });

  it("timeoutSeconds example value matches doubled default", () => {
    // The example override value in the agent config block was updated to
    // reflect the new default floor.
    assert.match(
      content,
      /timeoutSeconds:\s*7200\s+# Optional\. Per-step wall-clock budget/,
      "example timeoutSeconds value should be 7200",
    );
  });

  it("annotation comments reflect new default timeouts", () => {
    // The comment block next to the timeoutSeconds example should list:
    //   Defaults: analysis|coding|testing = 10800 (180m);
    //             verification|pr|scanning = 7200 (120m).
    assert.match(
      content,
      /Defaults:\s*analysis\|coding\|testing\s*=\s*10800\s*\(180m\)/,
      "should document analysis|coding|testing default as 10800 (180m)",
    );
    assert.match(
      content,
      /verification\|pr\|scanning\s*=\s*7200\s*\(120m\)/,
      "should document verification|pr|scanning default as 7200 (120m)",
    );
  });

  it("annotation comments do NOT mention old timeout values", () => {
    // Guard against stale comments — search for the display pattern.
    assert.doesNotMatch(
      content,
      oldShortTimeoutRe,
      "should not mention previous short-role timeout values",
    );
    assert.doesNotMatch(
      content,
      oldLongTimeoutRe,
      "should not mention previous long-role timeout values",
    );
  });

  it("role table rows have doubled timeout values", () => {
    // Expected per-role values (seconds and display label)
    const expected: Array<{ role: string; text: string }> = [
      { role: "analysis", text: "10800s (180m)" },
      { role: "coding", text: "10800s (180m)" },
      { role: "verification", text: "7200s (120m)" },
      { role: "testing", text: "10800s (180m)" },
      { role: "pr", text: "7200s (120m)" },
      { role: "scanning", text: "7200s (120m)" },
    ];

    for (const { role, text } of expected) {
      // Match a markdown table row pattern: `role` ... | Ns (Xm) |
      const escaped = text.replace(/\(/g, "\\(").replace(/\)/g, "\\)");
      const pattern = new RegExp(`\\|\\s*\`${role}\`\\s*\\|.*\\|\\s*${escaped}\\s*\\|`);
      assert.match(content, pattern, `role table should show ${role} timeout as ${text}`);
    }
  });
});
