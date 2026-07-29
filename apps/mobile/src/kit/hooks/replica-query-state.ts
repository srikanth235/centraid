import type { ReplicaRow } from "@centraid/client/replica/native";

export type ReplicaQueryConnection =
  | "loading"
  | "unavailable"
  | "offline"
  | "syncing"
  | "current";

export interface ReplicaQueryState {
  rows: Array<ReplicaRow & { __rowId: string }>;
  loading: boolean;
  error?: string;
  connection: ReplicaQueryConnection;
  unavailableReason?: string;
  lastSyncedAt?: string;
  refresh: () => Promise<void>;
}

export interface CombinedReplicaQueryState {
  loading: boolean;
  error?: string;
  connection: ReplicaQueryConnection;
  unavailableReason?: string;
  lastSyncedAt?: string;
}

export function replicaQueryConnection(input: {
  ready: boolean;
  hasSession: boolean;
  reachability?: "device-offline" | "gateway-asleep" | "syncing" | "current";
}): ReplicaQueryConnection {
  if (!input.ready) return "loading";
  if (!input.hasSession) return "unavailable";
  if (input.reachability === "syncing") return "syncing";
  if (
    input.reachability === "device-offline" ||
    input.reachability === "gateway-asleep"
  )
    return "offline";
  return "current";
}

const CONNECTION_PRIORITY: Record<ReplicaQueryConnection, number> = {
  unavailable: 5,
  loading: 4,
  offline: 3,
  syncing: 2,
  current: 1,
};

export function combineReplicaQueryStates(
  states: readonly ReplicaQueryState[]
): CombinedReplicaQueryState {
  const connection =
    states
      .map((state) => state.connection)
      .sort((a, b) => CONNECTION_PRIORITY[b] - CONNECTION_PRIORITY[a])[0] ??
    "loading";
  const error = states.find((state) => state.error)?.error;
  const unavailableReason = states.find(
    (state) => state.unavailableReason
  )?.unavailableReason;
  const lastSyncedAt = states
    .flatMap((state) => (state.lastSyncedAt ? [state.lastSyncedAt] : []))
    .sort((a, b) => b.localeCompare(a))[0];
  return {
    loading: states.some((state) => state.loading),
    connection,
    ...(error ? { error } : {}),
    ...(unavailableReason ? { unavailableReason } : {}),
    ...(lastSyncedAt ? { lastSyncedAt } : {}),
  };
}
