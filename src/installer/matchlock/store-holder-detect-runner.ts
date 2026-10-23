/**
 * Default Matchlock store-holder probe runner (Linux procfs + darwin lsof).
 *
 * G6 HOLDER-DETECTION (bead tamandua-7p5.1.6) US-005/US-006. This is the THIN default
 * {@link HolderProbeDeps} implementation for `store-holder-detect.ts`. It
 * exists so the pure module never imports a spawn-capable module (procfs
 * helpers, the bounded lsof primitive) and its test can stay in the parallel
 * lane; this runner and its test carry the serial-lane classification instead.
 *
 * READ-ONLY PROBES ONLY. The runner enumerates processes and the files they
 * have open. It never opens a store through a database driver, never takes a
 * lock, never writes, never signals and never kills anything. Its entire output
 * is a candidate list handed to the pure module, which remains the authority
 * for the `(dev, ino)` match, for sidecar spelling, for redaction and for
 * ordering. Nothing here decides, refuses or reserves anything: holder
 * detection is an informational listing, and two or more holders is a normal,
 * permitted state.
 *
 * SAME-USER LIMITATION (documented, deliberate). The Linux path keeps only
 * processes whose owner uid equals the effective uid of this process. Other
 * users' processes are OUT OF SCOPE for the gate: their file descriptors are
 * unreadable without privilege, and the stores a Matchlock launch maps are the
 * caller's own. Skipping them is therefore not a probe failure and never sets
 * `observationComplete: false`.
 *
 * NON-DUMPABLE SAME-USER PROCESSES are NOT skipped, and an unprivileged probe
 * on a normal systemd host therefore reports `observationComplete: false` while
 * still listing every holder it could see. A user session manager (`systemd
 * --user`) allows its descriptor DIRECTORY to be listed but denies the
 * `readlink`s, and its `(sd-pam)` helper denies the directory itself; the kernel
 * refuses to expose either process's open files to anyone, including its owner.
 * The rule is the one this story pins: an unreadable descriptor directory is
 * NOT an absence of holders, so it is recorded as a pid-scoped
 * {@link ProbeFailure} (the listing is informational, so the gate is not
 * affected). Silently treating an unreadable process as "holds nothing" would
 * trade a visible gap for an invisible one.
 *
 * LINUX ENUMERATION. `listPids()` then, per same-user pid, read the pid's
 * procfs `fd` directory, `readlink` each entry to collect raw open-path
 * spellings (a trailing " (deleted)" is preserved: an unlinked file can still
 * be held open) and read the pid's procfs `cmdline` split on NUL with the
 * trailing empty element dropped. Non-absolute descriptors (`socket:[...]`,
 * `pipe:[...]`, `anon_inode:...`) are not filesystem paths and are ignored.
 * The identity prefilter below is DEFENSE IN DEPTH, NOT THE AUTHORITY: it only
 * drops a process whose open paths share no filesystem identity with any
 * requested path, and it may only ever OVER-include — the raw spellings are
 * returned so the pure module re-derives the match itself.
 *
 * FAILURE SEMANTICS. A vanished pid or descriptor (ENOENT) is skipped: that is
 * a normal race with process exit, not a gap. A same-user pid whose descriptor
 * directory cannot be read, whose descriptors cannot be resolved, or whose
 * kernel start identity is unavailable is NOT an absence of holders: the
 * enumeration finishes so the remaining processes are still observed, then
 * throws a {@link HolderProbeError} with that pid's scope and every candidate
 * collected so far as `partialCandidates`, which the pure module still lists.
 * An unsupported platform throws; it never returns `[]`, because an
 * unperformed observation must not read as "no holders". A failure here is
 * recorded by the pure module and is NOT a gate refusal (no reason code covers
 * it; GATE-IMPLEMENTATION-SPEC.md sections 3 and 5).
 *
 * DARWIN uses the bounded lsof primitive (`runLsof` in
 * `src/lib/lsof-probe.ts`, which ALWAYS prepends `-b -w` and enforces a hard
 * SIGKILL timeout) exactly once per probe:
 *
 *   runLsof(["-F", "pcn", "--", ...paths])
 *
 * and parses the `p<pid>` / `c<command>` / `n<path>` field records into
 * candidates. lsof only reports descriptors it could match to the requested
 * paths, so no identity prefilter runs there; the raw `n` spellings are
 * returned and the pure module still re-derives the `(dev, ino)` match. lsof
 * has no argv, so a candidate's `argv` is `[command]` (the `c` record) and a
 * process whose command lsof could not report has no argv at all, which the
 * pure module renders as "(command unavailable)". lsof's own exit convention
 * is honoured: status 1 with EMPTY stderr means "no open file matched a
 * requested path" (zero candidates, NOT a failure), while a timeout, an
 * unavailable binary or any other non-zero exit is UNKNOWN — it throws a
 * {@link HolderProbeError} (`lsof:timeout` / `lsof:probe`) rather than reading
 * as "no holder". Every other platform throws `platform:<platform>` /
 * "unsupported platform"; it never returns `[]`.
 *
 * HERMETIC SEAMS. Every filesystem, uid, clock-free identity and lsof read is
 * injected through {@link HolderRunnerSeams}, so no test needs a real process,
 * a real descriptor or a real lsof binary. The defaults are the production
 * helpers: `src/lib/proc-info.ts` (`hasProcfs`, `listPids`, `procfsPidPath`),
 * `node:fs`, `src/lib/process-start-identity.ts` (`getProcessStartIdentity`)
 * and `src/lib/lsof-probe.ts` (`runLsof`, already `-b -w` with a SIGKILL
 * timeout — never call `lsof` any other way).
 */

