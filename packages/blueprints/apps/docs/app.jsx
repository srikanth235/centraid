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
// Starred is vault-canonical (issue #274): one flags-scheme tag on the
// canonical content item, written through core.star_document/unstar_document
// — the same star a favorited photo carries, so Starred here shows them too.
// Sharing still has no vault signal (no per-person "shared" edge), so there
// is honestly no sharing UI at all.
//
// React port (native web-components infra, see kit/react-core.min.js): the
// static index.html body is unchanged, and this module owns one React root
// per dynamic container (created once at boot) plus the same external
// `state`/`data` objects and render orchestrator the Lit version used —
// every write still mutates `state`, then calls `render()`, which fans out
// to each root's `.render(...)` call. Popovers (kebab / move-to) stay plain
// DOM built with kit's `h()`/`popItem()`, exactly as before — no React root
// needed there. `emptyState()`/`showSkeleton()` remain the raw kit.js DOM
// helpers because `#empty` and the boot skeleton in `#list` are the two
// spots that were never Lit-rendered either; every OTHER container below was
// Lit-templated before and is React-templated now.

import { createRoot, useEffect, useRef } from './react-core.min.js';
import {
  armConfirm,
  closePopover,
  debounce,
  emptyState,
  fmtBytes as fmtBytesBase,
  h,
  openPopover,
  outcomeMessage,
  popItem,
  readFailed,
  runBulk as runBulkBase,
  showSkeleton,
  stageFileBytes,
  toast,
  wireThemeToggle,
} from './kit.js';
// `h` stays imported: it builds the empty-state action buttons (a real-DOM-
// node contract `emptyState()` expects, not a JSX context) and the plain-DOM
// popover content (kebab menu, move-to tree) — both "imperative island" carve
// -outs the refactor brief sanctions, not reimplementations of React.

const $ = (id) => document.getElementById(id);
// Bytes stream to the blob staging route (issue #296) — no base64 through
// command JSON — so big documents fit; the route itself caps at 512 MB.
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

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
};

// The folder row's hover-revealed rename/delete tool icons (14px — distinct
// from the 18px sidebar/toolbar set above).
const RENAME_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L18.5 9.5a2 2 0 0 0-2.8-2.8L5 17z"/></svg>';
const DELETE_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>';

