// governance: allow-repo-hygiene file-size-limit blueprints are single-file by design (read wholesale by one agent); Docs is a finished drive — sidebar, grid/list, filing, search, details, quick-look, trash, restore — and splitting it would break that "one file" contract.
// Docs — the drive, reinvented, as a projection over the personal vault. Every
// row is a core.content_item whose bytes are sha256-deduped; folders are SKOS
// concepts in the owner's folders scheme and filing is one tag per document.
// Trash sets a purge date ~30 days out and keeps the folder tag, so restore
// lands a document back where it was. Every write is a typed vault command —
// consent-checked and receipted, all risk low. The app stores nothing of its
// own: revoke the grant and this page goes dark while the documents, history
// and receipts remain the owner's.
//
// Two things the vault has no signal for are surfaced honestly rather than
// faked: there is no "starred" bit and no per-person "shared" edge, so the
// Starred view stays an honest empty state and there is no sharing UI at all.

import { armConfirm, debounce, outcomeMessage, readFailed, showSkeleton, toast } from './kit.js';

const $ = (id) => document.getElementById(id);
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // reject before reading — ~8 MB

// ---------- Tiny DOM helpers ----------

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'style') e.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function')
      e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

// ---------- Icons ----------

const I = {
  folder:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h5l2 2h9v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z"/></svg>',
  clock:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/></svg>',
  star: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 2.6 5.6 6 .7-4.5 4.2 1.2 6-5.3-3-5.3 3 1.2-6L3.4 9.3l6-.7z"/></svg>',
  allDocs:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h5l2 2h9v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z"/></svg>',
  trash:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>',
  upload:
    '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--ink-2)" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3m0 0 4 4m-4-4-4 4M5 21h14"/></svg>',
  folderPlus:
    '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--ink-2)" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h5l2 2h9v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z"/><path d="M12 11v5M9.5 13.5h5"/></svg>',
  check:
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 6"/></svg>',
  dots: '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>',
  close:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  chevL:
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m15 6-6 6 6 6"/></svg>',
  chevR:
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>',
  download:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"/></svg>',
  sun: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/></svg>',
  moon: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>',
};

// ---------- State ----------

let data = { folders: [], documents: [], root_folder_id: null };
let driveWindow = 200;
let driveTruncated = false;

const state = {
  view: document.documentElement.getAttribute('data-app-view') === 'list' ? 'list' : 'grid',
  nav: { kind: 'all' }, // all | recent | starred | folder(folderId) | trash
  sortKey: 'added', // added | name | size
  sortDir: -1,
  type: 'all', // all | pdf | image | doc | sheet
  search: '',
  selected: new Set(),
  anchorIndex: null,
  detailsId: null,
  quickId: null,
  newMenuOpen: false,
  creatingFolder: false,
  renamingFolderId: null,
  narrow: false,
};

let visibleRows = []; // the row list as rendered — selection range + quick-look order
let searchResults = null;
let searchSeq = 0;
let uploading = false;

// ---------- Notice / consent narration ----------