import fs from "node:fs";
import path from "node:path";
import {
  hasProcfs as procfsAvailable,
  listPids as listVisiblePids,
  procfsPidPath,
} from "../../lib/proc-info.js";
import { runLsof as boundedLsof } from "../../lib/lsof-probe.js";
import type { LsofProbeResult } from "../../lib/lsof-probe.js";
import { getProcessStartIdentity } from "../../lib/process-start-identity.js";
import { HolderProbeError } from "./store-holder-detect.js";
import type { HolderCandidate, HolderProbeDeps } from "./store-holder-detect.js";

/** Filesystem identity of a path, as DECIMAL strings (never JS doubles). */
export type HolderPathIdentity = {
  dev: string;
  ino: string;
};

/**
 * Injectable side-effect seams for the default probe.
 *
 * Production callers pass nothing: {@link createDefaultHolderProbeDeps} fills
 * every seam with the real helper. Tests override what they need, so every
 * branch (a same-user holder, an other-user process, a vanished pid, an
 * unreadable descriptor directory, an unsupported platform) is exercisable
 * without a real child process or a real lsof binary.
 */
export type HolderRunnerSeams = {
  /** Platform to probe for: `linux` (procfs) or `darwin` (bounded lsof). */
  platform: NodeJS.Platform;
  /** Whether procfs is present and readable (true on Linux). */
  hasProcfs: () => boolean;
  /** Every visible pid. */
  listPids: () => number[];
  /** Directory entries of a directory. */
  readDir: (dirPath: string) => string[];
  /** Resolve one directory entry (a descriptor link) to its target spelling. */
  readLink: (linkPath: string) => string;
  /**
   * Raw `cmdline` content of a pid (NUL-separated argv), or null when it
   * cannot be read. The caller splits on NUL and drops the trailing empty
   * element.
   */
  readCmdline: (pid: number) => string | null;
  /** Owner uid of a pid's procfs directory entry. */
  statUid: (procPath: string) => number;
  /** Identity of a path, or null when it cannot be read (missing/unreadable). */
  statIdentity: (candidatePath: string) => HolderPathIdentity | null;
  /** Kernel start identity of a pid, or null when it is unavailable. */
  getStartIdentity: (pid: number) => string | null;
  /** Bounded lsof probe (the ONLY sanctioned lsof entry point). */
  runLsof: (args: readonly string[]) => LsofProbeResult;
};

/** Trailing marker the kernel appends to an unlinked-but-open descriptor. */
const DELETED_SUFFIX = " (deleted)";

