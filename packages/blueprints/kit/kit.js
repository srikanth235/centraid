// governance: allow-repo-hygiene file-size-limit the kit is the single canonical bundle every app loads verbatim (UX primitives + charts + the folded Ask-your-vault controller); it is served as one file, so splitting it would fracture that one-request contract without reducing surface
// Centraid blueprint kit — the shared UX substrate for template apps.
//
// Canonical (and ONLY) copy: packages/blueprints/kit/kit.js. Apps don't
// carry their own copies — the app-engine runtime serves `kit.js` /
// `kit.css` from this dir (`sharedAssetsDir`, wired to `KIT_DIR`) whenever
// an app folder has no override of its own. Edit here, and every app —
// bundled template or deployed clone — picks it up on next load.
//
// Everything here is presentation plumbing the 14 apps used to hand-roll
// with drift: outcome toasts, loading/error states, confirm-to-act, money
// and local-date formatting, letter avatars, and small SVG charts. App
// logic stays in each app.js.
//
// The presentation PRIMITIVES (avatar, meter, charts, skeleton, toast, mention
// chip, reference strip) are now native Web Components defined in `elements.js`
// (issue #327). Importing it here runs the `customElements.define()` calls; the
// factory functions below (`letterAvatar`, `lineChart`, `toast`, …) construct +
// configure those elements, so app code that calls them is unchanged. The
// live-network controllers (Ask driver, @-mention popover/field) stay as the
// imperative controllers they always were — see the excluded set in issue #327.
import { entityKindLabel } from './elements.js';
import { sha256FileStream, stageDirectFile, stageFallbackFile } from './edge-upload.js';
// Shared chat-client core (issue #420) — the same parser/renderer/consent-flow
// the React shell uses, so the Ask panel renders ref-chips + typed blocks and
// gains stop/cancel from one canonical source.
import { consumeSse } from './turn-stream.js';
import { richAnswerHtml, hydrateRefs, wireCodeCopy } from './assistant-rich.js';
import {
  outcomeOf,
  fetchParkedEntry,
  describeParked,
  confirmParked as confirmParkedShared,
  normalizeApproveOutcome,
} from './consent-cards.js';
import {
  conversationsPath,
  conversationPath,
  blobsPath,
  vaultStatusPath,
  vaultAppsPath,
  normalizeModelState,
  modelLabel,
} from './conversation-client.js';

// Re-export the shared kind-label helper (its definition moved to elements.js,
// where the mention-chip and reference-strip components also need it).
export { entityKindLabel };

// ---------- Tiny DOM builders (the h()/el() every app copied from Docs) -----

/** Parse an HTML string and return its first element. */
export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/**
 * Hyperscript element builder: `h('div', { class, html, style, on* }, ...kids)`.
 * Null/false props and kids are skipped; string kids become text nodes.
 */
export function h(tag, props = {}, ...kids) {
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

// ---------- Native haptics (feature-detected, best-effort) ----------

// The mobile shell exposes `window.centraid.haptic.*` on its native bridge;
// the desktop iframe has no such surface. Feature-detect and swallow every
// failure so the kit behaves identically wherever the app renders.
function haptic(kind) {
  try {
    window.centraid?.haptic?.[kind]?.();
  } catch {
    /* bridge absent or refused — visual feedback already covers it */
  }
}

// ---------- Toasts (the one feedback channel that follows the user) ----------

let toastHost = null;

function ensureToastHost() {
  if (toastHost) return toastHost;
  toastHost = document.createElement('div');
  toastHost.className = 'kit-toasts';
  toastHost.setAttribute('role', 'status');
  toastHost.setAttribute('aria-live', 'polite');
  document.body.appendChild(toastHost);
  return toastHost;
}

/**
 * Show a transient toast. Options:
 *  - undoLabel/onUndo: renders an action button (e.g. Undo) that runs once.
 *  - duration: ms before auto-dismiss (default 5000; sticky if 0).
 */
export function toast(text, { undoLabel, onUndo, duration = 5000 } = {}) {
  haptic('success');
  const host = ensureToastHost();
  const el = document.createElement('kit-toast');
  el.text = text;
  let timer = 0;
  const dismiss = () => {
    clearTimeout(timer);
    el.remove();
  };
  if (undoLabel && onUndo) {
    el.undoLabel = undoLabel;
    el.addEventListener('kit-undo', () => {
      dismiss();
      onUndo();
    });
  }
  el.addEventListener('kit-dismiss', dismiss);
  if (duration === 0) el.dataset.sticky = '1';
  host.appendChild(el);
  // A quick-capture burst (bulk add, demo seed) stacks a toast per receipt
  // and can cover half the app for seconds — keep only the newest few.
  // Sticky toasts (duration 0, e.g. errors awaiting dismissal) are evicted
  // last. An evicted toast's timer later fires dismiss() on a detached
  // node, which is a no-op.
  const MAX_TOASTS = 3;
  while (host.children.length > MAX_TOASTS) {
    const victim =
      [...host.children].find((c) => c.dataset.sticky !== '1') ?? host.firstElementChild;
    if (!victim) break;
    victim.remove();
  }
  if (duration > 0) timer = setTimeout(dismiss, duration);
  return dismiss;
}

/** The shared translation of a typed-command outcome into a human sentence. */
export function outcomeMessage(outcome) {
  if (outcome?.status === 'queued' || outcome?.status === 'in-flight') {
    return outcome.reason ?? 'Saved on this device — it will sync when the gateway is reachable.';
  }
  if (outcome?.status === 'parked') {
    return 'Waiting for your approval — it lands once you confirm it in vault settings.';
  }
  if (outcome?.status === 'failed') {
    const detail = outcome.predicate ?? outcome.reason ?? 'a precondition failed';
    // A command-authored friendly message (see ConditionSpec.message) is
    // already a full sentence with its own punctuation — don't double it up
    // ("...on your calendar..") the way the raw `name: column op value`
    // fallback needs its trailing period added.
    return `The vault refused: ${detail}${/[.!?]$/.test(detail) ? '' : '.'}`;
  }
  if (outcome?.status === 'denied') {
    return `Denied by consent${outcome.reason ? `: ${outcome.reason}` : '.'}`;
  }
  return null;
}

// ---------- Loading and read-error states ----------

/** Fill a container with shimmer rows while the first read is in flight. */
export function showSkeleton(container, rows = 3) {
  container.innerHTML = '';
  const el = document.createElement('kit-skeleton');
  el.rows = rows;
  container.appendChild(el);
}

/**
 * Surface a failed read in the app's notice banner instead of silence —
 * a broken vault must not look like an empty one.
 */
export function readFailed(bannerEl) {
  if (!bannerEl) return;
  bannerEl.textContent = 'Couldn’t reach the vault — retrying when you come back.';
  bannerEl.hidden = false;
}

/**
 * Subscribe to a live read's future values without applying its current value
 * twice. The replica bridge deliberately emits the current value to a new
 * subscriber; callers also await the same read for their initial paint, so
 * this helper consumes that first subscription emission and forwards reruns.
 * Plain-Promise compatibility reads remain unmanaged.
 */
export function subscribeReadUpdates(read, onUpdate) {
  if (typeof read?.subscribe !== 'function') {
    return { managed: false, unsubscribe: () => {} };
  }
  let settled = false;
  let buffered = false;
  let latest;
  const unsubscribe = read.subscribe((value) => {
    if (!settled) {
      latest = value;
      buffered = true;
      return;
    }
    onUpdate(value);
  });
  Promise.resolve(read).then(
    (initial) => {
      settled = true;
      if (buffered && latest !== initial) queueMicrotask(() => onUpdate(latest));
    },
    () => {
      settled = true;
    },
  );
  return { managed: true, unsubscribe };
}

// ---------- Confirm-to-act (arm on first click, run on second) ----------

/**
 * Returns true when the click should proceed. First click arms the button
 * (label swap + auto-disarm after `timeout` ms); second click confirms.
 */
export function armConfirm(btn, { armedLabel = 'Sure?', timeout = 3000 } = {}) {
  if (btn.dataset.kitArmed === 'true') {
    clearTimeout(Number(btn.dataset.kitArmTimer));
    delete btn.dataset.kitArmed;
    btn.textContent = btn.dataset.kitLabel ?? btn.textContent;
    return true;
  }
  haptic('selection');
  btn.dataset.kitArmed = 'true';
  btn.dataset.kitLabel = btn.textContent;
  btn.textContent = armedLabel;
  btn.dataset.kitArmTimer = String(
    setTimeout(() => {
      delete btn.dataset.kitArmed;
      btn.textContent = btn.dataset.kitLabel ?? btn.textContent;
    }, timeout),
  );
  return false;
}

// ---------- Formatting ----------

/** Minor units → localized currency string ("€12.34"), tolerant of gaps. */
export function fmtMoney(minor, currency) {
  const value = Number(minor ?? 0) / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency ?? ''}`.trim();
  }
}

/** The viewer's local YYYY-MM-DD for an instant — never the UTC slice. */
export function localDayKey(dateish) {
  const d = dateish instanceof Date ? dateish : new Date(dateish);
  if (Number.isNaN(d.getTime())) return String(dateish).slice(0, 10);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The viewer's local YYYY-MM for an instant. */
export function localMonthKey(dateish) {
  return localDayKey(dateish).slice(0, 7);
}

/** "5m" / "3h" / "2d" / "Mar 4" — the inbox-style relative timestamp. */
export function relTime(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h`;
  if (mins < 60 * 24 * 7) return `${Math.round(mins / (60 * 24))}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function debounce(fn, ms = 200) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ---------- Refresh discipline (data-change + focus) ----------
//
// Every app re-derives what it renders from the vault, so the two cheap
// mistakes are (a) re-reading on every doorbell even when nothing this app
// cares about moved, and (b) re-reading on every window 'focus' even when the
// last read was a moment ago (alt-tab thrash). These two tiny wrappers give
// both a common, honest discipline; nothing here holds state beyond one timer
// and one timestamp.

/**
 * Subscribe to `window.centraid.onChange` with a trailing debounce and a
 * tables filter. `tables` is the set of vault entities this app reads
 * (e.g. `['knowledge.note', 'core.tag']`). A change names the tables it
 * touched; we skip the callback only when that list is NON-EMPTY and misses
 * every declared table — an empty list means "this app acted, re-derive"
 * (post-#286 handler writes carry no tables), so it always fires. Returns an
 * unsubscribe fn.
 */
export function onDataChange(tables, cb, { debounceMs = 200 } = {}) {
  const want = new Set(tables ?? []);
  let timer = 0;
  const pending = new Map();
  const unsub = window.centraid?.onChange?.((detail) => {
    const named = detail && Array.isArray(detail.tables) ? detail.tables : null;
    if (named && named.length && want.size && !named.some((t) => want.has(t))) return;
    const key =
      detail?.source === 'overlay' && typeof detail?.intentId === 'string'
        ? `${detail.intentId}:${detail.intentState ?? ''}`
        : 'latest';
    pending.set(key, detail);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const details = [...pending.values()];
      pending.clear();
      for (const value of details) cb(value);
    }, debounceMs);
  });
  return () => {
    clearTimeout(timer);
    pending.clear();
    unsub?.();
  };
}

/**
 * Refresh on window 'focus', but skip when the last focus-refresh fired less
 * than `minIntervalMs` ago — a blur/focus flurry (alt-tab, devtools) must not
 * re-hit the vault each time. Independent of onDataChange's timer: a real
 * change still refreshes immediately. The gate never applies while a consent
 * banner (`#consentBanner`) is up: focus is the recovery path when access was
 * just re-granted, so a denied app must always re-read on focus. Returns an
 * unsubscribe fn.
 */
export function onFocusRefresh(cb, { minIntervalMs = 30000 } = {}) {
  let last = 0;
  const onFocus = () => {
    const banner = document.getElementById('consentBanner');
    const recovering = banner && !banner.hidden;
    const now = Date.now();
    if (!recovering && now - last < minIntervalMs) return;
    last = now;
    cb();
  };
  window.addEventListener('focus', onFocus);
  return () => window.removeEventListener('focus', onFocus);
}

/**
 * Track an element's width and call `onNarrow(isNarrow)` whenever it crosses
 * `breakpoint` (or `data-app-width="narrow"` is forced). Prefers a
 * `ResizeObserver` (fires only on real size changes, and pauses when the tab
 * is hidden because layout doesn't change off-screen); falls back to a
 * visibility-gated poll only where RO is unavailable. Fires once immediately.
 * Returns a stop fn.
 */
export function observeWidth(el, breakpoint, onNarrow, { pollMs = 250 } = {}) {
  const measure = () => {
    if (!el) return;
    const forced = document.documentElement.getAttribute('data-app-width') === 'narrow';
    onNarrow(forced || el.clientWidth < breakpoint);
  };
  measure();
  if (typeof ResizeObserver === 'function' && el) {
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // The forced-narrow knob flips an attribute, not a size — catch it too.
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }
  const id = setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    measure();
  }, pollMs);
  return () => clearInterval(id);
}

