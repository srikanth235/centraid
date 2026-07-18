// governance: allow-repo-hygiene file-size-limit blueprints are single-file by design (read wholesale by one agent, see tally/app.tsx's waiver) — docs is the entry/orchestrator for browse, details, quick-look, in-place edit and version history, so it is large by design.
// Docs — the drive, reinvented, as a projection over the personal vault. A
// document is a core.document WRAPPER around a canonical core.content_item
// (issue #352): the document_id is the row's identity — selection, details,
// quick-look and folders/star all key off it — while current_content_id
// names the HEAD revision whose bytes render. Folders are SKOS concepts in
// the owner's folders scheme and filing is one tag per document. Trash sets
// a purge date ~30 days out and keeps the folder tag, so restore lands a
// document back where it was. Every write is a typed vault command —
// consent-checked and receipted, all risk low. The app stores nothing of its
// own: revoke the grant and this page goes dark while the documents, history
// and receipts remain the owner's.
//
// Starred is vault-canonical (issue #274): one flags-scheme tag on the
// document, written through core.star_document/unstar_document — the same
// star a favorited photo carries, so Starred here shows them too. Sharing
// still has no vault signal, so there is honestly no sharing UI.
//
// React port (native web-components infra, see kit/react-core.min.js): the
// static index.html body is unchanged, and this module owns one React root
// per dynamic container (created once at boot) plus the same external
// `state`/`data` objects and render orchestrator the Lit version used — every
// write still mutates `state`, then calls `render()`, which fans out to each
// root's `.render(...)` call. Popovers (kebab / move-to) stay plain DOM built
// with kit's `h()`/`popItem()`, exactly as before — no React root needed
// there. `emptyState()`/`showSkeleton()` remain the raw kit.js DOM helpers
// because `#empty` and the boot skeleton in `#list` were never Lit-rendered
// either; every OTHER container below was Lit-templated before and is
// React-templated now.
//
// TS + CSS-modules conversion: this entry file, the `logic.ts`/`nav.ts`/
// `chrome.ts` factories and every `components/*.tsx` are strict TS now; each
// component's JSX-only classes live in a co-located `*.module.css` while the
// static-shell remainder (the containers this file's roots mount into) stays
// global in `app.css`. Runtime is unchanged — the serve pipeline resolves the
// real `.ts`/`.tsx` files these `import` specifiers name.
//
// Split across modules: this file is the entry/orchestrator — state, vault
// IO, the render fan-out, `createRoot` calls, event wiring. `logic.ts`/
// `nav.ts` are plain factories that close over this file's own `state`/
// `data` (passed by reference, never reassigned) to hold the non-visual
// business logic and state transitions; `chrome.ts` wires the toolbar/
// keyboard/drag-drop listeners; `format.ts`/`icons.ts` are stateless.
// `components/` holds pure functions of props — none reach for `state`/
// `data` or import this module.
import { createRoot } from './react-core.min.js';
import {
  closePopover,
  debounce,
  emptyState,
  h,
  onDataChange,
  readFailed,
  showSkeleton,
} from './kit.js';
import { emptyStateFor } from './format.ts';
import { createLogic } from './logic.ts';
import { createNav } from './nav.ts';
import { wireChrome } from './chrome.ts';
import { BulkBar } from './components/BulkBar.tsx';
import { Details } from './components/Details.tsx';
import { Editor } from './components/Editor.tsx';
import { GridCard } from './components/Grid.tsx';
import { ListHead, ListRow, WindowFoot } from './components/List.tsx';
import { NewMenu } from './components/NewMenu.tsx';
import { QuickLook } from './components/QuickLook.tsx';
import { FolderList, SmartNav, Storage } from './components/Sidebar.tsx';
import { TagChips, TypeChips } from './components/Toolbar.tsx';
import type { ReactNode } from './react-core.min.js';
import type { AppData, AppState, DriveDoc, Folder } from './types.ts';

type ReactRoot = ReturnType<typeof createRoot>;

