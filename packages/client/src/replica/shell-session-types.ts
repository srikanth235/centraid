// WHAT A CALLER HANDS THE SHELL SESSION, AND WHAT IT GETS BACK.
//
// The session's own vocabulary, in a file of its own so the class can stay the
// size of what it DOES. Every one of these was wider before #996 W5: a request
// named a shape, a write named a catalog, an option named a worker factory and
// an IndexedDB. A seat has one file, so what is left is what the caller
// genuinely chooses.

import type { IntentRecordStore } from "./intent-record-store.js";
import type { SeatOpener } from "./seat/session-seat.js";
import type { ReplicaWriteResult } from "./shell-outcomes.js";
import type { ReplicaFetcher } from "./shell-transport.js";
import type { ReplicaIdentityInventory } from "./storage-manifest.js";
import type {
  ReplicaSearchRequest,
  ReplicaBaseVersion,
  ReplicaValue,
} from "./types.js";
import type { ReplicaWriteMutationInput } from "./write-helpers.js";

export type ShellReplicaSearchRequest = Omit<ReplicaSearchRequest, "shapeId">;

export type ShellOptimisticMutation = ReplicaWriteMutationInput;

export interface ShellReplicaWriteInput {
  action: string;
  input: ReplicaValue;
  optimistic?: ShellOptimisticMutation[];
  intentId?: string;
  baseVersions?: ReplicaBaseVersion[];
}

export type ShellReplicaWriteResult = ReplicaWriteResult;

/**
 * The one thing the session does NOT do for itself: what to do when the gateway
 * refuses its credentials. Dropping the scope, clearing the browser's caches
 * and purging is the REGISTRY's response, and the session only reports.
 *
 * Typed over the session structurally so this file names no class — the class
 * imports these options, and a type that named it back would be a cycle.
 */
export interface AuthorizationRevoked<Session> {
  onAuthorizationRevoked?: (session: Session) => void;
}

export interface ReplicaShellSessionOptions<
  Session = never,
> extends AuthorizationRevoked<Session> {
  fetcher?: ReplicaFetcher;
  eventTarget?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  isOnline?: () => boolean;
  retryDelayMs?: number;
  indexedDbFactory?: IDBFactory;
  rememberStorage?: boolean;
  inventory?: ReplicaIdentityInventory;
  pollIntervalMs?: number;
  /** Injected so a suite can drive the session's seat without a worker. */
  seatOpener?: SeatOpener;
  /** Injected so a suite can drive the queue without a seat file. */
  intentStore?: IntentRecordStore;
  idFactory?: () => string;
}
