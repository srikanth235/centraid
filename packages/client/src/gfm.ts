// GFM block + inline parser for the rich-answer renderer (issue #420, Wave 2).
// Dependency-free; assistant-rich.ts is its only consumer.
//
// SECURITY (see assistant-rich.ts for the full contract): every text path runs
// through `escapeHtml` FIRST, so the parser only ever pattern-matches over
// already-escaped text and injects a fixed, closed set of tags (p, h3–h6, ul,
// ol, li, blockquote, hr, table, a, img, strong, em, del, code, and the ref
// button). URLs for links/images pass through `sanitizeUrl`, which allowlists
// http/https(/mailto) + relative gateway paths and rejects javascript:/data:/
// protocol-relative. Attribute injection is structurally impossible because the
// URL is drawn from the escaped string (quotes are already `&#34;`).

/**
 * The subset of the renderer's resolved class map this parser reads. Declared
 * structurally so `AssistantRichClasses` (the full slot list) satisfies it
 * without either module depending on the other's shape.
 */
export interface GfmClasses {
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
}

interface ElementAttrs {
  class?: string;
  trustedHtml?: string;
  style?: Partial<CSSStyleDeclaration>;
}

type ElementChild = Node | string | false | null | undefined;

/** Join truthy class names (a tiny `cx`). */
export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}

/** DOM helper — string/element children; `trustedHtml` sets innerHTML. */
export function el(
  tag: string,
  attrs: ElementAttrs = {},
  children: ElementChild | ElementChild[] = []
): HTMLElement {
  const node = document.createElement(tag);
  if (attrs.class) node.className = attrs.class;
  if (attrs.trustedHtml !== undefined) node.innerHTML = attrs.trustedHtml;
  if (attrs.style) Object.assign(node.style, attrs.style);
  for (const c of Array.isArray(children) ? children : [children]) {
    if (c == null || c === false) continue;
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

/** HTML-escape a string (numeric entities for the five dangerous chars). */
export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);
}

/** Sentinel wrapping an extracted inline-code span (control chars: never in escaped text). */
const CODE_OPEN = "\u0000";
const CODE_CLOSE = "\u0001";

/**
 * Allowlist a link/image URL drawn from ALREADY-ESCAPED markdown. Returns the
 * safe URL string, or `null` to reject (the caller then renders plain text /
 * alt). Strips control + whitespace chars first so `java\tscript:` can't slip
 * past scheme detection, rejects protocol-relative `//host`, and permits only
 * http/https(+ mailto for links) schemes or scheme-less relative paths.
 */
export function sanitizeUrl(url: string, isImage: boolean): string | null {
  // Strip control + whitespace chars browsers ignore during scheme detection.
  const cleaned = String(url).replace(/[\p{Cc}\s]+/gu, "");
  if (!cleaned) return null;
  if (cleaned.startsWith("//")) return null; // protocol-relative → external
  const scheme = cleaned.match(/^(?<scheme>[a-z][a-z0-9+.-]*):/iu);
  if (scheme) {
    const s = (scheme.groups?.scheme ?? "").toLowerCase();
    const ok = s === "http" || s === "https" || (!isImage && s === "mailto");
    return ok ? cleaned : null;
  }
  return cleaned; // scheme-less → relative gateway path / fragment / query
}

/**
 * Inline markdown → HTML string. `raw` is escaped first; then ref-chips,
 * images, links, strikethrough, bold, italic, and inline code are applied.
 * Inline code is extracted before the others so its contents stay literal.
 */
