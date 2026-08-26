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

  /** §6.2: versions is a route over the drive, not an overlay. */
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

  // #352: same-tag click toggles the filter off.
  function selectTag(key: string) {
    state.tag = state.tag === key ? "all" : key;
    clearSelection();
    render();
  }

  // Nav clears selection/menu/search state (spec §1.1's `dgo`). Never write
  // `#root`'s classes from here — that is the HOST's mount div.
  function selectShelf(shelf: ShelfId) {
    state.shelf = shelf;
    state.versionsId = null;
    clearSelection();
    state.detailsId = null;
    state.search = "";
    state.searchResults = null;
    state.searchStatus = "resting";
    // THE FIELD IS NOT CHROME (components/SearchField.tsx): only Search
    // renders `#searchInput`, so null check — not a non-null cast.
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