function notice(text) {
  const b = $('noticeBanner');
  b.textContent = text || '';
  b.hidden = !text;
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

// Returns true when the write executed; otherwise narrates parked / failed /
// denied honestly and returns false.
function narrate(outcome) {
  if (outcome?.status === 'executed') {
    notice('');
    return true;
  }
  if (outcome?.status === 'parked') {
    notice('Sent to the owner for confirmation — it lands once approved.');
  } else if (outcome?.status === 'failed') {
    notice(
      FRIENDLY_PREDICATES[outcome.predicate] ??
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
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
function fmtDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const m = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return d.getFullYear() === new Date().getFullYear() ? m : `${m}, ${d.getFullYear()}`;
  } catch {
    return String(iso).slice(0, 10);
  }
}
function fmtFull(iso) {
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
function purgeCountdown(iso) {
  if (!iso) return '';
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
  if (Number.isNaN(days)) return '';
  if (days <= 0) return 'purges today';
  if (days === 1) return 'purges tomorrow';
  return `purges in ${days} days`;
}

// Render a vault search snippet from text nodes only — the ⟦…⟧ hit markers
// become <mark>; document text never parses as HTML.
function snippetInto(elm, snippet) {
  const parts = String(snippet ?? '').split(/[⟦⟧]/);
  for (let i = 0; i < parts.length; i += 1) {
    if (!parts[i]) continue;
    if (i % 2 === 1) {
      const mark = document.createElement('mark');
      mark.textContent = parts[i];
      elm.appendChild(mark);
    } else {
      elm.appendChild(document.createTextNode(parts[i]));
    }
  }
}

// ---------- File types ----------

function typeMeta(mediaType) {
  const t = String(mediaType ?? '').toLowerCase();
  if (t === 'application/pdf')
    return { label: 'PDF', name: 'PDF document', cat: 'pdf', cv: '--c-pdf' };
  if (t.startsWith('image/')) return { label: 'IMG', name: 'Image', cat: 'image', cv: '--c-image' };
  if (
    t.includes('spreadsheet') ||
    t === 'application/vnd.ms-excel' ||
    t === 'text/csv' ||
    t === 'application/vnd.oasis.opendocument.spreadsheet'
  )
    return { label: 'XLS', name: 'Spreadsheet', cat: 'sheet', cv: '--c-sheet' };
  if (
    t.includes('presentation') ||
    t === 'application/vnd.ms-powerpoint' ||
    t === 'application/vnd.oasis.opendocument.presentation'
  )
    return { label: 'PPT', name: 'Presentation', cat: 'slide', cv: '--c-slide' };
  if (
    t.includes('word') ||
    t === 'application/msword' ||
    t === 'application/vnd.oasis.opendocument.text' ||
    t === 'application/rtf' ||
    t.startsWith('text/')
  )
    return { label: 'DOC', name: 'Document', cat: 'doc', cv: '--c-doc' };
  return { label: 'FILE', name: 'File', cat: 'other', cv: '--ink-3' };
}

function loadable(uri) {
  return /^(data:|https?:)/i.test(String(uri ?? ''));
}
function isImage(doc) {
  return String(doc.media_type ?? '').startsWith('image/') && loadable(doc.content_uri);
}
function tintBg(cv, pct) {
  return `color-mix(in oklab, var(${cv}) ${pct}%, transparent)`;
}

// ---------- Data helpers ----------

function folderById(id) {
  return data.folders.find((f) => f.folder_id === id);
}
function folderName(id) {
  return id == null ? 'Documents' : (folderById(id)?.name ?? 'a folder');
}
function activeFiles() {
  return data.documents.filter((f) => !f.trashed);
}
function trashedFiles() {
  return data.documents.filter((f) => f.trashed);
}

function compareDocs(a, b) {
  let r = 0;
  if (state.sortKey === 'size') r = (a.byte_size ?? 0) - (b.byte_size ?? 0);
  else if (state.sortKey === 'name')
    r = String(a.title ?? '').localeCompare(String(b.title ?? ''), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  else r = String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));
  return r * state.sortDir;
}

// The rows for the current view: nav (or search) → type filter → sort.
function currentRows() {
  const { nav, type, search } = state;
  if (nav.kind === 'starred') return []; // honest empty — no vault star signal
  let list;
  if (search.trim()) {
    list = searchResults ?? []; // flat vault FTS matches across every folder
  } else if (nav.kind === 'trash') {
    list = trashedFiles();
  } else {
    list = activeFiles();
    if (nav.kind === 'folder') list = list.filter((f) => (f.folder_id ?? null) === nav.folderId);
  }
  if (type !== 'all') list = list.filter((f) => typeMeta(f.media_type).cat === type);
  if (search.trim()) return list; // keep the vault's rank order for search
  if (nav.kind === 'recent') {
    return [...list]
      .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
      .slice(0, 8);
  }
  return [...list].sort(compareDocs);
}

// ---------- Selection ----------

function clearSelection() {
  state.selected.clear();
  state.anchorIndex = null;
}
function selectedDocs() {
  return data.documents.filter((d) => state.selected.has(d.content_id));
}
function toggleSelect(id, index, shift) {
  const sel = state.selected;
  if (shift && state.anchorIndex != null) {
    const [a, b] = [Math.min(state.anchorIndex, index), Math.max(state.anchorIndex, index)];
    const on = !sel.has(id);
    for (let i = a; i <= b; i += 1) {
      const rid = visibleRows[i]?.content_id;
      if (!rid) continue;
      if (on) sel.add(rid);
      else sel.delete(rid);
    }
  } else {
    if (sel.has(id)) sel.delete(id);
    else sel.add(id);
    state.anchorIndex = index;
  }
  render();
}

// ---------- Popover (kebab + move) ----------

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
  const box = h('div', { class: 'd-popover', role: 'menu' });
  build(box);
  document.body.appendChild(box);
  const rect = anchor.getBoundingClientRect();
  const left = Math.max(
    8,
    Math.min(rect.right - box.offsetWidth, window.innerWidth - box.offsetWidth - 8),
  );
  let top = rect.bottom + 4;
  if (top + box.offsetHeight > window.innerHeight - 8)
    top = Math.max(8, rect.top - box.offsetHeight - 4);
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  const onDoc = (e) => {
    if (!box.contains(e.target) && !anchor.contains(e.target)) closePopover();
  };
  const onScroll = (e) => {
    if (!box.contains(e.target)) closePopover();
  };
  const timer = setTimeout(() => document.addEventListener('click', onDoc), 0);
  window.addEventListener('resize', closePopover);
  window.addEventListener('scroll', onScroll, true);
  popoverEl = box;
  popoverCleanup = () => {
    clearTimeout(timer);
    document.removeEventListener('click', onDoc);
    window.removeEventListener('resize', closePopover);
    window.removeEventListener('scroll', onScroll, true);
  };
}
function popItem(label, onClick, { danger = false, disabled = false, iconHtml = null } = {}) {
  const btn = h('button', {
    type: 'button',
    class: `d-popover-item${danger ? ' danger' : ''}`,
    role: 'menuitem',
    disabled: disabled || undefined,
    onclick: onClick,
  });
  if (iconHtml) btn.appendChild(el(iconHtml));
  btn.appendChild(document.createTextNode(label));
  return btn;
}

// One shared "Move to…" tree for the kebab and the bulk toolbar.
function openMovePopover(anchor, docs) {
  const ids = docs.map((d) => d.content_id);
  const single = docs.length === 1 ? docs[0] : null;
  openPopover(anchor, (box) => {
    box.appendChild(
      h(
        'p',
        { class: 'd-popover-head' },
        single ? `Move “${single.title ?? 'document'}” to` : `Move ${docs.length} to`,
      ),
    );
    const scroll = h('div', { class: 'd-popover-scroll' });
    const target = (folderId, name, depth) => {
      const btn = popItem(name, async () => {
        closePopover();
        await moveDocs(ids, folderId, name);
      });
      btn.style.paddingLeft = `${0.7 + depth * 0.85}rem`;
      if (single && (single.folder_id ?? null) === folderId) btn.disabled = true;
      scroll.appendChild(btn);
    };
    target(null, 'Documents', 0);
    for (const f of data.folders) target(f.folder_id, f.name, 1);
    box.appendChild(scroll);
  });
}

function openDocMenu(anchor, doc) {
  closePopover();
  openPopover(anchor, (box) => {
    box.appendChild(
      popItem('Open', () => {
        closePopover();
        openQuick(doc.content_id);
      }),
    );
    const dl = h(
      'a',
      {
        class: 'd-popover-item',
        role: 'menuitem',
        href: doc.content_uri,
        download: doc.title ?? 'file',
        onclick: closePopover,
      },
      'Download',
    );
    box.appendChild(dl);
    box.appendChild(
      popItem('Rename', () => {
        closePopover();
        startRenameDoc(doc);
      }),
    );
    box.appendChild(popItem('Move to…', () => openMovePopover(anchor, [doc])));
    box.appendChild(h('div', { class: 'd-popover-sep' }));
    box.appendChild(
      popItem(
        'Trash',
        async (e) => {
          const btn = e.currentTarget;
          if (!armConfirm(btn, { armedLabel: 'Trash — sure?' })) return;
          closePopover();
          await trashDoc(doc);
        },
        { danger: true },
      ),
    );
  });
}

// ---------- Document writes ----------

async function trashDoc(doc) {
  const outcome = await act('trash', { content_id: doc.content_id });
  if (!narrate(outcome)) return;
  if (state.detailsId === doc.content_id) state.detailsId = null;
  toast(`Moved to trash · receipted.`, {
    undoLabel: 'Undo',
    onUndo: async () => {
      const back = await act('restore', { content_id: doc.content_id });
      if (narrate(back)) await refresh();
    },
  });
  await refresh();
}

async function restoreDoc(doc) {
  const outcome = await act('restore', { content_id: doc.content_id });
  if (narrate(outcome)) {
    toast('Restored to its folder · receipted.');
    await refresh();
  }
}

async function moveDocs(ids, folderId, name) {
  const input = (id) => ({ content_id: id, ...(folderId == null ? {} : { folder_id: folderId }) });
  if (ids.length === 1) {
    const outcome = await act('move', input(ids[0]));
    if (!narrate(outcome)) return;
    toast(`Moved to ${name} · receipted.`);
    clearSelection();
    await refresh();
    return;
  }
  await runBulk(ids, (id) => act('move', input(id)), {
    progress: 'Moving',
    done: 'Moved',
    suffix: ` to ${name}`,
  });
}

async function startRenameDoc(doc) {
  const title = window.prompt?.('Rename document', doc.title ?? '');
  if (title == null) return;
  const trimmed = title.trim();
  if (!trimmed || trimmed === doc.title) return;
  const outcome = await act('rename', { content_id: doc.content_id, title: trimmed });
  if (narrate(outcome)) {
    toast('Renamed · receipted.');
    await refresh();
  }
}

// Loop an action over many rows: live progress, keep going past failures,
// one summary toast at the end.
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
  const parts = [`${done} ${ok} of ${n}${suffix} · receipted.`];
  if (parked > 0) parts.push(`${parked} waiting for approval.`);
  toast(parts.join(' '));
  clearSelection();
  await refresh();
}

