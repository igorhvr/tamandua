/**
 * Matchlock dsh session-store decoding/parsing (explicit-root, node-only).
 *
 * This is the adapter's OWN explicit-root reader for the mapped dsh home; the
 * existing native reader (`src/installer/dsh-usage.ts`) is left untouched.
 * Pure helpers are intentionally re-implemented under this owned prefix rather
 * than imported from `dsh-usage.ts`, whose module graph reaches
 * `node:child_process` (the native `zstd -dc` fallback) — this adapter must
 * stay process-spawn-free and deterministic so its tests remain in the
 * parallel lane and its decode behavior is exactly reproducible.
 *
 * Scope — only what was actually inspected/qualified on the installed CLI
 * (dsh >= 0.1.5): canonical CURRENT v3 generation artifacts
 * (`session.v3.jsonl.zstd` concatenated-frame zstd, `session.v3.jsonl` plain)
 * under `$DSH_HOME/sessions/<projectKey(cwd)>/<session-id>/`. Legacy
 * generations (`session.v2.*`, `session.jsonl*`), conflicting encodings,
 * torn/corrupt/unknown artifacts are classified honestly (never counted,
 * never fabricated as zero).
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {
  DSH_CURRENT_SESSION_FORMAT_VERSION,
  DSH_DEFAULT_ARTIFACT_LIMITS,
  type DshArtifactDecodeStatus,
  type DshArtifactLimits,
  type DshSessionArtifactRead,
  type DshSessionHeader,
  type DshSessionHeaderParse,
  type DshStoreEncoding,
} from "./dsh-adapter-contract.js";

// ── zstd feature detection (Node >= 23.8) ──────────────────────────

/**
 * Feature-detect node:zlib's synchronous zstd decoder through the namespace
 * (a direct named import would be a load-time error on Node < 23.8).
 */
function detectNodeZstdDecompress(): ((buf: Uint8Array) => Buffer) | undefined {
  const candidate = (
    zlib as unknown as { zstdDecompressSync?: unknown }
  ).zstdDecompressSync;
  return typeof candidate === "function"
    ? (candidate as (buf: Uint8Array) => Buffer)
    : undefined;
}

/**
 * Test-only override of the node:zlib zstd feature gate. The production
 * reader must NEVER silently depend on host Node >= 23.8 zlib: when the
 * decoder is unavailable the artifact read reports `zstd-unavailable` with an
 * explicit problem (decode requirements are qualified, never silently zeroed).
 * Pass `null` to clear the override and restore live detection.
 */
export function setMatchlockNodeZstdAvailableForTest(
  value: boolean | null,
): void {
  matchlockNodeZstdOverrideForTest = value;
}

let matchlockNodeZstdOverrideForTest: boolean | null = null;

/** True when node:zlib can decode zstd on this Node. */
export function matchlockNodeZstdAvailable(): boolean {
  if (matchlockNodeZstdOverrideForTest !== null) {
    return matchlockNodeZstdOverrideForTest;
  }
  return detectNodeZstdDecompress() !== undefined;
}

// ── projectKey (dsh session-format parity, owned copy) ─────────────

/**
 * Encode a cwd as dsh's per-project session directory key — byte-identical to
 * the installed `session-persistence-jsonl/format.ts` `projectKey` and to the
 * native reader's copy in `dsh-usage.ts`. `/`, `\` and `:` collapse to `-`;
 * safe `[A-Za-z0-9._-]` UTF-16 units stay literal; every other unit becomes
 * `~XXXX`; the slug is wrapped in `--…--` and bounded at 251 chars.
 */
export function matchlockProjectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  const slug = readable.replace(/^-+/, "") || "root";
  return `--${slug.slice(0, 251)}--`;
}

/** The per-workdir sessions directory under a dsh home. */
export function matchlockSessionProjectDir(dshHome: string, workdir: string): string {
  return path.join(dshHome, "sessions", matchlockProjectKey(workdir));
}

