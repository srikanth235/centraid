// governance: allow-repo-hygiene file-size-limit blueprints are single-file by design (read wholesale by one agent); Locker is a finished password manager — sidebar, list, detail, watchtower, trash, generator and lock — and splitting it would break that "one file" contract.
// Locker — everything, locked up. A personal password manager as a projection
// over the personal vault. Every row is a locker.item; the list payload is
// secret-free (only the single-item query returns passwords, card numbers,
// CVVs, OTP seeds and note bodies), so secrets never ride a list and are never
// logged. Copy and reveal are the only ways a secret leaves a field. One-time
// codes are real RFC-6238 TOTP computed client-side from the seed once it is
// read; the password generator runs entirely in the browser. Watchtower flags
// weak / reused / compromised (weak + reused derived server-side, compromised a
// stored breach flag). Favorites are the vault-canonical flags-scheme star.
// Every write is a typed vault command — consent-checked and receipted. The app
// stores nothing of its own: revoke the grant and this page goes dark.

import { armConfirm, debounce, outcomeMessage, readFailed, showSkeleton, toast } from './kit.js';

const $ = (id) => document.getElementById(id);

// ---------- Tiny DOM helpers ----------

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

// ---------- Icons ----------

const svg = (inner, sw = 1.7) =>
  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

const I = {
  lock: '<path d="M8 11V8a4 4 0 018 0v3"></path><rect x="5" y="11" width="14" height="10" rx="2"></rect>',
  plus: '<path d="M12 5v14M5 12h14"></path>',
  close: '<path d="M6 6l12 12M18 6 6 18"></path>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"></path>',
  search: '<circle cx="11" cy="11" r="7"></circle><path d="m21 21-4.3-4.3"></path>',
  back: '<path d="m15 6-6 6 6 6"></path>',
  edit: '<path d="M4 20h4L18.5 9.5a2 2 0 0 0-2.8-2.8L5 17z"></path>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h8"></path>',
  eye: '<circle cx="12" cy="12" r="3"></circle><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"></path>',
  eyeOff:
    '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"></path><path d="m4 4 16 16"></path>',
  regen:
    '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path><path d="M3 21v-5h5"></path>',
  trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"></path>',
  tag: '<path d="M4 4h7l9 9-7 7-9-9z"></path><circle cx="8.5" cy="8.5" r="1.3"></circle>',
  starFill: '<path d="m12 3 2.6 5.6 6 .7-4.5 4.2 1.2 6-5.3-3-5.3 3 1.2-6L3.4 9.3l6-.7z"></path>',
  sun: '<circle cx="12" cy="12" r="4.5"></circle><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"></path>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"></path>',
  all: '<path d="M4 6h16M4 12h16M4 18h16"></path>',
  shield:
    '<path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"></path><path d="m9.5 12 2 2 3.5-3.5"></path>',
};

const CAT_ICON = {
  login:
    '<path d="M15 7a5 5 0 1 0-4.5 5H12l2 2 2-2 1.5-1.5"></path><path d="M11.5 11.5 8 15l-1 3 3-1 3.5-3.5"></path>',
  card: '<path d="M3 7h18v11H3z"></path><path d="M3 11h18"></path>',
  note: '<path d="M6 3h9l4 4v14H6z"></path><path d="M9 12h7M9 16h5M14 3v4h4"></path>',
  identity:
    '<path d="M4 5h16v14H4z"></path><path d="M8 10a2 2 0 1 0 0-.1"></path><path d="M6 16a3 3 0 0 1 6 0"></path><path d="M14 9h4M14 13h4"></path>',
  password: '<path d="M7 12h.01M12 12h.01M17 12h.01"></path><path d="M4 7h16v10H4z"></path>',
  wifi: '<path d="M5 12.5a10 10 0 0 1 14 0"></path><path d="M8.5 15.5a5 5 0 0 1 7 0"></path><path d="M12 18.5h.01"></path>',
};

const CATS = {
  login: { label: 'Logins', color: '#2F63E6' },
  card: { label: 'Credit Cards', color: '#7C5BD9' },
  note: { label: 'Secure Notes', color: '#E0902E' },
  identity: { label: 'Identities', color: '#2FA36B' },
  password: { label: 'Passwords', color: '#3AA6B9' },
  wifi: { label: 'Wi-Fi', color: '#E0567A' },
};
const CAT_ORDER = ['login', 'card', 'note', 'identity', 'password', 'wifi'];
const TYPE_LABEL = {
  login: 'Login',
  card: 'Card',
  note: 'Note',
  identity: 'Identity',
  wifi: 'Wi-Fi',
  password: 'Password',
};

function catOf(t) {
  return CATS[t] || { label: 'Item', color: '#5C677D' };
}
function monoOf(it) {
  return (it.title || '?').trim().slice(0, 1).toUpperCase();
}

// ---------- State ----------

// data.items are the secret-free decorated rows from the `items` query. Secrets
// live only in state.detail (from the single-item `item` query) and never touch
// this array.
let data = { items: [], truncated: false };

const state = {
  nav: { kind: 'all' }, // all | fav | watch | cat(type) | tag(tag) | trash
  selectedId: null,
  detail: null, // full item from `item` query (holds secrets)
  detailLoading: false,
  reveal: {}, // fieldId -> bool
  search: '',
  tick: 0,
  dark: document.documentElement.dataset.theme === 'dark',
  narrow: false,
  sideOpen: false,
  showList: true,
  locked: false,
  passInput: '',
  gen: false,
  genLen: 20,
  genNum: true,
  genSym: true,
  genValue: '',
  edit: null, // { mode, id?, type, title, fields:{}, tags:'' }
  // view-scoped row pools populated by refresh() for the current nav
  trashRows: [],
  watch: { compromised: 0, weak: 0, reused: 0, items: [] },
};

let denied = false;
let readFailedShowing = false;
let searchSeq = 0;
let searchRows = null;

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
  if (outcome?.status === 'parked') {
    notice('Sent to the owner for confirmation — it lands once approved.');
  } else if (outcome?.status === 'failed') {
    notice(`The vault refused: ${outcome.predicate ?? outcome.reason ?? 'a precondition failed'}.`);
  } else if (outcome?.status === 'denied') {
    notice(`Denied by consent: ${outcome.reason ?? ''}`);
  } else {
    notice(outcomeMessage(outcome) ?? 'The write did not go through.');
  }
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

// ---------- Formatting ----------