// ---------- Folder writes ----------

async function createFolder(name) {
  const outcome = await act('create-folder', { name });
  if (narrate(outcome)) {
    state.creatingFolder = false;
    toast(`Folder “${name}” created · receipted.`);
    await refresh();
  } else {
    render();
  }
}
async function renameFolder(folderId, name) {
  const outcome = await act('rename-folder', { folder_id: folderId, name });
  if (narrate(outcome)) {
    state.renamingFolderId = null;
    toast('Folder renamed · receipted.');
    await refresh();
  } else {
    render();
  }
}
async function deleteFolder(folder) {
  const outcome = await act('delete-folder', { folder_id: folder.folder_id });
  if (narrate(outcome)) {
    if (state.nav.kind === 'folder' && state.nav.folderId === folder.folder_id)
      state.nav = { kind: 'all' };
    toast('Folder deleted · receipted.');
    await refresh();
  }
}

// ---------- Upload (picker + drag-and-drop) ----------

function fileToDataUri(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

async function uploadFiles(fileList) {
  if (uploading) return;
  const files = [...fileList];
  if (files.length === 0) return;
  const folderId = state.nav.kind === 'folder' ? state.nav.folderId : null;
  const skipped = files.filter((f) => f.size > MAX_UPLOAD_BYTES);
  const accepted = files.filter((f) => f.size <= MAX_UPLOAD_BYTES);
  const failures = [];
  if (skipped.length === 1)
    failures.push(
      `“${skipped[0].name}” is ${fmtBytes(skipped[0].size)} — files up to 8 MB travel well.`,
    );
  else if (skipped.length > 1) failures.push(`Skipped ${skipped.length} files over 8 MB.`);

  uploading = true;
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
  notice(failures.join(' '));
  if (accepted.length > 0) {
    const parts = [`Uploaded ${ok} of ${accepted.length} · receipted.`];
    if (parked > 0) parts.push(`${parked} waiting for approval.`);
    toast(parts.join(' '));
  }
  await refresh();
}

// ---------- Sidebar render ----------

function navItem({ icon, label, active, count, onClick }) {
  const item = h('button', {
    type: 'button',
    class: 'd-nav-item',
    'aria-current': String(!!active),
    onclick: onClick,
  });
  item.appendChild(el(icon));
  item.appendChild(h('span', {}, label));
  if (count != null) item.appendChild(h('span', { class: 'd-nav-count' }, count));
  return item;
}

function renderSidebar() {
  const counts = {
    all: activeFiles().length,
    starred: 0,
    trash: trashedFiles().length,
  };

  const nav = $('smartNav');
  nav.replaceChildren(
    navItem({
      icon: I.allDocs,
      label: 'All documents',
      active: state.nav.kind === 'all',
      count: counts.all,
      onClick: () => selectNav({ kind: 'all' }),
    }),
    navItem({
      icon: I.clock,
      label: 'Recent',
      active: state.nav.kind === 'recent',
      onClick: () => selectNav({ kind: 'recent' }),
    }),
    navItem({
      icon: I.star,
      label: 'Starred',
      active: state.nav.kind === 'starred',
      count: counts.starred,
      onClick: () => selectNav({ kind: 'starred' }),
    }),
  );

  const list = $('folderList');
  list.replaceChildren();

  if (state.creatingFolder) {
    const input = h('input', {
      type: 'text',
      placeholder: 'Folder name…',
      'aria-label': 'New folder name',
    });
    const create = h('button', { type: 'button' }, 'Create');
    const commit = () => {
      const name = input.value.trim();
      if (name) createFolder(name);
      else {
        state.creatingFolder = false;
        render();
      }
    };
    create.addEventListener('click', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      }
      if (e.key === 'Escape') {
        state.creatingFolder = false;
        render();
      }
    });
    list.appendChild(h('div', { class: 'd-folder-edit' }, input, create));
    setTimeout(() => input.focus(), 0);
  }

  for (const f of data.folders) {
    if (state.renamingFolderId === f.folder_id) {
      const input = h('input', { type: 'text', 'aria-label': 'Folder name' });
      input.value = f.name;
      const save = h('button', { type: 'button' }, 'Save');
      const commit = () => {
        const name = input.value.trim();
        if (name && name !== f.name) renameFolder(f.folder_id, name);
        else {
          state.renamingFolderId = null;
          render();
        }
      };
      save.addEventListener('click', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
        if (e.key === 'Escape') {
          state.renamingFolderId = null;
          render();
        }
      });
      list.appendChild(h('div', { class: 'd-folder-edit' }, input, save));
      setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
      continue;
    }
    const count = activeFiles().filter((d) => (d.folder_id ?? null) === f.folder_id).length;
    const active = state.nav.kind === 'folder' && state.nav.folderId === f.folder_id;
    const item = navItem({
      icon: I.folder,
      label: f.name,
      active,
      count: count || '',
      onClick: () => selectNav({ kind: 'folder', folderId: f.folder_id }),
    });
    const rename = h('button', {
      type: 'button',
      class: 'd-tool-btn',
      'aria-label': `Rename ${f.name}`,
      onclick: (e) => {
        e.stopPropagation();
        state.renamingFolderId = f.folder_id;
        render();
      },
      html: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L18.5 9.5a2 2 0 0 0-2.8-2.8L5 17z"/></svg>',
    });
    const del = h('button', {
      type: 'button',
      class: 'd-tool-btn danger',
      'aria-label': `Delete ${f.name}`,
      html: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>',
    });
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!armConfirm(del, { armedLabel: '×?' })) return;
      deleteFolder(f);
    });
    const tools = h('span', { class: 'd-folder-tools' }, rename, del);
    list.appendChild(h('div', { class: 'd-folder' }, item, tools));
  }

  list.appendChild(
    navItem({
      icon: I.trash,
      label: 'Trash',
      active: state.nav.kind === 'trash',
      count: counts.trash || '',
      onClick: () => selectNav({ kind: 'trash' }),
    }),
  );

  // Storage → an honest footprint of what the drive is holding right now.
  // The vault gives no account-wide total, so we report real bytes + count
  // over the loaded window instead of a fabricated "used / total".
  const files = activeFiles();
  const bytes = files.reduce((s, f) => s + (f.byte_size ?? 0), 0);
  const store = $('storage');
  store.replaceChildren(
    h(
      'div',
      { class: 'd-storage-top' },
      h('span', { class: 'lbl' }, 'Footprint'),
      h('span', { class: 'val' }, String(files.length)),
    ),
    h(
      'div',
      { class: 'd-storage-label' },
      `${fmtBytes(bytes)} across ${files.length} document${files.length === 1 ? '' : 's'}${driveTruncated ? ' — newest in view' : ''}`,
    ),
  );
}

