import type { JSX, ReactNode } from 'react';

import styles from './SessionStatusStrip.module.css';

export interface SessionStatusStripProps {
  leading?: ReactNode;
  model?: ReactNode;
  effort?: ReactNode;
  context?: { used: number; size: number };
  busy: boolean;
}

/**
 * Shared conversation-session telemetry. The gauge follows the latest ACP
 * snapshot exactly, including decreases after compaction.
 */
export default function SessionStatusStrip({
  leading,
  model,
  effort,
  context,
  busy,
}: SessionStatusStripProps): JSX.Element {
  const ratio =
    context && context.size > 0 ? Math.min(1, Math.max(0, context.used / context.size)) : 0;
  const percentage = Math.round(ratio * 100);
  return (
    <div className={styles.strip} data-testid="session-status-strip">
      <div className={styles.leading}>{leading}</div>
      <div className={styles.telemetry}>
        {context ? (
          <span
            className={styles.context}
            aria-label={`Context ${context.used} of ${context.size} tokens`}
            title={`${context.used.toLocaleString()} / ${context.size.toLocaleString()} context tokens`}
          >
            <span className={styles.contextTrack}>
              <span className={styles.contextFill} style={{ width: `${percentage}%` }} />
            </span>
            <span>{percentage}%</span>
          </span>
        ) : null}
        <span className={styles.activity} data-busy={busy ? 'true' : undefined}>
          <span className={styles.activityDot} />
          {busy ? 'Working' : 'Ready'}
        </span>
        {model}
        {effort}
      </div>
    </div>
  );
}