// ── Artifact discovery within one session directory ────────────────

interface SessionArtifacts {
  /** Present current-generation file (v3) when unambiguous. */
  current: string | null;
  /** Which encoding the current artifact uses. */
  encoding: DshStoreEncoding | null;
  /** Legacy canonical generations present (v0/v1/v2) — recognized, not attributed. */
  legacy: string[];
  /** Non-canonical/unknown file entries (retained, never read for attribution). */
  unknown: string[];
  /** Human problem when no unambiguous current artifact exists. */
  problem: string | null;
}

function canonicalGeneration(fileName: string): number | undefined {
  const m = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/.exec(fileName);
  if (!m) return undefined;
  return m[1] === undefined ? 0 : Number(m[1]);
}

function fileNameEncoding(fileName: string): DshStoreEncoding | null {
  if (fileName.endsWith(".zstd")) return "zstd";
  if (/^session(?:\.v([1-9][0-9]*))?\.jsonl$/.test(fileName)) return "plain";
  return null;
}

/** Enumerate the artifacts inside one session directory (names only). */
export function discoverSessionArtifacts(dirPath: string): SessionArtifacts {
  let entries: string[];
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
    return {
      current: null,
      encoding: null,
      legacy: [],
      unknown: [],
      problem: "session directory unreadable",
    };
  }
  const legacy: string[] = [];
  const unknown: string[] = [];
  const current: { fileName: string; encoding: DshStoreEncoding }[] = [];
  for (const name of entries) {
    const generation = canonicalGeneration(name);
    if (generation === undefined) {
      unknown.push(name);
      continue;
    }
    const encoding = fileNameEncoding(name);
    if (encoding === null) {
      unknown.push(name);
      continue;
    }
    if (generation === DSH_CURRENT_SESSION_FORMAT_VERSION) {
      current.push({ fileName: name, encoding });
    } else {
      legacy.push(name);
    }
  }
  if (current.length === 0) {
    const problem =
      legacy.length > 0
        ? `no current v3 artifact (legacy generation(s) present, not attributed: ${legacy.join(", ")})`
        : unknown.length > 0
          ? `no current v3 artifact (unknown entries only: ${unknown.join(", ")})`
          : "no session artifact present";
    return { current: null, encoding: null, legacy, unknown, problem };
  }
  if (current.length > 1) {
    return {
      current: null,
      encoding: null,
      legacy,
      unknown,
      problem: `multiple current-generation artifacts (${current.map((v) => v.fileName).join(", ")})`,
    };
  }
  return {
    current: current[0].fileName,
    encoding: current[0].encoding,
    legacy,
    unknown,
    problem: null,
  };
}

// ── zstd structural scan (concatenated frames) ─────────────────────

const ZSTD_MAGIC = 0xfd2fb528;

interface FrameScan {
  /** Structurally complete frame ranges (start inclusive, end exclusive). */
  frames: { start: number; end: number }[];
  /** EOF interrupted the final frame at this byte offset. */
  tornStart: number | null;
  /** Structural corruption at this byte offset (bad magic / reserved bits). */
  corruptAt: number | null;
  corruptReason: string | null;
}

/**
 * Locate complete zstd frames in a concatenated-frame container (the session
 * log format dsh appends to). Mirrors the structural scan of the installed
 * `session-persistence-jsonl` zstd module (and the native reader): reserved
 * frame-header bits/types and invalid mid-stream magic are corruption; EOF
 * inside the final frame marks it torn.
 */
