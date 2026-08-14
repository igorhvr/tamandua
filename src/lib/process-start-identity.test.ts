/**
 * Tests for src/lib/process-start-identity.ts — stable process-start identity
 * (procfs starttime on linux, `ps -o lstart=` on darwin, null elsewhere).
 *
 * Classified as serial: imports node:child_process (spawnSync) for the
 * certainly-dead-pid case.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { getProcessStartIdentity } from "./process-start-identity.ts";

describe("getProcessStartIdentity", () => {
  it("reads a non-null, stable start identity for the current process", () => {
    const first = getProcessStartIdentity(process.pid);
    assert.ok(first !== null, "start identity must be computable for the current process");
    assert.equal(getProcessStartIdentity(process.pid), first);
  });

  it("uses the current platform's identity format", () => {
    const first = getProcessStartIdentity(process.pid);
    if (process.platform === "linux") {
      assert.ok(first !== null, "start identity must be computable on linux");
      assert.ok(first.startsWith("proc:"), `expected proc: prefix on linux, got: ${first}`);
    } else if (process.platform === "darwin") {
      assert.ok(first !== null, "start identity must be computable on darwin");
      assert.ok(first.startsWith("ps:"), `expected ps: prefix on darwin, got: ${first}`);
    } else {
      assert.equal(first, null, "identity must be null on unsupported platforms");
    }
  });

  it("returns null for a certainly-dead pid", { skip: process.platform !== "linux" }, () => {
    const child = spawnSync(process.execPath, ["-e", ""]);
    assert.equal(child.status, 0, "short-lived child must exit cleanly");
    assert.equal(getProcessStartIdentity(child.pid), null, "procfs entry is gone after exit");
  });
});
