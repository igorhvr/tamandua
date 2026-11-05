/**
 * Matchlock host-side store holder detector (informational listing only).
 *
 * G6 HOLDER-DETECTION (bead tamandua-7p5.1.6). A refused Matchlock launch must
 * be ACTIONABLE: the operator needs to see which live processes have a store,
 * or one of its sidecars, open. This module answers that question from
 * read-only probes and nothing else.
 *
 * INFORMATIONAL ONLY — NOT AN OWNERSHIP CONTROL. The listing is not a lease, a
 * reservation, a verdict or an input to a verdict. Two or more holders is a
 * normal, permitted state and every one of them is listed; nothing here admits,
 * refuses, blocks, signals or kills a process. GATE-IMPLEMENTATION-SPEC.md
 * section 5 is explicit that a failed holder probe is RECORDED
 * (`observationComplete: false` plus a {@link ProbeFailure}) and is never
 * itself a refusal, because no reason code covers it (section 3) and turning
 * one into a refusal would smuggle ownership back into the gate.
 *
 * THREE-PART SHAPE. {@link HolderStore} carries the identity the caller has
 * already resolved (canonical path, device id and inode both as DECIMAL
 * STRINGS). {@link HolderProbeDeps} is the single injected probe seam: it is
 * handed the store and sidecar spellings exactly once and returns raw
 * candidates. {@link detectStoreHolders} is the authority for the match and
 * for the output order; the default probe lives in a separate runner module so
 * this module stays free of spawn-capable imports and its test stays in the
 * parallel lane.
 *
 * IDENTITY MATCHING, where the precision matters:
 *  - A candidate is a holder of store S when one of its open paths resolves to
 *    the SAME filesystem identity as S. Identity is read with
 *    `fs.statSync(p, { bigint: true })` and compared as DECIMAL STRINGS, never
 *    as JS numbers: a 64-bit inode is lossy as a double, so numeric comparison
 *    could make two different files look equal.
 *  - A hardlink alias (same device and inode, different spelling) therefore
 *    matches. A symlink alias pointing at a DIFFERENT file, and a same-basename
 *    file in another directory, do not: their inode differs.
 *  - A candidate is also a holder when an open path, after stripping the
 *    trailing " (deleted)" that an unlinked-but-still-open entry carries,
 *    exactly equals one of S's sidecar spellings (`-wal`, `-shm`, `-journal`).
 *    A sidecar can be removed while a writer still holds it open, and then the
 *    path spelling is the only evidence left.
 *  - A sidecar holder is reported under the STORE's canonical path, never the
 *    sidecar spelling and never the candidate's alias spelling: the listing
 *    answers "which processes hold THIS store", not "which spelling matched".
 *  - ENOENT on an open path is ignored: the file is gone, so it cannot be the
 *    current store path. Any other read failure is REMEMBERED as a probe
 *    failure for that process — never as an absence of holders and never as a
 *    fabricated match.
 *  - Non-absolute entries (`socket:[123]`, `pipe:[456]`, `anon_inode:...`) are
 *    ignored without raising.
 *
 * AGGREGATION AND ORDER (US-002). The same process can be observed more than
 * once (one probe entry per open file). Candidates that share BOTH pid and
 * startIdentity therefore merge into ONE holder: `storePaths` is the union of
 * every matched store canonicalPath, deduped and sorted in UTF-8 byte order,
 * and the description is the byte-smallest of the observations, so a merged
 * holder never depends on candidate input order. Two candidates with the same
 * pid but a DIFFERENT startIdentity stay separate entries — pid reuse is a
 * different process, not a duplicate. Holders are ordered by pid ascending,
 * then by startIdentity in UTF-8 byte order; neither caller input order nor
 * Map insertion order takes part. `observationComplete` is exactly
 * `probeFailures.length === 0`, and zero matching candidates against a
 * non-empty store list is a COMPLETE observation of no holders, not a gap.
 *
 * FAILURES ARE RECORDED, NEVER THROWN (US-004). `deps.listOpenFileHolders` is
 * the only fallible call and it is wrapped: whatever it throws becomes ONE
 * {@link ProbeFailure} in the result and `observationComplete: false`. A
 * {@link HolderProbeError} thrown by the runner carries the SCOPE that failed
 * (`pid:<pid>`, `lsof:timeout`, `platform:<platform>`, ...) and may carry the
 * candidates it observed before failing; those partial candidates are still
 * matched and listed, because a partial observation must never hide holders
 * that were really seen — aggregation outranks short-circuiting. The scope
 * defaults to `holder-probe` for an untyped throw. A reason is sanitized with
 * the same credential and pattern-kill redaction as a command description
 * (a process error message can quote a path or an argument that carries a
 * secret), stripped of control characters and capped, and a non-Error throw is
 * stringified safely. A per-candidate open path that cannot be stat'ed for any
 * reason other than ENOENT is recorded under `pid:<pid>` and fabricates NO
 * match: inability to inspect is a gap in the observation, never an absence of
 * holders. `probeFailures` are sorted by scope then reason in UTF-8 byte
 * order, so identical inputs still produce deeply equal output.
 *
 * COMMAND DESCRIPTIONS are identification, never a transcript. A description
 * is the executable basename plus at most three identifying arguments from the
 * rest of argv, sanitized and bounded. GATE-IMPLEMENTATION-SPEC.md section 8 is
 * explicit that raw argv must never be dumped because process arguments can
 * carry API keys, tokens or secret-bearing paths; so credential-shaped content
 * (an `sk-` credential token, `Bearer <value>`, `name=value` whose name ends in
 * token/key/secret/password/passwd/authorization, and a credential flag
 * followed by a separate value) is replaced with `[redacted]`, pattern-kill
 * text never survives, control characters and newlines are stripped and the
 * whole line is capped at 240 characters. Raw argv is never exposed by any
 * exported result type.
 *
 * NO MUTATION, NO LOCK, NO DRIVER. No database driver is imported and no
 * database call is made: nothing here opens a store through a driver, reads its
 * contents, takes a lock, or writes. No clock reads, no randomness and no
 * environment reads — the only inputs are the arguments, so identical inputs
 * produce deeply equal output. The function never throws for any probe outcome;
 * a probe that fails narrows the evidence and says so in the result.
 */

