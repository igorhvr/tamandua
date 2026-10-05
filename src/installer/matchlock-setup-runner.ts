/**
 * Spawn-capable production wiring for `tamandua matchlock setup` (MTLK-SETUP).
 *
 * The pure installer core (`matchlock-setup.ts`) deliberately never imports
 * `node:child_process`; this module supplies the real seams it needs:
 *
 *   - a `RunCommand` built on `child_process.spawn` (argv-array spawns only,
 *     never a shell string; `pipe`/`inherit` stdio; bounded timeouts);
 *   - filesystem probes and mutations (`node:fs`);
 *   - platform/arch, the process environment and the effective uid;
 *   - an account-database home resolver (`/etc/passwd`) used by the R12
 *     forced-root path instead of an inherited HOME;
 *   - a READ-ONLY, network-free probe of the local matchlock image store
 *     (`<store>/metadata.db`, matchlock's `images(scope, tag, digest, ...)`
 *     table) that reports a `local` shadow ahead of the `registry` cache.
 *
 * `createDefaultMatchlockSetupDeps()` is the single factory the CLI uses;
 * every field can be overridden so tests can inject fakes.
 *
 * Spec: matchlock-setup-command-proposal.md
 * (sha256 b9c908be8c52b0adce1aacff4fa3dd4a1ec924b8e86bc45566ed0b0ab4f3d8ea).
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

import {
  type MatchlockSetupDeps,
  type MatchlockSetupFs,
  type MaybePromise,
  type RunCommand,
  type RunCommandResult,
  type SetupOutput,
  type StoredImageEntry,
  type StoredImageSource,
} from "./matchlock-setup.js";
import { resolveSourcePath } from "./paths.js";

/** Exit code reported when a bounded child exceeds its timeout (GNU `timeout`). */
export const SPAWN_TIMEOUT_EXIT_CODE = 124;

/** Name of the account database consulted for the forced-root home (R12). */
export const ACCOUNT_DATABASE_PATH = "/etc/passwd";

/**
 * Drops `undefined` values from an environment map before handing it to
 * `spawn` (Node would otherwise interpolate them as the literal "undefined").
 */
function definedEnv(
  env: Record<string, string | undefined> | undefined,
): NodeJS.ProcessEnv | undefined {
  if (env === undefined) return undefined;
  const cleaned: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") cleaned[key] = value;
  }
  return cleaned;
}

/**
 * Builds the production `RunCommand`: one argv-array `spawn` per invocation.
 *
 * Contract (matching the pure core's `RunCommand`): the returned promise
 * rejects ONLY when the binary cannot be spawned at all (ENOENT/EACCES); any
 * non-zero exit code — including the timeout kill — resolves normally so the
 * caller can render a typed phase failure.
 */
export function createSpawnRunCommand(): RunCommand {
  return (command, args, options = {}) =>
    new Promise<RunCommandResult>((resolve, reject) => {
      const inherit = options.stdio === "inherit";

      let child: ChildProcess;
      try {
        child = spawn(command, args, {
          ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
          ...(options.env !== undefined ? { env: definedEnv(options.env) } : {}),
          stdio: inherit ? "inherit" : "pipe",
        });
      } catch (error) {
        reject(error);
        return;
      }

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const finish = (result: RunCommandResult): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve(result);
      };

      if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return;
          timedOut = true;
          try {
            child.kill("SIGKILL");
          } catch {
            /* the child already exited */
          }
        }, options.timeoutMs);
        timer.unref?.();
      }

      if (!inherit) {
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr?.on("data", (chunk: string) => {
          stderr += chunk;
        });
      }

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        reject(error);
      });

      child.on("close", (code, signal) => {
        if (timedOut) {
          const note =
            `command timed out after ${options.timeoutMs} ms: ` +
            `${command} ${args.join(" ")}`;
          finish({
            code: SPAWN_TIMEOUT_EXIT_CODE,
            stdout,
            stderr: stderr === "" ? note : `${stderr}\n${note}`,
          });
          return;
        }
        finish({ code: code ?? (signal !== null ? 1 : 0), stdout, stderr });
      });

      if (!inherit) {
        if (options.input !== undefined) child.stdin?.write(options.input);
        child.stdin?.end();
      }
    });
}

