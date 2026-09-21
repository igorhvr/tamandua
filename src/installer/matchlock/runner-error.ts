/**
 * runner-error.ts — the typed Matchlock runner/infrastructure error.
 *
 * MTLK-INTEGRATE US-003 (pi+hermes+dsh union): this error class is a LEAF with
 * no imports so the hermes/dsh invocation runners and the scheduler seam can
 * subclass or consume it WITHOUT a module-evaluation-time dependency on
 * pi-invocation-runner. Otherwise the documented import cycle
 * (pi-invocation-runner → native-step-services → step-ops →
 * agent-scheduler → scheduler-matchlock → hermes-invocation-runner →
 * pi-invocation-runner) TDZ-crashes on `extends MatchlockRunnerError` when a
 * test enters the graph through scheduler-dsh first.
 *
 * pi-invocation-runner re-exports this binding so every existing importer
 * (`from "./pi-invocation-runner.js"`) keeps working unchanged.
 */

/** Typed runner/infrastructure error (fail-closed; distinct from a guest round outcome). */
export class MatchlockRunnerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MatchlockRunnerError";
    this.code = code;
  }
}

/**
 * Byte bound for an error's appended stderr tail / serialized body. Bounded so
 * a multi-megabyte Firecracker/RPC stderr dump can never flood a run event,
 * the daemon log or the force-fail reason.
 */
export const MATCHLOCK_ERROR_TAIL_MAX_BYTES = 2048;

/**
 * Truncate `text` to at most `maxBytes` UTF-8 bytes without splitting a
 * multi-byte sequence, appending an explicit marker when it was cut.
 */
export function boundMatchlockErrorText(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = "…[truncated]";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  const cut = Buffer.from(text, "utf8").subarray(0, budget).toString("utf8").replace(/\uFFFD+$/u, "");
  return `${cut}${marker}`;
}

function matchlockErrorTail(rec: Record<string, unknown>, maxBytes: number): string | null {
  for (const key of ["stderrTail", "stderr_tail"] as const) {
    const value = rec[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return boundMatchlockErrorText(value, maxBytes);
    }
  }
  return null;
}

/**
 * Render ANY error surfaced by the Matchlock runner/probe/controller into a
 * legible, bounded string. This exists because the RPC client rejects with a
 * PLAIN body object (`{ code, message }`, optionally carrying a `stderrTail`),
 * so the pre-fix `String(err)` produced `[object Object]` and hid the real
 * failure (F4: the Firecracker SUN_LEN message).
 *
 *   - Error -> its message;
 *   - RPC body `{ code, message }` -> `matchlock rpc error <code>: <message>`
 *     (+ the bounded stderr tail when the body carries `stderrTail` /
 *     `stderr_tail`);
 *   - anything else -> bounded JSON.stringify (NEVER `[object Object]`).
 */
export function describeMatchlockError(
  err: unknown,
  opts: { maxTailBytes?: number } = {},
): string {
  const maxBytes = opts.maxTailBytes ?? MATCHLOCK_ERROR_TAIL_MAX_BYTES;
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const rec = err as Record<string, unknown>;
    const code = rec.code;
    const message = rec.message;
    if ((typeof code === "number" || typeof code === "string") && typeof message === "string") {
      let text = `matchlock rpc error ${String(code)}: ${message}`;
      const tail = matchlockErrorTail(rec, maxBytes);
      if (tail !== null) text += `; stderr tail: ${tail}`;
      return text;
    }
    try {
      const json = JSON.stringify(err);
      if (typeof json === "string" && json.length > 0) {
        return boundMatchlockErrorText(json, maxBytes);
      }
    } catch {
      // Circular / non-serializable body: fall through to a bounded tag.
    }
    return "[unserializable matchlock error]";
  }
  return String(err);
}

/**
 * MTLK-CLEANUP US-001: where an error was raised on the Matchlock invocation
 * path, plus the exact owned VM it belonged to. All fields are optional; every
 * present field is rendered into the serialized single-line output.
 */
export interface MatchlockErrorContext {
  /** Owned VM id when known (`vm-…`); absent before a VM was created. */
  vmId?: string | null;
  /**
   * Failing phase: `create` / `probe` / `exec` / `close` / `dispose` (or a
   * finer site such as `broker-close` / `suite-store-close`).
   */
  phase?: string;
  /** Bare run id the invocation belonged to. */
  runId?: string;
  /** Host-bound invocation id. */
  invocationId?: string;
  /**
   * Controller/RPC stderr tail captured by the caller. When present it wins
   * over any `stderrTail` carried on the error body.
   */
  stderrTail?: string | null;
}

export interface SerializeMatchlockErrorOptions {
  /** Byte bound for the whole rendering (default MATCHLOCK_ERROR_TAIL_MAX_BYTES). */
  maxBytes?: number;
  /** Stack frames appended (default 4, clamped to 1..5). */
  maxStackFrames?: number;
}

