/**
 * Diagnostics summary and SUMMARY.md builder (DIAG-PRUNE US-009).
 *
 * Turns the raw collector outputs (DB rows, run events, daemon log, evidence
 * listing, session paths, Matchlock evidence) into:
 *
 *  - a plain, JSON-serializable summary object with the run status and
 *    scheduling, ISO-8601 instants, a step/story timeline with retry and
 *    abandonment counts, the force-fail reason and the last failing round's
 *    bounded stderr tail, and
 *  - a SUMMARY.md rendering of the same sections in text form.
 *
 * Contract:
 *
 *  1. READ-ONLY and pure: no file is read or written here and no daemon is
 *     contacted; the caller hands in already-collected parts.
 *  2. TOTAL: a missing collector output, a malformed event, a null payload or
 *     any unexpected field is reported as an explicit `status: 'absent'`
 *     section (with an `absenceReason`), never thrown.
 *  3. NO FABRICATION: the force-fail reason and the failing-round stderr tail
 *     are copied verbatim from the event that carries them. When no event
 *     carries one the section is `'absent'` — a synthetic value is never
 *     invented.
 *  4. BOUNDED: the retained stderr tail is capped (the most recent
 *     {@link MAX_STDERR_TAIL_CHARS} characters) and the truncation is
 *     recorded.
 *  5. INSTANTS are normalized with the time contract's `formatInstant`; a
 *     missing or unparseable instant is omitted, never replaced by "now".
 *
 * This module imports only Node-core plus `src/lib/instant.ts` and the
 * type-only shared shapes, so its test stays in the parallel lane.
 */
import { formatInstant, nowIso } from "../lib/instant.js";
import type {
  DaemonLogCollection,
  DbRowsCollection,
  DiagnosticsSummary,
  DiagnosticsTimelineEntry,
  EvidenceCollection,
  JsonObject,
  MatchlockCollection,
  RunEventRecord,
  RunEventsCollection,
  SessionPathsCollection,
  SourceStatus,
} from "./types.js";

/**
 * The already-collected parts a summary is assembled from. Every field is
 * optional: an omitted collector is reported as an `'absent'` source.
 */
export interface DiagnosticsSummaryParts {
  runId: string;
  bareRunId: string;
  db?: DbRowsCollection;
  events?: RunEventsCollection;
  logs?: DaemonLogCollection;
  evidence?: EvidenceCollection;
  sessions?: SessionPathsCollection;
  matchlock?: MatchlockCollection;
  /** Instant the summary was built; defaults to the current UTC instant. */
  generatedAt?: Date | string | null;
}

/**
 * Run-level events whose `reason`/`detail` explains why a run stopped. The
 * LAST matching event in the stream wins.
 */
export const FORCE_FAIL_EVENTS: readonly string[] = Object.freeze([
  "run.force_failed",
  "run.failed",
  "run.harness_probe_failed",
]);

/**
 * Failing-round events that may carry a harness stderr tail. The last event
 * that actually carries a non-empty tail wins.
 */
export const FAILING_ROUND_EVENTS: readonly string[] = Object.freeze([
  "step.worker_lost",
  "step.preclaim_round_died",
  "step.failed",
]);

/** Upper bound on the stderr tail retained in a summary (bounded forensics). */
export const MAX_STDERR_TAIL_CHARS = 4000;

/** Every collector key tracked in the summary's `sources` map. */
const SOURCE_KEYS = [
  "db",
  "events",
  "logs",
  "evidence",
  "sessions",
  "matchlock",
] as const;

/** A trimmed non-empty string, or `undefined`. */
function asText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() === "" ? undefined : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

/** A finite number, or `undefined`. */
function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** The `event` name of a raw event record, or `undefined`. */
function eventName(event: unknown): string | undefined {
  if (event === null || typeof event !== "object") return undefined;
  return asText((event as Record<string, unknown>).event);
}

/**
 * Copy the first non-empty string among `keys` from an event. Used to read
 * `reason`/`detail`/`stderrTail` without trusting the payload shape.
 */
