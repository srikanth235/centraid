// Tasks glyphs lower through the shared product icon registry.
import { iconSvg } from "@centraid/design";
import type { IconName } from "@centraid/design";

const glyph = (name: IconName, size: number, strokeWidth = 1.75): string =>
  iconSvg(name, { size, strokeWidth });

export const I = {
  brand: glyph("CheckCircle", 16, 1.9),
  plus: glyph("Plus", 18, 2),
  today: glyph("Clock", 17),
  upcoming: glyph("Calendar", 17),
  anytime: glyph("List", 17),
  inbox: glyph("Archive", 17),
  logbook: glyph("FileEdit", 17),
  close: glyph("X", 18),
  menu: glyph("Menu", 19),
  search: glyph("Search", 16),
  shield: glyph("CheckCircle", 14, 1.6),
  check: glyph("Check", 12, 3.2),
  cancelMark: glyph("X", 11, 2.6),
  empty: glyph("CheckCircle", 26, 1.6),
};
