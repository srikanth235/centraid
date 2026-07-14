// Notes — a Keep/Apple-Notes-style notebook wall that is still a pure
// projection over the personal vault. Every card rendered here lives in
// knowledge.note over a deduped canonical core.content_item body; every
// mutation is a typed vault command (knowledge.create_note / edit_note /
// move_note / create_notebook / rename_notebook / delete_notebook /
// delete_note, core.attach/detach) routed through this app's action
// handlers, consent-checked and receipted. Revoke the grant and this page
// goes dark while the notes, notebooks and receipts remain the owner's.
//
// React port: module-level `state`/`data` (mutated in place, never
// reassigned) plus a `render()` orchestrator fanning out to one React root
// per stable container — the same tasks/app.jsx pattern. `logic.js` holds
// the non-visual business logic (vault IO, notebook CRUD, parked-write
// tracking, search); `chrome.js` wires the toolbar/keyboard/resize
// listeners; `format.js`/`icons.js` are stateless. `components/` holds pure
// functions of props.
import { createRoot } from './react-core.min.js';
import { onDataChange, readFailed, showSkeleton, wireAttachInput } from './kit.js';
import {
  buildWall,
  createLogic,
  notebookNoteCounts,
  sidebarCounts,
  tagNoteCounts,
} from './logic.js';
import { wireChrome } from './chrome.js';
import { SidebarFoot, SidebarNav } from './components/Sidebar.jsx';
import { Toolbar } from './components/Toolbar.jsx';
import { Wall } from './components/Wall.jsx';
import { Editor } from './components/Editor.jsx';

const $ = (id) => document.getElementById(id);

// Vault entities this app's queries read — the doorbell filter re-derives
// only when a change names one of these (or names none, i.e. "this app acted").
const CHANGE_TABLES = [
  'knowledge.note',
  'core.content_item',
  'core.attachment',
  'core.link',
  'core.collection',
  'core.collection_entry',
  'core.tag',
  'core.concept',
];

// ---------- State ----------
// The last successful library read (never reassigned — mutated in place so
// logic.js's closure over it stays valid) and all client-side presentation
// state, which is never persisted and never sent to the vault.

const data = { notes: [], notebooks: [], tags: [], window: 200 };

const validViews = new Set(['masonry', 'list']);
const knobView = document.documentElement.getAttribute('data-app-default-view');

const state = {
  nav: { kind: 'all' }, // {kind:'all'} | {kind:'pinned'} | {kind:'notebook', notebookId}
  view: validViews.has(knobView) ? knobView : 'masonry',
  search: '',
  searchResults: null,
  libraryWindow: 200,
  libraryTruncated: false,
  editorId: null,
  narrow: false,
  editingNotebookId: null, // toolbar's inline-rename target
  creatingNotebook: false, // sidebar's inline "new notebook" form
  // Parked writes: note_ids/notebook_ids with an outstanding write, plus
  // ghost entries for parked creates (no note_id exists yet).
  pendingNoteIds: new Set(),
  pendingNotebookIds: new Set(),
  pendingCreates: [],
  readFailedShown: false,
};

let focusQuickAddFn = null;
function focusQuickAdd() {
  if (state.nav.kind === 'pinned') logic.selectNav({ kind: 'all' });
  focusQuickAddFn?.();
}

let editorFlush = null;
function registerEditorFlush(fn) {
  editorFlush = fn;
}
async function closeEditor() {
  if (editorFlush) {
    const fn = editorFlush;
    editorFlush = null;
    await fn();
  }
  logic.closeEditor();
}

// ---------- Logic instance ----------
// `render`/`refresh` are `function` declarations (hoisted), so `logic` can
// close over them here even though they're defined further down the file.

const logic = createLogic({ state, data, render, refresh });

// ---------- Roots ----------

let sidebarNavRoot;
let sidebarFootRoot;
let toolbarRoot;
let wallRoot;
let editorRoot;

