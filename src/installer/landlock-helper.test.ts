/**
 * landlock-helper.test.ts — focused backend/setup tests for the Linux
 * Landlock startup helper (KHYG US-001).
 *
 * These tests exercise the REAL compiled helper (dist/native/landlock-helper,
 * built from native/landlock-helper.c by `npm run build`; falls back to
 * compiling the repo source into a temp dir when the artifact is absent):
 *
 *  1. READY contract: after applying a fresh SIGNAL-scope domain to ITSELF
 *     (no-new-privs, only FS_REFER handled + one allow rule at '/'), the
 *     helper writes `READY mode=landlock abi=<n> pid=<p>` on a private
 *     control fd (NOT stdin) and then execs its given argv exactly once after
 *     an explicit release.
 *  2. Pre-exec setup failure: an ABI < 6 gate (or forced via the test-only
 *     TAMANDUA_LANDLOCK_HELPER_TEST_FORCE_ABI hook) exits with the distinct
 *     pre-exec setup-failure code (125) BEFORE exec'ing anything — the target
 *     never runs and no READY is emitted.
 *  3. No release, no exec: closing the control channel before release aborts
 *     the helper without ever executing the target.
 *  4. Preserved rename/link composition: cross-directory hardlink + rename
 *     keep working under the product domain, and when the product domain is
 *     composed with a filesystem Landlock domain in EITHER order, matching
 *     the coordinator composition evidence (native-signal-probes.DHNQbp) —
 *     the FS_REFER root allow rule prevents EXDEV. A bare signal-scope
 *     domain (no REFER handling) composed with a filesystem domain still
 *     EXDEVs, proving the matrix is not vacuously green.
 *
 * Capability handling: on non-Linux hosts or kernels without Landlock
 * SIGNAL-scope support (ABI < 6) these tests skip honestly with a message;
 * on our rollout hosts (Linux, ABI >= 6) they MUST execute.
 *
 * Spawn-capable: listed in tests/serial-files.txt.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  HELPER_EXIT_SETUP_FAILURE,
  LANDLOCK_CONTROL_FD,
  LANDLOCK_MIN_ABI,
  defaultHelperPath,
  nativeArtifactsDir,
} from "../../dist/installer/native-signal-backend.js";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import { cleanChildEnv } from "../../tests/helpers/test-env.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const HELPER_SOURCE = path.join(REPO_ROOT, "native", "landlock-helper.c");

/** Test-only ABI override env hook understood by the helper. */
const FORCE_ABI_ENV = "TAMANDUA_LANDLOCK_HELPER_TEST_FORCE_ABI";

const READY_RE = /^READY mode=landlock abi=(\d+) pid=(\d+)$/;

/** Watchdog: never let a misbehaving helper strand a child process. */
const WATCHDOG_MS = 25000;