// ---------- Toolbar render ----------

function renderToolbar() {
  const rows = visibleRows;
  const titles = { all: 'All documents', recent: 'Recent', starred: 'Starred', trash: 'Trash' };
  let title = state.nav.kind === 'folder' ? folderName(state.nav.folderId) : titles[state.nav.kind];
  if (state.search.trim()) title = `Results for “${state.search.trim()}”`;
  $('activeTitle').textContent = title;

  const n = rows.length;
  let sub;
  if (state.search.trim()) sub = `${n} match${n === 1 ? '' : 'es'} “${state.search.trim()}”`;
  else if (state.nav.kind === 'trash') sub = `${n} in trash · auto-purge after 30 days`;
  else if (state.nav.kind === 'recent') sub = 'Newest across every folder';
  else if (state.nav.kind === 'starred') sub = 'Starring isn’t wired to your vault yet';
  else sub = `${n} document${n === 1 ? '' : 's'}`;
  $('activeSub').textContent = sub;

  const chips = [
    ['all', 'All'],
    ['pdf', 'PDFs'],
    ['image', 'Images'],
    ['doc', 'Docs'],
    ['sheet', 'Sheets'],
  ];
  $('typeChips').replaceChildren(
    ...chips.map(([key, label]) =>
      h(
        'button',
        {
          type: 'button',
          class: 'd-chip',
          'aria-pressed': String(state.type === key),
          onclick: () => {
            state.type = key;
            clearSelection();
            render();
          },
        },
        label,
      ),
    ),
  );

  const sortNames = { added: 'Date', name: 'Name', size: 'Size' };
  $('sortLabel').textContent = `${sortNames[state.sortKey]} ${state.sortDir === 1 ? '↑' : '↓'}`;

  $('viewGrid').setAttribute('aria-pressed', String(state.view === 'grid'));
  $('viewList').setAttribute('aria-pressed', String(state.view === 'list'));
}

// ---------- Bulk bar ----------

function renderBulk() {
  const bar = $('bulkBar');
  const n = state.selected.size;
  bar.hidden = n === 0;
  if (n === 0) return;
  const inTrash = state.nav.kind === 'trash' && !state.search.trim();
  const actions = h('div', { class: 'd-bulk-actions' });
  if (inTrash) {
    actions.appendChild(
      h(
        'button',
        {
          type: 'button',
          class: 'd-bulk-btn',
          onclick: () =>
            runBulk([...state.selected], (id) => act('restore', { content_id: id }), {
              progress: 'Restoring',
              done: 'Restored',
            }),
        },
        'Restore',
      ),
    );
  } else {
    const move = h('button', { type: 'button', class: 'd-bulk-btn' }, 'Move to…');
    move.addEventListener('click', () => openMovePopover(move, selectedDocs()));
    actions.appendChild(move);
    const trash = h('button', { type: 'button', class: 'd-bulk-btn danger' }, 'Trash');
    trash.addEventListener('click', () => {
      if (!armConfirm(trash, { armedLabel: `Trash ${n} — sure?` })) return;
      runBulk([...state.selected], (id) => act('trash', { content_id: id }), {
        progress: 'Trashing',
        done: 'Trashed',
      });
    });
    actions.appendChild(trash);
  }
  actions.appendChild(
    h(
      'button',
      {
        type: 'button',
        class: 'd-bulk-btn',
        onclick: () => {
          clearSelection();
          render();
        },
      },
      'Clear',
    ),
  );
  bar.replaceChildren(h('span', { class: 'd-bulk-count' }, `${n} selected`), actions);
}

// ---------- Rows: grid + list ----------

function checkbox(cls, selected, onClick, label) {
  const btn = h('button', {
    type: 'button',
    class: cls,
    'aria-pressed': String(selected),
    'aria-label': label,
    onclick: onClick,
  });
  if (selected) btn.appendChild(el(I.check));
  return btn;
}

