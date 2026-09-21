/**
 * DSH-OVERLAY-FSYNC-FIX US-002 — fast-lane (no VM) coverage for the PURE
 * host-side trace parser / mount reconciler / wrapper builder used by the
 * on-demand in-VM dsh `fsync ENOENT` diagnosis gate.
 *
 * The real VM gate (e2e-tests/matchlock-dsh-fsync-diagnosis.test.ts) is NOT
 * part of npm test; these tests mechanically pin the parsing logic that turns
 * the guest's raw strace log into the exact failing syscall/path.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DSH_FSYNC_DIAG_FSYNC_BEGIN,
  DSH_FSYNC_DIAG_FSYNC_END,
  DSH_FSYNC_DIAG_MOUNTS_BEGIN,
  DSH_FSYNC_DIAG_MOUNTS_END,
  DSH_FSYNC_DIAG_REAL_DSH_MARKER,
  DSH_FSYNC_DIAG_STRACE_BEGIN,
  DSH_FSYNC_DIAG_STRACE_END,
  DSH_FSYNC_DIAG_STRACE_PROBE_FAILED_MARKER,
  DSH_FSYNC_DIAG_TRACE_METHOD_MARKER,
  buildDshFsyncNodeShimScript,
  buildDshStraceWrapperScript,
  extractMarkedSection,
  extractMarkerValue,
  mountsUnderRoot,
  parseDshFsyncTrace,
  parseGuestMountTable,
  reconcileObservedMountsWithPlan,
} from "../e2e-tests/helpers/matchlock-dsh-fsync-trace.ts";

const GUEST_ROOT = "/workspace/config/dsh";

describe("dsh fsync diagnosis trace parser (pure)", () => {
  it("recovers the exact path from an -y annotated failing fsync", () => {
    const trace = [
      "TAMANDUA_DIAG_REAL_DSH=/usr/local/bin/dsh",
      "TAMANDUA_DIAG_TRACE_METHOD=guest-strace",
      DSH_FSYNC_DIAG_STRACE_BEGIN,
      "1234  openat(AT_FDCWD, \"/workspace/config/dsh/storages/session_projcache/sessions/session-x.json\", O_RDWR) = -1 ENOENT (No such file or directory)",
      "1234  fsync(7</workspace/config/dsh/sessions/--workspace-project--/session-a/session.v3.jsonl.zstd>) = -1 ENOENT (No such file or directory)",
      DSH_FSYNC_DIAG_STRACE_END,
    ].join("\n");
    const finding = parseDshFsyncTrace(trace);
    assert.equal(finding.traceMethod, "guest-strace");
    assert.equal(finding.realDshBinary, "/usr/local/bin/dsh");
    assert.equal(finding.failingSyscall, "fsync");
    assert.equal(finding.fd, 7);
    assert.equal(
      finding.exactPath,
      "/workspace/config/dsh/sessions/--workspace-project--/session-a/session.v3.jsonl.zstd",
    );
    assert.equal(finding.targetPathOrFd, finding.exactPath);
    assert.equal(finding.enoentFsyncs.length, 1);
    assert.equal(finding.failedCalls.length, 1);
    assert.match(finding.failedCalls[0].rawLine, /openat\(/);
  });

  it("reconstructs fd -> path from a preceding successful openat when -y is absent", () => {
    const trace = [
      "777  openat(AT_FDCWD, \"/workspace/config/dsh/storages/session_projcache/sessions/session-1.json\", O_WRONLY|O_CREAT, 0600) = 12",
      "777  fdatasync(12) = -1 ENOENT (No such file or directory)",
    ].join("\n");
    const finding = parseDshFsyncTrace(trace);
    assert.equal(finding.failingSyscall, "fdatasync");
    assert.equal(finding.fd, 12);
    assert.equal(
      finding.exactPath,
      "/workspace/config/dsh/storages/session_projcache/sessions/session-1.json",
    );
  });

  it("handles strace `[pid N]` prefixes as well as the bare pid prefix", () => {
    const trace = [
      "[pid 42] openat(AT_FDCWD, \"/workspace/config/dsh/storages/a.json\", O_RDWR) = 5",
      "[pid 42] fsync(5) = -1 ENOENT (No such file or directory)",
    ].join("\n");
    const finding = parseDshFsyncTrace(trace);
    assert.equal(finding.failingSyscall, "fsync");
    assert.equal(finding.fd, 5);
    assert.equal(finding.exactPath, "/workspace/config/dsh/storages/a.json");
  });

  it("recovers the exact path from the Node fsync interposer when ptrace is denied", () => {
    const trace = [
      "TAMANDUA_DIAG_TRACE_METHOD=guest-node-fs-shim",
      "TAMANDUA_DIAG_STRACE_PROBE_FAILED=strace: PTRACE_TRACEME: Operation not permitted",
      "TAMANDUA_DIAG_FSYNC_BEGIN",
      "SYNC_FAIL syscall=fsync fd=19 path=/workspace/config/dsh/sessions/--workspace-proj--/session-a/session.v3.jsonl.zstd err=ENOENT message=ENOENT: no such file or directory, fsync",
      "TAMANDUA_DIAG_FSYNC_END",
    ].join("\n");
    const finding = parseDshFsyncTrace(trace);
    assert.equal(finding.traceMethod, "guest-node-fs-shim");
    assert.match(finding.straceProbeFailure ?? "", /PTRACE_TRACEME/);
    assert.equal(finding.failingSyscall, "fsync");
    assert.equal(finding.fd, 19);
    assert.equal(
      finding.exactPath,
      "/workspace/config/dsh/sessions/--workspace-proj--/session-a/session.v3.jsonl.zstd",
    );
    assert.equal(finding.enoentFsyncs[0].source, "node-fs-shim");
  });

  it("distinguishes a non-ENOENT shim failure (recorded, not treated as the dead-end)", () => {
    const trace = [
      "TAMANDUA_DIAG_FSYNC_BEGIN",
      "SYNC_FAIL syscall=fsync fd=3 path=/workspace/config/dsh/x err=EIO message=fsync EIO",
      "SYNC_FAIL syscall=fdatasync fd=4 path=/workspace/config/dsh/y err=ENOENT message=fsync ENOENT",
      "TAMANDUA_DIAG_FSYNC_END",
    ].join("\n");
    const finding = parseDshFsyncTrace(trace);
    assert.equal(finding.failingSyscall, "fdatasync");
    assert.equal(finding.fd, 4);
    assert.equal(finding.exactPath, "/workspace/config/dsh/y");
    assert.equal(finding.failedCalls.length, 1);
    assert.equal(finding.failedCalls[0].errno, "EIO");
  });

  it("prefers the first ENOENT fsync and keeps every failed call", () => {
    const trace = [
      "1  fsync(3</a>) = 0",
      "1  fsync(4</workspace/config/dsh/sessions/s1>) = -1 ENOENT (No such file or directory)",
      "1  fsync(5</workspace/config/dsh/sessions/s2>) = -1 ENOENT (No such file or directory)",
      "1  mkdir(\"/workspace/config/dsh/sessions/new\", 0700) = -1 ENOENT (No such file or directory)",
    ].join("\n");
    const finding = parseDshFsyncTrace(trace);
    assert.equal(finding.failingSyscall, "fsync");
    assert.equal(finding.fd, 4);
    assert.equal(finding.exactPath, "/workspace/config/dsh/sessions/s1");
    assert.equal(finding.enoentFsyncs.length, 2);
    // failedCalls holds the NON-fsync failed syscalls (fsyncs are in enoentFsyncs).
    assert.equal(finding.failedCalls.length, 1);
    assert.equal(finding.failedCalls[0].syscall, "mkdir");
  });

  it("ignores non-ENOENT fsync failures (e.g. EIO) and never fabricates a path", () => {
    const trace = [
      "2  fsync(9</workspace/config/dsh/x>) = -1 EIO (Input/output error)",
      "2  fsync(10</workspace/config/dsh/y>) = -1 ENOENT (No such file or directory)",
    ].join("\n");
    const finding = parseDshFsyncTrace(trace);
    assert.equal(finding.failingSyscall, "fsync");
    assert.equal(finding.fd, 10);
    assert.equal(finding.exactPath, "/workspace/config/dsh/y");
  });

  it("returns a null finding (fd fallback, no fabricated path) when no ENOENT fsync exists", () => {
    const trace = "3  fsync(1</workspace/config/dsh/ok>) = 0\n";
    const finding = parseDshFsyncTrace(trace);
    assert.equal(finding.failingSyscall, null);
    assert.equal(finding.fd, null);
    assert.equal(finding.exactPath, null);
    assert.equal(finding.targetPathOrFd, "unknown");
    assert.equal(finding.traceMethod, "unknown");
  });

  it("uses the fd fallback target when the fd annotation is unavailable", () => {
    const trace = "4  fsync(21) = -1 ENOENT (No such file or directory)";
    const finding = parseDshFsyncTrace(trace);
    assert.equal(finding.fd, 21);
    assert.equal(finding.exactPath, null);
    assert.equal(finding.targetPathOrFd, "fd 21");
  });

  it("extracts fenced sections and marker values", () => {
    const text = [
      "noise",
      DSH_FSYNC_DIAG_MOUNTS_BEGIN,
      "fuse /workspace/config/dsh fuse rw",
      DSH_FSYNC_DIAG_MOUNTS_END,
      "trailing",
    ].join("\n");
    assert.match(extractMarkedSection(text, DSH_FSYNC_DIAG_MOUNTS_BEGIN, DSH_FSYNC_DIAG_MOUNTS_END), /fuse \/workspace/);
    assert.equal(extractMarkerValue(`${DSH_FSYNC_DIAG_TRACE_METHOD_MARKER}guest-strace\n`, DSH_FSYNC_DIAG_TRACE_METHOD_MARKER), "guest-strace");
    assert.equal(extractMarkerValue("nothing", DSH_FSYNC_DIAG_TRACE_METHOD_MARKER), null);
  });
});

describe("dsh guest mount table parsing/reconciliation (pure)", () => {
  const mountsText = [
    DSH_FSYNC_DIAG_MOUNTS_BEGIN,
    "overlay / overlay rw,relatime",
    "fuse /workspace/config/dsh fuse rw,nosuid,nodev",
    "fuse /workspace/runtime fuse ro",
    DSH_FSYNC_DIAG_MOUNTS_END,
  ].join("\n");

  it("parses guest mount-table entries and filters to the guest config root", () => {
    const entries = parseGuestMountTable(mountsText);
    assert.equal(entries.length, 3);
    assert.equal(entries[1].device, "fuse");
    assert.equal(entries[1].fsType, "fuse");
    const under = mountsUnderRoot(entries, GUEST_ROOT);
    assert.deepEqual(
      under.map((e) => e.mountPoint),
      ["/workspace/config/dsh"],
    );
  });

  it("names a single-mount collapse as a discrepancy (not a match)", () => {
    const planned = [
      "/workspace/config/dsh/.anonymous-user-id",
      "/workspace/config/dsh/.credentials.yaml",
      "/workspace/config/dsh/profiles",
      "/workspace/config/dsh/sessions",
      "/workspace/config/dsh/storages",
    ];
    const result = reconcileObservedMountsWithPlan(["/workspace/config/dsh"], planned, GUEST_ROOT);
    assert.equal(result.matches, false);
    assert.match(result.discrepancy, /SINGLE FUSE destination/);
    assert.deepEqual(result.observedUnderRoot, ["/workspace/config/dsh"]);
    assert.equal(result.plannedDestinations.length, 5);
  });

  it("matches exactly when observed mount points equal the planned destinations", () => {
    const planned = ["/workspace/config/dsh/sessions", "/workspace/config/dsh/storages"];
    const result = reconcileObservedMountsWithPlan(planned, planned, GUEST_ROOT);
    assert.equal(result.matches, true);
    assert.equal(result.discrepancy, "");
  });

  it("names missing and unplanned observed destinations", () => {
    const result = reconcileObservedMountsWithPlan(
      ["/workspace/config/dsh/sessions", "/workspace/config/dsh/extra"],
      ["/workspace/config/dsh/sessions", "/workspace/config/dsh/storages"],
      GUEST_ROOT,
    );
    assert.equal(result.matches, false);
    assert.match(result.discrepancy, /missing observed/);
    assert.match(result.discrepancy, /unplanned observed/);
  });
});

describe("dsh strace wrapper builder (pure)", () => {
  it("builds a byte-deterministic wrapper that selects guest-strace and dumps mounts", () => {
    const a = buildDshStraceWrapperScript();
    const b = buildDshStraceWrapperScript();
    assert.equal(a, b);
    assert.match(a, /^#!\/bin\/sh/);
    assert.match(a, /command -v strace/);
    assert.match(a, /-e status=failed/);
    assert.match(a, /-y/);
    assert.match(a, /fsync,fdatasync,openat/);
    assert.ok(a.includes(DSH_FSYNC_DIAG_MOUNTS_BEGIN));
    assert.ok(a.includes(DSH_FSYNC_DIAG_MOUNTS_END));
    assert.ok(a.includes(DSH_FSYNC_DIAG_TRACE_METHOD_MARKER));
    assert.ok(a.includes(DSH_FSYNC_DIAG_REAL_DSH_MARKER));
    assert.ok(a.includes(DSH_FSYNC_DIAG_STRACE_PROBE_FAILED_MARKER));
    assert.ok(a.includes(DSH_FSYNC_DIAG_FSYNC_BEGIN));
    assert.ok(a.includes(DSH_FSYNC_DIAG_FSYNC_END));
    assert.match(a, /cat \/proc\/mounts/);
    // Node interposer fallback when the guest sandbox denies ptrace.
    assert.match(a, /guest-node-fs-shim/);
    assert.match(a, /NODE_OPTIONS="--require \$NODE_SHIM"/);
    assert.match(a, /fsync-shim\.cjs/);
  });

  it("builds a Node interposer that patches the opened FileHandle prototype and fs.fsync*", () => {
    const shim = buildDshFsyncNodeShimScript();
    assert.equal(shim, buildDshFsyncNodeShimScript());
    assert.match(shim, /TAMANDUA_FSYNC_LOG/);
    assert.match(shim, /SYNC_FAIL syscall=/);
    assert.match(shim, /installHandlePatch/);
    assert.match(shim, /proto\.sync = function/);
    assert.match(shim, /fsp\.open = function/);
    assert.match(shim, /wrapSync\(fs, 'fsyncSync', 'fsync'\)/);
    assert.match(shim, /\/proc\/self\/fd\//);
  });

  it("honors explicit real-dsh/log paths", () => {
    const script = buildDshStraceWrapperScript({
      realDshPath: "/opt/custom/dsh",
      straceLogPath: "/tmp/custom.strace",
      mountLogPath: "/tmp/custom.mounts",
      fsyncLogPath: "/tmp/custom.fsync",
      nodeShimGuestPath: "/workspace/runtime/bin/custom-shim.cjs",
    });
    assert.ok(script.includes("REAL_DSH='/opt/custom/dsh'"));
    assert.ok(script.includes("STRACE_LOG='/tmp/custom.strace'"));
    assert.ok(script.includes("MOUNT_LOG='/tmp/custom.mounts'"));
    assert.ok(script.includes("FSYNC_LOG='/tmp/custom.fsync'"));
    assert.ok(script.includes("NODE_SHIM='/workspace/runtime/bin/custom-shim.cjs'"));
  });
});
