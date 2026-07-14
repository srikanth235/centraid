// Chrome wiring: the sidebar buttons (add expense / new group / add friend /
// settle up), the hamburger/scrim narrow-sidebar toggle, the search input
// (debounced, Escape-to-clear), the theme toggle, the global Escape handler
// (closes modals, else the sidebar) and the component-width narrow
// measurement. Pure event-listener glue — no JSX — factored out purely to
// keep app.jsx under the file-size cap, same shape as tasks/chrome.js.
import { observeWidth, onFocusRefresh, wireThemeToggle } from './kit.js';

const $ = (id) => document.getElementById(id);

export function wireChrome({ state, logic, renderModals, refreshAll }) {
  $('addExpenseBtn').addEventListener('click', logic.openAddExpense);
  $('newGroupBtn').addEventListener('click', logic.openNewGroup);
  $('addFriendBtn').addEventListener('click', logic.openAddFriend);
  $('settleBtn').addEventListener('click', logic.openSettle);
  // Kit theme toggle; app.jsx's render() calls the returned setter too, so
  // the icon stays in sync after a shell-driven theme flip (postMessage).
  const setThemeIcon = wireThemeToggle($('themeBtn'));
  $('hamburger').addEventListener('click', () => $('root').classList.add('side-open'));
  $('sideClose').addEventListener('click', () => $('root').classList.remove('side-open'));
  $('scrim').addEventListener('click', () => $('root').classList.remove('side-open'));
  $('searchInput').addEventListener('input', logic.applySearch);
  $('searchInput').addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    logic.clearSearch();
  });

  onFocusRefresh(refreshAll);
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (logic.anyModalOpen()) {
      logic.closeAllModals();
      renderModals();
      return;
    }
    if ($('root').classList.contains('side-open')) $('root').classList.remove('side-open');
  });

  // Component-width driven responsive: blueprints render inside a panel, so we
  // measure the root's own width (not the viewport) and toggle the phone
  // layout. A ResizeObserver replaces the old 4Hz poll (issue #404).
  const root = $('root');
  observeWidth(root, 900, (narrow) => {
    if (narrow === state.narrow) return;
    state.narrow = narrow;
    root.classList.toggle('is-narrow', narrow);
    if (!narrow) root.classList.remove('side-open');
  });

  return { setThemeIcon };
}