export function scanMatchlockZstdFrames(buffer: Buffer): FrameScan {
  const frames: { start: number; end: number }[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) {
      return { frames, tornStart: start, corruptAt: null, corruptReason: null };
    }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      return {
        frames,
        tornStart: null,
        corruptAt: offset,
        corruptReason: `invalid zstd frame magic at byte ${offset}`,
      };
    }
    offset += 4;
    if (offset === buffer.length) {
      return { frames, tornStart: start, corruptAt: null, corruptReason: null };
    }
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) {
      return {
        frames,
        tornStart: null,
        corruptAt: offset - 1,
        corruptReason: `reserved zstd frame-header bit at byte ${offset - 1}`,
      };
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes =
      contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes =
      (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) {
      return { frames, tornStart: start, corruptAt: null, corruptReason: null };
    }
    offset += remainingHeaderBytes;

    let blockHeaderOffset = offset;
    for (;;) {
      if (buffer.length - blockHeaderOffset < 3) {
        return { frames, tornStart: start, corruptAt: null, corruptReason: null };
      }
      const blockHeader = buffer.readUIntLE(blockHeaderOffset, 3);
      blockHeaderOffset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        return {
          frames,
          tornStart: null,
          corruptAt: blockHeaderOffset - 3,
          corruptReason: `reserved zstd block type at byte ${blockHeaderOffset - 3}`,
        };
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - blockHeaderOffset < payloadBytes) {
        return { frames, tornStart: start, corruptAt: null, corruptReason: null };
      }
      blockHeaderOffset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - blockHeaderOffset < 4) {
        return { frames, tornStart: start, corruptAt: null, corruptReason: null };
      }
      blockHeaderOffset += 4;
    }
    frames.push({ start, end: blockHeaderOffset });
    offset = blockHeaderOffset;
  }
  return { frames, tornStart: null, corruptAt: null, corruptReason: null };
}

// ── Header parsing ─────────────────────────────────────────────────

/** Parse the first record of a decoded artifact as a `type:"session"` header. */
export function parseSessionHeader(text: string): DshSessionHeaderParse {
  let first: string | undefined;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      first = trimmed;
      break;
    }
  }
  if (first === undefined) {
    return { header: null, problem: "artifact contains no records" };
  }
  let record: unknown;
  try {
    record = JSON.parse(first);
  } catch {
    return { header: null, problem: "first record is not valid JSON" };
  }
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return { header: null, problem: "first record is not an object" };
  }
  const r = record as Record<string, unknown>;
  if (r.type !== "session") {
    return { header: null, problem: "first record is not a session header" };
  }
  if (r.version !== DSH_CURRENT_SESSION_FORMAT_VERSION) {
    return {
      header: null,
      problem: `unsupported session header version ${String(r.version)}`,
    };
  }
  if (typeof r.id !== "string" || typeof r.createdAt !== "number" || typeof r.isSeeded !== "boolean") {
    return { header: null, problem: "session header missing required fields" };
  }
  if (r.origin !== undefined && r.origin !== "subagent") {
    return { header: null, problem: "session header origin must be \"subagent\"" };
  }
  const header: DshSessionHeader = {
    type: "session",
    version: r.version as number,
    id: r.id as string,
    createdAt: r.createdAt as number,
    isSeeded: r.isSeeded as boolean,
    delegationDepth:
      typeof r.delegationDepth === "number" ? (r.delegationDepth as number) : 0,
    ...(typeof r.cwd === "string" ? { cwd: r.cwd as string } : {}),
    ...(typeof r.parentSession === "string"
      ? { parentSession: r.parentSession as string }
      : {}),
    ...(r.origin === "subagent" ? { origin: "subagent" as const } : {}),
    ...(typeof r.agentPreset === "string" ? { agentPreset: r.agentPreset as string } : {}),
  };
  return { header, problem: null };
}

// ── Usage extraction (dsh convention) ──────────────────────────────

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

interface UsageRecordResult {
  /** Convention tokens counted (uncached input + output). */
  tokens: number;
  counted: boolean;
  /**
   * True when the record is a USAGE-BEARING record whose token fields are
   * malformed or MISSING — the artifact total must then be treated as
   * incomplete, never as a verified total.
   */
  malformed: boolean;
}

