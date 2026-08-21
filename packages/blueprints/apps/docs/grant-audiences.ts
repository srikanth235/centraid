/**
 * WHAT THE DOCS SEAT MUST HOLD BEFORE IT MAY DRAW SHARE (issue #825).
 *
 * The roster mapping itself is NOT here: `_shared/grant-audiences.ts` owns it
 * for every app and both seats. What is Docs-specific is the contract between
 * this app's frame and its own share entries.
 */

import { ROSTER_UNREADABLE } from "../_shared/grant-audiences.ts";
import type { GrantAudienceRead } from "../_shared/grant-audiences.ts";
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

/** What Docs holds after a roster read, and what it owes the status line. */
export interface DocsRosterAnswer {
  /** What Share may name — `null` while the roster is not an answer at all. */
  audiences: readonly GrantAudienceOption[] | null;
  /** The sentence the app's one status line owes the member, or none. */
  status: string | null;
}

/**
 * THE THREE STATES, KEPT APART (#825). An empty roster is an ANSWER — Docs
 * draws Share and the sheet says "nobody yet" in its own words. A roster that
 * could not be read is not: Docs draws no Share verb, and SAYS why, because a
 * control that quietly vanished teaches a member nothing, and calling a full
 * People directory empty would be a lie the failed read never earned.
 */
export function docsRosterAnswer(read: GrantAudienceRead): DocsRosterAnswer {
  return read.ok
    ? { audiences: read.audiences, status: null }
    : { audiences: null, status: ROSTER_UNREADABLE };
}
