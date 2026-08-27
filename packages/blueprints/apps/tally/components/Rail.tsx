// Tally's 232px rail (spec §1), on a wide pointer surface only.
//
// THREE NAMED GROUPS, because the rail answers three different questions and
// the difference is the app's whole navigational idea: *The ledger* is what
// the app is (balances, the feed, the queue), *Groups* and *People* are the
// two ways a net is cut, and the tail under the last rule is a set of LENSES —
// states of the ledger rather than places in it, which is the weaker
// separation a hairline draws.
//
// IT IS `_shared/NavRail.tsx`, NOT A RAIL OF ITS OWN. The shared component
// owns the column, the divider, the roving tab stop and the row rung; this
// file only says which rows exist. Two consequences the design file draws
// differently, and both are the repo's law rather than an omission:
//
//   * NO HUE DOT beside a group. The rail draws no badge, no dot and no icon
//     chip anywhere in the product; a group's hue lives on its own row's
//     person chips and on its ledger, where the colour is about the content.
//   * NO NET IN THE COUNT COLUMN. That column is bare integers. A friend's net
//     is money with a sign and a direction, and putting it where a count goes
//     would make the one column mean two things. A member's net is on the
//     Balances row that opens them, in the figure block built for it.
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
  /** The group whose ledger is open, so the rail lights the right row rather
   *  than every group at once. */
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
