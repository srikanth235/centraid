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

import {
  armConfirm,
  closePopover,
  debounce,
  el,
  emptyState,
  fmtBytes as fmtBytesBase,
  h,
  openPopover,
  outcomeMessage,
  popItem,
  readFailed,
  runBulk as runBulkBase,
  showSkeleton,
  snippetInto,
  stageFileBytes,
  toast,
  wireThemeToggle,
} from './kit.js';
// `h`/`el` stay imported: `h` builds the two action buttons handed to kit's
// `emptyState()` (a real-DOM-node contract, not a template context) and `el`
// parses this file's trusted static icon-SVG strings into nodes interpolated
// straight into Lit templates — both are the "imperative island" / "one
// literal" carve-outs the refactor brief sanctions, not reimplementations.
import { html, nothing, ref, render as litRender, repeat } from './lit-core.min.js';

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
// Lit templates below interpolate it as-is — the target list mixes a fixed
// depth-0 root with depth-1 folders, exactly as the vanilla builder did.
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
    litRender(
      html`
        <p class="kit-popover-head">
          ${single ? `Move “${single.title ?? 'document'}” to` : `Move ${docs.length} to`}
        </p>
        <div class="kit-popover-scroll">
          ${moveTargetBtn(null, 'Documents', 0, ids, single)}
          ${data.folders.map((f) => moveTargetBtn(f.folder_id, f.name, 1, ids, single))}
        </div>
      `,
      box,
    );
  });
}

