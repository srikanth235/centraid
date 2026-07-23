// The Google-Photos-style justified timeline (replaces Grid.jsx): sticky
// month headers, day sub-labels, and rows packed edge-to-edge by
// `justify()` (layout.ts) — real aspect ratios, no more rigid squares. The
// trash shelf rides the SAME timeline (unlike the old Grid.jsx's separate
// flat TrashGridBody) — the reference mockup folds trash into one timeline
// too; each tile just grows a purge-countdown/Restore footer via `isTrash`.
// `.row` elements must stay DIRECT children of the month/day Fragments so
// month headers can `position: sticky` against the scroll pane — same
// constraint the old Grid.jsx's `.tile-wrap` had against `#grid`.
// CSS split: React-owned classes live in Timeline.module.css; the tile's
// imperatively-injected media guts (ph-tile-ph/video-badge/duration/
// is-placeholder from media.ts) stay GLOBAL — see that module's header.
import { restoreAsset, toggleFavorite } from '../assets-actions.ts';
import { cls, dayKey, fmtDay, fmtMonth } from '../format.ts';
import { CheckIcon, HeartIcon } from '../icons.tsx';
import { justify } from '../layout.ts';
import { mountMedia } from '../media.ts';
import { act, narrate } from '../outcomes.ts';
import { Fragment } from 'react';
import type { MouseEvent } from 'react';
import type { Asset } from '../types.ts';
import type { JustifiedTile } from '../layout.ts';
import styles from './Timeline.module.css';

interface TileCommon {
  inAlbum: boolean;
  albumId: string | null;
  isTrash: boolean;
  refresh: () => Promise<void>;
  selectMode: boolean;
  onEnterSelectMode: () => void;
  onToggleSelect: (assetId: string, shiftKey?: boolean) => void;
  onOpen: (assetId: string) => void;
}