function usageFromRecord(record: unknown): UsageRecordResult {
  if (typeof record !== "object" || record === null) {
    return { tokens: 0, counted: false, malformed: false };
  }
  const r = record as Record<string, unknown>;

  // v3 usage lives at the TOP-LEVEL data.usage of assistant/message and
  // compaction/summary records. `inputTokens` is the UNcached prompt input
  // (the real store has no `uncachedInputTokens` key; its totalTokens =
  // inputTokens + outputTokens + cacheReadTokens), so the counted convention
  // is inputTokens + outputTokens. cache-read / cache-write and reasoning
  // buckets are excluded. The same usage is mirrored into
  // data.stream[*].chunk.usage, but this adapter counts the top-level
  // data.usage ONCE and never reads the stream mirror.
  if (r.type === "assistant/message" || r.type === "compaction/summary") {
    const data =
      typeof r.data === "object" && r.data !== null
        ? (r.data as Record<string, unknown>)
        : null;
    const usage =
      data !== null && typeof data.usage === "object" && data.usage !== null
        ? (data.usage as Record<string, unknown>)
        : null;
    if (usage === null) {
      // A compaction/summary that recorded no LLM usage is a legitimate
      // non-usage record. An assistant/message from a non-assistant role (e.g.
      // a user echo) is also a legitimate non-usage record. Only an
      // assistant/message whose role is "assistant" (or unclassifiable) with
      // NO top-level data.usage cannot be verified: no silent skip and no
      // fabricated zero — the total is incomplete.
      if (r.type !== "assistant/message") {
        return { tokens: 0, counted: false, malformed: false };
      }
      const message =
        data !== null && typeof data.message === "object" && data.message !== null
          ? (data.message as Record<string, unknown>)
          : null;
      const role = typeof message?.role === "string" ? message.role : null;
      if (role !== null && role !== "assistant") {
        return { tokens: 0, counted: false, malformed: false };
      }
      return { tokens: 0, counted: false, malformed: true };
    }
    const input = usage.inputTokens;
    const output = usage.outputTokens;
    if (isNonNegativeSafeInteger(input) && isNonNegativeSafeInteger(output)) {
      const sum = input + output;
      // Sum of two safe integers is exact in doubles; still refuse overflow.
      if (Number.isSafeInteger(sum)) {
        return { tokens: sum, counted: true, malformed: false };
      }
      return { tokens: 0, counted: false, malformed: true };
    }
    return { tokens: 0, counted: false, malformed: true };
  }

  if (r.type === "assistant/chunk") {
    // Legacy usage chunks (v0/v1 generations): TokenUsage under
    // data.chunk.usage (or flat on the chunk); inputTokens + outputTokens.
    // An assistant/chunk whose chunk.type is NOT "usage" is a legitimate
    // non-usage record — never counted, never malformed.
    const data =
      typeof r.data === "object" && r.data !== null
        ? (r.data as Record<string, unknown>)
        : null;
    const chunk =
      data !== null && typeof data.chunk === "object" && data.chunk !== null
        ? (data.chunk as Record<string, unknown>)
        : null;
    if (chunk === null) {
      return { tokens: 0, counted: false, malformed: false };
    }
    if (chunk.type !== "usage") {
      return { tokens: 0, counted: false, malformed: false };
    }
    const usage = (typeof chunk.usage === "object" && chunk.usage !== null ? chunk.usage : chunk) as Record<
      string,
      unknown
    >;
    const input = usage.inputTokens;
    const output = usage.outputTokens;
    if (isNonNegativeSafeInteger(input) && isNonNegativeSafeInteger(output)) {
      const sum = input + output;
      if (Number.isSafeInteger(sum)) {
        return { tokens: sum, counted: true, malformed: false };
      }
      return { tokens: 0, counted: false, malformed: true };
    }
    return { tokens: 0, counted: false, malformed: true };
  }

  // Every other record type (session headers, non-usage events, other roles,
  // non-message lines) is a legitimate non-usage record: never counted, never
  // malformed.
  return { tokens: 0, counted: false, malformed: false };
}

