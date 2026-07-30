/** In-process doorbell for the Inbox SSE stream and content-free wake relay. */
export interface InboxChangedEvent {
  vaultId: string;
  wake: boolean;
}

export class InboxEventBus {
  readonly #listeners = new Map<
    string,
    Set<(event: InboxChangedEvent) => void>
  >();

  publish(vaultId: string, wake = false): void {
    const event = { vaultId, wake };
    for (const listener of this.#listeners.get(vaultId) ?? []) listener(event);
  }

  subscribe(
    vaultId: string,
    listener: (event: InboxChangedEvent) => void
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

/**
 * Detect newly-opened canonical decisions without storing shadow decision
 * state. Provenance commits are the common doorbell for parked, outbox,
 * scope-request, and connection-auth rows; the gateway samples their existing
 * projection after each commit and wakes only when that count rises.
 */
export function createInboxDecisionWakeTracker(): {
  observe: (vaultId: string, count: number) => boolean;
} {
  const counts = new Map<string, number>();
  return {
    observe(vaultId, count) {
      const previous = counts.get(vaultId) ?? 0;
      counts.set(vaultId, count);
      return count > previous;
    },
  };
}
