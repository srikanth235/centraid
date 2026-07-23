// Non-visual business logic: vault IO (write/act), row derivation, selection,
// the kebab/move-to-list popover (stays plain DOM, built with kit's
// `h()`/`popItem()` — no React root needed there), every person/list write,
// the profile drawer's load/reload + "+ add" write helper, journal/activity
// reads, and navigation state transitions. `createLogic()` is a factory
// app.tsx calls once at boot, closing over the exact `state`/`data` objects
// app.tsx owns (passed by reference: app.tsx mutates their properties in
// place, never reassigns the bindings, so this module always sees the live
// values) plus the render entry points only app.tsx can define. Everything
// returned here is then wired into app.tsx's render functions and JSX props,
// exactly like any other value flowing down. Same factory pattern as
// tasks/logic.ts and notes/logic.ts.
import {
  closePopover,
  h,
  openPopover,
  outcomeMessage,
  popItem,
  runBulk as runBulkBase,
  toast,
} from './kit.ts';
import { PALETTE, listColor, daysSince, daysUntilAnnual, statusOf } from './format.ts';
import type {
  DashboardData,
  DetailPerson,
  JournalData,
  LogicDeps,
  Nav,
  Person,
  PersonList,
} from './types.ts';

const $ = (id: string) => document.getElementById(id)!;

