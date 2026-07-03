// governance: allow-repo-hygiene file-size-limit blueprints are single-file by design (read wholesale by one agent); Docs is a finished drive — tree, filing, search, preview, trash, restore — and splitting it would break that "one file" contract.
// Docs — a small drive as a projection over the personal vault. Every row
// is a core.content_item whose bytes are sha256-deduped; folders are SKOS
// concepts in the owner's folders scheme and filing is one tag per document.
// Trash sets a purge date ~30 days out and keeps the folder tag, so restore
// lands a document back where it was. Every write is a typed vault command,
// all risk low. The app stores nothing — revoke the grant and this page goes
// dark while the documents, history and receipts remain the owner's.

import { armConfirm, debounce, outcomeMessage, readFailed, showSkeleton, toast } from './kit.js';

const $ = (id) => document.getElementById(id);

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // reject before reading — ~8 MB

let data = { folders: [], documents: [], root_folder_id: null };
let currentFolder = null; // folder_id, or null = the drive's top level
let trashView = false;
let searchQuery = ''; // non-empty = flat search results across all folders
let sortKey = 'name'; // 'name' | 'size' | 'added'
let sortDir = 1; // 1 asc, -1 desc
let uploading = false;
let selected = new Set(); // content_ids picked via row checkboxes
let anchorIndex = null; // last non-shift toggle, for shift-range selection
let expanded = new Set(); // folder_ids whose children show in the tree
let visibleRows = []; // the row list as rendered — preview + shift-range order
let previewId = null; // content_id while the preview overlay is open
let previewReturnFocus = null;

function notice(text) {
  const el = $('noticeBanner');
  el.textContent = text;
  el.hidden = !text;
}

// The vault speaks in predicates; the drive speaks in plain language.
const FRIENDLY_PREDICATES = {
  not_rented_elsewhere:
    'This file is in use elsewhere in your vault (an attachment, a note, an avatar…) — remove it there first.',
  folder_is_empty:
    'Empty the folder first — move or trash its documents (including trashed ones) and delete its subfolders.',
  name_unused_among_siblings: 'A folder with that name already exists here.',
};

function friendlyOutcome(outcome) {
  return FRIENDLY_PREDICATES[outcome?.predicate] ?? outcomeMessage(outcome);
}

function narrate(outcome) {
  if (outcome?.status === 'executed') {
    notice('');
    return true;
  }
  if (outcome?.status === 'parked') {
    notice('Sent to the owner for confirmation — it lands once approved.');
  } else if (outcome?.status === 'failed') {
    const friendly = FRIENDLY_PREDICATES[outcome.predicate];
    notice(
      friendly ??
        `The vault refused: ${outcome.predicate ?? outcome.reason ?? 'a precondition failed'}.`,
    );
  } else if (outcome?.status === 'denied') {
    notice(`Denied by consent: ${outcome.reason ?? ''}`);
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

function fmtBytes(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return String(iso).slice(0, 10);
  }
}

// "purges in N days" reads better than a raw date on a trash row.
function purgeCountdown(iso) {
  if (!iso) return '';
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
  if (Number.isNaN(days)) return '';
  if (days <= 0) return 'purges today';
  if (days === 1) return 'purges tomorrow';
  return `purges in ${days} days`;
}

function iconKind(mediaType) {
  const t = String(mediaType ?? '');
  if (t === 'application/pdf') return { cls: 'pdf', label: 'PDF' };
  if (t.startsWith('image/')) return { cls: 'image', label: 'IMG' };
  return { cls: 'generic', label: 'FILE' };
}

// ---------- Folder tree helpers ----------

function folderById(id) {
  return data.folders.find((f) => f.folder_id === id);
}

function childrenOf(parentId) {
  return data.folders.filter((f) => f.parent_id === parentId);
}

function docsIn(folderId, { trashed }) {
  return data.documents.filter((d) => d.folder_id === folderId && d.trashed === trashed);
}

function trashedDocs() {
  return data.documents.filter((d) => d.trashed);
}

// Path from the top level down to a folder, for the breadcrumb.
function pathTo(folderId) {
  const path = [];
  let cursor = folderId == null ? null : folderById(folderId);
  while (cursor) {
    path.unshift(cursor);
    cursor = cursor.parent_id == null ? null : folderById(cursor.parent_id);
  }
  return path;
}

function folderPathLabel(folderId) {
  return ['Documents', ...pathTo(folderId).map((f) => f.name)].join(' / ');
}

function ensurePathExpanded(folderId) {
  for (const f of pathTo(folderId)) expanded.add(f.folder_id);
}

// ---------- Row list: filter (view or search) + sort ----------

function compareDocs(a, b) {
  let r = 0;
  if (sortKey === 'size') r = (a.byte_size ?? 0) - (b.byte_size ?? 0);
  else if (sortKey === 'added')
    r = String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));
  else {
    r = String(a.title ?? '').localeCompare(String(b.title ?? ''), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  }
  return r * sortDir;
}

