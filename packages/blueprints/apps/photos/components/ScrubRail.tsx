// THE SCRUB RAIL (v4 handoff §2.3, §4.5) — a new shared control.
//
// It is neither a scrollbar nor a slider: it answers "where am I in a list
// tens of thousands long?" in the only unit that means anything here, which is
// the month. It is labelled by month and it snaps to one.
//
// Two surfaces, one control:
//
//   Desktop / PWA  a 14px COLUMN on the trailing edge of the content area,
//                  with a `--line` hairline on its LEADING side, month ticks
//                  (7px for the current month, 3px otherwise) and a mono label
//                  every other month.
//   Phone          the rail OVERLAYS the grid. A 44px column would cost 11% of
//                  a 390px screen for a control the thumb only touches while
//                  dragging, so it is `position: absolute`, 44px wide,
//                  `pointer-events: none` except the thumb, `touch-action:
//                  none`, and the only VISIBLE part is a month bubble
//                  (`Aug 2026`) that tracks the drag.
//
// Every tick is a real button with a real label, so the rail is reachable by
// pointer and by keyboard — nothing here is drag-only.
import { useCallback, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import { cls } from "../format.ts";
import type { MonthTick } from "../grouping.ts";

import styles from "./ScrubRail.module.css";

export interface ScrubRailProps {
  /** Newest month first — the same order the timeline paints. */
  ticks: readonly MonthTick[];
  /** The month currently at the top of the scroller, or null before the
   *  first scroll. Drawn as the 7px tick. */
  activeKey: string | null;
  /** The compact form factor: overlay + bubble instead of a column. */
  phone: boolean;
  onSeek: (monthKey: string) => void;
}

export function ScrubRail({ ticks, activeKey, phone, onSeek }: ScrubRailProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  // The month the thumb is over WHILE DRAGGING — the only thing the phone
  // rail draws. Null when nothing is being dragged, so the bubble costs no
  // pixels at rest.
  const [dragging, setDragging] = useState<string | null>(null);

  const monthAt = useCallback(
    (clientY: number): string | null => {
      const track = trackRef.current;
      if (!track || ticks.length === 0) return null;
      const box = track.getBoundingClientRect();
      if (box.height <= 0) return null;
      const ratio = Math.min(1, Math.max(0, (clientY - box.top) / box.height));
      const index = Math.min(
        ticks.length - 1,
        Math.floor(ratio * ticks.length)
      );
      return ticks[index]?.key ?? null;
    },
    [ticks]
  );

  const drag = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const key = monthAt(e.clientY);
      if (key === null) return;
      setDragging(key);
      onSeek(key);
    },
    [monthAt, onSeek]
  );

  if (ticks.length === 0) return null;

  return (
    <nav
      className={cls(styles.rail, phone ? styles.phone : styles.column)}
      // A `<nav>` because that is what it is: every tick moves the member to a
      // month. It is named, so a screen reader announces the rail rather than
      // an unlabelled second navigation beside the shelf strip.
      aria-label="Scrub by month"
    >
      <div
        className={styles.track}
        ref={trackRef}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag(e);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) drag(e);
        }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          setDragging(null);
        }}
        onPointerCancel={() => setDragging(null)}
      >
        {ticks.map((tick, i) => (
          <button
            key={tick.key}
            type="button"
            className={cls(
              styles.tick,
              tick.key === activeKey && styles.tickCurrent
            )}
            // Icon-free and text-free at rest, so it states its own name.
            aria-label={tick.short}
            aria-current={tick.key === activeKey ? "true" : undefined}
            onClick={() => onSeek(tick.key)}
          >
            <span className={styles.tickMark} aria-hidden="true" />
            {/* A mono label every other month — a label on every one is a
                column of overlapping type at 11.5px. */}
            {!phone && i % 2 === 0 ? (
              <span className={styles.tickLabel} aria-hidden="true">
                {tick.short}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      {phone && dragging ? (
        <span className={styles.bubble}>
          {ticks.find((t) => t.key === dragging)?.short ?? ""}
        </span>
      ) : null}
    </nav>
  );
}
