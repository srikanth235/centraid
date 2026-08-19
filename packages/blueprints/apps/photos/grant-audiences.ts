/**
 * WHO PHOTOS MAY NAME IN A GRANT (issue #825, wave 6).
 *
 * The grant kit draws the sheet; the HOST says who is in the room. That split
 * is deliberate — the roster is People's, not Photos', so this module only
 * turns the roster Photos can already read (`_shared/share-kit.ts`) into the
 * kit's `GrantAudienceOption` and adds nothing of its own.
 *
 * Two rules the mapping enforces, because a grant is addressed to a PARTY and
 * not to a vault:
 *
 *  - A destination with no party id names a vault, not a person, and is
 *    dropped. The grant plane has nobody to address it to.
 *  - A `pending:` party id is an offline overlay no vault has settled
 *    (`isPendingPartyId`), so it names nobody yet. Offering it would record a
 *    grant against an identity that does not exist.
 *
 * An empty answer is a real answer — "there is nobody to share with yet" — and
 * every caller states it rather than drawing an empty picker.
 */

import { useState } from "react";

import {
  grantPlaneAvailable,
  GRANTS_UNAVAILABLE_HERE,
} from "../_shared/grant-gateway.ts";
import type { GrantAudienceOption } from "../_shared/grant-plane.ts";
import {
  isPendingPartyId,
  loadShareCircles,
  loadShareDestinations,
} from "../_shared/share-kit.ts";
import type { ShareCircle, ShareDestination } from "../_shared/share-kit.ts";

/** Why Share cannot even open. Stated on the control, never after the fact. */
export const NOBODY_TO_SHARE_WITH =
  "There is nobody to share with yet — add someone in People first.";

/**
 * Why a multi-selection cannot be shared (v1). A grant stands over ONE subject
 * — one photograph, or one album — and the door records exactly that. Turning
 * a selection of twelve into twelve standing grants would leave a member with
 * twelve rows to revoke one at a time and no object they could point at, so
 * the control refuses in the member's own terms and names the way through: an
 * album IS the shareable many, and a photograph added to it later reaches the
 * same audience with no second gesture.
 */
export const ONE_AT_A_TIME =
  "Sharing stands over one photograph or one album — select a single photograph, or share the album.";

/** People first, then named circles: a person is what a member reaches for. */
export function photoAudiences(
  destinations: readonly ShareDestination[],
  circles: readonly ShareCircle[]
): GrantAudienceOption[] {
  const people = destinations.flatMap<GrantAudienceOption>((destination) =>
    destination.partyId && !isPendingPartyId(destination.partyId)
      ? [{ kind: "party", id: destination.partyId, label: destination.label }]
      : []
  );
  const named = circles.map<GrantAudienceOption>((circle) => ({
    kind: "circle",
    id: circle.circleId,
    label: circle.label,
    memberCount: circle.members.length,
  }));
  return [...people, ...named];
}

/** The roster, live. Never throws: both loaders answer empty on a bad read. */
export async function loadPhotoAudiences(): Promise<GrantAudienceOption[]> {
  const [destinations, circles] = await Promise.all([
    loadShareDestinations(null),
    loadShareCircles(),
  ]);
  return photoAudiences(destinations, circles);
}

/** Photos' one way into the grant sheet, for all three web entries. */
export interface PhotoShareEntry {
  /** Who the sheet may name. Empty until a request has resolved the roster. */
  audiences: GrantAudienceOption[];
  open: boolean;
  /**
   * The member asked to share. The roster is read HERE rather than on mount —
   * a member who adds someone in People and comes back sees them, and no
   * Photos surface holds a roster read it may never need. A refusal is spoken
   * before the sheet opens: an empty picker is not an answer.
   */
  request: () => void;
  close: () => void;
}

export function usePhotoShare(
  /** The frame's one status line — every refusal lands there, never a toast. */
  refuse: (message: string) => void
): PhotoShareEntry {
  const [audiences, setAudiences] = useState<GrantAudienceOption[]>([]);
  const [open, setOpen] = useState(false);
  return {
    audiences,
    open,
    request: () => {
      if (!grantPlaneAvailable()) {
        refuse(GRANTS_UNAVAILABLE_HERE);
        return;
      }
      void loadPhotoAudiences().then((rows) => {
        setAudiences(rows);
        if (rows.length === 0) refuse(NOBODY_TO_SHARE_WITH);
        else setOpen(true);
      });
    },
    close: () => setOpen(false),
  };
}