import fs from "node:fs";
import path from "node:path";

/** A store under inspection, identified by filesystem identity. */
export type HolderStore = {
  /** Canonical (realpath) spelling of the store file. */
  canonicalPath: string;
  /** Filesystem device id as a decimal string (bigint-sourced). */
  dev: string;
  /** Filesystem inode number as a decimal string (bigint-sourced). */
  ino: string;
};

/** One probe that did not complete. Recorded evidence, never a refusal. */
export type ProbeFailure = {
  /** Where the probe failed: a `pid:<pid>` scope, or a probe-wide scope. */
  scope: string;
  /** Sanitized, bounded description of what could not be read. */
  reason: string;
};

/** One process holding one or more of the inspected stores. */
export type Holder = {
  pid: number;
  startIdentity: string;
  /** Sanitized, bounded command identification (never raw argv). */
  commandDescription: string;
  /** Canonical store paths this process holds, deduped and byte-sorted. */
  storePaths: string[];
};

/** A raw process observation supplied by the probe. */
export type HolderCandidate = {
  pid: number;
  startIdentity: string;
  argv: string[];
  openPaths: string[];
};

/** The injected probe seam: the only way this module observes processes. */
export type HolderProbeDeps = {
  listOpenFileHolders(paths: string[]): HolderCandidate[];
};

/** The complete informational listing. No verdict field exists. */
export type HolderDetection = {
  observationComplete: boolean;
  holders: Holder[];
  probeFailures: ProbeFailure[];
};

