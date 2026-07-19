/**
 * Shared helpers for smoke/state-machine e2e tests.
 *
 * These helpers support the fast smoke test (manual step claim/complete with
 * canned outputs, no real agents or models). They are also reusable by the
 * slow real e2e test where applicable (e.g. createTempHome, baseEnv, cli).
 */

import assert from "node:assert/strict";
import {
  cleanChildEnv,
  reservePortHandles,
  type PortHandle,
} from "../../tests/helpers/test-env.ts";
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tamanduaTempDir, tamanduaTempRoot } from "../../src/lib/temp-dir.ts";
import { openE2eDatabase } from "./e2e-database.mjs";

const repoRoot = process.cwd();
const cliPath = path.resolve(repoRoot, "dist", "cli", "cli.js");

// Module-level registry for process-exit cleanup of temp homes.
// Follows the same pattern as tests/helpers/test-env.ts so aborted
// e2e runs stop leaking /tmp directories.
const _cleanupDirs = new Set<string>();
let _cleanupRegistered = false;
const _releasedPortHandles = new WeakSet<object>();

function _registerProcessCleanup() {
  if (_cleanupRegistered) return;
  _cleanupRegistered = true;

  const cleanup = () => {
    for (const dir of _cleanupDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    _cleanupDirs.clear();
  };

  // clean exit (process.exit, normal termination)
  process.on("exit", cleanup);

  // kill signals — Node won't run 'exit' for these, so we handle them explicitly
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      cleanup();
      process.exit(1);
    });
  }
}

export interface CreateTempHomeOptions {
  /**
   * When true, symlink the real ~/.pi and ~/.hermes directories into the
   * isolated test HOME so the test environment reuses working auth
   * configuration. Required by real-token e2e tiers that need live provider
   * credentials.
   *
   * When false (default), create an empty stub ~/.pi directory instead.
   * Zero-token tiers (smoke, scripted) don't need real auth and can run on
   * machines without configured pi auth.
   */
  linkRealAgentDirs?: boolean;
}

export async function createTempHome(options?: CreateTempHomeOptions) {
  _registerProcessCleanup();

  const linkRealAgentDirs = options?.linkRealAgentDirs ?? false;

  const portHandles = await reservePortHandles(2);
  const [controlPort, dashboardPort] = portHandles.map((h) => h.port);
  const root = tamanduaTempDir("tamandua-e2e-workflows-");
  _cleanupDirs.add(root);

  const homeDir = path.join(root, "home");
  const tamanduaDir = path.join(homeDir, ".tamandua");
  fs.mkdirSync(tamanduaDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(
    path.join(tamanduaDir, "port"),
    String(dashboardPort),
    "utf-8",
  );

  if (linkRealAgentDirs) {
    // Symlink the real developer ~/.pi so the isolated test environment
    // reuses the working pi auth configuration (provider, API key, model).
    // This avoids the auth isolation mismatch where a synthesized
    // settings.json points at providers.openai.apiKey but pi --print
    // cannot resolve it (especially when cleanChildEnv strips env-based
    // auth like OPENAI_API_KEY).
    const realPiDir = path.join(os.homedir(), ".pi");
    const isolatedPiLink = path.join(homeDir, ".pi");
    assert.ok(
      fs.existsSync(realPiDir),
      `Real ~/.pi directory must exist at ${realPiDir} for e2e tests to reuse pi auth configuration.`,
    );
    fs.symlinkSync(realPiDir, isolatedPiLink, "dir");

    // Also symlink real ~/.hermes for hermes-based e2e tests (e.g., hermes
    // canary). Hermes reads its credentials and config from ~/.hermes, the
    // same isolation pattern as ~/.pi above. Skip silently if ~/.hermes
    // doesn't exist (most dev machines won't have hermes installed).
    const realHermesDir = path.join(os.homedir(), ".hermes");
    const isolatedHermesLink = path.join(homeDir, ".hermes");
    if (fs.existsSync(realHermesDir)) {
      fs.symlinkSync(realHermesDir, isolatedHermesLink, "dir");
    }
  } else {
    // Zero-token tiers: create a stub ~/.pi directory with a minimal
    // settings.json so harness spawns and workflow install don't fail
    // on missing config. Scripted/smoke agents use canned outputs, so
    // the stub config content doesn't matter — it just needs to exist.
    const stubPiAgentDir = path.join(homeDir, ".pi", "agent");
    fs.mkdirSync(stubPiAgentDir, { recursive: true });
    fs.writeFileSync(
      path.join(stubPiAgentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "stub", defaultModel: "stub" }),
      "utf-8",
    );
  }

  return { root, homeDir, tamanduaDir, controlPort, dashboardPort, portHandles };
}

