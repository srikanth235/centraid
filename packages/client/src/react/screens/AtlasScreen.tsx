import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";

import { ATLAS_EMPTY_BODY, ATLAS_EMPTY_TITLE } from "../../data-copy.js";
import { browseRows } from "../../gateway-client.js";
import type {
  AtlasCensusPayload,
  AtlasGraphPayload,
  AtlasPulsePayload,
} from "../../gateway-client.js";
import { SKELETON_NOTE } from "../../surface-copy.js";
import type { OpsState } from "../shell/opsBar.js";
import {
  clearRouteSignals,
  publishRouteSignals,
  publishRouteVerbs,
} from "../shell/routeVitals.js";
import type { RouteHealth } from "../shell/routeVitals.js";
import { PageSkeleton } from "../shell/status.js";
import { postStatus } from "../shell/statusChannel.js";
import ChipsBlock from "../ui/ChipsBlock.js";
import EmptyBlock from "../ui/EmptyBlock.js";
import NoteBlock from "../ui/NoteBlock.js";
import PanelBlock from "../ui/PanelBlock.js";
import SectionBlock from "../ui/SectionBlock.js";
import AtlasKindsSection from "./AtlasKindsSection.js";
import AtlasRecordsSection from "./AtlasRecordsSection.js";
import AtlasRelationsSection from "./AtlasRelationsSection.js";
import {
  censusStamp,
  countLine,
  healthDetail,
  holdsMeta,
  isCensusPayload,
  kindRowsFrom,
  kindWritten,
  NEVER_WRITTEN,
} from "./atlasScreenModel.js";
import type { KindRow } from "./atlasScreenModel.js";

import styles from "./AtlasScreen.module.css";

// The Data route (#765): kinds → note → relations → the browsed kind's rows.
// Identity and condition belong to the app bar via `routeVitals`, not the body.

export interface AtlasScreenProps {
  loadStats: () => Promise<AtlasCensusPayload>;
  loadPulse: () => Promise<AtlasPulsePayload>;
  loadGraph: () => Promise<AtlasGraphPayload>;
  /** Failure is silent: drop the "Last backup" clause, never fail the page. */
  loadLastBackupAt?: () => Promise<string | null>;
  embedded?: boolean;
  onReport?: (report: AtlasReport) => void;
  collapsed?: boolean;
  onToggle?: () => void;
}

export interface AtlasReport {
  state: OpsState;
  count: string;
  /** `null` until the census answers — omit the clause, never guess it. */
  records: number | null;
  health: RouteHealth | null;
}

const FULL_AT = 8;

const EXPORT_PAGE_CAP = 40;

// `all` means all (#775): never-written kinds included; `never` isolates them.
const CHIPS = [
  { id: "all", label: "All kinds" },
  { id: "largest", label: "Largest" },
  { id: "today", label: "Written today" },
  { id: "never", label: NEVER_WRITTEN },
] as const;
type ChipId = (typeof CHIPS)[number]["id"];