/**
 * A probe that failed part-way, raised by the RUNNER (never by this module).
 *
 * It exists so a failure can say WHICH thing could not be observed and what it
 * had already seen: the scope names the failing unit (`pid:<pid>`,
 * `lsof:timeout`, `platform:<platform>`, ...) and `partialCandidates` carries
 * the candidates observed before the failure, which this module still matches
 * and lists. `detectStoreHolders` catches every value raised by the probe and
 * records it as a {@link ProbeFailure}; this class is never a refusal and is
 * never rethrown.
 */
export class HolderProbeError extends Error {
  /** The unit that failed: a `pid:<pid>` scope, or a probe-wide scope. */
  readonly scope: string;

  /** Candidates observed before the failure, when the probe had any. */
  readonly partialCandidates?: HolderCandidate[];

  constructor(scope: string, message: string, partialCandidates?: HolderCandidate[]) {
    super(message);
    this.name = "HolderProbeError";
    this.scope = scope;
    if (partialCandidates !== undefined) this.partialCandidates = partialCandidates;
  }
}

/** Trailing marker a probe adds when the open entry is already unlinked. */
const DELETED_SUFFIX = " (deleted)";

/** Placeholder used when the probe supplied no usable executable. */
const COMMAND_UNAVAILABLE = "(command unavailable)";

/** Bounded size for any free-form text this module records. */
const MAX_DESCRIPTION_LENGTH = 240;

/** Identifying arguments kept after the executable name. */
const MAX_IDENTIFYING_ARGUMENTS = 3;

/** Marker substituted for credential-shaped or pattern-kill text. */
const REDACTED = "[redacted]";

/**
 * Credential NAME suffixes: a `name=value` argument whose name ends with one of
 * these carries a secret value, so the value is never emitted.
 */
const SECRET_NAME_SUFFIXES = [
  "token",
  "key",
  "secret",
  "password",
  "passwd",
  "authorization",
] as const;

/**
 * Bare flags (leading dashes ignored) whose NEXT argument is a secret value.
 */
const SECRET_FLAG_NAMES = new Set<string>([
  "token",
  "key",
  "secret",
  "password",
  "passwd",
  "authorization",
  "api-key",
  "api_key",
  "access-token",
  "access_token",
  "api-token",
  "api_token",
]);

/** Pattern-kill vocabulary that must never survive into a description. */
const PATTERN_KILL_WORDS = ["pkill", "killall"] as const;

/**
 * SQLite sidecar suffixes a store may carry. Exported so the darwin probe
 * runner can tell an OPTIONAL sidecar spelling (whose absence is normal) from a
 * REQUIRED store path (whose absence is evidence of a gap).
 */
export const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

interface Identity {
  dev: string;
  ino: string;
}

type IdentityLookup =
  | { kind: "ok"; identity: Identity }
  | { kind: "gone" }
  | { kind: "unreadable" };

interface StoreEntry {
  store: HolderStore;
  sidecars: string[];
}

/**
 * Strip the trailing " (deleted)" marker from an open-path spelling.
 *
 * The suffix is only ever appended by a process-listing probe; a real file name
 * may legitimately contain it, so only the exact trailing form is removed.
 */
function stripDeletedSuffix(openPath: string): string {
  return openPath.endsWith(DELETED_SUFFIX)
    ? openPath.slice(0, openPath.length - DELETED_SUFFIX.length)
    : openPath;
}

