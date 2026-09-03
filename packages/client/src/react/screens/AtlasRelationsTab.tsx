import { useCallback, useMemo, useState } from "react";
import type { JSX } from "react";

import type {
  AtlasAuthoredLink,
  AtlasFkEdge,
  AtlasGraphPayload,
} from "../../gateway-client.js";
import Icon from "../ui/Icon.js";
import { useOrreryCamera } from "./atlasOrreryCamera.js";
import AtlasOrreryChart from "./AtlasOrreryChart.js";
import type { AtlasHighlight, Readout } from "./AtlasOrreryChart.js";
import {
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
} from "./atlasOrreryGeometry.js";
import type { AtlasDetailLevel } from "./atlasOrreryGeometry.js";
import {
  useRecenterAnimation,
  usePrefersReducedMotion,
} from "./atlasOrreryMotion.js";
import AtlasOrreryPanel from "./AtlasOrreryPanel.js";
import { LEVELS, QUESTIONS, fmt } from "./atlasRelationsMeta.js";
import type { QuestionKey } from "./atlasRelationsMeta.js";
import { useSampleRows } from "./atlasSampleRows.js";
import type { SampleRowsFetcher } from "./atlasSampleRows.js";

import styles from "./AtlasRelationsTab.module.css";

export interface AtlasRelationsTabProps {
  graph: AtlasGraphPayload | null;
  fetchSampleRows?: SampleRowsFetcher;
}

