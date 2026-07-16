/* oxlint-disable typescript-eslint/ban-ts-comment -- the package tsconfig has no
   DOM lib (blueprints "src" is node-side); this file runs the browser kit under
   jsdom, so DOM globals are runtime-real but invisible to tsc. */
/* oxlint-disable no-script-url -- the whole point of these tests is to feed the
   renderer dangerous `javascript:` URLs and prove they are rejected. */
// @ts-nocheck — exercises the untyped browser kit module under jsdom.
// @vitest-environment jsdom
// Adversarial sanitization tests for the shared renderer (issue #420, Wave 2).
// Model output is UNTRUSTED and injected via innerHTML / dangerouslySetInnerHTML
// on both chat surfaces — these prove the SECURITY CONTRACT in assistant-rich.js
// holds across the link / image / table / ref-chip / code paths. Every case
// asserts that no live script or dangerous scheme survives into the output.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const PKG = path.resolve(import.meta.dirname, '..');
const url = pathToFileURL(path.resolve(PKG, 'kit/assistant-rich.js')).href;
const { richAnswerHtml } = await import(url);
const gfmUrl = pathToFileURL(path.resolve(PKG, 'kit/gfm.js')).href;
const { sanitizeUrl } = await import(gfmUrl);

/** Render, then assert the DOM carries no executable script / dangerous href. */
function assertInert(html: string): Document {
  const host = document.createElement('div');
  host.innerHTML = html;
  // No script elements, ever.
  expect(host.querySelector('script')).toBeNull();
  // No anchor/image points at a javascript:/data:/vbscript: destination.
  for (const a of host.querySelectorAll('a')) {
    expect(a.getAttribute('href') ?? '').not.toMatch(/^\s*(javascript|data|vbscript):/i);
  }
  for (const img of host.querySelectorAll('img')) {
    expect(img.getAttribute('src') ?? '').not.toMatch(/^\s*(javascript|data|vbscript):/i);
  }
  return host;
}

describe('renderer sanitization — links', () => {
  it('rejects a javascript: link, keeping the label as plain text', () => {
    const html = richAnswerHtml('[click](javascript:alert(1))');
    assertInert(html);
    expect(html).not.toContain('javascript:');
    expect(html).toContain('click');
  });

  it('renders a link whose URL contains whitespace as inert text (no anchor)', () => {
    const html = richAnswerHtml('[x](java\tscript:alert(1))');
    const host = assertInert(html);
    expect(host.querySelector('a')).toBeNull();
  });

  it('rejects a protocol-relative //host link', () => {
    const html = richAnswerHtml('[x](//evil.example)');
    const host = assertInert(html);
    expect(host.querySelector('a')).toBeNull(); // downgraded to text
  });

  it('allows a normal https link with noopener + a relative path', () => {
    const html = richAnswerHtml('[a](https://ok.example) and [b](/centraid/vault)');
    const host = assertInert(html);
    const [a, b] = host.querySelectorAll('a');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(b.getAttribute('href')).toBe('/centraid/vault');
    expect(b.getAttribute('target')).toBeNull(); // relative → no new tab
  });
});

describe('renderer sanitization — images', () => {
  it('rejects a data: image URL, keeping the alt text', () => {
    const html = richAnswerHtml('![alt](data:text/html,<script>alert(1)</script>)');
    const host = assertInert(html);
    expect(host.querySelector('img')).toBeNull();
    expect(html).not.toContain('<script');
  });

  it('cannot break out of the src attribute via a crafted URL', () => {
    const html = richAnswerHtml('![x]("onerror="alert(1) https://ok/a.png)');
    const host = assertInert(html);
    // No img carries an event handler — the crafted quotes are entity-encoded
    // inside the src value, so attribute break-out is impossible.
    expect(host.querySelector('img[onerror]')).toBeNull();
    expect(html).not.toContain('" onerror=');
  });
});

describe('renderer sanitization — tables & ref chips & code', () => {
  it('escapes HTML injected through a markdown table cell', () => {
    const html = richAnswerHtml('| h |\n| --- |\n| <img src=x onerror=alert(1)> |');
    const host = assertInert(html);
    expect(host.querySelector('td img')).toBeNull();
    expect(html).toContain('&lt;img'); // the tag is escaped, inert text
  });

  it('escapes HTML injected through a typed block:table cell', () => {
    const spec = JSON.stringify({ columns: ['<b>c</b>'], rows: [['<script>x</script>']] });
    const html = richAnswerHtml('```block:table\n' + spec + '\n```');
    assertInert(html);
    expect(html).not.toContain('<script>x');
    expect(html).not.toContain('<b>c</b>');
  });

  it('escapes markup smuggled through a ref-chip label', () => {
    const html = richAnswerHtml('@[<img src=x onerror=alert(1)>](ref:home.asset_item/abc)');
    const host = assertInert(html);
    expect(host.querySelector('.asstRef img')).toBeNull();
    expect(html).toContain('&lt;img'); // label escaped, inert text
  });

  it('never executes markup inside a fenced code block', () => {
    const html = richAnswerHtml('```html\n<script>alert(1)</script>\n```');
    assertInert(html);
    expect(html).not.toContain('<script>alert');
  });
});

describe('sanitizeUrl unit', () => {
  it('allowlists http/https/mailto + relative, rejects the rest', () => {
    expect(sanitizeUrl('https://x.io', false)).toBe('https://x.io');
    expect(sanitizeUrl('mailto:a@b.co', false)).toBe('mailto:a@b.co');
    expect(sanitizeUrl('/rel/path', false)).toBe('/rel/path');
    expect(sanitizeUrl('#frag', false)).toBe('#frag');
    expect(sanitizeUrl('javascript:alert(1)', false)).toBeNull();
    expect(sanitizeUrl('data:text/html,x', false)).toBeNull();
    expect(sanitizeUrl('vbscript:x', false)).toBeNull();
    expect(sanitizeUrl('//host', false)).toBeNull();
    // Control-char obfuscation is stripped before scheme detection.
    expect(sanitizeUrl('java' + String.fromCharCode(1) + 'script:x', false)).toBeNull();
    // Images: mailto is not a valid image source.
    expect(sanitizeUrl('mailto:a@b.co', true)).toBeNull();
  });
});
