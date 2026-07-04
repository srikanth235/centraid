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

import { armConfirm, debounce, outcomeMessage, readFailed, showSkeleton, toast } from './kit.js';

const $ = (id) => document.getElementById(id);

// Client-side ceiling per file. The command caps the data: URI at roughly
// 11M characters; 8 MB of bytes base64-encodes comfortably under that.
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

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
  return String(iso ?? '').slice(0, 10);
}

function isoDayOffset(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

function fmtDay(key) {
  if (!key) return 'Undated';
  if (key === isoDayOffset(0)) return 'Today';
  if (key === isoDayOffset(-1)) return 'Yesterday';
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

function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
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
      uri.startsWith('data:video'))
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

function chip(label, active, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chip';
  btn.dataset.active = active ? 'true' : 'false';
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function ghostBtn(label, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost';
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

// ---------- Albums toolbar ----------

function renderToolbar() {
  renderChips();
  renderAlbumTools();
  // Trash tiles offer exactly one action — selection has nothing to select.
  $('selectBtn').hidden = selectedAlbum === TRASH;
}

function renderChips() {
  const nav = $('albumChips');
  nav.innerHTML = '';
  nav.hidden = false;
  const pick = (albumId) => () => {
    selectedAlbum = albumId;
    if (selectMode) exitSelectMode();
    renderToolbar();
    renderGrid();
  };
  nav.appendChild(chip('All', selectedAlbum === null, pick(null)));
  nav.appendChild(chip('♥ Favorites', selectedAlbum === FAVORITES, pick(FAVORITES)));
  for (const album of albums) {
    nav.appendChild(
      chip(album.title ?? 'Album', selectedAlbum === album.album_id, pick(album.album_id)),
    );
  }
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'chip chip-new';
  add.textContent = '＋ New album';
  add.addEventListener('click', () => {
    const input = inlineInput({
      placeholder: 'Album name',
      label: 'New album name',
      onSubmit: async (title) => {
        const outcome = await act('create-album', { title });
        if (narrate(outcome)) {
          if (outcome.output?.album_id) selectedAlbum = outcome.output.album_id;
          await refresh();
        } else {
          renderToolbar();
        }
      },
      onCancel: renderToolbar,
    });
    input.className = 'chip-input';
    add.replaceWith(input);
    input.focus();
  });
  nav.appendChild(add);
  // The trash shelf only earns a chip while something is in it.
  if (trash.length > 0) {
    const t = chip(`Trash (${trash.length})`, selectedAlbum === TRASH, pick(TRASH));
    t.classList.add('chip-trash');
    nav.appendChild(t);
  }
}

function renderAlbumTools() {
  const tools = $('albumTools');
  tools.innerHTML = '';
  const album = albums.find((a) => a.album_id === selectedAlbum);
  tools.hidden = !album;
  if (!album) return;

  const count = albumAssets().length;
  const label = document.createElement('span');
  label.className = 'album-tools-label';
  label.textContent = `${count} ${count === 1 ? 'photo' : 'photos'} in this album`;
  tools.appendChild(label);

  tools.appendChild(ghostBtn('Add photos', () => openPicker()));

  tools.appendChild(
    ghostBtn('Rename', () => {
      const input = inlineInput({
        value: album.title ?? '',
        placeholder: 'Album name',
        label: 'Rename album',
        onSubmit: async (title) => {
          const outcome = await act('rename-album', { album_id: album.album_id, title });
          if (narrate(outcome)) await refresh();
          else renderToolbar();
        },
        onCancel: renderToolbar,
      });
      tools.innerHTML = '';
      tools.appendChild(input);
      input.focus();
      input.select();
    }),
  );

  const del = ghostBtn('Delete album', async () => {
    if (!armConfirm(del, { armedLabel: 'Delete album?' })) return;
    const outcome = await act('delete-album', { album_id: album.album_id });
    if (narrate(outcome)) {
      selectedAlbum = null;
      toast('Album deleted — its photos stay in your library.');
      await refresh();
    }
  });
  del.classList.add('danger');
  tools.appendChild(del);
}

// ---------- Grid ----------

function renderGrid() {
  const grid = $('grid');
  grid.classList.toggle('selecting', selectMode);
  grid.innerHTML = '';
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
    for (const asset of shown) grid.appendChild(renderTrashTile(asset));
    return;
  }
  // Google-Photos-style timeline: sticky month headers, day labels inside.
  const months = new Map(); // month key -> Map(day key -> assets)
  for (const asset of shown) {
    const dk = dayKey(asset.taken_at);
    const mk = dk.slice(0, 7);
    if (!months.has(mk)) months.set(mk, new Map());
    const days = months.get(mk);
    if (!days.has(dk)) days.set(dk, []);
    days.get(dk).push(asset);
  }
  for (const [mk, days] of months) {
    const mh = document.createElement('h2');
    mh.className = 'month-label';
    mh.textContent = fmtMonth(mk);
    grid.appendChild(mh);
    for (const [dk, dayAssets] of days) {
      const h = document.createElement('p');
      h.className = 'day-label muted small';
      h.textContent = fmtDay(dk);
      grid.appendChild(h);
      for (const asset of dayAssets) {
        grid.appendChild(renderTile(asset));
      }
    }
  }
  // The window is honest about its edge: All, Favorites, albums and the
  // client-side search all filter the same loaded slice, so any of them can
  // silently miss photos older than the window. "Show more" grows it — with
  // no search plane, that is the only road back in time.
  if (libraryTruncated) {
    const footer = document.createElement('div');
    footer.className = 'window-footer';
    const label = document.createElement('span');
    label.textContent =
      selectedAlbum || searchQuery
        ? `This view covers your latest ${libraryWindow} photos — older ones may be missing. `
        : `Showing your latest ${libraryWindow} photos. `;
    const more = ghostBtn('Show more', async () => {
      more.disabled = true;
      libraryWindow += 500;
      await refresh();
    });
    footer.append(label, more);
    grid.appendChild(footer);
  }
}

// The visual guts of a tile — shared by the grid and the album picker.
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

function renderTile(asset) {
  const wrap = document.createElement('div');
  wrap.className = 'tile-wrap';
  wrap.dataset.assetId = asset.asset_id;
  if (selectedIds.has(asset.asset_id)) wrap.classList.add('selected');

  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'tile';
  fillTileMedia(tile, asset);
  tile.addEventListener('click', (e) => {
    if (selectMode) toggleSelect(asset.asset_id, e.shiftKey);
    else openLightbox(asset.asset_id);
  });
  wrap.appendChild(tile);

  // The selection dot: always present so select mode is one tap away;
  // outside select mode it surfaces on hover/focus as an accelerator.
  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'tile-check';
  check.setAttribute('aria-label', selectedIds.has(asset.asset_id) ? 'Deselect' : 'Select');
  check.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!selectMode) enterSelectMode();
    toggleSelect(asset.asset_id, e.shiftKey);
  });
  wrap.appendChild(check);

  // The favorite heart: hover reveal on desktop, always on for touch and
  // for photos already favorited; the toggle rides update-asset.
  if (asset.favorite) wrap.classList.add('faved');
  const heart = document.createElement('button');
  heart.type = 'button';
  heart.className = 'tile-heart';
  heart.setAttribute('aria-pressed', asset.favorite ? 'true' : 'false');
  heart.setAttribute('aria-label', asset.favorite ? 'Remove from favorites' : 'Add to favorites');
  const heartGlyph = document.createElement('span');
  heartGlyph.textContent = asset.favorite ? '♥' : '♡';
  heartGlyph.setAttribute('aria-hidden', 'true');
  heart.appendChild(heartGlyph);
  heart.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFavorite(asset);
  });
  wrap.appendChild(heart);

  // Inside an album, each tile offers the one contextual edit: leave it.
  if (albums.some((a) => a.album_id === selectedAlbum)) {
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'tile-remove';
    rm.title = 'Remove from album';
    rm.setAttribute('aria-label', 'Remove from album');
    const glyph = document.createElement('span');
    glyph.textContent = '×';
    glyph.setAttribute('aria-hidden', 'true');
    rm.appendChild(glyph);
    rm.addEventListener('click', async () => {
      const outcome = await act('remove-from-album', {
        album_id: selectedAlbum,
        asset_id: asset.asset_id,
      });
      if (narrate(outcome)) await refresh();
    });
    wrap.appendChild(rm);
  }
  return wrap;
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

