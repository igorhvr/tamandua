/**
 * dsh (DeepSeek Harness) token usage reader — session-file strategy.
 *
 * dsh never prints token usage to stdout. Usage is recorded only in the
 * session log at:
 *
 *   $DSH_HOME/sessions/<escaped-cwd>/session-<uuid>/session.jsonl.zstd
 *
 * as `assistant/chunk` events whose `chunk.type === "usage"`
 * ({inputTokens, outputTokens, cacheReadTokens, ...}). This module reads
 * that file after a dsh round and returns input + output tokens,
 * excluding cache reads (matching the hermes convention of excluding
 * cache reads).
 *
 * cwd escaping (`projectKey`) is replicated exactly from dsh's session
 * persistence source
 * (packages/session/session-persistence-jsonl/src/format.ts): `/`, `\`,
 * and `:` collapse to `-` (runs collapse to one); safe `[A-Za-z0-9._-]`
 * UTF-16 units stay literal; every other unit becomes `~XXXX`; the
 * result is wrapped in `--…--` and bounded at 251 chars.
 *
 * The session.jsonl.zstd artifact is a concatenated zstd frame container
 * (one frame for the header + first batch, one frame per durable append),
 * so decompression scans frames structurally and decodes each frame
 * separately. node:zlib `zstdDecompressSync` exists on Node >= 23.8;
 * `engines` allows >= 22, so older Node falls back to spawning
 * `zstd -dc`. When neither is available the lookup warns and returns
 * null (0 tokens).
 *
 * Best-effort throughout: ANY failure returns null with one warning —
 * never throws into the dispatch path, never blocks step completion.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import zlib from "node:zlib";
import { logger } from "../lib/logger.js";

// ── Types ──────────────────────────────────────────────────────────

/** Result of a successful session-file token lookup. */
export interface DshSessionUsage {
  /** inputTokens + outputTokens across usage chunks (cacheReadTokens excluded). */
  totalTokens: number;
  /** The session directory name (e.g. `session-<uuid>`) the usage was read from. */
  sessionRef: string;
}

/** zstd decompression tier selection for {@link lookupDshSessionTokens}. */
export type DshZstdStrategy = "auto" | "node" | "binary" | "none";

export interface LookupDshSessionTokensOptions {
  /** Unix epoch ms at which the dsh worker was spawned. */
  spawnedAtMs: number;
  /** Absolute working directory the worker ran in (drives the escaped-cwd session subdirectory). */
  workdir: string;
  /** Environment used to resolve $DSH_HOME (defaults to process.env, then ~/.dsh). */
  env?: NodeJS.ProcessEnv;
  /**
   * zstd decompression tier. "auto" (default) prefers node:zlib
   * `zstdDecompressSync` and falls back to a `zstd -dc` spawn when the
   * Node API is absent; tests may pin a tier to exercise fallbacks
   * deterministically.
   */
  zstdStrategy?: DshZstdStrategy;
}

// ── dsh session-store layout ───────────────────────────────────────

/**
 * Resolve the dsh home directory from the given env (falls back to
 * process.env, then ~/.dsh).
 */
export function resolveDshHome(env?: NodeJS.ProcessEnv): string {
  return (
    env?.DSH_HOME ??
    process.env.DSH_HOME ??
    path.join(os.homedir(), ".dsh")
  );
}

/**
 * Encode a cwd as dsh's per-project session directory key.
 *
 * Replicates dsh's `projectKey` exactly (session-persistence-jsonl
 * `format.ts`): `/`, `\`, and `:` collapse to `-` (consecutive
 * separators collapse to one); safe `[A-Za-z0-9._-]` UTF-16 code units
 * stay literal; every other code unit (including lone surrogates)
 * becomes `~XXXX`; a leading separator run is stripped (or replaced by
 * `root` for an all-separator input); the result is wrapped in `--…--`
 * and bounded at 251 chars.
 */
