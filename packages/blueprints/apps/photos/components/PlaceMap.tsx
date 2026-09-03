import { projectPlaces, readableName, tierNoun } from "../place-map.ts";
import type { MapPin, PlacePoint } from "../place-map.ts";
import { photosPinLabel } from "../shared-copy.ts";

import styles from "./PlaceMap.module.css";

const PIN_MIN = 40;
const PIN_MAX = 76;

function pinSize(count: number, largest: number): number {
  if (largest <= 1) return PIN_MIN;
  const share = Math.sqrt(count) / Math.sqrt(largest);
  return Math.round(PIN_MIN + (PIN_MAX - PIN_MIN) * share);
}

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
  activeKey?: string | null;
  onOpen: (key: string) => void;
}) {
  if (points.length === 0 || width <= 0) return null;

  const drawWidth = Math.min(width, MAX_DRAW_WIDTH);
  const drawHeight = height ?? Math.round(drawWidth * 0.66);
  const { pins, meridians, parallels, scale, tier } = projectPlaces(points, {
    width: drawWidth,
    height: drawHeight,
    padding: PIN_MAX / 2 + 6,
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
          {/* The grid carries NO numbers; the scale bar answers distance. */}
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
              {/* Off the ladder that decided the merge, so the legend cannot
                  name a grouping the drawing did not perform. */}
              <text x={0} y={14} className={styles.tick}>
                {tierNoun(tier)}
              </text>
            </g>
          ) : null}
        </svg>

        {/* PERCENTAGES off the svg's projection, so pins stay registered. */}
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
                  <img className={styles.shot} src={pin.thumb} alt="" />
                ) : null}
                {/* A numeral: mono. */}
                <span className={styles.count}>{pin.count}</span>
              </span>
              {/* Never a coordinate. */}
              {name ? <span className={styles.name}>{name}</span> : null}
            </button>
          );
        })}
      </div>
      <figcaption className={styles.caption}>
        Arranged by where each photograph was taken — no map data leaves this
        device.
      </figcaption>
    </figure>
  );
}