export function inlineHtml(raw: string, C: GfmClasses): string {
  let s = escapeHtml(raw);
  // Extract inline code so `*`/`[` etc. inside it are not re-interpreted.
  const codes: string[] = [];
  s = s.replace(/`(?<code>[^`]+)`/gu, (_m, code: string) => {
    codes.push(code);
    return `${CODE_OPEN}${codes.length - 1}${CODE_CLOSE}`;
  });
  // Vault ref chips (@[Title](ref:type/id)).
  s = s.replace(
    /@\[(?<label>[^\]]+)\]\(ref:(?<type>[a-z_]+\.[a-z_]+)\/(?<id>[A-Za-z0-9_-]+)\)/gu,
    (_m, label: string, type: string, id: string) =>
      `<button type="button" class="${C.asstRef}" data-ref-type="${type}" data-ref-id="${id}">${label}</button>`
  );
  // Images ![alt](url) — before links (the leading `!` disambiguates).
  s = s.replace(
    /!\[(?<alt>[^\]]*)\]\((?<url>[^)\s]+)(?:\s+&#34;[^)]*)?\)/gu,
    (_m, alt: string, url: string) => {
      const safe = sanitizeUrl(url, true);
      return safe
        ? `<img class="${C.asstImg}" src="${safe}" alt="${alt}" loading="lazy" />`
        : alt;
    }
  );
  // Links [text](url).
  s = s.replace(
    /\[(?<text>[^\]]+)\]\((?<url>[^)\s]+)(?:\s+&#34;[^)]*)?\)/gu,
    (_m, text: string, url: string) => {
      const safe = sanitizeUrl(url, false);
      if (!safe) return text;
      const attrs = /^https?:/iu.test(safe)
        ? ' target="_blank" rel="noopener noreferrer"'
        : "";
      return `<a class="${C.asstA}" href="${safe}"${attrs}>${text}</a>`;
    }
  );
  // Strikethrough, bold, italic.
  s = s.replace(
    /~~(?<struck>[^~]+)~~/gu,
    `<del class="${C.asstDel}">$<struck></del>`
  );
  s = s.replace(/\*\*(?<bold>[^*]+)\*\*/gu, "<strong>$<bold></strong>");
  s = s.replace(
    /(?<lead>^|[\s(>])\*(?<italic>[^*\n]+)\*/gu,
    "$<lead><em>$<italic></em>"
  );
  // Restore inline code.
  s = s.replace(
    new RegExp(`${CODE_OPEN}(\\d+)${CODE_CLOSE}`, "gu"),
    (_m, i: string) => `<code>${codes[Number(i)]}</code>`
  );
  return s;
}

const HR_RE = /^ {0,3}(?<rule>[-*_])(?: *\k<rule>){2,} *$/u;
const LIST_RE = /^(?<indent>\s*)(?<marker>[-*+]|\d+[.)])\s+(?<content>.*)$/u;
const HEADING_RE = /^(?<hashes>#{1,6})\s+(?<text>.*)$/u;

/** Cells of a pipe-table row, trimmed, outer pipes stripped. */
function tableCells(row: string): string[] {
  return row
    .replace(/^\s*\|/u, "")
    .replace(/\|\s*$/u, "")
    .split("|")
    .map((c) => c.trim());
}

/** Is `sep` a table delimiter row (dashes/colons/pipes, at least one dash + pipe/colon)? */
function isTableSep(sep: string | undefined): sep is string {
  return (
    sep !== undefined &&
    /-/u.test(sep) &&
    /^[\s|:-]+$/u.test(sep) &&
    /[|:]/u.test(sep)
  );
}

function buildTable(
  lines: string[],
  start: number,
  C: GfmClasses
): { node: HTMLElement; next: number } | null {
  const header = lines[start];
  const sep = lines[start + 1];
  if (!header || !/\|/u.test(header) || !isTableSep(sep)) return null;
  const cols = tableCells(header);
  const aligns = tableCells(sep).map((s) =>
    s.startsWith(":") && s.endsWith(":")
      ? "center"
      : s.endsWith(":")
        ? "right"
        : s.startsWith(":")
          ? "left"
          : ""
  );
  const table = el("table", { class: C.asstTable });
  table.append(
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        cols.map((c, i) =>
          el("th", {
            ...(aligns[i] ? { style: { textAlign: aligns[i] } } : {}),
            trustedHtml: inlineHtml(c, C),
          })
        )
      )
    )
  );
  const body = el("tbody");
  let i = start + 2;
  for (; i < lines.length; i += 1) {
    const row = lines[i] ?? "";
    if (!/\|/u.test(row) || row.trim() === "") break;
    const cells = tableCells(row);
    body.append(
      el(
        "tr",
        {},
        cols.map((_c, ci) =>
          el("td", {
            ...(aligns[ci] ? { style: { textAlign: aligns[ci] } } : {}),
            trustedHtml: inlineHtml(cells[ci] ?? "", C),
          })
        )
      )
    );
  }
  table.append(body);
  return {
    node: el("div", { class: cx(C.asstBlock, C.asstTableWrap) }, table),
    next: i,
  };
}

interface ListItem {
  indent: number;
  ordered: boolean;
  content: string;
}

/**
 * Build a (possibly nested, mixed ul/ol) list from parsed marker rows. `items`
 * is never empty — the caller only calls this after matching at least one row.
 */
function buildList(
  items: [ListItem, ...ListItem[]],
  C: GfmClasses
): HTMLElement {
  let idx = 0;
  const build = (indent: number): HTMLElement => {
    const first = items[idx];
    const listEl = el(first?.ordered ? "ol" : "ul", {
      class: first?.ordered ? C.asstOl : C.asstUl,
    });
    while (idx < items.length) {
      const it = items[idx];
      if (!it || it.indent < indent) break;
      if (it.indent > indent) {
        const child = build(it.indent);
        (listEl.lastElementChild ?? listEl).append(child);
        continue;
      }
      listEl.append(el("li", { trustedHtml: inlineHtml(it.content, C) }));
      idx += 1;
    }
    return listEl;
  };
  return build(items[0].indent);
}

/**
 * GFM block parser: prose text (with code fences already split out upstream) →
 * an array of block-level DOM nodes. Handles headings, hr, blockquotes, nested
 * lists, pipe tables, and paragraphs.
 */
export function blockNodes(text: string, C: GfmClasses): HTMLElement[] {
  const lines = text.split("\n");
  const out: HTMLElement[] = [];
  let para: string[] = [];
  const flushPara = (): void => {
    if (para.length)
      out.push(
        el("p", { class: C.asstP, trustedHtml: inlineHtml(para.join(" "), C) })
      );
    para = [];
  };
  for (let i = 0; i < lines.length;) {
    const line = (lines[i] ?? "").replace(/\s+$/u, "");
    if (line.trim() === "") {
      flushPara();
      i += 1;
      continue;
    }
    // Table (header line has a pipe, next line is a delimiter).
    if (/\|/u.test(line) && isTableSep(lines[i + 1])) {
      flushPara();
      const built = buildTable(lines, i, C);
      if (built) {
        out.push(built.node);
        i = built.next;
        continue;
      }
    }
    // Horizontal rule.
    if (HR_RE.test(line)) {
      flushPara();
      out.push(el("hr", { class: C.asstHr }));
      i += 1;
      continue;
    }
    // Heading.
    const heading = line.match(HEADING_RE);
    if (heading) {
      flushPara();
      out.push(
        el(`h${Math.min((heading.groups?.hashes ?? "").length + 2, 6)}`, {
          class: C.asstH,
          trustedHtml: inlineHtml(heading.groups?.text ?? "", C),
        })
      );
      i += 1;
      continue;
    }
    // Blockquote (collect the run, strip one `>`, recurse).
    if (/^\s*>/u.test(line)) {
      flushPara();
      const inner: string[] = [];
      while (i < lines.length && /^\s*>/u.test(lines[i] ?? "")) {
        inner.push((lines[i] ?? "").replace(/^\s*>\s?/u, ""));
        i += 1;
      }
      out.push(
        el(
          "blockquote",
          { class: C.asstQuote },
          blockNodes(inner.join("\n"), C)
        )
      );
      continue;
    }
    // List (collect the contiguous run, build nested).
    if (LIST_RE.test(line)) {
      flushPara();
      const items: ListItem[] = [];
      while (i < lines.length) {
        const mm = (lines[i] ?? "").match(LIST_RE);
        if (!mm) break;
        items.push({
          indent: (mm.groups?.indent ?? "").length,
          ordered: /\d/u.test(mm.groups?.marker ?? ""),
          content: mm.groups?.content ?? "",
        });
        i += 1;
      }
      const [first, ...rest] = items;
      if (first) out.push(buildList([first, ...rest], C));
      continue;
    }
    // Paragraph line.
    para.push(line.trim());
    i += 1;
  }
  flushPara();
  return out;
}
