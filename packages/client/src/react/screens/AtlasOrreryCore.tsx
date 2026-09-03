import type { JSX } from "react";

import type { AtlasGraphNode } from "../../gateway-client.js";
import { cx } from "../ui/cx.js";
import { ORRERY } from "./atlasOrreryGeometry.js";

import styles from "./AtlasRelationsTab.module.css";

const CORE_TICKS = Array.from({ length: 60 }, (_, i) => {
  const major = i % 5 === 0;
  const a = (i * 6 * Math.PI) / 180;
  const r0 = ORRERY.coreR + 8;
  const r1 = r0 + (major ? 5 : 2.5);
  return {
    key: i,
    major,
    x1: ORRERY.cx + Math.cos(a) * r0,
    y1: ORRERY.cy + Math.sin(a) * r0,
    x2: ORRERY.cx + Math.cos(a) * r1,
    y2: ORRERY.cy + Math.sin(a) * r1,
  };
});

export interface AtlasOrreryCoreProps {
  center: string;
  centerNode: AtlasGraphNode | undefined;
  isRoot: boolean;
  inDeg: number;
  outDeg: number;
  pct: number;
  centerEdgeCount: number;
  edgeCount: number;
}

export default function AtlasOrreryCore({
  center,
  centerNode,
  isRoot,
  inDeg,
  outDeg,
  pct,
  centerEdgeCount,
  edgeCount,
}: AtlasOrreryCoreProps): JSX.Element {
  const name = centerNode?.friendly ?? centerNode?.table ?? center;
  const est = name.length * 13 * 0.62;
  const max = ORRERY.coreR * 2 - 8;

  return (
    <g>
      <circle
        className={styles.coreGlow}
        cx={ORRERY.cx}
        cy={ORRERY.cy}
        r={ORRERY.coreR + 26}
      />
      <g className={styles.coreBezel}>
        {CORE_TICKS.map((t) => (
          <line
            key={t.key}
            className={cx(styles.coreTick, t.major && styles.coreTickMajor)}
            x1={t.x1}
            y1={t.y1}
            x2={t.x2}
            y2={t.y2}
          />
        ))}
      </g>
      <circle
        className={styles.coreRingOuter}
        cx={ORRERY.cx}
        cy={ORRERY.cy}
        r={ORRERY.coreR + 5}
      />
      <circle
        className={styles.corePlate}
        cx={ORRERY.cx}
        cy={ORRERY.cy}
        r={ORRERY.coreR}
      />
      <text
        className={styles.coreName}
        x={ORRERY.cx}
        y={ORRERY.cy - 6}
        textAnchor="middle"
        {...(est > max
          ? { textLength: max, lengthAdjust: "spacingAndGlyphs" }
          : {})}
      >
        {name}
      </text>
      {/* the physical/SQL name, demoted to the small mono line under the friendly
          name — the honest machine identity, never hidden */}
      <text
        className={styles.coreK}
        x={ORRERY.cx}
        y={ORRERY.cy + 12}
        textAnchor="middle"
        data-testid="atlas-center-physical"
      >
        {centerNode?.physical ?? center}
      </text>
      <text
        className={styles.coreCaption}
        x={ORRERY.cx}
        y={ORRERY.cy + ORRERY.coreR + 20}
        textAnchor="middle"
        data-testid="atlas-center-caption"
      >
        {isRoot ? (
          <>
            <tspan className={styles.coreCaptionLit}>
              {centerEdgeCount} of {edgeCount}
            </tspan>
            <tspan> structural references point here — {pct}%</tspan>
          </>
        ) : (
          <tspan>
            {inDeg} point in · {outDeg} point out · rings recomputed by hop
            distance
          </tspan>
        )}
      </text>
    </g>
  );
}
