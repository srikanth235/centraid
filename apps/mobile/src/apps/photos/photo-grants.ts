// PHOTOS' WAY INTO THE GRANT SHEET, native seat (issue #825, wave 6).
//
// The kit draws the sheet and owns the whole write door; the HOST says who is
// in the room and where an outcome is spoken. That is all this module is.
//
// The mapping itself is NOT restated here: `photoAudiences` is the blueprint
// law both seats read (`apps/photos/grant-audiences.ts`), so "a grant is
// addressed to a party, never to a vault, and never to a `pending:` overlay
// id" is decided once for the phone and the desktop together. What native
// genuinely supplies differently is only where the roster comes from —
// replica queries plus the gateway's link list, exactly as the commons sheet
// reads them.

import { useEffect, useMemo, useState } from "react";

import type { GrantAudienceOption } from "@centraid/blueprints/apps/_shared/grant-plane";
import {
  NOBODY_TO_SHARE_WITH,
  photoAudiences,
} from "@centraid/blueprints/apps/photos/grant-audiences";

import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { useNamedShareCircles } from "../../kit/share/named-circles";
import { nativeShareTargets } from "../../kit/share/share-targets";
import { listLinks } from "../../lib/replica/links-transport";
import type { GatewayLink } from "../../lib/replica/links-transport";

/** What a phone with no gateway session says. It names the missing thing. */
export const NO_GATEWAY_TO_SHARE_THROUGH =
  "Not connected to a gateway, so nothing can be shared from here.";

export interface PhotoShareEntry {
  /** Who the sheet may name. Read on request, not held open on every screen. */
  audiences: readonly GrantAudienceOption[];
  visible: boolean;
  /**
   * The member asked to share. The roster is read HERE and the refusal — no
   * gateway, or nobody to name — is spoken on the status line BEFORE a sheet
   * opens. An empty picker is not an answer to "who can see this".
   */
  request: () => void;
  dismiss: () => void;
}

export function usePhotoShare(
  /** The screen's one status line. Every refusal lands there. */
  refuse: (message: string) => void
): PhotoShareEntry {
  const replica = useReplica();
  const parties = useReplicaQuery(
    "people",
    useMemo(() => ({ entity: "core.party", limit: 500 }), [])
  );
  const vault = useReplicaQuery(
    "people",
    useMemo(() => ({ entity: "core.vault", limit: 1 }), [])
  );
  const [links, setLinks] = useState<GatewayLink[]>([]);
  const [pending, setPending] = useState(false);
  const [visible, setVisible] = useState(false);

  const ownerPartyId =
    typeof vault.rows[0]?.owner_party_id === "string"
      ? vault.rows[0].owner_party_id
      : undefined;
  const targets = nativeShareTargets({
    sourceVaultId: replica.vaultId ?? "",
    ...(ownerPartyId ? { ownerPartyId } : {}),
    parties: parties.rows,
    links,
    scopes: replica.scopes ?? [],
  });
  const circles = useNamedShareCircles(targets, ownerPartyId);
  const audiences = photoAudiences(targets, circles);

  // The decision waits for the render that HAS the freshly read links —
  // deciding inside `request` would judge the roster it was about to replace.
  useEffect(() => {
    if (!pending) return;
    setPending(false);
    if (audiences.length === 0) refuse(NOBODY_TO_SHARE_WITH);
    else setVisible(true);
  }, [pending, audiences, refuse]);

  return {
    audiences,
    visible,
    request: () => {
      if (!replica.session || !replica.gatewayBase) {
        refuse(NO_GATEWAY_TO_SHARE_THROUGH);
        return;
      }
      const base = replica.gatewayBase;
      void (async () => {
        try {
          setLinks(await listLinks(base));
        } catch {
          // A link read that failed is not a roster: People still names
          // everyone this member added, and an invitation is a real target.
          setLinks([]);
        }
        setPending(true);
      })();
    },
    dismiss: () => setVisible(false),
  };
}
