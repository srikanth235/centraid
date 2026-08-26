// SCRUB RAIL (v4 handoff §2.3, §4.5): answers "where am I in tens of
// thousands?" in months, snapping to one. Desktop: tick column; phone:
// absolute overlay. Every tick is a real labelled button — never drag-only.
import { useCallback, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import { cls } from "../format.ts";
import type { MonthTick } from "../grouping.ts";

import styles from "./ScrubRail.module.css";

export interface ScrubRailProps {
  /** Newest month first. */
  ticks: readonly MonthTick[];
  /** Null before first scroll. */
  activeKey: string | null;
  phone: boolean;
  onSeek: (monthKey: string) => void;
}

export function ScrubRail({ ticks, activeKey, phone, onSeek }: ScrubRailProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  // Month under the thumb WHILE DRAGGING; null at rest.
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
      // Named <nav>: announced as one landmark.
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
            // Text-free at rest, so it states its own name.
            aria-label={tick.short}
            aria-current={tick.key === activeKey ? "true" : undefined}
            onClick={() => onSeek(tick.key)}
          >
            <span className={styles.tickMark} aria-hidden="true" />
            {/* Labels overlap at 11.5px. */}
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
