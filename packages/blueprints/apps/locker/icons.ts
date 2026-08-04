// Locker stores path fragments because Shared.tsx owns the outer SVG size and
// stroke.  The fragments still come from the single product icon registry.
import { iconPathMarkup } from "@centraid/design";
import type { IconName } from "@centraid/design";

const glyph = (name: IconName): string => iconPathMarkup(name);

export const ICON_PATHS: Record<string, string> = {
  lock: glyph("Lock"),
  plus: glyph("Plus"),
  close: glyph("X"),
  menu: glyph("Menu"),
  search: glyph("Search"),
  back: glyph("ArrowLeft"),
  edit: glyph("Pencil"),
  copy: glyph("Copy"),
  eye: glyph("Eye"),
  eyeOff: glyph("EyeOff"),
  regen: glyph("Refresh"),
  trash: glyph("Trash"),
  tag: glyph("Bookmark"),
  starFill: glyph("Star"),
  sun: glyph("Sun"),
  moon: glyph("Moon"),
  all: glyph("Menu"),
  shield: glyph("CheckCircle"),
};

export const CAT_ICON_PATHS: Record<string, string> = {
  login: glyph("Key"),
  card: glyph("Receipt"),
  note: glyph("FileEdit"),
  identity: glyph("AddressBook"),
  password: glyph("MoreHoriz"),
  wifi: glyph("Wifi"),
};
