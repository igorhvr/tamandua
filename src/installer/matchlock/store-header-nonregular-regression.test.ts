/**
 * store-header non-regular-file regression (G3-B FIX, US-002).
 *
 * The landed baseline d6c0383d (tree a7090b54) called
 * `fs.openSync(storePath, "r")` after a `statSync` precheck. On a FIFO that
 * `open` blocks forever until a writer appears, so `observeStore` — an
 * admission-path reader that promises never to hang — hung, invisibly.
 *
 * This file proves the regression differentially instead of only proving that
 * the candidate passes:
 *
 *   1. The landed baseline module is reconstructed EXACTLY from
 *      `git show d6c0383d:src/installer/matchlock/store-header.ts`, transpiled
 *      to ESM and written into a scratch directory. No baseline worktree and no
 *      baseline `npm install` are used, and the checked-out tree is never
 *      modified.
 *   2. The same tiny probe script imports a module path from argv and prints
 *      the resulting observation as JSON.
 *   3. The probe runs in a separate `node` SUBPROCESS. A real `setTimeout` in
 *      the PARENT event loop SIGKILLs the child after the deadline. An
 *      in-process timer cannot interrupt a blocked synchronous `open`, so the
 *      deadline must live outside the blocked context; a test that hangs the
 *      suite would not be a passing test.
 *
 * The baseline probe must be killed by the external deadline and must emit no
 * observation. The candidate probe must exit well inside the deadline with a
 * bounded `header-unreadable` refusal for the same FIFO.
 *
 * A second probe (US-003) proves the check-to-open race. It patches
 * `fs.openSync` in the child so the first open of a symlink-to-regular path
 * unlinks it and re-links it to the FIFO, AFTER the lstat/stat precheck. The
 * candidate must still return a bounded refusal, rejected from `fstatSync` on
 * the opened descriptor rather than from the stale pathname observation. The
 * probe reports the swap so the test fails if the race path was never hit.
 *
 * Because it spawns processes (node + mkfifo + git), this file belongs in the
 * SERIAL lane and is registered in tests/serial-files.txt.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { tamanduaShortTempDir } from "../../../dist/lib/temp-dir.js";
import {
  STORE_REASON_CODE_ORDER,
  observeStore,
} from "../../../dist/installer/matchlock/store-header.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const CANDIDATE_MODULE = path.join(
  REPO_ROOT,
  "dist",
  "installer",
  "matchlock",
  "store-header.js",
);
const BASELINE_COMMIT = "d6c0383d";
const BASELINE_TREE = "a7090b54";
const BASELINE_SOURCE_PATH = "src/installer/matchlock/store-header.ts";
const DEADLINE_MS = 3_000;
const PROBE_MARKER = "TAMANDUA_PROBE_OBSERVATION:";
const SWAP_MARKER = "TAMANDUA_PROBE_SWAP:";

const createdDirs: string[] = [];

after(() => {
  for (const dir of createdDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort: a killed probe may still be releasing the FIFO
    }
  }
});

interface SwapReport {
  swapped: boolean;
  swapCount: number;
  readCalls: number;
  error: string | null;
}

interface ProbeResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  timedOut: boolean;
  observation: Record<string, unknown> | null;
  swapReport: SwapReport | null;
}

/** Extract the observation JSON the probe prints, or null if it never did. */
function parseObservation(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(PROBE_MARKER)) continue;
    try {
      return JSON.parse(line.slice(PROBE_MARKER.length)) as Record<
        string,
        unknown
      >;
    } catch {
      return null;
    }
  }
  return null;
}