// The `drive`/`search` read projections this file consumes off window.centraid.
interface DriveResult {
  folders?: Folder[];
  documents?: DriveDoc[];
  root_folder_id?: string | null;
  truncated?: boolean;
  vaultDenied?: { message?: string } | null;
}
interface SearchResult {
  documents?: DriveDoc[];
}

const $ = (id: string) => document.getElementById(id)!;

// Vault entities this app's queries read — the doorbell filter re-derives
// only when a change names one of these (or names none, i.e. "this app acted").
const CHANGE_TABLES = [
  'core.document',
  'core.content_item',
  'core.tag',
  'core.concept',
  'core.concept_scheme',
  'core.link',
  'blob.custody_state',
  'consent.provenance',
];

// ---------- State ----------

const data: AppData = { folders: [], documents: [], root_folder_id: null };

const state: AppState = {
  view: document.documentElement.getAttribute('data-app-view') === 'list' ? 'list' : 'grid',
  nav: { kind: 'all' }, // all | recent | starred | folder(folderId) | trash
  sortKey: 'added', // added | name | size
  sortDir: -1,
  type: 'all', // all | pdf | image | doc | sheet
  tag: 'all', // 'all' | a free-form label (issue #352 phase 4)
  search: '',
  searchResults: null,
  searchSeq: 0,
  selected: new Set(),
  anchorIndex: null,
  detailsId: null,
  quickId: null,
  editingId: null,
  newMenuOpen: false,
  creatingFolder: false,
  renamingFolderId: null,
  narrow: false,
  uploading: false,
  visibleRows: [], // the row list as rendered — selection range + quick-look order
  driveWindow: 200,
  driveTruncated: false,
};

// `logic`/`nav` close over `state`/`data` by reference (mutated in place,
// never reassigned) plus the render entry points only this file defines.
// `nav` needs `logic.clearSelection` and `logic` needs `nav.openQuick`, so
// `nav`'s copy is a lazy wrapper — safe since neither is called until both
// exist.
let logic: ReturnType<typeof createLogic>;
const nav = createNav({
  state,
  render,
  refresh,
  renderDetails,
  renderQuick,
  renderNewMenu,
  renderEditor,
  clearSelection: () => logic.clearSelection(),
});
logic = createLogic({ state, data, render, refresh, openQuick: nav.openQuick });
const {
  notice,
  folderName,
  activeFiles,
  toggleSelect,
  toggleAllVisible,
  openMovePopover,
  openDocMenu,
  trashDoc,
  restoreDoc,
  toggleStar,
  createFolder,
  renameFolder,
  deleteFolder,
  startRenameFolder,
  cancelCreateFolder,
  cancelRenameFolder,
  restoreSelected,
  trashSelected,
  moveSelected,
  clearSelected,
  uploadFiles,
  editDocument,
  replaceDocument,
  restoreVersion,
  loadHistory,
  addTag,
  removeTag,
  loadActivity,
} = logic;
const {
  openDetails,
  closeDetails,
  openQuick,
  closeQuick,
  quickStep,
  openEditor,
  closeEditor,
  triggerUpload,
  startCreateFolder,
  selectType,
  selectTag,
  selectNav,
  showMoreDocs,
} = nav;

// ---------- Sidebar render ----------

let smartNavRoot: ReactRoot;
let folderListRoot: ReactRoot;
let storageRoot: ReactRoot;

function renderSidebar() {
  const active = activeFiles();
  const counts = {
    all: active.length,
    starred: active.filter((f) => f.starred).length,
    trash: logic.trashedFiles().length,
  };
  smartNavRoot.render(
    <SmartNav navKind={state.nav.kind} counts={counts} onSelectNav={selectNav} />,
  );
  folderListRoot.render(
    <FolderList
      folders={data.folders}
      activeDocs={active}
      navKind={state.nav.kind}
      navFolderId={state.nav.folderId}
      renamingFolderId={state.renamingFolderId}
      creatingFolder={state.creatingFolder}
      trashCount={counts.trash}
      onSelectNav={selectNav}
      onStartRename={startRenameFolder}
      onDeleteFolder={deleteFolder}
      onRenameCommit={renameFolder}
      onRenameCancel={cancelRenameFolder}
      onCreateCommit={createFolder}
      onCreateCancel={cancelCreateFolder}
    />,
  );
  storageRoot.render(<Storage docs={active} truncated={state.driveTruncated} />);
}

