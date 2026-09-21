/**
 * Guest-side bounded file transfer helpers.
 *
 * The guest CLI opens guest files itself (relative to the guest caller cwd),
 * reads them once and sends bounded CONTENT across the bridge. A guest
 * filename is NEVER forwarded for the host to open. Content is size-limited so
 * an oversized file cannot exhaust the framed transport.
 *
 * Error wording mirrors the native step CLI (src/cli/commands/step.ts) so the
 * guest surface behaves identically. Node-core only — safe for the pack.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  MAX_CONTENT_LINES,
  MAX_REASON_BYTES,
  MAX_REPORT_BYTES,
  MAX_STORIES_JSON_FILE_BYTES,
} from "./guest-protocol.js";

export type ReadTextResult =
  | { ok: true; text: string }
  | { ok: false; message: string };

type RawRead =
  | { ok: true; text: string }
  | { ok: false; kind: "missing" | "oversized" | "lines" | "io"; sysMessage?: string };

/**
 * Open + bounded read of an already-resolved path. Returns raw failure kinds;
 * callers format native-parity messages.
 */
function openAndReadBounded(resolvedPath: string, maxBytes: number): RawRead {
  let fd: number;
  try {
    fd = fs.openSync(resolvedPath, "r");
  } catch (err) {
    return { ok: false, kind: "missing", sysMessage: (err as NodeJS.ErrnoException).message };
  }
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size > maxBytes) {
      return { ok: false, kind: "oversized", sysMessage: `size ${stat.size} exceeds ${maxBytes} bytes` };
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const scratch = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const n = fs.readSync(fd, scratch, 0, scratch.byteLength, total);
      if (n <= 0) break;
      total += n;
      if (total > maxBytes) {
        return { ok: false, kind: "oversized", sysMessage: `size exceeds ${maxBytes} bytes` };
      }
      chunks.push(Buffer.from(scratch.subarray(0, n)));
    }
    const text = Buffer.concat(chunks).toString("utf-8").trim();
    const lineCount = text.length === 0 ? 0 : text.split("\n").length;
    if (lineCount > MAX_CONTENT_LINES) {
      return { ok: false, kind: "lines", sysMessage: `${lineCount} lines exceeds ${MAX_CONTENT_LINES}` };
    }
    return { ok: true, text };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* best-effort close */
    }
  }
}

/**
 * Native --file / --reason-file read. `flag` is "--file" or "--reason-file"
 * for error wording; resolves `filePath` against `callerCwd`.
 */
export function readFlagFileBounded(
  filePath: string,
  callerCwd: string,
  flag: "--file" | "--reason-file",
): ReadTextResult {
  const resolvedPath = path.resolve(callerCwd, filePath);
  const maxBytes = flag === "--file" ? MAX_REPORT_BYTES : MAX_REASON_BYTES;
  const raw = openAndReadBounded(resolvedPath, maxBytes);
  if (raw.ok) return raw;
  switch (raw.kind) {
    case "missing":
      return { ok: false, message: `Cannot read ${flag} "${filePath}": ${raw.sysMessage ?? "error"}` };
    case "oversized":
      return {
        ok: false,
        message: `Cannot read ${flag} "${filePath}": file is too large to transfer (limit ${maxBytes} bytes)`,
      };
    case "lines":
      return {
        ok: false,
        message: `Cannot read ${flag} "${filePath}": ${raw.sysMessage ?? "too many lines"}`,
      };
    default:
      return { ok: false, message: `Cannot read ${flag} "${filePath}"` };
  }
}

/**
 * Dereference a STORIES_JSON_FILE line inside a report, mirroring native
 * step.ts: resolve relative to caller cwd, read bounded, require a valid JSON
 * array, replace the line with `STORIES_JSON: <minified>` (first match only).
 */
export function dereferenceStoriesJsonFile(output: string, callerCwd: string): ReadTextResult {
  const sjfMatch = output.match(/^STORIES_JSON_FILE:\s*(.+)$/m);
  if (!sjfMatch) return { ok: true, text: output };
  const filePath = sjfMatch[1].trim();
  const resolvedPath = path.resolve(callerCwd, filePath);
  const raw = openAndReadBounded(resolvedPath, MAX_STORIES_JSON_FILE_BYTES);
  if (!raw.ok) {
    if (raw.kind === "missing") {
      return {
        ok: false,
        message: `STORIES_JSON_FILE error: cannot read file "${filePath}": ${raw.sysMessage ?? "error"}`,
      };
    }
    return {
      ok: false,
      message: `STORIES_JSON_FILE error: file "${filePath}" is too large to transfer (limit ${MAX_STORIES_JSON_FILE_BYTES} bytes)`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.text);
  } catch (err) {
    return {
      ok: false,
      message: `STORIES_JSON_FILE error: file "${filePath}" does not contain valid JSON: ${(err as Error).message}`,
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      message: `STORIES_JSON_FILE error: file "${filePath}" must contain a JSON array, got ${typeof parsed}`,
    };
  }
  const minified = JSON.stringify(parsed);
  const replaced = output.replace(/^STORIES_JSON_FILE:\s*.+$/m, `STORIES_JSON: ${minified}`);
  return { ok: true, text: replaced };
}

export const REPORT_MAX_BYTES = MAX_REPORT_BYTES;
export const REASON_MAX_BYTES = MAX_REASON_BYTES;