function renderEditor() {
  const note = state.editorId ? logic.findNote(state.editorId) : null;
  editorRoot.render(
    note ? (
      <Editor
        key={`${note.note_id}:${typeof note.body === 'string' ? 'full' : 'lite'}`}
        note={note}
        notebooks={data.notebooks}
        pending={state.pendingNoteIds.has(note.note_id)}
        registerFlush={registerEditorFlush}
        onClose={closeEditor}
        onAutosave={(noteId, patch) => logic.editNoteAutosave(noteId, patch)}
        onTogglePin={(n) => logic.togglePin(n)}
        onMove={(noteId, notebookId) => logic.moveNote(noteId, notebookId)}
        onDelete={(n) => logic.deleteNote(n)}
        onAttach={(noteId) => {
          logic.setAttachTarget(noteId);
          $('attachInput').click();
        }}
        onRemoveAttachment={(attachmentId) => logic.removeAttachment(attachmentId)}
        onAddTag={(noteId, label) => logic.addTag(noteId, label)}
        onRemoveTag={(tagId) => logic.removeTag(tagId)}
      />
    ) : null,
  );
}

function render() {
  const counts = sidebarCounts(data);
  const nbCounts = notebookNoteCounts(data);
  const tgCounts = tagNoteCounts(data);
  sidebarNavRoot.render(
    <SidebarNav
      nav={state.nav}
      counts={counts}
      notebooks={data.notebooks}
      notebookCounts={nbCounts}
      tags={data.tags}
      tagCounts={tgCounts}
      creatingNotebook={state.creatingNotebook}
      pendingNotebookIds={state.pendingNotebookIds}
      onSelect={(nav) => logic.selectNav(nav)}
      onStartCreate={() => {
        state.creatingNotebook = true;
        render();
      }}
      onCancelCreate={() => {
        state.creatingNotebook = false;
        render();
      }}
      onSubmitCreate={(name) => logic.createNotebook(name)}
    />,
  );
  sidebarFootRoot.render(<SidebarFoot counts={counts} />);

  const q = state.search.trim();
  const wall = buildWall(data, state);
  const rows = wall.pinned.length + wall.others.length;
  const titles = { all: 'All notes', pinned: 'Pinned' };
  const activeTitle =
    state.nav.kind === 'notebook'
      ? logic.notebookName(state.nav.notebookId)
      : state.nav.kind === 'tag'
        ? `#${(data.tags ?? []).find((t) => t.concept_id === state.nav.conceptId)?.label ?? 'tag'}`
        : (titles[state.nav.kind] ?? 'All notes');
  const activeSub = q
    ? `${rows} match${rows === 1 ? '' : 'es'} “${q}”`
    : `${rows} ${rows === 1 ? 'note' : 'notes'}`;

  toolbarRoot.render(
    <Toolbar
      title={activeTitle}
      sub={activeSub}
      showNotebookTools={state.nav.kind === 'notebook'}
      renaming={state.nav.kind === 'notebook' && state.editingNotebookId === state.nav.notebookId}
      notebookId={state.nav.kind === 'notebook' ? state.nav.notebookId : null}
      notebookName={activeTitle}
      onStartRename={() => {
        state.editingNotebookId = state.nav.notebookId;
        render();
      }}
      onCommitRename={(notebookId, name) => logic.renameNotebook(notebookId, name)}
      onCancelRename={() => {
        state.editingNotebookId = null;
        render();
      }}
      onDelete={(notebookId) => logic.deleteNotebook(notebookId)}
    />,
  );

  const footer =
    state.libraryTruncated && !q ? { windowSize: data.window ?? state.libraryWindow } : null;
  const targetLabel =
    state.nav.kind === 'notebook' ? `Into ${logic.notebookName(state.nav.notebookId)}` : 'Unfiled';

  wallRoot.render(
    <Wall
      view={state.view}
      showQuickAdd={state.nav.kind !== 'pinned' && !q}
      quickAddProps={{
        targetLabel,
        onSubmit: (payload) => logic.submitQuickAdd(payload),
        registerFocus: (fn) => {
          focusQuickAddFn = fn;
        },
      }}
      pendingCreates={state.pendingCreates}
      pinned={wall.pinned}
      others={wall.others}
      showPinnedGroup={wall.showPinnedGroup}
      isEmpty={wall.isEmpty}
      emptyTitle={wall.emptyTitle}
      emptySub={wall.emptySub}
      search={state.search}
      pendingNoteIds={state.pendingNoteIds}
      footer={footer}
      onShowMore={showMore}
      onOpenNote={(noteId) => logic.openEditor(noteId)}
      onTogglePin={(note) => logic.togglePin(note)}
    />,
  );

  renderEditor();
}