function download(text: string, filename: string): void {
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json" })
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function filterKinds(kinds: readonly KindRow[], chip: ChipId): KindRow[] {
  if (chip === "largest")
    return [...kinds]
      .filter(kindWritten)
      .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
  if (chip === "today") return kinds.filter((k) => (k.writtenToday ?? 0) > 0);
  if (chip === "never") return kinds.filter((k) => !kindWritten(k));
  return [...kinds];
}

export default function AtlasScreen({
  loadStats,
  loadPulse,
  loadGraph,
  loadLastBackupAt,
  embedded = false,
  onReport,
  collapsed = false,
  onToggle,
}: AtlasScreenProps): JSX.Element {
  const [stats, setStats] = useState<AtlasCensusPayload | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [pulse, setPulse] = useState<AtlasPulsePayload | null>(null);
  const [graph, setGraph] = useState<AtlasGraphPayload | null>(null);
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(null);
  const [chip, setChip] = useState<ChipId>("all");
  const [picked, setPicked] = useState<string | null>(null);
  const [relationsOpen, setRelationsOpen] = useState(false);
  // When THIS PAGE read the census, not the payload's `generatedAt`: the
  // gateway may serve a cached one, and Refresh must move the stamp.
  const [censusReadAt, setCensusReadAt] = useState<string | null>(null);
  const mountedRef = useRef(true);

  // The pulse is enhancement-only; only a census failure is the page's error.
  const loadCensus = useCallback(() => {
    void Promise.allSettled([loadStats(), loadPulse()]).then(([s, p]) => {
      if (!mountedRef.current) return;
      if (s.status === "fulfilled" && isCensusPayload(s.value)) {
        setStats(s.value);
        setStatsError(null);
        setCensusReadAt(new Date().toISOString());
      } else if (s.status === "fulfilled") {
        // A 200 that is not a census is an error: passing it on throws in
        // kindRowsFrom, taking the merged Vault surface down.
        setStats(null);
        setStatsError("The host did not return a vault census.");
      } else
        setStatsError(
          s.reason instanceof Error ? s.reason.message : String(s.reason)
        );
      if (p.status === "fulfilled") setPulse(p.value);
    });
  }, [loadStats, loadPulse]);

  const retry = useCallback(() => {
    setStats(null);
    setStatsError(null);
    loadCensus();
  }, [loadCensus]);

  useEffect(() => {
    mountedRef.current = true;
    loadCensus();
    void loadGraph()
      .then((g) => {
        if (mountedRef.current) setGraph(g);
      })
      .catch(() => {});
    void loadLastBackupAt?.()
      .then((at) => {
        if (mountedRef.current) setLastBackupAt(at);
      })
      .catch(() => {});
    return () => {
      mountedRef.current = false;
    };
  }, [loadCensus, loadGraph, loadLastBackupAt]);

  const kinds = useMemo(
    () => (stats ? kindRowsFrom(stats, pulse) : []),
    [stats, pulse]
  );
  const shown = useMemo(() => filterKinds(kinds, chip), [kinds, chip]);
  // Declared-but-unwritten kinds still mean an EMPTY vault: count these.
  const written = useMemo(() => kinds.filter(kindWritten), [kinds]);

  const state =
    statsError !== null && stats === null
      ? "error"
      : stats === null
        ? "loading"
        : written.length === 0
          ? "empty"
          : kinds.length > FULL_AT
            ? "full"
            : "ready";

  const selected =
    written.find((k) => k.logical === picked) ?? written[0] ?? null;

  // Embedded, the surface above owns both slots; never publish from here.
  const health = useMemo<RouteHealth | null>(
    () =>
      state === "ready" || state === "full"
        ? {
            detail: healthDetail(pulse, lastBackupAt),
            label: "Everything is readable",
          }
        : null,
    [lastBackupAt, pulse, state]
  );
  useEffect(() => {
    if (embedded) return;
    publishRouteSignals("atlas", {
      state,
      ...(stats ? { count: countLine(stats) } : {}),
      ...(health ? { health } : {}),
    });
  }, [embedded, health, state, stats]);

  useEffect(() => {
    if (embedded) return undefined;
    return () => clearRouteSignals("atlas");
  }, [embedded]);

  const report = useMemo<AtlasReport>(
    () => ({
      count: stats ? countLine(stats) : "",
      health,
      records: stats ? (stats.totals?.rows ?? null) : null,
      state,
    }),
    [health, state, stats]
  );
  // Keep the block body: an expression arrow hands the reporter's return
  // value to React as an effect destructor.
  useEffect(() => {
    onReport?.(report);
  }, [onReport, report]);

  // A copy-out, not a commit — Data declares no filled control.
  const exportKind = useCallback(() => {
    if (!selected) return;
    const { logical, label } = selected;
    void (async () => {
      const out: Record<string, unknown>[] = [];
      let after: string | null = null;
      for (let page = 0; page < EXPORT_PAGE_CAP; page += 1) {
        // oxlint-disable-next-line no-await-in-loop -- keyset paging: each page's cursor comes from the one before it
        const res: Awaited<ReturnType<typeof browseRows>> = await browseRows({
          dir: "desc",
          table: logical,
          ...(after ? { after } : {}),
        });
        out.push(...res.rows);
        after = res.nextCursor;
        if (!after) break;
      }
      download(
        JSON.stringify({ kind: logical, records: out }, null, 2),
        `${logical}.json`
      );
      postStatus(
        `Exported ${out.length.toLocaleString()} ${label} records${after ? " (the first pages)" : ""}`
      );
    })().catch((error: unknown) => {
      postStatus(
        `Could not export ${label} · ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }, [selected]);

  useEffect(() => {
    // Merged, the bar's verbs belong to the surface; export is a row instead.
    if (embedded) return;
    publishRouteVerbs("atlas", { onSecondary: exportKind });
  }, [embedded, exportKind]);

  // Merged, a whole-page state is only the section's body: head, census
  // sentence and disclosure stay drawn.
  const frame = (body: JSX.Element): JSX.Element =>
    embedded ? (
      <>
        <SectionBlock
          collapsed={collapsed}
          label="What it holds"
          meta={stats ? holdsMeta(stats) : "Reading the census"}
          {...(onToggle ? { onToggle } : {})}
        />
        {collapsed ? null : body}
      </>
    ) : (
      <div className={styles.page}>{body}</div>
    );

  if (state === "error")
    return frame(
      <PanelBlock
        action={{ label: "Try again", onClick: retry }}
        body="The host could not open the vault — usually a permissions problem on this machine."
        eyebrow="What it holds"
        title="Cannot open the store"
        tone="net"
        wide
      />
    );

  if (state === "loading")
    return frame(
      <>
        <PageSkeleton label="Reading your vault’s census" rows={6} />
        <NoteBlock>{SKELETON_NOTE}</NoteBlock>
      </>
    );

  if (state === "empty")
    return frame(
      <EmptyBlock body={ATLAS_EMPTY_BODY} routine title={ATLAS_EMPTY_TITLE} />
    );

  const holds = (
    <>
      <AtlasKindsSection
        chips={
          state === "full" ? (
            <ChipsBlock
              ariaLabel="Filter kinds"
              chips={CHIPS.map((c) => ({ ...c, on: c.id === chip }))}
              onPick={(id) => setChip(id as ChipId)}
            />
          ) : undefined
        }
        collapsed={embedded ? collapsed : false}
        kinds={shown}
        meta={stats ? holdsMeta(stats) : ""}
        onBrowse={setPicked}
        onExport={exportKind}
        onRefresh={loadCensus}
        onRelations={() => setRelationsOpen((open) => !open)}
        {...(embedded && onToggle ? { onToggle } : {})}
        relations={
          <AtlasRelationsSection
            graph={graph}
            onBrowse={setPicked}
            fetchSampleRows={(logical) =>
              browseRows({ limit: 3, table: logical }).then((r) => r.rows)
            }
          />
        }
        relationsOpen={relationsOpen}
        stamp={censusStamp(censusReadAt)}
        totalKinds={kinds.length}
      />

      {/* Part of "What it holds", so it closes with it. */}
      {(embedded && collapsed) || !selected ? null : (
        <AtlasRecordsSection
          key={selected.logical}
          label={selected.label}
          logical={selected.logical}
          records={selected.records}
        />
      )}
    </>
  );

  return embedded ? holds : <div className={styles.page}>{holds}</div>;
}