function eventField(
  event: RunEventRecord,
  keys: readonly string[],
): string | undefined {
  if (event === null || typeof event !== "object") return undefined;
  const record = event as unknown as Record<string, unknown>;
  for (const key of keys) {
    const value = asText(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** The event `ts` normalized to an ISO-Z instant, or `undefined`. */
function eventInstant(event: RunEventRecord): string | undefined {
  if (event === null || typeof event !== "object") return undefined;
  const ts = (event as unknown as Record<string, unknown>).ts;
  return formatInstant(typeof ts === "string" ? ts : undefined);
}

/** A non-empty events array from a collection, or `[]`. */
function safeEvents(events?: RunEventsCollection): RunEventRecord[] {
  const raw = events?.events;
  return Array.isArray(raw) ? raw : [];
}

/** The last event whose name is in `names`, or `undefined`. */
function findLastEvent(
  events: RunEventRecord[],
  names: readonly string[],
): RunEventRecord | undefined {
  let found: RunEventRecord | undefined;
  for (const event of events) {
    const name = eventName(event);
    if (name !== undefined && names.includes(name)) found = event;
  }
  return found;
}

/** Build the run section from the DB rows collection (status-aware). */
function buildRunSection(db?: DbRowsCollection): Record<string, unknown> {
  const row =
    db && Array.isArray(db.runs) && db.runs.length > 0 ? db.runs[0] : undefined;
  if (row === undefined) {
    const status: SourceStatus = db?.status ?? "absent";
    return {
      status,
      absenceReason: db?.absenceReason ?? "no run row collected",
    };
  }
  return {
    status: "present" as SourceStatus,
    runStatus: asText(row.status),
    runNumber: asNumber(row.run_number),
    workflowId: asText(row.workflow_id),
    schedulingStatus: asText(row.scheduling_status),
    schedulingError: asText(row.scheduling_error),
    createdAt: formatInstant(asText(row.created_at)),
    updatedAt: formatInstant(asText(row.updated_at)),
    tokensSpent: asNumber(row.tokens_spent),
    workerLostCount: asNumber(row.worker_lost_count),
    ceilingExpiryCount: asNumber(row.ceiling_expiry_count),
    instantFailCount: asNumber(row.instant_fail_count),
    harnessProbeStatus: asText(row.harness_probe_status),
    matchlockPolicyPresent: row.matchlock_policy_present === true,
  };
}

/** One resolved timeline entry plus its numeric instant for ordering. */
interface ResolvedTimelineEntry {
  entry: DiagnosticsTimelineEntry;
  at: number | undefined;
}

function stepEntry(row: JsonObject): ResolvedTimelineEntry {
  const rawInstant = asText(row.created_at) ?? asText(row.updated_at);
  const at = formatInstant(rawInstant);
  const entry: DiagnosticsTimelineEntry = {
    kind: "step",
    id: asText(row.step_id) ?? asText(row.id) ?? "unknown",
    status: asText(row.status),
    instant: at,
    retries: asNumber(row.retry_count),
    abandonCount: asNumber(row.abandoned_count),
    type: asText(row.type),
    agentId: asText(row.agent_id),
  };
  return { entry, at: parseAt(at) };
}

function storyEntry(row: JsonObject): ResolvedTimelineEntry {
  const rawInstant = asText(row.created_at) ?? asText(row.updated_at);
  const at = formatInstant(rawInstant);
  const entry: DiagnosticsTimelineEntry = {
    kind: "story",
    id: asText(row.story_id) ?? asText(row.id) ?? "unknown",
    title: asText(row.title),
    status: asText(row.status),
    instant: at,
    retries: asNumber(row.retry_count),
    abandonCount: asNumber(row.abandoned_count),
  };
  return { entry, at: parseAt(at) };
}

/** Numeric epoch of an ISO-Z instant for stable chronological ordering. */
function parseAt(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Build the step/story timeline, oldest first. Entries without a parseable
 * instant keep their source order and follow the timestamped ones.
 */
function buildTimeline(db?: DbRowsCollection): {
  status: SourceStatus;
  absenceReason?: string;
  entries: DiagnosticsTimelineEntry[];
} {
  if (db === undefined) {
    return { status: "absent", absenceReason: "db rows not collected", entries: [] };
  }
  const resolved: ResolvedTimelineEntry[] = [];
  const steps = Array.isArray(db.steps) ? db.steps : [];
  const stories = Array.isArray(db.stories) ? db.stories : [];
  for (const row of steps) {
    if (row !== null && typeof row === "object") resolved.push(stepEntry(row));
  }
  for (const row of stories) {
    if (row !== null && typeof row === "object") resolved.push(storyEntry(row));
  }
  resolved.sort((a, b) => {
    if (a.at === undefined && b.at === undefined) return 0;
    if (a.at === undefined) return 1;
    if (b.at === undefined) return -1;
    return a.at - b.at;
  });
  const entries = resolved.map((item) => item.entry);
  if (entries.length === 0) {
    return {
      status: "empty",
      absenceReason: "no step or story rows for the run",
      entries,
    };
  }
  return { status: "present", entries };
}

/** Extract the last force-fail reason from the run's event stream. */
function buildForceFail(
  events: RunEventRecord[],
  collection?: RunEventsCollection,
): DiagnosticsSummary["forceFail"] {
  const event = findLastEvent(events, FORCE_FAIL_EVENTS);
  if (event === undefined) {
    const reason =
      collection === undefined
        ? "run events not collected"
        : `no ${FORCE_FAIL_EVENTS.join(" / ")} event in ${events.length} run event(s)`;
    return { status: "absent", absenceReason: reason };
  }
  const text = eventField(event, ["reason", "detail"]);
  if (text === undefined) {
    return {
      status: "absent",
      absenceReason: `${eventName(event) ?? "event"} carried no reason/detail`,
      event: eventName(event),
      instant: eventInstant(event),
    };
  }
  return {
    status: "present",
    event: eventName(event),
    reason: text,
    instant: eventInstant(event),
    stepId: eventField(event, ["stepId"]),
  };
}

/** Extract the last failing round's bounded harness stderr tail. */
function buildLastFailingRound(
  events: RunEventRecord[],
  collection?: RunEventsCollection,
): DiagnosticsSummary["lastFailingRound"] {
  let found: { event: RunEventRecord; tail: string } | undefined;
  for (const event of events) {
    const name = eventName(event);
    if (name === undefined || !FAILING_ROUND_EVENTS.includes(name)) continue;
    const tail = eventField(event, ["stderrTail"]);
    if (tail !== undefined) found = { event, tail };
  }
  if (found === undefined) {
    const reason =
      collection === undefined
        ? "run events not collected"
        : `no non-empty stderrTail on ${FAILING_ROUND_EVENTS.join(" / ")} in ${events.length} run event(s)`;
    return { status: "absent", absenceReason: reason };
  }
  const { text, truncated } = boundTail(found.tail);
  return {
    status: "present",
    event: eventName(found.event),
    stepId: eventField(found.event, ["stepId"]),
    instant: eventInstant(found.event),
    exitCode: asNumber(
      (found.event as unknown as Record<string, unknown>).exitCode,
    ),
    signal: eventField(found.event, ["signal"]),
    stderrTail: text,
    tailChars: text.length,
    truncated,
  };
}

/** Bound a stderr tail to the most recent {@link MAX_STDERR_TAIL_CHARS}. */
function boundTail(tail: string): { text: string; truncated: boolean } {
  if (tail.length <= MAX_STDERR_TAIL_CHARS) return { text: tail, truncated: false };
  return { text: tail.slice(tail.length - MAX_STDERR_TAIL_CHARS), truncated: true };
}

/** A status-carrying section with an optional absence reason. */
function section(
  status: SourceStatus,
  absenceReason: string | undefined,
  extra: JsonObject = {},
): Record<string, unknown> {
  return {
    status,
    ...(absenceReason !== undefined ? { absenceReason } : {}),
    ...extra,
  };
}

/** Build every non-run source section with its explicit status. */
function buildSourceSections(parts: DiagnosticsSummaryParts): {
  logs: Record<string, unknown>;
  evidence: Record<string, unknown>;
  sessions: Record<string, unknown>;
  matchlock: Record<string, unknown>;
} {
  const logs = parts.logs;
  const evidence = parts.evidence;
  const sessions = parts.sessions;
  const matchlock = parts.matchlock;

  return {
    logs: section(
      logs?.status ?? "absent",
      logs?.absenceReason ?? (logs === undefined ? "daemon log not collected" : undefined),
      {
        files: Array.isArray(logs?.files) ? logs!.files.length : 0,
        entries: Array.isArray(logs?.entries) ? logs!.entries.length : 0,
        truncated: logs?.truncated === true,
      },
    ),
    evidence: section(
      evidence?.status ?? "absent",
      evidence?.absenceReason ??
        (evidence === undefined ? "evidence not collected" : undefined),
      {
        evidenceDir: evidence?.evidenceDir,
        entries: Array.isArray(evidence?.entries) ? evidence!.entries.length : 0,
        totalBytes: asNumber(evidence?.totalBytes) ?? 0,
        suiteLedger: Array.isArray(evidence?.suiteLedger)
          ? evidence!.suiteLedger.length
          : 0,
        suiteLedgerStatus: evidence?.suiteLedgerStatus ?? "absent",
      },
    ),
    sessions: section(
      sessions?.status ?? "absent",
      sessions === undefined ? "session paths not collected" : undefined,
      {
        workdir: sessions?.workdir,
        entries: Array.isArray(sessions?.entries) ? sessions!.entries.length : 0,
      },
    ),
    matchlock: section(
      matchlock?.status ?? "absent",
      matchlock?.absenceReason ??
        (matchlock === undefined ? "matchlock evidence not collected" : undefined),
      {
        policyStatus: matchlock?.policyStatus ?? "absent",
        vms: Array.isArray(matchlock?.vms) ? matchlock!.vms.length : 0,
        consoleLogs: Array.isArray(matchlock?.consoleLogs)
          ? matchlock!.consoleLogs.length
          : 0,
        errorRecords: Array.isArray(matchlock?.errorRecords)
          ? matchlock!.errorRecords.length
          : 0,
      },
    ),
  };
}

/** Aggregate the per-collector statuses into the summary's source map. */
function buildSources(
  parts: DiagnosticsSummaryParts,
): Record<string, SourceStatus> {
  const statuses: Record<string, SourceStatus> = {};
  const provided: Record<(typeof SOURCE_KEYS)[number], SourceStatus | undefined> = {
    db: parts.db?.status,
    events: parts.events?.status,
    logs: parts.logs?.status,
    evidence: parts.evidence?.status,
    sessions: parts.sessions?.status,
    matchlock: parts.matchlock?.status,
  };
  for (const key of SOURCE_KEYS) statuses[key] = provided[key] ?? "absent";
  return statuses;
}

/** Summarize the retry/abandonment counters already present in the timeline. */
function buildRetries(entries: DiagnosticsTimelineEntry[]): JsonObject[] {
  const retries: JsonObject[] = [];
  for (const entry of entries) {
    const retryCount = asNumber(entry.retries) ?? 0;
    const abandonCount = asNumber(entry.abandonCount) ?? 0;
    if (retryCount === 0 && abandonCount === 0) continue;
    retries.push({
      kind: entry.kind,
      id: entry.id,
      ...(entry.title !== undefined ? { title: entry.title } : {}),
      status: entry.status,
      instant: entry.instant,
      retries: retryCount,
      abandonCount,
    });
  }
  return retries;
}

/**
 * Assemble the diagnostics summary from the already-collected parts. Never
 * throws: every missing or malformed input becomes an explicit `'absent'`
 * section.
 */
export function buildDiagnosticsSummary(
  parts: DiagnosticsSummaryParts,
): DiagnosticsSummary {
  const runId = asText(parts.runId) ?? "";
  const bareRunId = asText(parts.bareRunId) ?? "";
  const generatedAt = formatInstant(parts.generatedAt ?? nowIso()) ?? nowIso();

  const run = buildRunSection(parts.db);
  const timeline = buildTimeline(parts.db);
  const events = safeEvents(parts.events);
  const forceFail = buildForceFail(events, parts.events);
  const lastFailingRound = buildLastFailingRound(events, parts.events);
  const sourceSections = buildSourceSections(parts);

  const runStatus = asText(run.runStatus) ?? "absent";

  return {
    runId,
    bareRunId,
    status: runStatus,
    schedulingStatus: asText(run.schedulingStatus),
    workflowId: asText(run.workflowId),
    createdAt: asText(run.createdAt),
    updatedAt: asText(run.updatedAt),
    generatedAt,
    run: run as DiagnosticsSummary["run"],
    timeline: timeline.entries,
    timelineStatus: timeline.status,
    retries: buildRetries(timeline.entries),
    forceFail,
    lastFailingRound,
    logs: sourceSections.logs as DiagnosticsSummary["logs"],
    evidence: sourceSections.evidence as DiagnosticsSummary["evidence"],
    sessions: sourceSections.sessions as DiagnosticsSummary["sessions"],
    matchlock: sourceSections.matchlock as DiagnosticsSummary["matchlock"],
    sources: buildSources(parts),
  };
}

/** Render one timeline entry as a plain markdown bullet. */
function renderTimelineEntry(entry: DiagnosticsTimelineEntry): string {
  const parts: string[] = [`- ${entry.kind} \`${entry.id}\``];
  if (entry.title !== undefined) parts.push(`(${entry.title})`);
  if (entry.status !== undefined) parts.push(`status=${entry.status}`);
  if (entry.retries !== undefined) parts.push(`retries=${entry.retries}`);
  if (entry.abandonCount !== undefined) {
    parts.push(`abandon=${entry.abandonCount}`);
  }
  if (entry.instant !== undefined) parts.push(`at=${entry.instant}`);
  return parts.join(" ");
}

/** Render one status-carrying section header/line; never throws. */
function renderSectionStatus(
  lines: string[],
  section: DiagnosticsSourceNoteLike | undefined,
  label: string,
): void {
  const status = section?.status ?? "absent";
  lines.push(`${label} status: ${status}`);
  if (section?.absenceReason !== undefined) {
    lines.push(`${label} note: ${section.absenceReason}`);
  }
}

/** Loosely-typed section view for the markdown renderer. */
interface DiagnosticsSourceNoteLike {
  status?: SourceStatus;
  absenceReason?: string;
  [key: string]: unknown;
}

function asRecord(value: unknown): DiagnosticsSourceNoteLike | undefined {
  return value !== null && typeof value === "object"
    ? (value as DiagnosticsSourceNoteLike)
    : undefined;
}

/**
 * Render a SUMMARY.md document from a summary produced by
 * {@link buildDiagnosticsSummary}. Never throws on malformed or missing
 * fields: absent sections are printed explicitly.
 */
export function renderSummaryMarkdown(summary: DiagnosticsSummary): string {
  const lines: string[] = [];
  const source = asRecord(summary) ?? {};

  lines.push("# Diagnostics summary");
  lines.push("");
  lines.push(`Run: ${asText(source.runId) ?? "unknown"}`);
  const bare = asText(source.bareRunId);
  if (bare !== undefined) lines.push(`Bare run id: ${bare}`);
  lines.push(`Generated: ${asText(source.generatedAt) ?? "absent"}`);
  lines.push("");

  lines.push("## Run");
  const run = asRecord(source.run);
  lines.push(`Run status: ${asText(run?.runStatus) ?? asText(source.status) ?? "absent"}`);
  renderSectionStatus(lines, run, "Run");
  if (run?.schedulingStatus !== undefined) {
    lines.push(`Scheduling: ${String(run.schedulingStatus)}`);
  }
  if (run?.schedulingError !== undefined) {
    lines.push(`Scheduling error: ${String(run.schedulingError)}`);
  }
  if (run?.workflowId !== undefined) {
    lines.push(`Workflow: ${String(run.workflowId)}`);
  }
  if (run?.runNumber !== undefined) {
    lines.push(`Run number: ${String(run.runNumber)}`);
  }
  if (run?.createdAt !== undefined) {
    lines.push(`Created: ${String(run.createdAt)}`);
  }
  if (run?.updatedAt !== undefined) {
    lines.push(`Updated: ${String(run.updatedAt)}`);
  }
  if (run?.tokensSpent !== undefined) {
    lines.push(`Tokens spent: ${String(run.tokensSpent)}`);
  }
  if (run?.workerLostCount !== undefined) {
    lines.push(`Worker lost count: ${String(run.workerLostCount)}`);
  }
  if (run?.ceilingExpiryCount !== undefined) {
    lines.push(`Ceiling expiry count: ${String(run.ceilingExpiryCount)}`);
  }
  if (run?.instantFailCount !== undefined) {
    lines.push(`Instant fail count: ${String(run.instantFailCount)}`);
  }
  if (run?.matchlockPolicyPresent !== undefined) {
    lines.push(`Matchlock policy present: ${String(run.matchlockPolicyPresent)}`);
  }
  lines.push("");

  lines.push("## Step and story timeline");
  lines.push(`Timeline status: ${asText(source.timelineStatus) ?? "absent"}`);
  const timeline = Array.isArray(source.timeline) ? source.timeline : [];
  if (timeline.length === 0) {
    lines.push("- (no step or story entries)");
  } else {
    for (const entry of timeline) {
      const record = asRecord(entry);
      if (record === undefined) {
        lines.push("- (malformed timeline entry)");
        continue;
      }
      lines.push(renderTimelineEntry(record as unknown as DiagnosticsTimelineEntry));
    }
  }
  lines.push("");

  lines.push("## Retries and abandonments");
  const retries = Array.isArray(source.retries) ? source.retries : [];
  if (retries.length === 0) {
    lines.push("- (none)");
  } else {
    for (const retry of retries) {
      const record = asRecord(retry);
      if (record === undefined) continue;
      lines.push(
        `- ${String(record.kind ?? "?")} \`${String(record.id ?? "?")}\` retries=${String(
          record.retries ?? 0,
        )} abandon=${String(record.abandonCount ?? 0)}`,
      );
    }
  }
  lines.push("");

  lines.push("## Force-fail reason");
  const forceFail = asRecord(source.forceFail);
  renderSectionStatus(lines, forceFail, "Force-fail");
  if (forceFail?.event !== undefined) lines.push(`Event: ${String(forceFail.event)}`);
  if (forceFail?.instant !== undefined) {
    lines.push(`Instant: ${String(forceFail.instant)}`);
  }
  if (forceFail?.reason !== undefined) {
    lines.push(`Reason: ${String(forceFail.reason)}`);
  }
  lines.push("");

  lines.push("## Last failing round stderr tail");
  const lastFailing = asRecord(source.lastFailingRound);
  renderSectionStatus(lines, lastFailing, "Last failing round");
  if (lastFailing?.event !== undefined) {
    lines.push(`Event: ${String(lastFailing.event)}`);
  }
  if (lastFailing?.stepId !== undefined) {
    lines.push(`Step: ${String(lastFailing.stepId)}`);
  }
  if (lastFailing?.instant !== undefined) {
    lines.push(`Instant: ${String(lastFailing.instant)}`);
  }
  if (lastFailing?.truncated !== undefined) {
    lines.push(`Truncated: ${String(lastFailing.truncated)}`);
  }
  if (lastFailing?.stderrTail !== undefined) {
    lines.push("");
    lines.push("```");
    lines.push(String(lastFailing.stderrTail));
    lines.push("```");
  }
  lines.push("");

  lines.push("## Source status");
  const sources = asRecord(source.sources);
  if (sources === undefined) {
    lines.push("- (source map absent)");
  } else {
    for (const key of SOURCE_KEYS) {
      lines.push(`- ${key}: ${String(sources[key] ?? "absent")}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}