function pad(n) {
  return (n < 10 ? '0' : '') + n;
}
function fmtDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
    return (
      ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
        d.getMonth()
      ] +
      ' ' +
      d.getDate() +
      ', ' +
      d.getFullYear()
    );
  } catch {
    return String(iso).slice(0, 10);
  }
}
function purgeCountdown(iso) {
  if (!iso) return '';
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
  if (Number.isNaN(days)) return '';
  if (days <= 0) return 'purges today';
  if (days === 1) return 'purges tomorrow';
  return `purges in ${days} days`;
}

// ---------- Secret helpers (strength, TOTP, generator) ----------

// Length + character-class score, 0..5 → { pct, label, color }. Mirrors the
// server's strengthScore so the meter agrees with Watchtower's "weak".
function strength(pw) {
  if (!pw) return { pct: '0%', label: '', color: 'var(--ink-3)' };
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 14) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/[0-9]/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  const pct = Math.min(100, (s / 5) * 100);
  const label = s <= 2 ? 'Weak' : s === 3 ? 'Fair' : s === 4 ? 'Good' : 'Strong';
  const color = s <= 2 ? 'var(--danger)' : s === 3 ? 'var(--warn)' : 'var(--ok)';
  return { pct: pct + '%', label, color };
}

// Real RFC-6238 TOTP, computed client-side after the seed is read. base32
// decode → HMAC-SHA1 over the big-endian 30s counter → dynamic truncation →
// 6 digits. Cached per (seed, 30s-step) so the per-second tick is cheap; the
// seed and code never get logged.
const OTP_CACHE = new Map(); // `${seed}|${step}` -> "123 456"

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(input || '')
    .toUpperCase()
    .replace(/=+$/, '')
    .replace(/\s/g, '');
  if (!clean || /[^A-Z2-7]/.test(clean)) return null;
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return out.length ? new Uint8Array(out) : null;
}

async function computeTotp(seed, step) {
  const key = base32Decode(seed);
  if (!key) return null;
  const counter = new ArrayBuffer(8);
  const view = new DataView(counter);
  // 8-byte big-endian counter; step fits in the low 32 bits for any real clock.
  view.setUint32(0, Math.floor(step / 0x100000000));
  view.setUint32(4, step >>> 0);
  try {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      key,
      { name: 'HMAC', hash: 'SHA-1' },
      false,
      ['sign'],
    );
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, counter));
    const offset = sig[sig.length - 1] & 0x0f;
    const bin =
      ((sig[offset] & 0x7f) << 24) |
      ((sig[offset + 1] & 0xff) << 16) |
      ((sig[offset + 2] & 0xff) << 8) |
      (sig[offset + 3] & 0xff);
    const code = String(bin % 1000000).padStart(6, '0');
    return code.slice(0, 3) + ' ' + code.slice(3);
  } catch {
    return null;
  }
}

// Kick off (or read a cached) TOTP for the seed at the current step; re-render
// when it resolves. Returns the cached string if we already have it.
function totpFor(seed) {
  if (!seed) return null;
  const step = Math.floor(Date.now() / 30000);
  const key = `${seed}|${step}`;
  if (OTP_CACHE.has(key)) return OTP_CACHE.get(key);
  computeTotp(seed, step).then((code) => {
    if (code == null) {
      OTP_CACHE.set(key, null);
      return;
    }
    OTP_CACHE.set(key, code);
    if (OTP_CACHE.size > 40) OTP_CACHE.delete(OTP_CACHE.keys().next().value);
    render();
  });
  return null;
}
function totpOffset() {
  const rem = 30 - (Math.floor(Date.now() / 1000) % 30);
  return 94.2 * (1 - rem / 30);
}

function genPassword() {
  let chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  if (state.genNum) chars += '23456789';
  if (state.genSym) chars += '!@#$%^&*-_=+';
  const buf = new Uint32Array(state.genLen);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < state.genLen; i++) out += chars[buf[i] % chars.length];
  return out;
}
function regen() {
  state.genValue = genPassword();
  render();
}

// Seconds a copied secret is allowed to live on the clipboard before we
// wipe it (issue #298 item 5): copy-password legitimately crosses into the
// OS clipboard, and from there into clipboard-history tools. We can't reach
// the native `org.nspasteboard.ConcealedType` mark from this sandboxed
// iframe (navigator.clipboard only speaks text/html/png), so the portable
// mitigation is a timed clear — and we only clear if the clipboard STILL
// holds the value we put there, never clobbering a later copy.
var CLIP_CLEAR_S = 30;
var clipClearTimer = null;
function scheduleClipboardClear(secret) {
  if (clipClearTimer) clearTimeout(clipClearTimer);
  if (!navigator.clipboard || !navigator.clipboard.writeText) return;
  clipClearTimer = setTimeout(function () {
    clipClearTimer = null;
    var done = function () {};
    try {
      if (navigator.clipboard.readText) {
        navigator.clipboard.readText().then(function (cur) {
          if (cur === secret) navigator.clipboard.writeText('').catch(done);
        }, done);
      }
      // No read permission → leave the clipboard alone rather than risk
      // wiping something the user copied since.
    } catch {
      /* clipboard unavailable */
    }
  }, CLIP_CLEAR_S * 1000);
}
function copy(text, label, secret) {
  try {
    navigator.clipboard && navigator.clipboard.writeText(text);
    if (secret) scheduleClipboardClear(text);
  } catch {
    /* clipboard unavailable — nothing to log */
  }
  toast((label || 'Copied') + ' copied' + (secret ? ' · clears in ' + CLIP_CLEAR_S + 's' : ''));
}

// ---------- Data helpers ----------

function subOf(it) {
  // The server already computes a safe subtitle, but keep a fallback.
  if (it.subtitle) return it.subtitle;
  const t = it.type;
  if (t === 'note') return 'Secure note';
  return catOf(t).label;
}
function warnColor(it) {
  if (it.severity === 'danger' || it.compromised) return 'var(--danger)';
  if (it.severity === 'warn' || it.weak || it.reused) return 'var(--warn)';
  return '';
}

// The rows for the current nav → search → filter → sort by title.
function currentPool() {
  if (state.nav.kind === 'trash') return [...state.trashRows].sort(byTitle);
  let pool = searchRows != null ? searchRows.slice() : data.items.slice();
  if (state.nav.kind === 'fav') pool = pool.filter((i) => i.favorite);
  else if (state.nav.kind === 'cat') pool = pool.filter((i) => i.type === state.nav.type);
  else if (state.nav.kind === 'tag')
    pool = pool.filter((i) => (i.tags || []).includes(state.nav.tag));
  return pool.sort(byTitle);
}
function byTitle(a, b) {
  return String(a.title || '').localeCompare(String(b.title || ''));
}

// ---------- Sidebar ----------

