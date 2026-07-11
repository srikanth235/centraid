// Chrome wiring: the hamburger/scrim narrow-sidebar toggle, the search input
// (debounced, clear button, Escape-to-clear), the theme toggle, the
// masonry/list view toggle, the "New note" button, the keyboard shortcuts
// (n / / /Escape) and the component-width narrow measurement. Pure
// event-listener glue — no JSX — factored out purely to keep app.jsx under
// the file-size cap, same shape as tasks/chrome.js.
import { wireThemeToggle } from './kit.js';

const $ = (id) => document.getElementById(id);

export function wireChrome({
  state,
  render,
  refresh,
  applySearchInput,
  focusQuickAdd,
  closeEditor,
}) {
  $('hamburger').addEventListener('click', () => $('shell').classList.add('side-open'));
  $('sideClose').addEventListener('click', () => $('shell').classList.remove('side-open'));
  $('scrim').addEventListener('click', () => $('shell').classList.remove('side-open'));
  $('newNoteBtn').addEventListener('click', () => {
    $('shell').classList.remove('side-open');
    focusQuickAdd();
  });

  wireThemeToggle($('themeBtn'));

  $('searchInput').addEventListener('input', (e) => {
    applySearchInput(e.target.value);
    $('searchClear').hidden = !e.target.value;
  });
  $('searchInput').addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (!$('searchInput').value && !state.search) return;
    $('searchInput').value = '';
    $('searchClear').hidden = true;
    applySearchInput('');
  });
  $('searchClear').addEventListener('click', () => {
    $('searchInput').value = '';
    $('searchClear').hidden = true;
    applySearchInput('');
    $('searchInput').focus();
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

  window.addEventListener('focus', refresh);

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
        $('searchInput').value = '';
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
  // layout, same convention as tasks/chrome.js.
  function measure() {
    const shell = $('shell');
    const forced = document.documentElement.getAttribute('data-app-width') === 'narrow';
    const narrow = forced || shell.clientWidth < 860;
    if (narrow !== state.narrow) {
      state.narrow = narrow;
      shell.classList.toggle('is-narrow', narrow);
      if (!narrow) shell.classList.remove('side-open');
    }
  }
  measure();
  setInterval(measure, 250);
}
