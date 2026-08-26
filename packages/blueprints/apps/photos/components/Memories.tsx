import { useState } from "react";

import { scopeAttr } from "../../_shared/scope-kit.ts";
import { displayText, safeBackgroundImage } from "../../_shared/untrusted.ts";
import { projectPlaces } from "../place-map.ts";
import type { TripRoutePoint } from "../trips.ts";
import type { MemoryCard } from "../types.ts";

import styles from "./Memories.module.css";
import shared from "./shared.module.css";

const SKETCH_WIDTH = 72;
const SKETCH_HEIGHT = 48;

// Offline route sketch (#816): geometry, not a map picture. One stop = one
// dot and no line — a polyline through one point would invent travel.
function RouteSketch({ route }: { route: readonly TripRoutePoint[] }) {
  const { pins } = projectPlaces(route, {
    width: SKETCH_WIDTH,
    height: SKETCH_HEIGHT,
    padding: 6,
    mergeDistance: 0,
  });
  if (pins.length === 0) return null;
  // Re-order to the trip: `projectPlaces` sorts by count.
  const stops = route.flatMap((point) => {
    const pin = pins.find((candidate) => candidate.key === point.key);
    return pin ? [pin] : [];
  });
  if (stops.length === 0) return null;
  return (
    <svg
      className={styles.memoryRoute}
      viewBox={`0 0 ${SKETCH_WIDTH} ${SKETCH_HEIGHT}`}
      aria-hidden="true"
    >
      {stops.length > 1 ? (
        <polyline
          className={styles.memoryRouteLine}
          points={stops.map((pin) => `${pin.x},${pin.y}`).join(" ")}
        />
      ) : null}
      {stops.map((pin) => (
        <circle
          key={pin.key}
          className={styles.memoryRouteStop}
          cx={pin.x}
          cy={pin.y}
          r={2.5}
        />
      ))}
    </svg>
  );
}

export function MemoriesStrip({ memories }: { memories: MemoryCard[] }) {
  const [expanded, setExpanded] = useState(false);
  if (memories.length === 0) return null;
  const visibleMemories = expanded ? memories : memories.slice(0, 3);
  return (
    <div className={styles.memories}>
      <div className={styles.memoriesHeader}>
        <div className={`${shared.sectionLabel} ${styles.memoriesLabel}`}>
          Memories
        </div>
        <button
          type="button"
          className={styles.allMemories}
          aria-expanded={expanded}
          onClick={() => setExpanded(true)}
        >
          All memories →
        </button>
      </div>
      <div className={styles.memoriesStrip}>
        {visibleMemories.map((m) => {
          const handleOpen = m.onOpen;
          const cover = safeBackgroundImage(m.coverUri);
          const title = displayText(m.title);
          return (
            <button
              key={m.key}
              type="button"
              className={styles.memoryCard}
              /* Cover may be a shared photo — fetch in that scope (#599). */
              data-scope={scopeAttr(m.coverScopeId)}
              /* Composite control: custom accessible NAME, not visible-text duplicate. */
              aria-label={`Open ${title}`}
              onClick={handleOpen}
            >
              {/* Sketch is a plate ON the photograph, never instead of it. */}
              <span className={styles.memoryStage}>
                <span
                  className={styles.memoryCover}
                  style={cover ? { backgroundImage: cover } : undefined}
                />
                {m.route && m.route.length > 0 ? (
                  <RouteSketch route={m.route} />
                ) : null}
              </span>
              <span className={styles.memoryText}>
                <span className={styles.memoryTitle}>{title}</span>
                <span className={styles.memorySub}>{displayText(m.sub)}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
