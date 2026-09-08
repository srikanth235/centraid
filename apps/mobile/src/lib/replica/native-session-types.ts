/*
 * WHAT THE PHONE'S SEAT SESSION IS SEEN AS (#996, W5).
 *
 * The session's own shape, kept apart from its 800 lines of behaviour so a
 * screen, a mount or a test can name what it takes and returns without pulling
 * the seat, the outbox and the drain loop in behind it.
 */

import type {
  GatewayAuth,
  ReplicaBaseVersion,
  ReplicaChangeFeedAdapter,
  ReplicaDigest,
  ReplicaFetcher,
  ReplicaIdFactory,
  ReplicaInvalidation,
  ReplicaSearchRequest,
  ReplicaSearchWireResult,
  ReplicaValue,
  ReplicaWriteMutationInput,
  ReplicaWriteResult,
} from "@centraid/client/replica/native";

import type { NativeSeatPort } from "./native-seat";
import type { VaultSource } from "./vault-source";
import type { MountedOrigin } from "./waiting-on";

export type NativeSearchRequest = Omit<ReplicaSearchRequest, "shapeId">;

export type NativeOptimisticMutation = ReplicaWriteMutationInput;

export interface NativeWriteInput {
  action: string;
  input: ReplicaValue;
  optimistic?: NativeOptimisticMutation[];
  intentId?: string;
  baseVersions?: ReplicaBaseVersion[];
  /**
   * The online-only door (blueprint-seats contract H; docs/mobile-offline.md).
   * A sealed input must never reach the outbox, which outlives the process.
   * `true` goes straight to the gateway and NEVER enqueues; a transport failure
   * surfaces as a failure, since the queue fallback is what this forbids.
   */
  onlineOnly?: boolean;
}

export type NativeWriteResult = ReplicaWriteResult;

export interface MobileReplicaSession {
  search: (
    appId: string,
    request: NativeSearchRequest
  ) => Promise<ReplicaSearchWireResult>;
  write: (appId: string, input: NativeWriteInput) => Promise<NativeWriteResult>;
  revisePendingWrite?: (
    intentId: string,
    revision: ReplicaValue
  ) => Promise<NativeWriteResult | undefined>;
  subscribe: (
    appId: string,
    listener: (invalidations: readonly ReplicaInvalidation[]) => void
  ) => () => void;
  pullNow: () => Promise<void | boolean>;
  /** The one vault this session holds (#996, R12). */
  scope?: () => VaultSource | undefined;
}

/** AppState-shaped foreground signal; RN's `AppState` satisfies it. */
export interface AppStateLike {
  readonly currentState: string | null;
  addEventListener: (
    type: "change",
    handler: (state: string) => void
  ) => { remove: () => void };
}

/** The change-feed adapter plus the session's foreground pause/resume control. */
export interface NativeChangeFeed extends ReplicaChangeFeedAdapter {
  setActive: (active: boolean) => void;
}

export interface CreateNativeReplicaSessionOptions {
  gatewayAuth: GatewayAuth;
  /** Non-streaming transport to the tunnel loopback proxy. */
  fetcher: ReplicaFetcher;
  changeFeed: NativeChangeFeed;
  /**
   * THIS PHONE'S COPY, opened but not necessarily filled. Injected rather than
   * constructed so this module never imports expo-sqlite, and opened BEFORE the
   * session because the outbox is a table in its file.
   */
  seat: NativeSeatPort;
  /**
   * The one vault this session holds (#996 wave 3). Every row it hands back is
   * stamped with it, because "which vault, and may I write there" is what the
   * screens ask about a row — it just has one answer now.
   */
  scope?: VaultSource;
  appState?: AppStateLike;
  isConnected?: () => boolean;
  isNetworkWorkAllowed?: () => Promise<boolean>;
  isRowSyncAllowed?: () => Promise<boolean>;
  retryDelayMs?: number;
  /** Hermes has no WebCrypto; these default to expo-crypto's, imported lazily. */
  digest?: ReplicaDigest;
  idFactory?: ReplicaIdFactory;
  /** Fires once per storage-full pause, so the mount need not poll. */
  onStorageFull?: (error: unknown) => void;
  onGatewayOutcome?: (reachable: boolean) => void;
  /**
   * Who a queued write into THIS vault may wait for. Set only where
   * `ReplicaVaultScope.personal === false`; absent means the member's own
   * vault, where a write waits for nobody and naming an owner would be fiction.
   */
  origin?: MountedOrigin;
}
