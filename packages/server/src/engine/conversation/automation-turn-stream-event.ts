import type { TurnStreamEvent } from "./runner.js";
import type { ItemKind } from "./schema.js";

export type AutomationTurnStreamEvent =
  | { type: "turn.start"; turnId: string }
  | {
      type: "item.start";
      itemId: string;
      ordinal: number;
      callId?: string;
      batchId?: number;
      kind: ItemKind;
      name?: string;
      args?: unknown;
      rawJson?: string;
    }
  | {
      type: "item.delta";
      itemId: string;
      ordinal: number;
      callId?: string;
      event: TurnStreamEvent;
    }
  | {
      type: "item.end";
      itemId: string;
      ordinal: number;
      callId?: string;
      ok: boolean;
      result?: unknown;
      error?: string;
      durationMs: number;
      rawJson?: string;
    }
  | { type: "turn.end"; turnId: string; ok: boolean; error?: string };
