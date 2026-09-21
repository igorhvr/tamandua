/**
 * vm-orphans.test.ts — MTLK-CLEANUP US-003 (bead tamandua-6sy.33.10.42).
 *
 * The bounded, atomic per-run orphan-VM record store that hands a VM which
 * could not be disposed to the reaper (US-006) and the run's completion
 * cleanup (US-007).
 *
 * Pure unit tests — no VM, no model, no child process. They import the
 * COMPILED module (build first: `npm run build`), which also keeps the
 * DEDC orphan-module guard green.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import {
  MAX_ORPHAN_STORE_BYTES,
  VmOrphanStoreError,
  assertSafeOrphanRunId,
  clearOrphanVm,
  isSafeOrphanVmId,
  readOrphanVms,
  resolveVmOrphanStore,
  writeOrphanVm,
} from "../../../dist/installer/matchlock/vm-orphans.js";

const RUN = "0e1131db-1111-2222-3333-444444444444";
const PREFIXED_RUN = `run-${RUN}`;
// A stable, non-temporary fixture HOME (the temp-dir guard forbids hardcoded
// temporary-root literals outside its allowlist; this is never a real path).
const HOME = "/var/lib/tamandua-runner/1000/h";
const VM_A = "vm-394274ee";
const VM_B = "vm-f9377c28";
const VM_C = "vm-1cb29b7c";

const tmpRoots: string[] = [];

function mkTmp(prefix: string): string {
  const dir = tamanduaTempDir(prefix);
  tmpRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpRoots.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

interface LogEntry {
  level: string;
  message: string;
  fields?: Record<string, unknown>;
}

function logSink(): { entries: LogEntry[]; onLog: (level: string, message: string, fields?: Record<string, unknown>) => void } {
  const entries: LogEntry[] = [];
  return {
    entries,
    onLog: (level, message, fields) => entries.push({ level, message, fields }),
  };
}

function baseInput(vmId: string, overrides: Record<string, unknown> = {}) {
  return {
    vmId,
    matchlockHome: HOME,
    invocationId: "f2c3107f-aaaa-bbbb-cccc-ddddeeeeffff",
    phase: "close",
    error: "matchlock error [phase=close vmId=vm-394274ee] name=MatchlockRpcError; code=-32000; message=boom",
    recordedAt: "2026-09-18T21:29:28.000Z",
    ...overrides,
  };
}

describe("vm-orphans store (MTLK-CLEANUP US-003)", () => {
  it("AC1: writeOrphanVm then readOrphanVms round-trips an exact record beside the run's evidence", () => {
    const runRoot = mkTmp("orphans-roundtrip-");
    const opts = { runId: PREFIXED_RUN, runRoot };

    const written = writeOrphanVm(
      baseInput(VM_A, { agentId: "feature-dev-merge_developer", round: "4", kind: "work" }),
      opts,
    );
    assert.ok(written, "write returns the persisted record");
    assert.equal(written.vmId, VM_A);
    assert.equal(written.matchlockHome, HOME);
    assert.equal(written.runId, RUN, "run id is normalized to bare");
    assert.equal(written.invocationId, "f2c3107f-aaaa-bbbb-cccc-ddddeeeeffff");
    assert.equal(written.phase, "close");
    assert.match(written.error, /-32000/);
    assert.equal(written.recordedAt, "2026-09-18T21:29:28.000Z");

    // The store sits beside the per-VM evidence dir, under the bare run id.
    const store = resolveVmOrphanStore(opts);
    assert.equal(store.file, path.join(runRoot, RUN, "matchlock", "orphans.json"));
    assert.equal(store.dir, path.join(runRoot, RUN, "matchlock"));
    assert.ok(fs.existsSync(store.file), "store file exists");

    const read = readOrphanVms(opts);
    assert.equal(read.length, 1);
    assert.deepEqual(read[0], written, "exact round-trip (vmId, home, run, invocation, phase, error, identity extras)");
  });

  it("AC2: writing the same vmId twice dedupes to one record (latest wins)", () => {
    const runRoot = mkTmp("orphans-dedupe-");
    const opts = { runId: RUN, runRoot };

    writeOrphanVm(baseInput(VM_A), opts);
    const second = writeOrphanVm(
      baseInput(VM_A, { phase: "dispose", error: "second serialized cause", recordedAt: "2026-09-18T22:00:00.000Z" }),
      opts,
    );
    assert.ok(second);

    const read = readOrphanVms(opts);
    assert.equal(read.length, 1, "one record per vmId");
    assert.equal(read[0].phase, "dispose");
    assert.equal(read[0].error, "second serialized cause");
    assert.equal(read[0].recordedAt, "2026-09-18T22:00:00.000Z");
  });

  it("AC2: clearing a vmId removes only that record; clearing an unknown vmId is a no-op", () => {
    const runRoot = mkTmp("orphans-clear-");
    const opts = { runId: RUN, runRoot };
    writeOrphanVm(baseInput(VM_A), opts);
    writeOrphanVm(baseInput(VM_B), opts);

    assert.equal(clearOrphanVm(VM_A, opts), true, "existing record cleared");
    const remaining = readOrphanVms(opts);
    assert.deepEqual(remaining.map((r) => r.vmId), [VM_B], "only VM_A removed");
    assert.equal(clearOrphanVm(VM_A, opts), false, "second clear is a no-op");
    assert.equal(clearOrphanVm("vm-never-recorded", opts), false);
    assert.deepEqual(readOrphanVms(opts).map((r) => r.vmId), [VM_B]);
  });

  it("AC3: an absent store yields an empty list and never throws", () => {
    const runRoot = mkTmp("orphans-absent-");
    const sink = logSink();
    const read = readOrphanVms({ runId: RUN, runRoot, onLog: sink.onLog });
    assert.deepEqual(read, []);
    assert.ok(
      sink.entries.some((e) => e.level === "info" && /absent/.test(e.message)),
      "reports the absent store as a bounded info diagnostic",
    );
  });

  it("AC3: malformed JSON yields a bounded warning diagnostic and an empty list, never a throw", () => {
    const runRoot = mkTmp("orphans-malformed-");
    const store = resolveVmOrphanStore({ runId: RUN, runRoot });
    fs.mkdirSync(store.dir, { recursive: true });
    fs.writeFileSync(store.file, "{ this is not json", "utf8");

    const sink = logSink();
    const read = readOrphanVms({ runId: RUN, runRoot, onLog: sink.onLog });
    assert.deepEqual(read, []);
    const warn = sink.entries.find((e) => e.level === "warn" && /malformed/.test(e.message));
    assert.ok(warn, "malformed store produces a warning");
    assert.equal(warn.fields?.file, store.file);
    assert.equal(typeof warn.fields?.error, "string");
    assert.ok((warn.fields?.error as string).length > 0);
  });

  it("AC3: a non-array top-level value is malformed; unusable entries are dropped, valid ones kept", () => {
    const runRoot = mkTmp("orphans-invalid-entries-");
    const store = resolveVmOrphanStore({ runId: RUN, runRoot });
    fs.mkdirSync(store.dir, { recursive: true });
    fs.writeFileSync(store.file, JSON.stringify({ not: "an array" }), "utf8");
    let sink = logSink();
    assert.deepEqual(readOrphanVms({ runId: RUN, runRoot, onLog: sink.onLog }), []);
    assert.ok(sink.entries.some((e) => e.level === "warn" && /malformed/.test(e.message)));

    const valid = {
      vmId: VM_B,
      matchlockHome: HOME,
      runId: RUN,
      invocationId: "inv-1",
      phase: "dispose",
      error: "bounded cause",
      recordedAt: "2026-09-18T22:00:00.000Z",
    };
    fs.writeFileSync(store.file, JSON.stringify([{ vmId: "../../escape" }, valid, 42]), "utf8");
    sink = logSink();
    const read = readOrphanVms({ runId: RUN, runRoot, onLog: sink.onLog });
    assert.deepEqual(read, [valid], "only the usable record survives");
    const dropped = sink.entries.find((e) => e.level === "warn" && /unusable/.test(e.message));
    assert.ok(dropped, "dropped entries are reported");
    assert.equal(dropped.fields?.dropped, 2);
  });

  it("AC3: an oversized store is refused with a bounded diagnostic", () => {
    const runRoot = mkTmp("orphans-oversized-");
    const store = resolveVmOrphanStore({ runId: RUN, runRoot });
    fs.mkdirSync(store.dir, { recursive: true });
    // Just past the bound, and also invalid JSON; the size guard fires first.
    fs.writeFileSync(store.file, `[${"x".repeat(MAX_ORPHAN_STORE_BYTES)}`, "utf8");
    const sink = logSink();
    assert.deepEqual(readOrphanVms({ runId: RUN, runRoot, onLog: sink.onLog }), []);
    const warn = sink.entries.find((e) => e.level === "warn" && /oversized/.test(e.message));
    assert.ok(warn, "oversized store is refused");
    assert.equal(warn.fields?.maxBytes, MAX_ORPHAN_STORE_BYTES);
  });

  it("AC4: an unsafe run id is refused and never writes outside the run root", () => {
    const runRoot = mkTmp("orphans-unsafe-run-");
    for (const bad of ["", "../escape", "../../etc/passwd", "run-../../x", "not-a-uuid", "0e1131db"]) {
      assert.throws(
        () => writeOrphanVm(baseInput(VM_A), { runId: bad, runRoot }),
        (err: unknown) => err instanceof VmOrphanStoreError && (err as VmOrphanStoreError).code === "invalid_run_id",
        `run id ${JSON.stringify(bad)} must be refused`,
      );
    }
    assert.equal(assertSafeOrphanRunId(PREFIXED_RUN), RUN);
    // Nothing escaped the run root.
    assert.equal(fs.existsSync(path.join(runRoot, "..", "escape")), false);
    assert.equal(fs.existsSync(path.join(runRoot, "escape")), false);
  });

  it("AC4: an unsafe vmId is refused per record and can never traverse the store dir", () => {
    const runRoot = mkTmp("orphans-unsafe-vm-");
    const opts = { runId: RUN, runRoot };
    for (const bad of ["", "..", ".", "a/b", "a\\b", "x\0y"]) {
      const sink = logSink();
      const written = writeOrphanVm(baseInput(bad), { ...opts, onLog: sink.onLog });
      assert.equal(written, null, `vm id ${JSON.stringify(bad)} must be refused`);
      assert.ok(sink.entries.some((e) => e.level === "warn"), "refusal is logged");
    }
    assert.equal(isSafeOrphanVmId(VM_A), true);
    assert.deepEqual(readOrphanVms(opts), []);
    assert.equal(fs.existsSync(path.join(runRoot, RUN, "escape")), false);
  });

  it("bounds the record count, dropping the oldest records and reporting it", () => {
    const runRoot = mkTmp("orphans-bounded-");
    const opts = { runId: RUN, runRoot, maxRecords: 2 };
    writeOrphanVm(baseInput(VM_A, { recordedAt: "2026-09-18T20:30:00.000Z" }), opts);
    writeOrphanVm(baseInput(VM_B, { recordedAt: "2026-09-18T20:48:00.000Z" }), opts);
    const sink = logSink();
    writeOrphanVm(baseInput(VM_C, { recordedAt: "2026-09-18T21:29:28.000Z" }), { ...opts, onLog: sink.onLog });

    const read = readOrphanVms(opts);
    assert.equal(read.length, 2, "record cap honored");
    assert.deepEqual(read.map((r) => r.vmId), [VM_B, VM_C], "oldest dropped");
    const warn = sink.entries.find((e) => e.level === "warn" && /cap reached/.test(e.message));
    assert.ok(warn, "eviction is reported");
    assert.match(String(warn.fields?.droppedVmIds), new RegExp(VM_A));
  });

  it("writes atomically: only orphans.json remains (no torn temp file)", () => {
    const runRoot = mkTmp("orphans-atomic-");
    const opts = { runId: RUN, runRoot };
    writeOrphanVm(baseInput(VM_A), opts);
    writeOrphanVm(baseInput(VM_B), opts);
    clearOrphanVm(VM_A, opts);
    const entries = fs.readdirSync(resolveVmOrphanStore(opts).dir);
    assert.deepEqual(entries, ["orphans.json"], "no temp file is left behind");
    // The file on disk is valid JSON.
    const parsed = JSON.parse(fs.readFileSync(resolveVmOrphanStore(opts).file, "utf8"));
    assert.ok(Array.isArray(parsed));
  });

  it("writes the store inside a fresh run dir (recursive create)", () => {
    const runRoot = mkTmp("orphans-mkdir-");
    const opts = { runId: RUN, runRoot: path.join(runRoot, "nested", "runs") };
    const written = writeOrphanVm(baseInput(VM_A), opts);
    assert.ok(written);
    assert.ok(fs.existsSync(resolveVmOrphanStore(opts).file));
  });
});
