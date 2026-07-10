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
  showSkeleton,
  stageFileBytes,
  toast,
} from './kit.js';
// Aliased to `litRender` so every call site reads unambiguously against this
// app's own `renderGrid`/`renderChips`/`renderSelectionBar`/… orchestrators —
// those rebuild app state and re-render; `litRender` is Lit's standalone
// DOM-commit function that actually paints a container.
import { createRef, html, nothing, ref, render as litRender, repeat } from './lit-core.min.js';

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

// Joins truthy class fragments — the Lit-template analogue of the old
// `classList.add()` chains, so a tile's class string composes exactly as
// before (e.g. "tile-wrap selected faved").
const cls = (...parts) => parts.filter(Boolean).join(' ');

function kitBtn(label, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'kit-btn';
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

// An input that submits on Enter and folds away on Escape or blur.
function inlineInput({ value = '', placeholder, label, onSubmit, onCancel }) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  if (placeholder) input.placeholder = placeholder;
  input.setAttribute('aria-label', label);
  let submitting = false;
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
      onCancel();
      return;
    }
    if (e.key !== 'Enter') return;
    const title = input.value.trim();
    if (!title) {
      onCancel();
      return;
    }
    submitting = true;
    input.disabled = true;
    await onSubmit(title);
  });
  input.addEventListener('blur', () => {
    if (!submitting) onCancel();
  });
  return input;
}

// A tile's media fill (fillTileMedia, below) is imperative — image decode,
// video setup, placeholder text — and must run exactly once per mounted
// element. `mountMedia` is that guard: keyed `repeat()` reuses a tile's DOM
// node across refreshes (same asset_id, same node), and the dataset check
// stops a re-render from reassigning `img.src` and flickering/refetching an
// image that's already showing.
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

function chipTpl(label, active, onClick, extraClass) {
  return html`<button
    type="button"
    class=${extraClass ? `kit-chip ${extraClass}` : 'kit-chip'}
    data-active=${active ? 'true' : 'false'}
    @click=${onClick}
  >
    ${label}
  </button>`;
}

// The raw <input> node while "＋ New album" is being typed, else null — a
// singleton, not per-album state (unlike the rename input below).
let newAlbumInput = null;

function startNewAlbum() {
  newAlbumInput = inlineInput({
    placeholder: 'Album name',
    label: 'New album name',
    onSubmit: async (title) => {
      const outcome = await act('create-album', { title });
      newAlbumInput = null;
      if (narrate(outcome)) {
        if (outcome.output?.album_id) selectedAlbum = outcome.output.album_id;
        await refresh();
      } else {
        renderToolbar();
      }
    },
    onCancel: () => {
      newAlbumInput = null;
      renderToolbar();
    },
  });
  newAlbumInput.className = 'chip-input';
  renderToolbar();
  newAlbumInput.focus();
}

function chipsTemplate() {
  return html`${chipTpl('All', selectedAlbum === null, () => selectAlbum(null))}${chipTpl(
    '♥ Favorites',
    selectedAlbum === FAVORITES,
    () => selectAlbum(FAVORITES),
  )}${repeat(
    albums,
    (a) => a.album_id,
    (album) =>
      chipTpl(album.title ?? 'Album', selectedAlbum === album.album_id, () =>
        selectAlbum(album.album_id),
      ),
  )}${newAlbumInput
    ? newAlbumInput
    : html`<button type="button" class="kit-chip chip-new" @click=${startNewAlbum}>
        ＋ New album
      </button>`}${trash.length > 0
    ? chipTpl(
        `Trash (${trash.length})`,
        selectedAlbum === TRASH,
        () => selectAlbum(TRASH),
        'chip-trash',
      )
    : nothing}`;
}

function renderChips() {
  const nav = $('albumChips');
  nav.hidden = false;
  litRender(chipsTemplate(), nav);
}

