import { describe, expect, it } from 'vitest';
import { changelogNotesToHtml } from './changelogMarkdown.js';

describe('changelogNotesToHtml', () => {
  it('renders headings as section labels', () => {
    expect(changelogNotesToHtml('### Fixed')).toBe('<h4>Fixed</h4>');
    expect(changelogNotesToHtml('# New')).toBe('<h4>New</h4>');
  });

  it('groups consecutive bullets into one list', () => {
    expect(changelogNotesToHtml('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
  });

  it('separates paragraphs and closes lists on blank lines', () => {
    expect(changelogNotesToHtml('- a\n\nafter')).toBe('<ul><li>a</li></ul><p>after</p>');
  });

  it('renders inline bold, italic, and code', () => {
    expect(changelogNotesToHtml('a **b** _c_ `d`')).toBe(
      '<p>a <strong>b</strong> <em>c</em> <code>d</code></p>',
    );
  });

  it('renders http(s) links with safe rel/target, preserving query separators', () => {
    expect(changelogNotesToHtml('[docs](https://x.dev/p?a=1&b=2)')).toBe(
      '<p><a href="https://x.dev/p?a=1&b=2" target="_blank" rel="noreferrer noopener">docs</a></p>',
    );
  });

  it('escapes raw HTML so injected markup renders as text', () => {
    expect(changelogNotesToHtml('<img src=x onerror=alert(1)>')).toBe(
      '<p>&#60;img src=x onerror=alert(1)&#62;</p>',
    );
  });

  it('does not linkify non-http schemes', () => {
    const html = changelogNotesToHtml('[x](javascript:alert(1))');
    expect(html).not.toContain('<a ');
  });

  it('returns empty string for blank input', () => {
    expect(changelogNotesToHtml('')).toBe('');
    expect(changelogNotesToHtml('\n\n')).toBe('');
  });
});
