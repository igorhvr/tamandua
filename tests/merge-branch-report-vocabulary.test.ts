import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * NPF-1 / REROUTE-BUDGET (US-007): the merge-branch landing report states only
 * what was verified. The retired checkout label claimed a checkout state
 * without inspecting one, so it must not survive anywhere in the shipped
 * source or the e2e harness as an assertion or expectation.
 *
 * The retired token is assembled at runtime so this guard file itself — which
 * lives under tests/ and is intentionally outside the scanned directories —
 * never becomes a false positive.
 */
const RETIRED_LABEL = ["not", "applicable"].join("-");

const SCANNED_ROOTS = ["src", "e2e-tests"];
const SCANNED_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".md"];

function collectFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && SCANNED_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        files.push(full);
      }
    }
  };
  if (statSync(root).isDirectory()) walk(root);
  return files;
}

describe("merge-branch landing report vocabulary (NPF-1 / US-007)", () => {
  it("retires the unverified not-applicable checkout label everywhere under src/ and e2e-tests/", () => {
    const offenders: string[] = [];
    for (const root of SCANNED_ROOTS) {
      for (const file of collectFiles(root)) {
        const contents = readFileSync(file, "utf8");
        if (contents.includes(RETIRED_LABEL)) offenders.push(file);
      }
    }
    assert.deepEqual(offenders, [], `retired checkout label still present in: ${offenders.join(", ")}`);
  });

  it("keeps the verified target tips and truthful labels in the command help and docs", () => {
    const help = readFileSync(join(process.cwd(), "src/cli/commands/merge-branch.ts"), "utf8");
    const docs = readFileSync(join(process.cwd(), "docs/merge-branch.md"), "utf8");

    for (const text of [help, docs]) {
      assert.match(text, /TARGET_TIP_BEFORE/);
      assert.match(text, /TARGET_TIP_AFTER/);
      assert.match(text, /refreshed/);
      assert.match(text, /already-coherent/);
      assert.match(text, /no-checkout-to-refresh/);
      assert.match(text, /checkout-not-at-tip/);
      assert.match(text, /parked:/);
    }
  });
});
