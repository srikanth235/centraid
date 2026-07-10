// governance: allow-repo-hygiene file-size-limit blueprints are single-file by design (read wholesale by one agent); Tally is a finished expense splitter — sidebar, dashboard, group/friend ledgers, activity, add/edit/settle/new-group/add-friend modals — and splitting it would break that "one file" contract.
// Tally — split, settled, as a projection over the personal vault. A friend is
// a canonical core.party; a group is a tally.group with one member row per
// party (you included); an expense stores its resolved splits. Balances are
// NEVER stored — they are derived server-side by the balance engine and this
// client just fetches + renders them. All money crosses the wire as INTEGER
// minor units (cents); the app formats it and, on the way out, resolves the
// chosen split mode (equally / exact / percent) into an integer splits array.
// Every write is a typed vault command — consent-checked and receipted. The
// app stores nothing of its own: revoke the grant and this page goes dark.

import {
  armConfirm,
  debounce,
  fmtMoney,
  letterAvatar,
  localDayKey,
  outcomeMessage,
  readFailed,
  showSkeleton,
  toast,
  wireThemeToggle,
} from './kit.js';

const $ = (id) => document.getElementById(id);

// ---------- Constants ----------

const MS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The closed category set — emoji + tint, straight from the prototype.
const CATS = {
  food: { icon: '🍔', color: '#E2603A' },
  groceries: { icon: '🛒', color: '#57A55A' },
  rent: { icon: '🏠', color: '#4E68DD' },
  utilities: { icon: '💡', color: '#E8923C' },
  transport: { icon: '🚕', color: '#3AA6B9' },
  fun: { icon: '🎬', color: '#7C5BD9' },
  travel: { icon: '✈️', color: '#0FA678' },
  shopping: { icon: '🛍️', color: '#E0567A' },
  general: { icon: '🧾', color: '#5C677D' },
};
const CAT_LIST = [
  'food',
  'groceries',
  'rent',
  'utilities',
  'transport',
  'fun',
  'travel',
  'shopping',
  'general',
];
const GROUP_ICONS = ['🏠', '✈️', '🎲', '🍽️', '🏖️', '🎉', '🏔️', '🚗'];
const FRIEND_COLORS = [
  '#7C5BD9',
  '#4E68DD',
  '#E0567A',
  '#E8923C',
  '#2EA098',
  '#3AA6B9',
  '#57A55A',
  '#D9536F',
];

const CHECK_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 6"/></svg>';

function cat(c) {
  return CATS[c] || CATS.general;
}
function tint(color) {
  return `color-mix(in oklab, ${color || '#5C677D'} 16%, transparent)`;
}

// ---------- Formatting (money is minor units end-to-end) ----------

// Absolute value, localized via the kit — the dashboard's currency, not a
// hardcoded "$" (callers phrase direction themselves: "owes you …").
function money(minor) {
  return fmtMoney(Math.abs(Number(minor ?? 0)), dash.currency || 'USD');
}
// Parse a decimal-dollar string → integer cents.
function toCents(str) {
  const n = parseFloat(str);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}
function todayKey() {
  return localDayKey(new Date());
}
function first(name) {
  return String(name ?? '').split(/\s+/)[0] || name || '';
}

// ---------- State ----------

// The sidebar/dashboard snapshot (dashboard query) plus `me`.
let dash = {
  me: null,
  currency: 'USD',
  friends: [],
  groups: [],
  owe_total_minor: 0,
  owed_total_minor: 0,
};
let me = null;

const state = {
  view: 'dashboard', // dashboard | activity | group | friend
  groupId: null,
  friendId: null,
  search: '',
  narrow: false,
  // The currently-loaded detail payload for the active view (group/friend/activity/search).
  viewData: null,
  // Open surfaces.
  detail: null, // a ledger row
  expense: null, // add/edit form model
  settle: null,
  newGroup: null,
  addFriend: null,
  // Members of the group chosen in the expense/settle modal (fetched on demand).
  modalMembers: [],
};

let searchSeq = 0;

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
  if (me && !map.has(me))
    map.set(me, { party_id: me, name: 'You', color: '#0FA678', initials: 'You' });
  return map;
}
function personOf(pid) {
  return (
    directory().get(pid) || { party_id: pid, name: 'Someone', color: '#5C677D', initials: '?' }
  );
}
function displayName(pid) {
  return pid === me ? 'You' : personOf(pid).name;
}
function shortName(pid) {
  return pid === me ? 'you' : first(personOf(pid).name);
}

// ---------- Split resolution → minor-unit splits array ----------

// Port of the prototype's computeSplits, in cents. `include` is a Set of
// party ids; exact/percent are maps of party_id → decimal-string. Returns
// [{party_id, share_minor}] summing to amountCents, or null if invalid. The
// rounding remainder always lands on the last participant.
function resolveSplits(model, amountCents) {
  const parts = state.modalMembers.map((m) => m.party_id).filter((id) => model.include.has(id));
  if (parts.length === 0 || !(amountCents > 0)) return null;
  const out = [];
  if (model.method === 'equal') {
    const per = Math.round(amountCents / parts.length);
    let acc = 0;
    parts.forEach((id, i) => {
      const share = i === parts.length - 1 ? amountCents - acc : per;
      out.push({ party_id: id, share_minor: share });
      acc += share;
    });
  } else if (model.method === 'exact') {
    let sum = 0;
    for (const id of parts) {
      const c = toCents(model.exact[id]) || 0;
      out.push({ party_id: id, share_minor: c });
      sum += c;
    }
    if (Math.abs(sum - amountCents) > 1) return null; // allow a single-cent rounding wobble
  } else {
    // percent
    let pctSum = 0;
    for (const id of parts) pctSum += parseFloat(model.percent[id]) || 0;
    if (Math.abs(pctSum - 100) > 0.1) return null;
    let acc = 0;
    parts.forEach((id, i) => {
      const share =
        i === parts.length - 1
          ? amountCents - acc
          : Math.round((amountCents * (parseFloat(model.percent[id]) || 0)) / 100);
      out.push({ party_id: id, share_minor: share });
      acc += share;
    });
  }
  return out;
}

