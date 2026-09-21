/**
 * Matchlock dsh adapter — export/input contract (shared types + constants).
 *
 * This module owns the typed interfaces that every other `matchlock/dsh-*`
 * module (and eventually the Matchlock controller) consumes. All functions
 * across the adapter take EXPLICIT captured inputs (submitting env/cwd/home,
 * guest paths, artifact bytes); nothing reads the ambient daemon HOME/env or
 * the live `~/.dsh` store. The actual VFS/two-VM persistence proof is a
 * follow-on integration gate (see the out-of-repo `dsh-contract.json`).
 *
 * Format scope: only the native session-store shape actually inspected and
 * qualified on the vaivm installation is treated as attributable — the current
 * v3 JSONL generations (`session.v3.jsonl.zstd`, `session.v3.jsonl`) under
 * `$DSH_HOME/sessions/<projectKey(cwd)>/<session-id>/`. Anything else
 * (unknown generations, legacy `session.v2.*`/`session.jsonl*` layouts,
 * unknown encodings, torn/corrupt artifacts) is classified honestly, never
 * silently counted and never silently zeroed.
 */

// ── Constants ──────────────────────────────────────────────────────

/**
 * Guest configuration-directory override applied to every Matchlock dsh
 * launch: `DSH_HOME=/workspace/config/dsh` (design section 5 mapping table).
 * The whole effective home is mounted RW at this path — never a selective
 * profile/settings copy.
 */
export const DSH_GUEST_CONFIGURATION_ROOT = "/workspace/config/dsh";

/** dsh profile booted for a one-shot task run. */
export const DSH_GUEST_PROFILE = "headless";

/**
 * Sandbox mode injected into the guest launch environment. Full access is
 * scoped to the VM; it does not request privileged Matchlock mode and never
 * grants a host execution channel.
 */
export const DSH_GUEST_PERMISSION_MODE = "danger-full-access";

/** Default host configuration directory name under the submitting HOME. */
export const DSH_HOME_DIR_NAME = ".dsh";

/**
 * Current native session-store generation actually qualified on the installed
 * CLI (dsh >= 0.1.5): v3 sessions whose first record is a `type:"session"`
 * JSON header line. v3 persists `session.v3.jsonl.zstd` (compressed) and
 * `session.v3.jsonl` (plain); older `session.v2.*` / `session.jsonl*` layouts
 * are legacy and never attributed.
 */
export const DSH_CURRENT_SESSION_FORMAT_VERSION = 3;

// ── Submission context (frozen at run creation) ────────────────────

/**
 * Explicit submission-time context captured at run creation. The adapter
 * resolves the dsh home ONLY from these values; it never re-derives the store
 * from the daemon's own HOME/DSH_HOME at dispatch time.
 */
export interface DshSubmissionContext {
  /** Submitting user's HOME (fallback for the `~/.dsh` default). */
  homeDir: string;
  /** Submitting user's env snapshot — only `DSH_HOME` is consulted. */
  env: Record<string, string | undefined>;
  /** Submitting command's cwd (resolves a relative `DSH_HOME`). */
  cwd: string;
}

/** Where the captured host home came from. */
export type DshHomeSource = "env" | "default";

/** Canonical host dsh home resolved from a frozen submission context. */
export interface DshResolvedHostHome {
  /** Canonical absolute host dsh home directory. */
  hostHome: string;
  /** Selection source: explicit `$DSH_HOME` vs `~/.dsh` default. */
  source: DshHomeSource;
}

// ── Home preservation inspection (never content) ───────────────────

export type DshHomeEntryKind = "dir" | "file" | "symlink";

/** One top-level entry of the dsh home — presence metadata only. */
export interface DshHomeEntry {
  name: string;
  kind: DshHomeEntryKind;
  /** true when the name indicates a secret-bearing file (contents never read). */
  sensitive: boolean;
  /** Symlink target when kind === "symlink". */
  symlinkTarget?: string;
}

/** One dsh-managed profile module fallback link under `profiles/node_modules`. */
export interface DshProfileModuleLink {
  packageName: string;
  /** Absolute path of the link. */
  linkPath: string;
  /** Raw symlink target (host- or guest-installation-relative). */
  target: string;
  /** First path segment of the resolved target, for installation-site grouping. */
  targetRoot: string;
}

