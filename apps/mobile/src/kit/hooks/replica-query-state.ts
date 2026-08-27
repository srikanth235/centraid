import type {
  ReplicaCoverage,
  ReplicaRow,
} from "@centraid/client/replica/native";

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
  /** `partial` means these rows are a readable preview, not the whole library. */
  coverage?: ReplicaCoverage;
  refresh: () => Promise<void>;
}

export interface CombinedReplicaQueryState {
  loading: boolean;
  error?: string;
  connection: ReplicaQueryConnection;
  unavailableReason?: string;
  lastSyncedAt?: string;
  coverage?: ReplicaCoverage;
}

export function replicaQueryConnection(input: {
  ready: boolean;
  hasSession: boolean;
  reachability?:
    | "device-offline"
    | "gateway-asleep"
    | "sync-paused"
    | "syncing"
    | "current";
}): ReplicaQueryConnection {
  if (!input.ready) return "loading";
  if (!input.hasSession) return "unavailable";
  if (input.reachability === "syncing") return "syncing";
  if (
    input.reachability === "device-offline" ||
    input.reachability === "gateway-asleep" ||
    // A paused sync reads as `offline` here rather than gaining a sixth value
    // every consumer would have to learn: what this enum tells an app is
    // whether the rows may be stale, and under the member's own transfer rules
    // they may. The reason is a status-bar sentence, not an app-level branch.
    input.reachability === "sync-paused"
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
  // Conservative, like the reader's own aggregate: one partial entity keeps the
  // combined screen partial. A complete claim needs every part to claim it.
  const coverages = states.flatMap((state) =>
    state.coverage ? [state.coverage] : []
  );
  const coverage: ReplicaCoverage | undefined =
    coverages.length === 0
      ? undefined
      : coverages.every((entry) => entry === "complete")
        ? "complete"
        : "partial";
  return {
    loading: states.some((state) => state.loading),
    connection,
    ...(error ? { error } : {}),
    ...(unavailableReason ? { unavailableReason } : {}),
    ...(lastSyncedAt ? { lastSyncedAt } : {}),
    ...(coverage ? { coverage } : {}),
  };
}
