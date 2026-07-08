import type { ReactNode } from 'react';

export interface MessageProps {
  /** Who authored the bubble. */
  role: 'user' | 'ai';
  /** Bubble content. */
  children?: ReactNode;
}

/** A conversation bubble in the Ask surface — user or assistant. */
export function Message({ role, children }: MessageProps) {
  return <div className={`kit-msg ${role}`}>{children}</div>;
}
