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

/**
 * Revision may use a cheap rewrite default only when the automation did not
 * pin a model. An explicit per-automation model is part of the automation's
 * execution identity and therefore wins during standing-instruction rewrite.
 */
export function resolveAutomationRewriteModel(
  requires: ManifestRequires,
  selection: { runner: RunnerKind; model?: string },
  configuredRewrite: unknown,
  fastModel?: string,
): string | undefined {
  if (requires.model) return requires.model;
  if (typeof configuredRewrite === 'string' && configuredRewrite) return configuredRewrite;
  if (fastModel) return fastModel;
  return selection.runner === 'claude-code' ? 'fast' : selection.model;
}
