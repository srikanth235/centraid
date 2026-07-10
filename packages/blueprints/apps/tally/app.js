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
// Aliased: the app already has a module-level `render()` orchestrator (paints
// sidebar + topbar + the active view into `#wrap`); `litRender` is Lit's
// standalone DOM-commit function used to drive the sidebar lists, `#wrap` and
// the modal-root (all kit-owned/static containers, per the app's Lit
// conventions — see apps/tasks/app.js for the reference pattern).
import { html, live, nothing, render as litRender, repeat } from './lit-core.min.js';

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

function dashboardIconTpl() {
  return html`<svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <rect x="3" y="3" width="8" height="8" rx="1.5" />
    <rect x="13" y="3" width="8" height="5" rx="1.5" />
    <rect x="13" y="10" width="8" height="11" rx="1.5" />
    <rect x="3" y="13" width="8" height="8" rx="1.5" />
  </svg>`;
}
function activityIconTpl() {
  return html`<svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M3 12h4l2 6 4-14 2 8h6" />
  </svg>`;
}

function navItemTpl(iconTpl, label, active, onClick) {
  return html`<button
    type="button"
    class="s-nav-item"
    aria-current=${String(!!active)}
    @click=${onClick}
  >
    ${iconTpl}<span class="lbl">${label}</span>
  </button>`;
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
  litRender(
    html`${navItemTpl(dashboardIconTpl(), 'Dashboard', state.view === 'dashboard', () =>
      setNav({ view: 'dashboard', search: '' }),
    )}${navItemTpl(activityIconTpl(), 'Activity', state.view === 'activity', () =>
      setNav({ view: 'activity', search: '' }),
    )}`,
    $('smartNav'),
  );

  litRender(
    html`${repeat(
      dash.groups,
      (g) => g.group_id,
      (g) => {
        const { cls, label } = balLabelGroup(g.owner_net_minor);
        return html`<button
          type="button"
          class="s-listitem"
          aria-current=${String(state.view === 'group' && state.groupId === g.group_id)}
          @click=${() => setNav({ view: 'group', groupId: g.group_id, search: '' })}
        >
          <span class="s-gicon" style="background:${tint(g.color)};">${g.icon || '👥'}</span>
          <span class="s-li-main">
            <span class="s-li-name">${g.name}</span>
            <span class="s-li-sub ${cls}">${label}</span>
          </span>
        </button>`;
      },
    )}`,
    $('groupsNav'),
  );

  litRender(
    html`${repeat(
      dash.friends,
      (f) => f.party_id,
      (f) => {
        const { cls, label } = balLabelFriend(f.net_minor);
        return html`<button
          type="button"
          class="s-listitem"
          aria-current=${String(state.view === 'friend' && state.friendId === f.party_id)}
          @click=${() => setNav({ view: 'friend', friendId: f.party_id, search: '' })}
        >
          ${letterAvatar(f.name, { size: '28px', color: f.color, initials: f.initials })}
          <span class="s-li-main">
            <span class="s-li-name">${f.name}</span>
            <span class="s-li-sub ${cls}">${label}</span>
          </span>
        </button>`;
      },
    )}`,
    $('friendsNav'),
  );
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

// `#wrap` starts out holding the kit's raw (non-Lit) skeleton markup
// (`showSkeleton`, at boot). Lit's standalone `render()` never clears a
// container's pre-existing children on its first call into it — it only
// appends past them — so the very first Lit commit into `#wrap` must clear
// that skeleton itself; every commit after that must go through `litRender`
// alone (a raw clear once Lit owns the container corrupts its part cache).
let wrapMounted = false;
function mountWrap(templateResult) {
  const wrap = $('wrap');
  if (!wrapMounted) {
    wrap.replaceChildren();
    wrapMounted = true;
  }
  litRender(templateResult, wrap);
}

function render() {
  renderSidebar();
  renderTopbar();
  setThemeIcon();
  if (state.search.trim()) return mountWrap(searchTpl());
  if (state.view === 'dashboard') return mountWrap(dashboardTpl());
  if (state.view === 'activity') return mountWrap(activityTpl());
  if (state.view === 'group' || state.view === 'friend') return mountWrap(ledgerTpl());
}

// A view is still loading: route the skeleton through the template itself
// (never raw-clear a Lit-owned container after the first commit).
function skeletonTpl(rows) {
  return html`<div class="s-explist"><kit-skeleton rows=${rows}></kit-skeleton></div>`;
}

// ---------- Dashboard ----------

function balRowTpl(p, kind) {
  const amtCls = kind === 'owe' ? 'neg' : 'pos';
  return html`<button
    type="button"
    class="s-bal-row"
    @click=${() => setNav({ view: 'friend', friendId: p.party_id, search: '' })}
  >
    ${letterAvatar(p.name, { size: '34px', color: p.color, initials: p.initials })}
    <span class="s-bal-main">
      <span class="s-bal-name">${p.name}</span>
      <span class="s-bal-sub">${kind === 'owe' ? 'you owe' : 'owes you'}</span>
    </span>
    <span class="s-bal-amt ${amtCls}">${money(p.net_minor)}</span>
  </button>`;
}

function groupCardTpl(g) {
  const { cls, label } = balLabelGroup(g.owner_net_minor);
  return html`<button
    type="button"
    class="s-gcard"
    @click=${() => setNav({ view: 'group', groupId: g.group_id, search: '' })}
  >
    <div class="s-gcard-top">
      <span
        class="s-gicon"
        style="width:38px;height:38px;font-size:19px;background:${tint(g.color)};"
        >${g.icon || '👥'}</span
      >
      <div>
        <div class="s-gcard-name">${g.name}</div>
        <div class="s-gcard-mem">${g.member_count} member${g.member_count === 1 ? '' : 's'}</div>
      </div>
    </div>
    <div class="s-gcard-bal ${cls}">${label}</div>
  </button>`;
}

function dashboardTpl() {
  // A fresh vault: no friends and no groups — invite the first steps.
  if (dash.friends.length === 0 && dash.groups.length === 0) {
    return html`<div class="s-dash-empty">
      <div class="t">Welcome to Tally</div>
      <div class="d">
        Add a friend, then create a group and start splitting shared costs. Balances update the
        moment you record an expense or a payment.
      </div>
      <div class="row">
        <button type="button" class="kit-btn primary" @click=${openAddFriend}>Add a friend</button>
        <button type="button" class="kit-btn" @click=${openNewGroup}>Create a group</button>
      </div>
    </div>`;
  }

  const owed = dash.owed_total_minor;
  const owe = dash.owe_total_minor;
  const net = owed - owe;
  const netCls = Math.abs(net) < 1 ? '' : net > 0 ? 'pos' : 'neg';
  const netLabel = (net >= 0 ? '+' : '−') + money(net);

  const oweList = dash.friends.filter((f) => f.net_minor < -1);
  const owedList = dash.friends.filter((f) => f.net_minor > 1);

  return html`
    <div class="s-summary">
      <div class="s-stat">
        <div class="k">Total balance</div>
        <div class="v ${netCls}">${netLabel}</div>
      </div>
      <div class="s-stat">
        <div class="k">You owe</div>
        <div class="v neg">${money(owe)}</div>
      </div>
      <div class="s-stat">
        <div class="k">You are owed</div>
        <div class="v pos">${money(owed)}</div>
      </div>
    </div>
    <div class="s-cols">
      <div class="s-card">
        <div class="s-card-h">You owe</div>
        ${oweList.length === 0
          ? html`<div class="s-empty-row">You're all settled up.</div>`
          : repeat(
              oweList,
              (p) => p.party_id,
              (p) => balRowTpl(p, 'owe'),
            )}
      </div>
      <div class="s-card">
        <div class="s-card-h">You are owed</div>
        ${owedList.length === 0
          ? html`<div class="s-empty-row">Nobody owes you right now.</div>`
          : repeat(
              owedList,
              (p) => p.party_id,
              (p) => balRowTpl(p, 'owed'),
            )}
      </div>
    </div>
    <div class="s-section-title">Your groups</div>
    ${dash.groups.length === 0
      ? html`<div class="s-card">
          <div class="s-empty-row" style="padding:28px 16px;">
            No groups yet.
            <button
              type="button"
              style="border:none;background:none;color:var(--accd);font-weight:600;cursor:pointer;"
              @click=${openNewGroup}
            >
              Create one
            </button>
            to start splitting.
          </div>
        </div>`
      : html`<div class="s-groupgrid">
          ${repeat(
            dash.groups,
            (g) => g.group_id,
            (g) => groupCardTpl(g),
          )}
        </div>`}
  `;
}

// ---------- Ledger (group / friend) ----------

// One expense row from a decorated ledger row (already carries splits).
function ledgerRowTpl(row, { groupSuffix = false } = {}) {
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
  // Search folds the group name into the sub line, like the prototype does.
  if (groupSuffix && row.group_name) sub = `${sub} · ${row.group_name}`;
  return html`<button type="button" class="s-exrow" @click=${() => openDetail(row)}>
    <span class="s-exdate">
      <span class="mo">${MS[d.getMonth()]}</span>
      <span class="dy">${String(d.getDate())}</span>
    </span>
    <span class="s-excat" style="background:${tint(c.color)};">${c.icon}</span>
    <span class="s-exmain">
      <span class="s-exdesc">${row.description}</span>
      <span class="s-exsub">${sub}</span>
    </span>
    <span class="s-exright">
      <span class="s-exlabel">${rLabel}</span>
      <span class="s-examt ${cls}">${amt}</span>
    </span>
  </button>`;
}

function groupBalChipTpl(m) {
  const v = m.net_minor;
  const who = m.is_me ? 'You' : first(m.name);
  const verb = m.is_me ? { g: 'get back', o: 'owe' } : { g: 'gets back', o: 'owes' };
  const text =
    Math.abs(v) < 1
      ? `${who} — settled`
      : v > 0
        ? `${who} ${verb.g} ${money(v)}`
        : `${who} ${verb.o} ${money(v)}`;
  return html`<span class="s-balchip">
    ${letterAvatar(m.name, { size: '22px', color: m.color, initials: m.initials })}
    <span>${text}</span>
  </span>`;
}

function ledgerTpl() {
  if (!state.viewData) return skeletonTpl(5);

  const parts = [];
  if (state.view === 'group') {
    const members = state.viewData.members ?? [];
    if (members.length) {
      parts.push(
        html`<div class="s-balpanel">
          ${repeat(
            members,
            (m) => m.party_id,
            (m) => groupBalChipTpl(m),
          )}
        </div>`,
      );
    }
  }

  const ledger = state.viewData.ledger ?? [];
  if (ledger.length === 0) {
    parts.push(
      html`<div class="s-explist">
        <div class="s-empty-row" style="padding:40px 16px;">
          No expenses yet. Add one to get started.
        </div>
      </div>`,
    );
  } else {
    parts.push(
      html`<div class="s-explist">
        ${repeat(
          ledger,
          (row) => row.expense_id,
          (row) => ledgerRowTpl(row),
        )}
      </div>`,
    );
  }
  return html`${parts}`;
}

// ---------- Search ----------

function searchTpl() {
  if (!state.viewData) return skeletonTpl(5);
  const results = state.viewData.results ?? [];
  if (results.length === 0) {
    return html`<div class="s-explist">
      <div class="s-empty-row" style="padding:40px 16px;">
        No expenses match “${state.search.trim()}”.
      </div>
    </div>`;
  }
  return html`<div class="s-explist">
    ${repeat(
      results,
      (row) => row.expense_id,
      (row) => ledgerRowTpl(row, { groupSuffix: true }),
    )}
  </div>`;
}

// ---------- Activity ----------

function activityItemTpl(a) {
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
    const toWho = a.to_party === me ? 'you' : first(a.to_name);
    text =
      a.from_party === me
        ? `You paid ${first(a.to_name)} ${money(a.amount_minor)}`
        : `${first(a.from_name)} paid ${toWho} ${money(a.amount_minor)}`;
  }
  return html`<div class="s-act">
    <span class="s-act-ic">${icon}</span>
    <div style="flex:1;min-width:0;">
      <div class="s-act-t">${text}</div>
      <div class="s-act-d">
        ${when}${suffix ? html`<span class="${cls}">${suffix}</span>` : nothing}
      </div>
    </div>
  </div>`;
}

function activityTpl() {
  if (!state.viewData) {
    return html`<div><kit-skeleton rows="6"></kit-skeleton></div>`;
  }
  const items = state.viewData.activity ?? [];
  if (items.length === 0) {
    return html`<div class="s-explist">
      <div class="s-empty-row" style="padding:40px 16px;">Nothing has happened yet.</div>
    </div>`;
  }
  return html`${repeat(
    items,
    (a, i) => a.expense_id ?? a.settlement_id ?? i,
    (a) => activityItemTpl(a),
  )}`;
}

// ---------- Modal shell ----------

function renderModals() {
  let tpl = nothing;
  if (state.detail) tpl = detailModalTpl(state.detail);
  else if (state.expense) tpl = expenseModalTpl();
  else if (state.settle) tpl = settleModalTpl();
  else if (state.newGroup) tpl = newGroupModalTpl();
  else if (state.addFriend) tpl = addFriendModalTpl();
  litRender(tpl, $('modalRoot'));
}

// The backdrop closes on its own click; the card itself stops that click from
// bubbling back to the backdrop (each modal's own root element carries the
// stopPropagation handler, matching the old imperative wiring 1:1).
function modalBackTpl(onClose, inner) {
  return html`<div class="kit-modal-back" @click=${onClose}>${inner}</div>`;
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

function detailModalTpl(row) {
  const c = cat(row.category);
  const d = new Date((row.spent_on || todayKey()) + 'T12:00:00');
  const when = `${MS[d.getMonth()]} ${d.getDate()}`;
  const paidLine =
    row.paid_by === me ? `You paid · ${when}` : `${first(row.paid_by_name)} paid · ${when}`;
  const groupName = dash.groups.find((g) => g.group_id === row.group_id)?.name || '';

  return modalBackTpl(
    closeDetail,
    html`<div class="kit-modal" style="max-width:440px;" @click=${(e) => e.stopPropagation()}>
      <div style="display:flex;align-items:center;gap:13px;">
        <span
          class="s-excat"
          style="width:46px;height:46px;font-size:22px;background:${tint(c.color)};"
          >${c.icon}</span
        >
        <div style="flex:1;min-width:0;">
          <h2 style="margin:0;">${row.description}</h2>
          <div class="s-sub">${groupName}</div>
        </div>
      </div>
      <div style="font:var(--font-title);font-size:30px;font-weight:600;margin:16px 0 4px;">
        ${money(row.amount_minor)}
      </div>
      <div class="s-sub" style="margin-bottom:14px;">${paidLine}</div>
      <div class="s-flabel">Split</div>
      <div>
        ${repeat(
          row.splits ?? [],
          (s) => s.party_id,
          (s) => html`<div
            style="display:flex;align-items:center;gap:11px;padding:8px 0;border-bottom:1px solid var(--line);"
          >
            ${letterAvatar(s.name, { size: '28px', color: s.color, initials: s.initials })}
            <span style="flex:1;font:var(--t-body);font-size:13.5px;"
              >${s.party_id === me ? 'You' : s.name}</span
            >
            <span style="font:var(--t-mono);font-size:12px;color:var(--ink-2);"
              >${money(s.share_minor)}</span
            >
          </div>`,
        )}
      </div>
      <div class="kit-modal-foot">
        <button
          type="button"
          class="kit-btn danger s-del"
          @click=${(e) => {
            if (!armConfirm(e.currentTarget, { armedLabel: 'Delete — sure?' })) return;
            deleteExpense(row.expense_id);
          }}
        >
          Delete
        </button>
        <button type="button" class="kit-btn" @click=${closeDetail}>Close</button>
        <button type="button" class="kit-btn primary" @click=${() => openEditExpense(row)}>
          Edit
        </button>
      </div>
    </div>`,
  );
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

// A clean inline-SVG checkmark for an included split row — no emoji, matches
// the prototype's solid-fill toggle box.
function checkIconTpl() {
  return html`<svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="#fff"
    stroke-width="3"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="m5 12 5 5L20 6" />
  </svg>`;
}

// The live sum/validity line under the split rows — computed fresh on every
// render (Lit's diffing keeps the focused input in place, so there's no need
// for the old code's separate "update just the sum, skip the full rebuild"
// path; every keystroke can safely recompute this).
function splitSumInfo(exp, members) {
  const cents = toCents(exp.amount) || 0;
  const parts = members.filter((m) => exp.include.has(m.party_id));
  if (exp.method === 'exact') {
    const sum = parts.reduce((a, m) => a + (toCents(exp.exact[m.party_id]) || 0), 0);
    const diff = cents - sum;
    const bad = Math.abs(diff) > 1;
    return {
      bad,
      text:
        money(sum) +
        ' of ' +
        money(cents) +
        (bad ? ' · ' + money(Math.abs(diff)) + (diff > 0 ? ' left' : ' over') : ' ✓'),
    };
  }
  if (exp.method === 'percent') {
    const sum = parts.reduce((a, m) => a + (parseFloat(exp.percent[m.party_id]) || 0), 0);
    const bad = Math.abs(sum - 100) > 0.1;
    return { bad, text: sum.toFixed(0) + '% of 100%' + (!bad ? ' ✓' : '') };
  }
  const per = parts.length && cents > 0 ? cents / parts.length : 0;
  return {
    bad: false,
    text: parts.length ? money(per) + ' each · ' + parts.length + ' people' : 'Select who splits',
  };
}

function splitRowTpl(m, exp, eqShare) {
  const inc = exp.include.has(m.party_id);
  const name = m.is_me || m.party_id === me ? 'You' : m.name;
  let right;
  if (exp.method === 'equal') {
    right = html`<span class="s-splitshare">${inc ? money(eqShare) : '—'}</span>`;
  } else if (exp.method === 'exact') {
    right = inc
      ? html`<input
          class="s-splitin"
          .value=${live(exp.exact[m.party_id] || '')}
          inputmode="decimal"
          placeholder="0.00"
          @input=${(e) => setE({ exact: { ...exp.exact, [m.party_id]: e.target.value } })}
        />`
      : html`<span class="s-splitshare">—</span>`;
  } else {
    right = inc
      ? html`<input
          class="s-splitin"
          .value=${live(exp.percent[m.party_id] || '')}
          inputmode="decimal"
          placeholder="0%"
          @input=${(e) => setE({ percent: { ...exp.percent, [m.party_id]: e.target.value } })}
        />`
      : html`<span class="s-splitshare">—</span>`;
  }
  return html`<div class="s-splitrow">
    <button
      type="button"
      class="s-splitbox ${inc ? 'on' : ''}"
      aria-label="Include"
      @click=${() => {
        const next = new Set(exp.include);
        if (inc) next.delete(m.party_id);
        else next.add(m.party_id);
        setE({ include: next });
      }}
    >
      ${inc ? checkIconTpl() : nothing}
    </button>
    ${letterAvatar(m.name, { size: '26px', color: m.color, initials: m.initials })}
    <span class="s-splitname">${name}</span>
    ${right}
  </div>`;
}

function expenseModalTpl() {
  const exp = state.expense;
  const amountCents = toCents(exp.amount);
  const members = state.modalMembers;
  const parts = members.filter((m) => exp.include.has(m.party_id));
  const eqShare = parts.length && amountCents > 0 ? amountCents / parts.length : 0;
  const sumInfo = splitSumInfo(exp, members);
  const valid = Boolean(exp.desc.trim() && amountCents > 0 && resolveSplits(exp, amountCents));

  return modalBackTpl(
    closeExpense,
    html`<div class="kit-modal s-wide" @click=${(e) => e.stopPropagation()}>
      <h2>${exp.mode === 'edit' ? 'Edit expense' : 'Add an expense'}</h2>
      <input
        class="s-in"
        style="font-size:15px;"
        .value=${live(exp.desc)}
        placeholder="What was it for?"
        @input=${(e) => setE({ desc: e.target.value })}
      />
      <div class="s-field">
        <div class="s-amtwrap">
          <span class="cur">$</span>
          <input
            class="s-amt"
            .value=${live(exp.amount)}
            inputmode="decimal"
            placeholder="0.00"
            @input=${(e) => setE({ amount: e.target.value })}
          />
        </div>
      </div>
      <div class="s-field">
        <div class="s-flabel">Category</div>
        <div class="s-catrow">
          ${repeat(
            CAT_LIST,
            (c) => c,
            (c) => html`<button
              type="button"
              class="kit-chip quiet"
              aria-pressed=${String(exp.category === c)}
              @click=${() => setE({ category: c })}
            >
              ${cat(c).icon} ${c.charAt(0).toUpperCase() + c.slice(1)}
            </button>`,
          )}
        </div>
      </div>
      <div class="s-row2">
        <div class="s-field" style="flex:1;">
          <div class="s-flabel">Group</div>
          <select
            class="s-select"
            @change=${async (e) => {
              exp.groupId = e.target.value;
              await loadModalMembers(exp.groupId);
              exp.include = new Set(state.modalMembers.map((m) => m.party_id));
              if (!state.modalMembers.some((m) => m.party_id === exp.paidBy)) exp.paidBy = me;
              renderModals();
            }}
          >
            ${repeat(
              dash.groups,
              (g) => g.group_id,
              (g) =>
                html`<option value=${g.group_id} .selected=${g.group_id === exp.groupId}>
                  ${g.name}
                </option>`,
            )}
          </select>
        </div>
        <div class="s-field" style="flex:1;">
          <div class="s-flabel">Paid by</div>
          <select class="s-select" @change=${(e) => setE({ paidBy: e.target.value })}>
            ${repeat(
              members,
              (m) => m.party_id,
              (m) =>
                html`<option value=${m.party_id} .selected=${m.party_id === exp.paidBy}>
                  ${m.is_me || m.party_id === me ? 'You' : m.name}
                </option>`,
            )}
          </select>
        </div>
      </div>
      <div class="s-field">
        <div class="s-flabel">Split</div>
        <div class="kit-seg stretch">
          <button
            type="button"
            aria-pressed=${String(exp.method === 'equal')}
            @click=${() => setE({ method: 'equal' })}
          >
            Equally
          </button>
          <button
            type="button"
            aria-pressed=${String(exp.method === 'exact')}
            @click=${() => setE({ method: 'exact' })}
          >
            Exact
          </button>
          <button
            type="button"
            aria-pressed=${String(exp.method === 'percent')}
            @click=${() => setE({ method: 'percent' })}
          >
            Percent
          </button>
        </div>
        <div style="margin-top:10px;">
          ${repeat(
            members,
            (m) => m.party_id,
            (m) => splitRowTpl(m, exp, eqShare),
          )}
          <div class="s-splitsum${sumInfo.bad ? ' bad' : ''}">${sumInfo.text}</div>
        </div>
      </div>
      <div class="kit-modal-foot">
        ${exp.mode === 'edit'
          ? html`<button
              type="button"
              class="kit-btn danger s-del"
              @click=${(e) => {
                if (!armConfirm(e.currentTarget, { armedLabel: 'Delete — sure?' })) return;
                deleteExpense(exp.expense_id);
              }}
            >
              Delete
            </button>`
          : nothing}
        <button type="button" class="kit-btn" @click=${closeExpense}>Cancel</button>
        <button type="button" class="kit-btn primary" ?disabled=${!valid} @click=${saveExpense}>
          Save
        </button>
      </div>
    </div>`,
  );
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

function settleSelectTpl(st, which) {
  const nameFor = (p) => (p.party_id === me ? 'You' : p.name);
  return html`<select
    class="s-select"
    @change=${(e) => {
      st[which] = e.target.value;
      renderModals();
    }}
  >
    ${repeat(
      st.people,
      (p) => p.party_id,
      (p) =>
        html`<option value=${p.party_id} .selected=${p.party_id === st[which]}>
          ${nameFor(p)}
        </option>`,
    )}
  </select>`;
}

function settleModalTpl() {
  const st = state.settle;
  const cents = toCents(st.amount);
  const hint =
    `${st.from === me ? 'You' : first(personOf(st.from).name)} pays ${st.to === me ? 'you' : first(personOf(st.to).name)}` +
    (cents > 0 ? ' ' + money(cents) : '');

  return modalBackTpl(
    closeSettle,
    html`<div class="kit-modal" style="max-width:420px;" @click=${(e) => e.stopPropagation()}>
      <h2>Settle up</h2>
      <div class="s-row2">
        <div class="s-field" style="flex:1;">
          <div class="s-flabel">From</div>
          ${settleSelectTpl(st, 'from')}
        </div>
        <div class="s-field" style="flex:1;">
          <div class="s-flabel">To</div>
          ${settleSelectTpl(st, 'to')}
        </div>
      </div>
      <div class="s-field">
        <div class="s-flabel">Amount</div>
        <div class="s-amtwrap">
          <span class="cur">$</span>
          <input
            class="s-amt"
            .value=${live(st.amount)}
            inputmode="decimal"
            placeholder="0.00"
            @input=${(e) => {
              st.amount = e.target.value;
              renderModals();
            }}
          />
        </div>
      </div>
      <div class="s-sub" style="margin-top:10px;">${hint}</div>
      <div class="kit-modal-foot">
        <button type="button" class="kit-btn" @click=${closeSettle}>Cancel</button>
        <button
          type="button"
          class="kit-btn primary"
          ?disabled=${!(cents > 0 && st.from !== st.to)}
          @click=${saveSettle}
        >
          Record payment
        </button>
      </div>
    </div>`,
  );
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

function newGroupModalTpl() {
  const ng = state.newGroup;
  const valid = Boolean(ng.name.trim() && ng.members.size >= 1);

  return modalBackTpl(
    closeNewGroup,
    html`<div class="kit-modal" style="max-width:420px;" @click=${(e) => e.stopPropagation()}>
      <h2>New group</h2>
      <input
        class="s-in"
        style="font-size:15px;"
        .value=${live(ng.name)}
        placeholder="Group name"
        @input=${(e) => {
          ng.name = e.target.value;
          renderModals();
        }}
      />
      <div class="s-field">
        <div class="s-flabel">Icon</div>
        <div class="s-catrow">
          ${repeat(
            GROUP_ICONS,
            (ic) => ic,
            (ic) => html`<button
              type="button"
              class="kit-chip quiet"
              aria-pressed=${String(ng.icon === ic)}
              @click=${() => {
                ng.icon = ic;
                renderModals();
              }}
            >
              ${ic}
            </button>`,
          )}
        </div>
      </div>
      <div class="s-field">
        <div class="s-flabel">Members</div>
        <div class="s-memtoggle">
          ${repeat(
            dash.friends,
            (f) => f.party_id,
            (f) => {
              const on = ng.members.has(f.party_id);
              return html`<button
                type="button"
                class="kit-chip quiet"
                aria-pressed=${String(on)}
                @click=${() => {
                  if (on) ng.members.delete(f.party_id);
                  else ng.members.add(f.party_id);
                  renderModals();
                }}
              >
                <span
                  style="width:9px;height:9px;border-radius:999px;background:${f.color};"
                ></span>
                ${first(f.name)}
              </button>`;
            },
          )}
        </div>
      </div>
      <div class="kit-modal-foot">
        <button type="button" class="kit-btn" @click=${closeNewGroup}>Cancel</button>
        <button type="button" class="kit-btn primary" ?disabled=${!valid} @click=${saveNewGroup}>
          Create group
        </button>
      </div>
    </div>`,
  );
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

function addFriendModalTpl() {
  const af = state.addFriend;

  return modalBackTpl(
    closeAddFriend,
    html`<div class="kit-modal" style="max-width:400px;" @click=${(e) => e.stopPropagation()}>
      <h2>Add a friend</h2>
      <input
        class="s-in"
        style="font-size:15px;"
        .value=${live(af.name)}
        placeholder="Name"
        @input=${(e) => {
          af.name = e.target.value;
          renderModals();
        }}
      />
      <div class="s-field">
        <div class="s-flabel">Colour</div>
        <div class="s-catrow">
          ${repeat(
            FRIEND_COLORS,
            (c) => c,
            (c) => html`<button
              type="button"
              class="kit-chip quiet"
              aria-pressed=${String(af.color === c)}
              aria-label="Colour"
              @click=${() => {
                af.color = c;
                renderModals();
              }}
            >
              <span
                style="display:block;width:18px;height:18px;border-radius:999px;background:${c};"
              ></span>
            </button>`,
          )}
        </div>
      </div>
      <div class="kit-modal-foot">
        <button type="button" class="kit-btn" @click=${closeAddFriend}>Cancel</button>
        <button
          type="button"
          class="kit-btn primary"
          ?disabled=${!af.name.trim()}
          @click=${saveAddFriend}
        >
          Add friend
        </button>
      </div>
    </div>`,
  );
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
