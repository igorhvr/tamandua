import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { cleanChildEnv, createTempHome } from "../../tests/helpers/test-env.ts";

/** Spawn the tamandua CLI with isolated temp environment. */
function cli(args: string[]) {
  const th = createTempHome("tamandua-unknown-test-");
  const wrapperPath = path.resolve("bin/tamandua");
  const result = spawnSync("/bin/sh", [wrapperPath, ...args], {
    encoding: "utf8",
    env: cleanChildEnv({
      HOME: th.homeDir,
      TAMANDUA_STATE_DIR: th.tamanduaDir,
    }),
  });
  return { ...result, testEnv: th };
}

describe("Unknown subcommand handling", () => {
  it("tamandua workflow cancel without run-id → Missing run-id + exit 1 (alias for stop)", () => {
    const result = cli(["workflow", "cancel"]);
    assert.equal(result.status, 1);
    const stderr = result.stderr ?? "";
    assert.match(stderr, /Missing run-id\./);
    // Must NOT produce Unknown command
    assert.doesNotMatch(stderr, /Unknown command/);
    // Must NOT print the full usage dump
    const stdout = result.stdout ?? "";
    assert.doesNotMatch(stdout, /tamandua get-ready/);
  });

  it("tamandua workflow cancel <bogus-id> → tries to stop (alias for stop)", () => {
    const result = cli(["workflow", "cancel", "00000000"]);
    assert.equal(result.status, 1);
    const stderr = result.stderr ?? "";
    // Should say "No run found" (not "Unknown command")
    assert.match(stderr, /No run found matching/);
    assert.doesNotMatch(stderr, /Unknown command/);
  });

  it("tamandua pause-all → Unknown command + top-level suggestion + exit 1", () => {
    const result = cli(["pause-all"]);
    assert.equal(result.status, 1);
    const stderr = result.stderr ?? "";
    assert.match(stderr, /Unknown command: "pause-all"/);
    assert.match(stderr, /Run tamandua --help for available commands/);
    // Must NOT print the full usage dump
    const stdout = result.stdout ?? "";
    assert.doesNotMatch(stdout, /tamandua get-ready/);
  });

  it("tamandua daemonctl x → Unknown command + suggestion + exit 1", () => {
    const result = cli(["daemonctl", "x"]);
    assert.equal(result.status, 1);
    const stderr = result.stderr ?? "";
    assert.match(stderr, /Unknown command: "daemonctl"/);
    assert.match(stderr, /Did you mean: tamandua/);
    // Must NOT print the full usage dump
    const stdout = result.stdout ?? "";
    assert.doesNotMatch(stdout, /tamandua get-ready/);
  });

  it("tamandua workflow run-details y → Unknown command + workflow suggestion + exit 1", () => {
    const result = cli(["workflow", "run-details", "y"]);
    assert.equal(result.status, 1);
    const stderr = result.stderr ?? "";
    assert.match(stderr, /Unknown command: "workflow run-details"/);
    assert.match(stderr, /Did you mean: tamandua workflow/);
    assert.match(stderr, /Run tamandua workflow --help for available commands/);
    // Must NOT print the full usage dump
    const stdout = result.stdout ?? "";
    assert.doesNotMatch(stdout, /tamandua get-ready/);
  });

  it("known subcommands still work: tamandua workflow --help exits 0", () => {
    const result = cli(["workflow", "--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout ?? "", /tamandua workflow/);
  });

  it("known subcommands still work: tamandua version", () => {
    const result = cli(["version"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout ?? "", /^\d{8}T\d{6}Z_[0-9a-f]{40}/m);
  });

  it("tamandua with no args still prints usage and exits 1", () => {
    const result = cli([]);
    assert.equal(result.status, 1);
    assert.match(result.stdout ?? "", /tamandua get-ready/);
    assert.match(result.stdout ?? "", /tamandua update/);
  });

  it("tamandua workflow flarg → Unknown command with suggestion, no full usage dump", () => {
    const result = cli(["workflow", "flarg"]);
    assert.equal(result.status, 1);
    const stderr = result.stderr ?? "";
    assert.match(stderr, /Unknown command: "workflow flarg"/);
    // Must NOT print the full usage dump
    const stdout = result.stdout ?? "";
    assert.doesNotMatch(stdout, /tamandua get-ready/);
  });
});
