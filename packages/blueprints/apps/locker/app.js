// governance: allow-repo-hygiene file-size-limit Locker is a finished password manager — sidebar, list, detail, watchtower, trash, generator and lock — and splitting it would break that "one file" contract.
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

import {
  armConfirm,
  barSpan,
  debounce,
  outcomeMessage,
  readFailed,
  showSkeleton,
  toast,
} from './kit.js';
import { KitElement } from './elements.js';
// Aliased: the app already has a module-level `render()` orchestrator (assigns
// properties on the mounted chrome components + redraws the overlay layer);
// `litRender` is Lit's standalone DOM-commit function used for the overlay
// layer (lock screen / generator / edit modal — kit-owned containers, per the
// app's Lit conventions).
import {
  createRef,
  html,
  live,
  nothing,
  ref,
  render as litRender,
  repeat,
  svg as svgFrag,
} from './lit-core.min.js';

const $ = (id) => document.getElementById(id);

// ---------- Icons ----------
// Static, trusted SVG path data (issue #327 house style): each shape is a Lit
// `svg` fragment built once; `iconSvg`/`catIconSvg` wrap it in the `<svg>`
// element with the size/stroke/fill a given call site needs.

const ICON_PATHS = {
  lock: svgFrag`<path d="M8 11V8a4 4 0 018 0v3"></path><rect x="5" y="11" width="14" height="10" rx="2"></rect>`,
  plus: svgFrag`<path d="M12 5v14M5 12h14"></path>`,
  close: svgFrag`<path d="M6 6l12 12M18 6 6 18"></path>`,
  menu: svgFrag`<path d="M4 7h16M4 12h16M4 17h16"></path>`,
  search: svgFrag`<circle cx="11" cy="11" r="7"></circle><path d="m21 21-4.3-4.3"></path>`,
  back: svgFrag`<path d="m15 6-6 6 6 6"></path>`,
  edit: svgFrag`<path d="M4 20h4L18.5 9.5a2 2 0 0 0-2.8-2.8L5 17z"></path>`,
  copy: svgFrag`<rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h8"></path>`,
  eye: svgFrag`<circle cx="12" cy="12" r="3"></circle><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"></path>`,
  eyeOff: svgFrag`<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"></path><path d="m4 4 16 16"></path>`,
  regen: svgFrag`<path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path><path d="M3 21v-5h5"></path>`,
  trash: svgFrag`<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"></path>`,
  tag: svgFrag`<path d="M4 4h7l9 9-7 7-9-9z"></path><circle cx="8.5" cy="8.5" r="1.3"></circle>`,
  starFill: svgFrag`<path d="m12 3 2.6 5.6 6 .7-4.5 4.2 1.2 6-5.3-3-5.3 3 1.2-6L3.4 9.3l6-.7z"></path>`,
  sun: svgFrag`<circle cx="12" cy="12" r="4.5"></circle><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"></path>`,
  moon: svgFrag`<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"></path>`,
  all: svgFrag`<path d="M4 6h16M4 12h16M4 18h16"></path>`,
  shield: svgFrag`<path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"></path><path d="m9.5 12 2 2 3.5-3.5"></path>`,
};

const CAT_ICON_PATHS = {
  login: svgFrag`<path d="M15 7a5 5 0 1 0-4.5 5H12l2 2 2-2 1.5-1.5"></path><path d="M11.5 11.5 8 15l-1 3 3-1 3.5-3.5"></path>`,
  card: svgFrag`<path d="M3 7h18v11H3z"></path><path d="M3 11h18"></path>`,
  note: svgFrag`<path d="M6 3h9l4 4v14H6z"></path><path d="M9 12h7M9 16h5M14 3v4h4"></path>`,
  identity: svgFrag`<path d="M4 5h16v14H4z"></path><path d="M8 10a2 2 0 1 0 0-.1"></path><path d="M6 16a3 3 0 0 1 6 0"></path><path d="M14 9h4M14 13h4"></path>`,
  password: svgFrag`<path d="M7 12h.01M12 12h.01M17 12h.01"></path><path d="M4 7h16v10H4z"></path>`,
  wifi: svgFrag`<path d="M5 12.5a10 10 0 0 1 14 0"></path><path d="M8.5 15.5a5 5 0 0 1 7 0"></path><path d="M12 18.5h.01"></path>`,
};

/** `<svg width height viewBox="0 0 24 24">` wrapping a stroked icon path. */
function iconSvg(key, { sw = 1.7, size = 16, stroke = 'currentColor', fill = 'none' } = {}) {
  return html`<svg
    width=${size}
    height=${size}
    viewBox="0 0 24 24"
    fill=${fill}
    stroke=${stroke}
    stroke-width=${sw}
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    ${ICON_PATHS[key]}
  </svg>`;
}

