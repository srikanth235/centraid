// The assistant rich-answer renderer (issue #420) — the ONE string→HTML
// renderer for the assistant transcript. Framework-free so the memoizing shell
// adapter (react/shell/routes/assistantRich.ts) can call it outside React.
//
// The shared prompt tells the model to emit `@[Title](ref:type/id)` citations
// and ```block:table|chart|stat``` JSON fences. This renderer turns those into
// interactive ref-chips and typed blocks; `hydrateRefs` resolves each chip to a
// live vault card title. Full GFM (links, images, ordered/nested lists,
// blockquotes, pipe tables, hr, strikethrough) comes from gfm.ts and
// dependency-free syntax highlighting from code-highlight.ts.
//
// ── SECURITY CONTRACT (model output is UNTRUSTED input) ──────────────────────
// The shell injects this renderer's output via `dangerouslySetInnerHTML`, so
// the output must be provably safe. The guarantees, audited across every path:
//   1. Escape-by-default. Every text fragment is HTML-escaped (`escapeHtml`)
//      BEFORE any pattern-matching or tag injection. The parser only ever adds
//      a fixed, closed set of tags — p, h3–h6, ul, ol, li, blockquote, hr,
//      table/thead/tbody/tr/th/td, a, img, strong, em, del, code, pre, the ref
//      <button>, and the block:* SVG/table/stat nodes it builds itself. No text
//      the model supplies is ever placed unescaped into markup.
//   2. URL allowlist. Link/image hrefs pass through `sanitizeUrl` (gfm.ts):
//      only http/https(/mailto for links) schemes or scheme-less relative
//      gateway paths survive; `javascript:`, `data:`, `vbscript:`, and
//      protocol-relative `//host` are rejected (link → plain text, image →
//      alt). Control/whitespace chars are stripped first so `java\tscript:`
//      can't slip past scheme detection. Attribute-break-out is structurally
//      impossible: the URL is drawn from the already-escaped string, so any
//      `"` is already `&#34;`.
//   3. External links carry `rel="noopener noreferrer"` + `target="_blank"`.
//   4. Syntax highlighting (code-highlight.ts) is escape-by-default too: it
//      emits only `<span class="hl…">` with static class names around escaped
//      source, so a fenced code block can never inject markup.
//   5. block:* JSON is parsed with a try/catch; a malformed block degrades to a
//      visible (escaped) code block, never silent loss and never eval.
// Adversarial coverage lives in assistant-sanitize.test.ts.

import { highlightCode } from "./code-highlight.js";
import { cx, el, blockNodes } from "./gfm.js";

/** The renderer's class-name slots — kit.css styles the literal defaults. */
export interface AssistantRichClasses {
  asstRich: string;
  asstP: string;
  asstH: string;
  asstUl: string;
  asstOl: string;
  asstQuote: string;
  asstHr: string;
  asstA: string;
  asstImg: string;
  asstDel: string;
  asstRef: string;
  asstBlock: string;
  asstTableWrap: string;
  asstTable: string;
  asstCaption: string;
  asstStat: string;
  asstStatValue: string;
  asstStatLabel: string;
  asstStatSub: string;
  asstChart: string;
  asstChartPlot: string;
  asstChartSvg: string;
  asstChartX: string;
  asstChartLegend: string;
  asstPre: string;
  asstCodeWrap: string;
  asstCopyBtn: string;
}

/** A ref chip resolved to a renderable card (loose shape the resolver returns). */
export interface ResolvedRefCard {
  status?: string;
  title?: string | null;
  subtitle?: string | null;
}

export type ResolveRefs = (
  refs: Array<{ type: string; id: string }>
) => Promise<ResolvedRefCard[]>;

/**
 * A caller's class-name overrides. Values may be `undefined` (a CSS-module
 * import is often typed `string | undefined`); the renderer falls back to the
 * literal default for any missing/undefined slot.
 */
export type AssistantRichClassOverrides = Partial<
  Record<keyof AssistantRichClasses, string | undefined>
>;

/** The literal class names kit.css styles. Callers may override any. */
export const DEFAULT_CLASSES: AssistantRichClasses = {
  asstRich: "asstRich",
  asstP: "asstP",
  asstH: "asstH",
  asstUl: "asstUl",
  asstOl: "asstOl",
  asstQuote: "asstQuote",
  asstHr: "asstHr",
  asstA: "asstA",
  asstImg: "asstImg",
  asstDel: "asstDel",
  asstRef: "asstRef",
  asstBlock: "asstBlock",
  asstTableWrap: "asstTableWrap",
  asstTable: "asstTable",
  asstCaption: "asstCaption",
  asstStat: "asstStat",
  asstStatValue: "asstStatValue",
  asstStatLabel: "asstStatLabel",
  asstStatSub: "asstStatSub",
  asstChart: "asstChart",
  asstChartPlot: "asstChartPlot",
  asstChartSvg: "asstChartSvg",
  asstChartX: "asstChartX",
  asstChartLegend: "asstChartLegend",
  asstPre: "asstPre",
  asstCodeWrap: "asstCodeWrap",
  asstCopyBtn: "asstCopyBtn",
};

