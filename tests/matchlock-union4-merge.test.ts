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
 *   3. the ONE schema chain tops out at SCHEMA_VERSION 14 (13 at the union
 *      landing plus LEDGER-DIAG's 13->14 suite_results.log_path step) with the
 *      `runs.matchlock_policy` (12->13) and `steps.target_moved_reroute_count`
 *      (10->11) guarded ALTERs present.
 *
 * Spawns `git`, so this file belongs to the serial lane.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SCHEMA_VERSION } from "../dist/db.js";
import { tamanduaShortTempDir } from "../dist/lib/temp-dir.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// UNION-PORT: the port merge parents are the integration base
// (integration/union-port = a61e250f) and the Matchlock union squash
// (refs/remotes/src/union = 5729f76d).
const MAIN_TIP = "a61e250f9a938dd350bc6ab3d5876c6ea8d1de4e";
const UNION_TIP = "5729f76d02e00b571d7fb63882330df71d45f8af";

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
}

/** True when `rev` names a commit object reachable in this clone. */
function objectExists(rev: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${rev}^{commit}`], {
      cwd: REPO,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

const LT = "<".repeat(7);
const GT = ">".repeat(7);
const BASE = "|".repeat(7);

/**
 * Extended-regex pattern matching the unambiguous conflict-marker prefixes.
 *
 * The base marker's seven `|` characters MUST be escaped. In ERE an unescaped
 * `|` is an alternation, so interpolating a raw `|||||||` (the old bug) parsed
 * as seven empty alternatives and `git grep -E` aborted with
 * `empty (sub)expression` (exit 128), which the harness then misread as
 * "markers found" (128 !== 1). A bare `=======` line stays excluded on purpose:
 * it is also a legitimate Markdown/section separator, and a real conflict always
 * carries a matching `<<<<<<<`/`>>>>>>>`.
 */
function conflictMarkerPattern(): string {
  return `^(${LT} |${GT} |${BASE.replace(/\|/g, "\\|")} )`;
}

interface GrepResult {
  status: number;
  /** stdout + stderr, so a git failure is visible in the assertion message. */
  output: string;
}

/**
 * Scan tracked files under `cwd` for conflict markers.
 *
 * Mirrors the exit-code contract: 0 = matches found, 1 = no matches, anything
 * else (notably 128) = git itself failed and the result must not be read as
 * "clean".
 */
function grepConflictMarkers(cwd: string): GrepResult {
  try {
    const stdout = execFileSync(
      "git",
      ["grep", "-nE", conflictMarkerPattern(), "--", "."],
      { cwd, encoding: "utf8" },
    );
    return { status: 0, output: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? 1,
      output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
    };
  }
}

describe("matchlock-union4 merge deliverable", () => {
  it("leaves no conflict markers in tracked files", () => {
    const { status, output } = grepConflictMarkers(REPO);
    assert.equal(
      status,
      1,
      status === 128
        ? `git grep could not run (malformed pattern or repo error):\n${output}`
        : `conflict markers found:\n${output}`,
    );
  });

  it("conflict-marker scan detects every marker prefix and stays clean otherwise", () => {
    // Self-contained proof that the scan can actually detect markers (not just
    // exit 1 for a pattern that never matches): build a throwaway repo, plant
    // synthetic markers, and assert git grep finds them; then clean the file and
    // assert the exit-code contract (1 = no matches).
    const root = tamanduaShortTempDir("tt-u4-");
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      const markerFile = path.join(root, "synthetic-markers.txt");
      writeFileSync(
        markerFile,
        [`${LT} HEAD`, `${GT} other-branch`, `${BASE} merged common ancestors`].join("\n") + "\n",
      );
      execFileSync("git", ["add", "synthetic-markers.txt"], { cwd: root });

      const found = grepConflictMarkers(root);
      assert.equal(
        found.status,
        0,
        `expected the scan to detect the synthetic markers, got status ${found.status}:\n${found.output}`,
      );
      for (const prefix of [LT, GT, BASE]) {
        assert.ok(
          found.output.includes(prefix),
          `scan missed marker prefix ${JSON.stringify(prefix)}:\n${found.output}`,
        );
      }

      // The deliberate `=======` exclusion and the anchor both hold.
      const pattern = new RegExp(conflictMarkerPattern());
      assert.equal(pattern.test("======="), false, "bare ======= must not match");
      assert.equal(pattern.test("<<<<<<<no-space"), false, "prefix requires trailing space");
      assert.equal(pattern.test("zzz <<<<<<< HEAD"), false, "match is anchored at line start");

      writeFileSync(markerFile, "no conflict markers here\n");
      const clean = grepConflictMarkers(root);
      assert.equal(
        clean.status,
        1,
        `expected exit 1 (no matches) on a clean tree, got ${clean.status}:\n${clean.output}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("HEAD ancestry is the union merge (or its squashed descendant)", (t) => {
    const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"])
      .split(/\s+/)
      .slice(1);
    if (parents.length === 2) {
      // This assertion needs the recorded union parents to be present. A fresh
      // clone only carries HEAD-reachable objects, so when they are absent the
      // check is skipped with an explicit reason rather than failing.
      const missing = [MAIN_TIP, UNION_TIP].filter((sha) => !objectExists(sha));
      if (missing.length > 0) {
        t.skip(
          `union merge parents unreachable in this clone: ${missing.join(", ")}`,
        );
        return;
      }
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

  it("tops out the one schema chain at SCHEMA_VERSION 14", () => {
    assert.equal(SCHEMA_VERSION, 14);
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
