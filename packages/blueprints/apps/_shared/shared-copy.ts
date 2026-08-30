/**
 * COPY BOTH CLIENTS PRINT, for the shared app machinery (#805).
 *
 * Deliberately IMPORT-FREE, like `apps/photos/shared-copy.ts`: native bundles
 * this file straight out of the blueprints package, and the mobile TypeScript
 * project neither enables `allowImportingTsExtensions` nor declares CSS
 * modules. A leaf with no imports is the only shape both worlds can read.
 *
 * ONLY strings both the `_shared` components and the mobile kit render: not a
 * second home for component copy.
 */

/**
 * Retaining a shared item into your own vault, done.
 *
 * A toast is a fragment (DESIGN.md → Copy) — never "Saved to my vault. This
 * copy survives if the share ends.", a sentence about custody arriving after
 * the decision, where it cannot change one.
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

/**
 * The denied-vault banner's title, said the same way by every app's chrome.
 *
 * A banner is one sentence: the state, plus one action (DESIGN.md → Copy). The
 * state is this line, the action is the grant button beside it, and nothing
 * else belongs. One home, so app chromes cannot drift (#883).
 */
export const VAULT_DENIED_TITLE = "No vault access yet.";

/** A rate-limited retry, in seconds. */
export function retryInSeconds(seconds: number): string {
  return `Try again in ${seconds} seconds.`;
}