/** Split a raw `cmdline` into argv, dropping the trailing empty element. */
function splitCmdline(raw: string): string[] {
  const parts = raw.split("\u0000");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** Strip the trailing " (deleted)" marker from a descriptor spelling. */
function stripDeletedSuffix(openPath: string): string {
  return openPath.endsWith(DELETED_SUFFIX)
    ? openPath.slice(0, openPath.length - DELETED_SUFFIX.length)
    : openPath;
}

/** `code` of a thrown filesystem error, when it has one. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** Short, non-secret descriptor of a thrown filesystem error. */
function errorText(error: unknown): string {
  const code = errorCode(error);
  if (code !== undefined) return code;
  if (error instanceof Error && error.message.length > 0) return error.message;
  return "unknown error";
}

/** Identity key used by the prefilter (dev + ino as decimal strings). */
function identityKey(identity: HolderPathIdentity): string {
  return `${identity.dev}:${identity.ino}`;
}

/**
 * Requested-path evidence the prefilter matches against.
 *
 * `identities` holds the `(dev, ino)` keys of every requested path that
 * resolves; `spellings` holds every requested spelling, so a process holding
 * an unlinked sidecar open (identity gone, spelling intact) is still kept.
 */
type RequestedEvidence = {
  identities: Set<string>;
  spellings: Set<string>;
};

/** Collect the requested paths' identities and spellings (never throws). */
function collectRequestedEvidence(
  requestedPaths: readonly string[],
  seams: HolderRunnerSeams,
): RequestedEvidence {
  const identities = new Set<string>();
  const spellings = new Set<string>();

  for (const requested of requestedPaths) {
    if (typeof requested !== "string" || requested.length === 0) continue;
    spellings.add(requested);
    const identity = seams.statIdentity(requested);
    if (identity !== null) identities.add(identityKey(identity));
  }

  return { identities, spellings };
}

/**
 * Whether any of a process's open paths is plausibly one of the requested
 * paths.
 *
 * DEFENSE IN DEPTH ONLY. The answer may be a superset of what the pure module
 * will match, never a subset: identity is re-derived by the module from these
 * same raw spellings, and a removed sidecar is kept by spelling alone because
 * its identity no longer exists to compare.
 */
function holdsRequestedPath(
  openPaths: readonly string[],
  requested: RequestedEvidence,
  seams: HolderRunnerSeams,
): boolean {
  for (const rawOpenPath of openPaths) {
    const spelling = stripDeletedSuffix(rawOpenPath);
    if (requested.spellings.has(spelling)) return true;
    const identity = seams.statIdentity(spelling);
    if (identity !== null && requested.identities.has(identityKey(identity))) return true;
  }
  return false;
}

/** One probe failure observed while enumerating, scoped to a pid. */
type PidFailure = {
  scope: string;
  reason: string;
};

/** Ascending numeric pid order, so the reported failure is deterministic. */
function sortedPids(pids: readonly number[]): number[] {
  return pids
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .slice()
    .sort((left, right) => left - right);
}

/**
 * Read one process's absolute open-file descriptors.
 *
 * Returns the RAW spellings (a trailing " (deleted)" is preserved). A vanished
 * pid (ENOENT) yields `null`; an unreadable descriptor directory or an
 * unresolvable descriptor yields a failure, because neither is evidence that
 * the process holds nothing.
 */
function readOpenPaths(
  pid: number,
  seams: HolderRunnerSeams,
): { openPaths: string[]; failure: PidFailure | null } {
  let entries: string[];
  try {
    entries = seams.readDir(procfsPidPath(pid, "fd"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { openPaths: [], failure: null };
    return {
      openPaths: [],
      failure: {
        scope: `pid:${pid}`,
        reason: `cannot list open file descriptors: ${errorText(error)}`,
      },
    };
  }

  const openPaths: string[] = [];
  let failure: PidFailure | null = null;

  for (const entry of entries) {
    let target: string;
    try {
      target = seams.readLink(procfsPidPath(pid, "fd", entry));
    } catch (error) {
      const code = errorCode(error);
      // The descriptor closed between the directory read and the readlink:
      // normal, and not a gap. Anything else is a partial observation: a
      // process whose descriptors cannot be resolved may still hold a store,
      // so it is recorded (pid-scoped) rather than read as "no holder".
      if (code === "ENOENT") continue;
      failure ??= {
        scope: `pid:${pid}`,
        reason: `cannot resolve open file descriptor: ${errorText(error)}`,
      };
      continue;
    }

    // "socket:[123]", "pipe:[456]" and "anon_inode:..." are not paths.
    if (!path.isAbsolute(target)) continue;
    openPaths.push(target);
  }

  return { openPaths, failure };
}

/** Effective uid of this process, or null when the host exposes none. */
function effectiveUid(): number | null {
  const getuid = process.getuid;
  if (typeof getuid !== "function") return null;
  return getuid.call(process);
}

/**
 * Enumerate Linux holder candidates for `requestedPaths`.
 *
 * Every same-user pid is inspected; processes whose open paths share no
 * identity (and no spelling) with a requested path are omitted. The first
 * inspection failure (in ascending pid order) is raised at the END of the
 * enumeration with the candidates observed so far as `partialCandidates`, so a
 * late failure never hides an earlier real holder.
 */
function listLinuxCandidates(
  requestedPaths: readonly string[],
  seams: HolderRunnerSeams,
): HolderCandidate[] {
  const uid = effectiveUid();
  if (uid === null) {
    throw new HolderProbeError("platform:linux", "effective user id is unavailable");
  }

  const requested = collectRequestedEvidence(requestedPaths, seams);
  const candidates: HolderCandidate[] = [];
  let failure: PidFailure | null = null;

  for (const pid of sortedPids(seams.listPids())) {
    let ownerUid: number;
    try {
      ownerUid = seams.statUid(procfsPidPath(pid));
    } catch (error) {
      // A pid that exited between listing and inspection is normal.
      if (errorCode(error) === "ENOENT") continue;
      failure ??= {
        scope: `pid:${pid}`,
        reason: `cannot determine process owner: ${errorText(error)}`,
      };
      continue;
    }

    // Other users' processes are out of scope by design (see the header), not
    // a probe failure: their descriptors are unreadable without privilege and
    // the stores under inspection belong to this user.
    if (ownerUid !== uid) continue;

    const observed = readOpenPaths(pid, seams);
    if (observed.failure !== null) failure ??= observed.failure;
    if (observed.openPaths.length === 0) continue;
    if (!holdsRequestedPath(observed.openPaths, requested, seams)) continue;

    const cmdline = seams.readCmdline(pid);
    const argv = cmdline === null ? [] : splitCmdline(cmdline);

    const startIdentity = seams.getStartIdentity(pid);
    if (startIdentity === null) {
      // A holder with no honest identity cannot be reported as one, and an
      // invented identity could never be compared safely.
      failure ??= {
        scope: `pid:${pid}`,
        reason: "process start identity is unavailable",
      };
      continue;
    }

    candidates.push({ pid, startIdentity, argv, openPaths: observed.openPaths });
  }

  if (failure !== null) {
    throw new HolderProbeError(failure.scope, failure.reason, candidates);
  }

  return candidates;
}

/** Bound for any free-form probe text a HolderProbeError carries. */
const MAX_PROBE_REASON_LENGTH = 240;

/**
 * Flatten, bound and trim probe text for a typed failure.
 *
 * The pure module sanitizes a recorded reason again (credential redaction and
 * pattern-kill removal), so this only has to keep the message single-line and
 * bounded — lsof stderr can quote a whole path list.
 */
function boundedProbeReason(value: string, fallback: string): string {
  const flattened = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (flattened.length === 0) return fallback;
  if (flattened.length <= MAX_PROBE_REASON_LENGTH) return flattened;
  return `${flattened.slice(0, MAX_PROBE_REASON_LENGTH - 3)}...`;
}

/** One process block of lsof field output. */
type LsofProcessBlock = {
  pid: number;
  /** The reported command name (`c` record), when lsof supplied one. */
  command: string | null;
  /** Absolute `n` records, deduped in first-seen order. */
  openPaths: string[];
};

/**
 * Parse `lsof -F pcn` field output into process blocks.
 *
 * A `p<pid>` record opens a process block; `c<command>` names it and `n<path>`
 * adds an open file. Every other field record (and any record that arrives
 * before a process header) is ignored, so a future `-F` extension cannot
 * corrupt the result. Only absolute `n` values are kept: lsof also reports
 * `socket:`, `pipe:`-style and protocol entries, which are not filesystem
 * paths. Blocks are returned in ascending pid order so a later start-identity
 * failure is reported deterministically.
 */
function parseLsofFieldOutput(stdout: string): LsofProcessBlock[] {
  const blocks = new Map<number, LsofProcessBlock>();
  let current: LsofProcessBlock | null = null;

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) continue;

    const field = line[0];
    const value = line.slice(1);

    if (field === "p") {
      // A malformed pid header ends the current block; the following records
      // cannot be attributed to any process.
      const pid = Number(value);
      if (!Number.isInteger(pid) || pid <= 0) {
        current = null;
        continue;
      }
      const existing = blocks.get(pid);
      if (existing === undefined) {
        current = { pid, command: null, openPaths: [] };
        blocks.set(pid, current);
      } else {
        current = existing;
      }
      continue;
    }

    if (current === null) continue;
    if (field === "c") {
      if (value.length > 0) current.command = value;
      continue;
    }
    if (field === "n") {
      if (!path.isAbsolute(value)) continue;
      if (!current.openPaths.includes(value)) current.openPaths.push(value);
    }
  }

  return [...blocks.values()].sort((left, right) => left.pid - right.pid);
}

/**
 * Turn parsed lsof field output into candidates.
 *
 * Returns the candidates observed AND the first start-identity failure rather
 * than throwing, so a caller can attach both to a probe failure: partial
 * evidence must never be discarded just because the probe also failed
 * (GATE-IMPLEMENTATION-SPEC.md section 1 — aggregation outranks
 * short-circuiting).
 */
function collectDarwinCandidates(
  stdout: string,
  seams: HolderRunnerSeams,
): { candidates: HolderCandidate[]; failure: PidFailure | null } {
  const candidates: HolderCandidate[] = [];
  let failure: PidFailure | null = null;

  for (const block of parseLsofFieldOutput(stdout)) {
    // A process lsof listed but then matched to no absolute path is not a
    // holder (nothing to compare).
    if (block.openPaths.length === 0) continue;

    const startIdentity = seams.getStartIdentity(block.pid);
    if (startIdentity === null) {
      // Never fabricate an identity; keep observing the remaining processes
      // and raise the first failure with everything already collected.
      failure ??= {
        scope: `pid:${block.pid}`,
        reason: "process start identity is unavailable",
      };
      continue;
    }

    candidates.push({
      pid: block.pid,
      startIdentity,
      // lsof reports a command NAME only; there is no argv to leak.
      argv: block.command === null ? [] : [block.command],
      openPaths: block.openPaths,
    });
  }

  return { candidates, failure };
}

/**
 * Enumerate darwin holder candidates with ONE bounded lsof probe.
 *
 * Only `runLsof` from `src/lib/lsof-probe.ts` is used: it owns `-b -w` and the
 * SIGKILL timeout, so this module must never spawn lsof itself and never adds
 * those flags. A probe that could not answer throws a typed
 * {@link HolderProbeError} (`lsof:timeout` / `lsof:probe`) instead of reading
 * as "no holder"; lsof's status-1-with-empty-stderr convention is the one
 * case that legitimately means "nothing matched".
 */
function listDarwinCandidates(
  requestedPaths: readonly string[],
  seams: HolderRunnerSeams,
): HolderCandidate[] {
  const scopedPaths = requestedPaths.filter(
    (requested) => typeof requested === "string" && requested.length > 0,
  );
  // lsof without a file argument lists every open file on the host. An empty
  // scope is therefore answered here, not by asking lsof.
  if (scopedPaths.length === 0) return [];

  let result: LsofProbeResult;
  try {
    // The ONE pinned lsof argv: bounded primitive owns -b -w and the timeout,
    // and "pcn" requests pid, command and file name records only.
    result = seams.runLsof(["-F", "pcn", "--", ...scopedPaths]);
  } catch (error) {
    throw new HolderProbeError(
      "lsof:probe",
      boundedProbeReason(`lsof probe failed: ${errorText(error)}`, "lsof probe failed"),
    );
  }

  if (result.kind === "timeout") {
    // A timed-out probe is UNKNOWN, never "no holder".
    throw new HolderProbeError(
      "lsof:timeout",
      `lsof probe timed out after ${result.timeoutMs}ms`,
    );
  }

  if (result.kind === "unavailable") {
    throw new HolderProbeError(
      "lsof:probe",
      boundedProbeReason(`lsof is unavailable: ${result.error}`, "lsof is unavailable"),
    );
  }

  if (result.kind === "error") {
    const stderr = result.stderr.trim();
    // lsof exits 1 when it found no open file matching the requested paths,
    // and reports that with EMPTY stderr. That is zero candidates, not a
    // failure — the one error status that is an observation.
    if (result.status === 1 && stderr.length === 0) return [];
    const detail =
      stderr.length > 0
        ? stderr
        : `lsof exited with status ${result.status === null ? "null" : result.status}`;
    throw new HolderProbeError(
      "lsof:probe",
      boundedProbeReason(detail, "lsof probe failed"),
    );
  }

  const { candidates, failure } = collectDarwinCandidates(result.stdout, seams);
  if (failure !== null) {
    throw new HolderProbeError(failure.scope, failure.reason, candidates);
  }
  return candidates;
}

/** Production implementations of every seam. */
function defaultSeams(): HolderRunnerSeams {
  return {
    platform: process.platform,
    hasProcfs: procfsAvailable,
    listPids: listVisiblePids,
    readDir: (dirPath: string) => fs.readdirSync(dirPath),
    readLink: (linkPath: string) => fs.readlinkSync(linkPath),
    readCmdline: (pid: number) => {
      try {
        return fs.readFileSync(procfsPidPath(pid, "cmdline"), "utf-8");
      } catch {
        return null;
      }
    },
    statUid: (procPath: string) => fs.statSync(procPath).uid,
    statIdentity: (candidatePath: string) => {
      try {
        // bigint: a 64-bit inode is lossy as a double, so identity is always
        // carried as decimal strings.
        const stat = fs.statSync(candidatePath, { bigint: true });
        return { dev: stat.dev.toString(), ino: stat.ino.toString() };
      } catch {
        return null;
      }
    },
    getStartIdentity: getProcessStartIdentity,
    runLsof: boundedLsof,
  };
}

/**
 * Build the default {@link HolderProbeDeps} probe.
 *
 * `overrides` replaces individual seams (tests only); every unset seam keeps
 * its production implementation. The returned probe ENUMERATES candidates
 * only: matching, sanitization and ordering stay in the pure module.
 */
export function createDefaultHolderProbeDeps(
  overrides: Partial<HolderRunnerSeams> = {},
): HolderProbeDeps {
  const defaults = defaultSeams();
  const seams: HolderRunnerSeams = {
    platform: overrides.platform ?? defaults.platform,
    hasProcfs: overrides.hasProcfs ?? defaults.hasProcfs,
    listPids: overrides.listPids ?? defaults.listPids,
    readDir: overrides.readDir ?? defaults.readDir,
    readLink: overrides.readLink ?? defaults.readLink,
    readCmdline: overrides.readCmdline ?? defaults.readCmdline,
    statUid: overrides.statUid ?? defaults.statUid,
    statIdentity: overrides.statIdentity ?? defaults.statIdentity,
    getStartIdentity: overrides.getStartIdentity ?? defaults.getStartIdentity,
    runLsof: overrides.runLsof ?? defaults.runLsof,
  };

  return {
    listOpenFileHolders(requestedPaths: string[]): HolderCandidate[] {
      if (seams.platform === "linux") {
        if (!seams.hasProcfs()) {
          throw new HolderProbeError(
            "platform:linux",
            "procfs is unavailable",
          );
        }
        return listLinuxCandidates(requestedPaths, seams);
      }
      if (seams.platform === "darwin") {
        // The bounded lsof primitive supplies the answer; no procfs exists.
        return listDarwinCandidates(requestedPaths, seams);
      }
      // Never `[]`: an unperformed observation must not read as "no holder".
      throw new HolderProbeError(
        `platform:${seams.platform}`,
        "unsupported platform",
      );
    },
  };
}