/** Extract the TOCTOU swap report the probe prints, or null if it never did. */
function parseSwapReport(stdout: string): SwapReport | null {
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(SWAP_MARKER)) continue;
    try {
      const parsed = JSON.parse(line.slice(SWAP_MARKER.length)) as Record<
        string,
        unknown
      >;
      return {
        swapped: parsed.swapped === true,
        swapCount:
          typeof parsed.swapCount === "number" ? parsed.swapCount : -1,
        readCalls:
          typeof parsed.readCalls === "number" ? parsed.readCalls : -1,
        error: typeof parsed.error === "string" ? parsed.error : null,
      };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Run one probe in a separate node process.
 *
 * The deadline is a parent-side `setTimeout` that SIGKILLs the child. It is
 * deliberately NOT an in-process timer around a blocking call: nothing inside
 * a process blocked in `open(2)` can observe a JS timer.
 */
function runProbe(
  probePath: string,
  modulePath: string,
  storePath: string,
  deadlineMs: number,
  extraArgs: string[] = [],
): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(
      process.execPath,
      [probePath, modulePath, storePath, ...extraArgs],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, deadlineMs);

    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolve({
        status,
        signal,
        stdout,
        stderr,
        elapsedMs: Date.now() - startedAt,
        timedOut,
        observation: parseObservation(stdout),
        swapReport: parseSwapReport(stdout),
      });
    });
  });
}

/** Probe script: dynamic-import the module named in argv, print one observation. */
const PROBE_SOURCE = [
  'import { pathToFileURL } from "node:url";',
  "const [modulePath, storePath] = process.argv.slice(2);",
  "const mod = await import(pathToFileURL(modulePath).href);",
  "const observation = mod.observeStore(storePath);",
  `process.stdout.write(${JSON.stringify(PROBE_MARKER)} + JSON.stringify(observation) + "\\n");`,
  "",
].join("\n");

function writeProbe(dir: string): string {
  const probePath = path.join(dir, "store-probe.mjs");
  fs.writeFileSync(probePath, PROBE_SOURCE, "utf-8");
  return probePath;
}

/**
 * TOCTOU probe: swap the symlink from a regular file to the FIFO on the first
 * `fs.openSync(linkPath, ...)` call, i.e. AFTER the module's lstat/stat
 * precheck and immediately BEFORE the real open. The candidate must pass
 * `O_NONBLOCK`, so opening the now-FIFO does not block, then reject it from
 * `fstatSync` before any read.
 *
 * The probe patches the very same `node:fs` default-export object that
 * `store-header.ts` calls dynamically (`fs.openSync(...)`), so the swap is
 * visible to the module. It prints the observation plus a swap report; the
 * test asserts the swap actually happened so it cannot pass by never
 * exercising the race path.
 */
const TOCTOU_PROBE_SOURCE = [
  'import { pathToFileURL } from "node:url";',
  'import fs from "node:fs";',
  "const [modulePath, linkPath, fifoPath] = process.argv.slice(2);",
  "// Import BEFORE patching: the ESM loader itself calls fs.readSync, and the",
  "// read guard below must count only reads performed by observeStore.",
  "const mod = await import(pathToFileURL(modulePath).href);",
  "const realOpenSync = fs.openSync;",
  "const realReadSync = fs.readSync;",
  "let swapCount = 0;",
  "let readCalls = 0;",
  "let error = null;",
  "fs.readSync = function patchedReadSync(fd, buffer, offset, length, position) {",
  "  readCalls += 1;",
  "  return realReadSync.call(fs, fd, buffer, offset, length, position);",
  "};",
  "fs.openSync = function patchedOpenSync(target, flags, mode) {",
  "  if (target === linkPath && swapCount === 0) {",
  "    try {",
  "      try { fs.unlinkSync(linkPath); } catch (err) {",
  '        if (err.code !== "ENOENT") throw err;',
  "      }",
  "      fs.symlinkSync(fifoPath, linkPath);",
  "      swapCount += 1;",
  "    } catch (err) {",
  "      error = err && err.message ? err.message : String(err);",
  "      throw err;",
  "    }",
  "  }",
  "  return realOpenSync.call(fs, target, flags, mode);",
  "};",
  "const observation = mod.observeStore(linkPath);",
  `process.stdout.write(${JSON.stringify(PROBE_MARKER)} + JSON.stringify(observation) + "\\n");`,
  `process.stdout.write(${JSON.stringify(SWAP_MARKER)} + JSON.stringify({ swapped: swapCount === 1, swapCount, readCalls, error }) + "\\n");`,
  "",
].join("\n");

function writeToctouProbe(dir: string): string {
  const probePath = path.join(dir, "store-toctou-probe.mjs");
  fs.writeFileSync(probePath, TOCTOU_PROBE_SOURCE, "utf-8");
  return probePath;
}

