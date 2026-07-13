import { describe, it, expect } from 'vitest';
import {
  AU_HUES,
  AU_GLYPHS,
  hashId,
  hueForId,
  glyphForId,
  auStatusForRow,
} from './automation-identity.js';

describe('hashId', () => {
  it('is deterministic for the same input', () => {
    expect(hashId('automation-abc123')).toBe(hashId('automation-abc123'));
  });

  it('is order-sensitive (distinct ids generally differ)', () => {
    expect(hashId('ab')).not.toBe(hashId('ba'));
  });

  it('never returns a negative number', () => {
    for (const id of ['', 'z', '~~~', 'automation-zzzzzz', 'a'.repeat(64)]) {
      expect(hashId(id)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('hueForId', () => {
  it('is deterministic and always a known palette hue', () => {
    const id = 'automation-7fa9c2';
    expect(hueForId(id)).toBe(hueForId(id));
    expect(AU_HUES).toContain(hueForId(id));
  });

  it('spreads ids across more than one hue', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) seen.add(hueForId(`automation-${i}`));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('glyphForId', () => {
  it('is deterministic and always a known glyph', () => {
    const id = 'automation-7fa9c2';
    expect(glyphForId(id)).toBe(glyphForId(id));
    expect(AU_GLYPHS).toContain(glyphForId(id));
  });

  it('is decoupled from hue (uses a salted hash)', () => {
    // The glyph derivation salts the id, so it is not just a function of the
    // hue index — collisions between the two derivations should not be total.
    const sameHueDifferentGlyph = Array.from({ length: 50 }, (_, i) => `auto-${i}`).some(
      (id) => AU_HUES.indexOf(hueForId(id)) !== AU_GLYPHS.indexOf(glyphForId(id)),
    );
    expect(sameHueDifferentGlyph).toBe(true);
  });
});

describe('auStatusForRow', () => {
  it('enabled → active regardless of run history', () => {
    expect(auStatusForRow(true, false)).toBe('active');
    expect(auStatusForRow(true, true)).toBe('active');
  });

  it('disabled with no runs → draft', () => {
    expect(auStatusForRow(false, false)).toBe('draft');
  });

  it('disabled with prior runs → paused', () => {
    expect(auStatusForRow(false, true)).toBe('paused');
  });
});
