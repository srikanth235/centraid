/* oxlint-disable typescript-eslint/ban-ts-comment -- the package tsconfig has no
   DOM lib (blueprints "src" is node-side); this file runs the browser kit under
   jsdom, so DOM globals are runtime-real but invisible to tsc (see kit-smoke.test.ts). */
// @ts-nocheck — exercises the untyped browser kit module under jsdom.
// @vitest-environment jsdom
// Unit tests for the shared assistant rich-answer renderer (issue #420) — the
// ONE renderer both chat surfaces use, so ref-chips + typed blocks are
// identical. Mirrors the React shell's assistantRich.test.ts against the
// canonical kit copy (default class names).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const PKG = path.resolve(import.meta.dirname, '..');
const url = pathToFileURL(path.resolve(PKG, 'kit/assistant-rich.js')).href;
const { richAnswerHtml, hydrateRefs, wireCodeCopy } = await import(url);

describe('richAnswerHtml', () => {
  it('renders prose paragraphs with inline formatting', () => {
    const html = richAnswerHtml('Hello **world** and `code`.');
    expect(html).toContain('asstRich');
    expect(html).toContain('<strong>world</strong>');
    expect(html).toContain('<code>code</code>');
  });

  it('renders bullet lists and headings', () => {
    const html = richAnswerHtml('# Title\n- one\n- two');
    expect(html).toContain('asstH');
    expect(html).toContain('asstUl');
    expect(html.match(/<li>/g)?.length).toBe(2);
  });

  it('renders a ref chip for an entity reference', () => {
    const html = richAnswerHtml('See @[Groceries](ref:home.asset_item/abc123).');
    expect(html).toContain('asstRef');
    expect(html).toContain('data-ref-type="home.asset_item"');
    expect(html).toContain('data-ref-id="abc123"');
    expect(html).toContain('Groceries');
  });

  it('renders a typed table block', () => {
    const spec = JSON.stringify({ columns: ['A', 'B'], rows: [[1, 2]], caption: 'Cap' });
    const html = richAnswerHtml('Before\n```block:table\n' + spec + '\n```\nAfter');
    expect(html).toContain('asstTable');
    expect(html).toContain('<th>A</th>');
    expect(html).toContain('asstCaption');
  });

  it('renders a stat block and a chart block', () => {
    const stat = richAnswerHtml(
      '```block:stat\n' + JSON.stringify({ value: '42', label: 'Total' }) + '\n```',
    );
    expect(stat).toContain('asstStatValue');
    const chart = richAnswerHtml(
      '```block:chart\n' +
        JSON.stringify({ type: 'bar', x: ['a', 'b'], series: [{ values: [1, 2] }] }) +
        '\n```',
    );
    expect(chart).toContain('asstChart');
    expect(chart).toContain('<rect');
  });

  it('renders a malformed block as visible payload, never silent loss', () => {
    const html = richAnswerHtml('```block:table\nnot json\n```');
    expect(html).toContain('asstPre');
    expect(html).toContain('not json');
  });

  it('honors an injected class map (how the React shell passes its CSS module)', () => {
    const html = richAnswerHtml('**bold**', { asstRich: 'x-rich', asstP: 'x-p' });
    expect(html).toContain('x-rich');
    expect(html).toContain('x-p');
    expect(html).not.toContain('asstRich');
  });

  it('wraps a fenced code block with a hover copy button (#420)', () => {
    const html = richAnswerHtml('```\nconst x = 1;\n```');
    expect(html).toContain('asstCodeWrap');
    expect(html).toContain('asstCopyBtn');
    expect(html).toContain('const x = 1;');
  });

  it('syntax-highlights a fenced code block for a known language (#420 W2)', () => {
    const html = richAnswerHtml('```js\nconst x = "hi"; // note\n```');
    expect(html).toContain('hlKeyword'); // const
    expect(html).toContain('hlString'); // "hi"
    expect(html).toContain('hlComment'); // // note
    expect(html).toContain('data-lang="js"');
  });

  it('leaves an unknown-language fence as plain escaped text (#420 W2)', () => {
    const html = richAnswerHtml('```wat\n<b>x</b>\n```');
    expect(html).not.toContain('hlKeyword');
    expect(html).not.toContain('<b>x</b>'); // escaped
    expect(html).toContain('&lt;b&gt;');
  });

  it('renders GFM links, images, ordered/nested lists, blockquote, hr, strike (#420 W2)', () => {
    const html = richAnswerHtml(
      [
        '[docs](https://example.com)',
        '',
        '![pic](/centraid/x.png)',
        '',
        '1. one',
        '2. two',
        '   - nested',
        '',
        '> quoted',
        '',
        '---',
        '',
        '~~gone~~',
      ].join('\n'),
    );
    expect(html).toContain('<a class="asstA" href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('<img class="asstImg" src="/centraid/x.png"');
    expect(html).toContain('<ol');
    expect(html).toContain('<ul'); // nested
    expect(html).toContain('<blockquote');
    expect(html).toContain('<hr');
    expect(html).toContain('<del');
  });

  it('renders a markdown pipe table (#420 W2)', () => {
    const html = richAnswerHtml('| A | B |\n| --- | --- |\n| 1 | 2 |');
    expect(html).toContain('asstTable');
    expect(html).toContain('<th>A</th>');
    expect(html).toContain('<td>1</td>');
  });
});

describe('wireCodeCopy', () => {
  it('copies the code block text to the clipboard on click (#420)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // jsdom has no clipboard by default — inject a minimal stub.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const host = document.createElement('div');
    host.innerHTML = richAnswerHtml('```\nSELECT 1;\n```');
    wireCodeCopy(host);
    const btn = host.querySelector('.asstCopyBtn');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(writeText).toHaveBeenCalledWith('SELECT 1;');
    await Promise.resolve();
    expect(btn.textContent).toBe('Copied');
  });

  it('is idempotent — a second wire does not double-bind', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const host = document.createElement('div');
    host.innerHTML = richAnswerHtml('```\nx\n```');
    wireCodeCopy(host);
    wireCodeCopy(host);
    host.querySelector('.asstCopyBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(writeText).toHaveBeenCalledTimes(1);
  });
});

describe('hydrateRefs', () => {
  it('resolves chips to live card titles via the injected resolver', async () => {
    const host = document.createElement('div');
    host.innerHTML = richAnswerHtml('See @[Placeholder](ref:home.asset_item/abc123).');
    const resolveRefs = vi
      .fn()
      .mockResolvedValue([{ status: 'live', title: 'Groceries', subtitle: 'Home' }]);
    hydrateRefs(host, { resolveRefs });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolveRefs).toHaveBeenCalledWith([{ type: 'home.asset_item', id: 'abc123' }]);
    const chip = host.querySelector('.asstRef');
    expect(chip?.textContent).toBe('Groceries');
    expect(chip?.dataset.resolved).toBe('true');
  });

  it('marks a missing ref rather than silently leaving it', async () => {
    const host = document.createElement('div');
    host.innerHTML = richAnswerHtml('@[X](ref:home.asset_item/gone).');
    hydrateRefs(host, { resolveRefs: vi.fn().mockResolvedValue([{ status: 'missing' }]) });
    await Promise.resolve();
    await Promise.resolve();
    expect(host.querySelector('.asstRef')?.dataset.state).toBe('missing');
  });
});
