import {
  isHarnessKind,
  resolveSubsystemConfigPins,
  resolveSubsystemModel,
} from "@centraid/app-engine";
import type { HarnessKind } from "@centraid/app-engine";
import type { ManifestRequires } from "@centraid/automation";

/**
 * Where the selected harness came from. `prefs` means the user's own
 * automations primary (or a manifest pin that names it anyway) — user-authored
 * consent for unattended egress. `manifest` means the automation's own
 * `requires.harness` chose a different provider; manifests are harness-writable,
 * so that selection is NOT consent and must be checked against the user's
 * ladder before anything leaves the device (#567 D13/D5).
 */
type AutomationHarnessSelectionSource = "prefs" | "manifest";

export interface AutomationHarnessSelection {
  harness: HarnessKind;
  selectionSource: AutomationHarnessSelectionSource;
  model?: string;
  configPins?: Readonly<Record<string, string>>;
}

/**
 * Resolve one automation's harness/model with manifest pins taking priority.
 * Harness keys stay open in the manifest for registry forward compatibility;
 * this host executes only keys registered in its current runtime.
 */
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

/**
 * Revision may use a cheap rewrite default only when the automation did not
 * pin a model. An explicit per-automation model is part of the automation's
 * execution identity and therefore wins during standing-instruction rewrite.
 */
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