// ---------- Letter avatars ----------

/**
 * A letter avatar element (see `<kit-avatar>`). Hue hashes from the name
 * unless `color` pins one; `initials` pins the letters; `src` swaps in a
 * photo; `shape: 'rounded'` squares the corners for file/doc tiles.
 */
export function letterAvatar(name, { size = '2.25rem', color, initials, src, shape } = {}) {
  const el = document.createElement('kit-avatar');
  el.name = String(name ?? '?');
  el.size = size;
  if (color) el.color = color;
  if (initials) el.initials = initials;
  if (src) el.src = src;
  if (shape) el.shape = shape;
  return el;
}

// ---------- SVG chart primitives (native elements — see elements.js) ----------
// The chart geometry now lives in the `<kit-line-chart>` / `<kit-bar-chart>`
// custom elements; these factories build + configure them so callers that
// append the returned element keep working.

/**
 * A time-aware line chart element: points are {x: epochMs, y: number}. Renders a
 * line, soft area fill, and an emphasized last point (see `<kit-line-chart>`).
 */
export function lineChart(points, { width = 640, height = 160, label = 'Trend' } = {}) {
  const el = document.createElement('kit-line-chart');
  el.points = points ?? [];
  el.width = width;
  el.height = height;
  el.label = label;
  return el;
}

/** Horizontal proportion bar element (e.g. cost share behind a row's amount). */
export function barSpan(ratio, { tone } = {}) {
  const el = document.createElement('kit-meter');
  el.ratio = ratio;
  if (tone) el.tone = tone;
  return el;
}

/** Vertical bar chart element for period totals: items are {label, value} (see `<kit-bar-chart>`). */
export function barChart(items, { width = 640, height = 160, label = 'Totals' } = {}) {
  const el = document.createElement('kit-bar-chart');
  el.items = items ?? [];
  el.width = width;
  el.height = height;
  el.label = label;
  return el;
}

// ---------- Attachments (the "shared pattern across apps", now actually shared) ----------
// Small files travel inline as data: URIs through the command JSON; larger
// ones stream to the vault's blob staging route and attach by sha (issue #296).

export const BLOB_ROUTE = '/centraid/_vault/blobs';
export const INLINE_ATTACH_BYTES = 256 * 1024;

/** Read a File into a data: URI (the inline path for small attachments). */
export function fileToDataUri(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/**
 * Incremental SHA-256 over the File stream. Callers opt in because hashing
 * is a full read pass; memory stays bounded and the upload body itself still
 * streams from the File on the following fetch.
 */
export async function sha256File(file) {
  if (typeof file?.arrayBuffer !== 'function') return null;
  return sha256FileStream(file);
}

/** Submit a typed contribution through the existing authenticated blob door. */
export async function stageDerivative(
  parentSha,
  variant,
  body,
  mediaType = 'application/octet-stream',
) {
  const q = new URLSearchParams({ variant, variant_of: parentSha, media_type: mediaType });
  const res = await fetch(`${BLOB_ROUTE}?${q}`, {
    method: 'POST',
    headers: { 'content-type': mediaType },
    body,
  });
  if (!res.ok) throw new Error(`${variant} contribution refused (${res.status})`);
  return res.json();
}

/** Strict policy acknowledges success only after provider custody. */
export function isPendingOffsite(staged) {
  return (
    staged?.casAck === 'replicated' &&
    staged?.custody !== 'replicated' &&
    staged?.custody !== 'remote-only'
  );
}

/**
 * Stream a File to the blob staging route; resolves the staging receipt
 * ({sha256, …}). `extra` appends pre-encoded query params (e.g. `&kind=…`).
 * With `{hash: true}`, preflight a client-declared sha and ship zero bytes
 * when another device already established custody; the gateway still hashes
 * and verifies every POST authoritatively.
 */
export async function stageFileBytes(file, extra = '', { hash = true } = {}) {
  const q = new URLSearchParams();
  if (file.name) q.set('filename', file.name);
  if (file.type) q.set('media_type', file.type);
  let declaredSha = null;
  if (hash) {
    try {
      declaredSha = await sha256File(file);
    } catch {
      declaredSha = null; // hashing support is an optimization, never an upload gate
    }
  }
  if (declaredSha) {
    q.set('sha256', declaredSha);
    try {
      const preflight = new URLSearchParams({ byte_size: String(file.size) });
      if (file.type) preflight.set('media_type', file.type);
      if (file.name) preflight.set('filename', file.name);
      const have = await fetch(`${BLOB_ROUTE}/_sha/${declaredSha}?${preflight}`, {
        method: 'HEAD',
      });
      if (have.ok) {
        return {
          sha256: declaredSha,
          mediaType: have.headers.get('x-centraid-media-type') ?? file.type ?? null,
          byteSize: Number(have.headers.get('content-length')) || file.size || 0,
          existingContentId: have.headers.get('x-centraid-content-id'),
          casAck: have.headers.get('x-centraid-cas-ack'),
          custody: have.headers.get('x-centraid-custody'),
          alreadyPresent: true,
        };
      }
    } catch {
      // Older/offline gateways simply take the normal authoritative POST.
    }
    const direct = await stageDirectFile(file, declaredSha);
    if (direct) return direct;
    const fallback = await stageFallbackFile(file, declaredSha);
    if (fallback) return fallback;
    // Session/direct routes are optional protocol extensions. The permanent
    // authoritative POST remains the compatibility and backpressure fallback.
    const legacy = await fetch(`${BLOB_ROUTE}?${q}${extra}`, {
      method: 'POST',
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-content-sha256': declaredSha,
      },
      body: file,
    });
    if (!legacy.ok) throw new Error(`upload refused (${legacy.status})`);
    return legacy.json();
  }
  const res = await fetch(`${BLOB_ROUTE}?${q}${extra}`, {
    method: 'POST',
    headers: {
      'content-type': file.type || 'application/octet-stream',
      ...(declaredSha ? { 'x-content-sha256': declaredSha } : {}),
    },
    body: file,
  });
  if (!res.ok) throw new Error(`upload refused (${res.status})`);
  return res.json();
}

/** "812 B" / "24 KB" / "1.3 MB" — `empty` is returned for 0/absent sizes. */
export function fmtBytes(n, empty = '') {
  if (!n || !Number.isFinite(Number(n))) return empty;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Fill `stripEl` with attachment tiles (image thumb or file link + size
 * badge). The remove control arms on first click (kit armConfirm) and calls
 * `onRemove(attachment_id)`; when that resolves to an executed outcome the
 * tile drops immediately. Pass `onRemove: null` for a read-only strip (no
 * remove control at all). `onZoom(attachment)`, when given, makes image
 * thumbs zoomable.
 */
export function renderAttachments(stripEl, list, onRemove, { onZoom } = {}) {
  // An imperative rebuild (any refresh — e.g. the window-focus one) would
  // otherwise wipe an armed remove button mid-confirm: the owner's second
  // click lands on a fresh, disarmed button and merely re-arms it. Carry
  // the armed state across the rebuild (the old node's disarm timer fires
  // on the detached button — a no-op).
  const armed = new Set(
    [...stripEl.querySelectorAll('.kit-attach-remove[data-kit-armed="true"]')].map(
      (b) => b.dataset.kitAttachmentId,
    ),
  );
  stripEl.innerHTML = '';
  for (const a of list ?? []) {
    const tile = document.createElement('div');
    tile.className = 'kit-attach-tile';
    if (String(a.media_type).startsWith('image/')) {
      const img = document.createElement('img');
      img.src = a.content_uri;
      img.alt = a.title ?? 'attachment';
      if (onZoom) {
        img.className = 'kit-attach-zoom';
        img.addEventListener('click', () => onZoom(a));
      }
      tile.appendChild(img);
    } else {
      const link = document.createElement('a');
      link.className = 'kit-attach-file';
      link.href = a.content_uri;
      link.download = a.title ?? 'file';
      link.textContent = (a.title ?? a.media_type ?? 'file').slice(0, 24);
      tile.appendChild(link);
    }
    const meta = document.createElement('span');
    meta.className = 'kit-attach-meta';
    meta.textContent = fmtBytes(a.byte_size);
    tile.appendChild(meta);
    if (onRemove) {
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'kit-attach-remove';
      rm.textContent = '×';
      rm.title = 'Remove';
      rm.setAttribute('aria-label', 'Remove attachment');
      rm.dataset.kitAttachmentId = String(a.attachment_id);
      rm.addEventListener('click', async () => {
        if (!armConfirm(rm, { armedLabel: 'Sure?' })) return;
        const outcome = await onRemove(a.attachment_id);
        if (outcome?.status === 'executed') tile.remove();
      });
      if (armed.has(String(a.attachment_id))) armConfirm(rm, { armedLabel: 'Sure?' });
      tile.appendChild(rm);
    }
    stripEl.appendChild(tile);
  }
}

/**
 * Wire a hidden `<input type=file>` to the attach flow: stage-or-inline each
 * picked file, run the app's `attach` action, narrate each outcome. The app
 * supplies its own consent voice: `act(action, input) → outcome`,
 * `narrate(outcome) → bool` (false stops the batch), `notice(text)` for read
 * errors, `refresh()` after the batch.
 */
export function wireAttachInput(inputEl, getSubjectId, { act, narrate, notice, refresh }) {
  inputEl.addEventListener('change', async () => {
    const subjectId = getSubjectId();
    if (!subjectId) return;
    for (const file of [...inputEl.files]) {
      let input;
      let custodyReceipt;
      try {
        if (file.size > INLINE_ATTACH_BYTES) {
          const staged = await stageFileBytes(file);
          custodyReceipt = staged;
          input = { subject_id: subjectId, staged_sha: staged.sha256, title: file.name };
        } else {
          const dataUri = await fileToDataUri(file);
          input = { subject_id: subjectId, data_uri: dataUri, title: file.name };
        }
      } catch {
        notice?.('Could not read that file.');
        continue;
      }
      const outcome = await act('attach', input);
      if (outcome?.status === 'executed' && isPendingOffsite(custodyReceipt)) {
        notice?.('Attached locally · waiting for offsite custody.');
      }
      if (!narrate(outcome)) break;
    }
    inputEl.value = '';
    await refresh?.();
  });
}

// ---------- Anchored popover menu (Docs' openPopover, shared) ----------

let popoverEl = null;
let popoverCleanup = null;

/** Whether a kit popover is open — layered Escape handlers ask before closing. */
export function isPopoverOpen() {
  return popoverEl != null;
}

/** Close the open kit popover (no-op when none is open). */
export function closePopover() {
  if (!popoverEl) return;
  popoverCleanup?.();
  popoverEl.remove();
  popoverEl = null;
  popoverCleanup = null;
}

/**
 * Open a popover anchored to `anchor`: right-aligned, flips above when the
 * viewport runs out, closes on outside click / scroll / resize / Escape.
 * `build` receives the popover box and appends its content (see `popItem`).
 * Options: `focus` moves focus to the first field/button inside (form
 * popovers); `className` adds an app class for width/spacing overrides;
 * `role` overrides the default `menu` (use `dialog` for form popovers);
 * `onClose` runs once when the popover closes by any path (Escape, outside
 * click, scroll, resize, programmatic) — the teardown point for popovers
 * that attach document-level helpers.
 */
export function openPopover(
  anchor,
  build,
  { focus = false, className, role = 'menu', onClose } = {},
) {
  closePopover();
  const box = h('div', { class: className ? `kit-popover ${className}` : 'kit-popover', role });
  build(box);
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closePopover();
    }
  });
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
    // Scrolling inside the popover — or inside the kit's own body-level
    // @-mention list — must not close the popover hosting it.
    if (box.contains(e.target)) return;
    if (e.target instanceof Element && e.target.closest?.('.kit-mention-pop')) return;
    closePopover();
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
    onClose?.();
  };
  if (focus) box.querySelector('input, select, textarea, button')?.focus();
}

