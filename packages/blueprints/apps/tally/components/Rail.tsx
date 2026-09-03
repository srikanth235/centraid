import type { ReactNode } from "react";

import { NavRail } from "../../_shared/NavRail.tsx";
import type { NavRailItem } from "../../_shared/NavRail.tsx";
import { displayText } from "../../_shared/untrusted.ts";
import {
  ACTIVITY,
  RECURRING,
  SPENDING,
  TRASH,
  WAITING,
  shelfLabel,
} from "../shelves.ts";
import type { ShelfId } from "../shelves.ts";
import type { FriendSummary, GroupSummary } from "../types.ts";
import { RAIL_HEADS } from "../view-copy.ts";

export interface RailProps {
  current: ShelfId;
  openGroupId: string | null;
  openFriendId: string | null;
  groups: readonly GroupSummary[];
  friends: readonly FriendSummary[];
  onSelect: (shelf: ShelfId) => void;
  onOpenGroup: (groupId: string) => void;
  onOpenFriend: (partyId: string) => void;
}

export function Rail(props: RailProps): ReactNode {
  const items: NavRailItem[] = [
    { kind: "head", label: RAIL_HEADS.ledger },
    {
      kind: "row",
      id: "balances",
      label: shelfLabel(null),
      current: props.current === null,
      onSelect: () => props.onSelect(null),
    },
    {
      kind: "row",
      id: "activity",
      label: shelfLabel(ACTIVITY),
      current: props.current === ACTIVITY,
      onSelect: () => props.onSelect(ACTIVITY),
    },
    {
      kind: "row",
      id: "contrib",
      label: shelfLabel(WAITING),
      current: props.current === WAITING,
      onSelect: () => props.onSelect(WAITING),
    },
    { kind: "rule" },
    { kind: "head", label: RAIL_HEADS.groups },
    ...props.groups.map(
      (group): NavRailItem => ({
        kind: "row",
        id: `group:${group.group_id}`,
        label: displayText(group.name),
        count: group.member_count,
        indent: true,
        current: props.openGroupId === group.group_id,
        onSelect: () => props.onOpenGroup(group.group_id),
      })
    ),
    { kind: "rule" },
    { kind: "head", label: RAIL_HEADS.people },
    ...props.friends.map(
      (friend): NavRailItem => ({
        kind: "row",
        id: `friend:${friend.party_id}`,
        label: displayText(friend.name),
        indent: true,
        current: props.openFriendId === friend.party_id,
        onSelect: () => props.onOpenFriend(friend.party_id),
      })
    ),
    { kind: "rule" },
    {
      kind: "row",
      id: "recurring",
      label: shelfLabel(RECURRING),
      current: props.current === RECURRING,
      onSelect: () => props.onSelect(RECURRING),
    },
    {
      kind: "row",
      id: "insight",
      label: shelfLabel(SPENDING),
      current: props.current === SPENDING,
      onSelect: () => props.onSelect(SPENDING),
    },
    {
      kind: "row",
      id: "trash",
      label: shelfLabel(TRASH),
      current: props.current === TRASH,
      onSelect: () => props.onSelect(TRASH),
    },
  ];

  return <NavRail label="Tally" items={items} />;
}
