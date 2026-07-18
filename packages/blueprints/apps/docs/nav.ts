// Navigation + overlay open/close state transitions — the small state
// mutations that sit between a click and a JSX re-render. Same factory
// pattern as `logic.ts`: no JSX here, so these live in their own module
// purely to keep app.tsx under the file-size cap, closing over app.tsx's
// own `state`/`data` plus the render entry points only app.tsx can define.
import type { AppState, Nav } from './types.ts';

const $ = (id: string) => document.getElementById(id)!;

interface NavDeps {
  state: AppState;
  render: () => void;
  refresh: () => Promise<void> | void;
  renderDetails: () => void;
  renderQuick: () => void;
  renderNewMenu: () => void;
  renderEditor: () => void;
  clearSelection: () => void;
}

export function createNav({
  state,
  render,
  refresh,
  renderDetails,
  renderQuick,
  renderNewMenu,
  renderEditor,
  clearSelection,
}: NavDeps) {
  function openDetails(id: string) {
    state.detailsId = id;
    state.quickId = null;
    renderQuick();
    renderDetails();
  }
  function closeDetails() {
    state.detailsId = null;
    renderDetails();
  }

  function openQuick(id: string) {
    state.quickId = id;
    renderQuick();
  }
  function closeQuick() {
    state.quickId = null;
    renderQuick();
  }
  function quickStep(delta: number) {
    const idx = state.visibleRows.findIndex((d) => d.document_id === state.quickId);
    const next = idx < 0 ? undefined : state.visibleRows[idx + delta];
    if (next) openQuick(next.document_id);
  }

  // The in-place text editor (issue #352) is its own overlay, stacked above
  // Details exactly like Quick Look is — opening it closes Details/Quick
  // Look the same way opening either of those closes the other.
  function openEditor(id: string) {
    state.editingId = id;
    state.detailsId = null;
    state.quickId = null;
    renderDetails();
    renderQuick();
    renderEditor();
  }
  function closeEditor() {
    state.editingId = null;
    renderEditor();
  }

  function triggerUpload() {
    state.newMenuOpen = false;
    renderNewMenu();
    $('uploadInput').click();
  }
  function startCreateFolder() {
    state.newMenuOpen = false;
    state.creatingFolder = true;
    render();
  }

  function selectType(key: string) {
    state.type = key;
    clearSelection();
    render();
  }

  // Free-form label filter (issue #352 phase 4) — same shape as selectType,
  // toggling off when the same tag is clicked again (a chip row's usual
  // idiom) rather than requiring a separate "All" chip of its own.
  function selectTag(key: string) {
    state.tag = state.tag === key ? 'all' : key;
    clearSelection();
    render();
  }

  function selectNav(nav: Nav) {
    state.nav = nav;
    clearSelection();
    state.detailsId = null;
    state.search = '';
    state.searchResults = null;
    ($('searchInput') as HTMLInputElement).value = '';
    state.newMenuOpen = false;
    state.creatingFolder = false;
    state.renamingFolderId = null;
    if (state.narrow) $('root').classList.remove('side-open');
    renderDetails();
    render();
  }

  async function showMoreDocs() {
    state.driveWindow += 200;
    await refresh();
  }

  return {
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
  };
}
