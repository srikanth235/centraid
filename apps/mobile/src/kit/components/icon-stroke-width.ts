// The stroke-width rule for the shared icon set (packages/design/src/icons.ts's
// own header comment): "the caller sets stroke-width (1.6, 1.75 below 16px)".
// Split into its own module, with no react-native-svg / theme imports, so
// Icon.test.tsx can assert it directly without dragging RN modules into the
// node test environment.
export function resolveStrokeWidth(size: number, strokeWidth?: number): number {
  if (strokeWidth != null) return strokeWidth;
  return size < 16 ? 1.75 : 1.6;
}