function catIconSvg(type, opts) {
  return html`<svg
    width=${opts?.size ?? 16}
    height=${opts?.size ?? 16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width=${opts?.sw ?? 1.7}
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    ${CAT_ICON_PATHS[type]}
  </svg>`;
}

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

// The mounted chrome: three persistent regions + the overlay layer, mounted
// once into #stage and thereafter driven by property assignment (dumb
// projections — refresh()/render() never rebuild them). This is what lets the
// once-a-second OTP tick (below) update only the detail pane's `tick` property
// directly instead of re-rendering regions the owner might be interacting with
// (typing in search, mid-edit in a modal).
let chromeMounted = false;
let sidebarComp = null;
let listComp = null;
let detailComp = null;
let overlaysEl = null;

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

// ---------- Formatting ----------

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

// Length + character-class score, 0..5 → { ratio, tone, label, color } for a
// kit-meter + label. Mirrors the server's strengthScore so the meter agrees
// with Watchtower's "weak".
function strength(pw) {
  if (!pw) return { ratio: 0, tone: '', label: '', color: 'var(--ink-3)' };
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 14) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/[0-9]/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  const label = s <= 2 ? 'Weak' : s === 3 ? 'Fair' : s === 4 ? 'Good' : 'Strong';
  const tone = s <= 2 ? 'danger' : s === 3 ? 'warn' : 'ok';
  const color = s <= 2 ? 'var(--danger)' : s === 3 ? 'var(--warn)' : 'var(--ok)';
  return { ratio: s / 5, tone, label, color };
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
// the detail pane when it resolves (never the sidebar/list — see `chromeMounted`
// above). Returns the cached string if we already have it.
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
    if (detailComp) detailComp.tick = ++state.tick;
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
  // writeText returns a promise — a sync try/catch never sees its rejection
  // (it surfaced as an unhandled NotAllowedError pageerror: the shell's app
  // iframe carries no clipboard-write permissions policy, see
  // apps/desktop/src/renderer/react/shell/routes/AppFrame.tsx). Toast
  // success only once the write actually lands; otherwise say so instead of
  // claiming a copy that never happened.
  const okToast = () =>
    toast((label || 'Copied') + ' copied' + (secret ? ' · clears in ' + CLIP_CLEAR_S + 's' : ''));
  if (!navigator.clipboard || !navigator.clipboard.writeText) {
    toast('Copy is unavailable here.');
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => {
      if (secret) scheduleClipboardClear(text);
      okToast();
    },
    () => toast('Copy is unavailable here.'),
  );
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

/** `<locker-sidebar>` — nav rail: top shortcuts, categories, tags, trash, lock
 * + theme. A dumb projection: `render()` assigns fresh counts/nav/dark on every
 * pass; clicks call straight back into the module-level nav/write helpers. */
class LockerSidebar extends KitElement {
  static properties = {
    counts: { attribute: false },
    catCounts: { attribute: false },
    tags: { attribute: false },
    trashCount: { type: Number },
    nav: { attribute: false },
    dark: { type: Boolean },
  };

  constructor() {
    super();
    this.counts = { all: 0, fav: 0, watch: 0 };
    this.catCounts = {};
    this.tags = [];
    this.trashCount = 0;
    this.nav = { kind: 'all' };
    this.dark = false;
  }

