// governance: allow-repo-hygiene file-size-limit the ported kit primitives are one
// cohesive Lit component set that every app loads verbatim alongside kit.js;
// splitting it would fracture the single-import contract the kit is built on
// Centraid blueprint kit — native Web Components (issue #327).
//
// The kit's presentation primitives, ported from the hand-rolled vanilla DOM
// builders (former `kit.js`) to Lit-based custom elements. These load with NO
// build step: `kit.js` does `import './elements.js'`, which imports the
// vendored runtime-only Lit bundle (`./lit-core.min.js`). Defining the elements
// here — real `customElements.define()` calls — is what lets claude.ai/design
// ingest them directly, dropping the React-wrapper duplication the old
// design-sync needed (see .design-sync/NOTES.md).
//
// STYLING CONTRACT (issue #327, Phase 3). Every element renders in the LIGHT
// DOM (`createRenderRoot() { return this; }`) and emits the SAME `.kit-*`
// markup the vanilla builders produced, so `kit.css` styles it identically and
// each app's CSS custom properties cascade in unchanged. The custom-element
// host itself is `display: contents` (see kit.css), so it adds no box of its
// own — the rendered tree, and therefore the layout, is byte-for-byte what the
// old builders appended. This is why no Shadow DOM / adopted-stylesheet /
// bridge rework was needed: the components stay plain, diffable, editable files.
//
// kit.js keeps thin factory functions (`letterAvatar`, `lineChart`, `toast`, …)
// that construct + configure these elements, so existing app code that calls
// them is unchanged.
import { LitElement, html, svg, nothing } from './lit-core.min.js';

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

/**
 * Shared base: light-DOM rendering (so `kit.css` + app CSS vars apply to the
 * emitted `.kit-*` markup) with a `display: contents` host (so the element adds
 * no layout box — the rendered tree lays out exactly as the old builder's did).
 */
class KitElement extends LitElement {
  createRenderRoot() {
    return this;
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
    return html`<span
      class="kit-avatar"
      style=${style}
      aria-hidden="true"
      data-shape=${this.shape || nothing}
      >${this.src
        ? html`<img src=${this.src} alt="" />`
        : this.initials || avatarInitials(text)}</span
    >`;
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
    return html`<span class="kit-bar" aria-hidden="true"
      ><span class="kit-bar-fill" style="width:${pct}%" data-tone=${this.tone || nothing}></span
    ></span>`;
  }
}
customElements.define('kit-meter', KitMeter);

// ---------- Charts (line / area / bar) — hand-rolled SVG, themed by kit.css ----------

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
    if (points.length < 2) {
      return html`<svg
        viewBox="0 0 ${width} ${height}"
        class="kit-chart"
        role="img"
        aria-label=${this.label}
      ></svg>`;
    }
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
    return html`<svg
      viewBox="0 0 ${width} ${height}"
      class="kit-chart"
      role="img"
      aria-label=${this.label}
    >
      ${svg`<path d=${area} class="kit-chart-area"></path>
      <path d=${d} class="kit-chart-line"></path>
      <circle cx=${sx(last.x)} cy=${sy(last.y)} r="3" class="kit-chart-dot"></circle>`}
    </svg>`;
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
    return html`<svg
      viewBox="0 0 ${width} ${height}"
      class="kit-chart"
      role="img"
      aria-label=${this.label}
    >
      ${items.map((item, i) => {
        const h = ((height - pad * 2 - labelBand) * item.value) / max;
        return svg`<rect
          x=${pad + i * band + band * 0.15}
          y=${height - pad - labelBand - h}
          width=${band * 0.7}
          height=${Math.max(h, 1)}
          rx="2"
          class="kit-chart-barrect"
          data-muted=${item.muted ? 'true' : nothing}
        ></rect>
        <text
          x=${pad + i * band + band / 2}
          y=${height - pad}
          class="kit-chart-ticklabel"
          text-anchor="middle"
        >${item.label}</text>`;
      })}
    </svg>`;
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
    return html`${Array.from(
      { length: count },
      () => html`<div class=${cls} style=${this.width ? `width:${this.width}` : nothing}></div>`,
    )}`;
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
    return html`<div class="kit-toast" data-tone=${this.tone || nothing}>
      <span>${this.text}</span>
      ${this.undoLabel
        ? html`<button
            type="button"
            class="kit-toast-action"
            @click=${() => this.dispatchEvent(new CustomEvent('kit-undo'))}
          >
            ${this.undoLabel}
          </button>`
        : nothing}
      <button
        type="button"
        class="kit-toast-close"
        aria-label="Dismiss"
        @click=${() => this.dispatchEvent(new CustomEvent('kit-dismiss'))}
      >
        ×
      </button>
    </div>`;
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
    card: { type: Object },
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
    return html`<span
      class=${gone ? 'kit-mention-chip ref-gone' : 'kit-mention-chip'}
      title="${entityKindLabel(card.type)} — linked reference"
      >${label}</span
    >`;
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
    if (list.length === 0) {
      return this.emptyText
        ? html`<div class="kit-ref-strip"><p class="kit-ref-empty">${this.emptyText}</p></div>`
        : html`<div class="kit-ref-strip"></div>`;
    }
    return html`<div class="kit-ref-strip">${list.map((ref) => this.#tile(ref))}</div>`;
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
    return html`<div class=${gone ? 'kit-ref-tile is-gone' : 'kit-ref-tile'}>
      <span class="kit-ref-kind">${entityKindLabel(card.type)}</span>
      ${ref.selector
        ? html`<span
            class=${inline ? 'kit-ref-flag is-inline' : 'kit-ref-flag'}
            title=${inline
              ? 'Shown inline in the text above'
              : "This reference's words are no longer in the text"}
            >${inline ? 'in text' : 'in strip'}</span
          >`
        : nothing}
      <span class="kit-ref-title">${title}</span>
      ${card.subtitle && card.status === 'live'
        ? html`<span class="kit-ref-sub">${card.subtitle}</span>`
        : nothing}
      ${this.onRemove
        ? html`<button
            type="button"
            class="kit-ref-remove"
            title="Remove reference"
            aria-label="Remove reference to ${title}"
            @click=${() => this.onRemove(ref)}
          >
            ×
          </button>`
        : nothing}
    </div>`;
  }
}
customElements.define('kit-reference-strip', KitReferenceStrip);
