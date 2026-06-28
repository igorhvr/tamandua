import type { AgentStatus } from "@shared/dashboard-types";

export type UIStatus = AgentStatus | "pending" | "approved" | "rejected" | "promoted" | "overfitted" | "success";

export interface StatusConfig {
  key: UIStatus;
  label: string;
  emoji: string;
  colorVar: string;
  hex: string;
  dotClass: string;
  borderClass: string;
  bgClass: string;
  priority: number;
  isUrgent: boolean;
}

export const STATUS_CONFIG: Record<UIStatus, StatusConfig> = {
  idle: {
    key: "idle",
    label: "PENDING",
    emoji: "⚪",
    colorVar: "--status-idle",
    hex: "#6e7681",
    dotClass: "bg-[var(--status-idle)]",
    borderClass: "border-[var(--status-idle)]",
    bgClass: "bg-[var(--status-idle)]/5",
    priority: 0,
    isUrgent: false,
  },
  pending: {
    key: "pending",
    label: "PENDING",
    emoji: "⚪",
    colorVar: "--status-pending",
    hex: "#6e7681",
    dotClass: "bg-[var(--status-pending)]",
    borderClass: "border-[var(--status-pending)]",
    bgClass: "bg-[var(--status-pending)]/5",
    priority: 0,
    isUrgent: false,
  },
  running: {
    key: "running",
    label: "RUNNING",
    emoji: "🔵",
    colorVar: "--status-running",
    hex: "#0969da",
    dotClass: "bg-[var(--status-running)]",
    borderClass: "border-[var(--status-running)]",
    bgClass: "bg-[var(--status-running)]/10",
    priority: 1,
    isUrgent: false,
  },
  completed: {
    key: "completed",
    label: "DONE",
    emoji: "✅",
    colorVar: "--status-completed",
    hex: "#1a7f37",
    dotClass: "bg-[var(--status-completed)]",
    borderClass: "border-[var(--status-completed)]",
    bgClass: "bg-[var(--status-completed)]/5",
    priority: 2,
    isUrgent: false,
  },
  failed: {
    key: "failed",
    label: "FAILED",
    emoji: "❌",
    colorVar: "--status-failed",
    hex: "#da3633",
    dotClass: "bg-[var(--status-failed)]",
    borderClass: "border-[var(--status-failed)]",
    bgClass: "bg-[var(--status-failed)]/10",
    priority: 3,
    isUrgent: true,
  },
  timed_out: {
    key: "timed_out",
    label: "TIMED OUT",
    emoji: "⏱️",
    colorVar: "--accent-orange",
    hex: "#d29922",
    dotClass: "bg-[var(--accent-orange)]",
    borderClass: "border-[var(--accent-orange)]",
    bgClass: "bg-[var(--accent-orange)]/10",
    priority: 3,
    isUrgent: true,
  },
  approved: {
    key: "approved",
    label: "APPROVED",
    emoji: "✅",
    colorVar: "--accent-green",
    hex: "#3fb950",
    dotClass: "bg-[var(--accent-green)]",
    borderClass: "border-[var(--accent-green)]",
    bgClass: "bg-[var(--accent-green)]/5",
    priority: 2,
    isUrgent: false,
  },
  rejected: {
    key: "rejected",
    label: "REJECTED",
    emoji: "🚫",
    colorVar: "--accent-red",
    hex: "#f85149",
    dotClass: "bg-[var(--accent-red)]",
    borderClass: "border-[var(--accent-red)]",
    bgClass: "bg-[var(--accent-red)]/5",
    priority: 3,
    isUrgent: true,
  },
  promoted: {
    key: "promoted",
    label: "PROMOTED",
    emoji: "⬆️",
    colorVar: "--accent-green",
    hex: "#3fb950",
    dotClass: "bg-[var(--accent-green)]",
    borderClass: "border-[var(--accent-green)]",
    bgClass: "bg-[var(--accent-green)]/5",
    priority: 2,
    isUrgent: false,
  },
  overfitted: {
    key: "overfitted",
    label: "OVERFITTED",
    emoji: "⚠️",
    colorVar: "--accent-orange",
    hex: "#d29922",
    dotClass: "bg-[var(--accent-orange)]",
    borderClass: "border-[var(--accent-orange)]",
    bgClass: "bg-[var(--accent-orange)]/10",
    priority: 3,
    isUrgent: true,
  },
  success: {
    key: "success",
    label: "SUCCESS",
    emoji: "✅",
    colorVar: "--accent-green",
    hex: "#3fb950",
    dotClass: "bg-[var(--accent-green)]",
    borderClass: "border-[var(--accent-green)]",
    bgClass: "bg-[var(--accent-green)]/5",
    priority: 2,
    isUrgent: false,
  },
};

export function getStatusConfig(status: string): StatusConfig {
  return STATUS_CONFIG[status as UIStatus] ?? STATUS_CONFIG.idle;
}