  #navItem({ icon, label, count, active, onClick }) {
    return html`<button
      type="button"
      class="v-nav-item"
      aria-current=${String(!!active)}
      @click=${onClick}
    >
      <span class="ic">${icon}</span>
      <span class="lbl">${label}</span>
      <span class="ct">${count == null || count === 0 ? '' : String(count)}</span>
    </button>`;
  }

  render() {
    return html`<aside class="v-side">
      <div class="v-brand">
        <span class="v-brand-mark">${iconSvg('lock', { sw: 1.9 })}</span>
        <div style="min-width:0;">
          <div class="v-brand-name">Locker</div>
          <div class="v-brand-tag">everything, locked up</div>
        </div>
        <button
          type="button"
          class="v-side-close"
          aria-label="Close"
          @click=${() => {
            state.sideOpen = false;
            render();
          }}
        >
          ${iconSvg('close', { sw: 1.75 })}
        </button>
      </div>

      <button type="button" class="v-newbtn" @click=${() => openNew()}>
        ${iconSvg('plus', { sw: 2 })} New item
      </button>

      <nav class="v-nav">
        ${this.#navItem({
          icon: iconSvg('all'),
          label: 'All items',
          count: this.counts.all,
          active: this.nav.kind === 'all',
          onClick: () => setNav({ kind: 'all' }),
        })}
        ${this.#navItem({
          icon: iconSvg('starFill', { sw: 1.6 }),
          label: 'Favorites',
          count: this.counts.fav,
          active: this.nav.kind === 'fav',
          onClick: () => setNav({ kind: 'fav' }),
        })}
        ${this.#navItem({
          icon: iconSvg('shield'),
          label: 'Watchtower',
          count: this.counts.watch,
          active: this.nav.kind === 'watch',
          onClick: () => setNav({ kind: 'watch' }),
        })}
      </nav>

      <div class="v-seclabel">Categories</div>
      <nav class="v-nav">
        ${CAT_ORDER.map((t) =>
          this.#navItem({
            icon: catIconSvg(t),
            label: CATS[t].label,
            count: this.catCounts[t],
            active: this.nav.kind === 'cat' && this.nav.type === t,
            onClick: () => setNav({ kind: 'cat', type: t }),
          }),
        )}
      </nav>

      <div class="v-seclabel">Tags</div>
      <nav class="v-nav">
        ${this.tags.map(({ tag, count }) =>
          this.#navItem({
            icon: iconSvg('tag'),
            label: tag,
            count,
            active: this.nav.kind === 'tag' && this.nav.tag === tag,
            onClick: () => setNav({ kind: 'tag', tag }),
          }),
        )}
        ${this.#navItem({
          icon: iconSvg('trash', { sw: 1.6 }),
          label: 'Trash',
          count: this.trashCount,
          active: this.nav.kind === 'trash',
          onClick: () => setNav({ kind: 'trash' }),
        })}
      </nav>

      <div class="v-side-foot">
        <button
          type="button"
          class="v-lock"
          @click=${() => {
            state.locked = true;
            state.passInput = '';
            render();
          }}
        >
          ${iconSvg('lock', { sw: 1.75 })} Lock
        </button>
        <button type="button" class="v-iconbtn" aria-label="Theme" @click=${() => toggleTheme()}>
          ${iconSvg(this.dark ? 'sun' : 'moon', { sw: 1.75 })}
        </button>
      </div>
    </aside>`;
  }
}
customElements.define('locker-sidebar', LockerSidebar);

// ---------- List pane ----------

function listRowTpl(i, selectedId) {
  const wc = warnColor(i);
  return html`<button
    type="button"
    class="v-item"
    aria-current=${String(selectedId === i.item_id)}
    @click=${() => selectItem(i.item_id)}
  >
    <span class="v-itile" style="background:${catOf(i.type).color};">${monoOf(i)}</span>
    <span class="v-imain">
      <span class="v-ititle"
        >${i.title}${i.favorite
          ? html`<span class="v-star"
              >${iconSvg('starFill', { size: 12, fill: 'currentColor', stroke: 'none' })}</span
            >`
          : nothing}${wc
          ? html`<span class="v-warn-dot" style="background:${wc};"></span>`
          : nothing}</span
      >
      <span class="v-isub">${subOf(i) || '—'}</span>
    </span>
  </button>`;
}

/** `<locker-list>` — the search box + filtered/sorted row list for the current
 * nav. `search` binds with `live()` since the box may re-render while the
 * owner is mid-keystroke (a debounced search commit, an unrelated nav flip). */
class LockerList extends KitElement {
  static properties = {
    pool: { attribute: false },
    listTitle: { type: String },
    allCount: { type: Number },
    search: { type: String },
    selectedId: { type: String },
  };

  constructor() {
    super();
    this.pool = [];
    this.listTitle = 'All items';
    this.allCount = 0;
    this.search = '';
    this.selectedId = null;
  }

  render() {
    const pool = this.pool ?? [];
    return html`<section class="v-list">
      <div class="v-list-top">
        <div class="v-list-head">
          <button
            type="button"
            class="v-hamburger"
            aria-label="Menu"
            @click=${() => {
              state.sideOpen = true;
              render();
            }}
          >
            ${iconSvg('menu', { sw: 1.75 })}
          </button>
          <span class="v-list-title">${this.listTitle}</span>
          <span class="v-list-count">${pool.length}</span>
        </div>
        <div class="v-search">
          ${iconSvg('search', { sw: 1.75, size: 15 })}
          <input
            type="search"
            placeholder="Search ${this.allCount} items"
            autocomplete="off"
            .value=${live(this.search)}
            @input=${(e) => {
              state.search = e.target.value;
              applySearch();
            }}
            @keydown=${(e) => {
              if (e.key === 'Escape' && state.search) {
                e.preventDefault();
                state.search = '';
                searchRows = null;
                searchSeq += 1;
                render();
              }
            }}
          />
        </div>
      </div>
      <div class="v-items">
        ${pool.length === 0
          ? html`<div class="v-list-empty">
              ${this.search.trim() ? 'No matches.' : 'Nothing here.'}
            </div>`
          : repeat(
              pool,
              (i) => i.item_id,
              (i) => listRowTpl(i, this.selectedId),
            )}
      </div>
    </section>`;
  }
}
customElements.define('locker-list', LockerList);

