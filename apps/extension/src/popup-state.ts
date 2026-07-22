import { COMPANION_MODULE_CATALOG } from './types.js';
import type { CompanionModule, ModuleStatus } from './types.js';

/** Selected modules remain visible but paused while locked or unreachable. */
export function pausedModuleStatuses(selected: readonly CompanionModule[]): ModuleStatus[] {
  const enabled = new Set(selected);
  return COMPANION_MODULE_CATALOG.map((module) => ({
    ...module,
    state: enabled.has(module.id) ? 'paused' : 'revoked',
  }));
}

export function blockingSummary(count: number): string {
  if (count <= 0) return 'No approvals waiting.';
  return `${count} approval${count === 1 ? '' : 's'} waiting in Centraid.`;
}
