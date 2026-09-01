// Grant-sheet host seam (#825): kit owns the write door; this says who is in
// the room and where refusals land. Addressing law lives in grantAudiencesFrom.

import { useMemo, useState } from "react";

import {
  grantAudiencesFrom,
  NOBODY_TO_SHARE_WITH,
  ROSTER_UNREADABLE,
} from "@centraid/blueprints/apps/_shared/grant-audiences";
import type { GrantAudienceOption } from "@centraid/blueprints/apps/_shared/grant-plane";

import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import {
  nativeNamedShareCircles,
  nativeShareTargets,
} from "../../kit/share/share-targets";
import { listLinks } from "../../lib/replica/links-transport";
import type { GatewayLink } from "../../lib/replica/links-transport";

export const NO_GATEWAY_TO_SHARE_THROUGH =
  "Not connected to a gateway, so nothing can be shared from here.";

export interface PhotoGrantEntry {
  /** Read on request, never held open. */
  audiences: readonly GrantAudienceOption[];
  visible: boolean;
  /** Refusals land on the status line BEFORE any sheet opens. */
  request: () => void;
  dismiss: () => void;
}

export function usePhotoGrantEntry(
  refuse: (message: string) => void
): PhotoGrantEntry {
  const replica = useReplica();
  const parties = useReplicaQuery(
    "people",
    useMemo(() => ({ entity: "core.party", limit: 500 }), [])
  );
  const vault = useReplicaQuery(
    "people",
    useMemo(() => ({ entity: "core.vault", limit: 1 }), [])
  );
  // Only an owned, group-decorated circle is a deliberate audience.
  const circles = useReplicaQuery(
    "tally",
    useMemo(() => ({ entity: "social.circle", limit: 500 }), [])
  );
  const circleMembers = useReplicaQuery(
    "tally",
    useMemo(() => ({ entity: "social.circle_member", limit: 2_000 }), [])
  );
  const groups = useReplicaQuery(
    "tally",
    useMemo(() => ({ entity: "tally.group", limit: 500 }), [])
  );
  const [audiences, setAudiences] = useState<readonly GrantAudienceOption[]>(
    []
  );
  const [visible, setVisible] = useState(false);

  const ownerPartyId =
    typeof vault.rows[0]?.owner_party_id === "string"
      ? vault.rows[0].owner_party_id
      : undefined;

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
        let links: GatewayLink[] = [];
        let linksUnread = false;
        try {
          links = await listLinks(base);
        } catch {
          // A failed link read is not an empty roster — see refusal below.
          links = [];
          linksUnread = true;
        }
        const targets = nativeShareTargets({
          sourceVaultId: replica.vaultId ?? "",
          ...(ownerPartyId ? { ownerPartyId } : {}),
          parties: parties.rows,
          links,
          scopes: replica.scopes ?? [],
        });
        const rows = grantAudiencesFrom(
          targets,
          nativeNamedShareCircles({
            circles: circles.rows,
            members: circleMembers.rows,
            groups: groups.rows,
            targets,
            ...(ownerPartyId ? { ownerPartyId } : {}),
          })
        );
        setAudiences(rows);
        if (rows.length > 0) {
          setVisible(true);
          return;
        }
        // A link is the WHOLE address (#903), so a failed link read answers
        // nothing at all — never say "you know nobody" off a read that broke.
        refuse(linksUnread ? ROSTER_UNREADABLE : NOBODY_TO_SHARE_WITH);
      })();
    },
    dismiss: () => setVisible(false),
  };
}