function navItem({ iconHtml, label, count, active, onClick }) {
  const item = h('button', {
    type: 'button',
    class: 'v-nav-item',
    'aria-current': String(!!active),
    onclick: onClick,
  });
  item.appendChild(el(`<span class="ic">${iconHtml}</span>`));
  item.appendChild(h('span', { class: 'lbl' }, label));
  item.appendChild(h('span', { class: 'ct' }, count == null || count === 0 ? '' : String(count)));
  return item;
}

function renderSidebar(root) {
  const items = data.items;
  const counts = {
    all: items.length,
    fav: items.filter((i) => i.favorite).length,
    watch: state.watch.compromised + state.watch.weak,
  };
  const catCounts = {};
  for (const t of CAT_ORDER) catCounts[t] = items.filter((i) => i.type === t).length;
  const allTags = [...new Set(items.flatMap((i) => i.tags || []))].sort();

  const side = h('aside', { class: 'v-side' });

  const brand = h('div', { class: 'v-brand' });
  brand.appendChild(el(`<span class="v-brand-mark">${svg(I.lock, 1.9)}</span>`));
  brand.appendChild(
    el(
      `<div style="min-width:0;"><div class="v-brand-name">Locker</div><div class="v-brand-tag">everything, locked up</div></div>`,
    ),
  );
  brand.appendChild(
    h('button', {
      type: 'button',
      class: 'v-side-close',
      'aria-label': 'Close',
      html: svg(I.close, 1.75),
      onclick: () => {
        state.sideOpen = false;
        render();
      },
    }),
  );
  side.appendChild(brand);

  side.appendChild(
    h(
      'button',
      {
        type: 'button',
        class: 'v-newbtn',
        onclick: () => openNew(),
      },
      el(svg(I.plus, 2)),
      'New item',
    ),
  );

  const top = h('nav', { class: 'v-nav' });
  top.appendChild(
    navItem({
      iconHtml: svg(I.all),
      label: 'All items',
      count: counts.all,
      active: state.nav.kind === 'all',
      onClick: () => setNav({ kind: 'all' }),
    }),
  );
  top.appendChild(
    navItem({
      iconHtml: svg(I.starFill, 1.6),
      label: 'Favorites',
      count: counts.fav,
      active: state.nav.kind === 'fav',
      onClick: () => setNav({ kind: 'fav' }),
    }),
  );
  top.appendChild(
    navItem({
      iconHtml: svg(I.shield),
      label: 'Watchtower',
      count: counts.watch,
      active: state.nav.kind === 'watch',
      onClick: () => setNav({ kind: 'watch' }),
    }),
  );
  side.appendChild(top);

  side.appendChild(h('div', { class: 'v-seclabel' }, 'Categories'));
  const cats = h('nav', { class: 'v-nav' });
  for (const t of CAT_ORDER) {
    cats.appendChild(
      navItem({
        iconHtml: svg(CAT_ICON[t]),
        label: CATS[t].label,
        count: catCounts[t],
        active: state.nav.kind === 'cat' && state.nav.type === t,
        onClick: () => setNav({ kind: 'cat', type: t }),
      }),
    );
  }
  side.appendChild(cats);

  side.appendChild(h('div', { class: 'v-seclabel' }, 'Tags'));
  const tags = h('nav', { class: 'v-nav' });
  for (const tag of allTags) {
    tags.appendChild(
      navItem({
        iconHtml: svg(I.tag),
        label: tag,
        count: items.filter((i) => (i.tags || []).includes(tag)).length,
        active: state.nav.kind === 'tag' && state.nav.tag === tag,
        onClick: () => setNav({ kind: 'tag', tag }),
      }),
    );
  }
  tags.appendChild(
    navItem({
      iconHtml: svg(I.trash, 1.6),
      label: 'Trash',
      count: state.trashRows.length,
      active: state.nav.kind === 'trash',
      onClick: () => setNav({ kind: 'trash' }),
    }),
  );
  side.appendChild(tags);

  const foot = h('div', { class: 'v-side-foot' });
  foot.appendChild(
    h(
      'button',
      {
        type: 'button',
        class: 'v-lock',
        onclick: () => {
          state.locked = true;
          state.passInput = '';
          render();
        },
      },
      el(svg(I.lock, 1.75)),
      'Lock',
    ),
  );
  foot.appendChild(
    h('button', {
      type: 'button',
      class: 'v-iconbtn',
      'aria-label': 'Theme',
      html: svg(state.dark ? I.sun : I.moon, 1.75),
      onclick: () => toggleTheme(),
    }),
  );
  side.appendChild(foot);

  root.appendChild(side);
}

// ---------- List pane ----------

function renderList(root) {
  const pool = currentPool();
  const navTitles = { all: 'All items', fav: 'Favorites', watch: 'Watchtower', trash: 'Trash' };
  let listTitle =
    state.nav.kind === 'cat'
      ? catOf(state.nav.type).label
      : state.nav.kind === 'tag'
        ? '#' + state.nav.tag
        : navTitles[state.nav.kind] || 'All items';

  const section = h('section', { class: 'v-list' });

  const top = h('div', { class: 'v-list-top' });
  const head = h('div', { class: 'v-list-head' });
  head.appendChild(
    h('button', {
      type: 'button',
      class: 'v-hamburger',
      'aria-label': 'Menu',
      html: svg(I.menu, 1.75),
      onclick: () => {
        state.sideOpen = true;
        render();
      },
    }),
  );
  head.appendChild(h('span', { class: 'v-list-title' }, listTitle));
  head.appendChild(h('span', { class: 'v-list-count' }, String(pool.length)));
  top.appendChild(head);

  const searchBox = h('div', { class: 'v-search' });
  searchBox.appendChild(
    el(svg(I.search, 1.75).replace('width="16" height="16"', 'width="15" height="15"')),
  );
  const input = h('input', {
    type: 'search',
    placeholder: `Search ${data.items.length} items`,
    value: state.search,
    autocomplete: 'off',
  });
  input.addEventListener('input', (ev) => {
    state.search = ev.target.value;
    applySearch();
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && state.search) {
      ev.preventDefault();
      state.search = '';
      searchRows = null;
      searchSeq += 1;
      render();
    }
  });
  searchBox.appendChild(input);
  top.appendChild(searchBox);
  section.appendChild(top);

  const listEl = h('div', { class: 'v-items' });
  if (pool.length === 0) {
    listEl.appendChild(
      h('div', { class: 'v-list-empty' }, state.search.trim() ? 'No matches.' : 'Nothing here.'),
    );
  } else {
    for (const i of pool) listEl.appendChild(listRow(i));
  }
  section.appendChild(listEl);
  root.appendChild(section);
}