export function createLogic({
  state,
  data,
  render,
  refresh,
  renderRows,
  renderDetails,
  renderModal,
  renderNewMenu,
}: LogicDeps) {
  function notice(text: string) {
    const b = $('noticeBanner');
    b.textContent = text || '';
    b.hidden = !text;
  }

  // Returns true when the write executed; otherwise narrates the outcome and
  // returns false.
  function narrate(outcome: VaultOutcome | undefined): boolean {
    if (outcome?.status === 'executed') {
      notice('');
      return true;
    }
    notice(outcomeMessage(outcome) ?? '');
    return false;
  }

  async function act(
    action: string,
    input: Record<string, unknown>,
  ): Promise<VaultOutcome | undefined> {
    try {
      return await window.centraid.write({ action, input });
    } catch (err) {
      notice(err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  // ---------- Row derivation (client-side, like the prototype's in-memory list) ----------

  function currentRows(): Person[] {
    const { nav, chip, search } = state;
    let base: Person[];
    if (search.trim()) {
      base = state.searchResults ?? [];
    } else {
      base = data.people.slice();
      if (nav.kind === 'reconnect')
        base = base.filter((p) => daysSince(p) >= (p.cadence_days ?? 30));
      else if (nav.kind === 'upcoming') base = base.filter((p) => (p.reminders || []).length > 0);
      else if (nav.kind === 'starred') base = base.filter((p) => p.starred);
      else if (nav.kind === 'list') base = base.filter((p) => (p.list_id ?? null) === nav.listId);
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
      const near = (p: Person) =>
        Math.min(...(p.reminders || []).map((d) => daysUntilAnnual(d.month_day)), 999);
      return base.slice().sort((a, b) => near(a) - near(b));
    }
    const dir = state.sortDir;
    return base.slice().sort((a, b) => {
      let r: number;
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
  function toggleSelect(id: string) {
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    render();
  }
  function toggleAllVisible(rows: Person[], allSelected: boolean) {
    if (allSelected) for (const p of rows) state.selected.delete(p.party_id);
    else for (const p of rows) state.selected.add(p.party_id);
    render();
  }
  function clearSelected() {
    clearSelection();
    render();
  }

  // ---------- Popover (kebab + move-to-list) ----------
  // Reused for both the row kebab menu and the drawer's "Move to list"
  // button (same target list), exactly as the old version did.

  function openPersonMenu(anchor: HTMLElement, p: Person) {
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
        h('p', { class: 'kit-popover-head' }, 'Move to list'),
        popItem(
          'No list',
          () => {
            closePopover();
            movePerson(p, null, 'no list');
          },
          { disabled: p.list_id == null, dotColor: 'var(--ink-3)' },
        ),
        ...data.lists.map((c) =>
          popItem(
            c.name,
            () => {
              closePopover();
              movePerson(p, c.list_id, c.name);
            },
            { disabled: p.list_id === c.list_id, dotColor: listColor(c.list_id) },
          ),
        ),
      );
    });
  }

  // ---------- Person writes ----------

  // refresh() re-renders the open drawer, but from the stale `detailPerson`
  // snapshot — so any write that can land while the drawer is open on the
  // same person must also reload the detail read, or the drawer keeps
  // showing the pre-write state (star glyph, list, history) until it's
  // closed and reopened.
  async function reloadOpenDetail(partyId: string) {
    if (state.detailsId === partyId) await loadDetail(partyId);
  }

  async function toggleStar(p: Person | DetailPerson) {
    const outcome = await act(p.starred ? 'unstar-person' : 'star-person', {
      party_id: p.party_id,
    });
    if (!narrate(outcome)) return;
    toast(p.starred ? 'Favorite removed · receipted.' : 'Favorited · receipted.');
    await refresh();
    await reloadOpenDetail(p.party_id);
  }

  async function movePerson(p: Person | DetailPerson, listId: string | null, name: string) {
    const input = { party_id: p.party_id, ...(listId == null ? {} : { list_id: listId }) };
    const outcome = await act('move-person', input);
    if (!narrate(outcome)) return;
    toast(`Moved to ${name} · receipted.`);
    await refresh();
    await reloadOpenDetail(p.party_id);
  }

  async function logInteraction(p: DetailPerson, kind: string, text: string) {
    const outcome = await act('log-interaction', { party_id: p.party_id, kind, text });
    if (!narrate(outcome)) return;
    toast(`Logged · receipted.`);
    await refresh();
    await reloadOpenDetail(p.party_id);
  }

  // Bulk actions run through the kit's runBulk with the app's own voice.
  const bulkOpts = {
    notice,
    friendly: (outcome: VaultOutcome | undefined) => outcome?.reason ?? outcome?.predicate ?? null,
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

  // ---------- List writes ----------

  async function createList(name: string) {
    const outcome = await act('create-list', { name });
    if (narrate(outcome)) {
      state.creatingList = false;
      toast(`List "${name}" created · receipted.`);
      await refresh();
    } else {
      render();
    }
  }
  async function renameList(listId: string, name: string) {
    const outcome = await act('rename-list', { list_id: listId, name });
    if (narrate(outcome)) {
      state.renamingListId = null;
      toast('List renamed · receipted.');
      await refresh();
    } else {
      render();
    }
  }
  async function deleteList(list: PersonList) {
    const outcome = await act('delete-list', { list_id: list.list_id });
    if (narrate(outcome)) {
      if (state.nav.kind === 'list' && state.nav.listId === list.list_id)
        state.nav = { kind: 'all' };
      toast('List deleted · receipted.');
      await refresh();
    }
  }
  function startRenameList(listId: string) {
    state.renamingListId = listId;
    render();
  }
  function cancelCreateList() {
    state.creatingList = false;
    render();
  }
  function cancelRenameList() {
    state.renamingListId = null;
    render();
  }

  // ---------- Profile drawer ----------

  async function openDetails(id: string) {
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
  async function loadDetail(id: string) {
    try {
      const res = await window.centraid.read<{ person?: DetailPerson; vaultDenied?: unknown }>({
        query: 'person',
        input: { party_id: id },
      });
      if (res?.vaultDenied) return;
      if (state.detailsId !== id) return;
      state.detailPerson = res?.person ?? null;
      renderDetails();
    } catch (err) {
      notice(err instanceof Error ? err.message : String(err));
    }
  }
  function toggleAdder(key: string) {
    state.detailAdders[key] = !state.detailAdders[key];
    renderDetails();
  }

  // Returns true when the write executed (the AddRows components clear their
  // own fields only then — a failed/parked write leaves the typed draft in
  // place instead of silently discarding it).
  async function drawerAct(
    action: string,
    input: Record<string, unknown>,
    message: string,
  ): Promise<boolean> {
    const outcome = await act(action, input);
    if (!narrate(outcome)) return false;
    toast(`${message} · receipted.`);
    await refresh();
    if (state.detailsId) await loadDetail(state.detailsId);
    return true;
  }

  // ---------- Add-person modal ----------

  async function addPerson({
    name,
    role,
    listId,
    cadence,
  }: {
    name: string;
    role: string;
    listId: string | null;
    cadence: number;
  }): Promise<boolean> {
    const avatar_color = PALETTE[data.people.length % PALETTE.length];
    const input = {
      display_name: name,
      cadence_days: cadence,
      avatar_color,
      ...(role ? { role } : {}),
      ...(listId != null ? { list_id: listId } : {}),
    };
    const outcome = await act('add-person', input);
    if (!narrate(outcome)) return false;
    state.addModalOpen = false;
    renderModal();
    toast('Added · receipted.');
    await refresh();
    const newId = outcome?.output?.party_id;
    if (typeof newId === 'string') await openDetails(newId);
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
  function startCreateList() {
    state.newMenuOpen = false;
    renderNewMenu();
    state.creatingList = true;
    render();
  }

  // ---------- Journal / Activity ----------

  async function loadJournal() {
    try {
      const res = await window.centraid.read<JournalData & { vaultDenied?: unknown }>({
        query: 'journal',
        input: {},
      });
      state.journalData = res?.vaultDenied ? { entries: [] } : (res ?? { entries: [] });
    } catch {
      state.journalData = { entries: [] };
    }
  }
  async function loadDashboard() {
    try {
      const res = await window.centraid.read<DashboardData & { vaultDenied?: unknown }>({
        query: 'dashboard',
        input: {},
      });
      state.dashboardData = res?.vaultDenied ? { recent: [] } : (res ?? { recent: [] });
    } catch {
      state.dashboardData = { recent: [] };
    }
  }
  async function addJournalEntry(mood: string, text: string): Promise<boolean> {
    const outcome = await act('add-journal-entry', { mood, text });
    if (!narrate(outcome)) return false;
    toast('Entry added · receipted.');
    await loadJournal();
    renderRows();
    return true;
  }

  // ---------- Navigation ----------

  async function selectNav(nav: Nav) {
    state.nav = nav;
    clearSelection();
    state.detailsId = null;
    state.detailPerson = null;
    state.search = '';
    state.searchResults = null;
    ($('searchInput') as HTMLInputElement).value = '';
    state.chip = 'all';
    state.newMenuOpen = false;
    state.creatingList = false;
    state.renamingListId = null;
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
    createList,
    renameList,
    deleteList,
    startRenameList,
    cancelCreateList,
    cancelRenameList,
    openDetails,
    closeDetails,
    loadDetail,
    toggleAdder,
    drawerAct,
    addPerson,
    openAddModal,
    closeAddModal,
    startCreateList,
    loadJournal,
    loadDashboard,
    addJournalEntry,
    selectNav,
    showMorePeople,
  };
}
