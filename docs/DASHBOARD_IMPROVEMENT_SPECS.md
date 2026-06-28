# Dashboard UX Improvements — Spec v2 (Architecture-Reviewed)

**Branch:** `feat+dashboard-improvements`
**Base:** `4ff2b6a` (main after prisma-server-migration merge)
**Source:** `docs/DASHBOARD_UX_REVIEW.md`
**Date:** 2026-06-28

---

## v1 → v2 Audit Summary

Problems found in v1 spec and fixed:

| Issue | v1 Spec | v2 Fix |
|-------|---------|--------|
| **Duplicated agent mappings** | `AGENT_PHASE` in ExperimentBoard, `AGENT_STEP_MAP` in pipeline-status, `AGENT_INFO_REGISTRY` in dashboard-types — 3 sources of truth | Single `AGENT_INFO_REGISTRY` as source of truth. Derive step_id, phase, label from it. Delete `AGENT_PHASE` and `AGENT_STEP_MAP` |
| **Duplicated formatElapsed** | Two different signatures in CommandCenter and PipelineStepper | Single `formatElapsed()` in `lib/format.ts`, consumed by both |
| **StatusBadge flag-driven props** | `showEmoji` + `showLabel` booleans = 4 combinations of implicit behavior | Composition via `children` render prop. Default renders emoji+label. Consumer overrides with custom children |
| **HumanStatus weak types** | `label: string` — no type safety, can pass arbitrary strings | `HumanStatusLabel` union literal type. `getHumanStatus()` returns discriminated union |
| **StatusCard monolithic** | Receives `HumanStatus` + derives display = mixes presentation and derivation logic | `StatusCard` is pure presentational. Derivation happens in `useHumanStatus()` hook that composes `getHumanStatus()` + pipeline data |
| **Toast over-engineered** | `ToastProvider` + `useToast()` + `ToastContainer` — context API for what's essentially a global stack | `ToastContainer` component + `addToast()` imperative function (singleton ref). No provider needed. Screens call `addToast()` directly |
| **AgentNavDropdown inline** | 40-line function inside App.tsx, `onMouseLeave` to close = broken on touch/keyboard | Extract to `components/AgentNavDropdown.tsx`. Use `useClickOutside` + `Escape` key + `onMouseLeave` layered closing |
| **Breadcrumb new component** | Re-implements route-to-label mapping that already exists in NAV_ITEMS | Derive from existing `NAV_ITEMS` config + `useLocation()`. No new mapping tables |
| **ActivityFeed new endpoint** | Proposes `GET /api/activity` — creates new backend route for data that already exists via `GET /api/agents/:name/logs` | Reuse `useAgentLogs()` for the currently-running agent. Merge last 5 log entries from all agents into `ActivityFeed` client-side. No new endpoint |
| **Hardcoded emoji in components** | Emoji strings like `"⚪"`, `"🔵"` scattered in JSX | All emoji live in the `STATUS_CONFIG` lookup table. Components never hardcode emoji |
| **Vanilla CSS classes per status** | `opacity-60`, `border-[var(--accent-blue)]` etc repeated per status in multiple places | `STATUS_CONFIG` maps each status to a Tailwind class group. Single source, consumed everywhere |
| **Duplicated spec-action logic** | `dispatchDecision` in CommandCenter and `dispatch` in ExperimentBoard are near-identical | Extract `useSpecDispatch()` hook that returns `{ approve, reject }` mutations with toast callbacks built in |

---

## New File Structure

```
src/dashboard/src/
├── lib/                              # NEW — pure logic, no React
│   ├── format.ts                     # formatElapsed, formatTimestamp
│   ├── format.test.ts
│   ├── status-config.ts              # STATUS_CONFIG lookup table (emoji, color, label, classes)
│   ├── status-config.test.ts
│   ├── human-status.ts               # getHumanStatus() pure function
│   └── human-status.test.ts
├── hooks/                             # NEW — composable React hooks
│   ├── useHumanStatus.ts             # compose getHumanStatus + pipeline data
│   ├── useSpecDispatch.ts            # approve/reject mutations with toast
│   └── useClickOutside.ts            # reusable click-outside detection
├── api/
│   └── api.ts                        # unchanged, add useRunningAgentLogs
├── screens/
│   ├── CommandCenter.tsx             # simplified, uses hooks + lib
│   ├── ExperimentBoard.tsx           # simplified, uses hooks + lib
│   ├── Leaderboard.tsx               # simplified
│   └── AgentDetail.tsx               # simplified
├── components/
│   ├── StatusBadge.tsx               # rewritten — composition-based
│   ├── StatusCard.tsx                # NEW — pure presentational
│   ├── PipelineStepper.tsx           # enhanced, consumes STATUS_CONFIG
│   ├── EmptyState.tsx                # NEW — reusable empty state
│   ├── AgentNavDropdown.tsx          # NEW — accessible dropdown
│   ├── ActivityFeed.tsx              # NEW — client-side merged logs
│   ├── Toast.tsx                     # NEW — imperative toast stack
│   ├── Breadcrumb.tsx                # NEW — derived from NAV_ITEMS
│   ├── ActionBar.tsx                 # unchanged
│   ├── TraceTimeline.tsx             # unchanged
│   ├── Sparkline.tsx                 # unchanged
│   ├── InteractiveChecklist.tsx      # unchanged
│   ├── ComparePanel.tsx             # unchanged
│   └── SpecDiffViewer.tsx           # unchanged
├── App.tsx                           # refactored header
├── main.tsx                          # add ToastContainer
└── index.css                         # add status CSS vars, remove .status-dot classes
```

```
src/shared/
└── dashboard-types.ts                # remove AGENT_PHASE/AGENT_STEP_MAP from ExperimentBoard + pipeline-status,
                                       # add AgentPhaseInfo to AGENT_INFO_REGISTRY entries
```

---

## Group A — Status Foundation Layer

**Goal:** Single source of truth for all status display. Eliminates hardcoded dots, duplicated formatters, and contradictory states.

**Parallel with:** B, C, D (A merges first; B/C/D consume A's exports but don't share files)

### A1. STATUS_CONFIG — Single Source of Truth

**Problem:** Status metadata (color, emoji, label, CSS classes) is scattered across `StatusBadge.tsx`, `index.css`, `PipelineStepper.tsx`, `CommandCenter.tsx`, `AgentDetail.tsx`. Every new status requires touching 5+ files.

**Files:**
- `src/dashboard/src/lib/status-config.ts` (NEW)
- `src/dashboard/src/lib/status-config.test.ts` (NEW)
- `src/dashboard/src/index.css` (modify — add CSS vars, remove `.status-dot` classes)
- `src/shared/dashboard-types.ts` (modify — add phase info to `AgentInfo`)

**Spec:**

Create a config-driven lookup table. Every status in the system has exactly one entry here.

