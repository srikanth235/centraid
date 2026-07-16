// Shared assistant rich-answer renderer (issue #420) — the ONE string→HTML
// renderer for every chat surface. Canonical copy: packages/blueprints/kit/
// assistant-rich.js. Both the kit's Ask panel and the React shell render
// assistant answers through this, so ref-chips and typed `block:*` blocks look
// identical on both. Ported from the React shell's assistantRich.ts (which now
// re-exports this) to framework-free vanilla ESM.
//
// The shared prompt tells the model to emit `@[Title](ref:type/id)` citations
// and ```block:table|chart|stat``` JSON fences. This renderer turns those into
// interactive ref-chips and typed blocks; `hydrateRefs` resolves each chip to a
// live vault card title.
//
// Class names: the renderer emits the DEFAULT_CLASSES literal names (styled by
// kit.css for the Ask panel). The React shell passes its CSS-module `styles`
// object as the `classes` argument, so its scoped/hashed class names come out
// instead — one renderer, two stylesheets, no React ever flowing into the kit.

/** The literal class names the kit's kit.css styles. Callers may override any. */
export const DEFAULT_CLASSES = {
  asstRich: 'asstRich',
  asstP: 'asstP',
  asstH: 'asstH',
  asstUl: 'asstUl',
  asstRef: 'asstRef',
  asstBlock: 'asstBlock',
  asstTableWrap: 'asstTableWrap',
  asstTable: 'asstTable',
  asstCaption: 'asstCaption',
  asstStat: 'asstStat',
  asstStatValue: 'asstStatValue',
  asstStatLabel: 'asstStatLabel',
  asstStatSub: 'asstStatSub',
  asstChart: 'asstChart',
  asstChartPlot: 'asstChartPlot',
  asstChartSvg: 'asstChartSvg',
  asstChartX: 'asstChartX',
  asstChartLegend: 'asstChartLegend',
  asstPre: 'asstPre',
};

/** Join truthy class names (a tiny `cx`). */
function cx(...names) {
  return names.filter(Boolean).join(' ');
}

/** DOM helper mirroring the shell renderer's `el` — string/element children. */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  if (attrs.class) node.className = attrs.class;
  if (attrs.trustedHtml !== undefined) node.innerHTML = attrs.trustedHtml;
  if (attrs.style) Object.assign(node.style, attrs.style);
  for (const c of Array.isArray(children) ? children : [children]) {
    if (c == null || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function inlineHtml(raw, C) {
  let s = escapeHtml(raw);
  s = s.replace(
    /@\[([^\]]+)\]\(ref:([a-z_]+\.[a-z_]+)\/([A-Za-z0-9_-]+)\)/g,
    (_m, label, type, id) =>
      `<button type="button" class="${C.asstRef}" data-ref-type="${type}" data-ref-id="${id}">${label}</button>`,
  );
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  return s;
}

function proseNodes(text, C) {
  const out = [];
  let list = null;
  const flushList = () => {
    if (list) out.push(list);
    list = null;
  };
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.trim() === '') {
      flushList();
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      list ??= el('ul', { class: C.asstUl });
      list.append(el('li', { trustedHtml: inlineHtml(bullet[1] ?? '', C) }));
      continue;
    }
    flushList();
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      out.push(
        el(`h${Math.min(heading[1].length + 2, 5)}`, {
          class: C.asstH,
          trustedHtml: inlineHtml(heading[2] ?? '', C),
        }),
      );
      continue;
    }
    out.push(el('p', { class: C.asstP, trustedHtml: inlineHtml(line, C) }));
  }
  flushList();
  return out;
}

