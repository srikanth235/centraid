// THE COMMONS PRODUCER, AND THE ONLY ONE THIS DEVICE HAS (#825 G-edit).
// `tally.group` is v1's one edit-capable subject, so this row is where a
// `centraid://commons-invite` URI is minted. Offline: `tally-seat-copy.ts`.

import React, { useMemo, useState } from "react";

import { placementEntity } from "@centraid/blueprints/apps/_shared/placement-registry";

import { postStatus } from "../../kit/components/status-line";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ShareSheet from "../../kit/share/ShareSheet";
import {
  SHARE_GROUP_META,
  SHARE_GROUP_OFFLINE,
  SHARE_GROUP_VERB,
} from "./tally-seat-copy";
import { LedgerRow } from "./TallyParts";

const NOUN = placementEntity("tally.group")?.label ?? "group";

export interface TallyShareGroupProps {
  groupId: string;
}

export default function TallyShareGroup({
  groupId,
}: TallyShareGroupProps): React.JSX.Element {
  const replica = useReplica();
  const [open, setOpen] = useState(false);
  // The gateway binds this commons to the group circle's exact stored roster.
  const groups = useReplicaQuery(
    "tally",
    useMemo(() => ({ entity: "tally.group", limit: 500 }), [])
  );
  const circleId = groups.rows.flatMap((row) =>
    row.group_id === groupId && typeof row.circle_id === "string"
      ? [row.circle_id]
      : []
  )[0];
  const itemIds = useMemo(() => [groupId], [groupId]);
  const sourceVaultId = replica.vaultId ?? "";
  const reachable =
    replica.online && replica.session !== undefined && sourceVaultId !== "";

  return (
    <>
      <LedgerRow
        title={SHARE_GROUP_VERB}
        meta={reachable ? SHARE_GROUP_META : SHARE_GROUP_OFFLINE}
        {...(reachable ? { onPress: () => setOpen(true) } : {})}
      />
      {open ? (
        <ShareSheet
          itemIds={itemIds}
          itemType="tally.group"
          noun={NOUN}
          onClose={() => setOpen(false)}
          onDone={(outcome) => postStatus(outcome.message)}
          sourceVaultId={sourceVaultId}
          visible
          {...(circleId ? { preferredCircleId: circleId } : {})}
        />
      ) : null}
    </>
  );
}