function currentRows() {
  let rows;
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    rows = data.documents.filter(
      (d) =>
        !d.trashed &&
        String(d.title ?? '')
          .toLowerCase()
          .includes(q),
    );
  } else if (trashView) {
    rows = trashedDocs();
  } else {
    rows = docsIn(currentFolder, { trashed: false });
  }
  return rows.toSorted(compareDocs);
}

function setSort(key) {
  if (sortKey === key) sortDir = -sortDir;
  else {
    sortKey = key;
    sortDir = key === 'name' ? 1 : -1;
  }
  renderDocs();
  renderListHeader();
}

// ---------- Selection ----------

function clearSelection() {
  selected.clear();
  anchorIndex = null;
}

function selectionChanged() {
  renderDocs();
  renderListHeader();
  renderBulkBar();
}

function selectedDocs() {
  return data.documents.filter((d) => selected.has(d.content_id));
}

// ---------- Shared popover (kebab menu + the one "Move to…" tree) ----------

let popoverEl = null;
let popoverCleanup = null;

function closePopover() {
  if (!popoverEl) return;
  popoverCleanup?.();
  popoverEl.remove();
  popoverEl = null;
  popoverCleanup = null;
}

function openPopover(anchor, build) {
  closePopover();
  const el = document.createElement('div');
  el.className = 'popover';
  el.setAttribute('role', 'menu');
  build(el);
  document.body.appendChild(el);
  const rect = anchor.getBoundingClientRect();
  const left = Math.max(
    8,
    Math.min(rect.right - el.offsetWidth, window.innerWidth - el.offsetWidth - 8),
  );
  let top = rect.bottom + 4;
  if (top + el.offsetHeight > window.innerHeight - 8) {
    top = Math.max(8, rect.top - el.offsetHeight - 4);
  }
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  const onDocClick = (e) => {
    if (!el.contains(e.target) && !anchor.contains(e.target)) closePopover();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closePopover();
      if (anchor.isConnected) anchor.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...el.querySelectorAll('.popover-item:not(:disabled)')];
    if (items.length === 0) return;
    e.preventDefault();
    const idx = items.indexOf(document.activeElement);
    const next =
      e.key === 'ArrowDown'
        ? (items[idx + 1] ?? items[0])
        : (items[idx - 1] ?? items[items.length - 1]);
    next.focus();
  };
  const onScroll = (e) => {
    if (!el.contains(e.target)) closePopover();
  };
  // Attach on the next tick so the opening click doesn't self-close; the
  // cleanup clears the timer too, or a same-tick close would leak the handler.
  const clickTimer = setTimeout(() => document.addEventListener('click', onDocClick), 0);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', closePopover);
  window.addEventListener('scroll', onScroll, true);
  popoverEl = el;
  popoverCleanup = () => {
    clearTimeout(clickTimer);
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', closePopover);
    window.removeEventListener('scroll', onScroll, true);
  };
  el.querySelector('.popover-item:not(:disabled)')?.focus();
}