// ---------- Detail pane ----------

function emptyPaneTpl() {
  return html`<div class="v-empty-detail">
    <div class="ic">${iconSvg('lock', { sw: 1.6, size: 28 })}</div>
    <div style="font:var(--t-strong);color:var(--ink-2);">Select an item</div>
    <div style="font:var(--t-small);margin-top:4px;">
      Pick something from the list to see its details.
    </div>
  </div>`;
}

function watchItemRowTpl(i) {
  const badge = i.compromised
    ? {
        t: 'Compromised',
        bg: 'color-mix(in oklab, var(--danger) 14%, transparent)',
        c: 'var(--danger)',
      }
    : i.weak
      ? { t: 'Weak', bg: 'color-mix(in oklab, var(--warn) 16%, transparent)', c: 'var(--warn)' }
      : { t: 'Reused', bg: 'color-mix(in oklab, var(--warn) 16%, transparent)', c: 'var(--warn)' };
  return html`<button type="button" class="v-wt-item" @click=${() => selectItem(i.item_id)}>
    <span
      class="v-itile"
      style="width:32px;height:32px;font-size:13px;background:${catOf(i.type).color};"
      >${monoOf(i)}</span
    >
    <span class="v-imain">
      <span class="v-ititle">${i.title}</span>
      <span class="v-isub">${subOf(i) || '—'}</span>
    </span>
    <span class="v-wt-badge" style="background:${badge.bg};color:${badge.c};">${badge.t}</span>
  </button>`;
}

function watchtowerPaneTpl(watch) {
  return html`<div class="v-detail-inner">
    <div class="v-dhead">
      <span class="v-dtile" style="background:var(--accd);"
        >${iconSvg('shield', { sw: 1.8, size: 26, stroke: '#fff' })}</span
      >
      <div>
        <div class="v-dtitle">Watchtower</div>
        <div class="v-dsub">Security review of your locker</div>
      </div>
    </div>

    <div class="v-wt-stats">
      <div class="v-wt-stat">
        <div class="n" style="color:var(--danger);">${watch.compromised}</div>
        <div class="k">Compromised</div>
      </div>
      <div class="v-wt-stat">
        <div class="n" style="color:var(--warn);">${watch.weak}</div>
        <div class="k">Weak passwords</div>
      </div>
      <div class="v-wt-stat">
        <div class="n" style="color:var(--warn);">${watch.reused}</div>
        <div class="k">Reused passwords</div>
      </div>
    </div>

    <div class="v-dlabel">Needs attention</div>
    <div class="v-fields">
      ${watch.items.length === 0
        ? html`<div class="v-list-empty" style="padding:26px;">Your locker looks healthy.</div>`
        : repeat(
            watch.items,
            (i) => i.item_id,
            (i) => watchItemRowTpl(i),
          )}
    </div>
  </div>`;
}

// Field descriptors for the read view, keyed by the vault's field names — the
// per-type shape the detail pane renders. `secret` fields hide behind a reveal
// toggle and carry copy; the password field grows a strength meter on reveal.
function fieldDescriptors(sel) {
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
  return fields;
}

/** Toggle a secret field's mask; a fresh `state.reveal` object each time so the
 * unmasked value never lingers once the field/item that owned it is gone. */
function toggleReveal(fid) {
  state.reveal = { ...state.reveal, [fid]: !state.reveal[fid] };
  render();
}