// ---------- View navigation ----------

function setNav(patch) {
  Object.assign(state, patch);
  state.detail = null;
  if (state.narrow) $('root').classList.remove('side-open');
  loadView();
}

// Fetch the payload for the active view, then render.
async function loadView() {
  state.viewData = null;
  render(); // paint chrome + a skeleton immediately
  try {
    if (state.view === 'group' && state.groupId) {
      state.viewData = await read('group', { group_id: state.groupId });
    } else if (state.view === 'friend' && state.friendId) {
      state.viewData = await read('friend', { party_id: state.friendId });
    } else if (state.view === 'activity') {
      state.viewData = await read('activity');
    } else if (state.search.trim()) {
      state.viewData = await read('search', { term: state.search.trim() });
    }
  } catch (err) {
    notice(String(err?.message ?? err));
  }
  if (state.viewData?.me) me = state.viewData.me;
  if (state.viewData?.vaultDenied) return applyDenied(state.viewData.vaultDenied);
  render();
}

// ---------- Sidebar render ----------

function navItem({ icon, label, active, onClick }) {
  const item = h('button', {
    type: 'button',
    class: 's-nav-item',
    'aria-current': String(!!active),
    onclick: onClick,
  });
  item.appendChild(el(icon));
  item.appendChild(h('span', { class: 'lbl' }, label));
  return item;
}

function balLabelFriend(v) {
  if (Math.abs(v) < 1) return { cls: 'muted', label: 'settled up' };
  return v > 0
    ? { cls: 'pos', label: 'owes you ' + money(v) }
    : { cls: 'neg', label: 'you owe ' + money(v) };
}
function balLabelGroup(v) {
  if (Math.abs(v) < 1) return { cls: 'muted', label: 'settled up' };
  return v > 0
    ? { cls: 'pos', label: 'you are owed ' + money(v) }
    : { cls: 'neg', label: 'you owe ' + money(v) };
}

function renderSidebar() {
  const nav = $('smartNav');
  nav.replaceChildren(
    navItem({
      icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/></svg>',
      label: 'Dashboard',
      active: state.view === 'dashboard',
      onClick: () => setNav({ view: 'dashboard', search: '' }),
    }),
    navItem({
      icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2 6 4-14 2 8h6"/></svg>',
      label: 'Activity',
      active: state.view === 'activity',
      onClick: () => setNav({ view: 'activity', search: '' }),
    }),
  );

  const groupsNav = $('groupsNav');
  groupsNav.replaceChildren();
  for (const g of dash.groups) {
    const { cls, label } = balLabelGroup(g.owner_net_minor);
    const item = h(
      'button',
      {
        type: 'button',
        class: 's-listitem',
        'aria-current': String(state.view === 'group' && state.groupId === g.group_id),
        onclick: () => setNav({ view: 'group', groupId: g.group_id, search: '' }),
      },
      h('span', { class: 's-gicon', style: `background:${tint(g.color)};` }, g.icon || '👥'),
      h(
        'span',
        { class: 's-li-main' },
        h('span', { class: 's-li-name' }, g.name),
        h('span', { class: `s-li-sub ${cls}` }, label),
      ),
    );
    groupsNav.appendChild(item);
  }

  const friendsNav = $('friendsNav');
  friendsNav.replaceChildren();
  for (const f of dash.friends) {
    const { cls, label } = balLabelFriend(f.net_minor);
    const item = h(
      'button',
      {
        type: 'button',
        class: 's-listitem',
        'aria-current': String(state.view === 'friend' && state.friendId === f.party_id),
        onclick: () => setNav({ view: 'friend', friendId: f.party_id, search: '' }),
      },
      letterAvatar(f.name, { size: '28px', color: f.color, initials: f.initials }),
      h(
        'span',
        { class: 's-li-main' },
        h('span', { class: 's-li-name' }, f.name),
        h('span', { class: `s-li-sub ${cls}` }, label),
      ),
    );
    friendsNav.appendChild(item);
  }
}

// ---------- Topbar render ----------

function renderTopbar() {
  const av = $('headAv');
  const title = $('activeTitle');
  const sub = $('activeSub');
  const settleBtn = $('settleBtn');
  av.hidden = true;
  settleBtn.hidden = true;

  if (state.search.trim()) {
    title.textContent = `Results for “${state.search.trim()}”`;
    const n = state.viewData?.results?.length ?? 0;
    sub.textContent = `${n} match${n === 1 ? '' : 'es'}`;
    return;
  }
  if (state.view === 'group' && state.viewData?.group) {
    const g = state.viewData.group;
    av.hidden = false;
    av.style.background = g.color || '#0FA678';
    av.textContent = g.icon || '👥';
    title.textContent = g.name;
    const n = state.viewData.members?.length ?? 0;
    sub.textContent = `${n} member${n === 1 ? '' : 's'}`;
    settleBtn.hidden = false;
    return;
  }
  if (state.view === 'friend' && state.viewData?.friend) {
    const f = state.viewData.friend;
    av.hidden = false;
    av.style.background = f.color || '#5C677D';
    av.textContent = f.initials;
    title.textContent = f.name;
    const v = f.net_minor;
    sub.textContent =
      Math.abs(v) < 1
        ? 'You are settled up'
        : v > 0
          ? `${first(f.name)} owes you ${money(v)}`
          : `You owe ${first(f.name)} ${money(v)}`;
    settleBtn.hidden = false;
    return;
  }
  if (state.view === 'activity') {
    title.textContent = 'Activity';
    sub.textContent = 'Expenses and settlements, newest first';
    return;
  }
  title.textContent = 'Dashboard';
  sub.textContent = 'Your balances at a glance';
}

