import {
  isRunnerKind,
  resolveSubsystemConfigPins,
  resolveSubsystemModel,
  type RunnerKind,
} from "@centraid/app-engine";
import type { ManifestRequires } from "@centraid/automation";

/**
 * Where the selected runner came from. `prefs` means the user's own
 * automations primary (or a manifest pin that names it anyway) — user-authored
 * consent for unattended egress. `manifest` means the automation's own
 * `requires.runner` chose a different provider; manifests are agent-writable,
 * so that selection is NOT consent and must be checked against the user's
 * ladder before anything leaves the device (#567 D13/D5).
 */
type AutomationRunnerSelectionSource = "prefs" | "manifest";

export interface AutomationAgentSelection {
  runner: RunnerKind;
  selectionSource: AutomationRunnerSelectionSource;
  model?: string;
  configPins?: Readonly<Record<string, string>>;
}

/**
 * Resolve one automation's harness/model with manifest pins taking priority.
 * Runner keys stay open in the manifest for registry forward compatibility;
 * this host executes only keys registered in its current runtime.
 */
export function resolveAutomationAgentSelection(
  requires: ManifestRequires,
  prefs: Record<string, unknown>,
  fallbackRunner: RunnerKind,
  options: { includeManifestProviderPins?: boolean } = {}
): AutomationAgentSelection {
  const runner = isRunnerKind(requires.runner)
    ? requires.runner
    : fallbackRunner;
  const selectionSource: AutomationRunnerSelectionSource =
    runner === fallbackRunner ? "prefs" : "manifest";
  const includeManifestProviderPins =
    options.includeManifestProviderPins ?? true;
  const model = resolveSubsystemModel(
    prefs,
    runner,
    "automations",
    includeManifestProviderPins ? requires.model : undefined
  );
  const configPins = resolveSubsystemConfigPins(
    prefs,
    runner,
    "automations",
    includeManifestProviderPins && requires.thoughtLevel
      ? { thought_level: requires.thoughtLevel }
      : {}
  );
  return {
    runner,
    selectionSource,
    ...(model ? { model } : {}),
    ...(Object.keys(configPins).length > 0 ? { configPins } : {}),
  };
}

/**
 * Revision may use a cheap rewrite default only when the automation did not
 * pin a model. An explicit per-automation model is part of the automation's
 * execution identity and therefore wins during standing-instruction rewrite.
 */
export function resolveAutomationRewriteModel(
  requires: ManifestRequires,
  selection: {
    runner: RunnerKind;
    model?: string;
    configPins?: Readonly<Record<string, string>>;
  },
  configuredRewrite: unknown,
  fastModel?: string
): string | undefined {
  if (requires.model) return requires.model;
  if (typeof configuredRewrite === "string" && configuredRewrite)
    return configuredRewrite;
  if (fastModel) return fastModel;
  return selection.runner === "claude-code" ? "fast" : selection.model;
}