function Tile({
  asset,
  width,
  height,
  inAlbum,
  albumId,
  isTrash,
  selected,
  selectMode,
  refresh,
  onEnterSelectMode,
  onToggleSelect,
  onOpen,
}: TileCommon & { asset: Asset; width: number; height: number; selected: boolean }) {
  return (
    <div
      className={cls(styles.tile, selected && styles.selected, isTrash && styles.trash)}
      style={{ width: `${width}px`, height: `${height}px` }}
      data-asset-id={asset.asset_id}
    >
      {/* The media fill (thumb or placeholder) and any video glyph are drawn
          imperatively by mountMedia/fillTileMedia (media.ts). */}
      <button
        type="button"
        className={styles.tileMedia}
        ref={(el) => mountMedia(el, asset)}
        onClick={() => {
          if (isTrash) return;
          if (selectMode) onToggleSelect(asset.asset_id);
          else onOpen(asset.asset_id);
        }}
      ></button>
      <span className={styles.tileScrim} aria-hidden="true" />
      {!isTrash ? (
        <button
          type="button"
          className={styles.tileCheck}
          aria-label={selected ? 'Deselect' : 'Select'}
          onClick={(e) => {
            e.stopPropagation();
            if (!selectMode) onEnterSelectMode();
            onToggleSelect(asset.asset_id);
          }}
        >
          {selected ? <CheckIcon size={12} /> : null}
        </button>
      ) : null}
      {!isTrash ? (
        <button
          type="button"
          className={styles.tileHeart}
          aria-pressed={asset.favorite ? 'true' : 'false'}
          aria-label={asset.favorite ? 'Remove from favorites' : 'Add to favorites'}
          onClick={(e) => {
            e.stopPropagation();
            toggleFavorite(asset, refresh);
          }}
        >
          <HeartIcon size={16} filled={!!asset.favorite} />
        </button>
      ) : null}
      {inAlbum && !isTrash ? (
        <button
          type="button"
          className={styles.tileRemove}
          title="Remove from album"
          aria-label="Remove from album"
          onClick={async (e) => {
            e.stopPropagation();
            const outcome = await act('remove-from-album', {
              album_id: albumId,
              asset_id: asset.asset_id,
            });
            if (narrate(outcome)) await refresh();
          }}
        >
          ×
        </button>
      ) : null}
      {isTrash ? (
        <div className={styles.tileTrashBar}>
          <span className={styles.tilePurge}>
            {asset.purge_in_days == null
              ? ''
              : asset.purge_in_days === 0
                ? 'purges today'
                : `purges in ${asset.purge_in_days}d`}
          </span>
          <button
            type="button"
            className={styles.tileRestore}
            aria-label={`Restore ${asset.title ?? 'photo'}`}
            onClick={async (e) => {
              e.stopPropagation();
              e.currentTarget.disabled = true;
              if (!(await restoreAsset(asset.asset_id, refresh))) e.currentTarget.disabled = false;
            }}
          >
            Restore
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Row({
  tiles,
  selectedIds,
  ...rest
}: TileCommon & { tiles: JustifiedTile[]; selectedIds: Set<string> }) {
  return (
    <div className={styles.row}>
      {tiles.map((t) => (
        <Tile
          key={t.asset.asset_id}
          asset={t.asset}
          width={t.width}
          height={t.height}
          selected={selectedIds.has(t.asset.asset_id)}
          {...rest}
        />
      ))}
    </div>
  );
}

export function TimelineBody({
  assets,
  containerWidth,
  targetHeight,
  inAlbum,
  albumId,
  isTrash,
  refresh,
  selectMode,
  selectedIds,
  onEnterSelectMode,
  onToggleSelect,
  onOpen,
  truncated,
  libraryWindow: windowSize,
  selectedAlbum: selected,
  searchQuery: query,
  onShowMore,
}: TileCommon & {
  assets: Asset[];
  containerWidth: number;
  targetHeight: number;
  selectedIds: Set<string>;
  truncated: boolean;
  libraryWindow: number;
  selectedAlbum: string | null;
  searchQuery: string;
  onShowMore: (e: MouseEvent<HTMLButtonElement>) => void;
}) {
  // A stable newest-first order regardless of the caller's source sort (the
  // trash shelf's own query sorts by deleted_at, not taken_at) — otherwise
  // bucketing by month/day below could scatter months out of order.
  const ordered = [...assets].sort((a, b) =>
    String(b.taken_at ?? '').localeCompare(String(a.taken_at ?? '')),
  );
  const months = new Map<string, Map<string, Asset[]>>();
  for (const asset of ordered) {
    const dk = dayKey(asset.taken_at);
    const mk = dk.slice(0, 7);
    let days = months.get(mk);
    if (!days) {
      days = new Map();
      months.set(mk, days);
    }
    let dayAssets = days.get(dk);
    if (!dayAssets) {
      dayAssets = [];
      days.set(dk, dayAssets);
    }
    dayAssets.push(asset);
  }
  const rowProps: TileCommon = {
    inAlbum,
    albumId,
    isTrash,
    refresh,
    selectMode,
    onEnterSelectMode,
    onToggleSelect,
    onOpen,
  };
  return (
    <>
      {[...months].map(([mk, days]) => (
        <Fragment key={mk}>
          <h2 className={styles.monthLabel}>{fmtMonth(mk)}</h2>
          {[...days].map(([dk, dayAssets]) => (
            <Fragment key={dk}>
              <p className={styles.dayLabel}>{fmtDay(dk)}</p>
              {justify(dayAssets, containerWidth, targetHeight).map((tiles, i) => (
                <Row key={`${dk}-${i}`} tiles={tiles} selectedIds={selectedIds} {...rowProps} />
              ))}
            </Fragment>
          ))}
        </Fragment>
      ))}
      {truncated ? (
        <div className={`kit-foot ${styles.foot}`}>
          <span>
            {selected || query
              ? `This view covers your latest ${windowSize} photos — older ones may be missing. `
              : `Showing your latest ${windowSize} photos. `}
          </span>
          <button type="button" className="kit-btn" onClick={onShowMore}>
            Show more
          </button>
        </div>
      ) : null}
    </>
  );
}