function baselineCommitAvailable(): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${BASELINE_COMMIT}^{commit}`], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconstruct the landed baseline module from the git object database and
 * write a transpiled ESM copy into the scratch directory.
 */
function writeBaselineModule(dir: string): string {
  const source = execFileSync(
    "git",
    ["show", `${BASELINE_COMMIT}:${BASELINE_SOURCE_PATH}`],
    { cwd: REPO_ROOT, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
  );

  assert.ok(
    source.includes('fs.openSync(storePath, "r")'),
    `the landed baseline ${BASELINE_COMMIT} must contain the blocking ` +
      `open that this regression exercises`,
  );

  const transpiled = ts.transpileModule(source, {
    fileName: "store-header-baseline.ts",
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });

  const banner = [
    `// Baseline snapshot: the EXACT landed module from commit ${BASELINE_COMMIT}`,
    `// (landed tree ${BASELINE_TREE}). The fix is confined to`,
    `// ${BASELINE_SOURCE_PATH}, so this blob exercises the same`,
    '// blocking fs.openSync(storePath, "r") as the baseline build.',
    "// It is transpiled and written into this scratch directory only: no baseline",
    "// worktree and no baseline npm install are used, and the checked-out tree is",
    "// never modified.",
    "",
  ].join("\n");

  const outPath = path.join(dir, "store-header-baseline.mjs");
  fs.writeFileSync(outPath, banner + transpiled.outputText, "utf-8");
  return outPath;
}

