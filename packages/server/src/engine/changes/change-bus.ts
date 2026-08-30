/*
 * Per-app change bus. An event carries the action's DECLARED tables so
 * consumers invalidate per-table; without tables it is the wildcard (#883 D2).
 * Delivery is sync and fire-and-forget, with listener errors caught so one bad
 * subscriber cannot stall a write.
 */

import type { RuntimeLogger } from "../runtime.js";

export interface AppChange {
  appId: string;
  tables: string[];
  ts: number;
  source: "assistant" | "handler" | "external";
  /** When `source === 'assistant'`, the harness dispatch id for the chat-pill. */
  toolCallId?: string;
  turnId?: string;
}

export type ChangeListener = (change: AppChange, serialized: string) => void;

function serializeChange(change: AppChange): string {
  const payload: Record<string, unknown> = {
    tables: change.tables,
    ts: change.ts,
    source: change.source,
  };
  if (change.toolCallId) payload.toolCallId = change.toolCallId;
  if (change.turnId) payload.turnId = change.turnId;
  return JSON.stringify(payload);
}

/** A no-op default is constructed when the host doesn't supply one. */
export class ChangeBus {
  private readonly listeners = new Map<string, Set<ChangeListener>>();
  private readonly logger: RuntimeLogger | undefined;

  constructor(opts: { logger?: RuntimeLogger } = {}) {
    this.logger = opts.logger;
  }

  subscribe(appId: string, listener: ChangeListener): () => void {
    let set = this.listeners.get(appId);
    if (!set) {
      set = new Set();
      this.listeners.set(appId, set);
    }
    set.add(listener);
    return () => {
      const s = this.listeners.get(appId);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.listeners.delete(appId);
    };
  }

  /** An EMPTY table list is meaningful: writes ride ctx.vault, so the event
   *  says "this app acted; re-derive what you render" (#286). */
  emit(change: AppChange): void {
    const set = this.listeners.get(change.appId);
    if (!set || set.size === 0) return;
    const serialized = serializeChange(change);
    // Set iteration is safe under concurrent delete in JS (the deleted
    // element is skipped, the rest still visit in insertion order).
    for (const listener of set) {
      try {
        listener(change, serialized);
      } catch (error) {
        this.logger?.warn(
          `[change-bus] listener for app "${change.appId}" threw: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  listenerCount(appId: string): number {
    return this.listeners.get(appId)?.size ?? 0;
  }
}
