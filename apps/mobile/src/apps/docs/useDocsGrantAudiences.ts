/**
 * WHO THE DOCS SEAT CAN NAME IN A GRANT (issue #825), native side.
 *
 * The share kit draws the sheet; the roster is the HOST's obligation, and on
 * this seat the host is Docs. Everything below is already the native seat's
 * own reading of People — the replica party rows, the approved links, the
 * named circles — so this hook composes those readers rather than adding a
 * second directory that could disagree with the one the old share sheet used.
 * The MAPPING from those rows to audiences is not restated here either:
 * `_shared/grant-audiences.ts` owns it for every app and both seats.
 *
 * `null` is "not an answer" — not read yet, or read and unreadable — which is
 * not the same fact as a vault that knows nobody: Docs draws no Share verb
 * until the roster is an actual answer, and an empty answer is one.
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
  // `null` is "not read yet"; `unreadable` is "asked, and the answer never
  // came" — the two are not the same fact and neither is an empty list.
  const [links, setLinks] = useState<GatewayLink[] | "unreadable" | null>(null);
  const gatewayBase = replica.gatewayBase;

  // Every write is deferred off the effect body: a synchronous setState here
  // cascades a second render before the first has painted.
  useEffect(() => {
    let active = true;
    void Promise.resolve()
      // A links read that fails is never a reason to withhold the People rows
      // that were already read — but it is recorded as unreadable rather than
      // as an empty list, because the two differ where People named nobody
      // either. A seat with no gateway yet genuinely has no links.
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
    typeof vault.rows[0]?.owner_party_id === "string"
      ? vault.rows[0].owner_party_id
      : undefined;
  const targets = nativeShareTargets({
    sourceVaultId: replica.vaultId ?? "",
    ...(ownerPartyId ? { ownerPartyId } : {}),
    parties: parties.rows,
    links: links === null || links === "unreadable" ? [] : links,
    scopes: replica.scopes ?? [],
  });
  const circles = useNamedShareCircles(targets, ownerPartyId);
  if (links === null) return null;
  const audiences = grantAudiencesFrom(targets, circles);
  // A FAILED READ IS NOT AN EMPTY ROSTER. People's own rows still count — a
  // linked-vault read that fell over never made the people this member added
  // disappear — but when they name nobody either, the only honest answer is
  // "no answer": Docs draws no Share verb rather than a sheet that would
  // accuse a member of knowing nobody on the strength of a broken read.
  if (links === "unreadable" && audiences.length === 0) return null;
  return audiences;
}
