import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { scanRootsForContents } from "./helpers/robust-scan-walk.ts";

/**
 * NPF-1 / REROUTE-BUDGET (US-007): the merge-branch landing report states only
 * what was verified. The retired checkout label claimed a checkout state
 * without inspecting one, so it must not survive anywhere in the shipped
 * source or the e2e harness as an assertion or expectation.
 *
 * The retired token is assembled at runtime so this guard file itself — which
 * lives under tests/ and is intentionally outside the scanned directories —
 * never becomes a false positive.
 *
 * TEST-HYGIENE-0923 item 3a (bead tamandua-6sy.88): the walk/read is done by
 * tests/helpers/robust-scan-walk.ts, which prunes documented transient fixture
 * paths and tolerates a file or directory that vanishes mid-walk (item 3b
 * moved tests/e2e-syntax-check.test.ts's scratch dir out of `e2e-tests/`, but
 * the tolerance stays as the general defence for any in-tree transient),
 * while never dropping a file that still exists.
 */
const RETIRED_LABEL = ["not", "applicable"].join("-");

const SCANNED_ROOTS = ["src", "e2e-tests"];
const SCANNED_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".md"];

describe("merge-branch landing report vocabulary (NPF-1 / US-007)", () => {
  it("retires the unverified not-applicable checkout label everywhere under src/ and e2e-tests/", () => {
    const scan = scanRootsForContents({
      roots: SCANNED_ROOTS,
      extensions: SCANNED_EXTENSIONS,
      cwd: process.cwd(),
    });

    assert.ok(scan.contents.length > 0, `scan of ${SCANNED_ROOTS.join(", ")} returned no files`);

    const offenders = scan.contents
      .filter(({ text }) => text.includes(RETIRED_LABEL))
      .map(({ path }) => path);

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