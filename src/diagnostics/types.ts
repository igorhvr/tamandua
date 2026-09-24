/**
 * Shared types for the DIAG-PRUNE diagnostics + evidence-prune commands
 * (DIAG-PRUNE US-001).
 *
 * This module is types only: the compiled output is empty, so importing it
 * (type-only) never pulls a runtime dependency. The concrete interfaces here
 * are the contract every collector (US-003..US-008), the orchestrator
 * (US-010), the summary builder (US-009) and the prune planner/executor
 * (US-013/US-014) share.
 *
 * Two rules encoded by these shapes:
 *  1. Every source reports its own `SourceStatus`; an absent source is
 *     explicit (`'absent'`) and never a thrown exception or a fabricated
 *     value.
 *  2. Prune items carry `action: 'remove' | 'keep'` plus a `reason`; nothing
 *     that is kept is ever removed, and refusals are listed rather than
 *     silently dropped.
 */
import type { TamanduaEvent } from "../installer/events.js";

/** Availability classification for a diagnostic source. */
export type SourceStatus = "present" | "empty" | "absent";

/** A JSON-serializable row (an explicitly projected DB row). */
export type JsonObject = Record<string, unknown>;

/** A parsed run event, exactly as the event-stream reader returns it. */
export type RunEventRecord = TamanduaEvent;

/** A corrupt (unparseable) event line, reported without throwing. */
export interface CorruptEventRecord {
  file: string;
  offset: number;
  length: number;
  preview: string;
}

/** Run event stream collected across the run-scoped and rotated global files. */
export interface RunEventsCollection {
  status: SourceStatus;
  absenceReason?: string;
  files: string[];
  events: RunEventRecord[];
  corrupt: CorruptEventRecord[];
}

/** Run/step/story/abandonment/worktree rows for one run. */
export interface DbRowsCollection {
  status: SourceStatus;
  absenceReason?: string;
  runs: JsonObject[];
  steps: JsonObject[];
  stories: JsonObject[];
  story_abandonments: JsonObject[];
  run_worktrees: JsonObject[];
}

/** One matched daemon log line. */
export interface DaemonLogEntry {
  file: string;
  line: number;
  text: string;
}

/** Per-file scan outcome for the daemon log collector. */
export interface DaemonLogSource {
  path: string;
  status: SourceStatus;
  /** Number of run-matching lines found in this file. */
  lines: number;
  /** Present when the file could not be read (never thrown). */
  error?: string;
}

/** Daemon log lines mentioning the run, current and rotated files. */
export interface DaemonLogCollection {
  status: SourceStatus;
  absenceReason?: string;
  files: DaemonLogSource[];
  entries: DaemonLogEntry[];
  truncated: boolean;
}

/** A file inside an evidence directory (relative path + size). */
export interface EvidenceFileEntry {
  path: string;
  sizeBytes: number;
}

/** One suite ledger row for the run (paths only, never the full log body). */
export interface SuiteLedgerRow {
  id: number | string;
  runId: string;
  stepId: string | null;
  cmdDisplay: string | null;
  exitCode: number | null;
  durationMs: number | null;
  createdAt: string | null;
  logPath: string | null;
  hasLogTail: boolean;
}

/** Per-run evidence directory listing + suite ledger rows. */
export interface EvidenceCollection {
  status: SourceStatus;
  absenceReason?: string;
  evidenceDir: string;
  entries: EvidenceFileEntry[];
  totalBytes: number;
  suiteLedger: SuiteLedgerRow[];
  suiteLedgerStatus: SourceStatus;
}

/** Harness kinds whose session stores may be referenced by a run. */
export type HarnessKind = "pi" | "dsh" | "hermes";

/** A session-store file (path + size; contents are never read). */
export interface SessionStoreFile {
  path: string;
  sizeBytes: number;
}

/** The resolved store location and files for one harness. */
export interface SessionStoreEntry {
  harness: HarnessKind;
  status: SourceStatus;
  storeDir: string | null;
  candidatePaths: string[];
  files: SessionStoreFile[];
  absenceReason?: string;
}

/** Session-store paths for a workdir across harnesses (paths only). */
export interface SessionPathsCollection {
  status: SourceStatus;
  workdir: string;
  entries: SessionStoreEntry[];
}

/** A Matchlock VM evidence directory for the run. */
export interface MatchlockVmEvidence {
  vmId: string;
  dir: string;
  status: SourceStatus;
  logs: EvidenceFileEntry[];
  totalBytes: number;
}

