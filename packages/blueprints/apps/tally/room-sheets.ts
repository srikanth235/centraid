// THE SIX QUESTIONS THE ROOM PUTS — minting a friend, a group, a member, a
// rename, a deletion, and taking a member out.
//
// Each is one line of state: which sheet is open, and what it is holding. They
// live together because they all answer the same shape of request — "open the
// sheet for THIS, seeded from what the room already knows" — and because two
// of them carry a verdict that is decided BEFORE the question is put.
//
// THE TWO GUARDS ARE ASKED IN FRONT OF THE QUESTION, not behind the commit:
//
//   * A member who appears anywhere on the group's ledger cannot be removed at
//     all — removing them would make its arithmetic unreadable — so the
//     confirm refuses and says why.
//   * A group that still holds expenses cannot be deleted; the vault refuses.
//     Where this room has already read that ledger it knows the answer, so the
//     confirm carries it. Where it has not, the question is put and the
//     VAULT'S OWN reason lands on the status line. Neither path invents one.
import { useCallback } from "react";

import { appearsOnLedger } from "./activity-model.ts";
import type { ComposeState } from "./compose-state.ts";
import type { GroupData } from "./types.ts";

export interface RoomSheets {
  askFriend: () => void;
  askGroup: () => void;
  askRename: () => void;
  askMember: () => void;
  askDeleteGroup: () => void;
  askRemove: (partyId: string) => void;
}

export function useRoomSheets(args: {
  compose: ComposeState;
  /** The open group's own read, where one has landed. */
  group: GroupData | null;
  openGroupId: string | null;
}): RoomSheets {
  const { compose, group, openGroupId } = args;

  const askFriend = useCallback(
    () => compose.show({ kind: "friend", name: "" }),
    [compose]
  );

  const askGroup = useCallback(
    () =>
      compose.show({
        kind: "group",
        name: "",
        icon: "home",
        color: "indigo",
        memberIds: [],
      }),
    [compose]
  );

  const askRename = useCallback(
    () =>
      compose.show({
        kind: "rename",
        groupId: String(openGroupId),
        name: group?.group?.name ?? "",
      }),
    [compose, group, openGroupId]
  );

  const askMember = useCallback(
    () =>
      compose.show({
        kind: "member",
        groupId: String(openGroupId),
        partyId: "",
      }),
    [compose, openGroupId]
  );

  const askDeleteGroup = useCallback(
    () =>
      compose.show({
        kind: "deleteGroup",
        groupId: String(openGroupId),
        name: group?.group?.name ?? "",
        refused: (group?.ledger.length ?? 0) > 0,
      }),
    [compose, group, openGroupId]
  );

  const askRemove = useCallback(
    (partyId: string) => {
      if (!group) return;
      const member = group.members.find((row) => row.party_id === partyId);
      if (!member) return;
      compose.show({
        kind: "remove",
        partyId,
        name: member.name,
        refused: appearsOnLedger(group.ledger, partyId),
      });
    },
    [compose, group]
  );

  return {
    askFriend,
    askGroup,
    askRename,
    askMember,
    askDeleteGroup,
    askRemove,
  };
}