/** One menu row for `openPopover`: label + optional icon, dot, danger tone. */
export function popItem(
  label,
  onClick,
  { danger = false, disabled = false, iconHtml = null, dotColor = null } = {},
) {
  const btn = h('button', {
    type: 'button',
    class: `kit-popover-item${danger ? ' danger' : ''}`,
    role: 'menuitem',
    disabled: disabled || undefined,
    onclick: onClick,
  });
  if (iconHtml) btn.appendChild(el(iconHtml));
  if (dotColor)
    btn.appendChild(h('span', { class: 'kit-dotmini', style: `background:${dotColor};` }));
  btn.appendChild(document.createTextNode(label));
  return btn;
}

// ---------- Empty state ----------

/**
 * Fill `container` with the canonical empty state (icon tile, title, sub,
 * optional action element) and unhide it.
 */
export function emptyState(container, { icon, title, sub, action } = {}) {
  const subEl = h('div', { class: 'kit-empty-sub' }, sub ?? '');
  if (action) subEl.appendChild(action);
  const kids = [];
  if (icon) {
    kids.push(h('div', { class: 'kit-empty-icon' }, typeof icon === 'string' ? el(icon) : icon));
  }
  kids.push(h('div', { class: 'kit-empty-title' }, title ?? ''), subEl);
  container.replaceChildren(...kids);
  container.hidden = false;
}

// ---------- Search-hit snippets ----------

/** Render a `⟦hit⟧` search snippet into `target`, marking the hits. */
export function snippetInto(target, snippet) {
  const parts = String(snippet ?? '').split(/[⟦⟧]/);
  for (let i = 0; i < parts.length; i += 1) {
    if (!parts[i]) continue;
    if (i % 2 === 1) {
      const mark = document.createElement('mark');
      mark.textContent = parts[i];
      target.appendChild(mark);
    } else {
      target.appendChild(document.createTextNode(parts[i]));
    }
  }
}

// ---------- Bulk runner (selection-bar actions) ----------

/**
 * Run `run(id)` over `ids` sequentially, narrating progress and the final
 * tally. The app supplies its voice + cleanup: `notice(text)`,
 * `friendly(outcome) → string|null` for failure copy, `after()` once done.
 */
export async function runBulk(ids, run, { progress, done, suffix = '', notice, friendly, after }) {
  const n = ids.length;
  let ok = 0;
  let parked = 0;
  const failures = [];
  for (let i = 0; i < n; i += 1) {
    notice(`${progress} ${i + 1} of ${n}…`);
    const outcome = await run(ids[i]);
    if (outcome?.status === 'executed') ok += 1;
    else if (outcome?.status === 'parked') parked += 1;
    else failures.push(friendly?.(outcome) ?? 'The write failed.');
  }
  notice(
    failures.length > 0 ? `${failures.length} of ${n} didn’t go through — ${failures[0]}` : '',
  );
  const parts = [`${done} ${ok} of ${n}${suffix} · receipted.`];
  if (parked > 0) parts.push(`${parked} waiting for approval.`);
  toast(parts.join(' '));
  await after?.();
}

// ---------- Theme toggle ----------

const SUN_SVG =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/></svg>';
const MOON_SVG =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>';