```ts
// status-config.ts

import type { AgentStatus, BadgeStatus } from "@shared/dashboard-types";

export type UIStatus = AgentStatus | "pending" | "approved" | "rejected" | "promoted" | "overfitted" | "success";

export interface StatusConfig {
  /** Machine-readable key — matches backend status value */
  key: UIStatus;
  /** Display label — human-friendly, uppercase */
  label: string;
  /** Emoji for icon representation */
  emoji: string;
  /** CSS variable name for color (without var()) */
  colorVar: string;
  /** Hex fallback — only used where CSS vars aren't available (e.g. ECharts) */
  hex: string;
  /** Tailwind classes for the status dot */
  dotClass: string;
  /** Tailwind classes for the card/badge border */
  borderClass: string;
  /** Tailwind classes for background tint (5-10% opacity) */
  bgClass: string;
  /** Visual weight — used for ordering and prominence */
  priority: number;
  /** Whether this status demands immediate user attention */
  isUrgent: boolean;
}

// Every status in the system — single source of truth
export const STATUS_CONFIG: Record<UIStatus, StatusConfig> = {
  idle:        { key: "idle",        label: "PENDING",  emoji: "⚪", colorVar: "--status-idle",        hex: "#6e7681", dotClass: "bg-[var(--status-idle)]",        borderClass: "border-[var(--status-idle)]",        bgClass: "bg-[var(--status-idle)]/5",        priority: 0, isUrgent: false },
  pending:     { key: "pending",     label: "PENDING",  emoji: "⚪", colorVar: "--status-pending",     hex: "#6e7681", dotClass: "bg-[var(--status-pending)]",     borderClass: "border-[var(--status-pending)]",     bgClass: "bg-[var(--status-pending)]/5",     priority: 0, isUrgent: false },
  running:    { key: "running",    label: "RUNNING",  emoji: "🔵", colorVar: "--status-running",      hex: "#0969da", dotClass: "bg-[var(--status-running)]",    borderClass: "border-[var(--status-running)]",    bgClass: "bg-[var(--status-running)]/10",    priority: 1, isUrgent: false },
  completed:  { key: "completed",  label: "DONE",     emoji: "✅", colorVar: "--status-completed",    hex: "#1a7f37", dotClass: "bg-[var(--status-completed)]",  borderClass: "border-[var(--status-completed)]",  bgClass: "bg-[var(--status-completed)]/5",  priority: 2, isUrgent: false },
  failed:     { key: "failed",     label: "FAILED",   emoji: "❌", colorVar: "--status-failed",       hex: "#da3633", dotClass: "bg-[var(--status-failed)]",     borderClass: "border-[var(--status-failed)]",     bgClass: "bg-[var(--status-failed)]/10",     priority: 3, isUrgent: true  },
  timed_out:  { key: "timed_out",  label: "TIMED OUT",emoji: "⏱️", colorVar: "--accent-orange",       hex: "#d29922", dotClass: "bg-[var(--accent-orange)]",      borderClass: "border-[var(--accent-orange)]",      bgClass: "bg-[var(--accent-orange)]/10",      priority: 3, isUrgent: true  },
  approved:   { key: "approved",   label: "APPROVED", emoji: "✅", colorVar: "--accent-green",        hex: "#3fb950", dotClass: "bg-[var(--accent-green)]",       borderClass: "border-[var(--accent-green)]",       bgClass: "bg-[var(--accent-green)]/5",       priority: 2, isUrgent: false },
  rejected:   { key: "rejected",   label: "REJECTED", emoji: "🚫", colorVar: "--accent-red",          hex: "#f85149", dotClass: "bg-[var(--accent-red)]",         borderClass: "border-[var(--accent-red)]",         bgClass: "bg-[var(--accent-red)]/5",         priority: 3, isUrgent: true  },
  promoted:   { key: "promoted",   label: "PROMOTED", emoji: "⬆️", colorVar: "--accent-green",        hex: "#3fb950", dotClass: "bg-[var(--accent-green)]",       borderClass: "border-[var(--accent-green)]",       bgClass: "bg-[var(--accent-green)]/5",       priority: 2, isUrgent: false },
  overfitted: { key: "overfitted", label: "OVERFITTED",emoji: "⚠️", colorVar: "--accent-orange",      hex: "#d29922", dotClass: "bg-[var(--accent-orange)]",      borderClass: "border-[var(--accent-orange)]",      bgClass: "bg-[var(--accent-orange)]/10",      priority: 3, isUrgent: true  },
  success:    { key: "success",    label: "SUCCESS",  emoji: "✅", colorVar: "--accent-green",        hex: "#3fb950", dotClass: "bg-[var(--accent-green)]",       borderClass: "border-[var(--accent-green)]",       bgClass: "bg-[var(--accent-green)]/5",       priority: 2, isUrgent: false },
};

/** Lookup with fallback — unknown statuses map to idle config */
export function getStatusConfig(status: string): StatusConfig {
  return STATUS_CONFIG[status as UIStatus] ?? STATUS_CONFIG.idle;
}
```

Add CSS vars to `index.css`:
```css
:root {
  /* ...existing vars... */
  --status-idle: #6e7681;
  --status-pending: #6e7681;
  --status-running: #0969da;
  --status-completed: #1a7f37;
  --status-failed: #da3633;
}

/* Replace the 6 .status-dot.* classes with a data-attribute approach */
.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
}
```

Update `dashboard-types.ts` — add phase metadata to `AgentInfo`:
```ts
export interface AgentInfo {
  name: string;
  label: string;
  description: string;
  tools: string[];
  model: string;
  /** Logical ML phase this agent belongs to */
  phase: PipelinePhase;
  /** Step ID in the `steps` table */
  stepId: string;
}
```

Update `AGENT_INFO_REGISTRY` entries with `phase` + `stepId`:
```ts
"data-analyst": { ..., phase: "data_analysis", stepId: "eda" },
"feature-engineer": { ..., phase: "feature_engineering", stepId: "features" },
"modeler-classic": { ..., phase: "modeling", stepId: "model-classic" },
"modeler-advanced": { ..., phase: "modeling", stepId: "model-advanced" },
"ml-critic": { ..., phase: "audit", stepId: "audit" },
```

Then delete:
- `AGENT_STEP_MAP` from `pipeline-status.ts` — replace with `AGENT_INFO_REGISTRY[agentName].stepId`
- `STEP_AGENT_MAP` from `pipeline-status.ts` — derive from `Object.entries(AGENT_INFO_REGISTRY).find(([, v]) => v.stepId === stepId)?.[0]`
- `AGENT_PHASE` from `ExperimentBoard.tsx` — derive from `AGENT_INFO_REGISTRY[agentName]`

**Acceptance:**
- All status metadata lives in `STATUS_CONFIG`
- No hardcoded emoji, colors, or status labels outside `status-config.ts`
- CSS vars defined once, consumed via `var(--status-*)`
- `AGENT_INFO_REGISTRY` is single source for agent→phase and agent→stepId mappings
- All existing tests pass after refactoring

---

### A2. Shared Formatting — `lib/format.ts`

**Problem:** `formatElapsed` is defined twice with different signatures. `formatTimestamp` is inline in multiple places.

