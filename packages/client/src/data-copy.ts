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
