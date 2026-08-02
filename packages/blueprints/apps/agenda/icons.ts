// Agenda glyphs lower through the product icon registry.  The app keeps its
// local names for call-site readability; artwork, stroke grammar, and SVG
// serialization live in @centraid/design.
import { iconSvg } from "@centraid/design";
import type { IconName } from "@centraid/design";

const glyph = (name: IconName, size: number, strokeWidth = 1.75): string =>
  iconSvg(name, { size, strokeWidth });

export const I = {
  brand: glyph("CalendarBlank", 16, 1.9),
  plus: glyph("Plus", 18, 2),
  chevronLeft: glyph("ChevronLeft", 18, 1.8),
  chevronRight: glyph("ChevronRight", 18, 1.8),
  miniLeft: glyph("ChevronLeft", 15, 1.9),
  miniRight: glyph("ChevronRight", 15, 1.9),
  close: glyph("X", 18),
  menu: glyph("Menu", 19),
  search: glyph("Search", 16),
  shield: glyph("CheckCircle", 14, 1.6),
  check: glyph("Check", 12, 3.2),
  maybe: glyph("AlertCircle", 11, 3),
  decline: glyph("X", 11, 3),
  empty: glyph("CheckCircle", 26, 1.6),
  attach: glyph("Paperclip", 15),
  repeat: glyph("Repeat", 12, 2.2),
  video: glyph("Video", 15, 1.8),
};
