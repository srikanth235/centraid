// The library grid: one tile per asset, grouped by month/day, plus the trash
// shelf's flat variant. `.tile-wrap` elements must stay DIRECT children of
// `#grid`: the timeline leans on `.grid`'s CSS Grid track flow plus
// `grid-column: 1 / -1` sticky month/day labels between tiles, so GridBody
// uses transparent `Fragment`s for month/day grouping instead of real
// wrapper nodes. `key={asset.asset_id}` on each tile is what keeps the
// underlying `<img>`/`<video>` node alive across refreshes.
import { toggleFavorite, restoreAsset } from '../assets-actions.js';
import { cls, dayKey, fmtDay, fmtMonth } from '../format.js';
import { mountMedia } from '../media.js';
import { act, narrate } from '../outcomes.js';
import { Fragment } from '../react-core.min.js';

function TileWrap({
  asset,
  inAlbum,
  selected,
  selectMode,
  albumId,
  refresh,
  onEnterSelectMode,
  onToggleSelect,
  onOpen,
}) {
  return (
    <div
      className={cls('tile-wrap', selected && 'selected', asset.favorite && 'faved')}
      data-asset-id={asset.asset_id}
    >
      <button
        type="button"
        className="tile"
        ref={(el) => mountMedia(el, asset)}
        onClick={(e) => {
          if (selectMode) onToggleSelect(asset.asset_id, e.shiftKey);
          else onOpen(asset.asset_id);
        }}
      ></button>
      <button
        type="button"
        className="tile-check"
        aria-label={selected ? 'Deselect' : 'Select'}
        onClick={(e) => {
          e.stopPropagation();
          if (!selectMode) onEnterSelectMode();
          onToggleSelect(asset.asset_id, e.shiftKey);
        }}
      ></button>
      <button
        type="button"
        className="tile-heart"
        aria-pressed={asset.favorite ? 'true' : 'false'}
        aria-label={asset.favorite ? 'Remove from favorites' : 'Add to favorites'}
        onClick={(e) => {
          e.stopPropagation();
          toggleFavorite(asset, refresh);
        }}
      >
        <span aria-hidden="true">{asset.favorite ? '♥' : '♡'}</span>
      </button>
      {inAlbum ? (
        <button
          type="button"
          className="tile-remove"
          title="Remove from album"
          aria-label="Remove from album"
          onClick={async () => {
            const outcome = await act('remove-from-album', {
              album_id: albumId,
              asset_id: asset.asset_id,
            });
            if (narrate(outcome)) await refresh();
          }}
        >
          <span aria-hidden="true">×</span>
        </button>
      ) : null}
    </div>
  );
}

// A trash tile: the photo, a purge countdown when one is derivable, and
// Restore — nothing else. No lightbox, no selection, no albums, no hearts.
function TrashTile({ asset, refresh }) {
  return (
    <div className="tile-wrap trash" data-asset-id={asset.asset_id}>
      <div className="tile" ref={(el) => mountMedia(el, asset)}></div>
      {asset.purge_in_days != null ? (
        <span className="tile-purge">
          {asset.purge_in_days === 0
            ? 'purges today'
            : `purges in ${asset.purge_in_days} ${asset.purge_in_days === 1 ? 'day' : 'days'}`}
        </span>
      ) : null}
      <button
        type="button"
        className="tile-restore"
        aria-label={`Restore ${asset.title ?? 'photo'}`}
        onClick={async (e) => {
          e.currentTarget.disabled = true;
          if (!(await restoreAsset(asset.asset_id, refresh))) e.currentTarget.disabled = false;
        }}
      >
        Restore
      </button>
    </div>
  );
}

// Bucket header + its tiles (open library only — the trash shelf forgoes the
// timeline). Months/days regroup fresh on every call (rebuilt `Map`s, same as
// before) via `Fragment`s keyed on the month/day key — a `Fragment` renders no
// DOM node of its own, so `.month-label`/`.day-label`/`.tile-wrap` still land
// as flat, direct children of `#grid`. Each day's tiles carry
// `key={asset.asset_id}`, so a tile (and its `<img>`) persists across
// refreshes instead of reloading.
export function GridBody({
  assets,
  inAlbum,
  albumId,
  refresh,
  libraryTruncated: truncated,
  selectedAlbum: selected,
  searchQuery: query,
  libraryWindow: windowSize,
  selectMode,
  selectedIds,
  onEnterSelectMode,
  onToggleSelect,
  onOpen,
  onShowMore,
}) {
  const months = new Map(); // month key -> Map(day key -> assets)
  for (const asset of assets) {
    const dk = dayKey(asset.taken_at);
    const mk = dk.slice(0, 7);
    if (!months.has(mk)) months.set(mk, new Map());
    const days = months.get(mk);
    if (!days.has(dk)) days.set(dk, []);
    days.get(dk).push(asset);
  }
  return (
    <>
      {[...months].map(([mk, days]) => (
        <Fragment key={mk}>
          <h2 className="month-label">{fmtMonth(mk)}</h2>
          {[...days].map(([dk, dayAssets]) => (
            <Fragment key={dk}>
              <p className="day-label muted small">{fmtDay(dk)}</p>
              {dayAssets.map((asset) => (
                <TileWrap
                  key={asset.asset_id}
                  asset={asset}
                  inAlbum={inAlbum}
                  albumId={albumId}
                  refresh={refresh}
                  selected={selectedIds.has(asset.asset_id)}
                  selectMode={selectMode}
                  onEnterSelectMode={onEnterSelectMode}
                  onToggleSelect={onToggleSelect}
                  onOpen={onOpen}
                />
              ))}
            </Fragment>
          ))}
        </Fragment>
      ))}
      {truncated ? (
        <div className="window-footer">
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

// Trash forgoes the timeline: newest-trashed first, purge labels on tiles.
export function TrashGridBody({ assets, refresh }) {
  return (
    <>
      {assets.map((asset) => (
        <TrashTile key={asset.asset_id} asset={asset} refresh={refresh} />
      ))}
    </>
  );
}
