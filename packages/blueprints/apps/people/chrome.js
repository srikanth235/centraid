// Chrome wiring: the toolbar buttons, search input, keyboard shortcuts, and
// the component-width resize measurement. Pure event-listener glue — no
// JSX — factored out purely to keep app.jsx under the file-size cap. Every
// callback it invokes is passed in by app.jsx, which is the only module that
// defines them (same shape as docs/tasks/notes' chrome.js).
import { closePopover, isPopoverOpen, wireThemeToggle } from './kit.js';

const $ = (id) => document.getElementById(id);

export function wireChrome({
  state,
  render,
  refresh,
  renderRows,
  renderNewMenu,
  closeDetails,
  closeAddModal,
  applySearch,
}) {
  $('newBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    state.newMenuOpen = !state.newMenuOpen;
    renderNewMenu();
  });
  document.addEventListener('click', (e) => {
    if (state.newMenuOpen && !e.target.closest('.d-new-wrap')) {
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
    const keys = ['last', 'name', 'cadence'];
    const i = keys.indexOf(state.sortKey);
    const next = keys[(i + 1) % keys.length];
    state.sortKey = next;
    state.sortDir = next === 'name' || next === 'cadence' ? 1 : -1;
    render();
  });
  $('hamburger').addEventListener('click', () => $('root').classList.add('side-open'));
  $('sideClose').addEventListener('click', () => $('root').classList.remove('side-open'));
  $('scrim').addEventListener('click', () => $('root').classList.remove('side-open'));

  $('searchInput').addEventListener('input', applySearch);
  $('searchInput').addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (!$('searchInput').value && !state.search) return;
    $('searchInput').value = '';
    state.searchSeq += 1;
    state.search = '';
    state.searchResults = null;
    state.selected.clear();
    render();
  });

  window.addEventListener('focus', refresh);

  // Layered Escape.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (isPopoverOpen()) {
      closePopover();
      return;
    }
    if (state.addModalOpen) {
      closeAddModal();
      return;
    }
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
  // layout.
  function measure() {
    const root = $('root');
    const forced = document.documentElement.getAttribute('data-app-width') === 'narrow';
    const narrow = forced || root.clientWidth < 860;
    if (narrow !== state.narrow) {
      state.narrow = narrow;
      root.classList.toggle('is-narrow', narrow);
      if (!narrow) root.classList.remove('side-open');
      renderRows();
    }
  }
  measure();
  setInterval(measure, 250);
}
