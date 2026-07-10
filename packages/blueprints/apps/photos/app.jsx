// governance: allow-repo-hygiene file-size-limit blueprints are single-file by design (read wholesale by one agent); Photos is a finished product — upload, albums, lightbox editing, delete — and splitting it would break that "one file" contract.
// Photos — a pure projection over the personal vault. Every tile rendered
// here is a media.media_asset joined to its core.content_item; the bytes
// themselves are rented, addressed by content_uri, never copied into the
// app. Every write is a typed media command — add_asset, update_asset
// (captions, capture times, favorites), delete_asset (a trash with a
// ~30-day purge), restore_asset and the album set — all risk low,
// consent-checked and receipted, with identical bytes deduping onto one
// asset. The app stores nothing: revoke the grant and this page goes dark
// while the library remains the owner's.

import {
  armConfirm,
  BLOB_ROUTE,
  debounce,
  fmtBytes,
  localDayKey,
  outcomeMessage,
  readFailed,
  stageFileBytes,
  toast,
} from './kit.js';
// React owns six containers — one root per dynamic region of the static
// index.html body (chips, album tools, grid, selection bar, lightbox,
// picker). Each region's render orchestrator (renderGrid, renderLightbox, …)
// calls that root's `.render()` with the current external state on every
// change — the same "re-render the whole region from scratch" shape the Lit
// port used, just with React's reconciler doing the DOM diffing instead of
// lit-html's.
import { createRoot, Fragment, useEffect, useRef } from './react-core.min.js';

const $ = (id) => document.getElementById(id);

// Client-side ceiling per file. Bytes stream to the blob staging route
// (issue #296) — no base64 through command JSON — so a phone video fits;
// the route itself caps at 512 MB.
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

// Tiles never render the full-resolution bytes — each image is downscaled
// once to this longest edge and cached; the lightbox keeps the original.
const THUMB_EDGE = 360;

// Built-in shelves share the album strip without being albums. The prefix
// can never collide with a vault id — ids are opaque tokens, not colons.
const FAVORITES = 'built-in:favorites';
const TRASH = 'built-in:trash';

let assets = [];
let albums = [];
let trash = [];
let selectedAlbum = null; // null = All; an album_id; or FAVORITES / TRASH
let lightboxAssetId = null; // non-null while the lightbox is open
let uploading = false;
let readErrorShown = false;
let searchQuery = '';
let selectMode = false;
let batchBusy = false;
let selectAnchor = null; // last toggled asset_id, for shift-click ranges
const selectedIds = new Set();
const thumbCache = new Map(); // asset_id -> data URL string | Promise

// ---------- Outcome narration (shared pattern across apps) ----------

function notice(text) {
  const el = $('noticeBanner');
  el.textContent = text;
  el.hidden = !text;
}

function narrate(outcome, noteEl) {
  if (outcome?.status === 'executed') {
    notice('');
    if (noteEl) noteEl.textContent = '';
    return true;
  }
  const msg = outcomeMessage(outcome);
  if (msg != null) {
    notice(msg);
    if (noteEl) noteEl.textContent = msg;
  }
  return false;
}

async function act(action, input) {
  try {
    return await window.centraid.write({ action, input });
  } catch (err) {
    notice(String(err?.message ?? err));
    return undefined;
  }
}

// ---------- Formatting ----------

function dayKey(iso) {
  // Local wall-clock bucketing (kit localDayKey), never the UTC slice — an
  // evening photo must not land on tomorrow's stack.
  return iso ? localDayKey(iso) : '';
}

function fmtDay(key) {
  if (!key) return 'Undated';
  if (key === localDayKey(new Date())) return 'Today';
  if (key === localDayKey(new Date(Date.now() - 86400000))) return 'Yesterday';
  try {
    return new Date(`${key}T00:00:00`).toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return key;
  }
}

function fmtMonth(key) {
  if (!key) return 'Undated';
  try {
    return new Date(`${key}-01T00:00:00`).toLocaleDateString(undefined, {
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return key;
  }
}

// What a datetime-local input wants: local wall-clock, minute precision.
function toLocalInputValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Byte size straight off the asset row when the vault recorded one,
// otherwise recovered from the base64 payload length.
function assetBytes(asset) {
  const recorded = asset.byte_size ?? asset.bytes ?? asset.size_bytes;
  if (typeof recorded === 'number') return recorded;
  const uri = asset.content_uri;
  if (typeof uri === 'string' && uri.startsWith('data:')) {
    const comma = uri.indexOf(',');
    if (comma > 0 && uri.slice(0, comma).includes('base64')) {
      return Math.round(((uri.length - comma - 1) * 3) / 4);
    }
  }
  return null;
}

function isVideoAsset(asset) {
  const uri = asset.content_uri;
  if (typeof uri === 'string' && uri.startsWith('data:video')) return true;
  return asset.kind === 'video' || String(asset.media_type ?? '').startsWith('video/');
}

function isRenderableUri(uri) {
  return (
    typeof uri === 'string' &&
    (uri.startsWith('http:') ||
      uri.startsWith('https:') ||
      uri.startsWith('data:image') ||
      uri.startsWith('data:video') ||
      // Blob-backed bytes arrive as same-origin vault URLs (issue #296).
      uri.startsWith(BLOB_ROUTE + '/'))
  );
}

// ---------- Thumbnails ----------

// Downscale an image URI to THUMB_EDGE on the longest side, JPEG-encoded.
// Anything that refuses (decode error, tainted canvas) falls back to the
// original URI so a tile never goes blank.
function makeThumb(uri) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const long = Math.max(img.naturalWidth, img.naturalHeight);
      if (!long || long <= THUMB_EDGE) {
        resolve(uri);
        return;
      }
      const scale = THUMB_EDGE / long;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      try {
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      } catch {
        resolve(uri);
      }
    };
    img.onerror = () => resolve(uri);
    img.src = uri;
  });
}

function setThumbSrc(img, asset) {
  // Blob-backed assets have a server-side variant endpoint (issue #296):
  // the grid loads ~KB thumbs, never full originals. A 404 (no variant
  // produced) falls back to the original bytes — a tile never goes blank.
  if (typeof asset.thumb_uri === 'string') {
    img.onerror = () => {
      img.onerror = null;
      img.src = asset.content_uri;
    };
    img.src = asset.thumb_uri;
    return;
  }
  const cached = thumbCache.get(asset.asset_id);
  if (typeof cached === 'string') {
    img.src = cached;
    return;
  }
  const pending =
    cached ??
    makeThumb(asset.content_uri).then((thumb) => {
      thumbCache.set(asset.asset_id, thumb);
      return thumb;
    });
  if (!cached) thumbCache.set(asset.asset_id, pending);
  pending.then((thumb) => {
    img.src = thumb;
  });
}

// ---------- Data ----------

// The browse window: the library query reads only this many recent live
// assets (trash rides beside it, capped server-side). "Show more" grows it —
// photos has no search plane, so the window is the only way back in time.
let libraryWindow = 500;
let libraryTruncated = false;