async function showMore() {
  const btn = $('wall').querySelector('.kit-foot button');
  if (btn) btn.disabled = true;
  state.libraryWindow += 200;
  await refresh();
}

async function refresh() {
  let res;
  try {
    res = await window.centraid.read({ query: 'library', input: { limit: state.libraryWindow } });
  } catch {
    // A broken vault must not look like an empty one.
    readFailed($('noticeBanner'));
    state.readFailedShown = true;
    return;
  }
  if (state.readFailedShown) {
    state.readFailedShown = false;
    logic.notice('');
  }
  const denied = res?.vaultDenied;
  $('consentBanner').hidden = !denied;
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    data.notes = [];
    data.notebooks = [];
    data.tags = [];
    state.editorId = null;
    render();
    return;
  }
  data.notes = res?.notes ?? [];
  data.notebooks = res?.notebooks ?? [];
  data.tags = res?.tags ?? [];
  data.window = res?.window ?? state.libraryWindow;
  state.libraryTruncated = Boolean(res?.truncated);
  if (
    state.nav.kind === 'notebook' &&
    !data.notebooks.some((nb) => nb.notebook_id === state.nav.notebookId)
  ) {
    state.nav = { kind: 'all' }; // active notebook deleted elsewhere
  }
  if (state.nav.kind === 'tag' && !data.tags.some((t) => t.concept_id === state.nav.conceptId)) {
    state.nav = { kind: 'all' }; // last note carrying this tag lost it, or aged out of the window
  }
  if (
    state.editingNotebookId &&
    !data.notebooks.some((nb) => nb.notebook_id === state.editingNotebookId)
  ) {
    state.editingNotebookId = null;
  }
  if (state.editorId && !logic.findNote(state.editorId)) state.editorId = null;
  render();
}

// ---------- Boot ----------

sidebarNavRoot = createRoot($('sidebarNav'));
sidebarFootRoot = createRoot($('sidebarFoot'));
toolbarRoot = createRoot($('toolbar'));
wallRoot = createRoot($('wall'));
editorRoot = createRoot($('editorRoot'));

showSkeleton($('wall'), 6);

wireChrome({
  state,
  render,
  refresh,
  applySearchInput: logic.applySearchInput,
  focusQuickAdd,
  closeEditor,
});

// One shared file input for the whole app; the editor's "Attach a file"
// button sets the target note, then triggers this.
wireAttachInput($('attachInput'), () => logic.getAttachTarget(), {
  act: logic.act,
  narrate: logic.narrate,
  notice: logic.notice,
  refresh,
});

// Reactive data (SKILL.md "Reactive data"): a write elsewhere (chat agent, a
// second window) fires this — re-read, and treat it as the resolution of any
// outstanding parked write (the owner approved or discarded it via another
// surface; there is no per-invocation poll wired here, so this is the
// honest, bounded way to clear a stale pending chip without guessing). The
// kit helper debounces the doorbell and filters by the tables this app reads.
onDataChange(CHANGE_TABLES, () => {
  logic.clearPending();
  refresh();
});

refresh();
