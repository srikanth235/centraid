// People glyphs lower through the shared product icon registry.
import { iconSvg } from "@centraid/design";
import type { IconName } from "@centraid/design";

const glyph = (name: IconName, size: number, strokeWidth = 1.75): string =>
  iconSvg(name, { size, strokeWidth });

export const I = {
  addPerson: glyph("CirclePlus", 17),
  circlePlus: glyph("CirclePlus", 17),
  people: glyph("Users", 18),
  clock: glyph("Clock", 18),
  bell: glyph("Bell", 18),
  star: glyph("Star", 18),
  journal: glyph("Book", 18),
  activity: glyph("Activity", 18),
  rename: glyph("Pencil", 14, 1.7),
  del: glyph("Trash", 14, 1.7),
  check: glyph("Check", 12, 3),
  checkTask: glyph("Check", 12, 2.6),
  dots: glyph("MoreVert", 17),
  close: glyph("X", 18),
  message: glyph("EnvelopeSimple", 15),
  call: glyph("Phone", 15),
  phone: glyph("Phone", 15, 1.6),
  mail: glyph("EnvelopeSimple", 15, 1.6),
  bellSm: glyph("Bell", 15),
  gift: glyph("Gift", 17, 1.6),
  plus: glyph("Plus", 16, 1.9),
};
