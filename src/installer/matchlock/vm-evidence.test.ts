/**
 * vm-evidence.test.ts — MATCHLOCK-OBS US-003 (serial lane: the vm-evidence
 * seam spawns a fake matchlock CLI child process, so this file is classified
 * into the serial lane via its process-spawning source import).
 *
 * Everything is a local fixture: no VM, no real matchlock, no image, no model.
 * The fake CLI records its exact argv + effective HOME and snapshots the
 * evidence destination at spawn time, which lets the suite prove the copy
 * happened BEFORE `rm` ran.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { captureAndRemoveVm } from "../../../dist/installer/matchlock/vm-evidence.js";
import { MATCHLOCK_ERROR_TAIL_MAX_BYTES } from "../../../dist/installer/matchlock/runner-error.js";
import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";

/**
 * Fake `matchlock` CLI. Records one JSON line per invocation
 * (`{ argv, home, destListing, vmDirExists }`), optionally prints canned
 * stdout/stderr, optionally removes the VM state dir and exits with a chosen
 * code. `FAKE_KEEP_DIR=1` leaves the state dir in place.
 */
const FAKE_CLI = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const home = process.env.HOME || "";
const vmId = argv[argv.length - 1];
const vmDir = path.join(home, ".matchlock", "vms", vmId);

function list(dir, prefix) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...list(path.join(dir, entry.name), prefix + entry.name + "/"));
    else out.push(prefix + entry.name);
  }
  return out;
}

let destListing = null;
const destDir = process.env.FAKE_DEST_DIR;
if (destDir) {
  try { destListing = list(destDir, "").sort(); } catch { destListing = null; }
}

if (process.env.FAKE_RECORD) {
  fs.appendFileSync(
    process.env.FAKE_RECORD,
    JSON.stringify({ argv, home, destListing, vmDirExists: fs.existsSync(vmDir) }) + "\\n",
  );
}
if (process.env.FAKE_STDOUT) process.stdout.write(process.env.FAKE_STDOUT);
if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR);

