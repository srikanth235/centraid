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
  /* The rail head's dismiss, at the size a 26px quiet target wants — 18px in
     a 26px box leaves no ground around the mark. */
  closeSm: glyph("X", 15, 1.8),
  chevL: glyph("ChevronLeft", 22, 1.9),
  chevR: glyph("ChevronRight", 22, 1.9),
  // A disclosure points DOWN when it is open — a left-pointing chevron for
  // "expanded" reads as "go back", not "this section is showing".
  chevDown: glyph("ChevronDown", 15, 1.9),
  chevRSmall: glyph("ChevronRight", 15, 1.9),
  plus: glyph("Plus", 13, 2),
  download: glyph("Download", 15),
  // The toolbar's rail toggle (`components/InfoToggle.tsx`) — 17px at 1.7, the
  // handoff's own `infoBtn` geometry.
  info: glyph("Info", 17, 1.7),
};

// The folder row's hover-revealed tools retain their compact geometry while
// sharing the same canonical glyphs.
/**
 * THE KIND GLYPH A ROW WEARS BESIDE A NAME.
 *
 * NEVER A TINTED SQUARE WITH `DOC` / `PDF` / `XLS` STAMPED INSIDE IT.
 * Three capital letters is a filename extension wearing a badge: it repeats
 * what the Kind column already prints one field to the right, it cannot be
 * read at a glance the way a shape can, and it put a coloured chip at the
 * leading edge of every row in the set — the loudest position in the list,
 * spent on the least interesting fact about the document.
 *
 * The handoff draws a LINE GLYPH per kind (`docRowsBlock`'s `paths:
 * DXI[k.icon]`) on no ground at all, and it draws every one of them in the
 * app's own hue rather than a colour per kind. Four glyphs cover its eight
 * kinds, which is the point: a member is being told "page", "picture",
 * "table", "plays", not which of six MIME families the bytes belong to.
 */
export const KIND_ICONS = {
  doc: glyph("FileText", 18, 1.6),
  image: glyph("Image", 18, 1.6),
  sheet: glyph("Table", 18, 1.6),
  media: glyph("Music", 18, 1.6),
  other: glyph("FileText", 18, 1.6),
} as const;

/**
 * THE SAME FOUR SHAPES, AT THE SIZE A THUMBNAIL NEEDS.
 *
 * A card's thumb and the details rail's hero are 104px and 120px boxes; the
 * row's 18px mark disappears in one. They must not hold `DOC` / `PDF` / `XLS`
 * set large on a tinted square: a three-capitals badge here beside a line
 * drawing in the rows is one drive saying "page" two ways depending on which
 * view you are in.
 *
 * The stroke thins to 1.35 as the glyph grows: a 1.6 stroke scaled from 18 to
 * 30 reads as a marker pen, where the row's mark reads as a line drawing.
 */
/** The FOLDER mark at the card's size (the Folders shelf's grid, §4.3).
 *  Deliberately not a member of `KIND_ICONS_LG`: a folder is not a file kind,
 *  and putting it in that table would make `typeMeta` able to return it. */
export const FOLDER_ICON_LG = glyph("Folder", 30, 1.35);

export const KIND_ICONS_LG = {
  doc: glyph("FileText", 30, 1.35),
  image: glyph("Image", 30, 1.35),
  sheet: glyph("Table", 30, 1.35),
  media: glyph("Music", 30, 1.35),
  other: glyph("FileText", 30, 1.35),
} as const;

/**
 * THE ROW MENU'S GLYPHS (the handoff's `menu:[...]` list on `docRowsBlock`,
 * each item `{label, icon}`). Drive's ⋮ is where rename, move, star, history
 * and trash actually live, and the handoff gives every one of them a glyph —
 * a menu where some items carry one and others carry a gap reads as a menu
 * with something missing.
 *
 * 15px at 1.6, which is the size the handoff draws menu glyphs at, and one
 * step down from the row's own kind mark so the menu reads as subordinate to
 * the row it opened from.
 */
