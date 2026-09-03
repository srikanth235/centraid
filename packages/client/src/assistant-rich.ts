import { highlightCode } from "./code-highlight.js";
import { cx, el, blockNodes } from "./gfm.js";

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

export interface ResolvedRefCard {
  status?: string;
  title?: string | null;
  subtitle?: string | null;
}

export type ResolveRefs = (
  refs: Array<{ type: string; id: string }>
) => Promise<ResolvedRefCard[]>;

export type AssistantRichClassOverrides = Partial<
  Record<keyof AssistantRichClasses, string | undefined>
>;

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

export function richAnswerHtml(
  text: string,
  classes?: AssistantRichClassOverrides
): string {
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
      () => {}
    );
  });
}
