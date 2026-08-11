import { useMemo } from "react";

import { useReplicaQuery } from "../hooks/useReplicaQuery";
import type { NativeShareTarget } from "./share-targets";
import { nativeNamedShareCircles } from "./share-targets";

/** Native host adapter for the shipped named-audience source. The generic
 * ShareSheet consumes only the resulting circles and never branches on an
 * app or container type. */
export function useNamedShareCircles(
  targets: readonly NativeShareTarget[],
  ownerPartyId?: string
) {
  const circles = useReplicaQuery(
    "tally",
    useMemo(() => ({ entity: "social.circle", limit: 500 }), [])
  );
  const members = useReplicaQuery(
    "tally",
    useMemo(() => ({ entity: "social.circle_member", limit: 2_000 }), [])
  );
  const groups = useReplicaQuery(
    "tally",
    useMemo(() => ({ entity: "tally.group", limit: 500 }), [])
  );
  return nativeNamedShareCircles({
    circles: circles.rows,
    members: members.rows,
    groups: groups.rows,
    targets,
    ownerPartyId,
  });
}
