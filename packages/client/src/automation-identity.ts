export const AU_HUES = [
  "indigo",
  "rose",
  "violet",
  "teal",
  "forest",
  "amber",
  "ochre",
  "slate",
] as const;
export type AuHue = (typeof AU_HUES)[number];

export const AU_GLYPHS = [
  "Bolt",
  "Clock",
  "Webhook",
  "Bell",
  "Activity",
  "Gauge",
  "Beaker",
  "Cpu",
] as const;
export type AuGlyph = (typeof AU_GLYPHS)[number];

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

export type RowStatus = "active" | "paused" | "draft";

export function auStatusForRow(enabled: boolean, hasRun: boolean): RowStatus {
  if (enabled) return "active";
  return hasRun ? "paused" : "draft";
}
