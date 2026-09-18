/**
 * Static daemon teardown guard (SWEEP-SCOPE US-006, bead tamandua-6sy.77).
 *
 * Every test file that starts a tamandua daemon MUST contain a teardown
 * reference in the same file. A test daemon that outlives its file can keep
 * running the leaked-process sweep against an unrelated enclosing worktree
 * (the CROSS-RUN KILL defect), so a fixture that starts a daemon and never
 * stops it is a hard failure here.
 *
 * This is a static, file-level check: it catches the "started but no stop
 * path at all" shape. Whether the stop runs is covered by the runtime
 * `tests/helpers/daemon-survivor-guard.ts` after-hook.
 *
 * Scanned roots (matching the story):
 *   - e2e-tests/*.test.ts
 *   - src/**\/*.test.ts
 *   - tests/*.test.ts
 *
 * Registered in `tests/serial-files.txt` (spawn-capable test surface).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const SELF_RELATIVE = path.join("tests", "test-daemon-teardown-guard.test.ts");

/** A recognized way to start a daemon in a test file. */
interface StartPattern {
  name: string;
  regex: RegExp;
}

/**
 * Daemon start channels. `direct daemon spawn` requires the spawn call and
 * the daemon script constant to be near each other, so merely mentioning
 * `daemon.js` in a string literal is not a start.
 */