interface SpawnProtectedOptions {
  helper: string;
  /** argv after the helper binary (e.g. ["--control-fd", "3", "--", "/bin/sh", "-c", ...]). */
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface ProtectedRun {
  child: ReturnType<typeof spawn>;
  control: import("node:net").Socket | null;
  /** Resolves with the parsed READY record, or null if the child exited first. */
  ready: Promise<{ abi: number; pid: number; line: string } | null>;
  /** Resolves with the process close info. */
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stdout: () => string;
  stderr: () => string;
  /** Release the helper so it execs its target exactly once. */
  release: () => void;
  /** Close the control channel WITHOUT releasing (simulates give-up/cancel). */
  closeControl: () => void;
}

function spawnProtected(opts: SpawnProtectedOptions): ProtectedRun {
  // detached: true mirrors the production launch shape (the helper never
  // setsids itself; the parent spawn detaches the process group) and lets the
  // watchdog kill the whole group instead of orphaning grandchildren.
  const child = spawn(opts.helper, opts.args, {
    cwd: opts.cwd,
    env: cleanChildEnv(opts.env ?? {}),
    stdio: ["pipe", "pipe", "pipe", "pipe"], // fd 3 = private control channel
    detached: true,
  });
  const control = child.stdio[3] ?? null;

  let stdoutBuf = "";
  let stderrBuf = "";
  child.stdout?.on("data", (d: Buffer) => (stdoutBuf += d.toString("utf8")));
  child.stderr?.on("data", (d: Buffer) => (stderrBuf += d.toString("utf8")));

  let controlBuf = "";
  let released = false;
  control?.on("data", (d: Buffer) => (controlBuf += d.toString("utf8")));

  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on("close", (code, signal) => {
        resolve({ code, signal: signal as NodeJS.Signals | null });
        try {
          control?.destroy();
        } catch {
          /* best effort */
        }
      });
    },
  );

  const watchdog = setTimeout(() => {
    // Never signal a historical PID: only a STILL-LIVE owned handle may be
    // group-SIGKILLed. A child that already exited (pre-READY exit 125 or a
    // signal death) settles via the done/ready promises below.
    if (child.exitCode === null && child.signalCode === null) {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* best effort */
        }
      }
    }
  }, WATCHDOG_MS);
  watchdog.unref();
  done.finally(() => clearTimeout(watchdog)).catch(() => undefined);

  const ready = new Promise<{ abi: number; pid: number; line: string } | null>(
    (resolve) => {
      const timer = setTimeout(() => resolve(null), 15000);
      const check = (): void => {
        const nl = controlBuf.indexOf("\n");
        if (nl >= 0) {
          clearTimeout(timer);
          const line = controlBuf.slice(0, nl).trim();
          const m = READY_RE.exec(line);
          resolve(m ? { abi: Number(m[1]), pid: Number(m[2]), line } : null);
          return;
        }
        // Settle on EITHER a clean exit or a signal death: a signal-killed
        // helper (exitCode stays null) must not hold the ready promise open
        // until the 15s timer.
        if (child.exitCode !== null || child.signalCode !== null) {
          clearTimeout(timer);
          resolve(null);
        }
      };
      control?.on("data", check);
      child.on("close", check);
      check();
    },
  );

  return {
    child,
    control,
    ready,
    done,
    stdout: () => stdoutBuf,
    stderr: () => stderrBuf,
    release: () => {
      if (released || !control) return;
      released = true;
      control.write("R"); // any byte means "release exactly once"
    },
    closeControl: () => {
      if (!control || control.destroyed) return;
      control.destroy(); // EOF before release -> helper must abort, never exec
    },
  };
}

interface Capability {
  helper: string;
  supported: boolean;
  reason: string;
  realAbi?: number;
}

function compileHelperInto(cc: string, outPath: string): boolean {
  const result = spawnSync(cc, ["-O2", "-o", outPath, HELPER_SOURCE], { encoding: "utf8" });
  return result.status === 0;
}

async function detectCapability(): Promise<Capability> {
  if (process.platform !== "linux") {
    return { helper: "", supported: false, reason: "not a linux host" };
  }
  const artifact = defaultHelperPath(nativeArtifactsDir());
  let helper = "";
  if (fs.existsSync(artifact) && fs.statSync(artifact).isFile()) {
    helper = artifact;
  } else {
    const cc = process.env.TAMANDUA_TEST_CC ?? "cc";
    const tmp = tamanduaTempDir("tamandua-llh-compile-");
    helper = path.join(tmp, "landlock-helper");
    if (!compileHelperInto(cc, helper)) {
      return { helper: "", supported: false, reason: "no usable compiler for helper source" };
    }
    fs.chmodSync(helper, 0o755);
  }

  // Probe real Landlock capability with a harmless fixture: a domain must be
  // applied and READY reported; ABI < 6 or a kernel without SIGNAL scope
  // makes this exit 125 before any target runs.
  const probe = spawnProtected({
    helper,
    args: ["--control-fd", String(LANDLOCK_CONTROL_FD), "--", "/bin/true"],
  });
  const ready = await probe.ready;
  let close: { code: number | null; signal: NodeJS.Signals | null };
  if (ready !== null) {
    probe.release();
    close = await probe.done;
  } else {
    // The helper never reported READY. If it is still live, kill its group;
    // if it already exited (ordinary pre-READY exit 125 / signal death),
    // NEVER signal a historical PID — probe.done has already settled.
    if (probe.child.exitCode === null && probe.child.signalCode === null) {
      try {
        if (probe.child.pid !== undefined) process.kill(-probe.child.pid, "SIGKILL");
      } catch {
        try {
          probe.child.kill("SIGKILL");
        } catch {
          /* best effort */
        }
      }
    }
    close = await probe.done;
  }
  if (ready === null || close.code !== 0) {
    // The helper exits 125 pre-READY for BOTH known platform unavailability
    // (ABI < 6 / Landlock unavailable at boot) AND genuine helper or
    // protocol bugs. Only the ABI gate's own diagnostic
    // (stage=abi-below-minimum) is KNOWN unavailability -> honest skip.
    // Anything else — an unexpected control-channel/protocol 125, a signal
    // death, a spawn failure, or a post-release target failure — is a
    // genuine regression and must stay RED, never blanket-skip the suite.
    const stderrText = probe.stderr();
    if (
      close.code === HELPER_EXIT_SETUP_FAILURE &&
      /stage=abi-below-minimum/.test(stderrText)
    ) {
      const detail = stderrText.trim().split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300);
      return {
        helper,
        supported: false,
        reason: `landlock ABI below 6 or SIGNAL scope unsupported on this kernel (${detail})`,
      };
    }
    throw new Error(
      `landlock-helper capability probe failed unexpectedly: code=${close.code} signal=${close.signal} stderr=${stderrText}`,
    );
  }
  return { helper, supported: true, reason: "landlock SIGNAL scope available", realAbi: ready.abi };
}

