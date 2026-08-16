import { projectPlaces, readableName } from "../place-map.ts";
import type { MapPin, PlacePoint } from "../place-map.ts";
// The Places map — YOUR OWN PHOTOGRAPHS, arranged by where they were taken.
//
// Every pixel here comes from `place-map.ts`'s arithmetic over coordinates the
// vault already holds. There is no basemap, no tile request, no third-party
// script, and therefore nothing that tells anyone where a member has been in
// order to draw where a member has been. That is the point rather than a
// limitation: a browser basemap means fetching tiles keyed to the exact
// coordinates of somebody's photographs, and the blueprint CSP denies remote
// hosts anyway (docs/traps/blueprint-csp.md).
//
// THE PIN IS THE PICTURE. The first cut of this drew outline dots on a
// graticule labelled in degrees down both margins, and it was unreadable — not
// because it was wrong but because "39.0°N" is not how anyone holds a memory.
// A member recognises the back garden at dusk instantly and needs no label to
// know it is a long way south of the lake. So the numbers came off the
// margins, and each pin became a photograph taken at that place. What survives
// of the cartography is what a person actually says out loud: a scale bar
// ("50 km"), north, and an unlabelled grid for rhythm.
//
// A NAME rides under a pin only when the place has one a person would
// recognise — `readableName` refuses a coordinate-shaped label, which is every
// place until a gazetteer is installed (docs/photos-places.md). Printing the
// coordinate would be the same mistake in a smaller font.
//
// The pins are HTML buttons layered over the svg rather than svg circles: a
// tap opens the place's section, so they must be real focusable controls with
// accessible names, and an <img> in a button is a great deal less machinery
// than an SVG <image> in a <clipPath> with hand-rolled hit testing.
import { photosPinLabel } from "../shared-copy.ts";

import styles from "./PlaceMap.module.css";

/** The pin diameter for a place holding one photograph, and the ceiling a very
 *  large place is allowed to grow to. Area — not width — tracks the count, so
 *  a place with nine photographs looks three times a place with one rather
 *  than nine times it; width-scaling is the classic way a bubble map
 *  overstates its own biggest number. The floor is 40px because below that a
 *  photograph stops being recognisable, which would defeat the whole idea, and
 *  it is also about a fingertip. */
const PIN_MIN = 40;
const PIN_MAX = 76;

function pinSize(count: number, largest: number): number {
  if (largest <= 1) return PIN_MIN;
  const share = Math.sqrt(count) / Math.sqrt(largest);
  return Math.round(PIN_MIN + (PIN_MAX - PIN_MIN) * share);
}

/** The subset of an asset row a pin needs: something to show. Blob-backed
 *  bytes resolve to same-origin serve URLs and inline ones to `data:` URIs
 *  (queries/_shared.ts `srcOf`) — both are what the app CSP allows, and
 *  neither is a request to anybody else. */
interface PinnableAsset {
  thumb_uri?: string | null;
  preview_uri?: string | null;
  content_uri?: string | null;
}

const thumbOf = (assets: readonly PinnableAsset[]): string | null => {
  const first = assets[0];
  return first?.thumb_uri ?? first?.preview_uri ?? first?.content_uri ?? null;
};

export function placePoints(
  sections: readonly {
    key: string;
    name: string | null;
    lat: number | null;
    lng: number | null;
    assets: readonly PinnableAsset[];
  }[]
): PlacePoint[] {
  return sections.flatMap((section) =>
    section.lat === null || section.lng === null
      ? []
      : [
          {
            key: section.key,
            lat: section.lat,
            lng: section.lng,
            count: section.assets.length,
            name: section.name,
            thumb: thumbOf(section.assets),
          },
        ]
  );
}

/**
 * The widest a map is allowed to be drawn.
 *
 * The shelf can be 1100px across on a desktop pane, and a 1100×260 box next
 * to a trip that is taller than it is wide fits BY HEIGHT and leaves the pins
 * huddled in a band across the middle with two thirds of the map empty. One
 * scale on both axes is non-negotiable (it is what keeps the shape honest),
 * so the fix is to stop drawing a box that wide. A map is a figure, not a
 * banner.
 */
const MAX_DRAW_WIDTH = 640;