// A trash tile: the photo, a purge countdown when one is derivable, and
// Restore — nothing else. No lightbox, no selection, no albums, no hearts.
function renderTrashTile(asset) {
  const wrap = document.createElement('div');
  wrap.className = 'tile-wrap trash';
  wrap.dataset.assetId = asset.asset_id;
  const tile = document.createElement('div');
  tile.className = 'tile';
  fillTileMedia(tile, asset);
  wrap.appendChild(tile);

  if (asset.purge_in_days != null) {
    const label = document.createElement('span');
    label.className = 'tile-purge';
    label.textContent =
      asset.purge_in_days === 0
        ? 'purges today'
        : `purges in ${asset.purge_in_days} ${asset.purge_in_days === 1 ? 'day' : 'days'}`;
    wrap.appendChild(label);
  }

  const restore = document.createElement('button');
  restore.type = 'button';
  restore.className = 'tile-restore';
  restore.textContent = 'Restore';
  restore.setAttribute('aria-label', `Restore ${asset.title ?? 'photo'}`);
  restore.addEventListener('click', async () => {
    restore.disabled = true;
    if (!(await restoreAsset(asset.asset_id))) restore.disabled = false;
  });
  wrap.appendChild(restore);
  return wrap;
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
      applySelection();
      return;
    }
  }
  if (selectedIds.has(assetId)) selectedIds.delete(assetId);
  else selectedIds.add(assetId);
  selectAnchor = assetId;
  applySelection();
}

