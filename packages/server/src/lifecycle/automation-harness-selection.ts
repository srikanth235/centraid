import type { ManifestRequires } from "@centraid/server/automation";
import {
  isHarnessKind,
  resolveSubsystemConfigPins,
  resolveSubsystemModel,
} from "@centraid/server/engine";
import type { HarnessKind } from "@centraid/server/engine";

type AutomationHarnessSelectionSource = "prefs" | "manifest";

export interface AutomationHarnessSelection {
  harness: HarnessKind;
  selectionSource: AutomationHarnessSelectionSource;
  model?: string;
  configPins?: Readonly<Record<string, string>>;
}

export function resolveAutomationHarnessSelection(
  requires: ManifestRequires,
  prefs: Record<string, unknown>,
  fallbackHarness: HarnessKind,
  options: { includeManifestProviderPins?: boolean } = {}
): AutomationHarnessSelection {
  const harness = isHarnessKind(requires.harness)
    ? requires.harness
    : fallbackHarness;
  const selectionSource: AutomationHarnessSelectionSource =
    harness === fallbackHarness ? "prefs" : "manifest";
  const includeManifestProviderPins =
    options.includeManifestProviderPins ?? true;
  const model = resolveSubsystemModel(
    prefs,
    harness,
    "automations",
    includeManifestProviderPins ? requires.model : undefined
  );
  const configPins = resolveSubsystemConfigPins(
    prefs,
    harness,
    "automations",
    includeManifestProviderPins && requires.thoughtLevel
      ? { thought_level: requires.thoughtLevel }
      : {}
  );
  return {
    harness,
    selectionSource,
    ...(model ? { model } : {}),
    ...(Object.keys(configPins).length > 0 ? { configPins } : {}),
  };
}

export function resolveAutomationRewriteModel(
  requires: ManifestRequires,
  selection: {
    harness: HarnessKind;
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
  return selection.harness === "claude-code" ? "fast" : selection.model;
}
