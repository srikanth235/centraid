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

import {
  armConfirm,
  debounce,
  fmtMoney,
  outcomeMessage,
  readFailed,
  showSkeleton,
  toast,
} from './kit.js';

const $ = (id) => document.getElementById(id);

// ---------- Tiny DOM helpers (Docs' exact h()/el()) ----------

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'style') e.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function')
      e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

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
  sun: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/></svg>',
  moon: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>',
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

function initials(name) {
  return String(name ?? '')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}
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

// Render a vault search snippet: ⟦…⟧ hit markers → <mark> (Docs' snippetInto).
function snippetInto(elm, snippet) {
  const parts = String(snippet ?? '').split(/[⟦⟧]/);
  for (let i = 0; i < parts.length; i += 1) {
    if (!parts[i]) continue;
    if (i % 2 === 1) {
      const mark = document.createElement('mark');
      mark.textContent = parts[i];
      elm.appendChild(mark);
    } else {
      elm.appendChild(document.createTextNode(parts[i]));
    }
  }
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

let popoverEl = null;
let popoverCleanup = null;

function closePopover() {
  if (!popoverEl) return;
  popoverCleanup?.();
  popoverEl.remove();
  popoverEl = null;
  popoverCleanup = null;
}
function openPopover(anchor, build) {
  closePopover();
  const box = h('div', { class: 'd-popover', role: 'menu' });
  build(box);
  document.body.appendChild(box);
  const rect = anchor.getBoundingClientRect();
  const left = Math.max(
    8,
    Math.min(rect.right - box.offsetWidth, window.innerWidth - box.offsetWidth - 8),
  );
  let top = rect.bottom + 4;
  if (top + box.offsetHeight > window.innerHeight - 8)
    top = Math.max(8, rect.top - box.offsetHeight - 4);
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  const onDoc = (e) => {
    if (!box.contains(e.target) && !anchor.contains(e.target)) closePopover();
  };
  const onScroll = (e) => {
    if (!box.contains(e.target)) closePopover();
  };
  const timer = setTimeout(() => document.addEventListener('click', onDoc), 0);
  window.addEventListener('resize', closePopover);
  window.addEventListener('scroll', onScroll, true);
  popoverEl = box;
  popoverCleanup = () => {
    clearTimeout(timer);
    document.removeEventListener('click', onDoc);
    window.removeEventListener('resize', closePopover);
    window.removeEventListener('scroll', onScroll, true);
  };
}
function popItem(label, onClick, { disabled = false, dotColor = null } = {}) {
  const btn = h('button', {
    type: 'button',
    class: 'd-popover-item',
    role: 'menuitem',
    disabled: disabled || undefined,
    onclick: onClick,
  });
  if (dotColor)
    btn.appendChild(h('span', { class: 'd-dotmini', style: `background:${dotColor};` }));
  btn.appendChild(document.createTextNode(label));
  return btn;
}

function openPersonMenu(anchor, p) {
  openPopover(anchor, (box) => {
    box.appendChild(
      popItem('Open profile', () => {
        closePopover();
        openDetails(p.party_id);
      }),
    );
    box.appendChild(
      popItem(p.starred ? 'Remove favorite' : 'Add to favorites', () => {
        closePopover();
        toggleStar(p);
      }),
    );
    box.appendChild(h('div', { class: 'd-popover-sep' }));
    box.appendChild(h('p', { class: 'd-popover-head' }, 'Move to circle'));
    box.appendChild(
      popItem(
        'No circle',
        () => {
          closePopover();
          movePerson(p, null, 'no circle');
        },
        { disabled: p.circle_id == null, dotColor: 'var(--ink-3)' },
      ),
    );
    for (const c of data.circles) {
      box.appendChild(
        popItem(
          c.name,
          () => {
            closePopover();
            movePerson(p, c.circle_id, c.name);
          },
          { disabled: p.circle_id === c.circle_id, dotColor: circleColor(c.circle_id) },
        ),
      );
    }
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

// Loop an action over many rows: live progress, keep going past failures, one
// summary toast (Docs' runBulk).
async function runBulk(ids, run, { progress, done, suffix = '' }) {
  const n = ids.length;
  let ok = 0;
  let parked = 0;
  const failures = [];
  for (let i = 0; i < n; i += 1) {
    notice(`${progress} ${i + 1} of ${n}…`);
    const outcome = await run(ids[i]);
    if (outcome?.status === 'executed') ok += 1;
    else if (outcome?.status === 'parked') parked += 1;
    else failures.push(outcome?.reason ?? outcome?.predicate ?? 'The write failed.');
  }
  notice(
    failures.length > 0 ? `${failures.length} of ${n} didn’t go through — ${failures[0]}` : '',
  );
  const parts = [`${done} ${ok} of ${n}${suffix} · receipted.`];
  if (parked > 0) parts.push(`${parked} waiting for approval.`);
  toast(parts.join(' '));
  clearSelection();
  await refresh();
}

// ---------- Circle writes ----------

async function createCircle(name) {
  const outcome = await act('create-circle', { name });
  if (narrate(outcome)) {
    state.creatingCircle = false;
    toast(`Circle “${name}” created · receipted.`);
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

function navItem({ icon, label, active, count, onClick }) {
  const item = h('button', {
    type: 'button',
    class: 'd-nav-item',
    'aria-current': String(!!active),
    onclick: onClick,
  });
  item.appendChild(el(icon));
  item.appendChild(h('span', { class: 'lbl' }, label));
  if (count != null) item.appendChild(h('span', { class: 'd-nav-count' }, count));
  return item;
}

function renderSidebar() {
  const all = data.people;
  const counts = {
    all: all.length,
    reconnect: all.filter((p) => daysSince(p) >= (p.cadence_days ?? 30)).length,
    upcoming: all.filter((p) => (p.reminders || []).length > 0).length,
    starred: all.filter((p) => p.starred).length,
  };

  const nav = $('smartNav');
  nav.replaceChildren(
    navItem({
      icon: I.people,
      label: 'All people',
      active: state.nav.kind === 'all',
      count: counts.all,
      onClick: () => selectNav({ kind: 'all' }),
    }),
    navItem({
      icon: I.clock,
      label: 'Reconnect',
      active: state.nav.kind === 'reconnect',
      count: counts.reconnect,
      onClick: () => selectNav({ kind: 'reconnect' }),
    }),
    navItem({
      icon: I.bell,
      label: 'Upcoming',
      active: state.nav.kind === 'upcoming',
      count: counts.upcoming,
      onClick: () => selectNav({ kind: 'upcoming' }),
    }),
    navItem({
      icon: I.star,
      label: 'Favorites',
      active: state.nav.kind === 'starred',
      count: counts.starred,
      onClick: () => selectNav({ kind: 'starred' }),
    }),
  );

  const list = $('circleList');
  list.replaceChildren();

  for (const c of data.circles) {
    if (state.renamingCircleId === c.circle_id) {
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
      list.appendChild(h('div', { class: 'd-folder-edit' }, input, save));
      setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
      continue;
    }
    const count = data.people.filter((p) => (p.circle_id ?? null) === c.circle_id).length;
    const active = state.nav.kind === 'circle' && state.nav.circleId === c.circle_id;
    const item = h('button', {
      type: 'button',
      class: 'd-nav-item',
      'aria-current': String(active),
      onclick: () => selectNav({ kind: 'circle', circleId: c.circle_id }),
    });
    item.appendChild(
      h('span', { class: 'd-nav-dot', style: `background:${circleColor(c.circle_id)};` }),
    );
    item.appendChild(h('span', { class: 'lbl' }, c.name));
    item.appendChild(h('span', { class: 'd-nav-count' }, count || ''));

    const rename = h('button', {
      type: 'button',
      class: 'd-tool-btn',
      'aria-label': `Rename ${c.name}`,
      html: I.rename,
      onclick: (e) => {
        e.stopPropagation();
        state.renamingCircleId = c.circle_id;
        render();
      },
    });
    const del = h('button', {
      type: 'button',
      class: 'd-tool-btn danger',
      'aria-label': `Delete ${c.name}`,
      html: I.del,
    });
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!armConfirm(del, { armedLabel: '×?' })) return;
      deleteCircle(c);
    });
    const tools = h('span', { class: 'd-folder-tools' }, rename, del);
    list.appendChild(h('div', { class: 'd-folder' }, item, tools));
  }

  if (state.creatingCircle) {
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
    list.appendChild(h('div', { class: 'd-folder-edit' }, input, create));
    setTimeout(() => input.focus(), 0);
  }

  const jn = $('journalNav');
  jn.replaceChildren(
    navItem({
      icon: I.journal,
      label: 'Journal',
      active: state.nav.kind === 'journal',
      onClick: () => selectNav({ kind: 'journal' }),
    }),
    navItem({
      icon: I.activity,
      label: 'Activity',
      active: state.nav.kind === 'activity',
      onClick: () => selectNav({ kind: 'activity' }),
    }),
  );

  const store = $('storage');
  store.replaceChildren(
    h(
      'div',
      { class: 'd-storage-top' },
      h('span', { class: 'lbl' }, 'People'),
      h('span', { class: 'val' }, String(counts.all)),
    ),
    h(
      'div',
      { class: 'd-storage-label' },
      `${counts.all} ${counts.all === 1 ? 'person' : 'people'} across ${data.circles.length} circle${data.circles.length === 1 ? '' : 's'}`,
    ),
  );
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
  if (state.search.trim()) title = `Results for “${state.search.trim()}”`;
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
    $('statusChips').replaceChildren(
      ...chipDefs.map(([key, label]) =>
        h(
          'button',
          {
            type: 'button',
            class: 'd-chip',
            'aria-pressed': String(state.chip === key),
            onclick: () => {
              state.chip = key;
              clearSelection();
              render();
            },
          },
          label,
        ),
      ),
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
  const fav = h('button', { type: 'button', class: 'd-bulk-btn' }, 'Favorite');
  fav.addEventListener('click', () =>
    runBulk([...state.selected], (id) => act('star-person', { party_id: id }), {
      progress: 'Favoriting',
      done: 'Favorited',
    }),
  );
  const clear = h(
    'button',
    {
      type: 'button',
      class: 'd-bulk-btn',
      onclick: () => {
        clearSelection();
        render();
      },
    },
    'Clear',
  );
  bar.replaceChildren(
    h('span', { class: 'd-bulk-count' }, `${n} selected`),
    h('div', { class: 'd-bulk-actions' }, fav, clear),
  );
}

// ---------- Rows: grid + list ----------

function metaLine(p) {
  return `Last spoke ${shortFmt(daysSince(p))}`;
}

function gridCard(p) {
  const color = avatarColor(p);
  const st = statusOf(p);
  const selected = state.selected.has(p.party_id);
  const card = h('div', { class: 'd-card', 'data-selected': String(selected) });

  const top = h('div', {
    class: 'd-card-top',
    style: `background:color-mix(in oklab, ${color} 12%, transparent);`,
    onclick: () => openDetails(p.party_id),
  });
  top.appendChild(
    h(
      'span',
      { class: 'd-av', style: `width:58px;height:58px;font-size:21px;background:${color};` },
      initials(p.name),
    ),
  );
  card.appendChild(top);

  const sel = h('button', {
    type: 'button',
    class: 'd-card-select',
    'aria-pressed': String(selected),
    'aria-label': `Select ${p.name}`,
    onclick: (e) => {
      e.stopPropagation();
      toggleSelect(p.party_id);
    },
  });
  if (selected) sel.appendChild(el(I.check));
  card.appendChild(sel);

  const star = h('button', {
    type: 'button',
    class: `d-card-star${p.starred ? ' on' : ''}`,
    'aria-label': 'Favorite',
    html: `<svg width="16" height="16" viewBox="0 0 24 24" fill="${p.starred ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 2.6 5.6 6 .7-4.5 4.2 1.2 6-5.3-3-5.3 3 1.2-6L3.4 9.3l6-.7z"/></svg>`,
    onclick: (e) => {
      e.stopPropagation();
      toggleStar(p);
    },
  });
  card.appendChild(star);

  const body = h('div', { class: 'd-card-body', onclick: () => openDetails(p.party_id) });
  body.appendChild(h('div', { class: 'd-card-title' }, p.name));
  body.appendChild(h('div', { class: 'd-card-role' }, p.role || ''));
  body.appendChild(
    h(
      'div',
      { class: 'd-card-meta' },
      h('span', { class: 'd-dotmini', style: `background:${st.color};` }),
      metaLine(p),
    ),
  );
  card.appendChild(body);
  return card;
}

function listRow(p) {
  const color = avatarColor(p);
  const st = statusOf(p);
  const selected = state.selected.has(p.party_id);
  const row = h('div', { class: 'd-row', 'data-selected': String(selected) });

  const check = h('button', {
    type: 'button',
    class: 'd-check',
    'aria-pressed': String(selected),
    'aria-label': `Select ${p.name}`,
    onclick: (e) => {
      e.stopPropagation();
      toggleSelect(p.party_id);
    },
  });
  if (selected) check.appendChild(el(I.check));
  row.appendChild(check);

  row.appendChild(
    h(
      'span',
      {
        class: 'd-av',
        style: `width:34px;height:34px;font-size:12px;background:${color};`,
        onclick: (e) => {
          e.stopPropagation();
          openDetails(p.party_id);
        },
      },
      initials(p.name),
    ),
  );

  const main = h('div', { class: 'd-row-main', onclick: () => openDetails(p.party_id) });
  const titleEl = h('div', { class: 'd-row-title' }, p.name);
  if (p.starred)
    titleEl.appendChild(h('span', { class: 'd-star-ind', 'aria-label': 'Favorite' }, '★'));
  main.appendChild(titleEl);
  main.appendChild(h('div', { class: 'd-row-role' }, p.role || ''));
  if (state.search.trim() && p.snippet) {
    const snip = h('div', { class: 'd-row-role' });
    snippetInto(snip, p.snippet);
    main.appendChild(snip);
  }
  row.appendChild(main);

  row.appendChild(
    h(
      'span',
      { class: 'd-cell circle', onclick: () => openDetails(p.party_id) },
      circleName(p.circle_id ?? null),
    ),
  );
  row.appendChild(
    h(
      'span',
      { class: 'd-cell last', onclick: () => openDetails(p.party_id) },
      shortFmt(daysSince(p)),
    ),
  );
  row.appendChild(
    h(
      'span',
      { class: 'd-cell status' },
      h('span', { class: 'd-dotmini', style: `background:${st.color};` }),
      st.label,
    ),
  );

  const kebab = h('button', {
    type: 'button',
    class: 'd-kebab',
    'aria-label': `Actions for ${p.name}`,
    'aria-haspopup': 'menu',
    html: I.dots,
  });
  kebab.addEventListener('click', (e) => {
    e.stopPropagation();
    openPersonMenu(kebab, p);
  });
  row.appendChild(h('div', { class: 'd-row-end' }, kebab));
  return row;
}

function emptyState(icon, title, sub) {
  const box = $('empty');
  box.replaceChildren(
    h('div', { class: 'd-empty-icon' }, el(icon)),
    h('div', { class: 'd-empty-title' }, title),
    h('div', { class: 'd-empty-sub' }, sub),
  );
  box.hidden = false;
}

function renderListHead(rows) {
  const head = $('listHead');
  const allSel = rows.length > 0 && rows.every((p) => state.selected.has(p.party_id));
  const check = h('button', {
    type: 'button',
    class: 'd-check',
    'aria-pressed': String(allSel),
    'aria-label': allSel ? 'Deselect all' : 'Select all',
    onclick: () => {
      if (allSel) for (const p of rows) state.selected.delete(p.party_id);
      else for (const p of rows) state.selected.add(p.party_id);
      render();
    },
  });
  if (allSel) check.appendChild(el(I.check));
  head.replaceChildren(
    check,
    h('span', { style: 'width:34px;' }),
    h('span', { class: 'd-col name' }, 'Name'),
    h('span', { class: 'd-col circle' }, 'Circle'),
    h('span', { class: 'd-col last' }, 'Last spoke'),
    h('span', { class: 'd-col status' }, 'Status'),
    h('span', { class: 'd-col end' }),
  );
}

function renderRows() {
  const nav = state.nav;
  const grid = $('grid');
  const listWrap = $('listWrap');
  const listHead = $('listHead');
  const list = $('list');
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
  grid.replaceChildren();
  list.replaceChildren();

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
    emptyState(I.people, title, sub);
    return;
  }

  if (state.view === 'grid') {
    grid.hidden = false;
    rows.forEach((p) => grid.appendChild(gridCard(p)));
  } else {
    listWrap.hidden = false;
    listHead.hidden = state.narrow;
    if (!state.narrow) renderListHead(rows);
    rows.forEach((p) => list.appendChild(listRow(p)));
  }

  if (peopleTruncated && !state.search.trim()) {
    foot.hidden = false;
    const more = h(
      'button',
      {
        type: 'button',
        onclick: async () => {
          peopleWindow += 200;
          more.disabled = true;
          await refresh();
        },
      },
      'Show more',
    );
    foot.replaceChildren(
      h('span', {}, `Showing your first ${peopleWindow} people — the rest are a search away.`),
      more,
    );
  }
}

// ---------- Journal view ----------

let journalDraft = '';
let journalMood = '🙂';

function renderJournal(root) {
  root.hidden = false;
  const wrap = h('div', { class: 'j-wrap' });

  const compose = h('div', { class: 'j-compose' });
  compose.appendChild(
    h('div', { style: 'font:var(--t-strong);font-size:14px;' }, 'How was today?'),
  );
  const moodRow = h('div', { class: 'j-moodrow' });
  ['😔', '😐', '🙂', '😄'].forEach((emoji) => {
    moodRow.appendChild(
      h(
        'button',
        {
          type: 'button',
          class: 'j-mood',
          'aria-pressed': String(journalMood === emoji),
          onclick: () => {
            journalMood = emoji;
            renderRows();
          },
        },
        emoji,
      ),
    );
  });
  compose.appendChild(moodRow);
  const ta = h('textarea', { class: 'j-text', rows: '2', placeholder: 'Write a line…' });
  ta.value = journalDraft;
  ta.addEventListener('input', () => {
    journalDraft = ta.value;
    addBtn.disabled = !journalDraft.trim();
  });
  compose.appendChild(ta);
  const addBtn = h(
    'button',
    {
      type: 'button',
      class: 'd-btn-primary',
      disabled: !journalDraft.trim() || undefined,
      onclick: async () => {
        const text = journalDraft.trim();
        if (!text) return;
        const outcome = await act('add-journal-entry', { mood: journalMood, text });
        if (!narrate(outcome)) return;
        journalDraft = '';
        toast('Entry added · receipted.');
        await loadJournal();
        renderRows();
      },
    },
    'Add entry',
  );
  compose.appendChild(
    h('div', { style: 'display:flex;justify-content:flex-end;margin-top:8px;' }, addBtn),
  );
  wrap.appendChild(compose);

  const entriesWrap = h('div', { style: 'margin-top:8px;' });
  const entries = journalData?.entries ?? [];
  for (const j of entries) {
    if (j.kind === 'auto') {
      const color = j.avatar_color || PALETTE[hashInt(j.name) % PALETTE.length];
      entriesWrap.appendChild(
        h(
          'div',
          { class: 'j-entry' },
          h(
            'span',
            {
              class: 'd-av',
              style: `width:40px;height:40px;flex-shrink:0;font-size:14px;background:${color};cursor:pointer;`,
              onclick: () => j.party_id && openDetails(j.party_id),
            },
            initials(j.name),
          ),
          h(
            'div',
            { style: 'flex:1;min-width:0;' },
            h('div', { class: 'dt' }, `${fmtJournalDate(j.date)} · ${j.touch}`),
            h('p', {}, j.text),
          ),
        ),
      );
    } else {
      entriesWrap.appendChild(
        h(
          'div',
          { class: 'j-entry' },
          h('span', { class: 'em' }, j.mood),
          h(
            'div',
            { style: 'flex:1;min-width:0;' },
            h('div', { class: 'dt' }, fmtJournalDate(j.date)),
            h('p', {}, j.text),
          ),
        ),
      );
    }
  }
  if (entries.length === 0)
    entriesWrap.appendChild(
      h(
        'p',
        { style: 'font:var(--t-small);color:var(--ink-3);padding:16px 0;' },
        'No entries yet — start with a line above.',
      ),
    );
  wrap.appendChild(entriesWrap);
  root.replaceChildren(wrap);
}

// ---------- Activity view ----------

function renderActivity(root) {
  root.hidden = false;
  const wrap = h('div', { class: 'j-wrap' });
  const recent = dashboardData?.recent ?? [];
  if (recent.length === 0) {
    root.replaceChildren(
      h(
        'div',
        { class: 'd-empty' },
        h('div', { class: 'd-empty-icon' }, el(I.activity)),
        h('div', { class: 'd-empty-title' }, 'Nothing logged yet'),
        h(
          'div',
          { class: 'd-empty-sub' },
          'Log a message or call from anyone’s profile and it shows up here.',
        ),
      ),
    );
    return;
  }
  recent.forEach((a) => {
    const color = a.avatar_color || PALETTE[hashInt(a.name) % PALETTE.length];
    wrap.appendChild(
      h(
        'div',
        { class: 'd-activity-item' },
        h(
          'div',
          { class: 'd-activity-rail' },
          h(
            'span',
            {
              class: 'd-av',
              style: `width:36px;height:36px;font-size:12px;background:${color};cursor:pointer;`,
              onclick: () => a.party_id && openDetails(a.party_id),
            },
            initials(a.name),
          ),
          h('span', { class: 'd-activity-line' }),
        ),
        h(
          'div',
          { style: 'flex:1;min-width:0;padding-top:2px;' },
          h(
            'div',
            { style: 'display:flex;align-items:baseline;gap:8px;' },
            h('span', { style: 'font:var(--t-strong);font-size:14px;' }, a.name),
            h('span', { class: 'd-activity-kind', style: `color:${color};` }, a.kind),
            h(
              'span',
              { class: 'd-activity-date', style: 'margin-left:auto;' },
              fmt(daysSinceIso(a.occurred_at)),
            ),
          ),
          h(
            'p',
            { style: 'margin:4px 0 14px;font:var(--t-body);color:var(--ink-2);line-height:1.5;' },
            a.text || '',
          ),
        ),
      ),
    );
  });
  root.replaceChildren(wrap);
}

// ---------- New menu ----------

function renderNewMenu() {
  const menu = $('newMenu');
  menu.hidden = !state.newMenuOpen;
  $('newBtn').setAttribute('aria-expanded', String(state.newMenuOpen));
  if (!state.newMenuOpen) {
    menu.replaceChildren();
    return;
  }
  const add = h('button', {
    type: 'button',
    class: 'd-menu-item',
    role: 'menuitem',
    onclick: () => {
      state.newMenuOpen = false;
      renderNewMenu();
      openAddModal();
    },
  });
  add.appendChild(el(I.addPerson));
  add.appendChild(document.createTextNode('Add person'));
  const circle = h('button', {
    type: 'button',
    class: 'd-menu-item',
    role: 'menuitem',
    onclick: () => {
      state.newMenuOpen = false;
      state.creatingCircle = true;
      render();
    },
  });
  circle.appendChild(el(I.circlePlus));
  circle.appendChild(document.createTextNode('New circle'));
  menu.replaceChildren(add, h('div', { class: 'd-menu-sep' }), circle);
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

// A dashed "+ add" input row (the prototype's .d-noteadd idiom). Returns the
// row element; `commit(values)` runs on the + button or Enter.
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

// A section label + an optional "+ add" reveal toggle.
function sectionLabel(text, key, extra) {
  const label = h('div', { class: 'd-detail-label' }, text);
  if (extra) label.appendChild(extra);
  if (key) {
    const toggle = h(
      'button',
      {
        type: 'button',
        class: 'd-addtoggle',
        onclick: () => {
          detailAdders[key] = !detailAdders[key];
          renderDetails();
        },
      },
      detailAdders[key] ? 'close' : '+ add',
    );
    label.appendChild(toggle);
  }
  return label;
}

async function drawerAct(action, input, message) {
  const outcome = await act(action, input);
  if (!narrate(outcome)) return;
  toast(`${message} · receipted.`);
  await refresh();
  if (state.detailsId) await loadDetail(state.detailsId);
}

function renderDetails() {
  const root = $('detailsRoot');
  if (!state.detailsId) {
    root.replaceChildren();
    return;
  }
  const dp = detailPerson;
  // While loading, show a light shell so the drawer opens instantly.
  const nameGuess = dp?.name ?? data.people.find((p) => p.party_id === state.detailsId)?.name ?? '';
  const color = dp ? avatarColor(dp) : PALETTE[hashInt(nameGuess) % PALETTE.length];

  const body = h('div', { class: 'd-details-body' });

  body.appendChild(
    h(
      'div',
      { style: 'display:flex;flex-direction:column;align-items:center;' },
      h(
        'span',
        {
          class: 'd-av',
          style: `width:72px;height:72px;font-size:26px;background:${color};box-shadow:0 8px 22px -6px color-mix(in oklab, ${color} 60%, transparent);`,
        },
        initials(nameGuess),
      ),
    ),
  );
  body.appendChild(h('div', { class: 'd-detail-name' }, nameGuess));
  body.appendChild(h('div', { class: 'd-detail-ext' }, dp?.role || ''));

  if (dp) {
    const st = statusOf(dp);
    const days = daysSince(dp);

    // Quick log + favorite
    const msgBtn = h('button', {
      type: 'button',
      class: 'd-detail-btn primary',
      html: `${I.message}Message`,
      onclick: () => logInteraction(dp, 'Message', 'Sent a message'),
    });
    const callBtn = h('button', {
      type: 'button',
      class: 'd-detail-btn',
      html: `${I.call}Call`,
      onclick: () => logInteraction(dp, 'Call', 'Gave them a call'),
    });
    const starBtn = h(
      'button',
      { type: 'button', class: 'd-detail-btn', onclick: () => toggleStar(dp) },
      dp.starred ? '★ Favorite' : '☆ Favorite',
    );
    body.appendChild(h('div', { class: 'd-detail-actions' }, msgBtn, callBtn, starBtn));

    // Keep in touch status chip
    body.appendChild(
      h(
        'div',
        {
          style:
            'border:1px solid var(--line);border-radius:12px;background:var(--bg-elev);padding:13px 15px;display:flex;align-items:center;justify-content:space-between;',
        },
        h(
          'div',
          {},
          h('div', { style: 'font:var(--t-strong);font-size:13px;' }, 'Keep in touch'),
          h(
            'div',
            { style: 'font:var(--t-small);font-size:12px;color:var(--ink-2);margin-top:2px;' },
            `${cadence(dp.cadence_days ?? 30)} · last ${fmt(days)}`,
          ),
        ),
        h(
          'span',
          { class: 'd-chip-sm', style: `border-color:${st.color};color:${st.color};` },
          st.label,
        ),
      ),
    );

    // How you met
    if (dp.met) {
      body.appendChild(h('div', { class: 'd-detail-label' }, 'How you met'));
      body.appendChild(
        h(
          'p',
          { style: 'margin:0;font:var(--t-body);color:var(--ink-2);line-height:1.5;' },
          dp.met,
        ),
      );
    }

    // Contact
    const contact = dp.contact ?? [];
    if (contact.length > 0) {
      body.appendChild(h('div', { class: 'd-detail-label' }, 'Contact'));
      const kv = h('div', { class: 'd-kv' });
      for (const c of contact) {
        kv.appendChild(
          h(
            'div',
            { class: 'd-kv-row' },
            el(c.kind === 'phone' ? I.phone : I.mail),
            h('span', { class: 'd-kv-v' }, c.value),
            h('span', { class: 'd-kv-k' }, c.kind),
          ),
        );
      }
      body.appendChild(kv);
    }

    // Relationships — always show the label so the add control is available.
    body.appendChild(sectionLabel('Relationships', 'rel'));
    const rels = dp.relationships ?? [];
    if (rels.length > 0) {
      const relWrap = h('div', {});
      for (const r of rels) {
        const badge = r.pet === 'cat' ? '🐱' : r.pet === 'dog' ? '🐶' : r.name?.[0] || '·';
        relWrap.appendChild(
          h(
            'div',
            { class: 'd-rel' },
            h('span', { class: 'd-rel-badge' }, badge),
            h('span', { style: 'flex:1;font:var(--t-body);font-weight:500;' }, r.name),
            h(
              'span',
              { style: 'font:var(--t-small);font-size:11.5px;color:var(--ink-3);' },
              r.kind,
            ),
          ),
        );
      }
      body.appendChild(relWrap);
    }
    if (detailAdders.rel) {
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
      body.appendChild(
        addRow(
          [nameI, kindI, petI],
          () => {
            const name = nameI.value.trim();
            const kind = kindI.value.trim();
            if (!name || !kind) return;
            drawerAct(
              'add-relationship',
              {
                party_id: dp.party_id,
                name,
                kind,
                ...(petI.value.trim() ? { pet: petI.value.trim() } : {}),
              },
              'Relationship added',
            );
          },
          { canCommit: () => nameI.value.trim() && kindI.value.trim() },
        ),
      );
    }

    // Important dates
    body.appendChild(sectionLabel('Important dates', 'date'));
    const dates = dp.dates ?? [];
    if (dates.length > 0) {
      const kv = h('div', { class: 'd-kv' });
      for (const d of dates) {
        const bell = h('button', {
          type: 'button',
          class: 'd-mini-btn',
          'aria-label': 'Reminder',
          style: `background:${d.reminder_on ? 'color-mix(in oklab, var(--_accent) 12%, transparent)' : 'color-mix(in oklab, var(--ink) 5%, transparent)'};color:${d.reminder_on ? 'var(--_accent)' : 'var(--ink-3)'};`,
          html: I.bellSm,
          onclick: () => drawerAct('toggle-reminder', { date_id: d.date_id }, 'Reminder updated'),
        });
        kv.appendChild(
          h(
            'div',
            { class: 'd-kv-row' },
            h(
              'span',
              { style: 'flex:1;' },
              h('span', { style: 'display:block;font:var(--t-body);font-weight:500;' }, d.label),
              h(
                'span',
                { style: 'display:block;font:var(--t-small);font-size:12px;color:var(--ink-3);' },
                `${fmtMonthDay(d.month_day)} · ${inFmt(daysUntilAnnual(d.month_day))}`,
              ),
            ),
            bell,
          ),
        );
      }
      body.appendChild(kv);
    }
    if (detailAdders.date) {
      const labelI = h('input', { placeholder: 'Label (Birthday…)', 'aria-label': 'Date label' });
      const dateI = h('input', { type: 'date', class: 'narrow', 'aria-label': 'Date' });
      body.appendChild(
        addRow(
          [labelI, dateI],
          () => {
            const label = labelI.value.trim();
            const md = dateInputToMonthDay(dateI.value);
            if (!label || !md) return;
            drawerAct(
              'add-important-date',
              { party_id: dp.party_id, label, month_day: md, reminder_on: true },
              'Date added',
            );
          },
          { canCommit: () => labelI.value.trim() && dateI.value },
        ),
      );
    }

    // Tasks
    body.appendChild(sectionLabel('Tasks', 'task'));
    const tasks = dp.tasks ?? [];
    if (tasks.length > 0) {
      const tw = h('div', {});
      for (const t of tasks) {
        const box = h('button', {
          type: 'button',
          class: `d-taskbox${t.done ? ' on' : ''}`,
          'aria-label': 'Toggle task',
          onclick: () => drawerAct('toggle-task', { task_id: t.task_id }, 'Task updated'),
        });
        if (t.done) box.appendChild(el(I.checkTask));
        tw.appendChild(
          h(
            'div',
            { class: 'd-taskrow' },
            box,
            h(
              'span',
              {
                style: `flex:1;font:var(--t-body);color:${t.done ? 'var(--ink-3)' : 'var(--ink)'};text-decoration:${t.done ? 'line-through' : 'none'};`,
              },
              t.text,
            ),
          ),
        );
      }
      body.appendChild(tw);
    }
    if (detailAdders.task) {
      const ti = h('input', { placeholder: 'Add a task…', 'aria-label': 'Task text' });
      body.appendChild(
        addRow(
          [ti],
          () => {
            const text = ti.value.trim();
            if (!text) return;
            drawerAct('add-task', { party_id: dp.party_id, text }, 'Task added');
          },
          { canCommit: () => ti.value.trim() },
        ),
      );
    }

    // Notes (the prototype ships this add input always)
    body.appendChild(h('div', { class: 'd-detail-label' }, 'Notes'));
    const noteWrap = h('div', {});
    for (const nn of dp.notes ?? []) {
      noteWrap.appendChild(
        h(
          'div',
          { class: 'd-note' },
          h('p', {}, nn.text),
          h('div', { class: 'when' }, fmt(daysSinceIso(nn.created_at))),
        ),
      );
    }
    const noteI = h('input', { placeholder: 'Add a note…', 'aria-label': 'Note text' });
    noteWrap.appendChild(
      addRow(
        [noteI],
        () => {
          const text = noteI.value.trim();
          if (!text) return;
          drawerAct('add-note', { party_id: dp.party_id, text }, 'Note added');
        },
        { canCommit: () => noteI.value.trim() },
      ),
    );
    body.appendChild(noteWrap);

    // Gift ideas
    body.appendChild(sectionLabel('Gift ideas', 'gift'));
    const gifts = dp.gifts ?? [];
    if (gifts.length > 0) {
      const gw = h('div', {});
      for (const g of gifts) {
        const given = g.state === 'given';
        gw.appendChild(
          h(
            'div',
            { class: 'd-taskrow' },
            el(I.gift),
            h(
              'span',
              {
                style: `flex:1;font:var(--t-body);color:${given ? 'var(--ink-3)' : 'var(--ink)'};text-decoration:${given ? 'line-through' : 'none'};`,
              },
              g.text,
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'd-chip-sm',
                style: `border-color:${given ? 'color-mix(in oklab, var(--ok) 30%, transparent)' : 'color-mix(in oklab, var(--c-family) 30%, transparent)'};background:${given ? 'color-mix(in oklab, var(--ok) 14%, transparent)' : 'color-mix(in oklab, var(--c-family) 14%, transparent)'};color:${given ? 'var(--ok)' : 'var(--c-family)'};`,
                onclick: () => drawerAct('toggle-gift', { gift_id: g.gift_id }, 'Gift updated'),
              },
              g.state,
            ),
          ),
        );
      }
      body.appendChild(gw);
    }
    if (detailAdders.gift) {
      const gi = h('input', { placeholder: 'A gift idea…', 'aria-label': 'Gift idea' });
      body.appendChild(
        addRow(
          [gi],
          () => {
            const text = gi.value.trim();
            if (!text) return;
            drawerAct('add-gift', { party_id: dp.party_id, text }, 'Gift idea added');
          },
          { canCommit: () => gi.value.trim() },
        ),
      );
    }

    // Debts — net summary in the label
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
    const netEl = h(
      'span',
      {
        style: `font-family:var(--mono);font-size:11px;text-transform:none;letter-spacing:0;color:${net >= 0 ? 'var(--ok)' : 'var(--ink-3)'};`,
      },
      netLabel,
    );
    body.appendChild(sectionLabel('Debts', 'debt', debts.length > 0 ? netEl : null));
    if (debts.length > 0) {
      const kv = h('div', { class: 'd-kv' });
      for (const b of debts) {
        const owe = b.direction === 'owe';
        const amount = fmtMoney(b.amount_minor, 'USD');
        kv.appendChild(
          h(
            'div',
            { class: 'd-kv-row' },
            h(
              'span',
              { style: 'flex:1;' },
              h(
                'span',
                {
                  style: `display:block;font:var(--t-body);font-weight:500;color:${owe ? 'var(--ink)' : 'var(--ok)'};`,
                },
                (owe ? 'You owe ' : 'Owes you ') + amount,
              ),
              h(
                'span',
                { style: 'display:block;font:var(--t-small);font-size:12px;color:var(--ink-3);' },
                b.reason || '',
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'd-chip-sm',
                style: 'border-color:var(--line);color:var(--ink-2);',
                onclick: () => drawerAct('settle-debt', { debt_id: b.debt_id }, 'Debt settled'),
              },
              'settle',
            ),
          ),
        );
      }
      body.appendChild(kv);
    }
    if (detailAdders.debt) {
      let dir = 'owe';
      const seg = h('div', { class: 'd-seg' });
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
      body.appendChild(
        addRow(
          [seg, amtI, reasonI],
          () => {
            const dollars = parseFloat(amtI.value);
            if (!(dollars > 0)) return;
            drawerAct(
              'add-debt',
              {
                party_id: dp.party_id,
                direction: dir,
                amount_minor: Math.round(dollars * 100),
                ...(reasonI.value.trim() ? { reason: reasonI.value.trim() } : {}),
              },
              'Debt added',
            );
          },
          { canCommit: () => parseFloat(amtI.value) > 0 },
        ),
      );
    }

    // History timeline
    const interactions = dp.interactions ?? [];
    if (interactions.length > 0) {
      body.appendChild(h('div', { class: 'd-detail-label' }, 'History'));
      const tl = h('div', {});
      interactions.forEach((t) => {
        tl.appendChild(
          h(
            'div',
            { class: 'd-activity-item' },
            h(
              'div',
              { class: 'd-activity-rail' },
              h('span', { class: 'd-activity-dot', style: `background:${color};` }),
              h('span', { class: 'd-activity-line' }),
            ),
            h(
              'div',
              { style: 'flex:1;min-width:0;' },
              h(
                'div',
                { style: 'display:flex;align-items:center;gap:6px;' },
                h('span', { class: 'd-activity-kind', style: 'color:var(--ink-2);' }, t.kind),
                h(
                  'span',
                  { class: 'd-activity-date', style: 'margin-left:auto;' },
                  fmt(daysSinceIso(t.occurred_at)),
                ),
              ),
              h(
                'div',
                { style: 'margin-top:2px;font:var(--t-body);font-size:13.5px;color:var(--ink-2);' },
                t.text || '',
              ),
            ),
          ),
        );
      });
      body.appendChild(tl);
    }
  }

  const foot = h('div', { class: 'd-details-foot' });
  if (dp) {
    const moveBtn = h('button', { type: 'button', class: 'd-detail-btn' }, 'Move to circle');
    moveBtn.addEventListener('click', () => openPersonMenu(moveBtn, dp));
    foot.appendChild(moveBtn);
  }

  const drawer = h(
    'aside',
    { class: 'd-details', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Profile' },
    h(
      'div',
      { class: 'd-details-head' },
      h('span', { class: 'lbl' }, 'Profile'),
      h('button', {
        type: 'button',
        class: 'd-details-x',
        'aria-label': 'Close',
        onclick: closeDetails,
        html: I.close,
      }),
    ),
    body,
    foot,
  );
  root.replaceChildren(h('div', { class: 'd-details-backdrop', onclick: closeDetails }), drawer);
}

// ---------- Add-person modal ----------

function openAddModal() {
  const root = $('modalRoot');
  const model = { name: '', role: '', circleId: null, cadence: 30 };

  const nameI = h('input', { class: 'd-input', placeholder: 'Name', 'aria-label': 'Name' });
  const roleI = h('input', {
    class: 'd-input',
    placeholder: 'Role or where they are (optional)',
    style: 'margin-top:8px;',
    'aria-label': 'Role',
  });

  const circleWrap = h('div', { class: 'd-pick' });
  const submit = h(
    'button',
    { type: 'button', class: 'd-btn-primary', disabled: true },
    'Add person',
  );
  const paintSubmit = () => {
    submit.disabled = !nameI.value.trim();
  };
  nameI.addEventListener('input', paintSubmit);

  const circleOpts = [{ circle_id: null, name: 'No circle' }, ...data.circles];
  const paintCircles = () => {
    circleWrap.replaceChildren(
      ...circleOpts.map((c) =>
        h(
          'button',
          {
            type: 'button',
            class: 'd-pickbtn',
            'aria-pressed': String(model.circleId === c.circle_id),
            onclick: () => {
              model.circleId = c.circle_id;
              paintCircles();
            },
          },
          c.name,
        ),
      ),
    );
  };
  paintCircles();

  const cadenceWrap = h('div', { class: 'd-pick' });
  const cadenceOpts = [
    { d: 7, l: 'Weekly' },
    { d: 14, l: 'Biweekly' },
    { d: 30, l: 'Monthly' },
    { d: 90, l: 'Quarterly' },
  ];
  const paintCadence = () => {
    cadenceWrap.replaceChildren(
      ...cadenceOpts.map((o) =>
        h(
          'button',
          {
            type: 'button',
            class: 'd-pickbtn',
            'aria-pressed': String(model.cadence === o.d),
            onclick: () => {
              model.cadence = o.d;
              paintCadence();
            },
          },
          o.l,
        ),
      ),
    );
  };
  paintCadence();

  const close = () => root.replaceChildren();
  submit.addEventListener('click', async () => {
    const name = nameI.value.trim();
    if (!name) return;
    submit.disabled = true;
    const avatar_color = PALETTE[data.people.length % PALETTE.length];
    const input = {
      display_name: name,
      cadence_days: model.cadence,
      avatar_color,
      ...(roleI.value.trim() ? { role: roleI.value.trim() } : {}),
      ...(model.circleId != null ? { circle_id: model.circleId } : {}),
    };
    const outcome = await act('add-person', input);
    if (!narrate(outcome)) {
      submit.disabled = false;
      return;
    }
    close();
    toast('Added · receipted.');
    await refresh();
    const newId = outcome?.output?.party_id;
    if (newId) openDetails(newId);
  });

  const modal = h(
    'div',
    { class: 'd-modal', onclick: (e) => e.stopPropagation() },
    h('h2', {}, 'Add someone'),
    h('p', { class: 'hint' }, 'Who do you want to keep up with?'),
    nameI,
    roleI,
    h('div', { class: 'd-modal-label' }, 'Circle'),
    circleWrap,
    h('div', { class: 'd-modal-label' }, 'Reach out'),
    cadenceWrap,
    h(
      'div',
      { class: 'd-modal-foot' },
      h('button', { type: 'button', class: 'd-btn-ghost', onclick: close }, 'Cancel'),
      submit,
    ),
  );
  root.replaceChildren(h('div', { class: 'd-modal-back', onclick: close }, modal));
  setTimeout(() => nameI.focus(), 0);
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

function isDarkNow() {
  const t = document.documentElement.dataset.theme;
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
}
function setThemeIcon() {
  $('themeBtn').innerHTML = isDarkNow() ? I.sun : I.moon;
}
function toggleTheme() {
  const dark = !isDarkNow();
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  if (dark && !root.style.getPropertyValue('--bg-l')) root.style.setProperty('--bg-l', '10%');
  setThemeIcon();
}

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
$('themeBtn').addEventListener('click', toggleTheme);
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
  if (popoverEl) {
    closePopover();
    return;
  }
  if ($('modalRoot').firstElementChild) {
    $('modalRoot').replaceChildren();
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

setThemeIcon();
state.narrow = $('root').clientWidth < 860;
$('root').classList.toggle('is-narrow', state.narrow);
showSkeleton($('list'), 6);
$('listWrap').hidden = false;
measure();
setInterval(measure, 250);
refresh();