/**
 * A fenced code block wrapped with a hover copy button. When `lang` is a known
 * language the `<pre>` gets escape-by-default syntax highlighting (hl… spans);
 * otherwise it stays a plain escaped text node. `wireCodeCopy` reads the
 * `<pre>`'s textContent (unchanged by the spans) on click, so copy still works.
 */
function codeBlock(
  code: string,
  lang: string,
  C: AssistantRichClasses
): HTMLElement {
  const btn = el("button", { class: C.asstCopyBtn }, "Copy");
  (btn as HTMLButtonElement).type = "button";
  btn.setAttribute("aria-label", "Copy code");
  const highlighted = lang ? highlightCode(code, lang) : null;
  const pre = highlighted
    ? el("pre", { class: C.asstPre, trustedHtml: highlighted })
    : el("pre", { class: C.asstPre }, code);
  if (lang) pre.dataset.lang = lang;
  return el("div", { class: C.asstCodeWrap }, [btn, pre]);
}

interface TableSpec {
  columns?: unknown[];
  rows?: unknown[];
  caption?: unknown;
}

function tableBlock(
  spec: TableSpec | null,
  C: AssistantRichClasses
): HTMLElement | null {
  if (!spec || !Array.isArray(spec.columns) || !Array.isArray(spec.rows))
    return null;
  const table = el("table", { class: C.asstTable });
  table.append(
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        spec.columns.map((c) => el("th", {}, String(c)))
      )
    )
  );
  const body = el("tbody");
  for (const row of spec.rows.slice(0, 100)) {
    if (!Array.isArray(row)) continue;
    body.append(
      el(
        "tr",
        {},
        row.map((v) =>
          el("td", {}, v === null || v === undefined ? "—" : String(v))
        )
      )
    );
  }
  table.append(body);
  const wrap = el("div", { class: cx(C.asstBlock, C.asstTableWrap) }, table);
  if (typeof spec.caption === "string" && spec.caption) {
    wrap.append(el("div", { class: C.asstCaption }, spec.caption));
  }
  return wrap;
}

interface StatSpec {
  value?: unknown;
  label?: unknown;
  sub?: unknown;
}

function statBlock(
  spec: StatSpec | null,
  C: AssistantRichClasses
): HTMLElement | null {
  if (
    !spec ||
    (typeof spec.value !== "string" && typeof spec.value !== "number")
  )
    return null;
  return el("div", { class: cx(C.asstBlock, C.asstStat) }, [
    el("div", { class: C.asstStatValue }, String(spec.value)),
    typeof spec.label === "string"
      ? el("div", { class: C.asstStatLabel }, spec.label)
      : false,
    typeof spec.sub === "string"
      ? el("div", { class: C.asstStatSub }, spec.sub)
      : false,
  ]);
}

interface ChartSeries {
  label?: string;
  values: number[];
}

interface ChartSpec {
  type?: unknown;
  x?: unknown[];
  series?: unknown[];
  title?: unknown;
}

function chartBlock(
  spec: ChartSpec | null,
  C: AssistantRichClasses
): HTMLElement | null {
  if (
    !spec ||
    (spec.type !== "bar" && spec.type !== "line") ||
    !Array.isArray(spec.x)
  )
    return null;
  const series = (Array.isArray(spec.series) ? spec.series : [])
    .filter(
      (r): r is ChartSeries =>
        Boolean(r) && Array.isArray((r as ChartSeries).values)
    )
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
  const py = (v: number): number =>
    H - PADY - ((v - min) / span) * (H - PADY * 2);
  const parts: string[] = [];
  if (spec.type === "bar") {
    const group = (W - PADX * 2) / Math.max(n, 1);
    const bw = Math.max(4, (group * 0.7) / series.length);
    series.forEach((r, si) => {
      r.values.slice(0, n).forEach((v, i) => {
        if (!Number.isFinite(v)) return;
        const x = PADX + i * group + group * 0.15 + si * bw;
        const y = Math.min(py(v), py(0));
        const h = Math.abs(py(v) - py(0));
        parts.push(
          `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h, 1).toFixed(1)}" rx="2" fill="var(--accent)" opacity="${1 - si * 0.35}"/>`
        );
      });
    });
  } else {
    const px = (i: number): number =>
      n <= 1 ? W / 2 : PADX + (i / (n - 1)) * (W - PADX * 2);
    series.forEach((r, si) => {
      const pts = r.values
        .slice(0, n)
        .map(
          (v, i) => `${i ? "L" : "M"}${px(i).toFixed(1)} ${py(v).toFixed(1)}`
        )
        .join(" ");
      parts.push(
        `<path d="${pts}" fill="none" stroke="var(--accent)" stroke-width="2" opacity="${1 - si * 0.35}" stroke-linecap="round" stroke-linejoin="round"/>`
      );
    });
  }
  const svg = `<svg aria-hidden="true" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="${C.asstChartSvg}">${parts.join("")}</svg>`;
  const labels = el(
    "div",
    { class: C.asstChartX },
    spec.x.slice(0, 12).map((v) => el("span", {}, String(v)))
  );
  const wrap = el("div", { class: cx(C.asstBlock, C.asstChart) });
  if (typeof spec.title === "string" && spec.title)
    wrap.append(el("div", { class: C.asstCaption }, spec.title));
  wrap.append(el("div", { class: C.asstChartPlot, trustedHtml: svg }), labels);
  if (series.some((r) => r.label)) {
    wrap.append(
      el(
        "div",
        { class: C.asstChartLegend },
        series.map((r, si) =>
          el(
            "span",
            { style: { opacity: String(1 - si * 0.35) } },
            r.label ?? `Series ${si + 1}`
          )
        )
      )
    );
  }
  return wrap;
}

