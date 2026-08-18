// What ONE DOCUMENT's own screens say (Docs spec §6.2, §7, §8): the version
// screen's fold, the details rail's tabs and notes, and the stage's actions
// and properties panel.
//
// The third copy module, split from `view-copy.ts` on the same axis the app is
// split on: a shelf is a set of rows, and these screens are about one row.
// Nothing here knows what a shelf is.
//
// TWO SECTIONS LEFT THIS FILE WITH THE SCREENS THEY SPOKE FOR. §6.3's seven
// write outcomes (`DSAVE`) and §6.1's reading-view rows (`READ_OFF`,
// `THIS_DOCUMENT`, `MACHINE_SUMMARY_EYEBROW`) were the copy of the in-place
// EDITOR and the reading ROUTE. Docs no longer edits a document of any kind —
// a new version arrives as a whole file through Replace — and text is read on
// the stage's paper sheet, so both screens are gone and their words with
// them.

// ---------------------------------------------------------------------------
// Versions (§6.2) and the details rail (§8)
// ---------------------------------------------------------------------------

/** §6.2 folds Activity INTO the version history, and says so. */
export const VERSIONS_ACTIVITY_HEAD = "Activity";
export const VERSIONS_ACTIVITY_META = "folded in here, deliberately";
/** Activity was CUT as its own screen: what happened to a document and which
 *  version it produced are one spine, so the history carries both. That
 *  rationale is a design fact, not a sentence a member standing on the screen
 *  needs; what they need is what the third column means. */
export const VERSIONS_CUT_NOTE =
  "The third column records whether a member, an app or a machine did it.";

/** §8's three tabs. One rail answers all three former screens: "All three
 *  answer 'what is this row', so they belong beside the row and not three
 *  screens away from it." (§8, verbatim.) */
export const RAIL_TABS = [
  { id: "props", label: "Properties" },
  { id: "facts", label: "Facts" },
  { id: "names", label: "Names" },
] as const;

export type RailTabId = (typeof RAIL_TABS)[number]["id"];

/** The notes §8 hangs off individual rows — each one a RULE, so each one is
 *  the spec's own sentence rather than a paraphrase. */
export const RAIL_NOTES = {
  folder: "a label on the document, not a place it sits",
  owner: "this document is in your own space",
  namesOff: "Docs has not looked. One consent, running on this device",
  cannotRender:
    "nothing has been converted. Docs holds it, versions it and files it, and hands the file to an app that reads this kind",
  duplicateBytes:
    "One copy of the bytes, and every app that points at it points at the same copy.",
  footer: "Select another row and the rail follows it.",
} as const;

/** §8's trailing row for a kind Docs cannot show (§10.1's `render` column). */
export function cannotRenderFact(kindName: string): string {
  return `Docs cannot render ${kindName}`;
}

// ---------------------------------------------------------------------------
// The stage (§7's `docsStage`)
// ---------------------------------------------------------------------------

/**
 * The stage's action names, in the handoff's own order: Star, Download,
 * Print, Place…, Properties, More. They are named here rather than inline so
 * the bar and the phone's bottom row cannot drift on what a verb is called —
 * the same rule Photos' `ACTION_LABELS` keeps for the same two arrangements.
 *
 * `Place…` carries its ellipsis because it opens a sheet and asks; every other
 * name is a verb that fires. `More` is NOT in the table: the handoff's mobile
 * bar draws it over a dead handler, and this stage gives the phone the five
 * actions in a bottom bar instead of hiding them behind a menu that would then
 * have to be built.
 */
export const STAGE_ACTIONS = {
  star: "Star",
  starred: "Starred",
  download: "Download",
  print: "Print",
  place: "Place…",
  properties: "Properties",
  trash: "Trash",
  close: "Close",
} as const;

/**
 * Why Print cannot fire, per kind — on the control, never in a toast (§6).
 *
 * PRINTING IS A LAYOUT, AND THE QUESTION IS WHO DOES IT. A picture and text are
 * laid onto a sheet by Docs, so Docs prints both. A PDF is laid out by the
 * browser's own viewer inside the stage's frame, and that viewer carries its
 * own print control — so the outer button says whose job it is instead of
 * drawing a second one that could not drive the inner document. Sound and
 * moving pictures have no sheet at all.
 */
export const PRINT_REFUSALS = {
  embeddedViewer:
    "A PDF opens in its own viewer here, and that viewer owns its printing.",
  timeBased: "Sound and moving pictures do not print.",
  unrendered:
    "Docs cannot render this kind on this device, so it cannot lay it onto a sheet.",
} as const;

/**
 * The stage's properties panel (§7's `vMeaning`). Each note is the handoff's
 * own sentence — a note explains what the value MEANS, which is the whole
 * reason the panel is not just the facts list twice.
 *
 * THREE OF THE HANDOFF'S ROWS ARE NOT DRAWN, and each is withheld because the
 * read behind it does not exist on this surface:
 *   * `Who this document names` — no read on this seat returns the people a
 *     document mentions; the details rail's Names tab already says Docs has
 *     not looked, and a second copy of that sentence on the stage would be a
 *     panel apologising twice.
 *   * `Where it is` — the drive projection carries no scope, so the panel
 *     cannot name the space a document is in or who can reach it.
 *   * `A refused write` — the stage has no write that can be refused. The
 *     row appears in the editor, which is where the seven outcomes land.
 */
export const STAGE_PROPS = {
  head: "Properties",
  title: "Title",
  titleHint: "rename this document",
  folder: "Folder",
  folderNote: "a label on this document · move it and nothing else changes",
  tags: "Tags",
  tagsEmpty: "none yet",
  device: "On this device",
  deviceNote: "where the bytes are, as the vault last swept them",
  deviceUnknown: "not swept yet",
  facts: "Facts",
  origin:
    "The document is identity; the bytes are content, deduplicated on the vault. Another document may hold these same bytes, so releasing this copy would not remove them.",
} as const;
