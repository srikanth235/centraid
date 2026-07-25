import type { AutomationTriggerCursor, AutomationTriggerStore } from '@centraid/app-engine';

/** Process-local cursor store for injected/test schedulers without a durable host store. */
export class MemoryCursorStore {
  private readonly rows = new Map<string, AutomationTriggerCursor>();

  getCursor(automationId: string, triggerIndex: number): AutomationTriggerCursor | undefined {
    return this.rows.get(`${automationId}\u0000${triggerIndex}`);
  }

  putCursor(input: Parameters<AutomationTriggerStore['putCursor']>[0]): void {
    this.rows.set(`${input.automationId}\u0000${input.triggerIndex}`, {
      automationId: input.automationId,
      triggerIndex: input.triggerIndex,
      sourceKind: input.sourceKind,
      ...(input.positionJson !== undefined ? { positionJson: input.positionJson } : {}),
      ...(input.windowFrom !== undefined ? { windowFrom: input.windowFrom } : {}),
      ...(input.windowTo !== undefined ? { windowTo: input.windowTo } : {}),
      skipped: input.skipped ?? 0,
      ...(input.gapReason !== undefined ? { gapReason: input.gapReason } : {}),
      updatedAt: input.updatedAt,
    });
  }

  deleteCursorsNotIn(automationIds: readonly string[]): number {
    const keep = new Set(automationIds);
    let deleted = 0;
    for (const [key, row] of this.rows) {
      if (keep.has(row.automationId)) continue;
      this.rows.delete(key);
      deleted++;
    }
    return deleted;
  }
}
