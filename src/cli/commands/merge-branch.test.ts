import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  getMergeBranchHelp,
  handleMergeBranch,
  parseMergeBranchOptions,
} from "../../../dist/cli/commands/merge-branch.js";

const validArgs = [
  "--origin", "/repo/origin",
  "--branch=feature/test",
  "--into", "main",
  "--expect-tip", "abc123",
  "--message", "Land feature",
];

describe("SPL2 merge-branch command module", () => {
  it("is backed by a reachable merge-branch command source module", () => {
    assert.equal(existsSync(join(process.cwd(), "src/cli/commands/merge-branch.ts")), true);
    const dispatcher = readFileSync(join(process.cwd(), "src/cli/cli.ts"), "utf8");
    assert.match(dispatcher, /from "\.\/commands\/merge-branch\.js"/);
  });

  it("owns required named-option parsing", () => {
    assert.deepEqual(parseMergeBranchOptions(validArgs), {
      "--origin": "/repo/origin",
      "--branch": "feature/test",
      "--into": "main",
      "--expect-tip": "abc123",
      "--message": "Land feature",
    });

    assert.throws(
      () => parseMergeBranchOptions([...validArgs, "--branch", "duplicate"]),
      /Duplicate option --branch\./,
    );
    assert.throws(
      () => parseMergeBranchOptions(validArgs.slice(0, -2)),
      /Missing required option --message\./,
    );
    assert.throws(
      () => parseMergeBranchOptions([...validArgs, "positional"]),
      /Unexpected argument positional\./,
    );
  });

  it("owns merge help and declines unrelated command groups", () => {
    assert.match(getMergeBranchHelp(), /^tamandua merge-branch — Atomically land a squash merge with Git plumbing/);
    assert.match(getMergeBranchHelp(), /STATUS: landed[\s\S]*STATUS: target_moved[\s\S]*STATUS: conflicts/);
    assert.equal(handleMergeBranch("workflow", ["workflow", "list"]), false);
  });
});
