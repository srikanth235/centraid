// governance: allow-repo-hygiene file-size-limit blueprints are single-file by design (read wholesale by one agent); People is a finished relationship keeper — directory, circles, profile drawer, journal, activity — and splitting it would break that "one file" contract.
// People — your circle, remembered. A pure projection over the personal
// vault. Every row is a core.party; circles are collections, cadence and
// stars are judgments the vault holds, notes/tasks/gifts/debts/dates hang
// off the party, and interactions are the touch log. The app stores nothing
// of its own: revoke the grant and this page goes dark while the people,
// their history and the receipts remain the owner's. Every write is a typed
// vault command — consent-checked and receipted.
//
// The design + copy + interactions come from the People prototype; the data
// is real, so where the prototype seeded contacts a fresh vault starts empty
// and the drawer grows small "+ add" affordances (tasks, gifts, dates,
// relationships, debts) alongside the notes input the prototype shipped.
//
// Rendering is Lit (see kit/elements.js for the house style): read-only
// regions (rows, lists, the profile drawer) are `html` templates committed
// with Lit's standalone `render()`; the drawer's own "+ add" mini-forms stay
// small imperative islands (kit's `h()` builder) because their plus-button
// paints on every keystroke without a re-render — exactly the kind of
// widget the conversion's conventions call out to leave alone.

import {
  armConfirm,
  closePopover,
  debounce,
  el,
  emptyState,
  fmtMoney,
  h,
  isPopoverOpen,
  openPopover,
  outcomeMessage,
  readFailed,
  runBulk,
  showSkeleton,
  snippetInto,
  toast,
  wireThemeToggle,
} from './kit.js';
import { KitElement } from './elements.js';
import { createRef, html, nothing, ref, render as litRender, repeat } from './lit-core.min.js';

const $ = (id) => document.getElementById(id);

// ---------- Icons (copied from the prototype) ----------

const I = {
  addPerson:
    '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--ink-2)" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3"/><path d="M3.5 19a5.5 5.5 0 0111 0"/><path d="M19 8v6M22 11h-6"/></svg>',
  circlePlus:
    '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--ink-2)" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
  people:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3"/><path d="M15 8a3 3 0 100-.1"/><path d="M3.5 19a5.5 5.5 0 0111 0"/><path d="M14.5 19a5.5 5.5 0 016-5.48"/></svg>',
  clock:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/></svg>',
  bell: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6z"/><path d="M10 20a2 2 0 004 0"/></svg>',
  star: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 2.6 5.6 6 .7-4.5 4.2 1.2 6-5.3-3-5.3 3 1.2-6L3.4 9.3l6-.7z"/></svg>',
  journal:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4a2 2 0 012-2h11v18H7a2 2 0 00-2 2z"/><path d="M9 7h6M9 11h4"/></svg>',
  activity:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2 6 4-14 2 8h6"/></svg>',
  rename:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L18.5 9.5a2 2 0 0 0-2.8-2.8L5 17z"/></svg>',
  del: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>',
  check:
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 6"/></svg>',
  checkTask:
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 6"/></svg>',
  dots: '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>',
  close:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  message:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v11H8l-4 4z"/></svg>',
  call: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h3.5l1.5 4-2 1.2a10 10 0 004.8 4.8L18 16l4 1.5V21a1 1 0 01-1 1A17 17 0 013 5a1 1 0 011-1z"/></svg>',
  phone:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h3.5l1.5 4-2 1.2a10 10 0 004.8 4.8L18 16l4 1.5V21a1 1 0 01-1 1A17 17 0 013 5a1 1 0 011-1z"/></svg>',
  mail: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18v12H3z"/><path d="M3 7l9 6 9-6"/></svg>',
  bellSm:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6z"/><path d="M10 20a2 2 0 004 0"/></svg>',
  gift: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M20 12v9H4v-9M2 7h20v5H2zM12 22V7M12 7S9 2 6.5 4 8 7 12 7zM12 7s3-5 5.5-3S16 7 12 7z"/></svg>',
  plus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
};

// The per-contact palette (prototype). Avatar hues come from here or a name
// hash; a circle's chrome dot hashes its id into the same eight colours so a
// circle is always the same colour.
const PALETTE = [
  '#7C5BD9',
  '#2EA098',
  '#4E68DD',
  '#E89A3C',
  '#5C8A4E',
  '#E0567A',
  '#B47B3F',
  '#5C677D',
];

// ---------- State ----------

let data = { people: [], circles: [] };
let peopleWindow = 200;
let peopleTruncated = false;

const state = {
  view: document.documentElement.getAttribute('data-app-view') === 'list' ? 'list' : 'grid',
  nav: { kind: 'all' }, // all | reconnect | upcoming | starred | circle(id) | journal | activity
  chip: 'all', // all | overdue | due | ok
  sortKey: 'last', // last | name | cadence
  sortDir: -1,
  search: '',
  selected: new Set(),
  detailsId: null,
  newMenuOpen: false,
  creatingCircle: false,
  renamingCircleId: null,
  narrow: false,
};

let visibleRows = []; // the person rows as rendered
let searchResults = null;
let searchSeq = 0;
let journalData = null;
let dashboardData = null;
let detailPerson = null; // the freshly-read PERSON for the open drawer
let detailAdders = {}; // which "+ add" affordances are revealed in the drawer

// `#list` starts out holding the kit's raw (non-Lit) skeleton markup
// (`showSkeleton`, at boot). Lit's standalone `render()` never clears a
// container's pre-existing children on its first commit — it only appends
// past them — so the first Lit commit into `#list` clears that skeleton
// itself; every commit after goes through `litRender` alone (a raw clear
// once Lit owns a container corrupts its part cache). `#grid` never holds
// non-Lit markup, so it needs no such guard.
let listMounted = false;
function mountGrid(tpl) {
  litRender(tpl, $('grid'));
}
function mountList(tpl) {
  const list = $('list');
  if (!listMounted) {
    list.replaceChildren();
    listMounted = true;
  }
  litRender(tpl, list);
}
function mountDetails(tpl) {
  litRender(tpl, $('detailsRoot'));
}

// ---------- Notice / consent narration (Docs' exact shape) ----------

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

// ---------- Formatting (prototype helpers, verbatim mapping) ----------

const DAY = 86400000;

// Days since last contact — derived from the timestamp (the prototype held an
// in-memory lastDays; here it's real).
function daysSince(p) {
  const iso = p.last_contacted_at ?? p.created_at;
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / DAY));
}

function fmt(d) {
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 7) return d + ' days ago';
  if (d < 14) return 'last week';
  if (d < 31) return Math.round(d / 7) + ' weeks ago';
  if (d < 61) return 'last month';
  return Math.round(d / 30) + ' months ago';
}
function shortFmt(d) {
  if (d <= 0) return 'now';
  if (d < 7) return d + 'd';
  if (d < 31) return Math.round(d / 7) + 'w';
  return Math.round(d / 30) + 'mo';
}
function inFmt(d) {
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d < 14) return 'in ' + d + ' days';
  if (d < 60) return 'in ' + Math.round(d / 7) + ' weeks';
  return 'in ' + Math.round(d / 30) + ' months';
}
function cadence(d) {
  return (
    {
      7: 'weekly',
      14: 'every 2 weeks',
      21: 'every 3 weeks',
      30: 'monthly',
      45: 'every 6 weeks',
      60: 'every 2 months',
      90: 'quarterly',
    }[d] || 'every ' + d + ' days'
  );
}