/** Production filesystem seam (`node:fs`, synchronous). */
export function createDefaultMatchlockSetupFs(): MatchlockSetupFs {
  return {
    exists: (path) => fs.existsSync(path),
    isFile: (path) => {
      try {
        return fs.statSync(path).isFile();
      } catch {
        return false;
      }
    },
    isExecutable: (path) => {
      try {
        if (!fs.statSync(path).isFile()) return false;
        fs.accessSync(path, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    isWritableDir: (path) => {
      try {
        if (!fs.statSync(path).isDirectory()) return false;
        fs.accessSync(path, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    readTextFile: (path) => fs.readFileSync(path, "utf8"),
    writeFile: (path, contents) => {
      fs.writeFileSync(path, contents);
    },
    copyFile: (from, to) => {
      fs.copyFileSync(from, to);
    },
    rename: (from, to) => {
      fs.renameSync(from, to);
    },
    remove: (path) => {
      fs.rmSync(path, { force: true });
    },
    mkdirp: (path) => {
      fs.mkdirSync(path, { recursive: true });
    },
    realpath: (path) => fs.realpathSync(path),
    readDir: (path) => fs.readdirSync(path),
    freeSpaceBytes: (path) => {
      const stats = fs.statfsSync(path);
      return Number(stats.bavail) * Number(stats.bsize);
    },
  };
}

/**
 * Resolves an account's home directory from the account database. Returns
 * `undefined` for an unknown account or an unreadable database; the pure
 * core turns that into a typed refusal under forced-root mode (R12).
 */
export function defaultAccountHomeResolver(account: string): string | undefined {
  if (typeof account !== "string" || account === "") return undefined;
  try {
    const contents = fs.readFileSync(ACCOUNT_DATABASE_PATH, "utf8");
    for (const line of contents.split("\n")) {
      if (line === "" || line.startsWith("#")) continue;
      const fields = line.split(":");
      if (fields[0] !== account) continue;
      const home = fields[5];
      return home !== undefined && home !== "" ? home : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Effective image-store directory for the environment's HOME (N4). */
function resolveImageStore(env: Record<string, string | undefined>): string {
  const home = env.HOME?.trim() || os.homedir();
  return join(home, ".cache", "matchlock", "images");
}

const STORED_IMAGE_QUERY =
  "SELECT scope, digest FROM images " +
  "WHERE tag = ? AND digest IS NOT NULL AND digest <> '' " +
  "ORDER BY CASE scope WHEN 'local' THEN 0 WHEN 'registry' THEN 1 ELSE 2 END " +
  "LIMIT 1";

/**
 * Read-only, network-free resolution of a reference in matchlock's local image
 * store. A `local` built/imported entry is the accepted shadow override and
 * takes precedence over the `registry` cache copy; a missing database, a
 * missing reference or any read error is reported as a store miss so the image
 * pull proceeds.
 */
export async function readStoredMatchlockImage(
  imageStore: string,
  reference: string,
): Promise<StoredImageEntry | undefined> {
  const databasePath = join(imageStore, "metadata.db");
  if (!fs.existsSync(databasePath)) return undefined;

  let database: { close(): void } | undefined;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const opened = new DatabaseSync(databasePath, { readOnly: true });
    database = opened;
    const row = opened.prepare(STORED_IMAGE_QUERY).get(reference);
    if (row === undefined) return undefined;
    const scope = row.scope;
    const digest = row.digest;
    if (typeof digest !== "string" || digest === "") return undefined;
    if (scope !== "local" && scope !== "registry") return undefined;
    return { digest, source: scope as StoredImageSource };
  } catch {
    return undefined;
  } finally {
    try {
      database?.close();
    } catch {
      /* ignore close errors on a read-only handle */
    }
  }
}

/** Default output seam: progress on stdout, warnings/refusals on stderr. */
const DEFAULT_OUTPUT: SetupOutput = {
  log: (message) => {
    process.stdout.write(`${message}\n`);
  },
  warn: (message) => {
    process.stderr.write(`${message}\n`);
  },
};

/** Optional overrides for {@link createDefaultMatchlockSetupDeps}. */
export interface DefaultMatchlockSetupDepsOverrides {
  runCommand?: RunCommand;
  fs?: MatchlockSetupFs;
  resolveStoredImage?: (reference: string) => MaybePromise<StoredImageEntry | undefined>;
  platform?: string;
  arch?: string;
  sourcePath?: string;
  env?: Record<string, string | undefined>;
  euid?: number;
  accountHomeResolver?: (account: string) => string | undefined;
  output?: SetupOutput;
}

/**
 * Builds the production `MatchlockSetupDeps` binding the pure core to this
 * host. Every seam can be overridden (tests inject fakes; the CLI uses the
 * defaults).
 */
export function createDefaultMatchlockSetupDeps(
  overrides: DefaultMatchlockSetupDepsOverrides = {},
): MatchlockSetupDeps {
  const env = overrides.env ?? process.env;
  return {
    runCommand: overrides.runCommand ?? createSpawnRunCommand(),
    fs: overrides.fs ?? createDefaultMatchlockSetupFs(),
    resolveStoredImage:
      overrides.resolveStoredImage ??
      ((reference: string) => readStoredMatchlockImage(resolveImageStore(env), reference)),
    platform: overrides.platform ?? process.platform,
    arch: overrides.arch ?? process.arch,
    sourcePath: overrides.sourcePath ?? resolveSourcePath(),
    env,
    euid: overrides.euid ?? (typeof process.geteuid === "function" ? process.geteuid() : 0),
    accountHomeResolver: overrides.accountHomeResolver ?? defaultAccountHomeResolver,
    output: overrides.output ?? DEFAULT_OUTPUT,
  };
}