function menuItem(label, onClick, { danger = false } = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `popover-item${danger ? ' danger' : ''}`;
  btn.setAttribute('role', 'menuitem');
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

// One shared "Move to…" tree for kebab menus and the bulk toolbar — the
// old per-row <select> rebuilt the whole folder tree for every row.
function openMovePopover(anchor, docs) {
  const ids = docs.map((d) => d.content_id);
  const single = docs.length === 1 ? docs[0] : null;
  openPopover(anchor, (el) => {
    const head = document.createElement('p');
    head.className = 'popover-head';
    head.textContent = single
      ? `Move “${single.title ?? 'document'}” to`
      : `Move ${docs.length} documents to`;
    el.appendChild(head);
    const list = document.createElement('div');
    list.className = 'popover-scroll';
    const addTarget = (folderId, name, depth) => {
      const btn = menuItem(name, async () => {
        closePopover();
        await moveDocs(ids, folderId, name);
      });
      btn.style.paddingLeft = `${0.75 + depth * 0.85}rem`;
      if (single && (single.folder_id ?? null) === folderId) btn.disabled = true;
      list.appendChild(btn);
    };
    addTarget(null, 'Documents', 0);
    const walk = (parentId, depth) => {
      for (const f of childrenOf(parentId)) {
        addTarget(f.folder_id, f.name, depth);
        walk(f.folder_id, depth + 1);
      }
    };
    walk(null, 1);
    el.appendChild(list);
  });
}

function openDocMenu(anchor, doc, cells) {
  openPopover(anchor, (el) => {
    const download = document.createElement('a');
    download.className = 'popover-item';
    download.setAttribute('role', 'menuitem');
    download.href = doc.content_uri;
    download.download = doc.title ?? 'file';
    download.textContent = 'Download';
    download.addEventListener('click', () => closePopover());
    el.appendChild(download);
    el.appendChild(
      menuItem('Rename', () => {
        closePopover();
        openDocEditor(cells, doc);
      }),
    );
    el.appendChild(menuItem('Move to…', () => openMovePopover(anchor, [doc])));
    const trash = menuItem(
      'Trash',
      async () => {
        if (!armConfirm(trash, { armedLabel: 'Trash — sure?' })) return;
        closePopover();
        await trashDoc(doc);
      },
      { danger: true },
    );
    el.appendChild(trash);
  });
}

// ---------- Single-document writes ----------

async function trashDoc(doc) {
  const outcome = await act('trash', { content_id: doc.content_id });
  if (!narrate(outcome)) return;
  toast(`“${doc.title ?? 'Document'}” moved to trash.`, {
    undoLabel: 'Undo',
    onUndo: async () => {
      const back = await act('restore', { content_id: doc.content_id });
      if (narrate(back)) await refresh();
    },
  });
  await refresh();
}

async function moveDocs(ids, folderId, folderName) {
  const input = (id) => ({ content_id: id, ...(folderId == null ? {} : { folder_id: folderId }) });
  if (ids.length === 1) {
    const outcome = await act('move', input(ids[0]));
    if (!narrate(outcome)) return;
    toast(`Moved to ${folderName}.`);
    clearSelection();
    await refresh();
    return;
  }
  await runBulk(ids, (id) => act('move', input(id)), {
    progress: 'Moving',
    done: 'Moved',
    suffix: ` to ${folderName}`,
  });
}

// Loop an action over many rows: live progress in the notice banner,
// keep going past failures, one summary toast at the end.
async function runBulk(ids, run, { progress, done, suffix = '' }) {
  const n = ids.length;
  let ok = 0;
  let parked = 0;
  const failures = [];
  for (let i = 0; i < n; i += 1) {
    notice(`${progress} ${i + 1} of ${n}…`);
    const outcome = await run(ids[i]);
    if (outcome?.status === 'executed') ok += 1;
    else if (outcome?.status === 'parked') parked += 1;
    else failures.push(friendlyOutcome(outcome) ?? 'The write failed.');
  }
  notice(
    failures.length > 0 ? `${failures.length} of ${n} didn’t go through — ${failures[0]}` : '',
  );
  const parts = [`${done} ${ok} of ${n}${suffix}.`];
  if (parked > 0) parts.push(`${parked} waiting for approval.`);
  toast(parts.join(' '));
  clearSelection();
  await refresh();
}

// ---------- Upload (fileToDataUri — shared pattern across apps) ----------

function fileToDataUri(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

// One loop for the picker and drag-and-drop: per-file progress, keep going
// past failures, then a summary toast (plus a notice listing what fell out).
async function uploadFiles(fileList) {
  if (uploading) return;
  const files = [...fileList];
  if (files.length === 0) return;
  const folderId = trashView || searchQuery ? null : currentFolder;
  const skipped = files.filter((f) => f.size > MAX_UPLOAD_BYTES);
  const accepted = files.filter((f) => f.size <= MAX_UPLOAD_BYTES);
  const failures = [];
  if (skipped.length === 1) {
    failures.push(
      `“${skipped[0].name}” is ${fmtBytes(skipped[0].size)} — files up to 8 MB travel well.`,
    );
  } else if (skipped.length > 1) {
    failures.push(`Skipped ${skipped.length} files over 8 MB.`);
  }
  uploading = true;
  $('uploadButton').disabled = true;
  let ok = 0;
  let parked = 0;
  for (let i = 0; i < accepted.length; i += 1) {
    const file = accepted[i];
    notice(`Uploading ${i + 1} of ${accepted.length}…`);
    let dataUri;
    try {
      dataUri = await fileToDataUri(file);
    } catch {
      failures.push(`Could not read “${file.name}”.`);
      continue;
    }
    const outcome = await act('upload', {
      data_uri: dataUri,
      title: file.name,
      ...(folderId != null ? { folder_id: folderId } : {}),
    });
    if (outcome?.status === 'executed') ok += 1;
    else if (outcome?.status === 'parked') parked += 1;
    else failures.push(`“${file.name}”: ${friendlyOutcome(outcome) ?? 'the upload failed'}`);
  }
  uploading = false;
  $('uploadButton').disabled = false;
  notice(failures.join(' '));
  if (accepted.length > 0) {
    const parts = [`Uploaded ${ok} of ${accepted.length}.`];
    if (parked > 0) parts.push(`${parked} waiting for approval.`);
    toast(parts.join(' '));
  }
  await refresh();
}

$('uploadButton').addEventListener('click', () => $('uploadInput').click());
$('emptyUploadButton').addEventListener('click', () => $('uploadInput').click());

$('uploadInput').addEventListener('change', async () => {
  const input = $('uploadInput');
  const files = [...input.files];
  input.value = '';
  await uploadFiles(files);
});

// Drag-and-drop: a window-level drop zone with a highlight overlay.
let dragDepth = 0;

function dragHasFiles(e) {
  return [...(e.dataTransfer?.types ?? [])].includes('Files');
}

window.addEventListener('dragenter', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  dragDepth += 1;
  const target =
    trashView || searchQuery ? 'Documents' : (folderById(currentFolder)?.name ?? 'Documents');
  $('dropTarget').textContent = `Drop to upload to ${target}`;
  $('dropOverlay').hidden = false;
});

window.addEventListener('dragover', (e) => {
  if (dragHasFiles(e)) e.preventDefault();
});

window.addEventListener('dragleave', () => {
  if ($('dropOverlay').hidden) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $('dropOverlay').hidden = true;
});

window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropOverlay').hidden = true;
  const files = e.dataTransfer?.files;
  if (files?.length) await uploadFiles(files);
});