// ── Composition fixture ────────────────────────────────────────────
// A small C probe (test fixture only, mirroring the coordinator's evidence
// mechanism) that applies one or more Landlock layers to ITSELF in the given
// order and then execs a command. Used to prove cross-directory link/rename
// survives composition with a filesystem Landlock domain in both orders
// thanks to the FS_REFER root allow rule.

const COMPOSE_FIXTURE_C = String.raw`
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>
/* Test fixture only (KHYG US-001 composition evidence reproduction). */
static int apply_layer(int kind) {
  struct landlock_ruleset_attr attr;
  memset(&attr, 0, sizeof(attr));
  if (kind == 1) { /* --layer-fs-refer: filesystem domain, FS_REFER handled + root allow */
    attr.handled_access_fs = LANDLOCK_ACCESS_FS_REFER;
  } else if (kind == 2) { /* --layer-signal-bare: bare SIGNAL scope, no fs rights handled */
    attr.scoped = LANDLOCK_SCOPE_SIGNAL;
  } else if (kind == 3) { /* --layer-signal-refer: SIGNAL scope + FS_REFER handled + root allow (product domain) */
    attr.handled_access_fs = LANDLOCK_ACCESS_FS_REFER;
    attr.scoped = LANDLOCK_SCOPE_SIGNAL;
  } else {
    return 124;
  }
  int fd = (int)syscall(SYS_landlock_create_ruleset, &attr, sizeof(attr), 0);
  if (fd < 0) { perror("create-ruleset"); return 125; }
  if (kind == 1 || kind == 3) {
    int root = open("/", O_PATH | O_CLOEXEC);
    if (root < 0) { perror("open-root"); return 125; }
    struct landlock_path_beneath_attr rule;
    memset(&rule, 0, sizeof(rule));
    rule.allowed_access = LANDLOCK_ACCESS_FS_REFER;
    rule.parent_fd = root;
    if (syscall(SYS_landlock_add_rule, fd, LANDLOCK_RULE_PATH_BENEATH, &rule, 0) < 0) {
      perror("add-rule"); return 125;
    }
    close(root);
  }
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) { perror("no-new-privs"); return 125; }
  if (syscall(SYS_landlock_restrict_self, fd, 0) < 0) { perror("restrict-self"); return 125; }
  close(fd);
  return 0;
}
int main(int argc, char **argv) {
  int i = 1;
  for (; i < argc; i++) {
    if (strcmp(argv[i], "--layer-fs-refer") == 0) { if (apply_layer(1)) return 125; }
    else if (strcmp(argv[i], "--layer-signal-bare") == 0) { if (apply_layer(2)) return 125; }
    else if (strcmp(argv[i], "--layer-signal-refer") == 0) { if (apply_layer(3)) return 125; }
    else if (strcmp(argv[i], "--") == 0) { i++; break; }
    else { fprintf(stderr, "unknown option %s\n", argv[i]); return 124; }
  }
  if (i >= argc) return 124;
  execvp(argv[i], &argv[i]);
  perror("exec");
  return 126;
}
`;

