// Notes glyphs lower through the shared product icon registry.
import { iconSvg } from "@centraid/design";
import type { IconName } from "@centraid/design";

const glyph = (name: IconName, size: number, strokeWidth = 1.75): string =>
  iconSvg(name, { size, strokeWidth });

export const I = {
  brand: glyph("FileEdit", 16, 1.8),
  plus: glyph("Plus", 18, 2),
  plusSm: glyph("Plus", 15, 1.9),
  allNotes: glyph("List", 18),
  pinnedOutline: glyph("Pin", 18, 1.6),
  pinCard: glyph("Pin", 15, 1.7),
  pinCardFilled: glyph("Pin", 15, 1.2),
  close: glyph("X", 18),
  closeSm: glyph("X", 15, 1.9),
  menu: glyph("Menu", 19),
  search: glyph("Search", 17),
  masonry: glyph("Grid", 17),
  list: glyph("List", 17),
  rename: glyph("Pencil", 15, 1.7),
  trash: glyph("Trash", 15, 1.7),
  trashLg: glyph("Trash", 17, 1.7),
  back: glyph("ChevronLeft", 18),
  checklistAdd: glyph("CheckCircle", 17),
  pinEditor: glyph("Pin", 17, 1.7),
  shield: glyph("CheckCircle", 14, 1.6),
  check: glyph("Check", 12, 3),
  empty: glyph("FileEdit", 26, 1.5),
  receipt: glyph("CheckCircle", 15, 1.9),
};
