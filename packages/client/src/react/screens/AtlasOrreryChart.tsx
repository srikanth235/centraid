/* oxlint-disable jsx-a11y/prefer-tag-over-role -- the orrery's clickable kind nodes are SVG <g> elements; <button> is not renderable inside <svg>, so the g carries role="button" + tabIndex + Enter/Space key handling instead */
import type { CSSProperties, JSX } from 'react';
import type { AtlasFkEdge, AtlasGraphNode } from '../../gateway-client.js';
import { cx } from '../ui/cx.js';
import {
  ORRERY,
  type BearingLayout,
  edgePath,
  fillStrokeOpacity,
  fillStrokeWidth,
  nodeRadius,
  packHueVar,
  polar,
} from './atlasOrreryGeometry.js';
import styles from './AtlasRelationsTab.module.css';

// The orrery's inline-SVG chart body (issue #441 B2) — a presentational leaf of
// AtlasRelationsTab. It draws the graticule, pack sectors, FK edge layer, the
// authored-link overlay, the brass centre plate, and the clickable kind nodes
// from fully-computed geometry handed down as props. All layout maths and the
// anti-hairball invariant live in atlasOrreryGeometry.ts; all state and the
// re-centre animation live in the parent. This component is stateless.

/** The current hover/focus readout target — a discriminated union shared with
 *  the parent and the side panel so both light up the same element. */
export type Readout =
  | { kind: 'idle' }
  | { kind: 'node'; node: AtlasGraphNode; hop: number | null }
  | { kind: 'edge'; edge: AtlasFkEdge };

const CSSVar = (name: string, value: string): CSSProperties => ({ [name]: value }) as CSSProperties;

export interface AtlasOrreryChartProps {
  center: string;
  centerNode: AtlasGraphNode | undefined;
  isRoot: boolean;
  inDeg: number;
  outDeg: number;
  pct: number;
  centerEdgeCount: number;
  edgeCount: number;
  layout: BearingLayout;
  radiusOf: (physical: string) => number;
  drawEdges: readonly AtlasFkEdge[];
  maxFill: number;
  visibleNodes: readonly AtlasGraphNode[];
  hops: Map<string, number | null>;
  rows: Map<string, number>;
  packs: readonly string[];
  overlayArcs: readonly { id: string; d: string }[];
  readout: Readout;
  onReadout: (r: Readout) => void;
  onRecenter: (physical: string) => void;
}

