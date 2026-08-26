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

/** Keyed structurally, not by class. */
export interface NotificationsDecisionProjection {
  outbox: ReadonlyArray<{ itemId: string; stagedAt: string }>;
  needsAuth: ReadonlyArray<{ connectionId: string; attentionAt: string }>;
  parked: ReadonlyArray<{ invocationId: string }>;
  scopeRequests: ReadonlyArray<{ requestId: string }>;
}

/** Episode timestamps ride the key: reused rows read as new decisions. */
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
 * Keys, not counts: closing one decision while opening another must still
 * wake. First observation per vault only seeds — restarts must not re-wake
 * already-open decisions.
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
