// governance: allow-repo-hygiene file-size-limit blueprints are single-file by design (read wholesale by one agent); Photos is a finished product — upload, albums, lightbox editing, delete — and splitting it would break that "one file" contract.
// Photos — a pure projection over the personal vault. Every tile rendered
// here is a media.media_asset joined to its core.content_item; the bytes
// themselves are rented, addressed by content_uri, never copied into the
// app. Every write is a typed media command — add_asset, update_asset,
// delete_asset and the album set — all risk low, consent-checked and
// receipted, with identical bytes deduping onto one asset. The app stores
// nothing: revoke the grant and this page goes dark while the library
// remains the owner's.

const $ = (id) => document.getElementById(id);

// Client-side ceiling per file. The command caps the data: URI at roughly
// 11M characters; 8 MB of bytes base64-encodes comfortably under that.
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

let assets = [];
let albums = [];
let selectedAlbum = null; // null = All
let lightboxAssetId = null; // non-null while the lightbox is open
let uploading = false;

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
  let msg = null;
  if (outcome?.status === 'parked') {
    msg = 'Sent to the owner for confirmation — it lands once approved.';
  } else if (outcome?.status === 'failed') {
    msg = `The vault refused: ${outcome.predicate ?? outcome.reason ?? 'a precondition failed'}.`;
  } else if (outcome?.status === 'denied') {
    msg = `Denied by consent: ${outcome.reason ?? ''}`;
  }
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

// What a datetime-local input wants: local wall-clock, minute precision.
function toLocalInputValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function isRenderableUri(uri) {
  return (
    typeof uri === 'string' &&
    (uri.startsWith('http:') || uri.startsWith('https:') || uri.startsWith('data:image'))
  );
}

// ---------- Data ----------

async function refresh() {
  let data;
  try {
    data = await window.centraid.read({ query: 'library' });
  } catch {
    return; // transient; the change feed retries
  }
  const denied = data?.vaultDenied;
  $('consentBanner').hidden = !denied;
  $('live').hidden = Boolean(denied);
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    return;
  }
  assets = data?.assets ?? [];
  albums = data?.albums ?? [];
  if (selectedAlbum && !albums.some((a) => a.album_id === selectedAlbum)) {
    selectedAlbum = null;
  }
  renderToolbar();
  renderGrid();
  if (lightboxAssetId != null) renderLightbox();
}

function visibleAssets() {
  if (!selectedAlbum) return assets;
  return assets.filter((a) => a.album_ids?.includes(selectedAlbum));
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
}

function renderChips() {
  const nav = $('albumChips');
  nav.innerHTML = '';
  nav.hidden = false;
  nav.appendChild(
    chip('All', selectedAlbum === null, () => {
      selectedAlbum = null;
      renderToolbar();
      renderGrid();
    }),
  );
  for (const album of albums) {
    nav.appendChild(
      chip(album.title ?? 'Album', selectedAlbum === album.album_id, () => {
        selectedAlbum = album.album_id;
        renderToolbar();
        renderGrid();
      }),
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
}

function renderAlbumTools() {
  const tools = $('albumTools');
  tools.innerHTML = '';
  const album = albums.find((a) => a.album_id === selectedAlbum);
  tools.hidden = !album;
  if (!album) return;

  const count = visibleAssets().length;
  const label = document.createElement('span');
  label.className = 'album-tools-label';
  label.textContent = `${count} ${count === 1 ? 'photo' : 'photos'} in this album`;
  tools.appendChild(label);

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
    if (!confirm(`Delete "${album.title ?? 'this album'}"? Its photos stay in your library.`)) {
      return;
    }
    const outcome = await act('delete-album', { album_id: album.album_id });
    if (narrate(outcome)) {
      selectedAlbum = null;
      await refresh();
    }
  });
  del.classList.add('danger');
  tools.appendChild(del);
}

// ---------- Grid ----------

function renderGrid() {
  const grid = $('grid');
  grid.innerHTML = '';
  const shown = visibleAssets();
  const empty = $('empty');
  empty.hidden = shown.length > 0;
  if (shown.length === 0) {
    $('emptyText').textContent = selectedAlbum
      ? 'Nothing in this album yet — open a photo under All and add it from there.'
      : 'No photos yet — your library starts with the first upload.';
    $('emptyUpload').hidden = Boolean(selectedAlbum);
  }
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
  const wrap = document.createElement('div');
  wrap.className = 'tile-wrap';
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
  tile.addEventListener('click', () => openLightbox(asset.asset_id));
  wrap.appendChild(tile);
  // Inside an album, each tile offers the one contextual edit: leave it.
  if (selectedAlbum) {
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'tile-remove';
    rm.textContent = '×';
    rm.title = 'Remove from album';
    rm.setAttribute('aria-label', 'Remove from album');
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
  if (isRenderableUri(asset.content_uri)) {
    const img = document.createElement('img');
    img.src = asset.content_uri;
    img.alt = asset.title ?? asset.kind ?? 'Photo';
    stage.appendChild(img);
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
  const del = ghostBtn('Delete photo', async () => {
    if (!confirm('Delete this photo? It leaves your library and every album it is in.')) return;
    const outcome = await act('delete-asset', { asset_id: asset.asset_id });
    if (narrate(outcome, note)) {
      closeLightbox();
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
window.addEventListener('keydown', (e) => {
  if ($('lightbox').hidden) return;
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
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

function setUploading(on) {
  uploading = on;
  $('uploadBtn').disabled = on;
  $('emptyUpload').disabled = on;
  $('uploadBtn').textContent = on ? 'Uploading…' : '＋ Add photos';
}

$('uploadBtn').addEventListener('click', () => $('fileInput').click());
$('emptyUpload').addEventListener('click', () => $('fileInput').click());

$('fileInput').addEventListener('change', async () => {
  const files = [...$('fileInput').files];
  $('fileInput').value = '';
  if (files.length === 0 || uploading) return;

  const parts = [];
  const oversized = files.filter((f) => f.size > MAX_UPLOAD_BYTES);
  const accepted = files.filter((f) => f.size <= MAX_UPLOAD_BYTES);
  if (oversized.length > 0) {
    parts.push(
      oversized.length === 1
        ? `Skipped "${oversized[0].name}" — each upload tops out around 8 MB.`
        : `Skipped ${oversized.length} files — each upload tops out around 8 MB.`,
    );
  }
  if (accepted.length === 0) {
    notice(parts.join(' '));
    return;
  }

  setUploading(true);
  let added = 0;
  let deduped = 0;
  let stopped = false;
  for (const file of accepted) {
    let dataUri;
    try {
      dataUri = await fileToDataUri(file);
    } catch {
      parts.push(`Could not read "${file.name}".`);
      continue;
    }
    const outcome = await act('upload', {
      data_uri: dataUri,
      captured_at: new Date(file.lastModified).toISOString(),
      title: file.name,
    });
    if (!narrate(outcome)) {
      stopped = true;
      break;
    }
    added += 1;
    if (outcome.output?.deduped) deduped += 1;
  }
  setUploading(false);
  if (!stopped) {
    if (added > 0) {
      const dedupeNote = deduped > 0 ? ` (${deduped} already in the library)` : '';
      parts.unshift(`Added ${added} ${added === 1 ? 'item' : 'items'}${dedupeNote}.`);
    }
    notice(parts.join(' '));
  }
  await refresh();
});

window.addEventListener('focus', refresh);
refresh();