function fieldRowTpl(f, reveal) {
  if (f.kind === 'otp') {
    const code = totpFor(f.seed);
    return html`<div class="v-field">
      <div class="v-field-main">
        <div class="v-field-k">One-time password</div>
        <div class="v-otp">
          <span class="v-otp-code">${code || '••• •••'}</span>
          <svg class="v-ring" viewBox="0 0 36 36">
            <circle
              cx="18"
              cy="18"
              r="15"
              fill="none"
              stroke="var(--line-strong)"
              stroke-width="3"
            ></circle>
            <circle
              cx="18"
              cy="18"
              r="15"
              fill="none"
              stroke="var(--_accent)"
              stroke-width="3"
              stroke-linecap="round"
              stroke-dasharray="94.2"
              stroke-dashoffset=${totpOffset()}
              transform="rotate(-90 18 18)"
            ></circle>
          </svg>
        </div>
      </div>
      ${code
        ? html`<button
            type="button"
            class="v-fbtn"
            aria-label="Copy"
            @click=${() => copy(code.replace(' ', ''), 'Code', true)}
          >
            ${iconSvg('copy', { sw: 1.6 })}
          </button>`
        : nothing}
    </div>`;
  }

  if (f.kind === 'link') {
    return html`<div class="v-field">
      <div class="v-field-main">
        <div class="v-field-k">${f.k}</div>
        <div class="v-field-v"><a href=${f.val} target="_blank" rel="noreferrer">${f.val}</a></div>
      </div>
      <button type="button" class="v-fbtn" aria-label="Copy" @click=${() => copy(f.val, f.k)}>
        ${iconSvg('copy', { sw: 1.6 })}
      </button>
    </div>`;
  }

  if (f.kind === 'plain') {
    return html`<div class="v-field">
      <div class="v-field-main">
        <div class="v-field-k">${f.k}</div>
        <div class=${f.mono ? 'v-field-v mono' : 'v-field-v'}>${f.val}</div>
      </div>
      ${f.canCopy
        ? html`<button
            type="button"
            class="v-fbtn"
            aria-label="Copy"
            @click=${() => copy(f.val, f.k)}
          >
            ${iconSvg('copy', { sw: 1.6 })}
          </button>`
        : nothing}
    </div>`;
  }

  // secret
  const revealed = !!reveal[f.fid];
  const st = f.strength && revealed && f.val ? strength(f.val) : null;
  return html`<div class="v-field">
    <div class="v-field-main">
      <div class="v-field-k">${f.k}</div>
      <div class="v-field-v mono">${f.val ? (revealed ? f.val : '••••••••••••') : '—'}</div>
      ${st
        ? html`<div class="v-strength">
            ${barSpan(st.ratio, { tone: st.tone })}
            <span style="font:var(--t-mono);font-size:10px;color:${st.color};">${st.label}</span>
          </div>`
        : nothing}
    </div>
    ${f.val
      ? html`<button
            type="button"
            class="v-fbtn"
            aria-label="Reveal"
            @click=${() => toggleReveal(f.fid)}
          >
            ${iconSvg(revealed ? 'eyeOff' : 'eye', { sw: 1.6 })}
          </button>
          <button
            type="button"
            class="v-fbtn"
            aria-label="Copy"
            @click=${() => copy(f.val, f.k, true)}
          >
            ${iconSvg('copy', { sw: 1.6 })}
          </button>`
      : nothing}
  </div>`;
}

function fieldsForTpl(sel, reveal) {
  const fields = fieldDescriptors(sel);
  return html`<div class="v-fields">
    ${fields.length === 0
      ? html`<div class="v-list-empty" style="padding:20px;">No fields.</div>`
      : repeat(
          fields,
          (f) => f.fid ?? f.k,
          (f) => fieldRowTpl(f, reveal),
        )}
  </div>`;
}

function itemPaneTpl(sel, reveal) {
  if (!sel) {
    return html`<div class="v-detail-inner">
      <div class="v-list-empty" style="padding:40px;">Opening…</div>
    </div>`;
  }
  const noteText = sel.type === 'note' ? sel.content : sel.notes;
  return html`<div class="v-detail-inner">
    <div class="v-dhead">
      <span class="v-dtile" style="background:${catOf(sel.type).color};">${monoOf(sel)}</span>
      <div style="min-width:0;">
        <div class="v-dtitle">${sel.title}</div>
        <div class="v-dsub">${subOf(sel) || catOf(sel.type).label}</div>
      </div>
      <div class="v-dhead-tools">
        ${sel.trashed
          ? nothing
          : html`<button
                type="button"
                class=${sel.favorite ? 'v-dtool on' : 'v-dtool'}
                aria-label="Favorite"
                @click=${() => toggleFav(sel)}
              >
                ${iconSvg('starFill', {
                  size: 17,
                  sw: 1.6,
                  fill: sel.favorite ? 'currentColor' : 'none',
                })}
              </button>
              <button type="button" class="v-dtool" aria-label="Edit" @click=${() => openEdit(sel)}>
                ${iconSvg('edit')}
              </button>`}
      </div>
    </div>

    ${fieldsForTpl(sel, reveal)}
    ${noteText
      ? html`<div class="v-dlabel">Note</div>
          <div class="v-note">${noteText}</div>`
      : nothing}
    ${(sel.tags || []).length > 0
      ? html`<div class="v-tags">
          ${sel.tags.map((t) => html`<span class="v-tag">${t}</span>`)}
        </div>`
      : nothing}

    <div class="v-meta">Updated ${fmtDate(sel.updated_at)}</div>

    <div style="display:flex;gap:8px;margin-top:20px;">
      ${sel.trashed
        ? html`<button type="button" class="kit-btn" @click=${() => restoreItem(sel)}>
              Restore
            </button>
            <button
              type="button"
              class="kit-btn danger v-del"
              style="margin-right:0;"
              @click=${(e) => {
                if (!armConfirm(e.currentTarget, { armedLabel: 'Delete forever — sure?' })) return;
                purgeItem(sel);
              }}
            >
              Delete forever
            </button>`
        : html`<button
            type="button"
            class="kit-btn danger v-del"
            style="margin-right:0;"
            @click=${() => trashItem(sel)}
          >
            Move to trash
          </button>`}
    </div>
  </div>`;
}