// ── Guest launch construction ──────────────────────────────────────

export interface DshGuestLaunchOptions {
  /** The one-shot task prompt (passed verbatim as the headless operand). */
  prompt: string;
  /** Guest `DSH_HOME` value; defaults to `/workspace/config/dsh`. */
  guestHome?: string;
  /** Profile to boot; defaults to `headless`. */
  profile?: string;
  /**
   * Binary argv[0] resolved INSIDE the image (guest PATH). The adapter never
   * embeds a host binary path — image PATH is independent of host PATH.
   */
  guestBinary?: string;
  /**
   * Additional allowed guest launch values (explicit protected inputs only —
   * e.g. proxy-secret injection). These are merged BELOW the two mandatory
   * dsh overrides, which always win.
   */
  extraGuestEnv?: Record<string, string>;
}

/** Complete, explicit launch construction for one guest dsh round. */
export interface DshGuestLaunchDescriptor {
  /** argv[0] is the guest-resolved binary name; never a host path. */
  command: string[];
  /**
   * Exact env overrides the controller must apply inside the guest on top of
   * the image's inherited environment. `DSH_HOME` and `DSH_PERMISSION_MODE`
   * are unconditional.
   */
  env: Record<string, string>;
  /** dsh reads the task from argv; the adapter always closes stdin. */
  stdin: "close";
  /**
   * stdout contract: preserve verbatim (including any final newline/STATUS);
   * dsh stdout is plain text, NOT pi JSON — no filtering or trimming.
   */
  stdout: "verbatim";
  /**
   * True when the prompt's first character is `-`; the launch then carries TWO
   * `--` separators (the outer launcher and the inner headless commander
   * parser each consume one) so the task operand survives parse.
   */
  promptLeadingDash: boolean;
  /** Human summary of the constructed invocation. */
  summary: string;
}

// ── Round termination (controller-owned) ───────────────────────────

/** Child exit forensics reported by the launch mechanism. */
export interface DshChildExit {
  /** Process exit code, or null when killed by signal. */
  exitCode: number | null;
  /** Terminating signal, or null. */
  signal: string | null;
}

/**
 * Controller-owned round outcome. Timeout/cancel ALWAYS win: dsh traps
 * SIGTERM and exits 0 (supervisor-stop semantics), so a graceful post-
 * termination `exit 0` must never erase a timeout/cancellation already
 * recorded by the controller.
 */
export type DshRoundTermination =
  | "cancelled"
  | "timed-out"
  | "failed"
  | "completed";

// ── Session-store decode / parsing ─────────────────────────────────

/** Physical encodings of a JSONL session artifact. */
export type DshStoreEncoding = "zstd" | "plain";

/**
 * Bounded decode limits applied to every session-artifact read. Every limit
 * exists so a guest-mutated artifact can never trigger unbounded host reads
 * or unbounded decompression (the accepted threat model: the guest may
 * rewrite the ENTIRE mounted config, including symlink-swapping leaf or
 * ancestor paths inside the admitted store).
 */
export interface DshArtifactLimits {
  /** Max compressed/plain artifact bytes admitted for a host read. */
  maxArtifactBytes: number;
  /** Max decoded bytes admitted from a single zstd frame. */
  maxDecodedBytesPerFrame: number;
  /** Max total decoded bytes admitted across all frames of one artifact. */
  maxTotalDecodedBytes: number;
  /** Max structurally complete zstd frames admitted in one artifact. */
  maxFrames: number;
}

/**
 * Default bounded-read limits. Generous for real stores (the largest qualified
 * real v3 artifact was well under 1 MiB compressed) while refusing bombs: a
 * 512 MiB compressed cap with a 1 GiB total decoded cap means no unbounded
 * decompression is ever possible through the host reader.
 */
export const DSH_DEFAULT_ARTIFACT_LIMITS: DshArtifactLimits = {
  maxArtifactBytes: 512 * 1024 * 1024,
  maxDecodedBytesPerFrame: 512 * 1024 * 1024,
  maxTotalDecodedBytes: 1024 * 1024 * 1024,
  maxFrames: 10_000,
};