/** Effective theme right now: the explicit data-theme, else the OS scheme. */
export function isDarkNow() {
  const t = document.documentElement.dataset.theme;
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Wire a header button as the app's light/dark toggle: sets `data-theme`,
 * seeds `--bg-l` on first dark flip (the wall gradient's knob), and keeps a
 * sun/moon icon in the button. `onChange(dark)` runs after each flip.
 */
export function wireThemeToggle(btn, { onChange } = {}) {
  const setIcon = () => {
    btn.innerHTML = isDarkNow() ? SUN_SVG : MOON_SVG;
  };
  btn.addEventListener('click', () => {
    const dark = !isDarkNow();
    const root = document.documentElement;
    root.dataset.theme = dark ? 'dark' : 'light';
    if (dark && !root.style.getPropertyValue('--bg-l')) root.style.setProperty('--bg-l', '10%');
    setIcon();
    onChange?.(dark);
  });
  setIcon();
  return setIcon;
}

// ============================================================================
//  "Ask your vault" controller — folded in from the former standalone kit-ask.js
//  so every app ships a single synced kit.js (evaluated via app.js's
//  `import './kit.js'`) instead of a second <script>. The IIFE below runs at
//  module-eval time — before app.js's body — so `window.kitAsk` is ready to wire.
//  Reads window.KIT_ASK (set inline in index.html before app.js) and mounts the
//  Ask button + panel onto [data-ask-mount].
//
//  By default the panel drives itself against the real vault surfaces:
//    - POST  <app>/_turn                        — the app's declared-handler
//      agent (SSE stream). Writes the agent makes flow through the same
//      dispatcher + vault consent gates as every other caller.
//    - GET   /centraid/_vault/parked            — when a turn's write parks,
//      the matching invocation is looked up and rendered as a proposed-write
//      card. Nothing is written without the owner's say-so.
//    - POST  /centraid/_vault/parked/<id>       — Approve/Discard post the
//      real {approve} decision and render the actual InvokeOutcome.
//    - GET   /centraid/_vault/status + /apps    — the context chip reflects
//      the app's true grant state instead of a hardcoded label.
//  An app can take over the conversation with:
//    kitAsk.onAsk(async (text) => { ...custom driver... })
// ============================================================================

(function () {
  var cfg = window.KIT_ASK || {};

  function el(html) {
    var t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
    });
  }

  var HISTORY_ICON =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3.2 2"/></svg>';
  var CLIP_ICON =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M16.9 6.6 9 14.5a2.75 2.75 0 0 0 3.9 3.9l7.4-7.4a4.5 4.5 0 1 0-6.36-6.37L6.5 12.1"/></svg>';
  var CHEVRON_ICON =
    '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

  /** Default intro copy — shared by the first render and every "New conversation" reset. */
  function introText() {
    return (
      cfg.intro ||
      'Ask me to add, change, find or remove anything here. I’ll show the change for your approval before it touches the vault.'
    );
  }

  function panelHTML() {
    var scope = esc(cfg.scope || 'this app');
    var sugg = (cfg.suggest || [])
      .map(function (s) {
        return '<button type="button" class="kit-ask-chip">' + esc(s) + '</button>';
      })
      .join('');
    return (
      '<div class="kit-ask-ov" id="kitAskOverlay" hidden><div class="kit-ask-panel" role="dialog" aria-modal="true" aria-label="Ask your vault">' +
      '<div class="kit-ask-head"><h2>Ask</h2><span class="kit-ask-note">a projection of your vault</span>' +
      '<button type="button" class="kit-ask-history-btn" aria-label="Conversation history" aria-pressed="false">' +
      HISTORY_ICON +
      '</button>' +
      '<button type="button" class="kit-ask-x" aria-label="Close">✕</button></div>' +
      '<div class="kit-ask-context"><span class="kit-ask-scope">Scope · ' +
      scope +
      '</span><span class="kit-ask-scope" data-kit-grant>read + write · consent-gated</span></div>' +
      '<div class="kit-ask-log" role="log" aria-live="polite"><div class="kit-msg ai">' +
      esc(introText()) +
      '</div></div>' +
      '<div class="kit-ask-history" hidden>' +
      '<div class="kit-ask-history-head"><button type="button" class="kit-ask-history-new">+ New conversation</button></div>' +
      '<div class="kit-ask-history-list" role="list"></div>' +
      '</div>' +
      '<div class="kit-ask-suggest">' +
      sugg +
      '</div>' +
      // Composer — one rounded frame (`.kit-ask-compose`) holding staged
      // attachment chips, the input, and a slim bottom controls strip
      // (attach left, model picker + send right) — modeled on Claude
      // Code's composer, adapted to kit tokens. `data-busy` is the e2e
      // contract for "a turn is in flight": 'true' from submit until the
      // turn's terminal SSE event (final/error/aborted) or the stream
      // closes; 'false' otherwise. The send button (and, while busy, the
      // model picker) are disabled so a turn can't be double-sent.
      '<form class="kit-ask-compose" data-busy="false">' +
      '<input type="file" class="kit-ask-file" multiple hidden aria-hidden="true" tabindex="-1">' +
      '<div class="kit-ask-pending" hidden></div>' +
      '<input class="kit-ask-input" placeholder="' +
      esc(cfg.placeholder || 'Ask…') +
      '" aria-label="Ask">' +
      '<div class="kit-ask-controls">' +
      '<button type="button" class="kit-ask-attach" aria-label="Attach files">' +
      CLIP_ICON +
      '</button>' +
      '<div class="kit-ask-controls-spacer"></div>' +
      '<div class="kit-ask-model">' +
      '<button type="button" class="kit-ask-model-btn" aria-label="Model" aria-haspopup="menu" aria-expanded="false">' +
      '<span class="kit-ask-model-label">Default</span>' +
      CHEVRON_ICON +
      '</button>' +
      '<div class="kit-ask-model-menu" hidden role="menu" aria-label="Choose the ask model"></div>' +
      '</div>' +
      '<button class="kit-ask-send" type="submit" aria-label="Send">→</button>' +
      '</div>' +
      '</form>' +
      '</div></div>'
    );
  }

  /**
   * Per-panel active-conversation id. Shared by the default `_turn` driver
   * AND the History view — selecting a past conversation there, or starting
   * a fresh one, must be reflected in the very next turn this panel sends.
   * Persisted in sessionStorage under a per-app key so a reload resumes the
   * same thread (mirrors the id-provisioning contract in `makeVaultDriver`).
   */
  function makeConversationSession() {
    var key = 'kitask:conversation:' + (appId() || location.pathname);
    var cached = null;
    return {
      get: function () {
        if (cached) return cached;
        try {
          cached = sessionStorage.getItem(key);
        } catch (_) {}
        return cached;
      },
      set: function (v) {
        cached = v || null;
        try {
          if (cached) sessionStorage.setItem(key, cached);
          else sessionStorage.removeItem(key);
        } catch (_) {}
      },
      clear: function () {
        this.set(null);
      },
    };
  }

  function init() {
    if (window.kitAsk) return; // once
    var mount =
      document.querySelector('[data-ask-mount]') ||
      document.querySelector('.head-tools') ||
      document.querySelector('.head') ||
      document.body;
    if (
      mount.classList &&
      (mount.classList.contains('head') || mount.classList.contains('head-tools'))
    ) {
      mount.style.flexWrap = 'wrap';
    }
    var btn = el(
      '<button type="button" class="kit-ask-btn" id="kitAskBtn"><span class="kit-spark">✦</span> Ask</button>',
    );
    mount.appendChild(btn);

    var ov = el(panelHTML());
    document.body.appendChild(ov);
    var panel = ov.querySelector('.kit-ask-panel');
    var log = ov.querySelector('.kit-ask-log');
    var historyBtn = ov.querySelector('.kit-ask-history-btn');
    var historyView = ov.querySelector('.kit-ask-history');
    var historyList = ov.querySelector('.kit-ask-history-list');
    var historyNewBtn = ov.querySelector('.kit-ask-history-new');
    var suggestRow = ov.querySelector('.kit-ask-suggest');
    var pendingStrip = ov.querySelector('.kit-ask-pending');
    var form = ov.querySelector('.kit-ask-compose');
    var input = form.querySelector('.kit-ask-input');
    var fileInput = form.querySelector('.kit-ask-file');
    var attachBtn = form.querySelector('.kit-ask-attach');
    var sendBtn = form.querySelector('.kit-ask-send');
    var session = makeConversationSession();
    var lastFocus = null;
    var autoLoadAttempted = false;

    // ---------- Busy state (a turn is in flight) ----------
    // `data-busy` on `.kit-ask-compose` is the e2e contract: 'true' from
    // submit until the turn's terminal SSE event (final/error/aborted) or
    // the stream closes; 'false' otherwise. Fixes the working-indicator
    // bug where `typing.done()` firing on the FIRST `assistant.delta` made
    // the panel look idle while tool calls were still running — this state
    // spans the WHOLE turn, not just the pre-first-token gap. Also doubles
    // as the double-send guard: the send button (and model picker) are
    // disabled while busy.
    var busy = false;
    // The AbortController of the in-flight turn, so the Send button can double
    // as Stop while busy (issue #420 — the kit's Ask panel gains cancel).
    var activeAbort = null;
    var SEND_ARROW = '→';
    var SEND_STOP = '■';
    function setBusy(b) {
      busy = !!b;
      form.dataset.busy = busy ? 'true' : 'false';
      // While busy the button stays enabled and becomes Stop; clicking it
      // aborts the turn (see the sendBtn click handler below) instead of
      // double-sending. Idle, it's the Send arrow that submits the form.
      sendBtn.disabled = false;
      sendBtn.innerHTML = busy ? SEND_STOP : SEND_ARROW;
      sendBtn.setAttribute('aria-label', busy ? 'Stop' : 'Send');
      if (busy) sendBtn.dataset.stop = 'true';
      else delete sendBtn.dataset.stop;
      if (modelPicker) modelPicker.setDisabled(busy);
    }
    // Intercept clicks while busy: cancel the turn rather than submit. Runs
    // before the form's submit handler; `preventDefault` stops the submit.
    sendBtn.addEventListener('click', function (e) {
      if (busy) {
        e.preventDefault();
        if (activeAbort) activeAbort.abort();
      }
    });

    function open() {
      lastFocus = document.activeElement;
      ov.hidden = false;
      // Re-check on every open, not just the first — a grant can change
      // (revoke, re-grant, scope widening) between opens within the same
      // iframe session, and the chip should never show stale consent state.
      refreshGrantChip(ov.querySelector('[data-kit-grant]'));
      maybeAutoLoadStoredConversation();
      if (modelPicker) modelPicker.load();
      setTimeout(function () {
        input && input.focus();
      }, 60);
    }
    function close() {
      ov.hidden = true;
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }
    btn.addEventListener('click', open);
    ov.querySelector('.kit-ask-x').addEventListener('click', close);
    ov.addEventListener('click', function (e) {
      if (e.target === ov) close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !ov.hidden) close();
    });
    ov.querySelectorAll('.kit-ask-chip').forEach(function (c) {
      c.addEventListener('click', function () {
        input.value = c.textContent;
        input.focus();
      });
    });

    // ---------- Inline model picker (subsystem `ask`, active runner) ----------
    // A quiet text control in the composer's controls row — shows the
    // current override's display name, or "Default" when the subsystem has
    // no override. Backed by `GET`/`PUT <app>/_turn/model` (the SAME
    // `model.<runnerKind>.ask` prefs key the gateway resolves at turn
    // time — see `resolveSubsystemModel`), so the picker and the actual
    // turn always agree. No caching beyond the current panel session: each
    // `open()` re-fetches, since the pref can change elsewhere (desktop
    // Settings → Agents) between opens.
    function initAskModelPicker() {
      var wrap = form.querySelector('.kit-ask-model');
      var modelBtn = form.querySelector('.kit-ask-model-btn');
      var labelEl = form.querySelector('.kit-ask-model-label');
      var menu = form.querySelector('.kit-ask-model-menu');
      if (!wrap || !modelBtn || !menu) return null;
      var state = { loaded: false, current: null, defaultModel: '', catalog: [] };

      function renderLabel() {
        labelEl.textContent = modelLabel(state);
      }

      function onDocPointer(e) {
        if (!menu.contains(e.target) && e.target !== modelBtn) closeMenu();
      }
      function onDocKey(e) {
        if (e.key === 'Escape') closeMenu();
      }
      function closeMenu() {
        if (menu.hidden) return;
        menu.hidden = true;
        modelBtn.setAttribute('aria-expanded', 'false');
        document.removeEventListener('mousedown', onDocPointer, true);
        document.removeEventListener('keydown', onDocKey, true);
      }

      function choose(modelId) {
        closeMenu();
        var prev = state.current;
        state.current = modelId; // optimistic
        renderLabel();
        fetch(appBase() + '_turn/model', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: modelId }),
        })
          .then(function (r) {
            if (!r.ok) throw new Error('model update failed (' + r.status + ')');
            return r.json();
          })
          .then(function (body) {
            Object.assign(state, normalizeModelState(body));
            renderLabel();
          })
          .catch(function () {
            state.current = prev; // revert the optimistic label on failure
            renderLabel();
          });
      }

      function renderMenu() {
        menu.innerHTML = '';
        var useDefault = el(
          '<button type="button" role="menuitemradio" class="kit-ask-model-item' +
            (!state.current ? ' is-active' : '') +
            '" aria-checked="' +
            !state.current +
            '"><span>Use default</span><span class="kit-ask-model-hint">' +
            esc(state.defaultModel || 'gateway default') +
            '</span></button>',
        );
        useDefault.addEventListener('click', function () {
          choose(null);
        });
        menu.appendChild(useDefault);
        if (state.catalog.length) menu.appendChild(el('<div class="kit-ask-model-divider"></div>'));
        state.catalog.forEach(function (m) {
          var active = m.id === state.current;
          var item = el(
            '<button type="button" role="menuitemradio" class="kit-ask-model-item' +
              (active ? ' is-active' : '') +
              '" aria-checked="' +
              active +
              '"><span>' +
              esc(m.label || m.id) +
              '</span></button>',
          );
          item.addEventListener('click', function () {
            choose(m.id);
          });
          menu.appendChild(item);
        });
      }

      function openMenu() {
        renderMenu();
        menu.hidden = false;
        modelBtn.setAttribute('aria-expanded', 'true');
        document.addEventListener('mousedown', onDocPointer, true);
        document.addEventListener('keydown', onDocKey, true);
      }

      modelBtn.addEventListener('click', function () {
        if (modelBtn.disabled) return;
        if (menu.hidden) openMenu();
        else closeMenu();
      });

      return {
        /** Re-fetch the picker state (called on every panel `open()`). */
        load: function () {
          return fetchJson(appBase() + '_turn/model').then(function (r) {
            if (r.ok && r.body) Object.assign(state, normalizeModelState(r.body));
            renderLabel();
          }, renderLabel);
        },
        setDisabled: function (disabled) {
          modelBtn.disabled = !!disabled;
          if (disabled) closeMenu();
        },
      };
    }
    var modelPicker = initAskModelPicker();

    function bubble(cls, html) {
      var m = el('<div class="kit-msg ' + cls + '"></div>');
      m.innerHTML = html;
      log.appendChild(m);
      log.scrollTop = log.scrollHeight;
      return m;
    }

    /** Attachment-chip markup for a message bubble — a just-sent turn or a loaded transcript. */
    function attachmentChipsHtml(atts) {
      if (!atts || !atts.length) return '';
      return (
        '<div class="kit-ask-msg-atts">' +
        atts
          .map(function (a) {
            return (
              '<span class="kit-ask-msg-att">' + CLIP_ICON + esc(a.filename || 'file') + '</span>'
            );
          })
          .join('') +
        '</div>'
      );
    }

    var api = {
      open: open,
      close: close,
      /** append a user bubble (escaped); `atts` optionally renders attachment chips beneath it */
      user: function (t, atts) {
        return bubble('user', esc(t) + attachmentChipsHtml(atts));
      },
      /** append an assistant bubble (HTML allowed — caller sanitises) */
      ai: function (html) {
        return bubble('ai', html);
      },
      /**
       * Append a muted system-note row (issue #424) — e.g. a context-reset
       * warning. Rendered the same way live and on reload so a persisted
       * `notice` looks identical to the one the live stream showed.
       */
      notice: function (t) {
        var m = el('<div class="kit-ask-toolnote kit-ask-notice"></div>');
        m.textContent = '⚠ ' + (t || 'Notice');
        log.appendChild(m);
        log.scrollTop = log.scrollHeight;
        return m;
      },
      /** show a typing indicator; returns { done() } */
      typing: function () {
        var t = el('<div class="kit-ask-typing"><i></i><i></i><i></i></div>');
        log.appendChild(t);
        log.scrollTop = log.scrollHeight;
        return {
          done: function () {
            if (t.parentNode) t.remove();
          },
        };
      },
      /**
       * Mark the panel busy/idle for the DURATION of a turn (not just the
       * pre-first-token gap `typing()` covers) — sets `data-busy` on
       * `.kit-ask-compose` and disables Send + the model picker. A custom
       * `onAsk` driver should call this too so double-sends stay guarded.
       */
      setBusy: setBusy,
      /** a completed, receipted action (with optional Undo) */
      applied: function (o) {
        o = o || {};
        var a = el(
          '<div class="kit-ask-applied"><span class="ck">✓</span><span class="ac-t">' +
            esc(o.title) +
            '<span class="ac-s">' +
            esc(o.receipt || 'saved as a receipt') +
            '</span></span>' +
            (o.onUndo ? '<button class="ac-undo">Undo</button>' : '') +
            '</div>',
        );
        log.appendChild(a);
        var u = a.querySelector('.ac-undo');
        if (u)
          u.addEventListener('click', function () {
            o.onUndo();
            a.remove();
          });
        log.scrollTop = log.scrollHeight;
        return a;
      },
      /**
       * A consent-gated proposed write.
       *
       * `onApprove` / `onDiscard` may return a promise — the card shows a
       * busy state until it settles and renders the REAL outcome: resolve
       * with `{ok: true, receipt?}` to swap to an applied receipt, or
       * `{ok: false, note}` (or reject) to keep the card and surface the
       * refusal honestly. A sync/void `onApprove` keeps the legacy
       * immediate-swap behavior.
       */
      propose: function (o) {
        o = o || {};
        var diff = o.diff
          ? '<div class="kit-aa-diff"><span class="d1">' +
            esc(o.diff[0]) +
            '</span> → <span class="d2">' +
            esc(o.diff[1]) +
            '</span></div>'
          : '';
        var card = el(
          '<div class="kit-ask-action"><span class="aa-label">Proposed write · needs your ok</span>' +
            '<div class="aa-title">' +
            esc(o.title) +
            '</div><div class="aa-detail">' +
            esc(o.detail || '') +
            '</div>' +
            diff +
            '<div class="aa-btns"><button class="kit-aa-approve">Approve</button>' +
            (o.onEdit ? '<button class="kit-aa-ghost aa-edit">Edit</button>' : '') +
            '<button class="kit-aa-ghost aa-discard">Discard</button></div></div>',
        );
        log.appendChild(card);
        function setBusy(busy) {
          card.querySelectorAll('button').forEach(function (b) {
            b.disabled = busy;
          });
          card.classList.toggle('aa-busy', busy);
        }
        function note(text) {
          var n =
            card.querySelector('.aa-note') || card.appendChild(el('<div class="aa-note"></div>'));
          n.textContent = text;
          log.scrollTop = log.scrollHeight;
        }
        function swapApplied(receipt) {
          card.replaceWith(
            el(
              '<div class="kit-ask-applied"><span class="ck">✓</span><span class="ac-t">' +
                esc(o.title) +
                '<span class="ac-s">' +
                esc(receipt || 'approved · saved as a receipt') +
                '</span></span></div>',
            ),
          );
          log.scrollTop = log.scrollHeight;
        }
        card.querySelector('.kit-aa-approve').addEventListener('click', function () {
          var settled = o.onApprove ? o.onApprove() : undefined;
          if (!settled || typeof settled.then !== 'function') return swapApplied();
          setBusy(true);
          settled.then(
            function (r) {
              if (r && r.ok === false) {
                setBusy(false);
                note(r.note || 'The vault refused this write.');
                return;
              }
              swapApplied(r && r.receipt);
            },
            function (err) {
              setBusy(false);
              note(String((err && err.message) || err || 'Approval failed.'));
            },
          );
        });
        var edit = card.querySelector('.aa-edit');
        if (edit)
          edit.addEventListener('click', function () {
            o.onEdit();
          });
        card.querySelector('.aa-discard').addEventListener('click', function () {
          var settled = o.onDiscard ? o.onDiscard() : undefined;
          if (!settled || typeof settled.then !== 'function') return card.remove();
          setBusy(true);
          settled.then(
            function () {
              card.remove();
            },
            function (err) {
              setBusy(false);
              note(String((err && err.message) || err || 'Discard failed.'));
            },
          );
        });
        log.scrollTop = log.scrollHeight;
        return card;
      },
      /**
       * Override the natural-language handler. Without an override the
       * panel drives the app's own `_turn` agent (declared handlers +
       * vault consent gates) — see `makeVaultDriver`.
       */
      onAsk: function (fn) {
        handler = fn;
      },
    };
    window.kitAsk = api;

    // ---------- Pending attachments (compose strip) ----------
    // Files picked/dropped/pasted upload immediately to the per-app
    // conversation blob CAS (issue #190); the strip tracks their upload
    // state until Send folds the resolved refs into the turn body.
    var pending = []; // { cid, file, status: 'uploading'|'done'|'error', hash, mime, filename, sizeBytes, error }
    var pendingSeq = 0;
    var MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

    function renderPending() {
      pendingStrip.innerHTML = '';
      pendingStrip.hidden = pending.length === 0 || !historyView.hidden;
      pending.forEach(function (p) {
        var chip = el(
          '<span class="kit-ask-pending-chip' +
            (p.status === 'uploading' ? ' is-uploading' : '') +
            (p.status === 'error' ? ' is-error' : '') +
            '">' +
            (p.status === 'uploading' ? '<i class="kit-ask-pending-spin"></i>' : '') +
            '<span class="kit-ask-pending-name">' +
            esc(p.file.name) +
            '</span><span class="kit-ask-pending-size">' +
            (p.status === 'error' ? esc(p.error || 'failed') : esc(fmtBytes(p.file.size, '0 B'))) +
            '</span><button type="button" class="kit-ask-pending-remove" aria-label="Remove ' +
            esc(p.file.name) +
            '">✕</button></span>',
        );
        chip.querySelector('.kit-ask-pending-remove').addEventListener('click', function () {
          pending = pending.filter(function (x) {
            return x.cid !== p.cid;
          });
          renderPending();
        });
        pendingStrip.appendChild(chip);
      });
    }

    function clearPending() {
      pending = [];
      renderPending();
    }

    function addFiles(files) {
      Array.prototype.slice.call(files || []).forEach(function (file) {
        var p = { cid: ++pendingSeq, file: file, status: 'uploading' };
        pending.push(p);
        renderPending();
        if (file.size > MAX_UPLOAD_BYTES) {
          p.status = 'error';
          p.error = 'over 25 MB';
          renderPending();
          return;
        }
        uploadBlob(file)
          .then(function (r) {
            if (pending.indexOf(p) === -1) return; // removed mid-upload
            p.status = 'done';
            p.hash = r.hash;
            p.mime = r.mime;
            p.sizeBytes = r.sizeBytes;
            p.filename = file.name;
            renderPending();
          })
          .catch(function (err) {
            if (pending.indexOf(p) === -1) return;
            p.status = 'error';
            p.error = String((err && err.message) || err || 'upload failed');
            renderPending();
          });
      });
    }

    function typesHasFiles(dt) {
      if (!dt || !dt.types) return false;
      for (var i = 0; i < dt.types.length; i++) {
        if (dt.types[i] === 'Files') return true;
      }
      return false;
    }

    attachBtn.addEventListener('click', function () {
      fileInput.click();
    });
    fileInput.addEventListener('change', function () {
      addFiles(fileInput.files);
      fileInput.value = '';
    });
    panel.addEventListener('dragover', function (e) {
      if (!typesHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      panel.classList.add('is-dragover');
    });
    panel.addEventListener('dragleave', function (e) {
      if (e.target === panel) panel.classList.remove('is-dragover');
    });
    panel.addEventListener('drop', function (e) {
      if (!typesHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      panel.classList.remove('is-dragover');
      var files = (e.dataTransfer && e.dataTransfer.files) || [];
      if (files.length) addFiles(files);
    });
    input.addEventListener('paste', function (e) {
      var files = (e.clipboardData && e.clipboardData.files) || [];
      if (files.length) addFiles(files);
    });

    // ---------- Conversation history (issue #190 read side) ----------

    function setViewMode(mode) {
      var isHistory = mode === 'history';
      historyView.hidden = !isHistory;
      log.hidden = isHistory;
      suggestRow.hidden = isHistory;
      form.hidden = isHistory;
      pendingStrip.hidden = isHistory || pending.length === 0;
      historyBtn.setAttribute('aria-pressed', isHistory ? 'true' : 'false');
      historyBtn.classList.toggle('is-active', isHistory);
    }

    function historyNote(text) {
      historyList.innerHTML = '';
      historyList.appendChild(el('<div class="kit-ask-history-empty"></div>')).textContent = text;
    }

    function renderHistoryList(sessions) {
      historyList.innerHTML = '';
      if (!sessions || !sessions.length) {
        historyNote('No past conversations');
        return;
      }
      sessions.forEach(function (s) {
        var title = s.title && String(s.title).trim() ? s.title : 'Conversation';
        var turns = s.turnCount || 0;
        var meta = (turns === 1 ? '1 turn' : turns + ' turns') + ' · ' + relTime(s.updatedAt);
        var row = el(
          '<div class="kit-ask-history-row">' +
            '<button type="button" class="kit-ask-history-item" data-id="' +
            esc(s.id) +
            '"><span class="kit-ask-history-title">' +
            esc(title) +
            '</span><span class="kit-ask-history-meta">' +
            esc(meta) +
            '</span></button>' +
            '<button type="button" class="kit-ask-history-del" data-id="' +
            esc(s.id) +
            '" aria-label="Delete ' +
            esc(title) +
            '">✕</button></div>',
        );
        historyList.appendChild(row);
      });
    }

    function loadHistoryList() {
      historyNote('Loading…');
      fetchJson(conversationsBase()).then(function (r) {
        if (!r.ok) {
          historyNote("Couldn't load past conversations.");
          return;
        }
        renderHistoryList((r.body && r.body.sessions) || []);
      });
    }

    function resetLogToIntro() {
      log.innerHTML = '';
      var m = el('<div class="kit-msg ai"></div>');
      m.textContent = introText();
      log.appendChild(m);
    }

    /** Reconstruct the log from a loaded session's messages, collapsing a run of `tool` items into one muted note. */
    function renderTranscript(messages) {
      log.innerHTML = '';
      var list = messages || [];
      var i = 0;
      while (i < list.length) {
        var payload = (list[i] && list[i].payload) || {};
        if (payload.kind === 'user') {
          bubble('user', esc(payload.text || '') + attachmentChipsHtml(payload.attachments));
          i++;
        } else if (payload.kind === 'tool') {
          var n = 0;
          while (i < list.length && list[i].payload && list[i].payload.kind === 'tool') {
            n++;
            i++;
          }
          var note = el('<div class="kit-ask-toolnote"></div>');
          note.textContent = '⚙ used ' + n + (n === 1 ? ' tool' : ' tools');
          log.appendChild(note);
        } else if (payload.kind === 'notice') {
          // Persisted system note (issue #424) — same muted row as live.
          api.notice(payload.text || '');
          i++;
        } else {
          // 'ai' (and any future kind) render as a plain assistant bubble.
          bubble('ai', esc(payload.text || ''));
          i++;
        }
      }
      if (!list.length) resetLogToIntro();
      log.scrollTop = log.scrollHeight;
    }

    function openConversation(id) {
      historyNote('Loading…');
      fetchJson(conversationPath(appId() || '', id)).then(function (r) {
        if (!r.ok) {
          if (r.status === 404) {
            loadHistoryList(); // a stale row — refresh the list in place
            return;
          }
          historyNote("Couldn't load that conversation.");
          return;
        }
        session.set(id);
        renderTranscript(r.body && r.body.messages);
        setViewMode('chat');
      });
    }

    function deleteConversationRow(id) {
      fetch(conversationPath(appId() || '', id), { method: 'DELETE' }).then(function () {
        if (session.get() === id) {
          session.clear();
          resetLogToIntro();
        }
        loadHistoryList();
      });
    }

    historyBtn.addEventListener('click', function () {
      if (historyView.hidden) {
        loadHistoryList();
        setViewMode('history');
      } else {
        setViewMode('chat');
      }
    });
    historyNewBtn.addEventListener('click', function () {
      session.clear();
      resetLogToIntro();
      clearPending();
      setViewMode('chat');
      input && input.focus();
    });
    historyList.addEventListener('click', function (e) {
      var del = e.target.closest('.kit-ask-history-del');
      if (del) {
        // Same two-click "arm then confirm" idiom as every other destructive
        // control in the kit — no native confirm() dialog.
        if (!armConfirm(del, { armedLabel: '✕?' })) return;
        deleteConversationRow(del.getAttribute('data-id'));
        return;
      }
      var item = e.target.closest('.kit-ask-history-item');
      if (item) openConversation(item.getAttribute('data-id'));
    });

    /** On first open, resume a stored conversation whose transcript hasn't rendered yet (e.g. after a page reload). */
    function maybeAutoLoadStoredConversation() {
      if (autoLoadAttempted) return;
      autoLoadAttempted = true;
      var id = session.get();
      // "empty" == still just the intro bubble — a fresh page load, not a
      // conversation this panel has already rendered this session.
      if (!id || log.children.length > 1) return;
      fetchJson(conversationPath(appId() || '', id)).then(function (r) {
        if (!r.ok) {
          if (r.status === 404) session.clear(); // stale id — a fresh vault, a restart
          return;
        }
        renderTranscript(r.body && r.body.messages);
      });
    }

    var handler = null;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy) return; // a turn is already in flight — guard double-sends
      var uploaded = pending.filter(function (p) {
        return p.status === 'done';
      });
      var refs = uploaded.map(function (p) {
        return { hash: p.hash, mime: p.mime, filename: p.filename, sizeBytes: p.sizeBytes };
      });
      var v = input.value.trim() || (refs.length ? '(attachment)' : '');
      if (!v) return;
      api.user(v, refs.length ? refs : undefined);
      input.value = '';
      clearPending();
      // Fresh AbortController per turn — the Send/Stop button aborts this
      // signal, and the default driver threads it into fetch + consumeSse.
      // Passed as a 3rd arg so a custom `onAsk` handler can honor cancel too
      // (older handlers that ignore it keep working).
      activeAbort = new AbortController();
      if (handler) handler(v, refs.length ? refs : undefined, activeAbort.signal);
    });

    // Default brain: the app's _turn conversation agent. Registered after
    // `window.kitAsk` exists so an app.js `onAsk` call simply replaces it.
    if (!cfg.demo) handler = makeVaultDriver(api, session);

    if (cfg.demo) playDemo(api, cfg.demo);
    document.dispatchEvent(new CustomEvent('kitask:ready'));
  }

  // ---------- Default vault driver (real surfaces only, no stubs) ----------

  /** App id as pinned by the runtime's injected change bridge; null in bare previews. */
  function appId() {
    return (window.centraid && window.centraid.appId) || null;
  }

  /** Base for app-scoped routes. Absolute when the bridge pinned an app id. */
  function appBase() {
    var id = appId();
    return id ? '/centraid/' + encodeURIComponent(id) + '/' : '';
  }

  /** Base for this app's conversation-history sessions (issue #98/#190; distinct from `appBase()`'s `/centraid/<id>/` turn surface). Route single-sourced in conversation-client.js (#420). */
  function conversationsBase() {
    return conversationsPath(appId() || '');
  }

  /** This app's attachment blob CAS — `POST` uploads, returns `{hash, sizeBytes, mime, url}`. */
  function blobsBase() {
    return blobsPath(appId() || '');
  }

  function fetchJson(url, opts) {
    return fetch(url, opts).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try {
          j = t ? JSON.parse(t) : null;
        } catch (_) {}
        return { ok: r.ok, status: r.status, body: j };
      });
    });
  }

  /** Upload one File to the conversation blob CAS; resolves `{hash, sizeBytes, mime, url}`. */
  function uploadBlob(file) {
    return fetch(blobsBase(), {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try {
          j = t ? JSON.parse(t) : null;
        } catch (_) {}
        if (!r.ok) {
          throw new Error((j && (j.message || j.error)) || 'upload failed (' + r.status + ')');
        }
        return j;
      });
    });
  }

  /**
   * Reflect the app's REAL grant state in the context chip, read from the
   * vault plane's owner surface. On any failure the default design-contract
   * label stays — we never claim a state we couldn't verify.
   */
  function refreshGrantChip(chip) {
    if (!chip || !appId()) return;
    fetchJson(vaultStatusPath())
      .then(function (s) {
        // The status route answers { vaultId, name, ownerPartyId, fresh } —
        // there is no `active` field (a resolvable vault always 200s, an
        // unresolvable one errors before this shape). Keying on a truthy
        // vaultId is the real "connected" signal; the old `active === true`
        // check misreported "no vault connected" against a working vault.
        if (!s.ok || !s.body || !s.body.vaultId) {
          chip.textContent = 'no vault connected';
          return;
        }
        return fetchJson(vaultAppsPath()).then(function (a) {
          var apps = (a.ok && a.body && a.body.apps) || [];
          // `apps[].appId` is the internal consent_app UUID minted at
          // enrollment, not the manifest id `appId()` reads off the runtime
          // bridge — `name` is the field that carries the manifest id.
          var mine = apps.filter(function (x) {
            return x.name === appId();
          })[0];
          if (!mine) {
            chip.textContent = 'not enrolled — vault calls deny';
            return;
          }
          var grants = mine.grants || [];
          if (!grants.length) {
            chip.textContent = 'no grant yet — writes deny or park';
            return;
          }
          var verbs = {};
          grants.forEach(function (g) {
            (g.scopes || []).forEach(function (sc) {
              String(sc.verbs || '')
                .split(',')
                .forEach(function (v) {
                  if (v.trim()) verbs[v.trim()] = 1;
                });
            });
          });
          var list = Object.keys(verbs);
          chip.textContent = (list.length ? list.join(' + ') : 'granted') + ' · consent-gated';
        });
      })
      .catch(function () {
        /* unreachable plane — leave the default label */
      });
  }

  /**
   * Default conversation driver: POST the question to the app's `_turn`
   * agent and translate its SSE stream into panel bubbles. Writes the agent
   * makes flow through the dispatcher + vault consent gates like any other
   * caller; one that PARKS surfaces here as a proposed-write card whose
   * Approve/Discard post the owner's real decision to
   * `/centraid/_vault/parked/<invocationId>`. Nothing is fabricated: every
   * bubble is agent text, every card a real parked invocation, and every
   * failure is surfaced as the error it was.
   *
   * `_turn` keys a turn on a real conversation-history row and 404s on any
   * id it doesn't own (same contract the vault assistant's shell-level
   * `_turn` enforces) — so the panel provisions its session the same way the
   * desktop's own chat pane does, via the `/_centraid-conversations` create
   * route, rather than guessing an id client-side. `session` is the shared
   * per-panel conversation-id state (also driven by the History view).
   */
  function makeVaultDriver(api, session) {
    /**
     * The `_turn` route keys a turn on a real `conversations` row (the
     * conversation-history ledger, issue #286) and 404s on any id it doesn't
     * own — a client can't mint one client-side. Mint it the same way the
     * desktop's own chat pane does: `POST /_centraid-conversations/apps/<id>/sessions`.
     */
    function createConversation() {
      return fetchJson(conversationsBase(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }).then(function (r) {
        if (!r.ok || !r.body || !r.body.id) {
          throw new Error('could not start a conversation (' + r.status + ')');
        }
        session.set(r.body.id);
        return r.body.id;
      });
    }

    /** Forget the persisted id (a stale/unowned one — a fresh vault, a restart). */
    function forgetConversation() {
      session.clear();
    }

    /**
     * Resolve this panel's conversation id, reusing the persisted one when
     * present and minting a fresh session on first use otherwise. Returns a
     * promise — the id is never guessed client-side.
     */
    function ensureConversationId() {
      var stored = session.get();
      if (stored) return Promise.resolve(stored);
      return createConversation();
    }

    /**
     * Look up a freshly-parked invocation on the consent surface and render its
     * card. The lookup / describe / decision-post / outcome-normalize flow is
     * the shared one (consent-cards.js, #420); the card chrome is `api.propose`.
     */
    function renderParked(invocationId) {
      return fetchParkedEntry(invocationId, { fetchJson: fetchJson }).then(function (entry) {
        if (!entry) {
          api.ai(
            esc(
              'A write parked for your approval but is no longer pending — it may have been handled from another surface.',
            ),
          );
          return;
        }
        var d = describeParked(entry);
        api.propose({
          title: d.title,
          detail: d.detail,
          onApprove: function () {
            return confirmParkedShared(invocationId, true, { fetchJson: fetchJson }).then(
              normalizeApproveOutcome,
            );
          },
          onDiscard: function () {
            return confirmParkedShared(invocationId, false, { fetchJson: fetchJson });
          },
        });
      });
    }

    return function ask(text, attachments, signal) {
      // Busy spans the WHOLE turn (submit → terminal SSE event or stream
      // close) — NOT just until the first token, which is all `typing`
      // covers. Before this, `typing.done()` firing on the first
      // `assistant.delta` made the panel look idle while a tool call was
      // still running mid-turn; `api.setBusy` is the fix, and doubles as the
      // double-send guard (see the submit handler). `signal` cancels the turn.
      api.setBusy(true);
      var typing = api.typing();
      var stream = null; // the streaming assistant bubble element
      var streamText = ''; // accumulated raw answer text
      var finalized = false;
      // One idempotency key per user send (issue #420), REUSED on the 404
      // re-mint retry below so a duplicate turn replays instead of re-running.
      var idempotencyKey =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : 'k-' + Date.now() + '-' + Math.random().toString(16).slice(2);
      function say(t) {
        typing.done();
        return api.ai(esc(t));
      }
      function ensureStream() {
        typing.done();
        if (!stream) stream = api.ai('');
        return stream;
      }
      // While streaming, show plain text live; on `final` we upgrade to the
      // shared rich renderer (ref-chips + typed blocks), identical to the
      // React shell (#420).
      function append(delta) {
        streamText += delta;
        ensureStream().textContent = streamText;
      }
      function finalizeRich(fullText) {
        var full = fullText || streamText;
        if (!full) return;
        finalized = true;
        var host = ensureStream();
        host.innerHTML = richAnswerHtml(full);
        hydrateRefs(host);
        wireCodeCopy(host);
      }
      function handleEvent(ev) {
        switch (ev.type) {
          case 'assistant.delta':
            if (typeof ev.delta === 'string') append(ev.delta);
            return;
          case 'tool.result': {
            var o = outcomeOf(ev.result);
            if (o && o.status === 'parked' && o.invocationId) renderParked(o.invocationId);
            else if (o && o.status === 'denied') {
              say(
                'The vault denied that write' +
                  (o.reason ? ': ' + o.reason : '.') +
                  ' Grant this app access from Settings → Vault to allow it.',
              );
            }
            return;
          }
          case 'final':
            finalizeRich(ev.text);
            return;
          case 'notice':
            // Non-fatal system note (issue #420: "can't read PDFs"; #424:
            // context-reset). A muted note, matching the reload rendering.
            typing.done();
            api.notice(ev.message);
            return;
          case 'error':
            say('The agent hit an error: ' + (ev.message || 'unknown'));
            return;
          case 'aborted':
            say('The turn was aborted before it finished.');
            return;
          default:
            return;
        }
      }
      /**
       * Drive the turn against a resolved conversation id. A 404 means the
       * id this panel was holding onto isn't a session the store knows about
       * (a gateway restart against a fresh vault, journal recreated, …) — mint
       * a real one and retry exactly once rather than surfacing a session
       * error the owner can't act on. The SSE body is parsed by the shared
       * `consumeSse` (#420), which also honors `signal` for clean cancel.
       */
      function runTurn(id, isRetry) {
        var body = {
          conversationId: id,
          message: text,
          register: 'ask',
          idempotencyKey: idempotencyKey,
        };
        if (attachments && attachments.length) body.attachments = attachments;
        return fetch(appBase() + '_turn', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: signal,
        }).then(function (res) {
          if (!res.ok) {
            return res.text().then(function (t) {
              var j = null;
              try {
                j = t ? JSON.parse(t) : null;
              } catch (_) {}
              if (res.status === 404 && j && j.error === 'not_found' && !isRetry) {
                forgetConversation();
                return createConversation().then(function (freshId) {
                  return runTurn(freshId, true);
                });
              }
              if (res.status === 429) {
                // Turn backpressure (issue #420): the vault is busy. The React
                // shell auto-retries; the kit keeps it simple with a nudge.
                say('The vault is busy running other turns — try again in a moment.');
              } else if (res.status === 503 && j && j.error === 'no_conversation_runner') {
                say(
                  'No coding agent is configured to answer yet — open Settings → Agents, pick one, and ask again.',
                );
              } else {
                say(
                  'The gateway refused the turn (' +
                    res.status +
                    (j && j.message ? ' · ' + j.message : '') +
                    ').',
                );
              }
            });
          }
          return consumeSse(res.body, handleEvent, { signal: signal });
        });
      }
      ensureConversationId()
        .then(function (id) {
          return runTurn(id, false);
        })
        .catch(function (err) {
          // A user-initiated cancel surfaces as an AbortError — not a failure.
          if ((signal && signal.aborted) || (err && err.name === 'AbortError')) return;
          say("Couldn't reach the vault gateway — " + String((err && err.message) || err));
        })
        .then(function () {
          typing.done();
          // Stream ended with text but no `final` event (model stopped, or a
          // cancel mid-answer) — still upgrade the plain text to the rich render.
          if (!finalized && streamText) finalizeRich(streamText);
          api.setBusy(false);
        });
    };
  }

  // Preview-only sample turn so the flow is visible without a live vault.
  function playDemo(api, d) {
    api.open();
    if (d.applied) api.applied(d.applied);
    if (d.q) {
      api.user(d.q);
      var t = api.typing();
      setTimeout(function () {
        t.done();
        if (d.a) api.ai(d.a);
        if (d.propose) api.propose(d.propose);
        if (d.q2) {
          api.user(d.q2);
          api.typing();
        }
      }, 750);
    }
  }

  // Kick off once everything above is defined.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