**Files:**
- `src/dashboard/src/lib/format.ts` (NEW)
- `src/dashboard/src/lib/format.test.ts` (NEW)
- `src/dashboard/src/components/PipelineStepper.tsx` (modify — import from lib)
- `src/dashboard/src/screens/CommandCenter.tsx` (modify — import from lib)

**Spec:**

```ts
// format.ts

/** Format milliseconds elapsed as MM:SS */
export function formatElapsedMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "00:00";
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const s = (totalSeconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

/** Format elapsed between two ISO timestamps as MM:SS */
export function formatElapsedBetween(startedAt: string | null, updatedAt: string | null): string {
  if (!startedAt) return "—";
  const start = new Date(startedAt).getTime();
  const end = updatedAt ? new Date(updatedAt).getTime() : Date.now();
  return formatElapsedMs(Math.max(0, end - start));
}

/** Format ISO timestamp to locale time string (HH:MM:SS) */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}
```

Refactor consumers:
- `PipelineStepper.tsx`: delete local `formatElapsed`, use `formatElapsedMs`
- `CommandCenter.tsx`: delete local `formatElapsed`, use `formatElapsedBetween`
- `TraceTimeline.tsx`: use `formatTime` from lib instead of local `formatTime`

**Acceptance:**
- Zero duplicate format functions
- All timestamps formatted through `lib/format.ts`

---

### A3. Human-Readable Status — `lib/human-status.ts`

**Problem:** Contradictory states (Running + Phase Idle + Round 0/5). Backend exposes raw fields; UI needs situational translation.

**Files:**
- `src/dashboard/src/lib/human-status.ts` (NEW)
- `src/dashboard/src/lib/human-status.test.ts` (NEW)
- `src/dashboard/src/hooks/useHumanStatus.ts` (NEW)

**Spec:**

Pure function with discriminated return type. No string literals — all labels are typed.

```ts
// human-status.ts

import { getStatusConfig } from "./status-config.js";
import type { PipelinePhase, PipelineStatus } from "@shared/dashboard-types";

export type HumanStatusLabel =
  | "idle"
  | "initializing"
  | "waiting_for_input"
  | "action_required"
  | "running"
  | "completed"
  | "failed"
  | "paused";

export interface HumanStatus {
  label: HumanStatusLabel;
  description: string;
  emoji: string;
  colorVar: string;
  isUrgent: boolean;
  /** Phase currently visible to user — null when idle */
  activePhase: PipelinePhase | null;
}

export interface HumanStatusInput {
  status: PipelineStatus["status"];
  currentPhase: PipelinePhase;
  currentRound: number;
  maxRounds: number;
  pendingDecisions: number;
}

// Rules evaluated in priority order — first match wins
const RULES: Array<{
  match: (i: HumanStatusInput) => boolean;
  resolve: (i: HumanStatusInput) => Omit<HumanStatus, "emoji" | "colorVar">;
}> = [
  {
    match: (i) => i.status === "idle",
    resolve: () => ({
      label: "idle",
      description: "Start a pipeline to begin",
      isUrgent: false,
      activePhase: null,
    }),
  },
  {
    match: (i) => i.status === "running" && i.currentPhase === "idle" && i.currentRound === 0,
    resolve: () => ({
      label: "initializing",
      description: "Pipeline is setting up",
      isUrgent: false,
      activePhase: null,
    }),
  },
  {
    match: (i) => i.status === "running" && i.currentPhase === "idle" && i.currentRound > 0,
    resolve: () => ({
      label: "waiting_for_input",
      description: "Pipeline paused — awaiting decision",
      isUrgent: true,
      activePhase: null,
    }),
  },
  {
    match: (i) => i.status === "running" && i.pendingDecisions > 0,
    resolve: (i) => ({
      label: "action_required",
      description: `${i.pendingDecisions} decision${i.pendingDecisions > 1 ? "s" : ""} pending`,
      isUrgent: true,
      activePhase: i.currentPhase,
    }),
  },
  {
    match: (i) => i.status === "running",
    resolve: (i) => ({
      label: "running",
      description: `Round ${i.currentRound}/${i.maxRounds}`,
      isUrgent: false,
      activePhase: i.currentPhase,
    }),
  },
  {
    match: (i) => i.status === "completed",
    resolve: (i) => ({
      label: "completed",
      description: `${i.currentRound} round${i.currentRound > 1 ? "s" : ""} finished`,
      isUrgent: false,
      activePhase: null,
    }),
  },
  {
    match: (i) => i.status === "failed",
    resolve: (i) => ({
      label: "failed",
      description: `Failed at ${i.currentPhase.replace(/_/g, " ")}, round ${i.currentRound}`,
      isUrgent: true,
      activePhase: i.currentPhase,
    }),
  },
  {
    match: (i) => i.status === "paused",
    resolve: (i) => ({
      label: "paused",
      description: `Pipeline paused at round ${i.currentRound}`,
      isUrgent: false,
      activePhase: i.currentPhase,
    }),
  },
];

/** Resolve composite pipeline state into a human-readable status.
 *  Pure function — no React, no side effects. */
export function getHumanStatus(input: HumanStatusInput): HumanStatus {
  const rule = RULES.find((r) => r.match(input));
  const resolved = rule ? rule.resolve(input) : {
    label: "idle" as HumanStatusLabel,
    description: "",
    isUrgent: false,
    activePhase: null as PipelinePhase | null,
  };

  // Derive emoji and color from the underlying status config
  const configKey = input.status === "running" && input.pendingDecisions > 0
    ? "pending" as const
    : input.status === "running" && input.currentPhase === "idle"
      ? "running" as const
      : input.status as keyof import("./status-config.js").STATUS_CONFIG;

  const config = getStatusConfig(configKey);

  return {
    ...resolved,
    emoji: config.emoji,
    colorVar: config.colorVar,
  };
}
```

Hook that composes `getHumanStatus` with pipeline data:

```ts
// hooks/useHumanStatus.ts

import { usePipelineStatus, useCommandCenter } from "../api/api.js";
import { getHumanStatus, type HumanStatus } from "../lib/human-status.js";

/** Composable hook — derives HumanStatus from live pipeline data */
export function useHumanStatus(): HumanStatus | null {
  const { data: pipeline } = usePipelineStatus();
  const { data: commandCenter } = useCommandCenter();

  if (!pipeline) return null;

  return getHumanStatus({
    status: pipeline.status,
    currentPhase: pipeline.currentPhase,
    currentRound: pipeline.currentRound,
    maxRounds: pipeline.maxRounds,
    pendingDecisions: commandCenter?.pendingDecisions.length ?? 0,
  });
}
```

**Acceptance:**
- All 8 rules tested with full coverage
- Pure function — no React dependency in `human-status.ts`
- Hook `useHumanStatus()` consumed by App header + CommandCenter + StatusCard
- Type-safe: `HumanStatusLabel` union prevents arbitrary strings

---

### A4. StatusBadge — Composition-Based Rewrite

**Problem:** Current StatusBadge renders dot + text. Adding `showEmoji`/`showLabel` props creates 4 implicit combinations. Instead, use composition.

