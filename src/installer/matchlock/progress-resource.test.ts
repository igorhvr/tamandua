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
import { execFile, spawn } from "node:child_process";
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

    // Phase 2 — a child process flips the leaf between committed regular
    // content and an outside symlink as fast as it can while the host reads
    // concurrently; this genuinely exercises the lstat->O_NOFOLLOW-open window
    // at the OS level. Every host read must be a committed regular content
    // string (any of the child's commit-N) or a progress_special_file refusal;
    // the outside target is never read and nothing hangs.
    const flips = 2500;
    const childSrc = [
      "const fs = require('fs');",
      "const doc = process.argv[1];",
      "const outside = process.argv[2];",
      "const n = Number(process.argv[3]);",
      "const tmp = doc + '.flip-tmp';",
      "for (let i = 1; i <= n; i++) {",
      "  fs.writeFileSync(tmp, 'commit-' + i);",
      "  fs.renameSync(tmp, doc);",
      "  const lnk = doc + '.flip-lnk';",
      "  try { fs.unlinkSync(lnk); } catch (e) {}",
      "  fs.symlinkSync(outside, lnk);",
      "  fs.renameSync(lnk, doc);",
      "}",
    ].join("\n");
    const child = spawn(process.execPath, ["-e", childSrc, doc, outside, String(flips)], {
      stdio: "ignore",
    });
    let regularReads = 0;
    let refusals = 0;
    const t0 = Date.now();
    const deadlineMs = 20000;
    let reads = 0;
    try {
      while (reads < 8000 && Date.now() - t0 < deadlineMs) {
        reads++;
        try {
          const text = access.readText();
          assert.ok(text !== null, "the flipper uses rename-over, so the doc must always exist");
          assert.notEqual(text, "OUTSIDE-SECRET", "the outside symlink target must never be read");
          assert.match(text, /^commit-\d+$/, `host read must be committed regular content, got: ${JSON.stringify(text)}`);
          regularReads++;
        } catch (err) {
          assert.ok(
            err instanceof ProgressResourceError && err.code === "progress_special_file",
            `expected a refusal or committed content, got: ${(err as Error).message}`,
          );
          refusals++;
        }
        if (reads % 16 === 0) {
          // Yield so the child flipper gets CPU; keeps the race real and bounded.
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
      // Give the child a bounded chance to finish, then stop it.
      const exitPromise = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      const finished = await Promise.race([
        exitPromise,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5000)),
      ]);
      if (finished === "timeout") child.kill();
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await new Promise<void>((resolve) => {
          if (child.exitCode !== null) return resolve();
          child.once("exit", () => resolve());
        });
      }
    }
    assert.ok(Date.now() - t0 < deadlineMs, "swap stress must stay bounded (no hang)");
    assert.ok(regularReads > 0 && refusals > 0, `phase2 must observe both committed reads and refusals (regular=${regularReads}, refusals=${refusals})`);
    assert.equal(fs.readFileSync(outside, "utf8"), "OUTSIDE-SECRET", "outside target must be untouched");
    // The host can always recover by atomic replace over whatever entry exists.
    access.commitText("host-restored\n");
    assert.equal(access.readText(), "host-restored\n");
  });
});
