import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import Button, { IconButton } from './Button.js';

// Vitest's `classNameStrategy: 'non-scoped'` returns the module-local names
// (`styles.btn` → 'btn'), so these assertions match the authored classes.

describe('Button', () => {
  it('emits the module classes for the variant', () => {
    const html = renderToStaticMarkup(<Button label="Save" variant="primary" />);
    expect(html).toContain('class="btn primary"');
    expect(html).toContain('Save');
    expect(html).toContain('type="button"');
  });

  it('supports solid, soft and ghost variants', () => {
    expect(renderToStaticMarkup(<Button label="x" variant="solid" />)).toContain('class="btn"');
    expect(renderToStaticMarkup(<Button label="x" variant="soft" />)).toContain('soft');
    expect(renderToStaticMarkup(<Button label="x" variant="ghost" />)).toContain('ghost');
  });

  it('defaults to the primary variant', () => {
    expect(renderToStaticMarkup(<Button label="x" />)).toContain('primary');
  });

  it('supports the compact and chrome sizes', () => {
    expect(renderToStaticMarkup(<Button label="x" size="sm" />)).toContain('btn sm');
    expect(renderToStaticMarkup(<Button label="x" size="chrome" />)).toContain('chrome primary');
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
      'class="btn primary wide"',
    );
  });

  it('prefers children over label', () => {
    expect(renderToStaticMarkup(<Button label="a">b</Button>)).toContain('>b<');
  });
});

describe('IconButton', () => {
  it('renders an icon-only square with an aria-label', () => {
    const html = renderToStaticMarkup(<IconButton icon="Bolt" ariaLabel="Run" />);
    expect(html).toContain('class="icon"');
    expect(html).toContain('aria-label="Run"');
    expect(html).toContain('<svg');
  });
});
