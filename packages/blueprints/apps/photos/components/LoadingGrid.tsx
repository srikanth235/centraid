import { cls } from "../format.ts";
import { justify } from "../layout.ts";
import type { Asset } from "../types.ts";

import styles from "./LoadingGrid.module.css";

const SHAPES: readonly (readonly [number, number])[] = [
  [4, 3],
  [3, 4],
  [3, 2],
  [1, 1],
  [16, 9],
  [2, 3],
  [5, 4],
  [3, 2],
  [4, 5],
  [16, 10],
];

const ROWS = 6;

function shapes(count: number): Asset[] {
  return Array.from({ length: count }, (_, i) => {
    const [w, h] = SHAPES[i % SHAPES.length]!;
    return { asset_id: `skeleton-${i}`, width: w * 100, height: h * 100 };
  }) as Asset[];
}

export interface LoadingGridProps {
  containerWidth: number;
  targetHeight: number;
  phone: boolean;
}

export function LoadingGrid({
  containerWidth,
  targetHeight,
  phone,
}: LoadingGridProps) {
  const perRow = Math.max(1, Math.round(containerWidth / (targetHeight * 1.2)));
  const rows = justify(
    shapes(perRow * ROWS),
    containerWidth,
    targetHeight
  ).slice(0, ROWS);

  return (
    <div className={styles.grid} aria-busy="true">
      <div
        className={cls(styles.stream, phone ? styles.streamPhone : null)}
        aria-hidden="true"
      >
        {rows.map((tiles, row) => (
          <div className={styles.row} key={`skeleton-row-${row}`}>
            {tiles.map((tile, i) => (
              <span
                className={styles.tile}
                key={`skeleton-${row}-${i}`}
                style={{ width: `${tile.width}px`, height: `${tile.height}px` }}
              />
            ))}
          </div>
        ))}
      </div>
      {/* Padding reserves the rail's column; its month ticks are not known yet. */}
    </div>
  );
}
