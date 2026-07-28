import type { AutomationTriggerCursor, AutomationTriggerStore } from '@centraid/app-engine';

import type { CursorRetentionKey } from './cursor-engine-support.js';

function rowKey(automationId: string, triggerIndex: number): string {
  return `${automationId}\u0000${triggerIndex}`;
}

/** Process-local cursor store for injected/test schedulers without a durable host store. */
export class MemoryCursorStore {
  private readonly rows = new Map<string, AutomationTriggerCursor>();

  getCursor(automationId: string, triggerIndex: number): AutomationTriggerCursor | undefined {
    return this.rows.get(rowKey(automationId, triggerIndex));
  }

  putCursor(input: Parameters<AutomationTriggerStore['putCursor']>[0]): void {
    this.rows.set(rowKey(input.automationId, input.triggerIndex), {
      automationId: input.automationId,
      triggerIndex: input.triggerIndex,
      sourceKind: input.sourceKind,
      ...(input.positionJson === undefined ? {} : { positionJson: input.positionJson }),
      ...(input.pendingJson === undefined ? {} : { pendingJson: input.pendingJson }),
      ...(input.windowFrom === undefined ? {} : { windowFrom: input.windowFrom }),
      ...(input.windowTo === undefined ? {} : { windowTo: input.windowTo }),
      skipped: input.skipped ?? 0,
      ...(input.gapReason === undefined ? {} : { gapReason: input.gapReason }),
      updatedAt: input.updatedAt,
    });
  }

  /**
   * Drop cursors for trigger slots the desired set no longer declares. An
   * empty retention set is a no-op, never a wipe — see `AutomationTriggerStore`.
   */
  deleteCursorsNotIn(retained: readonly CursorRetentionKey[]): number {
    if (retained.length === 0) return 0;
    const keep = new Set(retained.map((entry) => rowKey(entry.automationId, entry.triggerIndex)));
    let deleted = 0;
    // Deleting the current entry mid-iteration is well-defined for a Map.
    for (const key of this.rows.keys()) {
      if (keep.has(key)) continue;
      this.rows.delete(key);
      deleted++;
    }
    return deleted;
  }
}
