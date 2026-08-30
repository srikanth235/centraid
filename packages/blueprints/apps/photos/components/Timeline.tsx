// The justified timeline (v4 handoff §4): `justify()` packs rows from real
// aspect ratios, grouped by month; no chrome inside the grid (§4.3). `.row`
// must stay a DIRECT child of the month/day fragments for the sticky head.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";

import { measuredModel } from "../../_shared/virtual-window.ts";
import {
  useMeasuredBlockHeight,
  useScrollHost,
  useVirtualWindow,
  VirtualSpacer,
} from "../../_shared/VirtualWindow.tsx";
import type { InlineScope } from "../../inline-types.ts";
import { assetKey } from "../asset-key.ts";
import { cls, fmtDay } from "../format.ts";
import { groupByMonth, monthTicks } from "../grouping.ts";
import type { MonthGroup } from "../grouping.ts";
import { justify, TIMELINE_GUTTER } from "../layout.ts";
import type { JustifiedTile } from "../layout.ts";
import { act, narrate } from "../outcomes.ts";
import { usePinchRung } from "../pinch.ts";
import { photosPurgeNote } from "../shared-copy.ts";
import { vaultMarker } from "../tile-state.ts";
import type { Asset } from "../types.ts";
import { ScrubRail } from "./ScrubRail.tsx";
import { Tile } from "./Tile.tsx";

import styles from "./Timeline.module.css";

export const MEMORIES_MAX_RUNG = 2;

interface TileCommon {
  inAlbum: boolean;
  albumId: string | null;
  canWriteAlbum: boolean;
  albumReason?: string;
  isTrash: boolean;
  refresh: () => Promise<void>;
  selectMode: boolean;
  rung: number;
  onEnterSelectMode: () => void;
  /** Both take the COMPOSITE key (asset-key.ts), never a bare `asset_id`. */
  onToggleSelect: (key: string, shiftKey?: boolean) => void;
  onOpen: (key: string) => void;
  vaultOf: (scopeId: string | null | undefined) => InlineScope | undefined;
}

const Row = memo(
  ({
    tiles,
    selectedIds,
    ...rest
  }: TileCommon & { tiles: JustifiedTile[]; selectedIds: Set<string> }) => {
    const {
      inAlbum,
      albumId,
      canWriteAlbum,
      albumReason,
      isTrash,
      refresh,
      vaultOf,
      ...tileRest
    } = rest;
    return (
      <div className={styles.row}>
        {tiles.map((t) => (
          <Tile
            // Ids are per-scope (#599); a bare id reuses another scope's tile.
            key={`${t.asset.scope_id ?? ""}:${t.asset.asset_id}`}
            asset={t.asset}
            width={t.width}
            height={t.height}
            selected={selectedIds.has(assetKey(t.asset))}
            vaultMark={vaultMarker(vaultOf(t.asset.scope_id))}
            {...(isTrash ? { note: purgeNote(t.asset) } : {})}
            {...(inAlbum
              ? {
                  extras: (
                    <TileExtras
                      asset={t.asset}
                      albumId={albumId}
                      canWrite={canWriteAlbum}
                      {...(albumReason === undefined
                        ? {}
                        : { reason: albumReason })}
                      refresh={refresh}
                    />
                  ),
                }
              : {})}
            {...tileRest}
          />
        ))}
      </div>
    );
  }
);
Row.displayName = "TimelineRow";

function purgeNote(asset: Asset): string | undefined {
  const days = asset.purge_in_days;
  if (days == null) return undefined;
  return photosPurgeNote(days);
}

function TileExtras({
  asset,
  albumId,
  canWrite,
  reason,
  refresh,
}: {
  asset: Asset;
  albumId: string | null;
  canWrite: boolean;
  reason?: string;
  refresh: () => Promise<void>;
}) {
  // A read-only album must offer no write (§6, §14): `disabled` stops pointer
  // and keyboard, the inert handler the rest.
  const remove = async (): Promise<void> => {
    const outcome = await act(
      "remove-from-album",
      { album_id: albumId, asset_id: asset.asset_id },
      asset.scope_id
    );
    if (narrate(outcome)) await refresh();
  };
  const run = canWrite ? remove : async (): Promise<void> => {};
  const label = `Remove ${asset.title ?? "photograph"} from this album`;
  return (
    <button
      type="button"
      className={styles.extraBtn}
      disabled={!canWrite}
      aria-label={
        canWrite || reason === undefined ? label : `${label} — ${reason}`
      }
      {...(canWrite || reason === undefined ? {} : { title: reason })}
      onClick={(e) => {
        e.stopPropagation();
        void run();
      }}
    >
      Remove
    </button>
  );
}

