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
import {
  censusStamp,
  countLine,
  healthDetail,
  kindRowsFrom,
  kindWritten,
  NEVER_WRITTEN,
} from "./atlasScreenModel.js";
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

// `all` genuinely means all (#775): the kinds list carries the never-written
// ones too, so the chip that says "All kinds" is not quietly showing a subset.
// `never` is the chip that isolates them — the answer to "what are the other
// thirty-one?" that the count line asks and nothing used to answer.
const CHIPS = [
  { id: "all", label: "All kinds" },
  { id: "largest", label: "Largest" },
  { id: "today", label: "Written today" },
  { id: "never", label: NEVER_WRITTEN },
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
}: AtlasScreenProps): JSX.Element {
  const [stats, setStats] = useState<AtlasCensusPayload | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [pulse, setPulse] = useState<AtlasPulsePayload | null>(null);
  const [graph, setGraph] = useState<AtlasGraphPayload | null>(null);
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(null);
  const [chip, setChip] = useState<ChipId>("all");
  const [picked, setPicked] = useState<string | null>(null);
  // When THIS PAGE last read the census. Not the payload's own `generatedAt`:
  // the gateway may serve a cached census, and the stamp is a promise about
  // when the page asked, which is the thing a Refresh verb changes.
  const [censusReadAt, setCensusReadAt] = useState<string | null>(null);
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
        setCensusReadAt(new Date().toISOString());
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
  // The kinds that hold something. A vault whose schema declares forty kinds
  // and has written none is still an EMPTY vault, so the empty state and the
  // records section below both count these rather than the whole list.
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

  // The kind whose records the last section shows: the one a Browse row asked
  // for, else the fullest kind — the page always has a table under it. A ghost
  // row's verb is inert, so `picked` is always a kind with records in it.
  const selected =
    written.find((k) => k.logical === picked) ?? written[0] ?? null;

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
          body="The host could not open the vault — usually a permissions problem on this machine."
          eyebrow="Vault"
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
        <NoteBlock>{SKELETON_NOTE}</NoteBlock>
      </div>
    );

  if (state === "empty")
    return (
      <div className={styles.page}>
        <EmptyBlock body={ATLAS_EMPTY_BODY} routine title={ATLAS_EMPTY_TITLE} />
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
        onRefresh={loadCensus}
        stamp={censusStamp(censusReadAt)}
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
