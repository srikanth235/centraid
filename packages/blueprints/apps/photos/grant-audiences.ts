/**
 * PHOTOS' OWN WAY INTO THE GRANT SHEET (#825).
 *
 * The grant kit draws the sheet; the HOST says who is in the room. The roster
 * MAPPING is not Photos' either — `_shared/grant-audiences.ts` owns it for
 * every app and both seats — so what is left here is genuinely Photos': what a
 * multi-selection means, and when the sheet is allowed to open at all.
 */

import { useState } from "react";

import {
  NOBODY_TO_SHARE_WITH,
  readGrantAudiences,
  ROSTER_UNREADABLE,
} from "../_shared/grant-audiences.ts";
import {
  grantPlaneAvailable,
  GRANTS_UNAVAILABLE_HERE,
} from "../_shared/grant-gateway.ts";
import type { GrantAudienceOption } from "../_shared/grant-plane.ts";

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

/** Photos' one way into the grant sheet, for all three web entries. */
export interface PhotoShareEntry {
  /** Who the sheet may name. Empty until a request has resolved the roster. */
  audiences: GrantAudienceOption[];
  open: boolean;
  /**
   * The member asked to share. The roster is read HERE rather than on mount —
   * a member who adds someone in People and comes back sees them, and no
   * Photos surface holds a roster read it may never need. A refusal is spoken
   * before the sheet opens: an empty picker is not an answer, and neither is
   * "you know nobody" when the truth is that the read failed.
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
      void readGrantAudiences().then((read) => {
        // A roster that could not be read is NOT an empty roster: the member
        // is told the read failed, not that they know nobody.
        if (!read.ok) {
          refuse(ROSTER_UNREADABLE);
          return;
        }
        setAudiences(read.audiences);
        if (read.audiences.length === 0) refuse(NOBODY_TO_SHARE_WITH);
        else setOpen(true);
      });
    },
    close: () => setOpen(false),
  };
}
