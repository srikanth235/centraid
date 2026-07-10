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
// Sharing still has no vault signal, so there is honestly no sharing UI.
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
// Split across modules: this file is the entry/orchestrator — state, vault
// IO, the render fan-out, `createRoot` calls, event wiring. `logic.js`/
// `nav.js` are plain factories that close over this file's own `state`/
// `data` (passed by reference, never reassigned) to hold the non-visual
// business logic and state transitions; `chrome.js` wires the toolbar/
// keyboard/drag-drop listeners; `format.js`/`icons.js` are stateless.
// `components/` holds pure functions of props — none reach for `state`/
// `data` or import this module.
import { createRoot } from './react-core.min.js';
import { closePopover, debounce, emptyState, h, readFailed, showSkeleton } from './kit.js';
import { emptyStateFor } from './format.js';
import { createLogic } from './logic.js';
import { createNav } from './nav.js';
import { wireChrome } from './chrome.js';
import { BulkBar } from './components/BulkBar.jsx';
import { Details } from './components/Details.jsx';
import { GridCard } from './components/Grid.jsx';
import { ListHead, ListRow, WindowFoot } from './components/List.jsx';
import { NewMenu } from './components/NewMenu.jsx';
import { QuickLook } from './components/QuickLook.jsx';
import { FolderList, SmartNav, Storage } from './components/Sidebar.jsx';
import { TypeChips } from './components/Toolbar.jsx';

const $ = (id) => document.getElementById(id);

// ---------- State ----------

const data = { folders: [], documents: [], root_folder_id: null };

const state = {
  view: document.documentElement.getAttribute('data-app-view') === 'list' ? 'list' : 'grid',
  nav: { kind: 'all' }, // all | recent | starred | folder(folderId) | trash
  sortKey: 'added', // added | name | size
  sortDir: -1,
  type: 'all', // all | pdf | image | doc | sheet
  search: '',
  searchResults: null,
  searchSeq: 0,
  selected: new Set(),
  anchorIndex: null,
  detailsId: null,
  quickId: null,
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
let logic;
const nav = createNav({
  state,
  render,
  refresh,
  renderDetails,
  renderQuick,
  renderNewMenu,
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
} = logic;
const {
  openDetails,
  closeDetails,
  openQuick,
  closeQuick,
  quickStep,
  triggerUpload,
  startCreateFolder,
  selectType,
  selectNav,
  showMoreDocs,
} = nav;

// ---------- Sidebar render ----------

let smartNavRoot;
let folderListRoot;
let storageRoot;

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

let typeChipsRoot;

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

  const sortNames = { added: 'Date', name: 'Name', size: 'Size' };
  $('sortLabel').textContent = `${sortNames[state.sortKey]} ${state.sortDir === 1 ? '↑' : '↓'}`;

  $('viewGrid').setAttribute('aria-pressed', String(state.view === 'grid'));
  $('viewList').setAttribute('aria-pressed', String(state.view === 'list'));
}

// ---------- Bulk bar render ----------

let bulkBarRoot;

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
function makeMounter(containerId, getRoot) {
  let mounted = false;
  return (node) => {
    if (!mounted) {
      $(containerId).replaceChildren();
      mounted = true;
    }
    getRoot().render(node);
  };
}
let gridRoot;
let listRoot;
const mountGrid = makeMounter('grid', () => gridRoot);
const mountList = makeMounter('list', () => listRoot);

let listHeadRoot;
let windowFootRoot;

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
            key={d.content_id}
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
            key={d.content_id}
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

let detailsRootReact;

function renderDetails() {
  const doc = state.detailsId ? data.documents.find((d) => d.content_id === state.detailsId) : null;
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
      />
    ) : null,
  );
}

// ---------- Quick-look ----------

let quickRootReact;

function renderQuick() {
  const doc = state.quickId ? data.documents.find((d) => d.content_id === state.quickId) : null;
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

// ---------- New menu ----------

let newMenuRoot;

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
  const q = $('searchInput').value.trim();
  if (q === state.search) return;
  state.search = q;
  logic.clearSelection();
  if (!q) {
    state.searchResults = null;
    render();
    return;
  }
  const seq = ++state.searchSeq;
  let rows = [];
  try {
    const res = await window.centraid.read({ query: 'search', input: { term: q } });
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
  let next;
  try {
    next = await window.centraid.read({ query: 'drive', input: { limit: state.driveWindow } });
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
  // Mutate `data` in place (never reassign the binding) — `logic.js` closed
  // over this exact object at boot.
  const incoming = next ?? data;
  data.folders = incoming.folders ?? [];
  data.documents = incoming.documents ?? [];
  data.root_folder_id = incoming.root_folder_id ?? data.root_folder_id;
  state.driveTruncated = Boolean(next?.truncated);
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

// ---------- Boot ----------

// One React root per dynamic container, created once and reused for every
// subsequent render.
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
wireChrome({
  state,
  render,
  refresh,
  renderRows,
  renderNewMenu,
  closeQuick,
  closeDetails,
  quickStep,
  applySearch,
  uploadFiles,
  folderName,
});
refresh();
