// Chrome wiring: the hamburger/scrim narrow-sidebar toggle, the search input
// (debounced, clear button, Escape-to-clear), the theme toggle, the
// masonry/list view toggle, the "New note" button, the keyboard shortcuts
// (n / / /Escape) and the component-width narrow measurement. Pure
// event-listener glue — no JSX — factored out purely to keep app.jsx under
// the file-size cap, same shape as tasks/chrome.js.
import { observeWidth, onFocusRefresh, wireThemeToggle } from './kit.js';
import type { AppState } from './types.ts';

const $ = (id: string) => document.getElementById(id)!;
const searchInputEl = () => $('searchInput') as HTMLInputElement;

interface ChromeDeps {
  state: AppState;
  render: () => void;
  refresh: () => Promise<void>;
  applySearchInput: (raw: string) => void;
  focusQuickAdd: () => void;
  closeEditor: () => void;
}

export function wireChrome({
  state,
  render,
  refresh,
  applySearchInput,
  focusQuickAdd,
  closeEditor,
}: ChromeDeps) {
  $('hamburger').addEventListener('click', () => $('shell').classList.add('side-open'));
  $('sideClose').addEventListener('click', () => $('shell').classList.remove('side-open'));
  $('scrim').addEventListener('click', () => $('shell').classList.remove('side-open'));
  $('newNoteBtn').addEventListener('click', () => {
    $('shell').classList.remove('side-open');
    focusQuickAdd();
  });

  wireThemeToggle($('themeBtn'));

  searchInputEl().addEventListener('input', (e) => {
    const value = (e.target as HTMLInputElement).value;
    applySearchInput(value);
    $('searchClear').hidden = !value;
  });
  searchInputEl().addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (!searchInputEl().value && !state.search) return;
    searchInputEl().value = '';
    $('searchClear').hidden = true;
    applySearchInput('');
  });
  $('searchClear').addEventListener('click', () => {
    searchInputEl().value = '';
    $('searchClear').hidden = true;
    applySearchInput('');
    searchInputEl().focus();
  });

  function updateViewButtons() {
    $('viewMasonryBtn').setAttribute('aria-pressed', String(state.view === 'masonry'));
    $('viewListBtn').setAttribute('aria-pressed', String(state.view === 'list'));
  }
  $('viewMasonryBtn').addEventListener('click', () => {
    state.view = 'masonry';
    updateViewButtons();
    render();
  });
  $('viewListBtn').addEventListener('click', () => {
    state.view = 'list';
    updateViewButtons();
    render();
  });
  updateViewButtons();

  onFocusRefresh(refresh);

  window.addEventListener('keydown', (e) => {
    const typing =
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      e.target instanceof HTMLSelectElement;
    if (e.key === 'Escape') {
      if (state.editorId) {
        closeEditor();
        return;
      }
      if (state.search) {
        searchInputEl().value = '';
        $('searchClear').hidden = true;
        applySearchInput('');
        return;
      }
      $('shell').classList.remove('side-open');
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey || state.editorId) return;
    if (e.key === 'n') {
      e.preventDefault();
      focusQuickAdd();
    } else if (e.key === '/') {
      e.preventDefault();
      $('searchInput').focus();
    }
  });

  // Component-width driven responsive: blueprints render inside a panel, so
  // measure the shell's own width (not the viewport) and toggle the phone
  // layout, same convention as tasks/chrome.js. A ResizeObserver replaces the
  // old 4Hz poll (issue #404) — it fires only on real size changes.
  const shell = $('shell');
  observeWidth(shell, 860, (narrow) => {
    if (narrow === state.narrow) return;
    state.narrow = narrow;
    shell.classList.toggle('is-narrow', narrow);
    if (!narrow) shell.classList.remove('side-open');
  });
}
