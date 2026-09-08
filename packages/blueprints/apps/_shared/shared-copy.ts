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

/** The share sheet's outcome: the count, and nothing else. Every audience is
 *  a LINKED person, so there is no half-delivered case to report. */
export function sharedWithOutcome(count: number): string {
  return `Shared with ${count} ${count === 1 ? "person" : "people"}.`;
}

/** The share sheet's failure. What happened; the sheet is still open, which is
 *  what to do. */
export const SHARE_FAILED = "Could not share with the selected people.";

/**
 * SHARING IS A COPY, NOT A LEASE (#996, R10) — said in the sheet, before the
 * decision, because it is the part of a share a person cannot undo by
 * changing their mind afterwards. Ending a share does remove the copy this
 * product placed and does stop updates; what it cannot reach is a copy the
 * recipient took out of their vault, and a sentence that implied otherwise
 * would be the product promising something it has no mechanism for.
 */
export const SHARE_IS_A_COPY =
  "Ending a share removes their copy and stops updates; anything they exported first stays theirs.";

/**
 * EGRESS ANSWERS DO NOT TRAVEL WITH A SHARE (#996, R18). The copy is enriched
 * by the RECEIVING vault under the recipient's own answers — so a sender whose
 * captions are off does not thereby keep them off for the person they shared
 * with, and the sheet says so rather than letting the sender assume it.
 */
export const SHARE_ENRICHMENT_IS_THEIRS =
  "Their vault makes its own thumbnails, text and search for the copy, under their settings.";

/**
 * LEAVING A SHARED VAULT. A member who leaves keeps nothing of the vault
 * itself and loses no copy already placed in their own — the two are different
 * things, and the one question people actually ask is which.
 */
export const LEAVING_SHARED_VAULT =
  "Leaving ends your access to this vault; copies already shared into your own vault stay.";

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

/**
 * THE TRUNCATION LINE, said the same way on every seat (#922 0a).
 *
 * A capped list that says nothing is a wrong screen, not a fast one: the
 * member counts 1,000 contacts and believes that is all they have. This is a
 * StatusLine, so it is one clause (DESIGN.md → Copy) — the number, and the
 * fact that it is not the whole set. No apology and no instruction: there is
 * nothing to tap, and the honest fact is the whole message.
 */
export function truncatedListNotice(appliedLimit: number): string {
  return `Showing the newest ${appliedLimit.toLocaleString("en-US")}; more not loaded`;
}

/**
 * A field this device does not hold, named where a screen reached for it
 * (#922, ruling SB-text).
 *
 * Since 0b, TEXT rides the replica lane in full up to the ceiling its entity
 * declares, so the only fields that reach this line are bytes a column
 * declares lazy and text past a declared ceiling. It is an error string, not
 * reassurance: what happened, and the one thing that changes it. Both clients
 * raise it through `guardReplicaRow`, so the phone and the shell say the same
 * sentence about the same absence.
 */
export function fieldNotOnThisDevice(field: string): string {
  return `${field} is not on this device — open it online.`;
}