function gridCard(doc, index) {
  const m = typeMeta(doc.media_type);
  const selected = state.selected.has(doc.content_id);
  const card = h('div', { class: 'd-card', 'data-selected': String(selected) });

  const thumb = h('div', { class: 'd-thumb', style: `background:${tintBg(m.cv, 15)};` });
  if (isImage(doc)) {
    thumb.appendChild(h('img', { src: doc.content_uri, alt: '', loading: 'lazy' }));
  } else {
    thumb.appendChild(h('span', { class: 'd-thumb-label', style: `color:var(${m.cv});` }, m.label));
    thumb.appendChild(
      h(
        'div',
        { class: 'd-thumb-lines' },
        h('i', { style: `width:70%;background:var(${m.cv});opacity:.18;` }),
        h('i', { style: `width:90%;background:var(${m.cv});opacity:.14;` }),
        h('i', { style: `width:55%;background:var(${m.cv});opacity:.14;` }),
      ),
    );
  }
  thumb.addEventListener('click', (e) => {
    e.stopPropagation();
    openQuick(doc.content_id);
  });
  card.appendChild(thumb);

  card.appendChild(
    checkbox(
      'd-card-select',
      selected,
      (e) => {
        e.stopPropagation();
        toggleSelect(doc.content_id, index, e.shiftKey);
      },
      `Select ${doc.title ?? 'document'}`,
    ),
  );

  card.appendChild(
    h(
      'div',
      { class: 'd-card-body' },
      h('div', { class: 'd-card-title' }, doc.title ?? 'Untitled'),
      h('div', { class: 'd-card-meta' }, `${fmtBytes(doc.byte_size)} · ${fmtDate(doc.created_at)}`),
    ),
  );

  card.addEventListener('click', (e) => {
    if (e.target.closest('button, a')) return;
    openDetails(doc.content_id);
  });
  return card;
}

function listRow(doc, index) {
  const m = typeMeta(doc.media_type);
  const selected = state.selected.has(doc.content_id);
  const trashed = state.nav.kind === 'trash' && !state.search.trim();
  const row = h('div', { class: 'd-row', 'data-selected': String(selected) });

  row.appendChild(
    checkbox(
      'd-check',
      selected,
      (e) => {
        e.stopPropagation();
        toggleSelect(doc.content_id, index, e.shiftKey);
      },
      `Select ${doc.title ?? 'document'}`,
    ),
  );

  const badge = h('button', {
    type: 'button',
    class: 'd-badge',
    style: `background:${tintBg(m.cv, 16)};`,
    'aria-label': `Preview ${doc.title ?? 'document'}`,
    onclick: (e) => {
      e.stopPropagation();
      openQuick(doc.content_id);
    },
  });
  if (isImage(doc)) badge.appendChild(h('img', { src: doc.content_uri, alt: '', loading: 'lazy' }));
  else badge.appendChild(h('span', { style: `color:var(${m.cv});` }, m.label));
  row.appendChild(badge);

  const main = h('div', { class: 'd-row-main' });
  const title = h(
    'button',
    {
      type: 'button',
      class: 'd-row-title',
      onclick: (e) => {
        e.stopPropagation();
        openQuick(doc.content_id);
      },
    },
    doc.title ?? 'Untitled',
  );
  main.appendChild(title);
  if (state.search.trim() && doc.snippet) {
    const snip = h('div', { class: 'd-snippet' });
    snippetInto(snip, doc.snippet);
    main.appendChild(snip);
  }
  // On narrow the wide columns are hidden, so the meta rides under the name.
  if (state.narrow) {
    let metaText;
    if (trashed) metaText = `from ${folderName(doc.folder_id)} · ${purgeCountdown(doc.purge_at)}`;
    else if (state.search.trim()) metaText = `in ${folderName(doc.folder_id)}`;
    else metaText = `${fmtBytes(doc.byte_size)} · ${fmtDate(doc.created_at)}`;
    main.appendChild(h('div', { class: 'd-row-meta' }, metaText));
  }
  row.appendChild(main);

  // Wide-only columns
  row.appendChild(
    h(
      'span',
      { class: 'd-cell where' },
      trashed ? `from ${folderName(doc.folder_id)}` : folderName(doc.folder_id),
    ),
  );
  row.appendChild(h('span', { class: 'd-cell size' }, fmtBytes(doc.byte_size)));
  row.appendChild(
    h(
      'span',
      { class: `d-cell added${trashed ? ' purge' : ''}` },
      trashed ? purgeCountdown(doc.purge_at) : fmtDate(doc.created_at),
    ),
  );

  const end = h('div', { class: 'd-row-end' });
  if (trashed) {
    end.appendChild(
      h(
        'button',
        {
          type: 'button',
          class: 'd-restore',
          onclick: (e) => {
            e.stopPropagation();
            restoreDoc(doc);
          },
        },
        'Restore',
      ),
    );
  } else {
    const kebab = h('button', {
      type: 'button',
      class: 'd-kebab',
      'aria-label': `Actions for ${doc.title ?? 'document'}`,
      'aria-haspopup': 'menu',
      html: I.dots,
    });
    kebab.addEventListener('click', (e) => {
      e.stopPropagation();
      openDocMenu(kebab, doc);
    });
    end.appendChild(kebab);
  }
  row.appendChild(end);

  row.addEventListener('click', (e) => {
    if (e.target.closest('button, a, input')) return;
    openDetails(doc.content_id);
  });
  return row;
}

function emptyState(icon, title, sub, actionEl) {
  const box = $('empty');
  const subEl = h('div', { class: 'd-empty-sub' }, sub);
  if (actionEl) subEl.appendChild(actionEl);
  box.replaceChildren(
    h('div', { class: 'd-empty-icon' }, el(icon)),
    h('div', { class: 'd-empty-title' }, title),
    subEl,
  );
  box.hidden = false;
}

