// Photos — a pure projection over the personal vault. Every tile rendered
// here is a media.media_asset joined to its core.content_item; the bytes
// themselves are rented, addressed by content_uri, never copied into the
// app. There are no write paths: the media domain has no typed commands
// yet, so this page stays read-only until that command pack ships. Revoke
// the grant and this page goes dark while the library remains the owner's.

const $ = (id) => document.getElementById(id);

let assets = [];
let albums = [];
let selectedAlbum = null; // null = All

function dayKey(iso) {
  return String(iso ?? '').slice(0, 10);
}

function fmtDay(key) {
  if (!key) return 'Undated';
  const today = new Date().toISOString().slice(0, 10);
  if (key === today) return 'Today';
  try {
    return new Date(`${key}T00:00:00`).toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return key;
  }
}

function isRenderableUri(uri) {
  return (
    typeof uri === 'string' &&
    (uri.startsWith('http:') || uri.startsWith('https:') || uri.startsWith('data:image'))
  );
}

function caption(asset) {
  const parts = [asset.title ?? asset.media_type ?? asset.kind];
  if (asset.album_titles?.length) parts.push(asset.album_titles.join(', '));
  if (asset.taken_at) parts.push(fmtDay(dayKey(asset.taken_at)));
  return parts.filter(Boolean).join(' · ');
}

async function refresh() {
  let data;
  try {
    data = await window.centraid.read({ query: 'library' });
  } catch {
    return; // transient; the change feed retries
  }
  const denied = data?.vaultDenied;
  $('consentBanner').hidden = !denied;
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    $('albumChips').hidden = true;
    $('grid').innerHTML = '';
    $('empty').hidden = true;
    return;
  }
  assets = data?.assets ?? [];
  albums = data?.albums ?? [];
  if (selectedAlbum && !albums.some((a) => a.album_id === selectedAlbum)) {
    selectedAlbum = null;
  }
  renderChips();
  renderGrid();
}

function renderChips() {
  const nav = $('albumChips');
  nav.innerHTML = '';
  nav.hidden = albums.length === 0;
  const all = chip('All', selectedAlbum === null, () => {
    selectedAlbum = null;
    renderChips();
    renderGrid();
  });
  nav.appendChild(all);
  for (const album of albums) {
    nav.appendChild(
      chip(album.title ?? 'Album', selectedAlbum === album.album_id, () => {
        selectedAlbum = album.album_id;
        renderChips();
        renderGrid();
      }),
    );
  }
}

function chip(label, active, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chip';
  btn.dataset.active = active ? 'true' : 'false';
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function visibleAssets() {
  if (!selectedAlbum) return assets;
  const album = albums.find((a) => a.album_id === selectedAlbum);
  const title = album?.title;
  return assets.filter((asset) => title != null && asset.album_titles?.includes(title));
}

function renderGrid() {
  const grid = $('grid');
  grid.innerHTML = '';
  const shown = visibleAssets();
  $('empty').hidden = shown.length > 0;
  const byDay = new Map();
  for (const asset of shown) {
    const key = dayKey(asset.taken_at);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(asset);
  }
  for (const [key, dayAssets] of byDay) {
    const h = document.createElement('p');
    h.className = 'day-label muted small';
    h.textContent = fmtDay(key);
    grid.appendChild(h);
    for (const asset of dayAssets) {
      grid.appendChild(renderTile(asset));
    }
  }
}

function renderTile(asset) {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'tile';
  if (isRenderableUri(asset.content_uri)) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = asset.content_uri;
    img.alt = asset.title ?? asset.kind ?? 'Photo';
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
  tile.addEventListener('click', () => openLightbox(asset));
  return tile;
}

function openLightbox(asset) {
  const box = $('lightbox');
  box.innerHTML = '';
  if (isRenderableUri(asset.content_uri)) {
    const img = document.createElement('img');
    img.src = asset.content_uri;
    img.alt = asset.title ?? asset.kind ?? 'Photo';
    box.appendChild(img);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'lightbox-placeholder';
    placeholder.textContent = asset.media_type ?? asset.kind ?? 'media';
    box.appendChild(placeholder);
  }
  const cap = document.createElement('p');
  cap.className = 'lightbox-caption';
  cap.textContent = caption(asset);
  box.appendChild(cap);
  box.hidden = false;
}

function closeLightbox() {
  const box = $('lightbox');
  box.hidden = true;
  box.innerHTML = '';
}

$('lightbox').addEventListener('click', closeLightbox);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeLightbox();
});

window.addEventListener('focus', refresh);
refresh();
