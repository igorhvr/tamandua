/**
 * Unit tests for the pure static isolation checker (US-009).
 *
 * These tests feed synthetic file contents to `findIsolationEnvViolations`
 * (and the small path/reference classifiers) and assert the contract:
 *   - a test file that spawns a daemon or the CLI entry without cleanChildEnv
 *     is flagged;
 *   - a file that calls cleanChildEnv directly, or imports a helper module
 *     that uses it (transitively), is accepted;
 *   - a reasoned allowlist entry is honored;
 *   - non-test files and text/comment-only mentions are not flagged.
 *
 * Everything here is pure (no process spawn), so the file stays in the
 * parallel lane. The `call()` builder assembles synthetic spawner calls at
 * runtime instead of writing the literal `name(` token, so the text-based
 * serial-classification guard does not mistake this pure-logic file for a
 * daemonctl spawner. (Synthetic fixture text naming `startDaemon` also keeps
 * this file out of the top-level daemon-teardown scan, which only visits
 * top-level tests/*.test.ts.)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findIsolationEnvViolations,
  isGuardedTestPath,
  spawnsDaemonOrCli,
} from "./isolation-env-guard.ts";

/** Build `name(args);` without the literal `name(` token in this source file. */
function call(name: string, args = ""): string {
  return `${name}(${args});`;
}

describe("findIsolationEnvViolations", () => {
  it("flags a synthetic daemon-spawning test file without cleanChildEnv", () => {
    const violations = findIsolationEnvViolations(
      [
        {
          path: "tests/synthetic-daemon.test.ts",
          content:
            'import { startDaemon } from "../dist/server/daemonctl.js";\n' +
            "const port = 4301;\n" +
            "await " +
            call("startDaemon", "port, { homeDir: tempHome }") +
            "\n",
        },
      ],
      [],
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0], /synthetic-daemon\.test\.ts/);
    assert.match(violations[0], /cleanChildEnv/);
  });

  it("flags a synthetic CLI-spawning test file without cleanChildEnv", () => {
    const violations = findIsolationEnvViolations(
      [
        {
          path: "e2e-tests/synthetic-cli.test.ts",
          content:
            'import { spawnSync } from "node:child_process";\n' +
            'import path from "node:path";\n' +
            'const cliPath = path.resolve(process.cwd(), "dist", "cli", "cli.js");\n' +
            'spawnSync(process.execPath, [cliPath, "status"]);\n',
        },
      ],
      [],
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0], /synthetic-cli\.test\.ts/);
  });

  it("accepts a file that calls cleanChildEnv directly", () => {
    const violations = findIsolationEnvViolations(
      [
        {
          path: "tests/synthetic-guarded.test.ts",
          content:
            'import { cleanChildEnv } from "./helpers/test-env.ts";\n' +
            'import { startMcp } from "../dist/server/daemonctl.js";\n' +
            "await " +
            call("startMcp", "port, { env: cleanChildEnv({ HOME: tempHome }) }") +
            "\n",
        },
      ],
      [],
    );
    assert.deepEqual(violations, []);
  });

  it("accepts a file whose imported helper itself uses cleanChildEnv", () => {
    const violations = findIsolationEnvViolations(
      [
        {
          path: "tests/synthetic-via-helper.test.ts",
          content:
            'import { baseEnv } from "./helpers/env-helper.ts";\n' +
            'import { spawnSync } from "node:child_process";\n' +
            'spawnSync("node", ["cli.js"], { env: baseEnv(homeDir, port) });\n',
        },
        {
          path: "tests/helpers/env-helper.ts",
          content:
            'import { cleanChildEnv } from "./test-env.ts";\n' +
            "export function baseEnv(home: string, port: number) {\n" +
            "  return cleanChildEnv({ HOME: home, TAMANDUA_CONTROL_PORT: String(port) });\n" +
            "}\n",
        },
      ],
      [],
    );
    assert.deepEqual(violations, []);
  });

  it("accepts a reasoned allow-list entry and rejects the same file without one", () => {
    const file = {
      path: "tests/allow-listed.test.ts",
      content: 'const cli = "bin/tamandua";\n',
    };
    assert.deepEqual(
      findIsolationEnvViolations(
        [file],
        [
          {
            path: "tests/allow-listed.test.ts",
            reason: "never spawns a process; entry is fixture text",
          },
        ],
      ),
      [],
    );
    assert.equal(findIsolationEnvViolations([file], []).length, 1);
  });

  it("does not flag non-test files or escaped text mentions", () => {
    const files = [
      {
        path: "tests/regex-only.test.ts",
        content: "const re = /\\bstartDaemon\\s*\\(/; // spawner names as text\n",
      },
      {
        path: "tests/helpers/not-a-test.ts",
        content: call("startDaemon", "4301") + "\n",
      },
    ];
    assert.deepEqual(findIsolationEnvViolations(files, []), []);
  });

  it("classifies guarded paths and spawner references", () => {
    assert.equal(isGuardedTestPath("tests/a.test.ts"), true);
    assert.equal(isGuardedTestPath("e2e-tests/a.test.ts"), true);
    assert.equal(isGuardedTestPath("src/a.test.ts"), false);
    assert.equal(isGuardedTestPath("tests/helpers/a.ts"), false);
    assert.equal(spawnsDaemonOrCli(call("startDashboardStandalone", "4912")), true);
    assert.equal(spawnsDaemonOrCli('const p = "dist/cli/cli.js";'), true);
    assert.equal(spawnsDaemonOrCli("const x = computeThing(1);"), false);
  });
});