function listRow(i) {
  const wc = warnColor(i);
  const btn = h('button', {
    type: 'button',
    class: 'v-item',
    'aria-current': String(state.selectedId === i.item_id),
    onclick: () => selectItem(i.item_id),
  });
  btn.appendChild(
    h('span', { class: 'v-itile', style: `background:${catOf(i.type).color};` }, monoOf(i)),
  );
  const main = h('span', { class: 'v-imain' });
  const title = h('span', { class: 'v-ititle' }, i.title);
  if (i.favorite)
    title.appendChild(
      el(
        `<span class="v-star"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">${I.starFill}</svg></span>`,
      ),
    );
  if (wc) title.appendChild(h('span', { class: 'v-warn-dot', style: `background:${wc};` }));
  main.appendChild(title);
  main.appendChild(h('span', { class: 'v-isub' }, subOf(i) || '—'));
  btn.appendChild(main);
  return btn;
}

// ---------- Detail pane ----------

function renderDetail(root) {
  const section = h('section', { class: 'v-detail' });
  section.appendChild(
    h(
      'button',
      {
        type: 'button',
        class: 'v-back',
        onclick: () => {
          state.showList = true;
          state.selectedId = null;
          state.detail = null;
          render();
        },
      },
      el(svg(I.back, 1.9).replace('width="16" height="16"', 'width="18" height="18"')),
      'Back',
    ),
  );

  if (state.nav.kind === 'watch') {
    section.appendChild(watchtowerPane());
  } else if (state.selectedId && (state.detail || state.detailLoading)) {
    section.appendChild(itemPane());
  } else {
    section.appendChild(emptyPane());
  }
  root.appendChild(section);
}

function emptyPane() {
  return el(
    `<div class="v-empty-detail"><div class="ic">${svg(I.lock, 1.6).replace('width="16" height="16"', 'width="28" height="28"')}</div><div style="font:var(--t-strong);color:var(--ink-2);">Select an item</div><div style="font:var(--t-small);margin-top:4px;">Pick something from the list to see its details.</div></div>`,
  );
}

function watchtowerPane() {
  const inner = h('div', { class: 'v-detail-inner' });
  const head = h('div', { class: 'v-dhead' });
  head.appendChild(
    el(
      `<span class="v-dtile" style="background:var(--accd);">${svg(I.shield, 1.8).replace('width="16" height="16"', 'width="26" height="26"').replace('stroke="currentColor"', 'stroke="#fff"')}</span>`,
    ),
  );
  head.appendChild(
    el(
      `<div><div class="v-dtitle">Watchtower</div><div class="v-dsub">Security review of your locker</div></div>`,
    ),
  );
  inner.appendChild(head);

  const stats = h('div', { class: 'v-wt-stats' });
  const stat = (n, label, color) =>
    el(
      `<div class="v-wt-stat"><div class="n" style="color:${color};">${n}</div><div class="k">${label}</div></div>`,
    );
  stats.appendChild(stat(state.watch.compromised, 'Compromised', 'var(--danger)'));
  stats.appendChild(stat(state.watch.weak, 'Weak passwords', 'var(--warn)'));
  stats.appendChild(stat(state.watch.reused, 'Reused passwords', 'var(--warn)'));
  inner.appendChild(stats);

  inner.appendChild(h('div', { class: 'v-dlabel' }, 'Needs attention'));
  const fields = h('div', { class: 'v-fields' });
  if (state.watch.items.length === 0) {
    fields.appendChild(
      h('div', { class: 'v-list-empty', style: 'padding:26px;' }, 'Your locker looks healthy.'),
    );
  } else {
    for (const i of state.watch.items) {
      const badge = i.compromised
        ? {
            t: 'Compromised',
            bg: 'color-mix(in oklab, var(--danger) 14%, transparent)',
            c: 'var(--danger)',
          }
        : i.weak
          ? { t: 'Weak', bg: 'color-mix(in oklab, var(--warn) 16%, transparent)', c: 'var(--warn)' }
          : {
              t: 'Reused',
              bg: 'color-mix(in oklab, var(--warn) 16%, transparent)',
              c: 'var(--warn)',
            };
      const row = h('button', {
        type: 'button',
        class: 'v-wt-item',
        onclick: () => selectItem(i.item_id),
      });
      row.appendChild(
        h(
          'span',
          {
            class: 'v-itile',
            style: `width:32px;height:32px;font-size:13px;background:${catOf(i.type).color};`,
          },
          monoOf(i),
        ),
      );
      row.appendChild(
        el(
          `<span class="v-imain"><span class="v-ititle"></span><span class="v-isub"></span></span>`,
        ),
      );
      row.querySelector('.v-ititle').textContent = i.title;
      row.querySelector('.v-isub').textContent = subOf(i) || '—';
      row.appendChild(
        h(
          'span',
          { class: 'v-wt-badge', style: `background:${badge.bg};color:${badge.c};` },
          badge.t,
        ),
      );
      fields.appendChild(row);
    }
  }
  inner.appendChild(fields);
  return inner;
}

function itemPane() {
  const inner = h('div', { class: 'v-detail-inner' });
  const sel = state.detail;
  if (!sel) {
    inner.appendChild(h('div', { class: 'v-list-empty', style: 'padding:40px;' }, 'Opening…'));
    return inner;
  }

  const head = h('div', { class: 'v-dhead' });
  head.appendChild(
    h('span', { class: 'v-dtile', style: `background:${catOf(sel.type).color};` }, monoOf(sel)),
  );
  const titleBox = h('div', { style: 'min-width:0;' });
  titleBox.appendChild(h('div', { class: 'v-dtitle' }, sel.title));
  titleBox.appendChild(h('div', { class: 'v-dsub' }, subOf(sel) || catOf(sel.type).label));
  head.appendChild(titleBox);
  const tools = h('div', { class: 'v-dhead-tools' });
  if (!sel.trashed) {
    tools.appendChild(
      h('button', {
        type: 'button',
        class: `v-dtool${sel.favorite ? ' on' : ''}`,
        'aria-label': 'Favorite',
        html: `<svg width="17" height="17" viewBox="0 0 24 24" fill="${sel.favorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${I.starFill}</svg>`,
        onclick: () => toggleFav(sel),
      }),
    );
    tools.appendChild(
      h('button', {
        type: 'button',
        class: 'v-dtool',
        'aria-label': 'Edit',
        html: svg(I.edit),
        onclick: () => openEdit(sel),
      }),
    );
  }
  head.appendChild(tools);
  inner.appendChild(head);

  inner.appendChild(fieldsFor(sel));

  const noteText = sel.type === 'note' ? sel.content : sel.notes;
  if (noteText) {
    inner.appendChild(h('div', { class: 'v-dlabel' }, 'Note'));
    inner.appendChild(h('div', { class: 'v-note' }, noteText));
  }

  if ((sel.tags || []).length > 0) {
    const tagWrap = h('div', { class: 'v-tags' });
    for (const t of sel.tags) tagWrap.appendChild(h('span', { class: 'v-tag' }, t));
    inner.appendChild(tagWrap);
  }

  inner.appendChild(h('div', { class: 'v-meta' }, 'Updated ' + fmtDate(sel.updated_at)));

  const footer = h('div', { style: 'display:flex;gap:8px;margin-top:20px;' });
  if (sel.trashed) {
    footer.appendChild(
      h(
        'button',
        { type: 'button', class: 'v-btn-ghost', onclick: () => restoreItem(sel) },
        'Restore',
      ),
    );
    const del = h(
      'button',
      { type: 'button', class: 'v-del', style: 'margin-right:0;' },
      'Delete forever',
    );
    del.addEventListener('click', (ev) => {
      if (!armConfirm(ev.currentTarget, { armedLabel: 'Delete forever — sure?' })) return;
      purgeItem(sel);
    });
    footer.appendChild(del);
  } else {
    footer.appendChild(
      h(
        'button',
        { type: 'button', class: 'v-del', style: 'margin-right:0;', onclick: () => trashItem(sel) },
        'Move to trash',
      ),
    );
  }
  inner.appendChild(footer);
  return inner;
}

