import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import type { AtlasAuthoredLink, AtlasFkEdge, AtlasGraphPayload } from '../../gateway-client.js';
import Icon from '../ui/Icon.js';
import AtlasOrreryChart, { type AtlasHighlight, type Readout } from './AtlasOrreryChart.js';
import AtlasOrreryPanel from './AtlasOrreryPanel.js';
import { useOrreryCamera } from './atlasOrreryCamera.js';
import { useRecenterAnimation, usePrefersReducedMotion } from './atlasOrreryMotion.js';
import { useSampleRows, type SampleRowsFetcher } from './atlasSampleRows.js';
import {
  type AtlasDetailLevel,
  aggregateRelationChips,
  allocateBearings,
  bfsHops,
  edgeBow,
  edgePath,
  edgeVisibleAtLevel,
  polar,
  ringRadius,
  rowsByTable,
  sortedPacks,
  visibleAtLevel,
} from './atlasOrreryGeometry.js';
import styles from './AtlasRelationsTab.module.css';

// Relations tab — the orrery (issue #441 B2, "Map" redesign #519). A
// party-centred radial star chart of the vault's kinds (inline SVG). Kinds sit
// on concentric rings by hop distance and on FIXED per-pack bearings; clicking a
// kind re-centres, animating radius only so pack identity stays a stable compass
// direction (the anti-hairball invariant lives in atlasOrreryGeometry.ts). Edges
// are FK columns weighted by fill; ghosts (fill 0) are dotted. The authored-link
// overlay (core_link) is a SEPARATE mechanism surfaced through the relation
// chips — never conflated with FKs. This orchestrator owns all state; the chart
// body, centre plate, side panel, camera and motion are leaves/hooks.

export interface AtlasRelationsTabProps {
  /** The `/_vault/atlas/graph` payload, or `null` before it lands / on error. */
  graph: AtlasGraphPayload | null;
  /**
   * Fetch up to a few sample rows of a kind, by logical name — the "A few of
   * yours" panel section. Optional: wired to `browseRows` in AtlasScreen, and
   * omitted in tests/hosts that don't want the fetch, where the section simply
   * never appears. Never per-hover — the parent fetches for the CENTRE only.
   */
  fetchSampleRows?: SampleRowsFetcher;
}

const fmt = (n: number): string => n.toLocaleString('en-US');

/** The three question chips above the stage — each a saved "lens" over the
 *  chart. `q` is the stable key (also the `data-q` attribute); one is active at
 *  a time, and clicking the active one clears it. */
const QUESTIONS: readonly { q: 'connected' | 'heaviest' | 'unused'; label: string }[] = [
  { q: 'connected', label: "What's connected here?" },
  { q: 'heaviest', label: "Where's my data heaviest?" },
  { q: 'unused', label: "What's unused?" },
];
type QuestionKey = (typeof QUESTIONS)[number]['q'];

/** The three detail-dial positions, tightest lens first. Each is an honest
 *  FILTER over the real schema (never an aggregation — see `visibleAtLevel` for
 *  the filter-not-aggregate rationale and the bearings-stay-fixed invariant):
 *  Simple shows only kinds that provably carry data; Standard is today's lens;
 *  Everything reveals the unreachable machinery and the raw SQL names too. */
const LEVELS: readonly { level: AtlasDetailLevel; label: string }[] = [
  { level: 'simple', label: 'Simple' },
  { level: 'standard', label: 'Standard' },
  { level: 'everything', label: 'Everything' },
];