export default function AtlasOrreryChart({
  center,
  centerNode,
  isRoot,
  inDeg,
  outDeg,
  pct,
  centerEdgeCount,
  edgeCount,
  layout,
  radiusOf,
  drawEdges,
  maxFill,
  visibleNodes,
  hops,
  rows,
  packs,
  overlayArcs,
  readout,
  onReadout,
  onRecenter,
}: AtlasOrreryChartProps): JSX.Element {
  return (
    <svg
      className={styles.orrery}
      viewBox={`0 0 ${ORRERY.view} ${ORRERY.view}`}
      role="img"
      aria-label={`Radial graph of the vault schema, centred on ${center}`}
      data-testid="atlas-orrery"
      data-center={center}
    >
      {/* graticule — concentric hop rings */}
      {[
        { r: ORRERY.ringHop1, label: 'hop 1', dashed: false },
        { r: ORRERY.ringHop2, label: 'hop 2', dashed: false },
        { r: ORRERY.ringHop3, label: 'hop 3+', dashed: false },
        { r: ORRERY.ringUnreached, label: 'unreached', dashed: true },
      ].map((ring) => (
        <g key={ring.label}>
          <circle
            className={cx(styles.ringGuide, ring.dashed && styles.ringGuideDashed)}
            cx={ORRERY.cx}
            cy={ORRERY.cy}
            r={ring.r}
          />
          <text className={styles.ringTick} x={ORRERY.cx + 5} y={ORRERY.cy - ring.r - 4}>
            {ring.label}
          </text>
        </g>
      ))}

      {/* pack sector names on the outer dial — fixed compass bearings */}
      {layout.sectors.map((s) => {
        const p = polar(s.midDeg, ORRERY.sectorLabelR);
        const flip = Math.cos((s.midDeg * Math.PI) / 180) < 0;
        return (
          <text
            key={s.pack}
            className={styles.sectorName}
            x={p.x}
            y={p.y}
            textAnchor={flip ? 'end' : 'start'}
            dominantBaseline="middle"
            transform={`rotate(${flip ? s.midDeg + 180 : s.midDeg} ${p.x} ${p.y})`}
          >
            {s.pack}
          </text>
        );
      })}

      {/* FK edges — pack-neutral, weighted by fill; ghosts dotted */}
      <g className={cx(styles.edges, readout.kind !== 'idle' && styles.edgesDimmed)}>
        {drawEdges.map((e) => {
          const a = polar(layout.bearing.get(e.fromTable) ?? 0, radiusOf(e.fromTable));
          const bIsCenter = e.toTable === center;
          const aIsCenter = e.fromTable === center;
          const bPos = bIsCenter
            ? { x: ORRERY.cx, y: ORRERY.cy }
            : polar(layout.bearing.get(e.toTable) ?? 0, radiusOf(e.toTable));
          const aPos = aIsCenter ? { x: ORRERY.cx, y: ORRERY.cy } : a;
          const bow = aIsCenter || bIsCenter ? 1 : 0.86;
          const d = edgePath(aPos.x, aPos.y, bPos.x, bPos.y, bow);
          const hot =
            (readout.kind === 'edge' &&
              readout.edge.fromTable === e.fromTable &&
              readout.edge.col === e.col &&
              readout.edge.toTable === e.toTable) ||
            (readout.kind === 'node' &&
              (readout.node.physical === e.fromTable || readout.node.physical === e.toTable));
          return (
            <g key={`${e.fromTable}.${e.col}`}>
              <path
                className={cx(
                  styles.edge,
                  e.ghost ? styles.edgeGhost : styles.edgeLive,
                  hot && styles.edgeHot,
                )}
                d={d}
                data-testid="atlas-edge"
                data-ghost={e.ghost ? 'true' : 'false'}
                data-notnull={e.notnull ? 'true' : 'false'}
                data-from={e.fromTable}
                data-to={e.toTable}
                data-fill={e.fill}
                style={
                  e.ghost
                    ? undefined
                    : {
                        strokeWidth: fillStrokeWidth(e.fill, maxFill),
                        strokeOpacity: fillStrokeOpacity(e.fill, maxFill, e.notnull),
                      }
                }
              />
              <path
                className={styles.edgeHit}
                d={d}
                data-testid="atlas-edge-hit"
                data-from={e.fromTable}
                data-to={e.toTable}
                onMouseOver={() => onReadout({ kind: 'edge', edge: e })}
                onMouseOut={() => onReadout({ kind: 'idle' })}
              />
            </g>
          );
        })}
      </g>

      {/* authored-link overlay — the SEPARATE core_link mechanism, dashed */}
      {overlayArcs.map((arc) => (
        <path
          key={arc.id}
          className={styles.authoredArc}
          d={arc.d}
          data-testid="atlas-authored-arc"
        />
      ))}

      {/* the centre — brass plate + the measured-fact caption */}
      <g>
        <circle className={styles.coreGlow} cx={ORRERY.cx} cy={ORRERY.cy} r={ORRERY.coreR + 26} />
        <circle className={styles.corePlate} cx={ORRERY.cx} cy={ORRERY.cy} r={ORRERY.coreR} />
        <text className={styles.coreName} x={ORRERY.cx} y={ORRERY.cy - 6} textAnchor="middle">
          {centerNode?.table ?? center}
        </text>
        <text className={styles.coreK} x={ORRERY.cx} y={ORRERY.cy + 12} textAnchor="middle">
          {isRoot ? 'THE CENTRE' : `${inDeg} IN · ${outDeg} OUT`}
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
              {inDeg} {inDeg === 1 ? 'reference points' : 'references point'} here · rings
              recomputed by hop distance
            </tspan>
          )}
        </text>
      </g>

      {/* the kinds */}
      {visibleNodes.map((n) => {
        const hop = hops.get(n.physical) ?? null;
        const pos = polar(layout.bearing.get(n.physical) ?? 0, radiusOf(n.physical));
        const nr = nodeRadius(rows.get(n.physical));
        const bearing = layout.bearing.get(n.physical) ?? 0;
        const b = ((bearing % 360) + 360) % 360;
        const flip = b > 90 && b < 270;
        const big = (rows.get(n.physical) ?? 0) > 4000;
        const hot =
          (readout.kind === 'node' && readout.node.physical === n.physical) ||
          (readout.kind === 'edge' &&
            (readout.edge.fromTable === n.physical || readout.edge.toTable === n.physical));
        return (
          <g
            role="button"
            key={n.physical}
            className={cx(styles.node, hot && styles.nodeHot)}
            style={CSSVar('--node-c', packHueVar(n.pack, packs))}
            transform={`translate(${pos.x.toFixed(1)} ${pos.y.toFixed(1)})`}
            tabIndex={0}
            aria-label={`${n.physical} — re-centre`}
            data-testid="atlas-node"
            data-physical={n.physical}
            data-logical={n.logical}
            data-pack={n.pack}
            data-hop={hop === null ? 'unreached' : String(hop)}
            data-bearing={bearing.toFixed(2)}
            data-selfref={n.selfRef ? 'true' : 'false'}
            onClick={() => onRecenter(n.physical)}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                onRecenter(n.physical);
              }
            }}
            onMouseOver={() => onReadout({ kind: 'node', node: n, hop })}
            onMouseOut={() => onReadout({ kind: 'idle' })}
            onFocus={() => onReadout({ kind: 'node', node: n, hop })}
          >
            <circle className={styles.nodeHalo} r={nr + 4} />
            <circle className={styles.nodeBody} r={nr} />
            {n.selfRef ? (
              <path
                className={styles.nodeSelfcurl}
                data-testid="atlas-selfref-glyph"
                d={`M ${(nr + 3) * 0.5} ${-(nr + 3) * 0.72} A ${(nr + 3) * 0.62} ${
                  (nr + 3) * 0.62
                } 0 1 1 ${-(nr + 3) * 0.5} ${-(nr + 3) * 0.72}`}
              />
            ) : null}
            <circle className={styles.nodeHit} r={Math.max(nr + 5, 11)} />
            <text
              className={cx(styles.nodeLabel, big && styles.nodeLabelBig)}
              x={flip ? -(nr + 5) : nr + 5}
              y={0}
              textAnchor={flip ? 'end' : 'start'}
              dominantBaseline="middle"
              transform={`rotate(${flip ? bearing + 180 : bearing})`}
            >
              {n.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
