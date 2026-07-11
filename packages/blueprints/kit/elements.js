// governance: allow-repo-hygiene file-size-limit the ported kit primitives are one
// cohesive custom-element set that every app loads verbatim alongside kit.js;
// splitting it would fracture the single-import contract the kit is built on
// Centraid blueprint kit — native Web Components (issue #327; de-Lit pass).
//
// The kit's presentation primitives, ported from the hand-rolled vanilla DOM
// builders (former `kit.js`) to plain `customElements.define()` classes. These
// load with NO build step and NO runtime dependency: `kit.js` does
// `import './elements.js'`, and that's the whole of it — no vendored template
// library underneath. Real custom elements is what lets claude.ai/design
// ingest them directly, dropping the React-wrapper duplication the old
// design-sync needed (see .design-sync/NOTES.md).
//
// STYLING CONTRACT (issue #327, Phase 3). Every element renders in the LIGHT
// DOM (`this` IS the render root — no shadow root is ever attached) and emits
// the SAME `.kit-*` markup the vanilla builders produced, so `kit.css` styles
// it identically and each app's CSS custom properties cascade in unchanged.
// The custom-element host itself is `display: contents` (see kit.css), so it
// adds no box of its own — the rendered tree, and therefore the layout, is
// byte-for-byte what the old builders appended. This is why no Shadow DOM /
// adopted-stylesheet / bridge rework was needed: the components stay plain,
// diffable, editable files.
//
// REACTIVITY CONTRACT (former Lit `static properties`, now vanilla). Each
// element still declares `static properties = { name: {type, attribute?} }` —
// the *shape* callers already depend on — but `KitElement` below reads that
// manifest itself and installs plain accessor properties + attribute
// observation with `Object.defineProperty`/`attributeChangedCallback`. Setting
// a JS property (`el.name = 'x'`, what every `kit.js` factory does) or an HTML
// attribute (what React does for a custom-element prop it does NOT find `in`
// the instance, falling back to attribute reflection) both trigger a
// synchronous re-render once the element is connected. There is no
// microtask-batched update queue here — these are small, cheap components, and
// synchronous keeps the base legible without an update scheduler.
//
// kit.js keeps thin factory functions (`letterAvatar`, `lineChart`, `toast`, …)
// that construct + configure these elements, so existing app code that calls
// them is unchanged.

/** Human labels for the entity kinds the picker / references surface. */
export const PICK_KIND_LABELS = {
  'core.party': 'Person',
  'core.place': 'Place',
  'core.event': 'Event',
  'core.transaction': 'Transaction',
  'core.content_item': 'File',
  'schedule.task': 'Task',
  'knowledge.note': 'Note',
  'core.collection': 'Collection',
  'social.thread': 'Thread',
  'media.media_asset': 'Photo',
  'home.asset_item': 'Belonging',
  'business.client': 'Client',
  'business.project': 'Project',
  'business.invoice': 'Invoice',
};

/** Human label for an entity kind — falls back to the table name. */
export function entityKindLabel(type) {
  if (PICK_KIND_LABELS[type]) return PICK_KIND_LABELS[type];
  const table = String(type).split('.')[1] ?? String(type);
  return table.replace(/_/g, ' ');
}

// ---------- Reactive-property plumbing (the vanilla stand-in for Lit) ----------

/** Classes whose `static properties` accessors have already been installed. */
const propertiesInstalled = new WeakSet();

/**
 * The HTML attribute name for a declared property, or `null` if it's
 * JS-property-only (`attribute: false` — used for the non-primitive props,
 * `.card`, `.refs`, `.onRemove`, …, that only ever travel as JS values).
 * Mirrors Lit's default converter: an explicit `attribute: 'kebab-name'`
 * string wins, otherwise it's the property name lowercased verbatim (NOT
 * kebab-cased) — which is exactly why multi-word props that DO want an
 * attribute (`undoLabel`, `emptyText`) spell one out below.
 */