export default function AtlasRelationsTab({
  graph,
  fetchSampleRows,
}: AtlasRelationsTabProps): JSX.Element {
  const reduced = usePrefersReducedMotion();

  // ── Static derivations (independent of the current centre) ──────────────
  const nodes = useMemo(() => graph?.nodes ?? [], [graph]);
  const edges = useMemo(() => graph?.fkEdges ?? [], [graph]);
  const packs = useMemo(() => sortedPacks(nodes), [nodes]);
  const layout = useMemo(() => allocateBearings(nodes), [nodes]);
  const rows = useMemo(() => rowsByTable(edges), [edges]);
  const nodeByPhysical = useMemo(() => new Map(nodes.map((n) => [n.physical, n])), [nodes]);
  const allTables = useMemo(() => nodes.map((n) => n.physical), [nodes]);
  const maxFill = useMemo(() => edges.reduce((m, e) => Math.max(m, e.fill), 1), [edges]);
  // Authored-link endpoints are typed by the ontology type string; match it
  // against a node's logical OR physical name so an arc can be placed.
  const nodeByType = useMemo(() => {
    const m = new Map<string, (typeof nodes)[number]>();
    for (const n of nodes) {
      m.set(n.logical, n);
      m.set(n.physical, n);
    }
    return m;
  }, [nodes]);

  // ── Centre + breadcrumb state ───────────────────────────────────────────
  const [center, setCenter] = useState<string>(graph?.center ?? '');
  const [trail, setTrail] = useState<string[]>(graph ? [graph.center] : []);
  const [readout, setReadout] = useState<Readout>({ kind: 'idle' });
  const [activeRels, setActiveRels] = useState<Set<string>>(new Set());
  // The active question-chip lens, or `null` when none is toggled.
  const [question, setQuestion] = useState<QuestionKey | null>(null);
  // The detail dial — a per-mount FILTER over which kinds/edges are visible.
  // Defaults to `simple` (the "your data" lens). Turning it never resets the
  // camera or the centre; nodes at fixed bearings appearing/disappearing is the
  // whole transition (the existing bloom animation covers it).
  const [level, setLevel] = useState<AtlasDetailLevel>('simple');

  // ── Pan/zoom camera ─────────────────────────────────────────────────────
  // A lens over the chart body, never a layout change (see atlasOrreryCamera.ts).
  // `consumeDrag()` swallows the click a pan would otherwise fire as a re-centre.
  const { view, resetView, consumeDrag, zoomBy, handlers } = useOrreryCamera();
  const { onWheel, onPointerDown, onPointerMove, onPointerUp } = handlers;

  // Re-seat the centre if a fresh graph arrives.
  useEffect(() => {
    if (!graph) return;
    setCenter(graph.center);
    setTrail([graph.center]);
    setReadout({ kind: 'idle' });
    setActiveRels(new Set());
    setQuestion(null);
    resetView();
  }, [graph, resetView]);

  // Hop distances from the current centre — undirected BFS, memoized per centre.
  const hops = useMemo(() => bfsHops(center, edges, allTables), [center, edges, allTables]);
  const targetRadius = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of nodes) m.set(n.physical, ringRadius(hops.get(n.physical) ?? null));
    return m;
  }, [nodes, hops]);

  // ── Radius-only re-centre animation ─────────────────────────────────────
  // Bearings never animate (the anti-hairball invariant); only each kind's
  // radial distance eases to its new ring on a centre change (atlasOrreryMotion).
  const radiusOf = useRecenterAnimation(center, targetRadius, reduced);

  const recenter = useCallback(
    (physical: string) => {
      if (physical === center) return;
      setCenter(physical);
      // Travelling re-frames: reset the camera so the new centre always lands
      // centred and at 1:1, never off-screen from a prior pan/zoom.
      resetView();
      setTrail((prev) => {
        const i = prev.indexOf(physical);
        const next = i >= 0 ? prev.slice(0, i + 1) : [...prev, physical];
        return next.length > 6 ? [...next.slice(0, 1), ...next.slice(-5)] : next;
      });
      const node = nodeByPhysical.get(physical);
      if (node) setReadout({ kind: 'node', node, hop: 0 });
    },
    [center, nodeByPhysical, resetView],
  );

  // Node activation from the chart, guarded against the click a drag fires: a
  // pan gesture records a drag, so `consumeDrag()` swallows the trailing click
  // once. Keyboard activation never trips it (no pointer sequence).
  const onNodeRecenter = useCallback(
    (physical: string) => {
      if (consumeDrag()) return;
      recenter(physical);
    },
    [recenter, consumeDrag],
  );

  const backToRoot = useCallback(() => {
    if (graph) recenter(graph.center);
  }, [graph, recenter]);

  // ── Relation vocabulary chips (authored links) ──────────────────────────
  const relChips = useMemo(() => aggregateRelationChips(graph?.authoredLinks ?? []), [graph]);

  // Authored arcs to overlay for the toggled-on relations, resolved to node
  // endpoints. A pair that names two kinds neither of which is rendered is
  // simply not drawable — skipped, never faked.
  const overlayArcs = useMemo(() => {
    if (activeRels.size === 0) return [];
    const out: { id: string; d: string }[] = [];
    (graph?.authoredLinks ?? []).forEach((link: AtlasAuthoredLink, i) => {
      const key = link.relationLabel ?? link.relationConceptId;
      if (!activeRels.has(key)) return;
      const from = nodeByType.get(link.fromType);
      const to = nodeByType.get(link.toType);
      if (!from || !to || from.physical === to.physical) return;
      const fromDeg = layout.bearing.get(from.physical) ?? 0;
      const toDeg = layout.bearing.get(to.physical) ?? 0;
      const a = polar(fromDeg, radiusOf(from.physical));
      const b = polar(toDeg, radiusOf(to.physical));
      // Bowed a touch deeper than FK edges so the overlay reads as its own
      // layer, but still separation-scaled (see edgeBow) to avoid hairpins.
      const bow = Math.max(0.7, edgeBow(fromDeg, toDeg) - 0.08);
      out.push({ id: `${key}-${i}`, d: edgePath(a.x, a.y, b.x, b.y, bow) });
    });
    return out;
  }, [activeRels, graph, nodeByType, layout, radiusOf]);

  const toggleRel = useCallback((key: string) => {
    setActiveRels((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // ── Question chips ──────────────────────────────────────────────────────
  // Each chip resolves to a `highlight` lens: a set of physical tables to keep
  // lit + a predicate for the edges to keep lit. The chart dims everything else
  // through the same machinery hover uses (and hover overrides a question). All
  // three lenses are derived from real payload numbers — never a guess.
  const toggleQuestion = useCallback((q: QuestionKey) => {
    setQuestion((prev) => (prev === q ? null : q));
  }, []);

  const highlight = useMemo<AtlasHighlight | null>(() => {
    if (question === null) return null;
    if (question === 'connected') {
      // The centre's direct FK neighbours (hop 1) + the edges touching it.
      const lit = new Set<string>([center]);
      for (const [t, h] of hops) if (h === 1) lit.add(t);
      return {
        lit,
        edgeLit: (e: AtlasFkEdge) => e.fromTable === center || e.toTable === center,
      };
    }
    if (question === 'heaviest') {
      // Kinds whose row count is >= 40% of the busiest kind's.
      let max = 0;
      for (const v of rows.values()) if (v > max) max = v;
      const threshold = max * 0.4;
      const lit = new Set<string>();
      for (const [t, v] of rows) if (v > 0 && v >= threshold) lit.add(t);
      return { lit, edgeLit: (e: AtlasFkEdge) => lit.has(e.fromTable) && lit.has(e.toTable) };
    }
    // unused — ghost edges + kinds with zero or unknown row counts.
    const lit = new Set<string>();
    for (const n of nodes) {
      const r = rows.get(n.physical);
      if (r === undefined || r === 0) lit.add(n.physical);
    }
    return { lit, edgeLit: (e: AtlasFkEdge) => e.ghost };
  }, [question, center, hops, rows, nodes]);

  // Sample rows for the current centre only (never per-hover), keyed by logical.
  const centerLogical = nodeByPhysical.get(center)?.logical;
  const sample = useSampleRows(centerLogical, fetchSampleRows);

  // ── Empty state ─────────────────────────────────────────────────────────
  if (!graph) {
    return (
      <div className={styles.empty} data-testid="atlas-relations-empty">
        <span className={styles.emptyIcon}>
          <Icon name="Globe" size={22} />
        </span>
        <p className={styles.emptyText}>
          The relations graph hasn’t loaded. It maps every kind by how much each structural
          reference actually carries.
        </p>
      </div>
    );
  }

  const pct = graph.edgeCount > 0 ? Math.round((graph.centerEdgeCount / graph.edgeCount) * 100) : 0;
  const inDeg = edges.filter((e) => e.toTable === center).length;
  const outDeg = edges.filter((e) => e.fromTable === center && !e.selfRef).length;
  const notnullCount = edges.filter((e) => e.notnull).length;
  const ghostCount = edges.filter((e) => e.ghost).length;
  const isRoot = center === graph.center;
  const centerNode = nodeByPhysical.get(center);

  // ── The detail-dial filter ──────────────────────────────────────────────
  // Which kinds/edges show is a pure FILTER of the current level over the real
  // schema (see `visibleAtLevel` — never an aggregation; the centre is never
  // hidden). Bearings and hop distance are computed once over the FULL graph, so
  // the dial only makes nodes appear/disappear at their fixed bearings.
  const visCtx = { center, hops, rows, edges };
  const visibleNodes = nodes.filter(
    (n) => n.physical !== center && visibleAtLevel(level, n, visCtx),
  );

  // Rendered edges: both endpoints visible, self-refs dropped (a glyph, not a
  // loop), and — at Simple only — ghost edges nothing fills yet are hidden.
  const visibleSet = new Set(visibleNodes.map((n) => n.physical));
  visibleSet.add(center);
  const drawEdges = edges.filter((e) => edgeVisibleAtLevel(level, e, visibleSet));

  // ── Honest tally of what this lens hides ─────────────────────────────────
  // Every number derived, never hardcoded. Compared against the FULL schema:
  // a non-centre kind or a non-self-ref edge that this level does not render is
  // "hidden". At Simple, every hidden kind is either empty (no provable data)
  // or plumbing (machinery); at Standard, every hidden kind is unreachable
  // machinery (ontology and reachable machinery always show). Everything hides
  // nothing, so instead it names the unreachable machinery it just revealed.
  const nonCenterKinds = nodes.filter((n) => n.physical !== center).length;
  const hiddenKinds = nonCenterKinds - visibleNodes.length;
  const drawableEdges = edges.filter((e) => !e.selfRef).length;
  const hiddenEdges = drawableEdges - drawEdges.length;
  const unreachableMachinery = nodes.filter(
    (n) => n.physical !== center && n.packKind === 'machinery' && hops.get(n.physical) == null,
  ).length;
  const lensExtras: { key: string; num: number; label: string }[] = [];
  if (level === 'everything') {
    if (unreachableMachinery > 0)
      lensExtras.push({
        key: 'revealed',
        num: unreachableMachinery,
        label: 'plumbing kinds beyond reach, now shown',
      });
  } else {
    if (hiddenKinds > 0)
      lensExtras.push({
        key: 'hidden-kinds',
        num: hiddenKinds,
        label:
          level === 'simple' ? 'kinds hidden (empty or plumbing)' : 'plumbing kinds beyond reach',
      });
    if (hiddenEdges > 0)
      lensExtras.push({ key: 'hidden-edges', num: hiddenEdges, label: 'connections hidden' });
  }

  const rootFriendly = nodeByPhysical.get(graph.center)?.friendly ?? graph.center;
  const centerRows = rows.get(center);

  return (
    <div className={styles.tab}>
      <div className={styles.head}>
        {/* question chips — saved lenses over the chart, one active at a time */}
        <div className={styles.questions} role="group" aria-label="Ask the map">
          {QUESTIONS.map((qq) => {
            const on = question === qq.q;
            return (
              <button
                key={qq.q}
                type="button"
                className={styles.qChip}
                aria-pressed={on}
                data-testid="atlas-question-chip"
                data-q={qq.q}
                onClick={() => toggleQuestion(qq.q)}
              >
                {qq.label}
              </button>
            );
          })}
        </div>

        {/* the detail dial — a three-position FILTER over which kinds/edges
            show. Simple (default) = only kinds that provably carry data;
            Standard = today's lens; Everything = also the unreachable machinery
            + the raw SQL names. A segmented control; one position active. */}
        <div
          className={styles.detailDial}
          role="group"
          aria-label="Level of detail"
          data-testid="atlas-detail-dial"
        >
          {LEVELS.map((lv) => {
            const on = level === lv.level;
            return (
              <button
                key={lv.level}
                type="button"
                className={styles.segBtn}
                aria-pressed={on}
                data-level={lv.level}
                onClick={() => setLevel(lv.level)}
              >
                {lv.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className={styles.instrument}>
        <div className={styles.stage}>
          <AtlasOrreryChart
            center={center}
            centerNode={centerNode}
            isRoot={isRoot}
            inDeg={inDeg}
            outDeg={outDeg}
            pct={pct}
            centerEdgeCount={graph.centerEdgeCount}
            edgeCount={graph.edgeCount}
            layout={layout}
            radiusOf={radiusOf}
            drawEdges={drawEdges}
            maxFill={maxFill}
            visibleNodes={visibleNodes}
            hops={hops}
            rows={rows}
            packs={packs}
            showPhysical={level === 'everything'}
            overlayArcs={overlayArcs}
            readout={readout}
            highlight={highlight}
            view={view}
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onReadout={setReadout}
            onRecenter={onNodeRecenter}
          />
          {/* Zoom controls overlaid on the well — HTML buttons (not SVG), so
              they zoom about the viewBox centre with no CTM maths and stay
              keyboard-reachable. Pan/wheel live on the svg itself. */}
          <div className={styles.zoomCtl}>
            <button
              type="button"
              className={styles.zoomBtn}
              aria-label="Zoom in"
              data-testid="atlas-zoom-in"
              onClick={() => zoomBy(1.35)}
            >
              +
            </button>
            <button
              type="button"
              className={styles.zoomBtn}
              aria-label="Zoom out"
              data-testid="atlas-zoom-out"
              onClick={() => zoomBy(1 / 1.35)}
            >
              −
            </button>
            <button
              type="button"
              className={styles.zoomBtn}
              aria-label="Reset view"
              data-testid="atlas-zoom-reset"
              onClick={resetView}
            >
              ⟲
            </button>
          </div>
        </div>

        <AtlasOrreryPanel
          center={center}
          rootCenter={graph.center}
          isRoot={isRoot}
          trail={trail}
          readout={readout}
          edges={edges}
          rows={rows}
          packs={packs}
          nodeByPhysical={nodeByPhysical}
          sample={sample}
          centerRows={centerRows}
          relChips={relChips}
          activeRels={activeRels}
          onRecenter={recenter}
          onBackToRoot={backToRoot}
          onToggleRel={toggleRel}
        />
      </div>

      {/* measured-fact caption strip — every number derived, never hardcoded;
          only the labels are plain-language (built-in connections, People, …) */}
      <div className={styles.caption} data-testid="atlas-caption">
        <span className={styles.captionItem}>
          <b className={styles.captionNum}>{fmt(graph.edgeCount)}</b> built-in connections
        </span>
        <span className={styles.captionItem}>
          <b className={styles.captionNum}>{fmt(notnullCount)}</b> always filled in
        </span>
        <span className={styles.captionItem}>
          <b className={styles.captionNum}>{fmt(graph.edgeCount - notnullCount)}</b> optional
        </span>
        <span className={styles.captionItem}>
          <b className={styles.captionNum}>{fmt(graph.centerEdgeCount)}</b> point to {rootFriendly}{' '}
          ({pct}%)
        </span>
        <span className={styles.captionItem}>
          <b className={styles.captionNum}>{fmt(ghostCount)}</b> nothing uses yet
        </span>
        <span className={styles.captionItem}>
          <b className={styles.captionNum}>{fmt(graph.selfRefCount)}</b> point to their own kind
        </span>
        <span className={styles.captionItem}>
          <b className={styles.captionNum}>{fmt(graph.island.length)}</b> not reachable from{' '}
          {rootFriendly}
        </span>
        {/* the lens tally — what the active detail level hides (or, at
            Everything, what it just revealed). Derived from the same visible
            sets the chart draws, never hardcoded. */}
        {lensExtras.map((x) => (
          <span key={x.key} className={styles.captionItem} data-testid="atlas-caption-lens">
            <b className={styles.captionNum}>{fmt(x.num)}</b> {x.label}
          </span>
        ))}
      </div>
    </div>
  );
}
