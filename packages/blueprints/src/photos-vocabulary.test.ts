// Vocabulary guard for the Photos app (issue #599). A multi-scope app mounts
// over the member's own scope AND shared audience scopes, so app-facing copy
// speaks of scopes by their human label ("Library", "Family") — the storage
// noun "vault" must never reach a user-visible string.
//
// HOW THE SCAN TELLS APP-FACING COPY FROM CODE. Two filters, both deliberately
// simple enough to reason about:
//
//  1. Comments are removed first, by a quote-aware state machine (single,
//     double and template strings are tracked so a `//` inside a string, e.g.
//     a URL, is not mistaken for a comment). Design notes and file headers
//     therefore say "vault" as often as they need to.
//  2. What survives is code + string literals + JSX text, and the offence
//     regex requires the word to be WHITESPACE- OR EDGE-bounded:
//     `(^|\s)vault(\s|punctuation|$)`. Prose ("your vault", "the vault.")
//     matches; a dotted member expression never does, because `ctx.vault.read`
//     puts a `.` immediately before the word. Same for `vaultDenied` and
//     `VAULT_CONSENT`, where the neighbouring character is a word character
//     and even a plain `\bvault\b` would not fire.
//
// The scan covers the app's `.ts`/`.tsx`/`.html` sources — the only files that
// can render text. `app.json` is excluded on purpose: its descriptions are the
// machine-readable contract read by handlers and agents, and the gallery copy
// users actually see comes from the blueprint index, not from there.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PHOTOS_DIR = path.resolve(import.meta.dirname, '../apps/photos');
const SCANNED = new Set(['.ts', '.tsx', '.html']);

/** Every scannable source file under the Photos app, repo-relative. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (SCANNED.has(path.extname(entry.name))) acc.push(full);
  }
  return acc;
}

/** Drop `<!-- -->`, `/* *\/` and `//` comments; keep string contents intact. */
function stripComments(source: string): string {
  const withoutHtml = source.replace(/<!--[\s\S]*?-->/g, ' ');
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < withoutHtml.length; i += 1) {
    const ch = withoutHtml[i]!;
    const next = withoutHtml[i + 1];
    if (quote) {
      if (ch === '\\') {
        out += ch + (next ?? '');
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      out += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < withoutHtml.length && withoutHtml[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < withoutHtml.length && !(withoutHtml[i] === '*' && withoutHtml[i + 1] === '/')) {
        i += 1;
      }
      i += 1;
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

/** The word as a user would read it: whitespace/edge bounded, not `x.vault`. */
const OFFENCE = /(^|[\s>({[])vault(?=[\s.,!;:?'’"”)\]}<-]|$)/gim;

function offences(source: string): string[] {
  const stripped = stripComments(source);
  const hits: string[] = [];
  for (const line of stripped.split('\n')) {
    OFFENCE.lastIndex = 0;
    if (OFFENCE.test(line)) hits.push(line.trim());
  }
  return hits;
}

describe('Photos app vocabulary (#599)', () => {
  it('scans a non-trivial number of Photos sources', () => {
    expect(sourceFiles(PHOTOS_DIR).length).toBeGreaterThan(20);
  });

  it('never shows the storage noun in user-visible copy', () => {
    const found: string[] = [];
    for (const file of sourceFiles(PHOTOS_DIR)) {
      for (const line of offences(fs.readFileSync(file, 'utf8'))) {
        found.push(`${path.relative(PHOTOS_DIR, file)}: ${line}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('distinguishes code and comments from prose', () => {
    // Code: the read API is a dotted member expression, never prose.
    expect(offences("await ctx.vault.read({ entity: 'media.media_asset' })")).toEqual([]);
    expect(offences('const denied = data?.vaultDenied;')).toEqual([]);
    expect(offences("if (e.code === 'VAULT_CONSENT') return;")).toEqual([]);
    // Comments: stripped before the scan, in both comment forms.
    expect(offences('// the vault owns the meaning here')).toEqual([]);
    expect(offences('/* a projection of your vault */')).toEqual([]);
    expect(offences('<!-- your vault, rendered -->')).toEqual([]);
    // A `//` inside a string is not a comment, so the prose after it is scanned.
    expect(offences("const help = 'https://x/y — see your vault';")).toHaveLength(1);
    // Prose: string literal and JSX text alike.
    expect(offences("const tag = 'a projection of your vault';")).toHaveLength(1);
    expect(offences('<div>Uploaded to your vault</div>')).toHaveLength(1);
    expect(offences('<p>Turned off for this vault. Turn it on.</p>')).toHaveLength(1);
    expect(offences('<strong>Vault</strong>')).toHaveLength(1);
  });
});
