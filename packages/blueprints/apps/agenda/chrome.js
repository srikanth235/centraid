// Chrome wiring: the hamburger/scrim narrow-sidebar toggle, the search input
// (debounced, Escape-to-clear), the theme toggle, the keyboard shortcuts
// (←/→/t/m/w/s, Escape closes the topmost overlay) and the component-width
// narrow measurement. Pure event-listener glue — no JSX — factored out
// purely to keep app.jsx under the file-size cap, same shape as tasks/notes'
// chrome.js.
import { wireThemeToggle } from './kit.js';

const $ = (id) => document.getElementById(id);

export function wireChrome({ state, load, applySearchInput, clearSearch, onNav, onToday, onSetView, closeDrawer, closeCreate }) {
  $('hamburger').addEventListener('click', () => $('shell').classList.add('side-open'));
  $('sideClose').addEventListener('click', () => $('shell').classList.remove('side-open'));
  $('scrim').addEventListener('click', () => $('shell').classList.remove('side-open'));

  wireThemeToggle($('themeBtn'));

  $('searchInput').addEventListener('input', (e) => applySearchInput(e.target.value));
  $('searchInput').addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (!$('searchInput').value && !state.search) return;
    $('searchInput').value = '';
    clearSearch();
  });

  window.addEventListener('focus', load);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (state.createOpen) {
        closeCreate();
        return;
      }
      if (state.detailEventId) {
        closeDrawer();
        return;
      }
      if (e.target === $('searchInput') && $('searchInput').value) {
        $('searchInput').value = '';
        clearSearch();
        return;
      }
      $('shell').classList.remove('side-open');
      return;
    }
    const typing =
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      e.target instanceof HTMLSelectElement;
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (state.createOpen || state.detailEventId) return;
    if (e.key === 'ArrowLeft') onNav(-1);
    else if (e.key === 'ArrowRight') onNav(1);
    else if (e.key === 't') onToday();
    else if (e.key === 'm') onSetView('month');
    else if (e.key === 'w') onSetView('week');
    else if (e.key === 's') onSetView('schedule');
  });

  // Component-width driven responsive: blueprints render inside a panel, so
  // measure the shell's own width (not the viewport) and toggle the phone
  // layout, same convention as tasks/notes' chrome.js.
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