/** `<locker-detail>` — back button + (watchtower | item | empty) content.
 * `tick` is bumped straight from the OTP interval and from `totpFor`'s async
 * resolution (see above) so the one-second countdown only touches this one
 * component, never the sidebar/list the owner might be mid-interaction with. */
class LockerDetail extends KitElement {
  static properties = {
    mode: { type: String },
    watch: { attribute: false },
    detail: { attribute: false },
    detailLoading: { type: Boolean },
    reveal: { attribute: false },
    tick: { type: Number },
  };

  constructor() {
    super();
    this.mode = 'empty';
    this.watch = { compromised: 0, weak: 0, reused: 0, items: [] };
    this.detail = null;
    this.detailLoading = false;
    this.reveal = {};
    this.tick = 0;
  }

  render() {
    return html`<section class="v-detail">
      <button
        type="button"
        class="v-back"
        @click=${() => {
          state.showList = true;
          state.selectedId = null;
          state.detail = null;
          render();
        }}
      >
        ${iconSvg('back', { sw: 1.9, size: 18 })} Back
      </button>
      ${this.mode === 'watch'
        ? watchtowerPaneTpl(this.watch)
        : this.mode === 'item'
          ? itemPaneTpl(this.detail, this.reveal)
          : emptyPaneTpl()}
    </section>`;
  }
}
customElements.define('locker-detail', LockerDetail);

// ---------- Overlays: lock screen / generator / edit modal ----------
// Standalone `litRender` into a persistent `[data-kit-host]` container (the
// kit's own display:contents attribute hook) — the sanctioned form for
// kit-owned modal surfaces. Order matters: the generator can be opened from
// inside the edit modal, and (matching the original DOM order) the edit modal
// paints after it, so re-opening the generator while editing still stacks the
// same way it always did.

function lockScreenTpl() {
  if (!state.locked) return nothing;
  return html`<div class="v-lockscreen">
    <span class="v-lock-mark">${iconSvg('lock', { sw: 1.7, size: 30, stroke: '#fff' })}</span>
    <div style="text-align:center;">
      <div class="v-lock-title">Locker is locked</div>
      <div class="v-lock-sub">Enter your passphrase to unlock</div>
    </div>
    <input
      class="v-lock-in"
      type="password"
      placeholder="••••••••"
      .value=${live(state.passInput)}
      @input=${(e) => {
        state.passInput = e.target.value;
      }}
      @keydown=${(e) => {
        if (e.key === 'Enter') unlock();
      }}
    />
    <button type="button" class="v-lock-btn" @click=${() => unlock()}>Unlock</button>
  </div>`;
}

function unlock() {
  state.locked = false;
  state.passInput = '';
  render();
}

function genToggleRowTpl(label, on, onClick, last = false) {
  return html`<div class="v-toggle-row" style=${last ? 'border-bottom:none;' : ''}>
    <span style="font:var(--t-body);font-size:13.5px;">${label}</span>
    <button type="button" class=${on ? 'v-switch on' : 'v-switch'} @click=${onClick}>
      <i></i>
    </button>
  </div>`;
}