function tableBlock(spec, C) {
  if (!spec || !Array.isArray(spec.columns) || !Array.isArray(spec.rows)) return null;
  const table = el('table', { class: C.asstTable });
  table.append(
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        spec.columns.map((c) => el('th', {}, String(c))),
      ),
    ),
  );
  const body = el('tbody');
  for (const row of spec.rows.slice(0, 100)) {
    if (!Array.isArray(row)) continue;
    body.append(
      el(
        'tr',
        {},
        row.map((v) => el('td', {}, v === null || v === undefined ? '—' : String(v))),
      ),
    );
  }
  table.append(body);
  const wrap = el('div', { class: cx(C.asstBlock, C.asstTableWrap) }, table);
  if (typeof spec.caption === 'string' && spec.caption) {
    wrap.append(el('div', { class: C.asstCaption }, spec.caption));
  }
  return wrap;
}

function statBlock(spec, C) {
  if (!spec || (typeof spec.value !== 'string' && typeof spec.value !== 'number')) return null;
  return el('div', { class: cx(C.asstBlock, C.asstStat) }, [
    el('div', { class: C.asstStatValue }, String(spec.value)),
    typeof spec.label === 'string' ? el('div', { class: C.asstStatLabel }, spec.label) : false,
    typeof spec.sub === 'string' ? el('div', { class: C.asstStatSub }, spec.sub) : false,
  ]);
}

function chartBlock(spec, C) {
  if (!spec || (spec.type !== 'bar' && spec.type !== 'line') || !Array.isArray(spec.x)) return null;
  const series = (Array.isArray(spec.series) ? spec.series : [])
    .filter((r) => r && Array.isArray(r.values))
    .slice(0, 3);
  if (series.length === 0) return null;
  const W = 640;
  const H = 220;
  const PADX = 6;
  const PADY = 18;
  const n = spec.x.length;
  const all = series.flatMap((r) => r.values.filter((v) => Number.isFinite(v)));
  const max = Math.max(...all, 0);
  const min = Math.min(...all, 0);
  const span = max - min || 1;
  const py = (v) => H - PADY - ((v - min) / span) * (H - PADY * 2);
  const parts = [];
  if (spec.type === 'bar') {
    const group = (W - PADX * 2) / Math.max(n, 1);
    const bw = Math.max(4, (group * 0.7) / series.length);
    series.forEach((r, si) => {
      r.values.slice(0, n).forEach((v, i) => {
        if (!Number.isFinite(v)) return;
        const x = PADX + i * group + group * 0.15 + si * bw;
        const y = Math.min(py(v), py(0));
        const h = Math.abs(py(v) - py(0));
        parts.push(
          `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h, 1).toFixed(1)}" rx="2" fill="var(--accent)" opacity="${1 - si * 0.35}"/>`,
        );
      });
    });
  } else {
    const px = (i) => (n <= 1 ? W / 2 : PADX + (i / (n - 1)) * (W - PADX * 2));
    series.forEach((r, si) => {
      const pts = r.values
        .slice(0, n)
        .map((v, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)} ${py(v).toFixed(1)}`)
        .join(' ');
      parts.push(
        `<path d="${pts}" fill="none" stroke="var(--accent)" stroke-width="2" opacity="${1 - si * 0.35}" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
    });
  }
  const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="${C.asstChartSvg}">${parts.join('')}</svg>`;
  const labels = el(
    'div',
    { class: C.asstChartX },
    spec.x.slice(0, 12).map((v) => el('span', {}, String(v))),
  );
  const wrap = el('div', { class: cx(C.asstBlock, C.asstChart) });
  if (typeof spec.title === 'string' && spec.title)
    wrap.append(el('div', { class: C.asstCaption }, spec.title));
  wrap.append(el('div', { class: C.asstChartPlot, trustedHtml: svg }), labels);
  if (series.some((r) => r.label)) {
    wrap.append(
      el(
        'div',
        { class: C.asstChartLegend },
        series.map((r, si) =>
          el('span', { style: { opacity: String(1 - si * 0.35) } }, r.label ?? `Series ${si + 1}`),
        ),
      ),
    );
  }
  return wrap;
}

/**
 * Full answer → prose + typed blocks + plain code fences, as an HTML string.
 * @param {string} text
 * @param {Partial<typeof DEFAULT_CLASSES>} [classes]
 * @returns {string}
 */
export function richAnswerHtml(text, classes) {
  // Override only with truthy values so an override map with `undefined` slots
  // (e.g. a CSS-module import typed `string | undefined`) falls back to the
  // literal default rather than blanking the class name.
  let C = DEFAULT_CLASSES;
  if (classes) {
    C = { ...DEFAULT_CLASSES };
    for (const k in classes) if (classes[k]) C[k] = classes[k];
  }
  const host = el('div', { class: C.asstRich });
  const fence = /```(block:table|block:chart|block:stat|[a-z]*)\n([\s\S]*?)```/g;
  let last = 0;
  let m;
  const pushProse = (seg) => {
    for (const node of proseNodes(seg, C)) host.append(node);
  };
  while ((m = fence.exec(text)) !== null) {
    pushProse(text.slice(last, m.index));
    last = m.index + m[0].length;
    const tag = m[1] ?? '';
    const payload = m[2] ?? '';
    if (tag.startsWith('block:')) {
      let node = null;
      try {
        const spec = JSON.parse(payload);
        node =
          tag === 'block:table'
            ? tableBlock(spec, C)
            : tag === 'block:chart'
              ? chartBlock(spec, C)
              : statBlock(spec, C);
      } catch {
        node = null;
      }
      host.append(node ?? el('pre', { class: C.asstPre }, payload.trim()));
    } else {
      host.append(el('pre', { class: C.asstPre }, payload.replace(/\n$/, '')));
    }
  }
  pushProse(text.slice(last));
  return host.outerHTML;
}

/**
 * The kit's default ref resolver — POSTs to the shell-level vault surface
 * `/centraid/_vault/assistant/resolve`, reachable from an app iframe (same
 * origin as the other `/centraid/_vault/*` calls the Ask panel already makes).
 * Returns the resolved cards array, or [] on any failure.
 * @param {Array<{type: string, id: string}>} refs
 * @returns {Promise<Array<{status?: string, title?: string|null, subtitle?: string|null}>>}
 */
export async function defaultResolveRefs(refs) {
  if (refs.length === 0) return [];
  try {
    const res = await fetch('/centraid/_vault/assistant/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refs }),
    });
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body?.cards) ? body.cards : [];
  } catch {
    return [];
  }
}