export default function AtlasRelationsTab({
  graph,
  fetchSampleRows,
}: AtlasRelationsTabProps): JSX.Element {
  const reduced = usePrefersReducedMotion();

  const nodes = useMemo(() => graph?.nodes ?? [], [graph]);
  const edges = useMemo(() => graph?.fkEdges ?? [], [graph]);
  const packs = useMemo(() => sortedPacks(nodes), [nodes]);
  const layout = useMemo(() => allocateBearings(nodes), [nodes]);
  const rows = useMemo(() => rowsByTable(edges), [edges]);
  const nodeByPhysical = useMemo(
    () => new Map(nodes.map((n) => [n.physical, n])),
    [nodes]
  );
  const allTables = useMemo(() => nodes.map((n) => n.physical), [nodes]);
  const maxFill = useMemo(
    () => edges.reduce((m, e) => Math.max(m, e.fill), 1),
    [edges]
  );
  const nodeByType = useMemo(() => {
    const m = new Map<string, (typeof nodes)[number]>();
    for (const n of nodes) {
      m.set(n.logical, n);
      m.set(n.physical, n);
    }
    return m;
  }, [nodes]);

  const [center, setCenter] = useState<string>(graph?.center ?? "");
  const [trail, setTrail] = useState<string[]>(graph ? [graph.center] : []);
  const [readout, setReadout] = useState<Readout>({ kind: "idle" });
  const [activeRels, setActiveRels] = useState<Set<string>>(new Set());
  const [question, setQuestion] = useState<QuestionKey | null>(null);
  const [level, setLevel] = useState<AtlasDetailLevel>("simple");

  const { view, resetView, consumeDrag, zoomBy, handlers } = useOrreryCamera();
  const { onWheel, onPointerDown, onPointerMove, onPointerUp } = handlers;

  const [seenGraph, setSeenGraph] = useState(graph);
  if (seenGraph !== graph) {
    setSeenGraph(graph);
    if (graph) {
      setCenter(graph.center);
      setTrail([graph.center]);
      setReadout({ kind: "idle" });
      setActiveRels(new Set());
      setQuestion(null);
      resetView();
    }
  }

  const hops = useMemo(
    () => bfsHops(center, edges, allTables),
    [center, edges, allTables]
  );
  const targetRadius = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of nodes)
      m.set(n.physical, ringRadius(hops.get(n.physical) ?? null));
    return m;
  }, [nodes, hops]);

  const radiusOf = useRecenterAnimation(center, targetRadius, reduced);

  const recenter = useCallback(
    (physical: string) => {
      if (physical === center) return;
      setCenter(physical);
      resetView();
      setTrail((prev) => {
        const i = prev.indexOf(physical);
        const next = i >= 0 ? prev.slice(0, i + 1) : [...prev, physical];
        return next.length > 6
          ? [...next.slice(0, 1), ...next.slice(-5)]
          : next;
      });
      const node = nodeByPhysical.get(physical);
      if (node) setReadout({ kind: "node", node, hop: 0 });
    },
    [center, nodeByPhysical, resetView]
  );

  const onNodeRecenter = useCallback(
    (physical: string) => {
      if (consumeDrag()) return;
      recenter(physical);
    },
    [recenter, consumeDrag]
  );

  const backToRoot = useCallback(() => {
    if (graph) recenter(graph.center);
  }, [graph, recenter]);

  const relChips = useMemo(
    () => aggregateRelationChips(graph?.authoredLinks ?? []),
    [graph]
  );

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

  const toggleQuestion = useCallback((q: QuestionKey) => {
    setQuestion((prev) => (prev === q ? null : q));
  }, []);

  const highlight = useMemo<AtlasHighlight | null>(() => {
    if (question === null) return null;
    if (question === "connected") {
      const lit = new Set<string>([center]);
      for (const [t, h] of hops) if (h === 1) lit.add(t);
      return {
        lit,
        edgeLit: (e: AtlasFkEdge) =>
          e.fromTable === center || e.toTable === center,
      };
    }
    if (question === "heaviest") {
      let max = 0;
      for (const v of rows.values()) if (v > max) max = v;
      const threshold = max * 0.4;
      const lit = new Set<string>();
      for (const [t, v] of rows) if (v > 0 && v >= threshold) lit.add(t);
      return {
        lit,
        edgeLit: (e: AtlasFkEdge) => lit.has(e.fromTable) && lit.has(e.toTable),
      };
    }
    const lit = new Set<string>();
    for (const n of nodes) {
      const r = rows.get(n.physical);
      if (r === undefined || r === 0) lit.add(n.physical);
    }
    return { lit, edgeLit: (e: AtlasFkEdge) => e.ghost };
  }, [question, center, hops, rows, nodes]);

  const centerLogical = nodeByPhysical.get(center)?.logical;
  const sample = useSampleRows(centerLogical, fetchSampleRows);

  if (!graph) {
    return (
      <div className={styles.empty} data-testid="atlas-relations-empty">
        <span className={styles.emptyIcon}>
          <Icon name="Globe" size={22} />
        </span>
        <p className={styles.emptyText}>The relations graph hasn’t loaded.</p>
      </div>
    );
  }

  const pct =
    graph.edgeCount > 0
      ? Math.round((graph.centerEdgeCount / graph.edgeCount) * 100)
      : 0;
  const inDeg = edges.filter((e) => e.toTable === center).length;
  const outDeg = edges.filter(
    (e) => e.fromTable === center && !e.selfRef
  ).length;
  const notnullCount = edges.filter((e) => e.notnull).length;
  const ghostCount = edges.filter((e) => e.ghost).length;
  const isRoot = center === graph.center;
  const centerNode = nodeByPhysical.get(center);

  const visCtx = { center, hops, rows, edges };
  const visibleNodes = nodes.filter(
    (n) => n.physical !== center && visibleAtLevel(level, n, visCtx)
  );

  const visibleSet = new Set([...visibleNodes.map((n) => n.physical), center]);
  const drawEdges = edges.filter((e) =>
    edgeVisibleAtLevel(level, e, visibleSet)
  );

  const nonCenterKinds = nodes.filter((n) => n.physical !== center).length;
  const hiddenKinds = nonCenterKinds - visibleNodes.length;
  const drawableEdges = edges.filter((e) => !e.selfRef).length;
  const hiddenEdges = drawableEdges - drawEdges.length;
  const unreachableMachinery = nodes.filter(
    (n) =>
      n.physical !== center &&
      n.packKind === "machinery" &&
      hops.get(n.physical) == null
  ).length;
  const lensExtras: { key: string; num: number; label: string }[] = [];
  if (level === "everything") {
    if (unreachableMachinery > 0)
      lensExtras.push({
        key: "revealed",
        num: unreachableMachinery,
        label: "plumbing kinds beyond reach, now shown",
      });
  } else {
    if (hiddenKinds > 0)
      lensExtras.push({
        key: "hidden-kinds",
        num: hiddenKinds,
        label:
          level === "simple"
            ? "kinds hidden (empty or plumbing)"
            : "plumbing kinds beyond reach",
      });
    if (hiddenEdges > 0)
      lensExtras.push({
        key: "hidden-edges",
        num: hiddenEdges,
        label: "connections hidden",
      });
  }

  const rootFriendly =
    nodeByPhysical.get(graph.center)?.friendly ?? graph.center;
  const centerRows = rows.get(center);

  return (
    <div className={styles.tab}>
      <div className={styles.head}>
        {/* Saved lenses over the chart, one active at a time. */}
        <fieldset className={styles.questions} aria-label="Ask the map">
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
        </fieldset>

        {/* Simple = kinds that provably carry data; Standard = today's lens;
            Everything = also unreachable machinery and raw SQL names. */}
        <fieldset
          className={styles.detailDial}
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
        </fieldset>
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
            showPhysical={level === "everything"}
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
          {/* HTML buttons, not SVG: they zoom about the viewBox centre with no
              CTM maths and stay keyboard-reachable. */}
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

      {/* Every number derived, never hardcoded. */}
      <div className={styles.caption} data-testid="atlas-caption">
        <span className={styles.captionItem}>
          <b className={styles.captionNum}>{fmt(graph.edgeCount)}</b> built-in
          connections
        </span>
        <span className={styles.captionItem}>
          <b className={styles.captionNum}>{fmt(notnullCount)}</b> always filled
          in
        </span>
        <span className={styles.captionItem}>
          <b className={styles.captionNum}>
            {fmt(graph.edgeCount - notnullCount)}
          </b>{" "}
          optional
        </span>
        <span className={styles.captionItem}>
          <b className={styles.captionNum}>{fmt(graph.centerEdgeCount)}</b>{" "}
          point to {rootFriendly} ({pct}%)
        </span>
        <span className={styles.captionItem}>
          <b className={styles.captionNum}>{fmt(ghostCount)}</b> nothing uses
          yet
        </span>
        <span className={styles.captionItem}>
          <b className={styles.captionNum}>{fmt(graph.selfRefCount)}</b> point
          to their own kind
        </span>
        <span className={styles.captionItem}>
          <b className={styles.captionNum}>{fmt(graph.island.length)}</b> not
          reachable from {rootFriendly}
        </span>
        {/* From the sets the chart draws. */}
        {lensExtras.map((x) => (
          <span
            key={x.key}
            className={styles.captionItem}
            data-testid="atlas-caption-lens"
          >
            <b className={styles.captionNum}>{fmt(x.num)}</b> {x.label}
          </span>
        ))}
      </div>
    </div>
  );
}
