/**
 * Matchlock dsh session attribution (explicit mapped store).
 *
 * For an opted-in round the adapter records a PRE-LAUNCH inventory of native
 * session ids/headers under the mapped store's per-cwd project directory,
 * launches the guest, then re-scans and attributes the round to the NEWLY
 * CREATED root session lineage — never to "the newest session directory"
 * (guest/host clocks need not match; a same-cwd native session or a parallel
 * opted-in run may be newer).
 *
 * Rules:
 * - Candidates are session directories that did NOT exist before launch.
 * - The root of the invocation is the created session whose v3 header has no
 *   `parentSession` and no `origin: "subagent"`.
 * - Created children whose header chains (`parentSession`, `origin: "subagent"`)
 *   to that root are attributed to the same lineage, each session counted once
 *   (no double counting; superseded legacy generations inside one session dir
 *   are never added).
 * - Two (or more) plausible roots → AMBIGUOUS (never "newest wins").
 * - No created session, or a created session whose header cannot be verified →
 *   UNAVAILABLE; nothing from another native session is ever borrowed.
 * - Torn/corrupt/missing artifacts or malformed usage → INCOMPLETE evidence,
 *   never a fabricated zero.
 */

import path from "node:path";
import fs from "node:fs";
import {
  DSH_DEFAULT_ARTIFACT_LIMITS,
  type DshArtifactLimits,
  type DshAttributionOptions,
  type DshAttributionResult,
  type DshAttributionSession,
  type DshAttributionStatus,
  type DshSessionHeader,
  type DshSessionInventory,
  type DshSessionInventoryEntry,
} from "./dsh-adapter-contract.js";
import {
  discoverSessionArtifacts,
  matchlockSessionProjectDir,
  readDshSessionArtifact,
} from "./dsh-session-store.js";

/** Build a session-level inventory entry from one directory (header best-effort). */
function inventorySessionDir(
  projectDir: string,
  dirName: string,
  admittedRoot: string,
  limits: DshArtifactLimits,
): DshSessionInventoryEntry {
  const dirPath = path.join(projectDir, dirName);
  const artifacts = discoverSessionArtifacts(dirPath);
  let header: DshSessionHeader | null = null;
  let headerProblem: string | null = artifacts.problem;
  if (artifacts.current !== null) {
    const read = readDshSessionArtifact({
      artifactPath: path.join(dirPath, artifacts.current),
      admittedRoot,
      limits,
    });
    header = read.header;
    headerProblem = read.headerProblem ?? null;
    if (read.decode !== "ok" && read.decode !== "torn") {
      headerProblem = read.headerProblem ?? read.decode;
    }
  }
  return {
    dirName,
    dirPath,
    artifactFileName: artifacts.current,
    header,
    headerProblem,
  };
}

/**
 * Snapshot the native session directories under the mapped home's per-cwd
 * project directory. Headers are read best-effort (a header is only valid
 * once its artifact has flushed, so a torn/unflushed artifact reports a
 * problem rather than a fake identity). All host reads are confined to the
 * mapped home (`admittedRoot`) with explicit bounded limits, so symlinked
 * leaf/ancestor components or outside-store paths are never followed.
 */
export function snapshotDshSessions(options: {
  dshHome: string;
  workdir: string;
  limits?: Partial<DshArtifactLimits>;
}): DshSessionInventory {
  const limits: DshArtifactLimits = { ...DSH_DEFAULT_ARTIFACT_LIMITS, ...options.limits };
  const projectDir = matchlockSessionProjectDir(options.dshHome, options.workdir);
  const sessions = new Map<string, DshSessionInventoryEntry>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return { projectDir, sessions };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    sessions.set(entry.name, inventorySessionDir(projectDir, entry.name, options.dshHome, limits));
  }
  return { projectDir, sessions };
}