// Update tile state in place — no full re-render on every tap.
function applySelection() {
  for (const wrap of $('grid').querySelectorAll('.tile-wrap')) {
    const on = selectedIds.has(wrap.dataset.assetId);
    wrap.classList.toggle('selected', on);
    const check = wrap.querySelector('.tile-check');
    if (check) check.setAttribute('aria-label', on ? 'Deselect' : 'Select');
  }
  renderSelectionBar();
}

function renderSelectionBar() {
  const bar = $('selectionBar');
  bar.hidden = !selectMode;
  bar.innerHTML = '';
  if (!selectMode) return;

  const n = selectedIds.size;
  const count = document.createElement('span');
  count.className = 'bar-count';
  count.textContent = n === 0 ? 'Select photos' : `${n} selected`;
  bar.appendChild(count);

  // Add to album — a small menu that opens above the bar.
  const menuWrap = document.createElement('div');
  menuWrap.className = 'bar-menu-wrap';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'ghost bar-btn';
  addBtn.textContent = 'Add to album ▾';
  addBtn.disabled = n === 0;
  addBtn.setAttribute('aria-haspopup', 'true');
  addBtn.addEventListener('click', () => {
    const open = menuWrap.querySelector('.album-menu');
    if (open) {
      open.remove();
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
        menu.remove();
        batchAddToAlbum([...selectedIds], album, count);
      });
      menu.appendChild(item);
    }
    menuWrap.appendChild(menu);
    const away = (e) => {
      if (!menuWrap.contains(e.target)) {
        menu.remove();
        document.removeEventListener('click', away, true);
      }
    };
    document.addEventListener('click', away, true);
  });
  menuWrap.appendChild(addBtn);
  bar.appendChild(menuWrap);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'ghost bar-btn danger';
  del.textContent = 'Delete';
  del.disabled = n === 0;
  del.addEventListener('click', () => {
    if (batchBusy || selectedIds.size === 0) return;
    if (!armConfirm(del, { armedLabel: `Delete ${selectedIds.size}?` })) return;
    batchDelete([...selectedIds], count);
  });
  bar.appendChild(del);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'bar-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Exit selection');
  close.addEventListener('click', exitSelectMode);
  bar.appendChild(close);
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
  box.innerHTML = '';
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

