// Chrome wiring: the hamburger/scrim narrow-sidebar toggle, the search input
// (debounced, Escape-to-clear), the theme toggle, the "New task" button, the
// keyboard shortcuts (n / / /f / Escape) and the component-width narrow
// measurement. Pure event-listener glue — no JSX — factored out purely to
// keep app.tsx under the file-size cap, same shape as docs/chrome.ts.
import { observeWidth, onFocusRefresh, wireThemeToggle } from './kit.js';
import type { AppState } from './types.ts';

const $ = (id: string) => document.getElementById(id)!;
const searchInputEl = () => $('searchInput') as HTMLInputElement;

interface ChromeDeps {
  state: AppState;
  render: () => void;
  refresh: () => Promise<void>;
  applySearchInput: (raw: string) => void;
  focusCapture: () => void;
  closeDetail: () => void;
}

export function wireChrome({
  state,
  render,
  refresh,
  applySearchInput,
  focusCapture,
  closeDetail,
}: ChromeDeps) {
  $('hamburger').addEventListener('click', () => $('shell').classList.add('side-open'));
  $('sideClose').addEventListener('click', () => $('shell').classList.remove('side-open'));
  $('scrim').addEventListener('click', () => $('shell').classList.remove('side-open'));
  $('newTaskBtn').addEventListener('click', () => {
    $('shell').classList.remove('side-open');
    if (state.view === 'logbook') {
      state.view = 'today';
      render();
    }
    focusCapture();
  });

  wireThemeToggle($('themeBtn'));

  searchInputEl().addEventListener('input', (e) =>
    applySearchInput((e.target as HTMLInputElement).value),
  );
  searchInputEl().addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key !== 'Escape') return;
    e.preventDefault();
    if (!searchInputEl().value && !state.search) return;
    searchInputEl().value = '';
    applySearchInput('');
  });

  onFocusRefresh(refresh);

  window.addEventListener('keydown', (e) => {
    const typing =
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      e.target instanceof HTMLSelectElement;
    if (e.key === 'Escape') {
      if (state.detailId) {
        closeDetail();
        return;
      }
      if (state.search) {
        searchInputEl().value = '';
        applySearchInput('');
        return;
      }
      $('shell').classList.remove('side-open');
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'n') {
      e.preventDefault();
      focusCapture();
    } else if (e.key === '/' || e.key === 'f') {
      e.preventDefault();
      searchInputEl().focus();
    }
  });

  // Component-width driven responsive: blueprints render inside a panel, so
  // measure the shell's own width (not the viewport) and toggle the phone
  // layout, same convention as docs/chrome.ts. A ResizeObserver replaces the
  // old 4Hz poll (issue #404).
  const shell = $('shell');
  observeWidth(shell, 860, (narrow) => {
    if (narrow === state.narrow) return;
    state.narrow = narrow;
    shell.classList.toggle('is-narrow', narrow);
    if (!narrow) shell.classList.remove('side-open');
  });
}
