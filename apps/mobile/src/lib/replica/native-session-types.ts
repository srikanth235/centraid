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
  /** The foreground catch-up clock (#1014, R15); defaults to a minute. */
  pullIntervalMs?: number;
  /** Hermes has no WebCrypto; these default to expo-crypto's, imported lazily. */
  digest?: ReplicaDigest;
  idFactory?: ReplicaIdFactory;
  /** Fires once per storage-full pause, so the mount need not poll. */
  onStorageFull?: (error: unknown) => void;
  /**
   * THE GATEWAY REFUSED THIS DEVICE (#1014, X7/X8; R-1014-12).
   *
   * Raised from the seat's own log door (a read-only seat never touches the
   * drain) and from the drain, and answered by the mount the same way the
   * browser answers it: quiesce, export what is unsent, purge. Absent leaves a
   * session that reports the refusal and does nothing with it, which is what
   * every phone did — it re-bootstrapped against a gateway that had revoked
   * it, forever.
   */
  onAuthorizationRevoked?: () => void;
  onGatewayOutcome?: (reachable: boolean) => void;
  /**
   * A batch of rows became durable in this phone's file, at this position
   * (#1014, C3). The honest freshness signal: the frame that predicted the
   * rows is a wake, and a stamp bumped from it says "current" over rows that
   * have not been applied yet.
   */
  onApplied?: (applied: number) => void;
  /**
   * Who a queued write into THIS vault may wait for. Set only where
   * `ReplicaVaultScope.personal === false`; absent means the member's own
   * vault, where a write waits for nobody and naming an owner would be fiction.
   */
  origin?: MountedOrigin;
}
