/**
 * Who the docs seat can name in a grant (#825), native side: composes existing
 * People readers (parties, links, circles) — no second directory. Mapping owned
 * by _shared/grant-audiences.ts. null = unreadable-or-unread, distinct from empty.
 */

import { useEffect, useMemo, useState } from "react";

import { grantAudiencesFrom } from "@centraid/blueprints/apps/_shared/grant-audiences";
import type { GrantAudienceOption } from "@centraid/blueprints/apps/_shared/grant-plane";

import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { useNamedShareCircles } from "../../kit/share/named-circles";
import { nativeShareTargets } from "../../kit/share/share-targets";
import { listLinks } from "../../lib/replica/links-transport";
import type { GatewayLink } from "../../lib/replica/links-transport";

export function useDocsGrantAudiences(): readonly GrantAudienceOption[] | null {
  const replica = useReplica();
  const parties = useReplicaQuery(
    "people",
    useMemo(() => ({ entity: "core.party", limit: 500 }), [])
  );
  const vault = useReplicaQuery(
    "people",
    useMemo(() => ({ entity: "core.vault", limit: 1 }), [])
  );
  const [links, setLinks] = useState<GatewayLink[] | "unreadable" | null>(null);
  const gatewayBase = replica.gatewayBase;

  useEffect(() => {
    let active = true;
    void Promise.resolve()
      // Failed links read = "unreadable", never empty.
      .then(() => (gatewayBase ? listLinks(gatewayBase) : []))
      .catch((): GatewayLink[] | "unreadable" => "unreadable")
      .then((rows) => {
        if (active) setLinks(rows);
      });
    return () => {
      active = false;
    };
  }, [gatewayBase]);

  const ownerPartyId =
    typeof vault.rows[0]?.self_party_id === "string"
      ? vault.rows[0].self_party_id
      : undefined;
  const targets = nativeShareTargets({
    sourceVaultId: replica.vaultId ?? "",
    ...(ownerPartyId ? { ownerPartyId } : {}),
    parties: parties.rows,
    links: links === null || links === "unreadable" ? [] : links,
    scopes: replica.scopes ?? [],
  });
  const circles = useNamedShareCircles(targets, ownerPartyId);
  // Two ways to have no answer, and neither is an empty roster: the read is
  // still in flight, or it fell over. The second used to be qualified with
  // "…and nobody else answered", which stopped meaning anything once a link
  // became the WHOLE address (`nativeShareTargets`): with the links read
  // broken there is no target to name, so the qualifier could never be false.
  if (links === null || links === "unreadable") return null;
  return grantAudiencesFrom(targets, circles);
}
