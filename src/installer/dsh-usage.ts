/**
 * dsh (DeepSeek Harness) token usage reader — OWNED session-store strategy.
 *
 * dsh never prints token usage to stdout. Usage is recorded only in the
 * session log. This reader targets dsh >= 0.1.5 (session format v3),
 * whose `assistant/message` (and `compaction/summary`) records carry a
 * TOP-LEVEL `data.usage` object
 * ({inputTokens, outputTokens, totalTokens, cacheReadTokens,
 * reasoningTokens}); the older `assistant/chunk` usage events do not
 * exist in v3. The module reads that file after a dsh round and applies
 * the shared harness token policy (token-usage-policy.ts):
 *
 *   billable = inputTokens + outputTokens
 *
 * ── OWNERSHIP (DSH-TOKENS-GAP / tamandua-sal corrective) ──────────────
 *
 * Native dsh rounds are DISPATCHED with an invocation-specific session
 * storage root (see `dshOwnedSessionsBaseDir` and the scheduler's
 * `prepareDshOwnedStore`): the adapter passes a `--patch` overlay to the
 * dsh launcher that replaces the `session-persistence-jsonl` row's root
 * with that directory. dsh then writes THIS invocation's session log
 * under `<ownedRoot>/<projectKey(workdir)>/<session-id>/…` and nowhere
 * else, so the shared `$DSH_HOME/sessions` store is NOT the accounting
 * source for a tamandua-dispatched native dsh round.
 *
 * `lookupDshSessionTokens` therefore reads EXCLUSIVELY from the owned
 * root passed by the caller. It NEVER scans `$DSH_HOME`, never falls back
 * to another directory, and never elects a candidate by recency: a
 * missing, empty or unreadable owned store is an explicit UNOBSERVED
 * result (`null` + one warning) — never a fabricated zero and never a
 * foreign session. Creation timestamps and directory mtimes are NOT
 * identity evidence anywhere in this module.
 *
 * Within the owned store, selection is EXACTLY-ONE-OR-REFUSE over
 * readable ROOT sessions:
 *   - ROOT session: v3 header with `isSeeded:false`, `delegationDepth: 0`,
 *     no `parentSession`, no `origin:"subagent"` (delegated/seeded work is
 *     not the invocation's root accounting);
 *   - zero readable roots → `null` ("no root session in the owned store");
 *   - two or more readable roots → `null` (ambiguous — never ranked).
 *
 * CONTAINMENT AND REFUSAL: everything read must be a plain directory or
 * regular file INSIDE the owned root — a symlinked project directory,
 * session directory or log file refuses the lookup (an indirection could
 * redirect the read elsewhere) — and any artifact that cannot be
 * classified (an unreadable directory, a session directory holding no
 * recognized log, an unsupported pre-v3 layout) refuses the lookup too:
 * the invocation's true evidence set is unknowable, and "elect whichever
 * entry still parses" is exactly the misattribution class this corrective
 * removes. The FINAL header validation and the usage summation run over
 * the SAME strict full-container decode of the winning log (concatenated
 * frames, each frame decoded separately; torn containers are rejected),
 * so the classification that authorizes the charge and the number it
 * charges can never come from different generations of the file — an
 * earlier candidate probe decompresses only headers and may still be
 * refused by this final read. The session directory name must equal dsh's
 * `encodeSegment(header.id)` for the winner (dsh always names session
 * dirs that way); a mismatch refuses. The winning total is
 * `inputTokens + outputTokens` over every v3 record carrying a top-level
 * `data.usage` object (`cacheReadTokens` excluded; `reasoningTokens` is
 * already inside `outputTokens`).
 *
 * Deliberately NOT enforced: a header-cwd ↔ workdir binding. The owned
 * store is per-invocation and the project directory inside it already
 * groups by workdir; a cwd binding would compare spellings (symlink
 * resolution) and cannot add ownership information — the ownership
 * boundary is the per-invocation root, not the header's contents. This
 * boundary isolates cooperating invocations from each other; it is not a
 * security boundary against an arbitrary same-user process that can write
 * inside the state directory.
 *
 * `inputTokens` is already UNCACHED in dsh (observed arithmetic:
 * totalTokens = inputTokens + cacheReadTokens + outputTokens), so
 * `cacheReadTokens` is EXCLUDED and the policy's cache-write component
 * is always 0 (dsh exposes no cache-write field).
 *
 * ONLY the v3 artifact layout is supported: `session.v3.jsonl.zstd`
 * (concatenated zstd frames), with a same-version plain-JSONL fallback
 * `session.v3.jsonl` for compression-off persistence. When the `.zstd`
 * form exists it wins; the plain form is read as UTF-8 text and zstd is
 * never invoked. Session directories that hold only an older layout
 * (`session.jsonl.zstd`/`session.jsonl` from dsh 0.1.0, or
 * `session.v2.jsonl.zstd`/`session.v2.jsonl` from dsh 0.1.3) are
 * unsupported: the lookup logs ONE warning naming the found file, states
 * the required dsh version `>= 0.1.5`, gives the remedy `upgrade dsh`,
 * and returns `null` — never a fabricated `{ totalTokens: 0 }`.
 *
 * Each request's usage is counted exactly once: the v3 `assistant/message`
 * record repeats the same usage object inside its embedded
 * `data.stream[<i>].chunk.usage` entry, so the parser deliberately reads
 * only the top-level `data.usage` and never recurses into `data.stream[]`.
 *
 * cwd escaping (`projectKey`) is replicated exactly from dsh's session
 * persistence source
 * (packages/session/session-persistence-jsonl/src/format.ts): `/`, `\`,
 * and `:` collapse to `-` (runs collapse to one); safe `[A-Za-z0-9._-]`
 * UTF-16 units stay literal; every other unit becomes `~XXXX`; the
 * result is wrapped in `--…--` and bounded at 251 chars.
 *
 * The `session.v3.jsonl.zstd` artifact is a concatenated zstd frame
 * container
 * (one frame for the header + first batch, one frame per durable append),
 * so decompression scans frames structurally and decodes each frame
 * separately. node:zlib `zstdDecompressSync` exists on Node >= 23.8;
 * `engines` allows >= 22, so older Node falls back to spawning
 * `zstd -dc`. When neither is available the lookup warns and returns
 * null (0 tokens).
 *
 * Best-effort throughout: ANY failure returns null with one warning —
 * never throws into the dispatch path, never blocks step completion.
 * Idempotent CHARGING (a repeated settlement of the same physical
 * session adds only its unaccounted increment) lives in the DB ledger
 * (`applyDshSessionCharge` in db.ts), not here.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import zlib from "node:zlib";
import { logger } from "../lib/logger.js";
import { assertStatePathIsolation } from "../lib/test-guard.js";
import { sumBillableTokens } from "./token-usage-policy.js";

// ── Types ──────────────────────────────────────────────────────────

/** Result of a successful owned-store token lookup. */
export interface DshSessionUsage {
  /** inputTokens + outputTokens across v3 usage records (cacheReadTokens excluded). */
  totalTokens: number;
  /** The session directory name (e.g. `session-<uuid>`) the usage was read from. */
  sessionRef: string;
  /** Absolute path of the session directory in the owned store (the per-invocation charge identity). */
  sessionDir: string;
}

