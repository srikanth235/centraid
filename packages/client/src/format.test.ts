import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  escapeHtml,
  tokenize,
  languageHint,
  LANG_DISPLAY,
  slugify,
  generateAppId,
  relativeWhen,
  formatBytes,
  shortVersionTitle,
} from './format.js';

describe('escapeHtml', () => {
  it('escapes the three HTML-significant characters', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href="x"&gt;&amp;&lt;/a&gt;');
  });

  it('escapes ampersands first so entities are not double-escaped wrong', () => {
    expect(escapeHtml('a & b < c')).toBe('a &amp; b &lt; c');
  });

  it('leaves text with no special characters untouched', () => {
    expect(escapeHtml('plain text 123')).toBe('plain text 123');
  });
});

describe('tokenize', () => {
  it('wraps a JS keyword in a tok-key span', () => {
    expect(tokenize('const x = 1', 'js')).toContain('<span class="tok-key">const</span>');
  });

  it('does not leak placeholder control characters into the output', () => {
    const out = tokenize('const s = "hi" // note', 'js');
    // The tokenizer uses U+0001–U+0006 as internal placeholders; none may survive.
    const leaked = [...out].some((ch) => ch.charCodeAt(0) >= 1 && ch.charCodeAt(0) <= 6);
    expect(leaked).toBe(false);
  });

  it('escapes HTML before highlighting so injected markup stays inert', () => {
    const out = tokenize('<script>', 'other');
    expect(out).toBe('&lt;script&gt;');
  });

  it('highlights an HTML tag without eating the attribute name into a class', () => {
    const out = tokenize('<div class="a">', 'html');
    expect(out).toContain('tok-tag');
    expect(out).toContain('tok-attr');
    // The injected span class must not be re-tokenised as an attribute.
    expect(out).not.toContain('tok-attr">tok-');
  });
});

describe('languageHint', () => {
  it.each([
    ['app.ts', 'ts'],
    ['main.js', 'js'],
    ['mod.mjs', 'js'],
    ['index.html', 'html'],
    ['page.htm', 'html'],
    ['styles.css', 'css'],
    ['app.json', 'json'],
    ['README.md', 'md'],
    ['LICENSE', 'other'],
    ['data.csv', 'other'],
  ])('maps %s to %s', (path, lang) => {
    expect(languageHint(path)).toBe(lang);
  });

  it('produces a display label for every language it can return', () => {
    for (const path of ['a.ts', 'a.js', 'a.html', 'a.css', 'a.json', 'a.md', 'a.bin']) {
      expect(LANG_DISPLAY[languageHint(path)]).toBeTruthy();
    }
  });
});

describe('slugify', () => {
  it('lowercases and hyphenates non-alphanumerics', () => {
    expect(slugify('Morning Digest!')).toBe('morning-digest');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('  --Hello--  ')).toBe('hello');
  });

  it('caps the slug at 40 characters', () => {
    expect(slugify('a'.repeat(60)).length).toBe(40);
  });

  it('collapses a run of separators into a single hyphen', () => {
    expect(slugify('a   b___c')).toBe('a-b-c');
  });
});

describe('generateAppId', () => {
  it('combines the slugified seed with a six-char base36 suffix', () => {
    expect(generateAppId('My App')).toMatch(/^my-app-[0-9a-z]{6}$/);
  });

  it('falls back to "app" when the seed slugifies to empty', () => {
    expect(generateAppId('!!!')).toMatch(/^app-[0-9a-z]{6}$/);
  });

  it('is unlikely to collide across calls (random suffix)', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateAppId('x')));
    expect(ids.size).toBeGreaterThan(45);
  });
});

describe('formatBytes', () => {
  it('shows integer bytes below 1 KiB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('shows one decimal of KB up to 1 MiB', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('shows one decimal of MB at and above 1 MiB', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('shortVersionTitle', () => {
  it('prefers an explicit declared version', () => {
    expect(
      shortVersionTitle({ versionId: 'v_2026-05-08T14-30-00-000Z_a1', declaredVersion: '1.2.0' }),
    ).toBe('1.2.0');
  });

  it('parses the embedded date-time out of a generated version id', () => {
    expect(shortVersionTitle({ versionId: 'v_2026-05-08T14-30-00-000Z_a1b2c3' })).toBe(
      '2026-05-08 14-30',
    );
  });

  it('falls back to a 24-char prefix for an unrecognised id', () => {
    expect(shortVersionTitle({ versionId: 'manual-tag-without-timestamp-xyz' })).toBe(
      'manual-tag-without-times',
    );
  });
});

describe('relativeWhen', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const pin = (now: string): void => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
  };

  it('says "Just now" within the last minute', () => {
    pin('2026-06-05T12:00:30Z');
    expect(relativeWhen('2026-06-05T12:00:00Z')).toBe('Just now');
  });

  it('counts whole minutes under an hour', () => {
    pin('2026-06-05T12:45:00Z');
    expect(relativeWhen('2026-06-05T12:00:00Z')).toBe('45m ago');
  });

  it('counts whole hours under a day', () => {
    pin('2026-06-05T20:00:00Z');
    expect(relativeWhen('2026-06-05T12:00:00Z')).toBe('8h ago');
  });

  it('counts whole days under a month', () => {
    pin('2026-06-15T12:00:00Z');
    expect(relativeWhen('2026-06-05T12:00:00Z')).toBe('10d ago');
  });

  it('falls back to a locale date beyond 30 days', () => {
    pin('2026-08-01T12:00:00Z');
    // 30+ days out → not a relative string.
    expect(relativeWhen('2026-06-05T12:00:00Z')).not.toMatch(/ago|Just now/);
  });

  it('renders an unparseable date as the platform "Invalid Date" string', () => {
    // `new Date('not-a-date')` yields NaN rather than throwing, so the parse
    // falls through to `toLocaleDateString()` → "Invalid Date" (the try/catch
    // guards only a genuine throw, which strings never trigger).
    pin('2026-06-05T12:00:00Z');
    expect(relativeWhen('not-a-date')).toBe('Invalid Date');
  });
});