function openDocMenu(anchor, doc) {
  closePopover();
  openPopover(anchor, (box) => {
    litRender(
      html`
        ${popItem('Open', () => {
          closePopover();
          openQuick(doc.content_id);
        })}
        <a
          class="kit-popover-item"
          role="menuitem"
          href=${doc.content_uri}
          download=${doc.title ?? 'file'}
          @click=${closePopover}
          >Download</a
        >
        ${popItem('Rename', () => {
          closePopover();
          startRenameDoc(doc);
        })}
        ${popItem(doc.starred ? 'Remove star' : 'Star', () => {
          closePopover();
          toggleStar(doc);
        })}
        ${popItem('Move to…', () => openMovePopover(anchor, [doc]))}
        <div class="kit-popover-sep"></div>
        ${popItem(
          'Trash',
          async (e) => {
            const btn = e.currentTarget;
            if (!armConfirm(btn, { armedLabel: 'Trash — sure?' })) return;
            closePopover();
            await trashDoc(doc);
          },
          { danger: true },
        )}
      `,
      box,
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

// ---------- Sidebar render ----------

function navItemTpl({ icon, label, active, count, onClick }) {
  return html`<button
    type="button"
    class="d-nav-item"
    aria-current=${String(!!active)}
    @click=${onClick}
  >
    ${el(icon)}
    <span>${label}</span>
    ${count != null ? html`<span class="d-nav-count">${count}</span>` : nothing}
  </button>`;
}

function smartNavTpl(counts) {
  return html`
    ${navItemTpl({
      icon: I.allDocs,
      label: 'All documents',
      active: state.nav.kind === 'all',
      count: counts.all,
      onClick: () => selectNav({ kind: 'all' }),
    })}
    ${navItemTpl({
      icon: I.clock,
      label: 'Recent',
      active: state.nav.kind === 'recent',
      onClick: () => selectNav({ kind: 'recent' }),
    })}
    ${navItemTpl({
      icon: I.star,
      label: 'Starred',
      active: state.nav.kind === 'starred',
      count: counts.starred,
      onClick: () => selectNav({ kind: 'starred' }),
    })}
  `;
}

// The new-folder editor row: a plain closure var (not createRef) captures the
// input node from the `ref()` callback, which runs synchronously during
// commit — well before `commit()` can be invoked by a later click/keydown.
function folderCreateEditTpl() {
  let inputEl;
  const commit = () => {
    const name = inputEl.value.trim();
    if (name) createFolder(name);
    else {
      state.creatingFolder = false;
      render();
    }
  };
  return html`<div class="d-folder-edit">
    <input
      type="text"
      placeholder="Folder name…"
      aria-label="New folder name"
      ${ref((node) => {
        inputEl = node;
        node?.focus();
      })}
      @keydown=${(e) => {
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
    <button type="button" @click=${commit}>Create</button>
  </div>`;
}

function folderRenameEditTpl(f) {
  let inputEl;
  const commit = () => {
    const name = inputEl.value.trim();
    if (name && name !== f.name) renameFolder(f.folder_id, name);
    else {
      state.renamingFolderId = null;
      render();
    }
  };
  return html`<div class="d-folder-edit">
    <input
      type="text"
      aria-label="Folder name"
      .value=${f.name}
      ${ref((node) => {
        inputEl = node;
        if (node) {
          node.focus();
          node.select();
        }
      })}
      @keydown=${(e) => {
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
    <button type="button" @click=${commit}>Save</button>
  </div>`;
}

function folderRowTpl(f) {
  if (state.renamingFolderId === f.folder_id) return folderRenameEditTpl(f);
  const count = activeFiles().filter((d) => (d.folder_id ?? null) === f.folder_id).length;
  const active = state.nav.kind === 'folder' && state.nav.folderId === f.folder_id;
  return html`<div class="d-folder">
    ${navItemTpl({
      icon: I.folder,
      label: f.name,
      active,
      count: count || '',
      onClick: () => selectNav({ kind: 'folder', folderId: f.folder_id }),
    })}
    <span class="d-folder-tools">
      <button
        type="button"
        class="d-tool-btn"
        aria-label="Rename ${f.name}"
        @click=${(e) => {
          e.stopPropagation();
          state.renamingFolderId = f.folder_id;
          render();
        }}
      >
        ${el(RENAME_ICON)}
      </button>
      <button
        type="button"
        class="d-tool-btn danger"
        aria-label="Delete ${f.name}"
        @click=${(e) => {
          e.stopPropagation();
          if (!armConfirm(e.currentTarget, { armedLabel: '×?' })) return;
          deleteFolder(f);
        }}
      >
        ${el(DELETE_ICON)}
      </button>
    </span>
  </div>`;
}

function folderListTpl(counts) {
  return html`
    ${state.creatingFolder ? folderCreateEditTpl() : nothing}
    ${repeat(
      data.folders,
      (f) => f.folder_id,
      (f) => folderRowTpl(f),
    )}
    ${navItemTpl({
      icon: I.trash,
      label: 'Trash',
      active: state.nav.kind === 'trash',
      count: counts.trash || '',
      onClick: () => selectNav({ kind: 'trash' }),
    })}
  `;
}

// Storage → an honest footprint of what the drive is holding right now. The
// vault gives no account-wide total, so we report real bytes + count over the
// loaded window instead of a fabricated "used / total".
function storageTpl() {
  const files = activeFiles();
  const bytes = files.reduce((s, f) => s + (f.byte_size ?? 0), 0);
  return html`
    <div class="d-storage-top">
      <span class="lbl">Footprint</span>
      <span class="val">${files.length}</span>
    </div>
    <div class="d-storage-label">
      ${fmtBytes(bytes)} across ${files.length}
      document${files.length === 1 ? '' : 's'}${driveTruncated ? ' — newest in view' : ''}
    </div>
  `;
}

function renderSidebar() {
  const counts = {
    all: activeFiles().length,
    starred: activeFiles().filter((f) => f.starred).length,
    trash: trashedFiles().length,
  };
  litRender(smartNavTpl(counts), $('smartNav'));
  litRender(folderListTpl(counts), $('folderList'));
  litRender(storageTpl(), $('storage'));
}

// ---------- Toolbar render ----------

const TYPE_CHIPS = [
  ['all', 'All'],
  ['pdf', 'PDFs'],
  ['image', 'Images'],
  ['doc', 'Docs'],
  ['sheet', 'Sheets'],
];

function typeChipsTpl() {
  return html`${TYPE_CHIPS.map(
    ([key, label]) => html`<button
      type="button"
      class="kit-chip quiet"
      aria-pressed=${String(state.type === key)}
      @click=${() => {
        state.type = key;
        clearSelection();
        render();
      }}
    >
      ${label}
    </button>`,
  )}`;
}

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

  litRender(typeChipsTpl(), $('typeChips'));

  const sortNames = { added: 'Date', name: 'Name', size: 'Size' };
  $('sortLabel').textContent = `${sortNames[state.sortKey]} ${state.sortDir === 1 ? '↑' : '↓'}`;

  $('viewGrid').setAttribute('aria-pressed', String(state.view === 'grid'));
  $('viewList').setAttribute('aria-pressed', String(state.view === 'list'));
}

// ---------- Bulk bar ----------

function bulkBarTpl(n) {
  const inTrash = state.nav.kind === 'trash' && !state.search.trim();
  return html`
    <span class="d-bulk-count">${n} selected</span>
    <div class="d-bulk-actions">
      ${inTrash
        ? html`<button
            type="button"
            class="kit-btn"
            @click=${() =>
              runBulk([...state.selected], (id) => act('restore', { content_id: id }), {
                progress: 'Restoring',
                done: 'Restored',
              })}
          >
            Restore
          </button>`
        : html`<button
              type="button"
              class="kit-btn"
              @click=${(e) => openMovePopover(e.currentTarget, selectedDocs())}
            >
              Move to…
            </button>
            <button
              type="button"
              class="kit-btn danger"
              @click=${(e) => {
                if (!armConfirm(e.currentTarget, { armedLabel: `Trash ${n} — sure?` })) return;
                runBulk([...state.selected], (id) => act('trash', { content_id: id }), {
                  progress: 'Trashing',
                  done: 'Trashed',
                });
              }}
            >
              Trash
            </button>`}
      <button
        type="button"
        class="kit-btn"
        @click=${() => {
          clearSelection();
          render();
        }}
      >
        Clear
      </button>
    </div>
  `;
}

// The bar's stale content is left in place (hidden) when the selection drops
// to zero, matching the old builder's behavior of never clearing it — only
// the next non-empty selection re-populates it.
function renderBulk() {
  const bar = $('bulkBar');
  const n = state.selected.size;
  bar.hidden = n === 0;
  if (n === 0) return;
  litRender(bulkBarTpl(n), bar);
}

// ---------- Rows: grid + list ----------

function checkboxTpl(cls, selected, onClick, label) {
  return html`<button
    type="button"
    class=${cls}
    aria-pressed=${String(selected)}
    aria-label=${label}
    @click=${onClick}
  >
    ${selected ? el(I.check) : nothing}
  </button>`;
}

function gridCardTpl(doc, index) {
  const m = typeMeta(doc.media_type);
  const selected = state.selected.has(doc.content_id);
  return html`<div
    class="d-card"
    data-selected=${String(selected)}
    @click=${(e) => {
      if (e.target.closest('button, a')) return;
      openDetails(doc.content_id);
    }}
  >
    <div
      class="d-thumb"
      style="background:${tintBg(m.cv, 15)};"
      @click=${(e) => {
        e.stopPropagation();
        openQuick(doc.content_id);
      }}
    >
      ${isImage(doc)
        ? html`<img src=${doc.content_uri} alt="" loading="lazy" />`
        : html`<span class="d-thumb-label" style="color:var(${m.cv});">${m.label}</span>
            <div class="d-thumb-lines">
              <i style="width:70%;background:var(${m.cv});opacity:.18;"></i>
              <i style="width:90%;background:var(${m.cv});opacity:.14;"></i>
              <i style="width:55%;background:var(${m.cv});opacity:.14;"></i>
            </div>`}
    </div>
    ${checkboxTpl(
      'd-card-select',
      selected,
      (e) => {
        e.stopPropagation();
        toggleSelect(doc.content_id, index, e.shiftKey);
      },
      `Select ${doc.title ?? 'document'}`,
    )}
    <div class="d-card-body">
      <div class="d-card-title">
        ${doc.title ?? 'Untitled'}${doc.starred
          ? html`<span class="d-star-ind" aria-label="Starred">★</span>`
          : nothing}
      </div>
      <div class="d-card-meta">${fmtBytes(doc.byte_size)} · ${fmtDate(doc.created_at)}</div>
    </div>
  </div>`;
}

function listRowTpl(doc, index) {
  const m = typeMeta(doc.media_type);
  const selected = state.selected.has(doc.content_id);
  const trashed = state.nav.kind === 'trash' && !state.search.trim();
  return html`<div
    class="d-row"
    data-selected=${String(selected)}
    @click=${(e) => {
      if (e.target.closest('button, a, input')) return;
      openDetails(doc.content_id);
    }}
  >
    ${checkboxTpl(
      'd-check',
      selected,
      (e) => {
        e.stopPropagation();
        toggleSelect(doc.content_id, index, e.shiftKey);
      },
      `Select ${doc.title ?? 'document'}`,
    )}
    <button
      type="button"
      class="d-badge"
      style="background:${tintBg(m.cv, 16)};"
      aria-label="Preview ${doc.title ?? 'document'}"
      @click=${(e) => {
        e.stopPropagation();
        openQuick(doc.content_id);
      }}
    >
      ${isImage(doc)
        ? html`<img src=${doc.content_uri} alt="" loading="lazy" />`
        : html`<span style="color:var(${m.cv});">${m.label}</span>`}
    </button>
    <div class="d-row-main">
      <button
        type="button"
        class="d-row-title"
        @click=${(e) => {
          e.stopPropagation();
          openQuick(doc.content_id);
        }}
      >
        ${doc.title ?? 'Untitled'}${doc.starred
          ? html`<span class="d-star-ind" aria-label="Starred">★</span>`
          : nothing}
      </button>
      ${state.search.trim() && doc.snippet
        ? html`<div
            class="d-snippet"
            ${ref((node) => {
              if (!node) return;
              node.replaceChildren();
              snippetInto(node, doc.snippet);
            })}
          ></div>`
        : nothing}
      ${state.narrow
        ? html`<div class="d-row-meta">
            ${trashed
              ? `from ${folderName(doc.folder_id)} · ${purgeCountdown(doc.purge_at)}`
              : state.search.trim()
                ? `in ${folderName(doc.folder_id)}`
                : `${fmtBytes(doc.byte_size)} · ${fmtDate(doc.created_at)}`}
          </div>`
        : nothing}
    </div>
    <span class="d-cell where"
      >${trashed ? `from ${folderName(doc.folder_id)}` : folderName(doc.folder_id)}</span
    >
    <span class="d-cell size">${fmtBytes(doc.byte_size)}</span>
    <span class="d-cell added${trashed ? ' purge' : ''}"
      >${trashed ? purgeCountdown(doc.purge_at) : fmtDate(doc.created_at)}</span
    >
    <div class="d-row-end">
      ${trashed
        ? html`<button
            type="button"
            class="kit-btn"
            @click=${(e) => {
              e.stopPropagation();
              restoreDoc(doc);
            }}
          >
            Restore
          </button>`
        : html`<button
            type="button"
            class="d-kebab"
            aria-label="Actions for ${doc.title ?? 'document'}"
            aria-haspopup="menu"
            @click=${(e) => {
              e.stopPropagation();
              openDocMenu(e.currentTarget, doc);
            }}
          >
            ${el(I.dots)}
          </button>`}
    </div>
  </div>`;
}

// `#grid`/`#list` are Lit-owned containers: `#list` starts holding the boot
// `showSkeleton()` markup, so its very first commit must clear that non-Lit
// content itself (`mounted` guard below); every commit after goes through
// `litRender` alone. `#grid` never carries pre-Lit content but shares the same
// guard for symmetry. Clearing between views goes through `render(nothing, …)`
// — never a raw `replaceChildren()` — per the kit's Lit conventions.
let gridMounted = false;
function mountGrid(tpl) {
  const grid = $('grid');
  if (!gridMounted) {
    grid.replaceChildren();
    gridMounted = true;
  }
  litRender(tpl, grid);
}
let listMounted = false;
function mountList(tpl) {
  const list = $('list');
  if (!listMounted) {
    list.replaceChildren();
    listMounted = true;
  }
  litRender(tpl, list);
}

function listHeadTpl(rows) {
  const allSel = rows.length > 0 && rows.every((d) => state.selected.has(d.content_id));
  return html`
    ${checkboxTpl(
      'd-check',
      allSel,
      () => {
        if (allSel) for (const d of rows) state.selected.delete(d.content_id);
        else for (const d of rows) state.selected.add(d.content_id);
        state.anchorIndex = null;
        render();
      },
      allSel ? 'Deselect all' : 'Select all',
    )}
    <span style="width:34px;"></span>
    <span class="d-col name">Name</span>
    <span class="d-col where">Where</span>
    <span class="d-col size">Size</span>
    <span class="d-col added">Added</span>
    <span class="d-col end"></span>
  `;
}

function windowFootTpl() {
  return html`<span
      >Showing your latest ${driveWindow} documents — older ones are a search away.</span
    >
    <button
      type="button"
      class="kit-btn"
      @click=${async (e) => {
        driveWindow += 200;
        e.currentTarget.disabled = true;
        await refresh();
      }}
    >
      Show more
    </button>`;
}

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
  mountGrid(nothing);
  mountList(nothing);

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
      html`${repeat(
        rows,
        (d) => d.content_id,
        (d, i) => gridCardTpl(d, i),
      )}`,
    );
  } else {
    listWrap.hidden = false;
    listHead.hidden = state.narrow;
    if (!state.narrow) litRender(listHeadTpl(rows), listHead);
    mountList(
      html`${repeat(
        rows,
        (d) => d.content_id,
        (d, i) => listRowTpl(d, i),
      )}`,
    );
  }

  if (driveTruncated && !state.search.trim() && state.nav.kind !== 'starred') {
    foot.hidden = false;
    litRender(windowFootTpl(), foot);
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

function detailsTpl(doc) {
  const m = typeMeta(doc.media_type);
  const trashed = doc.trashed;

  // Activity — only what the projection can honestly derive: this document was
  // uploaded (created_at) and filed into its folder. Each is a real receipted
  // vault write, so it wears a receipt chip.
  const events = [];
  if (doc.folder_id != null)
    events.push({ text: `Filed in ${folderName(doc.folder_id)}`, date: fmtFull(doc.created_at) });
  events.push({ text: 'Uploaded to your vault', date: fmtFull(doc.created_at) });

  return html`
    <div class="d-details-backdrop" @click=${closeDetails}></div>
    <aside class="d-details" role="dialog" aria-modal="true" aria-label="Document details">
      <div class="d-details-head">
        <span class="lbl">Details</span>
        <button type="button" class="d-details-x" aria-label="Close" @click=${closeDetails}>
          ${el(I.close)}
        </button>
      </div>
      <div class="d-details-body">
        <div class="d-hero" style="background:${tintBg(m.cv, 16)};">
          ${isImage(doc)
            ? html`<img src=${doc.content_uri} alt="" />`
            : html`<span style="color:var(${m.cv});">${m.label}</span>`}
        </div>
        <div class="d-detail-name">${doc.title ?? 'Untitled'}</div>
        <div class="d-detail-ext">${extOf(doc)} · ${fmtBytes(doc.byte_size)}</div>
        <div class="d-detail-actions">
          <button
            type="button"
            class="kit-btn d-detail-btn"
            @click=${() => openQuick(doc.content_id)}
          >
            Open
          </button>
          <a class="kit-btn d-detail-btn" href=${doc.content_uri} download=${doc.title ?? 'file'}
            >Download</a
          >
          ${trashed
            ? nothing
            : html`<button
                type="button"
                class="kit-btn d-detail-btn"
                @click=${() => toggleStar(doc)}
              >
                ${doc.starred ? '★ Starred' : '☆ Star'}
              </button>`}
        </div>
        <div class="d-detail-label">Details</div>
        <dl class="d-detail-grid">
          <dt>Type</dt>
          <dd>${m.name}</dd>
          <dt>Size</dt>
          <dd>${fmtBytes(doc.byte_size)}</dd>
          <dt>${trashed ? 'Was in' : 'Folder'}</dt>
          <dd>${folderName(doc.folder_id)}</dd>
          <dt>${trashed ? 'Purges' : 'Added'}</dt>
          <dd>${trashed ? purgeCountdown(doc.purge_at) : fmtFull(doc.created_at)}</dd>
        </dl>
        <div class="d-detail-label">Activity</div>
        <div>
          ${events.map(
            (ev, i) => html`<div class="d-activity-item">
              <div class="d-activity-rail">
                <span class="d-activity-dot"></span>
                ${i < events.length - 1 ? html`<span class="d-activity-line"></span>` : nothing}
              </div>
              <div>
                <div class="d-activity-text">${ev.text}</div>
                <div class="d-activity-meta">
                  <span class="d-activity-date">${ev.date}</span>
                  <span class="d-receipt-chip">receipt</span>
                </div>
              </div>
            </div>`,
          )}
        </div>
      </div>
      <div class="d-details-foot">
        ${trashed
          ? html`<button type="button" class="kit-btn d-detail-btn" @click=${() => restoreDoc(doc)}>
              Restore
            </button>`
          : html`<button
                type="button"
                class="kit-btn d-detail-btn"
                @click=${(e) => openMovePopover(e.currentTarget, [doc])}
              >
                Move
              </button>
              <button
                type="button"
                class="kit-btn d-detail-btn danger"
                @click=${(e) => {
                  if (!armConfirm(e.currentTarget, { armedLabel: 'Trash — sure?' })) return;
                  trashDoc(doc);
                }}
              >
                Trash
              </button>`}
      </div>
    </aside>
  `;
}

function renderDetails() {
  const root = $('detailsRoot');
  const doc = state.detailsId ? data.documents.find((d) => d.content_id === state.detailsId) : null;
  litRender(doc ? detailsTpl(doc) : nothing, root);
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

// The iframe (PDF) / img stage is load-bearing: content_uri is a same-origin
// vault blob URL or data: URI (CSP `default-src 'self'` — issue #296), and
// re-setting `src` reloads/rescrolls it. The `lastQuickId` short-circuit below
// keeps the exact old semantics (skip the render call entirely for an
// unrelated re-render of the SAME open doc) rather than leaning on Lit's
// value-diffing to avoid the reload, since that's the one guarantee this
// overlay cannot regress on.
function quickTpl(doc) {
  const m = typeMeta(doc.media_type);
  const idx = visibleRows.findIndex((d) => d.content_id === doc.content_id);

  let stage;
  if (isImage(doc)) {
    stage = html`<img class="d-quick-image" src=${doc.content_uri} alt=${doc.title ?? 'Image'} />`;
  } else if (String(doc.media_type ?? '') === 'application/pdf' && loadable(doc.content_uri)) {
    stage = html`<iframe
      class="d-quick-frame"
      src=${doc.content_uri}
      title=${doc.title ?? 'PDF'}
    ></iframe>`;
  } else {
    // A document-page mock for docs / sheets / slides / other.
    const widths = [96, 88, 93, 70, 90, 82, 60];
    stage = html`<div class="d-quick-page">
      <i style="height:11px;width:44%;background:var(${m.cv});opacity:.85;margin-bottom:22px;"></i>
      ${widths.map(
        (w, i) =>
          html`<i
            style="height:7px;width:${w}%;background:${i < 4
              ? '#e6e7ea'
              : '#eceef1'};margin-bottom:${i === 3 ? 26 : 11}px;"
          ></i>`,
      )}
    </div>`;
  }

  return html`<div class="d-quick" role="dialog" aria-modal="true" aria-label="Quick look">
    <div class="d-quick-top">
      <span class="d-quick-badge" style="background:${tintBg(m.cv, 20)};color:var(${m.cv});"
        >${m.label}</span
      >
      <span class="d-quick-title">${doc.title ?? 'Untitled'}</span>
      <a class="d-quick-btn" href=${doc.content_uri} download=${doc.title ?? 'file'}
        >${el(I.download)}Download</a
      >
      <button type="button" class="d-quick-btn icon" aria-label="Close" @click=${closeQuick}>
        ${el(I.close)}
      </button>
    </div>
    <div class="d-quick-stage">
      <button
        type="button"
        class="d-quick-nav prev"
        aria-label="Previous"
        ?disabled=${idx <= 0}
        @click=${() => quickStep(-1)}
      >
        ${el(I.chevL)}
      </button>
      ${stage}
      <button
        type="button"
        class="d-quick-nav next"
        aria-label="Next"
        ?disabled=${idx < 0 || idx >= visibleRows.length - 1}
        @click=${() => quickStep(1)}
      >
        ${el(I.chevR)}
      </button>
    </div>
    <div class="d-quick-foot">
      ${folderName(doc.folder_id)} · ${fmtBytes(doc.byte_size)} · added ${fmtFull(doc.created_at)}
    </div>
  </div>`;
}

function renderQuick() {
  const root = $('quickRoot');
  const doc = state.quickId ? data.documents.find((d) => d.content_id === state.quickId) : null;
  if (!doc) {
    litRender(nothing, root);
    lastQuickId = null;
    return;
  }
  if (doc.content_id === lastQuickId && root.firstElementChild) return; // avoid reloading an open iframe on unrelated renders
  lastQuickId = doc.content_id;
  litRender(quickTpl(doc), root);
}

// ---------- New menu ----------

function newMenuTpl() {
  return html`
    <button
      type="button"
      class="d-menu-item"
      role="menuitem"
      @click=${() => {
        state.newMenuOpen = false;
        renderNewMenu();
        $('uploadInput').click();
      }}
    >
      ${el(I.upload)}Upload files
    </button>
    <div class="d-menu-sep"></div>
    <button
      type="button"
      class="d-menu-item"
      role="menuitem"
      @click=${() => {
        state.newMenuOpen = false;
        state.creatingFolder = true;
        render();
      }}
    >
      ${el(I.folderPlus)}New folder
    </button>
  `;
}

function renderNewMenu() {
  const menu = $('newMenu');
  menu.hidden = !state.newMenuOpen;
  $('newBtn').setAttribute('aria-expanded', String(state.newMenuOpen));
  if (!state.newMenuOpen) {
    litRender(nothing, menu);
    return;
  }
  litRender(newMenuTpl(), menu);
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

$('root').classList.toggle('is-narrow', $('root').clientWidth < 860);
state.narrow = $('root').clientWidth < 860;
showSkeleton($('list'), 6);
$('listWrap').hidden = false;
measure();
setInterval(measure, 250);
refresh();
