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
    const help = getMergeBranchHelp();
    assert.match(help, /^tamandua merge-branch — Atomically land a squash merge with Git plumbing/);
    assert.match(help, /STATUS: landed[\s\S]*STATUS: target_moved[\s\S]*STATUS: conflicts/);
    assert.match(help, /linked worktrees/i);
    assert.match(help, /dirty or ambiguous[\s\S]*exit code 1/i);
    assert.match(help, /post-CAS[\s\S]*rollback/i);
    assert.match(help, /CHECKOUT_REFRESH: <refreshed \| already-coherent \| not-applicable>/);
    assert.doesNotMatch(help, /skipped:/);
    assert.equal(handleMergeBranch("workflow", ["workflow", "list"]), false);
  });

  it("publishes the fail-closed checkout contract in operator documentation", () => {
    const documentation = readFileSync(join(process.cwd(), "docs/merge-branch.md"), "utf8");
    assert.match(documentation, /git worktree list --porcelain/);
    assert.match(documentation, /dirty or ambiguous[\s\S]*before[\s\S]*target ref moves/i);
    assert.match(documentation, /post-CAS[\s\S]*compare-and-swap rollback/i);
    assert.match(documentation, /CHECKOUT_REFRESH: refreshed/);
    assert.match(documentation, /CHECKOUT_REFRESH: already-coherent/);
    assert.match(documentation, /CHECKOUT_REFRESH: not-applicable/);
    assert.doesNotMatch(documentation, /skipped:/);
  });

  it("limits successful merge event checkout outcomes to truthful values", () => {
    const eventTypes = readFileSync(join(process.cwd(), "src/installer/events.ts"), "utf8");
    assert.match(eventTypes, /export type CheckoutRefreshOutcome = "refreshed" \| "already-coherent" \| "not-applicable";/);
    assert.doesNotMatch(eventTypes, /skipped:/);
  });
});