/** Node driver that reports raw link/rename results (no mv copy fallback). */
const LINK_RENAME_DRIVER = String.raw`
const fs = require("node:fs");
const [, , linkSrc, linkDst, renameSrc, renameDst] = process.argv;
function attempt(label, fn) {
  try { fn(); console.log(label + "=ok"); }
  catch (e) { console.log(label + "=err:" + (e && e.code ? e.code : String(e))); }
}
attempt("link", () => fs.linkSync(linkSrc, linkDst));
attempt("rename", () => fs.renameSync(renameSrc, renameDst));
`;

describe("landlock-helper (US-001)", () => {
  let cap: Capability = { helper: "", supported: false, reason: "not detected yet" };
  let scratch: string | null = null;

  before(async () => {
    cap = await detectCapability();
  });

  after(() => {
    if (scratch !== null) {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  function newScratch(prefix: string): string {
    if (scratch === null) {
      scratch = tamanduaTempDir("tamandua-llh-");
    }
    return fs.mkdtempSync(path.join(scratch, prefix));
  }

  it("records the host capability honestly (unsupported hosts skip, rollout hosts run)", () => {
    assert.ok(cap.reason.length > 0);
    if (!cap.supported) {
      console.log(`landlock-helper (US-001): capability skip on this host: ${cap.reason}`);
    }
  });

  it("reports READY with abi>=6 after self-restriction and execs argv exactly once", { timeout: 60000 }, async (t) => {
    if (!cap.supported) return t.skip(cap.reason);
    const dir = newScratch("ready-");
    const marker = path.join(dir, "marker");
    const run = spawnProtected({
      helper: cap.helper,
      args: ["--control-fd", String(LANDLOCK_CONTROL_FD), "--", "/bin/sh", "-c", `echo "TARGET_EXECUTED_${process.pid}"; printf 'ran\\n' >> "$MARKER"; sleep 0.1`],
      env: { MARKER: marker },
      cwd: dir,
    });

    const ready = await run.ready;
    assert.ok(ready, `helper must report READY before exec; stderr: ${run.stderr()}`);
    assert.ok(ready.abi >= LANDLOCK_MIN_ABI, `abi ${ready.abi} >= ${LANDLOCK_MIN_ABI}`);
    assert.equal(ready.pid, run.child.pid, "READY pid must be the helper pid (no fork)");
    assert.match(ready.line, /^READY mode=landlock abi=\d+ pid=\d+$/);

    run.release();
    const close = await run.done;
    assert.equal(close.code, 0, `stderr: ${run.stderr()}`);
    assert.match(run.stdout(), /TARGET_EXECUTED_\d+/);
    const lines = fs.readFileSync(marker, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1, "target argv must be executed exactly once");
  });

  it("exits with the distinct pre-exec setup-failure code on ABI < 6 and never execs the target", { timeout: 60000 }, async (t) => {
    if (!cap.supported) return t.skip(cap.reason);
    const dir = newScratch("abi-");
    const marker = path.join(dir, "marker");
    const run = spawnProtected({
      helper: cap.helper,
      args: ["--control-fd", String(LANDLOCK_CONTROL_FD), "--", "/bin/sh", "-c", `touch "$MARKER"`],
      env: { MARKER: marker, [FORCE_ABI_ENV]: "3" },
      cwd: dir,
    });

    const ready = await run.ready;
    const close = await run.done;
    assert.equal(ready, null, "no READY may be emitted before the ABI gate passes");
    assert.equal(close.code, HELPER_EXIT_SETUP_FAILURE, `stderr: ${run.stderr()}`);
    assert.match(run.stderr(), /abi-below-minimum/);
    assert.equal(fs.existsSync(marker), false, "target must never execute");
    assert.equal(run.stdout(), "", "target must never produce output");
  });

  it("preserves the real ABI-probe errno on syscall failure (distinct from a low ABI)", { timeout: 60000 }, async (t) => {
    if (!cap.supported) return t.skip(cap.reason);
    const dir = newScratch("abi-errno-");
    const marker = path.join(dir, "marker");
    // Simulate an unsupported/disabled SYS_landlock_create_ruleset: ABI -1
    // with the real errno preserved (ENOSYS), not zeroed before reporting.
    const run = spawnProtected({
      helper: cap.helper,
      args: ["--control-fd", String(LANDLOCK_CONTROL_FD), "--", "/bin/sh", "-c", `touch "$MARKER"`],
      env: { MARKER: marker, [FORCE_ABI_ENV]: "syscall-error" },
      cwd: dir,
    });

    const ready = await run.ready;
    const close = await run.done;
    assert.equal(ready, null, "no READY may be emitted when the ABI probe fails");
    assert.equal(close.code, HELPER_EXIT_SETUP_FAILURE, `stderr: ${run.stderr()}`);
    assert.match(run.stderr(), /abi-below-minimum/);
    assert.match(run.stderr(), /errno=38/); // ENOSYS preserved, not zeroed
    assert.match(run.stderr(), /probe failed/);
    assert.equal(fs.existsSync(marker), false, "target must never execute");
  });

  it("never executes the target when the control channel closes before release", { timeout: 60000 }, async (t) => {
    if (!cap.supported) return t.skip(cap.reason);
    const dir = newScratch("eof-");
    const marker = path.join(dir, "marker");
    const run = spawnProtected({
      helper: cap.helper,
      args: ["--control-fd", String(LANDLOCK_CONTROL_FD), "--", "/bin/sh", "-c", `touch "$MARKER"`],
      env: { MARKER: marker },
      cwd: dir,
    });

    const ready = await run.ready;
    assert.ok(ready, `helper must be ready before we simulate cancellation; stderr: ${run.stderr()}`);
    run.closeControl(); // no release ever sent
    const close = await run.done;
    assert.equal(close.code, HELPER_EXIT_SETUP_FAILURE, `stderr: ${run.stderr()}`);
    assert.match(run.stderr(), /control-eof-before-release/);
    assert.equal(
      fs.existsSync(marker),
      false,
      "a setup child that never received release must never exec the harness",
    );
  });

  it("keeps cross-directory hardlink and rename working under the product domain", { timeout: 60000 }, async (t) => {
    if (!cap.supported) return t.skip(cap.reason);
    const results = await runLinkRenameUnder({ helper: cap.helper, layers: null });
    assert.equal(results.link, "ok", `hardlink under the product domain: ${JSON.stringify(results)}`);
    assert.equal(results.rename, "ok", `rename under the product domain: ${JSON.stringify(results)}`);
  });

  it("keeps cross-directory link/rename working when composed with a filesystem domain in both orders (no EXDEV)", { timeout: 60000 }, async (t) => {
    if (!cap.supported) return t.skip(cap.reason);
    // Order 1: product helper domain FIRST, then a filesystem Landlock domain.
    const order1 = await runLinkRenameUnder({ helper: cap.helper, layers: ["--layer-fs-refer"] });
    assert.equal(order1.link, "ok", `order1 link: ${JSON.stringify(order1)}`);
    assert.equal(order1.rename, "ok", `order1 rename: ${JSON.stringify(order1)}`);
    // Order 2: filesystem Landlock domain FIRST, then the product helper domain.
    const order2 = await runLinkRenameUnder({ helper: cap.helper, layers: ["--layer-fs-refer"], fsFirst: true });
    assert.equal(order2.link, "ok", `order2 link: ${JSON.stringify(order2)}`);
    assert.equal(order2.rename, "ok", `order2 rename: ${JSON.stringify(order2)}`);
  });

  it("detects the composition hazard for a bare signal-scope layer (negative control)", { timeout: 60000 }, async (t) => {
    if (!cap.supported) return t.skip(cap.reason);
    const fixture = await composeFixture();
    for (const layers of [
      ["--layer-fs-refer", "--layer-signal-bare"],
      ["--layer-signal-bare", "--layer-fs-refer"],
    ]) {
      const results = await runLinkRenameUnderCompose(fixture, layers);
      assert.equal(results.link, "err:EXDEV", `${layers.join(" ")} link should EXDEV: ${JSON.stringify(results)}`);
      assert.equal(results.rename, "err:EXDEV", `${layers.join(" ")} rename should EXDEV: ${JSON.stringify(results)}`);
    }
  });

  // ── helpers ──────────────────────────────────────────────────────

  let _fixture: string | null = null;
  async function composeFixture(): Promise<string> {
    if (_fixture) return _fixture;
    const dir = newScratch("compose-");
    const srcPath = path.join(dir, "compose-probe.c");
    const binPath = path.join(dir, "compose-probe");
    fs.writeFileSync(srcPath, COMPOSE_FIXTURE_C);
    const cc = process.env.TAMANDUA_TEST_CC ?? "cc";
    const result = spawnSync(cc, ["-O2", "-o", binPath, srcPath], { encoding: "utf8" });
    assert.equal(result.status, 0, `compose fixture compile failed: ${result.stderr}`);
    _fixture = binPath;
    return binPath;
  }

  function writeLinkRenameFixture(dir: string): {
    file: string;
    renameSrc: string;
    driverPath: string;
    linkDst: string;
    renameDst: string;
  } {
    const dirA = path.join(dir, "a");
    const dirB = path.join(dir, "b");
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    const file = path.join(dirA, "file.txt");
    fs.writeFileSync(file, "payload");
    const renameSrc = path.join(dirA, "rename-src.txt");
    fs.writeFileSync(renameSrc, "rename-me");
    const driverPath = path.join(dir, "driver.js");
    fs.writeFileSync(driverPath, LINK_RENAME_DRIVER);
    return {
      file,
      renameSrc,
      driverPath,
      linkDst: path.join(dirB, "hardlink.txt"),
      renameDst: path.join(dirB, "renamed.txt"),
    };
  }

  async function runLinkRenameUnder(opts: {
    helper: string;
    layers: string[] | null;
    fsFirst?: boolean;
  }): Promise<{ link: string; rename: string }> {
    const fixture = await composeFixture();
    const dir = newScratch("files-");
    const f = writeLinkRenameFixture(dir);
    const driverArgs = ["node", f.driverPath, f.file, f.linkDst, f.renameSrc, f.renameDst];

    if (opts.fsFirst) {
      // Filesystem domain first (outer compose fixture), then the helper.
      const run = spawnProtected({
        helper: fixture,
        args: ["--layer-fs-refer", "--", opts.helper, "--control-fd", String(LANDLOCK_CONTROL_FD), "--", ...driverArgs],
        cwd: dir,
      });
      const ready = await run.ready;
      assert.ok(ready, `fs-first composition did not reach READY: ${run.stderr()}`);
      run.release();
      const close = await run.done;
      assert.equal(close.code, 0, `fs-first composition stderr: ${run.stderr()}`);
      return parseDriverOutput(run.stdout());
    }

    // Helper domain first, then optional extra layers via the compose fixture.
    const inner =
      opts.layers && opts.layers.length > 0 ? [fixture, ...opts.layers, "--", ...driverArgs] : driverArgs;
    const run = spawnProtected({
      helper: opts.helper,
      args: ["--control-fd", String(LANDLOCK_CONTROL_FD), "--", ...inner],
      cwd: dir,
    });
    const ready = await run.ready;
    assert.ok(ready, `helper-first composition did not reach READY: ${run.stderr()}`);
    run.release();
    const close = await run.done;
    assert.equal(close.code, 0, `helper-first composition stderr: ${run.stderr()}`);
    return parseDriverOutput(run.stdout());
  }

  async function runLinkRenameUnderCompose(
    fixture: string,
    layers: string[],
  ): Promise<{ link: string; rename: string }> {
    const dir = newScratch("files-");
    const f = writeLinkRenameFixture(dir);
    const run = spawnProtected({
      helper: fixture,
      args: [
        ...layers,
        "--",
        "node",
        f.driverPath,
        f.file,
        f.linkDst,
        f.renameSrc,
        f.renameDst,
      ],
      cwd: dir,
    });
    const close = await run.done;
    assert.equal(close.code, 0, `compose run stderr: ${run.stderr()}`);
    return parseDriverOutput(run.stdout());
  }
});

function parseDriverOutput(stdout: string): { link: string; rename: string } {
  const out: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const m = /^(link|rename)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].trim();
  }
  return { link: out.link ?? "missing", rename: out.rename ?? "missing" };
}
