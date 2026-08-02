// Tally glyphs lower through the shared product icon registry.
import { iconSvg } from "@centraid/design";
import type { IconName } from "@centraid/design";

const glyph = (name: IconName, size: number, strokeWidth = 1.75): string =>
  iconSvg(name, { size, strokeWidth });

export const I: Record<string, string> = {
  dashboard: glyph("Grid", 18),
  activity: glyph("Activity", 18),
  check: glyph("Check", 12, 3),
};