// ---------- Main content render ----------

function render() {
  renderSidebar();
  renderTopbar();
  setThemeIcon();
  const wrap = $('wrap');
  wrap.replaceChildren();

  if (state.search.trim()) return renderSearch(wrap);
  if (state.view === 'dashboard') return renderDashboard(wrap);
  if (state.view === 'activity') return renderActivity(wrap);
  if (state.view === 'group' || state.view === 'friend') return renderLedger(wrap);
}

function skeletonList(wrap) {
  const box = h('div', { class: 's-explist' });
  showSkeleton(box, 5);
  wrap.appendChild(box);
}

// ---------- Dashboard ----------

function balRow(p, kind) {
  const amtCls = kind === 'owe' ? 'neg' : 'pos';
  return h(
    'button',
    {
      type: 'button',
      class: 's-bal-row',
      onclick: () => setNav({ view: 'friend', friendId: p.party_id, search: '' }),
    },
    letterAvatar(p.name, { size: '34px', color: p.color, initials: p.initials }),
    h(
      'span',
      { class: 's-bal-main' },
      h('span', { class: 's-bal-name' }, p.name),
      h('span', { class: 's-bal-sub' }, kind === 'owe' ? 'you owe' : 'owes you'),
    ),
    h('span', { class: `s-bal-amt ${amtCls}` }, money(p.net_minor)),
  );
}

function renderDashboard(wrap) {
  const owed = dash.owed_total_minor;
  const owe = dash.owe_total_minor;
  const net = owed - owe;

  // A fresh vault: no friends and no groups — invite the first steps.
  if (dash.friends.length === 0 && dash.groups.length === 0) {
    wrap.appendChild(
      h(
        'div',
        { class: 's-dash-empty' },
        h('div', { class: 't' }, 'Welcome to Tally'),
        h(
          'div',
          { class: 'd' },
          'Add a friend, then create a group and start splitting shared costs. Balances update the moment you record an expense or a payment.',
        ),
        h(
          'div',
          { class: 'row' },
          h(
            'button',
            { type: 'button', class: 'kit-btn primary', onclick: openAddFriend },
            'Add a friend',
          ),
          h(
            'button',
            { type: 'button', class: 'kit-btn', onclick: openNewGroup },
            'Create a group',
          ),
        ),
      ),
    );
    return;
  }

  const netCls = Math.abs(net) < 1 ? '' : net > 0 ? 'pos' : 'neg';
  const netLabel = (net >= 0 ? '+' : '−') + money(net);
  wrap.appendChild(
    h(
      'div',
      { class: 's-summary' },
      h(
        'div',
        { class: 's-stat' },
        h('div', { class: 'k' }, 'Total balance'),
        h('div', { class: `v ${netCls}` }, netLabel),
      ),
      h(
        'div',
        { class: 's-stat' },
        h('div', { class: 'k' }, 'You owe'),
        h('div', { class: 'v neg' }, money(owe)),
      ),
      h(
        'div',
        { class: 's-stat' },
        h('div', { class: 'k' }, 'You are owed'),
        h('div', { class: 'v pos' }, money(owed)),
      ),
    ),
  );

  const oweList = dash.friends.filter((f) => f.net_minor < -1);
  const owedList = dash.friends.filter((f) => f.net_minor > 1);
  const cardOwe = h('div', { class: 's-card' }, h('div', { class: 's-card-h' }, 'You owe'));
  if (oweList.length === 0)
    cardOwe.appendChild(h('div', { class: 's-empty-row' }, "You're all settled up."));
  else for (const p of oweList) cardOwe.appendChild(balRow(p, 'owe'));
  const cardOwed = h('div', { class: 's-card' }, h('div', { class: 's-card-h' }, 'You are owed'));
  if (owedList.length === 0)
    cardOwed.appendChild(h('div', { class: 's-empty-row' }, 'Nobody owes you right now.'));
  else for (const p of owedList) cardOwed.appendChild(balRow(p, 'owed'));
  wrap.appendChild(h('div', { class: 's-cols' }, cardOwe, cardOwed));

  wrap.appendChild(h('div', { class: 's-section-title' }, 'Your groups'));
  if (dash.groups.length === 0) {
    wrap.appendChild(
      h(
        'div',
        { class: 's-card' },
        h(
          'div',
          { class: 's-empty-row', style: 'padding:28px 16px;' },
          'No groups yet. ',
          h(
            'button',
            {
              type: 'button',
              style:
                'border:none;background:none;color:var(--accd);font-weight:600;cursor:pointer;',
              onclick: openNewGroup,
            },
            'Create one',
          ),
          ' to start splitting.',
        ),
      ),
    );
    return;
  }
  const grid = h('div', { class: 's-groupgrid' });
  for (const g of dash.groups) {
    const { cls, label } = balLabelGroup(g.owner_net_minor);
    grid.appendChild(
      h(
        'button',
        {
          type: 'button',
          class: 's-gcard',
          onclick: () => setNav({ view: 'group', groupId: g.group_id, search: '' }),
        },
        h(
          'div',
          { class: 's-gcard-top' },
          h(
            'span',
            {
              class: 's-gicon',
              style: `width:38px;height:38px;font-size:19px;background:${tint(g.color)};`,
            },
            g.icon || '👥',
          ),
          h(
            'div',
            {},
            h('div', { class: 's-gcard-name' }, g.name),
            h(
              'div',
              { class: 's-gcard-mem' },
              `${g.member_count} member${g.member_count === 1 ? '' : 's'}`,
            ),
          ),
        ),
        h('div', { class: `s-gcard-bal ${cls}` }, label),
      ),
    );
  }
  wrap.appendChild(grid);
}

