import { useSeatPages } from "../hooks/useSeatPages";
import {
  SHARE_CIRCLES,
  SHARE_CIRCLE_MEMBERS,
  SHARE_GROUPS,
} from "./share-audience-queries";
import type { NativeShareTarget } from "./share-targets";
import { nativeNamedShareCircles } from "./share-targets";

/** Native host adapter for the shipped named-audience source. The generic
 * ShareSheet consumes only the resulting circles and never branches on an
 * app or container type. */
export function useNamedShareCircles(
  targets: readonly NativeShareTarget[],
  ownerPartyId?: string
) {
  const circles = useSeatPages("tally", SHARE_CIRCLES, {
    entity: "social.circle",
    rowIdColumn: "circle_id",
  });
  const members = useSeatPages("tally", SHARE_CIRCLE_MEMBERS, {
    entity: "social.circle_member",
    rowIdColumn: "member_id",
  });
  const groups = useSeatPages("tally", SHARE_GROUPS, {
    entity: "tally.group",
    rowIdColumn: "group_id",
  });
  return nativeNamedShareCircles({
    circles: circles.rows,
    members: members.rows,
    groups: groups.rows,
    targets,
    ownerPartyId,
  });
}
