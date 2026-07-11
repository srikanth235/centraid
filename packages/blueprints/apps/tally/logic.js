// Non-visual business logic: vault IO (write/act/read), navigation, the
// people directory, and every modal's open/patch/save/close flow (expense,
// detail, settle, new-group, add-friend). `createLogic` closes over app.jsx's
// own `state`/`dash` (mutated in place, never reassigned) plus the
// render/renderModals/loadView/refreshAll entry points app.jsx defines — the
// same factory shape tasks/logic.js and notes/logic.js use.
//
// Every modal's fields (state.expense/settle/newGroup/addFriend) stay a
// plain mutable object patched via `Object.assign` + a full modal re-render,
// exactly like the original Lit app's `setE()` — the components are pure
// functions of that object, so a controlled input's `value` prop simply
// tracks it (no React `useState` needed for these, no Lit `live()` needed
// either: a full re-render already keeps the DOM in sync on every keystroke).
import { debounce, outcomeMessage, toast } from './kit.js';
import { FRIEND_COLORS, first, resolveSplits, toCents, todayKey } from './format.js';

export function createLogic({ state, dash, render, renderModals, loadView, refreshAll }) {
  const $ = (id) => document.getElementById(id);

  // ---------- Notice / consent narration ----------

  function notice(text) {
    const b = $('noticeBanner');
    b.textContent = text || '';
    b.hidden = !text;
  }

  // Returns true when the write executed; otherwise narrates parked / failed /
  // denied honestly and returns false.
  function narrate(outcome) {
    if (outcome?.status === 'executed') {
      notice('');
      return true;
    }
    notice(outcomeMessage(outcome) ?? 'The write did not go through.');
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

  async function read(query, input) {
    return window.centraid.read({ query, input: input ?? {} });
  }

  function applyDenied(denied) {
    $('consentBanner').hidden = false;
    $('consentDetail').textContent = denied.message ?? '';
    $('root').classList.add('denied');
  }

  // ---------- People lookups (from the loaded snapshots) ----------

  // A directory of everyone we know about across the loaded snapshots, so any
  // party id resolves to a name/color/initials even outside its home view.
  function directory() {
    const map = new Map();
    const put = (p) => {
      if (p && p.party_id && !map.has(p.party_id)) map.set(p.party_id, p);
    };
    for (const f of dash.friends) put(f);
    for (const m of state.modalMembers) put(m);
    if (state.viewData) {
      for (const m of state.viewData.members ?? []) put(m);
      if (state.viewData.friend) put(state.viewData.friend);
    }
    if (dash.me && !map.has(dash.me))
      map.set(dash.me, { party_id: dash.me, name: 'You', color: '#0FA678', initials: 'You' });
    return map;
  }
  function personOf(pid) {
    return directory().get(pid) || { party_id: pid, name: 'Someone', color: '#5C677D', initials: '?' };
  }
  function displayName(pid) {
    return pid === dash.me ? 'You' : personOf(pid).name;
  }
  function shortName(pid) {
    return pid === dash.me ? 'you' : first(personOf(pid).name);
  }

  // ---------- View navigation ----------

  function setNav(patch) {
    Object.assign(state, patch);
    state.detail = null;
    if (state.narrow) $('root').classList.remove('side-open');
    loadView();
  }

  // ---------- Search ----------

  let searchSeq = 0;
  const applySearch = debounce(async () => {
    const q = $('searchInput').value.trim();
    if (q === state.search) return;
    state.search = q;
    const seq = ++searchSeq;
    if (!q) {
      state.viewData = null;
      await loadView();
      return;
    }
    render(); // paint the "Results for…" chrome + skeleton
    let res = null;
    try {
      res = await read('search', { term: q });
    } catch {
      res = { results: [] };
    }
    if (seq !== searchSeq) return;
    if (res?.me) dash.me = res.me;
    state.viewData = res;
    render();
  }, 150);

  function clearSearch() {
    const input = $('searchInput');
    if (!input.value && !state.search) return;
    input.value = '';
    searchSeq += 1;
    state.search = '';
    loadView();
  }

  // ---------- Expense detail popover ----------

  function openDetail(row) {
    state.detail = row;
    renderModals();
  }
  function closeDetail() {
    state.detail = null;
    renderModals();
  }

  // ---------- Add / edit expense modal ----------

  // Load a group's members into state.modalMembers, then re-render the modal.
  async function loadModalMembers(groupId) {
    try {
      const res = await read('group', { group_id: groupId });
      if (res?.me) dash.me = res.me;
      state.modalMembers = res?.members ?? [];
    } catch {
      state.modalMembers = [];
    }
    renderModals();
  }

  async function openAddExpense() {
    closeAllModals();
    // Default to the active group, else the first group.
    const gid = state.view === 'group' ? state.groupId : dash.groups[0]?.group_id;
    if (!gid) {
      notice('Create a group first — expenses live inside a group.');
      return;
    }
    state.expense = {
      mode: 'new',
      groupId: gid,
      desc: '',
      amount: '',
      paidBy: dash.me,
      method: 'equal',
      category: 'general',
      spent_on: todayKey(),
      include: new Set(),
      exact: {},
      percent: {},
    };
    await loadModalMembers(gid);
    // Include everyone by default.
    state.expense.include = new Set(state.modalMembers.map((m) => m.party_id));
    renderModals();
  }

  async function openEditExpense(row) {
    closeAllModals();
    const include = new Set((row.splits ?? []).map((s) => s.party_id));
    const exact = {};
    for (const s of row.splits ?? []) exact[s.party_id] = (s.share_minor / 100).toFixed(2);
    state.expense = {
      mode: 'edit',
      expense_id: row.expense_id,
      groupId: row.group_id,
      desc: row.description,
      amount: (row.amount_minor / 100).toFixed(2),
      paidBy: row.paid_by,
      method: 'exact', // edit lands on exact so the existing shares show
      category: row.category || 'general',
      spent_on: row.spent_on || todayKey(),
      include,
      exact,
      percent: {},
    };
    await loadModalMembers(row.group_id);
    renderModals();
  }

  function closeExpense() {
    state.expense = null;
    renderModals();
  }
  function setExpense(patch) {
    Object.assign(state.expense, patch);
    renderModals();
  }
  // The expense modal's Group select: switching groups reloads that group's
  // members, resets who's included to "everyone", and falls back paid-by to
  // "me" if the previous payer isn't a member of the newly-chosen group.
  async function setExpenseGroup(groupId) {
    state.expense.groupId = groupId;
    await loadModalMembers(groupId);
    state.expense.include = new Set(state.modalMembers.map((m) => m.party_id));
    if (!state.modalMembers.some((m) => m.party_id === state.expense.paidBy)) state.expense.paidBy = dash.me;
    renderModals();
  }

  async function saveExpense() {
    const exp = state.expense;
    const cents = toCents(exp.amount);
    const splits = resolveSplits(exp, cents, state.modalMembers);
    if (!exp.desc.trim() || !(cents > 0) || !splits) return;
    const base = {
      description: exp.desc.trim(),
      amount_minor: cents,
      paid_by: exp.paidBy,
      category: exp.category,
      spent_on: exp.spent_on,
      splits,
    };
    let outcome;
    if (exp.mode === 'edit') outcome = await act('edit-expense', { expense_id: exp.expense_id, ...base });
    else outcome = await act('add-expense', { group_id: exp.groupId, ...base });
    if (!narrate(outcome)) return;
    toast(exp.mode === 'edit' ? 'Expense updated · receipted.' : 'Expense added · receipted.');
    closeExpense();
    await refreshAll();
  }

  async function deleteExpense(expenseId) {
    const outcome = await act('delete-expense', { expense_id: expenseId });
    if (!narrate(outcome)) return;
    toast('Expense deleted · receipted.');
    closeAllModals();
    // closeAllModals() only nulls the state — every other caller follows it
    // with its own renderModals(), and render()/refreshAll() never touch
    // #modalRoot, so without this the detail/edit modal for the now-deleted
    // expense stays painted on screen until something else repaints modals.
    renderModals();
    await refreshAll();
  }

  // ---------- Settle up ----------

  async function openSettle() {
    closeAllModals();
    if (state.view === 'group' && state.groupId) {
      await loadModalMembers(state.groupId);
      const other = state.modalMembers.find((m) => m.party_id !== dash.me);
      state.settle = {
        people: state.modalMembers,
        from: other?.party_id ?? dash.me,
        to: dash.me,
        amount: '',
        groupId: state.groupId,
      };
    } else if (state.view === 'friend' && state.viewData?.friend) {
      const f = state.viewData.friend;
      state.modalMembers = [
        { party_id: dash.me, name: 'You', color: '#0FA678', initials: 'You', is_me: true },
        f,
      ];
      state.settle = {
        people: state.modalMembers,
        from: f.party_id,
        to: dash.me,
        amount: '',
        groupId: null,
      };
    } else {
      return;
    }
    renderModals();
  }
  function closeSettle() {
    state.settle = null;
    renderModals();
  }
  function setSettle(patch) {
    Object.assign(state.settle, patch);
    renderModals();
  }

  async function saveSettle() {
    const st = state.settle;
    const cents = toCents(st.amount);
    if (!(cents > 0) || st.from === st.to) return;
    const input = { from_party: st.from, to_party: st.to, amount_minor: cents, paid_on: todayKey() };
    if (st.groupId) input.group_id = st.groupId;
    const outcome = await act('settle-up', input);
    if (!narrate(outcome)) return;
    toast('Payment recorded · receipted.');
    closeSettle();
    await refreshAll();
  }

  // ---------- New group ----------

  function openNewGroup() {
    closeAllModals();
    if (dash.friends.length === 0) {
      notice('Add a friend first — a group needs at least one other member.');
      openAddFriend();
      return;
    }
    state.newGroup = { name: '', icon: '🏠', members: new Set() };
    renderModals();
  }
  function closeNewGroup() {
    state.newGroup = null;
    renderModals();
  }
  function setNewGroup(patch) {
    Object.assign(state.newGroup, patch);
    renderModals();
  }

  async function saveNewGroup() {
    const ng = state.newGroup;
    if (!ng.name.trim() || ng.members.size < 1) return;
    const outcome = await act('create-group', {
      name: ng.name.trim(),
      icon: ng.icon,
      color: '#0FA678',
      member_ids: [...ng.members],
    });
    if (!narrate(outcome)) return;
    const gid = outcome?.output?.group_id;
    toast('Group created · receipted.');
    closeNewGroup();
    await refreshAll();
    if (gid) setNav({ view: 'group', groupId: gid, search: '' });
  }

  // ---------- Add friend (REQUIRED — a fresh vault starts empty) ----------

  function openAddFriend() {
    closeAllModals();
    state.addFriend = { name: '', color: FRIEND_COLORS[dash.friends.length % FRIEND_COLORS.length] };
    renderModals();
  }
  function closeAddFriend() {
    state.addFriend = null;
    renderModals();
  }
  function setAddFriend(patch) {
    Object.assign(state.addFriend, patch);
    renderModals();
  }

  async function saveAddFriend() {
    const af = state.addFriend;
    if (!af.name.trim()) return;
    const outcome = await act('add-friend', { name: af.name.trim(), avatar_color: af.color });
    if (!narrate(outcome)) return;
    toast('Friend added · receipted.');
    closeAddFriend();
    await refreshAll();
  }

  // ---------- Modal helpers ----------

  function closeAllModals() {
    state.detail = null;
    state.expense = null;
    state.settle = null;
    state.newGroup = null;
    state.addFriend = null;
  }
  function anyModalOpen() {
    return !!(state.detail || state.expense || state.settle || state.newGroup || state.addFriend);
  }

  return {
    notice,
    narrate,
    act,
    read,
    applyDenied,
    directory,
    personOf,
    displayName,
    shortName,
    setNav,
    applySearch,
    clearSearch,
    openDetail,
    closeDetail,
    loadModalMembers,
    openAddExpense,
    openEditExpense,
    closeExpense,
    setExpense,
    setExpenseGroup,
    saveExpense,
    deleteExpense,
    openSettle,
    closeSettle,
    setSettle,
    saveSettle,
    openNewGroup,
    closeNewGroup,
    setNewGroup,
    saveNewGroup,
    openAddFriend,
    closeAddFriend,
    setAddFriend,
    saveAddFriend,
    closeAllModals,
    anyModalOpen,
  };
}