/**
 * Resolve every ref chip under `host` to a live card title, batched. Injectable
 * `resolveRefs` (the shell passes its auth-aware `resolveAssistantRefs`; the kit
 * defaults to `defaultResolveRefs`) and `refClass` (the `asstRef` class name the
 * chips carry).
 *
 * @param {HTMLElement} host
 * @param {{
 *   resolveRefs?: (refs: Array<{type: string, id: string}>) => Promise<Array<{status?: string, title?: string|null, subtitle?: string|null}>>,
 *   refClass?: string,
 * }} [options]
 * @returns {void}
 */
export function hydrateRefs(host, options = {}) {
  const resolveRefs = options.resolveRefs ?? defaultResolveRefs;
  const refClass = options.refClass ?? DEFAULT_CLASSES.asstRef;
  const chips = [...host.querySelectorAll(`.${refClass}:not([data-resolved])`)];
  if (chips.length === 0) return;
  const refs = chips.map((c) => ({ type: c.dataset.refType ?? '', id: c.dataset.refId ?? '' }));
  void resolveRefs(refs)
    .then((cards) => {
      chips.forEach((chip, i) => {
        const card = cards[i];
        chip.dataset.resolved = 'true';
        if (!card || card.status !== 'live') {
          chip.dataset.state = 'missing';
          chip.title = 'Not found in the vault';
          return;
        }
        if (card.title) chip.textContent = card.title;
        chip.title = [card.title, card.subtitle].filter(Boolean).join(' — ');
      });
    })
    .catch(() => undefined);
}