// The raw <input> node while an album rename is in progress, else null, plus
// which album it belongs to — `renderAlbumTools` discards it the moment the
// selected album no longer matches (switching albums must never show album
// X's half-typed rename inside album Y's tools).
let renamingAlbumInput = null;
let renamingAlbumForId = null;

function startRenameAlbum(album) {
  renamingAlbumForId = album.album_id;
  renamingAlbumInput = inlineInput({
    value: album.title ?? '',
    placeholder: 'Album name',
    label: 'Rename album',
    onSubmit: async (title) => {
      const outcome = await act('rename-album', { album_id: album.album_id, title });
      renamingAlbumInput = null;
      renamingAlbumForId = null;
      if (narrate(outcome)) await refresh();
      else renderToolbar();
    },
    onCancel: () => {
      renamingAlbumInput = null;
      renamingAlbumForId = null;
      renderToolbar();
    },
  });
  renderToolbar();
  renamingAlbumInput.focus();
  renamingAlbumInput.select();
}

function albumToolsTemplate(album) {
  if (renamingAlbumInput && renamingAlbumForId === album.album_id) return renamingAlbumInput;
  const count = albumAssets().length;
  return html`<span class="album-tools-label"
      >${count} ${count === 1 ? 'photo' : 'photos'} in this album</span
    >
    <button type="button" class="kit-btn" @click=${openPicker}>Add photos</button>
    <button type="button" class="kit-btn" @click=${() => startRenameAlbum(album)}>Rename</button>
    <button
      type="button"
      class="kit-btn danger"
      @click=${async (e) => {
        if (!armConfirm(e.currentTarget, { armedLabel: 'Delete album?' })) return;
        const outcome = await act('delete-album', { album_id: album.album_id });
        if (narrate(outcome)) {
          selectedAlbum = null;
          toast('Album deleted — its photos stay in your library.');
          await refresh();
        }
      }}
    >
      Delete album
    </button>`;
}

function renderAlbumTools() {
  const tools = $('albumTools');
  const album = albums.find((a) => a.album_id === selectedAlbum);
  tools.hidden = !album;
  if (!album) {
    renamingAlbumInput = null;
    renamingAlbumForId = null;
    litRender(nothing, tools);
    return;
  }
  if (renamingAlbumForId !== album.album_id) {
    renamingAlbumInput = null;
    renamingAlbumForId = null;
  }
  litRender(albumToolsTemplate(album), tools);
}

// ---------- Grid ----------

// `#grid` starts out holding the kit's raw (non-Lit) skeleton markup
// (`showSkeleton`, at boot). Lit's standalone `render()` never clears a
// container's pre-existing children on its first call — it only appends past
// them — so the very first Lit commit must clear that skeleton itself; every
// commit after that goes through `litRender` alone (a raw clear once Lit owns
// the container corrupts its part cache).
let gridMounted = false;
function mountGrid(templateResult) {
  const grid = $('grid');
  if (!gridMounted) {
    grid.replaceChildren();
    gridMounted = true;
  }
  litRender(templateResult, grid);
}