export const MENU_ICONS = {
  open: glyph("OpenExternal", 15, 1.6),
  download: glyph("Download", 15, 1.6),
  rename: glyph("Pencil", 15, 1.6),
  move: glyph("Folder", 15, 1.6),
  star: glyph("Star", 15, 1.6),
  history: glyph("History", 15, 1.6),
  details: glyph("Info", 15, 1.6),
  tag: glyph("Tag", 15, 1.6),
  trash: glyph("Trash", 15, 1.6),
} as const;

/**
 * THE PLACE MENU'S GLYPHS (the trailing crumb's `⌄`).
 *
 * Same 15/1.6 as `MENU_ICONS`, because it is the same KIND of surface — a
 * popover of destinations hung off the thing it belongs to — and two popovers
 * in one app drawing their rows at two weights is two menus.
 *
 * A menu of words can only be read; a menu of shapes can be aimed at, and
 * after the second visit a member goes to the lock or the camera without
 * reading the row at all.
 */
export const PLACE_ICONS = {
  newdoc: glyph("Upload", 15, 1.6),
  scan: glyph("Camera", 15, 1.6),
  storage: glyph("Database", 15, 1.6),
  capabilities: glyph("Eye", 15, 1.6),
  filing: glyph("Folder", 15, 1.6),
  names: glyph("Users", 15, 1.6),
  locker: glyph("Lock", 15, 1.6),
} as const;

/** The selection bar's glyphs (the handoff's `selDefs`). 16px — one step up
 *  from a menu row, because these are controls in a bar and not lines in a
 *  list. `restore` is the history arrow, which is the glyph the handoff's own
 *  docs selection bar swaps to in trash. */
export const BULK_ICONS = {
  star: glyph("Star", 16, 1.7),
  move: glyph("Folder", 16, 1.7),
  download: glyph("Download", 16, 1.7),
  trash: glyph("Trash", 16, 1.7),
  restore: glyph("History", 16, 1.7),
} as const;

/**
 * EVERY OTHER VERB IN THE APP, at the `kit-btn` rung.
 *
 * A WORD ALONE IS A THING TO READ; A WORD WITH A SHAPE IS A THING TO
 * RECOGNISE. The row menu and the selection bar and the stage all carried
 * glyphs while the details rail, the trash row, the version list, the upload
 * queue and the folder editors carried bare words — so the SAME verb looked
 * like two different things depending on which region a member met it in, and
 * the regions with words could only be scanned by reading them.
 *
 * ONE SHAPE PER VERB, ACROSS EVERY REGION. `move` is a folder wherever it
 * appears — the row menu, the selection bar, the details rail — because a
 * glyph that means one thing in a menu and another in a drawer teaches nothing
 * the second time. That is what this table is for, and why it sits beside
 * `MENU_ICONS` / `BULK_ICONS` / `STAGE_ICONS` rather than inside a component:
 * the four tables differ ONLY in size, which is a fact about the region, never
 * about the verb.
 *
 * 15px at 1.7: `kit-btn` is a smaller box than a bar control, and a 16px mark
 * beside a 13px label crowds the word it is there to help.
 */
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

/**
 * THE STAGE'S OWN GLYPHS (the handoff's `docsStage` `acts`/`bottomActs`).
 *
 * 18px, which is the size Photos draws its viewer bar at — the two tenants of
 * the one theater ground wear the same weight of mark, so a member who learns
 * the bar in one app has learnt it in the other. The near-black ground is why
 * the stroke stays at 1.75 rather than the 1.6 a row uses: a hairline that is
 * comfortable on paper thins out against `--stage`.
 */
export const STAGE_ICONS = {
  star: glyph("Star", 18),
  download: glyph("Download", 18),
  print: glyph("Print", 18),
  share: glyph("Share", 18),
  info: glyph("Info", 18),
  trash: glyph("Trash", 18),
} as const;