function generatorTpl() {
  if (!state.gen) return nothing;
  const st = strength(state.genValue);
  return html`<div class="kit-modal-back" @click=${() => closeGen()}>
    <div class="kit-modal" style="max-width:420px;" @click=${(ev) => ev.stopPropagation()}>
      <h2>Password generator</h2>

      <div class="v-genrow">
        <div class="v-genout">${state.genValue}</div>
        <button type="button" class="v-iconbtn" aria-label="Regenerate" @click=${() => regen()}>
          ${iconSvg('regen')}
        </button>
      </div>

      <div class="v-strength">
        ${barSpan(st.ratio, { tone: st.tone })}
        <span style="font:var(--t-mono);font-size:10px;color:${st.color};">${st.label}</span>
      </div>

      <div class="v-field-lg">
        <div class="v-flabel">Length · ${state.genLen}</div>
        <input
          type="range"
          class="v-slider"
          min="8"
          max="40"
          .value=${live(String(state.genLen))}
          @input=${(e) => {
            state.genLen = parseInt(e.target.value, 10);
            regen();
          }}
        />
      </div>

      ${genToggleRowTpl('Numbers', state.genNum, () => {
        state.genNum = !state.genNum;
        regen();
      })}
      ${genToggleRowTpl(
        'Symbols',
        state.genSym,
        () => {
          state.genSym = !state.genSym;
          regen();
        },
        true,
      )}

      <div class="kit-modal-foot">
        <button type="button" class="kit-btn" @click=${() => closeGen()}>Close</button>
        <button
          type="button"
          class="kit-btn primary"
          @click=${() => {
            // If a password field is waiting for it, drop the value there; always copy.
            if (state.genTarget && state.edit) setEditField(state.genTarget, state.genValue);
            copy(state.genValue, 'Password', true);
            closeGen();
          }}
        >
          Copy
        </button>
      </div>
    </div>
  </div>`;
}

