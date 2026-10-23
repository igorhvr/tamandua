/**
 * store-holder-detect RUNNER tests (G6 HOLDER-DETECTION US-005/US-006).
 *
 * These tests exercise `createDefaultHolderProbeDeps` in
 * src/installer/matchlock/store-holder-detect-runner.ts — the thin default
 * probe that enumerates holder candidates for the pure module. Every BRANCH is
 * driven through the injected `HolderRunnerSeams`, so no fake test needs a real
 * process, a real descriptor or a real `lsof` binary: a fake process table
 * answers `listPids`, the descriptor directory, the descriptor links, the
 * command line, the owner uid and the kernel start identity, and a canned
 * bounded-lsof result drives the darwin parser.
 *
 * Covered here: a same-user process holding a requested path becomes a
 * candidate with its RAW open-path spellings and a NUL-split argv; other-user
 * processes are out of scope; a vanished pid or a descriptor that closed
 * between the directory read and the readlink is skipped; `socket:`, `pipe:`
 * and `anon_inode:` targets are not paths; an unreadable descriptor directory,
 * an unresolvable descriptor and a null start identity all throw
 * `HolderProbeError` with the `pid:<pid>` scope AND the candidates observed so
 * far, so a partial observation still lists the real holders; other users'
 * processes are out of scope and are not failures; an unsupported platform and
 * a Linux host without procfs throw instead of reporting "no holders".
 *
 * Darwin coverage: one `-F pcn` bounded-lsof probe (never a second one, never
 * an empty whole-host scan), `p`/`c`/`n` parsing, command-only argv,
 * non-absolute and unknown records ignored, `lsof:timeout` and `lsof:probe`
 * failures throwing, and the one legitimate zero-candidate answer (status 1
 * with empty stderr). One END-TO-END case spawns a real child holding a real
 * temp store and proves the production seams detect it — that case is
 * Linux-only and is the reason this file's serial-lane classification is
 * pinned here (it imports a transitively spawn-capable runner and now spawns
 * one child itself, so it MUST be listed in tests/serial-files.txt — unlike
 * the pure module's parallel-lane test).
 *
 * The module under test is imported from dist/ (repo convention for this
 * directory), so `npm run build` must run first.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { tamanduaShortTempDir } from "../../../dist/lib/temp-dir.js";
import { procfsPidPath } from "../../../dist/lib/proc-info.js";
import { getProcessStartIdentity } from "../../../dist/lib/process-start-identity.js";
import type { LsofProbeResult } from "../../../dist/lib/lsof-probe.js";
import { detectStoreHolders, HolderProbeError } from "../../../dist/installer/matchlock/store-holder-detect.js";
import type { HolderStore } from "../../../dist/installer/matchlock/store-holder-detect.js";
import { createDefaultHolderProbeDeps } from "../../../dist/installer/matchlock/store-holder-detect-runner.js";
import type {
  HolderPathIdentity,
  HolderRunnerSeams,
} from "../../../dist/installer/matchlock/store-holder-detect-runner.js";
import { classifyTestFile } from "../../../tests/helpers/serial-classification.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const THIS_FILE = path.join(HERE, "store-holder-detect-runner.test.ts");
const PURE_MODULE_PATH = path.join(HERE, "store-holder-detect.ts");
const RUNNER_MODULE_PATH = path.join(HERE, "store-holder-detect-runner.ts");
const SERIAL_FILES_PATH = path.join(REPO_ROOT, "tests", "serial-files.txt");
const THIS_RELATIVE = path.relative(REPO_ROOT, THIS_FILE).split(path.sep).join("/");

const CURRENT_UID = typeof process.getuid === "function" ? process.getuid() : 1000;

const createdDirs: string[] = [];

let root: string;
let storePath: string;
let store: HolderStore;
let unrelatedPath: string;

function fixtureDir(prefix: string): string {
  const dir = tamanduaShortTempDir(prefix);
  createdDirs.push(dir);
  return dir;
}

function writeFixtureFile(filePath: string, bytes: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes);
}

function identityOf(filePath: string): HolderPathIdentity {
  const stat = fs.statSync(filePath, { bigint: true });
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}

// ---------------------------------------------------------------------------
// A fake process table behind the injected seams.
// ---------------------------------------------------------------------------

interface FakeProcess {
  pid: number;
  /** Owner uid; defaults to this process's effective uid. */
  uid?: number;
  /** argv, NUL-joined by the fake `cmdline` read. */
  argv?: string[];
  /** Raw readlink targets, including non-path entries such as socket:[1]. */
  openPaths?: string[];
  /** The pid vanishes before inspection (statUid/readDir raise ENOENT). */
  vanish?: boolean;
  /** The descriptor directory is unreadable (EACCES/EPERM). */
  fdDirError?: "EACCES" | "EPERM";
  /** Per-descriptor-entry readlink failures, keyed by the entry name. */
  fdLinkErrors?: Record<string, string>;
  /** Explicit kernel start identity; default is a synthetic v2 value. */
  startIdentity?: string | null;
  /** The command line cannot be read. */
  cmdlineUnreadable?: boolean;
}

