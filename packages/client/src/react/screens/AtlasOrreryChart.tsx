/* oxlint-disable jsx-a11y/prefer-tag-over-role -- the orrery's clickable kind nodes are SVG <g> elements; <button> is not renderable inside <svg>, so the g carries role="button" + tabIndex + Enter/Space key handling instead */
import { useEffect, useId, useRef, type CSSProperties, type JSX, type PointerEvent } from 'react';
import type { AtlasFkEdge, AtlasGraphNode } from '../../gateway-client.js';
import { cx } from '../ui/cx.js';
import AtlasOrreryCore from './AtlasOrreryCore.js';
import {
  ORRERY,
  type BearingLayout,
  type ViewTransform,
  dialArcPath,
  edgeBow,
  edgePath,
  fillStrokeOpacity,
  fillStrokeWidth,
  nodeRadius,
  packHueVar,
  polar,
  sectorFlipped,
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

/**
 * A question-chip highlight — a lens the parent computes ("what's connected
 * here?", "…heaviest?", "…unused?") and the chart applies through the SAME dim/
 * hot machinery hover uses: lit nodes/edges stay bright, the rest dims. It never
 * changes geometry, and hover always wins over it (a live readout overrides the
 * question so the two never fight for the same element).
 */
export interface AtlasHighlight {
  /** Physical table names to keep lit; every other node dims. */
  lit: ReadonlySet<string>;
  /** Predicate for the edges to keep lit; every other edge dims. */
  edgeLit: (edge: AtlasFkEdge) => boolean;
}

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
  /** At the `everything` detail level, each node gains a small second label
   *  line under its friendly name carrying its physical SQL table name — the
   *  machine truth surfaced. Off at every other level. */
  showPhysical: boolean;
  overlayArcs: readonly { id: string; d: string }[];
  readout: Readout;
  /** The active question-chip highlight, or `null` when no question is toggled.
   *  Applied only while nothing is hovered — a live readout takes precedence. */
  highlight: AtlasHighlight | null;
  /** The pan/zoom camera. Applied to the single viewport `<g>` that wraps every
   *  layer; it never changes the geometry beneath (see `ViewTransform`). */
  view: ViewTransform;
  /** Native wheel handler (see the effect below for why it is not a JSX prop):
   *  React registers `wheel` as a passive root listener, so `preventDefault`
   *  only bites when attached with `{ passive: false }` ourselves. */
  onWheel: (ev: WheelEvent) => void;
  /** Pointer-drag pan bookkeeping lives in the parent (it also owns the click
   *  suppression guard), so these just forward the raw pointer events. */
  onPointerDown: (ev: PointerEvent<SVGSVGElement>) => void;
  onPointerMove: (ev: PointerEvent<SVGSVGElement>) => void;
  onPointerUp: (ev: PointerEvent<SVGSVGElement>) => void;
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
  showPhysical,
  overlayArcs,
  readout,
  highlight,
  view,
  onWheel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onReadout,
  onRecenter,
}: AtlasOrreryChartProps): JSX.Element {
  // Unique per-mount prefix for the dial's <textPath> arc ids — two mounted
  // orreries (tests, previews) must never share element ids.
  const uid = useId();

  // A question highlight only bites while nothing is hovered — a live readout
  // (hover/focus) overrides it, so the two lensing systems never fight over the
  // same node. When active, non-lit nodes/edges dim and lit ones read as `hot`.
  const questionActive = highlight != null && readout.kind === 'idle';

  // Wheel-to-zoom must call preventDefault to stop the page scrolling under a
  // zoom gesture, but React attaches `wheel` to the root as a PASSIVE listener,
  // where preventDefault is inert. So we bind it natively with
  // `{ passive: false }` on the svg element. This is the one imperative seam in
  // an otherwise declarative, stateless leaf — no render state is held.
  const svgRef = useRef<SVGSVGElement | null>(null);
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onWheel]);

  return (
    <svg
      ref={svgRef}
      className={styles.orrery}
      viewBox={`0 0 ${ORRERY.view} ${ORRERY.view}`}
      role="img"
      aria-label={`Radial graph of the vault schema, centred on ${center}`}
      data-testid="atlas-orrery"
      data-center={center}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* The single viewport lens: every layer below rides this
          `translate(x y) scale(k)` camera, so pan/zoom moves the whole chart as
          one rigid body. Nothing inside recomputes from `view` — bearings,
          rings and edge paths stay in fixed viewBox space (the camera invariant
          in atlasOrreryGeometry.ts). */}
      <g
        data-testid="atlas-viewport"
        transform={`translate(${view.x.toFixed(3)} ${view.y.toFixed(3)}) scale(${view.k.toFixed(4)})`}
      >
        {/* graticule — concentric hop rings, labelled at 12 o'clock */}
        <g className={styles.graticule}>
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
              <text
                className={styles.ringTick}
                x={ORRERY.cx}
                y={ORRERY.cy - ring.r - 4}
                textAnchor="middle"
              >
                {ring.label}
              </text>
            </g>
          ))}
        </g>

        {/* the dial — per-pack sector arcs, boundary ticks, curved pack names.
          Bearings are fixed, so this bezel never moves when you re-centre; a
          sector whose kinds are all hidden (unreached machinery) stays in
          place but dims — the compass never lies about empty space. */}
        <g className={styles.dial}>
          {layout.sectors.map((s) => {
            const flip = sectorFlipped(s.midDeg);
            const arcId = `${uid}-sector-${s.pack}`;
            const pad = Math.min(2.4, s.spanDeg * 0.16);
            const tickIn = polar(s.startDeg, ORRERY.dialTickIn);
            const tickOut = polar(s.startDeg, ORRERY.dialTickOut);
            // The label arc is deliberately wider than the sector (centred on
            // midDeg) so a long pack name over a one-kind sector isn't clipped
            // by textPath's path-length cutoff.
            const labelR = flip ? ORRERY.sectorLabelR + 7 : ORRERY.sectorLabelR;
            const hot = readout.kind === 'node' && readout.node.pack === s.pack;
            const empty =
              s.pack !== centerNode?.pack && !visibleNodes.some((n) => n.pack === s.pack);
            return (
              <g
                key={s.pack}
                className={cx(styles.sector, hot && styles.sectorHot, empty && styles.sectorEmpty)}
                style={CSSVar('--sector-c', packHueVar(s.pack, packs))}
              >
                <path
                  className={styles.sectorArc}
                  d={dialArcPath(
                    s.startDeg + pad,
                    s.startDeg + s.spanDeg - pad,
                    ORRERY.dialR,
                    false,
                  )}
                />
                <line
                  className={styles.sectorTick}
                  x1={tickIn.x}
                  y1={tickIn.y}
                  x2={tickOut.x}
                  y2={tickOut.y}
                />
                <path
                  id={arcId}
                  fill="none"
                  d={dialArcPath(s.midDeg - 40, s.midDeg + 40, labelR, flip)}
                />
                <text className={styles.sectorName} textAnchor="middle">
                  <textPath href={`#${arcId}`} startOffset="50%">
                    {s.packLabel}
                  </textPath>
                </text>
              </g>
            );
          })}
        </g>

        {/* FK edges — pack-neutral, weighted by fill; ghosts dotted. The layer
            dims whenever anything is lensed — a hover readout OR an active
            question — leaving only the `hot` edges bright. */}
        <g
          className={cx(
            styles.edges,
            (readout.kind !== 'idle' || questionActive) && styles.edgesDimmed,
          )}
        >
          {drawEdges.map((e, ei) => {
            const fromDeg = layout.bearing.get(e.fromTable) ?? 0;
            const toDeg = layout.bearing.get(e.toTable) ?? 0;
            const a = polar(fromDeg, radiusOf(e.fromTable));
            const bIsCenter = e.toTable === center;
            const aIsCenter = e.fromTable === center;
            const bPos = bIsCenter
              ? { x: ORRERY.cx, y: ORRERY.cy }
              : polar(toDeg, radiusOf(e.toTable));
            const aPos = aIsCenter ? { x: ORRERY.cx, y: ORRERY.cy } : a;
            const bow = aIsCenter || bIsCenter ? 1 : edgeBow(fromDeg, toDeg);
            const d = edgePath(aPos.x, aPos.y, bPos.x, bPos.y, bow);
            const hot =
              (readout.kind === 'edge' &&
                readout.edge.fromTable === e.fromTable &&
                readout.edge.col === e.col &&
                readout.edge.toTable === e.toTable) ||
              (readout.kind === 'node' &&
                (readout.node.physical === e.fromTable || readout.node.physical === e.toTable)) ||
              (questionActive && (highlight?.edgeLit(e) ?? false));
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
                  style={{
                    ...CSSVar('--dly', `${360 + (ei % 24) * 14}ms`),
                    ...(e.ghost
                      ? undefined
                      : {
                          strokeWidth: fillStrokeWidth(e.fill, maxFill),
                          strokeOpacity: fillStrokeOpacity(e.fill, maxFill, e.notnull),
                        }),
                  }}
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

        {/* the centre — brass plate, tick bezel + the measured-fact caption */}
        <AtlasOrreryCore
          center={center}
          centerNode={centerNode}
          isRoot={isRoot}
          inDeg={inDeg}
          outDeg={outDeg}
          pct={pct}
          centerEdgeCount={centerEdgeCount}
          edgeCount={edgeCount}
        />

        {/* the kinds */}
        {visibleNodes.map((n) => {
          const hop = hops.get(n.physical) ?? null;
          const pos = polar(layout.bearing.get(n.physical) ?? 0, radiusOf(n.physical));
          const nr = nodeRadius(rows.get(n.physical));
          const bearing = layout.bearing.get(n.physical) ?? 0;
          const b = ((bearing % 360) + 360) % 360;
          const flip = b > 90 && b < 270;
          const big = (rows.get(n.physical) ?? 0) > 4000;
          // Label stagger: adjacent kinds in a pack alternate between two radial
          // distances so dense sectors stay legible.
          const labelGap = layout.labelTier.get(n.physical) === 1 ? nr + 14 : nr + 5;
          // Reveal choreography: rings bloom outward, sweeping clockwise from
          // 12 o'clock within each ring.
          const dly = (hop === null ? 4 : hop) * 110 + (((b + 90) % 360) / 360) * 220;
          const lit = questionActive && (highlight?.lit.has(n.physical) ?? false);
          const hot =
            (readout.kind === 'node' && readout.node.physical === n.physical) ||
            (readout.kind === 'edge' &&
              (readout.edge.fromTable === n.physical || readout.edge.toTable === n.physical)) ||
            lit;
          // A question dims every node it does not light; hover never dims nodes
          // (only its edge layer), so `nodeDim` is a question-only state.
          const dim = questionActive && !lit;
          const display = n.friendly ?? n.label;
          return (
            <g
              role="button"
              key={n.physical}
              className={cx(styles.node, hot && styles.nodeHot, dim && styles.nodeDim)}
              style={{
                ...CSSVar('--node-c', packHueVar(n.pack, packs)),
                ...CSSVar('--dly', `${Math.round(dly)}ms`),
              }}
              transform={`translate(${pos.x.toFixed(1)} ${pos.y.toFixed(1)})`}
              tabIndex={0}
              aria-label={`${display} (${n.physical}) — re-centre`}
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
                x={flip ? -labelGap : labelGap}
                y={showPhysical ? -3 : 0}
                textAnchor={flip ? 'end' : 'start'}
                dominantBaseline="middle"
                transform={`rotate(${flip ? bearing + 180 : bearing})`}
              >
                {display}
              </text>
              {/* the raw SQL name, surfaced only at the `everything` level as a
                  small second line under the friendly name — the machine truth,
                  never conflated with the human label above it */}
              {showPhysical ? (
                <text
                  className={styles.nodeSubLabel}
                  data-testid="atlas-node-physical"
                  x={flip ? -labelGap : labelGap}
                  y={6}
                  textAnchor={flip ? 'end' : 'start'}
                  dominantBaseline="middle"
                  transform={`rotate(${flip ? bearing + 180 : bearing})`}
                >
                  {n.physical}
                </text>
              ) : null}
            </g>
          );
        })}
      </g>
    </svg>
  );
}