/** Structural decode classification for one artifact read. */
export type DshArtifactDecodeStatus =
  /** Fully decoded (zstd: every frame complete; plain: text). */
  | "ok"
  /** zstd: EOF inside the final frame — earlier frames decoded. */
  | "torn"
  /** zstd: structurally invalid (bad magic mid-stream, reserved bits/types). */
  | "corrupt"
  /** Artifact is zstd but no working decoder is available on this Node. */
  | "zstd-unavailable"
  /** Bytes are neither plain JSONL text nor a zstd container. */
  | "unknown-format"
  /** No artifact file for the selected generation was present. */
  | "missing-artifact"
  /**
   * Host read refused BEFORE opening: the artifact path is not inside the
   * admitted store root, or a leaf/ancestor path component is a symlink or a
   * non-regular file. The host reader never follows symlinks out of the
   * admitted config; post-guest attribution evidence must be obtained by the
   * confined guest-side bounded read while the VM is still owned (never a
   * general host read/SQL/shell bridge).
   */
  | "refused"
  /** Artifact exceeded an explicit bounded-read limit (size/frames/decoded). */
  | "over-limit";

/**
 * Parsed `type:"session"` header (v3 field set). `origin`/`parentSession` are
 * present only for subagent (child) sessions; a fresh headless root has
 * neither.
 */
export interface DshSessionHeader {
  type: "session";
  version: number;
  id: string;
  createdAt: number;
  cwd?: string;
  parentSession?: string;
  origin?: "subagent";
  isSeeded: boolean;
  delegationDepth: number;
  agentPreset?: string;
}

export interface DshSessionHeaderParse {
  header: DshSessionHeader | null;
  /** When non-null, why no usable header could be parsed. */
  problem: string | null;
}

/** One decoded session artifact, with usage extracted under the dsh convention. */
export interface DshSessionArtifactRead {
  /** Canonical generation file name read (e.g. `session.v3.jsonl.zstd`). */
  fileName: string;
  generation: number;
  encoding: DshStoreEncoding;
  decode: DshArtifactDecodeStatus;
  /**
   * Fully decoded plaintext when `decode` is "ok" (torn artifacts carry the
   * decoded prefix in {@link partialText}). null otherwise.
   */
  text: string | null;
  /** Decoded prefix from complete frames of a torn artifact. */
  partialText: string | null;
  /** True when any decoded frame was structurally invalid or undecodable. */
  incomplete: boolean;
  header: DshSessionHeader | null;
  headerProblem: string | null;
  /**
   * dsh usage convention: uncached prompt input + output tokens summed over
   * well-formed usage records. For v3, the counted source is the TOP-LEVEL
   * `data.usage` of `assistant/message` and `compaction/summary` records
   * (`inputTokens` is the UNcached prompt input, since the store's
   * `totalTokens` = input + output + cacheRead); legacy `assistant/chunk`
   * usage chunks are tolerated. The identical usage is mirrored into
   * `data.stream[*].chunk.usage`, so the top-level `data.usage` is counted
   * exactly once and the stream mirror is never summed. cache-read/cache-write
   * and reasoning tokens are excluded. null when no well-formed usage record
   * was found.
   */
  usageTokens: number | null;
  /**
   * True when at least one usage-bearing record was dropped because its token
   * fields were malformed, or the artifact could not be fully decoded — the
   * count must then not be treated as a verified total.
   */
  usageIncomplete: boolean;
  /** Number of well-formed usage records summed. */
  usageRecords: number;
}

// ── Attribution ────────────────────────────────────────────────────

export interface DshSessionInventoryEntry {
  /** Session directory name (native `encodeSegment(id)` — normally `session-<uuid>`). */
  dirName: string;
  /** Absolute path of the session directory. */
  dirPath: string;
  /** Current-generation artifact file name present in the dir, or null. */
  artifactFileName: string | null;
  /** Header identity when the artifact decoded cleanly (best effort). */
  header: DshSessionHeader | null;
  headerProblem: string | null;
}