/** Release reserved ports immediately before handing them to a daemon bind. */
export async function releasePortReservations(env: {
  portHandles?: Array<{ close(): Promise<void> }>;
}): Promise<void> {
  const handlesToClose = (env.portHandles ?? []).filter((handle) => {
    if (_releasedPortHandles.has(handle)) return false;
    _releasedPortHandles.add(handle);
    return true;
  });
  await Promise.all(handlesToClose.map((handle) => handle.close()));
}

export function inheritedProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.NODE_TEST_CONTEXT;
  return env;
}

export function baseEnv(homeDir: string, controlPort: number) {
  const tamanduaDir = path.join(homeDir, ".tamandua");
  return {
    ...inheritedProcessEnv(),
    HOME: homeDir,
    TAMANDUA_CONTROL_PORT: String(controlPort),
    TAMANDUA_STATE_DIR: tamanduaDir,
    TAMANDUA_DB_PATH: path.join(tamanduaDir, "tamandua.db"),
    TAMANDUA_WORKTREE_ROOT: path.join(tamanduaDir, "worktrees"),
  };
}

export function cli(args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    env: cleanChildEnv(env),
    encoding: "utf-8",
  });
}

export function cliMustSucceed(
  args: string[],
  env: Record<string, string>,
  label: string,
) {
  const r = cli(args, env);
  assert.equal(
    r.status,
    0,
    `${label} failed (exit ${r.status}): ${r.stderr || r.stdout}`,
  );
  return r.stdout;
}

export function stepClaim(
  agentId: string,
  runId: string,
  env: Record<string, string>,
) {
  const r = cli(["step", "claim", agentId, "--run-id", runId], env);
  assert.equal(
    r.status,
    0,
    `step claim ${agentId} failed: ${r.stderr || r.stdout}`,
  );
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(parsed.stepId, `no stepId in claim response: ${r.stdout}`);
  return parsed as { stepId: string; runId: string; input: string };
}

export function stepComplete(
  stepId: string,
  output: string,
  env: Record<string, string>,
) {
  const r = spawnSync(process.execPath, [cliPath, "step", "complete", stepId], {
    env: cleanChildEnv(env),
    input: output,
    encoding: "utf-8",
  });
  assert.equal(
    r.status,
    0,
    `step complete ${stepId} failed: ${r.stderr || r.stdout}`,
  );
  return JSON.parse(r.stdout.trim()) as { status: string };
}

/**
 * Spawn `tamandua workflow run` and capture the 8-char run-ID prefix from stdout.
 * Kills the child process once the output is captured.
 */
export function spawnWorkflowRun(
  args: string[],
  env: Record<string, string>,
  timeoutMs = 30_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: cleanChildEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;

    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill("SIGKILL");
      reject(
        new Error(
          `Timeout waiting for workflow run output. stdout: ${stdout}, stderr: ${stderr}`,
        ),
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = stdout.match(/^Run:\s+(?:run-)?([0-9a-f]{8,})/im);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        child.kill("SIGTERM");
        resolve(match[1]);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      reject(err);
    });

    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      const match = stdout.match(/^Run:\s+(?:run-)?([0-9a-f]{8,})/im);
      if (match) {
        resolve(match[1]);
      } else {
        reject(
          new Error(
            `Workflow run failed (exit ${code}). stdout: ${stdout}, stderr: ${stderr}`,
          ),
        );
      }
    });
  });
}

/** Prepare a clean git repo from the sample project fixture */
export function prepareGitRepo(fixtureDir: string, targetDir: string) {
  fs.mkdirSync(targetDir, { recursive: true });
  const cpResult = spawnSync("cp", ["-r", `${fixtureDir}/.`, `${targetDir}/`], {
    encoding: "utf-8",
  });
  assert.equal(cpResult.status, 0, `cp failed: ${cpResult.stderr}`);

  function git(args: string[]) {
    const r = spawnSync("git", args, { cwd: targetDir, encoding: "utf-8" });
    assert.equal(
      r.status,
      0,
      `git ${args.join(" ")} failed: ${r.stderr || r.stdout}`,
    );
    return r.stdout.trim();
  }

  git(["init"]);
  git(["config", "user.email", "test@tamandua.local"]);
  git(["config", "user.name", "Tamandua E2E Test"]);
  git(["add", "-A"]);
  git(["commit", "-m", "initial commit with sample project"]);
  return targetDir;
}

/**
 * Detach the origin checkout from its current branch so the fail-closed
 * merge policy (merge-branch refuses to write when the destination ref is
 * the checked-out HEAD) does not refuse the landing. Captures the pre-detach
 * tip and tree SHA for later assertions that the detached origin remained
 * unchanged.
 */
