// Atlas' cross-surface copy (issue #805, slice C).
//
// The vault census is drawn by `react/screens/AtlasScreen.tsx` +
// `AtlasKindsSection.tsx` on desktop and by `screens/data/Data.tsx` on mobile,
// which is why "Data" and "Atlas" both appear in the tree: the place is Atlas,
// the mobile route is Data, and the words are one set.

export const ATLAS_EMPTY_TITLE = "This vault is empty";

/**
 * The empty body — one sentence (DESIGN.md → Copy). The dropped half,
 * "Nothing is created until an app or an import puts something in", restated
 * the first clause as an absence.
 */
export const ATLAS_EMPTY_BODY = "Kinds appear here as apps write records.";

/**
 * The rule this page explains once, in the words the design brief pinned.
 * One sentence now: the sizes clause is a dependent fact about kinds, not a
 * second thought.
 */
export const ATLAS_KINDS_NOTE =
  "A kind is a shape of record an app writes; sizes include every version kept.";

/** The "Export a kind" row's one line. An export is a file this device writes
 *  — not a share, and not a thing that leaves anything behind on the gateway. */
export const ATLAS_EXPORT_ROW =
  "A file this device writes, in pages of records.";

/**
 * "Who can reach it" — the Vault surface's second question (v11).
 *
 * The section is three POINTERS and no copies, and this is the sentence that
 * says why. It is a consent disclosure, which is one of the three places
 * DESIGN.md § Copy allows full sentences.
 */
export const ATLAS_REACH_NOTE = "Consent is answered where it is asked.";

/** The half of the same disclosure that names the one place this page cannot
 *  point at, kept as its own line so neither sentence has to carry both. */
export const ATLAS_REACH_SUB =
  "A grant an app holds over its own data lives in that app’s consent pane.";