// ---------- Toolbar render ----------

let typeChipsRoot: ReactRoot;
let tagChipsRoot: ReactRoot;

function renderToolbar() {
  const rows = state.visibleRows;
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

  typeChipsRoot.render(<TypeChips type={state.type} onSelect={selectType} />);
  // Distinct labels across the WHOLE loaded drive (issue #352 phase 4) —
  // never scoped to the current folder/nav, mirroring the photos app's own
  // tag-chip derivation (Toolbar's renderChips).
  const tagOptions = [
    ...new Set(activeFiles().flatMap((f) => (f.tags ?? []).map((t) => t.label))),
  ].sort();
  tagChipsRoot.render(<TagChips tags={tagOptions} active={state.tag} onSelect={selectTag} />);

  const sortNames = { added: 'Date', name: 'Name', size: 'Size' };
  $('sortLabel').textContent = `${sortNames[state.sortKey]} ${state.sortDir === 1 ? '↑' : '↓'}`;

  $('viewGrid').setAttribute('aria-pressed', String(state.view === 'grid'));
  $('viewList').setAttribute('aria-pressed', String(state.view === 'list'));
}

// ---------- Bulk bar render ----------

let bulkBarRoot: ReactRoot;

// Stale content stays in place (hidden) when selection drops to zero — only
// the next non-empty selection re-populates it, matching the old behavior.
function renderBulk() {
  const bar = $('bulkBar');
  const n = state.selected.size;
  bar.hidden = n === 0;
  if (n === 0) return;
  const inTrash = state.nav.kind === 'trash' && !state.search.trim();
  bulkBarRoot.render(
    <BulkBar
      n={n}
      inTrash={inTrash}
      onRestore={restoreSelected}
      onMoveTo={moveSelected}
      onTrashSelected={trashSelected}
      onClear={clearSelected}
    />,
  );
}

// ---------- Rows: grid + list ----------

// `#grid`/`#list` are React-owned containers: `#list` starts holding the boot
// `showSkeleton()` markup. Unlike Lit, React's first `root.render()` DOES
// clear pre-existing children it never created (verified under jsdom), so
// the `mounted` guard below only makes the skeleton handoff explicit — it is
// not load-bearing. Clearing between views goes through `root.render(null)`,
// never a raw `replaceChildren()` after React owns the container.
function makeMounter(containerId: string, getRoot: () => ReactRoot) {
  let mounted = false;
  return (node: ReactNode) => {
    if (!mounted) {
      $(containerId).replaceChildren();
      mounted = true;
    }
    getRoot().render(node);
  };
}
let gridRoot: ReactRoot;
let listRoot: ReactRoot;
const mountGrid = makeMounter('grid', () => gridRoot);
const mountList = makeMounter('list', () => listRoot);

let listHeadRoot: ReactRoot;
let windowFootRoot: ReactRoot;