interface FakeHost {
  seams: HolderRunnerSeams;
  readDirPaths: string[];
  readLinkPaths: string[];
  /** Every argv the fake bounded-lsof seam was invoked with. */
  lsofCalls: string[][];
}

function errnoError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/**
 * Split a procfs path into its pid and trailing segments WITHOUT spelling the
 * procfs root here (the portability lint reserves that literal for
 * src/lib/proc-info.ts): `procfsPidPath(pid)` is `[<root>, <pid>]`, so the pid
 * always sits at index 1.
 */
function parseProcfsPath(procPath: string): { pid: number; tail: string[] } {
  const segments = procPath.split("/").filter((segment) => segment.length > 0);
  return { pid: Number(segments[1]), tail: segments.slice(2) };
}

function fakeHost(
  processes: FakeProcess[],
  options: {
    platform?: NodeJS.Platform;
    procfs?: boolean;
    /** Canned bounded-lsof result; defaults to an empty successful probe. */
    lsofResult?: (args: readonly string[]) => LsofProbeResult;
  } = {},
): FakeHost {
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const readDirPaths: string[] = [];
  const readLinkPaths: string[] = [];
  const lsofCalls: string[][] = [];

  const seams: HolderRunnerSeams = {
    platform: options.platform ?? "linux",
    hasProcfs: () => options.procfs ?? true,
    listPids: () => processes.map((proc) => proc.pid),
    readDir: (dirPath: string) => {
      readDirPaths.push(dirPath);
      const { pid, tail } = parseProcfsPath(dirPath);
      const proc = byPid.get(pid);
      if (proc === undefined || proc.vanish) throw errnoError("ENOENT", "no such process");
      if (tail.length !== 1 || tail[0] !== "fd") throw errnoError("ENOENT", "unexpected directory");
      if (proc.fdDirError !== undefined) throw errnoError(proc.fdDirError, "permission denied");
      return (proc.openPaths ?? []).map((_target, index) => String(index + 3));
    },
    readLink: (linkPath: string) => {
      readLinkPaths.push(linkPath);
      const { pid, tail } = parseProcfsPath(linkPath);
      const proc = byPid.get(pid);
      if (proc === undefined || proc.vanish) throw errnoError("ENOENT", "no such process");
      if (tail.length !== 2 || tail[0] !== "fd") throw errnoError("ENOENT", "unexpected descriptor");
      const failure = proc.fdLinkErrors?.[tail[1]];
      if (failure !== undefined) throw errnoError(failure, "cannot resolve descriptor");
      const index = Number(tail[1]) - 3;
      const openPaths = proc.openPaths ?? [];
      if (!Number.isInteger(index) || index < 0 || index >= openPaths.length) {
        throw errnoError("ENOENT", "descriptor closed");
      }
      return openPaths[index];
    },
    readCmdline: (pid: number) => {
      const proc = byPid.get(pid);
      if (proc === undefined || proc.vanish) return null;
      if (proc.cmdlineUnreadable) return null;
      const argv = proc.argv ?? [];
      return argv.length === 0 ? "" : `${argv.join("\u0000")}\u0000`;
    },
    statUid: (procPath: string) => {
      const { pid, tail } = parseProcfsPath(procPath);
      const proc = byPid.get(pid);
      if (proc === undefined || proc.vanish) throw errnoError("ENOENT", "no such process");
      if (tail.length !== 0) throw errnoError("ENOENT", "unexpected path");
      return proc.uid ?? CURRENT_UID;
    },
    statIdentity: (candidatePath: string) => {
      try {
        const stat = fs.statSync(candidatePath, { bigint: true });
        return { dev: stat.dev.toString(), ino: stat.ino.toString() };
      } catch {
        return null;
      }
    },
    getStartIdentity: (pid: number) => {
      const proc = byPid.get(pid);
      if (proc === undefined || proc.vanish) return null;
      return proc.startIdentity === undefined ? `v2:${pid}:1700000000000` : proc.startIdentity;
    },
    runLsof: (args: readonly string[]) => {
      lsofCalls.push([...args]);
      const answer = options.lsofResult;
      return answer === undefined
        ? { kind: "ok", stdout: "", stderr: "", status: 0 }
        : answer(args);
    },
  };

  return { seams, readDirPaths, readLinkPaths, lsofCalls };
}

/** Run a probe and return the HolderProbeError it must raise. */
function captureHolderProbeError(run: () => unknown): HolderProbeError {
  try {
    run();
  } catch (error) {
    assert.ok(
      error instanceof HolderProbeError,
      `expected a HolderProbeError, received ${String(error)}`,
    );
    return error;
  }
  return assert.fail("expected the probe to throw a HolderProbeError");
}

