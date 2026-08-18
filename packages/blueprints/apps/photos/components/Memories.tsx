import { useState } from "react";

import { scopeAttr } from "../../_shared/scope-kit.ts";
import { displayText, safeBackgroundImage } from "../../_shared/untrusted.ts";
// The memories strip (main Photos view only, per the build prompt — never in
// search/select). Pure view; `memories` is already the fully-derived list
// (see buildMemories() in app.tsx) of `{ key, title, sub, coverUri, onOpen }`.
import { projectPlaces } from "../place-map.ts";
import type { TripRoutePoint } from "../trips.ts";
import type { MemoryCard } from "../types.ts";

import styles from "./Memories.module.css";
import shared from "./shared.module.css";

/** The sketch's own drawing box, in the coordinate space of its viewBox — a
 *  corner plate on a 250×120 cover, so it reads as a figure ON the photograph
 *  rather than a second cover competing with it. */
const SKETCH_WIDTH = 72;
const SKETCH_HEIGHT = 48;

/**
 * WHERE THE TRIP WENT, as a line — the route sketch on a trip card (#816).
 *
 * `projectPlaces` is the same arithmetic both Places surfaces run, so this
 * plate and the Places map agree about the shape of a trip because they execute
 * one projection rather than because somebody kept two in step. Nothing is
 * fetched to draw it: there is no basemap, no tile, no embedded picture and no
 * URL of any kind in this markup — a card built from coordinates the vault
 * holds renders identically with the network unplugged, which is the whole
 * reason the sketch is geometry instead of a static map picture.
 *
 * A single-stop trip draws its one dot and no line: a polyline through one
 * point is not a route, and stretching it into one would invent travel.
 */
function RouteSketch({ route }: { route: readonly TripRoutePoint[] }) {
  const { pins } = projectPlaces(route, {
    width: SKETCH_WIDTH,
    height: SKETCH_HEIGHT,
    // A dot's radius plus a hair, so the outermost stop is not clipped by the
    // plate's own edge; no merge at all, because two stops the eye cannot
    // separate at this size are still two stops the LINE has to pass through.
    padding: 6,
    mergeDistance: 0,
  });
  if (pins.length === 0) return null;
  // Back into the route's own order: `projectPlaces` sorts by count for its
  // merge pass, and the line has to follow the trip, not the tally.
  const stops = route.flatMap((point) => {
    const pin = pins.find((candidate) => candidate.key === point.key);
    return pin ? [pin] : [];
  });
  if (stops.length === 0) return null;
  return (
    <svg
      className={styles.memoryRoute}
      viewBox={`0 0 ${SKETCH_WIDTH} ${SKETCH_HEIGHT}`}
      /* Decoration in the accessibility tree: the card's own title already
         says where the trip was, and a screen reader has no use for a line. */
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
              /* The cover is one real asset's bytes, and a memory can be built
                 from a shared audience's photo — so the card names the scope its
                 background-image must be fetched in (issue #599). */
              data-scope={scopeAttr(m.coverScopeId)}
              /* A composite control (cover + title + subtitle), so this is a
                 custom accessible NAME, not a duplicate of visible text — the
                 same case DESIGN.md's "aria-label is a replacement" rule and
                 lint-aria-labels' allowlist both carve out for rich cards. */
              aria-label={`Open ${title}`}
              onClick={handleOpen}
            >
              {/* The cover is the photograph; the route sketch is a corner
                  plate ON it, never instead of it — a trip is remembered by
                  the picture and situated by the line. */}
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