// ============================================================================
// Cross-referencing (issues #272 + #282) — owner link writes + the reference
// strip. Referencing is a SHELL capability, not an app capability: the sole
// creation gesture is the inline `@`-mention (attachMentionPopover, below),
// which browses/searches the vault at owner trust (via the gateway's
// /_vault/picker surface, every read receipted); the user picks ONE row and
// the app receives only that row's card. The link is asserted with the
// owner-device credential (POST /_vault/links → core.link_entities,
// asserted_by='owner') — the pick is the consent, scoped to one row, so the
// app never needs read scopes on the foreign domain. Rendering the linked
// entity later rides ctx.vault.resolve's resolvable-if-linked rule.
// ============================================================================

// `entityKindLabel` (and its `PICK_KIND_LABELS` table) moved to elements.js,
// where the mention-chip and reference-strip components need it; it is imported
// and re-exported at the top of this file.

/**
 * Assert a link as the owner (the pick already carried the intent):
 * `from`/`to` are `{type, id}`; relation defaults to `references`. An
 * optional `selector` ({exact, prefix, suffix, start}, issue #282) writes an
 * inline standoff anchor atomically with the link.
 * Returns the vault's InvokeOutcome — `{status: 'executed', …}` on success.
 */
export async function createReference(from, to, relation, selector) {
  const r = await fetch('/centraid/_vault/links', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      from_type: from.type,
      from_id: from.id,
      to_type: to.type,
      to_id: to.id,
      relation: relation || 'references',
      ...(selector ? { selector } : {}),
    }),
  });
  return r.json();
}