/**
 * Sum dsh-convention usage over decoded artifact text. Integrity rules:
 *
 * - A JSON line that does not parse is UNKNOWN data: skipped with bounded
 *   continuation, but the artifact total is marked `usageIncomplete` — a
 *   partial count is never mistaken for a verified total.
 * - A well-formed v3 `assistant/message` without `data.usage` is incomplete
 *   (never a silent skip, never a fabricated zero). A `compaction/summary`
 *   without `data.usage` is a legitimate non-usage record.
 * - Fractional / non-safe-integer counters and totals that would overflow
 *   MAX_SAFE_INTEGER are rejected (malformed / incomplete).
 * - Legitimate non-usage records (session headers, other roles, non-usage
 *   chunks, the `data.stream` chunk mirror) are distinguished and never
 *   counted as usage records.
 */
export function extractMatchlockUsage(text: string): {
  usageTokens: number | null;
  usageIncomplete: boolean;
  usageRecords: number;
} {
  let total = 0;
  let records = 0;
  let malformed = false;
  let unknownLine = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      unknownLine = true; // skipped line, bounded continuation — total incomplete
      continue;
    }
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      unknownLine = true; // JSONL session events are objects; anything else is unknown
      continue;
    }
    const usage = usageFromRecord(record);
    if (usage.malformed) malformed = true;
    if (usage.counted) {
      // Per-record tokens are already safe integers; guard the running total
      // against overflow beyond MAX_SAFE_INTEGER (never a silently truncated
      // or wrapped total).
      if (!Number.isSafeInteger(total + usage.tokens)) {
        malformed = true;
        continue;
      }
      total += usage.tokens;
      records += 1;
    }
  }
  return {
    usageTokens: records > 0 ? total : null,
    usageIncomplete: malformed || unknownLine,
    usageRecords: records,
  };
}

// ── Artifact read ──────────────────────────────────────────────────

function sniffEncoding(buf: Buffer): DshStoreEncoding | "unknown" {
  if (buf.length >= 4 && buf.readUInt32LE(0) === ZSTD_MAGIC) return "zstd";
  let i = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    i = 3; // skip UTF-8 BOM
  }
  while (i < buf.length && /\s/.test(String.fromCharCode(buf[i]))) i += 1;
  if (i < buf.length && buf[i] === 0x7b /* '{' */) return "plain";
  return "unknown";
}

/** Outcome of a bounded zstd multi-frame decode. */
interface ZstdFrameDecodeResult {
  /** Concatenated decoded UTF-8 text when every admitted frame decoded. */
  text: string | null;
  /** Structural decode failure (invalid frame payload). */
  decodeError: string | null;
  /** Explicit bounded-limit refusal (frame count / per-frame / total bytes). */
  overLimitReason: string | null;
}

function decodeZstdFrames(
  buffer: Buffer,
  scan: FrameScan,
  limits: DshArtifactLimits,
): ZstdFrameDecodeResult {
  const nodeZstd = detectNodeZstdDecompress();
  if (nodeZstd === undefined) {
    return { text: null, decodeError: "node:zlib zstd decoder unavailable", overLimitReason: null };
  }
  if (scan.frames.length > limits.maxFrames) {
    return {
      text: null,
      decodeError: null,
      overLimitReason: `artifact carries ${scan.frames.length} zstd frames (bounded-read frame limit ${limits.maxFrames})`,
    };
  }
  const parts: Buffer[] = [];
  let total = 0;
  for (const frame of scan.frames) {
    let decoded: Buffer;
    try {
      decoded = nodeZstd(buffer.subarray(frame.start, frame.end));
    } catch (err) {
      return {
        text: null,
        decodeError: `zstd frame at byte ${frame.start} failed validation: ${
          err instanceof Error ? err.message : String(err)
        }`,
        overLimitReason: null,
      };
    }
    if (decoded.length > limits.maxDecodedBytesPerFrame) {
      return {
        text: null,
        decodeError: null,
        overLimitReason: `zstd frame at byte ${frame.start} decoded to ${decoded.length} bytes (per-frame bounded-read limit ${limits.maxDecodedBytesPerFrame})`,
      };
    }
    if (total + decoded.length > limits.maxTotalDecodedBytes) {
      return {
        text: null,
        decodeError: null,
        overLimitReason: `decoded artifact exceeds the ${limits.maxTotalDecodedBytes}-byte total bounded-read limit`,
      };
    }
    parts.push(decoded);
    total += decoded.length;
  }
  return { text: Buffer.concat(parts).toString("utf8"), decodeError: null, overLimitReason: null };
}