function closeGen() {
  state.gen = false;
  state.genTarget = null;
  render();
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

function editFieldRowTpl(e, f) {
  const input = html`<input
    class=${f.mono ? 'v-in mono' : 'v-in'}
    placeholder=${f.ph || ''}
    .value=${e.fields[f.key] || ''}
    @input=${(ev) => {
      e.fields[f.key] = ev.target.value;
    }}
  />`;
  return html`<div class="v-field-lg">
    <div class="v-flabel">${f.label}</div>
    ${f.gen
      ? html`<div class="v-genrow">
          ${input}
          <button
            type="button"
            class="v-iconbtn"
            aria-label="Generate"
            @click=${() => {
              state.gen = true;
              state.genTarget = f.key;
              regen();
            }}
          >
            ${iconSvg('regen')}
          </button>
        </div>`
      : input}
  </div>`;
}

function editTpl() {
  const e = state.edit;
  if (!e) return nothing;

  // The save button's disabled state is toggled straight off the title input's
  // keystrokes (not a full re-render — same imperative shortcut the vanilla
  // code used) so typing a title never has to wait for an unrelated render.
  const saveRef = createRef();

  return html`<div class="kit-modal-back" @click=${() => closeEdit()}>
    <div class="kit-modal" @click=${(ev) => ev.stopPropagation()}>
      <h2>${e.mode === 'edit' ? 'Edit item' : 'New item'}</h2>

      ${e.mode === 'new'
        ? html`<div class="v-field-lg">
            <div class="v-flabel">Type</div>
            <div class="v-typerow">
              ${CAT_ORDER.map(
                (t) => html`<button
                  type="button"
                  class="kit-chip quiet"
                  aria-pressed=${String(e.type === t)}
                  @click=${() => {
                    e.type = t;
                    e.fields = {};
                    render();
                  }}
                >
                  ${TYPE_LABEL[t]}
                </button>`,
              )}
            </div>
          </div>`
        : nothing}

      <div class="v-field-lg">
        <div class="v-flabel">Title</div>
        <input
          class="v-in"
          placeholder="Item name"
          .value=${e.title}
          @input=${(ev) => {
            e.title = ev.target.value;
            if (saveRef.value) saveRef.value.disabled = !e.title.trim();
          }}
        />
      </div>

      ${repeat(
        editFieldsFor(e),
        (f) => f.key,
        (f) => editFieldRowTpl(e, f),
      )}

      <div class="v-field-lg">
        <div class="v-flabel">Tags (comma-separated)</div>
        <input
          class="v-in"
          placeholder="personal, finance"
          .value=${e.tags}
          @input=${(ev) => {
            e.tags = ev.target.value;
          }}
        />
      </div>

      <!-- Connector alias (issue #298 item 4): a stable name an automation
      binds to, so replacing this item later re-heals the binding without a
      manifest edit. -->
      <div class="v-field-lg">
        <div class="v-flabel">Connector alias (optional)</div>
        <input
          class="v-in mono"
          placeholder="e.g. github-token"
          .value=${e.alias || ''}
          @input=${(ev) => {
            e.alias = ev.target.value.trim();
          }}
        />
      </div>

      <div class="kit-modal-foot">
        <button type="button" class="kit-btn" @click=${() => closeEdit()}>Cancel</button>
        <button
          type="button"
          class="kit-btn primary"
          ?disabled=${!e.title.trim()}
          ${ref(saveRef)}
          @click=${() => saveEdit()}
        >
          Save
        </button>
      </div>
    </div>
  </div>`;
}

// ---------- Edit / new plumbing ----------

function openNew() {
  state.edit = { mode: 'new', type: 'login', title: '', fields: {}, tags: '', alias: '' };
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
    alias: sel.alias || '',
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
  // Alias is write-safe from the UI: a non-empty value sets/changes it; a
  // blank field is left untouched (never clobbers an existing binding).
  // Clearing or reassigning is an assistant/CLI gesture.
  const alias = (e.alias || '').trim();
  if (alias) input.alias = alias;
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
  clearChrome();
}

/** Drop the mounted chrome so a later successful refresh remounts it fresh. */
function clearChrome() {
  $('stage').replaceChildren();
  chromeMounted = false;
  sidebarComp = null;
  listComp = null;
  detailComp = null;
  overlaysEl = null;
}

// ---------- Master render ----------

// `#stage` starts out holding the kit's raw (non-Lit) skeleton markup
// (`showSkeleton`, below). The chrome is mounted ONCE — three persistent
// region components plus the overlay layer — and every subsequent render()
// call only assigns properties on them (or, for the overlay layer, redraws
// via `litRender`); nothing here rebuilds region DOM from scratch.
function mountChrome(stage) {
  if (chromeMounted) return;
  sidebarComp = document.createElement('locker-sidebar');
  listComp = document.createElement('locker-list');
  detailComp = document.createElement('locker-detail');
  overlaysEl = document.createElement('div');
  overlaysEl.setAttribute('data-kit-host', '');
  stage.replaceChildren(sidebarComp, listComp, detailComp, overlaysEl);
  chromeMounted = true;
}

function render() {
  const stage = $('stage');
  if (denied) {
    clearChrome();
    return;
  }

  mountChrome(stage);

  // Root classes for the responsive master-detail flow.
  const rootEl = $('root');
  rootEl.classList.toggle('is-narrow', state.narrow);
  rootEl.classList.toggle('side-open', state.narrow && state.sideOpen);
  rootEl.classList.toggle('show-list', state.showList);

  const items = data.items;
  const catCounts = {};
  for (const t of CAT_ORDER) catCounts[t] = items.filter((i) => i.type === t).length;
  const allTags = [...new Set(items.flatMap((i) => i.tags || []))].sort();

  sidebarComp.counts = {
    all: items.length,
    fav: items.filter((i) => i.favorite).length,
    watch: state.watch.compromised + state.watch.weak,
  };
  sidebarComp.catCounts = catCounts;
  sidebarComp.tags = allTags.map((tag) => ({
    tag,
    count: items.filter((i) => (i.tags || []).includes(tag)).length,
  }));
  sidebarComp.trashCount = state.trashRows.length;
  sidebarComp.nav = state.nav;
  sidebarComp.dark = state.dark;

  const navTitles = { all: 'All items', fav: 'Favorites', watch: 'Watchtower', trash: 'Trash' };
  listComp.pool = currentPool();
  listComp.listTitle =
    state.nav.kind === 'cat'
      ? catOf(state.nav.type).label
      : state.nav.kind === 'tag'
        ? '#' + state.nav.tag
        : navTitles[state.nav.kind] || 'All items';
  listComp.allCount = data.items.length;
  listComp.search = state.search;
  listComp.selectedId = state.selectedId;

  detailComp.mode =
    state.nav.kind === 'watch'
      ? 'watch'
      : state.selectedId && (state.detail || state.detailLoading)
        ? 'item'
        : 'empty';
  detailComp.watch = state.watch;
  detailComp.detail = state.detail;
  detailComp.detailLoading = state.detailLoading;
  detailComp.reveal = state.reveal;
  detailComp.tick = state.tick;

  litRender(html`${lockScreenTpl()}${generatorTpl()}${editTpl()}`, overlaysEl);
  if (state.locked) {
    const input = overlaysEl.querySelector('.v-lock-in');
    if (input) setTimeout(() => input.focus(), 0);
  }
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
// Real-TOTP second hand: bump only the detail component's tick so the ring +
// code refresh each second without disturbing the sidebar/list/overlays.
setInterval(() => {
  if (state.selectedId && state.detail && state.detail.otp_seed) {
    state.tick += 1;
    if (detailComp) detailComp.tick = state.tick;
  }
}, 1000);
refresh();