// The windowed stream (#883). Windowing is arithmetic, not estimate: blocks
// carry exact heights from `justify()` and the measured chrome rungs.
// `content-visibility` is not enough on its own — an off-screen tile is still a
// node, retained and re-measured on every resize.
//
// Month heads are never windowed out: the head is `position: sticky` and the
// scrub rail's tick observes `[data-month]`, so dropping one stops the month
// naming itself and the rail following. One head per month bounds that by the
// calendar.

const BLOCK_KIND_ATTR = "data-vkind";

const MONTH_HEAD_FALLBACK = 45;
const DAY_HEAD_FALLBACK = 31;

type TimelineBlock =
  | { kind: "month"; key: string; month: MonthGroup; height: number }
  | {
      kind: "day";
      key: string;
      day: MonthGroup["days"][number];
      height: number;
    }
  | { kind: "row"; key: string; tiles: JustifiedTile[]; height: number };

/** Months → days → packed rows, one flat sequence with a height each. Heights
 *  come from `layout.ts`, so scrollbar and packer can never disagree. */
function flattenTimeline(
  months: readonly MonthGroup[],
  containerWidth: number,
  targetHeight: number,
  monthHead: number,
  dayHead: number
): TimelineBlock[] {
  const blocks: TimelineBlock[] = [];
  for (const month of months) {
    blocks.push({
      kind: "month",
      key: month.key,
      month,
      height: monthHead,
    });
    for (const day of month.days) {
      blocks.push({ kind: "day", key: day.key, day, height: dayHead });
      const rows = justify(day.assets, containerWidth, targetHeight);
      for (const [index, tiles] of rows.entries()) {
        blocks.push({
          kind: "row",
          key: `${day.key}-${index}`,
          tiles,
          height: (tiles[0]?.height ?? targetHeight) + TIMELINE_GUTTER,
        });
      }
    }
  }
  return blocks;
}

/** One spacer per omitted RUN: per block, the saving goes on the stand-ins. */
function renderBlocks(
  blocks: readonly TimelineBlock[],
  slice: { start: number; end: number },
  context: { rowProps: TileCommon; selectedIds: Set<string> }
): ReactNode[] {
  const out: ReactNode[] = [];
  let pending = 0;
  let pendingAt = 0;
  const flush = (): void => {
    if (pending <= 0) return;
    out.push(<VirtualSpacer key={`gap-${pendingAt}`} height={pending} />);
    pending = 0;
  };
  for (const [index, block] of blocks.entries()) {
    const mounted =
      block.kind === "month" || (index >= slice.start && index < slice.end);
    if (!mounted) {
      if (pending === 0) pendingAt = index;
      pending += block.height;
      continue;
    }
    flush();
    if (block.kind === "month") {
      out.push(
        <h2
          key={`m-${block.key}`}
          className={styles.monthLabel}
          data-month={block.key}
          {...{ [BLOCK_KIND_ATTR]: "month" }}
        >
          <span className={styles.monthName}>{block.month.label}</span>
          <span className={styles.monthCount}>{block.month.count}</span>
        </h2>
      );
      continue;
    }
    if (block.kind === "day") {
      out.push(
        <p
          key={`d-${block.key}`}
          className={styles.dayLabel}
          {...{ [BLOCK_KIND_ATTR]: "day" }}
        >
          <span className={styles.dayName}>{fmtDay(block.key)}</span>
          <span className={styles.dayMeta}>{block.day.meta}</span>
        </p>
      );
      continue;
    }
    out.push(
      <Row
        key={`r-${block.key}`}
        tiles={block.tiles}
        selectedIds={context.selectedIds}
        {...context.rowProps}
      />
    );
  }
  flush();
  return out;
}

