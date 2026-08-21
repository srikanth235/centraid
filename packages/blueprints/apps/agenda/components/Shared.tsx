// The small pieces every Agenda view draws: the calendar hue dot, the search
// snippet, the held-write mark, and the empty case.
//
// EVERY VAULT STRING PASSES THROUGH `displayText` BEFORE IT REACHES THE DOM.
// A summary, a location and a guest's name are all member-supplied or
// imported text; React escapes them, and `displayText` additionally strips the
// invisible control and bidi-override characters that can make one label read
// as another. The joining link takes `safeExternalUrl` on top, because React
// does not make a `javascript:` href safe by escaping it.
import type { ReactNode } from "react";

import { displayText, safeExternalUrl } from "../../_shared/untrusted.ts";
import { snippetSegments } from "../format.ts";
import { PENDING_MARK } from "../view-copy.ts";

import styles from "./Shared.module.css";

/** A calendar's hue, as a CONTENT marker. It arrives as an inline custom
 *  property because the value is data — a per-calendar colour the owner may
 *  set — and a stylesheet is not where data belongs. */
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

/** A number a member reads as a number: tabular figures, isolated so RTL
 *  cannot reorder `17:00` against the words beside it. */
export function Num({ children }: { children: ReactNode }): ReactNode {
  return <span className={styles.num}>{children}</span>;
}

/** A vault FTS snippet, with the hit marked and everything inert. */
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

/** Plain vault text, inert. */
export function Safe({ value }: { value: unknown }): ReactNode {
  return <>{displayText(value)}</>;
}

/**
 * A joining link, or nothing. An unsafe scheme draws NO control rather than a
 * dead one — an affordance that cannot act is the thing the product refuses.
 */
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

/**
 * The mark a row carries while its write is on this device: a 2px inline-start
 * rule and the words. Never a spinner and never a badge — the row says what is
 * true about itself, in place.
 */
export function PendingMark({
  text = PENDING_MARK,
}: {
  text?: string;
}): ReactNode {
  return <span className={styles.pendingMark}>{text}</span>;
}

/** An empty view, in its own words, with the one thing to do next when there
 *  is one. A variant with no action draws no button rather than a dead one. */
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
