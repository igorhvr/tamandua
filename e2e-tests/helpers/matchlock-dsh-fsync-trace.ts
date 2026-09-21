/******************************************************************************
 * matchlock-dsh-fsync-trace.ts — DSH-OVERLAY-FSYNC-FIX US-002.
 *
 * PURE host-side parsing/reconciliation seam for the on-demand in-VM dsh
 * `fsync ENOENT` diagnosis (bead tamandua-6sy.33.10.34, third round).
 *
 * The diagnosis gate boots the REAL dsh inside a fresh Matchlock VM with a
 * real-LAYOUT `$DSH_HOME`, wrapped so the guest writes:
 *   - the observed guest mount table (`/proc/mounts`), fenced by the
 *     `TAMANDUA_DIAG_MOUNTS_BEGIN/END` markers;
 *   - EITHER `strace -f -y -e trace=... -e status=failed` output (fenced by
 *     `TAMANDUA_DIAG_STRACE_BEGIN/END`) OR, when the guest sandbox denies
 *     ptrace (PTRACE_TRACEME EPERM — observed in the qualified image), a
 *     Node `FileHandle.prototype.sync`/`fs.fsync*` interposer log (fenced by
 *     `TAMANDUA_DIAG_FSYNC_BEGIN/END`);
 *   - a `TAMANDUA_DIAG_TRACE_METHOD=<method>` marker naming how the trace was
 *     obtained (`guest-strace`, `guest-node-fs-shim`, or `none`).
 *
 * This module NEVER imports `node:child_process` (or any host administrative
 * module) so the fast-lane unit test that imports it directly stays in the
 * parallel lane. It performs STRING parsing only.
 *****************************************************************************/

/** Marker prefix naming how the guest obtained the trace. */
export const DSH_FSYNC_DIAG_TRACE_METHOD_MARKER = "TAMANDUA_DIAG_TRACE_METHOD=";
/** Marker naming the resolved real dsh binary inside the guest. */
export const DSH_FSYNC_DIAG_REAL_DSH_MARKER = "TAMANDUA_DIAG_REAL_DSH=";
/** Marker naming the failed guest strace probe (ptrace denied), when any. */
export const DSH_FSYNC_DIAG_STRACE_PROBE_FAILED_MARKER =
  "TAMANDUA_DIAG_STRACE_PROBE_FAILED=";
/** Fence markers around the strace log. */
export const DSH_FSYNC_DIAG_STRACE_BEGIN = "TAMANDUA_DIAG_STRACE_BEGIN";
export const DSH_FSYNC_DIAG_STRACE_END = "TAMANDUA_DIAG_STRACE_END";
/** Fence markers around the Node fsync-interposer log. */
export const DSH_FSYNC_DIAG_FSYNC_BEGIN = "TAMANDUA_DIAG_FSYNC_BEGIN";
export const DSH_FSYNC_DIAG_FSYNC_END = "TAMANDUA_DIAG_FSYNC_END";
/** Fence markers around the observed guest mount table. */
export const DSH_FSYNC_DIAG_MOUNTS_BEGIN = "TAMANDUA_DIAG_MOUNTS_BEGIN";
export const DSH_FSYNC_DIAG_MOUNTS_END = "TAMANDUA_DIAG_MOUNTS_END";

/** Guest basename of the Node fsync interposer (inside the RO helper pack). */
export const DSH_FSYNC_DIAG_SHIM_BASENAME = "fsync-shim.cjs";

/** Trace methods the wrapper can select. */
export type DshFsyncTraceMethod = "guest-strace" | "guest-node-fs-shim" | "none";

/** Syscalls the guest strace records (the failing fsync class + path plumbing). */
export const DSH_FSYNC_DIAG_TRACE_SYSCALLS = [
  "fsync",
  "fdatasync",
  "openat",
  "open",
  "mkdir",
  "mkdirat",
  "rename",
  "renameat",
  "renameat2",
  "symlink",
  "symlinkat",
  "readlink",
  "readlinkat",
] as const;

/** The dsh-boot dead-end observed at boot (vaimetal run #35). */
export const DSH_FSYNC_DIAG_ERRNO = "ENOENT";

