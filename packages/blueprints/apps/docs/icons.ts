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
  closeSm: glyph("X", 15, 1.8),
  chevL: glyph("ChevronLeft", 22, 1.9),
  chevR: glyph("ChevronRight", 22, 1.9),
  // A disclosure points DOWN when open; a left chevron reads as "go back".
  chevDown: glyph("ChevronDown", 15, 1.9),
  chevRSmall: glyph("ChevronRight", 15, 1.9),
  plus: glyph("Plus", 13, 2),
  download: glyph("Download", 15),
  info: glyph("Info", 17, 1.7),
};

/** NEVER a tinted `DOC`/`PDF` square: line glyphs in the app's own hue. */
export const KIND_ICONS = {
  doc: glyph("FileText", 18, 1.6),
  image: glyph("Image", 18, 1.6),
  sheet: glyph("Table", 18, 1.6),
  media: glyph("Music", 18, 1.6),
  other: glyph("FileText", 18, 1.6),
} as const;

/** Not in `KIND_ICONS_LG`: a folder is not a file kind. */
export const FOLDER_ICON_LG = glyph("Folder", 30, 1.35);

export const KIND_ICONS_LG = {
  doc: glyph("FileText", 30, 1.35),
  image: glyph("Image", 30, 1.35),
  sheet: glyph("Table", 30, 1.35),
  media: glyph("Music", 30, 1.35),
  other: glyph("FileText", 30, 1.35),
} as const;

/**
 * The row menu's glyphs, as REGISTRY NAMES. Named separately from the rendered
 * SVGs below because `glyph()` returns markup, and a React Native surface can
 * do nothing with markup — the phone's own menu was picking names by hand and
 * had already drifted (a document mark where the web opens with `OpenExternal`).
 * One table, two lowerings.
 */
export const MENU_ICON_NAMES = {
  open: "OpenExternal",
  download: "Download",
  share: "Share",
  rename: "Pencil",
  move: "Folder",
  star: "Star",
  history: "History",
  details: "Info",
  tag: "Tag",
  trash: "Trash",
} as const satisfies Record<string, IconName>;

/** EVERY item carries a glyph: one with a gap reads as a menu missing one. */
export const MENU_ICONS = {
  open: glyph(MENU_ICON_NAMES.open, 15, 1.6),
  download: glyph(MENU_ICON_NAMES.download, 15, 1.6),
  share: glyph(MENU_ICON_NAMES.share, 15, 1.6),
  rename: glyph(MENU_ICON_NAMES.rename, 15, 1.6),
  move: glyph(MENU_ICON_NAMES.move, 15, 1.6),
  star: glyph(MENU_ICON_NAMES.star, 15, 1.6),
  history: glyph(MENU_ICON_NAMES.history, 15, 1.6),
  details: glyph(MENU_ICON_NAMES.details, 15, 1.6),
  tag: glyph(MENU_ICON_NAMES.tag, 15, 1.6),
  trash: glyph(MENU_ICON_NAMES.trash, 15, 1.6),
} as const;

export const PLACE_ICONS = {
  newdoc: glyph("Upload", 15, 1.6),
  scan: glyph("Camera", 15, 1.6),
  storage: glyph("Database", 15, 1.6),
  capabilities: glyph("Eye", 15, 1.6),
  filing: glyph("Folder", 15, 1.6),
  names: glyph("Users", 15, 1.6),
  locker: glyph("Lock", 15, 1.6),
} as const;

export const BULK_ICONS = {
  star: glyph("Star", 16, 1.7),
  move: glyph("Folder", 16, 1.7),
  download: glyph("Download", 16, 1.7),
  trash: glyph("Trash", 16, 1.7),
  restore: glyph("History", 16, 1.7),
} as const;

/** ONE SHAPE PER VERB, ACROSS EVERY REGION. The four tables here differ ONLY
 *  in size — a fact about the region, never about the verb. */
export const ACTION_ICONS = {
  open: glyph("OpenExternal", 15, 1.7),
  download: glyph("Download", 15, 1.7),
  star: glyph("Star", 15, 1.7),
  replace: glyph("Upload", 15, 1.7),
  save: glyph("Save", 15, 1.7),
  share: glyph("Share", 15, 1.7),
  history: glyph("History", 15, 1.7),
  move: glyph("Folder", 15, 1.7),
  trash: glyph("Trash", 15, 1.7),
  restore: glyph("History", 15, 1.7),
  rename: glyph("Pencil", 15, 1.7),
  newFolder: glyph("FolderPlus", 15, 1.7),
  more: glyph("ChevronsDown", 15, 1.7),
  retry: glyph("Refresh", 15, 1.7),
  dismiss: glyph("X", 15, 1.7),
  confirm: glyph("Check", 15, 2),
  cancel: glyph("X", 15, 1.7),
} as const;

export const RENAME_ICON = glyph("Pencil", 14, 1.7);
export const SHARE_ICON = glyph("Share", 14, 1.7);
export const DELETE_ICON = glyph("Trash", 14, 1.7);

/** Stroke stays 1.75: a 1.6 hairline thins out against `--stage`. */
export const STAGE_ICONS = {
  star: glyph("Star", 18),
  download: glyph("Download", 18),
  print: glyph("Print", 18),
  share: glyph("Share", 18),
  info: glyph("Info", 18),
  trash: glyph("Trash", 18),
} as const;
