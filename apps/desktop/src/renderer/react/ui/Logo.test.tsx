import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import Logo from './Logo.js';

describe('Logo', () => {
  it('draws the three-arc + core-dot mark at the given size', () => {
    const html = renderToStaticMarkup(<Logo size={48} />);
    expect(html).toContain('viewBox="0 0 240 240"');
    expect(html).toContain('width="48"');
    expect(html).toContain('<circle');
    // three arcs
    expect(html.match(/<path/g)?.length).toBe(3);
  });

  it('defaults to size 32', () => {
    expect(renderToStaticMarkup(<Logo />)).toContain('width="32"');
  });
});
