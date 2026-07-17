import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { AtlasAuthoredLink, AtlasGraphPayload } from '../../gateway-client.js';
import Icon from '../ui/Icon.js';
import AtlasOrreryChart, { type Readout } from './AtlasOrreryChart.js';
import AtlasOrreryPanel from './AtlasOrreryPanel.js';
import {
  ORRERY,
  aggregateRelationChips,
  allocateBearings,
  bfsHops,
  edgePath,
  polar,
  ringRadius,
  rowsByTable,
  sortedPacks,
} from './atlasOrreryGeometry.js';
import styles from './AtlasRelationsTab.module.css';

// Relations tab — the orrery (issue #441 B2). A party-centred radial star chart
// of the vault's kinds, drawn as inline SVG (no chart library). Kinds sit on
// concentric rings by hop distance and on FIXED per-pack bearings; clicking a
// kind re-centres the whole chart, animating radius only so pack identity stays
// a stable compass direction (the anti-hairball invariant lives in
// atlasOrreryGeometry.ts). Edges are the schema's FK columns, weighted by how
// many child rows actually fill them; ghost edges (fill 0) are dotted. The
// authored-link overlay (core_link) is a SEPARATE mechanism, surfaced through
// the relation-vocabulary chips — never conflated with structural FKs. This
// orchestrator owns all state; the chart body and side panel are presentational
// leaves (AtlasOrreryChart / AtlasOrreryPanel).

export interface AtlasRelationsTabProps {
  /** The `/_vault/atlas/graph` payload, or `null` before it lands / on error. */
  graph: AtlasGraphPayload | null;
}

const fmt = (n: number): string => n.toLocaleString('en-US');

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (): void => setReduced(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return reduced;
}

export default function AtlasRelationsTab({ graph }: AtlasRelationsTabProps): JSX.Element {
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

  // Re-seat the centre if a fresh graph arrives.
  useEffect(() => {
    if (!graph) return;
    setCenter(graph.center);
    setTrail([graph.center]);
    setReadout({ kind: 'idle' });
    setActiveRels(new Set());
  }, [graph]);

  // Hop distances from the current centre — undirected BFS, memoized per centre.
  const hops = useMemo(() => bfsHops(center, edges, allTables), [center, edges, allTables]);
  const targetRadius = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of nodes) m.set(n.physical, ringRadius(hops.get(n.physical) ?? null));
    return m;
  }, [nodes, hops]);

  // ── Radius-only re-centre animation ─────────────────────────────────────
  const startRadiusRef = useRef<Map<string, number>>(new Map());
  const [progress, setProgress] = useState(1);
  useEffect(() => {
    const start = startRadiusRef.current;
    // Snap (no rAF) on first paint, under reduced-motion, and in any host
    // without `matchMedia` (jsdom / non-browser) — there, animating would only
    // schedule frames that never composite.
    const canAnimate =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      typeof requestAnimationFrame === 'function';
    const snap = start.size === 0 || reduced || !canAnimate;
    if (snap) {
      startRadiusRef.current = new Map(targetRadius);
      setProgress(1);
      return;
    }
    setProgress(0);
    const t0 = performance.now();
    const dur = 640;
    const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
    let raf = requestAnimationFrame(function step(now: number) {
      const t = Math.min(1, (now - t0) / dur);
      setProgress(ease(t));
      if (t < 1) raf = requestAnimationFrame(step);
      else startRadiusRef.current = new Map(targetRadius);
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#441) animate only on centre change
  }, [center]);

  const radiusOf = useCallback(
    (physical: string): number => {
      const target = targetRadius.get(physical) ?? ORRERY.ringUnreached;
      if (progress >= 1) return target;
      const start = startRadiusRef.current.get(physical) ?? target;
      return start + (target - start) * progress;
    },
    [targetRadius, progress],
  );

  const recenter = useCallback(
    (physical: string) => {
      if (physical === center) return;
      setCenter(physical);
      setTrail((prev) => {
        const i = prev.indexOf(physical);
        const next = i >= 0 ? prev.slice(0, i + 1) : [...prev, physical];
        return next.length > 6 ? [...next.slice(0, 1), ...next.slice(-5)] : next;
      });
      const node = nodeByPhysical.get(physical);
      if (node) setReadout({ kind: 'node', node, hop: 0 });
    },
    [center, nodeByPhysical],
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
      const a = polar(layout.bearing.get(from.physical) ?? 0, radiusOf(from.physical));
      const b = polar(layout.bearing.get(to.physical) ?? 0, radiusOf(to.physical));
      out.push({ id: `${key}-${i}`, d: edgePath(a.x, a.y, b.x, b.y, 0.7) });
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

  // Rendered edges: both endpoints must resolve to a node and it can't be a
  // self-reference (those are drawn as a glyph on the node, not a loop edge).
  const drawEdges = edges.filter(
    (e) => !e.selfRef && nodeByPhysical.has(e.fromTable) && nodeByPhysical.has(e.toTable),
  );

  // Machinery kinds are hidden unless the current centre can reach them — the
  // chart stays about the ontology, not the plumbing. Ontology kinds always
  // render (an unreachable one belongs on the "unreached" ring, honestly shown).
  const visibleNodes = nodes.filter((n) => {
    if (n.physical === center) return false; // the centre is the brass plate
    if (n.packKind === 'ontology') return true;
    return hops.get(n.physical) != null;
  });

  return (
    <div className={styles.tab}>
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
            overlayArcs={overlayArcs}
            readout={readout}
            onReadout={setReadout}
            onRecenter={recenter}
          />
        </div>

        <AtlasOrreryPanel
          center={center}
          rootCenter={graph.center}
          isRoot={isRoot}
          trail={trail}
          readout={readout}
          edges={edges}
          rows={rows}
          relChips={relChips}
          activeRels={activeRels}
          onRecenter={recenter}
          onBackToRoot={backToRoot}
          onToggleRel={toggleRel}
        />
      </div>

      {/* measured-fact caption strip — all derived, never hardcoded */}
      <div className={styles.caption} data-testid="atlas-caption">
        <span className={styles.captionItem}>
          <b className={styles.captionNum}>{fmt(graph.edgeCount)}</b> structural references
        </span>
        <span className={styles.captionItem}>
          <b className={styles.captionNum}>{fmt(notnullCount)}</b> NOT NULL · mandatory
        </span>
        <span className={styles.captionItem}>
          <b className={styles.captionNum}>{fmt(graph.edgeCount - notnullCount)}</b> nullable
        </span>
        <span className={styles.captionItem}>
          <b className={styles.captionNum}>{fmt(graph.centerEdgeCount)}</b> → {graph.center} ({pct}
          %)
        </span>
        <span className={styles.captionItem}>
          <b className={styles.captionNum}>{fmt(ghostCount)}</b> ghost edges
        </span>
        <span className={styles.captionItem}>
          <b className={styles.captionNum}>{fmt(graph.selfRefCount)}</b> self-references
        </span>
        <span className={styles.captionItem}>
          <b className={styles.captionNum}>{fmt(graph.island.length)}</b> unreached from{' '}
          {graph.center}
        </span>
      </div>
    </div>
  );
}
