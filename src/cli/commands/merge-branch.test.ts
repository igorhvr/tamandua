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
    assert.match(help, /worktree list --porcelain/);
    assert.match(help, /checked-out[\s\S]*refusal[\s\S]*exit code 1/i);
    assert.match(help, /not a partial landing/i);
    assert.match(help, /not a retryable lock wait/i);
    assert.match(help, /CHECKOUT_REFRESH: not-applicable/);
    assert.doesNotMatch(help, /CHECKOUT_REFRESH: <refreshed/);
    assert.doesNotMatch(help, /post-CAS/);
    assert.doesNotMatch(help, /rollback/);
    assert.doesNotMatch(help, /skipped:/);
    assert.equal(handleMergeBranch("workflow", ["workflow", "list"]), false);
  });

  it("publishes the fail-closed checkout contract in operator documentation", () => {
    const documentation = readFileSync(join(process.cwd(), "docs/merge-branch.md"), "utf8");
    assert.match(documentation, /git worktree list --porcelain/);
    assert.match(documentation, /any unique root or linked checkout/i);
    assert.match(documentation, /bounded operational refusal/i);
    assert.match(documentation, /not a partial landing/i);
    assert.match(documentation, /not a retryable lock wait/i);
    assert.match(documentation, /CHECKOUT_REFRESH: not-applicable/);
    assert.match(documentation, /success is possible only for bare/i);
    assert.match(documentation, /the operator must make the target ref unowned/i);
    assert.doesNotMatch(documentation, /CHECKOUT_REFRESH: refreshed/);
    assert.doesNotMatch(documentation, /CHECKOUT_REFRESH: already-coherent/);
    assert.doesNotMatch(documentation, /post-CAS/i);
    assert.doesNotMatch(documentation, /rollback/i);
    assert.doesNotMatch(documentation, /skipped:/);
  });

  it("limits successful merge event checkout outcomes to truthful values", () => {
    const eventTypes = readFileSync(join(process.cwd(), "src/installer/events.ts"), "utf8");
    assert.match(eventTypes, /export type CheckoutRefreshOutcome = "refreshed" \| "already-coherent" \| "not-applicable";/);
    assert.doesNotMatch(eventTypes, /skipped:/);
  });
});