/** Build the shared non-decoded refusal/limit classification shape. */
function artifactRefusal(opts: {
  fileName: string;
  generation: number;
  encoding: DshStoreEncoding;
  decode: DshArtifactDecodeStatus;
  reason: string;
}): DshSessionArtifactRead {
  return {
    fileName: opts.fileName,
    generation: opts.generation,
    encoding: opts.encoding,
    decode: opts.decode,
    text: null,
    partialText: null,
    incomplete: true,
    header: null,
    headerProblem: opts.reason,
    usageTokens: null,
    usageIncomplete: true,
    usageRecords: 0,
  };
}

type HostArtifactAdmission =
  | { kind: "ok"; size: number }
  | { kind: "missing" }
  | { kind: "refused"; reason: string }
  | { kind: "over-limit"; reason: string };

/**
 * Host-read admission for one artifact path inside an admitted store root.
 *
 * The accepted threat model is that the guest may rewrite the ENTIRE mounted
 * config, so this admission is only a deterministic first barrier (used for
 * PRE-LAUNCH inventory and for host-owned retained evidence copies whose tree
 * the guest cannot reach). A lexical predicate or realpath-then-open does NOT
 * close a host-side TOCTOU race; POST-guest attribution evidence must be
 * obtained by the confined guest-side bounded read while the VM is still
 * owned (never a general host read/SQL/shell bridge). This barrier refuses,
 * before any open:
 *
 * - artifact paths not lexically inside `admittedRoot`;
 * - any symlink component between `admittedRoot` and the artifact (leaf or
 *   ancestor) — the host reader never follows symlinks out of the store;
 * - non-regular leaf files (fifo/socket/dir);
 * - artifacts whose resolved realpath escapes the admitted root;
 * - artifacts larger than `maxArtifactBytes` (bounded read).
 */