/**
 * Full answer → GFM prose + typed blocks + highlighted code fences, as an HTML
 * string. Untrusted input — see the SECURITY CONTRACT above.
 */
export function richAnswerHtml(
  text: string,
  classes?: AssistantRichClassOverrides
): string {
  // Override only with truthy values so an override map with `undefined` slots
  // (e.g. a CSS-module import typed `string | undefined`) falls back to the
  // literal default rather than blanking the class name.
  let C = DEFAULT_CLASSES;
  if (classes) {
    const merged = { ...DEFAULT_CLASSES };
    for (const key of Object.keys(classes) as Array<
      keyof AssistantRichClasses
    >) {
      const value = classes[key];
      if (value) merged[key] = value;
    }
    C = merged;
  }
  const host = el("div", { class: C.asstRich });
  const fence =
    /```(?<tag>block:table|block:chart|block:stat|[A-Za-z0-9+#_-]*)\n(?<payload>[\s\S]*?)```/gu;
  let last = 0;
  let m: RegExpExecArray | null;
  const pushProse = (seg: string): void => {
    for (const node of blockNodes(seg, C)) host.append(node);
  };
  while ((m = fence.exec(text)) !== null) {
    pushProse(text.slice(last, m.index));
    last = m.index + m[0].length;
    const tag = m.groups?.tag ?? "";
    const payload = m.groups?.payload ?? "";
    if (tag.startsWith("block:")) {
      let node: HTMLElement | null = null;
      try {
        const spec: unknown = JSON.parse(payload);
        node =
          tag === "block:table"
            ? tableBlock(spec as TableSpec, C)
            : tag === "block:chart"
              ? chartBlock(spec as ChartSpec, C)
              : statBlock(spec as StatSpec, C);
      } catch {
        node = null;
      }
      host.append(node ?? codeBlock(payload.trim(), "", C));
    } else {
      host.append(codeBlock(payload.replace(/\n$/u, ""), tag, C));
    }
  }
  pushProse(text.slice(last));
  return host.outerHTML;
}

/**
 * Resolve every ref chip under `host` to a live card title, batched. The shell
 * passes its auth-aware `resolveAssistantRefs` and the scoped `asstRef` class
 * name its CSS module minted.
 */
export function hydrateRefs(
  host: HTMLElement,
  options: { resolveRefs: ResolveRefs; refClass?: string }
): void {
  const { resolveRefs } = options;
  const refClass = options.refClass ?? DEFAULT_CLASSES.asstRef;
  const chips = [
    ...host.querySelectorAll<HTMLElement>(`.${refClass}:not([data-resolved])`),
  ];
  if (chips.length === 0) return;
  const refs = chips.map((c) => ({
    type: c.dataset.refType ?? "",
    id: c.dataset.refId ?? "",
  }));
  void resolveRefs(refs)
    .then((cards) => {
      chips.forEach((chip, i) => {
        const card = cards[i];
        chip.dataset.resolved = "true";
        if (!card || card.status !== "live") {
          chip.dataset.state = "missing";
          chip.title = "Not found in the vault";
          return;
        }
        if (card.title) chip.textContent = card.title;
        chip.title = [card.title, card.subtitle].filter(Boolean).join(" — ");
      });
    })
    .catch(() => undefined);
}

/**
 * Wire one delegated click handler under `host` so every code block's hover
 * "Copy" button copies its `<pre>` text to the clipboard (issue #420).
 * Idempotent: a `data-copy-wired` flag guards against double-binding when a
 * node is re-hydrated.
 */
export function wireCodeCopy(
  host: HTMLElement,
  options: { copyClass?: string } = {}
): void {
  if (!host || host.dataset.copyWired === "true") return;
  const copyClass = options.copyClass ?? DEFAULT_CLASSES.asstCopyBtn;
  host.dataset.copyWired = "true";
  host.addEventListener("click", (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const btn = target.closest<HTMLElement>(`.${copyClass}`);
    if (!btn || !host.contains(btn)) return;
    const pre = btn.parentElement?.querySelector("pre");
    const text = pre?.textContent ?? "";
    if (!text) return;
    void navigator.clipboard.writeText(text).then(
      () => {
        btn.dataset.copied = "true";
        btn.textContent = "Copied";
        setTimeout(() => {
          delete btn.dataset.copied;
          btn.textContent = "Copy";
        }, 1400);
      },
      () => {
        /* clipboard write failed — leave the button as-is */
      }
    );
  });
}
