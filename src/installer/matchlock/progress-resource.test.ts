/**
 * progress-resource.test.ts — MTLK-PROGRESS host resource layer tests.
 *
 * ALL synthetic isolated state: fresh temp run-root trees only, no live run
 * data, no real VM, no daemon, no model. The "guest" is a HOST FILESYSTEM
 * SIMULATION: a helper writes/append/rewrite/rename-over `progress.txt`
 * directly inside the progress resource directory — exactly the bytes a guest
 * would commit through the write-through directory mount — and the host access
 * layer must observe them. Labels distinguish host-fs simulation from actualVM
 * (actualVM is NOT authorized by this task).
 *
 * Serial lane: this file exercises real FIFO/socket special files via mkfifo
 * and a unix-socket listener (child_process / net), so it belongs in
 * tests/serial-files.txt.
 */

import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";
import { tamanduaShortTempDir } from "../../../dist/lib/temp-dir.js";
import {
  PROGRESS_DOC_FILE_NAME,
  ProgressResourceAccess,
  ProgressResourceError,
  assertSafeRunId,
  progressGuestDirForRun,
  progressGuestFileForRun,
  progressHostFile,
  progressResourceHostDirForRun,
} from "../../../dist/installer/matchlock/progress-resource.js";

const RUN = "11111111-1111-4111-8111-111111111111";
const PREFIXED_RUN = `run-${RUN}`;

function freshRoot(tag: string): string {
  // The FIFO/socket case below binds an AF_UNIX socket at
  // `<root>/<run-uuid>/progress-resource/progress.txt`, whose sun_path must fit
  // the kernel budget (104 bytes incl. NUL on macOS, 108 on Linux). The ambient
  // OS temp directory (deep under /private/var on macOS) would push the doc
  // path to ~136 bytes, and `net.Server.listen()` would then report success
  // WITHOUT creating the socket file, silently disabling the product refusal
  // this case is meant to exercise. Use the short literal temp base provided by
  // tamanduaShortTempDir() so the doc path stays well under budget.
  return tamanduaShortTempDir("tt-pr-" + tag + "-");
}

/** HOST-FS SIMULATION of the guest writing through the directory mount. */
function simGuestWrite(resourceDir: string, content: string): void {
  fs.mkdirSync(resourceDir, { recursive: true });
  fs.writeFileSync(path.join(resourceDir, PROGRESS_DOC_FILE_NAME), content, "utf8");
}

/** HOST-FS SIMULATION of the guest appending through the mount. */
function simGuestAppend(resourceDir: string, text: string): void {
  fs.appendFileSync(path.join(resourceDir, PROGRESS_DOC_FILE_NAME), text, "utf8");
}