export const DAEMON_START_PATTERNS: StartPattern[] = [
  { name: "startIsolatedDaemon", regex: /\bstartIsolatedDaemon\s*\(/ },
  { name: "startIsolatedDashboard", regex: /\bstartIsolatedDashboard\s*\(/ },
  { name: "startDaemon", regex: /\bstartDaemon\s*\(/ },
  { name: "startControlPlane", regex: /\bstartControlPlane\s*\(/ },
  { name: "startMcp", regex: /\bstartMcp\s*\(/ },
  { name: "startDashboardStandalone", regex: /\bstartDashboardStandalone\s*\(/ },
  {
    name: "direct daemon spawn",
    regex:
      /spawn[A-Za-z]*\s*\([^;]{0,600}?(?:daemon\.js|DAEMON_SCRIPT|daemonScript|dashboard-standalone\.js|DASHBOARD_STANDALONE_SCRIPT|dashboardStandaloneScript|DASHBOARD_SCRIPT)/s,
  },
];

/**
 * A recognized teardown reference. Deliberately forgiving: any stop helper,
 * SIGTERM/SIGKILL, or a direct kill call satisfies the file-level rule. The
 * runtime survivor guard plus review enforce "stop the EXACT pid".
 */
export const DAEMON_STOP_PATTERNS: RegExp[] = [
  /\bstop\w*Daemon/,
  /\bstop\w*ControlPlane/,
  /\bstop\w*Mcp/,
  /\bstop\w*Dashboard/,
  /\.kill\s*\(/,
  /\bSIGTERM\b|\bSIGKILL\b/,
  /\bprocess\.kill\s*\(/,
  /\bstopPidfileServiceAndWait\s*\(/,
  /\breapStaleOrphans\s*\(/,
  /\bterminateOwnedProcessGroup\s*\(/,
];

export interface SourceEntry {
  /** Repo-relative path, used in violation messages. */
  path: string;
  content: string;
}

/** Return one violation string per file that starts a daemon without any stop reference. */
export function findDaemonTeardownViolations(entries: SourceEntry[]): string[] {
  const violations: string[] = [];
  for (const entry of entries) {
    const start = DAEMON_START_PATTERNS.find((p) => p.regex.test(entry.content));
    if (!start) continue;
    const hasStop = DAEMON_STOP_PATTERNS.some((r) => r.test(entry.content));
    if (!hasStop) {
      violations.push(
        `${entry.path}: starts a daemon via ${start.name} but has no stop/kill reference in the same file`,
      );
    }
  }
  return violations;
}

/** Recursively collect `*.test.ts` files under a directory. */
function collectTestFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTestFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** The exact scan set: top-level e2e/tests files plus every src test file. */
export function collectScannedFiles(repoRoot: string): string[] {
  const files: string[] = [];
  for (const name of fs.readdirSync(path.join(repoRoot, "e2e-tests"))) {
    if (name.endsWith(".test.ts")) files.push(path.join(repoRoot, "e2e-tests", name));
  }
  files.push(...collectTestFiles(path.join(repoRoot, "src")));
  for (const name of fs.readdirSync(path.join(repoRoot, "tests"))) {
    if (name.endsWith(".test.ts")) files.push(path.join(repoRoot, "tests", name));
  }
  return files;
}

/** Read every scanned file into a SourceEntry, excluding this guard itself. */
export function collectScannedEntries(repoRoot: string): SourceEntry[] {
  const entries: SourceEntry[] = [];
  for (const file of collectScannedFiles(repoRoot)) {
    const relative = path.relative(repoRoot, file);
    if (relative === SELF_RELATIVE) continue;
    entries.push({ path: relative, content: fs.readFileSync(file, "utf-8") });
  }
  return entries;
}

describe("daemon teardown guard", () => {
  it("passes on the repository test files", () => {
    const violations = findDaemonTeardownViolations(collectScannedEntries(REPO_ROOT));
    assert.deepEqual(
      violations,
      [],
      `test file(s) start a daemon without a teardown:\n${violations.join("\n")}`,
    );
  });

  it("fails on a synthetic fixture that starts but never stops a daemon", () => {
    const dir = tamanduaTempDir("tamandua-teardown-guard-");
    try {
      const bad = path.join(dir, "fixture-starts-never-stops.test.ts");
      const good = path.join(dir, "fixture-starts-and-stops.test.ts");
      fs.writeFileSync(
        bad,
        [
          'import { startIsolatedDaemon } from "./helpers/e2e-helpers.ts";',
          "const daemon = await startIsolatedDaemon(home, port);",
          "// no teardown at all",
        ].join("\n"),
      );
      fs.writeFileSync(
        good,
        [
          'import { startIsolatedDaemon, stopIsolatedDaemon } from "./helpers/e2e-helpers.ts";',
          "const daemon = await startIsolatedDaemon(home, port);",
          "try { await run(); } finally { await stopIsolatedDaemon(daemon); }",
        ].join("\n"),
      );

      const entries = [bad, good].map((file) => ({
        path: path.basename(file),
        content: fs.readFileSync(file, "utf-8"),
      }));
      const violations = findDaemonTeardownViolations(entries);

      assert.equal(violations.length, 1, `expected exactly one violation, got: ${violations.join("; ")}`);
      assert.match(violations[0], /fixture-starts-never-stops\.test\.ts/);
      assert.match(violations[0], /startIsolatedDaemon/);
      assert.ok(
        !violations.some((v) => v.includes("fixture-starts-and-stops")),
        "a fixture that stops its daemon must not be flagged",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a direct daemon spawn as a start channel", () => {
    const content = [
      'const DAEMON_SCRIPT = path.resolve("dist", "server", "daemon.js");',
      'const child = spawn("node", [DAEMON_SCRIPT]);',
    ].join("\n");
    assert.deepEqual(
      findDaemonTeardownViolations([{ path: "fixture.test.ts", content }]),
      ["fixture.test.ts: starts a daemon via direct daemon spawn but has no stop/kill reference in the same file"],
    );

    const withStop = `${content}\nprocess.kill(child.pid, "SIGKILL");`;
    assert.deepEqual(findDaemonTeardownViolations([{ path: "fixture.test.ts", content: withStop }]), []);
  });

  it("does not treat a bare daemon.js string literal as a start", () => {
    const content = 'const cmdline = "node /opt/tamandua/dist/server/daemon.js --with-mcp";';
    assert.deepEqual(findDaemonTeardownViolations([{ path: "strings.test.ts", content }]), []);
  });

  it("scans only e2e-tests top-level, tests top-level and src recursively", () => {
    const scanned = collectScannedFiles(REPO_ROOT).map((f) => path.relative(REPO_ROOT, f));
    assert.ok(scanned.includes(path.join("tests", "daemon-survivor-guard.test.ts")));
    assert.ok(scanned.includes(path.join("tests", "helpers", "dead-owner-teardown.test.ts")) === false);
    assert.ok(scanned.includes(path.join("e2e-tests", "helpers", "e2e-helpers.test.ts")) === false);
    assert.ok(scanned.includes(path.join("e2e-tests", "workflows-scripted.test.ts")));
  });
});