/** End a link (temporal — the row survives with valid_to set). */
export async function removeReference(linkId) {
  const r = await fetch('/centraid/_vault/links/' + encodeURIComponent(linkId), {
    method: 'DELETE',
  });
  return r.json();
}

/**
 * Render the reference strip — the durable home of a note/doc's cross-refs
 * and the landing zone an inline anchor degrades to (issues #272 + #282).
 * This is the ONE canonical strip renderer: every consumer of references
 * (Notes now, Docs when it adopts) calls it so the strip, its card states,
 * and the anchored/orphaned distinction render identically everywhere.
 *
 * Presentation-only — it never writes. The app owns persistence: pass
 * `onRemove(ref)` to show a remove control (the app runs removeReference +
 * whatever refresh it needs); omit it for a read-only strip.
 *
 * Each `ref` is `{link_id, card, selector?}` where `card` is a resolver card
 * ({type, title, subtitle, status: live|trashed|missing|denied}). `selector`
 * present ⇒ the reference is anchored; pass `inlineIds` (a Set of link_ids
 * currently resolved inline in the body) and the tile flags itself "in text"
 * vs "in strip". Plain picker links (no selector) wear no flag.
 *
 * Options: {inlineIds?: Set<string>, onRemove?: (ref) => void, emptyText?: string}.
 *
 * The tile rendering lives in the `<kit-reference-strip>` custom element
 * (elements.js); this adapter mounts a single instance inside `stripEl` and
 * feeds it the props, so existing callers that pass their own container keep
 * working while the DOM/behaviour is owned by one component.
 */
