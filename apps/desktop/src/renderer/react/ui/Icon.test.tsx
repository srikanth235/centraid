import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { IconName } from '@centraid/design-tokens';
import Icon from './Icon.js';

describe('Icon', () => {
  it('emits a 24-viewBox svg inheriting currentColor by default', () => {
    const html = renderToStaticMarkup(<Icon name="Bolt" />);
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('<path');
  });

  it('honors size and strokeWidth', () => {
    const html = renderToStaticMarkup(<Icon name="Bolt" size={40} strokeWidth={2} />);
    expect(html).toContain('width="40"');
    expect(html).toContain('height="40"');
    expect(html).toContain('stroke-width="2"');
  });

  it('applies an explicit color to the stroke', () => {
    expect(renderToStaticMarkup(<Icon name="Bolt" color="#ff0000" />)).toContain(
      'stroke="#ff0000"',
    );
  });

  it('renders nothing for an unknown glyph', () => {
    expect(renderToStaticMarkup(<Icon name={'NotAGlyph' as IconName} />)).toBe('');
  });
});
