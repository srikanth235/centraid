import { isRunnerKind, resolveSubsystemModel, type RunnerKind } from '@centraid/app-engine';
import type { ManifestRequires } from '@centraid/automation';

/**
 * Resolve one automation's harness/model with manifest pins taking priority.
 * Runner keys stay open in the manifest for registry forward compatibility;
 * this host executes only keys registered in its current runtime.
 */
export function resolveAutomationAgentSelection(
  requires: ManifestRequires,
  prefs: Record<string, unknown>,
  fallbackRunner: RunnerKind,
): { runner: RunnerKind; model?: string } {
  const runner = isRunnerKind(requires.runner) ? requires.runner : fallbackRunner;
  const model = resolveSubsystemModel(prefs, runner, 'automations', requires.model);
  return { runner, ...(model ? { model } : {}) };
}
