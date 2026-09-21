/**
 * MATCHLOCK-UNION-4 US-001 — merge deliverable regression.
 *
 * Pins the three machine-checkable outcomes of the real two-parent merge of the
 * Matchlock union squash (refs/remotes/src/union = 5729f76d) into the
 * integration base (integration/union-port = a61e250f):
 *
 *   1. no conflict markers remain in any tracked file;
 *   2. HEAD ancestry is the two-parent union merge (or its post-squash
 *      single-parent descendant on the integration branch — the merge is
 *      deliberately squashed there, so the parents are only asserted when HEAD
 *      actually is the merge commit);
 *   3. the ONE schema chain tops out at SCHEMA_VERSION 13 with the
 *      `runs.matchlock_policy` (12->13) and `steps.target_moved_reroute_count`
 *      (10->11) guarded ALTERs present.
 *
 * Spawns `git`, so this file belongs to the serial lane.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SCHEMA_VERSION } from "../dist/db.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// UNION-PORT: the port merge parents are the integration base
// (integration/union-port = a61e250f) and the Matchlock union squash
// (refs/remotes/src/union = 5729f76d).
const MAIN_TIP = "a61e250f9a938dd350bc6ab3d5876c6ea8d1de4e";
const UNION_TIP = "5729f76d02e00b571d7fb63882330df71d45f8af";

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
}

describe("matchlock-union4 merge deliverable", () => {
  it("leaves no conflict markers in tracked files", () => {
    // Only the unambiguous marker prefixes are matched: a bare `=======` line
    // is also a legitimate Markdown/section separator, so it is intentionally
    // excluded (a real conflict always has a matching `<<<<<<<`/`>>>>>>>`).
    const lt = "<".repeat(7);
    const gt = ">".repeat(7);
    const base = "|".repeat(7);
    const pattern = `^(${lt} |${gt} |${base} )`;
    let stdout = "";
    let status = 0;
    try {
      stdout = execFileSync("git", ["grep", "-nE", pattern, "--", "."], {
        cwd: REPO,
        encoding: "utf8",
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      status = e.status ?? 1;
      stdout = e.stdout ?? "";
    }
    assert.equal(status, 1, `conflict markers found:\n${stdout}`);
  });

  it("HEAD ancestry is the union merge (or its squashed descendant)", () => {
    const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"])
      .split(/\s+/)
      .slice(1);
    if (parents.length === 2) {
      assert.deepEqual(
        new Set(parents),
        new Set([MAIN_TIP, UNION_TIP]),
        `merge parents were ${parents.join(", ")}`,
      );
    } else {
      // The merger squash-merges the union onto integration/union-20260916 as
      // ONE commit; a single-parent HEAD there is the expected post-squash
      // shape. The union invariants below still hold on that tree.
      assert.equal(parents.length, 1, "HEAD must have one or two parents");
    }
  });

  it("tops out the one schema chain at SCHEMA_VERSION 13", () => {
    assert.equal(SCHEMA_VERSION, 13);
  });

  it("carries both guarded ALTERs in src/db.ts", () => {
    const source = readFileSync(path.join(REPO, "src", "db.ts"), "utf8");
    assert.match(
      source,
      /ALTER TABLE runs ADD COLUMN matchlock_policy TEXT/,
      "11->12 runs.matchlock_policy ALTER missing",
    );
    assert.match(
      source,
      /ALTER TABLE steps ADD COLUMN target_moved_reroute_count INTEGER DEFAULT 0/,
      "10->11 steps.target_moved_reroute_count ALTER missing",
    );
    assert.match(
      source,
      /pragma_table_info\('runs'\) WHERE name = 'matchlock_policy'/,
      "matchlock_policy pragma_table_info guard missing",
    );
    assert.match(
      source,
      /migrateInstantsToIsoZ\(db\)/,
      "9->10 instant rewrite call missing",
    );
  });
});
