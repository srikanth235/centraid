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
  clearSelection: () => void;
}

export function createNav({
  state,
  render,
  refresh,
  renderDetails,
  renderQuick,
  renderNewMenu,
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

  /** §6.2's version history — a ROUTE: opening it replaces the drive in the
   *  scroll region rather than covering it, and it closes every overlay that
   *  was standing over the drive, because a member who navigated is not still
   *  half-inside the thing they navigated away from. */
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

  // Free-form label filter (#352) — toggling off when the same
  // tag is clicked again (a chip row's usual idiom) rather than requiring a
  // separate "All" chip of its own. Tags are not one of §4.2's four filter
  // axes, so they keep their own chips rather than becoming a fifth pill.
  function selectTag(key: string) {
    state.tag = state.tag === key ? "all" : key;
    clearSelection();
    render();
  }

  // Every navigation inside Docs clears selection and any open menu or
  // search state (spec §1.1's `dgo`). The drawer's own close is the
  // caller's — app-root wraps this so the React drawer state moves with it;
  // this module does not reach for `#root`'s class list: that is a write onto
  // the HOST's mount div, and a no-op from here.
  function selectShelf(shelf: ShelfId) {
    state.shelf = shelf;
    // A shelf is a place. Leaving for another one leaves the document route
    // behind with everything else that was open over the drive.
    state.versionsId = null;
    clearSelection();
    state.detailsId = null;
    state.search = "";
    state.searchResults = null;
    state.searchStatus = "resting";
    // THE FIELD IS NOT CHROME ANY MORE (components/SearchField.tsx): it is
    // rendered by the Search shelf and by nothing else, so on every other
    // shelf `#searchInput` is legitimately absent — hence the null check and
    // not a non-null cast, which turns an ordinary navigation into a TypeError
    // the moment the field moves.
    const field = $("searchInput") as HTMLInputElement | null;
    if (field) field.value = "";
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
    openVersions,
    closeVersions,
    openQuick,
    closeQuick,
    quickStep,
    triggerUpload,
    startCreateFolder,
    selectTag,
    selectShelf,
    showMoreDocs,
  };
}