// ---------- New folder ----------

$('newFolderButton').addEventListener('click', () => {
  const form = $('folderForm');
  form.hidden = !form.hidden;
  if (!form.hidden) {
    const parent = trashView ? null : currentFolder;
    $('folderFormTarget').textContent =
      `In ${parent ? (folderById(parent)?.name ?? 'Documents') : 'Documents'}`;
    $('folderNameInput').focus();
  }
});

$('cancelFolder').addEventListener('click', () => {
  $('folderForm').hidden = true;
  $('folderNameInput').value = '';
});

$('folderForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('folderNameInput').value.trim();
  if (!name) {
    notice('Give the folder a name.');
    return;
  }
  const parent = trashView ? null : currentFolder;
  const outcome = await act('create-folder', {
    name,
    ...(parent != null ? { parent_folder_id: parent } : {}),
  });
  if (narrate(outcome)) {
    $('folderForm').hidden = true;
    $('folderNameInput').value = '';
    await refresh();
  }
});

// ---------- Navigation ----------

function clearSearch() {
  searchQuery = '';
  $('searchInput').value = '';
}

function openFolder(folderId) {
  currentFolder = folderId;
  trashView = false;
  clearSearch();
  clearSelection();
  ensurePathExpanded(folderId);
  render();
}

function openTrash() {
  trashView = true;
  clearSearch();
  clearSelection();
  render();
}

$('trashButton').addEventListener('click', openTrash);
window.addEventListener('focus', refresh);

// ---------- Search: titles across all folders, flat, with folder paths ----------

const applySearch = debounce(() => {
  const q = $('searchInput').value.trim();
  if (q === searchQuery) return;
  searchQuery = q;
  clearSelection();
  render();
}, 150);

$('searchInput').addEventListener('input', applySearch);
$('searchInput').addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  if (!$('searchInput').value && !searchQuery) return;
  clearSearch();
  clearSelection();
  render();
});

// ---------- Render: sidebar tree (collapsible, expanded to the current path) ----------

function renderTree() {
  const tree = $('folderTree');
  tree.innerHTML = '';
  tree.appendChild(renderTreeRow(null, 0));
  const walk = (parentId, depth) => {
    for (const f of childrenOf(parentId)) {
      tree.appendChild(renderTreeRow(f, depth));
      if (expanded.has(f.folder_id)) walk(f.folder_id, depth + 1);
    }
  };
  walk(null, 1);
  $('trashCount').textContent = String(trashedDocs().length || '');
  $('trashButton').setAttribute('aria-current', String(trashView));
}