/** One failed syscall line captured by either trace method. */
export interface DshTraceFailedCall {
  /** strace `-f` pid prefix, or null when the line is unprefixed. */
  readonly pid: number | null;
  /** Syscall name (e.g. `fsync`, `openat`). */
  readonly syscall: string;
  /** Raw path operand for path-taking syscalls, when present. */
  readonly path: string | null;
  /** strace `-y` resolved path annotation for fd-taking syscalls, when present. */
  readonly resolvedPath: string | null;
  /** errno symbol (e.g. `ENOENT`). */
  readonly errno: string;
  /** The raw trace line (verbatim, trimmed of the trailing newline). */
  readonly rawLine: string;
  /** Which method produced the line (`strace` | `node-fs-shim`). */
  readonly source: "strace" | "node-fs-shim";
}

/** The parsed outcome of the diagnosis trace. */
export interface DshFsyncTraceFinding {
  /** Exact failing syscall (`fsync`/`fdatasync`), or null when none failed. */
  readonly failingSyscall: "fsync" | "fdatasync" | null;
  /** fd operand of the failing call, or null. */
  readonly fd: number | null;
  /** Best-effort target (exact path, else `fd <n>`, else `unknown`). */
  readonly targetPathOrFd: string;
  /** Exact guest path the failing fsync targeted, or null when unrecoverable. */
  readonly exactPath: string | null;
  /** The raw failing line, or null. */
  readonly rawLine: string | null;
  /** Every failed non-fsync syscall line (open/mkdir/rename/symlink/readlink). */
  readonly failedCalls: readonly DshTraceFailedCall[];
  /** Every `fsync`/`fdatasync` line that returned ENOENT. */
  readonly enoentFsyncs: readonly DshTraceFailedCall[];
  /** `TAMANDUA_DIAG_TRACE_METHOD=` value, or `unknown` when absent. */
  readonly traceMethod: string;
  /** `TAMANDUA_DIAG_REAL_DSH=` value, or null when absent. */
  readonly realDshBinary: string | null;
  /** Failed guest-strace probe text (ptrace denied), or null when absent. */
  readonly straceProbeFailure: string | null;
}

/** One `/proc/mounts` entry. */
export interface DshGuestMountEntry {
  readonly device: string;
  readonly mountPoint: string;
  readonly fsType: string;
  readonly options: string;
}

/** Plan-vs-observed reconciliation result. */
export interface DshMountReconciliation {
  /** True when the observed guest mount points equal the planned destinations. */
  readonly matches: boolean;
  /** Observed mount points at/under the guest configuration root (sorted). */
  readonly observedUnderRoot: readonly string[];
  /** Planned destination paths (sorted). */
  readonly plannedDestinations: readonly string[];
  /** A human-readable description of the discrepancy (empty when matches). */
  readonly discrepancy: string;
}

function unescapeStraceString(value: string): string {
  return value
    .replace(/\\(["\\])/g, "$1")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");
}

/** Extract the text between two fence lines (exclusive), or "" when absent. */
export function extractMarkedSection(
  text: string,
  beginMarker: string,
  endMarker: string,
): string {
  const begin = text.indexOf(beginMarker);
  if (begin < 0) return "";
  const after = begin + beginMarker.length;
  const end = text.indexOf(endMarker, after);
  if (end < 0) return text.slice(after);
  return text.slice(after, end);
}

/** Read the single-value `KEY=value` marker from anywhere in `text`. */
export function extractMarkerValue(text: string, marker: string): string | null {
  const idx = text.indexOf(marker);
  if (idx < 0) return null;
  const rest = text.slice(idx + marker.length);
  const line = rest.split("\n", 1)[0] ?? "";
  const value = line.trim();
  return value.length > 0 ? value : null;
}

const FD_ANNOTATION_RE = /<([^>]*)>/;
const FAILED_RESULT_RE = /=\s*-1\s+([A-Z][A-Z0-9]*)/;
const SUCCESS_FD_RE = /=\s*(\d+)\b/;
/** Node fsync-interposer line: SYNC_FAIL syscall=fsync fd=7 path=... err=ENOENT ... */
const SHIM_FAIL_RE =
  /^SYNC_FAIL\s+syscall=(\S+)\s+fd=(\d+)\s+path=(.*?)\s+err=(\S+)(?:\s+message=.*)?$/;

function stripPidPrefix(line: string): { pid: number | null; body: string } {
  const bracketed = /^\s*\[pid\s+(\d+)\]\s+(.*)$/.exec(line);
  if (bracketed) return { pid: Number(bracketed[1]), body: bracketed[2] };
  const m = /^\s*(\d+)\s+(.*)$/.exec(line);
  if (m) return { pid: Number(m[1]), body: m[2] };
  return { pid: null, body: line.trim() };
}

function firstQuotedString(body: string): string | null {
  const m = /"((?:[^"\\]|\\.)*)"/.exec(body);
  return m ? unescapeStraceString(m[1]) : null;
}