// ---------- Ledger (group / friend) ----------

// One expense row from a decorated ledger row (already carries splits).
function ledgerRow(row) {
  const c = cat(row.category);
  const d = new Date((row.spent_on || todayKey()) + 'T12:00:00');
  let rLabel, amt, cls, sub;
  if (row.your_role === 'lent') {
    rLabel = 'you lent';
    amt = money(row.your_amount_minor);
    cls = 'pos';
    sub = 'you paid ' + money(row.amount_minor);
  } else if (row.your_role === 'borrowed') {
    rLabel = 'you borrowed';
    amt = money(row.your_amount_minor);
    cls = 'neg';
    sub = first(row.paid_by_name) + ' paid ' + money(row.amount_minor);
  } else {
    rLabel = 'not involved';
    amt = money(row.amount_minor);
    cls = 'muted';
    sub = first(row.paid_by_name) + ' paid';
  }
  return h(
    'button',
    { type: 'button', class: 's-exrow', onclick: () => openDetail(row) },
    h(
      'span',
      { class: 's-exdate' },
      h('span', { class: 'mo' }, MS[d.getMonth()]),
      h('span', { class: 'dy' }, String(d.getDate())),
    ),
    h('span', { class: 's-excat', style: `background:${tint(c.color)};` }, c.icon),
    h(
      'span',
      { class: 's-exmain' },
      h('span', { class: 's-exdesc' }, row.description),
      h('span', { class: 's-exsub' }, sub),
    ),
    h(
      'span',
      { class: 's-exright' },
      h('span', { class: 's-exlabel' }, rLabel),
      h('span', { class: `s-examt ${cls}` }, amt),
    ),
  );
}

function renderLedger(wrap) {
  if (!state.viewData) return skeletonList(wrap);

  if (state.view === 'group') {
    const members = state.viewData.members ?? [];
    if (members.length) {
      const panel = h('div', { class: 's-balpanel' });
      for (const m of members) {
        const v = m.net_minor;
        const who = m.is_me ? 'You' : first(m.name);
        const verb = m.is_me ? { g: 'get back', o: 'owe' } : { g: 'gets back', o: 'owes' };
        const text =
          Math.abs(v) < 1
            ? `${who} — settled`
            : v > 0
              ? `${who} ${verb.g} ${money(v)}`
              : `${who} ${verb.o} ${money(v)}`;
        panel.appendChild(
          h(
            'span',
            { class: 's-balchip' },
            letterAvatar(m.name, { size: '22px', color: m.color, initials: m.initials }),
            h('span', {}, text),
          ),
        );
      }
      wrap.appendChild(panel);
    }
  }

  const ledger = state.viewData.ledger ?? [];
  if (ledger.length === 0) {
    wrap.appendChild(
      h(
        'div',
        { class: 's-explist' },
        h(
          'div',
          { class: 's-empty-row', style: 'padding:40px 16px;' },
          'No expenses yet. Add one to get started.',
        ),
      ),
    );
    return;
  }
  const list = h('div', { class: 's-explist' });
  for (const row of ledger) list.appendChild(ledgerRow(row));
  wrap.appendChild(list);
}

// ---------- Search ----------

function renderSearch(wrap) {
  if (!state.viewData) return skeletonList(wrap);
  const results = state.viewData.results ?? [];
  if (results.length === 0) {
    wrap.appendChild(
      h(
        'div',
        { class: 's-explist' },
        h(
          'div',
          { class: 's-empty-row', style: 'padding:40px 16px;' },
          `No expenses match “${state.search.trim()}”.`,
        ),
      ),
    );
    return;
  }
  const list = h('div', { class: 's-explist' });
  for (const row of results) {
    const item = ledgerRow(row);
    // Fold in the group name as the row sub, like the prototype does for search.
    const subEl = item.querySelector('.s-exsub');
    if (subEl && row.group_name) subEl.textContent = `${subEl.textContent} · ${row.group_name}`;
    list.appendChild(item);
  }
  wrap.appendChild(list);
}

// ---------- Activity ----------

function renderActivity(wrap) {
  if (!state.viewData) {
    const box = h('div', {});
    showSkeleton(box, 6);
    wrap.appendChild(box);
    return;
  }
  const items = state.viewData.activity ?? [];
  if (items.length === 0) {
    wrap.appendChild(
      h(
        'div',
        { class: 's-explist' },
        h(
          'div',
          { class: 's-empty-row', style: 'padding:40px 16px;' },
          'Nothing has happened yet.',
        ),
      ),
    );
    return;
  }
  for (const a of items) {
    const d = new Date((a.date || todayKey()) + 'T12:00:00');
    const when = `${MS[d.getMonth()]} ${d.getDate()}`;
    let icon,
      text,
      suffix = '',
      cls = 'muted';
    if (a.kind === 'expense') {
      icon = cat(a.category).icon;
      const who = a.paid_by === me ? 'You' : first(a.paid_by_name);
      text = `${who} added “${a.description}”${a.group_name ? ' in ' + a.group_name : ''}`;
      if (a.your_role === 'lent') {
        suffix = '  ·  you get back ' + money(a.your_amount_minor);
        cls = 'pos';
      } else if (a.your_role === 'borrowed') {
        suffix = '  ·  you owe ' + money(a.your_amount_minor);
        cls = 'neg';
      }
    } else {
      icon = '💸';
      const fromWho = a.from_party === me ? 'You' : first(a.from_name);
      const toWho = a.to_party === me ? 'you' : first(a.to_name);
      text =
        a.from_party === me
          ? `You paid ${first(a.to_name)} ${money(a.amount_minor)}`
          : `${first(a.from_name)} paid ${toWho} ${money(a.amount_minor)}`;
    }
    wrap.appendChild(
      h(
        'div',
        { class: 's-act' },
        h('span', { class: 's-act-ic' }, icon),
        h(
          'div',
          { style: 'flex:1;min-width:0;' },
          h('div', { class: 's-act-t' }, text),
          h('div', { class: 's-act-d' }, when, suffix ? h('span', { class: cls }, suffix) : null),
        ),
      ),
    );
  }
}