function renderTreeRow(folder, depth) {
  const row = document.createElement('div');
  row.className = 'tree-row';

  const id = folder?.folder_id ?? null;
  const kids = folder ? childrenOf(id) : [];
  if (folder && kids.length > 0) {
    const caret = document.createElement('button');
    caret.type = 'button';
    caret.className = 'tree-caret';
    caret.textContent = '▸';
    const open = expanded.has(id);
    caret.setAttribute('aria-expanded', String(open));
    caret.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} ${folder.name}`);
    caret.style.marginLeft = `${(depth - 1) * 0.7}rem`;
    caret.addEventListener('click', () => {
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      renderTree();
    });
    row.appendChild(caret);
  } else {
    const spacer = document.createElement('span');
    spacer.className = 'tree-caret-spacer';
    spacer.style.marginLeft = `${Math.max(0, depth - 1) * 0.7}rem`;
    row.appendChild(spacer);
  }

  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'tree-item';
  item.setAttribute('aria-current', String(!trashView && !searchQuery && currentFolder === id));
  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = folder ? folder.name : 'Documents';
  const count = document.createElement('span');
  count.className = 'tree-count';
  count.textContent = String(docsIn(id, { trashed: false }).length || '');
  item.append(label, count);
  item.addEventListener('click', () => openFolder(id));
  row.appendChild(item);

  if (folder) {
    const tools = document.createElement('span');
    tools.className = 'tree-tools';
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'tool-btn';
    rename.textContent = 'Rename';
    rename.setAttribute('aria-label', `Rename folder ${folder.name}`);
    rename.addEventListener('click', () => openFolderEditor(row, folder));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'tool-btn danger';
    del.textContent = 'Delete';
    del.setAttribute('aria-label', `Delete folder ${folder.name}`);
    del.addEventListener('click', async () => {
      if (!armConfirm(del)) return;
      const outcome = await act('delete-folder', { folder_id: folder.folder_id });
      if (narrate(outcome)) {
        if (currentFolder === folder.folder_id) currentFolder = folder.parent_id;
        await refresh();
      }
    });
    tools.append(rename, del);
    row.appendChild(tools);
  }
  return row;
}

// Inline folder rename — swaps the row for an input + save/cancel.
function openFolderEditor(row, folder) {
  const editor = document.createElement('div');
  editor.className = 'tree-edit';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = folder.name;
  input.setAttribute('aria-label', 'Folder name');
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'ghost';
  save.textContent = 'Save';
  const commit = async () => {
    const name = input.value.trim();
    if (!name || name === folder.name) {
      render();
      return;
    }
    const outcome = await act('rename-folder', { folder_id: folder.folder_id, name });
    if (narrate(outcome)) await refresh();
    else render();
  };
  save.addEventListener('click', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    }
    if (e.key === 'Escape') render();
  });
  editor.append(input, save);
  row.replaceChildren(editor);
  input.focus();
  input.select();
}

// ---------- Render: breadcrumb ----------

function renderBreadcrumb() {
  const bar = $('breadcrumb');
  bar.innerHTML = '';
  if (searchQuery) {
    bar.appendChild(crumb(`Results for “${searchQuery}”`, true, () => {}));
    return;
  }
  if (trashView) {
    bar.appendChild(crumb('Trash', true, openTrash));
    return;
  }
  const path = pathTo(currentFolder);
  bar.appendChild(crumb('Documents', path.length === 0, () => openFolder(null)));
  path.forEach((f, i) => {
    const sep = document.createElement('span');
    sep.textContent = '›';
    sep.setAttribute('aria-hidden', 'true');
    bar.appendChild(sep);
    bar.appendChild(crumb(f.name, i === path.length - 1, () => openFolder(f.folder_id)));
  });
}

function crumb(text, isCurrent, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'crumb';
  btn.textContent = text;
  btn.setAttribute('aria-current', String(isCurrent));
  if (!isCurrent) btn.addEventListener('click', onClick);
  return btn;
}

// ---------- Render: selection toolbar ----------

function renderBulkBar() {
  const bar = $('bulkBar');
  bar.innerHTML = '';
  bar.hidden = selected.size === 0;
  if (selected.size === 0) return;

  const label = document.createElement('span');
  label.className = 'bulk-count';
  label.textContent = `${selected.size} selected`;
  bar.appendChild(label);

  if (!trashView || searchQuery) {
    const move = document.createElement('button');
    move.type = 'button';
    move.className = 'ghost';
    move.textContent = 'Move to…';
    move.addEventListener('click', () => openMovePopover(move, selectedDocs()));
    bar.appendChild(move);

    const trash = document.createElement('button');
    trash.type = 'button';
    trash.className = 'ghost danger';
    trash.textContent = 'Trash';
    trash.addEventListener('click', async () => {
      if (!armConfirm(trash, { armedLabel: `Trash ${selected.size} — sure?` })) return;
      await runBulk([...selected], (id) => act('trash', { content_id: id }), {
        progress: 'Trashing',
        done: 'Trashed',
      });
    });
    bar.appendChild(trash);
  } else {
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'ghost';
    restore.textContent = 'Restore';
    restore.addEventListener('click', async () => {
      await runBulk([...selected], (id) => act('restore', { content_id: id }), {
        progress: 'Restoring',
        done: 'Restored',
      });
    });
    bar.appendChild(restore);
  }

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'ghost bulk-clear';
  clear.textContent = 'Clear';
  clear.addEventListener('click', () => {
    clearSelection();
    selectionChanged();
  });
  bar.appendChild(clear);
}

// ---------- Render: sort header ----------

const SORT_COLUMNS = [
  ['name', 'Name'],
  ['size', 'Size'],
  ['added', 'Added'],
];

function renderListHeader() {
  const head = $('listHeader');
  head.innerHTML = '';
  head.hidden = visibleRows.length === 0;
  if (visibleRows.length === 0) return;

  const checkWrap = document.createElement('label');
  checkWrap.className = 'doc-check';
  const check = document.createElement('input');
  check.type = 'checkbox';
  const allPicked = visibleRows.every((d) => selected.has(d.content_id));
  const somePicked = visibleRows.some((d) => selected.has(d.content_id));
  check.checked = allPicked;
  check.indeterminate = !allPicked && somePicked;
  check.setAttribute('aria-label', allPicked ? 'Deselect all' : 'Select all');
  check.addEventListener('click', () => {
    if (check.checked) for (const d of visibleRows) selected.add(d.content_id);
    else for (const d of visibleRows) selected.delete(d.content_id);
    anchorIndex = null;
    selectionChanged();
  });
  checkWrap.appendChild(check);
  head.appendChild(checkWrap);

  for (const [key, text] of SORT_COLUMNS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `col-btn col-${key}`;
    btn.dataset.active = String(sortKey === key);
    btn.setAttribute(
      'aria-label',
      sortKey === key
        ? `Sorted by ${text.toLowerCase()}, ${sortDir === 1 ? 'ascending' : 'descending'} — reverse`
        : `Sort by ${text.toLowerCase()}`,
    );
    const label = document.createElement('span');
    label.textContent = text;
    btn.appendChild(label);
    if (sortKey === key) {
      const dir = document.createElement('span');
      dir.className = 'col-dir';
      dir.textContent = sortDir === 1 ? '↑' : '↓';
      dir.setAttribute('aria-hidden', 'true');
      btn.appendChild(dir);
    }
    btn.addEventListener('click', () => setSort(key));
    head.appendChild(btn);
  }
  const spacer = document.createElement('span');
  head.appendChild(spacer);
}

// ---------- Render: document rows ----------

function renderDocs() {
  const list = $('docList');
  list.innerHTML = '';
  const rows = currentRows();
  visibleRows = rows;
  const active = data.documents.filter((d) => !d.trashed);
  $('emptyDrive').hidden = !(!searchQuery && !trashView && active.length === 0);
  $('emptyFolder').hidden = !(!searchQuery && !trashView && active.length > 0 && rows.length === 0);
  $('emptyTrash').hidden = !(!searchQuery && trashView && rows.length === 0);
  $('emptySearch').hidden = !(searchQuery && rows.length === 0);
  rows.forEach((doc, i) => {
    list.appendChild(trashView && !searchQuery ? renderTrashRow(doc, i) : renderDocRow(doc, i));
  });
}

function docIcon(doc) {
  const { cls, label } = iconKind(doc.media_type);
  const icon = document.createElement('span');
  icon.className = `doc-icon ${cls}`;
  icon.textContent = label;
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

// Row checkbox: plain click toggles (and re-anchors), shift-click selects
// the whole range from the anchor — the spreadsheet muscle memory.
function rowCheck(doc, index) {
  const wrap = document.createElement('label');
  wrap.className = 'doc-check';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = selected.has(doc.content_id);
  input.setAttribute('aria-label', `Select ${doc.title ?? 'document'}`);
  input.addEventListener('click', (e) => {
    if (e.shiftKey && anchorIndex != null) {
      const [a, b] = [Math.min(anchorIndex, index), Math.max(anchorIndex, index)];
      for (let i = a; i <= b; i += 1) {
        const id = visibleRows[i]?.content_id;
        if (!id) continue;
        if (input.checked) selected.add(id);
        else selected.delete(id);
      }
    } else {
      if (input.checked) selected.add(doc.content_id);
      else selected.delete(doc.content_id);
      anchorIndex = index;
    }
    selectionChanged();
  });
  wrap.appendChild(input);
  return wrap;
}

function docMain(doc, metaText, { metaNarrowOnly = false } = {}) {
  const main = document.createElement('div');
  main.className = 'doc-main';
  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'doc-title';
  title.textContent = doc.title ?? 'Untitled';
  title.addEventListener('click', () => openPreview(doc.content_id));
  main.appendChild(title);
  if (metaText) {
    const meta = document.createElement('span');
    meta.className = `doc-meta${metaNarrowOnly ? ' narrow-only' : ''}`;
    meta.textContent = metaText;
    main.appendChild(meta);
  }
  return main;
}

function metaCell(cls, text) {
  const el = document.createElement('span');
  el.className = `doc-cell ${cls}`;
  el.textContent = text;
  return el;
}

function renderDocRow(doc, index) {
  const row = document.createElement('div');
  row.className = 'doc-row';
  if (selected.has(doc.content_id)) row.dataset.selected = 'true';
  row.appendChild(rowCheck(doc, index));
  row.appendChild(docIcon(doc));
  const main = searchQuery
    ? docMain(doc, `in ${folderPathLabel(doc.folder_id)}`)
    : docMain(doc, [fmtBytes(doc.byte_size), fmtDate(doc.created_at)].filter(Boolean).join(' · '), {
        metaNarrowOnly: true,
      });
  row.appendChild(main);
  row.appendChild(metaCell('cell-size', fmtBytes(doc.byte_size)));
  row.appendChild(metaCell('cell-added', fmtDate(doc.created_at)));

  const kebab = document.createElement('button');
  kebab.type = 'button';
  kebab.className = 'kebab';
  kebab.textContent = '⋮';
  kebab.setAttribute('aria-label', `Actions for ${doc.title ?? 'document'}`);
  kebab.setAttribute('aria-haspopup', 'menu');
  kebab.addEventListener('click', () => openDocMenu(kebab, doc, { row, main }));
  row.appendChild(kebab);

  // The row's main area opens the preview; controls keep their own clicks.
  row.addEventListener('click', (e) => {
    if (e.target.closest('button, a, input, label')) return;
    openPreview(doc.content_id);
  });
  return row;
}

// Inline document rename — the title swaps for an input + save.
function openDocEditor({ row, main }, doc) {
  const editor = document.createElement('div');
  editor.className = 'doc-edit';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = doc.title ?? '';
  input.setAttribute('aria-label', 'Document name');
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'ghost';
  save.textContent = 'Save';
  const commit = async () => {
    const title = input.value.trim();
    if (!title || title === doc.title) {
      render();
      return;
    }
    const outcome = await act('rename', { content_id: doc.content_id, title });
    if (narrate(outcome)) await refresh();
    else render();
  };
  save.addEventListener('click', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    }
    if (e.key === 'Escape') render();
  });
  editor.append(input, save);
  main.replaceWith(editor);
  row.classList.add('editing');
  input.focus();
  input.select();
}

function renderTrashRow(doc, index) {
  const row = document.createElement('div');
  row.className = 'doc-row';
  if (selected.has(doc.content_id)) row.dataset.selected = 'true';
  row.appendChild(rowCheck(doc, index));
  row.appendChild(docIcon(doc));
  const wasIn =
    doc.folder_id == null ? 'Documents' : (folderById(doc.folder_id)?.name ?? 'a folder');
  const main = docMain(doc, `from ${wasIn}`);
  const narrowPurge = document.createElement('span');
  narrowPurge.className = 'doc-meta narrow-only purge';
  narrowPurge.textContent = purgeCountdown(doc.purge_at);
  main.appendChild(narrowPurge);
  row.appendChild(main);
  row.appendChild(metaCell('cell-size', fmtBytes(doc.byte_size)));
  const purge = metaCell('cell-added purge', purgeCountdown(doc.purge_at));
  row.appendChild(purge);

  const restore = document.createElement('button');
  restore.type = 'button';
  restore.className = 'ghost';
  restore.textContent = 'Restore';
  restore.addEventListener('click', async () => {
    const outcome = await act('restore', { content_id: doc.content_id });
    if (narrate(outcome)) await refresh();
  });
  row.appendChild(restore);

  row.addEventListener('click', (e) => {
    if (e.target.closest('button, a, input, label')) return;
    openPreview(doc.content_id);
  });
  return row;
}

// ---------- Preview overlay ----------

function openPreview(contentId) {
  previewReturnFocus = document.activeElement;
  previewId = contentId;
  renderPreview();
}

function closePreview() {
  previewId = null;
  const box = $('preview');
  box.hidden = true;
  box.innerHTML = '';
  if (previewReturnFocus?.isConnected) previewReturnFocus.focus();
  previewReturnFocus = null;
}

function previewStep(delta) {
  const idx = visibleRows.findIndex((d) => d.content_id === previewId);
  const next = idx < 0 ? undefined : visibleRows[idx + delta];
  if (!next) return;
  previewId = next.content_id;
  renderPreview();
}

function previewable(doc) {
  const t = String(doc.media_type ?? '');
  const uri = String(doc.content_uri ?? '');
  const loadable = uri.startsWith('data:') || uri.startsWith('http:') || uri.startsWith('https:');
  if (!loadable) return 'none';
  if (t.startsWith('image/')) return 'image';
  if (t === 'application/pdf') return 'pdf';
  return 'none';
}

function renderPreview() {
  const box = $('preview');
  const doc = data.documents.find((d) => d.content_id === previewId);
  if (!doc) {
    closePreview();
    return;
  }
  // Keep focus on the same control across next/prev re-renders.
  const keepFocus = box.contains(document.activeElement) ? document.activeElement.dataset.pv : null;
  box.innerHTML = '';

  const top = document.createElement('div');
  top.className = 'preview-top';
  const title = document.createElement('span');
  title.className = 'preview-title';
  title.textContent = doc.title ?? 'Untitled';
  top.appendChild(title);
  const download = document.createElement('a');
  download.className = 'preview-btn preview-download';
  download.href = doc.content_uri;
  download.download = doc.title ?? 'file';
  download.textContent = 'Download';
  download.dataset.pv = 'download';
  top.appendChild(download);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'preview-btn preview-close';
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Close preview');
  close.dataset.pv = 'close';
  close.addEventListener('click', closePreview);
  top.appendChild(close);
  box.appendChild(top);

  const stage = document.createElement('div');
  stage.className = 'preview-stage';
  const kind = previewable(doc);
  if (kind === 'image') {
    const img = document.createElement('img');
    img.src = doc.content_uri;
    img.alt = doc.title ?? 'Document';
    stage.appendChild(img);
  } else if (kind === 'pdf') {
    const frame = document.createElement('iframe');
    frame.className = 'preview-frame';
    frame.src = doc.content_uri;
    frame.title = doc.title ?? 'PDF preview';
    stage.appendChild(frame);
  } else {
    const card = document.createElement('div');
    card.className = 'preview-card';
    card.appendChild(docIcon(doc));
    const name = document.createElement('p');
    name.className = 'preview-card-title';
    name.textContent = doc.title ?? 'Untitled';
    card.appendChild(name);
    const facts = document.createElement('dl');
    facts.className = 'preview-facts';
    const addFact = (k, v) => {
      if (!v) return;
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      facts.append(dt, dd);
    };
    addFact('Type', doc.media_type);
    addFact('Size', fmtBytes(doc.byte_size));
    addFact('Added', fmtDate(doc.created_at));
    addFact(
      doc.trashed ? 'Trash' : 'Folder',
      doc.trashed ? purgeCountdown(doc.purge_at) : folderPathLabel(doc.folder_id),
    );
    card.appendChild(facts);
    const note = document.createElement('p');
    note.className = 'preview-card-note';
    note.textContent = 'No preview for this type — download it to open.';
    card.appendChild(note);
    stage.appendChild(card);
  }
  stage.addEventListener('click', (e) => {
    if (e.target === stage) closePreview();
  });
  box.appendChild(stage);

  const idx = visibleRows.findIndex((d) => d.content_id === doc.content_id);
  for (const [cls, delta, glyph, name] of [
    ['prev', -1, '‹', 'Previous document'],
    ['next', 1, '›', 'Next document'],
  ]) {
    const nav = document.createElement('button');
    nav.type = 'button';
    nav.className = `preview-nav ${cls}`;
    nav.textContent = glyph;
    nav.setAttribute('aria-label', name);
    nav.dataset.pv = cls;
    nav.disabled = idx < 0 || !visibleRows[idx + delta];
    nav.addEventListener('click', () => previewStep(delta));
    box.appendChild(nav);
  }

  box.hidden = false;
  const focusTarget =
    (keepFocus && box.querySelector(`[data-pv="${keepFocus}"]:not(:disabled)`)) ||
    box.querySelector('[data-pv="close"]');
  focusTarget?.focus();
}

// Focus stays trapped inside the dialog while it is open.
function trapPreviewFocus(e) {
  const box = $('preview');
  const focusables = [...box.querySelectorAll('button, a[href], iframe')].filter(
    (el) => !el.disabled,
  );
  if (focusables.length === 0) {
    e.preventDefault();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const inside = box.contains(document.activeElement);
  if (e.shiftKey && (!inside || document.activeElement === first)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
    e.preventDefault();
    first.focus();
  }
}

window.addEventListener('keydown', (e) => {
  if ($('preview').hidden) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closePreview();
  } else if (e.key === 'ArrowLeft') previewStep(-1);
  else if (e.key === 'ArrowRight') previewStep(1);
  else if (e.key === 'Tab') trapPreviewFocus(e);
});

// ---------- Refresh ----------

function render() {
  // A folder can vanish under us (deleted elsewhere) — fall back to the top.
  if (currentFolder != null && !folderById(currentFolder)) currentFolder = null;
  ensurePathExpanded(currentFolder);
  closePopover();
  renderTree();
  renderBreadcrumb();
  renderBulkBar();
  renderDocs();
  renderListHeader();
  if (previewId != null) renderPreview();
}

let readFailedShowing = false;

async function refresh() {
  let next;
  try {
    next = await window.centraid.read({ query: 'drive' });
  } catch {
    readFailed($('noticeBanner')); // a broken vault must not look empty
    readFailedShowing = true;
    return;
  }
  if (readFailedShowing) {
    readFailedShowing = false;
    notice('');
  }
  const denied = next?.vaultDenied;
  $('consentBanner').hidden = !denied;
  $('live').hidden = Boolean(denied);
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    return;
  }
  data = next;
  selected = new Set([...selected].filter((id) => data.documents.some((d) => d.content_id === id)));
  render();
}

showSkeleton($('docList'), 6);
refresh();
