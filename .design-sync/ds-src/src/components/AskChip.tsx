import type { ReactNode } from 'react';

export interface AskChipProps {
  /** Chip label — a suggested prompt. */
  children?: ReactNode;
  /** Click handler — fills the composer with this suggestion. */
  onClick?: () => void;
}

/** A suggestion chip inside the Ask panel. */
export function AskChip({ children, onClick }: AskChipProps) {
  return (
    <button type="button" className="kit-ask-chip" onClick={onClick}>
      {children}
    </button>
  );
}