// Build the per-type fields. `secret` fields hide behind a reveal toggle and
// carry copy; the password field grows a strength meter on reveal.
function fieldsFor(sel) {
  const wrap = h('div', { class: 'v-fields' });
  const fields = [];

  const plain = (k, val, opts = {}) => ({
    kind: 'plain',
    k,
    val: val || '—',
    mono: !!opts.mono,
    canCopy: !!val,
  });
  const link = (k, val) => ({ kind: 'link', k, val });
  const secret = (fid, k, val, opts = {}) => ({
    kind: 'secret',
    fid,
    k,
    val,
    strength: !!opts.strength,
  });
  const otp = (seed) => ({ kind: 'otp', seed });

  if (sel.type === 'login') {
    fields.push(plain('Username', sel.username));
    fields.push(secret('pw-' + sel.item_id, 'Password', sel.password, { strength: true }));
    if (sel.url) fields.push(link('Website', sel.url));
    if (sel.otp_seed) fields.push(otp(sel.otp_seed));
  } else if (sel.type === 'card') {
    fields.push(secret('num-' + sel.item_id, 'Card number', sel.card_number));
    fields.push(plain('Cardholder', sel.cardholder));
    fields.push(plain('Expiry', sel.expiry, { mono: true }));
    fields.push(secret('cvv-' + sel.item_id, 'CVV', sel.cvv));
    if (sel.brand) fields.push(plain('Brand', sel.brand));
  } else if (sel.type === 'identity') {
    fields.push(plain('Full name', sel.fullname));
    fields.push(plain('Email', sel.email));
    fields.push(plain('Phone', sel.phone, { mono: true }));
    fields.push(plain('Address', sel.address));
  } else if (sel.type === 'wifi') {
    fields.push(plain('Network', sel.network));
    fields.push(secret('wf-' + sel.item_id, 'Password', sel.password, { strength: true }));
  } else if (sel.type === 'password') {
    fields.push(secret('pw-' + sel.item_id, 'Password', sel.password, { strength: true }));
  }

  for (const f of fields) wrap.appendChild(fieldRow(f));
  // If a type produced no fields at all, keep the card from collapsing weirdly.
  if (fields.length === 0)
    wrap.appendChild(h('div', { class: 'v-list-empty', style: 'padding:20px;' }, 'No fields.'));
  return wrap;
}

function fieldRow(f) {
  const row = h('div', { class: 'v-field' });
  const main = h('div', { class: 'v-field-main' });

  if (f.kind === 'otp') {
    main.appendChild(h('div', { class: 'v-field-k' }, 'One-time password'));
    const code = totpFor(f.seed);
    const otpWrap = h('div', { class: 'v-otp' });
    otpWrap.appendChild(h('span', { class: 'v-otp-code' }, code || '••• •••'));
    otpWrap.appendChild(
      el(
        `<svg class="v-ring" viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" fill="none" stroke="var(--line-strong)" stroke-width="3"></circle><circle cx="18" cy="18" r="15" fill="none" stroke="var(--_accent)" stroke-width="3" stroke-linecap="round" stroke-dasharray="94.2" stroke-dashoffset="${totpOffset()}" transform="rotate(-90 18 18)"></circle></svg>`,
      ),
    );
    main.appendChild(otpWrap);
    row.appendChild(main);
    if (code)
      row.appendChild(
        h('button', {
          type: 'button',
          class: 'v-fbtn',
          'aria-label': 'Copy',
          html: svg(I.copy, 1.6),
          onclick: () => copy(code.replace(' ', ''), 'Code', true),
        }),
      );
    return row;
  }

  main.appendChild(h('div', { class: 'v-field-k' }, f.k));

  if (f.kind === 'link') {
    const vd = h('div', { class: 'v-field-v' });
    vd.appendChild(h('a', { href: f.val, target: '_blank', rel: 'noreferrer' }, f.val));
    main.appendChild(vd);
    row.appendChild(main);
    row.appendChild(
      h('button', {
        type: 'button',
        class: 'v-fbtn',
        'aria-label': 'Copy',
        html: svg(I.copy, 1.6),
        onclick: () => copy(f.val, f.k),
      }),
    );
    return row;
  }

  if (f.kind === 'plain') {
    main.appendChild(h('div', { class: `v-field-v${f.mono ? ' mono' : ''}` }, f.val));
    row.appendChild(main);
    if (f.canCopy)
      row.appendChild(
        h('button', {
          type: 'button',
          class: 'v-fbtn',
          'aria-label': 'Copy',
          html: svg(I.copy, 1.6),
          onclick: () => copy(f.val, f.k),
        }),
      );
    return row;
  }

  // secret
  const revealed = !!state.reveal[f.fid];
  main.appendChild(
    h('div', { class: 'v-field-v mono' }, f.val ? (revealed ? f.val : '••••••••••••') : '—'),
  );
  if (f.strength && revealed && f.val) {
    const st = strength(f.val);
    const meter = h('div', { class: 'v-strength' });
    const bar = h('div', { class: 'v-strbar' });
    bar.appendChild(h('i', { style: `width:${st.pct};background:${st.color};` }));
    meter.appendChild(bar);
    meter.appendChild(
      h('span', { style: `font:var(--t-mono);font-size:10px;color:${st.color};` }, st.label),
    );
    main.appendChild(meter);
  }
  row.appendChild(main);
  if (f.val) {
    row.appendChild(
      h('button', {
        type: 'button',
        class: 'v-fbtn',
        'aria-label': 'Reveal',
        html: svg(revealed ? I.eyeOff : I.eye, 1.6),
        onclick: () => {
          state.reveal = { ...state.reveal, [f.fid]: !state.reveal[f.fid] };
          render();
        },
      }),
    );
    row.appendChild(
      h('button', {
        type: 'button',
        class: 'v-fbtn',
        'aria-label': 'Copy',
        html: svg(I.copy, 1.6),
        // A secret field: copy arms the timed clipboard clear (issue #298).
        onclick: () => copy(f.val, f.k, true),
      }),
    );
  }
  return row;
}