function attributeNameFor(propName, cfg) {
  if (cfg?.attribute === false) return null;
  if (typeof cfg?.attribute === 'string') return cfg.attribute;
  return propName.toLowerCase();
}

/** Converts a raw attribute string to a property's declared `type`. */
function convertFromAttribute(type, raw) {
  if (raw == null) return type === Boolean ? false : null;
  if (type === Number) return Number(raw);
  if (type === Boolean) return true; // presence-based — Lit's Boolean contract
  if (type === Array || type === Object) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw; // String (default)
}

/** Defines a reactive get/set accessor for one declared property on a prototype. */
function installProperty(proto, name) {
  const store = Symbol(name);
  Object.defineProperty(proto, name, {
    configurable: true,
    enumerable: true,
    get() {
      return this[store];
    },
    set(value) {
      this[store] = value;
      this.requestUpdate();
    },
  });
}

/**
 * Installs every accessor a class's `static properties` declares, once per
 * class (subclasses of subclasses — none here, but harmless — get their own
 * pass keyed off their own constructor).
 */
function ensurePropertiesInstalled(ctor) {
  if (propertiesInstalled.has(ctor)) return;
  propertiesInstalled.add(ctor);
  for (const name of Object.keys(ctor.properties ?? {})) {
    installProperty(ctor.prototype, name);
  }
}

/**
 * Shared base: light-DOM rendering (so `kit.css` + app CSS vars apply to the
 * emitted `.kit-*` markup, and there's no shadow root at all) with a
 * `display: contents` host (so the element adds no layout box — the rendered
 * tree lays out exactly as the old builder's did).
 *
 * Exported for the apps: app-level components extend this and inherit the
 * whole styling + reactivity contract. The host stamps `data-kit-host` on
 * connect, which is what `kit.css` keys the `display: contents` rule on — app
 * elements need no per-tag CSS registration. A component that wants its host
 * to BE a layout box overrides with a compound selector in its own app.css
 * (e.g. `x-foo[data-kit-host] { display: block; }`).
 *
 * Subclasses declare `static properties = { foo: { type: String } }` (same
 * shape Lit used) and implement `render()`, returning a Node, an array of
 * Nodes, or `null` — whatever should become this element's children. Setting
 * a declared property, or (for attribute-backed properties) the matching HTML
 * attribute, re-renders synchronously once the element is connected.
 */
export class KitElement extends HTMLElement {
  static properties = {};

  static get observedAttributes() {
    return Object.entries(this.properties ?? {})
      .map(([name, cfg]) => attributeNameFor(name, cfg))
      .filter((attr) => attr !== null);
  }

  constructor() {
    super();
    ensurePropertiesInstalled(new.target);
  }

  connectedCallback() {
    this.setAttribute('data-kit-host', '');
    this.requestUpdate();
  }

  attributeChangedCallback(attrName, oldValue, newValue) {
    if (oldValue === newValue) return;
    const entry = Object.entries(this.constructor.properties ?? {}).find(
      ([name, cfg]) => attributeNameFor(name, cfg) === attrName,
    );
    if (!entry) return;
    const [name, cfg] = entry;
    this[name] = convertFromAttribute(cfg.type, newValue);
  }

  /** Re-renders now if connected; a no-op otherwise (connect will render). */
  requestUpdate() {
    if (!this.isConnected) return;
    const result = this.render();
    const nodes = result == null ? [] : Array.isArray(result) ? result : [result];
    this.replaceChildren(...nodes);
  }
}

// ---------- Letter / photo avatar ----------

/** Deterministic hue from a name so the same person is always the same color. */
function avatarHue(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return ((hash % 360) + 360) % 360;
}

function avatarInitials(name) {
  const parts = name.split(/\s+/);
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}

/**
 * `<kit-avatar name size shape src color initials>` — a letter (or photo)
 * avatar. The fill defaults to a stable hashed hue; `color` pins an explicit
 * one (a persisted per-contact colour, a server-assigned palette slot).
 * `initials` pins the letters when the caller knows better than the name
 * split ("You"). Type scales with `size` so one element serves 28px list
 * rows and 58px cards alike.
 */
