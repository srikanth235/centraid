// Shared assistant rich-answer renderer (issue #420) — the ONE string→HTML
// renderer for every chat surface. Canonical copy: packages/blueprints/kit/
// assistant-rich.js. Both the kit's Ask panel and the React shell render
// assistant answers through this, so GFM, typed `block:*` blocks, code
// highlighting, and ref-chips look identical on both. Framework-free vanilla
// ESM (no npm dependency); the React shell re-exports it (assistantRich.ts).
//
// The shared prompt tells the model to emit `@[Title](ref:type/id)` citations
// and ```block:table|chart|stat``` JSON fences. This renderer turns those into
// interactive ref-chips and typed blocks; `hydrateRefs` resolves each chip to a
// live vault card title. Wave 2 added full GFM (links, images, ordered/nested
// lists, blockquotes, pipe tables, hr, strikethrough) via gfm.js and
// dependency-free syntax highlighting via code-highlight.js.
//
// ── SECURITY CONTRACT (model output is UNTRUSTED input) ──────────────────────
// The React shell injects this renderer's output via `dangerouslySetInnerHTML`
// and the kit via `innerHTML`, so the output must be provably safe. The
// guarantees, audited across every path:
//   1. Escape-by-default. Every text fragment is HTML-escaped (`escapeHtml`)
//      BEFORE any pattern-matching or tag injection. The parser only ever adds
//      a fixed, closed set of tags — p, h3–h6, ul, ol, li, blockquote, hr,
//      table/thead/tbody/tr/th/td, a, img, strong, em, del, code, pre, the ref
//      <button>, and the block:* SVG/table/stat nodes it builds itself. No text
//      the model supplies is ever placed unescaped into markup.
//   2. URL allowlist. Link/image hrefs pass through `sanitizeUrl` (gfm.js):
//      only http/https(/mailto for links) schemes or scheme-less relative
//      gateway paths survive; `javascript:`, `data:`, `vbscript:`, and
//      protocol-relative `//host` are rejected (link → plain text, image →
//      alt). Control/whitespace chars are stripped first so `java\tscript:`
//      can't slip past scheme detection. Attribute-break-out is structurally
//      impossible: the URL is drawn from the already-escaped string, so any
//      `"` is already `&#34;`.
//   3. External links carry `rel="noopener noreferrer"` + `target="_blank"`.
//   4. Syntax highlighting (code-highlight.js) is escape-by-default too: it
//      emits only `<span class="hl…">` with static class names around escaped
//      source, so a fenced code block can never inject markup.
//   5. block:* JSON is parsed with a try/catch; a malformed block degrades to a
//      visible (escaped) code block, never silent loss and never eval.
// Adversarial coverage lives in packages/blueprints/src/assistant-sanitize.test.ts.

import { cx, el, escapeHtml, inlineHtml, blockNodes } from './gfm.js';
import { highlightCode } from './code-highlight.js';

/** The literal class names the kit's kit.css styles. Callers may override any. */
export const DEFAULT_CLASSES = {
  asstRich: 'asstRich',
  asstP: 'asstP',
  asstH: 'asstH',
  asstUl: 'asstUl',
  asstOl: 'asstOl',
  asstQuote: 'asstQuote',
  asstHr: 'asstHr',
  asstA: 'asstA',
  asstImg: 'asstImg',
  asstDel: 'asstDel',
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
  asstCodeWrap: 'asstCodeWrap',
  asstCopyBtn: 'asstCopyBtn',
};

/**
 * A fenced code block wrapped with a hover copy button. When `lang` is a known
 * language the `<pre>` gets escape-by-default syntax highlighting (hl… spans);
 * otherwise it stays a plain escaped text node. `wireCodeCopy` reads the
 * `<pre>`'s textContent (unchanged by the spans) on click, so copy still works.
 * @param {string} code
 * @param {string} lang
 * @param {typeof DEFAULT_CLASSES} C
 * @returns {HTMLElement}
 */
function codeBlock(code, lang, C) {
  const btn = el('button', { class: C.asstCopyBtn }, 'Copy');
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Copy code');
  const highlighted = lang ? highlightCode(code, lang) : null;
  const pre = highlighted
    ? el('pre', { class: C.asstPre, trustedHtml: highlighted })
    : el('pre', { class: C.asstPre }, code);
  if (lang) pre.dataset.lang = lang;
  return el('div', { class: C.asstCodeWrap }, [btn, pre]);
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
 * Full answer → GFM prose + typed blocks + highlighted code fences, as an HTML
 * string. Untrusted input — see the SECURITY CONTRACT above.
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
  const fence = /```(block:table|block:chart|block:stat|[A-Za-z0-9+#_-]*)\n([\s\S]*?)```/g;
  let last = 0;
  let m;
  const pushProse = (seg) => {
    for (const node of blockNodes(seg, C)) host.append(node);
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
      host.append(node ?? codeBlock(payload.trim(), '', C));
    } else {
      host.append(codeBlock(payload.replace(/\n$/, ''), tag, C));
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

/**
 * Wire one delegated click handler under `host` so every code block's hover
 * "Copy" button copies its `<pre>` text to the clipboard (issue #420). Shared
 * by both chat surfaces — the shell calls it in the answer node's ref callback
 * alongside `hydrateRefs`, the kit's Ask panel calls it after `finalizeRich`.
 * Idempotent: a `data-copy-wired` flag guards against double-binding when a
 * node is re-hydrated.
 *
 * @param {HTMLElement} host
 * @param {{ copyClass?: string }} [options]
 * @returns {void}
 */
export function wireCodeCopy(host, options = {}) {
  if (!host || host.dataset.copyWired === 'true') return;
  const copyClass = options.copyClass ?? DEFAULT_CLASSES.asstCopyBtn;
  host.dataset.copyWired = 'true';
  host.addEventListener('click', (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const btn = target.closest(`.${copyClass}`);
    if (!btn || !host.contains(btn)) return;
    const pre = btn.parentElement?.querySelector('pre');
    const text = pre?.textContent ?? '';
    if (!text) return;
    const done = () => {
      btn.dataset.copied = 'true';
      btn.textContent = 'Copied';
      setTimeout(() => {
        delete btn.dataset.copied;
        btn.textContent = 'Copy';
      }, 1400);
    };
    try {
      void navigator.clipboard.writeText(text).then(done, () => undefined);
    } catch {
      /* clipboard unavailable — leave the button as-is */
    }
  });
}
