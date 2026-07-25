/*
 * Native automation turn stream (issue #541).
 *
 * The durable source of truth is the same conversation → turn → item ledger
 * used by interactive conversations. Lifecycle events mirror those row names;
 * model-token activity stays the shared `TurnStreamEvent`, nested under the
 * item that owns it.
 */

import type { TurnStreamEvent } from './runner.js';
import type { ItemKind } from './schema.js';

export type AutomationTurnStreamEvent =
  | { type: 'turn.start'; turnId: string }
  | {
      type: 'item.start';
      itemId: string;
      ordinal: number;
      callId?: string;
      batchId?: number;
      kind: ItemKind;
      name?: string;
      args?: unknown;
      rawJson?: string;
    }
  /** Ephemeral shared conversation event nested under its durable item. */
  | {
      type: 'item.delta';
      itemId: string;
      ordinal: number;
      callId?: string;
      event: TurnStreamEvent;
    }
  | {
      type: 'item.end';
      itemId: string;
      ordinal: number;
      callId?: string;
      ok: boolean;
      result?: unknown;
      error?: string;
      durationMs: number;
      rawJson?: string;
    }
  | { type: 'turn.end'; turnId: string; ok: boolean; error?: string };