before(() => {
  root = fixtureDir("holder-runner-");
  storePath = path.join(root, "hermes", "state.db");
  writeFixtureFile(storePath, "not a database: identity matching is metadata only");
  unrelatedPath = path.join(root, "elsewhere", "other.db");
  writeFixtureFile(unrelatedPath, "a different file, a different inode");
  store = { canonicalPath: storePath, ...identityOf(storePath) };
});

after(() => {
  for (const dir of createdDirs) fs.rmSync(dir, { recursive: true, force: true });
  createdDirs.length = 0;
});

// ---------------------------------------------------------------------------
// Linux enumeration.
// ---------------------------------------------------------------------------

describe("store-holder-detect-runner: linux enumeration", () => {
  it("reports a same-user process holding the store as a candidate", () => {
    const host = fakeHost([
      { pid: 4100, argv: ["/usr/bin/node", "server.js"], openPaths: [storePath] },
    ]);
    const deps = createDefaultHolderProbeDeps(host.seams);

    const candidates = deps.listOpenFileHolders([storePath]);

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].pid, 4100);
    assert.equal(candidates[0].startIdentity, "v2:4100:1700000000000");
    assert.deepEqual(candidates[0].argv, ["/usr/bin/node", "server.js"]);
    // The RAW spelling is returned; the pure module re-derives the match.
    assert.deepEqual(candidates[0].openPaths, [storePath]);
  });

  it("reads the descriptor directory and links at the pid's procfs paths", () => {
    const host = fakeHost([{ pid: 4101, openPaths: [storePath] }]);
    const deps = createDefaultHolderProbeDeps(host.seams);

    deps.listOpenFileHolders([storePath]);

    assert.deepEqual(host.readDirPaths, [procfsPidPath(4101, "fd")]);
    assert.deepEqual(host.readLinkPaths, [procfsPidPath(4101, "fd", "3")]);
  });

  it("splits the NUL-separated cmdline into argv with no trailing empty element", () => {
    const host = fakeHost([
      {
        pid: 4102,
        argv: ["/usr/local/bin/node", "/app/server.js", "--port", "0"],
        openPaths: [storePath],
      },
    ]);
    const deps = createDefaultHolderProbeDeps(host.seams);

    const candidates = deps.listOpenFileHolders([storePath]);

    assert.deepEqual(candidates[0].argv, [
      "/usr/local/bin/node",
      "/app/server.js",
      "--port",
      "0",
    ]);
    assert.ok(!candidates[0].argv.includes(""), "the trailing NUL must not become an argv entry");
  });

  it("keeps only absolute descriptor targets (socket:, pipe: and anon_inode: are not paths)", () => {
    const host = fakeHost([
      {
        pid: 4103,
        argv: ["node", "server.js"],
        openPaths: ["socket:[12345]", "pipe:[67890]", "anon_inode:[eventfd]", storePath],
      },
    ]);
    const deps = createDefaultHolderProbeDeps(host.seams);

    const candidates = deps.listOpenFileHolders([storePath]);

    assert.deepEqual(candidates[0].openPaths, [storePath]);
  });

  it("skips a process whose open files share no identity with the requested paths", () => {
    const host = fakeHost([
      { pid: 4104, argv: ["node", "unrelated.js"], openPaths: [unrelatedPath] },
    ]);
    const deps = createDefaultHolderProbeDeps(host.seams);

    assert.deepEqual(deps.listOpenFileHolders([storePath]), []);
  });

  it("skips a process owned by another user (out of scope, not a failure)", () => {
    const host = fakeHost([
      { pid: 4105, uid: CURRENT_UID + 1, openPaths: [storePath] },
    ]);
    const deps = createDefaultHolderProbeDeps(host.seams);

    assert.deepEqual(deps.listOpenFileHolders([storePath]), []);
  });

  it("skips a pid that vanished before inspection (ENOENT) without failing the probe", () => {
    const host = fakeHost([{ pid: 4106, vanish: true, openPaths: [storePath] }]);
    const deps = createDefaultHolderProbeDeps(host.seams);

    assert.deepEqual(deps.listOpenFileHolders([storePath]), []);
  });

  it("skips a descriptor that closed between the directory read and the readlink", () => {
    const host = fakeHost([
      {
        pid: 4107,
        argv: ["node", "server.js"],
        openPaths: [storePath, storePath],
        fdLinkErrors: { "3": "ENOENT" },
      },
    ]);
    const deps = createDefaultHolderProbeDeps(host.seams);

    const candidates = deps.listOpenFileHolders([storePath]);

    // The closed descriptor is skipped; the surviving one still identifies it.
    assert.equal(candidates.length, 1);
    assert.deepEqual(candidates[0].openPaths, [storePath]);
  });

  it("inherits the default seams it is not given (one override still probes Linux)", () => {
    const deps = createDefaultHolderProbeDeps({
      listPids: () => [],
      hasProcfs: () => true,
      platform: "linux",
    });

    assert.equal(typeof deps.listOpenFileHolders, "function");
    assert.deepEqual(deps.listOpenFileHolders([storePath]), []);
  });
});

