// EVERY vault string passes through `displayText` before the DOM — it strips
// invisible control/bidi characters. Links take `safeExternalUrl`: escaping
// never makes `javascript:` safe.
import type { ChangeEvent, ReactNode } from "react";

import { displayText, safeExternalUrl } from "../../_shared/untrusted.ts";
import { snippetSegments } from "../format.ts";
import { CLOSE, PENDING_MARK, SEARCH_LABEL } from "../view-copy.ts";

import styles from "./Shared.module.css";

/** Where the band's Search tab and the bar's Search icon both land. */
export function SearchField({
  value,
  onSearch,
  onClose,
}: {
  value: string;
  onSearch: (value: string) => void;
  onClose: () => void;
}): ReactNode {
  return (
    <div className={styles.searchRow}>
      <label className={styles.searchField}>
        <span className="kit-sr-only">{SEARCH_LABEL}</span>
        <input
          id="searchInput"
          type="search"
          className="kit-input"
          placeholder={SEARCH_LABEL}
          value={value}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            onSearch(event.target.value)
          }
        />
      </label>
      <button
        type="button"
        className="kit-icon-btn"
        aria-label={CLOSE}
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}

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
