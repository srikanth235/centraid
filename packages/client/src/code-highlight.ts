// Dependency-free fenced-code syntax highlighter (#420). A tiny
// hand-rolled scanner with no npm dependency. The rich-answer renderer
// (assistant-rich.ts) calls it from its code-block path.
//
// SECURITY: the scanner is escape-by-default. Every character of the source is
// emitted through `esc()` (HTML-escaped) and the ONLY markup it ever adds is a
// fixed set of `<span class="hl…">` wrappers with static class names. Untrusted
// model code can never inject markup. `highlightCode` returns HTML whose
// `textContent` equals the original source, so the copy button still works.
//
// Coverage: js/ts/jsx/tsx, json, python, sql, bash/shell, html, css, rust, go.
// An unknown language returns `null` — the caller falls back to a plain,
// escaped `<pre>` (graceful degradation, never a throw).

/** Internal scanner config for one language (opaque to callers). */
export interface HighlightLangConfig {
  line?: string;
  block?: readonly [string, string];
  strings?: string;
  kw: ReadonlySet<string>;
  ci?: boolean;
  dollar?: boolean;
  triple?: boolean;
}

/** HTML-escape one string (same policy as gfm.ts's `escapeHtml`). */
function esc(s: string): string {
  return String(s).replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);
}

const KW = (s: string): ReadonlySet<string> =>
  new Set(s.split(/\s+/u).filter(Boolean));

const JS_KW =
  KW(`await break case catch class const continue debugger default delete do else
  export extends finally for function if import in instanceof let new return super switch this
  throw try typeof var void while with yield async of as from static get set
  interface type enum namespace declare implements private public protected readonly abstract
  true false null undefined NaN Infinity`);
const PY_KW =
  KW(`False None True and as assert async await break class continue def del elif
  else except finally for from global if import in is lambda nonlocal not or pass raise return
  try while with yield match case self`);
const SQL_KW =
  KW(`select from where insert into values update set delete create table drop alter
  add column index view join inner left right outer full on group by order having limit offset
  distinct union all as and or not null is in like between exists count sum avg min max case when
  then else end asc desc primary key foreign references default unique constraint begin commit
  rollback transaction with returning`);
const SH_KW =
  KW(`if then else elif fi for while do done case esac in function select until
  return break continue local export readonly declare echo cd exit set unset source alias`);
const RS_KW =
  KW(`as break const continue crate dyn else enum extern false fn for if impl in let
  loop match mod move mut pub ref return self Self static struct super trait true type unsafe use
  where while async await where`);
const GO_KW =
  KW(`break case chan const continue default defer else fallthrough for func go goto
  if import interface map package range return select struct switch type var true false nil iota`);
const CSS_KW = KW("");

/**
 * Per-language scanner config. `line`/`block` are comment markers, `strings`
 * the string delimiters, `kw` the keyword set, `ci` case-insensitivity for the
 * keyword match (SQL), `dollar` a shell `$VAR` pass.
 */
const LANGS: Record<string, HighlightLangConfig | undefined> = {
  js: { line: "//", block: ["/*", "*/"], strings: `"'\``, kw: JS_KW },
  json: { strings: '"', kw: KW("true false null") },
  python: { line: "#", strings: `"'`, kw: PY_KW, triple: true },
  sql: { line: "--", block: ["/*", "*/"], strings: `'`, kw: SQL_KW, ci: true },
  bash: { line: "#", strings: `"'`, kw: SH_KW, dollar: true },
  html: { block: ["<!--", "-->"], strings: `"'`, kw: CSS_KW },
  css: { block: ["/*", "*/"], strings: `"'`, kw: CSS_KW },
  rust: { line: "//", block: ["/*", "*/"], strings: `"`, kw: RS_KW },
  go: { line: "//", block: ["/*", "*/"], strings: `"\``, kw: GO_KW },
};

/** Alias map → canonical config key. Unknown languages resolve to `undefined`. */
const ALIAS: Record<string, string | undefined> = {
  js: "js",
  javascript: "js",
  ts: "js",
  typescript: "js",
  jsx: "js",
  tsx: "js",
  mjs: "js",
  cjs: "js",
  json: "json",
  json5: "json",
  py: "python",
  python: "python",
  sql: "sql",
  psql: "sql",
  mysql: "sql",
  sqlite: "sql",
  sh: "bash",
  bash: "bash",
  shell: "bash",
  zsh: "bash",
  html: "html",
  xml: "html",
  svg: "html",
  css: "css",
  scss: "css",
  rust: "rust",
  rs: "rust",
  go: "go",
  golang: "go",
};