// ---------- Overlays: toast is via kit; lock / generator / edit built here ----------

function renderLock(root) {
  if (!state.locked) return;
  const screen = h('div', { class: 'v-lockscreen' });
  screen.appendChild(
    el(
      `<span class="v-lock-mark">${svg(I.lock, 1.7).replace('stroke="currentColor"', 'stroke="#fff"').replace('width="16" height="16"', 'width="30" height="30"')}</span>`,
    ),
  );
  screen.appendChild(
    el(
      `<div style="text-align:center;"><div class="v-lock-title">Locker is locked</div><div class="v-lock-sub">Enter your passphrase to unlock</div></div>`,
    ),
  );
  const input = h('input', {
    class: 'v-lock-in',
    type: 'password',
    placeholder: '••••••••',
    value: state.passInput,
  });
  input.addEventListener('input', (ev) => {
    state.passInput = ev.target.value;
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') unlock();
  });
  screen.appendChild(input);
  screen.appendChild(
    h('button', { type: 'button', class: 'v-lock-btn', onclick: () => unlock() }, 'Unlock'),
  );
  root.appendChild(screen);
  setTimeout(() => input.focus(), 0);
}

function unlock() {
  state.locked = false;
  state.passInput = '';
  render();
}

function renderGenerator(root) {
  if (!state.gen) return;
  const back = h('div', { class: 'v-modal-back', onclick: () => closeGen() });
  const modal = h('div', {
    class: 'v-modal',
    style: 'max-width:420px;',
    onclick: (ev) => ev.stopPropagation(),
  });
  modal.appendChild(h('h2', {}, 'Password generator'));

  const genrow = h('div', { class: 'v-genrow' });
  genrow.appendChild(h('div', { class: 'v-genout' }, state.genValue));
  genrow.appendChild(
    h('button', {
      type: 'button',
      class: 'v-iconbtn',
      'aria-label': 'Regenerate',
      html: svg(I.regen),
      onclick: () => regen(),
    }),
  );
  modal.appendChild(genrow);

  const st = strength(state.genValue);
  const meter = h('div', { class: 'v-strength' });
  const bar = h('div', { class: 'v-strbar' });
  bar.appendChild(h('i', { style: `width:${st.pct};background:${st.color};` }));
  meter.appendChild(bar);
  meter.appendChild(
    h('span', { style: `font:var(--t-mono);font-size:10px;color:${st.color};` }, st.label),
  );
  modal.appendChild(meter);

  const lenWrap = h('div', { class: 'v-field-lg' });
  lenWrap.appendChild(h('div', { class: 'v-flabel' }, `Length · ${state.genLen}`));
  const slider = h('input', {
    type: 'range',
    class: 'v-slider',
    min: '8',
    max: '40',
    value: String(state.genLen),
  });
  slider.addEventListener('input', (ev) => {
    state.genLen = parseInt(ev.target.value, 10);
    regen();
  });
  lenWrap.appendChild(slider);
  modal.appendChild(lenWrap);

  const toggle = (label, on, onClick, last) => {
    const rowStyle = last ? 'border-bottom:none;' : '';
    const t = h('div', { class: 'v-toggle-row', style: rowStyle });
    t.appendChild(h('span', { style: 'font:var(--t-body);font-size:13.5px;' }, label));
    t.appendChild(
      h(
        'button',
        { type: 'button', class: `v-switch${on ? ' on' : ''}`, onclick: onClick },
        h('i', {}),
      ),
    );
    return t;
  };
  modal.appendChild(
    toggle('Numbers', state.genNum, () => {
      state.genNum = !state.genNum;
      regen();
    }),
  );
  modal.appendChild(
    toggle(
      'Symbols',
      state.genSym,
      () => {
        state.genSym = !state.genSym;
        regen();
      },
      true,
    ),
  );

  const foot = h('div', { class: 'v-modal-foot' });
  foot.appendChild(
    h('button', { type: 'button', class: 'v-btn-ghost', onclick: () => closeGen() }, 'Close'),
  );
  const useBtn = h('button', { type: 'button', class: 'v-btn-primary' }, 'Copy');
  useBtn.addEventListener('click', () => {
    // If a password field is waiting for it, drop the value there; always copy.
    if (state.genTarget && state.edit) {
      setEditField(state.genTarget, state.genValue);
    }
    copy(state.genValue, 'Password', true);
    closeGen();
  });
  foot.appendChild(useBtn);
  modal.appendChild(foot);

  back.appendChild(modal);
  root.appendChild(back);
}

function closeGen() {
  state.gen = false;
  state.genTarget = null;
  render();
}

