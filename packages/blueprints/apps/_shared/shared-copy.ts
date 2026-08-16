/**
 * COPY BOTH CLIENTS PRINT, for the shared app machinery (issue #805).
 *
 * The same shape and the same reason as `apps/photos/shared-copy.ts`:
 * deliberately IMPORT-FREE, because native bundles this file straight out of
 * the blueprints package and the mobile TypeScript project neither enables
 * `allowImportingTsExtensions` nor declares CSS modules. A leaf with no
 * imports is the only shape both worlds can read.
 *
 * What lives here is the copy the `_shared` components say and the mobile kit
 * re-implements verbatim — the share sheet's outcomes, the save-to-vault
 * outcome Photos and Docs both post, the rate-limit line. ONLY strings both
 * surfaces render: this is not a second home for component copy.
 */

/**
 * Retaining a shared item into your own vault, done.
 *
 * A toast is a fragment (DESIGN.md → Copy). It used to be "Saved to my vault.
 * This copy survives if the share ends." — a sentence about custody arriving
 * after the decision, where it cannot change one. Docs' viewer had drifted to
 * "This copy stays if the share ends", which is what two homes for one string
 * produces.
 */
export const SAVED_TO_MY_VAULT = "Saved to my vault";

/** The share sheet's outcome when some of the chosen people have no vault
 *  yet: the count, and what happens to the invitations. */
export function sharedWithOutcome(count: number, invited: number): string {
  return invited
    ? `Shared with ${count} people; ${invited} ${invited === 1 ? "is" : "are"} invited and will join after creating a vault.`
    : `Shared with ${count} ${count === 1 ? "person" : "people"}.`;
}

/** The share sheet's failure. What happened; the sheet is still open, which is
 *  what to do. */
export const SHARE_FAILED = "Could not share with the selected people.";

/** A rate-limited retry, in seconds. */
export function retryInSeconds(seconds: number): string {
  return `Try again in ${seconds} seconds.`;
}
