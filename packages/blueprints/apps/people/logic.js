// Non-visual business logic: vault IO (write/act), row derivation, selection,
// the kebab/move-to-circle popover (stays plain DOM, built with kit's
// `h()`/`popItem()` — no React root needed there), every person/circle write,
// the profile drawer's load/reload + "+ add" write helper, journal/activity
// reads, and navigation state transitions. `createLogic()` is a factory
// app.jsx calls once at boot, closing over the exact `state`/`data` objects
// app.jsx owns (passed by reference: app.jsx mutates their properties in
// place, never reassigns the bindings, so this module always sees the live
// values) plus the render entry points only app.jsx can define. Everything
// returned here is then wired into app.jsx's render functions and JSX props,
// exactly like any other value flowing down. Same factory pattern as
// tasks/logic.js and notes/logic.js.
import {
  closePopover,
  h,
  openPopover,
  outcomeMessage,
  popItem,
  runBulk as runBulkBase,
  toast,
} from './kit.js';
import { PALETTE, circleColor, daysSince, daysUntilAnnual, statusOf } from './format.js';

const $ = (id) => document.getElementById(id);

export function createLogic({
  state,
  data,
  render,
  refresh,
  renderRows,
  renderDetails,
  renderModal,
  renderNewMenu,
}) {
  function notice(text) {
    const b = $('noticeBanner');
    b.textContent = text || '';
    b.hidden = !text;
  }

  // Returns true when the write executed; otherwise narrates the outcome and
  // returns false.
  function narrate(outcome) {
    if (outcome?.status === 'executed') {
      notice('');
      return true;
    }
    notice(outcomeMessage(outcome) ?? '');
    return false;
  }

  async function act(action, input) {
    try {
      return await window.centraid.write({ action, input });
    } catch (err) {
      notice(String(err?.message ?? err));
      return undefined;
    }
  }

  // ---------- Row derivation (client-side, like the prototype's in-memory list) ----------

  function currentRows() {
    const { nav, chip, search } = state;
    let base;
    if (search.trim()) {
      base = state.searchResults ?? [];
    } else {
      base = data.people.slice();
      if (nav.kind === 'reconnect')
        base = base.filter((p) => daysSince(p) >= (p.cadence_days ?? 30));
      else if (nav.kind === 'upcoming') base = base.filter((p) => (p.reminders || []).length > 0);
      else if (nav.kind === 'starred') base = base.filter((p) => p.starred);
      else if (nav.kind === 'circle')
        base = base.filter((p) => (p.circle_id ?? null) === nav.circleId);
    }
    if (chip !== 'all') base = base.filter((p) => statusOf(p).key === chip);

    if (search.trim()) return base; // keep vault rank order
    if (nav.kind === 'reconnect') {
      return base
        .slice()
        .sort(
          (a, b) => daysSince(b) - (b.cadence_days ?? 30) - (daysSince(a) - (a.cadence_days ?? 30)),
        );
    }
    if (nav.kind === 'upcoming') {
      const near = (p) =>
        Math.min(...(p.reminders || []).map((d) => daysUntilAnnual(d.month_day)), 999);
      return base.slice().sort((a, b) => near(a) - near(b));
    }
    const dir = state.sortDir;
    return base.slice().sort((a, b) => {
      let r;
      if (state.sortKey === 'name') r = String(a.name).localeCompare(String(b.name));
      else if (state.sortKey === 'cadence') r = (a.cadence_days ?? 0) - (b.cadence_days ?? 0);
      else r = daysSince(a) - daysSince(b);
      return r * dir;
    });
  }

  // ---------- Selection ----------

  function clearSelection() {
    state.selected.clear();
  }
  function toggleSelect(id) {
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    render();
  }
  function toggleAllVisible(rows, allSelected) {
    if (allSelected) for (const p of rows) state.selected.delete(p.party_id);
    else for (const p of rows) state.selected.add(p.party_id);
    render();
  }
  function clearSelected() {
    clearSelection();
    render();
  }

  // ---------- Popover (kebab + move-to-circle) ----------
  // Reused for both the row kebab menu and the drawer's "Move to circle"
  // button (same target list), exactly as the old version did.

  function openPersonMenu(anchor, p) {
    openPopover(anchor, (box) => {
      box.append(
        popItem('Open profile', () => {
          closePopover();
          openDetails(p.party_id);
        }),
        popItem(p.starred ? 'Remove favorite' : 'Add to favorites', () => {
          closePopover();
          toggleStar(p);
        }),
        h('div', { class: 'kit-popover-sep' }),
        h('p', { class: 'kit-popover-head' }, 'Move to circle'),
        popItem(
          'No circle',
          () => {
            closePopover();
            movePerson(p, null, 'no circle');
          },
          { disabled: p.circle_id == null, dotColor: 'var(--ink-3)' },
        ),
        ...data.circles.map((c) =>
          popItem(
            c.name,
            () => {
              closePopover();
              movePerson(p, c.circle_id, c.name);
            },
            { disabled: p.circle_id === c.circle_id, dotColor: circleColor(c.circle_id) },
          ),
        ),
      );
    });
  }

  // ---------- Person writes ----------

  // refresh() re-renders the open drawer, but from the stale `detailPerson`
  // snapshot — so any write that can land while the drawer is open on the
  // same person must also reload the detail read, or the drawer keeps
  // showing the pre-write state (star glyph, circle, history) until it's
  // closed and reopened.
  async function reloadOpenDetail(partyId) {
    if (state.detailsId === partyId) await loadDetail(partyId);
  }

  async function toggleStar(p) {
    const outcome = await act(p.starred ? 'unstar-person' : 'star-person', {
      party_id: p.party_id,
    });
    if (!narrate(outcome)) return;
    toast(p.starred ? 'Favorite removed · receipted.' : 'Favorited · receipted.');
    await refresh();
    await reloadOpenDetail(p.party_id);
  }

  async function movePerson(p, circleId, name) {
    const input = { party_id: p.party_id, ...(circleId == null ? {} : { circle_id: circleId }) };
    const outcome = await act('move-person', input);
    if (!narrate(outcome)) return;
    toast(`Moved to ${name} · receipted.`);
    await refresh();
    await reloadOpenDetail(p.party_id);
  }

  async function logInteraction(p, kind, text) {
    const outcome = await act('log-interaction', { party_id: p.party_id, kind, text });
    if (!narrate(outcome)) return;
    toast(`Logged · receipted.`);
    await refresh();
    await reloadOpenDetail(p.party_id);
  }

  // Bulk actions run through the kit's runBulk with the app's own voice.
  const bulkOpts = {
    notice,
    friendly: (outcome) => outcome?.reason ?? outcome?.predicate ?? null,
    after: async () => {
      clearSelection();
      await refresh();
    },
  };
  function favoriteSelected() {
    return runBulkBase([...state.selected], (id) => act('star-person', { party_id: id }), {
      progress: 'Favoriting',
      done: 'Favorited',
      ...bulkOpts,
    });
  }

  // ---------- Circle writes ----------

  async function createCircle(name) {
    const outcome = await act('create-circle', { name });
    if (narrate(outcome)) {
      state.creatingCircle = false;
      toast(`Circle "${name}" created · receipted.`);
      await refresh();
    } else {
      render();
    }
  }
  async function renameCircle(circleId, name) {
    const outcome = await act('rename-circle', { circle_id: circleId, name });
    if (narrate(outcome)) {
      state.renamingCircleId = null;
      toast('Circle renamed · receipted.');
      await refresh();
    } else {
      render();
    }
  }
  async function deleteCircle(circle) {
    const outcome = await act('delete-circle', { circle_id: circle.circle_id });
    if (narrate(outcome)) {
      if (state.nav.kind === 'circle' && state.nav.circleId === circle.circle_id)
        state.nav = { kind: 'all' };
      toast('Circle deleted · receipted.');
      await refresh();
    }
  }
  function startRenameCircle(circleId) {
    state.renamingCircleId = circleId;
    render();
  }
  function cancelCreateCircle() {
    state.creatingCircle = false;
    render();
  }
  function cancelRenameCircle() {
    state.renamingCircleId = null;
    render();
  }

  // ---------- Profile drawer ----------

  async function openDetails(id) {
    state.detailsId = id;
    state.detailPerson = null;
    state.detailAdders = {};
    renderDetails(); // paints a shell immediately
    await loadDetail(id);
  }
  function closeDetails() {
    state.detailsId = null;
    state.detailPerson = null;
    renderDetails();
  }
  async function loadDetail(id) {
    try {
      const res = await window.centraid.read({ query: 'person', input: { party_id: id } });
      if (res?.vaultDenied) return;
      if (state.detailsId !== id) return;
      state.detailPerson = res?.person ?? null;
      renderDetails();
    } catch (err) {
      notice(String(err?.message ?? err));
    }
  }
  function toggleAdder(key) {
    state.detailAdders[key] = !state.detailAdders[key];
    renderDetails();
  }

  // Returns true when the write executed (the AddRows components clear their
  // own fields only then — a failed/parked write leaves the typed draft in
  // place instead of silently discarding it).
  async function drawerAct(action, input, message) {
    const outcome = await act(action, input);
    if (!narrate(outcome)) return false;
    toast(`${message} · receipted.`);
    await refresh();
    if (state.detailsId) await loadDetail(state.detailsId);
    return true;
  }

  // ---------- Add-person modal ----------

  async function addPerson({ name, role, circleId, cadence }) {
    const avatar_color = PALETTE[data.people.length % PALETTE.length];
    const input = {
      display_name: name,
      cadence_days: cadence,
      avatar_color,
      ...(role ? { role } : {}),
      ...(circleId != null ? { circle_id: circleId } : {}),
    };
    const outcome = await act('add-person', input);
    if (!narrate(outcome)) return false;
    state.addModalOpen = false;
    renderModal();
    toast('Added · receipted.');
    await refresh();
    const newId = outcome?.output?.party_id;
    if (newId) await openDetails(newId);
    return true;
  }
  function openAddModal() {
    state.newMenuOpen = false;
    renderNewMenu();
    state.addModalOpen = true;
    renderModal();
  }
  function closeAddModal() {
    state.addModalOpen = false;
    renderModal();
  }
  function startCreateCircle() {
    state.newMenuOpen = false;
    renderNewMenu();
    state.creatingCircle = true;
    render();
  }

  // ---------- Journal / Activity ----------

  async function loadJournal() {
    try {
      const res = await window.centraid.read({ query: 'journal', input: {} });
      state.journalData = res?.vaultDenied ? { entries: [] } : (res ?? { entries: [] });
    } catch {
      state.journalData = { entries: [] };
    }
  }
  async function loadDashboard() {
    try {
      const res = await window.centraid.read({ query: 'dashboard', input: {} });
      state.dashboardData = res?.vaultDenied ? { recent: [] } : (res ?? { recent: [] });
    } catch {
      state.dashboardData = { recent: [] };
    }
  }
  async function addJournalEntry(mood, text) {
    const outcome = await act('add-journal-entry', { mood, text });
    if (!narrate(outcome)) return false;
    toast('Entry added · receipted.');
    await loadJournal();
    renderRows();
    return true;
  }

  // ---------- Navigation ----------

  async function selectNav(nav) {
    state.nav = nav;
    clearSelection();
    state.detailsId = null;
    state.detailPerson = null;
    state.search = '';
    state.searchResults = null;
    $('searchInput').value = '';
    state.chip = 'all';
    state.newMenuOpen = false;
    state.creatingCircle = false;
    state.renamingCircleId = null;
    if (state.narrow) $('root').classList.remove('side-open');
    renderDetails();
    if (nav.kind === 'journal') await loadJournal();
    if (nav.kind === 'activity') await loadDashboard();
    render();
  }

  async function showMorePeople() {
    state.peopleWindow += 200;
    await refresh();
  }

  return {
    notice,
    narrate,
    act,
    currentRows,
    clearSelection,
    toggleSelect,
    toggleAllVisible,
    clearSelected,
    openPersonMenu,
    toggleStar,
    movePerson,
    logInteraction,
    favoriteSelected,
    createCircle,
    renameCircle,
    deleteCircle,
    startRenameCircle,
    cancelCreateCircle,
    cancelRenameCircle,
    openDetails,
    closeDetails,
    loadDetail,
    toggleAdder,
    drawerAct,
    addPerson,
    openAddModal,
    closeAddModal,
    startCreateCircle,
    loadJournal,
    loadDashboard,
    addJournalEntry,
    selectNav,
    showMorePeople,
  };
}