function admitHostArtifactRead(opts: {
  artifactPath: string;
  admittedRoot?: string;
  maxArtifactBytes: number;
}): HostArtifactAdmission {
  const { artifactPath, admittedRoot, maxArtifactBytes } = opts;

  const refuseNonRegular = (st: fs.Stats, pathLabel: string): HostArtifactAdmission => {
    if (st.isSymbolicLink()) {
      return {
        kind: "refused",
        reason: `${pathLabel} is a symlink — the host reader never follows symlinks out of the admitted config`,
      };
    }
    if (!st.isFile()) {
      return { kind: "refused", reason: `${pathLabel} is not a regular file` };
    }
    return { kind: "ok", size: st.size };
  };

  if (admittedRoot !== undefined) {
    const rel = path.relative(admittedRoot, artifactPath);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      return {
        kind: "refused",
        reason: `artifact path escapes the admitted store root ${admittedRoot}`,
      };
    }
    // Walk every component below the admitted root (including the leaf).
    const relParts = rel.split(path.sep).filter((p) => p.length > 0 && p !== ".");
    let current = admittedRoot;
    for (let i = 0; i < relParts.length; i++) {
      current = path.join(current, relParts[i]);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(current);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
        return {
          kind: "refused",
          reason: `artifact path component ${current} is unreadable: ${String(err)}`,
        };
      }
      if (st.isSymbolicLink()) {
        return {
          kind: "refused",
          reason: `artifact path component ${current} is a symlink — refusing a host-follow read outside the admitted store`,
        };
      }
      if (i === relParts.length - 1) {
        const nonRegular = refuseNonRegular(st, `artifact path ${artifactPath}`);
        if (nonRegular.kind !== "ok") return nonRegular;
      }
    }
    // Every component below the admitted root was a real non-symlink path at
    // admission time; double-check resolved containment against the real root.
    let realRoot: string;
    let realArtifact: string;
    try {
      realRoot = fs.realpathSync(admittedRoot);
      realArtifact = fs.realpathSync(artifactPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
      return {
        kind: "refused",
        reason: `artifact path ${artifactPath} is unreadable: ${String(err)}`,
      };
    }
    if (realArtifact !== realRoot && !realArtifact.startsWith(realRoot + path.sep)) {
      return {
        kind: "refused",
        reason: `artifact path ${artifactPath} resolves outside the admitted store root ${realRoot}`,
      };
    }
    const st = fs.statSync(artifactPath);
    if (st.size > maxArtifactBytes) {
      return {
        kind: "over-limit",
        reason: `artifact ${artifactPath} is ${st.size} bytes (bounded-read artifact limit ${maxArtifactBytes})`,
      };
    }
    return { kind: "ok", size: st.size };
  }

  // No admitted root supplied: still refuse symlink/non-regular leaves and
  // cap the artifact size (the caller is responsible for confining ancestors).
  let st: fs.Stats;
  try {
    st = fs.lstatSync(artifactPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "refused", reason: `artifact path ${artifactPath} is unreadable: ${String(err)}` };
  }
  const leaf = refuseNonRegular(st, `artifact path ${artifactPath}`);
  if (leaf.kind !== "ok") return leaf;
  if (leaf.size > maxArtifactBytes) {
    return {
      kind: "over-limit",
      reason: `artifact ${artifactPath} is ${leaf.size} bytes (bounded-read artifact limit ${maxArtifactBytes})`,
    };
  }
  return { kind: "ok", size: leaf.size };
}

/**
 * Read and classify one session artifact. `usageTokens` follows the dsh
 * convention (uncached input + output, cache-read/cache-write/reasoning
 * excluded). Returns a full classification — never throws for data problems.
 *
 * `admittedRoot` confines the host read to the admitted store: symlinked leaf
 * or ancestor components and outside-store paths are REFUSED before any open,
 * and explicit bounded limits (`limits`) cap artifact size, frame count and
 * decoded bytes so a guest-mutated artifact can never trigger unbounded
 * decompression. See {@link admitHostArtifactRead} for the boundary note.
 */