/** zstd decompression tier selection for {@link lookupDshSessionTokens}. */
export type DshZstdStrategy = "auto" | "node" | "binary" | "none";

export interface LookupDshSessionTokensOptions {
  /**
   * The invocation-OWNED session-storage root for this harness invocation
   * (created by the dispatcher before launch; the same directory handed to
   * dsh through the `--patch` persistence overlay). The lookup reads ONLY
   * `<ownedRoot>/<projectKey(workdir)>/…`; a missing or unreadable owned
   * store is UNOBSERVED (`null`) and is never substituted by a scan of any
   * other store.
   */
  ownedRoot: string;
  /** Absolute working directory the worker ran in (drives the escaped-cwd session subdirectory). */
  workdir: string;
  /** Environment used by the zstd binary fallback tier (defaults to process.env). */
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
 *
 * NOTE: with owned stores this is diagnostic-only for tamandua-dispatched
 * rounds (their sessions never land in `$DSH_HOME/sessions`); it remains
 * the right answer for a user's own dsh usage and for doctor/collectors.
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
 * Encode one session id as dsh's session-directory name segment.
 *
 * Replicates dsh's `encodeSegment` (session-persistence-jsonl
 * `format.ts`) exactly: safe `[A-Za-z0-9._-]` UTF-16 code units stay
 * literal, `.`/`..` are fully escaped, every other unit becomes `~XXXX`.
 * dsh names every session directory `encodeSegment(id)`, so the reader
 * uses this as the directory-name ↔ header-id binding check.
 */
export function encodeDshSessionSegment(raw: string): string {
  if (raw.length === 0) throw new Error("cannot encode an empty path segment");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch;
    } else {
      out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
    }
  }
  return out;
}

/**
 * The per-workdir sessions directory under a dsh home
 * (`$DSH_HOME/sessions/<escaped-cwd>`). Retained for doctor / diagnostics
 * that inspect a user's own dsh store; NOT used by token attribution.
 */
export function dshSessionProjectDir(dshHome: string, workdir: string): string {
  return path.join(dshHome, "sessions", projectKey(workdir));
}

/** Name of the per-run owned-store directory tree under a tamandua state dir. */
export const DSH_OWNED_SESSIONS_DIRNAME = "dsh-sessions";

/**
 * The base directory for tamandua-owned, per-invocation dsh session
 * stores: `<stateDir>/dsh-sessions/`. The dispatcher creates one root per
 * harness invocation under it (`<base>/<runId>/<jobId>-<phase>-<nonce>/`)
 * and passes it to dsh through the `--patch` persistence overlay.
 */
export function dshOwnedSessionsBaseDir(stateDir: string): string {
  return path.join(stateDir, DSH_OWNED_SESSIONS_DIRNAME);
}

/**
 * The per-workdir sessions directory inside an owned root
 * (`<ownedRoot>/<escaped-cwd>` — dsh's `projectDir(root, cwd)` under the
 * overlay-redirected root).
 */
export function dshOwnedSessionProjectDir(ownedRoot: string, workdir: string): string {
  return path.join(ownedRoot, projectKey(workdir));
}

/**
 * Every candidate project directory for one workdir spelling pair:
 * the key derived from the workdir AS GIVEN and — when it differs — the
 * key derived from its PHYSICAL path. The harness child's `process.cwd()`
 * is the kernel-resolved path, so dsh's own `projectKey(cwd)` uses the
 * physical spelling whenever symlinks are involved; the reader must look
 * at both to avoid a false "unobserved". Deduplicated; order stable.
 */
export function dshOwnedSessionProjectDirs(ownedRoot: string, workdir: string): string[] {
  const keys = new Set<string>();
  keys.add(projectKey(workdir));
  try {
    keys.add(projectKey(fs.realpathSync(workdir)));
  } catch {
    // The workdir may not exist yet (or be unreadable): the given
    // spelling's key is then the only candidate.
  }
  return [...keys].map((key) => path.join(ownedRoot, key));
}

/** Filename of the generated `--patch` overlay inside an owned root. */
export const DSH_OWNED_OVERLAY_FILENAME = "session-root.patch.yml";

/** Filename of the ownership receipt recorded inside an owned root before launch. */
export const DSH_OWNED_RECEIPT_FILENAME = "owner.json";

/** The ownership receipt recorded inside an owned root before launch. */
export interface DshOwnedReceipt {
  runId: string;
  jobId: string;
  phase: string;
  ownedRoot: string;
  createdAt: string;
}

/**
 * Read the ownership receipt from an owned root. The path is DERIVED from
 * the root (never caller-supplied), and any malformed/absent receipt is
 * `null` — the settle path then refuses, it never guesses.
 */