// One grid tile: the media button, the always-present select dot, the
// hover-reveal favorite heart, and (inside an album) the leave-album control.
// Kept as a plain function — not a component — so `.tile-wrap` elements stay
// DIRECT children of `#grid`: the timeline leans on `.grid`'s CSS Grid track
// flow plus `grid-column: 1 / -1` sticky month/day labels between tiles.
function tileTpl(asset, inAlbum) {
  const selected = selectedIds.has(asset.asset_id);
  return html`<div
    class=${cls('tile-wrap', selected && 'selected', asset.favorite && 'faved')}
    data-asset-id=${asset.asset_id}
  >
    <button
      type="button"
      class="tile"
      ${ref((el) => mountMedia(el, asset))}
      @click=${(e) => {
        if (selectMode) toggleSelect(asset.asset_id, e.shiftKey);
        else openLightbox(asset.asset_id);
      }}
    ></button>
    <button
      type="button"
      class="tile-check"
      aria-label=${selected ? 'Deselect' : 'Select'}
      @click=${(e) => {
        e.stopPropagation();
        if (!selectMode) enterSelectMode();
        toggleSelect(asset.asset_id, e.shiftKey);
      }}
    ></button>
    <button
      type="button"
      class="tile-heart"
      aria-pressed=${asset.favorite ? 'true' : 'false'}
      aria-label=${asset.favorite ? 'Remove from favorites' : 'Add to favorites'}
      @click=${(e) => {
        e.stopPropagation();
        toggleFavorite(asset);
      }}
    >
      <span aria-hidden="true">${asset.favorite ? '♥' : '♡'}</span>
    </button>
    ${inAlbum
      ? html`<button
          type="button"
          class="tile-remove"
          title="Remove from album"
          aria-label="Remove from album"
          @click=${async () => {
            const outcome = await act('remove-from-album', {
              album_id: selectedAlbum,
              asset_id: asset.asset_id,
            });
            if (narrate(outcome)) await refresh();
          }}
        >
          <span aria-hidden="true">×</span>
        </button>`
      : nothing}
  </div>`;
}