// A "MM-DD" annual date → days until its next occurrence from today.
function daysUntilAnnual(monthDay) {
  const parts = String(monthDay ?? '').split('-');
  if (parts.length !== 2) return 999;
  const mo = Number(parts[0]) - 1;
  const da = Number(parts[1]);
  if (Number.isNaN(mo) || Number.isNaN(da)) return 999;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let next = new Date(now.getFullYear(), mo, da);
  if (next < today) next = new Date(now.getFullYear() + 1, mo, da);
  return Math.round((next - today) / DAY);
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtMonthDay(monthDay) {
  const parts = String(monthDay ?? '').split('-');
  if (parts.length !== 2) return String(monthDay ?? '');
  const mo = Number(parts[0]) - 1;
  const da = Number(parts[1]);
  if (Number.isNaN(mo) || Number.isNaN(da) || mo < 0 || mo > 11) return String(monthDay);
  return `${MONTHS[mo]} ${da}`;
}
// A yyyy-mm-dd date value → "MM-DD".
function dateInputToMonthDay(v) {
  const parts = String(v ?? '').split('-');
  if (parts.length !== 3) return null;
  return `${parts[1]}-${parts[2]}`;
}

function fmtDay(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return String(iso).slice(0, 10);
  }
}
// A journal ENTRY carries a "YYYY-MM-DD" date; an AUTO row carries an iso.
function fmtJournalDate(v) {
  if (!v) return '';
  const s = String(v);
  const d = s.length === 10 ? new Date(s + 'T00:00:00') : new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Days since an iso, for activity/interaction relative time.
function daysSinceIso(iso) {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / DAY));
}

// ---------- Identity helpers ----------

function hashInt(s) {
  let n = 0;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i += 1) n = (n * 31 + str.charCodeAt(i)) >>> 0;
  return n;
}
// Avatar hue: honour a stored colour, else derive from the name hash.
function avatarColor(p) {
  return p.avatar_color || PALETTE[hashInt(p.name) % PALETTE.length];
}
// Circle chrome dot: deterministic from the circle id.
function circleColor(circleId) {
  if (circleId == null) return 'var(--ink-3)';
  return PALETTE[hashInt(circleId) % PALETTE.length];
}
function circleName(id) {
  if (id == null) return '—';
  const c = data.circles.find((x) => x.circle_id === id);
  return c ? c.name : '—';
}

// ---------- Status ----------

function statusOf(p) {
  const days = daysSince(p);
  const cad = p.cadence_days ?? 30;
  const over = days >= cad;
  const due = !over && days >= cad * 0.72;
  if (over) return { key: 'overdue', label: 'overdue', color: 'var(--danger)' };
  if (due) return { key: 'due', label: 'due soon', color: 'var(--c-family)' };
  return { key: 'ok', label: 'on track', color: 'var(--ok)' };
}

// ---------- Row derivation (client-side, like the prototype's in-memory list) ----------

function currentRows() {
  const { nav, chip, search } = state;
  let base;
  if (search.trim()) {
    base = searchResults ?? [];
  } else {
    base = data.people.slice();
    if (nav.kind === 'reconnect') base = base.filter((p) => daysSince(p) >= (p.cadence_days ?? 30));
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

// ---------- Popover (kebab + move-to-circle) ----------

function openPersonMenu(anchor, p) {
  openPopover(anchor, (box) => {
    litRender(
      html`
        <button
          type="button"
          class="kit-popover-item"
          role="menuitem"
          @click=${() => {
            closePopover();
            openDetails(p.party_id);
          }}
        >
          Open profile
        </button>
        <button
          type="button"
          class="kit-popover-item"
          role="menuitem"
          @click=${() => {
            closePopover();
            toggleStar(p);
          }}
        >
          ${p.starred ? 'Remove favorite' : 'Add to favorites'}
        </button>
        <div class="kit-popover-sep"></div>
        <p class="kit-popover-head">Move to circle</p>
        <button
          type="button"
          class="kit-popover-item"
          role="menuitem"
          ?disabled=${p.circle_id == null}
          @click=${() => {
            closePopover();
            movePerson(p, null, 'no circle');
          }}
        >
          <span class="kit-dotmini" style="background:var(--ink-3);"></span>No circle
        </button>
        ${repeat(
          data.circles,
          (c) => c.circle_id,
          (c) => html`
            <button
              type="button"
              class="kit-popover-item"
              role="menuitem"
              ?disabled=${p.circle_id === c.circle_id}
              @click=${() => {
                closePopover();
                movePerson(p, c.circle_id, c.name);
              }}
            >
              <span class="kit-dotmini" style="background:${circleColor(c.circle_id)};"></span
              >${c.name}
            </button>
          `,
        )}
      `,
      box,
    );
  });
}

// ---------- Person writes ----------

async function toggleStar(p) {
  const outcome = await act(p.starred ? 'unstar-person' : 'star-person', { party_id: p.party_id });
  if (!narrate(outcome)) return;
  toast(p.starred ? 'Favorite removed · receipted.' : 'Favorited · receipted.');
  await refresh();
}

async function movePerson(p, circleId, name) {
  const input = { party_id: p.party_id, ...(circleId == null ? {} : { circle_id: circleId }) };
  const outcome = await act('move-person', input);
  if (!narrate(outcome)) return;
  toast(`Moved to ${name} · receipted.`);
  await refresh();
}

async function logInteraction(p, kind, text) {
  const outcome = await act('log-interaction', { party_id: p.party_id, kind, text });
  if (!narrate(outcome)) return;
  toast(`Logged · receipted.`);
  await refresh();
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

// ---------- Sidebar render ----------

function navItemTpl({ icon, label, active, count, onClick }) {
  return html`<button
    type="button"
    class="d-nav-item"
    aria-current=${String(!!active)}
    @click=${onClick}
  >
    ${el(icon)}
    <span class="lbl">${label}</span>
    ${count != null ? html`<span class="d-nav-count">${count}</span>` : nothing}
  </button>`;
}

function renderSmartNav() {
  const all = data.people;
  const counts = {
    all: all.length,
    reconnect: all.filter((p) => daysSince(p) >= (p.cadence_days ?? 30)).length,
    upcoming: all.filter((p) => (p.reminders || []).length > 0).length,
    starred: all.filter((p) => p.starred).length,
  };
  litRender(
    html`
      ${navItemTpl({
        icon: I.people,
        label: 'All people',
        active: state.nav.kind === 'all',
        count: counts.all,
        onClick: () => selectNav({ kind: 'all' }),
      })}
      ${navItemTpl({
        icon: I.clock,
        label: 'Reconnect',
        active: state.nav.kind === 'reconnect',
        count: counts.reconnect,
        onClick: () => selectNav({ kind: 'reconnect' }),
      })}
      ${navItemTpl({
        icon: I.bell,
        label: 'Upcoming',
        active: state.nav.kind === 'upcoming',
        count: counts.upcoming,
        onClick: () => selectNav({ kind: 'upcoming' }),
      })}
      ${navItemTpl({
        icon: I.star,
        label: 'Favorites',
        active: state.nav.kind === 'starred',
        count: counts.starred,
        onClick: () => selectNav({ kind: 'starred' }),
      })}
    `,
    $('smartNav'),
  );
}

// The circle rename/create rows are small imperative islands (kit's h()
// builder): focus-on-open + Enter/Escape wiring, same idiom as the drawer's
// "+ add" forms below.
function circleEditRow(c) {
  const input = h('input', {
    type: 'text',
    'aria-label': 'Circle name',
    placeholder: 'Circle name…',
  });
  input.value = c.name;
  const save = h('button', { type: 'button' }, 'Save');
  const commit = () => {
    const name = input.value.trim();
    if (name && name !== c.name) renameCircle(c.circle_id, name);
    else {
      state.renamingCircleId = null;
      render();
    }
  };
  save.addEventListener('click', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    }
    if (e.key === 'Escape') {
      state.renamingCircleId = null;
      render();
    }
  });
  const row = h('div', { class: 'd-folder-edit' }, input, save);
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
  return row;
}

function circleCreateRow() {
  const input = h('input', {
    type: 'text',
    placeholder: 'Circle name…',
    'aria-label': 'New circle name',
  });
  const create = h('button', { type: 'button' }, 'Create');
  const commit = () => {
    const name = input.value.trim();
    if (name) createCircle(name);
    else {
      state.creatingCircle = false;
      render();
    }
  };
  create.addEventListener('click', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    }
    if (e.key === 'Escape') {
      state.creatingCircle = false;
      render();
    }
  });
  const row = h('div', { class: 'd-folder-edit' }, input, create);
  setTimeout(() => input.focus(), 0);
  return row;
}