function renderLightbox() {
  const box = $('lightbox');
  const asset = assets.find((a) => a.asset_id === lightboxAssetId);
  if (!asset) {
    closeLightbox();
    return;
  }
  box.innerHTML = '';
  const swallow = (el) => el.addEventListener('click', (e) => e.stopPropagation());

  const stage = document.createElement('div');
  stage.className = 'lightbox-stage';
  swallow(stage);
  let stageImg = null;
  if (isRenderableUri(asset.content_uri) && isVideoAsset(asset)) {
    const vid = document.createElement('video');
    vid.src = asset.content_uri;
    vid.controls = true;
    vid.playsInline = true;
    vid.setAttribute('aria-label', asset.title ?? 'Video');
    stage.appendChild(vid);
  } else if (isRenderableUri(asset.content_uri)) {
    stageImg = document.createElement('img');
    stageImg.src = asset.content_uri; // the lightbox keeps the original bytes
    stageImg.alt = asset.title ?? asset.kind ?? 'Photo';
    wireZoom(stageImg);
    stage.appendChild(stageImg);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'lightbox-placeholder';
    placeholder.textContent = asset.media_type ?? asset.kind ?? 'media';
    stage.appendChild(placeholder);
  }
  box.appendChild(stage);

  const list = visibleAssets();
  const idx = list.findIndex((a) => a.asset_id === asset.asset_id);
  for (const [cls, delta, glyph, name] of [
    ['prev', -1, '‹', 'Previous photo'],
    ['next', 1, '›', 'Next photo'],
  ]) {
    const nav = document.createElement('button');
    nav.type = 'button';
    nav.className = `lightbox-nav ${cls}`;
    nav.textContent = glyph;
    nav.setAttribute('aria-label', name);
    nav.disabled = idx < 0 || !list[idx + delta];
    nav.addEventListener('click', (e) => {
      e.stopPropagation();
      step(delta);
    });
    box.appendChild(nav);
  }

  const panel = document.createElement('div');
  panel.className = 'lightbox-panel';
  swallow(panel);

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
  panel.appendChild(meta);

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
  if (stageImg && (asset.width == null || asset.height == null)) {
    stageImg.addEventListener('load', () => setInfo(stageImg.naturalWidth, stageImg.naturalHeight));
  }
  panel.appendChild(info);

  // Album membership: one chip per album, click to join or leave.
  if (albums.length > 0) {
    const strip = document.createElement('div');
    strip.className = 'lightbox-albums';
    for (const album of albums) {
      const member = asset.album_ids?.includes(album.album_id) ?? false;
      strip.appendChild(
        chip(
          member ? `✓ ${album.title ?? 'Album'}` : (album.title ?? 'Album'),
          member,
          async () => {
            const outcome = await act(member ? 'remove-from-album' : 'add-to-album', {
              album_id: album.album_id,
              asset_id: asset.asset_id,
            });
            if (narrate(outcome, note)) await refresh();
          },
        ),
      );
    }
    panel.appendChild(strip);
  }

  const actions = document.createElement('div');
  actions.className = 'lightbox-actions';
  const fav = ghostBtn(asset.favorite ? '♥ Favorited' : '♡ Favorite', async () => {
    await toggleFavorite(asset, note); // refresh re-renders this lightbox
  });
  fav.classList.add('lightbox-fav');
  if (asset.favorite) fav.classList.add('faved');
  fav.setAttribute('aria-pressed', asset.favorite ? 'true' : 'false');
  actions.appendChild(fav);
  if (isRenderableUri(asset.content_uri) || String(asset.content_uri ?? '').startsWith('data:')) {
    const dl = document.createElement('a');
    dl.className = 'ghost lightbox-download';
    dl.textContent = 'Download';
    dl.href = asset.content_uri;
    dl.download = (asset.title ?? '').trim() || `photo-${asset.asset_id}`;
    actions.appendChild(dl);
  }
  const del = ghostBtn('Delete photo', async () => {
    if (!armConfirm(del, { armedLabel: 'Delete photo?' })) return;
    const outcome = await act('delete-asset', { asset_id: asset.asset_id });
    if (narrate(outcome, note)) {
      closeLightbox();
      toast('Moved to trash — it leaves every album it was in.', {
        undoLabel: 'Undo',
        onUndo: () => restoreAsset(asset.asset_id),
      });
      await refresh();
    }
  });
  del.classList.add('danger');
  actions.appendChild(del);
  panel.appendChild(actions);
  panel.appendChild(note);

  box.appendChild(panel);
  box.hidden = false;
}

$('lightbox').addEventListener('click', closeLightbox);

// ---------- Album picker ("Add photos" from inside an album) ----------

function closePicker() {
  const p = $('picker');
  p.hidden = true;
  p.innerHTML = '';
}