// A trash tile: the photo, a purge countdown when one is derivable, and
// Restore — nothing else. No lightbox, no selection, no albums, no hearts.
function trashTileTpl(asset) {
  return html`<div class="tile-wrap trash" data-asset-id=${asset.asset_id}>
    <div class="tile" ${ref((el) => mountMedia(el, asset))}></div>
    ${asset.purge_in_days != null
      ? html`<span class="tile-purge"
          >${asset.purge_in_days === 0
            ? 'purges today'
            : `purges in ${asset.purge_in_days} ${asset.purge_in_days === 1 ? 'day' : 'days'}`}</span
        >`
      : nothing}
    <button
      type="button"
      class="tile-restore"
      aria-label="Restore ${asset.title ?? 'photo'}"
      @click=${async (e) => {
        e.currentTarget.disabled = true;
        if (!(await restoreAsset(asset.asset_id))) e.currentTarget.disabled = false;
      }}
    >
      Restore
    </button>
  </div>`;
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
// timeline). Months/days regroup via plain (unkeyed) `.map()` on every render
// — same as the grouping `Map`s themselves, rebuilt fresh each time — while
// each day's tiles ride a keyed `repeat()` on `asset_id`, so a tile (and its
// `<img>`) persists across refreshes instead of reloading.
function gridTemplate(months, inAlbum) {
  return html`${[...months].map(
    ([mk, days]) => html`<h2 class="month-label">${fmtMonth(mk)}</h2>
      ${[...days].map(
        ([dk, dayAssets]) => html`<p class="day-label muted small">${fmtDay(dk)}</p>
          ${repeat(
            dayAssets,
            (a) => a.asset_id,
            (asset) => tileTpl(asset, inAlbum),
          )}`,
      )}`,
  )}${libraryTruncated
    ? html`<div class="window-footer">
        <span
          >${selectedAlbum || searchQuery
            ? `This view covers your latest ${libraryWindow} photos — older ones may be missing. `
            : `Showing your latest ${libraryWindow} photos. `}</span
        >
        <button
          type="button"
          class="kit-btn"
          @click=${async (e) => {
            e.target.disabled = true;
            libraryWindow += 500;
            await refresh();
          }}
        >
          Show more
        </button>
      </div>`
    : nothing}`;
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
    mountGrid(html`${repeat(shown, (a) => a.asset_id, trashTileTpl)}`);
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
  mountGrid(gridTemplate(months, inAlbum));
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
// owns (it isn't a kit popover) — a raw DOM node while open, else null, kept
// deliberately imperative like the old code: an away-click listener is
// added/removed in lockstep with it, which is more fragile to reason about
// as reactive state than as a plain open/close pair.
let albumMenuNode = null;

function closeAlbumMenu() {
  if (!albumMenuNode) return;
  albumMenuNode = null;
  document.removeEventListener('click', onAlbumMenuAway, true);
}

function onAlbumMenuAway(e) {
  const wrap = $('selectionBar').querySelector('.bar-menu-wrap');
  if (wrap && !wrap.contains(e.target)) {
    closeAlbumMenu();
    renderSelectionBar();
  }
}

function toggleAlbumMenu(countEl) {
  if (albumMenuNode) {
    closeAlbumMenu();
    renderSelectionBar();
    return;
  }
  const menu = document.createElement('div');
  menu.className = 'album-menu';
  menu.setAttribute('role', 'menu');
  if (albums.length === 0) {
    const none = document.createElement('p');
    none.className = 'album-menu-empty';
    none.textContent = 'No albums yet — make one from the chips above.';
    menu.appendChild(none);
  }
  for (const album of albums) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'album-menu-item';
    item.setAttribute('role', 'menuitem');
    item.textContent = album.title ?? 'Album';
    item.addEventListener('click', () => {
      closeAlbumMenu();
      renderSelectionBar();
      batchAddToAlbum([...selectedIds], album, countEl);
    });
    menu.appendChild(item);
  }
  albumMenuNode = menu;
  renderSelectionBar();
  document.addEventListener('click', onAlbumMenuAway, true);
}

function selectionBarTemplate() {
  const n = selectedIds.size;
  const countRef = createRef();
  return html`<span class="bar-count" ${ref(countRef)}
      >${n === 0 ? 'Select photos' : `${n} selected`}</span
    >
    <div class="bar-menu-wrap">
      <button
        type="button"
        class="kit-btn bar-btn"
        aria-haspopup="true"
        ?disabled=${n === 0}
        @click=${() => toggleAlbumMenu(countRef.value)}
      >
        Add to album ▾
      </button>
      ${albumMenuNode ?? nothing}
    </div>
    <button
      type="button"
      class="kit-btn bar-btn danger"
      ?disabled=${n === 0}
      @click=${(e) => {
        if (batchBusy || selectedIds.size === 0) return;
        if (!armConfirm(e.currentTarget, { armedLabel: `Delete ${selectedIds.size}?` })) return;
        batchDelete([...selectedIds], countRef.value);
      }}
    >
      Delete
    </button>
    <button type="button" class="bar-close" aria-label="Exit selection" @click=${exitSelectMode}>
      ×
    </button>`;
}

function renderSelectionBar() {
  const bar = $('selectionBar');
  bar.hidden = !selectMode;
  if (!selectMode) {
    litRender(nothing, bar);
    return;
  }
  litRender(selectionBarTemplate(), bar);
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
  litRender(nothing, box);
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

// The stage's media (image/video/placeholder), keyed by `asset_id` in
// `lightboxTpl` below: stepping to a different photo always mints a fresh
// element (so zoom state never bleeds from one photo to the next), while a
// background refresh landing on the SAME photo reuses the node (so the image
// doesn't reload/flicker). `wireZoom` is guarded per-element so that reuse
// never double-attaches its pointer/dblclick listeners.
function stageTpl(asset, setInfo) {
  if (isRenderableUri(asset.content_uri) && isVideoAsset(asset)) {
    return html`<video
      .src=${asset.content_uri}
      .muted=${true}
      .playsInline=${true}
      .controls=${true}
      preload="metadata"
      aria-label=${asset.title ?? 'Video'}
    ></video>`;
  }
  if (isRenderableUri(asset.content_uri)) {
    const needsProbe = asset.width == null || asset.height == null;
    return html`<img
      .src=${asset.content_uri}
      alt=${asset.title ?? asset.kind ?? 'Photo'}
      ${ref((el) => {
        if (!el || el.dataset.zoomWired) return;
        el.dataset.zoomWired = '1';
        wireZoom(el);
      })}
      @load=${(e) => {
        if (needsProbe) setInfo(e.target.naturalWidth, e.target.naturalHeight);
      }}
    />`;
  }
  return html`<div class="lightbox-placeholder">${asset.media_type ?? asset.kind ?? 'media'}</div>`;
}

function lightboxTpl(asset, metaNode, infoNode, facesHostNode, noteNode, setInfo) {
  const list = visibleAssets();
  const idx = list.findIndex((a) => a.asset_id === asset.asset_id);
  return html`<div class="lightbox-stage" @click=${(e) => e.stopPropagation()}>
      ${repeat(
        [asset],
        (a) => a.asset_id,
        (a) => stageTpl(a, setInfo),
      )}
    </div>
    ${[
      ['prev', -1, '‹', 'Previous photo'],
      ['next', 1, '›', 'Next photo'],
    ].map(
      ([variant, delta, glyph, name]) => html`<button
        type="button"
        class="lightbox-nav ${variant}"
        aria-label=${name}
        ?disabled=${idx < 0 || !list[idx + delta]}
        @click=${(e) => {
          e.stopPropagation();
          step(delta);
        }}
      >
        ${glyph}
      </button>`,
    )}
    <div class="lightbox-panel" @click=${(e) => e.stopPropagation()}>
      ${metaNode} ${infoNode}
      ${albums.length > 0
        ? html`<div class="lightbox-albums">
            ${repeat(
              albums,
              (a) => a.album_id,
              (album) => {
                const member = asset.album_ids?.includes(album.album_id) ?? false;
                return html`<button
                  type="button"
                  class="kit-chip"
                  data-active=${member ? 'true' : 'false'}
                  @click=${async () => {
                    const outcome = await act(member ? 'remove-from-album' : 'add-to-album', {
                      album_id: album.album_id,
                      asset_id: asset.asset_id,
                    });
                    if (narrate(outcome, noteNode)) await refresh();
                  }}
                >
                  ${member ? `✓ ${album.title ?? 'Album'}` : (album.title ?? 'Album')}
                </button>`;
              },
            )}
          </div>`
        : nothing}
      ${facesHostNode}
      <div class="lightbox-actions">
        <button
          type="button"
          class=${cls('kit-btn', 'lightbox-fav', asset.favorite && 'faved')}
          aria-pressed=${asset.favorite ? 'true' : 'false'}
          @click=${async () => {
            await toggleFavorite(asset, noteNode); // refresh re-renders this lightbox
          }}
        >
          ${asset.favorite ? '♥ Favorited' : '♡ Favorite'}
        </button>
        ${isRenderableUri(asset.content_uri) || String(asset.content_uri ?? '').startsWith('data:')
          ? html`<a
              class="kit-btn lightbox-download"
              href=${asset.content_uri}
              download=${(asset.title ?? '').trim() || `photo-${asset.asset_id}`}
              >Download</a
            >`
          : nothing}
        <button
          type="button"
          class="kit-btn danger"
          @click=${async (e) => {
            if (!armConfirm(e.currentTarget, { armedLabel: 'Delete photo?' })) return;
            const outcome = await act('delete-asset', { asset_id: asset.asset_id });
            if (narrate(outcome, noteNode)) {
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
      ${noteNode}
    </div>`;
}

// The lightbox rebuilds its meta form (caption + capture time), info line
// and faces host as plain imperative nodes on every call — exactly as the
// pre-Lit version did — because they're written into by scattered async
// handlers (save, faces confirm/reject, load-driven dimension probe) whose
// closures are simplest when they close over a real, already-existing
// element rather than a Lit part whose commit order isn't guaranteed to
// precede theirs.
function renderLightbox() {
  const box = $('lightbox');
  const asset = assets.find((a) => a.asset_id === lightboxAssetId);
  if (!asset) {
    closeLightbox();
    return;
  }

  const note = document.createElement('p');
  note.className = 'lightbox-note';

  // Caption + capture time, both saved on commit (Enter or focus leaving).
  const meta = document.createElement('div');
  meta.className = 'lightbox-meta';
  const cap = document.createElement('input');
  cap.type = 'text';
  cap.className = 'lightbox-title';
  cap.value = asset.title ?? '';
  cap.placeholder = 'Add a caption';
  cap.setAttribute('aria-label', 'Caption');
  cap.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') cap.blur();
  });
  cap.addEventListener('change', async () => {
    const title = cap.value.trim();
    if (title === (asset.title ?? '')) return;
    const outcome = await act('update-asset', { asset_id: asset.asset_id, title });
    if (narrate(outcome, note)) await refresh();
  });
  const when = document.createElement('input');
  when.type = 'datetime-local';
  when.className = 'lightbox-when';
  when.value = toLocalInputValue(asset.captured_at ?? asset.taken_at);
  when.setAttribute('aria-label', 'Capture time');
  when.addEventListener('change', async () => {
    if (!when.value) return;
    const d = new Date(when.value);
    if (Number.isNaN(d.getTime())) return;
    const outcome = await act('update-asset', {
      asset_id: asset.asset_id,
      captured_at: d.toISOString(),
    });
    if (narrate(outcome, note)) await refresh();
  });
  meta.append(cap, when);

  // Info line: kind · dimensions · size · when.
  const info = document.createElement('p');
  info.className = 'lightbox-info';
  const setInfo = (w, h) => {
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
    info.textContent = parts.join(' · ');
  };
  setInfo();

  // People (issue #299): the enricher's face proposals with the owner's
  // confirm/reject loop. Loaded async so an empty vault costs nothing; the
  // section only appears when regions exist.
  const facesHost = document.createElement('div');
  facesHost.className = 'lightbox-faces';
  renderFaces(facesHost, asset.asset_id, note);

  litRender(lightboxTpl(asset, meta, info, facesHost, note, setInfo), box);
  box.hidden = false;
}

