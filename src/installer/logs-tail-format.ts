import { formatInstant } from "../lib/instant.js";
import { type TamanduaEvent } from "./events.js";

const EVENT_LABELS: Record<string, string> = {
  "run.started": "Run started",
  "run.completed": "Run completed",
  "run.failed": "Run failed",
  "run.canceled": "Run canceled",
  "run.nudged": "Run nudged",
  "run.deleted": "Run deleted",
  "run.tokens.updated": "Token spend updated",
  "run.tokens.final": "Token spend finalized",
  "system.tokens.updated": "System token spend updated",
  "step.pending": "Step pending",
  "step.running": "Claimed step",
  "step.done": "Step completed",
  "step.failed": "Step failed",
  "step.timeout": "Step timed out",
  "step.respawned": "Step respawned",
  "step.rerouted": "Step rerouted",
  "step.reroute_budget_exhausted": "Reroute budget exhausted",
  // REROUTE-BUDGET (NPF-3): stale-tip (target_moved) reroutes have their own
  // budget, so their exhaustion gets its own label — operators can tell
  // landing contention from ordinary shared-budget exhaustion at a glance.
  "step.target_moved_reroute_exhausted": "Target-moved reroute budget exhausted",
  "story.started": "Story started",
  "story.done": "Story done",
  "story.verified": "Story verified",
  "story.retry": "Story retry",
  "story.failed": "Story failed",
  "agent.nudged": "Agent nudged",
  "agent.nudge.skipped": "Nudge skipped",
  "pipeline.advanced": "Pipeline advanced",
};

/**
 * The leading time token of a logs-tail line.
 *
 * TIME-OUTPUT US-003: serialize via the shared `formatInstant(..., 'log')`
 * helper so every human log line carries a full date and an explicit `Z`
 * (`YYYY-MM-DD HH:MM:SSZ`, always UTC). The old `toLocaleTimeString` form was
 * host-local and date-less, so two instants in different zones were
 * indistinguishable. A missing/unparseable `ts` renders the stable `?`
 * placeholder and never throws.
 */
export function formatLogsTailTime(ts: string | null | undefined): string {
  return formatInstant(ts, { style: "log" }) ?? "?";
}

export function formatLogsTailLabel(evt: TamanduaEvent): string {
  // TATR US-007: a post-terminal token flush (run DB status already
  // terminal at attribution time) gets a distinct label so operators can
  // tell a late flush from a regular in-run token update at a glance.
  if (evt.event === "run.tokens.updated" && evt.postTerminal === true) {
    return "Token spend updated (post-terminal)";
  }
  // WAVE-B.1: step.rerouted events flag their reroute class (terminal:boolean
  // + rerouteMode). Surface a terminal-CLASS reroute (rerouteMode ===
  // 'terminal' — a FAILURE_CLASS terminal decision or ledger-gate terminal
  // refusal) with a marker so operators can distinguish it from an ordinary
  // expects/retry/orphan reroute, which keeps the plain label.
  if (evt.event === "step.rerouted" && evt.terminal === true) {
    return "Step rerouted (terminal)";
  }
  return EVENT_LABELS[evt.event] ?? evt.event;
}

function formatTokenSpend(evt: TamanduaEvent): string {
  const hasDelta = Number.isFinite(evt.tokenDelta);
  const hasTotal = Number.isFinite(evt.tokensSpent);
  if (!hasDelta && !hasTotal) return "";

  const parts: string[] = [];
  if (hasDelta) {
    const delta = evt.tokenDelta as number;
    parts.push(`Δ ${delta >= 0 ? "+" : ""}${Math.trunc(delta)}`);
  }
  if (hasTotal) {
    const total = evt.tokensSpent as number;
    // F3: run.completed/run.failed carry the run total AS OF the terminal
    // event; the harness's final round usage lands after it and is closing
    // by run.tokens.final. Never present the terminal snapshot as the final
    // total — labeled readers must defer to run.tokens.final or the runs row.
    if (evt.event === "run.completed" || evt.event === "run.failed") {
      parts.push(`total ${Math.trunc(total)} as of completion`);
    } else {
      parts.push(`total ${Math.trunc(total)}`);
    }
  }

  return ` [tokens: ${parts.join(", ")}]`;
}

/**
 * The run/agent/label/story/detail/token portion of a logs-tail line, with NO
 * leading time token.
 *
 * TIME-OUTPUT US-006: the dashboard feeds the browser a raw ISO-Z `ts` plus
 * this body, so the browser (not the server) localizes the instant for the
 * viewer. `formatLogsTailLine` composes the CLI form with the UTC time token.
 */
export function formatLogsTailBody(evt: TamanduaEvent): string {
  const agent = evt.agentId ? `  ${evt.agentId.split("_").slice(-1)[0]}` : "";
  const label = formatLogsTailLabel(evt);
  const story = evt.storyTitle ? ` — ${evt.storyTitle}` : "";
  const detail = evt.detail ? ` (${evt.detail})` : "";
  const tokenSpend = formatTokenSpend(evt);
  const run = evt.runId ? `  [run-${evt.runId.slice(0, 8)}]` : "";
  return `${run}${agent}  ${label}${story}${detail}${tokenSpend}`;
}

export function formatLogsTailLine(evt: TamanduaEvent): string {
  return `${formatLogsTailTime(evt.ts)}${formatLogsTailBody(evt)}`;
}

export function formatLogsTailLines(events: TamanduaEvent[]): string[] {
  return events.map((evt) => formatLogsTailLine(evt));
}