// A trusted static SVG string rendered inline, with the exact DOM shape the
// old `el(svg)` produced: no wrapper box in the layout (`display:contents`),
// so flex/gap rules written against the *icon itself* being a flex child
// (e.g. `.d-nav-item { gap: 11px }`) keep behaving identically. `<i>` (not
// `<span>`) so it never collides with `.d-nav-item span:first-of-type`,
// the one rule in app.css that counts sibling spans.
function Icon({ svg }) {
  return <i style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

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

// The drive shows an em dash for absent sizes everywhere it prints bytes.
const fmtBytes = (n) => fmtBytesBase(n, '—');
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
  // Same-origin vault blob URLs (issue #296) render everywhere data: did —
  // and in iframes BETTER: `default-src 'self'` allows them where data:
  // PDFs went blank.
  return /^(data:|https?:|\/centraid\/_vault\/blobs\/)/i.test(String(uri ?? ''));
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
  let list;
  if (search.trim()) {
    list = searchResults ?? []; // flat vault FTS matches across every folder
  } else if (nav.kind === 'trash') {
    list = trashedFiles();
  } else {
    list = activeFiles();
    if (nav.kind === 'starred') list = list.filter((f) => f.starred);
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

// One "Move to…" target row. `popItem` (kit.js) builds the real button node;
// these popovers stay plain DOM (built with `h()`/`popItem()`), exactly as
// before — the target list mixes a fixed depth-0 root with depth-1 folders,
// same as the vanilla builder always did.
function moveTargetBtn(folderId, name, depth, ids, single) {
  const btn = popItem(name, async () => {
    closePopover();
    await moveDocs(ids, folderId, name);
  });
  btn.style.paddingLeft = `${0.7 + depth * 0.85}rem`;
  if (single && (single.folder_id ?? null) === folderId) btn.disabled = true;
  return btn;
}

// One shared "Move to…" tree for the kebab and the bulk toolbar.
function openMovePopover(anchor, docs) {
  const ids = docs.map((d) => d.content_id);
  const single = docs.length === 1 ? docs[0] : null;
  openPopover(anchor, (box) => {
    const head = h(
      'p',
      { class: 'kit-popover-head' },
      single ? `Move “${single.title ?? 'document'}” to` : `Move ${docs.length} to`,
    );
    const scroll = h(
      'div',
      { class: 'kit-popover-scroll' },
      moveTargetBtn(null, 'Documents', 0, ids, single),
      ...data.folders.map((f) => moveTargetBtn(f.folder_id, f.name, 1, ids, single)),
    );
    box.append(head, scroll);
  });
}

function openDocMenu(anchor, doc) {
  closePopover();
  openPopover(anchor, (box) => {
    box.append(
      popItem('Open', () => {
        closePopover();
        openQuick(doc.content_id);
      }),
      h(
        'a',
        {
          class: 'kit-popover-item',
          role: 'menuitem',
          href: doc.content_uri,
          download: doc.title ?? 'file',
          onclick: closePopover,
        },
        'Download',
      ),
      popItem('Rename', () => {
        closePopover();
        startRenameDoc(doc);
      }),
      popItem(doc.starred ? 'Remove star' : 'Star', () => {
        closePopover();
        toggleStar(doc);
      }),
      popItem('Move to…', () => openMovePopover(anchor, [doc])),
      h('div', { class: 'kit-popover-sep' }),
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

// One star across the vault: the flags-scheme tag on the canonical content
// item, so favorites from Photos and stars from here are the same judgment.
async function toggleStar(doc) {
  const outcome = await act(doc.starred ? 'unstar' : 'star', { content_id: doc.content_id });
  if (narrate(outcome)) {
    toast(doc.starred ? 'Star removed · receipted.' : 'Starred · receipted.');
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

// Loop an action over many rows (kit runBulk) in this app's voice: our
// notice banner, our friendly failure copy, and the old hard-wired tail —
// clear the selection, then refresh.
const runBulk = (ids, run, opts) =>
  runBulkBase(ids, run, {
    ...opts,
    notice,
    friendly: friendlyOutcome,
    after: async () => {
      clearSelection();
      await refresh();
    },
  });

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

// Each file's bytes stage into the vault's CAS via kit stageFileBytes
// (issue #296); the upload action claims the returned sha — that claim is
// the receipt.
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
      `“${skipped[0].name}” is ${fmtBytes(skipped[0].size)} — files up to 512 MB travel well.`,
    );
  else if (skipped.length > 1) failures.push(`Skipped ${skipped.length} files over 512 MB.`);

  uploading = true;
  let ok = 0;
  let parked = 0;
  for (let i = 0; i < accepted.length; i += 1) {
    const file = accepted[i];
    notice(`Uploading ${i + 1} of ${accepted.length}…`);
    let staged;
    try {
      staged = await stageFileBytes(file);
    } catch {
      failures.push(`Could not read “${file.name}”.`);
      continue;
    }
    const outcome = await act('upload', {
      staged_sha: staged.sha256,
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

// ---------- Sidebar components ----------

function NavItem({ icon, label, active, count, onClick }) {
  return (
    <button type="button" className="d-nav-item" aria-current={String(!!active)} onClick={onClick}>
      <Icon svg={icon} />
      <span>{label}</span>
      {count != null ? <span className="d-nav-count">{count}</span> : null}
    </button>
  );
}

function SmartNav({ counts }) {
  return (
    <>
      <NavItem
        icon={I.allDocs}
        label="All documents"
        active={state.nav.kind === 'all'}
        count={counts.all}
        onClick={() => selectNav({ kind: 'all' })}
      />
      <NavItem
        icon={I.clock}
        label="Recent"
        active={state.nav.kind === 'recent'}
        onClick={() => selectNav({ kind: 'recent' })}
      />
      <NavItem
        icon={I.star}
        label="Starred"
        active={state.nav.kind === 'starred'}
        count={counts.starred}
        onClick={() => selectNav({ kind: 'starred' })}
      />
    </>
  );
}

// The new-folder editor row: an uncontrolled input, focused once on mount —
// the React analogue of the old Lit `ref()` callback, which ran synchronously
// during commit (well before `commit()` could be invoked by a later
// click/keydown). React preserves this same host `<input>` node across
// re-renders of the same tree shape, so typed text and focus both survive
// unrelated re-renders exactly as they did under Lit.
function FolderCreateEdit() {
  const inputRef = useRef(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const commit = () => {
    const name = inputRef.current.value.trim();
    if (name) createFolder(name);
    else {
      state.creatingFolder = false;
      render();
    }
  };
  return (
    <div className="d-folder-edit">
      <input
        type="text"
        placeholder="Folder name…"
        aria-label="New folder name"
        ref={inputRef}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
          if (e.key === 'Escape') {
            state.creatingFolder = false;
            render();
          }
        }}
      />
      <button type="button" onClick={commit}>
        Create
      </button>
    </div>
  );
}

function FolderRenameEdit({ f }) {
  const inputRef = useRef(null);
  useEffect(() => {
    const node = inputRef.current;
    if (node) {
      node.focus();
      node.select();
    }
  }, []);
  const commit = () => {
    const name = inputRef.current.value.trim();
    if (name && name !== f.name) renameFolder(f.folder_id, name);
    else {
      state.renamingFolderId = null;
      render();
    }
  };
  return (
    <div className="d-folder-edit">
      <input
        type="text"
        aria-label="Folder name"
        defaultValue={f.name}
        ref={inputRef}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
          if (e.key === 'Escape') {
            state.renamingFolderId = null;
            render();
          }
        }}
      />
      <button type="button" onClick={commit}>
        Save
      </button>
    </div>
  );
}

function FolderRow({ f }) {
  if (state.renamingFolderId === f.folder_id) return <FolderRenameEdit f={f} />;
  const count = activeFiles().filter((d) => (d.folder_id ?? null) === f.folder_id).length;
  const active = state.nav.kind === 'folder' && state.nav.folderId === f.folder_id;
  return (
    <div className="d-folder">
      <NavItem
        icon={I.folder}
        label={f.name}
        active={active}
        count={count || ''}
        onClick={() => selectNav({ kind: 'folder', folderId: f.folder_id })}
      />
      <span className="d-folder-tools">
        <button
          type="button"
          className="d-tool-btn"
          aria-label={`Rename ${f.name}`}
          onClick={(e) => {
            e.stopPropagation();
            state.renamingFolderId = f.folder_id;
            render();
          }}
        >
          <Icon svg={RENAME_ICON} />
        </button>
        <button
          type="button"
          className="d-tool-btn danger"
          aria-label={`Delete ${f.name}`}
          onClick={(e) => {
            e.stopPropagation();
            if (!armConfirm(e.currentTarget, { armedLabel: '×?' })) return;
            deleteFolder(f);
          }}
        >
          <Icon svg={DELETE_ICON} />
        </button>
      </span>
    </div>
  );
}

function FolderList({ counts }) {
  return (
    <>
      {state.creatingFolder ? <FolderCreateEdit /> : null}
      {data.folders.map((f) => (
        <FolderRow key={f.folder_id} f={f} />
      ))}
      <NavItem
        icon={I.trash}
        label="Trash"
        active={state.nav.kind === 'trash'}
        count={counts.trash || ''}
        onClick={() => selectNav({ kind: 'trash' })}
      />
    </>
  );
}

// Storage → an honest footprint of what the drive is holding right now. The
// vault gives no account-wide total, so we report real bytes + count over the
// loaded window instead of a fabricated "used / total".
function Storage() {
  const files = activeFiles();
  const bytes = files.reduce((s, f) => s + (f.byte_size ?? 0), 0);
  return (
    <>
      <div className="d-storage-top">
        <span className="lbl">Footprint</span>
        <span className="val">{files.length}</span>
      </div>
      <div className="d-storage-label">
        {fmtBytes(bytes)} across {files.length} document
        {files.length === 1 ? '' : 's'}
        {driveTruncated ? ' — newest in view' : ''}
      </div>
    </>
  );
}

let smartNavRoot;
let folderListRoot;
let storageRoot;

function renderSidebar() {
  const counts = {
    all: activeFiles().length,
    starred: activeFiles().filter((f) => f.starred).length,
    trash: trashedFiles().length,
  };
  smartNavRoot.render(<SmartNav counts={counts} />);
  folderListRoot.render(<FolderList counts={counts} />);
  storageRoot.render(<Storage />);
}

// ---------- Toolbar components ----------

const TYPE_CHIPS = [
  ['all', 'All'],
  ['pdf', 'PDFs'],
  ['image', 'Images'],
  ['doc', 'Docs'],
  ['sheet', 'Sheets'],
];

function TypeChips() {
  return (
    <>
      {TYPE_CHIPS.map(([key, label]) => (
        <button
          key={key}
          type="button"
          className="kit-chip quiet"
          aria-pressed={String(state.type === key)}
          onClick={() => {
            state.type = key;
            clearSelection();
            render();
          }}
        >
          {label}
        </button>
      ))}
    </>
  );
}

let typeChipsRoot;

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
  else if (state.nav.kind === 'starred')
    sub = `${n} starred document${n === 1 ? '' : 's'} · one star across your vault`;
  else sub = `${n} document${n === 1 ? '' : 's'}`;
  $('activeSub').textContent = sub;

  typeChipsRoot.render(<TypeChips />);

  const sortNames = { added: 'Date', name: 'Name', size: 'Size' };
  $('sortLabel').textContent = `${sortNames[state.sortKey]} ${state.sortDir === 1 ? '↑' : '↓'}`;

  $('viewGrid').setAttribute('aria-pressed', String(state.view === 'grid'));
  $('viewList').setAttribute('aria-pressed', String(state.view === 'list'));
}

// ---------- Bulk bar ----------

function BulkBar({ n }) {
  const inTrash = state.nav.kind === 'trash' && !state.search.trim();
  return (
    <>
      <span className="d-bulk-count">{n} selected</span>
      <div className="d-bulk-actions">
        {inTrash ? (
          <button
            type="button"
            className="kit-btn"
            onClick={() =>
              runBulk([...state.selected], (id) => act('restore', { content_id: id }), {
                progress: 'Restoring',
                done: 'Restored',
              })
            }
          >
            Restore
          </button>
        ) : (
          <>
            <button
              type="button"
              className="kit-btn"
              onClick={(e) => openMovePopover(e.currentTarget, selectedDocs())}
            >
              Move to…
            </button>
            <button
              type="button"
              className="kit-btn danger"
              onClick={(e) => {
                if (!armConfirm(e.currentTarget, { armedLabel: `Trash ${n} — sure?` })) return;
                runBulk([...state.selected], (id) => act('trash', { content_id: id }), {
                  progress: 'Trashing',
                  done: 'Trashed',
                });
              }}
            >
              Trash
            </button>
          </>
        )}
        <button
          type="button"
          className="kit-btn"
          onClick={() => {
            clearSelection();
            render();
          }}
        >
          Clear
        </button>
      </div>
    </>
  );
}

let bulkBarRoot;

// The bar's stale content is left in place (hidden) when the selection drops
// to zero, matching the old builder's behavior of never clearing it — only
// the next non-empty selection re-populates it. (Same reason `bulkBarRoot`
// is never asked to render `null` here.)
function renderBulk() {
  const bar = $('bulkBar');
  const n = state.selected.size;
  bar.hidden = n === 0;
  if (n === 0) return;
  bulkBarRoot.render(<BulkBar n={n} />);
}

// ---------- Rows: grid + list ----------

function Checkbox({ cls, selected, onClick, label }) {
  return (
    <button
      type="button"
      className={cls}
      aria-pressed={String(selected)}
      aria-label={label}
      onClick={onClick}
    >
      {selected ? <Icon svg={I.check} /> : null}
    </button>
  );
}

function GridCard({ doc, index }) {
  const m = typeMeta(doc.media_type);
  const selected = state.selected.has(doc.content_id);
  return (
    <div
      className="d-card"
      data-selected={String(selected)}
      onClick={(e) => {
        if (e.target.closest('button, a')) return;
        openDetails(doc.content_id);
      }}
    >
      <div
        className="d-thumb"
        style={{ background: tintBg(m.cv, 15) }}
        onClick={(e) => {
          e.stopPropagation();
          openQuick(doc.content_id);
        }}
      >
        {isImage(doc) ? (
          <img src={doc.content_uri} alt="" loading="lazy" />
        ) : (
          <>
            <span className="d-thumb-label" style={{ color: `var(${m.cv})` }}>
              {m.label}
            </span>
            <div className="d-thumb-lines">
              <i style={{ width: '70%', background: `var(${m.cv})`, opacity: 0.18 }}></i>
              <i style={{ width: '90%', background: `var(${m.cv})`, opacity: 0.14 }}></i>
              <i style={{ width: '55%', background: `var(${m.cv})`, opacity: 0.14 }}></i>
            </div>
          </>
        )}
      </div>
      <Checkbox
        cls="d-card-select"
        selected={selected}
        onClick={(e) => {
          e.stopPropagation();
          toggleSelect(doc.content_id, index, e.shiftKey);
        }}
        label={`Select ${doc.title ?? 'document'}`}
      />
      <div className="d-card-body">
        <div className="d-card-title">
          {doc.title ?? 'Untitled'}
          {doc.starred ? (
            <span className="d-star-ind" aria-label="Starred">
              ★
            </span>
          ) : null}
        </div>
        <div className="d-card-meta">
          {fmtBytes(doc.byte_size)} · {fmtDate(doc.created_at)}
        </div>
      </div>
    </div>
  );
}

// The search-hit snippet: replicated as JSX `<mark>` spans instead of calling
// kit's `snippetInto()` — that helper mutates a container's DOM directly,
// which must never target a React-owned node (this row lives in a React
// root). Plain strings interleaved with `<mark>` reproduce the exact old
// text-node + <mark> shape `.d-snippet mark` styles.
function Snippet({ snippet }) {
  const parts = String(snippet ?? '').split(/[⟦⟧]/);
  return (
    <div className="d-snippet">
      {parts.map((part, i) => (!part ? null : i % 2 === 1 ? <mark key={i}>{part}</mark> : part))}
    </div>
  );
}

function ListRow({ doc, index }) {
  const m = typeMeta(doc.media_type);
  const selected = state.selected.has(doc.content_id);
  const trashed = state.nav.kind === 'trash' && !state.search.trim();
  return (
    <div
      className="d-row"
      data-selected={String(selected)}
      onClick={(e) => {
        if (e.target.closest('button, a, input')) return;
        openDetails(doc.content_id);
      }}
    >
      <Checkbox
        cls="d-check"
        selected={selected}
        onClick={(e) => {
          e.stopPropagation();
          toggleSelect(doc.content_id, index, e.shiftKey);
        }}
        label={`Select ${doc.title ?? 'document'}`}
      />
      <button
        type="button"
        className="d-badge"
        style={{ background: tintBg(m.cv, 16) }}
        aria-label={`Preview ${doc.title ?? 'document'}`}
        onClick={(e) => {
          e.stopPropagation();
          openQuick(doc.content_id);
        }}
      >
        {isImage(doc) ? (
          <img src={doc.content_uri} alt="" loading="lazy" />
        ) : (
          <span style={{ color: `var(${m.cv})` }}>{m.label}</span>
        )}
      </button>
      <div className="d-row-main">
        <button
          type="button"
          className="d-row-title"
          onClick={(e) => {
            e.stopPropagation();
            openQuick(doc.content_id);
          }}
        >
          {doc.title ?? 'Untitled'}
          {doc.starred ? (
            <span className="d-star-ind" aria-label="Starred">
              ★
            </span>
          ) : null}
        </button>
        {state.search.trim() && doc.snippet ? <Snippet snippet={doc.snippet} /> : null}
        {state.narrow ? (
          <div className="d-row-meta">
            {trashed
              ? `from ${folderName(doc.folder_id)} · ${purgeCountdown(doc.purge_at)}`
              : state.search.trim()
                ? `in ${folderName(doc.folder_id)}`
                : `${fmtBytes(doc.byte_size)} · ${fmtDate(doc.created_at)}`}
          </div>
        ) : null}
      </div>
      <span className="d-cell where">
        {trashed ? `from ${folderName(doc.folder_id)}` : folderName(doc.folder_id)}
      </span>
      <span className="d-cell size">{fmtBytes(doc.byte_size)}</span>
      <span className={`d-cell added${trashed ? ' purge' : ''}`}>
        {trashed ? purgeCountdown(doc.purge_at) : fmtDate(doc.created_at)}
      </span>
      <div className="d-row-end">
        {trashed ? (
          <button
            type="button"
            className="kit-btn"
            onClick={(e) => {
              e.stopPropagation();
              restoreDoc(doc);
            }}
          >
            Restore
          </button>
        ) : (
          <button
            type="button"
            className="d-kebab"
            aria-label={`Actions for ${doc.title ?? 'document'}`}
            aria-haspopup="menu"
            onClick={(e) => {
              e.stopPropagation();
              openDocMenu(e.currentTarget, doc);
            }}
          >
            <Icon svg={I.dots} />
          </button>
        )}
      </div>
    </div>
  );
}

// `#grid`/`#list` are React-owned containers: `#list` starts holding the boot
// `showSkeleton()` markup. Unlike Lit, React's first `root.render()` DOES
// clear pre-existing children it never created (verified against the vendored
// react-core under jsdom), so the `mounted` guards below are not load-bearing
// — they only make the skeleton handoff explicit and independent of that React
// behavior. Clearing between views goes through `root.render(null)` — never a
// raw `replaceChildren()` after React owns the container.
let gridRoot;
let gridMounted = false;
function mountGrid(node) {
  const grid = $('grid');
  if (!gridMounted) {
    grid.replaceChildren();
    gridMounted = true;
  }
  gridRoot.render(node);
}
let listRoot;
let listMounted = false;
function mountList(node) {
  const list = $('list');
  if (!listMounted) {
    list.replaceChildren();
    listMounted = true;
  }
  listRoot.render(node);
}

function ListHead({ rows }) {
  const allSel = rows.length > 0 && rows.every((d) => state.selected.has(d.content_id));
  return (
    <>
      <Checkbox
        cls="d-check"
        selected={allSel}
        onClick={() => {
          if (allSel) for (const d of rows) state.selected.delete(d.content_id);
          else for (const d of rows) state.selected.add(d.content_id);
          state.anchorIndex = null;
          render();
        }}
        label={allSel ? 'Deselect all' : 'Select all'}
      />
      <span style={{ width: '34px' }}></span>
      <span className="d-col name">Name</span>
      <span className="d-col where">Where</span>
      <span className="d-col size">Size</span>
      <span className="d-col added">Added</span>
      <span className="d-col end"></span>
    </>
  );
}

function WindowFoot() {
  return (
    <>
      <span>Showing your latest {driveWindow} documents — older ones are a search away.</span>
      <button
        type="button"
        className="kit-btn"
        onClick={async (e) => {
          driveWindow += 200;
          e.currentTarget.disabled = true;
          await refresh();
        }}
      >
        Show more
      </button>
    </>
  );
}

let listHeadRoot;
let windowFootRoot;

function renderRows() {
  const rows = visibleRows;
  const grid = $('grid');
  const listWrap = $('listWrap');
  const listHead = $('listHead');
  const empty = $('empty');
  const foot = $('windowFoot');
  grid.hidden = true;
  listWrap.hidden = true;
  empty.hidden = true;
  foot.hidden = true;
  mountGrid(null);
  mountList(null);

  if (rows.length === 0) {
    if (state.nav.kind === 'starred' && state.type === 'all') {
      emptyState(empty, {
        icon: I.star,
        title: 'Nothing starred yet',
        sub: 'Star a document from its menu to pin it here. It is one star across your vault — photos you favorite land here too.',
      });
    } else if (state.search.trim()) {
      emptyState(empty, {
        icon: I.allDocs,
        title: 'No matches',
        sub: `No documents match “${state.search.trim()}”. Try fewer words.`,
      });
    } else if (state.nav.kind === 'trash') {
      emptyState(empty, {
        icon: I.trash,
        title: 'Trash is empty',
        sub: 'Trashed documents purge after about 30 days.',
      });
    } else if (state.type !== 'all') {
      emptyState(empty, {
        icon: I.allDocs,
        title: 'No matches',
        sub: 'No documents of this type here. Clear the filter to see everything.',
      });
    } else if (state.nav.kind === 'folder') {
      const up = h(
        'button',
        { type: 'button', onclick: () => $('uploadInput').click() },
        'Upload to this folder',
      );
      emptyState(empty, {
        icon: I.folder,
        title: 'Empty folder',
        sub: 'Nothing filed here yet.',
        action: up,
      });
    } else if (activeFiles().length === 0) {
      const up = h(
        'button',
        { type: 'button', onclick: () => $('uploadInput').click() },
        'Upload your first document',
      );
      emptyState(empty, {
        icon: I.allDocs,
        title: 'Your drive is empty',
        sub: 'Leases, IDs, warranties, tax forms — file the important stuff here.',
        action: up,
      });
    } else {
      emptyState(empty, {
        icon: I.allDocs,
        title: 'Nothing here',
        sub: 'No documents to show.',
      });
    }
    return;
  }

  if (state.view === 'grid') {
    grid.hidden = false;
    mountGrid(
      <>
        {rows.map((d, i) => (
          <GridCard key={d.content_id} doc={d} index={i} />
        ))}
      </>,
    );
  } else {
    listWrap.hidden = false;
    listHead.hidden = state.narrow;
    if (!state.narrow) listHeadRoot.render(<ListHead rows={rows} />);
    mountList(
      <>
        {rows.map((d, i) => (
          <ListRow key={d.content_id} doc={d} index={i} />
        ))}
      </>,
    );
  }

  if (driveTruncated && !state.search.trim() && state.nav.kind !== 'starred') {
    foot.hidden = false;
    windowFootRoot.render(<WindowFoot />);
  }
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

function Details({ doc }) {
  const m = typeMeta(doc.media_type);
  const trashed = doc.trashed;

  // Activity — only what the projection can honestly derive: this document was
  // uploaded (created_at) and filed into its folder. Each is a real receipted
  // vault write, so it wears a receipt chip.
  const events = [];
  if (doc.folder_id != null)
    events.push({ text: `Filed in ${folderName(doc.folder_id)}`, date: fmtFull(doc.created_at) });
  events.push({ text: 'Uploaded to your vault', date: fmtFull(doc.created_at) });

  return (
    <>
      <div className="d-details-backdrop" onClick={closeDetails}></div>
      <aside className="d-details" role="dialog" aria-modal="true" aria-label="Document details">
        <div className="d-details-head">
          <span className="lbl">Details</span>
          <button type="button" className="d-details-x" aria-label="Close" onClick={closeDetails}>
            <Icon svg={I.close} />
          </button>
        </div>
        <div className="d-details-body">
          <div className="d-hero" style={{ background: tintBg(m.cv, 16) }}>
            {isImage(doc) ? (
              <img src={doc.content_uri} alt="" />
            ) : (
              <span style={{ color: `var(${m.cv})` }}>{m.label}</span>
            )}
          </div>
          <div className="d-detail-name">{doc.title ?? 'Untitled'}</div>
          <div className="d-detail-ext">
            {extOf(doc)} · {fmtBytes(doc.byte_size)}
          </div>
          <div className="d-detail-actions">
            <button
              type="button"
              className="kit-btn d-detail-btn"
              onClick={() => openQuick(doc.content_id)}
            >
              Open
            </button>
            <a
              className="kit-btn d-detail-btn"
              href={doc.content_uri}
              download={doc.title ?? 'file'}
            >
              Download
            </a>
            {trashed ? null : (
              <button
                type="button"
                className="kit-btn d-detail-btn"
                onClick={() => toggleStar(doc)}
              >
                {doc.starred ? '★ Starred' : '☆ Star'}
              </button>
            )}
          </div>
          <div className="d-detail-label">Details</div>
          <dl className="d-detail-grid">
            <dt>Type</dt>
            <dd>{m.name}</dd>
            <dt>Size</dt>
            <dd>{fmtBytes(doc.byte_size)}</dd>
            <dt>{trashed ? 'Was in' : 'Folder'}</dt>
            <dd>{folderName(doc.folder_id)}</dd>
            <dt>{trashed ? 'Purges' : 'Added'}</dt>
            <dd>{trashed ? purgeCountdown(doc.purge_at) : fmtFull(doc.created_at)}</dd>
          </dl>
          <div className="d-detail-label">Activity</div>
          <div>
            {events.map((ev, i) => (
              <div className="d-activity-item" key={i}>
                <div className="d-activity-rail">
                  <span className="d-activity-dot"></span>
                  {i < events.length - 1 ? <span className="d-activity-line"></span> : null}
                </div>
                <div>
                  <div className="d-activity-text">{ev.text}</div>
                  <div className="d-activity-meta">
                    <span className="d-activity-date">{ev.date}</span>
                    <span className="d-receipt-chip">receipt</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="d-details-foot">
          {trashed ? (
            <button type="button" className="kit-btn d-detail-btn" onClick={() => restoreDoc(doc)}>
              Restore
            </button>
          ) : (
            <>
              <button
                type="button"
                className="kit-btn d-detail-btn"
                onClick={(e) => openMovePopover(e.currentTarget, [doc])}
              >
                Move
              </button>
              <button
                type="button"
                className="kit-btn d-detail-btn danger"
                onClick={(e) => {
                  if (!armConfirm(e.currentTarget, { armedLabel: 'Trash — sure?' })) return;
                  trashDoc(doc);
                }}
              >
                Trash
              </button>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

let detailsRootReact;

function renderDetails() {
  const doc = state.detailsId ? data.documents.find((d) => d.content_id === state.detailsId) : null;
  detailsRootReact.render(doc ? <Details doc={doc} /> : null);
}

function extOf(doc) {
  const t = String(doc.title ?? '');
  const dot = t.lastIndexOf('.');
  if (dot > 0 && dot < t.length - 1) return `.${t.slice(dot + 1).toLowerCase()}`;
  return typeMeta(doc.media_type).label.toLowerCase();
}

// ---------- Quick-look ----------

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

// The iframe (PDF) / img stage is load-bearing: content_uri is a same-origin
// vault blob URL or data: URI (CSP `default-src 'self'` — issue #296), and
// re-setting `src` reloads/rescrolls it. Under Lit this needed an explicit
// `lastQuickId` short-circuit to skip re-rendering entirely for an unrelated
// re-render of the SAME open doc. React's reconciler gives the same guarantee
// for free here: `renderQuick()` is called on every unrelated `render()` too,
// but as long as the doc is unchanged the new element tree has the same
// type/position/props at every node (including this `src` string, which is
// never regenerated — it's the same field straight off the doc), so React
// bails out of touching the real `<iframe>`/`<img>` DOM node at all. The
// `key={doc.content_id}` on the stage element is the belt-and-braces part:
// it forces a genuine remount (a real reload) exactly when the doc changes
// (prev/next), and never otherwise.
function QuickLook({ doc }) {
  const m = typeMeta(doc.media_type);
  const idx = visibleRows.findIndex((d) => d.content_id === doc.content_id);

  let stage;
  if (isImage(doc)) {
    stage = (
      <img
        key={doc.content_id}
        className="d-quick-image"
        src={doc.content_uri}
        alt={doc.title ?? 'Image'}
      />
    );
  } else if (String(doc.media_type ?? '') === 'application/pdf' && loadable(doc.content_uri)) {
    stage = (
      <iframe
        key={doc.content_id}
        className="d-quick-frame"
        src={doc.content_uri}
        title={doc.title ?? 'PDF'}
      />
    );
  } else {
    // A document-page mock for docs / sheets / slides / other.
    const widths = [96, 88, 93, 70, 90, 82, 60];
    stage = (
      <div className="d-quick-page" key={doc.content_id}>
        <i
          style={{
            height: '11px',
            width: '44%',
            background: `var(${m.cv})`,
            opacity: 0.85,
            marginBottom: '22px',
          }}
        ></i>
        {widths.map((w, i) => (
          <i
            key={i}
            style={{
              height: '7px',
              width: `${w}%`,
              background: i < 4 ? '#e6e7ea' : '#eceef1',
              marginBottom: `${i === 3 ? 26 : 11}px`,
            }}
          ></i>
        ))}
      </div>
    );
  }

  return (
    <div className="d-quick" role="dialog" aria-modal="true" aria-label="Quick look">
      <div className="d-quick-top">
        <span
          className="d-quick-badge"
          style={{ background: tintBg(m.cv, 20), color: `var(${m.cv})` }}
        >
          {m.label}
        </span>
        <span className="d-quick-title">{doc.title ?? 'Untitled'}</span>
        <a className="d-quick-btn" href={doc.content_uri} download={doc.title ?? 'file'}>
          <Icon svg={I.download} />
          Download
        </a>
        <button type="button" className="d-quick-btn icon" aria-label="Close" onClick={closeQuick}>
          <Icon svg={I.close} />
        </button>
      </div>
      <div className="d-quick-stage">
        <button
          type="button"
          className="d-quick-nav prev"
          aria-label="Previous"
          disabled={idx <= 0}
          onClick={() => quickStep(-1)}
        >
          <Icon svg={I.chevL} />
        </button>
        {stage}
        <button
          type="button"
          className="d-quick-nav next"
          aria-label="Next"
          disabled={idx < 0 || idx >= visibleRows.length - 1}
          onClick={() => quickStep(1)}
        >
          <Icon svg={I.chevR} />
        </button>
      </div>
      <div className="d-quick-foot">
        {folderName(doc.folder_id)} · {fmtBytes(doc.byte_size)} · added {fmtFull(doc.created_at)}
      </div>
    </div>
  );
}

let quickRootReact;

function renderQuick() {
  const doc = state.quickId ? data.documents.find((d) => d.content_id === state.quickId) : null;
  quickRootReact.render(doc ? <QuickLook doc={doc} /> : null);
}

// ---------- New menu ----------

function NewMenu() {
  return (
    <>
      <button
        type="button"
        className="d-menu-item"
        role="menuitem"
        onClick={() => {
          state.newMenuOpen = false;
          renderNewMenu();
          $('uploadInput').click();
        }}
      >
        <Icon svg={I.upload} />
        Upload files
      </button>
      <div className="d-menu-sep"></div>
      <button
        type="button"
        className="d-menu-item"
        role="menuitem"
        onClick={() => {
          state.newMenuOpen = false;
          state.creatingFolder = true;
          render();
        }}
      >
        <Icon svg={I.folderPlus} />
        New folder
      </button>
    </>
  );
}

let newMenuRoot;

function renderNewMenu() {
  const menu = $('newMenu');
  menu.hidden = !state.newMenuOpen;
  $('newBtn').setAttribute('aria-expanded', String(state.newMenuOpen));
  if (!state.newMenuOpen) {
    newMenuRoot.render(null);
    return;
  }
  newMenuRoot.render(<NewMenu />);
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
wireThemeToggle($('themeBtn'));
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

// One React root per dynamic container, created once — every subsequent
// state change re-renders into these same roots rather than recreating them.
smartNavRoot = createRoot($('smartNav'));
folderListRoot = createRoot($('folderList'));
storageRoot = createRoot($('storage'));
typeChipsRoot = createRoot($('typeChips'));
bulkBarRoot = createRoot($('bulkBar'));
gridRoot = createRoot($('grid'));
listRoot = createRoot($('list'));
listHeadRoot = createRoot($('listHead'));
windowFootRoot = createRoot($('windowFoot'));
detailsRootReact = createRoot($('detailsRoot'));
quickRootReact = createRoot($('quickRoot'));
newMenuRoot = createRoot($('newMenu'));

$('root').classList.toggle('is-narrow', $('root').clientWidth < 860);
state.narrow = $('root').clientWidth < 860;
showSkeleton($('list'), 6);
$('listWrap').hidden = false;
measure();
setInterval(measure, 250);
refresh();