function renderRows() {
  const rows = visibleRows;
  const grid = $('grid');
  const listWrap = $('listWrap');
  const listHead = $('listHead');
  const list = $('list');
  const empty = $('empty');
  const foot = $('windowFoot');
  grid.hidden = true;
  listWrap.hidden = true;
  empty.hidden = true;
  foot.hidden = true;
  grid.replaceChildren();
  list.replaceChildren();

  if (rows.length === 0) {
    if (state.nav.kind === 'starred') {
      emptyState(
        I.star,
        'Nothing starred',
        'Starring is a personal marker — it isn’t backed by your vault yet, so this stays empty. Everything the drive holds lives in All documents.',
      );
    } else if (state.search.trim()) {
      emptyState(
        I.allDocs,
        'No matches',
        `No documents match “${state.search.trim()}”. Try fewer words.`,
      );
    } else if (state.nav.kind === 'trash') {
      emptyState(I.trash, 'Trash is empty', 'Trashed documents purge after about 30 days.');
    } else if (state.type !== 'all') {
      emptyState(
        I.allDocs,
        'No matches',
        'No documents of this type here. Clear the filter to see everything.',
      );
    } else if (state.nav.kind === 'folder') {
      const up = h(
        'button',
        { type: 'button', onclick: () => $('uploadInput').click() },
        'Upload to this folder',
      );
      emptyState(I.folder, 'Empty folder', 'Nothing filed here yet.', up);
    } else if (activeFiles().length === 0) {
      const up = h(
        'button',
        { type: 'button', onclick: () => $('uploadInput').click() },
        'Upload your first document',
      );
      emptyState(
        I.allDocs,
        'Your drive is empty',
        'Leases, IDs, warranties, tax forms — file the important stuff here.',
        up,
      );
    } else {
      emptyState(I.allDocs, 'Nothing here', 'No documents to show.');
    }
    return;
  }

  if (state.view === 'grid') {
    grid.hidden = false;
    rows.forEach((doc, i) => grid.appendChild(gridCard(doc, i)));
  } else {
    listWrap.hidden = false;
    listHead.hidden = state.narrow;
    if (!state.narrow) renderListHead(rows);
    rows.forEach((doc, i) => list.appendChild(listRow(doc, i)));
  }

  if (driveTruncated && !state.search.trim() && state.nav.kind !== 'starred') {
    foot.hidden = false;
    const more = h(
      'button',
      {
        type: 'button',
        onclick: async () => {
          driveWindow += 200;
          more.disabled = true;
          await refresh();
        },
      },
      'Show more',
    );
    foot.replaceChildren(
      h('span', {}, `Showing your latest ${driveWindow} documents — older ones are a search away.`),
      more,
    );
  }
}

function renderListHead(rows) {
  const head = $('listHead');
  const allSel = rows.length > 0 && rows.every((d) => state.selected.has(d.content_id));
  const check = checkbox(
    'd-check',
    allSel,
    () => {
      if (allSel) for (const d of rows) state.selected.delete(d.content_id);
      else for (const d of rows) state.selected.add(d.content_id);
      state.anchorIndex = null;
      render();
    },
    allSel ? 'Deselect all' : 'Select all',
  );
  head.replaceChildren(
    check,
    h('span', { style: 'width:34px;' }),
    h('span', { class: 'd-col name' }, 'Name'),
    h('span', { class: 'd-col where' }, 'Where'),
    h('span', { class: 'd-col size' }, 'Size'),
    h('span', { class: 'd-col added' }, 'Added'),
    h('span', { class: 'd-col end' }),
  );
}

// ---------- Details drawer ----------

function openDetails(id) {
  state.detailsId = id;
  state.quickId = null;
  renderQuick();
  renderDetails();
}
function closeDetails() {
  state.detailsId = null;
  renderDetails();
}