function syscallName(body: string): string | null {
  const m = /^([a-z_][a-z0-9_]*)\(/.exec(body);
  return m ? m[1] : null;
}

function fdOperand(body: string): number | null {
  const m = /^[a-z_][a-z0-9_]*\((\d+)/.exec(body);
  return m ? Number(m[1]) : null;
}

interface MutableFinding {
  failingSyscall: "fsync" | "fdatasync" | null;
  failingFd: number | null;
  failingPath: string | null;
  failingRawLine: string | null;
}

function parseStraceBody(traceBody: string, finding: MutableFinding): {
  failedCalls: DshTraceFailedCall[];
  enoentFsyncs: DshTraceFailedCall[];
} {
  const fdPaths = new Map<number, Map<number, string>>();
  const failedCalls: DshTraceFailedCall[] = [];
  const enoentFsyncs: DshTraceFailedCall[] = [];

  for (const rawLine of traceBody.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;
    const { pid, body } = stripPidPrefix(line);
    const name = syscallName(body);
    if (name === null) continue;

    const errnoMatch = FAILED_RESULT_RE.exec(body);
    const failed = errnoMatch !== null;
    const errno = errnoMatch ? errnoMatch[1] : "";

    if (name === "open" || name === "openat") {
      const path = firstQuotedString(body);
      const resolved = FD_ANNOTATION_RE.exec(body);
      const fdMatch = SUCCESS_FD_RE.exec(body);
      if (!failed && fdMatch && pid !== null && path !== null) {
        let pidMap = fdPaths.get(pid);
        if (!pidMap) {
          pidMap = new Map<number, string>();
          fdPaths.set(pid, pidMap);
        }
        pidMap.set(Number(fdMatch[1]), resolved ? resolved[1] : path);
      }
      if (failed) {
        failedCalls.push({
          pid,
          syscall: name,
          path,
          resolvedPath: resolved ? resolved[1] : null,
          errno,
          rawLine: line,
          source: "strace",
        });
      }
      continue;
    }

    if (
      failed &&
      (name === "mkdir" ||
        name === "mkdirat" ||
        name.startsWith("rename") ||
        name.startsWith("symlink") ||
        name.startsWith("readlink"))
    ) {
      failedCalls.push({
        pid,
        syscall: name,
        path: firstQuotedString(body),
        resolvedPath: FD_ANNOTATION_RE.exec(body)?.[1] ?? null,
        errno,
        rawLine: line,
        source: "strace",
      });
      continue;
    }

    if (name === "fsync" || name === "fdatasync") {
      const fd = fdOperand(body);
      const annotation = FD_ANNOTATION_RE.exec(body);
      const resolvedPid = pid ?? 0;
      const pathFromFd =
        fd !== null && fdPaths.get(resolvedPid)?.get(fd) !== undefined
          ? fdPaths.get(resolvedPid)!.get(fd)!
          : null;
      const exact = annotation ? annotation[1] : pathFromFd;
      if (failed && errno === DSH_FSYNC_DIAG_ERRNO) {
        enoentFsyncs.push({
          pid,
          syscall: name,
          path: exact,
          resolvedPath: annotation ? annotation[1] : null,
          errno,
          rawLine: line,
          source: "strace",
        });
        if (finding.failingSyscall === null) {
          finding.failingSyscall = name;
          finding.failingFd = fd;
          finding.failingPath = exact;
          finding.failingRawLine = line;
        }
      }
      continue;
    }
  }
  return { failedCalls, enoentFsyncs };
}

function parseShimBody(shimBody: string, finding: MutableFinding): {
  failedCalls: DshTraceFailedCall[];
  enoentFsyncs: DshTraceFailedCall[];
} {
  const failedCalls: DshTraceFailedCall[] = [];
  const enoentFsyncs: DshTraceFailedCall[] = [];
  for (const rawLine of shimBody.split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = SHIM_FAIL_RE.exec(line);
    if (!m) continue;
    const [, syscallRaw, fdRaw, path, errno] = m;
    const syscall = syscallRaw === "fdatasync" ? "fdatasync" : "fsync";
    const call: DshTraceFailedCall = {
      pid: null,
      syscall,
      path,
      resolvedPath: path,
      errno,
      rawLine: line,
      source: "node-fs-shim",
    };
    if (errno === DSH_FSYNC_DIAG_ERRNO) {
      enoentFsyncs.push(call);
      if (finding.failingSyscall === null) {
        finding.failingSyscall = syscall;
        finding.failingFd = Number(fdRaw);
        finding.failingPath = path;
        finding.failingRawLine = line;
      }
    } else {
      failedCalls.push(call);
    }
  }
  return { failedCalls, enoentFsyncs };
}

/**
 * Parse a raw guest trace (strace and/or Node-interposer markers) and recover
 * the exact failing `fsync`/`fdatasync` target.
 *
 * The strace branch reconstructs fd -> open path per pid from successful
 * `open`/`openat` lines (needed when `-y` is unavailable); the Node-interposer
 * branch already carries the exact path.
 */
export function parseDshFsyncTrace(text: string): DshFsyncTraceFinding {
  const straceBody = text.includes(DSH_FSYNC_DIAG_STRACE_BEGIN)
    ? extractMarkedSection(text, DSH_FSYNC_DIAG_STRACE_BEGIN, DSH_FSYNC_DIAG_STRACE_END)
    : text.includes(DSH_FSYNC_DIAG_FSYNC_BEGIN)
      ? ""
      : text;
  const shimBody = text.includes(DSH_FSYNC_DIAG_FSYNC_BEGIN)
    ? extractMarkedSection(text, DSH_FSYNC_DIAG_FSYNC_BEGIN, DSH_FSYNC_DIAG_FSYNC_END)
    : "";
  const traceMethod = extractMarkerValue(text, DSH_FSYNC_DIAG_TRACE_METHOD_MARKER) ?? "unknown";
  const realDshBinary = extractMarkerValue(text, DSH_FSYNC_DIAG_REAL_DSH_MARKER);
  const straceProbeFailure = extractMarkerValue(text, DSH_FSYNC_DIAG_STRACE_PROBE_FAILED_MARKER);

  const finding: MutableFinding = {
    failingSyscall: null,
    failingFd: null,
    failingPath: null,
    failingRawLine: null,
  };
  const strace = parseStraceBody(straceBody, finding);
  const shim = parseShimBody(shimBody, finding);
  const failedCalls = [...strace.failedCalls, ...shim.failedCalls];
  const enoentFsyncs = [...strace.enoentFsyncs, ...shim.enoentFsyncs];

  return {
    failingSyscall: finding.failingSyscall,
    fd: finding.failingFd,
    targetPathOrFd:
      finding.failingPath ?? (finding.failingFd !== null ? `fd ${finding.failingFd}` : "unknown"),
    exactPath: finding.failingPath,
    rawLine: finding.failingRawLine,
    failedCalls,
    enoentFsyncs,
    traceMethod,
    realDshBinary,
    straceProbeFailure,
  };
}

/** Parse `/proc/mounts`-style lines (device mountpoint fstype options ...). */
export function parseGuestMountTable(text: string): DshGuestMountEntry[] {
  const body = text.includes(DSH_FSYNC_DIAG_MOUNTS_BEGIN)
    ? extractMarkedSection(text, DSH_FSYNC_DIAG_MOUNTS_BEGIN, DSH_FSYNC_DIAG_MOUNTS_END)
    : text;
  const entries: DshGuestMountEntry[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    // /proc/mounts escapes spaces as \040.
    const parts = line.replace(/\\040/g, " ").split(" ");
    if (parts.length < 4) continue;
    entries.push({
      device: parts[0],
      mountPoint: parts[1],
      fsType: parts[2],
      options: parts[3],
    });
  }
  return entries;
}

/** Keep mount entries at or under `guestRoot`, sorted by mount point. */
export function mountsUnderRoot(
  entries: readonly DshGuestMountEntry[],
  guestRoot: string,
): DshGuestMountEntry[] {
  const root = guestRoot.replace(/\/+$/, "");
  return entries
    .filter((e) => e.mountPoint === root || e.mountPoint.startsWith(`${root}/`))
    .slice()
    .sort((a, b) => a.mountPoint.localeCompare(b.mountPoint));
}

/**
 * Reconcile the OBSERVED guest mount points with the per-durable-entry
 * destinations `planDshHomeMounts` emits. The runtime may legally collapse
 * several exact destinations that share a parent into ONE FUSE mount at that
 * parent (a MountRouter); that collapse is the discrepancy this function names
 * — it does not silently call it a match.
 */
export function reconcileObservedMountsWithPlan(
  observedMountPoints: readonly string[],
  plannedDestinations: readonly string[],
  guestRoot: string,
): DshMountReconciliation {
  const root = guestRoot.replace(/\/+$/, "");
  const observedUnderRoot = [...new Set(observedMountPoints)]
    .filter((p) => p === root || p.startsWith(`${root}/`))
    .sort((a, b) => a.localeCompare(b));
  const planned = [...new Set(plannedDestinations)].sort((a, b) => a.localeCompare(b));

  const observedSet = new Set(observedUnderRoot);
  const plannedSet = new Set(planned);
  const sameSet =
    observedUnderRoot.length === planned.length &&
    observedUnderRoot.every((p) => plannedSet.has(p));

  if (sameSet) {
    return {
      matches: true,
      observedUnderRoot,
      plannedDestinations: planned,
      discrepancy: "",
    };
  }

  let discrepancy: string;
  if (observedUnderRoot.length === 0) {
    discrepancy =
      `no guest mount at/under ${root} was observed; the composed plan names ` +
      `${planned.length} destination(s) (${planned.join(", ")}).`;
  } else if (observedUnderRoot.length === 1 && planned.length > 1) {
    discrepancy =
      `the runtime mounted a SINGLE FUSE destination ${observedUnderRoot[0]} instead of the ` +
      `${planned.length} per-durable-entry destinations the plan emits ` +
      `(${planned.join(", ")}); the whole dsh home is served by one synthetic mount root.`;
  } else {
    const missing = planned.filter((p) => !observedSet.has(p));
    const extra = observedUnderRoot.filter((p) => !plannedSet.has(p));
    const bits: string[] = [];
    if (missing.length > 0) bits.push(`missing observed: ${missing.join(", ")}`);
    if (extra.length > 0) bits.push(`unplanned observed: ${extra.join(", ")}`);
    discrepancy = `observed guest mounts differ from the composed plan (${bits.join("; ")}).`;
  }

  return { matches: false, observedUnderRoot, plannedDestinations: planned, discrepancy };
}

export interface DshStraceWrapperOptions {
  /** Absolute path of the real guest dsh binary (default `/usr/local/bin/dsh`). */
  realDshPath?: string;
  /** Guest path for the strace log (default `/tmp/tamandua-dsh-fsync.strace`). */
  straceLogPath?: string;
  /** Guest path for the Node-interposer log (default `/tmp/tamandua-dsh-fsync.log`). */
  fsyncLogPath?: string;
  /** Guest path for the mount-table dump (default `/tmp/tamandua-dsh-mounts.txt`). */
  mountLogPath?: string;
  /** Guest path for the strace probe stderr (default `/tmp/tamandua-dsh-strace-probe.err`). */
  straceProbeErrPath?: string;
  /**
   * Guest path of the Node fsync interposer (default
   * `/workspace/runtime/bin/fsync-shim.cjs`, i.e. inside the mounted pack).
   */
  nodeShimGuestPath?: string;
}

/**
 * Build the guest `dsh` wrapper that traces the REAL dsh boot and dumps the
 * observed mount table. It is byte-deterministic for a given options set so it
 * can be unit-tested. It prefers a usable guest `strace`; when the guest
 * sandbox denies ptrace (PTRACE_TRACEME EPERM — the qualified image), it falls
 * back to the Node fsync interposer (`TAMANDUA_DIAG_TRACE_METHOD=guest-node-fs-shim`).
 */
export function buildDshStraceWrapperScript(opts: DshStraceWrapperOptions = {}): string {
  const realDshPath = opts.realDshPath ?? "/usr/local/bin/dsh";
  const straceLogPath = opts.straceLogPath ?? "/tmp/tamandua-dsh-fsync.strace";
  const fsyncLogPath = opts.fsyncLogPath ?? "/tmp/tamandua-dsh-fsync.log";
  const mountLogPath = opts.mountLogPath ?? "/tmp/tamandua-dsh-mounts.txt";
  const straceProbeErrPath = opts.straceProbeErrPath ?? "/tmp/tamandua-dsh-strace-probe.err";
  const nodeShimGuestPath = opts.nodeShimGuestPath ?? `/workspace/runtime/bin/${DSH_FSYNC_DIAG_SHIM_BASENAME}`;
  const syscalls = DSH_FSYNC_DIAG_TRACE_SYSCALLS.join(",");
  return [
    "#!/bin/sh",
    "# DSH-OVERLAY-FSYNC-FIX US-002 diagnosis wrapper (generated).",
    "set -u",
    `REAL_DSH=${shellQuote(realDshPath)}`,
    `STRACE_LOG=${shellQuote(straceLogPath)}`,
    `FSYNC_LOG=${shellQuote(fsyncLogPath)}`,
    `MOUNT_LOG=${shellQuote(mountLogPath)}`,
    `STRACE_PROBE_ERR=${shellQuote(straceProbeErrPath)}`,
    `NODE_SHIM=${shellQuote(nodeShimGuestPath)}`,
    `cat /proc/mounts > "$MOUNT_LOG" 2>&1`,
    "if [ ! -x \"$REAL_DSH\" ]; then",
    "  REAL_DSH=\"$(command -v dsh)\"",
    "fi",
    `printf '%s%s\\n' ${shellQuote(DSH_FSYNC_DIAG_REAL_DSH_MARKER)} "$REAL_DSH"`,
    "TRACE_METHOD=none",
    "if command -v strace >/dev/null 2>&1; then",
    "  if strace -o /dev/null -e trace=fsync /bin/true >/dev/null 2>\"$STRACE_PROBE_ERR\"; then",
    "    TRACE_METHOD=guest-strace",
    "  else",
    `    printf '%s%s\\n' ${shellQuote(DSH_FSYNC_DIAG_STRACE_PROBE_FAILED_MARKER)} "$(tr '\\n' ' ' < "$STRACE_PROBE_ERR" | cut -c1-400)"`,
    "  fi",
    "fi",
    "if [ \"$TRACE_METHOD\" = none ] && [ -f \"$NODE_SHIM\" ]; then",
    "  TRACE_METHOD=guest-node-fs-shim",
    "fi",
    `printf '%s%s\\n' ${shellQuote(DSH_FSYNC_DIAG_TRACE_METHOD_MARKER)} "$TRACE_METHOD"`,
    ": > \"$FSYNC_LOG\" 2>/dev/null || true",
    "if [ \"$TRACE_METHOD\" = guest-strace ]; then",
    `  strace -f -y -o "$STRACE_LOG" -e trace=${syscalls} -e status=failed "$REAL_DSH" "$@"`,
    "  rc=$?",
    `  printf '%s\\n' ${shellQuote(DSH_FSYNC_DIAG_STRACE_BEGIN)}`,
    "  cat \"$STRACE_LOG\" 2>&1",
    `  printf '%s\\n' ${shellQuote(DSH_FSYNC_DIAG_STRACE_END)}`,
    "elif [ \"$TRACE_METHOD\" = guest-node-fs-shim ]; then",
    "  TAMANDUA_FSYNC_LOG=\"$FSYNC_LOG\" NODE_OPTIONS=\"--require $NODE_SHIM\" \"$REAL_DSH\" \"$@\"",
    "  rc=$?",
    "else",
    "  \"$REAL_DSH\" \"$@\"",
    "  rc=$?",
    "fi",
    `printf '%s\\n' ${shellQuote(DSH_FSYNC_DIAG_FSYNC_BEGIN)}`,
    "cat \"$FSYNC_LOG\" 2>&1",
    `printf '%s\\n' ${shellQuote(DSH_FSYNC_DIAG_FSYNC_END)}`,
    `printf '%s\\n' ${shellQuote(DSH_FSYNC_DIAG_MOUNTS_BEGIN)}`,
    "cat \"$MOUNT_LOG\" 2>&1",
    `printf '%s\\n' ${shellQuote(DSH_FSYNC_DIAG_MOUNTS_END)}`,
    "exit $rc",
    "",
  ].join("\n");
}

/**
 * Build the Node `--require` interposer source. It patches the PUBLIC
 * `FileHandle.prototype.sync`, `fs.fsyncSync`/`fs.fsync` and
 * `fs.promises.fsync` entry points so any failing sync logs its exact target
 * (resolved through `/proc/self/fd/<fd>`) and errno to
 * `$TAMANDUA_FSYNC_LOG`, then rethrows unchanged. PURE text; the gate writes it
 * into the RO helper pack.
 */
export function buildDshFsyncNodeShimScript(): string {
  return [
    "'use strict';",
    "// DSH-OVERLAY-FSYNC-FIX US-002 Node fsync interposer (generated).",
    "// The guest Matchlock sandbox denies ptrace, so strace cannot run here; this",
    "// public-API interposer recovers the exact fsync target instead.",
    "const fs = require('node:fs');",
    "const fsp = require('node:fs/promises');",
    "const LOG = process.env.TAMANDUA_FSYNC_LOG || '/tmp/tamandua-dsh-fsync.log';",
    "function logLine(line) {",
    "  try { fs.appendFileSync(LOG, line + '\\n'); } catch (_) { /* best-effort */ }",
    "}",
    "function resolveFdPath(fd) {",
    "  try { return fs.readlinkSync('/proc/self/fd/' + fd); } catch (_) { return '?'; }",
    "}",
    "function record(syscall, fd, err) {",
    "  const code = err && err.code ? err.code : (err && err.errno ? String(err.errno) : 'UNKNOWN');",
    "  const message = err && err.message ? String(err.message).replace(/\\s+/g, ' ').slice(0, 300) : '';",
    "  logLine('SYNC_FAIL syscall=' + syscall + ' fd=' + fd + ' path=' + resolveFdPath(fd) + ' err=' + code + ' message=' + message);",
    "}",
    "function wrapAsync(owner, name, syscall) {",
    "  const original = owner && owner[name];",
    "  if (typeof original !== 'function') return;",
    "  owner[name] = function (...args) {",
    "    const fd = typeof args[0] === 'number' ? args[0] : null;",
    "    const result = original.apply(this, args);",
    "    if (result && typeof result.catch === 'function') {",
    "      return result.catch((err) => { if (fd !== null) record(syscall, fd, err); throw err; });",
    "    }",
    "    return result;",
    "  };",
    "}",
    "function wrapSync(owner, name, syscall) {",
    "  const original = owner && owner[name];",
    "  if (typeof original !== 'function') return;",
    "  owner[name] = function (fd, ...rest) {",
    "    try { return original.call(this, fd, ...rest); }",
    "    catch (err) { record(syscall, fd, err); throw err; }",
    "  };",
    "}",
    "// FileHandle is NOT exported by node:fs/promises on this Node build, so the",
    "// prototype is patched lazily from each opened handle (dsh's session store",
    "// uses `open` from node:fs/promises and then `handle.sync()`).",
    "function installHandlePatch(handle) {",
    "  const proto = handle && Object.getPrototypeOf(handle);",
    "  if (!proto || proto.__tamanduaSyncPatched || typeof proto.sync !== 'function') return;",
    "  const originalSync = proto.sync;",
    "  proto.sync = function (...args) {",
    "    const fd = this && this.fd;",
    "    const result = originalSync.apply(this, args);",
    "    if (result && typeof result.catch === 'function') {",
    "      return result.catch((err) => { if (typeof fd === 'number') record('fsync', fd, err); throw err; });",
    "    }",
    "    return result;",
    "  };",
    "  try { Object.defineProperty(proto, '__tamanduaSyncPatched', { value: true, enumerable: false }); }",
    "  catch (_) { proto.__tamanduaSyncPatched = true; }",
    "}",
    "const originalOpen = fsp.open;",
    "fsp.open = function (...args) {",
    "  const result = originalOpen.apply(this, args);",
    "  if (result && typeof result.then === 'function') {",
    "    return result.then((handle) => { installHandlePatch(handle); return handle; });",
    "  }",
    "  return result;",
    "};",
    "wrapSync(fs, 'fsyncSync', 'fsync');",
    "wrapSync(fs, 'fdatasyncSync', 'fdatasync');",
    "wrapAsync(fs, 'fsync', 'fsync');",
    "wrapAsync(fs, 'fdatasync', 'fdatasync');",
    "wrapAsync(fsp, 'fsync', 'fsync');",
    "wrapAsync(fsp, 'fdatasync', 'fdatasync');",
    "",
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