function circleRowTpl(c) {
  if (state.renamingCircleId === c.circle_id) return circleEditRow(c);
  const count = data.people.filter((p) => (p.circle_id ?? null) === c.circle_id).length;
  const active = state.nav.kind === 'circle' && state.nav.circleId === c.circle_id;
  return html`<div class="d-folder">
    <button
      type="button"
      class="d-nav-item"
      aria-current=${String(active)}
      @click=${() => selectNav({ kind: 'circle', circleId: c.circle_id })}
    >
      <span class="d-nav-dot" style="background:${circleColor(c.circle_id)};"></span>
      <span class="lbl">${c.name}</span>
      <span class="d-nav-count">${count || ''}</span>
    </button>
    <span class="d-folder-tools">
      <button
        type="button"
        class="d-tool-btn"
        aria-label="Rename ${c.name}"
        @click=${(e) => {
          e.stopPropagation();
          state.renamingCircleId = c.circle_id;
          render();
        }}
      >
        ${el(I.rename)}
      </button>
      <button
        type="button"
        class="d-tool-btn danger"
        aria-label="Delete ${c.name}"
        @click=${(e) => {
          e.stopPropagation();
          if (!armConfirm(e.currentTarget, { armedLabel: '×?' })) return;
          deleteCircle(c);
        }}
      >
        ${el(I.del)}
      </button>
    </span>
  </div>`;
}

function renderCircleList() {
  litRender(
    html`${data.circles.map((c) => circleRowTpl(c))}${state.creatingCircle
      ? circleCreateRow()
      : nothing}`,
    $('circleList'),
  );
}

function renderJournalNav() {
  litRender(
    html`
      ${navItemTpl({
        icon: I.journal,
        label: 'Journal',
        active: state.nav.kind === 'journal',
        onClick: () => selectNav({ kind: 'journal' }),
      })}
      ${navItemTpl({
        icon: I.activity,
        label: 'Activity',
        active: state.nav.kind === 'activity',
        onClick: () => selectNav({ kind: 'activity' }),
      })}
    `,
    $('journalNav'),
  );
}

function renderStorage() {
  const count = data.people.length;
  litRender(
    html`
      <div class="d-storage-top">
        <span class="lbl">People</span>
        <span class="val">${count}</span>
      </div>
      <div class="d-storage-label">
        ${count} ${count === 1 ? 'person' : 'people'} across ${data.circles.length}
        circle${data.circles.length === 1 ? '' : 's'}
      </div>
    `,
    $('storage'),
  );
}

function renderSidebar() {
  renderSmartNav();
  renderCircleList();
  renderJournalNav();
  renderStorage();
}

// ---------- Toolbar render ----------

function renderToolbar() {
  const rows = visibleRows;
  const nav = state.nav;
  const isPeople = ['all', 'reconnect', 'upcoming', 'starred', 'circle'].includes(nav.kind);
  const titles = {
    all: 'All people',
    reconnect: 'Reconnect',
    upcoming: 'Upcoming',
    starred: 'Favorites',
    journal: 'Journal',
    activity: 'Activity',
  };
  let title = nav.kind === 'circle' ? circleName(nav.circleId) : titles[nav.kind];
  if (state.search.trim()) title = `Results for "${state.search.trim()}"`;
  $('activeTitle').textContent = title;

  const n = rows.length;
  let sub;
  if (nav.kind === 'journal') sub = 'A private line about your days and the people in them';
  else if (nav.kind === 'activity') sub = 'Every touch you have logged, most recent first';
  else if (state.search.trim()) sub = `${n} ${n === 1 ? 'match' : 'matches'}`;
  else if (nav.kind === 'reconnect') sub = `${n} overdue · sorted by how long it has been`;
  else if (nav.kind === 'upcoming') sub = `${n} with reminders · birthdays and dates`;
  else if (nav.kind === 'starred') sub = `${n} favorite${n === 1 ? '' : 's'}`;
  else sub = `${n} ${n === 1 ? 'person' : 'people'}`;
  $('activeSub').textContent = sub;

  $('peopleTools').hidden = !isPeople;
  if (isPeople) {
    const chipDefs = [
      ['all', 'All'],
      ['overdue', 'Overdue'],
      ['due', 'Due soon'],
      ['ok', 'On track'],
    ];
    litRender(
      html`${chipDefs.map(
        ([key, label]) => html`<button
          type="button"
          class="kit-chip quiet"
          aria-pressed=${String(state.chip === key)}
          @click=${() => {
            state.chip = key;
            clearSelection();
            render();
          }}
        >
          ${label}
        </button>`,
      )}`,
      $('statusChips'),
    );
    const sortNames = { last: 'Last spoke', name: 'Name', cadence: 'Cadence' };
    $('sortLabel').textContent = `${sortNames[state.sortKey]} ${state.sortDir === 1 ? '↑' : '↓'}`;
  }

  $('viewGrid').setAttribute('aria-pressed', String(state.view === 'grid'));
  $('viewList').setAttribute('aria-pressed', String(state.view === 'list'));
}

// ---------- Bulk bar ----------

function renderBulk() {
  const bar = $('bulkBar');
  const n = state.selected.size;
  bar.hidden = n === 0;
  if (n === 0) return;
  litRender(
    html`
      <span class="d-bulk-count">${n} selected</span>
      <div class="d-bulk-actions">
        <button
          type="button"
          class="kit-btn"
          @click=${() =>
            runBulk([...state.selected], (id) => act('star-person', { party_id: id }), {
              progress: 'Favoriting',
              done: 'Favorited',
              ...bulkOpts,
            })}
        >
          Favorite
        </button>
        <button
          type="button"
          class="kit-btn"
          @click=${() => {
            clearSelection();
            render();
          }}
        >
          Clear
        </button>
      </div>
    `,
    bar,
  );
}

// ---------- Rows: grid + list ----------

function metaLine(p) {
  return `Last spoke ${shortFmt(daysSince(p))}`;
}

function gridCardTpl(p) {
  const color = avatarColor(p);
  const st = statusOf(p);
  const selected = state.selected.has(p.party_id);
  return html`<div class="d-card" data-selected=${String(selected)}>
    <div
      class="d-card-top"
      style="background:color-mix(in oklab, ${color} 12%, transparent);"
      @click=${() => openDetails(p.party_id)}
    >
      <kit-avatar .name=${p.name} size="58px" .color=${color}></kit-avatar>
    </div>
    <button
      type="button"
      class="d-card-select"
      aria-pressed=${String(selected)}
      aria-label="Select ${p.name}"
      @click=${(e) => {
        e.stopPropagation();
        toggleSelect(p.party_id);
      }}
    >
      ${selected ? el(I.check) : nothing}
    </button>
    <button
      type="button"
      class=${p.starred ? 'd-card-star on' : 'd-card-star'}
      aria-label="Favorite"
      @click=${(e) => {
        e.stopPropagation();
        toggleStar(p);
      }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill=${p.starred ? 'currentColor' : 'none'}
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="m12 3 2.6 5.6 6 .7-4.5 4.2 1.2 6-5.3-3-5.3 3 1.2-6L3.4 9.3l6-.7z"></path>
      </svg>
    </button>
    <div class="d-card-body" @click=${() => openDetails(p.party_id)}>
      <div class="d-card-title">${p.name}</div>
      <div class="d-card-role">${p.role || ''}</div>
      <div class="d-card-meta">
        <span class="kit-dotmini" style="background:${st.color};"></span>${metaLine(p)}
      </div>
    </div>
  </div>`;
}