function renderDetails() {
  const root = $('detailsRoot');
  const doc = state.detailsId ? data.documents.find((d) => d.content_id === state.detailsId) : null;
  if (!doc) {
    root.replaceChildren();
    return;
  }
  const m = typeMeta(doc.media_type);
  const trashed = doc.trashed;

  const hero = h('div', { class: 'd-hero', style: `background:${tintBg(m.cv, 16)};` });
  if (isImage(doc)) hero.appendChild(h('img', { src: doc.content_uri, alt: '' }));
  else hero.appendChild(h('span', { style: `color:var(${m.cv});` }, m.label));

  const actions = h(
    'div',
    { class: 'd-detail-actions' },
    h(
      'button',
      { type: 'button', class: 'd-detail-btn', onclick: () => openQuick(doc.content_id) },
      'Open',
    ),
    h(
      'a',
      { class: 'd-detail-btn', href: doc.content_uri, download: doc.title ?? 'file' },
      'Download',
    ),
  );

  const grid = h(
    'dl',
    { class: 'd-detail-grid' },
    h('dt', {}, 'Type'),
    h('dd', {}, m.name),
    h('dt', {}, 'Size'),
    h('dd', {}, fmtBytes(doc.byte_size)),
    h('dt', {}, trashed ? 'Was in' : 'Folder'),
    h('dd', {}, folderName(doc.folder_id)),
    h('dt', {}, trashed ? 'Purges' : 'Added'),
    h('dd', {}, trashed ? purgeCountdown(doc.purge_at) : fmtFull(doc.created_at)),
  );

  // Activity — only what the projection can honestly derive: this document was
  // uploaded (created_at) and filed into its folder. Each is a real receipted
  // vault write, so it wears a receipt chip.
  const events = [];
  if (doc.folder_id != null)
    events.push({ text: `Filed in ${folderName(doc.folder_id)}`, date: fmtFull(doc.created_at) });
  events.push({ text: 'Uploaded to your vault', date: fmtFull(doc.created_at) });
  const activity = h('div', {});
  events.forEach((ev, i) => {
    activity.appendChild(
      h(
        'div',
        { class: 'd-activity-item' },
        h(
          'div',
          { class: 'd-activity-rail' },
          h('span', { class: 'd-activity-dot' }),
          i < events.length - 1 ? h('span', { class: 'd-activity-line' }) : null,
        ),
        h(
          'div',
          {},
          h('div', { class: 'd-activity-text' }, ev.text),
          h(
            'div',
            { class: 'd-activity-meta' },
            h('span', { class: 'd-activity-date' }, ev.date),
            h('span', { class: 'd-receipt-chip' }, 'receipt'),
          ),
        ),
      ),
    );
  });

  const foot = h('div', { class: 'd-details-foot' });
  if (trashed) {
    foot.appendChild(
      h(
        'button',
        { type: 'button', class: 'd-detail-btn', onclick: () => restoreDoc(doc) },
        'Restore',
      ),
    );
  } else {
    const move = h('button', { type: 'button', class: 'd-detail-btn' }, 'Move');
    move.addEventListener('click', () => openMovePopover(move, [doc]));
    foot.appendChild(move);
    const trash = h('button', { type: 'button', class: 'd-detail-btn danger' }, 'Trash');
    trash.addEventListener('click', () => {
      if (!armConfirm(trash, { armedLabel: 'Trash — sure?' })) return;
      trashDoc(doc);
    });
    foot.appendChild(trash);
  }

  const drawer = h(
    'aside',
    { class: 'd-details', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Document details' },
    h(
      'div',
      { class: 'd-details-head' },
      h('span', { class: 'lbl' }, 'Details'),
      h('button', {
        type: 'button',
        class: 'd-details-x',
        'aria-label': 'Close',
        onclick: closeDetails,
        html: I.close,
      }),
    ),
    h(
      'div',
      { class: 'd-details-body' },
      hero,
      h('div', { class: 'd-detail-name' }, doc.title ?? 'Untitled'),
      h('div', { class: 'd-detail-ext' }, `${extOf(doc)} · ${fmtBytes(doc.byte_size)}`),
      actions,
      h('div', { class: 'd-detail-label' }, 'Details'),
      grid,
      h('div', { class: 'd-detail-label' }, 'Activity'),
      activity,
    ),
    foot,
  );

  root.replaceChildren(h('div', { class: 'd-details-backdrop', onclick: closeDetails }), drawer);
}

function extOf(doc) {
  const t = String(doc.title ?? '');
  const dot = t.lastIndexOf('.');
  if (dot > 0 && dot < t.length - 1) return `.${t.slice(dot + 1).toLowerCase()}`;
  return typeMeta(doc.media_type).label.toLowerCase();
}

// ---------- Quick-look ----------

let lastQuickId = null;

function openQuick(id) {
  state.quickId = id;
  renderQuick();
}
function closeQuick() {
  state.quickId = null;
  renderQuick();
}
function quickStep(delta) {
  const idx = visibleRows.findIndex((d) => d.content_id === state.quickId);
  const next = idx < 0 ? undefined : visibleRows[idx + delta];
  if (next) openQuick(next.content_id);
}

function renderQuick() {
  const root = $('quickRoot');
  const doc = state.quickId ? data.documents.find((d) => d.content_id === state.quickId) : null;
  if (!doc) {
    root.replaceChildren();
    lastQuickId = null;
    return;
  }
  if (doc.content_id === lastQuickId && root.firstElementChild) return; // avoid reloading an open iframe on unrelated renders
  lastQuickId = doc.content_id;

  const m = typeMeta(doc.media_type);
  const idx = visibleRows.findIndex((d) => d.content_id === doc.content_id);

  let stageInner;
  if (isImage(doc)) {
    stageInner = h('img', {
      class: 'd-quick-image',
      src: doc.content_uri,
      alt: doc.title ?? 'Image',
    });
  } else if (String(doc.media_type ?? '') === 'application/pdf' && loadable(doc.content_uri)) {
    stageInner = h('iframe', {
      class: 'd-quick-frame',
      src: doc.content_uri,
      title: doc.title ?? 'PDF',
    });
  } else {
    // A document-page mock for docs / sheets / slides / other.
    const page = h('div', { class: 'd-quick-page' });
    page.appendChild(
      h('i', {
        style: `height:11px;width:44%;background:var(${m.cv});opacity:.85;margin-bottom:22px;`,
      }),
    );
    const widths = [96, 88, 93, 70, 90, 82, 60];
    widths.forEach((w, i) =>
      page.appendChild(
        h('i', {
          style: `height:7px;width:${w}%;background:${i < 4 ? '#e6e7ea' : '#eceef1'};margin-bottom:${i === 3 ? 26 : 11}px;`,
        }),
      ),
    );
    stageInner = page;
  }

  const prev = h('button', {
    type: 'button',
    class: 'd-quick-nav prev',
    'aria-label': 'Previous',
    disabled: idx <= 0 || undefined,
    onclick: () => quickStep(-1),
    html: I.chevL,
  });
  const next = h('button', {
    type: 'button',
    class: 'd-quick-nav next',
    'aria-label': 'Next',
    disabled: idx < 0 || idx >= visibleRows.length - 1 || undefined,
    onclick: () => quickStep(1),
    html: I.chevR,
  });

  const overlay = h(
    'div',
    { class: 'd-quick', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Quick look' },
    h(
      'div',
      { class: 'd-quick-top' },
      h(
        'span',
        { class: 'd-quick-badge', style: `background:${tintBg(m.cv, 20)};color:var(${m.cv});` },
        m.label,
      ),
      h('span', { class: 'd-quick-title' }, doc.title ?? 'Untitled'),
      h(
        'a',
        { class: 'd-quick-btn', href: doc.content_uri, download: doc.title ?? 'file' },
        el(I.download),
        'Download',
      ),
      h('button', {
        type: 'button',
        class: 'd-quick-btn icon',
        'aria-label': 'Close',
        onclick: closeQuick,
        html: I.close,
      }),
    ),
    h('div', { class: 'd-quick-stage' }, prev, stageInner, next),
    h(
      'div',
      { class: 'd-quick-foot' },
      `${folderName(doc.folder_id)} · ${fmtBytes(doc.byte_size)} · added ${fmtFull(doc.created_at)}`,
    ),
  );
  root.replaceChildren(overlay);
}

// ---------- New menu ----------

function renderNewMenu() {
  const menu = $('newMenu');
  menu.hidden = !state.newMenuOpen;
  $('newBtn').setAttribute('aria-expanded', String(state.newMenuOpen));
  if (!state.newMenuOpen) {
    menu.replaceChildren();
    return;
  }
  const upload = h('button', {
    type: 'button',
    class: 'd-menu-item',
    role: 'menuitem',
    onclick: () => {
      state.newMenuOpen = false;
      renderNewMenu();
      $('uploadInput').click();
    },
  });
  upload.appendChild(el(I.upload));
  upload.appendChild(document.createTextNode('Upload files'));
  const folder = h('button', {
    type: 'button',
    class: 'd-menu-item',
    role: 'menuitem',
    onclick: () => {
      state.newMenuOpen = false;
      state.creatingFolder = true;
      render();
    },
  });
  folder.appendChild(el(I.folderPlus));
  folder.appendChild(document.createTextNode('New folder'));
  menu.replaceChildren(upload, h('div', { class: 'd-menu-sep' }), folder);
}

// ---------- Navigation ----------

function selectNav(nav) {
  state.nav = nav;
  clearSelection();
  state.detailsId = null;
  state.search = '';
  searchResults = null;
  $('searchInput').value = '';
  state.newMenuOpen = false;
  state.creatingFolder = false;
  state.renamingFolderId = null;
  if (state.narrow) $('root').classList.remove('side-open');
  renderDetails();
  render();
}

// ---------- Master render ----------

function render() {
  // A folder can vanish under us (deleted elsewhere) — fall back to the top.
  if (state.nav.kind === 'folder' && !folderById(state.nav.folderId)) state.nav = { kind: 'all' };
  closePopover();
  visibleRows = currentRows(); // one source of truth for toolbar counts + rows
  renderSidebar();
  renderNewMenu();
  renderToolbar();
  renderBulk();
  renderRows();
}

// ---------- Search ----------

const applySearch = debounce(async () => {
  const q = $('searchInput').value.trim();
  if (q === state.search) return;
  state.search = q;
  clearSelection();
  if (!q) {
    searchResults = null;
    render();
    return;
  }
  const seq = ++searchSeq;
  let rows = [];
  try {
    const res = await window.centraid.read({ query: 'search', input: { term: q } });
    rows = res?.documents ?? [];
  } catch {
    rows = [];
  }
  if (seq !== searchSeq) return;
  searchResults = rows;
  render();
}, 150);

// ---------- Refresh ----------

let readFailedShowing = false;

async function refresh() {
  let next;
  try {
    next = await window.centraid.read({ query: 'drive', input: { limit: driveWindow } });
  } catch {
    readFailed($('noticeBanner'));
    readFailedShowing = true;
    return;
  }
  if (readFailedShowing) {
    readFailedShowing = false;
    notice('');
  }
  const denied = next?.vaultDenied;
  $('consentBanner').hidden = !denied;
  $('root').classList.toggle('denied', Boolean(denied));
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    return;
  }
  data = next ?? data;
  data.folders = data.folders ?? [];
  data.documents = data.documents ?? [];
  driveTruncated = Boolean(next?.truncated);
  // Drop selections and open surfaces for documents that no longer exist.
  state.selected = new Set(
    [...state.selected].filter((id) => data.documents.some((d) => d.content_id === id)),
  );
  if (state.detailsId && !data.documents.some((d) => d.content_id === state.detailsId))
    state.detailsId = null;
  if (state.quickId && !data.documents.some((d) => d.content_id === state.quickId))
    state.quickId = null;
  render();
  renderDetails();
  renderQuick();
}

// ---------- Chrome wiring ----------

function isDarkNow() {
  const t = document.documentElement.dataset.theme;
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
}
function setThemeIcon() {
  $('themeBtn').innerHTML = isDarkNow() ? I.sun : I.moon;
}
function toggleTheme() {
  const dark = !isDarkNow();
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  if (dark && !root.style.getPropertyValue('--bg-l')) root.style.setProperty('--bg-l', '10%');
  setThemeIcon();
}

$('newBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  state.newMenuOpen = !state.newMenuOpen;
  renderNewMenu();
});
document.addEventListener('click', (e) => {
  if (state.newMenuOpen && !e.target.closest('.d-new-wrap')) {
    state.newMenuOpen = false;
    renderNewMenu();
  }
});
$('viewGrid').addEventListener('click', () => {
  state.view = 'grid';
  render();
});
$('viewList').addEventListener('click', () => {
  state.view = 'list';
  render();
});
$('themeBtn').addEventListener('click', toggleTheme);
$('sortBtn').addEventListener('click', () => {
  const order = ['added', 'name', 'size'];
  if (state.sortDir === -1 && state.sortKey !== 'name') {
    state.sortDir = 1;
    render();
    return;
  }
  if (state.sortDir === 1) {
    state.sortDir = -1;
    render();
    return;
  }
  const i = order.indexOf(state.sortKey);
  const nextKey = order[(i + 1) % order.length];
  state.sortKey = nextKey;
  state.sortDir = nextKey === 'name' ? 1 : -1;
  render();
});
$('hamburger').addEventListener('click', () => $('root').classList.add('side-open'));
$('sideClose').addEventListener('click', () => $('root').classList.remove('side-open'));
$('scrim').addEventListener('click', () => $('root').classList.remove('side-open'));