export function projectKey(cwd: string): string {
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

/**
 * The per-workdir sessions directory under a dsh home
 * (`$DSH_HOME/sessions/<escaped-cwd>`).
 */
export function dshSessionProjectDir(dshHome: string, workdir: string): string {
  return path.join(dshHome, "sessions", projectKey(workdir));
}

// ── Token lookup ───────────────────────────────────────────────────

/**
 * Read token usage for the dsh round that was spawned at `spawnedAtMs`
 * in `workdir`, from dsh's own session files.
 *
 * Strategy: scan `$DSH_HOME/sessions/<escaped-cwd-of-workdir>/` for
 * session directories whose mtime is >= the spawn time (dsh creates the
 * directory when the session starts, so older sessions from other
 * processes are excluded), pick the newest, decompress its
 * `session.jsonl.zstd`, and sum `inputTokens + outputTokens` over every
 * `assistant/chunk` usage record (`cacheReadTokens` excluded).
 *
 * `sessionRef` is the winning session directory name. Best-effort
 * throughout: any failure (missing dir, no candidates, corrupt log, no
 * zstd support, no usage chunks) returns `null` with ONE warning — the
 * caller falls back to 0 tokens.
 *
 * @returns total tokens + sessionRef, or `null` when unavailable.
 */
export async function lookupDshSessionTokens(
  options: LookupDshSessionTokensOptions,
): Promise<DshSessionUsage | null> {
  try {
    const { spawnedAtMs, workdir } = options;

    if (typeof spawnedAtMs !== "number" || !Number.isFinite(spawnedAtMs)) {
      logger.warn("dsh session token lookup failed", {
        reason: "invalid spawn timestamp",
        spawnedAtMs,
      });
      return null;
    }
    if (typeof workdir !== "string" || workdir.length === 0) {
      logger.warn("dsh session token lookup failed", {
        reason: "missing worker working directory",
      });
      return null;
    }

    const dshHome = resolveDshHome(options.env);
    const sessionsDir = dshSessionProjectDir(dshHome, workdir);

    // ── Session candidate scan ─────────────────────────────────
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
    } catch {
      logger.warn("dsh session token lookup failed: no sessions dir", {
        sessionsDir,
        workdir,
      });
      return null;
    }

    interface Candidate {
      name: string;
      logPath: string;
      mtimeMs: number;
    }

    const candidates: Candidate[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const logPath = path.join(sessionsDir, entry.name, "session.jsonl.zstd");
      try {
        if (!fs.existsSync(logPath)) continue;
        const mtimeMs = fs.statSync(path.join(sessionsDir, entry.name)).mtimeMs;
        candidates.push({ name: entry.name, logPath, mtimeMs });
      } catch {
        // unreadable/vanished entry — skip
      }
    }

    const eligible = candidates
      .filter((c) => c.mtimeMs >= spawnedAtMs)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    if (eligible.length === 0) {
      logger.warn("dsh session token lookup failed: no session created since spawn", {
        sessionsDir,
        workdir,
        spawnedAtMs,
      });
      return null;
    }

    // Newest session since spawn time wins.
    const session = eligible[0];

    // ── Decompress + parse ─────────────────────────────────────
    const text = await decompressSessionLog(
      session.logPath,
      options.zstdStrategy ?? "auto",
      options.env,
    );
    if (text === null) {
      // decompressSessionLog already warned.
      return null;
    }

    const totalTokens = sumUsageChunks(text);
    if (totalTokens === null) {
      logger.warn("dsh session token lookup found no usage chunks", {
        sessionRef: session.name,
        logPath: session.logPath,
      });
      return null;
    }

    return { totalTokens, sessionRef: session.name };
  } catch (err) {
    // Belt-and-braces: the dispatch path must never see a throw.
    logger.warn("dsh session token lookup failed", {
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── zstd decompression ─────────────────────────────────────────────

/** zstd frame magic 0xFD2FB528 (little-endian). */
const ZSTD_MAGIC = 0xfd2fb528;

interface ZstdFrameRange {
  /** Inclusive frame start. */
  start: number;
  /** Exclusive frame end. */
  end: number;
}

/**
 * Feature-detect node:zlib's synchronous zstd decoder (Node >= 23.8).
 * `engines` allows Node >= 22, where the named export does not exist,
 * so the detection goes through the namespace object instead of a
 * direct import (a direct named import would be a load-time error on
 * Node 22).
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
 * Feature-detect node:zlib's synchronous zstd decoder (Node >= 23.8).
 * Exported for doctor diagnostics: when neither this nor a `zstd`
 * binary on PATH is available, dsh token accounting falls back to
 * 0 tokens with a warning.
 */
export function nodeZstdDecompressAvailable(): boolean {
  return detectNodeZstdDecompress() !== undefined;
}

/**
 * Structurally locate complete zstd frames in a concatenated-frame
 * container (the session log format dsh appends to). Mirrors dsh's own
 * `scanZstdFrames` (session-persistence-jsonl `zstd.ts`) — reserved
 * bits/types reject, and any truncated header/block/checksum throws.
 */
function scanZstdFrames(buffer: Buffer): ZstdFrameRange[] {
  const frames: ZstdFrameRange[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) {
      throw new Error(`corrupt zstd: truncated frame magic at byte ${offset}`);
    }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt zstd: invalid frame magic at byte ${offset}`);
    }
    offset += 4;

    if (offset === buffer.length) {
      throw new Error(`corrupt zstd: truncated frame header at byte ${offset}`);
    }
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt zstd: reserved frame-header bit at byte ${offset - 1}`);
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
      throw new Error(`corrupt zstd: truncated frame header at byte ${offset}`);
    }
    offset += remainingHeaderBytes;

    for (;;) {
      if (buffer.length - offset < 3) {
        throw new Error(`corrupt zstd: truncated block header at byte ${offset}`);
      }
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        throw new Error(`corrupt zstd: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) {
        throw new Error(`corrupt zstd: truncated block payload at byte ${offset}`);
      }
      offset += payloadBytes;
      if (lastBlock) break;
    }

    if (checksum) {
      if (buffer.length - offset < 4) {
        throw new Error(`corrupt zstd: truncated checksum at byte ${offset}`);
      }
      offset += 4;
    }

    frames.push({ start, end: offset });
  }

  return frames;
}

/**
 * Decompress the session log via the selected strategy. Returns the
 * plaintext JSONL, or null after one warning on any failure.
 */
async function decompressSessionLog(
  logPath: string,
  strategy: DshZstdStrategy,
  env?: NodeJS.ProcessEnv,
): Promise<string | null> {
  const nodeZstd = detectNodeZstdDecompress();

  if (strategy === "node" || (strategy === "auto" && nodeZstd !== undefined)) {
    if (nodeZstd === undefined) {
      logger.warn("dsh session token lookup skipped: node:zlib zstd unavailable", {
        logPath,
      });
      return null;
    }
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(logPath);
    } catch (err) {
      logger.warn("dsh session token lookup failed to read session log", {
        logPath,
        reason: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    try {
      const frames = scanZstdFrames(buffer);
      const parts: Buffer[] = [];
      for (const frame of frames) {
        parts.push(nodeZstd(buffer.subarray(frame.start, frame.end)));
      }
      return Buffer.concat(parts).toString("utf8");
    } catch (err) {
      logger.warn("dsh session token lookup failed to decompress session log", {
        logPath,
        reason: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  if (strategy === "none") {
    logger.warn("dsh session token lookup skipped: no zstd support available", {
      logPath,
    });
    return null;
  }

  // "binary" (or "auto" on Node < 23.8): spawn `zstd -dc`, which handles
  // concatenated frames natively.
  try {
    const childEnv: NodeJS.ProcessEnv = {
      ...(process.env as NodeJS.ProcessEnv),
      ...(env ?? {}),
    };
    const stdout = await runZstdBinary(logPath, childEnv);
    return stdout;
  } catch (err) {
    logger.warn("dsh session token lookup failed: zstd binary unavailable or failed", {
      logPath,
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Spawn `zstd -dc <file>` and resolve its stdout as UTF-8 text.
 * Rejects when the binary is missing (ENOENT), exits non-zero, times
 * out, or exceeds the 64MB decoded-output bound (session logs are
 * bounded well below that in practice).
 */
function runZstdBinary(filePath: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "zstd",
      ["-dc", filePath],
      {
        encoding: "buffer",
        env,
        timeout: 15_000,
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve((stdout as Buffer).toString("utf8"));
      },
    );
  });
}

// ── JSONL usage parsing ────────────────────────────────────────────

interface DshUsageNumbers {
  inputTokens?: unknown;
  outputTokens?: unknown;
}

/**
 * Sum input+output tokens across all `assistant/chunk` records whose
 * `chunk.type === "usage"` in a session log. cacheReadTokens (and any
 * other usage field) is excluded, matching the hermes convention.
 *
 * dsh serializes the usage numbers under `chunk.usage` (TokenUsage);
 * flat fields directly on the chunk are also tolerated for forward
 * compatibility with fixture variants. Non-numeric/negative values
 * count as 0. Lines that fail to parse are skipped (best effort).
 *
 * @returns the rounded total, or `null` when the log contained no
 *          recognizable usage chunk at all.
 */
export function sumUsageChunks(text: string): number | null {
  let total = 0;
  let found = false;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue; // best-effort per line
    }
    if (typeof record !== "object" || record === null) continue;

    if ((record as { type?: unknown }).type !== "assistant/chunk") continue;

    const data = (record as { data?: unknown }).data;
    if (typeof data !== "object" || data === null) continue;

    const chunk = (data as { chunk?: unknown }).chunk;
    if (typeof chunk !== "object" || chunk === null) continue;
    if ((chunk as { type?: unknown }).type !== "usage") continue;

    // dsh TokenUsage travels under chunk.usage; tolerate flat fields too.
    const usage = ((chunk as { usage?: unknown }).usage ?? chunk) as DshUsageNumbers;
    if (typeof usage !== "object" || usage === null) continue;

    const input = toNonNegative(usage.inputTokens);
    const output = toNonNegative(usage.outputTokens);
    total += input + output;
    found = true;
  }

  return found ? Math.round(total) : null;
}

/** Non-negative finite number, or 0 for anything else. */
function toNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}
