// THE APP NAVIGATION RAIL (v16 handoff, "The app navigation rail — Photos and
// Docs") — a vertical list of ONE APP's own destinations, on the leading edge
// of its content area, under a pointer.
//
// ```
// ┌────────┬──────────────────┬───────────────────────────────┬────────┐
// │  stem  │   app rail       │   content                     │ info   │
// │  240   │   232            │   flex                        │ 308    │
// │ WHICH  │   WHERE IN IT    │                               │ WHAT   │
// │  APP   │                  │                               │ IS THIS│
// └────────┴──────────────────┴───────────────────────────────┴────────┘
// ```
//
// Three columns is three questions, not three spines. Invariant 1 reserves the
// band for the FRAME, and this is not a second band: the stem answers **which
// app** and never moves, the rail answers **where in it**. An app earns one by
// having more than four destinations of its own — below that the app bar's
// segmented control carries them and the rail would be a column of three rows.
//
// AN APP WITH A RAIL MUST STILL WORK WITHOUT IT. On touch, and in a pane too
// narrow for a 232px column beside the set, the same destinations are the app
// band or the shelf strip. A destination that exists only here is a defect, so
// this component never invents one: it draws the rows it is handed, and both
// callers build those rows from the same shelf tables their strip reads.
//
// WHAT IT DOES NOT DRAW, and each is deliberate: no hue, no icon chip, no
// badge, no dot, no disclosure triangle, no expandable row, no drop target. A
// count is a number in the numeric register or it is absent. Hover firms
// nothing and a route change does not animate — a route change is a CONTENT
// change, and a spine that moved every time the content did would be claiming
// the credit for it.
import { useCallback, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import styles from "./NavRail.module.css";

/**
 * One entry in a rail. Three shapes, because a rail says three things:
 *
 *   * `head` — a GROUP, and a group is a distinction the horizontal strip
 *     flattened. Photos' *Library* and *Collections* are the example: a shelf
 *     filters the library, a collection is its own set.
 *   * `rule` — a hairline. What sits below it is a STATE of the set rather
 *     than a place in it (Duplicates, Trash), which is a weaker separation
 *     than a group head and is drawn as one.
 *   * `row` — a destination.
 */
export type NavRailItem =
  | { kind: "head"; label: string }
  | { kind: "rule" }
  | {
      kind: "row";
      /** Stable across renders — the shelf id, the folder id, or a literal for
       *  the one row that is not a destination. Used as the React key and as
       *  the focus identity, never rendered. */
      id: string;
      label: string;
      /**
       * The count, read from the caller's ONE counts map — the same map its
       * shelf strip and its More sheet read, so the three surfaces cannot
       * disagree about how many things a shelf holds. Absent where the count
       * is not yet known: a rail that invented a zero would be reporting an
       * empty shelf it had never read.
       */
      count?: number;
      /** The route the member is standing on. Exactly one row per rail. */
      current?: boolean;
      /** A row nested under the head above it — Docs' folders under *Folders*.
       *  One level; there is no second. */
      indent?: boolean;
      /**
       * Where pressing it goes. **Absent means the row is not a destination**
       * and is drawn as inert text: Docs' *Unfiled* is a fact about the drive
       * — the set with no label, and the largest one in it — and the drive has
       * no route that shows only that set. A row that routed somewhere else
       * while wearing its own number would be lying about where it led, and a
       * row wearing a number nobody can reach is worse than one that admits it
       * is a total. `FoldersRoute` makes the same call for the same reason.
       */
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
  /** The `nav`'s accessible name — *Photos*, *Docs*. The app, because what
   *  the rail lists is the app's own destinations and a screen reader
   *  announcing "navigation" twice on one screen has to be able to tell the
   *  frame's stem from this. */
  label: string;
  items: readonly NavRailItem[];
}): ReactNode {
  // ONE TAB STOP INTO THE RAIL, then up/down through the rows. A rail of ten
  // destinations that spent ten tab stops would put the content column nine
  // presses further away than the strip did, and the strip is the thing this
  // replaces. Roving tabindex: exactly one row is tabbable, and which one
  // follows the member's own arrow keys once they are in.
  const refs = useRef(new Map<string, HTMLButtonElement>());
  /**
   * Where the member arrowed to, AND the route they were on when they did.
   *
   * The route is carried with it rather than reset by an effect: a route
   * change re-homes the tab stop, and an effect that reached back into state
   * to say so would be a second, invisible idea of "where you are" that
   * renders once behind the first. Kept as one value, the staleness is simply
   * derivable — the walk belongs to the route it was made on.
   */
  const [walked, setWalked] = useState<{
    id: string;
    from: string | undefined;
  } | null>(null);

  const destinations = items.filter(isDestination);
  const currentId = destinations.find((row) => row.current)?.id;
  // The row that owns the tab stop: wherever the member last arrowed to on
  // THIS route, else the route they are standing on, else the head of the
  // list. Falling back to the current row means tabbing in lands on WHERE YOU
  // ARE rather than at the top of a list you would then arrow back down.
  // `walked !== null` is load-bearing and not a formality: on a rail with NO
  // current row — Photos standing on Storage, which the rail does not list —
  // `currentId` is `undefined`, and so is `walked?.from` while nothing has
  // been walked. Comparing those two alone answers "yes" for a walk that never
  // happened.
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
      // Clamped, not wrapped: the ends of a spine are a place, and arrowing
      // off the bottom onto the top would lose the member's place in a column
      // whose whole job is to hold it.
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
      // Enter and Space are the button's own; nothing here intercepts them.
    };

  return (
    <nav className={styles.rail} aria-label={label}>
      {items.map((item, index) => {
        if (item.kind === "rule") {
          // Presentational: the separation it draws is already carried by the
          // rows on either side of it, and a screen reader announcing
          // "separator" between Places and Duplicates learns nothing.
          // Keyed by position: a rule has no identity of its own, and where it
          // sits IS what it is.
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
