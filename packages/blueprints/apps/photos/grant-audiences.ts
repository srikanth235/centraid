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

export const ONE_AT_A_TIME =
  "Sharing stands over one photograph or one album — select a single photograph, or share the album.";

export interface PhotoShareEntry {
  audiences: GrantAudienceOption[];
  open: boolean;
  request: () => void;
  close: () => void;
}

export function usePhotoShare(
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
