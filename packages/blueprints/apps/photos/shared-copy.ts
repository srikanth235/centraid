/**
 * PHOTOS COPY BOTH CLIENTS PRINT — the strings web and native each render
 * verbatim, held in one place so the two surfaces cannot drift on what a
 * shelf says about itself.
 *
 * Deliberately IMPORT-FREE, the same shape as `enrichment-consent.ts`. Native
 * bundles this file straight out of the blueprints package, and the mobile
 * TypeScript project does not enable `allowImportingTsExtensions` or declare
 * CSS modules — so a module native reads must not reach for the web app's
 * explicit-`.ts` graph (`view-copy.ts` → `shelves.ts` → `components/
 * SelectionBar.tsx`), which is browser-native ESM on purpose and stays that
 * way. A leaf with no imports is the only shape that both worlds can read.
 *
 * `view-copy.ts` re-exports everything here, so web callers keep importing
 * from the module they already know and nothing about the web side changes.
 *
 * ONLY the strings native actually renders live here. This is not a second
 * home for Photos copy: the rest of the view copy — the shelf titles, the
 * empty-state table, Storage, Search — stays in `view-copy.ts` beside the
 * shelf ids it is keyed by.
 */

/**
 * The section head a Places group takes when the place it names has no name
 * (§5). It is NOT "Unknown": the vault knows exactly where these were taken,
 * it just has no label to print, and the copy says which of the two is true.
 */
export const PLACE_UNNAMED = "A place with no name yet";

/**
 * The Duplicates shelf's own lede line (§5, proto 4437), with the live
 * cluster count substituted for the prototype's fixed "Six" and the correct
 * grammar for exactly one cluster. Never names the issue that shipped this
 * shelf — an issue id is an implementation detail, not something a member
 * reads (a member-facing string must never print one).
 */
export function duplicatesLede(clusterCount: number): string {
  const noun = clusterCount === 1 ? "cluster" : "clusters";
  return `${clusterCount} ${noun} of near-identical photographs. Selecting a copy marks it for trash; the one you keep stays where it is, in the album and the timeline it is already in.`;
}
