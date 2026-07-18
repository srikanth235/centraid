// Pure, JSX-free helpers: markdown-lite body parsing (headings/bullets/
// checklists), preview flattening, text-highlight segments and a
// deterministic notebook dot color. No app state, no vault IO — every
// function is a plain projection of its arguments so app.tsx and the
// components can both call them without a circular import. Mirrors the
// shape of tasks/format.js.

// ---------- Body parsing (shared by the card preview and the editor) ----------
// Markdown-lite: `#`/`##`/`###` headings, `- `/`* `/`1. ` lists, `- [ ]`/
// `- [x]` checklists, everything else a paragraph. Inline `**bold**`/
// `*italic*`/`` `code` `` syntax is stripped rather than styled — this reads
// exactly like the v2 reference prototype's own renderer, and it keeps body
// rendering to safe text nodes only (no HTML parsing of note content).

/** One parsed markdown-lite block — a discriminated union on `kind`. */
export type Block =
  | { kind: 'check'; checked: boolean; text: string; line: number }
  | { kind: 'h'; level: number; text: string; line: number }
  | { kind: 'li'; text: string; line: number }
  | { kind: 'gap'; line: number }
  | { kind: 'p'; text: string; line: number };

/** One highlight segment — a run of text either matched (`hit`) or plain. */
export interface Segment {
  text: string;
  hit: boolean;
}

export function parseBlocks(body: unknown): Block[] {
  const out: Block[] = [];
  String(body ?? '')
    .split('\n')
    .forEach((line, i) => {
      let m = /^\s*[-*] \[( |x|X)\]\s?(.*)$/.exec(line);
      if (m) {
        out.push({ kind: 'check', checked: /x/i.test(m[1]!), text: m[2]!, line: i });
        return;
      }
      m = /^(#{1,3})\s+(.*)$/.exec(line);
      if (m) {
        out.push({ kind: 'h', level: m[1]!.length, text: m[2]!, line: i });
        return;
      }
      m = /^\s*[-*]\s+(.*)$/.exec(line);
      if (m) {
        out.push({ kind: 'li', text: m[1]!, line: i });
        return;
      }
      m = /^\s*\d+\.\s+(.*)$/.exec(line);
      if (m) {
        out.push({ kind: 'li', text: m[1]!, line: i });
        return;
      }
      if (line.trim() === '') {
        out.push({ kind: 'gap', line: i });
        return;
      }
      out.push({ kind: 'p', text: line, line: i });
    });
  return out;
}

export function stripInline(text: unknown): string {
  return String(text ?? '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1');
}

/** Open/total checkbox count across a body — drives the card progress bar
 * and the sidebar's "open checklist items" tally. */
export function checkStats(body: unknown): { total: number; done: number } {
  const boxes = parseBlocks(body).filter((b) => b.kind === 'check');
  return { total: boxes.length, done: boxes.filter((b) => b.checked).length };
}

/** Flatten a body into a short card preview: checklist items become ☐/☑,
 * bullets become •, headings are dropped (the title already carries that
 * weight), everything else is a line of stripped text. */
export function previewText(body: unknown): string {
  return parseBlocks(body)
    .filter((b) => b.kind !== 'gap' && b.kind !== 'h')
    .slice(0, 6)
    .map((b) => {
      const t = stripInline('text' in b ? b.text : '');
      if (b.kind === 'check') return (b.checked ? '☑ ' : '☐ ') + t;
      if (b.kind === 'li') return '• ' + t;
      return t;
    })
    .join('\n');
}

// Quick-add and the editor's autosave derive a title from the body's first
// line when none was typed — a note never loses its name.
export function deriveTitle(title: unknown, body: unknown): string {
  const typed = String(title ?? '').trim();
  if (typed) return typed;
  const firstLine = String(body ?? '')
    .split('\n')
    .find((l) => l.trim());
  return firstLine ? firstLine.trim().slice(0, 80) : '';
}

// ---------- Text highlight segments (title + card preview + search) ----------

/** Case-insensitive substring highlight of `text` against `term` — returns
 * `[{ text, hit }]` segments a component turns into plain text / <mark>. */
export function highlightSegments(text: unknown, term: unknown): Segment[] {
  const str = String(text ?? '');
  const needle = String(term ?? '').trim();
  if (!needle) return [{ text: str, hit: false }];
  const low = str.toLowerCase();
  const lowNeedle = needle.toLowerCase();
  const segments: Segment[] = [];
  let i = 0;
  let idx = low.indexOf(lowNeedle);
  while (idx !== -1) {
    if (idx > i) segments.push({ text: str.slice(i, idx), hit: false });
    segments.push({ text: str.slice(idx, idx + needle.length), hit: true });
    i = idx + needle.length;
    idx = low.indexOf(lowNeedle, i);
  }
  if (i < str.length) segments.push({ text: str.slice(i), hit: false });
  return segments;
}

/** Split a vault FTS `⟦hit⟧`-marked snippet into `[{ text, hit }]` segments. */
export function snippetSegments(snippet: unknown): Segment[] {
  const parts = String(snippet ?? '').split(/[⟦⟧]/);
  return parts.map((text, i) => ({ text, hit: i % 2 === 1 })).filter((s) => s.text !== '');
}

// ---------- Notebook dot color ----------
// The library query's notebooks carry no color of their own (core.collection
// has none) — a small stable hash into the app-icon palette gives every
// notebook a fixed, deterministic dot without inventing vault state.

const DOT_PALETTE = ['--c-indigo', '--c-teal', '--c-violet', '--c-rose', '--c-ochre', '--c-slate'];

export function notebookColorVar(notebookId: unknown): string {
  const id = String(notebookId ?? '');
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `var(${DOT_PALETTE[h % DOT_PALETTE.length]!})`;
}