async function refresh() {
  let data;
  try {
    data = await window.centraid.read({ query: 'library', input: { limit: libraryWindow } });
  } catch {
    // A broken vault must not look like an empty one.
    readFailed($('noticeBanner'));
    readErrorShown = true;
    return;
  }
  if (readErrorShown) {
    notice('');
    readErrorShown = false;
  }
  const denied = data?.vaultDenied;
  $('consentBanner').hidden = !denied;
  $('live').hidden = Boolean(denied);
  // The sidebar wrapper only opens once a read lands — until then (and
  // while consent is denied) the grid pane keeps the full width.
  $('sideNav').hidden = Boolean(denied);
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    return;
  }
  assets = data?.assets ?? [];
  albums = data?.albums ?? [];
  trash = data?.trash ?? [];
  libraryTruncated = Boolean(data?.truncated);
  // The trash shelf folds away when it empties; Favorites is always a place.
  if (selectedAlbum === TRASH && trash.length === 0) selectedAlbum = null;
  if (
    selectedAlbum &&
    selectedAlbum !== FAVORITES &&
    selectedAlbum !== TRASH &&
    !albums.some((a) => a.album_id === selectedAlbum)
  ) {
    selectedAlbum = null;
  }
  for (const id of [...selectedIds]) {
    if (!assets.some((a) => a.asset_id === id)) selectedIds.delete(id);
  }
  renderToolbar();
  renderGrid();
  renderSelectionBar();
  if (lightboxAssetId != null) renderLightbox();
}

function albumAssets() {
  if (!selectedAlbum) return assets;
  if (selectedAlbum === FAVORITES) return assets.filter((a) => a.favorite);
  if (selectedAlbum === TRASH) return trash;
  return assets.filter((a) => a.album_ids?.includes(selectedAlbum));
}

