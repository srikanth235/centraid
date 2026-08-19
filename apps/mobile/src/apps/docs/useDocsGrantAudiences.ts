/**
 * WHO THE DOCS SEAT CAN NAME IN A GRANT (issue #825), native side.
 *
 * The share kit draws the sheet; the roster is the HOST's obligation, and on
 * this seat the host is Docs. Everything below is already the native seat's
 * own reading of People — the replica party rows, the approved links, the
 * named circles — so this hook composes those readers rather than adding a
 * second directory that could disagree with the one the old share sheet used.
 *
 * `null` is "not read yet", which is not the same fact as a vault that knows
 * nobody: Docs draws no Share verb until the roster is an actual answer.
 */

import { useEffect, useMemo, useState } from "react";

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
  const [links, setLinks] = useState<GatewayLink[] | null>(null);
  const gatewayBase = replica.gatewayBase;

  // Every write is deferred off the effect body: a synchronous setState here
  // cascades a second render before the first has painted.
  useEffect(() => {
    let active = true;
    void Promise.resolve()
      // A links read that fails is "no linked vaults known", never a reason to
      // withhold the People rows that were already read — and a seat with no
      // gateway yet has the same answer.
      .then(() => (gatewayBase ? listLinks(gatewayBase) : []))
      .catch(() => [])
      .then((rows) => {
        if (active) setLinks(rows);
      });
    return () => {
      active = false;
    };
  }, [gatewayBase]);

  const ownerPartyId =
    typeof vault.rows[0]?.owner_party_id === "string"
      ? vault.rows[0].owner_party_id
      : undefined;
  const targets = nativeShareTargets({
    sourceVaultId: replica.vaultId ?? "",
    ...(ownerPartyId ? { ownerPartyId } : {}),
    parties: parties.rows,
    links: links ?? [],
    scopes: replica.scopes ?? [],
  });
  const circles = useNamedShareCircles(targets, ownerPartyId);
  if (links === null) return null;
  return [
    // A person queued offline carries an id no vault has settled; a grant
    // naming one would address somebody who does not exist yet.
    ...targets.flatMap((target) =>
      target.partyId && !target.pending
        ? [
            {
              kind: "party" as const,
              id: target.partyId,
              label: target.label,
            },
          ]
        : []
    ),
    ...circles.map((circle) => ({
      kind: "circle" as const,
      id: circle.circleId,
      label: circle.label,
      memberCount: circle.members.length,
    })),
  ];
}
