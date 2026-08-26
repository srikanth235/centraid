// EVERY vault string passes through `displayText` before the DOM — it strips
// invisible control/bidi characters. Links take `safeExternalUrl`: escaping
// never makes `javascript:` safe.
import type { ReactNode } from "react";

import { displayText, safeExternalUrl } from "../../_shared/untrusted.ts";
import { snippetSegments } from "../format.ts";
import { PENDING_MARK } from "../view-copy.ts";

import styles from "./Shared.module.css";

export function CalendarDot({ hue }: { hue: string | null }): ReactNode {
  if (!hue) return null;
  return (
    <span
      className={styles.dot}
      style={{ "--dot-hue": hue } as Record<string, string>}
      aria-hidden="true"
    />
  );
}

export function Num({ children }: { children: ReactNode }): ReactNode {
  return <span className={styles.num}>{children}</span>;
}

export function Snippet({ snippet }: { snippet: string }): ReactNode {
  return (
    <span className={styles.snippet}>
      {snippetSegments(snippet).map((segment, index) =>
        segment.hit ? (
          <mark key={`hit-${index}`}>{displayText(segment.text)}</mark>
        ) : (
          <span key={`run-${index}`}>{displayText(segment.text)}</span>
        )
      )}
    </span>
  );
}

export function Safe({ value }: { value: unknown }): ReactNode {
  return <>{displayText(value)}</>;
}

/** An unsafe scheme draws NO control rather than a dead one. */
export function JoinLink({
  uri,
  label,
}: {
  uri: string | null | undefined;
  label: string;
}): ReactNode {
  const href = safeExternalUrl(uri);
  if (!href) return null;
  return (
    <a
      className="kit-btn"
      href={href}
      rel="noreferrer noopener"
      target="_blank"
    >
      {label}
    </a>
  );
}

export function PendingMark({
  text = PENDING_MARK,
}: {
  text?: string;
}): ReactNode {
  return <span className={styles.pendingMark}>{text}</span>;
}

export function EmptyState({
  line,
  actionLabel,
  onAction,
}: {
  line: string;
  actionLabel?: string;
  onAction?: () => void;
}): ReactNode {
  return (
    <div className={`kit-empty ${styles.empty}`}>
      <p className={styles.emptyLine}>{line}</p>
      {actionLabel && onAction ? (
        <button type="button" className="kit-btn" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}
