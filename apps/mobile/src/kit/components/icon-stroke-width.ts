// The stroke-width rule for the shared icon set (packages/design/src/icons.ts's
// own header comment): "the caller sets stroke-width (1.6, 1.75 below 16px)".
// Split into its own module, with no react-native-svg / theme imports, so
// Icon.test.tsx can assert it directly without dragging RN modules into the
// node test environment.
/**
 * A DOT glyph: every segment is a zero-length `h.01` after a moveto, drawn with
 * round caps. `MoreVert` (`M12 6h.01M12 12h.01M12 18h.01`) and `MoreHoriz` are
 * the two in the registry today.
 *
 * Matched on the PATH rather than by name so the rule cannot drift from the
 * registry: any glyph drawn this way earns it, and a glyph that stops being
 * drawn this way loses it.
 */
const DOT_GLYPH = /^(?:M[\d.]+ [\d.]+h\.01)+$/u;

export function isDotGlyph(paths: readonly { d: string }[]): boolean {
  return (
    paths.length > 0 && paths.every((path) => DOT_GLYPH.test(path.d.trim()))
  );
}

/**
 * For a dot glyph the stroke is not a line weight — it IS the dot's diameter,
 * because the segment has no length. The ramp's 1.6 therefore renders a `⋮`
 * as three ~1.2pt specks at a 20px box, which is why the band's More tab and
 * the row's `···` both read as missing rather than quiet. 2.6 viewBox units
 * puts the drawn dot near 2.2pt at the sizes these two are used at.
 */
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