function matchesSearch(asset) {
  if (!searchQuery) return true;
  const key = dayKey(asset.taken_at);
  const hay = [
    asset.title,
    asset.kind,
    asset.media_type,
    key,
    fmtDay(key),
    fmtMonth(key.slice(0, 7)),
    ...(asset.album_titles ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return searchQuery
    .toLowerCase()
    .split(/\s+/)
    .every((token) => hay.includes(token));
}

// What the grid shows right now: the album filter, then the search filter.
function visibleAssets() {
  return albumAssets().filter(matchesSearch);
}

// ---------- Small builders ----------

// Joins truthy class fragments — the same `.tile-wrap selected faved`-style
// composition the Lit port used, unchanged by the move to JSX (`className=`
// still just wants a string).
const cls = (...parts) => parts.filter(Boolean).join(' ');

// Used only by `renderFaces` below, which stays a fully-imperative DOM
// builder (see that function's comment) — it constructs its own `<button>`s
// the same way the pre-Lit app always did.
function kitBtn(label, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'kit-btn';
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

// A shared "type a name, Enter to submit, Escape/blur to cancel" input used
// by both the new-album chip and the album rename control. Uncontrolled
// (`defaultValue`, not `value`) — like the vanilla/Lit versions before it, it
// never re-renders on keystroke; only Enter/Escape/blur touch app state. The
// ref-based focus/select guard mirrors `mountMedia`'s once-only pattern.
function InlineInput({
  value = '',
  placeholder,
  label,
  className,
  autoSelect = false,
  onSubmit,
  onCancel,
}) {
  return (
    <input
      type="text"
      className={className}
      defaultValue={value}
      placeholder={placeholder}
      aria-label={label}
      ref={(el) => {
        if (!el || el.dataset.wired) return;
        el.dataset.wired = '1';
        el.focus();
        if (autoSelect) el.select();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          onCancel();
          return;
        }
        if (e.key !== 'Enter') return;
        const title = e.currentTarget.value.trim();
        if (!title) {
          onCancel();
          return;
        }
        e.currentTarget.disabled = true;
        onSubmit(title);
      }}
      onBlur={(e) => {
        if (e.currentTarget.disabled) return; // mid-submit — disabling already fired this blur
        onCancel();
      }}
    />
  );
}

// A tile's media fill (fillTileMedia, below) is imperative — image decode,
// video setup, placeholder text — and must run exactly once per mounted
// element. `mountMedia` is that guard, now wired through a React callback
// ref instead of a Lit `ref()` directive: React calls it once when a tile's
// `<button class="tile">` mounts and again (with `null`) on unmount, and the
// dataset check makes every call besides the first a no-op. Pairing this
// with a stable `key={asset.asset_id}` on the tile (see TileWrap) is what
// keeps the underlying `<img>`/`<video>` node — and therefore its already
// loaded bytes — alive across refreshes, the same guarantee the Lit port got
// from keyed `repeat()`.
function mountMedia(el, asset) {
  if (!el || el.dataset.mediaFor === asset.asset_id) return;
  el.dataset.mediaFor = asset.asset_id;
  fillTileMedia(el, asset);
}

// ---------- Albums toolbar ----------

function renderToolbar() {
  renderChips();
  renderAlbumTools();
  // Trash tiles offer exactly one action — selection has nothing to select.
  $('selectBtn').hidden = selectedAlbum === TRASH;
}

function selectAlbum(albumId) {
  selectedAlbum = albumId;
  if (selectMode) exitSelectMode();
  renderToolbar();
  renderGrid();
}

function Chip({ label, active, onClick, extraClass }) {
  return (
    <button
      type="button"
      className={extraClass ? `kit-chip ${extraClass}` : 'kit-chip'}
      data-active={active ? 'true' : 'false'}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

// The "＋ New album" chip while typing, else null — a singleton flag, not
// per-album state (unlike the rename guard below).
let newAlbumOpen = false;

function startNewAlbum() {
  newAlbumOpen = true;
  renderToolbar();
}

async function submitNewAlbum(title) {
  const outcome = await act('create-album', { title });
  newAlbumOpen = false;
  if (narrate(outcome)) {
    if (outcome.output?.album_id) selectedAlbum = outcome.output.album_id;
    await refresh();
  } else {
    renderToolbar();
  }
}

function cancelNewAlbum() {
  newAlbumOpen = false;
  renderToolbar();
}

function ChipsView({
  albums: albumList,
  selectedAlbum: selected,
  trashCount,
  newAlbumOpen: editing,
  onSelect,
}) {
  return (
    <>
      <Chip label="All" active={selected === null} onClick={() => onSelect(null)} />
      <Chip
        label="♥ Favorites"
        active={selected === FAVORITES}
        onClick={() => onSelect(FAVORITES)}
      />
      {albumList.map((album) => (
        <Chip
          key={album.album_id}
          label={album.title ?? 'Album'}
          active={selected === album.album_id}
          onClick={() => onSelect(album.album_id)}
        />
      ))}
      {editing ? (
        <InlineInput
          key="new-album"
          className="chip-input"
          placeholder="Album name"
          label="New album name"
          onSubmit={submitNewAlbum}
          onCancel={cancelNewAlbum}
        />
      ) : (
        <button type="button" className="kit-chip chip-new" onClick={startNewAlbum}>
          ＋ New album
        </button>
      )}
      {trashCount > 0 ? (
        <Chip
          label={`Trash (${trashCount})`}
          active={selected === TRASH}
          onClick={() => onSelect(TRASH)}
          extraClass="chip-trash"
        />
      ) : null}
    </>
  );
}

function renderChips() {
  const nav = $('albumChips');
  nav.hidden = false;
  chipsRoot.render(
    <ChipsView
      albums={albums}
      selectedAlbum={selectedAlbum}
      trashCount={trash.length}
      newAlbumOpen={newAlbumOpen}
      onSelect={selectAlbum}
    />,
  );
}

// Which album is mid-rename, else null — `renderAlbumTools` discards it the
// moment the selected album no longer matches (switching albums must never
// show album X's half-typed rename inside album Y's tools). The rename
// `<input>` is also keyed by album id (see AlbumToolsView), so React mints a
// fresh DOM node on top of the JS guard rather than relying on either alone.
let renamingAlbumForId = null;

function startRenameAlbum(album) {
  renamingAlbumForId = album.album_id;
  renderToolbar();
}

async function submitRenameAlbum(album, title) {
  const outcome = await act('rename-album', { album_id: album.album_id, title });
  renamingAlbumForId = null;
  if (narrate(outcome)) await refresh();
  else renderToolbar();
}

function cancelRenameAlbum() {
  renamingAlbumForId = null;
  renderToolbar();
}

async function deleteAlbumConfirmed(album) {
  const outcome = await act('delete-album', { album_id: album.album_id });
  if (narrate(outcome)) {
    selectedAlbum = null;
    toast('Album deleted — its photos stay in your library.');
    await refresh();
  }
}

function AlbumToolsView({ album, count, renaming, onAdd, onDelete }) {
  if (renaming) {
    return (
      <InlineInput
        key={album.album_id}
        value={album.title ?? ''}
        placeholder="Album name"
        label="Rename album"
        autoSelect
        onSubmit={(title) => submitRenameAlbum(album, title)}
        onCancel={cancelRenameAlbum}
      />
    );
  }
  return (
    <>
      <span className="album-tools-label">
        {count} {count === 1 ? 'photo' : 'photos'} in this album
      </span>
      <button type="button" className="kit-btn" onClick={onAdd}>
        Add photos
      </button>
      <button type="button" className="kit-btn" onClick={() => startRenameAlbum(album)}>
        Rename
      </button>
      <button
        type="button"
        className="kit-btn danger"
        onClick={(e) => {
          if (!armConfirm(e.currentTarget, { armedLabel: 'Delete album?' })) return;
          onDelete(album);
        }}
      >
        Delete album
      </button>
    </>
  );
}

function renderAlbumTools() {
  const tools = $('albumTools');
  const album = albums.find((a) => a.album_id === selectedAlbum);
  tools.hidden = !album;
  if (!album) {
    renamingAlbumForId = null;
    albumToolsRoot.render(null);
    return;
  }
  if (renamingAlbumForId !== album.album_id) renamingAlbumForId = null;
  albumToolsRoot.render(
    <AlbumToolsView
      album={album}
      count={albumAssets().length}
      renaming={renamingAlbumForId === album.album_id}
      onAdd={openPicker}
      onDelete={deleteAlbumConfirmed}
    />,
  );
}

// ---------- Grid ----------

// One grid tile: the media button, the always-present select dot, the
// hover-reveal favorite heart, and (inside an album) the leave-album
// control. `.tile-wrap` elements must stay DIRECT children of `#grid`: the
// timeline leans on `.grid`'s CSS Grid track flow plus `grid-column: 1 / -1`
// sticky month/day labels between tiles, so this never wraps its siblings in
// an intermediate element (see GridBody, which uses transparent `Fragment`s
// for the month/day grouping instead of real wrapper nodes).
function TileWrap({ asset, inAlbum, selected }) {
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
          if (selectMode) toggleSelect(asset.asset_id, e.shiftKey);
          else openLightbox(asset.asset_id);
        }}
      ></button>
      <button
        type="button"
        className="tile-check"
        aria-label={selected ? 'Deselect' : 'Select'}
        onClick={(e) => {
          e.stopPropagation();
          if (!selectMode) enterSelectMode();
          toggleSelect(asset.asset_id, e.shiftKey);
        }}
      ></button>
      <button
        type="button"
        className="tile-heart"
        aria-pressed={asset.favorite ? 'true' : 'false'}
        aria-label={asset.favorite ? 'Remove from favorites' : 'Add to favorites'}
        onClick={(e) => {
          e.stopPropagation();
          toggleFavorite(asset);
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
              album_id: selectedAlbum,
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
function TrashTile({ asset }) {
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
          if (!(await restoreAsset(asset.asset_id))) e.currentTarget.disabled = false;
        }}
      >
        Restore
      </button>
    </div>
  );
}

// The visual guts of a tile — shared by the grid, the trash shelf and the
// album picker. Imperative on purpose: `mountMedia` guards it to run once per
// mounted element, exactly like the old code's one-time build.
function fillTileMedia(tile, asset) {
  if (isRenderableUri(asset.content_uri) && isVideoAsset(asset)) {
    const vid = document.createElement('video');
    vid.src = asset.content_uri;
    vid.muted = true;
    vid.playsInline = true;
    vid.preload = 'metadata';
    vid.setAttribute('aria-label', asset.title ?? 'Video');
    tile.appendChild(vid);
    const badge = document.createElement('span');
    badge.className = 'tile-video-badge';
    badge.textContent = '▶';
    badge.setAttribute('aria-hidden', 'true');
    tile.appendChild(badge);
  } else if (isRenderableUri(asset.content_uri)) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = asset.title ?? asset.kind ?? 'Photo';
    setThumbSrc(img, asset);
    tile.appendChild(img);
  } else {
    tile.classList.add('placeholder');
    const type = document.createElement('span');
    type.className = 'placeholder-type';
    type.textContent = asset.media_type ?? asset.kind ?? 'media';
    const title = document.createElement('span');
    title.className = 'placeholder-title';
    title.textContent = asset.title ?? '';
    tile.append(type, title);
  }
}

// Bucket header + its tiles (open library only — the trash shelf forgoes the
// timeline). Months/days regroup fresh on every call (rebuilt `Map`s, same as
// before) via `Fragment`s keyed on the month/day key — a `Fragment` renders no
// DOM node of its own, so `.month-label`/`.day-label`/`.tile-wrap` still land
// as flat, direct children of `#grid`. Each day's tiles carry
// `key={asset.asset_id}`, so a tile (and its `<img>`) persists across
// refreshes instead of reloading — the React analogue of the Lit port's keyed
// `repeat()`.
function GridBody({
  months,
  inAlbum,
  libraryTruncated: truncated,
  selectedAlbum: selected,
  searchQuery: query,
  libraryWindow: windowSize,
  onShowMore,
}) {
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
                  selected={selectedIds.has(asset.asset_id)}
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

function renderGrid() {
  const grid = $('grid');
  grid.classList.toggle('selecting', selectMode);
  const shown = visibleAssets();
  const empty = $('empty');
  empty.hidden = shown.length > 0;
  if (shown.length === 0) {
    const searching = searchQuery !== '';
    $('emptyText').textContent = searching
      ? `No matches for “${searchQuery}”.`
      : selectedAlbum === FAVORITES
        ? 'No favorites yet — tap the heart on any photo.'
        : selectedAlbum === TRASH
          ? 'Trash is empty.'
          : selectedAlbum
            ? 'Nothing in this album yet.'
            : 'No photos yet — your library starts with the first upload.';
    $('emptyUpload').hidden = searching || selectedAlbum === FAVORITES || selectedAlbum === TRASH;
  }
  // Trash forgoes the timeline: newest-trashed first, purge labels on tiles.
  if (selectedAlbum === TRASH) {
    gridRoot.render(
      <>
        {shown.map((asset) => (
          <TrashTile key={asset.asset_id} asset={asset} />
        ))}
      </>,
    );
    return;
  }
  // Google-Photos-style timeline: sticky month headers, day labels inside.
  const inAlbum = albums.some((a) => a.album_id === selectedAlbum);
  const months = new Map(); // month key -> Map(day key -> assets)
  for (const asset of shown) {
    const dk = dayKey(asset.taken_at);
    const mk = dk.slice(0, 7);
    if (!months.has(mk)) months.set(mk, new Map());
    const days = months.get(mk);
    if (!days.has(dk)) days.set(dk, []);
    days.get(dk).push(asset);
  }
  // The window is honest about its edge: All, Favorites, albums and the
  // client-side search all filter the same loaded slice, so any of them can
  // silently miss photos older than the window. "Show more" grows it — with
  // no search plane, that is the only road back in time.
  gridRoot.render(
    <GridBody
      months={months}
      inAlbum={inAlbum}
      libraryTruncated={libraryTruncated}
      selectedAlbum={selectedAlbum}
      searchQuery={searchQuery}
      libraryWindow={libraryWindow}
      onShowMore={async (e) => {
        e.target.disabled = true;
        libraryWindow += 500;
        await refresh();
      }}
    />,
  );
}

async function toggleFavorite(asset, noteEl) {
  const outcome = await act('update-asset', {
    asset_id: asset.asset_id,
    favorite: asset.favorite ? 0 : 1,
  });
  if (narrate(outcome, noteEl)) await refresh();
}

// Restore one trashed asset; shared by the trash tile, the delete-toast
// Undo, and the batch Undo-all. Album membership does not come back.
async function restoreAsset(assetId, { quiet = false } = {}) {
  const outcome = await act('restore', { asset_id: assetId });
  if (!narrate(outcome)) return false;
  if (!quiet) toast('Photo restored to your library.');
  await refresh();
  return true;
}

// ---------- Multi-select ----------

function enterSelectMode() {
  selectMode = true;
  selectAnchor = null;
  $('selectBtn').textContent = 'Cancel';
  $('selectBtn').dataset.active = 'true';
  document.body.classList.add('has-selection');
  renderGrid();
  renderSelectionBar();
}

function exitSelectMode() {
  selectMode = false;
  selectedIds.clear();
  selectAnchor = null;
  $('selectBtn').textContent = 'Select';
  delete $('selectBtn').dataset.active;
  document.body.classList.remove('has-selection');
  closeAlbumMenu();
  renderGrid();
  renderSelectionBar();
}

function toggleSelect(assetId, shiftKey) {
  if (batchBusy) return;
  const list = visibleAssets();
  if (shiftKey && selectAnchor && selectAnchor !== assetId) {
    const a = list.findIndex((x) => x.asset_id === selectAnchor);
    const b = list.findIndex((x) => x.asset_id === assetId);
    if (a >= 0 && b >= 0) {
      const on = !selectedIds.has(assetId);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) {
        if (on) selectedIds.add(list[i].asset_id);
        else selectedIds.delete(list[i].asset_id);
      }
      selectAnchor = assetId;
      renderGrid();
      renderSelectionBar();
      return;
    }
  }
  if (selectedIds.has(assetId)) selectedIds.delete(assetId);
  else selectedIds.add(assetId);
  selectAnchor = assetId;
  renderGrid();
  renderSelectionBar();
}

// ---------- Selection bar ----------

// The "Add to album ▾" menu is a small, transient popover that only this app
// owns (it isn't a kit popover) — a plain open/closed flag, kept deliberately
// imperative like the old code: an away-click listener is added/removed in
// lockstep with it, which is more fragile to reason about as reactive state
// than as a plain boolean.
let albumMenuOpen = false;

function closeAlbumMenu() {
  if (!albumMenuOpen) return;
  albumMenuOpen = false;
  document.removeEventListener('click', onAlbumMenuAway, true);
}

function onAlbumMenuAway(e) {
  const wrap = $('selectionBar').querySelector('.bar-menu-wrap');
  if (wrap && !wrap.contains(e.target)) {
    closeAlbumMenu();
    renderSelectionBar();
  }
}

function toggleAlbumMenu() {
  if (albumMenuOpen) {
    closeAlbumMenu();
    renderSelectionBar();
    return;
  }
  albumMenuOpen = true;
  renderSelectionBar();
  document.addEventListener('click', onAlbumMenuAway, true);
}

function SelectionBarView({ count, albums: albumList }) {
  const countRef = useRef(null);
  return (
    <>
      <span className="bar-count" ref={countRef}>
        {count === 0 ? 'Select photos' : `${count} selected`}
      </span>
      <div className="bar-menu-wrap">
        <button
          type="button"
          className="kit-btn bar-btn"
          aria-haspopup="true"
          disabled={count === 0}
          onClick={() => toggleAlbumMenu()}
        >
          Add to album ▾
        </button>
        {albumMenuOpen ? (
          <div className="album-menu" role="menu">
            {albumList.length === 0 ? (
              <p className="album-menu-empty">No albums yet — make one from the chips above.</p>
            ) : (
              albumList.map((album) => (
                <button
                  key={album.album_id}
                  type="button"
                  className="album-menu-item"
                  role="menuitem"
                  onClick={() => {
                    closeAlbumMenu();
                    renderSelectionBar();
                    batchAddToAlbum([...selectedIds], album, countRef.current);
                  }}
                >
                  {album.title ?? 'Album'}
                </button>
              ))
            )}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className="kit-btn bar-btn danger"
        disabled={count === 0}
        onClick={(e) => {
          if (batchBusy || selectedIds.size === 0) return;
          if (!armConfirm(e.currentTarget, { armedLabel: `Delete ${selectedIds.size}?` })) return;
          batchDelete([...selectedIds], countRef.current);
        }}
      >
        Delete
      </button>
      <button
        type="button"
        className="bar-close"
        aria-label="Exit selection"
        onClick={exitSelectMode}
      >
        ×
      </button>
    </>
  );
}

function renderSelectionBar() {
  const bar = $('selectionBar');
  bar.hidden = !selectMode;
  if (!selectMode) {
    selectionBarRoot.render(null);
    return;
  }
  selectionBarRoot.render(<SelectionBarView count={selectedIds.size} albums={albums} />);
}

function setBarBusy(on) {
  batchBusy = on;
  for (const btn of $('selectionBar').querySelectorAll('button')) btn.disabled = on;
}

async function batchDelete(ids, progressEl) {
  setBarBusy(true);
  let parked = 0;
  let failed = 0;
  let lastBad = null;
  const trashedIds = []; // what actually landed in the trash — Undo's manifest
  for (let i = 0; i < ids.length; i += 1) {
    progressEl.textContent = `Deleting ${i + 1} of ${ids.length}…`;
    const outcome = await act('delete-asset', { asset_id: ids[i] });
    if (outcome?.status === 'executed') trashedIds.push(ids[i]);
    else if (outcome?.status === 'parked') parked += 1;
    else {
      failed += 1;
      lastBad = outcome;
    }
  }
  setBarBusy(false);
  exitSelectMode();
  await refresh();
  const ok = trashedIds.length;
  const parts = [];
  if (ok > 0) parts.push(`Moved ${ok} ${ok === 1 ? 'item' : 'items'} to trash`);
  if (parked > 0) parts.push(`${parked} awaiting approval`);
  if (failed > 0) parts.push(`${failed} failed`);
  const summary = parts.join(' · ') || 'Nothing to do';
  if (ok > 0) toast(summary, { undoLabel: 'Undo', onUndo: () => batchRestore(trashedIds) });
  else toast(summary);
  if (lastBad) narrate(lastBad);
}

async function batchRestore(ids) {
  let ok = 0;
  let bad = 0;
  let lastBad = null;
  for (const id of ids) {
    const outcome = await act('restore', { asset_id: id });
    if (outcome?.status === 'executed') ok += 1;
    else {
      bad += 1;
      lastBad = outcome;
    }
  }
  await refresh();
  const parts = [];
  if (ok > 0) parts.push(`Restored ${ok} ${ok === 1 ? 'item' : 'items'}`);
  if (bad > 0) parts.push(`${bad} not restored`);
  toast(parts.join(' · ') || 'Nothing to restore');
  if (lastBad) narrate(lastBad);
}

async function batchAddToAlbum(ids, album, progressEl) {
  setBarBusy(true);
  let ok = 0;
  let parked = 0;
  let skipped = 0;
  for (let i = 0; i < ids.length; i += 1) {
    progressEl.textContent = `Adding ${i + 1} of ${ids.length}…`;
    const outcome = await act('add-to-album', { album_id: album.album_id, asset_id: ids[i] });
    if (outcome?.status === 'executed') ok += 1;
    else if (outcome?.status === 'parked') parked += 1;
    else skipped += 1; // usually "already in the album" — a precondition, not an error
  }
  setBarBusy(false);
  exitSelectMode();
  await refresh();
  const parts = [];
  if (ok > 0) parts.push(`Added ${ok} to “${album.title ?? 'Album'}”`);
  if (parked > 0) parts.push(`${parked} awaiting approval`);
  if (skipped > 0) parts.push(`${skipped} already there`);
  toast(parts.join(' · ') || 'Nothing to add');
}

// ---------- Lightbox ----------

function openLightbox(assetId) {
  lightboxAssetId = assetId;
  renderLightbox();
}

function closeLightbox() {
  lightboxAssetId = null;
  const box = $('lightbox');
  box.hidden = true;
  lightboxRoot.render(null);
}

function step(delta) {
  const list = visibleAssets();
  const idx = list.findIndex((a) => a.asset_id === lightboxAssetId);
  const next = idx < 0 ? undefined : list[idx + delta];
  if (!next) return;
  lightboxAssetId = next.asset_id;
  renderLightbox();
}

// Double-click zooms the stage image; while zoomed a pointer drag pans it.
function wireZoom(img) {
  let zoomed = false;
  let panX = 0;
  let panY = 0;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  const apply = () => {
    img.style.transform = zoomed ? `translate(${panX}px, ${panY}px) scale(2.5)` : '';
    img.classList.toggle('zoomed', zoomed);
  };
  img.classList.add('zoomable');
  img.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    zoomed = !zoomed;
    panX = 0;
    panY = 0;
    apply();
  });
  img.addEventListener('pointerdown', (e) => {
    if (!zoomed) return;
    dragging = true;
    startX = e.clientX - panX;
    startY = e.clientY - panY;
    img.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  img.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    panX = e.clientX - startX;
    panY = e.clientY - startY;
    apply();
  });
  const stop = () => {
    dragging = false;
  };
  img.addEventListener('pointerup', stop);
  img.addEventListener('pointercancel', stop);
  // A drag while zoomed must not fall through as a backdrop click.
  img.addEventListener('click', (e) => e.stopPropagation());
}

// The stage's media (image/video/placeholder), keyed by `asset_id` where it's
// mounted (LightboxShell, below): stepping to a different photo always mints
// a fresh element (so zoom state never bleeds from one photo to the next),
// while a background refresh landing on the SAME photo reuses the node (so
// the image doesn't reload/flicker) — the same guarantee the Lit port's
// keyed single-item `repeat()` gave the stage. `wireZoom` is guarded per
// element (via the ref's dataset check) so reuse never double-attaches its
// pointer/dblclick listeners; this stays the one genuinely imperative island
// in the lightbox, same as the Lit port.
function Stage({ asset, onDims }) {
  if (isRenderableUri(asset.content_uri) && isVideoAsset(asset)) {
    return (
      <video
        src={asset.content_uri}
        muted
        playsInline
        controls
        preload="metadata"
        aria-label={asset.title ?? 'Video'}
      ></video>
    );
  }
  if (isRenderableUri(asset.content_uri)) {
    const needsProbe = asset.width == null || asset.height == null;
    return (
      <img
        src={asset.content_uri}
        alt={asset.title ?? asset.kind ?? 'Photo'}
        ref={(el) => {
          if (!el || el.dataset.zoomWired) return;
          el.dataset.zoomWired = '1';
          wireZoom(el);
        }}
        onLoad={(e) => {
          if (needsProbe) onDims(e.target.naturalWidth, e.target.naturalHeight);
        }}
      />
    );
  }
  return <div className="lightbox-placeholder">{asset.media_type ?? asset.kind ?? 'media'}</div>;
}

// The lightbox's caption/capture-time form, info line and faces host, keyed
// by `renderSeq` (so every call to `renderLightbox` mints a wholly fresh copy
// of this subtree) — exactly mirroring the Lit port's choice to rebuild these
// as plain nodes on every call, because they're written into by scattered
// async handlers (save, faces confirm/reject, the stage's load-driven
// dimension probe) whose closures are simplest when they close over a
// stable, already-existing element. `setInfoRef` is how the sibling `Stage`
// (which does NOT remount on a same-photo refresh) reaches whichever
// `PanelBody` is currently mounted — its effect refreshes that ref's target
// on every mount, the same way the old code's `setInfo` closure got replaced
// by each `renderLightbox` call even though the stage element itself
// persisted underneath it.
function PanelBody({ asset, albums: albumList, setInfoRef }) {
  const noteRef = useRef(null);
  const infoRef = useRef(null);
  const facesHostRef = useRef(null);

  useEffect(() => {
    setInfoRef.current = (w, h) => {
      const parts = [asset.kind ?? 'photo'];
      const width = asset.width ?? w;
      const height = asset.height ?? h;
      if (width && height) parts.push(`${width}×${height}`);
      const size = fmtBytes(assetBytes(asset));
      if (size) parts.push(size);
      const t = asset.taken_at ? new Date(asset.taken_at) : null;
      if (t && !Number.isNaN(t.getTime())) {
        parts.push(t.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
      }
      if (infoRef.current) infoRef.current.textContent = parts.join(' · ');
    };
    setInfoRef.current();
    // People (issue #299): the enricher's face proposals with the owner's
    // confirm/reject loop. Loaded async so an empty vault costs nothing; the
    // section only appears when regions exist.
    renderFaces(facesHostRef.current, asset.asset_id, noteRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- this component
    // remounts fresh on every renderLightbox() call (keyed by renderSeq), so
    // "run once per mount" already means "run once per asset+refresh pass".
  }, []);

  return (
    <>
      <div className="lightbox-meta">
        <input
          type="text"
          className="lightbox-title"
          defaultValue={asset.title ?? ''}
          placeholder="Add a caption"
          aria-label="Caption"
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          onChange={async (e) => {
            const title = e.currentTarget.value.trim();
            if (title === (asset.title ?? '')) return;
            const outcome = await act('update-asset', { asset_id: asset.asset_id, title });
            if (narrate(outcome, noteRef.current)) await refresh();
          }}
        />
        <input
          type="datetime-local"
          className="lightbox-when"
          defaultValue={toLocalInputValue(asset.captured_at ?? asset.taken_at)}
          aria-label="Capture time"
          onChange={async (e) => {
            if (!e.currentTarget.value) return;
            const d = new Date(e.currentTarget.value);
            if (Number.isNaN(d.getTime())) return;
            const outcome = await act('update-asset', {
              asset_id: asset.asset_id,
              captured_at: d.toISOString(),
            });
            if (narrate(outcome, noteRef.current)) await refresh();
          }}
        />
      </div>
      <p className="lightbox-info" ref={infoRef}></p>
      {albumList.length > 0 ? (
        <div className="lightbox-albums">
          {albumList.map((album) => {
            const member = asset.album_ids?.includes(album.album_id) ?? false;
            return (
              <button
                key={album.album_id}
                type="button"
                className="kit-chip"
                data-active={member ? 'true' : 'false'}
                onClick={async () => {
                  const outcome = await act(member ? 'remove-from-album' : 'add-to-album', {
                    album_id: album.album_id,
                    asset_id: asset.asset_id,
                  });
                  if (narrate(outcome, noteRef.current)) await refresh();
                }}
              >
                {member ? `✓ ${album.title ?? 'Album'}` : (album.title ?? 'Album')}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="lightbox-faces" ref={facesHostRef}></div>
      <div className="lightbox-actions">
        <button
          type="button"
          className={cls('kit-btn', 'lightbox-fav', asset.favorite && 'faved')}
          aria-pressed={asset.favorite ? 'true' : 'false'}
          onClick={async () => {
            await toggleFavorite(asset, noteRef.current); // refresh re-renders this lightbox
          }}
        >
          {asset.favorite ? '♥ Favorited' : '♡ Favorite'}
        </button>
        {isRenderableUri(asset.content_uri) ||
        String(asset.content_uri ?? '').startsWith('data:') ? (
          <a
            className="kit-btn lightbox-download"
            href={asset.content_uri}
            download={(asset.title ?? '').trim() || `photo-${asset.asset_id}`}
          >
            Download
          </a>
        ) : null}
        <button
          type="button"
          className="kit-btn danger"
          onClick={async (e) => {
            if (!armConfirm(e.currentTarget, { armedLabel: 'Delete photo?' })) return;
            const outcome = await act('delete-asset', { asset_id: asset.asset_id });
            if (narrate(outcome, noteRef.current)) {
              closeLightbox();
              toast('Moved to trash — it leaves every album it was in.', {
                undoLabel: 'Undo',
                onUndo: () => restoreAsset(asset.asset_id),
              });
              await refresh();
            }
          }}
        >
          Delete photo
        </button>
      </div>
      <p className="lightbox-note" ref={noteRef}></p>
    </>
  );
}

// The lightbox shell itself never remounts while open — only its two
// independently keyed children do (Stage by asset_id, PanelBody by
// renderSeq) — so `setInfoRef` (a plain ref holding "whatever PanelBody's
// current setInfo function is") survives across both stepping and refreshing.
function LightboxShell({ asset, idx, list, albums: albumList, renderSeq }) {
  const setInfoRef = useRef(() => {});
  return (
    <>
      <div className="lightbox-stage" onClick={(e) => e.stopPropagation()}>
        <Stage key={asset.asset_id} asset={asset} onDims={(w, h) => setInfoRef.current(w, h)} />
      </div>
      {[
        ['prev', -1, '‹', 'Previous photo'],
        ['next', 1, '›', 'Next photo'],
      ].map(([variant, delta, glyph, name]) => (
        <button
          key={variant}
          type="button"
          className={`lightbox-nav ${variant}`}
          aria-label={name}
          disabled={idx < 0 || !list[idx + delta]}
          onClick={(e) => {
            e.stopPropagation();
            step(delta);
          }}
        >
          {glyph}
        </button>
      ))}
      <div className="lightbox-panel" onClick={(e) => e.stopPropagation()}>
        <PanelBody key={renderSeq} asset={asset} albums={albumList} setInfoRef={setInfoRef} />
      </div>
    </>
  );
}

let lightboxRenderSeq = 0;

function renderLightbox() {
  const box = $('lightbox');
  const asset = assets.find((a) => a.asset_id === lightboxAssetId);
  if (!asset) {
    closeLightbox();
    return;
  }
  lightboxRenderSeq += 1;
  const list = visibleAssets();
  const idx = list.findIndex((a) => a.asset_id === asset.asset_id);
  lightboxRoot.render(
    <LightboxShell
      asset={asset}
      idx={idx}
      list={list}
      albums={albums}
      renderSeq={lightboxRenderSeq}
    />,
  );
  box.hidden = false;
}

$('lightbox').addEventListener('click', closeLightbox);

// ---------- Album picker ("Add photos" from inside an album) ----------

let pickerAlbum = null;
const pickerPicked = new Set();

function closePicker() {
  const p = $('picker');
  p.hidden = true;
  pickerRoot.render(null);
  pickerAlbum = null;
  pickerPicked.clear();
}

function PickerTile({ asset, picked, onToggle }) {
  return (
    <button
      type="button"
      className="picker-tile"
      aria-pressed={picked ? 'true' : 'false'}
      aria-label={asset.title ?? 'Photo'}
      ref={(el) => mountMedia(el, asset)}
      onClick={onToggle}
    ></button>
  );
}

async function submitPicker(e) {
  const btn = e.currentTarget;
  const album = pickerAlbum;
  const ids = [...pickerPicked];
  btn.disabled = true;
  let ok = 0;
  let parked = 0;
  let skipped = 0;
  for (let i = 0; i < ids.length; i += 1) {
    btn.textContent = `Adding ${i + 1} of ${ids.length}…`;
    const outcome = await act('add-to-album', { album_id: album.album_id, asset_id: ids[i] });
    if (outcome?.status === 'executed') ok += 1;
    else if (outcome?.status === 'parked') parked += 1;
    else skipped += 1;
  }
  closePicker();
  await refresh();
  const parts = [];
  if (ok > 0) parts.push(`Added ${ok} to “${album.title ?? 'Album'}”`);
  if (parked > 0) parts.push(`${parked} awaiting approval`);
  if (skipped > 0) parts.push(`${skipped} already there`);
  toast(parts.join(' · ') || 'Nothing to add');
}

// The picker's own `.kit-modal` rides the shared modal shell as a compound
// class (`kit-modal picker-panel`) — app.css keys its photo-grid shape off
// that pair, so both classes must stay on the one panel element.
function PickerView({ album, candidates, picked, onToggle }) {
  const n = picked.size;
  return (
    <div className="kit-modal picker-panel" onClick={(e) => e.stopPropagation()}>
      <h2 className="picker-head">Add to “{album.title ?? 'Album'}”</h2>
      <div className="picker-grid">
        {candidates.length === 0 ? (
          <p className="picker-empty muted">Everything in your library is already in this album.</p>
        ) : (
          candidates.map((asset) => (
            <PickerTile
              key={asset.asset_id}
              asset={asset}
              picked={picked.has(asset.asset_id)}
              onToggle={() => onToggle(asset.asset_id)}
            />
          ))
        )}
      </div>
      <div className="picker-foot">
        <span className="picker-count">{n === 0 ? 'Pick photos to add' : `${n} selected`}</span>
        <button type="button" className="kit-btn" onClick={closePicker}>
          Cancel
        </button>
        <button type="button" className="kit-btn primary" disabled={n === 0} onClick={submitPicker}>
          {n === 0 ? 'Add' : `Add ${n}`}
        </button>
      </div>
    </div>
  );
}

function renderPicker() {
  if (!pickerAlbum) return;
  const candidates = assets.filter((a) => !(a.album_ids ?? []).includes(pickerAlbum.album_id));
  pickerRoot.render(
    <PickerView
      album={pickerAlbum}
      candidates={candidates}
      picked={pickerPicked}
      onToggle={(id) => {
        if (pickerPicked.has(id)) pickerPicked.delete(id);
        else pickerPicked.add(id);
        renderPicker();
      }}
    />,
  );
}

function openPicker() {
  const album = albums.find((a) => a.album_id === selectedAlbum);
  if (!album) return;
  pickerAlbum = album;
  pickerPicked.clear();
  renderPicker();
  $('picker').hidden = false;
}

$('picker').addEventListener('click', closePicker);

// ---------- Keyboard ----------

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('picker').hidden) {
    closePicker();
    return;
  }
  if ($('lightbox').hidden) {
    if (e.key === 'Escape' && selectMode && !batchBusy) exitSelectMode();
    return;
  }
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
});

// ---------- Search ----------

const applySearch = debounce(() => renderGrid(), 120);

$('searchInput').addEventListener('input', () => {
  searchQuery = $('searchInput').value.trim();
  $('searchClear').hidden = searchQuery === '';
  applySearch();
});

function clearSearch() {
  $('searchInput').value = '';
  $('searchClear').hidden = true;
  if (searchQuery !== '') {
    searchQuery = '';
    renderGrid();
  }
}

$('searchInput').addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  e.stopPropagation();
  if ($('searchInput').value) clearSearch();
  else $('searchInput').blur();
});

$('searchClear').addEventListener('click', () => {
  clearSearch();
  $('searchInput').focus();
});

// ---------- Faces (issue #299) ----------

// The propose-and-confirm loop over media.face_region: unconfirmed
// proposals show a person picker + Confirm/Reject; confirmed ones read as
// facts. Everything here is derived data — rejecting is disposal, and a
// re-run of the enricher can always propose again.
//
// Stays a fully-imperative DOM builder, same as the Lit port: it targets an
// empty `<div ref={facesHostRef}>` that PanelBody always renders with no JSX
// children, so React never has anything of its own to reconcile there — the
// same "React-owned but foreign-filled" contract the boot skeleton relies on
// (see the Boot section below).
async function renderFaces(host, assetId, note) {
  let data;
  try {
    data = await window.centraid.read({ query: 'faces', input: { asset_id: assetId } });
  } catch {
    return; // face queries never break the lightbox
  }
  const regions = data?.regions ?? [];
  if (regions.length === 0 || data?.denied) return;
  host.replaceChildren();
  const heading = document.createElement('p');
  heading.className = 'lightbox-faces-title';
  heading.textContent = 'People';
  host.appendChild(heading);
  for (const region of regions) {
    const row = document.createElement('div');
    row.className = 'lightbox-face';
    if (region.confirmed) {
      const who = document.createElement('span');
      who.textContent = `✓ ${region.person_name ?? 'Confirmed'}`;
      row.appendChild(who);
      host.appendChild(row);
      continue;
    }
    const label = document.createElement('span');
    const pct = region.confidence != null ? ` · ${Math.round(region.confidence * 100)}%` : '';
    label.textContent = `Face${region.person_name ? ` — ${region.person_name}?` : ''}${pct}`;
    row.appendChild(label);
    const picker = document.createElement('select');
    picker.setAttribute('aria-label', 'Who is this?');
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = 'Who is this?';
    picker.appendChild(blank);
    for (const person of data.people ?? []) {
      const option = document.createElement('option');
      option.value = person.party_id;
      option.textContent = person.name;
      if (region.party_id === person.party_id) option.selected = true;
      picker.appendChild(option);
    }
    const confirm = kitBtn('Confirm', async () => {
      const partyId = picker.value;
      if (!partyId) {
        note.textContent = 'Pick a person first.';
        return;
      }
      const outcome = await act('confirm-face', { region_id: region.region_id, party_id: partyId });
      if (narrate(outcome, note)) await renderFaces(host, assetId, note);
    });
    const reject = kitBtn('✕', async () => {
      const outcome = await act('reject-face', { region_id: region.region_id });
      if (narrate(outcome, note)) await renderFaces(host, assetId, note);
    });
    reject.setAttribute('aria-label', 'Reject this face proposal');
    row.append(picker, confirm, reject);
    host.appendChild(row);
  }
}

// ---------- Upload ----------

// 64-bit dHash (issue #299 Tier 0): 9×8 grayscale, each bit = "left pixel
// brighter than its right neighbour". The canvas is the client's raster
// codec, so the phash rides the same decode the thumb already paid for.
function dHashFromImage(img) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 9;
    canvas.height = 8;
    const g = canvas.getContext('2d');
    g.drawImage(img, 0, 0, 9, 8);
    const data = g.getImageData(0, 0, 9, 8).data;
    const lum = [];
    for (let i = 0; i < 72; i += 1) {
      const o = i * 4;
      lum.push(0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]);
    }
    let hex = '';
    for (let row = 0; row < 8; row += 1) {
      let byte = 0;
      for (let col = 0; col < 8; col += 1) {
        byte = (byte << 1) | (lum[row * 9 + col] > lum[row * 9 + col + 1] ? 1 : 0);
      }
      hex += byte.toString(16).padStart(2, '0');
    }
    return hex;
  } catch {
    return null; // no phash is fewer duplicate hints, never a failed upload
  }
}

// The grid's thumbnail, produced at upload time on this device (the canvas
// is the one raster codec every client has) and staged as the `thumb`
// variant beside the original. Dimensions + perceptual hash ride for free.
async function stageClientThumb(file, parentSha) {
  try {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    await img.decode();
    const dims =
      img.naturalWidth > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null;
    const phash = dHashFromImage(img);
    const long = Math.max(img.naturalWidth, img.naturalHeight);
    if (long > THUMB_EDGE) {
      const scale = THUMB_EDGE / long;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
      if (blob) {
        await fetch(`${BLOB_ROUTE}?variant=thumb&variant_of=${parentSha}&media_type=image/jpeg`, {
          method: 'POST',
          headers: { 'content-type': 'image/jpeg' },
          body: blob,
        });
      }
    }
    URL.revokeObjectURL(url);
    return dims ? { ...dims, ...(phash ? { phash } : {}) } : phash ? { phash } : null;
  } catch {
    return null; // no thumb is a slower grid, never a failed upload
  }
}

async function uploadFiles(files) {
  if (uploading || files.length === 0) return;
  const oversized = files.filter((f) => f.size > MAX_UPLOAD_BYTES);
  const accepted = files.filter((f) => f.size <= MAX_UPLOAD_BYTES);
  if (accepted.length === 0) {
    toast(
      oversized.length === 1
        ? `Skipped “${oversized[0].name}” — each upload tops out at 512 MB.`
        : `Skipped ${oversized.length} files — each upload tops out at 512 MB.`,
    );
    return;
  }

  uploading = true;
  const btn = $('uploadBtn');
  btn.disabled = true;
  $('emptyUpload').disabled = true;

  let added = 0;
  let deduped = 0;
  let parked = 0;
  let failed = 0;
  let unreadable = 0;
  let lastBad = null;
  for (let i = 0; i < accepted.length; i += 1) {
    btn.textContent = `Uploading ${i + 1} of ${accepted.length}…`;
    const file = accepted[i];
    // Stage the bytes (issue #296), grow a client thumb beside them, then
    // claim the sha through the typed command — which is where the receipt
    // mints and the library learns about the asset.
    let staged;
    try {
      staged = await stageFileBytes(file);
    } catch {
      unreadable += 1;
      continue;
    }
    const kind = file.type.startsWith('video/')
      ? 'video'
      : file.type.startsWith('audio/')
        ? 'audio'
        : 'photo';
    const dims = kind === 'photo' ? await stageClientThumb(file, staged.sha256) : null;
    const outcome = await act('upload', {
      staged_sha: staged.sha256,
      kind,
      captured_at: new Date(file.lastModified || Date.now()).toISOString(),
      ...(file.name ? { title: file.name } : {}),
      ...(dims?.width ? { width: dims.width, height: dims.height } : {}),
      ...(dims?.phash ? { phash: dims.phash } : {}),
    });
    // One bad file never sinks the batch — count it and keep going.
    if (outcome?.status === 'executed') {
      added += 1;
      if (outcome.output?.deduped) deduped += 1;
    } else if (outcome?.status === 'parked') {
      parked += 1;
    } else {
      failed += 1;
      lastBad = outcome;
    }
  }

  uploading = false;
  btn.disabled = false;
  btn.textContent = '＋ Add photos';
  $('emptyUpload').disabled = false;

  const parts = [];
  if (added > 0) {
    const dedupeNote = deduped > 0 ? ` (${deduped} already in the library)` : '';
    parts.push(`Added ${added} ${added === 1 ? 'item' : 'items'}${dedupeNote}`);
  }
  if (parked > 0) parts.push(`${parked} awaiting approval`);
  if (failed > 0) parts.push(`${failed} refused`);
  if (unreadable > 0) parts.push(`${unreadable} unreadable`);
  if (oversized.length > 0) parts.push(`${oversized.length} over the 512 MB cap`);
  toast(parts.join(' · ') || 'Nothing added');
  if (lastBad) narrate(lastBad);
  await refresh();
}

$('uploadBtn').addEventListener('click', () => $('fileInput').click());
$('emptyUpload').addEventListener('click', () => {
  // Inside a real album the natural "add" is from the library, not disk.
  if (albums.some((a) => a.album_id === selectedAlbum)) openPicker();
  else $('fileInput').click();
});

$('fileInput').addEventListener('change', async () => {
  const files = [...$('fileInput').files];
  $('fileInput').value = '';
  await uploadFiles(files);
});

// Drag a file anywhere onto the page: a full-page "Drop to add" overlay.
let dragDepth = 0;

function dragHasFiles(e) {
  return [...(e.dataTransfer?.types ?? [])].includes('Files');
}

window.addEventListener('dragenter', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  dragDepth += 1;
  $('dropOverlay').hidden = false;
});

