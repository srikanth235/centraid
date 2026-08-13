// Navigation + overlay open/close state transitions — the small state
// mutations that sit between a click and a JSX re-render. Same factory
// pattern as `logic.ts`: no JSX here, so these live in their own module
// purely to keep app.tsx under the file-size cap, closing over app.tsx's
// own `state`/`data` plus the render entry points only app.tsx can define.
import type { ShelfId } from "./shelves.ts";
import type { AppState } from "./types.ts";

const $ = (id: string) => document.querySelector<HTMLElement>(`#${id}`)!;

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

  // The reading view is a ROUTE (§6.1/§1.8): opening it replaces the drive in
  // the scroll region rather than covering it, and it closes every overlay
  // that was standing over the drive — a member who navigated is not still
  // half-inside the thing they navigated away from.
  function openReading(id: string) {
    state.readingId = id;
    state.versionsId = null;
    state.quickId = null;
    state.detailsId = null;
    renderQuick();
    renderDetails();
    render();
  }
  function closeReading() {
    state.readingId = null;
    state.versionsId = null;
    render();
  }
  /** §6.2's version history — the same kind of route, reached from a reading
   *  view or from the rail's footer. */
  function openVersions(id: string) {
    state.versionsId = id;
    state.quickId = null;
    state.detailsId = null;
    renderQuick();
    renderDetails();
    render();
  }
  function closeVersions() {
    state.versionsId = null;
    render();
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
    const idx = state.visibleRows.findIndex(
      (d) => d.document_id === state.quickId
    );
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
    $("uploadInput").click();
  }
  function startCreateFolder() {
    state.newMenuOpen = false;
    state.creatingFolder = true;
    render();
  }

  // Free-form label filter (issue #352 phase 4) — toggling off when the same
  // tag is clicked again (a chip row's usual idiom) rather than requiring a
  // separate "All" chip of its own. Tags are not one of §4.2's four filter
  // axes, so they keep their own chips rather than becoming a fifth pill.
  function selectTag(key: string) {
    state.tag = state.tag === key ? "all" : key;
    clearSelection();
    render();
  }

  // Every navigation inside Docs clears selection and any open menu, search
  // or editor state (spec §1.1's `dgo`). The drawer's own close is the
  // caller's — app-root wraps this so the React drawer state moves with it;
  // this module no longer reaches for `#root`'s class list, which was a write
  // onto the HOST's mount div and had been a no-op since the inline flip.
  function selectShelf(shelf: ShelfId) {
    state.shelf = shelf;
    // A shelf is a place. Leaving for another one leaves the document routes
    // behind with everything else that was open over the drive.
    state.readingId = null;
    state.versionsId = null;
    clearSelection();
    state.detailsId = null;
    state.search = "";
    state.searchResults = null;
    ($("searchInput") as HTMLInputElement).value = "";
    state.newMenuOpen = false;
    state.creatingFolder = false;
    state.renamingFolderId = null;
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
    openReading,
    closeReading,
    openVersions,
    closeVersions,
    openQuick,
    closeQuick,
    quickStep,
    openEditor,
    closeEditor,
    triggerUpload,
    startCreateFolder,
    selectTag,
    selectShelf,
    showMoreDocs,
  };
}
