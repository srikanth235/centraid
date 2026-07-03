// Centraid blueprint kit — the shared UX substrate for template apps.
//
// Canonical copy: packages/blueprints/kit/kit.js. Each template carries its
// own copy next to index.html (same convention as wall.css) so apps stay
// standalone; run `node scripts/sync-kit.mjs` after editing this file.
//
// Everything here is presentation plumbing the 14 apps used to hand-roll
// with drift: outcome toasts, loading/error states, confirm-to-act, money
// and local-date formatting, letter avatars, and small SVG charts. App
// logic stays in each app.js.

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
  const el = document.createElement('div');
  el.className = 'kit-toast';
  const span = document.createElement('span');
  span.textContent = text;
  el.appendChild(span);
  let timer = 0;
  const dismiss = () => {
    clearTimeout(timer);
    el.remove();
  };
  if (undoLabel && onUndo) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'kit-toast-action';
    btn.textContent = undoLabel;
    btn.addEventListener('click', () => {
      dismiss();
      onUndo();
    });
    el.appendChild(btn);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'kit-toast-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Dismiss');
  close.addEventListener('click', dismiss);
  el.appendChild(close);
  host.appendChild(el);
  if (duration > 0) timer = setTimeout(dismiss, duration);
  return dismiss;
}

/** The shared translation of a typed-command outcome into a human sentence. */
export function outcomeMessage(outcome) {
  if (outcome?.status === 'parked') {
    return 'Waiting for your approval — it lands once you confirm it in vault settings.';
  }
  if (outcome?.status === 'failed') {
    return `The vault refused: ${outcome.predicate ?? outcome.reason ?? 'a precondition failed'}.`;
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
  for (let i = 0; i < rows; i += 1) {
    const row = document.createElement('div');
    row.className = 'kit-skeleton';
    container.appendChild(row);
  }
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

// ---------- Letter avatars ----------

/** Deterministic hue from a name so the same person is always the same color. */
export function letterAvatar(name, { size = '2.25rem' } = {}) {
  const text = String(name ?? '?').trim() || '?';
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  const hue = ((hash % 360) + 360) % 360;
  const el = document.createElement('span');
  el.className = 'kit-avatar';
  el.style.width = size;
  el.style.height = size;
  el.style.background = `hsl(${hue} 45% 42%)`;
  el.setAttribute('aria-hidden', 'true');
  const parts = text.split(/\s+/);
  el.textContent = (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
  return el;
}

// ---------- SVG chart primitives (no libraries — hand-rolled, themed) ----------

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/**
 * A time-aware line chart: points are {x: epochMs, y: number}. Renders a
 * line, soft area fill, an emphasized last point, and min/max y labels.
 */
export function lineChart(points, { width = 640, height = 160, label = 'Trend' } = {}) {
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'kit-chart',
    role: 'img',
    'aria-label': label,
  });
  if (points.length < 2) return svg;
  const pad = 8;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const sx = (x) => pad + ((x - x0) / (x1 - x0 || 1)) * (width - pad * 2);
  const sy = (y) => height - pad - ((y - y0) / (y1 - y0 || 1)) * (height - pad * 2);
  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`)
    .join(' ');
  svg.appendChild(
    svgEl('path', {
      d: `${d} L${sx(x1).toFixed(1)},${height - pad} L${sx(x0).toFixed(1)},${height - pad} Z`,
      class: 'kit-chart-area',
    }),
  );
  svg.appendChild(svgEl('path', { d, class: 'kit-chart-line' }));
  const last = points[points.length - 1];
  svg.appendChild(
    svgEl('circle', { cx: sx(last.x), cy: sy(last.y), r: 3, class: 'kit-chart-dot' }),
  );
  return svg;
}

/** Horizontal proportion bar (e.g. cost share behind a row's amount). */
export function barSpan(ratio) {
  const el = document.createElement('span');
  el.className = 'kit-bar';
  const fill = document.createElement('span');
  fill.className = 'kit-bar-fill';
  fill.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  el.appendChild(fill);
  el.setAttribute('aria-hidden', 'true');
  return el;
}

/** Vertical bar chart for period totals: items are {label, value}. */
export function barChart(items, { width = 640, height = 160, label = 'Totals' } = {}) {
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'kit-chart',
    role: 'img',
    'aria-label': label,
  });
  if (items.length === 0) return svg;
  const pad = 8;
  const labelBand = 16;
  const max = Math.max(...items.map((i) => i.value), 1);
  const band = (width - pad * 2) / items.length;
  items.forEach((item, i) => {
    const h = ((height - pad * 2 - labelBand) * item.value) / max;
    svg.appendChild(
      svgEl('rect', {
        x: pad + i * band + band * 0.15,
        y: height - pad - labelBand - h,
        width: band * 0.7,
        height: Math.max(h, 1),
        rx: 2,
        class: 'kit-chart-barrect',
      }),
    );
    const text = svgEl('text', {
      x: pad + i * band + band / 2,
      y: height - pad,
      class: 'kit-chart-ticklabel',
      'text-anchor': 'middle',
    });
    text.textContent = item.label;
    svg.appendChild(text);
  });
  return svg;
}
