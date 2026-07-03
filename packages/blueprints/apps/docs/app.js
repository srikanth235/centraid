// Docs — a small drive as a projection over the personal vault. Every row
// is a core.content_item whose bytes are sha256-deduped; folders are SKOS
// concepts in the owner's folders scheme and filing is one tag per document.
// Trash sets a purge date ~30 days out and keeps the folder tag, so restore
// lands a document back where it was. Every write is a typed vault command,
// all risk low. The app stores nothing — revoke the grant and this page goes
// dark while the documents, history and receipts remain the owner's.

const $ = (id) => document.getElementById(id);

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // reject before reading — ~8 MB

let data = { folders: [], documents: [], root_folder_id: null };
let currentFolder = null; // folder_id, or null = the drive's top level
let trashView = false;

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

// Destructive buttons arm on first click and fire on the second.
function armThenRun(btn, run) {
  if (btn.dataset.armed) {
    delete btn.dataset.armed;
    run();
    return;
  }
  const label = btn.textContent;
  btn.dataset.armed = '1';
  btn.textContent = 'Sure?';
  setTimeout(() => {
    if (btn.isConnected && btn.dataset.armed) {
      delete btn.dataset.armed;
      btn.textContent = label;
    }
  }, 3000);
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

// ---------- Upload (fileToDataUri — shared pattern across apps) ----------

function fileToDataUri(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

$('uploadButton').addEventListener('click', () => $('uploadInput').click());
$('emptyUploadButton').addEventListener('click', () => $('uploadInput').click());

$('uploadInput').addEventListener('change', async () => {
  const input = $('uploadInput');
  const folderId = trashView ? null : currentFolder;
  for (const file of [...input.files]) {
    if (file.size > MAX_UPLOAD_BYTES) {
      notice(
        `"${file.name}" is ${fmtBytes(file.size)} — too big for the drive. Files up to 8 MB travel well.`,
      );
      continue;
    }
    let dataUri;
    try {
      dataUri = await fileToDataUri(file);
    } catch {
      notice('Could not read that file.');
      continue;
    }
    const outcome = await act('upload', {
      data_uri: dataUri,
      title: file.name,
      ...(folderId != null ? { folder_id: folderId } : {}),
    });
    if (!narrate(outcome)) break;
  }
  input.value = '';
  await refresh();
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

function openFolder(folderId) {
  currentFolder = folderId;
  trashView = false;
  render();
}

function openTrash() {
  trashView = true;
  render();
}

$('trashButton').addEventListener('click', openTrash);
window.addEventListener('focus', refresh);

// ---------- Render: sidebar tree ----------

function renderTree() {
  const tree = $('folderTree');
  tree.innerHTML = '';
  tree.appendChild(renderTreeRow(null, 0));
  const walk = (parentId, depth) => {
    for (const f of childrenOf(parentId)) {
      tree.appendChild(renderTreeRow(f, depth));
      walk(f.folder_id, depth + 1);
    }
  };
  walk(null, 1);
  $('trashCount').textContent = String(trashedDocs().length || '');
  $('trashButton').setAttribute('aria-current', String(trashView));
}

function renderTreeRow(folder, depth) {
  const row = document.createElement('div');
  row.className = 'tree-row';

  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'tree-item';
  item.style.paddingLeft = `${0.5 + depth * 0.85}rem`;
  const id = folder?.folder_id ?? null;
  item.setAttribute('aria-current', String(!trashView && currentFolder === id));
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
    del.addEventListener('click', () =>
      armThenRun(del, async () => {
        const outcome = await act('delete-folder', { folder_id: folder.folder_id });
        if (narrate(outcome)) {
          if (currentFolder === folder.folder_id) currentFolder = folder.parent_id;
          await refresh();
        }
      }),
    );
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
  if (trashView) {
    bar.appendChild(crumb('Trash', true, openTrash));
    return;
  }
  const path = pathTo(currentFolder);
  bar.appendChild(crumb('Documents', path.length === 0, () => openFolder(null)));
  path.forEach((f, i) => {
    const sep = document.createElement('span');
    sep.textContent = '/';
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

// ---------- Render: document rows ----------

function renderDocs() {
  const list = $('docList');
  list.innerHTML = '';
  const active = data.documents.filter((d) => !d.trashed);
  const rows = trashView ? trashedDocs() : docsIn(currentFolder, { trashed: false });
  $('emptyDrive').hidden = !(!trashView && active.length === 0);
  $('emptyFolder').hidden = !(!trashView && active.length > 0 && rows.length === 0);
  $('emptyTrash').hidden = !(trashView && rows.length === 0);
  for (const doc of rows) list.appendChild(trashView ? renderTrashRow(doc) : renderDocRow(doc));
}

function docIcon(doc) {
  const { cls, label } = iconKind(doc.media_type);
  const icon = document.createElement('span');
  icon.className = `doc-icon ${cls}`;
  icon.textContent = label;
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

function docMain(doc, metaText) {
  const main = document.createElement('div');
  main.className = 'doc-main';
  const title = document.createElement('span');
  title.className = 'doc-title';
  title.textContent = doc.title ?? 'Untitled';
  const meta = document.createElement('span');
  meta.className = 'doc-meta';
  meta.textContent = metaText;
  main.append(title, meta);
  return main;
}

function renderDocRow(doc) {
  const row = document.createElement('div');
  row.className = 'doc-row';
  row.appendChild(docIcon(doc));
  const main = docMain(
    doc,
    [fmtBytes(doc.byte_size), fmtDate(doc.created_at)].filter(Boolean).join(' · '),
  );
  row.appendChild(main);

  const actions = document.createElement('div');
  actions.className = 'doc-actions';

  const download = document.createElement('a');
  download.className = 'ghost';
  download.href = doc.content_uri;
  download.download = doc.title ?? 'file';
  download.textContent = 'Download';
  actions.appendChild(download);

  const rename = document.createElement('button');
  rename.type = 'button';
  rename.className = 'ghost';
  rename.textContent = 'Rename';
  rename.addEventListener('click', () => openDocEditor(row, main, actions, doc));
  actions.appendChild(rename);

  actions.appendChild(renderMoveSelect(doc));

  const trash = document.createElement('button');
  trash.type = 'button';
  trash.className = 'ghost danger';
  trash.textContent = 'Trash';
  trash.addEventListener('click', () =>
    armThenRun(trash, async () => {
      const outcome = await act('trash', { content_id: doc.content_id });
      if (narrate(outcome)) await refresh();
    }),
  );
  actions.appendChild(trash);

  row.appendChild(actions);
  return row;
}

// Folder picker — "Move…" plus the top level and every folder, indented.
function renderMoveSelect(doc) {
  const select = document.createElement('select');
  select.setAttribute('aria-label', `Move ${doc.title ?? 'document'}`);
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Move…';
  placeholder.disabled = true;
  placeholder.selected = true;
  select.appendChild(placeholder);
  const addOption = (value, name, depth, disabled) => {
    const el = document.createElement('option');
    el.value = value;
    el.textContent = `${'\u00a0'.repeat(depth * 2)}${name}`;
    el.disabled = disabled;
    select.appendChild(el);
  };
  addOption('root', 'Documents', 0, doc.folder_id == null);
  const walk = (parentId, depth) => {
    for (const f of childrenOf(parentId)) {
      addOption(f.folder_id, f.name, depth, doc.folder_id === f.folder_id);
      walk(f.folder_id, depth + 1);
    }
  };
  walk(null, 1);
  select.addEventListener('change', async () => {
    const value = select.value;
    if (!value) return;
    const outcome = await act('move', {
      content_id: doc.content_id,
      ...(value === 'root' ? {} : { folder_id: value }),
    });
    if (narrate(outcome)) await refresh();
    else select.selectedIndex = 0;
  });
  return select;
}

// Inline document rename — the title swaps for an input + save.
function openDocEditor(row, main, actions, doc) {
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
  actions.hidden = true;
  input.focus();
  input.select();
}

function renderTrashRow(doc) {
  const row = document.createElement('div');
  row.className = 'doc-row';
  row.appendChild(docIcon(doc));
  const wasIn =
    doc.folder_id == null ? 'Documents' : (folderById(doc.folder_id)?.name ?? 'a folder');
  const main = docMain(doc, `${fmtBytes(doc.byte_size)} · from ${wasIn} · `);
  const purge = document.createElement('span');
  purge.className = 'purge';
  purge.textContent = `purges ${fmtDate(doc.purge_at)}`;
  main.querySelector('.doc-meta').appendChild(purge);
  row.appendChild(main);

  const actions = document.createElement('div');
  actions.className = 'doc-actions';
  const restore = document.createElement('button');
  restore.type = 'button';
  restore.className = 'ghost';
  restore.textContent = 'Restore';
  restore.addEventListener('click', async () => {
    const outcome = await act('restore', { content_id: doc.content_id });
    if (narrate(outcome)) await refresh();
  });
  actions.appendChild(restore);
  row.appendChild(actions);
  return row;
}

// ---------- Refresh ----------

function render() {
  // A folder can vanish under us (deleted elsewhere) — fall back to the top.
  if (currentFolder != null && !folderById(currentFolder)) currentFolder = null;
  renderTree();
  renderBreadcrumb();
  renderDocs();
}

async function refresh() {
  let next;
  try {
    next = await window.centraid.read({ query: 'drive' });
  } catch {
    return; // transient; the change feed retries
  }
  const denied = next?.vaultDenied;
  $('consentBanner').hidden = !denied;
  $('live').hidden = Boolean(denied);
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    return;
  }
  data = next;
  render();
}

refresh();