// ---------------------------------------------------------------------------
// Hand-off to the pure module.
// ---------------------------------------------------------------------------

describe("store-holder-detect-runner: feeds the pure detector", () => {
  it("lists the holder for the store's canonical path with a sanitized description", () => {
    const host = fakeHost([
      { pid: 4200, argv: ["/usr/bin/node", "/app/server.js"], openPaths: [storePath] },
    ]);
    const deps = createDefaultHolderProbeDeps(host.seams);

    const detection = detectStoreHolders([store], deps);

    assert.equal(detection.observationComplete, true);
    assert.deepEqual(detection.probeFailures, []);
    assert.deepEqual(detection.holders, [
      {
        pid: 4200,
        startIdentity: "v2:4200:1700000000000",
        commandDescription: "node /app/server.js",
        storePaths: [storePath],
      },
    ]);
  });

  it("keeps a process holding an unlinked sidecar open (identity gone, spelling intact)", () => {
    const host = fakeHost([
      {
        pid: 4201,
        argv: ["node", "writer.js"],
        openPaths: [`${storePath}-wal (deleted)`],
      },
    ]);
    const deps = createDefaultHolderProbeDeps(host.seams);

    const detection = detectStoreHolders([store], deps);

    assert.equal(detection.observationComplete, true);
    assert.equal(detection.holders.length, 1);
    // A sidecar holder is reported under the STORE's canonical path.
    assert.deepEqual(detection.holders[0].storePaths, [storePath]);
  });

  it("reports an unreadable cmdline as (command unavailable) instead of inventing argv", () => {
    const host = fakeHost([
      { pid: 4202, cmdlineUnreadable: true, openPaths: [storePath] },
    ]);
    const deps = createDefaultHolderProbeDeps(host.seams);

    const detection = detectStoreHolders([store], deps);

    assert.equal(detection.observationComplete, true);
    assert.equal(detection.holders[0].commandDescription, "(command unavailable)");
  });
});

// ---------------------------------------------------------------------------
// Partial observations and refusals to answer.
// ---------------------------------------------------------------------------

describe("store-holder-detect-runner: probe failures carry pid scope and partial evidence", () => {
  it("throws for an unreadable descriptor directory after listing what it saw", () => {
    const host = fakeHost([
      { pid: 4300, argv: ["node", "server.js"], openPaths: [storePath] },
      { pid: 4301, argv: ["node", "other.js"], fdDirError: "EACCES" },
    ]);
    const deps = createDefaultHolderProbeDeps(host.seams);

    const error = captureHolderProbeError(() => deps.listOpenFileHolders([storePath]));

    assert.equal(error.scope, "pid:4301");
    assert.match(error.message, /cannot list open file descriptors: EACCES/);
    assert.ok(error.partialCandidates !== undefined, "the observed candidates must be carried");
    assert.deepEqual(
      error.partialCandidates?.map((candidate) => candidate.pid),
      [4300],
    );
  });

  it("still lists the partial holders through detectStoreHolders (not a refusal)", () => {
    const host = fakeHost([
      { pid: 4302, argv: ["node", "server.js"], openPaths: [storePath] },
      { pid: 4303, argv: ["node", "other.js"], fdDirError: "EPERM" },
    ]);
    const deps = createDefaultHolderProbeDeps(host.seams);

    const detection = detectStoreHolders([store], deps);

    assert.equal(detection.observationComplete, false);
    assert.deepEqual(
      detection.holders.map((holder) => holder.pid),
      [4302],
    );
    assert.equal(detection.probeFailures.length, 1);
    assert.equal(detection.probeFailures[0].scope, "pid:4303");
    assert.match(detection.probeFailures[0].reason, /cannot list open file descriptors/);
    // Informational only: the result has no verdict field whatsoever.
    assert.deepEqual(Object.keys(detection).sort(), [
      "holders",
      "observationComplete",
      "probeFailures",
    ]);
  });

  it("throws for an unresolvable descriptor with pid scope", () => {
    const host = fakeHost([
      {
        pid: 4304,
        argv: ["node", "server.js"],
        openPaths: [storePath],
        fdLinkErrors: { "3": "EACCES" },
      },
    ]);
    const deps = createDefaultHolderProbeDeps(host.seams);

    const error = captureHolderProbeError(() => deps.listOpenFileHolders([storePath]));

    assert.equal(error.scope, "pid:4304");
    assert.match(error.message, /cannot resolve open file descriptor: EACCES/);
    assert.deepEqual(error.partialCandidates, []);
  });

  it("records a non-permission descriptor error with the same pid scope", () => {
    const host = fakeHost([
      {
        pid: 4309,
        argv: ["node", "server.js"],
        openPaths: [storePath],
        fdLinkErrors: { "3": "EIO" },
      },
    ]);
    const deps = createDefaultHolderProbeDeps(host.seams);

    const error = captureHolderProbeError(() => deps.listOpenFileHolders([storePath]));

    assert.equal(error.scope, "pid:4309");
    assert.match(error.message, /cannot resolve open file descriptor: EIO/);
  });

  it("throws rather than fabricating a start identity for a matched holder", () => {
    const host = fakeHost([
      { pid: 4305, argv: ["node", "server.js"], openPaths: [storePath], startIdentity: null },
    ]);
    const deps = createDefaultHolderProbeDeps(host.seams);

    const error = captureHolderProbeError(() => deps.listOpenFileHolders([storePath]));

    assert.equal(error.scope, "pid:4305");
    assert.match(error.message, /start identity is unavailable/);
    assert.deepEqual(error.partialCandidates, []);
  });
});