export function renderReferenceStrip(stripEl, refs, options = {}) {
  const { inlineIds, onRemove, emptyText } = options;
  let strip = stripEl.firstElementChild;
  if (!strip || strip.tagName !== 'KIT-REFERENCE-STRIP') {
    stripEl.innerHTML = '';
    strip = document.createElement('kit-reference-strip');
    stripEl.appendChild(strip);
  }
  strip.refs = refs ?? [];
  strip.inlineIds = inlineIds ?? null;
  strip.onRemove = onRemove ?? null;
  strip.emptyText = emptyText ?? '';
}

/**
 * Move (selector object) or clear (selector null) the standoff anchor of a
 * live link — the re-anchor / re-baseline half of inline references (issue
 * #282). A locator write: the link judgment itself is untouched, so clearing
 * demotes the reference to strip-only.
 */
export async function reanchorReference(linkId, selector) {
  const r = await fetch('/centraid/_vault/links/' + encodeURIComponent(linkId), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ selector: selector ?? null }),
  });
  return r.json();
}

// ============================================================================
// Inline anchored references (issue #282) — the standoff-anchor half of
// cross-referencing. A reference stays a core.link edge; these helpers give
// it an inline presentation over a PLAIN text body: a W3C-style selector
// points into the words from outside, the read view resolves selectors to
// spans, and a broken selector degrades to the strip — never a wrong chip.
// Anchor resolution runs here in the kit (one implementation for every
// consumer) and is presentation-only: it never writes.
// ============================================================================

/** Context window captured either side of a mention (chars). */
const MENTION_CONTEXT = 24;

/**
 * Build the standoff selector for the words at [start, end) of `text`:
 * TextQuoteSelector (exact + surrounding context) belt, TextPositionSelector
 * (start, in UTF-16 code units) suspenders.
 */
export function computeMentionSelector(text, start, end) {
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - MENTION_CONTEXT), start),
    suffix: text.slice(end, end + MENTION_CONTEXT),
    start,
  };
}

// Deterministic normalization for the last resolution rung: collapse
// whitespace runs, fold smart quotes. Zero fuzzy risk — every normalized hit
// is still an exact hit modulo these two classes. The map carries normalized
// indices back to raw ones.
function normalizeWithMap(text) {
  let out = '';
  const map = [];
  let lastWasSpace = false;
  for (let i = 0; i < text.length; i += 1) {
    let ch = text[i];
    if (/\s/.test(ch)) {
      if (lastWasSpace) continue;
      out += ' ';
      map.push(i);
      lastWasSpace = true;
      continue;
    }
    lastWasSpace = false;
    if (ch === '‘' || ch === '’') ch = "'";
    else if (ch === '“' || ch === '”') ch = '"';
    out += ch;
    map.push(i);
  }
  return { text: out, map };
}

// How much of the stored context survives around an occurrence — matching
// outward from the boundary, so nearby identical quotes separate cleanly.
function contextScore(body, occStart, occEnd, sel) {
  const prefix = sel.prefix ?? '';
  const suffix = sel.suffix ?? '';
  let score = 0;
  for (let k = 1; k <= prefix.length; k += 1) {
    if (body[occStart - k] === prefix[prefix.length - k]) score += 1;
    else break;
  }
  for (let k = 0; k < suffix.length; k += 1) {
    if (body[occEnd + k] === suffix[k]) score += 1;
    else break;
  }
  return score;
}

function occurrencesOf(haystack, needle) {
  const out = [];
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    out.push(at);
    at = haystack.indexOf(needle, at + 1);
  }
  return out;
}

/**
 * Resolve standoff anchors to text spans — the global one-span-per-anchor
 * assignment (issue #282, Q2's layered ladder). `anchors` is a list of
 * `{link_id, selector: {exact, prefix, suffix, start}}`; the result maps
 * link_id → {start, end} in raw body offsets. An anchor that wins no span is
 * simply absent — an ORPHAN, rendered in the strip only.
 *
 * Ladder per anchor: exact occurrences (context-scored, nearest-to-stored-
 * position tiebreak; a position-verified match is just the perfect score) →
 * whitespace/smart-quote-normalized occurrences → orphan. NO fuzzy matching:
 * a wrong chip is a lie, a strip chip is honest. Arbitration is global —
 * each occurrence goes to at most one anchor and spans never overlap, so an
 * irreducibly ambiguous pair (same quote, same context) yields one inline
 * chip and one strip entry instead of a double render.
 */
export function assignAnchors(body, anchors) {
  const candidates = [];
  let norm = null;
  for (const anchor of anchors) {
    const sel = anchor.selector;
    if (!sel || typeof sel.exact !== 'string' || sel.exact.length === 0) continue;
    let spans = occurrencesOf(body, sel.exact).map((at) => ({
      start: at,
      end: at + sel.exact.length,
      normalized: 0,
    }));
    if (spans.length === 0) {
      norm = norm ?? normalizeWithMap(body);
      const needle = normalizeWithMap(sel.exact).text;
      if (needle.length > 0) {
        spans = occurrencesOf(norm.text, needle).map((at) => ({
          start: norm.map[at],
          end: norm.map[at + needle.length - 1] + 1,
          normalized: 1,
        }));
      }
    }
    for (const span of spans) {
      candidates.push({
        linkId: anchor.link_id,
        start: span.start,
        end: span.end,
        normalized: span.normalized,
        score: contextScore(body, span.start, span.end, sel),
        posDist: Math.abs(span.start - (Number.isFinite(sel.start) ? sel.start : 0)),
      });
    }
  }
  // Best claims first: exact before normalized, most context, nearest to the
  // stored position, then document order for full determinism.
  candidates.sort(
    (a, b) =>
      a.normalized - b.normalized ||
      b.score - a.score ||
      a.posDist - b.posDist ||
      a.start - b.start,
  );
  const assigned = new Map();
  const claimed = [];
  for (const c of candidates) {
    if (assigned.has(c.linkId)) continue;
    if (claimed.some(([s, e]) => c.start < e && s < c.end)) continue;
    assigned.set(c.linkId, { start: c.start, end: c.end });
    claimed.push([c.start, c.end]);
  }
  return assigned;
}

// Caret pixel position inside a textarea, via the classic mirror-div
// technique: clone the metrics that shape line wrapping, lay out the text up
// to `index`, and read where a marker span lands.
const MIRROR_STYLES = [
  'boxSizing',
  'width',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'lineHeight',
  'textTransform',
  'wordSpacing',
  'textIndent',
];

function caretRect(textarea, index) {
  const mirror = document.createElement('div');
  const style = getComputedStyle(textarea);
  for (const prop of MIRROR_STYLES) mirror.style[prop] = style[prop];
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  mirror.textContent = textarea.value.slice(0, index);
  const marker = document.createElement('span');
  marker.textContent = '​';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const top = marker.offsetTop;
  const left = marker.offsetLeft;
  const lineHeight = marker.offsetHeight || parseFloat(style.lineHeight) || 20;
  mirror.remove();
  const box = textarea.getBoundingClientRect();
  return {
    top: box.top + top - textarea.scrollTop,
    left: box.left + left - textarea.scrollLeft,
    height: lineHeight,
  };
}

/**
 * The inline `@`-mention gesture over a plain textarea (issue #282). Typing
 * `@` at a word boundary opens a caret-anchored popover of pickable entity
 * cards; typing filters it CLIENT-SIDE over one batch fetched when the
 * popover opened — one receipted owner read per gesture, never per
 * keystroke (the receipt stays legible as "the owner opened the picker").
 *
 * The kit only runs the gesture: on pick it calls `onPick(card, range)` with
 * `range = {start, end}` covering `@token` in the textarea's value, and the
 * APP inserts the plain words and asserts the (anchored) link — text stays
 * plain, the reference stays structural.
 *
 * Options: {kinds?: string[], exclude?: {type, id}, onPick(card, range)}.
 * Returns a detach() that removes every listener.
 */
