/**
 * CLI-level tests for the daemon-lifecycle surfacing in `tamandua status`
 * (US-004).
 *
 * Proves, against the real CLI with a temp HOME:
 * 1. `tamandua status` text output includes a 'Daemon Lifecycle' section with
 *    'No recorded daemon deaths.' when lifecycle.log has no death entries
 * 2. A clean death renders 'Last daemon exit: clean at <ts> (pid <pid>,
 *    signal <signal>)'
 * 3. A fresh unclean death renders 'UNCLEAN [UNSEEN]' on the first text run
 *    and drops '[UNSEEN]' on the next run (rendering acknowledges by writing
 *    lifecycle-seen.json)
 * 4. `tamandua status --json` includes the daemonLifecycle key with a
 *    lastDaemonDeath object (or null) and does NOT acknowledge (never writes
 *    lifecycle-seen.json)
 *
 * Serial lane: spawns the CLI via node:child_process (listed in
 * tests/serial-files.txt).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanChildEnv, createTempHome } from "./helpers/test-env.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_SCRIPT = path.resolve(__dirname, "..", "dist", "cli", "cli.js");

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runCli(args: string[], homeDir: string, stateDir: string): Promise<CliResult> {
  return new Promise<CliResult>((resolve) => {
    let stdout = "";
    let stderr = "";

    const child = spawn("node", ["--no-warnings", CLI_SCRIPT, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanChildEnv({
        HOME: homeDir,
        TAMANDUA_STATE_DIR: stateDir,
      }),
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.once("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
  });
}

function cleanStderr(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter((line) => {
      if (line.includes("ExperimentalWarning") && line.includes("SQLite")) return false;
      if (line.includes("node --trace-warnings")) return false;
      return true;
    })
    .join("\n")
    .trim();
}

function appendJournalEntry(homeDir: string, entry: Record<string, unknown>): void {
  const log = path.join(homeDir, ".tamandua", "lifecycle.log");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.appendFileSync(log, JSON.stringify(entry) + "\n", "utf-8");
}

function seedCleanDeath(homeDir: string, ts: string, pid: number, signal = "SIGTERM"): void {
  appendJournalEntry(homeDir, {
    ts,
    action: "daemon.shutdown",
    targetPid: pid,
    signal,
    exitCode: 0,
  });
}

function seedUncleanDeath(homeDir: string, ts: string, pid: number): void {
  appendJournalEntry(homeDir, {
    ts,
    action: "daemon.uncleanExit",
    targetPid: pid,
    priorPid: pid,
    startedAt: new Date(Date.parse(ts) - 60_000).toISOString(),
    lastHeartbeatAt: new Date(Date.parse(ts) - 5000).toISOString(),
    lastHeartbeatAgeMs: 5000,
  });
}

const seenFilePath = (homeDir: string) =>
  path.join(homeDir, ".tamandua", "lifecycle-seen.json");

/**
 * Point the MCP / control-plane port files at unlikely ports so the async
 * status probes fail fast instead of touching any service on the default
 * ports (3338/3339).
 */
function isolateServicePorts(homeDir: string): void {
  const tamanduaDir = path.join(homeDir, ".tamandua");
  fs.mkdirSync(tamanduaDir, { recursive: true });
  fs.writeFileSync(path.join(tamanduaDir, "mcp-port"), "13338", "utf-8");
  fs.writeFileSync(path.join(tamanduaDir, "control-plane-port"), "13339", "utf-8");
}