function listRowTpl(p) {
  const color = avatarColor(p);
  const st = statusOf(p);
  const selected = state.selected.has(p.party_id);
  return html`<div class="d-row" data-selected=${String(selected)}>
    <button
      type="button"
      class="d-check"
      aria-pressed=${String(selected)}
      aria-label="Select ${p.name}"
      @click=${(e) => {
        e.stopPropagation();
        toggleSelect(p.party_id);
      }}
    >
      ${selected ? el(I.check) : nothing}
    </button>
    <kit-avatar
      style="cursor:pointer;"
      .name=${p.name}
      size="34px"
      .color=${color}
      @click=${(e) => {
        e.stopPropagation();
        openDetails(p.party_id);
      }}
    ></kit-avatar>
    <div class="d-row-main" @click=${() => openDetails(p.party_id)}>
      <div class="d-row-title">
        ${p.name}${p.starred
          ? html`<span class="d-star-ind" aria-label="Favorite">★</span>`
          : nothing}
      </div>
      <div class="d-row-role">${p.role || ''}</div>
      ${state.search.trim() && p.snippet
        ? html`<div
            class="d-row-role"
            ${ref((elm) => {
              if (!elm) return;
              elm.replaceChildren();
              snippetInto(elm, p.snippet);
            })}
          ></div>`
        : nothing}
    </div>
    <span class="d-cell circle" @click=${() => openDetails(p.party_id)}
      >${circleName(p.circle_id ?? null)}</span
    >
    <span class="d-cell last" @click=${() => openDetails(p.party_id)}
      >${shortFmt(daysSince(p))}</span
    >
    <span class="d-cell status">
      <span class="kit-dotmini" style="background:${st.color};"></span>${st.label}
    </span>
    <div class="d-row-end">
      <button
        type="button"
        class="d-kebab"
        aria-label="Actions for ${p.name}"
        aria-haspopup="menu"
        @click=${(e) => {
          e.stopPropagation();
          openPersonMenu(e.currentTarget, p);
        }}
      >
        ${el(I.dots)}
      </button>
    </div>
  </div>`;
}

function listHeadTpl(rows) {
  const allSel = rows.length > 0 && rows.every((p) => state.selected.has(p.party_id));
  return html`
    <button
      type="button"
      class="d-check"
      aria-pressed=${String(allSel)}
      aria-label=${allSel ? 'Deselect all' : 'Select all'}
      @click=${() => {
        if (allSel) for (const p of rows) state.selected.delete(p.party_id);
        else for (const p of rows) state.selected.add(p.party_id);
        render();
      }}
    >
      ${allSel ? el(I.check) : nothing}
    </button>
    <span style="width:34px;"></span>
    <span class="d-col name">Name</span>
    <span class="d-col circle">Circle</span>
    <span class="d-col last">Last spoke</span>
    <span class="d-col status">Status</span>
    <span class="d-col end"></span>
  `;
}
function renderListHead(rows) {
  litRender(listHeadTpl(rows), $('listHead'));
}

function gridTpl(rows) {
  return html`${repeat(rows, (p) => p.party_id, gridCardTpl)}`;
}
function listTpl(rows) {
  return html`${repeat(rows, (p) => p.party_id, listRowTpl)}`;
}

function renderRows() {
  const nav = state.nav;
  const grid = $('grid');
  const listWrap = $('listWrap');
  const listHead = $('listHead');
  const empty = $('empty');
  const foot = $('windowFoot');
  const journalView = $('journalView');
  const activityView = $('activityView');
  grid.hidden = true;
  listWrap.hidden = true;
  empty.hidden = true;
  foot.hidden = true;
  journalView.hidden = true;
  activityView.hidden = true;
  mountGrid(nothing);
  mountList(nothing);

  if (nav.kind === 'journal') {
    renderJournal(journalView);
    return;
  }
  if (nav.kind === 'activity') {
    renderActivity(activityView);
    return;
  }

  const rows = visibleRows;
  if (rows.length === 0) {
    const searching = !!state.search.trim();
    const title = searching
      ? 'No matches'
      : nav.kind === 'starred'
        ? 'No favorites yet'
        : nav.kind === 'reconnect'
          ? 'All caught up'
          : 'No one here yet';
    const sub = searching
      ? 'Try fewer words.'
      : nav.kind === 'reconnect'
        ? 'Nobody is overdue right now — nice.'
        : 'Add someone from the New button to start keeping in touch.';
    emptyState($('empty'), { icon: I.people, title, sub });
    return;
  }

  if (state.view === 'grid') {
    grid.hidden = false;
    mountGrid(gridTpl(rows));
  } else {
    listWrap.hidden = false;
    listHead.hidden = state.narrow;
    if (!state.narrow) renderListHead(rows);
    mountList(listTpl(rows));
  }

  if (peopleTruncated && !state.search.trim()) {
    foot.hidden = false;
    litRender(
      html`
        <span>Showing your first ${peopleWindow} people — the rest are a search away.</span>
        <button
          type="button"
          @click=${async (e) => {
            e.target.disabled = true;
            peopleWindow += 200;
            await refresh();
          }}
        >
          Show more
        </button>
      `,
      foot,
    );
  }
}

// ---------- Journal view ----------

let journalDraft = '';
let journalMood = '🙂';

function journalEntryTpl(j) {
  if (j.kind === 'auto') {
    const color = j.avatar_color || PALETTE[hashInt(j.name) % PALETTE.length];
    return html`<div class="j-entry">
      <kit-avatar
        style="cursor:pointer;"
        .name=${j.name}
        size="40px"
        .color=${color}
        @click=${() => j.party_id && openDetails(j.party_id)}
      ></kit-avatar>
      <div style="flex:1;min-width:0;">
        <div class="dt">${fmtJournalDate(j.date)} · ${j.touch}</div>
        <p>${j.text}</p>
      </div>
    </div>`;
  }
  return html`<div class="j-entry">
    <span class="em">${j.mood}</span>
    <div style="flex:1;min-width:0;">
      <div class="dt">${fmtJournalDate(j.date)}</div>
      <p>${j.text}</p>
    </div>
  </div>`;
}

function journalTpl() {
  const entries = journalData?.entries ?? [];
  const addBtnRef = createRef();
  return html`<div class="j-wrap">
    <div class="j-compose">
      <div style="font:var(--t-strong);font-size:14px;">How was today?</div>
      <div class="j-moodrow">
        ${['😔', '😐', '🙂', '😄'].map(
          (emoji) => html`<button
            type="button"
            class="j-mood"
            aria-pressed=${String(journalMood === emoji)}
            @click=${() => {
              journalMood = emoji;
              renderRows();
            }}
          >
            ${emoji}
          </button>`,
        )}
      </div>
      <textarea
        class="j-text"
        rows="2"
        placeholder="Write a line…"
        .value=${journalDraft}
        @input=${(e) => {
          journalDraft = e.target.value;
          if (addBtnRef.value) addBtnRef.value.disabled = !journalDraft.trim();
        }}
      ></textarea>
      <div style="display:flex;justify-content:flex-end;margin-top:8px;">
        <button
          ${ref(addBtnRef)}
          type="button"
          class="kit-btn primary"
          ?disabled=${!journalDraft.trim()}
          @click=${async () => {
            const text = journalDraft.trim();
            if (!text) return;
            const outcome = await act('add-journal-entry', { mood: journalMood, text });
            if (!narrate(outcome)) return;
            journalDraft = '';
            toast('Entry added · receipted.');
            await loadJournal();
            renderRows();
          }}
        >
          Add entry
        </button>
      </div>
    </div>
    <div style="margin-top:8px;">
      ${entries.length === 0
        ? html`<p style="font:var(--t-small);color:var(--ink-3);padding:16px 0;">
            No entries yet — start with a line above.
          </p>`
        : entries.map((j) => journalEntryTpl(j))}
    </div>
  </div>`;
}