export class KitAvatar extends KitElement {
  static properties = {
    name: { type: String },
    size: { type: String },
    shape: { type: String },
    src: { type: String },
    color: { type: String },
    initials: { type: String },
  };

  constructor() {
    super();
    this.name = '';
    this.size = '2.25rem';
    this.shape = '';
    this.src = '';
    this.color = '';
    this.initials = '';
  }

  render() {
    const text = String(this.name ?? '?').trim() || '?';
    const fill = this.color || `hsl(${avatarHue(text)} 45% 42%)`;
    const style = `width:${this.size};height:${this.size};font-size:calc(${this.size} * 0.36);background:${fill}`;
    const span = document.createElement('span');
    span.className = 'kit-avatar';
    span.setAttribute('style', style);
    span.setAttribute('aria-hidden', 'true');
    if (this.shape) span.setAttribute('data-shape', this.shape);
    if (this.src) {
      const img = document.createElement('img');
      img.src = this.src;
      img.alt = '';
      span.appendChild(img);
    } else {
      span.textContent = this.initials || avatarInitials(text);
    }
    return span;
  }
}
customElements.define('kit-avatar', KitAvatar);

// ---------- Proportion bar / meter ----------

/**
 * `<kit-meter ratio tone>` — a slim proportion bar (former `barSpan()`).
 * `ratio` is 0–1 (clamped); `tone` is `warn` | `danger` | `ok`.
 */
export class KitMeter extends KitElement {
  static properties = {
    ratio: { type: Number },
    tone: { type: String },
  };

  constructor() {
    super();
    this.ratio = 0;
    this.tone = '';
  }

  render() {
    const pct = Math.max(0, Math.min(1, Number(this.ratio) || 0)) * 100;
    const bar = document.createElement('span');
    bar.className = 'kit-bar';
    bar.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('span');
    fill.className = 'kit-bar-fill';
    fill.setAttribute('style', `width:${pct}%`);
    if (this.tone) fill.setAttribute('data-tone', this.tone);
    bar.appendChild(fill);
    return bar;
  }
}
customElements.define('kit-meter', KitMeter);

// ---------- Charts (line / area / bar) — hand-rolled SVG, themed by kit.css ----------

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Creates one namespaced SVG element with attributes (falsy ⇒ omitted). */
function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    node.setAttribute(key, String(value));
  }
  return node;
}

/**
 * `<kit-line-chart .points width height label>` — a time-aware trend line with
 * a soft area fill and an emphasized last point (former `lineChart()`).
 * `points` is `[{x: epochMs, y: number}]`.
 */
export class KitLineChart extends KitElement {
  static properties = {
    points: { type: Array },
    width: { type: Number },
    height: { type: Number },
    label: { type: String },
  };

  constructor() {
    super();
    this.points = [];
    this.width = 640;
    this.height = 160;
    this.label = 'Trend';
  }

