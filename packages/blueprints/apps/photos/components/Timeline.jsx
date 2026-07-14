// The Google-Photos-style justified timeline (replaces Grid.jsx): sticky
// month headers, day sub-labels, and rows packed edge-to-edge by
// `justify()` (layout.js) — real aspect ratios, no more rigid squares. The
// trash shelf rides the SAME timeline (unlike the old Grid.jsx's separate
// flat TrashGridBody) — the reference mockup folds trash into one timeline
// too; each tile just grows a purge-countdown/Restore footer via `isTrash`.
// `.ph-row` elements must stay DIRECT children of the month/day Fragments so
// month headers can `position: sticky` against the scroll pane — same
// constraint the old Grid.jsx's `.tile-wrap` had against `#grid`.
import { restoreAsset, toggleFavorite } from '../assets-actions.js';
import { cls, dayKey, fmtDay, fmtMonth } from '../format.js';
import { CheckIcon, HeartIcon } from '../icons.jsx';
import { justify } from '../layout.js';
import { mountMedia } from '../media.js';
import { act, narrate } from '../outcomes.js';
import { Fragment } from '../react-core.min.js';

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
}) {
  return (
    <div
      className={cls('ph-tile', selected && 'is-selected', isTrash && 'is-trash')}
      style={{ width: `${width}px`, height: `${height}px` }}
      data-asset-id={asset.asset_id}
    >
      {/* The media fill (thumb or placeholder) and any video glyph are drawn
          imperatively by mountMedia/fillTileMedia (media.js). */}
      <button
        type="button"
        className="ph-tile-media"
        ref={(el) => mountMedia(el, asset)}
        onClick={() => {
          if (isTrash) return;
          if (selectMode) onToggleSelect(asset.asset_id);
          else onOpen(asset.asset_id);
        }}
      ></button>
      <span className="ph-tile-scrim" aria-hidden="true" />
      {!isTrash ? (
        <button
          type="button"
          className="ph-tile-check"
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
          className="ph-tile-heart"
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
          className="ph-tile-remove"
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
        <div className="ph-tile-trash-bar">
          <span className="ph-tile-purge">
            {asset.purge_in_days == null
              ? ''
              : asset.purge_in_days === 0
                ? 'purges today'
                : `purges in ${asset.purge_in_days}d`}
          </span>
          <button
            type="button"
            className="ph-tile-restore"
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

function Row({ tiles, selectedIds, ...rest }) {
  return (
    <div className="ph-row">
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
}) {
  // A stable newest-first order regardless of the caller's source sort (the
  // trash shelf's own query sorts by deleted_at, not taken_at) — otherwise
  // bucketing by month/day below could scatter months out of order.
  const ordered = [...assets].sort((a, b) =>
    String(b.taken_at ?? '').localeCompare(String(a.taken_at ?? '')),
  );
  const months = new Map();
  for (const asset of ordered) {
    const dk = dayKey(asset.taken_at);
    const mk = dk.slice(0, 7);
    if (!months.has(mk)) months.set(mk, new Map());
    const days = months.get(mk);
    if (!days.has(dk)) days.set(dk, []);
    days.get(dk).push(asset);
  }
  const rowProps = {
    inAlbum,
    albumId,
    isTrash,
    refresh,
    selectMode,
    selectedIds,
    onEnterSelectMode,
    onToggleSelect,
    onOpen,
  };
  return (
    <>
      {[...months].map(([mk, days]) => (
        <Fragment key={mk}>
          <h2 className="ph-month-label">{fmtMonth(mk)}</h2>
          {[...days].map(([dk, dayAssets]) => (
            <Fragment key={dk}>
              <p className="ph-day-label">{fmtDay(dk)}</p>
              {justify(dayAssets, containerWidth, targetHeight).map((tiles, i) => (
                <Row key={`${dk}-${i}`} tiles={tiles} {...rowProps} />
              ))}
            </Fragment>
          ))}
        </Fragment>
      ))}
      {truncated ? (
        <div className="kit-foot ph-foot">
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