function renderJournal(root) {
  root.hidden = false;
  litRender(journalTpl(), root);
}

// ---------- Activity view ----------

function activityItemTpl(a) {
  const color = a.avatar_color || PALETTE[hashInt(a.name) % PALETTE.length];
  return html`<div class="d-activity-item">
    <div class="d-activity-rail">
      <kit-avatar
        style="cursor:pointer;"
        .name=${a.name}
        size="36px"
        .color=${color}
        @click=${() => a.party_id && openDetails(a.party_id)}
      ></kit-avatar>
      <span class="d-activity-line"></span>
    </div>
    <div style="flex:1;min-width:0;padding-top:2px;">
      <div style="display:flex;align-items:baseline;gap:8px;">
        <span style="font:var(--t-strong);font-size:14px;">${a.name}</span>
        <span class="d-activity-kind" style="color:${color};">${a.kind}</span>
        <span class="d-activity-date" style="margin-left:auto;"
          >${fmt(daysSinceIso(a.occurred_at))}</span
        >
      </div>
      <p style="margin:4px 0 14px;font:var(--t-body);color:var(--ink-2);line-height:1.5;">
        ${a.text || ''}
      </p>
    </div>
  </div>`;
}

function activityTpl() {
  const recent = dashboardData?.recent ?? [];
  if (recent.length === 0) {
    return html`<div class="kit-empty">
      <div class="kit-empty-icon">${el(I.activity)}</div>
      <div class="kit-empty-title">Nothing logged yet</div>
      <div class="kit-empty-sub">
        Log a message or call from anyone’s profile and it shows up here.
      </div>
    </div>`;
  }
  return html`<div class="j-wrap">${recent.map((a) => activityItemTpl(a))}</div>`;
}

function renderActivity(root) {
  root.hidden = false;
  litRender(activityTpl(), root);
}

// ---------- New menu ----------

function renderNewMenu() {
  const menu = $('newMenu');
  menu.hidden = !state.newMenuOpen;
  $('newBtn').setAttribute('aria-expanded', String(state.newMenuOpen));
  if (!state.newMenuOpen) {
    litRender(nothing, menu);
    return;
  }
  litRender(
    html`
      <button
        type="button"
        class="d-menu-item"
        role="menuitem"
        @click=${() => {
          state.newMenuOpen = false;
          renderNewMenu();
          openAddModal();
        }}
      >
        ${el(I.addPerson)}Add person
      </button>
      <div class="d-menu-sep"></div>
      <button
        type="button"
        class="d-menu-item"
        role="menuitem"
        @click=${() => {
          state.newMenuOpen = false;
          state.creatingCircle = true;
          render();
        }}
      >
        ${el(I.circlePlus)}New circle
      </button>
    `,
    menu,
  );
}

// ---------- Profile drawer ----------

async function openDetails(id) {
  state.detailsId = id;
  detailPerson = null;
  detailAdders = {};
  renderDetails(); // paints a shell immediately
  await loadDetail(id);
}
function closeDetails() {
  state.detailsId = null;
  detailPerson = null;
  renderDetails();
}
async function loadDetail(id) {
  try {
    const res = await window.centraid.read({ query: 'person', input: { party_id: id } });
    if (res?.vaultDenied) return;
    if (state.detailsId !== id) return;
    detailPerson = res?.person ?? null;
    renderDetails();
  } catch (err) {
    notice(String(err?.message ?? err));
  }
}

// A dashed "+ add" input row (the prototype's .d-noteadd idiom) — a small
// imperative island: the plus button repaints on every keystroke without a
// re-render, and Enter/blur wiring lives directly on the real inputs.
function addRow(children, onCommit, { canCommit } = {}) {
  const row = h('div', { class: 'd-noteadd' }, ...children);
  const btn = h('button', {
    type: 'button',
    class: 'd-mini-btn',
    'aria-label': 'Add',
    html: I.plus,
  });
  const paint = () => {
    const on = !canCommit || canCommit();
    btn.style.background = on ? 'var(--accd)' : 'color-mix(in oklab, var(--ink) 8%, transparent)';
    btn.style.color = on ? '#fff' : 'var(--ink-3)';
  };
  row.addEventListener('input', paint);
  btn.addEventListener('click', () => onCommit());
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onCommit();
    }
  });
  row.appendChild(btn);
  paint();
  return row;
}

function relationshipAddRow(onSubmit) {
  const nameI = h('input', { placeholder: 'Name', 'aria-label': 'Relationship name' });
  const kindI = h('input', {
    class: 'narrow',
    placeholder: 'Kind',
    'aria-label': 'Relationship kind',
  });
  const petI = h('input', {
    class: 'narrow',
    placeholder: 'Pet?',
    'aria-label': 'Pet kind (optional)',
  });
  return addRow(
    [nameI, kindI, petI],
    () => {
      const name = nameI.value.trim();
      const kind = kindI.value.trim();
      if (!name || !kind) return;
      onSubmit({ name, kind, ...(petI.value.trim() ? { pet: petI.value.trim() } : {}) });
    },
    { canCommit: () => nameI.value.trim() && kindI.value.trim() },
  );
}

function dateAddRow(onSubmit) {
  const labelI = h('input', { placeholder: 'Label (Birthday…)', 'aria-label': 'Date label' });
  const dateI = h('input', { type: 'date', class: 'narrow', 'aria-label': 'Date' });
  return addRow(
    [labelI, dateI],
    () => {
      const label = labelI.value.trim();
      const md = dateInputToMonthDay(dateI.value);
      if (!label || !md) return;
      onSubmit({ label, month_day: md, reminder_on: true });
    },
    { canCommit: () => labelI.value.trim() && dateI.value },
  );
}

function taskAddRow(onSubmit) {
  const ti = h('input', { placeholder: 'Add a task…', 'aria-label': 'Task text' });
  return addRow(
    [ti],
    () => {
      const text = ti.value.trim();
      if (!text) return;
      onSubmit({ text });
    },
    { canCommit: () => ti.value.trim() },
  );
}

function noteAddRow(onSubmit) {
  const noteI = h('input', { placeholder: 'Add a note…', 'aria-label': 'Note text' });
  return addRow(
    [noteI],
    () => {
      const text = noteI.value.trim();
      if (!text) return;
      onSubmit({ text });
    },
    { canCommit: () => noteI.value.trim() },
  );
}

function giftAddRow(onSubmit) {
  const gi = h('input', { placeholder: 'A gift idea…', 'aria-label': 'Gift idea' });
  return addRow(
    [gi],
    () => {
      const text = gi.value.trim();
      if (!text) return;
      onSubmit({ text });
    },
    { canCommit: () => gi.value.trim() },
  );
}

function debtAddRow(onSubmit) {
  let dir = 'owe';
  const seg = h('div', { class: 'kit-seg d-seg' });
  const oweB = h('button', { type: 'button', 'aria-pressed': 'true' }, 'You owe');
  const owedB = h('button', { type: 'button', 'aria-pressed': 'false' }, 'Owes you');
  oweB.addEventListener('click', () => {
    dir = 'owe';
    oweB.setAttribute('aria-pressed', 'true');
    owedB.setAttribute('aria-pressed', 'false');
  });
  owedB.addEventListener('click', () => {
    dir = 'owed';
    owedB.setAttribute('aria-pressed', 'true');
    oweB.setAttribute('aria-pressed', 'false');
  });
  seg.append(oweB, owedB);
  const amtI = h('input', {
    class: 'narrow',
    type: 'number',
    min: '0',
    step: '0.01',
    placeholder: '$0.00',
    'aria-label': 'Amount',
  });
  const reasonI = h('input', { placeholder: 'Reason', 'aria-label': 'Reason' });
  return addRow(
    [seg, amtI, reasonI],
    () => {
      const dollars = parseFloat(amtI.value);
      if (!(dollars > 0)) return;
      onSubmit({
        direction: dir,
        amount_minor: Math.round(dollars * 100),
        ...(reasonI.value.trim() ? { reason: reasonI.value.trim() } : {}),
      });
    },
    { canCommit: () => parseFloat(amtI.value) > 0 },
  );
}

