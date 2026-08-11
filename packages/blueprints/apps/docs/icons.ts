// Docs glyphs lower through the shared product icon registry.
import { iconSvg } from "@centraid/design";
import type { IconName } from "@centraid/design";

const glyph = (name: IconName, size: number, strokeWidth = 1.75): string =>
  iconSvg(name, { size, strokeWidth });

export const I = {
  folder: glyph("Folder", 18, 1.6),
  clock: glyph("Clock", 18),
  star: glyph("Star", 18),
  allDocs: glyph("Folder", 18),
  trash: glyph("Trash", 18, 1.6),
  upload: glyph("Upload", 17),
  folderPlus: glyph("FolderPlus", 17),
  check: glyph("Check", 12, 3),
  dots: glyph("MoreVert", 17),
  close: glyph("X", 18),
  chevL: glyph("ChevronLeft", 22, 1.9),
  chevR: glyph("ChevronRight", 22, 1.9),
  // A disclosure points DOWN when it is open — a left-pointing chevron for
  // "expanded" reads as "go back", not "this section is showing".
  chevDown: glyph("ChevronDown", 15, 1.9),
  chevRSmall: glyph("ChevronRight", 15, 1.9),
  plus: glyph("Plus", 13, 2),
  download: glyph("Download", 15),
};

// The folder row's hover-revealed tools retain their compact geometry while
// sharing the same canonical glyphs.
export const RENAME_ICON = glyph("Pencil", 14, 1.7);
export const SHARE_ICON = glyph("Share", 14, 1.7);
export const DELETE_ICON = glyph("Trash", 14, 1.7);