function renderEdit(root) {
  const e = state.edit;
  if (!e) return;
  const back = h('div', { class: 'v-modal-back', onclick: () => closeEdit() });
  const modal = h('div', { class: 'v-modal', onclick: (ev) => ev.stopPropagation() });
  modal.appendChild(h('h2', {}, e.mode === 'edit' ? 'Edit item' : 'New item'));

  if (e.mode === 'new') {
    const typeWrap = h('div', { class: 'v-field-lg' });
    typeWrap.appendChild(h('div', { class: 'v-flabel' }, 'Type'));
    const chips = h('div', { class: 'v-typerow' });
    for (const t of CAT_ORDER) {
      chips.appendChild(
        h(
          'button',
          {
            type: 'button',
            class: 'v-typechip',
            'aria-pressed': String(e.type === t),
            onclick: () => {
              e.type = t;
              e.fields = {};
              render();
            },
          },
          TYPE_LABEL[t],
        ),
      );
    }
    typeWrap.appendChild(chips);
    modal.appendChild(typeWrap);
  }

  const titleWrap = h('div', { class: 'v-field-lg' });
  titleWrap.appendChild(h('div', { class: 'v-flabel' }, 'Title'));
  const titleInput = h('input', { class: 'v-in', placeholder: 'Item name', value: e.title });
  titleInput.addEventListener('input', (ev) => {
    e.title = ev.target.value;
    // Live-enable Save without a full re-render (keeps focus).
    saveBtn.disabled = !e.title.trim();
  });
  titleWrap.appendChild(titleInput);
  modal.appendChild(titleWrap);

  for (const f of editFieldsFor(e)) modal.appendChild(editFieldRow(e, f));

  const tagsWrap = h('div', { class: 'v-field-lg' });
  tagsWrap.appendChild(h('div', { class: 'v-flabel' }, 'Tags (comma-separated)'));
  const tagsInput = h('input', { class: 'v-in', placeholder: 'personal, finance', value: e.tags });
  tagsInput.addEventListener('input', (ev) => {
    e.tags = ev.target.value;
  });
  tagsWrap.appendChild(tagsInput);
  modal.appendChild(tagsWrap);

  const foot = h('div', { class: 'v-modal-foot' });
  foot.appendChild(
    h('button', { type: 'button', class: 'v-btn-ghost', onclick: () => closeEdit() }, 'Cancel'),
  );
  const saveBtn = h('button', { type: 'button', class: 'v-btn-primary' }, 'Save');
  saveBtn.disabled = !e.title.trim();
  saveBtn.addEventListener('click', () => saveEdit());
  foot.appendChild(saveBtn);
  modal.appendChild(foot);

  back.appendChild(modal);
  root.appendChild(back);
}

// Field descriptors for the edit modal, keyed by the ACTION's input keys
// (otp_seed, card_number) — the map from prototype names happens here.
function editFieldsFor(e) {
  switch (e.type) {
    case 'login':
      return [
        { label: 'Username', key: 'username', ph: 'you@email.com' },
        { label: 'Password', key: 'password', mono: true, gen: true },
        { label: 'Website', key: 'url', ph: 'https://' },
        { label: 'One-time secret', key: 'otp_seed', mono: true, ph: 'base32 seed (optional)' },
      ];
    case 'card':
      return [
        { label: 'Card number', key: 'card_number', mono: true },
        { label: 'Cardholder', key: 'cardholder' },
        { label: 'Expiry', key: 'expiry', mono: true, ph: 'MM/YY' },
        { label: 'CVV', key: 'cvv', mono: true },
        { label: 'Brand', key: 'brand', ph: 'Visa' },
      ];
    case 'note':
      return [{ label: 'Content', key: 'content' }];
    case 'identity':
      return [
        { label: 'Full name', key: 'fullname' },
        { label: 'Email', key: 'email' },
        { label: 'Phone', key: 'phone', mono: true },
        { label: 'Address', key: 'address' },
      ];
    case 'wifi':
      return [
        { label: 'Network', key: 'network' },
        { label: 'Password', key: 'password', mono: true, gen: true },
      ];
    default:
      return [{ label: 'Password', key: 'password', mono: true, gen: true }];
  }
}

function editFieldRow(e, f) {
  const wrap = h('div', { class: 'v-field-lg' });
  wrap.appendChild(h('div', { class: 'v-flabel' }, f.label));
  const input = h('input', {
    class: `v-in${f.mono ? ' mono' : ''}`,
    placeholder: f.ph || '',
    value: e.fields[f.key] || '',
  });
  input.addEventListener('input', (ev) => {
    e.fields[f.key] = ev.target.value;
  });
  if (f.gen) {
    const rowEl = h('div', { class: 'v-genrow' });
    rowEl.appendChild(input);
    rowEl.appendChild(
      h('button', {
        type: 'button',
        class: 'v-iconbtn',
        'aria-label': 'Generate',
        html: svg(I.regen),
        onclick: () => {
          state.gen = true;
          state.genTarget = f.key;
          regen();
        },
      }),
    );
    wrap.appendChild(rowEl);
  } else {
    wrap.appendChild(input);
  }
  return wrap;
}

// ---------- Edit / new plumbing ----------

function openNew() {
  state.edit = { mode: 'new', type: 'login', title: '', fields: {}, tags: '' };
  state.sideOpen = false;
  render();
}
// The detail pane already holds the full (secret-bearing) item — reuse it so
// edit never re-fetches. Map only the action-key fields into the form.
function openEdit(sel) {
  const keys = [
    'username',
    'password',
    'url',
    'otp_seed',
    'notes',
    'cardholder',
    'card_number',
    'expiry',
    'cvv',
    'brand',
    'content',
    'fullname',
    'email',
    'phone',
    'address',
    'network',
  ];
  const fields = {};
  for (const k of keys) if (sel[k] != null) fields[k] = sel[k];
  state.edit = {
    mode: 'edit',
    id: sel.item_id,
    type: sel.type,
    title: sel.title,
    fields,
    tags: (sel.tags || []).join(', '),
  };
  render();
}
function setEditField(key, val) {
  if (!state.edit) return;
  state.edit.fields[key] = val;
  render();
}
function closeEdit() {
  state.edit = null;
  render();
}

async function saveEdit() {
  const e = state.edit;
  if (!e || !e.title.trim()) return;
  const tags = e.tags
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  // Only the fields belonging to the chosen type (the backend drops the rest
  // too, but keep the payload clean).
  const allowed = new Set(editFieldsFor(e).map((f) => f.key));
  const input = { title: e.title.trim(), tags };
  for (const [k, v] of Object.entries(e.fields)) {
    if (allowed.has(k) && v != null && v !== '') input[k] = v;
  }
  let outcome;
  if (e.mode === 'edit') {
    outcome = await act('edit-item', { item_id: e.id, ...input });
  } else {
    outcome = await act('add-item', { type: e.type, ...input });
  }
  if (!narrate(outcome)) return;
  const savedId = e.mode === 'edit' ? e.id : (outcome?.output?.item_id ?? null);
  state.edit = null;
  toast(e.mode === 'edit' ? 'Saved · receipted.' : 'Item saved · receipted.');
  await refresh();
  // Re-open the item we just wrote so its (possibly changed) secrets reload.
  if (savedId) selectItem(savedId);
  else render();
}

// ---------- Item writes ----------

async function toggleFav(sel) {
  const outcome = await act(sel.favorite ? 'unstar-item' : 'star-item', { item_id: sel.item_id });
  if (!narrate(outcome)) return;
  toast(sel.favorite ? 'Star removed · receipted.' : 'Starred · receipted.');
  if (state.detail && state.detail.item_id === sel.item_id)
    state.detail = { ...state.detail, favorite: !sel.favorite };
  await refresh();
}

