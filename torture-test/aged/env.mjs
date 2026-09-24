// env.mjs — containment environment + subprocess phase launcher for the
// tt-storm-aged zero-token aged-state generator.
//
// Every mutating phase runs as a private subprocess whose environment is:
//   - HOME / TAMANDUA_STATE_DIR / TAMANDUA_DB_PATH / TMPDIR all inside the
//     owned seed root (never operator HOME / default state),
//   - TAMANDUA_WORKTREE_ROOT inside the owned root,
//   - TAMANDUA_TEST_GUARD=1 (isolation guard on),
//   - TAMANDUA_CONTROL_PORT + daemon-secret in the private state (the
//     non-dispatching transport double listens on that port),
//   - parent run/reporting authority stripped, provider/auth config
//     removed, secret-bearing variables removed (fail closed).
//
// No phase process may fall back to an operator HOME/default state: the env
// builder throws if a required private variable cannot be set.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { utcNow, writeExclusive } from "./seedcommon.mjs";

// Env vars inherited from a parent tamandua worker round that would grant
// run/reporting authority or influence dispatch; always stripped.
export const PARENT_AUTHORITY_STRIP = [
  "TAMANDUA_RUN_ID",
  "TAMANDUA_WORKER_PID",
  "TAMANDUA_DB_PATH",
  "TAMANDUA_STATE_DIR",
  "TAMANDUA_CONTROL_PORT",
  "TAMANDUA_WORKTREE_ROOT",
  "TAMANDUA_MAX_ACTIVE_TIMERS",
  "TAMANDUA_PI_BINARY",
  "TAMANDUA_HARNESS",
  "TAMANDUA_INSTANT_FAIL_BACKOFF_K",
  "TAMANDUA_INSTANT_FAIL_ESCALATION_N",
  "TAMANDUA_TEST_GUARD_LEDGER",
  "TAMANDUA_DEBUG_EVENTS",
  "TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR",
  "PI_SETTINGS_PATH",
  "PI_AUTH_PATH",
  "HERMES_HOME",
];

// Secret-bearing / provider variables that must never reach a phase process.
export const SECRET_STRIP = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "TAMANDUA_DAEMON_SECRET",
  "PI_API_KEY",
];