describe("store-holder-detect-runner: platforms it refuses to answer for", () => {
  it("throws for an unsupported platform instead of returning an empty list", () => {
    const host = fakeHost([{ pid: 4400, openPaths: [storePath] }], { platform: "freebsd" });
    const deps = createDefaultHolderProbeDeps(host.seams);

    const error = captureHolderProbeError(() => deps.listOpenFileHolders([storePath]));

    assert.equal(error.scope, "platform:freebsd");
    assert.match(error.message, /unsupported platform/);
    assert.equal(host.readDirPaths.length, 0, "no enumeration may run on an unsupported platform");
    assert.equal(host.lsofCalls.length, 0, "no lsof probe may run on an unsupported platform");
  });

  it("throws on Linux without procfs instead of reporting no holders", () => {
    const host = fakeHost([{ pid: 4401, openPaths: [storePath] }], { procfs: false });
    const deps = createDefaultHolderProbeDeps(host.seams);

    const error = captureHolderProbeError(() => deps.listOpenFileHolders([storePath]));

    assert.equal(error.scope, "platform:linux");
    assert.match(error.message, /procfs is unavailable/);
  });
});

// ---------------------------------------------------------------------------
// Darwin: one bounded lsof probe.
// ---------------------------------------------------------------------------

describe("store-holder-detect-runner: darwin bounded lsof", () => {
  function darwinHost(stdout: string, processes?: FakeProcess[]): FakeHost {
    // The fake process table only has to know the pids lsof reported, so a
    // start identity is available for them.
    const derived =
      processes ??
      [...stdout.matchAll(/^p(\d+)$/gm)].map((match) => ({ pid: Number(match[1]) }));
    return fakeHost(derived, {
      platform: "darwin",
      procfs: false,
      lsofResult: () => ({ kind: "ok", stdout, stderr: "", status: 0 }),
    });
  }

  it("probes once with -F pcn and the scoped paths, parsing p/c/n into candidates", () => {
    const host = darwinHost(
      [
        "p5100",
        "cnode",
        `n${storePath}`,
        "p5000",
        "cnode",
        `n${storePath}`,
        `n${unrelatedPath}`,
        "",
      ].join("\n"),
    );
    const deps = createDefaultHolderProbeDeps(host.seams);

    const candidates = deps.listOpenFileHolders([storePath]);

    assert.deepEqual(host.lsofCalls, [["-F", "pcn", "--", storePath]]);
    assert.equal(host.readDirPaths.length, 0, "the darwin path must not touch procfs");
    assert.deepEqual(
      candidates.map((candidate) => candidate.pid),
      [5000, 5100],
      "candidates are ordered by pid",
    );
    // lsof has no argv: the command name is the only executable evidence.
    assert.deepEqual(candidates[0], {
      pid: 5000,
      startIdentity: "v2:5000:1700000000000",
      argv: ["node"],
      openPaths: [storePath, unrelatedPath],
    });
  });

  it("ignores unknown field records, records before a process header and non-absolute names", () => {
    const host = darwinHost(
      [
        "ftxt",
        "p5200",
        "f3",
        "u1000",
        "cPython",
        "nsocket:[123]",
        "nTCP:127.0.0.1:22",
        `n${storePath}`,
        "p",
        `n${storePath}`,
        "",
      ].join("\n"),
    );
    const deps = createDefaultHolderProbeDeps(host.seams);

    const candidates = deps.listOpenFileHolders([storePath]);

    assert.deepEqual(candidates, [
      {
        pid: 5200,
        startIdentity: "v2:5200:1700000000000",
        argv: ["Python"],
        openPaths: [storePath],
      },
    ]);
  });

  it("dedupes repeated n records and leaves argv empty when lsof reports no command", () => {
    const host = darwinHost(`p5300\nn${storePath}\nn${storePath}\n`);
    const deps = createDefaultHolderProbeDeps(host.seams);

    const candidates = deps.listOpenFileHolders([storePath]);

    assert.deepEqual(candidates, [
      {
        pid: 5300,
        startIdentity: "v2:5300:1700000000000",
        argv: [],
        openPaths: [storePath],
      },
    ]);
  });

  it("hands the lsof command name to the pure detector as the description", () => {
    const host = darwinHost(`p5400\ncnode\nn${storePath}\n`);
    const deps = createDefaultHolderProbeDeps(host.seams);

    const detection = detectStoreHolders([store], deps);

    assert.equal(detection.observationComplete, true);
    assert.deepEqual(detection.probeFailures, []);
    assert.deepEqual(detection.holders, [
      {
        pid: 5400,
        startIdentity: "v2:5400:1700000000000",
        commandDescription: "node",
        storePaths: [storePath],
      },
    ]);
  });

  it("treats lsof status 1 with empty stderr as zero candidates, not a failure", () => {
    const host = fakeHost([], {
      platform: "darwin",
      procfs: false,
      lsofResult: () => ({ kind: "error", status: 1, stderr: "" }),
    });
    const deps = createDefaultHolderProbeDeps(host.seams);

    assert.deepEqual(deps.listOpenFileHolders([storePath]), []);
    assert.equal(host.lsofCalls.length, 1);
  });

  it("throws lsof:timeout when the bounded probe times out (a timeout is UNKNOWN)", () => {
    const host = fakeHost([], {
      platform: "darwin",
      procfs: false,
      lsofResult: () => ({ kind: "timeout", timeoutMs: 5000 }),
    });
    const deps = createDefaultHolderProbeDeps(host.seams);

    const error = captureHolderProbeError(() => deps.listOpenFileHolders([storePath]));

    assert.equal(error.scope, "lsof:timeout");
    assert.match(error.message, /lsof probe timed out after 5000ms/);
  });

  it("throws lsof:probe when lsof is unavailable", () => {
    const host = fakeHost([], {
      platform: "darwin",
      procfs: false,
      lsofResult: () => ({ kind: "unavailable", error: "spawn lsof ENOENT" }),
    });
    const deps = createDefaultHolderProbeDeps(host.seams);

    const error = captureHolderProbeError(() => deps.listOpenFileHolders([storePath]));

    assert.equal(error.scope, "lsof:probe");
    assert.match(error.message, /lsof is unavailable: spawn lsof ENOENT/);
  });

  it("throws lsof:probe for a non-zero exit with stderr, flattened and bounded", () => {
    const noisy = `lsof: WARNING\n\tprobe failed ${"x".repeat(400)}`;
    const host = fakeHost([], {
      platform: "darwin",
      procfs: false,
      lsofResult: () => ({ kind: "error", status: 2, stderr: noisy }),
    });
    const deps = createDefaultHolderProbeDeps(host.seams);

    const error = captureHolderProbeError(() => deps.listOpenFileHolders([storePath]));

    assert.equal(error.scope, "lsof:probe");
    assert.ok(!error.message.includes("\n"), "a reason must stay on one line");
    assert.ok(error.message.length <= 240, "a reason must stay bounded");
    assert.match(error.message, /lsof: WARNING probe failed/);
  });

  it("throws lsof:probe for a non-status-1 exit with empty stderr", () => {
    const host = fakeHost([], {
      platform: "darwin",
      procfs: false,
      lsofResult: () => ({ kind: "error", status: 2, stderr: "  \n" }),
    });
    const deps = createDefaultHolderProbeDeps(host.seams);

    const error = captureHolderProbeError(() => deps.listOpenFileHolders([storePath]));

    assert.equal(error.scope, "lsof:probe");
    assert.match(error.message, /lsof exited with status 2/);
  });

  it("throws lsof:probe when the bounded primitive throws instead of answering", () => {
    const host = fakeHost([], {
      platform: "darwin",
      procfs: false,
      lsofResult: () => {
        throw new Error("spawn EACCES");
      },
    });
    const deps = createDefaultHolderProbeDeps(host.seams);

    const error = captureHolderProbeError(() => deps.listOpenFileHolders([storePath]));

    assert.equal(error.scope, "lsof:probe");
    assert.match(error.message, /lsof probe failed: spawn EACCES/);
  });

  it("throws for a matched pid without a start identity, keeping earlier candidates", () => {
    const host = fakeHost(
      [
        { pid: 5500, startIdentity: "v2:5500:1700000000000" },
        { pid: 5600, startIdentity: null },
      ],
      {
        platform: "darwin",
        procfs: false,
        lsofResult: () => ({
          kind: "ok",
          stdout: `p5500\ncnode\nn${storePath}\np5600\ncnode\nn${storePath}\n`,
          stderr: "",
          status: 0,
        }),
      },
    );
    const deps = createDefaultHolderProbeDeps(host.seams);

    const error = captureHolderProbeError(() => deps.listOpenFileHolders([storePath]));

    assert.equal(error.scope, "pid:5600");
    assert.match(error.message, /start identity is unavailable/);
    assert.deepEqual(
      error.partialCandidates?.map((candidate) => candidate.pid),
      [5500],
    );
    // The partial evidence is still listed, and the gap stays visible.
    const detection = detectStoreHolders([store], deps);
    assert.equal(detection.observationComplete, false);
    assert.deepEqual(
      detection.holders.map((holder) => holder.pid),
      [5500],
    );
    assert.deepEqual(
      detection.probeFailures.map((failure) => failure.scope),
      ["pid:5600"],
    );
  });

  it("never probes lsof for an empty path scope (no whole-host scan)", () => {
    const host = darwinHost(`p5000\ncnode\nn${storePath}\n`);
    const deps = createDefaultHolderProbeDeps(host.seams);

    assert.deepEqual(deps.listOpenFileHolders([]), []);
    assert.deepEqual(deps.listOpenFileHolders(["", ""]), []);
    assert.deepEqual(host.lsofCalls, []);
  });
});