async function trashItem(sel) {
  const outcome = await act('trash-item', { item_id: sel.item_id });
  if (!narrate(outcome)) return;
  toast('Moved to trash · receipted.', {
    undoLabel: 'Undo',
    onUndo: async () => {
      const back = await act('restore-item', { item_id: sel.item_id });
      if (narrate(back)) await refresh();
    },
  });
  state.selectedId = null;
  state.detail = null;
  state.showList = true;
  await refresh();
}

async function restoreItem(sel) {
  const outcome = await act('restore-item', { item_id: sel.item_id });
  if (!narrate(outcome)) return;
  toast('Restored · receipted.');
  state.selectedId = null;
  state.detail = null;
  state.showList = true;
  await refresh();
}

async function purgeItem(sel) {
  const outcome = await act('purge-item', { item_id: sel.item_id });
  if (!narrate(outcome)) return;
  toast('Deleted forever · receipted.');
  state.selectedId = null;
  state.detail = null;
  state.showList = true;
  await refresh();
}

// ---------- Selection / navigation ----------

// Open an item: fetch its FULL fields (the only place secrets arrive) and show
// the detail pane. Secrets stay in state.detail, never in the list array.
async function selectItem(id) {
  state.selectedId = id;
  state.detail = null;
  state.detailLoading = true;
  state.reveal = {};
  if (state.nav.kind === 'watch') state.nav = { kind: 'all' };
  state.showList = false;
  render();
  let res;
  try {
    res = await window.centraid.read({ query: 'item', input: { item_id: id } });
  } catch {
    res = null;
  }
  state.detailLoading = false;
  if (res?.vaultDenied) {
    applyDenied(res.vaultDenied);
    return;
  }
  // Ignore a stale open if the user moved on.
  if (state.selectedId !== id) return;
  state.detail = res?.item ?? null;
  render();
}

function setNav(nav) {
  state.nav = nav;
  state.selectedId = null;
  state.detail = null;
  state.search = '';
  searchRows = null;
  searchSeq += 1;
  state.sideOpen = false;
  state.showList = true;
  render();
}

function toggleTheme() {
  const dark = !state.dark;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  if (dark && !document.documentElement.style.getPropertyValue('--bg-l'))
    document.documentElement.style.setProperty('--bg-l', '10%');
  state.dark = dark;
  render();
}

// ---------- Search ----------

const applySearch = debounce(async () => {
  const q = state.search.trim();
  const seq = ++searchSeq;
  if (!q) {
    searchRows = null;
    render();
    return;
  }
  let rows = [];
  try {
    const res = await window.centraid.read({ query: 'search', input: { term: q } });
    if (res?.vaultDenied) {
      applyDenied(res.vaultDenied);
      return;
    }
    rows = res?.items ?? [];
  } catch {
    rows = [];
  }
  if (seq !== searchSeq) return;
  searchRows = rows;
  render();
}, 150);

// ---------- Consent / denied ----------

function applyDenied(d) {
  denied = true;
  $('consentBanner').hidden = false;
  $('consentDetail').textContent = d?.message ?? '';
  $('root').classList.add('denied');
  $('stage').replaceChildren();
}

// ---------- Master render ----------

function render() {
  const root = $('stage');
  if (denied) {
    root.replaceChildren();
    return;
  }
  root.replaceChildren();

  // Root classes for the responsive master-detail flow.
  const rootEl = $('root');
  rootEl.classList.toggle('is-narrow', state.narrow);
  rootEl.classList.toggle('side-open', state.narrow && state.sideOpen);
  rootEl.classList.toggle('show-list', state.showList);

  renderSidebar(root);
  renderList(root);
  renderDetail(root);
  renderLock(root);
  renderGenerator(root);
  renderEdit(root);
}

// ---------- Refresh ----------

async function refresh() {
  let next;
  try {
    next = await window.centraid.read({ query: 'items', input: { limit: 300 } });
  } catch {
    readFailed($('noticeBanner'));
    readFailedShowing = true;
    return;
  }
  if (readFailedShowing) {
    readFailedShowing = false;
    notice('');
  }
  if (next?.vaultDenied) {
    applyDenied(next.vaultDenied);
    return;
  }
  denied = false;
  $('consentBanner').hidden = true;
  $('root').classList.remove('denied');

  data = { items: next?.items ?? [], truncated: Boolean(next?.truncated) };

  // Pull the derived views used by the sidebar badge, watchtower and trash.
  // Trash only when needed for its list, but watchtower counts feed the badge
  // so we fetch it every refresh (it is bounded and cheap).
  const jobs = [
    window.centraid
      .read({ query: 'watchtower' })
      .then((r) => {
        if (r && !r.vaultDenied)
          state.watch = {
            compromised: r.compromised ?? 0,
            weak: r.weak ?? 0,
            reused: r.reused ?? 0,
            items: r.items ?? [],
          };
      })
      .catch(() => {}),
    window.centraid
      .read({ query: 'trash' })
      .then((r) => {
        if (r && !r.vaultDenied) state.trashRows = r.items ?? [];
      })
      .catch(() => {}),
  ];
  await Promise.all(jobs);

  // Drop a selection whose item vanished (unless it now lives in trash).
  if (
    state.selectedId &&
    !data.items.some((i) => i.item_id === state.selectedId) &&
    !state.trashRows.some((i) => i.item_id === state.selectedId)
  ) {
    state.selectedId = null;
    state.detail = null;
  }
  render();
}

// ---------- Responsive: component-width driven ----------

function measure() {
  const root = $('root');
  const forced = document.documentElement.getAttribute('data-app-width') === 'narrow';
  const narrow = forced || root.clientWidth < 860;
  if (narrow !== state.narrow) {
    state.narrow = narrow;
    if (!narrow) state.sideOpen = false;
    render();
  }
}

// ---------- Global keydown (layered Escape) ----------

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (state.edit) {
    closeEdit();
    return;
  }
  if (state.gen) {
    closeGen();
    return;
  }
  if (state.sideOpen) {
    state.sideOpen = false;
    render();
  }
});
window.addEventListener('resize', measure);
window.addEventListener('focus', refresh);

// ---------- Boot ----------

state.narrow = $('root').clientWidth < 860;
$('root').classList.toggle('is-narrow', state.narrow);
showSkeleton($('stage'), 6);
regen();
measure();
setInterval(measure, 250);
// Real-TOTP second hand: cheap re-render so the ring + code refresh each second.
setInterval(() => {
  if (state.selectedId && state.detail && state.detail.otp_seed) {
    state.tick += 1;
    render();
  }
}, 1000);
refresh();