**Files:**
- `src/dashboard/src/components/StatusBadge.tsx` (rewrite)
- `src/dashboard/src/components/StatusBadge.test.tsx` (update)

**Spec:**

```tsx
// StatusBadge.tsx

import type { ReactNode } from "react";
import { getStatusConfig, type UIStatus } from "../lib/status-config.js";

export interface StatusBadgeProps {
  status: UIStatus | string;
  size?: "sm" | "md" | "lg";
  /** Override the default content (emoji + label). Receives the resolved config. */
  children?: (config: { emoji: string; label: string }) => ReactNode;
}

const SIZE_CLASSES = {
  sm: "text-xs px-1.5 py-0.5",
  md: "text-sm px-2 py-0.5",
  lg: "text-base px-3 py-1",
} as const;

export function StatusBadge({ status, size = "md", children }: StatusBadgeProps) {
  const config = getStatusConfig(status);
  const sizeClass = SIZE_CLASSES[size];

  return (
    <span
      data-testid="status-badge"
      data-status={status}
      className={`inline-flex items-center gap-1.5 rounded-full font-medium border ${sizeClass} ${config.borderClass} ${config.bgClass}`}
      style={{ color: `var(${config.colorVar})` }}
    >
      {children
        ? children({ emoji: config.emoji, label: config.label })
        : (
          <>
            <span aria-hidden="true" className="text-sm">{config.emoji}</span>
            <span>{config.label}</span>
          </>
        )}
    </span>
  );
}
```

Usage patterns:
```tsx
// Default — emoji + label
<StatusBadge status="running" />

// Minimal — just the dot (like old behavior)
<StatusBadge status="running">{() => <span className={`status-dot ${getStatusConfig("running").dotClass}`} />}</StatusBadge>

// Custom — emoji only
<StatusBadge status="running">{({ emoji }) => <>{emoji}</>}</StatusBadge>

// Custom — label only
<StatusBadge status="running">{({ label }) => <>{label}</>}</StatusBadge>
```

**Acceptance:**
- Default renders emoji + label (no flags)
- Composition via `children` render prop — explicit, not implicit
- All existing `StatusBadge` usages still work (update snapshots)
- No hardcoded emoji or colors in this file

---

### A5. StatusCard — Pure Presentational

**Problem:** No dominant status element in CommandCenter (§1). Need a hero card, but it must not contain derivation logic.

**Files:**
- `src/dashboard/src/components/StatusCard.tsx` (NEW)
- `src/dashboard/src/components/StatusCard.test.tsx` (NEW)

**Spec:**

Pure presentational component. All logic derived externally.

```tsx
// StatusCard.tsx

import type { HumanStatus } from "../lib/human-status.js";
import { formatElapsedBetween } from "../lib/format.js";
import { AGENT_INFO_REGISTRY } from "@shared/dashboard-types";

export interface StatusCardProps {
  status: HumanStatus;
  /** ISO timestamps for elapsed calculation */
  startedAt: string | null;
  updatedAt: string | null;
  /** Name of the currently-running agent (if any) */
  currentAgent?: string;
}

export function StatusCard({ status, startedAt, updatedAt, currentAgent }: StatusCardProps) {
  const agentInfo = currentAgent ? AGENT_INFO_REGISTRY[currentAgent] : undefined;
  const elapsed = formatElapsedBetween(startedAt, updatedAt);
  const colorStyle = `var(${status.colorVar})`;

  return (
    <div
      data-testid="status-card"
      className={`rounded-lg border-l-4 p-6 ${status.isUrgent ? "animate-pulse-subtle" : ""}`}
      style={{
        borderColor: colorStyle,
        backgroundColor: `color-mix(in srgb, ${colorStyle} 8%, transparent)`,
      }}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="text-3xl" aria-hidden="true">{status.emoji}</span>
          <div>
            <h2 className="text-2xl font-bold" style={{ color: colorStyle }}>
              {status.description}
            </h2>
            {agentInfo && (
              <p className="text-sm text-[var(--text-secondary)] mt-0.5">
                Agent: {agentInfo.label}
              </p>
            )}
          </div>
        </div>
        <div className="text-right">
          <p className="text-xs text-[var(--text-muted)]">Elapsed</p>
          <p className="text-2xl font-mono text-[var(--text-primary)]">{elapsed}</p>
        </div>
      </div>
    </div>
  );
}
```

CSS animation in `index.css`:
```css
@keyframes pulse-subtle {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.9; }
}
.animate-pulse-subtle {
  animation: pulse-subtle 2s ease-in-out infinite;
}
```

**Acceptance:**
- Zero logic — all data comes from props
- Uses `HumanStatus` type (from A3)
- Uses `formatElapsedBetween` (from A2)
- Urgent states pulse subtly via CSS animation
- Running agent label derived from `AGENT_INFO_REGISTRY`

---

### A6. PipelineStepper — Consume STATUS_CONFIG

**Problem:** Phase icons and colors hardcoded. Uses its own `STATUS_COLOR` mapping instead of `STATUS_CONFIG`.

**Files:**
- `src/dashboard/src/components/PipelineStepper.tsx` (modify)

**Spec:**

Refactor to use `getStatusConfig` + `STATUS_CONFIG`:

```tsx
import { getStatusConfig } from "../lib/status-config.js";
import { formatElapsedMs } from "../lib/format.js";
import type { PhaseInfo } from "@shared/dashboard-types";

// Delete local STATUS_COLOR — use getStatusConfig(p.status)
// Delete local formatElapsed — use formatElapsedMs from lib
```

Phase dot rendering:
- Done: `{getStatusConfig("completed").emoji}` instead of filled circle
- Running: `{getStatusConfig("running").emoji}` with `animate-pulse`
- Failed: `{getStatusConfig("failed").emoji}`
- Pending: dimmed dot (no emoji)

Add running-phase background highlight:
```tsx
{isCurrent && p.status === "running" && (
  <div className="absolute inset-0 rounded-lg bg-[var(--status-running)]/5 -z-10" />
)}
```

Connector lines:
- Done-to-done: `bg-[var(--status-completed)]`
- Otherwise: `bg-[var(--border-default)]` with `border-dashed` for pending

**Acceptance:**
- No hardcoded colors or emoji in PipelineStepper
- Uses `getStatusConfig` for all visual decisions
- Uses `formatElapsedMs` from lib

---

## Group B — ExperimentBoard Overhaul

**Goal:** Make status view default, visually differentiate lanes, improve empty states, add card→agent navigation.

**Parallel with:** A, C, D

### B1. Default View = Status

**Problem:** Board defaults to "phase" view. Status is more useful (§2).

**Files:**
- `src/dashboard/src/screens/ExperimentBoard.tsx` (modify — line 136)

**Spec:**

```ts
const [view, setView] = useState<ViewMode>("status");
```

One-line change. Delete `AGENT_PHASE` map and derive from `AGENT_INFO_REGISTRY`:
```ts
// Replace:
const AGENT_PHASE: Record<string, { id: string; label: string }> = { ... };
// With:
import { AGENT_INFO_REGISTRY } from "@shared/dashboard-types";

// In buildLanes for phase view:
const phase = AGENT_INFO_REGISTRY[l.agent];
const phaseId = phase?.phase ?? l.agent;
const phaseLabel = phase?.label ?? l.label;
```

