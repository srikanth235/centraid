/** In-process runId-keyed bus (#158): fire publishes automation turn events, the SSE endpoint replays the durable ledger then forwards live until `turn.end`. Events are ephemeral — a run with no subscriber drops them; the ledger is the durable record (see `automations-routes.ts`). */

import type { AutomationTurnStreamEvent } from "@centraid/server/engine";

export type RunEventListener = (
  ev: AutomationTurnStreamEvent,
  serialized: string
) => void;

export class RunEventBus {
  private readonly listeners = new Map<string, Set<RunEventListener>>();

  publish(runId: string, ev: AutomationTurnStreamEvent): void {
    const set = this.listeners.get(runId);
    if (!set) return;
    const serialized = JSON.stringify(ev);
    // Snapshot: a listener may unsubscribe itself (e.g. on `turn.end`) mid-fanout.
    for (const fn of Array.from(set)) {
      try {
        fn(ev, serialized);
      } catch {
        /* one wedged subscriber must not break the fanout */
      }
    }
  }

  /** Returns an idempotent unsubscribe. */
  subscribe(runId: string, fn: RunEventListener): () => void {
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(fn);
    return () => {
      const s = this.listeners.get(runId);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) this.listeners.delete(runId);
    };
  }

  subscriberCount(runId: string): number {
    return this.listeners.get(runId)?.size ?? 0;
  }
}
