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
  /**
   * This read's WINDOW cut the answer short (#922 0a) — a different fact from
   * `coverage`, which is about the device's copy of the library. A fully
   * bootstrapped phone still truncates a 5,000-contact roster at 1,000.
   */
  truncated?: boolean;
  /** The window that produced `rows`. */
  appliedLimit?: number;
  /** The truncation line, already worded, so no screen phrases it its own way. */
  truncationNotice?: string;
  refresh: () => Promise<void>;
}

export interface CombinedReplicaQueryState {
  loading: boolean;
  error?: string;
  connection: ReplicaQueryConnection;
  unavailableReason?: string;
  lastSyncedAt?: string;
  coverage?: ReplicaCoverage;
  /** Any part truncated truncates the screen: a composed view is as short as
   *  its shortest window (#922 0a). */
  truncated?: boolean;
  truncationNotice?: string;
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
  // Conservative like coverage above: one truncated part makes the composed
  // screen truncated, and the notice shown is the smallest window in play —
  // the one that actually cut the answer short.
  const truncatedStates = states.filter((state) => state.truncated === true);
  const truncationNotice = truncatedStates
    .flatMap((state) => (state.truncationNotice ? [state] : []))
    .sort(
      (a, b) => (a.appliedLimit ?? 0) - (b.appliedLimit ?? 0)
    )[0]?.truncationNotice;
  return {
    loading: states.some((state) => state.loading),
    connection,
    ...(error ? { error } : {}),
    ...(unavailableReason ? { unavailableReason } : {}),
    ...(lastSyncedAt ? { lastSyncedAt } : {}),
    ...(coverage ? { coverage } : {}),
    ...(truncatedStates.length > 0 ? { truncated: true } : {}),
    ...(truncationNotice ? { truncationNotice } : {}),
  };
}