export function attachMentionPopover(textarea, options = {}) {
  let pop = null;
  let cards = null; // the one batch fetched for this popover
  let fetchSeq = 0;
  let atIndex = -1;
  let selected = 0;

  function close() {
    if (pop) pop.remove();
    pop = null;
    cards = null;
    atIndex = -1;
    selected = 0;
    fetchSeq += 1; // orphan any in-flight fetch
  }

  function tokenAtCaret() {
    const caret = textarea.selectionStart;
    if (caret !== textarea.selectionEnd) return null;
    const upto = textarea.value.slice(0, caret);
    const at = upto.lastIndexOf('@');
    if (at === -1) return null;
    const before = at === 0 ? '' : upto[at - 1];
    if (before && !/[\s(]/.test(before)) return null;
    const token = upto.slice(at + 1);
    if (token.length > 40 || token.includes('\n')) return null;
    return { at, caret, token };
  }

  function filtered() {
    const gesture = tokenAtCaret();
    const term = (gesture?.token ?? '').trim().toLowerCase();
    const excluded = options.exclude
      ? (c) => c.type === options.exclude.type && c.id === options.exclude.id
      : () => false;
    return (cards ?? [])
      .filter((c) => !excluded(c))
      .filter((c) => {
        if (!term) return true;
        const hay = `${c.title ?? ''} ${c.subtitle ?? ''} ${entityKindLabel(c.type)}`.toLowerCase();
        return hay.includes(term);
      })
      .slice(0, 8);
  }

  function pick(card) {
    const gesture = tokenAtCaret();
    close();
    if (!gesture || !options.onPick) return;
    options.onPick(card, { start: gesture.at, end: gesture.caret });
  }

  function renderList() {
    if (!pop) return;
    const list = pop.firstChild;
    list.innerHTML = '';
    const visible = filtered();
    if (selected >= visible.length) selected = Math.max(0, visible.length - 1);
    if (cards && visible.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'kit-mention-empty';
      empty.textContent = 'Nothing in your vault matches that.';
      list.appendChild(empty);
      return;
    }
    visible.forEach((card, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'kit-mention-row';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', i === selected ? 'true' : 'false');
      const kind = document.createElement('span');
      kind.className = 'kit-mention-kind';
      kind.textContent = entityKindLabel(card.type);
      const title = document.createElement('span');
      title.className = 'kit-mention-title';
      title.textContent = card.title ?? `${entityKindLabel(card.type)} ${card.id.slice(-6)}`;
      row.append(kind, title);
      // pointerdown, not click: keep the textarea focused through the pick.
      row.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        pick(card);
      });
      list.appendChild(row);
    });
  }

  function place() {
    if (!pop || atIndex < 0) return;
    const rect = caretRect(textarea, atIndex);
    const width = Math.min(320, window.innerWidth - 16);
    pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    pop.style.top = `${Math.min(rect.top + rect.height + 4, window.innerHeight - 60)}px`;
    pop.style.width = `${width}px`;
  }

  async function open(gesture) {
    atIndex = gesture.at;
    selected = 0;
    if (!pop) {
      pop = document.createElement('div');
      pop.className = 'kit-mention-pop';
      pop.setAttribute('role', 'listbox');
      pop.setAttribute('aria-label', 'Mention an entity from your vault');
      const list = document.createElement('div');
      list.className = 'kit-mention-list';
      list.dataset.state = 'loading';
      pop.appendChild(list);
      const note = document.createElement('p');
      note.className = 'kit-mention-note';
      note.textContent = 'Picking links only the picked item — receipted.';
      pop.appendChild(note);
      document.body.appendChild(pop);
    }
    place();
    if (cards === null) {
      const mine = ++fetchSeq;
      const params = new URLSearchParams();
      params.set('limit', '25');
      if (options.kinds && options.kinds.length) params.set('kinds', options.kinds.join(','));
      let batch = [];
      try {
        const r = await fetch('/centraid/_vault/picker?' + params.toString());
        const body = r.ok ? await r.json() : null;
        batch = (body && body.cards) || [];
      } catch {
        batch = [];
      }
      if (mine !== fetchSeq || !pop) return; // closed while loading
      cards = batch;
      delete pop.firstChild.dataset.state;
    }
    renderList();
  }

  function onInput() {
    const gesture = tokenAtCaret();
    if (!gesture) {
      close();
      return;
    }
    if (pop && gesture.at === atIndex) renderList();
    else open(gesture);
  }

  function onKeydown(e) {
    if (!pop) return;
    const visible = filtered();
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      selected = (selected + delta + Math.max(1, visible.length)) % Math.max(1, visible.length);
      renderList();
    } else if ((e.key === 'Enter' || e.key === 'Tab') && visible.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      pick(visible[selected]);
    }
  }

  function onBlur() {
    // pointerdown picks already ran preventDefault, so a real blur means the
    // gesture is over — but a programmatic open (a button that inserts `@`
    // and re-focuses the textarea) blurs then immediately refocuses, so only
    // close if focus actually left the field.
    setTimeout(() => {
      if (document.activeElement !== textarea) close();
    }, 80);
  }

  textarea.addEventListener('input', onInput);
  // Capture phase: while the popover is open its Enter/Arrows must win over
  // the app's own editor keydown handlers (e.g. checklist continuation).
  textarea.addEventListener('keydown', onKeydown, true);
  textarea.addEventListener('blur', onBlur);
  textarea.addEventListener('click', onInput);
  return function detach() {
    close();
    textarea.removeEventListener('input', onInput);
    textarea.removeEventListener('keydown', onKeydown, true);
    textarea.removeEventListener('blur', onBlur);
    textarea.removeEventListener('click', onInput);
  };
}

// ---------- Inline-chip rendering (shared read-view helpers, issue #282) ----------
// A resolved standoff anchor renders the mentioned words as a chip showing the
// resolver's LIVE card title — rename the target and the chip follows, while
// the body bytes stay the plain words that were typed. These are the pieces a
// read view reuses; the app supplies its own block/markdown layout and calls
// appendWithChips for each rendered text chunk.

/** The live-card chip element for one resolved anchor span (see `<kit-mention-chip>`). */
export function mentionChip(ref) {
  const chip = document.createElement('kit-mention-chip');
  chip.card = ref.card ?? {};
  return chip;
}

/**
 * Resolve a body's anchored references to inline spans (issue #282). `refs` is
 * the app's live reference list (`{link_id, selector, card}`); returns
 * `[{start, end, link_id, card}]` for the anchors that currently resolve, via
 * the global one-span-per-anchor assignment. Pure presentation — no writes.
 */
export function resolveInlineSpans(body, refs) {
  const anchored = (refs ?? []).filter((r) => r.selector);
  if (anchored.length === 0) return [];
  const assigned = assignAnchors(String(body ?? ''), anchored);
  return anchored
    .filter((r) => assigned.has(r.link_id))
    .map((r) => ({ ...assigned.get(r.link_id), link_id: r.link_id, card: r.card }));
}

/** The set of link_ids currently resolved inline in `body` (strip flagging). */
export function inlineLinkIds(body, refs) {
  return new Set(resolveInlineSpans(body, refs).map((r) => r.link_id));
}

/**
 * Append one rendered chunk of body text to `el`, swapping any anchor span
 * that falls fully inside it for its chip. `absStart` is the chunk's offset
 * in the whole decoded body — the space assignAnchors speaks. `renderPlain(el,
 * seg)` renders the non-chip text (default: a text node; a markdown app passes
 * its inline renderer). A span straddling a chunk boundary renders as plain
 * text — the chip is presentation, degrading is free.
 */
export function appendWithChips(el, text, absStart, spans, renderPlain) {
  const plain = renderPlain || ((node, seg) => node.appendChild(document.createTextNode(seg)));
  const absEnd = absStart + text.length;
  const inside = (spans ?? [])
    .filter((r) => r.start >= absStart && r.end <= absEnd)
    .toSorted((a, b) => a.start - b.start);
  const literal = (seg) => {
    if (seg) plain(el, seg);
  };
  if (inside.length === 0) {
    literal(text);
    return;
  }
  let cursor = absStart;
  for (const r of inside) {
    literal(text.slice(cursor - absStart, r.start - absStart));
    el.appendChild(mentionChip(r));
    cursor = r.end;
  }
  literal(text.slice(cursor - absStart));
}

// ---------- The @-mention field (turnkey cross-references, issues #272/#282) ----------
// Bundles the whole "@ works" behaviour so ANY app's <textarea> gains inline
// cross-references in a few lines: the caret popover, the pick→insert→assert
// (re-anchor-don't-duplicate), and the 4b reconcile-on-save (re-baseline live
// selectors, temporal-retract orphans, reversible Undo). Presentation +
// gesture only — the app still owns the body bytes, persistence, and the
// reference list (which it reads from its own core.link + core.link_anchor
// query). Everything below is a projection of that list.
//
// options:
//   from        () => {type,id} | {type,id} | null   — the entity mentions attach to
//   references  () => Array<{link_id, selector, card}> (live, mutated in place)
//   onChange    () => void                            — re-render strip/read-view after a mutation
//   relation    string = 'references'
//   kinds       string[]?                             — restrict the picker
//   onError     (outcome) => void?                    — vault refusal (default: a toast)
// returns { detach(), reconcile(body): Promise, startMention() }.
export function attachMentionField(textarea, options = {}) {
  const relation = options.relation || 'references';
  const getFrom = () =>
    (typeof options.from === 'function' ? options.from() : options.from) || null;
  const getRefs = () => {
    const r = typeof options.references === 'function' ? options.references() : options.references;
    return r || [];
  };
  const changed = () => options.onChange && options.onChange();
  const fail = (outcome, label) => {
    if (options.onError) options.onError(outcome);
    else toast(`Couldn’t link ${label}.`);
  };

  async function onPick(card, range) {
    const from = getFrom();
    if (!from) return;
    if (card.type === from.type && card.id === from.id) {
      toast('You can’t reference this record from itself.');
      return;
    }
    const refs = getRefs();
    const anchored = refs.filter((r) => r.selector);
    // Re-anchor, don't duplicate: an edge to this entity whose words were
    // edited away (orphaned BEFORE this insertion) takes the new selector
    // instead of minting a second judgment.
    const preAssigned = assignAnchors(textarea.value, anchored);
    const orphan = refs.find(
      (r) =>
        r.selector &&
        !preAssigned.has(r.link_id) &&
        r.card?.type === card.type &&
        r.card?.id === card.id,
    );
    const label = card.title ?? entityKindLabel(card.type);
    textarea.setRangeText(label, range.start, range.end, 'end');
    textarea.focus();
    // One synthetic input event lets the app's own handler sync its draft and
    // schedule its save — no duplicated bookkeeping here.
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    const selector = computeMentionSelector(
      textarea.value,
      range.start,
      range.start + label.length,
    );
    const outcome = orphan
      ? await reanchorReference(orphan.link_id, selector)
      : await createReference(from, card, relation, selector);
    if (outcome?.status !== 'executed') {
      fail(outcome, label);
      return;
    }
    if (orphan) orphan.selector = selector;
    else refs.push({ link_id: outcome.output?.link_id, selector, card });
    toast(`${orphan ? 'Re-linked' : 'Linked'} ${label}.`);
    changed();
  }

  const detachPopover = attachMentionPopover(textarea, {
    ...(options.kinds ? { kinds: options.kinds } : {}),
    onPick,
  });

  // Reconcile runs when a save lands (the app's debounce is the "settled"
  // signal). Serialized so two quick saves can't race the same edge. The
  // subject is captured at call time (opts.from / opts.references) so a
  // navigation during the async window can't retarget it at the wrong record.
  let chain = Promise.resolve();
  function reconcile(body, opts = {}) {
    const from = opts.from ?? getFrom();
    const refs = opts.references ?? getRefs();
    chain = chain.then(() => doReconcile(body, from, refs)).catch(() => {});
    return chain;
  }
  async function doReconcile(body, from, refs) {
    const anchored = refs.filter((r) => r.selector);
    if (anchored.length === 0) return;
    const assigned = assignAnchors(body, anchored);
    const orphans = [];
    for (const ref of anchored) {
      const span = assigned.get(ref.link_id);
      if (!span) {
        orphans.push(ref);
        continue;
      }
      // Re-baseline: keep the stored selector current with the saved body so
      // drift never accumulates and resolution needs no fuzzy rung.
      const fresh = computeMentionSelector(body, span.start, span.end);
      const cur = ref.selector;
      if (
        cur.exact !== fresh.exact ||
        cur.prefix !== fresh.prefix ||
        cur.suffix !== fresh.suffix ||
        cur.start !== fresh.start
      ) {
        const outcome = await reanchorReference(ref.link_id, fresh);
        if (outcome?.status === 'executed') ref.selector = fresh;
      }
    }
    if (orphans.length === 0) return;
    const retracted = [];
    for (const ref of orphans) {
      const outcome = await removeReference(ref.link_id);
      if (outcome?.status === 'executed') retracted.push(ref);
    }
    if (retracted.length === 0) return;
    for (const ref of retracted) {
      const i = refs.indexOf(ref);
      if (i >= 0) refs.splice(i, 1);
    }
    changed();
    const names = retracted.map((r) => r.card?.title ?? entityKindLabel(r.card?.type)).join(', ');
    toast(
      retracted.length === 1
        ? `Unlinked ${names} — its mention left the text.`
        : `Unlinked ${retracted.length} references whose mentions left the text.`,
      {
        undoLabel: 'Undo',
        // Undo re-asserts a FRESH, anchorless edge (history is never rewritten;
        // an anchorless link lives in the strip, exempt from re-retraction —
        // so it can't oscillate against the still-missing words).
        onUndo: async () => {
          if (!from) return;
          for (const ref of retracted) {
            const outcome = await createReference(from, ref.card, relation);
            if (outcome?.status === 'executed') {
              refs.push({ link_id: outcome.output?.link_id, selector: null, card: ref.card });
            }
          }
          changed();
        },
      },
    );
  }

  // Drop an `@` at the caret and open the popover (a discoverability shim for
  // a button). The app makes the textarea visible/editable first.
  function startMention() {
    textarea.focus();
    const pos = textarea.selectionStart ?? textarea.value.length;
    const prev = pos > 0 ? textarea.value[pos - 1] : '';
    textarea.setRangeText(prev && !/[\s(]/.test(prev) ? ' @' : '@', pos, pos, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  return { detach: detachPopover, reconcile, startMention };
}
