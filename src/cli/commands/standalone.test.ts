import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";

const updateSpecifier = fileURLToPath(
  new URL("../../../dist/cli/update.js", import.meta.url),
);

describe("SPL2 standalone command module", () => {
  // Handler-level update exit code tests with stubbed runUpdate.
  // Uses mock.module so we can verify the exit-code dispatch in
  // handleStandalone without exercising the real update pipeline.
  // The mock is installed BEFORE standalone.js is imported so that
  // the live ESM binding to runUpdate resolves to our stub.
  describe("update exit codes (handler-level, with stubbed runUpdate)", () => {
    let mockResult: any;

    // Guard: mock.module requires --experimental-test-module-mocks.
    // Without it, skip these tests rather than erroring.
    const hasMockModule = typeof mock.module === "function";

    if (hasMockModule) {
      mock.module(updateSpecifier, {
        exports: {
          runUpdate: async () => mockResult,
        },
      });
    }

    it("maps blocked_active_runs, refused_diverged, pull_failed to exitCode 1", {
      skip: !hasMockModule ? "requires --experimental-test-module-mocks" : undefined,
    }, async () => {
      const { handleStandalone } = await import(
        "../../../dist/cli/commands/standalone.js"
      );

      const failureStatuses: Array<{ status: string } & Record<string, any>> = [
        { status: "blocked_active_runs", sourcePath: "", beforeHead: "", afterHead: "", activeRuns: [] },
        { status: "refused_diverged", sourcePath: "", head: "" },
        { status: "pull_failed", sourcePath: "", head: "", error: "network failure" },
      ];

      for (const result of failureStatuses) {
        mockResult = result;
        process.exitCode = 0;
        await handleStandalone("update", ["update"]);
        assert.equal(
          process.exitCode,
          1,
          `${result.status} should set exitCode=1, got ${process.exitCode}`,
        );
      }
      process.exitCode = 0;
    });

    it("maps no_change, updated to exitCode 0", {
      skip: !hasMockModule ? "requires --experimental-test-module-mocks" : undefined,
    }, async () => {
      const { handleStandalone } = await import(
        "../../../dist/cli/commands/standalone.js"
      );

      // no_change
      mockResult = { status: "no_change", sourcePath: "", head: "" };
      process.exitCode = 0;
      await handleStandalone("update", ["update"]);
      assert.equal(
        process.exitCode,
        0,
        `no_change should leave exitCode=0, got ${process.exitCode}`,
      );

      // updated
      mockResult = {
        status: "updated",
        sourcePath: "",
        beforeHead: "",
        afterHead: "",
        services: {
          daemon: { running: false, pid: null, port: 0 },
          dashboard: { running: false, pid: null, port: 0 },
          mcp: { running: false, pid: null, port: 0 },
        },
        installedWorkflows: [],
      };
      process.exitCode = 0;
      await handleStandalone("update", ["update"]);
      assert.equal(
        process.exitCode,
        0,
        `updated should leave exitCode=0, got ${process.exitCode}`,
      );

      process.exitCode = 0;
    });
  });

  it("owns help for every standalone command", async () => {
    const {
      getTamanduaHelp,
      getVersionHelp,
      getSkillPathHelp,
      getSourcePathHelp,
      getUpdateHelp,
      getNudgeHelp,
    } = await import("../../../dist/cli/commands/standalone.js");
    assert.match(getTamanduaHelp(), /tamandua tamandua/);
    assert.match(getVersionHelp(), /tamandua --version/);
    assert.match(getSkillPathHelp(), /tamandua skill-path/);
    assert.match(getSourcePathHelp(), /tamandua source-path/);
    assert.match(getUpdateHelp(), /tamandua update \[--force\]/);
    assert.match(getNudgeHelp(), /tamandua nudge/);
  });

  it("declines commands owned by other command groups", async () => {
    const { handleStandalone } = await import(
      "../../../dist/cli/commands/standalone.js"
    );
    assert.equal(await handleStandalone("doctor", ["doctor"]), false);
  });
});