export function reserveRandomPort() {
  const srv = net.createServer();
  return new Promise((resolve, reject) => {
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

export function buildPhaseEnv({ root, paths }) {
  if (!root || !path.isAbsolute(root)) {
    throw new Error("buildPhaseEnv: owned root must be an absolute path");
  }
  const env = {};

  // Start from a copy of process.env minus stripped vars.
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (PARENT_AUTHORITY_STRIP.includes(k)) continue;
    if (SECRET_STRIP.includes(k)) continue;
    env[k] = v;
  }

  // Private locations (all under the owned root).
  env.HOME = paths.homeDir;
  env.TAMANDUA_STATE_DIR = paths.stateDir;
  env.TAMANDUA_DB_PATH = path.join(paths.stateDir, "tamandua.db");
  env.TAMANDUA_WORKTREE_ROOT = paths.worktreesRoot;
  env.TMPDIR = paths.tmpDir;
  env.TAMANDUA_TEST_GUARD = "1";

  // Optional owned-home override.  `writeNeutralPiConfig` refuses to write a
  // neutral pi config under the operator's real home prefix, so a caller whose
  // owned seed root cannot host the private HOME (e.g. an owned copy under the
  // gate worktree, itself under the real home) may point the private HOME at a
  // separate scratch dir.  Opt-in and fail-closed: the override must live
  // OUTSIDE the real home and the real ~/.tamandua state.
  const homeOverride = process.env.TAMANDUA_AGED_HOME_DIR?.trim();
  if (homeOverride) {
    const resolved = path.resolve(homeOverride);
    let realHome = null;
    try {
      realHome = os.userInfo().homedir || null;
    } catch {
      realHome = null;
    }
    if (!realHome) {
      throw new Error("buildPhaseEnv: cannot resolve the real home for the TAMANDUA_AGED_HOME_DIR check");
    }
    const realState = path.join(realHome, ".tamandua");
    if (resolved === realHome || resolved.startsWith(realHome + path.sep)) {
      throw new Error(`buildPhaseEnv: refusing TAMANDUA_AGED_HOME_DIR under the real home ${realHome}`);
    }
    if (resolved === realState || resolved.startsWith(realState + path.sep)) {
      throw new Error(`buildPhaseEnv: refusing TAMANDUA_AGED_HOME_DIR under the real state dir ${realState}`);
    }
    env.HOME = resolved;
  }

  // Ensure private dirs exist.
  for (const dir of [env.HOME, paths.stateDir, paths.tmpDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Neutral pi settings/auth in the private HOME so real product install and
  // workflow-loading code paths can read a config without any real provider
  // credentials being copied.  These carry NO provider/api keys.  Use env.HOME
  // (which may be the validated TAMANDUA_AGED_HOME_DIR override), never the
  // owned-root path directly.
  writeNeutralPiConfig(env.HOME);

  // A per-phase random control port; the child binds its non-dispatching
  // transport double here (never a production port).
  return env;
}

// Write an explicitly credential-free pi settings/auth pair under a private
// HOME (real product installs read ~/.pi/agent/settings.json and throw when
// missing).  Fail closed: refuses to run when the private HOME path is the
// real user home or the real ~/.tamandua state dir.
export function writeNeutralPiConfig(homeDir) {
  const realHome = (() => {
    try {
      const osMod = os.userInfo().homedir || null;
      return osMod;
    } catch {
      return null;
    }
  })();
  if (realHome && (homeDir === realHome || homeDir.startsWith(realHome + path.sep))) {
    throw new Error(`writeNeutralPiConfig: refusing to write into real home ${realHome}`);
  }
  const agentDir = path.join(homeDir, ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const settingsFile = path.join(agentDir, "settings.json");
  const authFile = path.join(agentDir, "auth.json");
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({ defaultProvider: null, defaultModel: null }, null, 2) + "\n", "utf-8");
  }
  if (!fs.existsSync(authFile)) {
    fs.writeFileSync(authFile, "{}\n", "utf-8");
  }
  return { settingsFile, authFile };
}

export function spawnPhase({
  nodeBinary = process.execPath,
  entry,
  args,
  env,
  journal,
  label,
  timeoutMs = 0,
}) {
  const startedAt = new Date().toISOString();
  journal({ intent: `phase:${label}`, argv: [entry, ...args], startedAt });
  return new Promise((resolve) => {
    const child = spawn(nodeBinary, [entry, ...args], {
      env,
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = timeoutMs > 0
      ? setTimeout(() => child.kill("SIGKILL"), timeoutMs)
      : null;
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      journal({ phase: label, outcome: "spawn-error", error: String(err), finishedAt: new Date().toISOString() });
      resolve({ ok: false, status: -1, stdout, stderr, error: String(err) });
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      journal({
        phase: label,
        outcome: code === 0 ? "ok" : "fail",
        exitCode: code,
        signal: signal ?? null,
        finishedAt: new Date().toISOString(),
        stdoutTail: stdout.slice(-4000),
        stderrTail: stderr.slice(-4000),
      });
      resolve({ ok: code === 0, status: code, stdout, stderr, signal });
    });
  });
}

export function writeDaemonSecret(homeDir) {
  // Product path resolution (DPID state-dir scoping):
  // defaultDaemonSecretFile() = path.join(resolveStateDir(), "daemon-secret"),
  // i.e. the EFFECTIVE TAMANDUA_STATE_DIR — NOT $HOME/.tamandua.  Writing only
  // the HOME copy left the product's readDaemonSecret() returning null, so the
  // non-dispatching transport double rejected every register-run with 401
  // (observed in the schema-14 full seed: zero of 5000 runs created).  The
  // state-dir secret is authoritative; it is mirrored to HOME for older/other
  // consumers, never clobbering a non-empty existing file.
  const stateDir = process.env.TAMANDUA_STATE_DIR?.trim()
    ? path.resolve(process.env.TAMANDUA_STATE_DIR)
    : path.join(homeDir, ".tamandua");
  const secretPath = path.join(stateDir, "daemon-secret");
  fs.mkdirSync(stateDir, { recursive: true });

  let secret = null;
  try {
    const existing = fs.readFileSync(secretPath, "utf-8").trim();
    if (existing.length > 0) secret = existing;
  } catch {
    /* absent */
  }
  let created = false;
  if (secret === null) {
    const candidate = `aged-seed-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    created = writeExclusive(secretPath, candidate + "\n").created;
    // First-write-wins race: re-read the authoritative value either way.
    try {
      secret = fs.readFileSync(secretPath, "utf-8").trim() || candidate;
    } catch {
      secret = candidate;
    }
  }

  // Legacy HOME mirror (never clobber a non-empty existing file).
  const homeSecretPath = path.join(homeDir, ".tamandua", "daemon-secret");
  if (path.resolve(homeSecretPath) !== path.resolve(secretPath)) {
    let mirrorNeeded = true;
    try {
      if (fs.readFileSync(homeSecretPath, "utf-8").trim().length > 0) mirrorNeeded = false;
    } catch {
      /* absent */
    }
    if (mirrorNeeded) {
      fs.mkdirSync(path.dirname(homeSecretPath), { recursive: true });
      fs.writeFileSync(homeSecretPath, secret + "\n", "utf-8");
    }
  }
  return { secretPath, secret, created };
}
