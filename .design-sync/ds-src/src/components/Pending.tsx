import type { ReactNode } from 'react';

export interface PendingProps {
  /** Chip label — e.g. "waiting", "parked". */
  label?: string;
  /** The row content the pending state wraps. */
  children?: ReactNode;
}

/**
 * The parked / pending state — a dashed "ticket" rail with a spinner chip,
 * shown while an action waits on the owner's approval.
 */
export function Pending({ label = 'waiting', children }: PendingProps) {
  return (
    <div className="kit-pending">
      {children}
      <span className="kit-pending-chip">{label}</span>
    </div>
  );
}
