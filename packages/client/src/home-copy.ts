// Home's cross-surface copy (issue #708, section A).
//
// Desktop (packages/client/src/react/screens/HomeSpringboard.tsx) and mobile
// (apps/mobile/src/screens/home/FirstRunGrid.tsx) draw the SAME Home in two
// renderers, so a string either surface can show has to have exactly one
// spelling. Before this module there were three first-run texts for one state —
// the brief's, desktop's paraphrase, and mobile's — which is the drift a shared
// constant exists to make impossible.
//
// Why here and not in `@centraid/design`: that package owns visual tokens and
// app metadata, not screen prose. `@centraid/client` is already the module
// boundary the two surfaces share (mobile imports `@centraid/client/capture`
// and `@centraid/client/replica/native`), so this is the narrowest existing
// seam that both can reach without inventing a new package.

/** First run — the vault has no content ANYWHERE. Verbatim from the brief. */
export const HOME_FIRST_RUN_TITLE = "Nothing here yet";

/** The body under it. One sentence about what Home becomes, one about custody. */
export const HOME_FIRST_RUN_BODY =
  "Bring your photographs and documents in and this becomes the front of your own archive. Everything you import stays on this device.";

/**
 * How many dashed placeholders the first-run treatment draws.
 *
 * FOUR, not one-per-installed-app: the placeholders are a picture of what Home
 * will look like, not a checklist of every app you own. Eight of them reads as
 * eight empty tiles, which is the exact thing the treatment replaces.
 */
export const HOME_FIRST_RUN_PLACEHOLDERS = 4;

/** Home's own cross-app search entry point (the third of three; ⌘K and the
 *  stem's Search control are the other two). */
export const HOME_SEARCH_EVERYTHING = "Search everything";
