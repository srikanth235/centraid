import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../gateway-client.js', () => ({ resolveAssistantRefs: vi.fn() }));

import { richAnswerHtml } from './assistantRich.js';

describe('richAnswerHtml', () => {
  it('renders prose paragraphs with inline formatting', () => {
    const html = richAnswerHtml('Hello **world** and `code`.');
    expect(html).toContain('cd-asst-rich');
    expect(html).toContain('<strong>world</strong>');
    expect(html).toContain('<code>code</code>');
  });

  it('renders bullet lists and headings', () => {
    const html = richAnswerHtml('# Title\n- one\n- two');
    expect(html).toContain('cd-asst-h');
    expect(html).toContain('cd-asst-ul');
    expect(html.match(/<li>/g)?.length).toBe(2);
  });

  it('renders a ref chip for an entity reference', () => {
    const html = richAnswerHtml('See @[Groceries](ref:home.asset_item/abc123).');
    expect(html).toContain('cd-asst-ref');
    expect(html).toContain('data-ref-type="home.asset_item"');
    expect(html).toContain('data-ref-id="abc123"');
    expect(html).toContain('Groceries');
  });

  it('renders a typed table block', () => {
    const spec = JSON.stringify({ columns: ['A', 'B'], rows: [[1, 2]], caption: 'Cap' });
    const html = richAnswerHtml('Before\n```block:table\n' + spec + '\n```\nAfter');
    expect(html).toContain('cd-asst-table');
    expect(html).toContain('<th>A</th>');
    expect(html).toContain('cd-asst-caption');
  });

  it('renders a stat block and a chart block', () => {
    const stat = richAnswerHtml('```block:stat\n' + JSON.stringify({ value: '42', label: 'Total' }) + '\n```');
    expect(stat).toContain('cd-asst-stat-value');
    const chart = richAnswerHtml(
      '```block:chart\n' + JSON.stringify({ type: 'bar', x: ['a', 'b'], series: [{ values: [1, 2] }] }) + '\n```',
    );
    expect(chart).toContain('cd-asst-chart');
    expect(chart).toContain('<rect');
  });

  it('renders a malformed block as visible payload, never silent loss', () => {
    const html = richAnswerHtml('```block:table\nnot json\n```');
    expect(html).toContain('cd-asst-pre');
    expect(html).toContain('not json');
  });
});