/** A redacted Matchlock runner error record, parsed or malformed. */
export interface MatchlockErrorRecord {
  path: string;
  status: SourceStatus;
  record?: unknown;
  error?: string;
}

/** Matchlock-backed round diagnostics (policy, VM evidence, error records). */
export interface MatchlockCollection {
  status: SourceStatus;
  absenceReason?: string;
  policy: unknown;
  policyStatus: SourceStatus;
  vms: MatchlockVmEvidence[];
  consoleLogs: EvidenceFileEntry[];
  errorRecords: MatchlockErrorRecord[];
}

/** One step/story entry in the diagnostics timeline. */
export interface DiagnosticsTimelineEntry {
  kind: "step" | "story";
  id: string;
  title?: string;
  status?: string;
  instant?: string;
  retries?: number;
  abandonCount?: number;
  [key: string]: unknown;
}

/** A summary section carrying its own source status. */
export interface DiagnosticsSourceNote {
  status: SourceStatus;
  absenceReason?: string;
  [key: string]: unknown;
}

/**
 * The run section of a diagnostics summary. `status` is the run/DB
 * collector's source status; the run's own lifecycle state is `runStatus` so
 * the two can never be confused.
 */
export interface DiagnosticsRunSection extends DiagnosticsSourceNote {
  runStatus?: string;
  runNumber?: number;
  workflowId?: string;
  schedulingStatus?: string;
  schedulingError?: string;
  createdAt?: string;
  updatedAt?: string;
  tokensSpent?: number;
  workerLostCount?: number;
  ceilingExpiryCount?: number;
  instantFailCount?: number;
  harnessProbeStatus?: string;
  matchlockPolicyPresent?: boolean;
}

/**
 * The top-level diagnostics summary. It intentionally carries an index
 * signature so later collectors can add fields without breaking consumers.
 *
 * Every section carries its own `status`, so an absent source is explicit
 * (`'absent'`) and never presented as a fabricated value.
 */
export interface DiagnosticsSummary extends Record<string, unknown> {
  runId: string;
  bareRunId: string;
  status: string;
  schedulingStatus?: string;
  workflowId?: string;
  createdAt?: string;
  updatedAt?: string;
  generatedAt: string;
  run: DiagnosticsRunSection;
  timeline: DiagnosticsTimelineEntry[];
  timelineStatus: SourceStatus;
  retries: JsonObject[];
  forceFail?: DiagnosticsSourceNote & { reason?: string; event?: string };
  lastFailingRound?: DiagnosticsSourceNote & {
    event?: string;
    stepId?: string;
    stderrTail?: string;
    truncated?: boolean;
  };
  logs?: DiagnosticsSourceNote;
  evidence?: DiagnosticsSourceNote;
  sessions?: DiagnosticsSourceNote;
  matchlock?: DiagnosticsSourceNote;
  sources: Record<string, SourceStatus>;
}

/** An assembled diagnostics bundle (files written + its summary). */
export interface DiagnosticsBundle {
  runId: string;
  bareRunId: string;
  bundlePath: string;
  createdAt: string;
  files: string[];
  summary: DiagnosticsSummary;
}

/** The on-disk evidence kinds a prune plan can target. */
export type PruneItemKind =
  | "evidence-dir"
  | "diagnostics-bundle"
  | "suite-log"
  | "removed-worktree";

/** A planned prune action. */
export type PruneAction = "remove" | "keep";

/** One candidate path in a dry-run prune plan. */
export interface PruneItem {
  kind: PruneItemKind;
  runId: string;
  bareRunId: string;
  path: string;
  sizeBytes: number;
  action: PruneAction;
  reason?: string;
}

/** A run/key that was considered but refused, with the reason. */
export interface PruneRefusal {
  runId?: string;
  bareRunId?: string;
  path?: string;
  status?: string;
  schedulingStatus?: string;
  reason: string;
}

/** Aggregate byte/item totals for a prune plan. */
export interface PruneTotals {
  itemCount: number;
  removeCount: number;
  keepCount: number;
  removeBytes: number;
  keepBytes: number;
  totalBytes: number;
}

/** A dry-run prune plan; executing it is a separate, explicit step. */
export interface PrunePlan {
  olderThanMs: number;
  items: PruneItem[];
  refusals: PruneRefusal[];
  totals: PruneTotals;
}

/** Outcome of executing an approved prune plan (filesystem only). */
export interface PruneExecutionResult {
  removed: PruneItem[];
  skipped: PruneItem[];
  failed: { item: PruneItem; error: string }[];
}