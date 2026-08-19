/**
 * WHAT THE DOCS SEAT MUST HOLD BEFORE IT MAY DRAW SHARE (issue #825).
 *
 * The roster mapping itself is NOT here: `_shared/grant-audiences.ts` owns it
 * for every app and both seats. What is Docs-specific is the contract between
 * this app's frame and its own share entries.
 */

import type { GrantAudienceOption } from "../_shared/grant-plane.ts";

/**
 * A roster that has been READ (an empty one is "nobody yet"; an unread one is
 * not an answer), and the app's one status line. Absent where this host has no
 * grant plane to reach, so a seat that cannot share offers no affordance
 * rather than a dead button.
 */
export interface DocsShareHost {
  audiences: readonly GrantAudienceOption[];
  onStatus: (message: string) => void;
}
