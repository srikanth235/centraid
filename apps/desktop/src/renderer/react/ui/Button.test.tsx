import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import Button from './Button.js';

describe('Button', () => {
  it('emits the vanilla cd-btn classes for the variant', () => {
    const html = renderToStaticMarkup(<Button label="Save" variant="primary" />);
    expect(html).toContain('class="cd-btn cd-btn-primary"');
    expect(html).toContain('Save');
    expect(html).toContain('type="button"');
  });

  it('supports soft and ghost variants', () => {
    expect(renderToStaticMarkup(<Button label="x" variant="soft" />)).toContain('cd-btn-soft');
    expect(renderToStaticMarkup(<Button label="x" variant="ghost" />)).toContain('cd-btn-ghost');
  });

  it('defaults to the primary variant', () => {
    expect(renderToStaticMarkup(<Button label="x" />)).toContain('cd-btn-primary');
  });

  it('renders a leading icon svg when an icon is given', () => {
    const html = renderToStaticMarkup(<Button label="Run" icon="Bolt" />);
    expect(html).toContain('<svg');
  });

  it('reflects the disabled attribute', () => {
    expect(renderToStaticMarkup(<Button label="x" disabled />)).toContain('disabled');
  });

  it('appends a caller className', () => {
    expect(renderToStaticMarkup(<Button label="x" className="wide" />)).toContain(
      'class="cd-btn cd-btn-primary wide"',
    );
  });
});