export function readDshOwnedReceipt(ownedRoot: string): DshOwnedReceipt | null {
  try {
    const raw = fs.readFileSync(path.join(ownedRoot, DSH_OWNED_RECEIPT_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as Partial<DshOwnedReceipt> | null;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      typeof parsed.runId !== "string" ||
      typeof parsed.jobId !== "string" ||
      typeof parsed.phase !== "string" ||
      typeof parsed.ownedRoot !== "string" ||
      typeof parsed.createdAt !== "string"
    ) {
      return null;
    }
    return {
      runId: parsed.runId,
      jobId: parsed.jobId,
      phase: parsed.phase,
      ownedRoot: parsed.ownedRoot,
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

/**
 * Canonical-containment check for a settlement: the session directory's
 * PHYSICAL path must be a strict descendant of the owned root's physical
 * path. Returns the canonical session path, or `null` when containment
 * cannot be proven (symlink escape, unreadable, root itself).
 */
export function canonicalContainedSessionDir(
  ownedRoot: string,
  sessionDir: string,
): string | null {
  try {
    const root = fs.realpathSync(ownedRoot);
    const dir = fs.realpathSync(sessionDir);
    if (dir === root) return null;
    if (!dir.startsWith(root + path.sep)) return null;
    return dir;
  } catch {
    return null;
  }
}

/**
 * Build the `--patch` overlay that redirects dsh's session persistence
 * into the invocation-owned root (the DSH-OWNER mechanism).
 *
 * The overlay is an id-targeted patch entry: it REPLACES the whole
 * `config` of the `session-persistence-jsonl` row from the dsh-base
 * bundle (an id-targeted patch never deep-merges), so the root is
 * restated together with `compression: zstd` (dsh's default; restating it
 * keeps the artifact layout the reader decodes even if a user profile
 * layer had set something else — the overlay is applied LAST and wins for
 * this one row on tamandua-dispatched rounds).
 *
 * The root value is emitted as a JSON-style double-quoted YAML scalar
 * (JSON string syntax is a subset of YAML flow scalars), so any path
 * characters are escaped safely.
 */
export function buildDshSessionRootOverlay(ownedRoot: string): string {
  return (
    "# tamandua DSH-OWNER: per-invocation dsh session persistence root.\n" +
    "# Generated by the dispatcher; applies only to this one harness invocation.\n" +
    "- id: session-persistence-jsonl\n" +
    "  config:\n" +
    `    root: ${JSON.stringify(ownedRoot)}\n` +
    "    compression: zstd\n"
  );
}

/** A prepared per-invocation owned session store. */
export interface DshOwnedStore {
  /** The fresh, exclusively-created session-storage root for one invocation. */
  ownedRoot: string;
  /** Absolute path of the generated `--patch` overlay that redirects dsh into `ownedRoot`. */
  overlayPath: string;
  /** Absolute path of the ownership receipt persisted beside the overlay. */
  receiptPath: string;
}

/** Sanitize one path-segment component for the owned-store tree. */
function sanitizeOwnedSegment(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^\.+/, "")
    .replace(/^-+|-+$/g, "");
  // ".", ".." and empty must never survive as a directory name (traversal).
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") return "x";
  return cleaned.slice(0, 96);
}

/**
 * Prepare the invocation-OWNED dsh session store for ONE harness
 * invocation (the DSH-OWNER mechanism).
 *
 * Creates a FRESH, exclusively-named root under
 * `<stateDir>/<DSH_OWNED_SESSIONS_DIRNAME>/<runId>/<jobId>-<phase>-<nonce>/`
 * (the nonce makes every invocation — work round, retry, probe — get its
 * own store even though the scheduler job id is deterministic), writes the
 * `--patch` overlay that redirects dsh's `session-persistence-jsonl` root
 * into it, and records an ownership receipt for diagnosis/replay.
 *
 * Returns `null` when the store cannot be prepared — the caller MUST then
 * refuse to launch (an unowned launch would silently fall back to the
 * shared store and lose attribution ownership).
 */
export function prepareDshOwnedStore(opts: {
  stateDir: string;
  runId: string;
  jobId: string;
  phase: "work" | "probe";
}): DshOwnedStore | null {
  try {
    if (
      typeof opts.stateDir !== "string" ||
      opts.stateDir.length === 0 ||
      typeof opts.runId !== "string" ||
      opts.runId.length === 0 ||
      typeof opts.jobId !== "string" ||
      opts.jobId.length === 0
    ) {
      logger.warn("dsh owned session store preparation failed", {
        reason: "missing_state_or_identity",
      });
      return null;
    }
    const base = dshOwnedSessionsBaseDir(opts.stateDir);
    // Guard BEFORE any filesystem mutation: the owned root must never be
    // created inside the real state directory under the test guard.
    assertStatePathIsolation(base, "prepareDshOwnedStore()");
    const runDir = path.join(base, sanitizeOwnedSegment(opts.runId));
    assertStatePathIsolation(runDir, "prepareDshOwnedStore()");
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    // EXCLUSIVE allocation: mkdtempSync creates a genuinely fresh directory
    // (a recursive mkdir + emptiness check is not an exclusive create), and
    // realpathSync canonicalizes the root once — the ledger's charge
    // identity and the overlay's persistence root are then the SAME
    // canonical path for every settlement and replay.
    const ownedRoot = fs.realpathSync(
      fs.mkdtempSync(
        path.join(runDir, `${sanitizeOwnedSegment(opts.jobId)}-${opts.phase}-`),
      ),
    );
    fs.chmodSync(ownedRoot, 0o700);
    const overlayPath = path.join(ownedRoot, DSH_OWNED_OVERLAY_FILENAME);
    fs.writeFileSync(overlayPath, buildDshSessionRootOverlay(ownedRoot), {
      mode: 0o600,
    });
    const receiptPath = path.join(ownedRoot, DSH_OWNED_RECEIPT_FILENAME);
    fs.writeFileSync(
      receiptPath,
      JSON.stringify(
        {
          runId: opts.runId,
          jobId: opts.jobId,
          phase: opts.phase,
          ownedRoot,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    return { ownedRoot, overlayPath, receiptPath };
  } catch (err) {
    logger.warn("dsh owned session store preparation failed", {
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── Supported artifact layout (dsh >= 0.1.5 / session format v3) ───

/**
 * Compressed v3 session log — the only supported persisted artifact when
 * dsh compression is on. dsh 0.1.5 writes this alongside a
 * `session.lock`.
 */
export const DSH_V3_LOG_COMPRESSED = "session.v3.jsonl.zstd";

/**
 * Plain v3 session log written by dsh when compression is disabled. Read
 * as UTF-8 text directly (zstd is never invoked for this form).
 */
export const DSH_V3_LOG_PLAIN = "session.v3.jsonl";

/**
 * Older (unsupported) session-log filenames, in probe order: dsh 0.1.0
 * wrote `session.jsonl[.zstd]`; dsh 0.1.3 wrote `session.v2.jsonl[.zstd]`.
 * A session directory holding only one of these triggers the
 * "upgrade dsh" warning instead of a silent 0-token reading.
 */
export const DSH_LEGACY_LOGS = [
  "session.jsonl.zstd",
  "session.jsonl",
  "session.v2.jsonl.zstd",
  "session.v2.jsonl",
] as const;

/** The minimum dsh version whose session layout this reader understands. */
export const DSH_MIN_SUPPORTED_VERSION = ">= 0.1.5";

// ── v3 session header probe (root classification) ──────────────────

/**
 * Initial byte budget for the header-probe read. dsh writes the header as
 * the FIRST zstd frame (typically a few hundred bytes). The probe starts
 * with this prefix and falls back to a full-file read when the prefix
 * cannot be decoded (node tier); the binary tier decodes the whole
 * container. The probe is therefore NOT strictly bounded by this budget.
 */
export const DSH_HEADER_PROBE_MAX_BYTES = 64 * 1024;

/**
 * Full-file retry bound for the node-tier header probe when the bounded
 * prefix alone cannot be decoded (single-frame writers whose frame exceeds
 * the prefix). 64 MiB matches the binary tier's decoded-output cap and
 * dwarfs any real session header frame.
 */
export const DSH_HEADER_PROBE_FULL_MAX_BYTES = 64 * 1024 * 1024;

/** The authoritative fields the header probe reads from a v3 header. */
export interface DshRootHeaderMeta {
  /** Session id recorded in the header. */
  id: string;
  /** Authoritative creation instant (epoch ms; dsh-validated non-negative safe integer). Diagnostic only — never an eligibility or selection input. */
  createdAtMs: number;
}

/**
 * Parse+classify result for one candidate's first line:
 *
 *   - `root`: a ROOT, UNSEDED v3 session header (eligible shape);
 *   - `non-root`: a VALID session header that is demonstrably not a round
 *     root (seeded, child/subagent) — safely excluded;
 *   - `invalid`: not a valid v3 session header at all (unparseable,
 *     non-session record, bad fields) — an UNKNOWN artifact the caller
 *     must handle conservatively (refuse the lookup).
 */
export type DshHeaderClassification =
  | { kind: "root"; meta: DshRootHeaderMeta }
  | { kind: "non-root"; reason: string }
  | { kind: "invalid"; reason: string };

/**
 * Classify one v3 session header line. A `root` result requires:
 *
 *   - `type === "session"` and `version === 3`;
 *   - non-empty string `id`;
 *   - `createdAt` a non-negative safe integer (dsh's own header validation;
 *     `-0` is rejected like dsh rejects it);
 *   - `isSeeded === false` — a seeded session inherits another session's
 *     event prefix, so its log RE-COUNTS that history;
 *   - no `parentSession` and no `origin: "subagent"` — child (subagent)
 *     sessions are delegated work, not this invocation's root session.
 *
 * Everything else is `non-root` (a valid header of another kind) or
 * `invalid` (unrecognizable) — never a throw, never a fabricated header.
 */
export function parseDshSessionHeader(line: string): DshHeaderClassification {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: "invalid", reason: "first line is not JSON" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "invalid", reason: "first line is not a JSON object" };
  }
  const header = value as Record<string, unknown>;
  if (header.type !== "session") {
    return { kind: "invalid", reason: "first line is not a session header" };
  }
  if (header.version !== 3) {
    return { kind: "invalid", reason: `session header version is not 3` };
  }
  if (typeof header.id !== "string" || header.id.length === 0) {
    return { kind: "invalid", reason: "session header has no id" };
  }
  const createdAt = header.createdAt;
  if (
    typeof createdAt !== "number" ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0 ||
    Object.is(createdAt, -0)
  ) {
    return { kind: "invalid", reason: "session header createdAt is not a non-negative safe integer" };
  }
  // Validate EVERY field of the known header shape BEFORE classifying, so a
  // malformed optional field (e.g. a numeric parentSession) is `invalid`,
  // never a cleanly-excluded `non-root` — malformed artifacts must reach the
  // conservative UNKNOWN handling, not be silently dropped.
  if (typeof header.isSeeded !== "boolean") {
    return { kind: "invalid", reason: "session header isSeeded is missing or not boolean" };
  }
  const delegationDepth = header.delegationDepth;
  if (
    typeof delegationDepth !== "number" ||
    !Number.isSafeInteger(delegationDepth) ||
    delegationDepth < 0 ||
    Object.is(delegationDepth, -0)
  ) {
    return {
      kind: "invalid",
      reason: "session header delegationDepth is missing or not a non-negative safe integer",
    };
  }
  if (header.parentSession !== undefined && typeof header.parentSession !== "string") {
    return { kind: "invalid", reason: "session header parentSession is not a string" };
  }
  if (header.origin !== undefined && header.origin !== "subagent") {
    return { kind: "invalid", reason: `session header origin is not 'subagent'` };
  }
  if (header.cwd !== undefined && (typeof header.cwd !== "string" || !path.isAbsolute(header.cwd))) {
    return { kind: "invalid", reason: "session header cwd is not an absolute path string" };
  }
  if (header.agentPreset !== undefined && typeof header.agentPreset !== "string") {
    return { kind: "invalid", reason: "session header agentPreset is not a string" };
  }
  if (header.isSeeded === true) {
    return { kind: "non-root", reason: "seeded session header (inherited event prefix)" };
  }
  if (delegationDepth > 0) {
    return { kind: "non-root", reason: "delegated session (delegationDepth > 0)" };
  }
  if (header.parentSession !== undefined) {
    return { kind: "non-root", reason: "child session (parentSession set)" };
  }
  if (header.origin === "subagent") {
    return { kind: "non-root", reason: "subagent-origin session" };
  }
  return { kind: "root", meta: { id: header.id, createdAtMs: createdAt } };
}

/** First non-empty line of a text chunk, or null. */
function firstNonEmptyLine(text: string): string | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

/**
 * Read at most `maxBytes` from the start of a file. `full` reports whether
 * the whole file was consumed (file size <= maxBytes).
 */
function readFilePrefix(logPath: string, maxBytes: number): { bytes: Buffer; full: boolean } {
  const fd = fs.openSync(logPath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const bytes = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = fs.readSync(fd, bytes, read, length - read, read);
      if (n <= 0) break;
      read += n;
    }
    return { bytes: bytes.subarray(0, read), full: size <= maxBytes };
  } finally {
    fs.closeSync(fd);
  }
}

/** Decode ONLY the first complete zstd frame of a buffer (dsh's header frame). */
function decodeFirstZstdFrame(
  bytes: Buffer,
  nodeZstd: (buf: Uint8Array) => Buffer,
): string {
  const frames = scanZstdFrames(bytes, 1);
  if (frames.length === 0) {
    throw new Error("no complete zstd frame");
  }
  return nodeZstd(bytes.subarray(frames[0].start, frames[0].end)).toString("utf8");
}

/**
 * Probe one session directory's v3 log for its authoritative header
 * classification (root / non-root / invalid).
 *
 * For the compressed form the probe decodes ONLY the first zstd frame of
 * a bounded prefix — a truncated final frame from a concurrently
 * appending writer must not hide the header — retrying once with a
 * full-file read (bounded by DSH_HEADER_PROBE_FULL_MAX_BYTES) when the
 * prefix alone cannot be decoded. The binary tier (`zstd -dc`) decodes
 * the whole container natively. The plain (compression-off) form is read
 * as UTF-8 text. ANY failure yields an `invalid` classification with a
 * reason — never a throw, never a fabricated header.
 */
export async function readDshSessionHeader(opts: {
  logPath: string;
  compressed: boolean;
  strategy: DshZstdStrategy;
  env?: NodeJS.ProcessEnv;
}): Promise<DshHeaderClassification> {
  try {
    if (!opts.compressed) {
      const read = readFilePrefix(opts.logPath, DSH_HEADER_PROBE_MAX_BYTES);
      const line = firstNonEmptyLine(read.bytes.toString("utf8"));
      if (line === null) return { kind: "invalid", reason: "empty session log" };
      return parseDshSessionHeader(line);
    }

    const nodeZstd = detectNodeZstdDecompress();
    const useNode =
      opts.strategy === "node" || (opts.strategy === "auto" && nodeZstd !== undefined);

    if (useNode) {
      if (nodeZstd === undefined) {
        return { kind: "invalid", reason: "no zstd support available (node:zlib zstd missing)" };
      }
      let lastReason = "unreadable zstd container";
      for (const maxBytes of [DSH_HEADER_PROBE_MAX_BYTES, DSH_HEADER_PROBE_FULL_MAX_BYTES]) {
        const read = readFilePrefix(opts.logPath, maxBytes);
        try {
          const text = decodeFirstZstdFrame(read.bytes, nodeZstd);
          const line = firstNonEmptyLine(text);
          if (line === null) return { kind: "invalid", reason: "empty first frame" };
          return parseDshSessionHeader(line);
        } catch (err) {
          lastReason = err instanceof Error ? err.message : String(err);
        }
        if (read.full) break; // prefix covered the whole file — no retry
      }
      return { kind: "invalid", reason: lastReason };
    }

    if (opts.strategy === "none") {
      return { kind: "invalid", reason: "no zstd support available (zstdStrategy none)" };
    }

    // "binary" (or "auto" without node:zlib zstd): `zstd -dc` decodes the
    // whole (concatenated-frame) container natively; the header is its
    // first line.
    const childEnv: NodeJS.ProcessEnv = {
      ...(process.env as NodeJS.ProcessEnv),
      ...(opts.env ?? {}),
    };
    try {
      const text = await runZstdBinary(opts.logPath, childEnv);
      const line = firstNonEmptyLine(text);
      if (line === null) return { kind: "invalid", reason: "empty session log" };
      return parseDshSessionHeader(line);
    } catch (err) {
      return {
        kind: "invalid",
        reason: `zstd binary unavailable or failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } catch (err) {
    return { kind: "invalid", reason: err instanceof Error ? err.message : String(err) };
  }
}

// ── Token lookup (owned store) ─────────────────────────────────────

/**
 * Read token usage for one harness invocation from ITS OWNED session
 * store, exclusively.
 *
 * The owned root is created by the dispatcher before launch and handed to
 * dsh through the `--patch` persistence overlay, so every artifact under
 * `<ownedRoot>/<projectKey(workdir)>/` belongs to THIS invocation. The
 * lookup:
 *   1. scans that directory for session dirs holding a v3 log
 *      (`session.v3.jsonl.zstd`, preferring it over the plain
 *      `session.v3.jsonl`) and probes each one's header;
 *   2. requires EXACTLY ONE readable ROOT session (zero → unavailable;
 *      two or more → refuse; an unreadable/malformed v3 artifact → refuse
 *      — the true root count is unknowable);
 *   3. decodes the winner (multi-frame scan) and sums
 *      `inputTokens + outputTokens` over every v3 record carrying a
 *      top-level `data.usage` object (`cacheReadTokens` excluded).
 *
 * UNOBSERVED semantics: a missing/unreadable owned store, no root
 * session, ambiguity or any read failure returns `null` with ONE warning
 * naming the owned root — never a zero total and never any candidate
 * from another store. Timestamps and mtimes play no role anywhere.
 *
 * `sessionRef` is the winning session directory name. Best-effort
 * throughout: this function never throws.
 *
 * @returns total tokens + sessionRef, or `null` when UNOBSERVED.
 */
export async function lookupDshSessionTokens(
  options: LookupDshSessionTokensOptions,
): Promise<DshSessionUsage | null> {
  try {
    const { workdir } = options;

    if (typeof options.ownedRoot !== "string" || options.ownedRoot.length === 0) {
      logger.warn("dsh session token lookup failed: no owned session store for this invocation", {
        reason: "missing_owned_root",
        workdir,
      });
      return null;
    }
    if (typeof workdir !== "string" || workdir.length === 0) {
      logger.warn("dsh session token lookup failed", {
        reason: "missing worker working directory",
      });
      return null;
    }

    const ownedRoot = options.ownedRoot;

    // The owned root leaf itself must be a plain directory: a symlinked
    // root could redirect every read outside the store the invocation
    // actually owns. (Canonicalized state-dir ANCESTORS are fine — only
    // the invocation-root leaf is validated.)
    try {
      const rootStat = fs.lstatSync(ownedRoot);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        logger.warn("dsh session token lookup unobserved: owned store root is not a plain directory", {
          reason: "owned_root_not_plain",
          ownedRoot,
          workdir,
        });
        return null;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        // Unreadable evidence must NOT read as "no store": the invocation
        // may own a store we cannot inspect.
        logger.warn(
          "dsh session token lookup unobserved: owned store root could not be inspected",
          {
            reason: "owned_root_inspect_failed",
            ownedRoot,
            workdir,
            error: err instanceof Error ? err.message : String(err),
          },
        );
        return null;
      }
      // Genuine absence — handled below as UNOBSERVED (owned_store_missing).
    }

    const projectDirs = dshOwnedSessionProjectDirs(ownedRoot, workdir);
    const sessionsDir = projectDirs[0];

    // Every candidate project directory (the workdir's own spelling key and
    // its physical-path key) must be a PLAIN directory: a symlinked leaf
    // could redirect every read elsewhere, so it is refused rather than
    // followed. Absent candidates are fine — the session lands under the
    // spelling dsh itself resolved as its cwd.
    const existingProjectDirs: string[] = [];
    for (const dir of projectDirs) {
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(dir);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          // This spelling simply does not exist — the other candidate
          // (or the absence handling below) decides.
          continue;
        }
        // A permission/I/O failure must NOT read as "no session here":
        // the owned store could hold evidence we cannot see.
        logger.warn(
          "dsh session token lookup unobserved: owned project directory could not be inspected",
          {
            reason: "owned_project_dir_inspect_failed",
            ownedRoot,
            sessionsDir: dir,
            workdir,
            error: err instanceof Error ? err.message : String(err),
          },
        );
        return null;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        logger.warn(
          "dsh session token lookup unobserved: owned project directory is not a plain directory",
          {
            reason: "owned_project_dir_not_plain",
            ownedRoot,
            sessionsDir: dir,
            workdir,
          },
        );
        return null;
      }
      existingProjectDirs.push(dir);
    }

    if (existingProjectDirs.length === 0) {
      // Distinguish "the invocation produced no store at all" from "the
      // store exists but dsh never materialized a session". Both are
      // UNOBSERVED; neither may be substituted by another directory.
      const rootExists = fs.existsSync(ownedRoot);
      logger.warn(
        rootExists
          ? "dsh session token lookup unobserved: no session directory in the owned store"
          : "dsh session token lookup unobserved: owned session store missing",
        {
          reason: rootExists ? "no_owned_session_dir" : "owned_store_missing",
          ownedRoot,
          sessionsDir,
          workdir,
        },
      );
      return null;
    }

    // ── Session candidate scan (owned root only) ───────────────
    // Candidates from ALL spelling directories are aggregated BEFORE the
    // exactly-one decision, so a session under either spelling counts.
    const scanSources: { dir: string; entry: fs.Dirent }[] = [];
    for (const dir of existingProjectDirs) {
      let dirEntries: fs.Dirent[];
      try {
        dirEntries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        logger.warn(
          "dsh session token lookup unobserved: owned project directory is unreadable",
          {
            reason: "owned_project_dir_unreadable",
            ownedRoot,
            sessionsDir: dir,
            workdir,
          },
        );
        return null;
      }
      for (const entry of dirEntries) scanSources.push({ dir, entry });
    }

    interface Candidate {
      name: string;
      dirPath: string;
      logPath: string;
      compressed: boolean;
    }

    interface LegacyCandidate extends Candidate {
      logFile: string;
    }

    // A candidate is a session dir holding a v3 log (supported). Its
    // `compressed` flag records whether the `.zstd` form was chosen, so
    // the plain form can be read without ever touching zstd.
    const v3Candidates: Candidate[] = [];
    // A candidate holding only an older layout — never read, only warned
    // about (and grounds for refusal: the owned store must be fully v3).
    const legacyCandidates: LegacyCandidate[] = [];
    // Entries that are NOT a plain session directory holding a recognized
    // log. Nothing here is skipped silently: the invocation's own store
    // must be fully classifiable, and an unrecognized entry anywhere in it
    // makes the true evidence set unknowable.
    const unclassifiable: { name: string; reason: string }[] = [];

    /**
     * Inspect a path: `undefined` ONLY for genuine absence (ENOENT/ENOTDIR);
     * any other failure (permission, I/O) throws, so a preferred artifact
     * that cannot be inspected never silently falls back to an inferior
     * one — the session-dir block below turns the throw into an
     * unclassifiable refusal.
     */
    const inspect = (target: string): fs.Stats | undefined => {
      try {
        return fs.lstatSync(target);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ENOENT" || code === "ENOTDIR") return undefined;
        throw err;
      }
    };

    for (const source of scanSources) {
      const entry = source.entry;
      if (entry.isSymbolicLink()) {
        // An indirection inside the owned store could redirect any read
        // elsewhere — never follow it, never ignore it.
        unclassifiable.push({ name: entry.name, reason: "symlinked entry in the owned store" });
        continue;
      }
      if (!entry.isDirectory()) {
        unclassifiable.push({
          name: entry.name,
          reason: "entry is not a plain session directory",
        });
        continue;
      }
      const dirPath = path.join(source.dir, entry.name);
      try {
        const compressedPath = path.join(dirPath, DSH_V3_LOG_COMPRESSED);
        const plainPath = path.join(dirPath, DSH_V3_LOG_PLAIN);
        const compressedStat = inspect(compressedPath);
        const plainStat = inspect(plainPath);
        if (compressedStat?.isSymbolicLink() || plainStat?.isSymbolicLink()) {
          unclassifiable.push({
            name: entry.name,
            reason: "symlinked session log in the owned store",
          });
          continue;
        }
        // A recognized log path must be a REGULAR file; anything else
        // (directory, socket, …) at that name is not a session log.
        if (compressedStat !== undefined && !compressedStat.isFile()) {
          unclassifiable.push({
            name: entry.name,
            reason: "session.v3.jsonl.zstd is not a regular file",
          });
          continue;
        }
        if (plainStat !== undefined && !plainStat.isFile()) {
          unclassifiable.push({
            name: entry.name,
            reason: "session.v3.jsonl is not a regular file",
          });
          continue;
        }
        if (compressedStat?.isFile()) {
          v3Candidates.push({
            name: entry.name,
            dirPath,
            logPath: compressedPath,
            compressed: true,
          });
          continue;
        }
        if (plainStat?.isFile()) {
          v3Candidates.push({
            name: entry.name,
            dirPath,
            logPath: plainPath,
            compressed: false,
          });
          continue;
        }
        let legacyFile: (typeof DSH_LEGACY_LOGS)[number] | undefined;
        let legacyUnclassifiableReason: string | undefined;
        for (const file of DSH_LEGACY_LOGS) {
          const stat = inspect(path.join(dirPath, file));
          if (stat === undefined) continue;
          if (stat.isFile() && !stat.isSymbolicLink()) {
            legacyFile = file;
            break;
          }
          legacyUnclassifiableReason = `legacy-named artifact ${file} is not a regular file`;
        }
        if (legacyFile !== undefined) {
          legacyCandidates.push({
            name: entry.name,
            dirPath,
            logPath: path.join(dirPath, legacyFile),
            compressed: true,
            logFile: legacyFile,
          });
          continue;
        }
        unclassifiable.push({
          name: entry.name,
          reason:
            legacyUnclassifiableReason ?? "session directory holds no recognized session log",
        });
      } catch (err) {
        unclassifiable.push({
          name: entry.name,
          reason: `unreadable session directory entry: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    if (unclassifiable.length > 0) {
      logger.warn(
        "dsh session token lookup unobserved: unclassifiable artifact in the owned store",
        {
          reason: "unclassifiable_in_owned_store",
          ownedRoot,
          sessionsDir,
          workdir,
          artifacts: unclassifiable,
        },
      );
      return null;
    }

    if (legacyCandidates.length > 0) {
      // An under-versioned dsh wrote an unsupported layout into the owned
      // store. It cannot be counted, and while it is present the evidence
      // set is not fully v3 — say so LOUDLY, name the file, and refuse.
      const found = legacyCandidates[0];
      logger.warn(
        `dsh session token lookup failed: unsupported session layout ` +
          `(found ${found.logFile}); dsh ${DSH_MIN_SUPPORTED_VERSION} is required ` +
          `(expected ${DSH_V3_LOG_COMPRESSED}) — upgrade dsh`,
        {
          ownedRoot,
          sessionsDir,
          workdir,
          foundFile: found.logFile,
          requiredDshVersion: DSH_MIN_SUPPORTED_VERSION,
          remedy: "upgrade dsh",
        },
      );
      return null;
    }

    // ── Root classification (owned store) ──────────────────────
    // Every v3 candidate is probed for its header. A root session is this
    // invocation's own accounting unit; delegated/seeded sessions are
    // excluded; an unreadable artifact refuses the lookup outright.
    const zstdStrategy = options.zstdStrategy ?? "auto";
    const eligibleRoots: Candidate[] = [];
    const unreadable: { name: string; reason: string }[] = [];

    for (const candidate of v3Candidates) {
      const classification = await readDshSessionHeader({
        logPath: candidate.logPath,
        compressed: candidate.compressed,
        strategy: zstdStrategy,
        env: options.env,
      });

      if (classification.kind === "non-root") {
        // A VALID header that is demonstrably not a root session (child,
        // subagent, seeded): never this invocation's root accounting.
        continue;
      }
      if (classification.kind === "invalid") {
        // Malformed own evidence: the true eligible-root count is
        // unknowable, so refuse — never elect "whichever entry parses".
        unreadable.push({ name: candidate.name, reason: classification.reason });
        continue;
      }
      eligibleRoots.push(candidate);
    }

    if (unreadable.length > 0) {
      logger.warn(
        "dsh session token lookup unobserved: unreadable session artifact in the owned store",
        {
          reason: "unreadable_in_owned_store",
          ownedRoot,
          sessionsDir,
          workdir,
          artifacts: unreadable,
        },
      );
      return null;
    }

    if (eligibleRoots.length === 0) {
      // No root session in the owned store. If an older-layout session
      // exists (an under-versioned dsh wrote it), say so LOUDLY and name
      // the file — the alternative is a silent 0-token run.
      if (legacyCandidates.length > 0) {
        const found = legacyCandidates[0];
        logger.warn(
          `dsh session token lookup failed: unsupported session layout ` +
            `(found ${found.logFile}); dsh ${DSH_MIN_SUPPORTED_VERSION} is required ` +
            `(expected ${DSH_V3_LOG_COMPRESSED}) — upgrade dsh`,
          {
            ownedRoot,
            sessionsDir,
            workdir,
            foundFile: found.logFile,
            requiredDshVersion: DSH_MIN_SUPPORTED_VERSION,
            remedy: "upgrade dsh",
          },
        );
        return null;
      }

      logger.warn("dsh session token lookup unobserved: no root session in the owned store", {
        reason: "no_root_session_in_owned_store",
        ownedRoot,
        sessionsDir,
        workdir,
      });
      return null;
    }

    if (eligibleRoots.length > 1) {
      // Ambiguity: more than one root session in the owned store. Refuse —
      // never rank, never elect (an honest zero beats a misattribution).
      logger.warn(
        "dsh session token lookup unobserved: multiple root sessions in the owned store",
        {
          reason: "multiple_roots_in_owned_store",
          ownedRoot,
          sessionsDir,
          workdir,
          sessionRefs: eligibleRoots.map((c) => c.name),
        },
      );
      return null;
    }

    const session = eligibleRoots[0];

    // ── Read (decompress only when needed) + parse ─────────────
    // ONE decode of the winning log services BOTH the identity
    // re-validation and the usage sum, so the root classification and the
    // counted usage always come from the same generation of the file.
    const text = session.compressed
      ? await decompressDshSessionLog(session.logPath, zstdStrategy, options.env)
      : readPlainSessionLog(session.logPath);
    if (text === null) {
      // The reader already warned.
      return null;
    }

    // Re-validate the DECODED content that will be summed: it must still
    // classify as a root session, and dsh names every session directory
    // `encodeSegment(header.id)` — a mismatch means this artifact was not
    // written the way dsh writes one, so refuse rather than read it.
    const decodedFirstLine = firstNonEmptyLine(text);
    const decodedHeader =
      decodedFirstLine === null ? null : parseDshSessionHeader(decodedFirstLine);
    if (decodedHeader === null || decodedHeader.kind !== "root") {
      logger.warn(
        "dsh session token lookup unobserved: decoded session log failed root re-validation",
        {
          reason: "decoded_log_revalidation_failed",
          ownedRoot,
          sessionRef: session.name,
          logPath: session.logPath,
        },
      );
      return null;
    }
    if (encodeDshSessionSegment(decodedHeader.meta.id) !== session.name) {
      logger.warn(
        "dsh session token lookup unobserved: session directory name does not match its header id",
        {
          reason: "session_dir_header_id_mismatch",
          ownedRoot,
          sessionRef: session.name,
          headerId: decodedHeader.meta.id,
          logPath: session.logPath,
        },
      );
      return null;
    }

    const totalTokens = sumUsageChunks(text);
    if (totalTokens === null) {
      logger.warn("dsh session token lookup found no usage chunks", {
        sessionRef: session.name,
        logPath: session.logPath,
        ownedRoot,
      });
      return null;
    }

    return {
      totalTokens,
      sessionRef: session.name,
      sessionDir: session.dirPath,
    };
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
function scanZstdFrames(buffer: Buffer, maxFrames = Number.POSITIVE_INFINITY): ZstdFrameRange[] {
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
    if (frames.length >= maxFrames) {
      // Header-only callers (`maxFrames = 1`) stop after the first complete
      // frame: dsh guarantees the first frame is exactly the header record,
      // and a torn final frame from a concurrently-appending writer must NOT
      // make the header unreadable (the strict full scan below still rejects
      // torn containers for the usage decode).
      return frames;
    }
  }

  return frames;
}

/**
 * Read a plain (uncompressed) `session.v3.jsonl` directly as UTF-8 text.
 * Used for the compression-off persistence form: zstd is never invoked
 * for this layout. Returns null after one warning on any read failure.
 */
function readPlainSessionLog(logPath: string): string | null {
  try {
    return fs.readFileSync(logPath, "utf8");
  } catch (err) {
    logger.warn("dsh session token lookup failed to read session log", {
      logPath,
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Decompress the (concatenated-frame) v3 session log via the selected
 * strategy and return its plaintext JSONL, or null after one warning on
 * any failure.
 *
 * Exported so tests can assert multi-frame decoding directly against a
 * real dsh >= 0.1.5 session container. The `node` tier scans the
 * container structurally and decodes EACH frame separately — whole-buffer
 * `zstdDecompressSync` would return only the first frame. The `binary`
 * tier spawns `zstd -dc`, which handles concatenated frames natively.
 * `lookupDshSessionTokens` behavior is unchanged by this export.
 */
export async function decompressDshSessionLog(
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
 * Sum input+output tokens across every session-format-v3 (dsh >= 0.1.5)
 * record that carries a TOP-LEVEL `data.usage` object — observed carriers
 * are `assistant/message` and `compaction/summary`; a generic scan also
 * covers any title-generation LLM result that records usage.
 *
 * The shared harness policy is applied per record via
 * `sumBillableTokens({ input: usage.inputTokens, output: usage.outputTokens })`:
 * dsh's `inputTokens` is already uncached, `cacheReadTokens` is excluded,
 * and `reasoningTokens` is already inside `outputTokens`, so neither is
 * read. Each record's usage is counted exactly once — the parser never
 * recurses into `data.stream[]`, where the `assistant/message` record
 * embeds a duplicate copy of the same usage object (counting both would
 * double-count the request).
 *
 * Lines that fail to parse are skipped (best effort); non-numeric or
 * negative components count as 0.
 *
 * @returns the rounded total, or `null` when the log contained no
 *          recognizable top-level usage object at all.
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
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      continue;
    }

    const data = (record as { data?: unknown }).data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) continue;

    // v3 usage is a TOP-LEVEL data.usage object. Do NOT recurse into
    // data.stream[]: the same usage is embedded there a second time.
    const usage = (data as { usage?: unknown }).usage;
    if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
      continue;
    }

    // Shared harness policy (token-usage-policy.ts): input + output
    // (dsh's inputTokens is already uncached), cache_read excluded. dsh
    // exposes no cache_write component, so none is passed.
    const numbers = usage as DshUsageNumbers;
    total += sumBillableTokens({
      input: numbers.inputTokens,
      output: numbers.outputTokens,
    });
    found = true;
  }

  return found ? Math.round(total) : null;
}