// A section label + an optional "+ add" reveal toggle (and, for Debts, a net
// summary riding alongside the label).
function sectionLabelTpl(text, key, open, onToggle, extra) {
  return html`<div class="d-detail-label">
    ${text}${extra ?? nothing}${key
      ? html`<button type="button" class="d-addtoggle" @click=${onToggle}>
          ${open ? 'close' : '+ add'}
        </button>`
      : nothing}
  </div>`;
}

async function drawerAct(action, input, message) {
  const outcome = await act(action, input);
  if (!narrate(outcome)) return;
  toast(`${message} · receipted.`);
  await refresh();
  if (state.detailsId) await loadDetail(state.detailsId);
}

/**
 * `<people-details>` — the profile drawer (issue: People's Lit conversion).
 * A dumb projection: `person` is the freshly-read PERSON (or null while the
 * shell shows), `adders` is a snapshot of which "+ add" affordances are
 * open. Every write flows out through the `on*` callback properties into
 * `drawerAct`/`toggleStar`/`logInteraction` — the component never calls the
 * vault itself. The "+ add" mini-forms stay small imperative islands (see
 * `addRow` family above); everything else here is a plain `html` template.
 */
class PeopleDetails extends KitElement {
  static properties = {
    person: { attribute: false },
    nameGuess: { type: String },
    color: { type: String },
    adders: { attribute: false },
    onClose: { attribute: false },
    onMove: { attribute: false },
    onMessage: { attribute: false },
    onCall: { attribute: false },
    onToggleStar: { attribute: false },
    onToggleAdder: { attribute: false },
    onAddRelationship: { attribute: false },
    onAddDate: { attribute: false },
    onToggleReminder: { attribute: false },
    onAddTask: { attribute: false },
    onToggleTask: { attribute: false },
    onAddNote: { attribute: false },
    onAddGift: { attribute: false },
    onToggleGift: { attribute: false },
    onAddDebt: { attribute: false },
    onSettleDebt: { attribute: false },
  };

  constructor() {
    super();
    this.person = null;
    this.nameGuess = '';
    this.color = '';
    this.adders = {};
  }

  render() {
    const dp = this.person;
    // The host stays `display: contents` (no aria/role there — see the
    // conversion's rule against hanging aria on a contents host); the real
    // `<aside>` below is the positioned box and carries the dialog semantics.
    return html`
      <aside class="d-details" role="dialog" aria-modal="true" aria-label="Profile">
        <div class="d-details-head">
          <span class="lbl">Profile</span>
          <button
            type="button"
            class="d-details-x"
            aria-label="Close"
            @click=${() => this.onClose?.()}
          >
            ${el(I.close)}
          </button>
        </div>
        <div class="d-details-body">
          <div style="display:flex;flex-direction:column;align-items:center;">
            <span
              style="display:inline-flex;border-radius:999px;box-shadow:0 8px 22px -6px color-mix(in oklab, ${this
                .color} 60%, transparent);"
            >
              <kit-avatar .name=${this.nameGuess} size="72px" .color=${this.color}></kit-avatar>
            </span>
          </div>
          <div class="d-detail-name">${this.nameGuess}</div>
          <div class="d-detail-ext">${dp?.role || ''}</div>
          ${dp ? this.#sections(dp) : nothing}
        </div>
        <div class="d-details-foot">
          ${dp
            ? html`<button
                type="button"
                class="kit-btn d-detail-btn"
                @click=${(e) => this.onMove?.(e.currentTarget)}
              >
                Move to circle
              </button>`
            : nothing}
        </div>
      </aside>
    `;
  }

