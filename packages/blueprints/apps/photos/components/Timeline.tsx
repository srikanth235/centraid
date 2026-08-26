// The justified timeline (v4 handoff §4): rows packed from real aspect ratios
// by `justify()`, grouped by month. NO CHROME INSIDE THE GRID (§4.3) — type on
// paper, 2px gutters. `.row` stays a DIRECT child of the month/day fragments so
// the month header can `position: sticky`. The vault slot derives from
// `InlineScope.kind` via `vaultMarker`, never from a name (§H).
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";

import type { InlineScope } from "../../inline-types.ts";
import { assetKey } from "../asset-key.ts";
import { cls, fmtDay } from "../format.ts";
import { groupByMonth, monthTicks } from "../grouping.ts";
import type { MonthGroup } from "../grouping.ts";
import { justify } from "../layout.ts";
import type { JustifiedTile } from "../layout.ts";
import { act, narrate } from "../outcomes.ts";
import { usePinchRung } from "../pinch.ts";
import { photosPurgeNote } from "../shared-copy.ts";
import { vaultMarker } from "../tile-state.ts";
import type { Asset } from "../types.ts";
import { ScrubRail } from "./ScrubRail.tsx";
import { Tile } from "./Tile.tsx";

import styles from "./Timeline.module.css";

/** At L the head stops reading as a head. */
export const MEMORIES_MAX_RUNG = 2;

interface TileCommon {
  inAlbum: boolean;
  albumId: string | null;
  /** Gates the tile's own Remove, as AlbumBar gates Rename/Delete (§6, §14). */
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

function Row({
  tiles,
  selectedIds,
  ...rest
}: TileCommon & { tiles: JustifiedTile[]; selectedIds: Set<string> }) {
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
          // Scope-qualified: ids are per-scope (#599), so a bare id would let
          // React reuse one scope's tile — and its bytes — for another's.
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
  // A READ-ONLY ALBUM MUST NOT OFFER A WRITE (§6, §14): `disabled` stops
  // pointer and keyboard, the inert handler stops everything else.
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
  const [activeMonth, setActiveMonth] = useState<string | null>(null);
  const pinch = usePinchRung(phone ? onPinchRung : undefined);

  // Callers sort differently (trash by deleted_at); bucketing needs taken_at.
  const ordered = [...assets].sort((a, b) =>
    String(b.taken_at ?? "").localeCompare(String(a.taken_at ?? ""))
  );
  const months: MonthGroup[] = groupByMonth(ordered);
  const ticks = monthTicks(months);

  // An observer, not a scroll handler: no ancestor knowledge needed.
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
        {months.map((month) => (
          <Fragment key={month.key}>
            <h2 className={styles.monthLabel} data-month={month.key}>
              <span className={styles.monthName}>{month.label}</span>
              <span className={styles.monthCount}>{month.count}</span>
            </h2>
            {month.days.map((day) => (
              <Fragment key={day.key}>
                <p className={styles.dayLabel}>
                  <span className={styles.dayName}>{fmtDay(day.key)}</span>
                  <span className={styles.dayMeta}>{day.meta}</span>
                </p>
                {justify(day.assets, containerWidth, targetHeight).map(
                  (tiles, i) => (
                    <Row
                      key={`${day.key}-${i}`}
                      tiles={tiles}
                      selectedIds={selectedIds}
                      {...rowProps}
                    />
                  )
                )}
              </Fragment>
            ))}
          </Fragment>
        ))}
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