export interface DshSessionInventory {
  /** Absolute sessions project directory scanned (`sessions/<projectKey(cwd)>`). */
  projectDir: string;
  /** Session directories keyed by directory name. */
  sessions: Map<string, DshSessionInventoryEntry>;
}

export type DshSessionRole = "root" | "child" | "unattributed";

export interface DshAttributionSession {
  dirName: string;
  role: DshSessionRole;
  /** Root session id this session chains to (self for a root). */
  lineageRoot: string | null;
  header: DshSessionHeader | null;
  headerProblem: string | null;
  read: DshSessionArtifactRead | null;
  /** usageTokens from a clean full decode; null otherwise. */
  usageTokens: number | null;
}

export type DshAttributionStatus =
  /** Exactly one root lineage identified and fully accounted. */
  | "attributed"
  /** More than one plausible root (e.g. two simultaneous runs) — never newest. */
  | "ambiguous"
  /** No new session / no attributable root — nothing borrowed. */
  | "unavailable"
  /** Root identified but artifacts torn/corrupt/missing — partial evidence only. */
  | "incomplete";

export interface DshAttributionResult {
  status: DshAttributionStatus;
  /** Short human reason for the status. */
  reason: string;
  workdir: string;
  /** Absolute `sessions/<projectKey(cwd)>` directory under the mapped home. */
  projectDir: string;
  /**
   * Honest lineage boundary. Only session dirs under {@link projectDir}
   * (`sessions/<projectKey(workdir)>`) are scanned; a child session that
   * records a DIFFERENT cwd lives under another project key and is never
   * silently included in (or omitted from) this total — the caller must
   * traverse that scope separately via the confined guest-side read. A
   * `tokenTotal` therefore never claims cross-cwd completeness.
   */
  lineageScope: string;
  /** Root session id when a single lineage was resolved. */
  rootSessionId: string | null;
  /** Root + attributed descendant session directory names (each counted once). */
  lineageSessionIds: string[];
  /** Sum of root + descendants usage; null unless every lineage artifact was clean. */
  tokenTotal: number | null;
  /** True when any lineage artifact was torn/corrupt/malformed. */
  incomplete: boolean;
  /** Per-session evidence for every newly created session (never dropped). */
  sessions: DshAttributionSession[];
}

/** Options for {@link resolveDshAttribution}. */
export interface DshAttributionOptions {
  /** Canonical absolute host dsh home (mapped store). */
  dshHome: string;
  /** Absolute launch cwd — identical host/guest spelling by the exact-path rule. */
  workdir: string;
  /** Inventory recorded immediately before the guest launch. */
  pre: DshSessionInventory;
  /** Inventory recorded after the guest launch (post final flush). */
  post: DshSessionInventory;
  /**
   * Session directory names that were ALREADY attributed to this run by an
   * earlier round. A round's pre-launch inventory can be stale when the
   * scheduler admits a round before the previous round finished publishing its
   * guest-written session back to the host home; without this exclusion the
   * previous round's session would be counted a second time. Such a session is
   * never "newly created" for this round even when the (stale) pre inventory
   * does not contain it.
   */
  excludeSessionNames?: ReadonlySet<string>;
  /** Bounded-read limits for decoding created artifacts. */
  limits?: Partial<DshArtifactLimits>;
}

// ── Adapter plan (facade) ──────────────────────────────────────────

export interface DshExecutionPlan {
  home: DshResolvedHostHome;
  /** Guest mapping: whole home mounted RW at this guest path. */
  guestHome: string;
  /** Guest profile to boot. */
  guestProfile: string;
  /** The exact host/guest launch cwd (equal spelling). */
  workdir: string;
  /** Whether workdir is preserved host-identically in the guest. */
  workdirPreserved: true;
  /** Guest permission-mode override. */
  guestPermissionMode: string;
  /**
   * Preservation rule: the ENTIRE effective home is admitted RW — credentials
   * (`.credentials.yaml` v1/refs), profiles, plugins, sessions, caches and
   * unknown entries. No selective copy, no host binary mounts, no config
   * migration is performed by this adapter.
   */
  preservation: "entire-home-rw";
}
