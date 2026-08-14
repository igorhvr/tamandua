import { type TamanduaEvent } from "./events.js";

const EVENT_LABELS: Record<string, string> = {
  "run.started": "Run started",
  "run.completed": "Run completed",
  "run.failed": "Run failed",
  "run.canceled": "Run canceled",
  "run.nudged": "Run nudged",
  "run.deleted": "Run deleted",
  "run.tokens.updated": "Token spend updated",
  "system.tokens.updated": "System token spend updated",
  "step.pending": "Step pending",
  "step.running": "Claimed step",
  "step.done": "Step completed",
  "step.failed": "Step failed",
  "step.timeout": "Step timed out",
  "story.started": "Story started",
  "story.done": "Story done",
  "story.verified": "Story verified",
  "story.retry": "Story retry",
  "story.failed": "Story failed",
  "agent.nudged": "Agent nudged",
  "agent.nudge.skipped": "Nudge skipped",
  "pipeline.advanced": "Pipeline advanced",
};

export function formatLogsTailTime(ts: string): string {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

export function formatLogsTailLabel(evt: TamanduaEvent): string {
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
    parts.push(`total ${Math.trunc(total)}`);
  }

  return ` [tokens: ${parts.join(", ")}]`;
}

export function formatLogsTailLine(evt: TamanduaEvent): string {
  const time = formatLogsTailTime(evt.ts);
  const agent = evt.agentId ? `  ${evt.agentId.split("_").slice(-1)[0]}` : "";
  const label = formatLogsTailLabel(evt);
  const story = evt.storyTitle ? ` — ${evt.storyTitle}` : "";
  const detail = evt.detail ? ` (${evt.detail})` : "";
  const tokenSpend = formatTokenSpend(evt);
  const run = evt.runId ? `  [run-${evt.runId.slice(0, 8)}]` : "";
  return `${time}${run}${agent}  ${label}${story}${detail}${tokenSpend}`;
}

export function formatLogsTailLines(events: TamanduaEvent[]): string[] {
  return events.map((evt) => formatLogsTailLine(evt));
}
