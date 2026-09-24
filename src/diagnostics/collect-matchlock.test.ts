/**
 * DIAG-PRUNE US-008 — unit tests for the Matchlock diagnostics collector.
 *
 * All fixtures are real files under isolated temp dirs; no process env is
 * mutated and no real Matchlock VM/store is touched. The collector is
 * Node-core only (plus the Node-core-only paths/redact/vm-orphans leaves), so
 * this file stays in the parallel lane.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import {
  collectMatchlock,
  MAX_MATCHLOCK_ERROR_RECORDS,
} from "../../dist/diagnostics/collect-matchlock.js";

const RUN_ID = "dff0c254-3e7e-4767-9a66-489e8dbdd90e";

const created: string[] = [];

function makeStateDir(prefix: string): string {
  const dir = tamanduaTempDir(prefix);
  created.push(dir);
  return dir;
}

after(() => {
  for (const dir of created) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeFile(full: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function matchlockDir(stateDir: string): string {
  return path.join(stateDir, "runs", RUN_ID, "matchlock");
}

describe("collectMatchlock — Matchlock-shaped run", () => {
  it("lists VM evidence dirs and console/serial logs with sizes", () => {
    const stateDir = makeStateDir("diag-matchlock-vm-");
    const vmDir = path.join(matchlockDir(stateDir), "vm-394274ee");
    writeFile(path.join(vmDir, "config.json"), "{\"machine\":\"fixture\"}");
    writeFile(path.join(vmDir, "console.log"), "console-bytes");
    writeFile(path.join(vmDir, "serial.log"), "serial-bytes-longer");
    writeFile(path.join(vmDir, "logs", "firecracker.log"), "fc");

    const policyJson = JSON.stringify({
      version: 2,
      harness: "pi",
      requestedImage: "igorhvr/bedlam-ubuntu",
      mounts: [{ hostPath: "/work", guestPath: "/work" }],
    });

    const result = collectMatchlock({
      stateDir,
      runId: `run-${RUN_ID}`,
      policyJson,
    });

    assert.equal(result.status, "present");
    assert.equal(result.policyStatus, "present");
    assert.equal(result.vms.length, 1);
    const vm = result.vms[0];
    assert.equal(vm.vmId, "vm-394274ee");
    assert.equal(vm.dir, vmDir);
    assert.equal(vm.status, "present");
    assert.deepEqual(
      vm.logs.map((entry) => entry.path),
      ["config.json", "console.log", "logs/firecracker.log", "serial.log"],
    );
    assert.equal(
      vm.logs.find((entry) => entry.path === "console.log")?.sizeBytes,
      "console-bytes".length,
    );
    assert.equal(
      vm.logs.find((entry) => entry.path === "serial.log")?.sizeBytes,
      "serial-bytes-longer".length,
    );
    assert.equal(vm.totalBytes, vm.logs.reduce((sum, e) => sum + e.sizeBytes, 0));

    assert.deepEqual(
      result.consoleLogs.map((entry) => entry.path),
      [
        "vm-394274ee/config.json",
        "vm-394274ee/console.log",
        "vm-394274ee/logs/firecracker.log",
        "vm-394274ee/serial.log",
      ],
    );
  });

  it("reads and parses orphans.json plus other runner error records", () => {
    const stateDir = makeStateDir("diag-matchlock-records-");
    const dir = matchlockDir(stateDir);
    const orphans = [
      {
        vmId: "vm-394274ee",
        matchlockHome: "/home/kaladin",
        runId: RUN_ID,
        invocationId: "inv-1",
        phase: "close",
        error: "matchlock error [phase=close vmId=vm-394274ee]",
        recordedAt: "2026-09-23T00:00:00.000Z",
      },
    ];
    writeFile(path.join(dir, "orphans.json"), JSON.stringify(orphans));
    writeFile(
      path.join(dir, "round-error.json"),
      JSON.stringify({ code: -32000, message: "boom" }),
    );
    // A directory named *.json must be reported, not read.
    fs.mkdirSync(path.join(dir, "nested.json"), { recursive: true });

    const result = collectMatchlock({
      stateDir,
      runId: RUN_ID,
      policyJson: JSON.stringify({ version: 2, harness: "pi" }),
    });

    assert.equal(result.status, "present");
    const orphanRecord = result.errorRecords.find(
      (record) => path.basename(record.path) === "orphans.json",
    );
    assert.ok(orphanRecord, "orphans.json is represented");
    assert.equal(orphanRecord.status, "present");
    assert.deepEqual(orphanRecord.record, orphans);

    const roundRecord = result.errorRecords.find(
      (record) => path.basename(record.path) === "round-error.json",
    );
    assert.ok(roundRecord);
    assert.equal(roundRecord.status, "present");
    assert.deepEqual(roundRecord.record, { code: -32000, message: "boom" });

    const nestedRecord = result.errorRecords.find(
      (record) => path.basename(record.path) === "nested.json",
    );
    assert.ok(nestedRecord);
    assert.equal(nestedRecord.status, "absent");
    assert.match(nestedRecord.error ?? "", /not a regular file/);
  });

  it("reports a malformed runner record without throwing", () => {
    const stateDir = makeStateDir("diag-matchlock-badrecord-");
    const dir = matchlockDir(stateDir);
    writeFile(path.join(dir, "orphans.json"), "{not json");

    const result = collectMatchlock({ stateDir, runId: RUN_ID });

    assert.equal(result.status, "absent");
    assert.equal(result.errorRecords.length, 1);
    assert.equal(result.errorRecords[0].status, "absent");
    assert.match(result.errorRecords[0].error ?? "", /malformed JSON/);
  });

  it("reports an empty VM evidence dir as empty", () => {
    const stateDir = makeStateDir("diag-matchlock-emptyvm-");
    fs.mkdirSync(path.join(matchlockDir(stateDir), "vm-aaaaaaaa"), {
      recursive: true,
    });

    const result = collectMatchlock({ stateDir, runId: RUN_ID });

    assert.equal(result.status, "present");
    assert.equal(result.vms.length, 1);
    assert.equal(result.vms[0].status, "empty");
    assert.deepEqual(result.vms[0].logs, []);
    assert.equal(result.vms[0].totalBytes, 0);
    assert.deepEqual(result.consoleLogs, []);
  });

  it("bounds the number of retained runner error records", () => {
    const stateDir = makeStateDir("diag-matchlock-bound-");
    const dir = matchlockDir(stateDir);
    for (let i = 0; i < MAX_MATCHLOCK_ERROR_RECORDS + 5; i += 1) {
      writeFile(path.join(dir, `record-${String(i).padStart(3, "0")}.json`), "{}");
    }

    const result = collectMatchlock({ stateDir, runId: RUN_ID });

    assert.equal(result.errorRecords.length, MAX_MATCHLOCK_ERROR_RECORDS);
    assert.match(result.absenceReason ?? "", /capped/);
  });
});

describe("collectMatchlock — secret redaction", () => {
  it("redacts secret-looking fields in the policy", () => {
    const stateDir = makeStateDir("diag-matchlock-policy-redact-");
    const policyJson = JSON.stringify({
      version: 2,
      harness: "pi",
      requestedImage: "igorhvr/bedlam-ubuntu",
      registryToken: "super-secret-token",
      nested: { apiKey: "key-123", region: "eu" },
      auth: [{ authorization: "Bearer abc", scope: "read" }],
    });

    const result = collectMatchlock({ stateDir, runId: RUN_ID, policyJson });

    const policy = result.policy as Record<string, unknown>;
    assert.equal(result.policyStatus, "present");
    assert.equal(policy.requestedImage, "igorhvr/bedlam-ubuntu");
    assert.equal(policy.registryToken, "<redacted>");
    assert.deepEqual(policy.nested, { apiKey: "<redacted>", region: "eu" });
    assert.deepEqual(policy.auth, [{ authorization: "<redacted>", scope: "read" }]);
  });

  it("redacts secret-looking fields in the runner error records", () => {
    const stateDir = makeStateDir("diag-matchlock-record-redact-");
    const dir = matchlockDir(stateDir);
    writeFile(
      path.join(dir, "round-error.json"),
      JSON.stringify({
        code: -32000,
        message: "boom",
        credential: "hunter2",
        nested: { secret: "s3cr3t", keep: 1 },
      }),
    );

    const result = collectMatchlock({
      stateDir,
      runId: RUN_ID,
      policyJson: JSON.stringify({ version: 2 }),
    });

    const record = result.errorRecords.find(
      (entry) => path.basename(entry.path) === "round-error.json",
    );
    assert.ok(record);
    assert.equal(record.status, "present");
    assert.deepEqual(record.record, {
      code: -32000,
      message: "boom",
      credential: "<redacted>",
      nested: { secret: "<redacted>", keep: 1 },
    });
  });

  it("does not mutate the on-disk policy or record files", () => {
    const stateDir = makeStateDir("diag-matchlock-immutable-");
    const dir = matchlockDir(stateDir);
    const policyJson = JSON.stringify({ token: "abc", image: "x" });
    const recordPath = path.join(dir, "orphans.json");
    writeFile(recordPath, JSON.stringify([{ vmId: "vm-1", secret: "s" }]));

    collectMatchlock({ stateDir, runId: RUN_ID, policyJson });

    assert.equal(fs.readFileSync(recordPath, "utf8"), JSON.stringify([{ vmId: "vm-1", secret: "s" }]));
  });
});

describe("collectMatchlock — native and malformed policies", () => {
  it("returns absent for a native run with a NULL policy and no matchlock dir", () => {
    const stateDir = makeStateDir("diag-matchlock-native-");

    const result = collectMatchlock({
      stateDir,
      runId: RUN_ID,
      policyJson: null,
    });

    assert.equal(result.status, "absent");
    assert.equal(result.policyStatus, "absent");
    assert.equal(result.policy, null);
    assert.deepEqual(result.vms, []);
    assert.deepEqual(result.consoleLogs, []);
    assert.deepEqual(result.errorRecords, []);
    assert.match(result.absenceReason ?? "", /native run/);
  });

  it("returns absent for a malformed policy without throwing", () => {
    const stateDir = makeStateDir("diag-matchlock-malformed-");

    const result = collectMatchlock({
      stateDir,
      runId: RUN_ID,
      policyJson: "{definitely not json",
    });

    assert.equal(result.status, "absent");
    assert.equal(result.policyStatus, "absent");
    assert.equal(result.policy, null);
    assert.match(result.absenceReason ?? "", /malformed matchlock policy/);
  });

  it("returns absent for an empty policy string", () => {
    const stateDir = makeStateDir("diag-matchlock-empty-policy-");

    const result = collectMatchlock({ stateDir, runId: RUN_ID, policyJson: "   " });

    assert.equal(result.status, "absent");
    assert.equal(result.policyStatus, "absent");
  });

  it("keeps status present for a valid policy with no Matchlock evidence dir", () => {
    const stateDir = makeStateDir("diag-matchlock-policy-only-");

    const result = collectMatchlock({
      stateDir,
      runId: RUN_ID,
      policyJson: JSON.stringify({ version: 2, harness: "pi" }),
    });

    assert.equal(result.status, "present");
    assert.equal(result.policyStatus, "present");
    assert.deepEqual(result.vms, []);
    assert.match(result.absenceReason ?? "", /matchlock evidence directory not found/);
  });

  it("resolves the evidence dir from a run- prefixed or bare run id", () => {
    const stateDir = makeStateDir("diag-matchlock-id-");
    writeFile(
      path.join(matchlockDir(stateDir), "vm-11112222", "console.log"),
      "x",
    );

    const prefixed = collectMatchlock({ stateDir, runId: `run-${RUN_ID}` });
    const bare = collectMatchlock({ stateDir, bareRunId: RUN_ID });

    assert.equal(prefixed.vms.length, 1);
    assert.equal(bare.vms.length, 1);
    assert.equal(bare.vms[0].vmId, "vm-11112222");
  });
});