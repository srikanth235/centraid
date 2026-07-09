import { resolveAssistantRefs } from '../../../gateway-client.js';
import styles from './assistantRich.module.css';
import { cx } from '../../ui/cx.js';
import asstPreCss from '../../styles/asstPre.module.css';

// Assistant rich-answer renderer — ports the vanilla app-assistant.ts
// markdown-lite + typed-block renderer (richAnswer / proseNodes / table / stat /
// chart blocks / inline formatting) and the ref-chip hydrator. Produces an HTML
// string the AssistantScreen injects via dangerouslySetInnerHTML (the message
// DTO's `html` field), exactly as the vanilla side did. A tiny local `el` mirrors
// the renderer's DOM helper so the block builders copy over near-verbatim.

type ElChild = HTMLElement | string | false | null | undefined;
interface ElAttrs {
  class?: string;
  trustedHtml?: string;
  style?: Partial<CSSStyleDeclaration>;
}

function el(tag: string, attrs: ElAttrs = {}, children: ElChild | ElChild[] = []): HTMLElement {
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

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function inlineHtml(raw: string): string {
  let s = escapeHtml(raw);
  s = s.replace(
    /@\[([^\]]+)\]\(ref:([a-z_]+\.[a-z_]+)\/([A-Za-z0-9_-]+)\)/g,
    (_m, label: string, type: string, id: string) =>
      `<button type="button" class="${styles.asstRef}" data-ref-type="${type}" data-ref-id="${id}">${label}</button>`,
  );
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  return s;
}

function proseNodes(text: string): HTMLElement[] {
  const out: HTMLElement[] = [];
  let list: HTMLElement | null = null;
  const flushList = (): void => {
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
      list ??= el('ul', { class: styles.asstUl });
      list.append(el('li', { trustedHtml: inlineHtml(bullet[1] ?? '') }));
      continue;
    }
    flushList();
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      out.push(
        el(`h${Math.min(heading[1]!.length + 2, 5)}`, {
          class: styles.asstH,
          trustedHtml: inlineHtml(heading[2] ?? ''),
        }),
      );
      continue;
    }
    out.push(el('p', { class: styles.asstP, trustedHtml: inlineHtml(line) }));
  }
  flushList();
  return out;
}

function tableBlock(spec: unknown): HTMLElement | null {
  const s = spec as { columns?: unknown; rows?: unknown; caption?: unknown };
  if (!Array.isArray(s.columns) || !Array.isArray(s.rows)) return null;
  const table = el('table', { class: styles.asstTable });
  table.append(
    el('thead', {}, el('tr', {}, s.columns.map((c) => el('th', {}, String(c))))),
  );
  const body = el('tbody');
  for (const row of (s.rows as unknown[]).slice(0, 100)) {
    if (!Array.isArray(row)) continue;
    body.append(el('tr', {}, row.map((v) => el('td', {}, v === null || v === undefined ? '—' : String(v)))));
  }
  table.append(body);
  const wrap = el('div', { class: cx(styles.asstBlock, styles.asstTableWrap) }, table);
  if (typeof s.caption === 'string' && s.caption) {
    wrap.append(el('div', { class: styles.asstCaption }, s.caption));
  }
  return wrap;
}

function statBlock(spec: unknown): HTMLElement | null {
  const s = spec as { value?: unknown; label?: unknown; sub?: unknown };
  if (typeof s.value !== 'string' && typeof s.value !== 'number') return null;
  return el('div', { class: cx(styles.asstBlock, styles.asstStat) }, [
    el('div', { class: styles.asstStatValue }, String(s.value)),
    typeof s.label === 'string' ? el('div', { class: styles.asstStatLabel }, s.label) : false,
    typeof s.sub === 'string' ? el('div', { class: styles.asstStatSub }, s.sub) : false,
  ]);
}

interface ChartSpec {
  type: 'bar' | 'line';
  x: string[];
  series: { label?: string; values: number[] }[];
  title?: string;
}

function chartBlock(spec: unknown): HTMLElement | null {
  const s = spec as Partial<ChartSpec>;
  if ((s.type !== 'bar' && s.type !== 'line') || !Array.isArray(s.x)) return null;
  const series = (Array.isArray(s.series) ? s.series : [])
    .filter((r) => r && Array.isArray(r.values))
    .slice(0, 3);
  if (series.length === 0) return null;
  const W = 640;
  const H = 220;
  const PADX = 6;
  const PADY = 18;
  const n = s.x.length;
  const all = series.flatMap((r) => r.values.filter((v) => Number.isFinite(v)));
  const max = Math.max(...all, 0);
  const min = Math.min(...all, 0);
  const span = max - min || 1;
  const py = (v: number): number => H - PADY - ((v - min) / span) * (H - PADY * 2);
  const parts: string[] = [];
  if (s.type === 'bar') {
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
    const px = (i: number): number => (n <= 1 ? W / 2 : PADX + (i / (n - 1)) * (W - PADX * 2));
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
  const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="${styles.asstChartSvg}">${parts.join('')}</svg>`;
  const labels = el('div', { class: styles.asstChartX }, s.x.slice(0, 12).map((v) => el('span', {}, String(v))));
  const wrap = el('div', { class: cx(styles.asstBlock, styles.asstChart) });
  if (typeof s.title === 'string' && s.title) wrap.append(el('div', { class: styles.asstCaption }, s.title));
  wrap.append(el('div', { class: styles.asstChartPlot, trustedHtml: svg }), labels);
  if (series.some((r) => r.label)) {
    wrap.append(
      el(
        'div',
        { class: styles.asstChartLegend },
        series.map((r, si) => el('span', { style: { opacity: String(1 - si * 0.35) } }, r.label ?? `Series ${si + 1}`)),
      ),
    );
  }
  return wrap;
}

/** Full answer → prose + typed blocks + plain code fences, as an HTML string. */
export function richAnswerHtml(text: string): string {
  const host = el('div', { class: styles.asstRich });
  const fence = /```(block:table|block:chart|block:stat|[a-z]*)\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const pushProse = (seg: string): void => {
    for (const node of proseNodes(seg)) host.append(node);
  };
  while ((m = fence.exec(text)) !== null) {
    pushProse(text.slice(last, m.index));
    last = m.index + m[0].length;
    const tag = m[1] ?? '';
    const payload = m[2] ?? '';
    if (tag.startsWith('block:')) {
      let node: HTMLElement | null = null;
      try {
        const spec: unknown = JSON.parse(payload);
        node =
          tag === 'block:table' ? tableBlock(spec) : tag === 'block:chart' ? chartBlock(spec) : statBlock(spec);
      } catch {
        node = null;
      }
      host.append(node ?? el('pre', { class: asstPreCss.asstPre }, payload.trim()));
    } else {
      host.append(el('pre', { class: asstPreCss.asstPre }, payload.replace(/\n$/, '')));
    }
  }
  pushProse(text.slice(last));
  return host.outerHTML;
}

/** Resolve every ref chip under `host` to a live card title, batched. */
export function hydrateRefs(host: HTMLElement): void {
  const chips = [...host.querySelectorAll<HTMLElement>(`.${styles.asstRef}:not([data-resolved])`)];
  if (chips.length === 0) return;
  const refs = chips.map((c) => ({ type: c.dataset.refType ?? '', id: c.dataset.refId ?? '' }));
  void resolveAssistantRefs(refs)
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