/** HOST-FS SIMULATION of the guest atomically replacing via rename-over. */
function simGuestRenameOver(resourceDir: string, content: string): void {
  const tmp = path.join(resourceDir, `.guest.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, path.join(resourceDir, PROGRESS_DOC_FILE_NAME));
}

/** HOST-FS SIMULATION of the guest rewriting (truncate+write) in place. */
function simGuestRewrite(resourceDir: string, content: string): void {
  fs.writeFileSync(path.join(resourceDir, PROGRESS_DOC_FILE_NAME), content, "utf8");
}

// ── STRESS-ASSERT (bead tamandua-6sy.85): bounded churn supervision ─────────
//
// The pre-fix phase-2 drive was a fixed 8000-read budget with an INSTANT
// `regularReads > 0 && refusals > 0` assertion. On a loaded host the child
// flipper could be starved right after planting its outside symlink, so the
// host observed only refusals (regular=0, refusals=8000 — aasylum fresh clone
// 12:38Z) and the case failed although nothing was wrong. The drive below keeps
// the SAME hard safety invariants — the outside target is never read, the case
// is bounded (it can never hang), and every read is committed regular content
// or a progress_special_file refusal — but it keeps reading (yielding to the
// writer) until both outcomes have been observed or a bounded deadline
// elapses. The read is injected, so the reachability property is testable
// deterministically with scripted readers.

/** Committed regular content written by the churn writer (phases 1 and 2). */
const COMMITTED_CONTENT_RE = /^commit-\d+$/;

interface ChurnSupervisionOptions {
  /** One host read of the progress document; throws a ProgressResourceError to refuse it. */
  read: () => string | null;
  /** Bounded wall budget for the whole drive (the hard no-hang bound). */
  deadlineMs: number;
  /** Yield to the writer every N reads so a real child flipper gets CPU. */
  yieldEvery: number;
  /** Injectable clock (tests drive the deadline without real waiting). */
  now?: () => number;
  /** Injectable yield (tests skip event-loop round trips). */
  yieldFn?: () => Promise<void>;
  /** Recognizer for committed regular content (default: COMMITTED_CONTENT_RE). */
  isCommitted?: (text: string) => boolean;
}

interface ChurnSupervisionResult {
  reads: number;
  regularReads: number;
  refusals: number;
  bothObserved: boolean;
  elapsedMs: number;
  /** True when the drive stopped on the bounded deadline instead of seeing both outcomes. */
  deadlineElapsed: boolean;
}

/** A scripted progress_special_file refusal (the document leaf is a symlink/special file). */
function refusalPoint(): never {
  throw new ProgressResourceError("progress_special_file", "scripted refusal: the document leaf is a symlink");
}

/** A safety-invariant breach: never a refusal, always a hard failure. */
function churnInvariantViolation(message: string): Error {
  return new Error(`churn invariant violated: ${message}`);
}

/**
 * Drive the churn window until BOTH a committed regular read and a refusal have
 * been observed, or until the bounded deadline elapses — whichever comes first.
 * Every read is validated against the hard invariants; a breach throws (it is
 * never counted as a refusal), and no read is ever retried into a pass.
 */
async function superviseChurn(options: ChurnSupervisionOptions): Promise<ChurnSupervisionResult> {
  const now = options.now ?? (() => Date.now());
  const yieldFn = options.yieldFn ?? (async () => new Promise<void>((resolve) => setImmediate(resolve)));
  const isCommitted = options.isCommitted ?? ((text: string) => COMMITTED_CONTENT_RE.test(text));
  const started = now();
  let reads = 0;
  let regularReads = 0;
  let refusals = 0;
  let deadlineElapsed = false;
  while (regularReads === 0 || refusals === 0) {
    if (now() - started >= options.deadlineMs) {
      deadlineElapsed = true;
      break;
    }
    reads++;
    let text: string | null = null;
    let refused = false;
    try {
      text = options.read();
    } catch (err) {
      if (err instanceof ProgressResourceError && err.code === "progress_special_file") {
        refused = true;
      } else {
        throw err; // any other failure is a hard failure, never a refusal
      }
    }
    if (refused) {
      refusals++;
    } else {
      if (text === null) {
        throw churnInvariantViolation("the churn writer replaces the entry atomically, so the document must always exist (read returned null)");
      }
      if (text === "OUTSIDE-SECRET") {
        throw churnInvariantViolation("the outside symlink target must never be read");
      }
      if (!isCommitted(text)) {
        throw churnInvariantViolation(`host read must be committed regular content (${COMMITTED_CONTENT_RE}), got ${JSON.stringify(text)}`);
      }
      regularReads++;
    }
    if (reads % options.yieldEvery === 0) await yieldFn();
  }
  return {
    reads,
    regularReads,
    refusals,
    bothObserved: regularReads > 0 && refusals > 0,
    elapsedMs: now() - started,
    deadlineElapsed,
  };
}

/** Stop the spawned churn writer: kill it and await its exit (bounded, never hangs). */
async function stopChurnChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(true), 5000);
      timer.unref(); // never hold the test process open for the grace window
    }),
  ]);
  if (timedOut) {
    child.kill("SIGKILL");
    await exited;
  }
}

describe("progress resource host layer (host-fs simulation, NOT actualVM)", () => {
  const roots: string[] = [];
  after(() => {
    for (const root of roots) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup of own fixture trees */
      }
    }
  });

  function makeRoot(tag: string): string {
    const root = freshRoot(tag);
    roots.push(root);
    return root;
  }

  it("derives a deterministic host dir + guest paths, and rejects malicious run ids", () => {
    const root = makeRoot("identity");
    const hostDir = progressResourceHostDirForRun(RUN, { runRoot: root });
    assert.equal(hostDir, path.join(root, RUN, "progress-resource"));
    assert.equal(progressGuestDirForRun(RUN), `/workspace/runs/${RUN}`);
    assert.equal(progressGuestFileForRun(RUN), `/workspace/runs/${RUN}/progress.txt`);
    assert.equal(progressHostFile(hostDir), path.join(hostDir, PROGRESS_DOC_FILE_NAME));
    // run- prefixed ids normalize identically.
    assert.equal(progressResourceHostDirForRun(PREFIXED_RUN, { runRoot: root }), hostDir);
    assert.equal(assertSafeRunId(PREFIXED_RUN), RUN);
    for (const bad of ["../etc", "a/b", "..", ".", "", "run-../x", "abc", "run-", "x".repeat(80)]) {
      assert.throws(
        () => assertSafeRunId(bad),
        (e: unknown) => e instanceof ProgressResourceError,
        `expected refusal for ${JSON.stringify(bad)}`,
      );
    }
  });

  it("two sequential fresh attachments: guest writes/append/rewrite/rename-over survive detach/re-attach and host reads observe committed content", () => {
    const root = makeRoot("two-attach");
    const hostDir = progressResourceHostDirForRun(RUN, { runRoot: root });

    // Invocation 1: host attaches (ensure dir), guest commits via host-fs sim.
    const access1 = new ProgressResourceAccess(hostDir);
    access1.ensureDir();
    assert.equal(access1.readText(), null, "attach must not fabricate content");
    simGuestWrite(hostDir, "# Progress\nline one\n");
    assert.equal(access1.readText(), "# Progress\nline one\n");
    simGuestAppend(hostDir, "line two\n");
    assert.equal(access1.readText(), "# Progress\nline one\nline two\n");
    simGuestRewrite(hostDir, "# Progress\nrewritten\n");
    assert.equal(access1.readText(), "# Progress\nrewritten\n");
    simGuestRenameOver(hostDir, "# Progress\natomically replaced\n");
    assert.equal(access1.readText(), "# Progress\natomically replaced\n");

    // Detach: fresh invocation 2 attaches the SAME deterministic host dir.
    const access2 = new ProgressResourceAccess(hostDir);
    access2.ensureDir();
    assert.equal(access2.readText(), "# Progress\natomically replaced\n", "content must survive detach/re-attach");
    // Restart must NOT overwrite committed content with blank initial data.
    assert.equal(access2.readText(), "# Progress\natomically replaced\n");
    simGuestAppend(hostDir, "survives detach\n");
    assert.equal(access2.readText(), "# Progress\natomically replaced\nsurvives detach\n");
  });

  it("host commitText performs atomic replace and host reads see the new committed document", () => {
    const root = makeRoot("commit");
    const hostDir = progressResourceHostDirForRun(RUN, { runRoot: root });
    const access = new ProgressResourceAccess(hostDir);
    access.ensureDir();
    simGuestWrite(hostDir, "guest seed\n");
    access.commitText("# Progress\nhost story plan\n");
    assert.equal(access.readText(), "# Progress\nhost story plan\n");
    // The guest's later write is observed again (no pinned inode).
    simGuestRenameOver(hostDir, "guest after host\n");
    assert.equal(access.readText(), "guest after host\n");
  });

  it("compare-and-commit update retries on a guest commit observed between the initial read and the pre-commit re-check (fresh content wins, no silent drop of the observed interleave)", () => {
    const root = makeRoot("cas");
    const hostDir = progressResourceHostDirForRun(RUN, { runRoot: root });
    const access = new ProgressResourceAccess(hostDir);
    access.ensureDir();
    simGuestWrite(hostDir, "# Progress\nbase\n");

    // merge reads current; the "guest" appends between merge and commit by
    // hooking the identity check (we simulate by committing inside merge).
    let guestInterleaved = false;
    const merged = access.updateText((current) => {
      if (!guestInterleaved) {
        guestInterleaved = true;
        simGuestAppend(hostDir, "guest interleave\n"); // changes identity BEFORE commit
      }
      return `${current ?? ""}host merged line\n`;
    });
    // Retry must have re-read the interleaved guest content, so it is retained.
    assert.equal(guestInterleaved, true);
    assert.match(merged, /guest interleave/);
    assert.match(merged, /host merged line/);
    assert.equal(access.readText(), merged);
  });

  it("refuses symlink leaf entries on read (no host escape) and a guest symlink swap is never followed", () => {
    const root = makeRoot("symlink");
    const hostDir = progressResourceHostDirForRun(RUN, { runRoot: root });
    const access = new ProgressResourceAccess(hostDir);
    access.ensureDir();
    const outside = path.join(root, "outside-secret.txt");
    fs.writeFileSync(outside, "host secret", "utf8");
    fs.symlinkSync(outside, progressHostFile(hostDir), "file");
    assert.throws(
      () => access.readText(),
      (e: unknown) => e instanceof ProgressResourceError && e.code === "progress_special_file",
    );
    // host commit over the symlink replaces the ENTRY (rename over), never
    // writes through the link target.
    access.commitText("safe\n");
    assert.equal(access.readText(), "safe\n");
    assert.equal(fs.readFileSync(outside, "utf8"), "host secret", "outside target must be untouched");
    assert.equal(fs.lstatSync(progressHostFile(hostDir)).isSymbolicLink(), false);
  });

  it("refuses FIFO/socket/device leaves without hanging (O_NOFOLLOW|O_NONBLOCK + fstat)", async () => {
    if (process.platform === "win32") return; // mkfifo/unix-socket semantics are POSIX-only
    const root = makeRoot("fifo");
    const hostDir = progressResourceHostDirForRun(RUN, { runRoot: root });
    const access = new ProgressResourceAccess(hostDir);
    access.ensureDir();
    const doc = progressHostFile(hostDir);

    // FIFO: opening O_RDONLY without O_NONBLOCK would block forever; our
    // layer refuses via no-follow+nonblock open and a regular-file check.
    const mkfifo = promisify(execFile);
    await mkfifo("mkfifo", [doc]);
    const t0 = Date.now();
    assert.throws(
      () => access.readText(),
      (e: unknown) => e instanceof ProgressResourceError && e.code === "progress_special_file",
    );
    assert.ok(Date.now() - t0 < 2000, "read of a FIFO leaf must not hang");

    // Socket leaf (unix domain socket). Keep the listener OPEN while reading
    // (Node removes the socket file when the server closes). The doc path must
    // fit the macOS sun_path budget (104 bytes incl. NUL); otherwise listen()
    // silently succeeds without creating the socket and the refusal below would
    // assert against an absent leaf.
    assert.ok(
      Buffer.byteLength(doc) <= 103,
      `socket fixture doc path must fit the macOS sun_path budget (<=103 bytes), got ${Buffer.byteLength(doc)}: ${doc}`,
    );
    fs.rmSync(doc, { force: true });
    await new Promise<void>((resolve, reject) => {
      const srv = net.createServer();
      srv.on("error", reject);
      srv.listen(doc, () => {
        try {
          assert.ok(fs.lstatSync(doc).isSocket(), `net.listen must create a real AF_UNIX socket at ${doc}`);
          assert.throws(
            () => access.readText(),
            (e: unknown) => e instanceof ProgressResourceError && e.code === "progress_special_file",
          );
          resolve();
        } catch (err) {
          reject(err as Error);
        } finally {
          srv.close();
        }
      });
    });
  });

  it("refuses oversized documents and oversized host commits", () => {
    const root = makeRoot("oversize");
    const hostDir = progressResourceHostDirForRun(RUN, { runRoot: root });
    const access = new ProgressResourceAccess(hostDir, { maxBytes: 64 });
    access.ensureDir();
    simGuestWrite(hostDir, "x".repeat(128));
    assert.throws(
      () => access.readText(),
      (e: unknown) => e instanceof ProgressResourceError && e.code === "progress_doc_too_large",
    );
    assert.throws(
      () => access.commitText("y".repeat(128)),
      (e: unknown) => e instanceof ProgressResourceError && e.code === "progress_doc_too_large",
    );
  });

  it("cannot read/change content outside the dedicated resource (sibling run data / admin state canaries)", () => {
    const root = makeRoot("outside");
    const hostDir = progressResourceHostDirForRun(RUN, { runRoot: root });
    const access = new ProgressResourceAccess(hostDir);
    access.ensureDir();
    // Sibling "admin state" and sibling-run canaries directly under the run root.
    const siblingRun = path.join(root, "99999999-9999-4999-8999-999999999999");
    fs.mkdirSync(siblingRun, { recursive: true });
    fs.writeFileSync(path.join(siblingRun, "progress.txt"), "sibling progress", "utf8");
    fs.writeFileSync(path.join(root, RUN, "admin-secret.txt"), "admin", "utf8");
    // The access layer only ever touches hostDir/progress.txt; nothing else.
    simGuestWrite(hostDir, "mine\n");
    assert.equal(access.readText(), "mine\n");
    assert.equal(fs.readFileSync(path.join(siblingRun, "progress.txt"), "utf8"), "sibling progress");
    assert.equal(fs.readFileSync(path.join(root, RUN, "admin-secret.txt"), "utf8"), "admin");
    // archiveTo writes only into the provided archive dir, reading only the doc.
    const archiveDir = path.join(root, "archive");
    const archived = access.archiveTo(archiveDir);
    assert.equal(archived, "mine\n");
    assert.equal(fs.readFileSync(path.join(archiveDir, "progress.txt"), "utf8"), "mine\n");
    assert.equal(access.readText(), null, "resource doc removed after archive");
    assert.equal(fs.readFileSync(path.join(siblingRun, "progress.txt"), "utf8"), "sibling progress");
  });

  it("resource directory must be a REAL directory (symlinked dir fails closed)", () => {
    const root = makeRoot("dirlink");
    const realDir = path.join(root, "real");
    fs.mkdirSync(realDir, { recursive: true });
    const hostDir = path.join(root, RUN, "progress-resource");
    fs.mkdirSync(path.dirname(hostDir), { recursive: true });
    fs.symlinkSync(realDir, hostDir, "dir");
    const access = new ProgressResourceAccess(hostDir);
    assert.throws(
      () => access.readText(),
      (e: unknown) => e instanceof ProgressResourceError && e.code === "resource_dir_unavailable",
    );
    assert.throws(
      () => access.commitText("x"),
      (e: unknown) => e instanceof ProgressResourceError && e.code === "resource_dir_unavailable",
    );
  });

  it("lifecycle: content persists after a VM ends; nothing here ever deletes the resource or broad parent state", () => {
    const root = makeRoot("lifecycle");
    const hostDir = progressResourceHostDirForRun(RUN, { runRoot: root });
    const access = new ProgressResourceAccess(hostDir);
    access.ensureDir();
    simGuestWrite(hostDir, "# Progress\npersistent\n");
    // No cleanup call exists on the resource layer; re-attach after "VM end".
    const accessAfter = new ProgressResourceAccess(hostDir);
    assert.equal(accessAfter.readText(), "# Progress\npersistent\n");
    // ensureDir on restart does not create/overwrite a doc.
    accessAfter.ensureDir();
    assert.equal(accessAfter.readText(), "# Progress\npersistent\n");
    // The run root and its contents (including the resource dir) remain.
    assert.equal(fs.existsSync(hostDir), true);
  });

  it("swap-window stress: bounded regular/symlink churn never leaks the outside target, never hangs, and every read is committed regular content or a refusal", async () => {
    if (process.platform === "win32") return; // POSIX rename/symlink semantics
    const root = makeRoot("swap-stress");
    const hostDir = progressResourceHostDirForRun(RUN, { runRoot: root });
    const access = new ProgressResourceAccess(hostDir);
    access.ensureDir();
    const doc = progressHostFile(hostDir);
    const outside = path.join(root, "outside-secret.txt");
    fs.writeFileSync(outside, "OUTSIDE-SECRET", "utf8");
    simGuestWrite(hostDir, "commit-0");

    // Phase 1 — deterministic repeated swap in THIS process: after each state
    // change the very next read must be exactly the committed regular content
    // (when the entry is regular) or a refusal (when the guest planted a
    // symlink leaf). Deterministic user-space interleaving of the lstat->open
    // window is impossible from one thread, so phase 1 pins the state invariant
    // while phase 2 exercises the real OS-level race window concurrently.
    for (let i = 1; i <= 120; i++) {
      simGuestRenameOver(hostDir, `commit-${i}`);
      assert.equal(access.readText(), `commit-${i}`, `phase1 read ${i} must be the committed content`);
      const link = path.join(hostDir, `.lnk-${i}`);
      fs.symlinkSync(outside, link);
      fs.renameSync(link, doc); // guest atomically swaps the entry for a symlink
      assert.throws(
        () => access.readText(),
        (e: unknown) => e instanceof ProgressResourceError && e.code === "progress_special_file",
        `phase1 read ${i} after symlink swap must refuse`,
      );
    }

    // Phase 2 — a child process alternates the leaf between committed regular
    // content and an outside symlink and HOLDS each shape for a bounded dwell
    // window. The pre-fix child flipped as fast as it could, so a loaded host
    // could be starved into observing only refusals (regular=0, refusals=8000)
    // and fail the instant both-outcomes assertion (STRESS-ASSERT,
    // tamandua-6sy.85). The dwell windows make each shape reachable regardless
    // of CPU scheduling, and the drive below stops as soon as both outcomes
    // have been observed (the child is then stopped). This still genuinely
    // exercises the lstat->O_NOFOLLOW-open window at the OS level: every host
    // read must be a committed regular content string (any of the child's
    // commit-N) or a progress_special_file refusal, the outside target is never
    // read, and nothing hangs.
    const dwellMs = 22;
    const iterations = 1000; // 2 × dwell per iteration ⇒ outlives the deadline
    const childSrc = [
      "const fs = require('fs');",
      "const doc = process.argv[1];",
      "const outside = process.argv[2];",
      "const iterations = Number(process.argv[3]);",
      "const dwellMs = Number(process.argv[4]);",
      "const tmp = doc + '.flip-tmp';",
      "const lnk = doc + '.flip-lnk';",
      "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
      "async function run() {",
      "  for (let i = 1; i <= iterations; i++) {",
      "    fs.writeFileSync(tmp, 'commit-' + i);",
      "    fs.renameSync(tmp, doc);",
      "    await sleep(dwellMs); // committed-regular dwell window",
      "    try { fs.unlinkSync(lnk); } catch (e) {}",
      "    fs.symlinkSync(outside, lnk);",
      "    fs.renameSync(lnk, doc);",
      "    await sleep(dwellMs); // outside-symlink dwell window",
      "  }",
      "}",
      "run().catch((err) => { console.error(String(err)); process.exitCode = 1; });",
    ].join("\n");
    const child = spawn(process.execPath, ["-e", childSrc, doc, outside, String(iterations), String(dwellMs)], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let childStderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (childStderr.length < 4000) childStderr += chunk;
    });
    let result: ChurnSupervisionResult;
    try {
      result = await superviseChurn({ read: () => access.readText(), deadlineMs: 20000, yieldEvery: 16 });
    } finally {
      await stopChurnChild(child);
    }
    // Hard invariant — bounded: the drive returns within its deadline plus a
    // small settle allowance, so this case can never hang.
    assert.ok(
      result.elapsedMs < 20000 + 2000,
      `swap stress must stay bounded (no hang); elapsed=${result.elapsedMs}ms reads=${result.reads}`,
    );
    // Hard invariant — both outcomes are reachable. The diagnostic carries the
    // observed counters (and the writer's exit state) so a failure is actionable.
    assert.ok(
      result.bothObserved,
      `phase2 must observe both committed reads and refusals (regular=${result.regularReads}, refusals=${result.refusals}, reads=${result.reads}, elapsed=${result.elapsedMs}ms, deadlineElapsed=${result.deadlineElapsed}, childExit=${child.exitCode}, childStderr=${JSON.stringify(childStderr.slice(-400))})`,
    );
    assert.equal(fs.readFileSync(outside, "utf8"), "OUTSIDE-SECRET", "outside target must be untouched");
    // The host can always recover by atomic replace over whatever entry exists.
    access.commitText("host-restored\n");
    assert.equal(access.readText(), "host-restored\n");
  });

  it("churn supervision: a refusal burst longer than the retired 8000-read budget still reaches committed content (bothObserved=true, no early both-outcomes failure)", async () => {
    // Scripted reader: refusals well past the pre-fix fixed 8000-read budget,
    // then committed regular content. The pre-fix drive stopped at 8000 reads
    // and concluded regular=0; the supervision must keep reading (bounded by its
    // deadline) until both outcomes have been observed.
    const refusalsBeforeCommitted = 8000 + 137;
    const scripted = (calls: number): string => {
      if (calls <= refusalsBeforeCommitted) refusalPoint();
      return `commit-${calls}`;
    };
    let calls = 0;
    const result = await superviseChurn({
      read: () => scripted(++calls),
      deadlineMs: 20000,
      yieldEvery: 64,
      now: () => calls, // one fake "ms" per read keeps the burst inside the deadline
      yieldFn: async () => {},
    });
    assert.equal(result.refusals, refusalsBeforeCommitted, "every scripted refusal must be counted");
    assert.equal(result.regularReads, 1, "the committed read must be reached after the burst");
    assert.equal(result.bothObserved, true);
    assert.equal(result.deadlineElapsed, false);

    // Red-arming the defect with the SAME scripted reader: the pre-fix drive
    // shape (fixed 8000-read budget + instant both-outcomes assertion) concludes
    // regular=0 — exactly the loaded-host failure this fix removes.
    let legacyCalls = 0;
    let legacyRegular = 0;
    let legacyRefusals = 0;
    while (legacyCalls < 8000) {
      legacyCalls++;
      try {
        assert.match(scripted(legacyCalls), /^commit-\d+$/);
        legacyRegular++;
      } catch (err) {
        assert.ok(err instanceof ProgressResourceError && err.code === "progress_special_file");
        legacyRefusals++;
      }
    }
    assert.equal(legacyRegular, 0, "the pre-fix fixed read budget never reached the committed read");
    assert.equal(legacyRefusals, 8000);
  });

  it("churn supervision: a writer that alternates cleanly is observed on both outcomes and the drive stops immediately", async () => {
    const sequence = ["commit-7", "refusal", "commit-8"];
    let index = 0;
    const result = await superviseChurn({
      read: () => {
        const kind = sequence[Math.min(index, sequence.length - 1)];
        index++;
        return kind === "refusal" ? refusalPoint() : kind;
      },
      deadlineMs: 20000,
      yieldEvery: 8,
      now: () => index,
      yieldFn: async () => {},
    });
    assert.equal(result.reads, 2, "the drive must stop as soon as both outcomes are observed");
    assert.equal(result.regularReads, 1);
    assert.equal(result.refusals, 1);
    assert.equal(result.bothObserved, true);
    assert.equal(result.deadlineElapsed, false);
  });

  it("churn supervision: the safety invariants stay hard (outside target / non-committed content / vanished document / foreign error all fail the drive)", async () => {
    const base = { deadlineMs: 20000, yieldEvery: 8, now: () => 0, yieldFn: async () => {} };
    await assert.rejects(
      superviseChurn({ ...base, read: () => "OUTSIDE-SECRET" }),
      /outside symlink target must never be read/,
    );
    await assert.rejects(
      superviseChurn({ ...base, read: () => "commit-1\nwith extra bytes" }),
      /must be committed regular content/,
    );
    await assert.rejects(superviseChurn({ ...base, read: () => null }), /must always exist/);
    await assert.rejects(
      superviseChurn({
        ...base,
        read: () => {
          throw new ProgressResourceError("progress_doc_too_large", "scripted oversize refusal");
        },
      }),
      /scripted oversize refusal/,
    );
  });

  it("churn supervision: a refusal-only writer stays bounded (no hang) — the deadline stops the drive and bothObserved reports false", async () => {
    let ticks = 0;
    const result = await superviseChurn({
      read: () => refusalPoint(),
      deadlineMs: 500,
      yieldEvery: 64,
      now: () => (ticks += 25), // 25 fake ms per clock read: the deadline is reached deterministically
      yieldFn: async () => {},
    });
    assert.equal(result.regularReads, 0);
    assert.ok(result.refusals > 0, "the drive must keep reading until its bounded deadline");
    assert.equal(result.bothObserved, false);
    assert.equal(result.deadlineElapsed, true);
    assert.ok(result.elapsedMs <= 1000, `the drive must stay within its bound, elapsed=${result.elapsedMs}ms`);
  });
});
