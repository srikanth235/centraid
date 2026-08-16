/** In-process doorbell for the Notifications SSE stream and content-free wake relay. */
export interface NotificationsChangedEvent {
  vaultId: string;
  wake: boolean;
}

export class NotificationsEventBus {
  readonly #listeners = new Map<
    string,
    Set<(event: NotificationsChangedEvent) => void>
  >();

  publish(vaultId: string, wake = false): void {
    const event = { vaultId, wake };
    for (const listener of this.#listeners.get(vaultId) ?? []) listener(event);
  }

  subscribe(
    vaultId: string,
    listener: (event: NotificationsChangedEvent) => void
  ): () => void {
    const listeners = this.#listeners.get(vaultId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(vaultId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(vaultId);
    };
  }
}

/** The decision projection this module keys on — structurally, not by class. */
export interface NotificationsDecisionProjection {
  outbox: ReadonlyArray<{ itemId: string; stagedAt: string }>;
  needsAuth: ReadonlyArray<{ connectionId: string; attentionAt: string }>;
  parked: ReadonlyArray<{ invocationId: string }>;
  scopeRequests: ReadonlyArray<{ requestId: string }>;
}

/**
 * Stable identity of every open decision in the blocking projection. Episode
 * timestamps ride the key where a row is reused across episodes (an outbox
 * item re-staged, a connection re-entering needs-auth) so a new episode reads
 * as a new decision rather than as the same one still standing.
 */
export function notificationsDecisionKeys(
  decisions: NotificationsDecisionProjection
): string[] {
  return [
    ...decisions.outbox.map((row) => `outbox:${row.itemId}:${row.stagedAt}`),
    ...decisions.needsAuth.map(
      (row) => `needs-auth:${row.connectionId}:${row.attentionAt}`
    ),
    ...decisions.parked.map((row) => `parked:${row.invocationId}`),
    ...decisions.scopeRequests.map((row) => `scope:${row.requestId}`),
  ];
}

/**
 * Detect newly-opened canonical decisions without storing shadow decision
 * state. Provenance commits are the common doorbell for parked, outbox,
 * scope-request, and connection-auth rows; the gateway samples their existing
 * projection after each commit and wakes when a decision key it has not seen
 * before appears.
 *
 * Keys, not a count: a grouped commit that closes one decision while opening
 * another leaves the count flat, and that new decision still has to reach a
 * closed device. The FIRST observation per vault only seeds — decisions that
 * were already open before this process started are not news, and waking on
 * them would spam every device on every gateway restart.
 */
export function createNotificationsDecisionWakeTracker(): {
  observe: (vaultId: string, keys: readonly string[]) => boolean;
} {
  const seen = new Map<string, Set<string>>();
  return {
    observe(vaultId, keys) {
      const previous = seen.get(vaultId);
      seen.set(vaultId, new Set(keys));
      if (previous === undefined) return false;
      return keys.some((key) => !previous.has(key));
    },
  };
}