Also update `actionsForCard` to use `AGENT_INFO_REGISTRY`:
```ts
const specId = `${runId}:${AGENT_INFO_REGISTRY[card.agentName]?.stepId ?? card.agentName}`;
```

**Acceptance:**
- Board opens with Status view by default
- `AGENT_PHASE` map deleted, derived from `AGENT_INFO_REGISTRY`

---

### B2. Lane Visual Differentiation — Data-Driven

**Problem:** Cards look the same regardless of status (§2). Visual classes are hardcoded per-lane.

**Files:**
- `src/dashboard/src/screens/ExperimentBoard.tsx` (modify — card/lane rendering)

**Spec:**

No hardcoded status→class mapping. Use `STATUS_CONFIG`:

```tsx
import { getStatusConfig } from "../lib/status-config.js";

// Lane header:
<div className={`px-3 py-2 border-b ${config.borderClass} ${config.bgClass} flex items-center justify-between`}>
  <span className="text-sm font-medium" style={{ color: `var(${config.colorVar})` }}>{lane.label}</span>
  ...
</div>

// Card styling:
const config = getStatusConfig(card.status);
<button
  className={`w-full text-left rounded p-2 border-l-3 transition-colors ${
    selectedCardId === card.id
      ? `${config.borderClass} ${config.bgClass}`
      : "border-[var(--border-default)] hover:border-l-[var(--status-running)]"
  } ${config.key === "idle" ? "opacity-60" : config.key === "completed" ? "opacity-80" : ""}`}
>
  <div className="flex items-center gap-1.5 mb-1">
    <span className="text-sm">{config.emoji}</span>
    <span className="text-xs font-medium text-[var(--text-primary)] truncate">{card.title}</span>
  </div>
</button>
```

**Acceptance:**
- All lane/card styling derived from `STATUS_CONFIG`
- No hardcoded status-specific CSS classes outside config

---

### B3. EmptyState — Reusable Component

**Problem:** "No cards" / "No experiments yet" / "No log entries" are bare text. Each screen has its own inline empty message (§11).

**Files:**
- `src/dashboard/src/components/EmptyState.tsx` (NEW)
- `src/dashboard/src/screens/ExperimentBoard.tsx` (modify)
- `src/dashboard/src/screens/AgentDetail.tsx` (modify)

**Spec:**

Single reusable component for all empty states:

```tsx
// EmptyState.tsx

export interface EmptyStateProps {
  /** Emoji icon — from STATUS_CONFIG or explicit */
  icon: string;
  /** Primary message */
  message: string;
  /** Secondary context — why it's empty or what to expect */
  detail?: string;
  /** Show a subtle pulse progress bar */
  showProgress?: boolean;
}

export function EmptyState({ icon, message, detail, showProgress }: EmptyStateProps) {
  return (
    <div className="text-center py-4 space-y-1.5">
      <span className="text-lg" aria-hidden="true">{icon}</span>
      <p className="text-sm text-[var(--text-secondary)]">{message}</p>
      {detail && <p className="text-xs text-[var(--text-muted)]">{detail}</p>}
      {showProgress && (
        <div className="w-48 mx-auto h-1 bg-[var(--bg-tertiary)] rounded overflow-hidden">
          <div className="h-full bg-[var(--accent-blue)] rounded animate-pulse w-1/3" />
        </div>
      )}
    </div>
  );
}
```

Usage in ExperimentBoard:
```tsx
const emptyMessages: Record<string, { icon: string; message: string; detail?: string }> = {
  idle:        { icon: "⚪", message: "No pending steps" },
  running:     { icon: getStatusConfig("running").emoji, message: "Steps in progress", showProgress: true },
  completed:   { icon: getStatusConfig("completed").emoji, message: "No completed steps yet" },
  failed:      { icon: getStatusConfig("completed").emoji, message: "No failures — all good!" },
};

// When pipeline is running, override:
if (pipelineRunning) {
  emptyMessages.idle = { icon: "⏳", message: "Waiting for pipeline to reach this step", showProgress: true };
}

<EmptyState {...emptyMessages[lane.status]} />
```

Usage in AgentDetail (replace 4 inline empty states):
```tsx
// Spec diff empty:
<EmptyState
  icon={getStatusConfig("running").emoji}
  message="Waiting for second round to generate diff"
  detail={currentStatus === "running" ? "Diff will appear after this round completes" : undefined}
  showProgress={currentStatus === "running"}
/>

// Rounds empty:
<EmptyState icon={getStatusConfig("idle").emoji} message="No rounds completed yet" />

// Logs empty:
<EmptyState icon={getStatusConfig("idle").emoji} message="No log entries" />
```

Also update CommandCenter:
```tsx
// Best model empty:
<EmptyState icon={getStatusConfig("idle").emoji} message="No experiments yet" detail="Best model will appear here after first trial" />

// Decisions empty:
<EmptyState icon={getStatusConfig("completed").emoji} message="Nothing waiting on you right now" />
```

**Acceptance:**
- Single `EmptyState` component used everywhere
- No bare "No X yet" text in any screen
- `showProgress` bar on active empty states
- All icons from `STATUS_CONFIG`, no hardcoded emoji

---

### B4. Card Detail — Agent Navigation Link

**Problem:** No path from card detail to Agent Detail page (§5).

**Files:**
- `src/dashboard/src/screens/ExperimentBoard.tsx` (modify — detail panel)

**Spec:**

Add `Link` to detail panel header, using `AGENT_INFO_REGISTRY` for label:

```tsx
import { Link } from "react-router-dom";
import { AGENT_INFO_REGISTRY } from "@shared/dashboard-types";

// In detail panel header:
<Link
  to={`/agents/${selectedCard.agentName}`}
  className="text-xs text-[var(--accent-blue)] hover:underline"
>
  {AGENT_INFO_REGISTRY[selectedCard.agentName]?.label ?? selectedCard.agentName} Detail →
</Link>
```

**Acceptance:**
- Detail panel links to Agent Detail page
- Label derived from `AGENT_INFO_REGISTRY`, not hardcoded

---

## Group C — Navigation & Shell

**Goal:** Fix hardcoded agent nav, make Run ID clickable, replace inline toasts with global toast system.

**Parallel with:** A, B, D

**Coordinate:** C1 + C2 both modify `App.tsx`. Merge A4 + C1 + C2 together.

### C1. Run ID — Clickable Link in Header

**Problem:** Run ID is plain text (§3).

**Files:**
- `src/dashboard/src/App.tsx` (modify)

**Spec:**

```tsx
import { Link } from "react-router-dom";

// Replace <code> with:
<Link
  to="/"
  className="text-[var(--text-primary)] bg-[var(--bg-tertiary)] hover:bg-[var(--accent-blue)] hover:text-white px-1.5 py-0.5 rounded text-xs font-mono transition-colors"
>
  {status.runId.slice(0, 8)}
</Link>
```