export function PlaceMap({
  points,
  width,
  height,
  activeKey,
  onOpen,
}: {
  points: readonly PlacePoint[];
  width: number;
  height?: number;
  /** The place whose section the member is looking at, drawn as the one
   *  raised pin. */
  activeKey?: string | null;
  onOpen: (key: string) => void;
}) {
  // A map of nothing is not an empty map, it is not a map — the shelf's own
  // empty state already says "no photograph here carries a place", and a blank
  // grid underneath it would be decoration pretending to be information.
  if (points.length === 0 || width <= 0) return null;

  const drawWidth = Math.min(width, MAX_DRAW_WIDTH);
  // Roughly the proportions of a paper map, so a north-south trip and an
  // east-west one both have somewhere to go.
  const drawHeight = height ?? Math.round(drawWidth * 0.66);
  // The pins are photographs now, so they need real room: the projection's
  // padding has to clear half of the largest pin or the northernmost picture
  // hangs off the top edge. It was 18 when a pin was a 13px dot.
  const { pins, meridians, parallels, scale } = projectPlaces(points, {
    width: drawWidth,
    height: drawHeight,
    padding: PIN_MAX / 2 + 6,
    // Two photographs cannot overlap the way two dots could. Measured on the
    // seeded roll: at PIN_MIN two Tahoe pins landed 54px apart and covered
    // 45×15px of each other. Centres closer than the WIDEST pin cannot both
    // be seen, so that is the threshold — and a merged pin says how many
    // places it stands for, which a half-hidden one does not.
    mergeDistance: PIN_MAX,
  });
  const largest = pins.reduce((max, pin) => Math.max(max, pin.count), 1);
  const label = (pin: MapPin): string => {
    const where = readableName(pin.name) ?? "an unnamed place";
    const photographs = `${pin.count} ${pin.count === 1 ? "photograph" : "photographs"}`;
    return photosPinLabel(where, pin.places, photographs);
  };

  return (
    <figure className={styles.figure}>
      <div
        className={styles.stage}
        style={{ aspectRatio: `${drawWidth} / ${drawHeight}` }}
      >
        <svg
          className={styles.map}
          viewBox={`0 0 ${drawWidth} ${drawHeight}`}
          aria-hidden="true"
        >
          {/* The grid carries NO numbers. It is rhythm — something for the eye
              to measure the spread against — and the moment it is labelled it
              starts asking to be read, in a vocabulary the reader did not sign
              up for. The scale bar answers "how far apart" honestly and in one
              phrase instead. */}
          <g className={styles.graticule}>
            {parallels.map((line) => (
              <line
                key={`p${line.degrees}`}
                x1={0}
                x2={drawWidth}
                y1={line.at}
                y2={line.at}
              />
            ))}
            {meridians.map((line) => (
              <line
                key={`m${line.degrees}`}
                x1={line.at}
                x2={line.at}
                y1={0}
                y2={drawHeight}
              />
            ))}
          </g>

          <text
            className={styles.north}
            x={drawWidth - 8}
            y={17}
            textAnchor="end"
          >
            N ↑
          </text>

          {scale.px > 0 ? (
            <g className={styles.scale} transform="translate(8 26)">
              <line x1={0} x2={scale.px} y1={0} y2={0} />
              <line x1={0} x2={0} y1={-3} y2={3} />
              <line x1={scale.px} x2={scale.px} y1={-3} y2={3} />
              <text x={0} y={-6} className={styles.tick}>
                {scale.km >= 1
                  ? `${scale.km} km`
                  : `${Math.round(scale.km * 1000)} m`}
              </text>
            </g>
          ) : null}
        </svg>

        {/* Positioned in PERCENTAGES off the same projection the svg drew, so
            the pins and the grid stay registered while the figure scales. */}
        {pins.map((pin) => {
          const size = pinSize(pin.count, largest);
          const name = readableName(pin.name);
          return (
            <button
              key={pin.key}
              type="button"
              className={styles.pin}
              data-active={
                activeKey != null && pin.key === activeKey ? "" : undefined
              }
              style={{
                left: `${(pin.x / drawWidth) * 100}%`,
                top: `${(pin.y / drawHeight) * 100}%`,
                inlineSize: `${size}px`,
              }}
              aria-label={label(pin)}
              aria-current={
                activeKey != null && pin.key === activeKey ? "true" : undefined
              }
              onClick={() => onOpen(pin.key)}
            >
              <span className={styles.frame} style={{ blockSize: `${size}px` }}>
                {pin.thumb ? (
                  // Decorative: the button's aria-label already says the place
                  // and the count, and repeating it here would announce every
                  // pin twice.
                  <img className={styles.shot} src={pin.thumb} alt="" />
                ) : null}
                {/* How many photographs, on the picture. A count is a numeral,
                    so it reads in mono like every other count in this app. */}
                <span className={styles.count}>{pin.count}</span>
              </span>
              {/* Only a name a person would recognise — never the coordinate
                  that stands in for one. */}
              {name ? <span className={styles.name}>{name}</span> : null}
            </button>
          );
        })}
      </div>
      <figcaption className={styles.caption}>
        Arranged by where each photograph was taken. Nothing is fetched — no map
        data leaves this device.
      </figcaption>
    </figure>
  );
}