function renderRows() {
  const rows = state.visibleRows;
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
    const cfg = emptyStateFor(state, activeFiles().length > 0);
    const action = cfg.needsUpload
      ? h('button', { type: 'button', onclick: () => $('uploadInput').click() }, cfg.needsUpload)
      : undefined;
    emptyState(empty, { icon: cfg.icon, title: cfg.title, sub: cfg.sub, action });
    return;
  }

  if (state.view === 'grid') {
    grid.hidden = false;
    mountGrid(
      <>
        {rows.map((d, i) => (
          <GridCard
            key={d.document_id}
            doc={d}
            index={i}
            selectedIds={state.selected}
            onOpenDetails={openDetails}
            onOpenQuick={openQuick}
            onToggleSelect={toggleSelect}
          />
        ))}
      </>,
    );
  } else {
    listWrap.hidden = false;
    const trashed = state.nav.kind === 'trash' && !state.search.trim();
    listHead.hidden = state.narrow;
    if (!state.narrow)
      listHeadRoot.render(
        <ListHead rows={rows} selectedIds={state.selected} onToggleAll={toggleAllVisible} />,
      );
    mountList(
      <>
        {rows.map((d, i) => (
          <ListRow
            key={d.document_id}
            doc={d}
            index={i}
            selectedIds={state.selected}
            narrow={state.narrow}
            search={state.search}
            trashed={trashed}
            folderName={folderName}
            onOpenDetails={openDetails}
            onOpenQuick={openQuick}
            onToggleSelect={toggleSelect}
            onOpenMenu={openDocMenu}
            onRestore={restoreDoc}
          />
        ))}
      </>,
    );
  }

  if (state.driveTruncated && !state.search.trim() && state.nav.kind !== 'starred') {
    foot.hidden = false;
    windowFootRoot.render(<WindowFoot driveWindow={state.driveWindow} onShowMore={showMoreDocs} />);
  }
}

// ---------- Details drawer ----------

let detailsRootReact: ReactRoot;

function renderDetails() {
  const doc = state.detailsId
    ? data.documents.find((d) => d.document_id === state.detailsId)
    : null;
  detailsRootReact.render(
    doc ? (
      <Details
        doc={doc}
        folderName={folderName}
        onClose={closeDetails}
        onOpenQuick={openQuick}
        onToggleStar={toggleStar}
        onMove={openMovePopover}
        onTrash={trashDoc}
        onRestore={restoreDoc}
        onEdit={(d) => openEditor(d.document_id)}
        onReplace={replaceDocument}
        loadHistory={loadHistory}
        onRestoreVersion={restoreVersion}
        onAddTag={addTag}
        onRemoveTag={removeTag}
        loadActivity={loadActivity}
      />
    ) : null,
  );
}

// ---------- Quick-look ----------

let quickRootReact: ReactRoot;

function renderQuick() {
  const doc = state.quickId ? data.documents.find((d) => d.document_id === state.quickId) : null;
  quickRootReact.render(
    doc ? (
      <QuickLook
        doc={doc}
        rows={state.visibleRows}
        folderName={folderName}
        onClose={closeQuick}
        onStep={quickStep}
      />
    ) : null,
  );
}

// ---------- In-place text editor ----------

let editorRootReact: ReactRoot;
// The registerFlush idiom notes/components/Editor already established:
// Editor.tsx registers its own pending-save flush here so every path that
// closes the overlay (its own × button, a backdrop click, the global
// Escape handler in chrome.ts) awaits an in-flight/pending autosave first
// instead of racing it — the debounce timer alone would otherwise drop the
// last ~700ms of keystrokes on a fast Escape. Closing is also the one point
// that pays for a real refresh() — versions.ts's editDocument deliberately
// leaves content_id/content_uri stale across the debounced autosaves (issue
// #352: it cannot honestly guess whether the vault kept the new version
// inline or moved it behind the blob route), so this is what corrects Grid/
// Details/Quick Look once the user is actually done typing, not on every
// keystroke's save.
let flushEditor: (() => Promise<void>) | null = null;
async function closeEditorSafely() {
  if (flushEditor) await flushEditor();
  flushEditor = null;
  await refresh();
  closeEditor();
}

function renderEditor() {
  const doc = state.editingId
    ? data.documents.find((d) => d.document_id === state.editingId)
    : null;
  editorRootReact.render(
    doc ? (
      <Editor
        key={doc.document_id}
        doc={doc}
        registerFlush={(fn) => {
          flushEditor = fn;
        }}
        onClose={closeEditorSafely}
        onSave={editDocument}
      />
    ) : null,
  );
}

// ---------- New menu ----------

let newMenuRoot: ReactRoot;

function renderNewMenu() {
  const menu = $('newMenu');
  menu.hidden = !state.newMenuOpen;
  $('newBtn').setAttribute('aria-expanded', String(state.newMenuOpen));
  if (!state.newMenuOpen) {
    newMenuRoot.render(null);
    return;
  }
  newMenuRoot.render(<NewMenu onUpload={triggerUpload} onNewFolder={startCreateFolder} />);
}

