// @ts-nocheck — exercises the untyped browser kit module (pure string→string).
// Unit tests for the dependency-free fenced-code highlighter (issue #420, W2).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const PKG = path.resolve(import.meta.dirname, '..');
const url = pathToFileURL(path.resolve(PKG, 'kit/code-highlight.js')).href;
const { highlightCode, configFor } = await import(url);

describe('highlightCode', () => {
  it('returns null for an unknown language (graceful plain fallback)', () => {
    expect(highlightCode('whatever', 'brainfuck')).toBeNull();
    expect(highlightCode('x', '')).toBeNull();
    expect(configFor('nope')).toBeNull();
  });

  it('tags keywords, strings, comments, numbers for js', () => {
    const out = highlightCode('const n = 42; // c\nlet s = "hi";', 'js');
    expect(out).toContain('<span class="hlKeyword">const</span>');
    expect(out).toContain('<span class="hlNumber">42</span>');
    expect(out).toContain('<span class="hlComment">// c</span>');
    expect(out).toContain('<span class="hlString">&#34;hi&#34;</span>');
  });

  it('matches sql keywords case-insensitively and -- comments', () => {
    const out = highlightCode('SELECT * FROM t -- note\nwhere id = 1', 'sql');
    expect(out).toContain('<span class="hlKeyword">SELECT</span>');
    expect(out).toContain('<span class="hlKeyword">where</span>');
    expect(out).toContain('<span class="hlComment">-- note</span>');
  });

  it('handles python # comments and triple-quoted strings', () => {
    const out = highlightCode('def f():\n    """doc"""\n    return 1  # ok', 'python');
    expect(out).toContain('<span class="hlKeyword">def</span>');
    expect(out).toContain('<span class="hlString">&#34;&#34;&#34;doc&#34;&#34;&#34;</span>');
    expect(out).toContain('<span class="hlComment"># ok</span>');
  });

  it('highlights shell $variables and keywords', () => {
    const out = highlightCode('if true; then echo $HOME; fi', 'bash');
    expect(out).toContain('<span class="hlKeyword">if</span>');
    expect(out).toContain('<span class="hlBuiltin">$HOME</span>');
  });

  it('escapes every source character (no markup injection)', () => {
    const out = highlightCode('const x = "<script>";', 'js');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&#60;script&#62;');
  });

  it('preserves textContent equality for round-trip copy', () => {
    const src = 'function go() { return `a${b}c`; } // done';
    const out = highlightCode(src, 'ts');
    // Strip the span tags — the remaining text (entities decoded) is the source.
    const stripped = out
      .replace(/<[^>]+>/g, '')
      .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));
    expect(stripped).toBe(src);
  });
});
