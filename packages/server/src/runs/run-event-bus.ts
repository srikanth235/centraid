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
    for (const fn of Array.from(set)) {
      try {
        fn(ev, serialized);
      } catch {
        // Intentionally empty.
      }
    }
  }

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