$('searchInput').addEventListener('input', applySearch);
$('searchInput').addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  if (!$('searchInput').value && !state.search) return;
  $('searchInput').value = '';
  searchSeq += 1;
  state.search = '';
  searchResults = null;
  clearSelection();
  render();
});

$('uploadInput').addEventListener('change', async () => {
  const input = $('uploadInput');
  const files = [...input.files];
  input.value = '';
  await uploadFiles(files);
});
window.addEventListener('focus', refresh);

// Drag-and-drop onto the current folder.
let dragDepth = 0;
function dragHasFiles(e) {
  return [...(e.dataTransfer?.types ?? [])].includes('Files');
}
window.addEventListener('dragenter', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  dragDepth += 1;
  const target = state.nav.kind === 'folder' ? folderName(state.nav.folderId) : 'Documents';
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

// Keyboard: quick-look nav, and a layered Escape.
window.addEventListener('keydown', (e) => {
  if (state.quickId) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeQuick();
    } else if (e.key === 'ArrowLeft') quickStep(-1);
    else if (e.key === 'ArrowRight') quickStep(1);
    return;
  }
  if (e.key !== 'Escape') return;
  if (state.detailsId) {
    closeDetails();
    return;
  }
  if (state.newMenuOpen) {
    state.newMenuOpen = false;
    renderNewMenu();
    return;
  }
  if ($('root').classList.contains('side-open')) $('root').classList.remove('side-open');
});

// Component-width driven responsive: blueprints render inside a panel, so we
// measure the root's own width (not the viewport) and toggle the phone layout.
function measure() {
  const root = $('root');
  const forced = document.documentElement.getAttribute('data-app-width') === 'narrow';
  const narrow = forced || root.clientWidth < 860;
  if (narrow !== state.narrow) {
    state.narrow = narrow;
    root.classList.toggle('is-narrow', narrow);
    if (!narrow) root.classList.remove('side-open');
    renderRows();
  }
}

// ---------- Boot ----------

setThemeIcon();
$('root').classList.toggle('is-narrow', $('root').clientWidth < 860);
state.narrow = $('root').clientWidth < 860;
showSkeleton($('list'), 6);
$('listWrap').hidden = false;
measure();
setInterval(measure, 250);
refresh();