// ---------------------------------------------------------------------------
// Module purity and serial-lane classification.
// ---------------------------------------------------------------------------

describe("store-holder-detect-runner: purity and classification", () => {
  it("keeps the pure module free of proc-info, lsof-probe and child_process imports", () => {
    const source = fs.readFileSync(PURE_MODULE_PATH, "utf-8");
    const specifiers = [...source.matchAll(/^\s*(?:import|export)\s+[^;]*?from\s+"([^"]+)"/gm)].map(
      (match) => match[1],
    );

    assert.deepEqual(specifiers.sort(), ["node:fs", "node:path"]);
    for (const forbidden of ["proc-info", "lsof-probe", "child_process"]) {
      assert.ok(
        !specifiers.some((specifier) => specifier.includes(forbidden)),
        `the pure module must not import ${forbidden}`,
      );
    }
  });

  it("never spawns a process and routes lsof only through the bounded primitive", () => {
    const source = fs.readFileSync(RUNNER_MODULE_PATH, "utf-8");

    // Built by concatenation so this test file never contains the tokens a
    // scanner could mistake for real usage.
    const spawners = ["spawn" + "Sync(", "exec" + "File(", "exec" + "Sync("];
    for (const token of spawners) {
      assert.ok(!source.includes(token), `the runner must not call ${token}`);
    }
    assert.ok(
      !source.includes(`from "node:${"child"}_${"process"}"`),
      "the runner must not import child_process directly",
    );
    assert.ok(
      source.includes(`from "../../lib/${"lsof"}-probe.js"`),
      "the runner must take lsof from the bounded primitive",
    );
  });

  it("is listed in tests/serial-files.txt in sorted position", () => {
    const entries = fs
      .readFileSync(SERIAL_FILES_PATH, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));

    const index = entries.indexOf(THIS_RELATIVE);
    assert.ok(index >= 0, `${THIS_RELATIVE} must be listed in tests/serial-files.txt`);

    if (index > 0) {
      assert.ok(
        entries[index - 1].localeCompare(THIS_RELATIVE) < 0,
        `${entries[index - 1]} must sort before ${THIS_RELATIVE}`,
      );
    }
    if (index < entries.length - 1) {
      assert.ok(
        THIS_RELATIVE.localeCompare(entries[index + 1]) < 0,
        `${THIS_RELATIVE} must sort before ${entries[index + 1]}`,
      );
    }
  });

  it("classifies as a serial-lane file (it imports a transitively spawn-capable module)", () => {
    const reasons = classifyTestFile(THIS_FILE, REPO_ROOT);

    assert.ok(
      reasons.length >= 1,
      `${THIS_RELATIVE} must classify as serial; got no reason at all`,
    );
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the REAL default probe against a REAL process holding a store.
// ---------------------------------------------------------------------------

/**
 * Child program: open the store and keep the descriptor open until signalled.
 * Deliberately a FILE (spawned by path) instead of an inline `-e` program, so
 * the sanitized description cannot contain script source.
 */
const CHILD_PROGRAM = [
  'import fs from "node:fs";',
  "const storePath = process.argv[2];",
  'const descriptor = fs.openSync(storePath, "r");',
  'process.stdout.write("READY\\n");',
  "setInterval(() => {",
  "  if (descriptor < 0) process.exit(1);",
  "}, 1000);",
  "",
].join("\n");

/** Wait for the child's READY line under a bounded monotonic deadline. */
function waitForChildReady(child: ChildProcess, timeoutMs: number): Promise<void> {
  const stdout = child.stdout;
  assert.ok(stdout !== null, "the child's stdout must be piped");

  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    let deadline: ReturnType<typeof setTimeout> | null = null;
    let buffer = "";

    const finish = (error?: Error): void => {
      if (deadline !== null) clearTimeout(deadline);
      stdout.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error === undefined) resolve();
      else reject(error);
    };

    const onData = (chunk: string): void => {
      buffer += chunk;
      if (buffer.includes("READY")) finish();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(
        new Error(`child exited before READY (code=${String(code)}, signal=${String(signal)})`),
      );
    };
    const onError = (error: Error): void => finish(error);

    deadline = setTimeout(() => {
      const elapsedMs = Math.round(performance.now() - startedAt);
      finish(new Error(`child did not print READY within ${timeoutMs}ms (elapsed ${elapsedMs}ms)`));
    }, timeoutMs);

    stdout.setEncoding("utf-8");
    stdout.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

/** Stop and reap the child, bounded, so the test never leaks a process. */
async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  await new Promise<void>((resolve) => {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const onExit = (): void => {
      if (deadline !== undefined) clearTimeout(deadline);
      resolve();
    };
    // The child may exit immediately on the signal; the deadline only bounds
    // a child that refuses to die and must not keep the loop alive afterwards.
    deadline = setTimeout(() => {
      child.off("exit", onExit);
      resolve();
    }, 5000);
    child.once("exit", onExit);
    child.kill("SIGKILL");
  });
}

describe("store-holder-detect-runner: real process on Linux", () => {
  it(
    "detects a live child holding a real store file with the default probe",
    { skip: process.platform !== "linux" },
    async () => {
      const dir = fixtureDir("holder-real-");
      const realStorePath = path.join(dir, "state.db");
      writeFixtureFile(realStorePath, "a real store file held open by a real process");
      const childScript = path.join(dir, "holder-child.mjs");
      fs.writeFileSync(childScript, CHILD_PROGRAM);

      const realStore: HolderStore = {
        canonicalPath: realStorePath,
        ...identityOf(realStorePath),
      };

      const child = spawn(process.execPath, [childScript, realStorePath], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      try {
        await waitForChildReady(child, 5000);
        const pid = child.pid;
        assert.ok(pid !== undefined, "the spawned child must have a pid");

        const expectedIdentity = getProcessStartIdentity(pid);
        assert.ok(
          typeof expectedIdentity === "string" && expectedIdentity.startsWith(`v2:${pid}:`),
          `expected a v2 start identity for the child, got ${String(expectedIdentity)}`,
        );

        // Scoped real enumeration: every probe seam is the production one
        // (procfs descriptor directory, readlinks, cmdline, kernel start
        // identity), only the pid list is narrowed to this child so the host's
        // unrelated processes cannot make this assertion environment-dependent.
        const scopedDetection = detectStoreHolders(
          [realStore],
          createDefaultHolderProbeDeps({ listPids: () => [pid] }),
        );

        assert.equal(scopedDetection.observationComplete, true);
        assert.deepEqual(scopedDetection.probeFailures, []);
        assert.equal(scopedDetection.holders.length, 1);

        const scopedHolder = scopedDetection.holders[0];
        assert.equal(scopedHolder.pid, pid);
        assert.equal(scopedHolder.startIdentity, expectedIdentity);
        assert.deepEqual(scopedHolder.storePaths, [realStorePath]);
        assert.match(scopedHolder.commandDescription, /^node /);
        assert.ok(
          scopedHolder.commandDescription.includes(path.basename(childScript)),
          "the description keeps the identifying script argument",
        );
        // Sanitized: no program source and no raw argv array anywhere.
        assert.ok(!scopedHolder.commandDescription.includes("openSync"));
        assert.ok(!scopedHolder.commandDescription.includes("setInterval"));
        assert.ok(!("argv" in scopedHolder));

        // The unchanged default enumeration (no seam overrides at all) must
        // also list the real holder. Other same-user processes on a normal
        // host may deny descriptor reads; that is a RECORDED observation gap
        // (observationComplete=false), never a thrown error and never a
        // missing holder — the pure module lists the partial evidence.
        const fullDetection = detectStoreHolders([realStore], createDefaultHolderProbeDeps());
        const fullHolder = fullDetection.holders.find((holder) => holder.pid === pid);
        assert.ok(
          fullHolder !== undefined,
          "the default enumeration must still list the real holder",
        );
        assert.equal(fullHolder.startIdentity, expectedIdentity);
        assert.deepEqual(fullHolder.storePaths, [realStorePath]);
        assert.equal(
          fullDetection.observationComplete,
          fullDetection.probeFailures.length === 0,
          "observationComplete is exactly the absence of recorded probe failures",
        );
        for (const failure of fullDetection.probeFailures) {
          assert.ok(failure.scope.length > 0, "a probe failure must name its scope");
          assert.ok(failure.reason.length > 0, "a probe failure must explain itself");
        }
      } finally {
        await stopChild(child);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
