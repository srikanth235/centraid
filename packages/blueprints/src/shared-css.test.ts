import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const packageDir = path.resolve(import.meta.dirname, '..');
const appDir = path.join(packageDir, 'apps');
const systemApps = ['agenda', 'docs', 'locker', 'notes', 'people', 'photos', 'tally', 'tasks'];

describe('shared blueprint CSS', () => {
  it('composes the canonical app shell in all system blueprints', () => {
    for (const app of systemApps) {
      const css = readFileSync(path.join(appDir, app, 'Chrome.module.css'), 'utf8');
      expect(css, `${app}/Chrome.module.css`).toMatch(
        /composes: kit-app-shell(?: [^;]+)? from global;/,
      );
    }
  });

  it('keeps all system-app wall styling in the shared inline layers', () => {
    for (const app of systemApps) {
      expect(existsSync(path.join(appDir, app, 'wall.css')), `${app}/wall.css`).toBe(false);
      expect(existsSync(path.join(appDir, app, 'app.css')), `${app}/app.css`).toBe(false);
    }
    expect(existsSync(path.join(packageDir, 'kit', 'wall.css'))).toBe(false);
    expect(existsSync(path.join(packageDir, 'kit', 'tokens.css'))).toBe(false);
  });

  it('does not reintroduce retired global chrome selectors', () => {
    const retiredSelectors = {
      agenda: ['.ag-shell', '.ag-side', '.ag-topbar'],
      notes: ['.nt-side', '.nt-topbar', '.nt-hamburger'],
      tasks: ['.tk-shell', '.tk-side', '.tk-topbar'],
    };

    for (const [app, selectors] of Object.entries(retiredSelectors)) {
      const css = readFileSync(path.join(appDir, app, 'Chrome.module.css'), 'utf8');
      for (const selector of selectors) {
        expect(css, `${app}/Chrome.module.css contains ${selector}`).not.toContain(selector);
      }
    }
  });

  it('does not ship served React or CSS entrypoints for inline system apps', () => {
    for (const app of systemApps) {
      expect(existsSync(path.join(appDir, app, 'app.tsx')), `${app}/app.tsx`).toBe(false);
      const html = readFileSync(path.join(appDir, app, 'index.html'), 'utf8');
      expect(html, `${app}/index.html`).not.toMatch(/<script|<link rel="stylesheet"/);
    }
  });
});
