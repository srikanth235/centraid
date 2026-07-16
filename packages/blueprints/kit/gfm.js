// GFM block + inline parser for the shared assistant renderer (issue #420,
// Wave 2). Framework-free vanilla ESM — NO npm dependency (kit constraint).
// assistant-rich.js imports these; both chat surfaces render through it.
//
// SECURITY (see assistant-rich.js for the full contract): every text path runs
// through `escapeHtml` FIRST, so the parser only ever pattern-matches over
// already-escaped text and injects a fixed, closed set of tags (p, h3–h6, ul,
// ol, li, blockquote, hr, table, a, img, strong, em, del, code, and the ref
// button). URLs for links/images pass through `sanitizeUrl`, which allowlists
// http/https(/mailto) + relative gateway paths and rejects javascript:/data:/
// protocol-relative. Attribute injection is structurally impossible because the
// URL is drawn from the escaped string (quotes are already `&#34;`).

/** Join truthy class names (a tiny `cx`). */
export function cx(...names) {
  return names.filter(Boolean).join(' ');
}

/** DOM helper — string/element children; `trustedHtml` sets innerHTML. */
export function el(tag, attrs = {}, children = []) {
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

/** HTML-escape a string (numeric entities for the five dangerous chars). */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Sentinel wrapping an extracted inline-code span (control chars: never in escaped text). */
const CODE_OPEN = '\u0000';
const CODE_CLOSE = '\u0001';

/**
 * Allowlist a link/image URL drawn from ALREADY-ESCAPED markdown. Returns the
 * safe URL string, or `null` to reject (the caller then renders plain text /
 * alt). Strips control + whitespace chars first so `java\tscript:` can't slip
 * past scheme detection, rejects protocol-relative `//host`, and permits only
 * http/https(+ mailto for links) schemes or scheme-less relative paths.
 * @param {string} url
 * @param {boolean} isImage
 * @returns {string | null}
 */
export function sanitizeUrl(url, isImage) {
  // Strip control + whitespace chars browsers ignore during scheme detection.
  const cleaned = String(url).replace(/[\u0000-\u0020]+/g, '');
  if (!cleaned) return null;
  if (cleaned.startsWith('//')) return null; // protocol-relative → external
  const scheme = cleaned.match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme) {
    const s = scheme[1].toLowerCase();
    const ok = s === 'http' || s === 'https' || (!isImage && s === 'mailto');
    return ok ? cleaned : null;
  }
  return cleaned; // scheme-less → relative gateway path / fragment / query
}

/**
 * Inline markdown → HTML string. `raw` is escaped first; then ref-chips,
 * images, links, strikethrough, bold, italic, and inline code are applied.
 * Inline code is extracted before the others so its contents stay literal.
 * @param {string} raw
 * @param {Record<string, string>} C
 * @returns {string}
 */
export function inlineHtml(raw, C) {
  let s = escapeHtml(raw);
  // Extract inline code so `*`/`[` etc. inside it are not re-interpreted.
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(code);
    return `${CODE_OPEN}${codes.length - 1}${CODE_CLOSE}`;
  });
  // Vault ref chips (@[Title](ref:type/id)).
  s = s.replace(
    /@\[([^\]]+)\]\(ref:([a-z_]+\.[a-z_]+)\/([A-Za-z0-9_-]+)\)/g,
    (_m, label, type, id) =>
      `<button type="button" class="${C.asstRef}" data-ref-type="${type}" data-ref-id="${id}">${label}</button>`,
  );
  // Images ![alt](url) — before links (the leading `!` disambiguates).
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&#34;[^)]*)?\)/g, (_m, alt, url) => {
    const safe = sanitizeUrl(url, true);
    return safe ? `<img class="${C.asstImg}" src="${safe}" alt="${alt}" loading="lazy" />` : alt;
  });
  // Links [text](url).
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&#34;[^)]*)?\)/g, (_m, text, url) => {
    const safe = sanitizeUrl(url, false);
    if (!safe) return text;
    const attrs = /^https?:/i.test(safe) ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<a class="${C.asstA}" href="${safe}"${attrs}>${text}</a>`;
  });
  // Strikethrough, bold, italic.
  s = s.replace(/~~([^~]+)~~/g, `<del class="${C.asstDel}">$1</del>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(>])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // Restore inline code.
  s = s.replace(
    new RegExp(`${CODE_OPEN}(\\d+)${CODE_CLOSE}`, 'g'),
    (_m, i) => `<code>${codes[Number(i)]}</code>`,
  );
  return s;
}

