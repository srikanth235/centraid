// ONE APP's own destinations, on the leading edge of its content area, under a
// pointer. Stem = which app, rail = where in it. An app earns a rail only above
// four destinations.
//
// AN APP WITH A RAIL MUST STILL WORK WITHOUT IT: on touch, or in a pane too
// narrow for the 232px column, the same destinations are the app band or shelf
// strip. A destination existing only here is a defect, so this component never
// invents one — it draws the rows it is handed.
//
// WHAT IT DOES NOT DRAW, each deliberate: no hue, icon chip, badge, dot,
// disclosure triangle, expandable row, or drop target. Hover firms nothing and a
// route change does not animate.
import { useCallback, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import styles from "./NavRail.module.css";

/**
 * `head` is a GROUP — a distinction the horizontal strip flattened. `rule` is a
 * hairline: below it is a STATE of the set, a weaker separation than a head.
 */
export type NavRailItem =
  | { kind: "head"; label: string }
  | { kind: "rule" }
  | {
      kind: "row";
      /** Stable across renders; the React key and focus identity, never rendered. */
      id: string;
      label: string;
      /** Absent where unknown: an invented zero reports a shelf never read. */
      count?: number;
      /** Exactly one row per rail. */
      current?: boolean;
      /** Nested under the head above it. One level; there is no second. */
      indent?: boolean;
      /** **Absent means not a destination**, drawn as inert text: a row routing
       *  elsewhere while wearing its own number would lie about where it led. */
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
  /** The `nav`'s accessible name — the APP, so a screen reader announcing
   *  "navigation" twice can tell the frame's stem from this. */
  label: string;
  items: readonly NavRailItem[];
}): ReactNode {
  // ONE TAB STOP, then up/down: ten tab stops would push the content column
  // further away than the strip this replaces. Roving tabindex.
  const refs = useRef(new Map<string, HTMLButtonElement>());
  /**
   * Where the member arrowed to, AND the route they were on. Never reset this by
   * effect: that would be a second idea of "where you are", one frame behind.
   */
  const [walked, setWalked] = useState<{
    id: string;
    from: string | undefined;
  } | null>(null);

  const destinations = items.filter(isDestination);
  const currentId = destinations.find((row) => row.current)?.id;
  // Last arrowed-to row on THIS route, else the current route, so tabbing in
  // lands on WHERE YOU ARE. `walked !== null` is load-bearing: with no current
  // row both `currentId` and `walked?.from` are `undefined`, and comparing those
  // alone answers yes for a walk that never happened.
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
          // Presentational: the rows either side already carry the separation.
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
