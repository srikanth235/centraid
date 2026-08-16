/*
 * In-process run-event bus (issue #158).
 *
 * The streaming transport for automation runs is a plain `runId`-keyed
 * emitter living in the gateway process — no new worker IPC. A fire
 * publishes native automation turn events here (via the event sink threaded
 * down to the handler runner); the SSE endpoint subscribes by `runId`,
 * replays the durable ledger, then forwards live events until `turn.end`.
 *
 * Events are ephemeral: a run with no current subscriber drops them on the
 * floor (the ledger is the durable record). A late viewer replays from the
 * ledger and only then goes live — see `automations-routes.ts`.
 */

import type { AutomationTurnStreamEvent } from "@centraid/server/engine";

export type RunEventListener = (
  ev: AutomationTurnStreamEvent,
  serialized: string
) => void;

export class RunEventBus {
  private readonly listeners = new Map<string, Set<RunEventListener>>();

  /** Fan out one event to every current subscriber of `runId`. */
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

  /** Subscribe to `runId`'s events. Returns an idempotent unsubscribe. */
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

  /** Live subscriber count for a run — used by tests. */
  subscriberCount(runId: string): number {
    return this.listeners.get(runId)?.size ?? 0;
  }
}