/** Resolve a fenced-code language tag to a scanner config, or null when unknown. */
export function configFor(
  lang: string | undefined
): HighlightLangConfig | null {
  const key = ALIAS[String(lang || "").toLowerCase()];
  return key ? (LANGS[key] ?? null) : null;
}

const isIdentStart = (c: string): boolean => /[A-Za-z_$]/u.test(c);
const isIdent = (c: string): boolean => /[\w$]/u.test(c);
const isDigit = (c: string): boolean => c >= "0" && c <= "9";

/**
 * Highlight `code` for a known `lang` as an HTML string (escaped text + `hl…`
 * spans), or `null` when the language is unknown so the caller can fall back to
 * a plain escaped `<pre>`. Escape-by-default; never throws.
 */
export function highlightCode(code: string, lang?: string): string | null {
  const cfg = configFor(lang);
  if (!cfg) return null;
  const src = String(code);
  const n = src.length;
  let out = "";
  let i = 0;
  const span = (cls: string, text: string): string =>
    `<span class="${cls}">${esc(text)}</span>`;
  const matchAt = (tok: string): boolean => src.startsWith(tok, i);

  while (i < n) {
    const c = src.charAt(i);
    // Comments — line then block.
    if (cfg.line && matchAt(cfg.line)) {
      let j = src.indexOf("\n", i);
      if (j < 0) j = n;
      out += span("hlComment", src.slice(i, j));
      i = j;
      continue;
    }
    if (cfg.block && matchAt(cfg.block[0])) {
      const [open, close] = cfg.block;
      let j = src.indexOf(close, i + open.length);
      j = j < 0 ? n : j + close.length;
      out += span("hlComment", src.slice(i, j));
      i = j;
      continue;
    }
    // Strings — including python triple-quotes and escape-aware single/double.
    if (cfg.strings && cfg.strings.includes(c)) {
      const triple = cfg.triple && src.startsWith(c + c + c, i);
      const delim = triple ? c + c + c : c;
      let j = i + delim.length;
      while (j < n) {
        if (!triple && src.charAt(j) === "\\") {
          j += 2;
          continue;
        }
        if (src.startsWith(delim, j)) {
          j += delim.length;
          break;
        }
        if (!triple && src.charAt(j) === "\n") break;
        j += 1;
      }
      out += span("hlString", src.slice(i, Math.min(j, n)));
      i = Math.min(j, n);
      continue;
    }
    // Shell variables ($VAR / ${VAR}).
    if (
      cfg.dollar &&
      c === "$" &&
      i + 1 < n &&
      /[A-Za-z_{]/u.test(src.charAt(i + 1))
    ) {
      let j = i + 1;
      if (src.charAt(j) === "{") {
        const close = src.indexOf("}", j);
        j = close < 0 ? n : close + 1;
      } else while (j < n && isIdent(src.charAt(j))) j += 1;
      out += span("hlBuiltin", src.slice(i, j));
      i = j;
      continue;
    }
    // Numbers (leading digit; a dotted/hex/exponent run).
    if (isDigit(c) || (c === "." && isDigit(src.charAt(i + 1)))) {
      let j = i;
      while (j < n && /[0-9a-fA-FxXbBoO._+-]/u.test(src.charAt(j))) {
        // Stop a trailing sign unless it's an exponent.
        if (
          (src.charAt(j) === "+" || src.charAt(j) === "-") &&
          !/[eE]/u.test(src.charAt(j - 1))
        )
          break;
        j += 1;
      }
      out += span("hlNumber", src.slice(i, j));
      i = j;
      continue;
    }
    // Identifiers / keywords.
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdent(src.charAt(j))) j += 1;
      const word = src.slice(i, j);
      const probe = cfg.ci ? word.toLowerCase() : word;
      out += cfg.kw.has(probe) ? span("hlKeyword", word) : esc(word);
      i = j;
      continue;
    }
    // Anything else — one escaped char.
    out += esc(c);
    i += 1;
  }
  return out;
}