// ---------- Master render ----------

function render() {
  // A folder can vanish under us (deleted elsewhere) — fall back to the top.
  if (state.nav.kind === 'folder' && !logic.folderById(state.nav.folderId))
    state.nav = { kind: 'all' };
  closePopover();
  state.visibleRows = logic.currentRows(); // one source of truth for toolbar counts + rows
  renderSidebar();
  renderNewMenu();
  renderToolbar();
  renderBulk();
  renderRows();
}

// ---------- Search ----------

const applySearch = debounce(async () => {
  const q = ($('searchInput') as HTMLInputElement).value.trim();
  if (q === state.search) return;
  state.search = q;
  logic.clearSelection();
  if (!q) {
    state.searchResults = null;
    render();
    return;
  }
  const seq = ++state.searchSeq;
  let rows: DriveDoc[] = [];
  try {
    const res = await window.centraid.read<SearchResult>({ query: 'search', input: { term: q } });
    rows = res?.documents ?? [];
  } catch {
    rows = [];
  }
  if (seq !== state.searchSeq) return;
  state.searchResults = rows;
  render();
}, 150);

// ---------- Refresh ----------

let readFailedShowing = false;

async function refresh() {
  let next: DriveResult;
  try {
    next = await window.centraid.read<DriveResult>({
      query: 'drive',
      input: { limit: state.driveWindow },
    });
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
  // Mutate `data` in place (never reassign the binding) — `logic.ts` closed
  // over this exact object at boot.
  const incoming = next ?? data;
  data.folders = incoming.folders ?? [];
  data.documents = incoming.documents ?? [];
  data.root_folder_id = incoming.root_folder_id ?? data.root_folder_id;
  state.driveTruncated = Boolean(next?.truncated);
  // Drop selections and open surfaces for documents that no longer exist.
  state.selected = new Set(
    [...state.selected].filter((id) => data.documents.some((d) => d.document_id === id)),
  );
  if (state.detailsId && !data.documents.some((d) => d.document_id === state.detailsId))
    state.detailsId = null;
  if (state.quickId && !data.documents.some((d) => d.document_id === state.quickId))
    state.quickId = null;
  // The editor overlay is deliberately left untouched by a background
  // refresh (no renderEditor() call here) — it manages its own body state
  // after its initial fetch, and a periodic window-focus refresh closing it
  // out from under a typing user would drop their draft. It only ever
  // closes through its own explicit close/Escape path.
  render();
  renderDetails();
  renderQuick();
}

// ---------- Boot ----------

// One React root per dynamic container, created once and reused for every
// subsequent render.
smartNavRoot = createRoot($('smartNav'));
folderListRoot = createRoot($('folderList'));
storageRoot = createRoot($('storage'));
typeChipsRoot = createRoot($('typeChips'));
tagChipsRoot = createRoot($('tagChips'));
bulkBarRoot = createRoot($('bulkBar'));
gridRoot = createRoot($('grid'));
listRoot = createRoot($('list'));
listHeadRoot = createRoot($('listHead'));
windowFootRoot = createRoot($('windowFoot'));
detailsRootReact = createRoot($('detailsRoot'));
quickRootReact = createRoot($('quickRoot'));
editorRootReact = createRoot($('editorRoot'));
newMenuRoot = createRoot($('newMenu'));

$('root').classList.toggle('is-narrow', $('root').clientWidth < 860);
state.narrow = $('root').clientWidth < 860;
showSkeleton($('list'), 6);
$('listWrap').hidden = false;
wireChrome({
  state,
  render,
  refresh,
  renderRows,
  renderNewMenu,
  closeQuick,
  closeDetails,
  closeEditor: closeEditorSafely,
  quickStep,
  applySearch,
  uploadFiles,
  folderName,
});

// Reactive data: a write elsewhere (chat agent, a second window) fires the
// doorbell — re-derive. Debounced + tables-filtered by the kit helper.
onDataChange(CHANGE_TABLES, refresh);

refresh();