const exit = Number(process.env.FAKE_EXIT || "0");
if (process.env.FAKE_KEEP_DIR !== "1" && argv.includes("rm")) {
  try { fs.rmSync(vmDir, { recursive: true, force: true }); } catch {}
}
process.exit(exit);
`;

interface FakeRecord {
  argv: string[];
  home: string;
  destListing: string[] | null;
  vmDirExists: boolean;
}

describe("captureAndRemoveVm (fake matchlock CLI)", () => {
  let tmpRoot: string;
  let fakeCli: string;

  before(() => {
    tmpRoot = tamanduaTempDir("tamandua-vm-evidence-");
    fakeCli = path.join(tmpRoot, "fake-matchlock");
    fs.writeFileSync(fakeCli, FAKE_CLI, "utf-8");
    fs.chmodSync(fakeCli, 0o755);
  });

  after(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** Create a fake VM state dir at <home>/.matchlock/vms/<vmId>/. */
  function makeVm(
    homeName: string,
    vmId: string,
    extras: Record<string, string> = {},
  ): { home: string; vmDir: string } {
    const home = path.join(tmpRoot, homeName);
    const vmDir = path.join(home, ".matchlock", "vms", vmId);
    fs.mkdirSync(path.join(vmDir, "logs"), { recursive: true });
    fs.writeFileSync(path.join(vmDir, "config.json"), `{"vm":"${vmId}"}\n`, "utf-8");
    for (const [relative, body] of Object.entries(extras)) {
      const target = path.join(vmDir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body, "utf-8");
    }
    return { home, vmDir };
  }

  function readRecords(recordPath: string): FakeRecord[] {
    if (!fs.existsSync(recordPath)) return [];
    return fs
      .readFileSync(recordPath, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as FakeRecord);
  }

  it("copies config.json + logs/* BEFORE spawning `rm` with the exact argv and HOME", () => {
    const vmId = "vm-11111111";
    const { home, vmDir } = makeVm("home-success", vmId, {
      "logs/round.log": "round-log\n",
      "logs/nested/deep.log": "deep-log\n",
    });
    const destinationDir = path.join(tmpRoot, "evidence-success");
    const recordPath = path.join(tmpRoot, "record-success.jsonl");
    const logs: string[] = [];

    const result = captureAndRemoveVm({
      vmId,
      matchlockHome: home,
      destinationDir,
      cliBinaryPath: fakeCli,
      cliArgsPrefix: ["--alpha", "--beta"],
      env: { FAKE_RECORD: recordPath, FAKE_DEST_DIR: destinationDir, HOME: "/definitely/not/the/home" },
      onLog: (level, message) => logs.push(`${level}:${message}`),
    });

    assert.equal(result.vmId, vmId);
    assert.equal(result.removed, true);
    assert.equal(result.logsCopiedTo, destinationDir);
    assert.equal(result.removalExitCode, 0);
    assert.equal(result.removalError, undefined);

    // Evidence copied verbatim (config re-written into the destination).
    assert.equal(fs.readFileSync(path.join(destinationDir, "config.json"), "utf-8"), `{"vm":"${vmId}"}\n`);
    assert.equal(fs.readFileSync(path.join(destinationDir, "logs", "round.log"), "utf-8"), "round-log\n");
    assert.equal(fs.readFileSync(path.join(destinationDir, "logs", "nested", "deep.log"), "utf-8"), "deep-log\n");

    // VM state dir removed.
    assert.equal(fs.existsSync(vmDir), false);

    // Exactly one child ran, with the prefix + rm + the exact vm id, HOME forced.
    const records = readRecords(recordPath);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].argv, ["--alpha", "--beta", "rm", vmId]);
    assert.equal(records[0].home, home);
    assert.equal(records[0].vmDirExists, true);
    // Ordering proof: the destination already held the evidence when rm spawned.
    assert.deepEqual(records[0].destListing, [
      "config.json",
      "logs/nested/deep.log",
      "logs/round.log",
    ]);
    assert.ok(logs.some((entry) => entry.startsWith("info:")), `expected an info log, got ${JSON.stringify(logs)}`);
  });

  it("spawns `rm` with the default argv (no prefix) and a plain HOME", () => {
    const vmId = "vm-1a1a1a1a";
    const { home, vmDir } = makeVm("home-default-prefix", vmId, { "logs/only.log": "only\n" });
    const destinationDir = path.join(tmpRoot, "evidence-default-prefix");
    const recordPath = path.join(tmpRoot, "record-default-prefix.jsonl");

    const result = captureAndRemoveVm({
      vmId,
      matchlockHome: home,
      destinationDir,
      cliBinaryPath: fakeCli,
      env: { FAKE_RECORD: recordPath },
    });

    assert.equal(result.removed, true);
    const records = readRecords(recordPath);
    assert.deepEqual(records[0].argv, ["rm", vmId]);
    assert.equal(records[0].home, home);
    assert.equal(fs.existsSync(vmDir), false);
  });

  it("keeps copied evidence and returns removed:false + bounded removalError on a non-zero rm", () => {
    const vmId = "vm-22222222";
    const { home, vmDir } = makeVm("home-fail", vmId, { "logs/keep.log": "keep-me\n" });
    const destinationDir = path.join(tmpRoot, "evidence-fail");
    const recordPath = path.join(tmpRoot, "record-fail.jsonl");
    const warns: string[] = [];

    const result = captureAndRemoveVm({
      vmId,
      matchlockHome: home,
      destinationDir,
      cliBinaryPath: fakeCli,
      env: {
        FAKE_RECORD: recordPath,
        FAKE_DEST_DIR: destinationDir,
        FAKE_EXIT: "7",
        FAKE_KEEP_DIR: "1",
        FAKE_STDERR: "boom: rm refused",
      },
      onLog: (level, message) => {
        if (level === "warn") warns.push(message);
      },
    });

    assert.equal(result.removed, false);
    assert.equal(result.removalExitCode, 7);
    assert.ok(result.removalError, "a genuine failure must carry a removalError");
    assert.ok(result.removalError!.includes("boom: rm refused"), result.removalError);
    // Copied evidence is retained on failure; VM dir is untouched.
    assert.equal(fs.existsSync(path.join(destinationDir, "logs", "keep.log")), true);
    assert.equal(fs.existsSync(vmDir), true);
    assert.ok(warns.length >= 1, "a removal failure must be logged");
  });

  it("bounds a very large removal error", () => {
    const vmId = "vm-2b2b2b2b";
    const { home } = makeVm("home-bounded", vmId, { "logs/b.log": "b\n" });
    const destinationDir = path.join(tmpRoot, "evidence-bounded");

    const result = captureAndRemoveVm({
      vmId,
      matchlockHome: home,
      destinationDir,
      cliBinaryPath: fakeCli,
      env: {
        FAKE_DEST_DIR: destinationDir,
        FAKE_EXIT: "9",
        FAKE_KEEP_DIR: "1",
        FAKE_STDERR: "E".repeat(20_000),
      },
    });

    assert.equal(result.removed, false);
    assert.ok(result.removalError);
    assert.ok(
      Buffer.byteLength(result.removalError!, "utf8") <= MATCHLOCK_ERROR_TAIL_MAX_BYTES,
      `removalError must be bounded, got ${Buffer.byteLength(result.removalError!, "utf8")} bytes`,
    );
  });

  it("treats an already-absent VM state dir as removed:true without spawning and with no fabricated error", () => {
    const vmId = "vm-33333333";
    const home = path.join(tmpRoot, "home-absent");
    fs.mkdirSync(path.join(home, ".matchlock", "vms"), { recursive: true });
    const destinationDir = path.join(tmpRoot, "evidence-absent");
    const recordPath = path.join(tmpRoot, "record-absent.jsonl");

    const result = captureAndRemoveVm({
      vmId,
      matchlockHome: home,
      destinationDir,
      cliBinaryPath: fakeCli,
      env: { FAKE_RECORD: recordPath },
    });

    assert.equal(result.removed, true);
    assert.equal(result.removalError, undefined);
    assert.equal(result.removalExitCode, null);
    assert.equal(result.logsCopiedTo, null);
    assert.equal(fs.existsSync(recordPath), false, "no rm child may spawn for an absent state dir");
    assert.equal(fs.existsSync(destinationDir), false);
  });

  it("treats an rm result that reports the VM already gone as removed:true", () => {
    const vmId = "vm-44444444";
    const { home } = makeVm("home-gone", vmId, { "logs/x.log": "x\n" });
    const destinationDir = path.join(tmpRoot, "evidence-gone");
    const recordPath = path.join(tmpRoot, "record-gone.jsonl");

    const result = captureAndRemoveVm({
      vmId,
      matchlockHome: home,
      destinationDir,
      cliBinaryPath: fakeCli,
      env: {
        FAKE_RECORD: recordPath,
        FAKE_DEST_DIR: destinationDir,
        FAKE_EXIT: "1",
        FAKE_KEEP_DIR: "1",
        FAKE_STDERR: "error: no such VM: not found (already removed)",
      },
    });

    assert.equal(result.removed, true);
    assert.equal(result.removalError, undefined, "already-gone must not fabricate an error");
    assert.equal(result.removalExitCode, 1);
    assert.equal(result.logsCopiedTo, destinationDir);
  });

  it("never follows a symlink out of the VM dir when copying evidence", () => {
    const vmId = "vm-55555555";
    const { home, vmDir } = makeVm("home-symlink", vmId, { "logs/real.log": "real\n" });
    const outsideFile = path.join(tmpRoot, "outside-secret.txt");
    fs.writeFileSync(outsideFile, "TOP-SECRET\n", "utf-8");
    const outsideDir = path.join(tmpRoot, "outside-dir");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "hidden.log"), "HIDDEN\n", "utf-8");
    fs.symlinkSync(outsideFile, path.join(vmDir, "logs", "escape-file.log"));
    fs.symlinkSync(outsideDir, path.join(vmDir, "logs", "escape-dir"));

    const destinationDir = path.join(tmpRoot, "evidence-symlink");
    const result = captureAndRemoveVm({
      vmId,
      matchlockHome: home,
      destinationDir,
      cliBinaryPath: fakeCli,
      env: { FAKE_RECORD: path.join(tmpRoot, "record-symlink.jsonl") },
    });

    assert.equal(result.removed, true);
    assert.equal(fs.readFileSync(path.join(destinationDir, "logs", "real.log"), "utf-8"), "real\n");
    assert.equal(fs.existsSync(path.join(destinationDir, "logs", "escape-file.log")), false);
    assert.equal(fs.existsSync(path.join(destinationDir, "logs", "escape-dir")), false);
    // The outside secret content must not appear anywhere under the destination.
    const copied = fs
      .readdirSync(path.join(destinationDir, "logs"), { recursive: true })
      .map((entry) => String(entry));
    assert.ok(!copied.some((entry) => entry.includes("secret") || entry.includes("hidden")), copied.join(","));
  });

  it("never throws and reports a failure when the CLI binary is missing", () => {
    const vmId = "vm-77777777";
    const { home } = makeVm("home-missing-cli", vmId, { "logs/m.log": "m\n" });
    const destinationDir = path.join(tmpRoot, "evidence-missing-cli");

    const result = captureAndRemoveVm({
      vmId,
      matchlockHome: home,
      destinationDir,
      cliBinaryPath: path.join(tmpRoot, "does-not-exist-matchlock"),
      env: { FAKE_DEST_DIR: destinationDir },
    });

    assert.equal(result.removed, false);
    assert.ok(result.removalError);
    // The already-captured evidence survives the failed removal.
    assert.equal(fs.existsSync(path.join(destinationDir, "logs", "m.log")), true);
  });

  it("refuses an unsafe/empty vm id without spawning or throwing", () => {
    const destinationDir = path.join(tmpRoot, "evidence-bad-id");
    const recordPath = path.join(tmpRoot, "record-bad-id.jsonl");

    for (const vmId of ["", "..", "../escape", "a/b", "a\\b"]) {
      const result = captureAndRemoveVm({
        vmId,
        matchlockHome: tmpRoot,
        destinationDir,
        cliBinaryPath: fakeCli,
        env: { FAKE_RECORD: recordPath },
      });
      assert.equal(result.removed, false, `vmId ${JSON.stringify(vmId)} must not be removed`);
      assert.ok(result.removalError, `vmId ${JSON.stringify(vmId)} must carry a removalError`);
    }
    assert.equal(fs.existsSync(recordPath), false, "no child may spawn for an invalid vm id");
  });
});