  render() {
    const { width, height } = this;
    const points = this.points ?? [];
    const svg = svgEl('svg', {
      viewBox: `0 0 ${width} ${height}`,
      class: 'kit-chart',
      role: 'img',
      'aria-label': this.label,
    });
    if (points.length < 2) return svg;
    const pad = 8;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys);
    const sx = (x) => pad + ((x - x0) / (x1 - x0 || 1)) * (width - pad * 2);
    const sy = (y) => height - pad - ((y - y0) / (y1 - y0 || 1)) * (height - pad * 2);
    const d = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`)
      .join(' ');
    const area = `${d} L${sx(x1).toFixed(1)},${height - pad} L${sx(x0).toFixed(1)},${height - pad} Z`;
    const last = points[points.length - 1];
    svg.appendChild(svgEl('path', { d: area, class: 'kit-chart-area' }));
    svg.appendChild(svgEl('path', { d, class: 'kit-chart-line' }));
    svg.appendChild(svgEl('circle', { cx: sx(last.x), cy: sy(last.y), r: 3, class: 'kit-chart-dot' }));
    return svg;
  }
}
customElements.define('kit-line-chart', KitLineChart);

/**
 * `<kit-bar-chart .items width height label>` — vertical bars with tick labels
 * (former `barChart()`). `items` is `[{label, value, muted?}]`.
 */
export class KitBarChart extends KitElement {
  static properties = {
    items: { type: Array },
    width: { type: Number },
    height: { type: Number },
    label: { type: String },
  };

  constructor() {
    super();
    this.items = [];
    this.width = 640;
    this.height = 160;
    this.label = 'Totals';
  }

  render() {
    const { width, height } = this;
    const items = this.items ?? [];
    const pad = 8;
    const labelBand = 16;
    const max = Math.max(...items.map((i) => i.value), 1);
    const band = items.length ? (width - pad * 2) / items.length : 0;
    const svg = svgEl('svg', {
      viewBox: `0 0 ${width} ${height}`,
      class: 'kit-chart',
      role: 'img',
      'aria-label': this.label,
    });
    items.forEach((item, i) => {
      const h = ((height - pad * 2 - labelBand) * item.value) / max;
      const rect = svgEl('rect', {
        x: pad + i * band + band * 0.15,
        y: height - pad - labelBand - h,
        width: band * 0.7,
        height: Math.max(h, 1),
        rx: 2,
        class: 'kit-chart-barrect',
      });
      if (item.muted) rect.setAttribute('data-muted', 'true');
      svg.appendChild(rect);
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
}
customElements.define('kit-bar-chart', KitBarChart);

// ---------- Loading skeleton ----------

/**
 * `<kit-skeleton rows variant width>` — shimmer placeholder rows shown while a
 * first read is in flight (former `showSkeleton()` primitive). `variant` is
 * `line` | `title` | `row` | `circle`.
 */
export class KitSkeleton extends KitElement {
  static properties = {
    rows: { type: Number },
    variant: { type: String },
    width: { type: String },
  };

  constructor() {
    super();
    this.rows = 3;
    this.variant = '';
    this.width = '';
  }

  render() {
    const cls = this.variant ? `kit-skeleton kit-skeleton-${this.variant}` : 'kit-skeleton';
    const count = Math.max(0, Number(this.rows) || 0);
    return Array.from({ length: count }, () => {
      const row = document.createElement('div');
      row.className = cls;
      if (this.width) row.setAttribute('style', `width:${this.width}`);
      return row;
    });
  }
}
customElements.define('kit-skeleton', KitSkeleton);

// ---------- Toast ----------

/**
 * `<kit-toast text tone undo-label>` — a single outcome toast bubble. In the app
 * the `toast()` helper (kit.js) hosts these in the fixed `.kit-toasts` stack and
 * wires timing; the element renders the bubble and fires `kit-undo` / `kit-dismiss`.
 */
export class KitToast extends KitElement {
  static properties = {
    text: { type: String },
    tone: { type: String },
    undoLabel: { type: String, attribute: 'undo-label' },
  };

  constructor() {
    super();
    this.text = '';
    this.tone = '';
    this.undoLabel = '';
  }

  render() {
    const div = document.createElement('div');
    div.className = 'kit-toast';
    if (this.tone) div.setAttribute('data-tone', this.tone);

    const span = document.createElement('span');
    span.textContent = this.text;
    div.appendChild(span);

    if (this.undoLabel) {
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'kit-toast-action';
      action.textContent = this.undoLabel;
      action.addEventListener('click', () => this.dispatchEvent(new CustomEvent('kit-undo')));
      div.appendChild(action);
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'kit-toast-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.addEventListener('click', () => this.dispatchEvent(new CustomEvent('kit-dismiss')));
    div.appendChild(close);

    return div;
  }
}
customElements.define('kit-toast', KitToast);

// ---------- Inline @-mention chip ----------

/**
 * `<kit-mention-chip .card>` — the live-card chip for one resolved anchor span
 * (former `mentionChip()`). `card` is `{type, title, status}`.
 */
export class KitMentionChip extends KitElement {
  static properties = {
    card: { type: Object, attribute: false },
  };

  constructor() {
    super();
    this.card = {};
  }

  render() {
    const card = this.card ?? {};
    const gone = card.status === 'missing' || card.status === 'trashed';
    const label =
      card.status === 'missing'
        ? 'removed from the vault'
        : (card.title ?? entityKindLabel(card.type));
    const span = document.createElement('span');
    span.className = gone ? 'kit-mention-chip ref-gone' : 'kit-mention-chip';
    span.title = `${entityKindLabel(card.type)} — linked reference`;
    span.textContent = label;
    return span;
  }
}
customElements.define('kit-mention-chip', KitMentionChip);

// ---------- Reference strip ----------

/**
 * `<kit-reference-strip .refs .inlineIds .onRemove empty-text>` — the canonical
 * cross-reference strip (former `renderReferenceStrip()`). Presentation only:
 * it never writes. `refs` is `[{link_id, card, selector?}]`; `inlineIds` is a
 * Set/array of link_ids resolved inline (flips a tile's flag to "in text");
 * `onRemove(ref)` (when set) shows a remove control.
 */
export class KitReferenceStrip extends KitElement {
  static properties = {
    refs: { type: Array },
    inlineIds: { attribute: false },
    onRemove: { attribute: false },
    emptyText: { type: String, attribute: 'empty-text' },
  };

  constructor() {
    super();
    this.refs = [];
    this.inlineIds = null;
    this.onRemove = null;
    this.emptyText = '';
  }

  #hasInline(linkId) {
    const ids = this.inlineIds;
    if (!ids) return false;
    return typeof ids.has === 'function' ? ids.has(linkId) : Array.from(ids).includes(linkId);
  }

  render() {
    const list = this.refs ?? [];
    const wrap = document.createElement('div');
    wrap.className = 'kit-ref-strip';
    if (list.length === 0) {
      if (this.emptyText) {
        const empty = document.createElement('p');
        empty.className = 'kit-ref-empty';
        empty.textContent = this.emptyText;
        wrap.appendChild(empty);
      }
      return wrap;
    }
    for (const ref of list) wrap.appendChild(this.#tile(ref));
    return wrap;
  }

  #tile(ref) {
    const card = ref.card ?? {};
    const gone = card.status === 'missing' || card.status === 'denied' || card.status === 'trashed';
    let title;
    if (card.status === 'missing') title = 'removed from the vault';
    else if (card.status === 'denied') title = 'access not granted';
    else {
      title = card.title ?? entityKindLabel(card.type);
      if (card.status === 'trashed') title += ' (in trash)';
    }
    const inline = this.#hasInline(ref.link_id);

    const tile = document.createElement('div');
    tile.className = gone ? 'kit-ref-tile is-gone' : 'kit-ref-tile';

    const kind = document.createElement('span');
    kind.className = 'kit-ref-kind';
    kind.textContent = entityKindLabel(card.type);
    tile.appendChild(kind);

    if (ref.selector) {
      const flag = document.createElement('span');
      flag.className = inline ? 'kit-ref-flag is-inline' : 'kit-ref-flag';
      flag.title = inline
        ? 'Shown inline in the text above'
        : "This reference's words are no longer in the text";
      flag.textContent = inline ? 'in text' : 'in strip';
      tile.appendChild(flag);
    }

    const titleSpan = document.createElement('span');
    titleSpan.className = 'kit-ref-title';
    titleSpan.textContent = title;
    tile.appendChild(titleSpan);

    if (card.subtitle && card.status === 'live') {
      const sub = document.createElement('span');
      sub.className = 'kit-ref-sub';
      sub.textContent = card.subtitle;
      tile.appendChild(sub);
    }

    if (this.onRemove) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'kit-ref-remove';
      remove.title = 'Remove reference';
      remove.setAttribute('aria-label', `Remove reference to ${title}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => this.onRemove(ref));
      tile.appendChild(remove);
    }

    return tile;
  }
}
customElements.define('kit-reference-strip', KitReferenceStrip);
