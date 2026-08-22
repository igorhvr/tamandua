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

  it("parses the optional --run-id without making it required", () => {
    // Absent: optional key stays absent (runPlumbingMerge then falls back to
    // TAMANDUA_RUN_ID env, then '' for runless manual merges).
    const absent = parseMergeBranchOptions(validArgs);
    assert.deepEqual(absent, {
      "--origin": "/repo/origin",
      "--branch": "feature/test",
      "--into": "main",
      "--expect-tip": "abc123",
      "--message": "Land feature",
    });
    assert.equal("--run-id" in absent, false);

    // Present exactly once with a non-empty value.
    assert.deepEqual(parseMergeBranchOptions([...validArgs, "--run-id", "run-xyz"]), {
      "--origin": "/repo/origin",
      "--branch": "feature/test",
      "--into": "main",
      "--expect-tip": "abc123",
      "--message": "Land feature",
      "--run-id": "run-xyz",
    });

    // --run-id=<value> form is accepted too.
    assert.equal(parseMergeBranchOptions([...validArgs, "--run-id=run-eq"])["--run-id"], "run-eq");

    // Duplicate and empty --run-id are rejected.
    assert.throws(
      () => parseMergeBranchOptions([...validArgs, "--run-id", "run-1", "--run-id", "run-2"]),
      /Duplicate option --run-id\./,
    );
    assert.throws(
      () => parseMergeBranchOptions([...validArgs, "--run-id"]),
      /Missing value for --run-id\./,
    );
    assert.throws(
      () => parseMergeBranchOptions([...validArgs, "--run-id="]),
      /Missing value for --run-id\./,
    );

    // Required-option validation still applies when --run-id is present.
    assert.throws(
      () => parseMergeBranchOptions([...validArgs.slice(0, -2), "--run-id", "run-xyz"]),
      /Missing required option --message\./,
    );
  });

  it("owns merge help and declines unrelated command groups", () => {
    const help = getMergeBranchHelp();
    assert.match(help, /^tamandua merge-branch — Atomically land a squash merge with Git plumbing/);
    assert.match(help, /STATUS: landed[\s\S]*STATUS: target_moved[\s\S]*STATUS: conflicts/);
    assert.match(help, /worktree list --porcelain/);
    assert.match(help, /managed parking/i);
    assert.match(help, /clean[\s\S]*refreshed/i);
    assert.match(help, /dirty[\s\S]*parked/i);
    assert.match(help, /multiple worktrees/i);
    assert.match(help, /invalid or ambiguous worktree metadata/i);
    assert.match(help, /operation in progress/i);
    assert.match(help, /CHECKOUT_REFRESH: <refreshed \| already-coherent \| not-applicable \| parked:branch>/);
    assert.match(help, /PARKED_BRANCH: <branch>/);
    assert.match(help, /PARKED_REASON: <local-changes \| advance-refused: detail>/);
    assert.doesNotMatch(help, /Operator remedy/i);
    assert.doesNotMatch(help, /git (?:checkout|reset|symbolic-ref|read-tree)/i);
    assert.equal(handleMergeBranch("workflow", ["workflow", "list"]), false);
  });

  it("publishes the managed checkout contract in operator documentation", () => {
    const documentation = readFileSync(join(process.cwd(), "docs/merge-branch.md"), "utf8");
    const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
    const readmeAtomicLanding = readme.slice(
      readme.indexOf("### Atomic landing"),
      readme.indexOf("### Management"),
    );

    assert.match(documentation, /git worktree list --porcelain/);
    assert.match(documentation, /clean[\s\S]*CHECKOUT_REFRESH: refreshed/i);
    assert.match(documentation, /dirty[\s\S]*CHECKOUT_REFRESH: parked:<backup-branch>/i);
    assert.match(documentation, /no-op[\s\S]*CHECKOUT_REFRESH: already-coherent/i);
    assert.match(documentation, /unowned[\s\S]*CHECKOUT_REFRESH: not-applicable/i);
    assert.match(documentation, /multiple worktrees[\s\S]*invalid or ambiguous[\s\S]*operation in progress/i);
    assert.doesNotMatch(documentation, /Operator remedy/i);
    assert.doesNotMatch(documentation, /(?:detach|manually switch|manual(?:ly)? reset|edit (?:worktree )?metadata|direct(?:ly)? rewrite refs)/i);
    assert.doesNotMatch(documentation, /skipped:/);

    assert.match(readmeAtomicLanding, /clean[\s\S]*refreshed/i);
    assert.match(readmeAtomicLanding, /dirty[\s\S]*parked/i);
    assert.match(readmeAtomicLanding, /no-op[\s\S]*already-coherent/i);
    assert.match(readmeAtomicLanding, /unowned[\s\S]*not-applicable/i);
    assert.doesNotMatch(readmeAtomicLanding, /any checked-out target is refused/i);
    assert.doesNotMatch(readmeAtomicLanding, /(?:detach|manually switch|manual(?:ly)? reset|edit (?:worktree )?metadata|direct(?:ly)? rewrite refs)/i);
  });

  it("limits successful merge event checkout outcomes to truthful values", () => {
    const eventTypes = readFileSync(join(process.cwd(), "src/installer/events.ts"), "utf8");
    assert.match(eventTypes, /`parked:\$\{string\}`/);
    assert.match(eventTypes, /parkedBranch\?: string;/);
    assert.match(eventTypes, /parkedReason\?: string;/);
    assert.doesNotMatch(eventTypes, /skipped:/);
  });
});