describe("tamandua status daemon-lifecycle surfacing", () => {
  it("text output includes the Daemon Lifecycle section with 'No recorded daemon deaths.' when no death exists", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-status-dl-");
    isolateServicePorts(homeDir);
    const { stdout, stderr } = await runCli(["status"], homeDir, tamanduaDir);
    assert.equal(cleanStderr(stderr), "", `unexpected stderr: ${cleanStderr(stderr)}`);
    assert.match(stdout, /Daemon Lifecycle/);
    assert.match(stdout, /No recorded daemon deaths\./);
    assert.ok(!fs.existsSync(seenFilePath(homeDir)), "no death must not write lifecycle-seen.json");
  });

  it("text output renders a clean death with kind, ts, pid, and signal", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-status-dl-");
    isolateServicePorts(homeDir);
    const ts = new Date(Date.now() - 60_000).toISOString();
    seedCleanDeath(homeDir, ts, 4242, "SIGINT");

    const { stdout } = await runCli(["status"], homeDir, tamanduaDir);
    assert.match(stdout, /Daemon Lifecycle/);
    assert.ok(
      stdout.includes(`Last daemon exit: clean at ${ts} (pid 4242, signal SIGINT)`),
      `expected clean-death line in:\n${stdout}`,
    );
  });

  it("text output flags a fresh unclean death as [UNSEEN] and acknowledges on the next run", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-status-dl-");
    isolateServicePorts(homeDir);
    const ts = new Date(Date.now() - 30_000).toISOString();
    seedUncleanDeath(homeDir, ts, 5150);

    const first = await runCli(["status"], homeDir, tamanduaDir);
    assert.match(first.stdout, /Daemon Lifecycle/);
    assert.ok(
      first.stdout.includes(`Last daemon exit: UNCLEAN [UNSEEN] at ${ts} (prior pid 5150, last heartbeat 5s ago)`),
      `expected unseen unclean-death line in:\n${first.stdout}`,
    );

    // Rendering the text section acknowledges: lifecycle-seen.json now holds the death ts.
    assert.ok(fs.existsSync(seenFilePath(homeDir)), "rendering an unseen unclean death must acknowledge");
    const seen = JSON.parse(fs.readFileSync(seenFilePath(homeDir), "utf-8")) as { ts: string };
    assert.equal(seen.ts, ts, "acknowledged ts must equal the surfaced death ts");

    const second = await runCli(["status"], homeDir, tamanduaDir);
    assert.ok(
      !second.stdout.includes("[UNSEEN]"),
      "second status run must show the unclean death as seen",
    );
    assert.ok(
      second.stdout.includes(`Last daemon exit: UNCLEAN at ${ts} (prior pid 5150, last heartbeat 5s ago)`),
      "seen unclean-death line must keep kind/ts/pid/age",
    );
  });

  it("--json includes the daemonLifecycle key and does NOT acknowledge", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-status-dl-");
    isolateServicePorts(homeDir);
    const ts = new Date(Date.now() - 30_000).toISOString();
    seedUncleanDeath(homeDir, ts, 5150);

    const { stdout, stderr } = await runCli(["status", "--json"], homeDir, tamanduaDir);
    assert.equal(cleanStderr(stderr), "", `unexpected stderr: ${cleanStderr(stderr)}`);

    const parsed = JSON.parse(stdout) as {
      daemonLifecycle: {
        lastDaemonDeath: {
          kind: string;
          ts: string;
          pid: number;
          priorPid?: number;
          lastHeartbeatAgeMs?: number;
          unseen: boolean;
        } | null;
      };
    };
    assert.ok(parsed.daemonLifecycle, "--json must include the daemonLifecycle key");
    assert.ok(parsed.daemonLifecycle.lastDaemonDeath, "a seeded unclean death must be returned");
    assert.equal(parsed.daemonLifecycle.lastDaemonDeath!.kind, "unclean");
    assert.equal(parsed.daemonLifecycle.lastDaemonDeath!.ts, ts);
    assert.equal(parsed.daemonLifecycle.lastDaemonDeath!.pid, 5150);
    assert.equal(parsed.daemonLifecycle.lastDaemonDeath!.priorPid, 5150);
    assert.equal(parsed.daemonLifecycle.lastDaemonDeath!.lastHeartbeatAgeMs, 5000);
    assert.equal(parsed.daemonLifecycle.lastDaemonDeath!.unseen, true);

    assert.ok(
      !fs.existsSync(seenFilePath(homeDir)),
      "--json must NOT acknowledge (must not write lifecycle-seen.json)",
    );
  });

  it("--json returns daemonLifecycle.lastDaemonDeath null when no death exists", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-status-dl-");
    isolateServicePorts(homeDir);
    const { stdout } = await runCli(["status", "--json"], homeDir, tamanduaDir);
    const parsed = JSON.parse(stdout) as { daemonLifecycle: { lastDaemonDeath: unknown } };
    assert.ok(parsed.daemonLifecycle, "--json must include the daemonLifecycle key");
    assert.equal(parsed.daemonLifecycle.lastDaemonDeath, null);
  });

  it("--json purity: daemonLifecycle rides in the same single JSON object", async () => {
    const { homeDir, tamanduaDir } = createTempHome("tamandua-status-dl-");
    isolateServicePorts(homeDir);
    const { stdout, stderr } = await runCli(["status", "--json"], homeDir, tamanduaDir);
    assert.equal(cleanStderr(stderr), "", `unexpected stderr: ${cleanStderr(stderr)}`);
    const trimmed = stdout.trim();
    assert.ok(trimmed.startsWith("{") && trimmed.endsWith("}"), "stdout must be a single JSON object");
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    assert.ok("services" in parsed, "existing services key must remain");
    assert.ok("info" in parsed, "existing info key must remain");
    assert.ok("runs" in parsed, "existing runs key must remain");
    assert.ok("processes" in parsed, "existing processes key must remain");
    assert.ok("daemonLifecycle" in parsed, "daemonLifecycle key must be present");
  });
});
