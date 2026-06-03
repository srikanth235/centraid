/*
 * Per-app change notification bus.
 *
 * The runtime emits an `AppChange` whenever an app's `data.sqlite` is
 * mutated — INSERT/UPDATE/DELETE/REPLACE — regardless of which code path
 * triggered the write. Today three call sites participate:
 *
 *   1. `runQuery()` — used by the HTTP `/centraid/_apps/{id}/query` route
 *      (the chat write tool in both desktop modes) AND by openclaw's
 *      legacy `centraid_sql_write` agent tool.
 *   2. `handler-runner.ts` — wraps every user-authored action / query
 *      handler with a session, so anything an app's own JS does to its
 *      database is observed.
 *   3. (room for more — e.g. future direct DB tools)
 *
 * Subscribers come and go via `subscribe()`. The HTTP SSE endpoint at
 * `GET /centraid/<appId>/_changes` is the main consumer; other in-process
 * consumers (e.g. log fanout) can subscribe too.
 *
 * Delivery is synchronous, fire-and-forget, in subscription order. Listener
 * errors are caught and logged so one bad subscriber can't block others or
 * stall a write.
 */

import type { RuntimeLogger } from './runtime.js';

export interface AppChange {
  appId: string;
  /** Table names mutated within this change. Sorted, deduplicated. */
  tables: string[];
  /** Wall-clock time of the commit (ms since epoch). */
  ts: number;
  /**
   * Who initiated the write:
   *  - `'agent'`     — an in-process agent tool call (centraid_sql_write).
   *  - `'handler'`   — a user-authored action / query handler.
   *  - `'external'`  — a cloud-panel SQL write or any other path that does
   *    not have agent or handler context.
   *
   * Subscribers can use this to render differently (e.g. flash agent-driven
   * rows) without needing to listen on a separate bus.
   */
  source: 'agent' | 'handler' | 'external';
  /**
   * When `source === 'agent'`, the tool-call id from the underlying CLI's
   * dispatch (codex `callId` / Claude `tool_use_id`). Lets a renderer pin a
   * later refresh to the same chat-pill the user is looking at.
   */
  toolCallId?: string;
  /**
   * Stable id for a single `ConversationRunner.run` invocation. Used by the chat UI
   * to group all writes from one turn — handy for "assistant updated 3
   * rows" style summaries.
   */
  turnId?: string;
}

export type ChangeListener = (change: AppChange) => void;

/**
 * In-process pub-sub keyed by appId. Construct once per `Runtime`. A no-op
 * default is constructed when the host doesn't supply one — that way the
 * change-tracking call sites (runQuery, handler-runner) never need to
 * branch on "is the bus enabled?".
 */
export class ChangeBus {
  private readonly listeners = new Map<string, Set<ChangeListener>>();
  private readonly logger: RuntimeLogger | undefined;

  constructor(opts: { logger?: RuntimeLogger } = {}) {
    this.logger = opts.logger;
  }

  /**
   * Subscribe to changes for one app. Returns an unsubscribe function.
   * Same listener may be added more than once; each add requires a matching
   * unsubscribe call.
   */
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

  /**
   * Emit a change. No-op if the table list is empty (read-only writers will
   * still call us — that's fine, we filter here so callers don't have to).
   */
  emit(change: AppChange): void {
    if (change.tables.length === 0) return;
    const set = this.listeners.get(change.appId);
    if (!set || set.size === 0) return;
    // Set iteration is safe under concurrent delete in JS (the deleted
    // element is skipped, the rest are still visited in insertion order),
    // so a listener can unsubscribe itself during dispatch without
    // breaking the loop.
    for (const listener of set) {
      try {
        listener(change);
      } catch (err) {
        this.logger?.warn(
          `[change-bus] listener for app "${change.appId}" threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /** Test/diagnostic helper. */
  listenerCount(appId: string): number {
    return this.listeners.get(appId)?.size ?? 0;
  }
}