**Acceptance:**
- Run ID is a link with hover state
- Keyboard accessible via `<Link>`

---

### C2. AgentNavDropdown — Accessible Component

**Problem:** Hardcoded `/agents/data-analyst` link (§10). Dropdown proposed inline with `onMouseLeave` — broken on touch/keyboard.

**Files:**
- `src/dashboard/src/components/AgentNavDropdown.tsx` (NEW)
- `src/dashboard/src/hooks/useClickOutside.ts` (NEW)
- `src/dashboard/src/App.tsx` (modify — use AgentNavDropdown)

**Spec:**

```tsx
// hooks/useClickOutside.ts
import { useEffect, useRef } from "react";

export function useClickOutside(
  ref: React.RefObject<HTMLElement | null>,
  handler: () => void,
) {
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) handler();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") handler();
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [ref, handler]);
}
```

```tsx
// components/AgentNavDropdown.tsx

import { useState, useRef, useCallback } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useAgents } from "../api/api.js";
import { useClickOutside } from "../hooks/useClickOutside.js";
import { getStatusConfig } from "../lib/status-config.js";

export function AgentNavDropdown() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data: agents } = useAgents();
  const location = useLocation();

  const close = useCallback(() => setOpen(false), []);
  useClickOutside(ref, close);

  const isActive = location.pathname.startsWith("/agents/");

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
        className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1 ${
          isActive
            ? "bg-[var(--accent-blue)] text-white"
            : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
        }`}
      >
        Agent Detail ▾
      </button>
      {open && agents && (
        <div
          role="menu"
          className="absolute left-0 top-full mt-1 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-md shadow-lg py-1 min-w-[200px] z-50"
        >
          {agents.map((a) => {
            const config = getStatusConfig(a.status);
            return (
              <NavLink
                key={a.name}
                role="menuitem"
                to={`/agents/${a.name}`}
                onClick={close}
                className={({ isActive }) =>
                  `flex items-center gap-2 px-4 py-2 text-sm ${
                    isActive ? "text-[var(--accent-blue)]" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                  }`
                }
              >
                <span className={`inline-block w-2 h-2 rounded-full ${config.dotClass}`} />
                {a.label}
              </NavLink>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

In `App.tsx`, replace hardcoded nav item:
```tsx
import { AgentNavDropdown } from "./components/AgentNavDropdown";

const NAV_ITEMS = [
  { to: "/", label: "Command Center", end: true },
  { to: "/kanban", label: "Experiment Board" },
  { to: "/leaderboard", label: "Model Arena" },
  // "Agent Detail" removed — rendered as <AgentNavDropdown />
];

// In nav rendering:
{NAV_ITEMS.map(...)}
<AgentNavDropdown />
```

**Acceptance:**
- Dropdown closes on: click outside, Escape key, NavLink click
- `aria-expanded`, `aria-haspopup`, `role="menu"` for accessibility
- Status dots from `STATUS_CONFIG`, no hardcoded classes
- Works on keyboard (Tab + Enter/Space to toggle)

---

### C3. Toast — Imperative Singleton (No Provider)

**Problem:** Toast is a plain `<div>`, easy to miss (§13). v1 spec proposed `ToastProvider` + `useToast()` — overkill for a notification stack.

**Files:**
- `src/dashboard/src/components/Toast.tsx` (NEW)
- `src/dashboard/src/main.tsx` (modify — add `<ToastContainer />`)
- `src/dashboard/src/screens/CommandCenter.tsx` (modify)
- `src/dashboard/src/screens/ExperimentBoard.tsx` (modify)
- `src/dashboard/src/screens/Leaderboard.tsx` (modify)

**Spec:**

Imperative singleton — no React context, no provider. A module-level ref + `addToast` function.

```tsx
// Toast.tsx

import { useState, useRef, useCallback } from "react";

interface ToastEntry {
  id: string;
  type: "success" | "error" | "warning" | "info";
  message: string;
  createdAt: number;
}

const TOAST_CONFIG = {
  success: { emoji: "✅", bgClass: "bg-[var(--accent-green)]/10 border-[var(--accent-green)]/30", autoDismiss: 4000 },
  error:   { emoji: "❌", bgClass: "bg-[var(--accent-red)]/10 border-[var(--accent-red)]/30", autoDismiss: null },
  warning: { emoji: "⚠️", bgClass: "bg-[var(--accent-orange)]/10 border-[var(--accent-orange)]/30", autoDismiss: 6000 },
  info:    { emoji: "ℹ️", bgClass: "bg-[var(--accent-blue)]/10 border-[var(--accent-blue)]/30", autoDismiss: 4000 },
} as const;

// Module-level imperative API — no provider needed
let addToastFn: ((type: ToastEntry["type"], message: string) => void) | null = null;

export function addToast(type: ToastEntry["type"], message: string): void {
  addToastFn?.(type, message);
}

const MAX_TOASTS = 3;

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const handleAdd = useCallback((type: ToastEntry["type"], message: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setToasts((prev) => [...prev.slice(-(MAX_TOASTS - 1)), { id, type, message, createdAt: Date.now() }]);

    const config = TOAST_CONFIG[type];
    if (config.autoDismiss) {
      timers.current.set(id, setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, config.autoDismiss));
    }
  }, []);

  // Register the imperative function on mount
  if (!addToastFn) addToastFn = handleAdd;
  addToastFn = handleAdd; // always keep ref fresh for re-renders

  const dismiss = useCallback((id: string) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-50 space-y-2 max-w-sm" role="status" aria-live="polite">
      {toasts.map((t) => {
        const config = TOAST_CONFIG[t.type];
        return (
          <div
            key={t.id}
            className={`flex items-center gap-2 px-4 py-3 rounded-lg border shadow-lg animate-slide-in ${config.bgClass}`}
          >
            <span aria-hidden="true">{config.emoji}</span>
            <p className="text-sm text-[var(--text-primary)] flex-1">{t.message}</p>
            <button
              onClick={() => dismiss(t.id)}
              className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-xs ml-2"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
```

Add slide-in animation to `index.css`:
```css
@keyframes slide-in {
  from { transform: translateX(100%); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}
.animate-slide-in {
  animation: slide-in 0.2s ease-out;
}
```

In `main.tsx`:
```tsx
import { ToastContainer } from "./components/Toast";

// Wrap inside QueryClientProvider:
<QueryClientProvider client={queryClient}>
  <RouterProvider router={router} />
  <ToastContainer />
</QueryClientProvider>
```

Replace all inline toast state in screens:
```tsx
// Before (in each screen):
const [toast, setToast] = useState<string | null>(null);
// ...
setToast("Approved");

// After:
import { addToast } from "../components/Toast";
// ...
addToast("success", `Approved ${specId}`);
addToast("error", `Approve failed: ${err.message}`);
```

Delete all `useState<string | null>(null)` toast state and inline toast `<div>` rendering from CommandCenter, ExperimentBoard, Leaderboard.

**Acceptance:**
- No `ToastProvider`, no context
- `addToast()` callable from anywhere (no hook dependency)
- Toasts appear fixed top-right with slide animation
- Success/info auto-dismiss, error persists
- Old inline toast divs completely removed from all screens

---

### C4. Breadcrumb — Derived from NAV_ITEMS

**Problem:** No navigation breadcrumb (§3). v1 proposed a new component that re-maps routes to labels — duplicating NAV_ITEMS.

**Files:**
- `src/dashboard/src/components/Breadcrumb.tsx` (NEW)
- `src/dashboard/src/App.tsx` (modify — render Breadcrumb in `<main>`)

**Spec:**

Derive breadcrumb from existing `NAV_ITEMS` config + `useLocation`. No new mapping tables.

```tsx
// Breadcrumb.tsx

import { Link, useLocation } from "react-router-dom";
import { usePipelineStatus } from "../api/api.js";

const NAV_ITEMS = [
  { to: "/", label: "Command Center", end: true },
  { to: "/kanban", label: "Experiment Board" },
  { to: "/leaderboard", label: "Model Arena" },
  { to: "/agents/:name", label: "Agent Detail" },
];

function matchPath(pathname: string): { label: string; agentName?: string } | null {
  // Exact matches first
  const exact = NAV_ITEMS.find((n) => n.to !== "/agents/:name" && pathname === n.to);
  if (exact) return { label: exact.label };

  // Agent detail pattern
  if (pathname.startsWith("/agents/")) {
    return { label: "Agent Detail", agentName: pathname.slice("/agents/") };
  }

  // Fallback
  const prefix = NAV_ITEMS.find((n) => n.to !== "/" && pathname.startsWith(n.to) && !n.to.includes(":"));
  return prefix ? { label: prefix.label } : null;
}

export function Breadcrumb() {
  const location = useLocation();
  const { data: pipeline } = usePipelineStatus();
  const current = matchPath(location.pathname);

  if (!current || location.pathname === "/") return null;

  const runSegment = pipeline?.runId
    ? { label: `Run ${pipeline.runId.slice(0, 8)}`, href: "/" }
    : null;

  return (
    <nav aria-label="Breadcrumb" className="text-xs text-[var(--text-muted)] py-2 flex items-center gap-1.5">
      <Link to="/" className="hover:text-[var(--text-primary)]">Formiga ML</Link>
      {runSegment && (
        <>
          <span>›</span>
          <Link to={runSegment.href} className="hover:text-[var(--text-primary)]">{runSegment.label}</Link>
        </>
      )}
      <span>›</span>
      <span className="text-[var(--text-primary)]">{current.label}</span>
      {current.agentName && (
        <>
          <span>›</span>
          <span className="text-[var(--text-primary)]">{current.agentName}</span>
        </>
      )}
    </nav>
  );
}
```

In `App.tsx`, render `<Breadcrumb />` at top of `<main>`:
```tsx
<main className="flex-1 overflow-auto p-6">
  <div className="max-w-screen-2xl mx-auto">
    <Breadcrumb />
    <Outlet />
  </div>
</main>
```

**Acceptance:**
- Breadcrumb derived from `NAV_ITEMS` config — no duplicate mapping
- Run segment only shows when active run exists
- Agent name shown for `/agents/:name` routes
- All segments except last are `<Link>` elements

---

## Group D — Feature Enhancements

**Goal:** Activity Feed (no new endpoint), Leaderboard context, Agent Strip clickability.

**Parallel with:** A, B, C

### D1. ActivityFeed — Client-Side Merged Logs

**Problem:** Dashboard feels static between 3s polls (§12). v1 proposed a new `GET /api/activity` endpoint — but `useAgentLogs()` already exists.

**Files:**
- `src/dashboard/src/components/ActivityFeed.tsx` (NEW)
- `src/dashboard/src/screens/CommandCenter.tsx` (modify — add section)

**Spec:**

Client-side composition — merge recent log entries from the running agent. No new backend endpoint.

```tsx
// ActivityFeed.tsx

import { useAgentLogs, useCommandCenter } from "../api/api.js";
import { formatTime } from "../lib/format.js";
import { AGENT_INFO_REGISTRY } from "@shared/dashboard-types";

export function ActivityFeed() {
  const { data: cc } = useCommandCenter();
  const runningAgent = cc?.agentStrip.find((a) => a.status === "running");

  // Only fetch logs for the currently-running agent
  const { data: logs } = useAgentLogs(runningAgent?.name, 0, 20);

  if (!logs || logs.entries.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-2">Recent Activity</h3>
        <p className="text-xs text-[var(--text-muted)]">No activity yet</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4">
      <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-2">Recent Activity</h3>
      <div className="max-h-[200px] overflow-y-auto space-y-1">
        {logs.entries.slice(-20).map((entry, i) => (
          <div key={i} className={`flex gap-2 text-xs py-0.5 ${entry.level === "error" ? "text-[var(--accent-red)]" : entry.level === "warn" ? "text-[var(--accent-orange)]" : "text-[var(--text-secondary)]"}`}>
            <span className="text-[var(--text-muted)] font-mono shrink-0">{formatTime(entry.timestamp)}</span>
            <span>{entry.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

In CommandCenter, place between Decisions Pending and Quick Stats:
```tsx
<ActivityFeed />
```

**Acceptance:**
- No new backend endpoint
- Reuses existing `useAgentLogs` hook
- Shows last 20 entries from running agent
- Auto-scrolls via `overflow-y-auto`
- Uses `formatTime` from lib, level-based coloring from `STATUS_CONFIG` palette

---

### D2. Leaderboard — Best Model Banner

**Problem:** Leaderboard doesn't communicate which model was selected and why (§8).

**Files:**
- `src/dashboard/src/screens/Leaderboard.tsx` (modify — add banner)

**Spec:**

Derive best model from existing `data` + `bestId`. No `find` in JSX — compute in `useMemo`:

```tsx
const bestEntry = useMemo(
  () => sortedEntries.find((e) => e.id === bestId) ?? null,
  [sortedEntries, bestId]
);

// Before the scatter plot:
{bestEntry && data?.bestCvMean != null && (
  <div className="bg-[var(--accent-green)]/10 border border-[var(--accent-green)]/30 rounded-lg p-4 flex items-center justify-between">
    <div className="flex items-center gap-3">
      <span className="text-2xl" aria-hidden="true">🏆</span>
      <div>
        <h3 className="font-semibold text-[var(--accent-green)]">Best Model</h3>
        <p className="text-sm text-[var(--text-secondary)]">
          <span className="font-mono text-[var(--accent-blue)]">{data.bestCvMean.toFixed(4)}</span>
          {" · "}{bestEntry.modelType}
          {" · Round "}{bestEntry.roundNumber}
        </p>
      </div>
    </div>
    <Link to={`/agents/${bestEntry.agentName}`} className="text-sm text-[var(--accent-blue)] hover:underline">
      {AGENT_INFO_REGISTRY[bestEntry.agentName]?.label ?? bestEntry.agentName} Detail →
    </Link>
  </div>
)}
```

**Acceptance:**
- Banner when best model exists
- Agent label from `AGENT_INFO_REGISTRY`, not hardcoded
- `bestEntry` computed in `useMemo`, not `find` inside JSX

---

### D3. Agent Strip — Clickable Cards with STATUS_CONFIG

**Problem:** Agent cards are not clickable. Running agents not highlighted (§7).

**Files:**
- `src/dashboard/src/screens/CommandCenter.tsx` (modify — agent strip section)

**Spec:**

```tsx
import { Link } from "react-router-dom";
import { getStatusConfig } from "../lib/status-config.js";

// Replace agent card div with Link:
{agentStrip.map((a) => {
  const config = getStatusConfig(a.status);
  const isRunning = a.status === "running";
  return (
    <Link
      key={a.name}
      to={`/agents/${a.name}`}
      className={`block border rounded p-3 transition-colors ${
        isRunning
          ? `${config.borderClass} ${config.bgClass}`
          : "border-[var(--border-default)] hover:border-[var(--accent-blue)] hover:bg-[var(--bg-tertiary)]"
      }`}
      data-testid={`agent-${a.name}`}
    >
      <div className="flex items-center gap-1.5 mb-2">
        <span className="text-sm">{config.emoji}</span>
        <span className="text-xs font-medium text-[var(--text-primary)] truncate">{a.label}</span>
      </div>
      <p className="text-[10px] text-[var(--text-muted)]">{a.trials} trial(s)</p>
      {a.bestCvMean != null && (
        <p className="text-[10px] text-[var(--accent-blue)] font-mono">best {a.bestCvMean.toFixed(4)}</p>
      )}
    </Link>
  );
})}
```

**Acceptance:**
- All agent cards are `<Link>` elements
- Running agent highlighted via `STATUS_CONFIG` classes
- Status dots replaced with emoji from config
- No hardcoded status-specific CSS

---

### D4. useSpecDispatch — Extract Duplicated Dispatch Logic

**Problem:** `dispatchDecision` in CommandCenter and `dispatch` in ExperimentBoard are near-identical 20-line functions. Both manage `approve`/`reject` mutations + toast messages.

**Files:**
- `src/dashboard/src/hooks/useSpecDispatch.ts` (NEW)
- `src/dashboard/src/screens/CommandCenter.tsx` (modify)
- `src/dashboard/src/screens/ExperimentBoard.tsx` (modify)

**Spec:**

```ts
// hooks/useSpecDispatch.ts

import { useSpecActions } from "../api/api.js";
import { addToast } from "../components/Toast.js";

export function useSpecDispatch() {
  const { approve: approveSpec, reject: rejectSpec } = useSpecActions();

  function approve(specId: string) {
    approveSpec.mutate(
      { specId },
      {
        onSuccess: () => addToast("success", `Approved ${specId}`),
        onError: (e) => addToast("error", `Approve failed: ${(e as Error).message}`),
      },
    );
  }

  function reject(specId: string) {
    const reason = window.prompt("Reject reason (optional):") ?? undefined;
    rejectSpec.mutate(
      { specId, reason },
      {
        onSuccess: () => addToast("success", `Rejected ${specId}`),
        onError: (e) => addToast("error", `Reject failed: ${(e as Error).message}`),
      },
    );
  }

  return { approve, reject };
}
```

In CommandCenter:
```tsx
// Delete: const { approve, reject } = useSpecActions(); + 20-line dispatchDecision
// Add:
const specDispatch = useSpecDispatch();

// In dispatchDecision:
function dispatchDecision(d: PendingDecision, actionId: string) {
  if (d.type === "spec_approval") {
    const specId = d.id.startsWith("spec:") ? d.id.slice(5) : d.id;
    if (actionId.startsWith("approve")) specDispatch.approve(specId);
    else if (actionId.startsWith("reject")) specDispatch.reject(specId);
    else addToast("info", `"${actionId}" not yet wired`);
    return;
  }
  addToast("info", `"${actionId}" not yet wired`);
}
```

Same pattern in ExperimentBoard.

**Acceptance:**
- Zero duplicated spec dispatch logic
- Screens use `useSpecDispatch()` hook
- All toast calls go through `addToast()` (from C3)

---

## Parallelization & Merge Strategy

```
Phase 1 — Foundation (Group A)
├── A1 STATUS_CONFIG        ← blocks all other tasks
├── A2 format.ts           ← independent
├── A3 human-status.ts      ← depends on A1
├── A4 StatusBadge          ← depends on A1
├── A5 StatusCard           ← depends on A1, A2, A3
└── A6 PipelineStepper      ← depends on A1, A2

Phase 2 — Parallel (Groups B, C, D after A merges)
├── Dev B: B1→B2→B3→B4     (ExperimentBoard)
├── Dev C: C1→C2→C3→C4     (Navigation + Toast)
└── Dev D: D1→D2→D3→D4     (Features)

All 3 can work in parallel after A is on the branch.
```

### Conflict Matrix

| File | Touches | Resolution |
|------|---------|-----------|
| `App.tsx` | A4 (header status) + C1 (Run ID) + C2 (dropdown) + C4 (breadcrumb) | Merge A4 + C1 + C2 + C4 together in one commit |
| `CommandCenter.tsx` | A5 (StatusCard) + D1 (ActivityFeed) + D3 (Agent Strip) + D4 (useSpecDispatch) | A5 replaces header, D1/D3 add sections, D4 extracts hook |
| `ExperimentBoard.tsx` | B1+B2+B3+B4 + D4 | B tasks are sequential in same file |
| `AgentDetail.tsx` | B3 (EmptyState) | B3 only |
| `Leaderboard.tsx` | D2 (banner) + C3 (toast) | C3 removes inline toast, D2 adds banner |
| `index.css` | A1 (CSS vars + animation) | A1 merges first |
| `dashboard-types.ts` | A1 (AgentInfo + phase/stepId) + pipeline-status.ts refactor | A1 merges first |

### Testing Requirements

Each task must include:
- [ ] Unit tests for new `lib/` functions (pure, no React)
- [ ] Component tests for new components
- [ ] Visual verification in browser (dark theme)
- [ ] Existing tests still pass
- [ ] No console errors
- [ ] Keyboard accessible (Tab + Enter, Escape to close dropdowns)
- [ ] `STATUS_CONFIG` is the only place status emoji/colors/labels appear

### Dependency Flow

```
A1 (STATUS_CONFIG)
 ├── A3 (human-status) ── A5 (StatusCard)
 ├── A4 (StatusBadge)
 ├── A6 (PipelineStepper)
 ├── B2 (lane styling)
 ├── B3 (EmptyState icons)
 ├── C2 (dropdown dots)
 ├── D2 (banner)
 └── D3 (agent strip)

A2 (format.ts)
 ├── A5 (StatusCard elapsed)
 ├── A6 (PipelineStepper elapsed)
 └── D1 (ActivityFeed timestamps)

A3 + C3 (addToast)
 └── D4 (useSpecDispatch)

A1 + dashboard-types (AgentInfo.phase/stepId)
 ├── B1 (delete AGENT_PHASE)
 ├── pipeline-status.ts (delete AGENT_STEP_MAP)
 └── B4 (agent nav link)
```