function openPicker() {
  const album = albums.find((a) => a.album_id === selectedAlbum);
  if (!album) return;
  const picked = new Set();
  const p = $('picker');
  p.innerHTML = '';

  const panel = document.createElement('div');
  panel.className = 'picker-panel';
  panel.addEventListener('click', (e) => e.stopPropagation());

  const head = document.createElement('h2');
  head.className = 'picker-head';
  head.textContent = `Add to “${album.title ?? 'Album'}”`;
  panel.appendChild(head);

  const candidates = assets.filter((a) => !(a.album_ids ?? []).includes(album.album_id));
  const grid = document.createElement('div');
  grid.className = 'picker-grid';
  if (candidates.length === 0) {
    const none = document.createElement('p');
    none.className = 'picker-empty muted';
    none.textContent = 'Everything in your library is already in this album.';
    grid.appendChild(none);
  }

  const count = document.createElement('span');
  count.className = 'picker-count';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'primary small-btn';
  const syncFoot = () => {
    count.textContent = picked.size === 0 ? 'Pick photos to add' : `${picked.size} selected`;
    addBtn.textContent = picked.size === 0 ? 'Add' : `Add ${picked.size}`;
    addBtn.disabled = picked.size === 0;
  };

  for (const asset of candidates) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'picker-tile';
    tile.setAttribute('aria-pressed', 'false');
    tile.setAttribute('aria-label', asset.title ?? 'Photo');
    fillTileMedia(tile, asset);
    tile.addEventListener('click', () => {
      if (picked.has(asset.asset_id)) picked.delete(asset.asset_id);
      else picked.add(asset.asset_id);
      tile.setAttribute('aria-pressed', picked.has(asset.asset_id) ? 'true' : 'false');
      syncFoot();
    });
    grid.appendChild(tile);
  }
  panel.appendChild(grid);

  const foot = document.createElement('div');
  foot.className = 'picker-foot';
  foot.appendChild(count);
  foot.appendChild(ghostBtn('Cancel', closePicker));
  addBtn.addEventListener('click', async () => {
    const ids = [...picked];
    addBtn.disabled = true;
    let ok = 0;
    let parked = 0;
    let skipped = 0;
    for (let i = 0; i < ids.length; i += 1) {
      addBtn.textContent = `Adding ${i + 1} of ${ids.length}…`;
      const outcome = await act('add-to-album', {
        album_id: album.album_id,
        asset_id: ids[i],
      });
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
  });
  foot.appendChild(addBtn);
  panel.appendChild(foot);
  syncFoot();

  p.appendChild(panel);
  p.hidden = false;
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

// ---------- Upload ----------

function fileToDataUri(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

// Decode once at upload time so the vault learns the pixel dimensions.
async function imageDims(dataUri) {
  try {
    const img = new Image();
    img.src = dataUri;
    await img.decode();
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      return { width: img.naturalWidth, height: img.naturalHeight };
    }
  } catch {
    // Undecodable is fine — the upload proceeds without dimensions.
  }
  return null;
}

async function uploadFiles(files) {
  if (uploading || files.length === 0) return;
  const oversized = files.filter((f) => f.size > MAX_UPLOAD_BYTES);
  const accepted = files.filter((f) => f.size <= MAX_UPLOAD_BYTES);
  if (accepted.length === 0) {
    toast(
      oversized.length === 1
        ? `Skipped “${oversized[0].name}” — each upload tops out around 8 MB.`
        : `Skipped ${oversized.length} files — each upload tops out around 8 MB.`,
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
    let dataUri;
    try {
      dataUri = await fileToDataUri(file);
    } catch {
      unreadable += 1;
      continue;
    }
    const kind = file.type.startsWith('video/')
      ? 'video'
      : file.type.startsWith('audio/')
        ? 'audio'
        : 'photo';
    const dims = kind === 'photo' ? await imageDims(dataUri) : null;
    const outcome = await act('upload', {
      data_uri: dataUri,
      kind,
      captured_at: new Date(file.lastModified || Date.now()).toISOString(),
      ...(file.name ? { title: file.name } : {}),
      ...(dims ? { width: dims.width, height: dims.height } : {}),
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
  if (oversized.length > 0) parts.push(`${oversized.length} over the 8 MB cap`);
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