/** Pick a JSON-RPC / Node error `code` (number or string) off a record. */
function matchlockErrorCode(rec: Record<string, unknown>): string | number | undefined {
  const code = rec.code;
  if (typeof code === "number" || typeof code === "string") return code;
  return undefined;
}

/** Extract the leading `at …` frames of a stack string (bounded, single-line). */
function matchlockErrorFrames(raw: unknown, maxFrames: number): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  const frames: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("at ")) continue;
    frames.push(trimmed);
    if (frames.length >= maxFrames) break;
  }
  return frames;
}

/** Bounded JSON fallback; NEVER `[object Object]`, circular ⇒ explicit tag. */
function matchlockErrorJson(value: unknown, maxBytes: number): string {
  try {
    const json = JSON.stringify(value);
    if (typeof json === "string" && json.length > 0) {
      return boundMatchlockErrorText(json, maxBytes);
    }
  } catch {
    // Circular / non-serializable body: fall through to a bounded tag.
  }
  return "[unserializable matchlock error]";
}

/**
 * MTLK-CLEANUP US-001: the ONE structured renderer for every error on the
 * Matchlock invocation path. Unlike {@link describeMatchlockError} (kept for
 * existing callers/format), this emits the error's `name`, `code`, bounded
 * message, first stack frames, the failing `phase`, the owned `vmId` and the
 * controller stderr tail — always as a single, byte-bounded line and never
 * `[object Object]`.
 *
 * Accepts the shapes the path actually produces:
 *   - `Error` (incl. `MatchlockRunnerError` carrying a `code`);
 *   - the RPC client's PLAIN body `{ code, message, stderrTail? }`
 *     (`rpc-client.ts` `pending.reject(obj.error)`);
 *   - a bare string;
 *   - any other value (bounded `JSON.stringify`; circular ⇒
 *     `[unserializable matchlock error]`).
 *
 * This module stays a LEAF (no imports) so the documented scheduler import
 * cycle cannot TDZ-crash.
 */
export function serializeMatchlockError(
  err: unknown,
  ctx: MatchlockErrorContext = {},
  opts: SerializeMatchlockErrorOptions = {},
): string {
  const maxBytes = opts.maxBytes ?? MATCHLOCK_ERROR_TAIL_MAX_BYTES;
  const stackFrames = Math.max(1, Math.min(5, opts.maxStackFrames ?? 4));

  const contextBits: string[] = [];
  if (ctx.phase) contextBits.push(`phase=${ctx.phase}`);
  if (ctx.vmId) contextBits.push(`vmId=${ctx.vmId}`);
  if (ctx.runId) contextBits.push(`runId=${ctx.runId}`);
  if (ctx.invocationId) contextBits.push(`invocationId=${ctx.invocationId}`);
  const segments: string[] = [
    contextBits.length > 0 ? `matchlock error [${contextBits.join(" ")}]` : "matchlock error",
  ];

  let name: string | undefined;
  let message: string;
  let code: string | number | undefined;
  let frames: string[] = [];
  let tail: string | null = null;

  if (err instanceof Error) {
    name = err.name || "Error";
    message = err.message || err.name || "";
    const rec = err as unknown as Record<string, unknown>;
    code = matchlockErrorCode(rec);
    frames = matchlockErrorFrames(err.stack, stackFrames);
    tail = matchlockErrorTail(rec, maxBytes);
  } else if (typeof err === "string") {
    message = err;
  } else if (typeof err === "object" && err !== null) {
    const rec = err as Record<string, unknown>;
    code = matchlockErrorCode(rec);
    const recName = typeof rec.name === "string" && rec.name.length > 0 ? rec.name : undefined;
    const recMessage = typeof rec.message === "string" ? rec.message : undefined;
    name = recName ?? (recMessage !== undefined && code !== undefined ? "MatchlockRpcError" : undefined);
    message = recMessage !== undefined ? recMessage : matchlockErrorJson(err, maxBytes);
    frames = matchlockErrorFrames(rec.stack, stackFrames);
    tail = matchlockErrorTail(rec, maxBytes);
  } else {
    message = String(err);
  }

  if (typeof ctx.stderrTail === "string" && ctx.stderrTail.trim().length > 0) {
    tail = boundMatchlockErrorText(ctx.stderrTail, maxBytes);
  }

  if (name) segments.push(`name=${name}`);
  if (code !== undefined) segments.push(`code=${String(code)}`);
  segments.push(`message=${boundMatchlockErrorText(message, maxBytes)}`);
  if (tail !== null) segments.push(`stderr tail=${tail}`);
  if (frames.length > 0) segments.push(`stack=${frames.join(" | ")}`);

  // Collapse any embedded newlines/whitespace so the rendering is ONE line.
  const singleLine = segments.join("; ").replace(/\s+/gu, " ").trim();
  return boundMatchlockErrorText(singleLine, maxBytes);
}
