import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { apps } from '@centraid/design-tokens';
import AppCard from './AppCard.js';

const app = apps[0];
if (!app) {
  throw new Error('design-tokens must ship at least one built-in app');
}

describe('AppCard', () => {
  it('emits the vanilla cd-app-card structure and the app name/blurb', () => {
    const html = renderToStaticMarkup(<AppCard app={app} stamp="2h ago" />);
    expect(html).toContain('class="cd-app-card"');
    expect(html).toContain('data-testid="app-tile"');
    expect(html).toContain(app.name);
    expect(html).toContain('cd-app-card-icon');
    expect(html).toContain('2h ago');
  });

  it('marks the small modifier', () => {
    expect(renderToStaticMarkup(<AppCard app={app} small />)).toContain(
      'cd-app-card cd-app-card--small',
    );
  });

  it('renders a status pill + icon dot for a tone', () => {
    const html = renderToStaticMarkup(<AppCard app={app} tone="draft" />);
    expect(html).toContain('cd-app-card-icon-dot');
    expect(html).toContain('data-tone="draft"');
    expect(html).toContain('cd-status');
  });

  it('falls back to a placeholder blurb when desc is empty', () => {
    const html = renderToStaticMarkup(<AppCard app={{ ...app, desc: '' }} />);
    expect(html).toContain('No description yet.');
  });
});