$('lightbox').addEventListener('click', closeLightbox);

// ---------- Album picker ("Add photos" from inside an album) ----------

let pickerAlbum = null;
const pickerPicked = new Set();

function closePicker() {
  const p = $('picker');
  p.hidden = true;
  litRender(nothing, p);
  pickerAlbum = null;
  pickerPicked.clear();
}

function pickerTileTpl(asset) {
  const picked = pickerPicked.has(asset.asset_id);
  return html`<button
    type="button"
    class="picker-tile"
    aria-pressed=${picked ? 'true' : 'false'}
    aria-label=${asset.title ?? 'Photo'}
    ${ref((el) => mountMedia(el, asset))}
    @click=${() => {
      if (pickerPicked.has(asset.asset_id)) pickerPicked.delete(asset.asset_id);
      else pickerPicked.add(asset.asset_id);
      renderPicker();
    }}
  ></button>`;
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
function pickerTpl(album) {
  const candidates = assets.filter((a) => !(a.album_ids ?? []).includes(album.album_id));
  const n = pickerPicked.size;
  return html`<div class="kit-modal picker-panel" @click=${(e) => e.stopPropagation()}>
    <h2 class="picker-head">Add to “${album.title ?? 'Album'}”</h2>
    <div class="picker-grid">
      ${candidates.length === 0
        ? html`<p class="picker-empty muted">
            Everything in your library is already in this album.
          </p>`
        : repeat(candidates, (a) => a.asset_id, pickerTileTpl)}
    </div>
    <div class="picker-foot">
      <span class="picker-count">${n === 0 ? 'Pick photos to add' : `${n} selected`}</span>
      <button type="button" class="kit-btn" @click=${closePicker}>Cancel</button>
      <button type="button" class="kit-btn primary" ?disabled=${n === 0} @click=${submitPicker}>
        ${n === 0 ? 'Add' : `Add ${n}`}
      </button>
    </div>
  </div>`;
}

function renderPicker() {
  if (!pickerAlbum) return;
  litRender(pickerTpl(pickerAlbum), $('picker'));
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

$('selectBtn').addEventListener('click', () => {
  if (selectMode) exitSelectMode();
  else enterSelectMode();
});

window.addEventListener('focus', refresh);
showSkeleton($('grid'), 6);
refresh();
