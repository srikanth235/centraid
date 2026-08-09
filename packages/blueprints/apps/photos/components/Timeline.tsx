// The justified timeline (v4 handoff §4). Rows packed edge to edge from real
// aspect ratios by `justify()` (layout.ts), grouped by month with a sticky
// header and a day sub-label, a scrub rail on the trailing edge, and the
// memories strip at its head.
//
// NO CHROME INSIDE THE GRID (§4.3). The month header and the day sub-label are
// type on paper — no rules, no cards, no pills. The gutter is 2px on both
// axes, the one place in the product where content touches content.
//
// THE TILE IS ITS OWN CONTROL (Tile.tsx). This file decides WHICH tiles go
// where and WHAT their four slots say; the tile decides how it draws them. The
// vault slot is derived from `InlineScope.kind` through `vaultMarker`, never
// from a name (§H) — an owner is free to rename any vault.
//
// `.row` elements stay DIRECT children of the month/day fragments so the month
// header can `position: sticky` against the scroll pane.
//
// CSS split: React-owned classes live in Timeline.module.css and
// Tile.module.css; the tile's imperatively-injected media guts
// (ph-tile-ph/video-badge/duration/is-placeholder from media.ts) stay GLOBAL —
// see that module's header.
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
import { vaultMarker } from "../tile-state.ts";
import type { Asset } from "../types.ts";
import { ScrubRail } from "./ScrubRail.tsx";
import { Tile } from "./Tile.tsx";

import styles from "./Timeline.module.css";

/** The memories strip's own head, rendered by the caller (§4.6). It only
 *  appears at rungs XS-M: at L the strip and the first row of tiles are the
 *  same size, and the head stops reading as a head. */
export const MEMORIES_MAX_RUNG = 2;

interface TileCommon {
  inAlbum: boolean;
  albumId: string | null;
  /**
   * May this member write to the album they are looking at? The bar's Rename
   * and Delete are gated on this already (AlbumBar); the tile's own Remove was
   * not, so a read-only album offered a working remove-from-album control on
   * every tile while the bar beside it correctly refused (§6, §14).
   * Meaningless outside album detail, where no extra is rendered at all.
   */
  canWriteAlbum: boolean;
  /** Why the album refuses a write, for the control that must say so. */
  albumReason?: string;
  isTrash: boolean;
  refresh: () => Promise<void>;
  selectMode: boolean;
  /** The member's tile-size rung, 0-3 = XS/S/M/L (§4.2). */
  rung: number;
  onEnterSelectMode: () => void;
  /** Both take the COMPOSITE key (asset-key.ts), never a bare `asset_id`. */
  onToggleSelect: (key: string, shiftKey?: boolean) => void;
  onOpen: (key: string) => void;
  /**
   * The mounted vault a tile is shown FROM (issue #599, §H). The tile's vault
   * marker is derived from this scope's record — any vault but the personal
   * one — so a member with one vault sees an unmarked grid and nothing about
   * the timeline changes for them.
   */
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
          // Scope-qualified: two scopes can legitimately hand the merged list
          // the same asset id (ids are per-scope, issue #599), and a bare id
          // key would make React reuse one tile's DOM — and its already loaded
          // bytes — for the other scope's photograph.
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

/** Trash's purge countdown, in the STATE slot (§5) — 30 days, then purged.
 *  Undefined where the row carries no countdown, so the slot stays empty
 *  rather than claiming a deadline nobody set. */
function purgeNote(asset: Asset): string | undefined {
  const days = asset.purge_in_days;
  if (days == null) return undefined;
  if (days === 0) return "purges today";
  return `purges in ${days} ${days === 1 ? "day" : "days"}`;
}

/**
 * Album detail's own Remove — deliberately outside the tile's four slots
 * (Tile.tsx's `extras`, §4.4). Trash's Restore used to live here beside it;
 * it retired once the selection bar grew the Trash → Restore swap (§6). This
 * one stays: removing a single photograph from the album you are looking at
 * has no equivalent among the bar's fixed five, since "Add to album" is a
 * destination picker on every other shelf and album detail is not a
 * destination to pick.
 */
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
  // A READ-ONLY ALBUM MUST NOT OFFER A WRITE (§6, §14). Two separate things
  // stop it, deliberately: the DOM `disabled` attribute stops a pointer and a
  // keyboard, and the INERT handler stops everything else — the same defense
  // in depth the selection bar's disabled actions use. The reason itself is
  // stated inline once, on the album bar above the grid; here it rides the
  // control's own name, because a per-tile sentence would repeat it as many
  // times as there are photographs.
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
  /** The compact form factor: the rail overlays, and pinch is live. */
  phone: boolean;
  /** The strip at the head of the timeline (§4.6), already gated by rung by
   *  the caller. Null renders no head at all rather than an empty band. */
  memories: ReactNode;
  selectedIds: Set<string>;
  truncated: boolean;
  libraryWindow: number;
  selectedAlbum: string | null;
  searchQuery: string;
  /** Pinch steps the SAME four rungs the stepper walks (§4.2). Absent on a
   *  surface with a pointer, where the stepper is the way in. */
  onPinchRung?: (delta: number) => void;
  onShowMore: (e: MouseEvent<HTMLButtonElement>) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [activeMonth, setActiveMonth] = useState<string | null>(null);
  const pinch = usePinchRung(phone ? onPinchRung : undefined);

  // A stable newest-first order regardless of the caller's source sort (the
  // trash shelf's own query sorts by deleted_at, not taken_at) — otherwise
  // bucketing by month/day could scatter months out of order.
  const ordered = [...assets].sort((a, b) =>
    String(b.taken_at ?? "").localeCompare(String(a.taken_at ?? ""))
  );
  const months: MonthGroup[] = groupByMonth(ordered);
  const ticks = monthTicks(months);

  // Which month is at the top of the scroller — the rail's 7px tick. An
  // observer rather than a scroll handler: it costs nothing while the member
  // is not scrolling, and it needs no knowledge of which ancestor scrolls.
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
