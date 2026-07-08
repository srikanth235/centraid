import { describe, expect, it } from 'vitest';
import { apps, tileFinish } from '@centraid/design-tokens';
import { tileVisual } from './tile-visual.js';

describe('tileVisual', () => {
  const app = apps[0];
  if (!app) {
    throw new Error('design-tokens must ship at least one built-in app');
  }

  it('carries the app name and glyph through', () => {
    const v = tileVisual(app);
    expect(v.name).toBe(app.name);
    expect(v.iconKey).toBe(app.iconKey);
  });

  it('defaults to the solid finish', () => {
    expect(tileVisual(app).finish).toEqual(tileFinish(app.color, 'solid'));
  });

  it('threads the requested variant to tileFinish', () => {
    expect(tileVisual(app, 'gradient').finish).toEqual(tileFinish(app.color, 'gradient'));
    expect(tileVisual(app, 'glassy').finish.glyphColor).toBe(app.color);
  });
});