/** Read a path's filesystem identity as decimal strings (bigint, never double). */
function readIdentity(openPath: string): IdentityLookup {
  try {
    const stat = fs.statSync(openPath, { bigint: true });
    return {
      kind: "ok",
      identity: { dev: stat.dev.toString(), ino: stat.ino.toString() },
    };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "gone" };
    return { kind: "unreadable" };
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** Compare two strings by UTF-8 byte order (never locale, never UTF-16). */
function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/** Strip control characters, collapse whitespace, trim and bound the length. */
function sanitizeText(value: string): string {
  const flattened = value
    // Control bytes, including the newline and NUL that argv can carry.
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (flattened.length <= MAX_DESCRIPTION_LENGTH) return flattened;
  return `${flattened.slice(0, MAX_DESCRIPTION_LENGTH - 3)}...`;
}

function comparisonText(value: string): string {
  return typeof value === "string" ? value : "";
}

/** The three sidecar spellings of one store, in stable order. */
function sidecarSpellings(store: HolderStore): string[] {
  return SIDECAR_SUFFIXES.map((suffix) => `${store.canonicalPath}${suffix}`);
}

/**
 * Build the single probe path list: store path then its three sidecars, per
 * store, deduped in FIRST-SEEN order.
 *
 * The order is part of the contract because it is the order the probe is
 * handed, and a later story relies on a stable, caller-independent list.
 */
function buildProbePaths(entries: StoreEntry[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];

  const push = (candidate: string): void => {
    if (seen.has(candidate)) return;
    seen.add(candidate);
    paths.push(candidate);
  };

  for (const entry of entries) {
    push(entry.store.canonicalPath);
    for (const sidecar of entry.sidecars) push(sidecar);
  }

  return paths;
}

/** Strip leading dashes and lowercase a flag or assignment name. */
function normalizeName(name: string): string {
  return name.replace(/^-+/, "").toLowerCase();
}

/** True when a `name=value` NAME marks its value as a credential. */
function isCredentialName(name: string): boolean {
  const normalized = normalizeName(name);
  if (normalized.length === 0) return false;
  return SECRET_NAME_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/** True when a bare flag (leading dashes ignored) takes a secret value. */
function isCredentialFlag(token: string): boolean {
  return SECRET_FLAG_NAMES.has(normalizeName(token));
}

/**
 * Replace credential-shaped text: `sk-` credentials, `Bearer <value>` and
 * `name=value` assignments whose name marks the value as a secret.
 *
 * The `sk-` form requires at least eight credential characters after the
 * prefix and a boundary before it, so an innocuous word such as `task-runner`
 * is left alone. The `Bearer` spelling is canonicalized in the output.
 */
function redactCredentialShapes(text: string): string {
  let value = text;

  value = value.replace(
    /(^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{8,}/g,
    (_match, prefix: string) => `${prefix}${REDACTED}`,
  );

  value = value.replace(/\bBearer\s+\S+/gi, `Bearer ${REDACTED}`);

  value = value.replace(/([^\s=]+)=(\S*)/g, (match, name: string) =>
    isCredentialName(name) ? `${name}=${REDACTED}` : match,
  );

  return value;
}

/** Replace pattern-kill vocabulary, including the two-token force-kill form. */
function redactPatternKill(text: string): string {
  let value = text;
  for (const word of PATTERN_KILL_WORDS) {
    value = value.replace(new RegExp(word, "gi"), REDACTED);
  }
  return value.replace(/\bkill\s+-9(?:\s+\d+)?\b/gi, REDACTED);
}

/** One argv entry reduced to safe identification text. */
function sanitizeToken(value: string): string {
  const flattened = sanitizeText(value);
  if (flattened.length === 0) return "";
  return redactPatternKill(redactCredentialShapes(flattened));
}

/**
 * Identification-only command description.
 *
 * The executable basename plus at most three identifying arguments, with
 * credential-shaped content redacted, pattern-kill text removed, control
 * characters stripped and the whole line bounded. Raw argv never leaves this
 * function: only the sanitized string does.
 */
function describeCommand(argv: string[]): string {
  if (!Array.isArray(argv) || argv.length === 0) return COMMAND_UNAVAILABLE;

  const executablePath = typeof argv[0] === "string" ? sanitizeText(argv[0]) : "";
  if (executablePath.length === 0) return COMMAND_UNAVAILABLE;

  const executable = sanitizeToken(path.basename(executablePath));
  if (executable.length === 0) return COMMAND_UNAVAILABLE;

  const parts: string[] = [executable];
  let redactNextArgument = false;

  for (let index = 1; index < argv.length; index += 1) {
    if (parts.length > MAX_IDENTIFYING_ARGUMENTS) break;

    const entry = argv[index];
    if (typeof entry !== "string") continue;

    const flattened = sanitizeText(entry);
    if (flattened.length === 0) continue;

    // The value of a credential flag or a bare `Bearer` is never emitted.
    if (redactNextArgument) {
      redactNextArgument = false;
      parts.push(REDACTED);
      continue;
    }

    const sanitized = sanitizeToken(flattened);
    if (sanitized.length === 0) continue;

    if (/^bearer$/i.test(sanitized)) {
      redactNextArgument = true;
      parts.push("Bearer");
      continue;
    }

    if (!sanitized.includes("=") && isCredentialFlag(sanitized)) {
      redactNextArgument = true;
    }

    parts.push(sanitized);
  }

  // A description can join `kill` with a separate `-9`, so the pattern-kill
  // rule is applied once more across the assembled line.
  return sanitizeText(redactPatternKill(parts.join(" ")));
}

/** Scope recorded for a thrown probe when the failure carries no scope. */
function thrownScope(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const scope = (error as { scope?: unknown }).scope;
    if (typeof scope === "string") {
      const sanitized = sanitizeToken(scope);
      if (sanitized.length > 0) return sanitized;
    }
  }
  return "holder-probe";
}

/**
 * Candidates a typed probe failure had already observed, if it carried any.
 *
 * A partial observation is still evidence: the caller lists those candidates
 * instead of discarding them, so a failure late in a probe never hides a
 * holder the probe had already seen.
 */
function partialCandidatesOf(error: unknown): HolderCandidate[] | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const partial = (error as { partialCandidates?: unknown }).partialCandidates;
  return Array.isArray(partial) ? (partial as HolderCandidate[]) : undefined;
}

/**
 * Sanitize free-form probe text (a failure reason or a scope).
 *
 * The same credential and pattern-kill redaction as a command description is
 * applied here because a probe error message can quote a path or an argument
 * that carries a secret; control characters are stripped and the text is
 * bounded. GATE-IMPLEMENTATION-SPEC.md section 8 forbids raw argv and
 * pattern-kill text in anything the operator sees, and this text is shown.
 */
function sanitizeProbeText(value: string): string {
  return sanitizeToken(value);
}

/** Best-effort, always-safe textual description of a thrown value. */
function describeThrown(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string" && error.message.length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.length > 0) return error;
  try {
    return String(error);
  } catch {
    return "holder probe failed";
  }
}

interface AccumulatedHolder {
  pid: number;
  startIdentity: string;
  commandDescription: string;
  storePaths: Set<string>;
}

/**
 * List every live process holding one of `stores` (or one of its sidecars).
 *
 * INFORMATIONAL ONLY: the result never admits, refuses, reserves or kills
 * anything, and an incomplete observation is reported as such instead of being
 * raised or turned into a verdict.
 *
 * The probe is called exactly once (and not at all when no store is supplied),
 * with every store and sidecar spelling deduped in first-seen order.
 */
export function detectStoreHolders(
  stores: HolderStore[],
  deps: HolderProbeDeps,
): HolderDetection {
  if (!Array.isArray(stores) || stores.length === 0) {
    return { observationComplete: true, holders: [], probeFailures: [] };
  }

  const entries: StoreEntry[] = stores.map((store) => ({
    store,
    sidecars: sidecarSpellings(store),
  }));

  const probeFailures: ProbeFailure[] = [];
  let candidates: HolderCandidate[] = [];

  try {
    const probed = deps.listOpenFileHolders(buildProbePaths(entries));
    if (Array.isArray(probed)) {
      candidates = probed;
    } else {
      // A probe that returns something other than a list observed nothing it
      // can vouch for; silence must not read as a clean observation.
      probeFailures.push({
        scope: "holder-probe",
        reason: "malformed probe result: expected a candidate list",
      });
    }
  } catch (error) {
    // A failed probe is evidence, not a refusal and not an exception. A typed
    // HolderProbeError may still carry what it observed before failing, and
    // those candidates are matched exactly like a complete probe's would be:
    // aggregation outranks short-circuiting, so a partial observation never
    // hides a holder that was really seen.
    const partial = partialCandidatesOf(error);
    if (partial !== undefined) candidates = partial;

    probeFailures.push({
      scope: thrownScope(error),
      reason: sanitizeProbeText(describeThrown(error)) || "holder probe failed",
    });
  }

  const accumulated = new Map<string, AccumulatedHolder>();

  for (const candidate of candidates) {
    // The probe seam is typed, but a malformed entry must narrow the evidence
    // and SAY SO rather than crash the caller: this module never throws for a
    // probe, and silence must never read as a clean observation.
    const openPaths = (candidate as { openPaths?: unknown } | null)?.openPaths;
    if (!Array.isArray(openPaths)) {
      probeFailures.push({
        scope: "holder-probe",
        reason: "malformed candidate observation",
      });
      continue;
    }

    const matchedStores = new Set<string>();

    for (const rawOpenPath of openPaths) {
      if (typeof rawOpenPath !== "string") continue;

      // Entries such as "socket:[123]" are not filesystem paths at all.
      const openPath = stripDeletedSuffix(rawOpenPath);
      if (!path.isAbsolute(openPath)) continue;

      // Sidecar evidence is path-based; the suffix may be an unlinked spelling.
      for (const entry of entries) {
        if (entry.sidecars.includes(openPath)) {
          matchedStores.add(entry.store.canonicalPath);
        }
      }

      const lookup = readIdentity(openPath);
      if (lookup.kind === "gone") continue;
      if (lookup.kind === "unreadable") {
        // Inability to inspect is recorded; it never fabricates a match and
        // never becomes a silent "no holder" for the process. The path is
        // sanitized like any other recorded text, since it can carry a
        // credential-shaped segment.
        probeFailures.push({
          scope: `pid:${candidate.pid}`,
          reason:
            sanitizeProbeText(`open path unreadable: ${openPath}`) ||
            "open path unreadable",
        });
        continue;
      }

      for (const entry of entries) {
        if (
          entry.store.dev === lookup.identity.dev &&
          entry.store.ino === lookup.identity.ino
        ) {
          matchedStores.add(entry.store.canonicalPath);
        }
      }
    }

    if (matchedStores.size === 0) continue;

    const key = `${candidate.pid}\u0000${candidate.startIdentity}`;
    const description = describeCommand(candidate.argv);
    const existing = accumulated.get(key);
    if (existing) {
      // One process, observed more than once. Union its stores and keep the
      // byte-smallest description so the merged holder is identical no matter
      // which observation the probe returned first.
      for (const storePath of matchedStores) existing.storePaths.add(storePath);
      if (compareUtf8(description, existing.commandDescription) < 0) {
        existing.commandDescription = description;
      }
      continue;
    }

    accumulated.set(key, {
      pid: candidate.pid,
      startIdentity: candidate.startIdentity,
      commandDescription: description,
      storePaths: matchedStores,
    });
  }

  const holders: Holder[] = [...accumulated.values()]
    .map((holder) => ({
      pid: holder.pid,
      startIdentity: holder.startIdentity,
      commandDescription: holder.commandDescription,
      storePaths: [...holder.storePaths].sort(compareUtf8),
    }))
    .sort(
      (left, right) =>
        left.pid - right.pid ||
        compareUtf8(comparisonText(left.startIdentity), comparisonText(right.startIdentity)),
    );

  probeFailures.sort(
    (left, right) =>
      compareUtf8(left.scope, right.scope) || compareUtf8(left.reason, right.reason),
  );

  return {
    observationComplete: probeFailures.length === 0,
    holders,
    probeFailures,
  };
}