export function TimelineBody({
  assets,
  containerWidth,
  targetHeight,
  rung,
  phone,
  memories,
  inAlbum,
  albumId,
  canWriteAlbum,
  albumReason,
  isTrash,
  refresh,
  selectMode,
  selectedIds,
  onEnterSelectMode,
  onToggleSelect,
  onOpen,
  onPinchRung,
  vaultOf,
  truncated,
  libraryWindow: windowSize,
  selectedAlbum: selected,
  searchQuery: query,
  onShowMore,
}: TileCommon & {
  assets: Asset[];
  containerWidth: number;
  targetHeight: number;
  phone: boolean;
  memories: ReactNode;
  selectedIds: Set<string>;
  truncated: boolean;
  libraryWindow: number;
  selectedAlbum: string | null;
  searchQuery: string;
  onPinchRung?: (delta: number) => void;
  onShowMore: (e: MouseEvent<HTMLButtonElement>) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const blocksRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useScrollHost(blocksRef);
  const [activeMonth, setActiveMonth] = useState<string | null>(null);
  const pinch = usePinchRung(phone ? onPinchRung : undefined);

  // Callers sort differently (trash by deleted_at); bucketing needs taken_at.
  const ordered = [...assets].sort((a, b) =>
    String(b.taken_at ?? "").localeCompare(String(a.taken_at ?? ""))
  );
  const months: MonthGroup[] = groupByMonth(ordered);
  const ticks = monthTicks(months);

  // Measured, never re-derived: both rungs move with the density tier and a
  // text-scale setting.
  const monthHead = useMeasuredBlockHeight(blocksRef, MONTH_HEAD_FALLBACK, {
    selector: `[${BLOCK_KIND_ATTR}="month"]`,
  });
  const dayHead = useMeasuredBlockHeight(blocksRef, DAY_HEAD_FALLBACK, {
    selector: `[${BLOCK_KIND_ATTR}="day"]`,
  });

  const blocks = useMemo(
    () =>
      flattenTimeline(months, containerWidth, targetHeight, monthHead, dayHead),
    [months, containerWidth, targetHeight, monthHead, dayHead]
  );
  const model = useMemo(
    () => measuredModel(blocks.map((block) => block.height)),
    [blocks]
  );
  const slice = useVirtualWindow({ model, scrollRef, listRef: blocksRef });

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const heads = [...root.querySelectorAll<HTMLElement>("[data-month]")];
    if (heads.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveMonth((entry.target as HTMLElement).dataset.month ?? null);
          }
        }
      },
      { rootMargin: "0px 0px -85% 0px" }
    );
    for (const head of heads) observer.observe(head);
    return () => observer.disconnect();
  }, [months.length]);

  const seek = useCallback((monthKey: string) => {
    const root = rootRef.current;
    if (!root) return;
    const head = [...root.querySelectorAll<HTMLElement>("[data-month]")].find(
      (el) => el.dataset.month === monthKey
    );
    head?.scrollIntoView({ block: "start" });
  }, []);

  const rowProps: TileCommon = {
    inAlbum,
    albumId,
    canWriteAlbum,
    ...(albumReason === undefined ? {} : { albumReason }),
    isTrash,
    refresh,
    rung,
    selectMode,
    onEnterSelectMode,
    onToggleSelect,
    onOpen,
    vaultOf,
  };

  return (
    <div className={styles.timeline} ref={rootRef}>
      <div
        className={cls(styles.stream, phone ? styles.streamPhone : null)}
        {...(pinch ?? {})}
      >
        {memories}
        {/* The windowed run. A bare wrapper, so the month heads stay
            `position: sticky` against the same scrollport they always did and
            every rule in the stylesheet still matches by class. */}
        <div ref={blocksRef}>
          {renderBlocks(blocks, slice, {
            rowProps,
            selectedIds,
          })}
        </div>
        {truncated ? (
          <div className={`kit-foot ${styles.foot}`}>
            <span>
              {selected || query
                ? `This view covers your latest ${windowSize} photographs — older ones may be missing. `
                : `Showing your latest ${windowSize} photographs. `}
            </span>
            <button type="button" className="kit-btn" onClick={onShowMore}>
              Show more
            </button>
          </div>
        ) : null}
      </div>
      <ScrubRail
        ticks={ticks}
        activeKey={activeMonth}
        phone={phone}
        onSeek={seek}
      />
    </div>
  );
}
