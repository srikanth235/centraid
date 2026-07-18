// Chrome wiring: the toolbar buttons, search input, upload input, drag-and-
// drop, keyboard shortcuts, and the component-width resize measurement. Pure
// event-listener glue — no JSX — factored out purely to keep app.tsx (which
// still owns and calls this once at boot) under the file-size cap. Every
// callback it invokes (render/refresh/renderRows/renderNewMenu/closeQuick/
// closeDetails/quickStep/applySearch/uploadFiles/folderName) is passed in by
// app.tsx, which is the only module that defines them.
import { observeWidth, onFocusRefresh, wireThemeToggle } from './kit.js';
import type { AppState } from './types.ts';

const $ = (id: string) => document.getElementById(id)!;

interface ChromeDeps {
  state: AppState;
  render: () => void;
  refresh: () => Promise<void> | void;
  renderRows: () => void;
  renderNewMenu: () => void;
  closeQuick: () => void;
  closeDetails: () => void;
  closeEditor: () => Promise<void> | void;
  quickStep: (delta: number) => void;
  applySearch: () => void;
  uploadFiles: (fileList: FileList | File[]) => Promise<void>;
  folderName: (id: string | null | undefined) => string;
}

export function wireChrome({
  state,
  render,
  refresh,
  renderRows,
  renderNewMenu,
  closeQuick,
  closeDetails,
  closeEditor,
  quickStep,
  applySearch,
  uploadFiles,
  folderName,
}: ChromeDeps) {
  $('newBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    state.newMenuOpen = !state.newMenuOpen;
    renderNewMenu();
  });
  document.addEventListener('click', (e) => {
    if (state.newMenuOpen && !(e.target as Element | null)?.closest('.d-new-wrap')) {
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
    const order = ['added', 'name', 'size'] as const;
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
    const nextKey = order[(i + 1) % order.length]!;
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
    const searchInput = $('searchInput') as HTMLInputElement;
    if (!searchInput.value && !state.search) return;
    searchInput.value = '';
    state.searchSeq += 1;
    state.search = '';
    state.searchResults = null;
    state.selected.clear();
    state.anchorIndex = null;
    render();
  });

  $('uploadInput').addEventListener('change', async () => {
    const input = $('uploadInput') as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    await uploadFiles(files);
  });
  onFocusRefresh(refresh);

  // Drag-and-drop onto the current folder.
  let dragDepth = 0;
  function dragHasFiles(e: DragEvent) {
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

  // Keyboard: quick-look nav, and a layered Escape. The editor sits above
  // everything else (opening it already closed Details/Quick Look, nav.ts's
  // openEditor), a textarea's own Escape still bubbles here since the
  // textarea itself defines no keydown handler for it.
  window.addEventListener('keydown', (e) => {
    if (state.editingId) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeEditor();
      }
      return;
    }
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

  // Component-width driven responsive: blueprints render inside a panel, so
  // we measure the root's own width (not the viewport) and toggle the phone
  // layout. A ResizeObserver replaces the old 4Hz poll (issue #404).
  const root = $('root');
  observeWidth(root, 860, (narrow) => {
    if (narrow === state.narrow) return;
    state.narrow = narrow;
    root.classList.toggle('is-narrow', narrow);
    if (!narrow) root.classList.remove('side-open');
    renderRows();
  });
}
