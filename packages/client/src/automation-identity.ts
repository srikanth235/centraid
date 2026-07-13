// Pure, DOM-free identity + status logic for automations (Automations
// redesign). Extracted so it is unit-testable; app.ts wraps these in DOM
// builders (`autoGlyphTile` / `auStatusPill` / `triggerBadge`).
//
// Per-automation identity colour + glyph are derived deterministically from
// the automation id — there is no manifest field for them, mirroring how the
// profile avatar defaults a colour by id. Identity is DECORATIVE ONLY: it
// tints the glyph tile, the trigger-hero rail, and status dots. Every CTA /
// active state keeps the single `--accent` action colour.

export const AU_HUES = [
  'indigo',
  'rose',
  'violet',
  'teal',
  'forest',
  'amber',
  'ochre',
  'slate',
] as const;
export type AuHue = (typeof AU_HUES)[number];

// Glyphs that read as "an automation" — picked deterministically per id so an
// automation keeps a stable face across every surface. Every entry is a real
// key in the @centraid/design-tokens icon set.
export const AU_GLYPHS = [
  'Bolt',
  'Clock',
  'Webhook',
  'Bell',
  'Activity',
  'Gauge',
  'Beaker',
  'Cpu',
] as const;
export type AuGlyph = (typeof AU_GLYPHS)[number];

// Stable, order-sensitive string hash (djb2-style, 32-bit). Deterministic
// across runs and platforms so the same id always maps to the same face.
export function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function hueForId(id: string): AuHue {
  return AU_HUES[hashId(id) % AU_HUES.length]!;
}

export function glyphForId(id: string): AuGlyph {
  return AU_GLYPHS[hashId(`${id}#glyph`) % AU_GLYPHS.length]!;
}

export type RowStatus = 'active' | 'paused' | 'draft';

// An automation's lifecycle status: enabled = active; disabled with no runs
// yet = draft (never switched on); disabled but previously run = paused.
export function auStatusForRow(enabled: boolean, hasRun: boolean): RowStatus {
  if (enabled) return 'active';
  return hasRun ? 'paused' : 'draft';
}