export function detachOriginCheckout(repoDir: string): { branch: string; tip: string; tree: string } {
  const { status: s1, stdout: branchOut, stderr: e1 } = spawnSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: repoDir, encoding: "utf-8" });
  assert.equal(s1, 0, `git symbolic-ref failed: ${e1}`);
  const branch = branchOut.trim();
  const { status: s2, stdout: tipOut, stderr: e2 } = spawnSync("git", ["rev-parse", `refs/heads/${branch}`], { cwd: repoDir, encoding: "utf-8" });
  assert.equal(s2, 0, `git rev-parse tip failed: ${e2}`);
  const tip = tipOut.trim();
  const { status: s3, stdout: treeOut, stderr: e3 } = spawnSync("git", ["rev-parse", `refs/heads/${branch}^{tree}`], { cwd: repoDir, encoding: "utf-8" });
  assert.equal(s3, 0, `git rev-parse tree failed: ${e3}`);
  const tree = treeOut.trim();
  const { status: s4, stderr: e4 } = spawnSync("git", ["checkout", "--detach", tip], { cwd: repoDir, encoding: "utf-8" });
  assert.equal(s4, 0, `git checkout --detach failed: ${e4}`);
  return { branch, tip, tree };
}

/** Resolve full run ID from the 8-char prefix using the temp home DB */
export function resolveFullRunId(prefix: string, tamanduaDir: string): string {
  const dbPath = path.join(tamanduaDir, "tamandua.db");
  const db = openE2eDatabase(dbPath);
  try {
    const rows = db
      .prepare("SELECT id FROM runs WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1")
      .all(`${prefix}%`) as Array<{ id: string }>;
    if (rows.length === 0) {
      throw new Error(`No run found matching prefix "${prefix}"`);
    }
    return rows[0].id;
  } finally {
    db.close();
  }
}

/**
 * Archive an isolated temp home directory to a preserved location when an e2e
 * test fails. Uses fs.cpSync for cross-platform copy (macOS + Linux).
 *
 * Archive path: <tamanduaTempRoot>/e2e-failures/<YYYY-MM-DDTHHmmss>-<sanitizedSlug>/
 *
 * Failure-proof: the entire function body is wrapped in try/catch. If archiving
 * or pruning throws, the error is logged to stderr and null is returned. This
 * function must never throw — a failed archive must not prevent test teardown
 * from completing.
 *
 * Pruning: keeps at most `maxArchives` (default 5) most recent archives sorted
 * by mtime. Older archives beyond the limit are removed.
 *
 * @returns the archive path on success, null on failure
 */
export function preserveE2eTestHome(
  rootDir: string,
  testSlug: string,
  maxArchives: number = 5,
): string | null {
  try {
    // Sanitize the slug: replace path-unsafe chars with hyphens
    const sanitizedSlug = testSlug.replace(/[\/\\:*?"<>|]/g, "-");

    // Build timestamp in YYYY-MM-DDTHHmmss format
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    const timestamp =
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
      `T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    const archivesDir = path.join(tamanduaTempRoot(), "e2e-failures");
    const archivePath = path.join(archivesDir, `${timestamp}-${sanitizedSlug}`);

    // Create parent dir (no-op if exists)
    fs.mkdirSync(archivesDir, { recursive: true });

    // Copy the temp home directory into the archive
    fs.cpSync(rootDir, archivePath, { recursive: true, force: true });

    // Prune oldest archives beyond the limit
    _pruneArchives(archivesDir, maxArchives);

    const msg = `[tamandua e2e] FAILURE FORENSICS PRESERVED: ${archivePath}`;
    console.error(msg);

    return archivePath;
  } catch (err) {
    console.error(
      `[tamandua e2e] Failed to preserve e2e test forensics: ${err}`,
    );
    return null;
  }
}

/** Internal: keep at most `max` most recent archive dirs in `archivesDir`. */
function _pruneArchives(archivesDir: string, max: number) {
  const entries = fs
    .readdirSync(archivesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({
      name: e.name,
      path: path.join(archivesDir, e.name),
      mtime: fs.statSync(path.join(archivesDir, e.name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime); // newest first

  for (let i = max; i < entries.length; i++) {
    fs.rmSync(entries[i].path, { recursive: true, force: true });
  }
}

export async function cleanupTempHome(
  env: { root: string; homeDir: string; controlPort: number; portHandles?: PortHandle[] },
) {
  try {
    cli(["dashboard", "stop"], baseEnv(env.homeDir, env.controlPort));
  } catch {
    // best-effort
  }
  // Release port handles before removing the temp directory. Handles may
  // already have been released at daemon handoff.
  await releasePortReservations(env).catch(() => {});
  try {
    fs.rmSync(env.root, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
