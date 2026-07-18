/**
 * Activity event listing and streaming commands.
 *
 * Extracted mechanically from src/cli/cli.ts (SPL2 story US-009).
 */

import { setTimeout as delay } from "node:timers/promises";

import {
  getRecentEvents,
  getRunEvents,
  readEventsFromCursor,
  type EventCursorSource,
  type TamanduaEvent,
} from "../../installer/events.js";
import { formatLogsTailLines } from "../../installer/logs-tail-format.js";
import { getWorkflowStatus } from "../../installer/status.js";
import { lookupRunIdByNumber, parseLogsSelector } from "../logs-selector.js";

function printEvents(events: TamanduaEvent[]): void {
  if (events.length === 0) { console.log("No events yet."); return; }
  for (const line of formatLogsTailLines(events)) {
    console.log(line);
  }
}

function getLogsTailPollIntervalMs(): number {
  const raw = parseInt(process.env.TAMANDUA_LOGS_TAIL_POLL_MS ?? "1000", 10);
  if (Number.isNaN(raw)) return 1000;
  return Math.max(10, raw);
}

async function streamEventSource(source: EventCursorSource, initialLimit: number): Promise<void> {
  const initial = readEventsFromCursor(source, 0);
  const firstBatch = initial.events.slice(-Math.max(1, initialLimit));
  if (firstBatch.length === 0) console.log("No events yet.");
  else printEvents(firstBatch);

  let cursor = initial.nextOffset;
  let generation = initial.generation;
  const abort = new AbortController();
  const pollIntervalMs = getLogsTailPollIntervalMs();
  const onSigint = () => abort.abort();

  process.on("SIGINT", onSigint);
  try {
    while (!abort.signal.aborted) {
      try {
        await delay(pollIntervalMs, undefined, { signal: abort.signal });
      } catch (err) {
        if ((err as Error).name === "AbortError") break;
        throw err;
      }
      if (abort.signal.aborted) break;

      const next = readEventsFromCursor(source, cursor, generation);
      cursor = next.nextOffset;
      generation = next.generation;
      if (next.events.length > 0) printEvents(next.events);
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

export function getLogsHelp(): string {
  return `tamandua logs — Show recent activity events

Usage: tamandua logs [<selector>] [--tail <N>]

Shows the most recent Tamandua activity events (runs, steps, agent activity).
The optional selector determines which events to show.

Selector syntax:
  <run-id>      Show events for a specific run (prefix match supported)
  #<N>          Show events for run number N
  <N>           Show the last N events globally (e.g. 20 for last 20)
  (no arg)      Show the last 50 events globally

Options:
  --tail <N>    Follow events in real-time (like logs-tail), starting with
                the last N events. With a run-id, follows that run's events.
                Without a run-id, follows global events.

If a run-id prefix matches no run in the database but has an events file on
disk (events can be written before the run row is committed), the logs output
will still show those events.

Examples:
  tamandua logs                   # Show last 50 global events
  tamandua logs 20                # Show last 20 global events
  tamandua logs abc123            # Show events for run starting with abc123
  tamandua logs #3                # Show events for run #3
  tamandua logs --tail 30         # Follow global events, starting with last 30
  tamandua logs abc123 --tail 20  # Follow run abc123 events, starting with last 20`;
}

export function getLogsTailHelp(): string {
  return `tamandua logs-tail — Follow activity events in real-time

Usage: tamandua logs-tail [<selector>]

Follows Tamandua activity events in real-time, polling for new events and
printing them as they arrive. Press Ctrl-C (SIGINT) to stop following.

The selector uses the same syntax as tamandua logs:
  <run-id>      Follow events for a specific run (prefix match supported)
  #<N>          Follow events for run number N
  <N>           Follow global events, showing the last N first
  (no arg)      Follow global events, showing the last 50 first

The polling interval defaults to 1000ms and can be configured via the
TAMANDUA_LOGS_TAIL_POLL_MS environment variable (minimum 10ms).

Examples:
  tamandua logs-tail              # Follow global events in real-time
  tamandua logs-tail 20           # Follow global events, starting with last 20
  tamandua logs-tail abc123       # Follow events for run starting with abc123
  tamandua logs-tail #3           # Follow events for run #3`;
}

/** Handle logs and logs-tail commands. Returns false for unrelated command groups. */
export async function handleLogs(group: string, args: string[]): Promise<boolean> {
  if (group === "logs") {
    // Pre-process args: extract --tail, reject unknown flags, detect "tail" literal.
    let tailLimit: number | undefined;
    const positionalArgs: string[] = [];

    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--tail") {
        if (i + 1 < args.length && /^\d+$/.test(args[i + 1])) {
          tailLimit = parseInt(args[i + 1], 10);
          i++; // consume the number
        } else {
          process.stderr.write(`Unknown option "${arg}" for tamandua logs. Run tamandua logs --help for available options.\n`);
          process.exit(1);
        }
      } else if (arg.startsWith("--tail=")) {
        const val = arg.slice("--tail=".length);
        if (/^\d+$/.test(val)) {
          tailLimit = parseInt(val, 10);
        } else {
          process.stderr.write(`Unknown option "${arg}" for tamandua logs. Run tamandua logs --help for available options.\n`);
          process.exit(1);
        }
      } else if (arg.startsWith("--")) {
        process.stderr.write(`Unknown option "${arg}" for tamandua logs. Run tamandua logs --help for available options.\n`);
        process.exit(1);
      } else {
        positionalArgs.push(arg);
      }
    }

    // Check if first positional arg is the literal "tail"
    if (positionalArgs.length > 0 && positionalArgs[0] === "tail") {
      process.stderr.write("Did you mean: tamandua logs-tail?\n");
      process.exit(1);
    }

    const selector = parseLogsSelector(positionalArgs.length > 0 ? positionalArgs[0] : undefined);

    // --tail mode: follow events in real-time (same behavior as logs-tail)
    if (tailLimit !== undefined) {
      if (selector.kind === "global-recent" || selector.kind === "global-limit") {
        await streamEventSource({ kind: "global" }, tailLimit);
        return true;
      }

      if (selector.kind === "run-number") {
        const runId = lookupRunIdByNumber(selector.runNumber);
        if (!runId) {
          console.log(`No run #${selector.runNumber}.`);
          return true;
        }
        await streamEventSource({ kind: "run", runId }, tailLimit);
        return true;
      }

      let runId: string;
      try {
        runId = getWorkflowStatus(selector.runId).id;
      } catch (err) {
        console.log(err instanceof Error ? err.message : `No run found matching "${selector.runId}".`);
        return true;
      }
      await streamEventSource({ kind: "run", runId }, tailLimit);
      return true;
    }

    // Non-tail mode: show recent events statically
    if (selector.kind === "global-recent" || selector.kind === "global-limit") {
      printEvents(getRecentEvents(selector.limit));
      return true;
    }

    if (selector.kind === "run-number") {
      const runId = lookupRunIdByNumber(selector.runNumber);
      if (runId) {
        const events = getRunEvents(runId);
        events.length === 0 ? console.log(`No events for run #${selector.runNumber}.`) : printEvents(events);
        return true;
      }

      const fallbackEvents = getRunEvents(selector.raw);
      fallbackEvents.length === 0 ? console.log(`No run #${selector.runNumber}.`) : printEvents(fallbackEvents);
      return true;
    }

    let runId: string;
    try {
      runId = getWorkflowStatus(selector.runId).id;
    } catch (err) {
      console.log(err instanceof Error ? err.message : `No run found matching "${selector.runId}".`);
      return true;
    }
    const events = getRunEvents(runId);
    events.length === 0 ? console.log(`No events for run "${selector.runId}".`) : printEvents(events);
    return true;
  }

  if (group === "logs-tail") {
    const selector = parseLogsSelector(args[1]);

    if (selector.kind === "global-recent" || selector.kind === "global-limit") {
      await streamEventSource({ kind: "global" }, selector.limit);
      return true;
    }

    if (selector.kind === "run-number") {
      const runId = lookupRunIdByNumber(selector.runNumber);
      if (!runId) {
        console.log(`No run #${selector.runNumber}.`);
        return true;
      }
      await streamEventSource({ kind: "run", runId }, 50);
      return true;
    }

    let logsTailRunId: string;
    try {
      logsTailRunId = getWorkflowStatus(selector.runId).id;
    } catch (err) {
      const message = err instanceof Error ? err.message : `No run found matching "${selector.runId}".`;
      // The DB row may lag behind the events file in early bootstrap (events
      // can be written before the run row is committed). If the literal runId
      // already has an events file on disk, tail it; otherwise fall through
      // to the not-found message so unknown prefixes don't hang forever.
      if (message.startsWith("No run found matching")) {
        const { getEventsPath } = await import("../../installer/events.js");
        const fsMod = await import("node:fs");
        const pathMod = await import("node:path");
        const eventsFile = pathMod.join(getEventsPath(), `${selector.runId}.jsonl`);
        if (fsMod.existsSync(eventsFile)) {
          await streamEventSource({ kind: "run", runId: selector.runId }, 50);
          return true;
        }
      }
      console.log(message);
      return true;
    }
    await streamEventSource({ kind: "run", runId: logsTailRunId }, 50);
    return true;
  }

  return false;
}