const HR_RE = /^ {0,3}([-*_])( *\1){2,} *$/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** Cells of a pipe-table row, trimmed, outer pipes stripped. */
function tableCells(row) {
  return row
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());
}

/** Is `sep` a table delimiter row (dashes/colons/pipes, at least one dash + pipe/colon)? */
function isTableSep(sep) {
  return sep !== undefined && /-/.test(sep) && /^[\s|:-]+$/.test(sep) && /[|:]/.test(sep);
}

function buildTable(lines, start, C) {
  const header = lines[start];
  const sep = lines[start + 1];
  if (!header || !/\|/.test(header) || !isTableSep(sep)) return null;
  const cols = tableCells(header);
  const aligns = tableCells(sep).map((s) =>
    s.startsWith(':') && s.endsWith(':')
      ? 'center'
      : s.endsWith(':')
        ? 'right'
        : s.startsWith(':')
          ? 'left'
          : '',
  );
  const table = el('table', { class: C.asstTable });
  table.append(
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        cols.map((c, i) =>
          el('th', {
            ...(aligns[i] ? { style: { textAlign: aligns[i] } } : {}),
            trustedHtml: inlineHtml(c, C),
          }),
        ),
      ),
    ),
  );
  const body = el('tbody');
  let i = start + 2;
  for (; i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== ''; i += 1) {
    const cells = tableCells(lines[i]);
    body.append(
      el(
        'tr',
        {},
        cols.map((_c, ci) =>
          el('td', {
            ...(aligns[ci] ? { style: { textAlign: aligns[ci] } } : {}),
            trustedHtml: inlineHtml(cells[ci] ?? '', C),
          }),
        ),
      ),
    );
  }
  table.append(body);
  return { node: el('div', { class: cx(C.asstBlock, C.asstTableWrap) }, table), next: i };
}

/** Build a (possibly nested, mixed ul/ol) list from parsed marker rows. */
function buildList(items, C) {
  let idx = 0;
  const build = (indent) => {
    const ordered = items[idx].ordered;
    const listEl = el(ordered ? 'ol' : 'ul', { class: ordered ? C.asstOl : C.asstUl });
    while (idx < items.length) {
      const it = items[idx];
      if (it.indent < indent) break;
      if (it.indent > indent) {
        const child = build(it.indent);
        (listEl.lastElementChild ?? listEl).append(child);
        continue;
      }
      listEl.append(el('li', { trustedHtml: inlineHtml(it.content, C) }));
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
 * @param {string} text
 * @param {Record<string, string>} C
 * @returns {HTMLElement[]}
 */
export function blockNodes(text, C) {
  const lines = text.split('\n');
  const out = [];
  let para = [];
  const flushPara = () => {
    if (para.length)
      out.push(el('p', { class: C.asstP, trustedHtml: inlineHtml(para.join(' '), C) }));
    para = [];
  };
  for (let i = 0; i < lines.length; ) {
    const line = lines[i].replace(/\s+$/, '');
    if (line.trim() === '') {
      flushPara();
      i += 1;
      continue;
    }
    // Table (header line has a pipe, next line is a delimiter).
    if (/\|/.test(line) && isTableSep(lines[i + 1])) {
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
      out.push(el('hr', { class: C.asstHr }));
      i += 1;
      continue;
    }
    // Heading.
    const heading = line.match(HEADING_RE);
    if (heading) {
      flushPara();
      out.push(
        el(`h${Math.min(heading[1].length + 2, 6)}`, {
          class: C.asstH,
          trustedHtml: inlineHtml(heading[2] ?? '', C),
        }),
      );
      i += 1;
      continue;
    }
    // Blockquote (collect the run, strip one `>`, recurse).
    if (/^\s*>/.test(line)) {
      flushPara();
      const inner = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        inner.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push(el('blockquote', { class: C.asstQuote }, blockNodes(inner.join('\n'), C)));
      continue;
    }
    // List (collect the contiguous run, build nested).
    if (LIST_RE.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length) {
        const mm = lines[i].match(LIST_RE);
        if (!mm) break;
        items.push({ indent: mm[1].length, ordered: /\d/.test(mm[2]), content: mm[3] ?? '' });
        i += 1;
      }
      out.push(buildList(items, C));
      continue;
    }
    // Paragraph line.
    para.push(line.trim());
    i += 1;
  }
  flushPara();
  return out;
}
