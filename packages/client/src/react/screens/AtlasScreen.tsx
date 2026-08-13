import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";

import { browseRows } from "../../gateway-client.js";
import type {
  AtlasCensusPayload,
  AtlasGraphPayload,
  AtlasPulsePayload,
} from "../../gateway-client.js";
import {
  clearRouteSignals,
  publishRouteSignals,
  publishRouteVerbs,
} from "../shell/routeVitals.js";
import { PageSkeleton } from "../shell/status.js";
import { postStatus } from "../shell/statusChannel.js";
import ChipsBlock from "../ui/ChipsBlock.js";
import EmptyBlock from "../ui/EmptyBlock.js";
import NoteBlock from "../ui/NoteBlock.js";
import PanelBlock from "../ui/PanelBlock.js";
import AtlasKindsSection from "./AtlasKindsSection.js";
import AtlasRecordsSection from "./AtlasRecordsSection.js";
import AtlasRelationsSection from "./AtlasRelationsSection.js";
import { countLine, healthDetail, kindRowsFrom } from "./atlasScreenModel.js";
import type { KindRow } from "./atlasScreenModel.js";

import styles from "./AtlasScreen.module.css";

// The Data route (v9 §6, issue #765) — one vertical block list, no tab strip.
//
// KINDS → the note → HOW THEY RELATE → the browsed kind's records. The three
// tabs it replaces (Kinds / Map / Browse) were three ways of asking the same
// question about the same vault, and the tab strip meant two of the three
// answers were always hidden. The identity (title, count line, "Export a kind")
// lives in the app bar via `routeVitals`; the page's condition lives on the
// status line; neither is drawn in the body any more.
//
// Above a threshold the kinds list grows a chip row — the `full` state — so a
// vault with forty kinds is filtered rather than scrolled.

export interface AtlasScreenProps {
  /** GET /_vault/atlas/stats — the Kinds census (rows/bytes per pack). */
  loadStats: () => Promise<AtlasCensusPayload>;
  /** GET /_vault/atlas/pulse — the write pulse behind "written today". */
  loadPulse: () => Promise<AtlasPulsePayload>;
  /** GET /_vault/atlas/graph — the relations payload. */
  loadGraph: () => Promise<AtlasGraphPayload>;
  /**
   * The gateway's backup status, for the status line's "Last backup" clause.
   * Optional, and its failure is silent: a page about what the vault holds does
   * not fail because a second, unrelated read did — the clause is simply left
   * off rather than guessed at.
   */
  loadLastBackupAt?: () => Promise<string | null>;
}

/** Kinds beyond this and the page is `full`: the chip row appears. */
const FULL_AT = 8;

/** Pages of records one export walks before it stops. A cap, stated in the
 *  file rather than discovered at 200k rows. */
const EXPORT_PAGE_CAP = 40;

const CHIPS = [
  { id: "all", label: "All kinds" },
  { id: "largest", label: "Largest" },
  { id: "today", label: "Written today" },
] as const;
type ChipId = (typeof CHIPS)[number]["id"];

/** Save a blob through the browser's own download path — the same shape the
 *  import screen uses; the desktop host resolves it to a file dialog. */
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
    return [...kinds].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
  if (chip === "today") return kinds.filter((k) => (k.writtenToday ?? 0) > 0);
  return [...kinds];
}

export default function AtlasScreen({
  loadStats,
  loadPulse,
  loadGraph,
  loadLastBackupAt,
}: AtlasScreenProps): JSX.Element {
  const [stats, setStats] = useState<AtlasCensusPayload | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [pulse, setPulse] = useState<AtlasPulsePayload | null>(null);
  const [graph, setGraph] = useState<AtlasGraphPayload | null>(null);
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(null);
  const [chip, setChip] = useState<ChipId>("all");
  const [picked, setPicked] = useState<string | null>(null);
  const mountedRef = useRef(true);

  // Census + pulse travel together (both feed the Kinds rows). The pulse is
  // enhancement-only — without it a row simply carries no "written today" and
  // no last-write meta — so only a census failure is the page's error state.
  const loadCensus = useCallback(() => {
    void Promise.allSettled([loadStats(), loadPulse()]).then(([s, p]) => {
      if (!mountedRef.current) return;
      if (s.status === "fulfilled") {
        setStats(s.value);
        setStatsError(null);
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

  const state =
    statsError !== null && stats === null
      ? "error"
      : stats === null
        ? "loading"
        : kinds.length === 0
          ? "empty"
          : kinds.length > FULL_AT
            ? "full"
            : "ready";

  // The kind whose records the last section shows: the one a Browse row asked
  // for, else the fullest kind — the page always has a table under it.
  const selected = kinds.find((k) => k.logical === picked) ?? kinds[0] ?? null;

  // ── The frame's two slots ────────────────────────────────────────────────
  useEffect(() => {
    publishRouteSignals("atlas", {
      state,
      ...(stats ? { count: countLine(stats) } : {}),
      ...(state === "ready" || state === "full"
        ? {
            health: {
              detail: healthDetail(pulse, lastBackupAt),
              label: "Everything is readable",
            },
          }
        : {}),
    });
  }, [state, stats, pulse, lastBackupAt]);

  useEffect(() => () => clearRouteSignals("atlas"), []);

  // "Export a kind" — the bar's one verb. It copies out what the page is
  // showing: every record of the browsed kind, as the vault stores it. Not a
  // commit, which is why Data declares no filled control at all.
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
    publishRouteVerbs("atlas", { onSecondary: exportKind });
  }, [exportKind]);

  // ── The five states ──────────────────────────────────────────────────────
  if (state === "error")
    return (
      <div className={styles.page}>
        <PanelBlock
          action={{ label: "Try again", onClick: retry }}
          body="The vault is encrypted and present on disk. The gateway could not open it, which is usually a permissions problem on the machine rather than damage to the data."
          eyebrow="Data"
          title="Cannot open the store"
          tone="net"
          wide
        />
      </div>
    );

  if (state === "loading")
    return (
      <div className={styles.page}>
        <PageSkeleton label="Reading your vault’s census" rows={6} />
        <NoteBlock>
          A row knows its shape before its content arrives, so nothing reflows
          when it does.
        </NoteBlock>
      </div>
    );

  if (state === "empty")
    return (
      <div className={styles.page}>
        <EmptyBlock
          body="Kinds appear here as apps write records. Nothing is created until an app or an import puts something in."
          routine
          title="This vault is empty"
        />
      </div>
    );

  return (
    <div className={styles.page}>
      {state === "full" ? (
        <ChipsBlock
          ariaLabel="Filter kinds"
          chips={CHIPS.map((c) => ({ ...c, on: c.id === chip }))}
          onPick={(id) => setChip(id as ChipId)}
        />
      ) : null}

      <AtlasKindsSection
        kinds={shown}
        onBrowse={setPicked}
        totalKinds={stats?.totals.kinds ?? kinds.length}
      />

      <AtlasRelationsSection
        graph={graph}
        onBrowse={setPicked}
        fetchSampleRows={(logical) =>
          browseRows({ limit: 3, table: logical }).then((r) => r.rows)
        }
      />

      {selected ? (
        <AtlasRecordsSection
          key={selected.logical}
          label={selected.label}
          logical={selected.logical}
          records={selected.records}
        />
      ) : null}
    </div>
  );
}
