import { describe, expect, it, vi } from 'vitest';
import { richAnswerHtml } from './assistantRich.js';

// `vi.mock` is hoisted above the import by vitest, so the stub lands first.
vi.mock('../../../gateway-client.js', () => ({ resolveAssistantRefs: vi.fn() }));

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
    const stat = richAnswerHtml('```block:stat\n' + JSON.stringify({ value: '42', label: 'Total' }) + '\n```');
    expect(stat).toContain('asstStatValue');
    const chart = richAnswerHtml(
      '```block:chart\n' + JSON.stringify({ type: 'bar', x: ['a', 'b'], series: [{ values: [1, 2] }] }) + '\n```',
    );
    expect(chart).toContain('asstChart');
    expect(chart).toContain('<rect');
  });

  it('renders a malformed block as visible payload, never silent loss', () => {
    const html = richAnswerHtml('```block:table\nnot json\n```');
    expect(html).toContain('asstPre');
    expect(html).toContain('not json');
  });
});
