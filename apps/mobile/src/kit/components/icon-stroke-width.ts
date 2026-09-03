const DOT_GLYPH = /^(?:M[\d.]+ [\d.]+h\.01)+$/u;

export function isDotGlyph(paths: readonly { d: string }[]): boolean {
  return (
    paths.length > 0 && paths.every((path) => DOT_GLYPH.test(path.d.trim()))
  );
}

export const DOT_GLYPH_STROKE = 2.6;

export function resolveStrokeWidth(
  size: number,
  strokeWidth?: number,
  paths?: readonly { d: string }[]
): number {
  if (strokeWidth != null) return strokeWidth;
  if (paths && isDotGlyph(paths)) return DOT_GLYPH_STROKE;
  return size < 16 ? 1.75 : 1.6;
}