// ---------- Modal shell ----------

function renderModals() {
  const root = $('modalRoot');
  root.replaceChildren();
  if (state.detail) root.appendChild(buildDetail());
  if (state.expense) root.appendChild(buildExpenseModal());
  if (state.settle) root.appendChild(buildSettleModal());
  if (state.newGroup) root.appendChild(buildNewGroupModal());
  if (state.addFriend) root.appendChild(buildAddFriendModal());
}

function modalBack(onClose, inner) {
  const back = h('div', { class: 'kit-modal-back', onclick: onClose });
  inner.addEventListener('click', (e) => e.stopPropagation());
  back.appendChild(inner);
  return back;
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

function buildDetail() {
  const row = state.detail;
  const c = cat(row.category);
  const d = new Date((row.spent_on || todayKey()) + 'T12:00:00');
  const when = `${MS[d.getMonth()]} ${d.getDate()}`;
  const paidLine =
    row.paid_by === me ? `You paid · ${when}` : `${first(row.paid_by_name)} paid · ${when}`;

  const splitRows = h('div', {});
  for (const s of row.splits ?? []) {
    splitRows.appendChild(
      h(
        'div',
        {
          style:
            'display:flex;align-items:center;gap:11px;padding:8px 0;border-bottom:1px solid var(--line);',
        },
        letterAvatar(s.name, { size: '28px', color: s.color, initials: s.initials }),
        h(
          'span',
          { style: 'flex:1;font:var(--t-body);font-size:13.5px;' },
          s.party_id === me ? 'You' : s.name,
        ),
        h(
          'span',
          { style: 'font:var(--t-mono);font-size:12px;color:var(--ink-2);' },
          money(s.share_minor),
        ),
      ),
    );
  }

  const groupName = dash.groups.find((g) => g.group_id === row.group_id)?.name || '';

  const inner = h(
    'div',
    { class: 'kit-modal', style: 'max-width:440px;' },
    h(
      'div',
      { style: 'display:flex;align-items:center;gap:13px;' },
      h(
        'span',
        {
          class: 's-excat',
          style: `width:46px;height:46px;font-size:22px;background:${tint(c.color)};`,
        },
        c.icon,
      ),
      h(
        'div',
        { style: 'flex:1;min-width:0;' },
        h('h2', { style: 'margin:0;' }, row.description),
        h('div', { class: 's-sub' }, groupName),
      ),
    ),
    h(
      'div',
      { style: 'font:var(--font-title);font-size:30px;font-weight:600;margin:16px 0 4px;' },
      money(row.amount_minor),
    ),
    h('div', { class: 's-sub', style: 'margin-bottom:14px;' }, paidLine),
    h('div', { class: 's-flabel' }, 'Split'),
    splitRows,
    h(
      'div',
      { class: 'kit-modal-foot' },
      h(
        'button',
        {
          type: 'button',
          class: 'kit-btn danger s-del',
          onclick: (e) => {
            if (!armConfirm(e.currentTarget, { armedLabel: 'Delete — sure?' })) return;
            deleteExpense(row.expense_id);
          },
        },
        'Delete',
      ),
      h('button', { type: 'button', class: 'kit-btn', onclick: closeDetail }, 'Close'),
      h(
        'button',
        { type: 'button', class: 'kit-btn primary', onclick: () => openEditExpense(row) },
        'Edit',
      ),
    ),
  );
  return modalBack(closeDetail, inner);
}

// ---------- Add / edit expense modal ----------

// Load a group's members into state.modalMembers, then re-render the modal.
async function loadModalMembers(groupId) {
  try {
    const res = await read('group', { group_id: groupId });
    if (res?.me) me = res.me;
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
    paidBy: me,
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
function setE(patch) {
  Object.assign(state.expense, patch);
  renderModals();
}

function buildExpenseModal() {
  const exp = state.expense;
  const amountCents = toCents(exp.amount);
  const members = state.modalMembers;
  const parts = members.filter((m) => exp.include.has(m.party_id));

  // Split rows.
  const rows = h('div', { style: 'margin-top:10px;' });
  const eqShare = parts.length && amountCents > 0 ? amountCents / parts.length : 0;
  for (const m of members) {
    const inc = exp.include.has(m.party_id);
    const box = h(
      'button',
      {
        type: 'button',
        class: `s-splitbox ${inc ? 'on' : ''}`,
        'aria-label': 'Include',
        onclick: () => {
          const next = new Set(exp.include);
          if (inc) next.delete(m.party_id);
          else next.add(m.party_id);
          setE({ include: next });
        },
      },
      inc ? el(CHECK_SVG) : null,
    );
    const row = h(
      'div',
      { class: 's-splitrow' },
      box,
      letterAvatar(m.name, { size: '26px', color: m.color, initials: m.initials }),
      h('span', { class: 's-splitname' }, m.is_me || m.party_id === me ? 'You' : m.name),
    );
    if (exp.method === 'equal') {
      row.appendChild(h('span', { class: 's-splitshare' }, inc ? money(eqShare) : '—'));
    } else if (exp.method === 'exact') {
      if (inc) {
        row.appendChild(
          h('input', {
            class: 's-splitin',
            value: exp.exact[m.party_id] || '',
            inputmode: 'decimal',
            placeholder: '0.00',
            oninput: (e) => {
              exp.exact = { ...exp.exact, [m.party_id]: e.target.value };
              updateSplitSum();
            },
          }),
        );
      } else row.appendChild(h('span', { class: 's-splitshare' }, '—'));
    } else {
      if (inc) {
        row.appendChild(
          h('input', {
            class: 's-splitin',
            value: exp.percent[m.party_id] || '',
            inputmode: 'decimal',
            placeholder: '0%',
            oninput: (e) => {
              exp.percent = { ...exp.percent, [m.party_id]: e.target.value };
              updateSplitSum();
            },
          }),
        );
      } else row.appendChild(h('span', { class: 's-splitshare' }, '—'));
    }
    rows.appendChild(row);
  }

  const sumEl = h('div', { class: 's-splitsum' });
  rows.appendChild(sumEl);

  const segBtn = (label, method) =>
    h(
      'button',
      {
        type: 'button',
        'aria-pressed': String(exp.method === method),
        onclick: () => setE({ method }),
      },
      label,
    );

  const catRow = h('div', { class: 's-catrow' });
  for (const c of CAT_LIST) {
    catRow.appendChild(
      h(
        'button',
        {
          type: 'button',
          class: 'kit-chip quiet',
          'aria-pressed': String(exp.category === c),
          onclick: () => setE({ category: c }),
        },
        `${cat(c).icon} ${c.charAt(0).toUpperCase() + c.slice(1)}`,
      ),
    );
  }

  const groupSelect = h(
    'select',
    {
      class: 's-select',
      onchange: async (e) => {
        exp.groupId = e.target.value;
        await loadModalMembers(exp.groupId);
        exp.include = new Set(state.modalMembers.map((m) => m.party_id));
        if (!state.modalMembers.some((m) => m.party_id === exp.paidBy)) exp.paidBy = me;
        renderModals();
      },
    },
    ...dash.groups.map((g) =>
      h('option', { value: g.group_id, selected: g.group_id === exp.groupId || undefined }, g.name),
    ),
  );

  const paidSelect = h(
    'select',
    { class: 's-select', onchange: (e) => setE({ paidBy: e.target.value }) },
    ...members.map((m) =>
      h(
        'option',
        { value: m.party_id, selected: m.party_id === exp.paidBy || undefined },
        m.is_me || m.party_id === me ? 'You' : m.name,
      ),
    ),
  );

  const descInput = h('input', {
    class: 's-in',
    value: exp.desc,
    placeholder: 'What was it for?',
    style: 'font-size:15px;',
    oninput: (e) => {
      exp.desc = e.target.value;
      updateSaveState();
    },
  });
  const amtInput = h('input', {
    class: 's-amt',
    value: exp.amount,
    inputmode: 'decimal',
    placeholder: '0.00',
    oninput: (e) => {
      exp.amount = e.target.value;
      // amount changes ripple through the share preview + validity
      renderModals();
    },
  });

  const saveBtn = h(
    'button',
    { type: 'button', class: 'kit-btn primary', onclick: saveExpense },
    'Save',
  );

  const foot = h('div', { class: 'kit-modal-foot' });
  if (exp.mode === 'edit') {
    foot.appendChild(
      h(
        'button',
        {
          type: 'button',
          class: 'kit-btn danger s-del',
          onclick: (e) => {
            if (!armConfirm(e.currentTarget, { armedLabel: 'Delete — sure?' })) return;
            deleteExpense(exp.expense_id);
          },
        },
        'Delete',
      ),
    );
  }
  foot.appendChild(
    h('button', { type: 'button', class: 'kit-btn', onclick: closeExpense }, 'Cancel'),
  );
  foot.appendChild(saveBtn);

  const inner = h(
    'div',
    { class: 'kit-modal s-wide' },
    h('h2', {}, exp.mode === 'edit' ? 'Edit expense' : 'Add an expense'),
    descInput,
    h(
      'div',
      { class: 's-field' },
      h('div', { class: 's-amtwrap' }, h('span', { class: 'cur' }, '$'), amtInput),
    ),
    h('div', { class: 's-field' }, h('div', { class: 's-flabel' }, 'Category'), catRow),
    h(
      'div',
      { class: 's-row2' },
      h(
        'div',
        { class: 's-field', style: 'flex:1;' },
        h('div', { class: 's-flabel' }, 'Group'),
        groupSelect,
      ),
      h(
        'div',
        { class: 's-field', style: 'flex:1;' },
        h('div', { class: 's-flabel' }, 'Paid by'),
        paidSelect,
      ),
    ),
    h(
      'div',
      { class: 's-field' },
      h('div', { class: 's-flabel' }, 'Split'),
      h(
        'div',
        { class: 'kit-seg stretch' },
        segBtn('Equally', 'equal'),
        segBtn('Exact', 'exact'),
        segBtn('Percent', 'percent'),
      ),
      rows,
    ),
    foot,
  );

  // Compute the live sum label + save validity once mounted.
  function updateSplitSum() {
    const cents = toCents(exp.amount) || 0;
    const p = members.filter((m) => exp.include.has(m.party_id));
    if (exp.method === 'exact') {
      const sum = p.reduce((a, m) => a + (toCents(exp.exact[m.party_id]) || 0), 0);
      const diff = cents - sum;
      sumEl.textContent =
        money(sum) +
        ' of ' +
        money(cents) +
        (Math.abs(diff) > 1
          ? ' · ' + money(Math.abs(diff)) + (diff > 0 ? ' left' : ' over')
          : ' ✓');
      sumEl.className = 's-splitsum' + (Math.abs(diff) > 1 ? ' bad' : '');
    } else if (exp.method === 'percent') {
      const sum = p.reduce((a, m) => a + (parseFloat(exp.percent[m.party_id]) || 0), 0);
      sumEl.textContent = sum.toFixed(0) + '% of 100%' + (Math.abs(sum - 100) < 0.1 ? ' ✓' : '');
      sumEl.className = 's-splitsum' + (Math.abs(sum - 100) > 0.1 ? ' bad' : '');
    } else {
      const per = p.length && cents > 0 ? cents / p.length : 0;
      sumEl.textContent = p.length
        ? money(per) + ' each · ' + p.length + ' people'
        : 'Select who splits';
      sumEl.className = 's-splitsum';
    }
    updateSaveState();
  }
  function updateSaveState() {
    const cents = toCents(exp.amount);
    const ok = exp.desc.trim() && cents > 0 && resolveSplits(exp, cents);
    saveBtn.disabled = !ok;
  }
  updateSplitSum();

  return modalBack(closeExpense, inner);
}

async function saveExpense() {
  const exp = state.expense;
  const cents = toCents(exp.amount);
  const splits = resolveSplits(exp, cents);
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
  if (exp.mode === 'edit')
    outcome = await act('edit-expense', { expense_id: exp.expense_id, ...base });
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
  await refreshAll();
}

// ---------- Settle up ----------

async function openSettle() {
  closeAllModals();
  if (state.view === 'group' && state.groupId) {
    await loadModalMembers(state.groupId);
    const other = state.modalMembers.find((m) => m.party_id !== me);
    state.settle = {
      people: state.modalMembers,
      from: other?.party_id ?? me,
      to: me,
      amount: '',
      groupId: state.groupId,
    };
  } else if (state.view === 'friend' && state.viewData?.friend) {
    const f = state.viewData.friend;
    state.modalMembers = [
      { party_id: me, name: 'You', color: '#0FA678', initials: 'You', is_me: true },
      f,
    ];
    state.settle = {
      people: state.modalMembers,
      from: f.party_id,
      to: me,
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

function buildSettleModal() {
  const st = state.settle;
  const nameFor = (p) => (p.party_id === me ? 'You' : p.name);
  const sel = (which) =>
    h(
      'select',
      {
        class: 's-select',
        onchange: (e) => {
          st[which] = e.target.value;
          renderModals();
        },
      },
      ...st.people.map((p) =>
        h(
          'option',
          { value: p.party_id, selected: p.party_id === st[which] || undefined },
          nameFor(p),
        ),
      ),
    );
  const cents = toCents(st.amount);
  const hint =
    `${st.from === me ? 'You' : first(personOf(st.from).name)} pays ${st.to === me ? 'you' : first(personOf(st.to).name)}` +
    (cents > 0 ? ' ' + money(cents) : '');
  const saveBtn = h(
    'button',
    {
      type: 'button',
      class: 'kit-btn primary',
      disabled: !(cents > 0 && st.from !== st.to) || undefined,
      onclick: saveSettle,
    },
    'Record payment',
  );
  const inner = h(
    'div',
    { class: 'kit-modal', style: 'max-width:420px;' },
    h('h2', {}, 'Settle up'),
    h(
      'div',
      { class: 's-row2' },
      h(
        'div',
        { class: 's-field', style: 'flex:1;' },
        h('div', { class: 's-flabel' }, 'From'),
        sel('from'),
      ),
      h(
        'div',
        { class: 's-field', style: 'flex:1;' },
        h('div', { class: 's-flabel' }, 'To'),
        sel('to'),
      ),
    ),
    h(
      'div',
      { class: 's-field' },
      h('div', { class: 's-flabel' }, 'Amount'),
      h(
        'div',
        { class: 's-amtwrap' },
        h('span', { class: 'cur' }, '$'),
        h('input', {
          class: 's-amt',
          value: st.amount,
          inputmode: 'decimal',
          placeholder: '0.00',
          oninput: (e) => {
            st.amount = e.target.value;
            renderModals();
          },
        }),
      ),
    ),
    h('div', { class: 's-sub', style: 'margin-top:10px;' }, hint),
    h(
      'div',
      { class: 'kit-modal-foot' },
      h('button', { type: 'button', class: 'kit-btn', onclick: closeSettle }, 'Cancel'),
      saveBtn,
    ),
  );
  return modalBack(closeSettle, inner);
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

function buildNewGroupModal() {
  const ng = state.newGroup;
  const iconRow = h('div', { class: 's-catrow' });
  for (const ic of GROUP_ICONS) {
    iconRow.appendChild(
      h(
        'button',
        {
          type: 'button',
          class: 'kit-chip quiet',
          'aria-pressed': String(ng.icon === ic),
          onclick: () => {
            ng.icon = ic;
            renderModals();
          },
        },
        ic,
      ),
    );
  }
  const memRow = h('div', { class: 's-memtoggle' });
  for (const f of dash.friends) {
    const on = ng.members.has(f.party_id);
    memRow.appendChild(
      h(
        'button',
        {
          type: 'button',
          class: 'kit-chip quiet',
          'aria-pressed': String(on),
          onclick: () => {
            if (on) ng.members.delete(f.party_id);
            else ng.members.add(f.party_id);
            renderModals();
          },
        },
        h('span', {
          style: `width:9px;height:9px;border-radius:999px;background:${f.color};`,
        }),
        first(f.name),
      ),
    );
  }
  const saveBtn = h(
    'button',
    {
      type: 'button',
      class: 'kit-btn primary',
      disabled: !(ng.name.trim() && ng.members.size >= 1) || undefined,
      onclick: saveNewGroup,
    },
    'Create group',
  );
  const inner = h(
    'div',
    { class: 'kit-modal', style: 'max-width:420px;' },
    h('h2', {}, 'New group'),
    h('input', {
      class: 's-in',
      value: ng.name,
      placeholder: 'Group name',
      style: 'font-size:15px;',
      oninput: (e) => {
        ng.name = e.target.value;
        saveBtn.disabled = !(ng.name.trim() && ng.members.size >= 1);
      },
    }),
    h('div', { class: 's-field' }, h('div', { class: 's-flabel' }, 'Icon'), iconRow),
    h('div', { class: 's-field' }, h('div', { class: 's-flabel' }, 'Members'), memRow),
    h(
      'div',
      { class: 'kit-modal-foot' },
      h('button', { type: 'button', class: 'kit-btn', onclick: closeNewGroup }, 'Cancel'),
      saveBtn,
    ),
  );
  return modalBack(closeNewGroup, inner);
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

function buildAddFriendModal() {
  const af = state.addFriend;
  const swatches = h('div', { class: 's-catrow' });
  for (const c of FRIEND_COLORS) {
    swatches.appendChild(
      h('button', {
        type: 'button',
        class: 'kit-chip quiet',
        'aria-pressed': String(af.color === c),
        'aria-label': 'Colour',
        onclick: () => {
          af.color = c;
          renderModals();
        },
        html: `<span style="display:block;width:18px;height:18px;border-radius:999px;background:${c};"></span>`,
      }),
    );
  }
  const saveBtn = h(
    'button',
    {
      type: 'button',
      class: 'kit-btn primary',
      disabled: !af.name.trim() || undefined,
      onclick: saveAddFriend,
    },
    'Add friend',
  );
  const inner = h(
    'div',
    { class: 'kit-modal', style: 'max-width:400px;' },
    h('h2', {}, 'Add a friend'),
    h('input', {
      class: 's-in',
      value: af.name,
      placeholder: 'Name',
      style: 'font-size:15px;',
      oninput: (e) => {
        af.name = e.target.value;
        saveBtn.disabled = !af.name.trim();
      },
    }),
    h('div', { class: 's-field' }, h('div', { class: 's-flabel' }, 'Colour'), swatches),
    h(
      'div',
      { class: 'kit-modal-foot' },
      h('button', { type: 'button', class: 'kit-btn', onclick: closeAddFriend }, 'Cancel'),
      saveBtn,
    ),
  );
  return modalBack(closeAddFriend, inner);
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

// ---------- Consent / denied ----------

function applyDenied(denied) {
  $('consentBanner').hidden = false;
  $('consentDetail').textContent = denied.message ?? '';
  $('root').classList.add('denied');
}

// ---------- Refresh ----------

// Re-fetch the sidebar/dashboard snapshot, then reload the active detail view.
async function refreshDashboard() {
  let next;
  try {
    next = await read('dashboard');
  } catch {
    readFailed($('noticeBanner'));
    return false;
  }
  if (next?.vaultDenied) {
    applyDenied(next.vaultDenied);
    return false;
  }
  $('consentBanner').hidden = true;
  $('root').classList.remove('denied');
  dash = next ?? dash;
  dash.friends = dash.friends ?? [];
  dash.groups = dash.groups ?? [];
  if (dash.me) me = dash.me;
  return true;
}

async function refreshAll() {
  const ok = await refreshDashboard();
  if (!ok) return;
  await loadView();
}

// ---------- Search wiring ----------

const applySearch = debounce(async () => {
  const q = $('searchInput').value.trim();
  if (q === state.search) return;
  state.search = q;
  const seq = ++searchSeq;
  if (!q) {
    state.viewData = null;
    // Return to whatever structural view we were on.
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
  if (res?.me) me = res.me;
  state.viewData = res;
  render();
}, 150);

// ---------- Chrome wiring ----------

$('addExpenseBtn').addEventListener('click', openAddExpense);
$('newGroupBtn').addEventListener('click', openNewGroup);
$('addFriendBtn').addEventListener('click', openAddFriend);
$('settleBtn').addEventListener('click', openSettle);
// Kit theme toggle; setThemeIcon also refreshes after shell-driven theme flips.
const setThemeIcon = wireThemeToggle($('themeBtn'));
$('hamburger').addEventListener('click', () => $('root').classList.add('side-open'));
$('sideClose').addEventListener('click', () => $('root').classList.remove('side-open'));
$('scrim').addEventListener('click', () => $('root').classList.remove('side-open'));
$('searchInput').addEventListener('input', applySearch);
$('searchInput').addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  if (!$('searchInput').value && !state.search) return;
  $('searchInput').value = '';
  searchSeq += 1;
  state.search = '';
  loadView();
});

window.addEventListener('focus', refreshAll);
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (anyModalOpen()) {
    closeAllModals();
    renderModals();
    return;
  }
  if ($('root').classList.contains('side-open')) $('root').classList.remove('side-open');
});

// Component-width driven responsive: blueprints render inside a panel, so we
// measure the root's own width (not the viewport) and toggle the phone layout.
function measure() {
  const root = $('root');
  const forced = document.documentElement.getAttribute('data-app-width') === 'narrow';
  const narrow = forced || root.clientWidth < 900;
  if (narrow !== state.narrow) {
    state.narrow = narrow;
    root.classList.toggle('is-narrow', narrow);
    if (!narrow) root.classList.remove('side-open');
  }
}
window.addEventListener('resize', measure);

// ---------- Boot ----------

state.narrow = $('root').clientWidth < 900;
$('root').classList.toggle('is-narrow', state.narrow);
showSkeleton($('wrap'), 4);
measure();
setInterval(measure, 250);
refreshAll();