export function readDshSessionArtifact(opts: {
  artifactPath: string;
  admittedRoot?: string;
  limits?: Partial<DshArtifactLimits>;
}): DshSessionArtifactRead {
  const { artifactPath } = opts;
  const limits: DshArtifactLimits = { ...DSH_DEFAULT_ARTIFACT_LIMITS, ...opts.limits };
  const fileName = path.basename(artifactPath);
  let generation: number;
  {
    const parsed = canonicalGeneration(fileName);
    generation = parsed === undefined ? 0 : parsed;
  }
  let encoding: DshStoreEncoding;
  {
    const enc = fileNameEncoding(fileName);
    encoding = enc === null ? "plain" : enc;
  }

  const admission = admitHostArtifactRead({
    artifactPath,
    admittedRoot: opts.admittedRoot,
    maxArtifactBytes: limits.maxArtifactBytes,
  });
  if (admission.kind === "refused") {
    return artifactRefusal({ fileName, generation, encoding, decode: "refused", reason: admission.reason });
  }
  if (admission.kind === "over-limit") {
    return artifactRefusal({ fileName, generation, encoding, decode: "over-limit", reason: admission.reason });
  }
  if (admission.kind === "missing") {
    return artifactRefusal({
      fileName,
      generation,
      encoding,
      decode: "missing-artifact",
      reason: "artifact unreadable",
    });
  }

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(artifactPath);
  } catch {
    return artifactRefusal({
      fileName,
      generation,
      encoding,
      decode: "missing-artifact",
      reason: "artifact unreadable",
    });
  }
  if (buffer.length > limits.maxArtifactBytes) {
    return artifactRefusal({
      fileName,
      generation,
      encoding,
      decode: "over-limit",
      reason: `artifact is ${buffer.length} bytes (bounded-read artifact limit ${limits.maxArtifactBytes})`,
    });
  }

  // ── Byte sniff: does the actual content match the filename encoding? ──
  const sniff = sniffEncoding(buffer);

  if (encoding === "plain" && sniff !== "plain") {
    const reason =
      sniff === "zstd"
        ? ".jsonl artifact actually holds zstd bytes"
        : buffer.length === 0
          ? "empty artifact (flush incomplete)"
          : "plain artifact does not begin with JSON text";
    return artifactRefusal({
      fileName,
      generation,
      encoding,
      decode: buffer.length === 0 ? "torn" : "unknown-format",
      reason,
    });
  }

  let decode: DshArtifactDecodeStatus = "ok";
  let text: string | null = null;
  let partialText: string | null = null;
  let headerProblem: string | null = null;

  if (encoding === "plain") {
    decode = "ok";
    text = buffer.toString("utf8");
  } else {
    // ── zstd concatenated-frame decode (bounded) ──
    if (sniff === "plain") {
      return artifactRefusal({
        fileName,
        generation,
        encoding,
        decode: "unknown-format",
        reason: ".zstd artifact does not begin with a zstd frame magic",
      });
    }
    if (sniff === "unknown") {
      return artifactRefusal({
        fileName,
        generation,
        encoding,
        decode: buffer.length === 0 ? "torn" : "unknown-format",
        reason:
          buffer.length === 0 ? "empty artifact (flush incomplete)" : "artifact is neither zstd nor JSONL",
      });
    }
    if (!matchlockNodeZstdAvailable()) {
      return artifactRefusal({
        fileName,
        generation,
        encoding,
        decode: "zstd-unavailable",
        reason: "node:zlib zstd decoder unavailable on this Node",
      });
    }
    const scan = scanMatchlockZstdFrames(buffer);
    if (scan.corruptAt !== null) {
      return artifactRefusal({
        fileName,
        generation,
        encoding,
        decode: "corrupt",
        reason: scan.corruptReason ?? `corrupt zstd at byte ${scan.corruptAt}`,
      });
    }
    const decoded = decodeZstdFrames(buffer, scan, limits);
    if (decoded.overLimitReason !== null) {
      return artifactRefusal({
        fileName,
        generation,
        encoding,
        decode: "over-limit",
        reason: decoded.overLimitReason,
      });
    }
    if (decoded.decodeError !== null) {
      return artifactRefusal({
        fileName,
        generation,
        encoding,
        decode: "corrupt",
        reason: decoded.decodeError,
      });
    }
    if (scan.tornStart !== null) {
      decode = "torn";
      partialText = decoded.text ?? "";
    } else {
      decode = "ok";
      text = decoded.text;
    }
  }

  const decodeText = text ?? partialText ?? "";
  const headerParse =
    decodeText.length === 0
      ? { header: null, problem: "artifact contains no records" }
      : parseSessionHeader(decodeText);
  const usage =
    decodeText.length === 0
      ? { usageTokens: null, usageIncomplete: true, usageRecords: 0 }
      : extractMatchlockUsage(decodeText);

  const incomplete = decode === "torn";
  const usageIncomplete = incomplete || usage.usageIncomplete;
  return {
    fileName,
    generation,
    encoding,
    decode,
    text,
    partialText,
    incomplete,
    header: headerParse.header,
    headerProblem: headerParse.problem,
    usageTokens: usage.usageTokens,
    usageIncomplete,
    usageRecords: usage.usageRecords,
  };
}
