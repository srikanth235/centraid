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
