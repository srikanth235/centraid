// A row must be actionable or awaited; `device-offline` stays silent because
// the replica is local — a notice there reads as a fault.

export type ReplicaReachability =
  | "current"
  | "device-offline"
  | "gateway-asleep"
  | "syncing";

// `syncing` is optimistic, so every pass must settle or it pins forever.
export function settledReachability(pullLanded: boolean): ReplicaReachability {
  return pullLanded ? "current" : "gateway-asleep";
}

export interface ReplicaStatusRow {
  /** Absent when the state earns no row. */
  label?: string;
  action?: string;
  actionable: boolean;
}

const SILENT: ReplicaStatusRow = { actionable: false };

export function replicaStatusRow(
  reachability: ReplicaReachability
): ReplicaStatusRow {
  switch (reachability) {
    case "gateway-asleep":
      return { action: "Wake help", actionable: true, label: "Gateway asleep" };
    case "syncing":
      return {
        action: "Sync now",
        actionable: false,
        label: "Syncing recent changes…",
      };
    case "current":
    case "device-offline":
      return SILENT;
  }
}
