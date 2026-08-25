// One app's destinations on the leading edge of its content area; earned only
// above four rows. MUST work without it: touch and narrow panes reach the same
// destinations via the app band/shelf strip — draw only handed-in rows, none
// invented. No hue/icon/badge/dot/disclosure/expand/drop-target chrome; hover
// firms nothing and routes don't animate.
import { useCallback, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import styles from "./NavRail.module.css";

/** `rule` separates states of a set — weaker than a `head`. */
export type NavRailItem =
  | { kind: "head"; label: string }
  | { kind: "rule" }
  | {
      kind: "row";
      id: string;
      label: string;
      /** Absent means unknown, never zero. */
      count?: number;
      /** Exactly one row per rail. */
      current?: boolean;
      indent?: boolean;
      /** Absent = not a destination, drawn as inert text. */
      onSelect?: () => void;
    };

function isDestination(
  item: NavRailItem
): item is Extract<NavRailItem, { kind: "row" }> & { onSelect: () => void } {
  return item.kind === "row" && typeof item.onSelect === "function";
}

export function NavRail({
  label,
  items,
}: {
  /** Accessible name = the APP: distinguishes frame nav from this rail. */
  label: string;
  items: readonly NavRailItem[];
}): ReactNode {
  // ONE TAB STOP then up/down (roving tabindex): ten stops push content away.
  const refs = useRef(new Map<string, HTMLButtonElement>());
  /** Never reset by effect: that would be a second, stale idea of "here". */
  const [walked, setWalked] = useState<{
    id: string;
    from: string | undefined;
  } | null>(null);

  const destinations = items.filter(isDestination);
  const currentId = destinations.find((row) => row.current)?.id;
  // Last arrow-to on THIS route else current. `walked !== null` is load-bearing:
  // undefined-vs-undefined would match vacuously.
  const walkedHere =
    walked !== null &&
    walked.from === currentId &&
    destinations.some((row) => row.id === walked.id)
      ? walked.id
      : null;
  const rovingId = walkedHere ?? currentId ?? destinations[0]?.id ?? null;

  const move = useCallback(
    (fromId: string, delta: 1 | -1): void => {
      const index = destinations.findIndex((row) => row.id === fromId);
      if (index < 0) return;
      // Clamped, not wrapped: the ends of a spine are a place.
      const next =
        destinations[
          Math.min(Math.max(index + delta, 0), destinations.length - 1)
        ];
      if (!next || next.id === fromId) return;
      setWalked({ from: currentId, id: next.id });
      refs.current.get(next.id)?.focus();
    },
    [currentId, destinations]
  );

  const handleKeyDown =
    (rowId: string) =>
    (event: KeyboardEvent): void => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        move(rowId, 1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        move(rowId, -1);
      }
      // Enter and Space are the button's own; never intercept them.
    };

  return (
    <nav className={styles.rail} aria-label={label}>
      {items.map((item, index) => {
        if (item.kind === "rule") {
          // Keyed by position — a rule has no identity but where it sits.
          return (
            <div
              key={`rule-${index}`}
              className={styles.rule}
              aria-hidden="true"
            />
          );
        }
        if (item.kind === "head") {
          return (
            <div key={`head-${item.label}`} className={styles.head}>
              {item.label}
            </div>
          );
        }
        const count =
          item.count === undefined ? null : (
            <span className={styles.count}>{item.count}</span>
          );
        if (!isDestination(item)) {
          return (
            <div
              key={item.id}
              className={styles.row}
              data-indent={item.indent ? "true" : "false"}
              data-static="true"
            >
              <span className={styles.label}>{item.label}</span>
              {count}
            </div>
          );
        }
        const on = Boolean(item.current);
        return (
          <button
            key={item.id}
            type="button"
            className={styles.row}
            data-indent={item.indent ? "true" : "false"}
            data-current={on ? "true" : "false"}
            {...(on ? { "aria-current": "page" as const } : {})}
            tabIndex={item.id === rovingId ? 0 : -1}
            ref={(el) => {
              if (el) refs.current.set(item.id, el);
              else refs.current.delete(item.id);
            }}
            onFocus={() => setWalked({ from: currentId, id: item.id })}
            onKeyDown={handleKeyDown(item.id)}
            onClick={() => item.onSelect()}
          >
            <span className={styles.label}>{item.label}</span>
            {count}
          </button>
        );
      })}
    </nav>
  );
}