  #sections(dp) {
    const st = statusOf(dp);
    const days = daysSince(dp);
    const adders = this.adders ?? {};
    const contact = dp.contact ?? [];
    const rels = dp.relationships ?? [];
    const tasks = dp.tasks ?? [];
    const gifts = dp.gifts ?? [];
    const notes = dp.notes ?? [];
    const interactions = dp.interactions ?? [];
    return html`
      <div class="d-detail-actions">
        <button
          type="button"
          class="kit-btn primary d-detail-btn"
          @click=${() => this.onMessage?.()}
        >
          ${el(I.message)}Message
        </button>
        <button type="button" class="kit-btn d-detail-btn" @click=${() => this.onCall?.()}>
          ${el(I.call)}Call
        </button>
        <button type="button" class="kit-btn d-detail-btn" @click=${() => this.onToggleStar?.()}>
          ${dp.starred ? '★ Favorite' : '☆ Favorite'}
        </button>
      </div>

      <div
        style="border:1px solid var(--line);border-radius:12px;background:var(--bg-elev);padding:13px 15px;display:flex;align-items:center;justify-content:space-between;"
      >
        <div>
          <div style="font:var(--t-strong);font-size:13px;">Keep in touch</div>
          <div style="font:var(--t-small);font-size:12px;color:var(--ink-2);margin-top:2px;">
            ${cadence(dp.cadence_days ?? 30)} · last ${fmt(days)}
          </div>
        </div>
        <span class="kit-chip quiet d-chip-sm" style="border-color:${st.color};color:${st.color};"
          >${st.label}</span
        >
      </div>

      ${dp.met
        ? html`<div class="d-detail-label">How you met</div>
            <p style="margin:0;font:var(--t-body);color:var(--ink-2);line-height:1.5;">
              ${dp.met}
            </p>`
        : nothing}
      ${contact.length > 0
        ? html`<div class="d-detail-label">Contact</div>
            <div class="d-kv">
              ${contact.map(
                (c) => html`<div class="d-kv-row">
                  ${el(c.kind === 'phone' ? I.phone : I.mail)}
                  <span class="d-kv-v">${c.value}</span>
                  <span class="d-kv-k">${c.kind}</span>
                </div>`,
              )}
            </div>`
        : nothing}
      ${sectionLabelTpl('Relationships', 'rel', !!adders.rel, () => this.onToggleAdder?.('rel'))}
      ${rels.length > 0
        ? html`<div>
            ${rels.map(
              (r) => html`<div class="d-rel">
                <span class="d-rel-badge"
                  >${r.pet === 'cat' ? '🐱' : r.pet === 'dog' ? '🐶' : r.name?.[0] || '·'}</span
                >
                <span style="flex:1;font:var(--t-body);font-weight:500;">${r.name}</span>
                <span style="font:var(--t-small);font-size:11.5px;color:var(--ink-3);"
                  >${r.kind}</span
                >
              </div>`,
            )}
          </div>`
        : nothing}
      ${adders.rel ? relationshipAddRow((fields) => this.onAddRelationship?.(fields)) : nothing}
      ${sectionLabelTpl('Important dates', 'date', !!adders.date, () =>
        this.onToggleAdder?.('date'),
      )}
      ${(dp.dates ?? []).length > 0
        ? html`<div class="d-kv">
            ${repeat(
              dp.dates ?? [],
              (d) => d.date_id,
              (d) => html`<div class="d-kv-row">
                <span style="flex:1;">
                  <span style="display:block;font:var(--t-body);font-weight:500;">${d.label}</span>
                  <span style="display:block;font:var(--t-small);font-size:12px;color:var(--ink-3);"
                    >${fmtMonthDay(d.month_day)} · ${inFmt(daysUntilAnnual(d.month_day))}</span
                  >
                </span>
                <button
                  type="button"
                  class="d-mini-btn"
                  aria-label="Reminder"
                  style="background:${d.reminder_on
                    ? 'color-mix(in oklab, var(--_accent) 12%, transparent)'
                    : 'color-mix(in oklab, var(--ink) 5%, transparent)'};color:${d.reminder_on
                    ? 'var(--_accent)'
                    : 'var(--ink-3)'};"
                  @click=${() => this.onToggleReminder?.(d.date_id)}
                >
                  ${el(I.bellSm)}
                </button>
              </div>`,
            )}
          </div>`
        : nothing}
      ${adders.date ? dateAddRow((fields) => this.onAddDate?.(fields)) : nothing}
      ${sectionLabelTpl('Tasks', 'task', !!adders.task, () => this.onToggleAdder?.('task'))}
      ${tasks.length > 0
        ? html`<div>
            ${repeat(
              tasks,
              (t) => t.task_id,
              (t) => html`<div class="d-taskrow">
                <button
                  type="button"
                  class=${t.done ? 'd-taskbox on' : 'd-taskbox'}
                  aria-label="Toggle task"
                  @click=${() => this.onToggleTask?.(t.task_id)}
                >
                  ${t.done ? el(I.checkTask) : nothing}
                </button>
                <span
                  style="flex:1;font:var(--t-body);color:${t.done
                    ? 'var(--ink-3)'
                    : 'var(--ink)'};text-decoration:${t.done ? 'line-through' : 'none'};"
                  >${t.text}</span
                >
              </div>`,
            )}
          </div>`
        : nothing}
      ${adders.task ? taskAddRow((fields) => this.onAddTask?.(fields)) : nothing}

      <div class="d-detail-label">Notes</div>
      <div>
        ${notes.map(
          (nn) => html`<div class="d-note">
            <p>${nn.text}</p>
            <div class="when">${fmt(daysSinceIso(nn.created_at))}</div>
          </div>`,
        )}${noteAddRow((fields) => this.onAddNote?.(fields))}
      </div>

      ${sectionLabelTpl('Gift ideas', 'gift', !!adders.gift, () => this.onToggleAdder?.('gift'))}
      ${gifts.length > 0
        ? html`<div>
            ${repeat(
              gifts,
              (g) => g.gift_id,
              (g) => {
                const given = g.state === 'given';
                return html`<div class="d-taskrow">
                  ${el(I.gift)}
                  <span
                    style="flex:1;font:var(--t-body);color:${given
                      ? 'var(--ink-3)'
                      : 'var(--ink)'};text-decoration:${given ? 'line-through' : 'none'};"
                    >${g.text}</span
                  >
                  <button
                    type="button"
                    class="kit-chip quiet d-chip-sm"
                    style="border-color:${given
                      ? 'color-mix(in oklab, var(--ok) 30%, transparent)'
                      : 'color-mix(in oklab, var(--c-family) 30%, transparent)'};background:${given
                      ? 'color-mix(in oklab, var(--ok) 14%, transparent)'
                      : 'color-mix(in oklab, var(--c-family) 14%, transparent)'};color:${given
                      ? 'var(--ok)'
                      : 'var(--c-family)'};"
                    @click=${() => this.onToggleGift?.(g.gift_id)}
                  >
                    ${g.state}
                  </button>
                </div>`;
              },
            )}
          </div>`
        : nothing}
      ${adders.gift ? giftAddRow((fields) => this.onAddGift?.(fields)) : nothing}
      ${this.#debtsSection(dp)}
      ${interactions.length > 0
        ? html`<div class="d-detail-label">History</div>
            <div>
              ${interactions.map(
                (t) => html`<div class="d-activity-item">
                  <div class="d-activity-rail">
                    <span class="d-activity-dot" style="background:${this.color};"></span>
                    <span class="d-activity-line"></span>
                  </div>
                  <div style="flex:1;min-width:0;">
                    <div style="display:flex;align-items:center;gap:6px;">
                      <span class="d-activity-kind" style="color:var(--ink-2);">${t.kind}</span>
                      <span class="d-activity-date" style="margin-left:auto;"
                        >${fmt(daysSinceIso(t.occurred_at))}</span
                      >
                    </div>
                    <div
                      style="margin-top:2px;font:var(--t-body);font-size:13.5px;color:var(--ink-2);"
                    >
                      ${t.text || ''}
                    </div>
                  </div>
                </div>`,
              )}
            </div>`
        : nothing}
    `;
  }

  #debtsSection(dp) {
    const adders = this.adders ?? {};
    const debts = dp.debts ?? [];
    const net = debts.reduce(
      (a, b) => a + (b.direction === 'owed' ? b.amount_minor : -b.amount_minor),
      0,
    );
    const netLabel =
      net === 0
        ? 'settled'
        : net > 0
          ? `net owes you ${fmtMoney(net, 'USD')}`
          : `net you owe ${fmtMoney(-net, 'USD')}`;
    const netEl =
      debts.length > 0
        ? html`<span
            style="font-family:var(--mono);font-size:11px;text-transform:none;letter-spacing:0;color:${net >=
            0
              ? 'var(--ok)'
              : 'var(--ink-3)'};"
            >${netLabel}</span
          >`
        : nothing;
    return html`
      ${sectionLabelTpl('Debts', 'debt', !!adders.debt, () => this.onToggleAdder?.('debt'), netEl)}
      ${debts.length > 0
        ? html`<div class="d-kv">
            ${repeat(
              debts,
              (b) => b.debt_id,
              (b) => {
                const owe = b.direction === 'owe';
                const amount = fmtMoney(b.amount_minor, 'USD');
                return html`<div class="d-kv-row">
                  <span style="flex:1;">
                    <span
                      style="display:block;font:var(--t-body);font-weight:500;color:${owe
                        ? 'var(--ink)'
                        : 'var(--ok)'};"
                      >${(owe ? 'You owe ' : 'Owes you ') + amount}</span
                    >
                    <span
                      style="display:block;font:var(--t-small);font-size:12px;color:var(--ink-3);"
                      >${b.reason || ''}</span
                    >
                  </span>
                  <button
                    type="button"
                    class="kit-chip quiet d-chip-sm"
                    style="border-color:var(--line);color:var(--ink-2);"
                    @click=${() => this.onSettleDebt?.(b.debt_id)}
                  >
                    settle
                  </button>
                </div>`;
              },
            )}
          </div>`
        : nothing}
      ${adders.debt ? debtAddRow((fields) => this.onAddDebt?.(fields)) : nothing}
    `;
  }
}
customElements.define('people-details', PeopleDetails);

function renderDetails() {
  if (!state.detailsId) {
    mountDetails(nothing);
    return;
  }
  const dp = detailPerson;
  const nameGuess = dp?.name ?? data.people.find((p) => p.party_id === state.detailsId)?.name ?? '';
  const color = dp ? avatarColor(dp) : PALETTE[hashInt(nameGuess) % PALETTE.length];
  mountDetails(html`
    <div class="d-details-backdrop" @click=${closeDetails}></div>
    <people-details
      .person=${dp}
      .nameGuess=${nameGuess}
      .color=${color}
      .adders=${{ ...detailAdders }}
      .onClose=${closeDetails}
      .onMove=${(anchor) => openPersonMenu(anchor, dp)}
      .onMessage=${() => logInteraction(dp, 'Message', 'Sent a message')}
      .onCall=${() => logInteraction(dp, 'Call', 'Gave them a call')}
      .onToggleStar=${() => toggleStar(dp)}
      .onToggleAdder=${(key) => {
        detailAdders[key] = !detailAdders[key];
        renderDetails();
      }}
      .onAddRelationship=${(fields) =>
        drawerAct('add-relationship', { party_id: dp.party_id, ...fields }, 'Relationship added')}
      .onAddDate=${(fields) =>
        drawerAct('add-important-date', { party_id: dp.party_id, ...fields }, 'Date added')}
      .onToggleReminder=${(dateId) =>
        drawerAct('toggle-reminder', { date_id: dateId }, 'Reminder updated')}
      .onAddTask=${(fields) =>
        drawerAct('add-task', { party_id: dp.party_id, ...fields }, 'Task added')}
      .onToggleTask=${(taskId) => drawerAct('toggle-task', { task_id: taskId }, 'Task updated')}
      .onAddNote=${(fields) =>
        drawerAct('add-note', { party_id: dp.party_id, ...fields }, 'Note added')}
      .onAddGift=${(fields) =>
        drawerAct('add-gift', { party_id: dp.party_id, ...fields }, 'Gift idea added')}
      .onToggleGift=${(giftId) => drawerAct('toggle-gift', { gift_id: giftId }, 'Gift updated')}
      .onAddDebt=${(fields) =>
        drawerAct('add-debt', { party_id: dp.party_id, ...fields }, 'Debt added')}
      .onSettleDebt=${(debtId) => drawerAct('settle-debt', { debt_id: debtId }, 'Debt settled')}
    ></people-details>
  `);
}

