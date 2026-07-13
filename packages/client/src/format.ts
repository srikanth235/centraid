// Pure formatting + string helpers for the renderer, extracted from the builder
// god-file so they can be unit-tested in isolation (TESTING.md §2 — "extract
// logic, then test it"). Nothing here touches the DOM, `window`, the network,
// or IPC: every function is a deterministic value→value transform (the only
// ambient inputs are `Date`/`Math.random`, which callers/tests can pin).

/** The code languages the builder's Code view knows how to syntax-highlight. */
export type CodeLang = 'html' | 'js' | 'ts' | 'css' | 'json' | 'md' | 'other';

/** Escape the three HTML-significant characters so source text renders inert. */
export function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Span classes for each syntax-token kind, supplied by the caller (the Code
 * view passes its CSS-module locals so the emitted HTML stays scoped). */
export interface TokenClasses {
  tag: string;
  attr: string;
  str: string;
  key: string;
  com: string;
}

/** Default classes — the unscoped `tok-*` names, kept for tests/plain hosts. */
export const DEFAULT_TOKEN_CLASSES: TokenClasses = {
  attr: 'tok-attr',
  com: 'tok-com',
  key: 'tok-key',
  str: 'tok-str',
  tag: 'tok-tag',
};

/**
 * Minimal, dependency-free syntax highlighter for the Code view. Returns HTML
 * with per-kind span classes (`classes`, defaulting to `tok-*`). Each pass
 * wraps tokens in placeholder control chars (not real `<span>`s) so a later
 * regex can't match the literal text of an earlier injection — e.g.
 * `\s[\w-]+=` eating the ` class=` inside an inserted span. Placeholders are
 * swapped to spans only at the very end.
 */
export function tokenize(
  src: string,
  lang: CodeLang,
  classes: TokenClasses = DEFAULT_TOKEN_CLASSES,
): string {
  const TAG = '\x01';
  const ATTR = '\x02';
  const STR = '\x03';
  const KEY = '\x04';
  const COM = '\x05';
  const END = '\x06';
  let html = escapeHtml(src);
  if (lang === 'html') {
    html = html
      .replaceAll(/(&lt;\/?[\w-]+)/g, `${TAG}$1${END}`)
      .replaceAll(/(\s[\w-]+)=/g, `${ATTR}$1${END}=`)
      .replaceAll(/("[^"]*")/g, `${STR}$1${END}`);
  } else if (lang === 'js' || lang === 'ts') {
    html = html
      .replaceAll(/\/\/[^\n]*/g, (m) => `${COM}${m}${END}`)
      .replaceAll(
        /\b(const|let|var|function|return|if|else|for|new|try|catch|throw|async|await|export|import|from|type|interface|class|extends|implements|satisfies)\b/g,
        `${KEY}$1${END}`,
      )
      .replaceAll(/('[^']*'|"[^"]*"|`[^`]*`)/g, `${STR}$1${END}`);
  } else if (lang === 'css') {
    html = html
      .replaceAll(/(\/\*[\s\S]*?\*\/)/g, `${COM}$1${END}`)
      .replaceAll(/(--[\w-]+)/g, `${KEY}$1${END}`)
      .replaceAll(/(#[0-9a-f]{3,8}|\d+px|\d+%)/g, `${STR}$1${END}`);
  } else if (lang === 'json') {
    html = html
      .replaceAll(/("[^"]*")(\s*:)/g, `${ATTR}$1${END}$2`)
      .replaceAll(/:\s*("[^"]*")/g, `: ${STR}$1${END}`)
      .replaceAll(/\b(true|false|null)\b/g, `${KEY}$1${END}`);
  }
  return html
    .replaceAll(TAG, `<span class="${classes.tag}">`)
    .replaceAll(ATTR, `<span class="${classes.attr}">`)
    .replaceAll(STR, `<span class="${classes.str}">`)
    .replaceAll(KEY, `<span class="${classes.key}">`)
    .replaceAll(COM, `<span class="${classes.com}">`)
    .replaceAll(END, '</span>');
}

/** Map a file path to the language used for syntax highlighting + the pill. */
export function languageHint(p: string): CodeLang {
  if (p.endsWith('.ts')) return 'ts';
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'js';
  if (p.endsWith('.html') || p.endsWith('.htm')) return 'html';
  if (p.endsWith('.css')) return 'css';
  if (p.endsWith('.json')) return 'json';
  if (p.endsWith('.md')) return 'md';
  return 'other';
}

/**
 * Per-language label shown in the colored pill next to a filename in the Code
 * view. Kept tiny + uppercase to read as metadata, not a brand mark.
 */
export const LANG_DISPLAY: Record<CodeLang, string> = {
  html: 'HTML',
  js: 'JS',
  ts: 'TS',
  css: 'CSS',
  json: 'JSON',
  md: 'MD',
  other: 'TXT',
};

/** Lowercase, hyphenate, and cap at 40 chars — the app-id slug grammar. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** A slug seed plus a short random suffix, e.g. `morning-digest-a1b2c3`. */
export function generateAppId(seed: string): string {
  const slug = slugify(seed) || 'app';
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${slug}-${suffix}`;
}

/** Coarse "Just now / Nm / Nh / Nd ago", falling back to a locale date. */
export function relativeWhen(iso: string): string {
  try {
    const t = new Date(iso).getTime();
    const ms = Date.now() - t;
    const s = Math.floor(ms / 1000);
    if (s < 60) return 'Just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d ago`;
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

/** Human byte size with one decimal at KB/MB/GB/TB, integer bytes below 1 KiB.
 *  Steps all the way to TB (issue #367's Storage card shows quota-scale
 *  figures, not just app-log-scale ones) — behavior below 1 MB is unchanged
 *  from the original KB/MB-only helper. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * A short title for a published version: its declared semver if present, else
 * the date-time parsed out of the generated `v_<iso>_<sha>` id, else a prefix.
 */
export function shortVersionTitle(v: { versionId: string; declaredVersion?: string }): string {
  if (v.declaredVersion) return v.declaredVersion;
  // versionId looks like v_2026-05-08T14-30-00-000Z_a1b2c3
  const m = /v_(\d{4}-\d{2}-\d{2}T\d{2}-\d{2})-/.exec(v.versionId);
  return m ? m[1]!.replace('T', ' ') : v.versionId.slice(0, 24);
}
