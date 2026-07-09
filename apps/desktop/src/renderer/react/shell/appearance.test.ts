import { describe, expect, it } from 'vitest';
import { ACCENT_PALETTE } from '../../app-shell-context.js';
import {
  applyPrefsToDocument,
  DEFAULT_PREFS,
  pickAppearance,
  toRemoteShape,
} from './appearance.js';

describe('appearance prefs', () => {
  it('picks only recognised keys off a remote object', () => {
    const got = pickAppearance({
      theme: 'dark',
      density: 'comfy',
      cards: 'elevated',
      coolCast: false,
      accentKey: 'rose',
      bogus: 'nope',
      density2: 'x',
    });
    expect(got).toEqual({
      theme: 'dark',
      density: 'comfy',
      cardVariant: 'elevated',
      coolBlueCast: false,
      accent: 'rose',
    });
  });

  it('rejects invalid union values', () => {
    expect(pickAppearance({ density: 'huge', cards: 'shiny', accentKey: 'chartreuse' })).toEqual({});
  });

  it('falls back to the legacy `accent` key when `accentKey` is absent', () => {
    expect(pickAppearance({ accent: 'teal' })).toEqual({ accent: 'teal' });
  });

  it('emits both the accent key and its resolved swatches to the wire', () => {
    const wire = toRemoteShape({ accent: 'violet' });
    expect(wire.accentKey).toBe('violet');
    expect(wire.accent).toBe(ACCENT_PALETTE.violet.accent);
    expect(wire.accentLight).toBe(ACCENT_PALETTE.violet.light);
    expect(wire.accentDeep).toBe(ACCENT_PALETTE.violet.deep);
  });

  it('maps cardVariant → cards on the wire', () => {
    expect(toRemoteShape({ cardVariant: 'flat' })).toEqual({ cards: 'flat' });
  });

  it('round-trips a full pref set through wire → pick', () => {
    const wire = toRemoteShape(DEFAULT_PREFS);
    const back = pickAppearance(wire);
    expect(back).toMatchObject({
      theme: DEFAULT_PREFS.theme,
      density: DEFAULT_PREFS.density,
      cardVariant: DEFAULT_PREFS.cardVariant,
      coolBlueCast: DEFAULT_PREFS.coolBlueCast,
      accent: DEFAULT_PREFS.accent,
    });
  });

  it('writes prefs onto <html> as data-attrs + CSS vars', () => {
    applyPrefsToDocument({ ...DEFAULT_PREFS, theme: 'light', density: 'compact', accent: 'ochre' });
    const html = document.documentElement;
    expect(html.dataset.theme).toBe('light');
    expect(html.dataset.density).toBe('compact');
    expect(html.style.getPropertyValue('--accent')).toBe(ACCENT_PALETTE.ochre.accent);
  });
});