describe("store-header: non-regular file subprocess regression", () => {
  it("proves baseline d6c0383d hangs and the candidate refuses a FIFO within an external deadline", async (t) => {
    assert.equal(typeof observeStore, "function", "candidate module must load");

    const dir = tamanduaShortTempDir("tamandua-store-fifo-");
    createdDirs.push(dir);

    try {
      const fifoPath = path.join(dir, "fifo-store.db");

      // A FIFO is the demonstrated fixture: opening it for reading blocks
      // until a writer appears. If mkfifo is unavailable, say so explicitly
      // rather than pretending the case was proven.
      try {
        execFileSync("mkfifo", [fifoPath], { stdio: "ignore" });
      } catch (err) {
        const code =
          typeof err === "object" && err !== null && "code" in err
            ? String((err as { code?: unknown }).code)
            : "";
        if (code === "ENOENT") {
          t.skip("FIFO case unproven: mkfifo is unavailable on this platform");
          return;
        }
        throw err;
      }
      assert.ok(fs.lstatSync(fifoPath).isFIFO(), "fixture must be a FIFO");

      if (!baselineCommitAvailable()) {
        t.skip(
          `baseline case unproven: commit ${BASELINE_COMMIT} is not available in this clone`,
        );
        return;
      }

      // Both probes run the exact same script; only the imported module
      // (candidate vs reconstructed baseline) differs.
      const probePath = writeProbe(dir);
      const baselineModule = writeBaselineModule(dir);

      assert.ok(
        fs.existsSync(CANDIDATE_MODULE),
        `candidate module must exist at ${CANDIDATE_MODULE}; run npm run build first`,
      );

      // --- Candidate: must return well inside the deadline -----------------
      const candidate = await runProbe(
        probePath,
        CANDIDATE_MODULE,
        fifoPath,
        DEADLINE_MS,
      );
      t.diagnostic(
        `candidate: status=${String(candidate.status)} signal=${String(candidate.signal)} ` +
          `elapsed=${candidate.elapsedMs}ms timedOut=${String(candidate.timedOut)}`,
      );
      assert.equal(
        candidate.timedOut,
        false,
        `candidate probe must return before the ${DEADLINE_MS}ms external deadline; ` +
          `stderr: ${candidate.stderr}`,
      );
      assert.equal(
        candidate.signal,
        null,
        `candidate probe must not be killed; stderr: ${candidate.stderr}`,
      );
      assert.equal(
        candidate.status,
        0,
        `candidate probe must exit 0; stderr: ${candidate.stderr}`,
      );
      assert.ok(
        candidate.elapsedMs < DEADLINE_MS,
        `candidate probe elapsed ${candidate.elapsedMs}ms must be inside the ${DEADLINE_MS}ms deadline`,
      );
      assert.notEqual(
        candidate.observation,
        null,
        `candidate probe must emit an observation JSON line; stdout: ${candidate.stdout}`,
      );

      const observation = candidate.observation as Record<string, unknown>;
      assert.equal(observation.exists, true);
      assert.equal(observation.readable, false);
      assert.equal(observation.magicOk, false);
      assert.equal(observation.headerFormat, "unknown");
      assert.equal(observation.rawBytes1819, null);

      const findings = observation.findingCodes;
      assert.ok(Array.isArray(findings), "findingCodes must be an array");
      assert.ok(
        findings.includes("header-unreadable"),
        "a FIFO refusal must report header-unreadable",
      );
      assert.ok(
        !findings.includes("header-truncated"),
        "a FIFO must be refused, not read as truncated",
      );
      assert.ok(
        !findings.includes("header-not-sqlite"),
        "a FIFO must be refused, not read as non-SQLite",
      );

      // Observation must not consume or replace the FIFO.
      assert.ok(fs.existsSync(fifoPath), "the FIFO must still exist");
      assert.ok(fs.lstatSync(fifoPath).isFIFO(), "the FIFO must still be a FIFO");

      // The reason-code set is part of the public contract this fix preserves.
      assert.deepEqual(STORE_REASON_CODE_ORDER, [
        "store-missing",
        "permission-denied",
        "header-unreadable",
        "header-truncated",
        "header-not-sqlite",
        "sidecar-unresolved",
      ]);

      // --- Baseline: must be killed by the external deadline ---------------
      const baseline = await runProbe(
        probePath,
        baselineModule,
        fifoPath,
        DEADLINE_MS,
      );
      t.diagnostic(
        `baseline ${BASELINE_COMMIT}: status=${String(baseline.status)} ` +
          `signal=${String(baseline.signal)} elapsed=${baseline.elapsedMs}ms ` +
          `timedOut=${String(baseline.timedOut)}`,
      );

      // If the baseline returns in time, the differential proves nothing:
      // fail loudly instead of skipping.
      assert.equal(
        baseline.timedOut,
        true,
        `baseline ${BASELINE_COMMIT} probe returned in ${baseline.elapsedMs}ms; ` +
          `the regression fixture must hang the landed baseline, so this ` +
          `differential proves nothing`,
      );
      assert.equal(
        baseline.signal,
        "SIGKILL",
        `baseline ${BASELINE_COMMIT} must be killed by the external deadline`,
      );
      assert.equal(
        baseline.status,
        null,
        `baseline ${BASELINE_COMMIT} must not exit with a status before the deadline`,
      );
      assert.ok(
        baseline.elapsedMs >= DEADLINE_MS,
        `baseline ${BASELINE_COMMIT} was expected to block past the ` +
          `${DEADLINE_MS}ms deadline but returned in ${baseline.elapsedMs}ms`,
      );
      assert.equal(
        baseline.observation,
        null,
        `baseline ${BASELINE_COMMIT} must emit no observation JSON before the deadline`,
      );
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // after() retries; a killed probe can briefly hold the FIFO
      }
    }
  });

  it("refuses a path swapped from a regular file to a FIFO between the precheck and the open", async (t) => {
    assert.equal(typeof observeStore, "function", "candidate module must load");

    const dir = tamanduaShortTempDir("tamandua-store-toctou-");
    createdDirs.push(dir);

    try {
      const statePath = path.join(dir, "state.db");
      const linkPath = path.join(dir, "link.db");
      const fifoPath = path.join(dir, "fifo-store.db");

      // A regular target behind a symlink: the module's lstat/stat precheck
      // therefore legitimately classifies link.db as a readable regular file,
      // and only the descriptor re-check can catch the swap.
      fs.writeFileSync(statePath, Buffer.alloc(100, 0));
      fs.symlinkSync(statePath, linkPath);
      assert.ok(
        fs.lstatSync(linkPath).isSymbolicLink(),
        "fixture link.db must be a symlink",
      );
      assert.ok(
        fs.statSync(linkPath).isFile(),
        "fixture link.db must resolve to a regular file before the swap",
      );

      try {
        execFileSync("mkfifo", [fifoPath], { stdio: "ignore" });
      } catch (err) {
        const code =
          typeof err === "object" && err !== null && "code" in err
            ? String((err as { code?: unknown }).code)
            : "";
        if (code === "ENOENT") {
          t.skip("FIFO case unproven: mkfifo is unavailable on this platform");
          return;
        }
        throw err;
      }
      assert.ok(fs.lstatSync(fifoPath).isFIFO(), "fixture must be a FIFO");

      assert.ok(
        fs.existsSync(CANDIDATE_MODULE),
        `candidate module must exist at ${CANDIDATE_MODULE}; run npm run build first`,
      );

      const probePath = writeToctouProbe(dir);
      const result = await runProbe(
        probePath,
        CANDIDATE_MODULE,
        linkPath,
        DEADLINE_MS,
        [fifoPath],
      );
      t.diagnostic(
        `toctou candidate: status=${String(result.status)} signal=${String(result.signal)} ` +
          `elapsed=${result.elapsedMs}ms timedOut=${String(result.timedOut)} ` +
          `swap=${JSON.stringify(result.swapReport)}`,
      );

      // The parent deadline is the only thing that can stop a blocked probe.
      assert.equal(
        result.timedOut,
        false,
        `swapped-FIFO probe must return before the ${DEADLINE_MS}ms external deadline; ` +
          `stderr: ${result.stderr}`,
      );
      assert.equal(
        result.signal,
        null,
        `swapped-FIFO probe must not be killed; stderr: ${result.stderr}`,
      );
      assert.equal(
        result.status,
        0,
        `swapped-FIFO probe must exit 0; stderr: ${result.stderr}`,
      );
      assert.ok(
        result.elapsedMs < DEADLINE_MS,
        `swapped-FIFO probe elapsed ${result.elapsedMs}ms must be inside the ${DEADLINE_MS}ms deadline`,
      );

      // The race path must actually have been exercised: the patched open
      // swapped link.db to point at the FIFO exactly once.
      assert.notEqual(
        result.swapReport,
        null,
        `probe must report the swap; stdout: ${result.stdout}`,
      );
      const swap = result.swapReport as SwapReport;
      assert.equal(swap.error, null, "the probe's swap must not error");
      assert.equal(
        swap.swapped,
        true,
        `the check-to-open swap must have happened; report: ${JSON.stringify(swap)}`,
      );
      assert.equal(swap.swapCount, 1, "the swap must happen exactly once");
      assert.equal(
        swap.readCalls,
        0,
        "the opened FIFO descriptor must be rejected by fstatSync before any readSync",
      );

      assert.notEqual(
        result.observation,
        null,
        `probe must emit an observation JSON line; stdout: ${result.stdout}`,
      );
      const observation = result.observation as Record<string, unknown>;
      assert.equal(observation.exists, true);
      assert.equal(observation.readable, false);
      assert.equal(observation.magicOk, false);
      assert.equal(observation.headerFormat, "unknown");
      assert.equal(observation.rawBytes1819, null);

      const findings = observation.findingCodes;
      assert.ok(Array.isArray(findings), "findingCodes must be an array");
      assert.ok(
        findings.includes("header-unreadable"),
        "a swapped-in FIFO must be refused with header-unreadable",
      );
      assert.ok(
        !findings.includes("header-truncated"),
        "a swapped-in FIFO must be refused, not read as truncated",
      );

      // Post-race filesystem state: link.db now resolves to the FIFO and the
      // FIFO is untouched (never read, never unlinked by the module).
      assert.ok(
        fs.lstatSync(linkPath).isSymbolicLink(),
        "link.db must still be a symlink after the probe",
      );
      assert.ok(
        fs.statSync(linkPath).isFIFO(),
        "link.db must resolve to the FIFO after the swap",
      );
      assert.ok(fs.lstatSync(fifoPath).isFIFO(), "the FIFO must still be a FIFO");

      // The reason-code set is part of the public contract this fix preserves.
      assert.deepEqual(STORE_REASON_CODE_ORDER, [
        "store-missing",
        "permission-denied",
        "header-unreadable",
        "header-truncated",
        "header-not-sqlite",
        "sidecar-unresolved",
      ]);
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // after() retries; a killed probe can briefly hold the FIFO
      }
    }
  });
});