// ---------- Add-person modal ----------

function openAddModal() {
  const root = $('modalRoot');
  const model = { circleId: null, cadence: 30 };
  const nameRef = createRef();
  const roleRef = createRef();
  const submitRef = createRef();

  const close = () => litRender(nothing, root);
  const paintSubmit = () => {
    if (submitRef.value) submitRef.value.disabled = !nameRef.value.value.trim();
  };

  const circleOpts = [{ circle_id: null, name: 'No circle' }, ...data.circles];
  const cadenceOpts = [
    { d: 7, l: 'Weekly' },
    { d: 14, l: 'Biweekly' },
    { d: 30, l: 'Monthly' },
    { d: 90, l: 'Quarterly' },
  ];

  const submit = async () => {
    const name = nameRef.value.value.trim();
    if (!name) return;
    submitRef.value.disabled = true;
    const avatar_color = PALETTE[data.people.length % PALETTE.length];
    const input = {
      display_name: name,
      cadence_days: model.cadence,
      avatar_color,
      ...(roleRef.value.value.trim() ? { role: roleRef.value.value.trim() } : {}),
      ...(model.circleId != null ? { circle_id: model.circleId } : {}),
    };
    const outcome = await act('add-person', input);
    if (!narrate(outcome)) {
      submitRef.value.disabled = false;
      return;
    }
    close();
    toast('Added · receipted.');
    await refresh();
    const newId = outcome?.output?.party_id;
    if (newId) openDetails(newId);
  };

  function paint() {
    litRender(
      html`<div class="kit-modal-back" @click=${close}>
        <div class="kit-modal" @click=${(e) => e.stopPropagation()}>
          <h2>Add someone</h2>
          <p class="hint">Who do you want to keep up with?</p>
          <input
            ${ref(nameRef)}
            class="d-input"
            placeholder="Name"
            aria-label="Name"
            @input=${paintSubmit}
          />
          <input
            ${ref(roleRef)}
            class="d-input"
            style="margin-top:8px;"
            placeholder="Role or where they are (optional)"
            aria-label="Role"
          />
          <div class="d-modal-label">Circle</div>
          <div class="d-pick">
            ${circleOpts.map(
              (c) => html`<button
                type="button"
                class="kit-chip quiet"
                aria-pressed=${String(model.circleId === c.circle_id)}
                @click=${() => {
                  model.circleId = c.circle_id;
                  paint();
                }}
              >
                ${c.name}
              </button>`,
            )}
          </div>
          <div class="d-modal-label">Reach out</div>
          <div class="d-pick">
            ${cadenceOpts.map(
              (o) => html`<button
                type="button"
                class="kit-chip quiet"
                aria-pressed=${String(model.cadence === o.d)}
                @click=${() => {
                  model.cadence = o.d;
                  paint();
                }}
              >
                ${o.l}
              </button>`,
            )}
          </div>
          <div class="kit-modal-foot d-modal-foot">
            <button type="button" class="kit-btn" @click=${close}>Cancel</button>
            <button
              ${ref(submitRef)}
              type="button"
              class="kit-btn primary"
              disabled
              @click=${submit}
            >
              Add person
            </button>
          </div>
        </div>
      </div>`,
      root,
    );
  }

  paint();
  setTimeout(() => nameRef.value?.focus(), 0);
}

// ---------- Navigation ----------

async function selectNav(nav) {
  state.nav = nav;
  clearSelection();
  state.detailsId = null;
  detailPerson = null;
  state.search = '';
  searchResults = null;
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

async function loadJournal() {
  try {
    const res = await window.centraid.read({ query: 'journal', input: {} });
    journalData = res?.vaultDenied ? { entries: [] } : (res ?? { entries: [] });
  } catch {
    journalData = { entries: [] };
  }
}
async function loadDashboard() {
  try {
    const res = await window.centraid.read({ query: 'dashboard', input: {} });
    dashboardData = res?.vaultDenied ? { recent: [] } : (res ?? { recent: [] });
  } catch {
    dashboardData = { recent: [] };
  }
}

// ---------- Master render ----------

function render() {
  // A circle can vanish under us (deleted elsewhere) — fall back to All.
  if (state.nav.kind === 'circle' && !data.circles.some((c) => c.circle_id === state.nav.circleId))
    state.nav = { kind: 'all' };
  closePopover();
  visibleRows = currentRows();
  renderSidebar();
  renderNewMenu();
  renderToolbar();
  renderBulk();
  renderRows();
}

// ---------- Search ----------

const applySearch = debounce(async () => {
  const q = $('searchInput').value.trim();
  if (q === state.search) return;
  state.search = q;
  clearSelection();
  if (!q) {
    searchResults = null;
    render();
    return;
  }
  // Search leaves journal/activity for a people-results view.
  if (state.nav.kind === 'journal' || state.nav.kind === 'activity') state.nav = { kind: 'all' };
  const seq = ++searchSeq;
  let rows = [];
  try {
    const res = await window.centraid.read({ query: 'search', input: { term: q } });
    rows = res?.people ?? [];
  } catch {
    rows = [];
  }
  if (seq !== searchSeq) return;
  searchResults = rows;
  render();
}, 150);

// ---------- Refresh ----------

let readFailedShowing = false;

async function refresh() {
  let next;
  try {
    next = await window.centraid.read({ query: 'people', input: { limit: peopleWindow } });
  } catch {
    readFailed($('noticeBanner'));
    readFailedShowing = true;
    return;
  }
  if (readFailedShowing) {
    readFailedShowing = false;
    notice('');
  }
  const denied = next?.vaultDenied;
  $('consentBanner').hidden = !denied;
  $('root').classList.toggle('denied', Boolean(denied));
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    return;
  }
  data = next ?? data;
  data.people = data.people ?? [];
  data.circles = data.circles ?? [];
  peopleTruncated = Boolean(next?.truncated);
  // Drop selections and a stale open drawer for people that no longer exist.
  state.selected = new Set(
    [...state.selected].filter((id) => data.people.some((p) => p.party_id === id)),
  );
  if (state.detailsId && !data.people.some((p) => p.party_id === state.detailsId)) {
    state.detailsId = null;
    detailPerson = null;
  }
  render();
  renderDetails();
}

// ---------- Chrome wiring ----------

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
  searchSeq += 1;
  state.search = '';
  searchResults = null;
  clearSelection();
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
  if ($('modalRoot').firstElementChild) {
    litRender(nothing, $('modalRoot'));
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

// Component-width driven responsive: blueprints render inside a panel, so we
// measure the root's own width (not the viewport) and toggle the phone layout.
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

// ---------- Boot ----------

state.narrow = $('root').clientWidth < 860;
$('root').classList.toggle('is-narrow', state.narrow);
showSkeleton($('list'), 6);
$('listWrap').hidden = false;
measure();
setInterval(measure, 250);
refresh();
