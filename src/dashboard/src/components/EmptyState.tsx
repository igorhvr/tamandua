export interface EmptyStateProps {
  /** Emoji/icon to represent the empty state */
  icon: string;
  /** Primary message (headline) */
  message: string;
  /** Optional detail below the primary message */
  detail?: string;
  /** Show subtle progress indicator */
  showProgress?: boolean;
}

export function EmptyState({ icon, message, detail, showProgress }: EmptyStateProps) {
  return (
    <div className="text-center py-4 space-y-1.5">
      <span className="text-lg" aria-hidden="true">
        {icon}
      </span>
      <p className="text-sm text-[var(--text-secondary)]">{message}</p>
      {detail && <p className="text-xs text-[var(--text-muted)]">{detail}</p>}
      {showProgress && (
        <div className="w-48 mx-auto h-1 bg-[var(--bg-tertiary)] rounded overflow-hidden">
          <div
            role="progressbar"
            aria-valuenow={33}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-full bg-[var(--accent-blue)] rounded animate-pulse w-1/3"
          />
        </div>
      )}
    </div>
  );
}
