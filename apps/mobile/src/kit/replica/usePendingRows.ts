// The pending marks for one app's rows, on the device-global ticker.
//
// Split from ./pending-rows for the reason ./replica-status is split from
// ReplicaStatusBar: the join and the copy are pure and asserted without a
// renderer, and this file is only the wiring that feeds them.

import { useMemo } from "react";

import { usePendingChanges } from "./pending-changes";
import { pendingRowMarks } from "./pending-rows";
import type { PendingRowMark } from "./pending-rows";
import { useReplica } from "./ReplicaProvider";

/**
 * Refreshed by the same device-global ticker the sync-status bar uses
 * (./pending-changes). `refresh` exists so a screen that just issued a write
 * shows its chip immediately instead of on the next tick.
 */
export function usePendingRows(appId: string): {
  marks: Map<string, PendingRowMark>;
  refresh: () => void;
} {
  const { session, reachability = "device-offline" } = useReplica();
  const { pending, refresh } = usePendingChanges(session);
  const marks = useMemo(
    () => pendingRowMarks(pending, appId, reachability !== "device-offline"),
    [appId, pending, reachability]
  );
  return { marks, refresh };
}