/** Attribute a round to its newly created root lineage. */
export function resolveDshAttribution(options: DshAttributionOptions): DshAttributionResult {
  const { dshHome, workdir, pre, post } = options;
  const limits: DshArtifactLimits = { ...DSH_DEFAULT_ARTIFACT_LIMITS, ...options.limits };
  const projectDir = matchlockSessionProjectDir(dshHome, workdir);
  const lineageScope = `session dirs under ${projectDir} only; a child session recording a different cwd lives under another project key and is never silently included in (or omitted from) this total`;

  // Newly created session directories (dir did not exist prelaunch), minus any
  // session directory already attributed to this run by an earlier round. The
  // exclusion keeps attribution correct when the pre-launch inventory is STALE
  // (the scheduler can admit a round before the previous round finished
  // publishing its guest-written session back to the host home): that session
  // must never be counted a second time here.
  const alreadyAttributed = options.excludeSessionNames;
  const createdNames: string[] = [];
  for (const name of post.sessions.keys()) {
    if (pre.sessions.has(name)) continue;
    if (alreadyAttributed !== undefined && alreadyAttributed.has(name)) continue;
    createdNames.push(name);
  }
  createdNames.sort();

  const resultBase = {
    workdir,
    projectDir,
    lineageScope,
    rootSessionId: null as string | null,
    lineageSessionIds: [] as string[],
    tokenTotal: null as number | null,
    incomplete: false,
    sessions: [] as DshAttributionSession[],
  };

  if (createdNames.length === 0) {
    return {
      ...resultBase,
      status: "unavailable" as DshAttributionStatus,
      reason: "no session directory was created under the mapped store during this round",
    };
  }

  // Decode each created session fully (per-session evidence; raw bytes retained
  // by the caller's artifact capture, never rewritten). Reads are confined to
  // the mapped store with bounded limits (see admitHostArtifactRead).
  const created: DshAttributionSession[] = createdNames.map((name) => {
    const entry = post.sessions.get(name)!;
    const artifacts = discoverSessionArtifacts(entry.dirPath);
    if (artifacts.current === null) {
      return {
        dirName: name,
        role: "unattributed" as const,
        lineageRoot: null,
        header: entry.header,
        headerProblem: artifacts.problem,
        read: null,
        usageTokens: null,
      };
    }
    const read = readDshSessionArtifact({
      artifactPath: path.join(entry.dirPath, artifacts.current),
      admittedRoot: dshHome,
      limits,
    });
    return {
      dirName: name,
      role: "unattributed" as const,
      lineageRoot: null,
      header: read.header ?? entry.header,
      headerProblem: read.headerProblem ?? artifacts.problem,
      read,
      usageTokens: read.decode === "ok" ? read.usageTokens : null,
    };
  });

  const rootCandidates = created.filter(
    (s) =>
      s.header !== null &&
      s.header.parentSession === undefined &&
      s.header.origin !== "subagent",
  );

  if (rootCandidates.length === 0) {
    return {
      ...resultBase,
      status: "unavailable" as DshAttributionStatus,
      reason:
        "no created session carries a verifiable root header (missing/unsupported/corrupt/refused header); usage left unattributed",
      sessions: created,
    };
  }

  // Duplicate header ids among newly created sessions (reused directory names,
  // copied artifacts, or colliding ids) make lineage unverifiable — ambiguous,
  // never a winner, never borrowed.
  const seenIds = new Map<string, string>();
  let duplicateId: string | null = null;
  for (const s of created) {
    if (s.header === null) continue;
    const prior = seenIds.get(s.header.id);
    if (prior !== undefined) {
      duplicateId = s.header.id;
      break;
    }
    seenIds.set(s.header.id, s.dirName);
  }
  if (duplicateId !== null) {
    return {
      ...resultBase,
      status: "ambiguous" as DshAttributionStatus,
      reason: `duplicate session header id ${duplicateId} across newly created session dirs — lineage cannot be verified, never newest, never borrowed`,
      sessions: created,
    };
  }

  if (rootCandidates.length > 1) {
    return {
      ...resultBase,
      status: "ambiguous" as DshAttributionStatus,
      reason: `multiple new root sessions detected (${rootCandidates
        .map((c) => c.dirName)
        .join(", ")}); a shared mapped home cannot pick a winner — never newest`,
      sessions: created,
    };
  }

  const rootDirName = rootCandidates[0].dirName;
  // Build the lineage: root + every created session whose header parentSession
  // chain resolves to the root id (children are origin:"subagent").
  const lineageNames = new Set<string>([rootDirName]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of created) {
      if (lineageNames.has(s.dirName)) continue;
      const parent = s.header?.parentSession ?? null;
      if (parent !== null && lineageNames.has(parent)) {
        lineageNames.add(s.dirName);
        changed = true;
      }
    }
  }

  const sessionsWithRole: DshAttributionSession[] = created.map((s) => {
    const inLineage = lineageNames.has(s.dirName);
    return {
      ...s,
      role: s.dirName === rootDirName ? ("root" as const) : inLineage ? ("child" as const) : ("unattributed" as const),
      lineageRoot: inLineage ? rootDirName : null,
    };
  });

  // Sum usage over the lineage, once per session dir, from clean full decodes
  // only; any torn/corrupt/malformed artifact makes the total incomplete.
  let tokenTotal = 0;
  let anyClean = false;
  let incomplete = false;
  for (const s of lineageNames) {
    const session = created.find((c) => c.dirName === s)!;
    if (session.read === null) {
      incomplete = true; // session dir exists but no current artifact flushed
      continue;
    }
    if (session.read.decode !== "ok") {
      incomplete = true;
      continue;
    }
    if (session.read.usageIncomplete) incomplete = true;
    if (session.usageTokens !== null) {
      tokenTotal += session.usageTokens;
      anyClean = true;
    }
  }

  if (incomplete) {
    return {
      ...resultBase,
      status: "incomplete" as DshAttributionStatus,
      reason: `root lineage ${[...lineageNames].sort().join(", ")} identified but artifact evidence is incomplete (torn/corrupt/malformed/missing flush) — partial accounting only, never a verified total`,
      rootSessionId: rootDirName,
      lineageSessionIds: [...lineageNames].sort(),
      tokenTotal: anyClean ? tokenTotal : null,
      incomplete: true,
      sessions: sessionsWithRole,
    };
  }

  return {
    ...resultBase,
    status: "attributed" as DshAttributionStatus,
    reason: `attributed to root ${rootDirName} (lineage: ${[...lineageNames].sort().join(", ")})`,
    rootSessionId: rootDirName,
    lineageSessionIds: [...lineageNames].sort(),
    tokenTotal: anyClean ? tokenTotal : null,
    incomplete: false,
    sessions: sessionsWithRole,
  };
}