window.addEventListener('dragover', (e) => {
  if (dragHasFiles(e)) e.preventDefault();
});

window.addEventListener('dragleave', (e) => {
  if (!dragHasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $('dropOverlay').hidden = true;
});

window.addEventListener('drop', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('dropOverlay').hidden = true;
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length > 0) uploadFiles(files);
});

// Paste an image (screenshot, copied photo) straight into the library.
window.addEventListener('paste', (e) => {
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return; // never hijack a text field
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length > 0) uploadFiles(files);
});

// ---------- Boot ----------

// One React root per dynamic container, created once at module scope (Form
// 1: external mutable state above + a render orchestrator per region, same
// shape the Lit port used with `litRender`). Unlike Lit's standalone
// `render()`, `createRoot(...).render()` fully owns its container from the
// first call, so no manual "clear the pre-existing skeleton" step is needed
// the way the Lit port's `mountGrid` guard was.
const chipsRoot = createRoot($('albumChips'));
const albumToolsRoot = createRoot($('albumTools'));
const gridRoot = createRoot($('grid'));
const selectionBarRoot = createRoot($('selectionBar'));
const lightboxRoot = createRoot($('lightbox'));
const pickerRoot = createRoot($('picker'));

$('selectBtn').addEventListener('click', () => {
  if (selectMode) exitSelectMode();
  else enterSelectMode();
});

window.addEventListener('focus', refresh);
// Shimmer rows while the first read is in flight — the genuine
// `<kit-skeleton>` custom element, rendered as ordinary JSX (not the
// `showSkeleton()` DOM-mutating helper, which must never target a
// React-owned node); `renderGrid` replaces it with real content once
// `refresh()` resolves.
gridRoot.render(<kit-skeleton rows={6}></kit-skeleton>);
refresh();
