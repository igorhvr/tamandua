import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

function collectTestFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("test isolation guard", () => {
  it("does not contain patterns that can touch the live daemon", () => {
    const testFiles = [
      ...collectTestFiles(path.join(process.cwd(), "tests")),
      ...collectTestFiles(path.join(process.cwd(), "e2e-tests")),
      ...collectTestFiles(path.join(process.cwd(), "src")),
    ];

    const forbidden = [
      /\bstopDaemon\(\s*\);/,
      /\bstopMcp\(\s*\);/,
      /\bstopControlPlane\(\s*\);/,
      /\bstopDashboardStandalone\(\s*\);/,
      /fs\.unlinkSync\(\s*(?:PID_FILE|MCP_PID_FILE|MCP_PORT_FILE|CONTROL_PLANE_PID_FILE|CONTROL_PLANE_PORT_FILE)\s*\)/,
      /\.{3}process\.env/,
      /env\s*\?\s*\{\s*\.{3}process\.env/,
      /:\s*process\.env\s*[,}]/,
      /\b(?:canBind|fetch)\(\s*(?:`[^`]*(?:3334|3338|3339)|["'][^"']*(?:3334|3338|3339)|3334|3338|3339)/,
      /\b(?:startDaemon|startMcp|startControlPlane|startDashboardStandalone)\(\s*(?:3334|3338|3339|DEFAULT_MCP_PORT|DEFAULT_CONTROL_PORT)/,
    ];

    const violations: string[] = [];
    for (const file of testFiles) {
      const relative = path.relative(process.cwd(), file);
      const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
      lines.forEach((line, index) => {
        for (const pattern of forbidden) {
          if (pattern.test(line)) {
            violations.push(`${relative}:${index + 1}: ${line.trim()}`);
          }
        }
      });
    }

    assert.deepEqual(violations, []);
  });

  it("test files that use logger or agent-scheduler must set TAMANDUA_STATE_DIR", () => {
    // Test files that import logger or agent-scheduler functions must isolate
    // their log output using TAMANDUA_STATE_DIR to avoid polluting the live
    // ~/.tamandua/tamandua.log. This regression test guards against that.
    const testFiles = [
      ...collectTestFiles(path.join(process.cwd(), "tests")),
      ...collectTestFiles(path.join(process.cwd(), "e2e-tests")),
      ...collectTestFiles(path.join(process.cwd(), "src")),
    ];

    // Patterns that indicate the test file uses logger functions that write to disk.
    // 1. Direct import from logger.js => logger.info/warn/error/debug/log calls write to disk.
    // 2. Import of runPi or executeDispatchRound from agent-scheduler => these call the logger internally.
    const loggerSensitiveImports = [
      /from\s+["'].*\/lib\/logger\.js["']/,
      /from\s+["'].*\/installer\/agent-scheduler\.js["'].*\brunPi\b/,
      /from\s+["'].*\/installer\/agent-scheduler\.js["'].*\bexecuteDispatchRound\b/,
    ];

    const logsViaTamanduaDir = /TAMANDUA_STATE_DIR/;
    // Acceptable alternatives to TAMANDUA_STATE_DIR: monkey-patching logger so it never writes to disk
    const hasLoggerPatch = /captureLoggerCalls|mutableLogger\.(?:info|warn|error)\s*=/;

    const violations: string[] = [];
    for (const file of testFiles) {
      const relative = path.relative(process.cwd(), file);
      const content = fs.readFileSync(file, "utf-8");

      const importsLogger = loggerSensitiveImports.some((p) => p.test(content));
      if (!importsLogger) continue;

      if (!logsViaTamanduaDir.test(content) && !hasLoggerPatch.test(content)) {
        violations.push(
          `${relative}: imports logger or agent-scheduler without setting TAMANDUA_STATE_DIR or monkey-patching logger`,
        );
      }
    }

    assert.deepEqual(violations, []);
  });

  it("src files that import logger must also import guard coverage (assertStatePathIsolation or testGuardActive)", () => {
    // Production src/ files that use the logger go through writeLine() which
    // now has a built-in assertStatePathIsolation guard. This static check
    // ensures every src/ logger consumer either:
    //   (a) imports assertStatePathIsolation/testGuardActive from test-guard, OR
    //   (b) is the logger module itself (which contains the guard).
    // This prevents regressions where a src/ module writes log data through
    // getLogPath() directly, bypassing writeLine()'s guard.
    const srcFiles = collectTestFiles(path.join(process.cwd(), "src"));

    const hasLoggerImport = /from\s+["'].*\/lib\/logger\.js["']/;
    const hasGuardImport =
      /from\s+["'].*\/lib\/test-guard\.js["'].*\bassertStatePathIsolation\b/;
    const hasGuardActiveImport =
      /from\s+["'].*\/lib\/test-guard\.js["'].*\btestGuardActive\b/;
    const isLoggerModule = /\/lib\/logger\.test\.ts$/;

    const violations: string[] = [];
    for (const file of srcFiles) {
      const relative = path.relative(process.cwd(), file);
      if (isLoggerModule.test(relative)) continue;

      const content = fs.readFileSync(file, "utf-8");
      if (!hasLoggerImport.test(content)) continue;

      if (!hasGuardImport.test(content) && !hasGuardActiveImport.test(content)) {
        violations.push(
          `${relative}: imports logger without importing assertStatePathIsolation or testGuardActive from test-guard.js`,
        );
      }
    }

    assert.deepEqual(violations, []);
  });

  it("src test files that import from events.ts must also import guard coverage", () => {
    // US-001 added assertStatePathIsolation to emitEvent() in events.ts.
    // This static check ensures every src/ test file that imports from events.ts
    // also imports assertStatePathIsolation or testGuardActive from test-guard.js,
    // demonstrating awareness of the isolation guard.
    const srcFiles = collectTestFiles(path.join(process.cwd(), "src"));

    const hasEventsImport = /from\s+["'].*\/installer\/events\.js["']/;
    const hasGuardImport =
      /\bassertStatePathIsolation\b.*from\s+["'].*\/lib\/test-guard\.js["']/;
    const hasGuardActiveImport =
      /\btestGuardActive\b.*from\s+["'].*\/lib\/test-guard\.js["']/;
    const isEventsModule = /\/installer\/events\.test\.ts$/;

    const violations: string[] = [];
    for (const file of srcFiles) {
      const relative = path.relative(process.cwd(), file);
      if (isEventsModule.test(relative)) continue;

      const content = fs.readFileSync(file, "utf-8");
      if (!hasEventsImport.test(content)) continue;

      if (!hasGuardImport.test(content) && !hasGuardActiveImport.test(content)) {
        violations.push(
          `${relative}: imports from events.ts without importing assertStatePathIsolation or testGuardActive from test-guard.js`,
        );
      }
    }

    assert.deepEqual(violations, []);
  });

  it("src test files that import from control-client.ts must also import guard coverage", () => {
    // US-002 added testGuardActive + assertStatePathIsolation to controlRequest()
    // in control-client.ts. This static check ensures every src/ test file that
    // imports from control-client.ts also imports the guard.
    const srcFiles = collectTestFiles(path.join(process.cwd(), "src"));

    const hasControlClientImport = /from\s+["'].*\/server\/control-client\.js["']/;
    const hasGuardImport =
      /\bassertStatePathIsolation\b.*from\s+["'].*\/lib\/test-guard\.js["']/;
    const hasGuardActiveImport =
      /\btestGuardActive\b.*from\s+["'].*\/lib\/test-guard\.js["']/;
    const isControlClientModule = /\/server\/control-client\.test\.ts$/;

    const violations: string[] = [];
    for (const file of srcFiles) {
      const relative = path.relative(process.cwd(), file);
      if (isControlClientModule.test(relative)) continue;

      const content = fs.readFileSync(file, "utf-8");
      if (!hasControlClientImport.test(content)) continue;

      if (!hasGuardImport.test(content) && !hasGuardActiveImport.test(content)) {
        violations.push(
          `${relative}: imports from control-client.ts without importing assertStatePathIsolation or testGuardActive from test-guard.js`,
        );
      }
    }

    assert.deepEqual(violations, []);
  });

  it("daemonctl.ts must import guard coverage", () => {
    // US-003 added assertStatePathIsolation to daemonctl.ts path resolution,
    // port read/write, and lifecycle functions. This self-check verifies the
    // module itself imports the guard.
    const daemonctlPath = path.join(process.cwd(), "src", "server", "daemonctl.ts");
    const content = fs.readFileSync(daemonctlPath, "utf-8");
    const hasGuardImport =
      /\b(?:assertStatePathIsolation|testGuardActive)\b.*from\s+["'].*\/lib\/test-guard\.js["']/;
    assert.ok(
      hasGuardImport.test(content),
      "daemonctl.ts must import assertStatePathIsolation or testGuardActive from test-guard.js",
    );
  });

  it("control-server.ts must import guard coverage when using secret functions", () => {
    // US-004 added guards to readDaemonSecret() and ensureDaemonSecret() in
    // control-server.ts. This self-check verifies the module imports the guard
    // if it uses those secret functions. The module also imports
    // assertPortIsolation for the port binding guard.
    const controlServerPath = path.join(process.cwd(), "src", "server", "control-server.ts");
    const content = fs.readFileSync(controlServerPath, "utf-8");
    const usesSecretFunctions = /\b(?:readDaemonSecret|ensureDaemonSecret)\b/.test(content);
    if (usesSecretFunctions) {
      const hasGuardImport =
        /\b(?:assertStatePathIsolation|testGuardActive)\b.*from\s+["'].*\/lib\/test-guard\.js["']/;
      assert.ok(
        hasGuardImport.test(content),
        "control-server.ts uses readDaemonSecret/ensureDaemonSecret but does not import assertStatePathIsolation or testGuardActive from test-guard.js",
      );
    }
  });
});

describe("test guard disarm protection", () => {
  it("test files that disable TAMANDUA_TEST_GUARD must save the prior value first", () => {
    // Regression guard for the disarm bug found 2026-07-05: several tests set
    // TAMANDUA_TEST_GUARD = "0" and then `delete`d the variable in finally
    // instead of restoring the previous value ("1" under npm test) — leaving
    // the isolation guard PERMANENTLY DISARMED for every subsequent test in
    // that file's process. Any test file that assigns a disabling value must
    // contain a save-read of process.env.TAMANDUA_TEST_GUARD (inline
    // `const prev = process.env.TAMANDUA_TEST_GUARD` or a beforeEach hook
    // capture) so the finally can restore rather than delete.
    const testFiles = [
      ...collectTestFiles(path.join(process.cwd(), "tests")),
      ...collectTestFiles(path.join(process.cwd(), "e2e-tests")),
      ...collectTestFiles(path.join(process.cwd(), "src")),
    ];

    const disables = /process\.env\.TAMANDUA_TEST_GUARD\s*=\s*["'](?:0|false|)["']/;
    const savesPrior = /=\s*process\.env\.TAMANDUA_TEST_GUARD\s*[;,)]/;

    const violations: string[] = [];
    for (const file of testFiles) {
      const relative = path.relative(process.cwd(), file);
      const content = fs.readFileSync(file, "utf-8");
      if (!disables.test(content)) continue;

      const disableIndex = content.search(disables);
      const saveIndex = content.search(savesPrior);
      if (saveIndex === -1 || saveIndex > disableIndex) {
        violations.push(
          `${relative}: disables TAMANDUA_TEST_GUARD without first saving the prior value — ` +
            `restore-by-delete disarms the guard for the rest of the test process`,
        );
      }
    }

    assert.deepEqual(violations, []);
  });
});
