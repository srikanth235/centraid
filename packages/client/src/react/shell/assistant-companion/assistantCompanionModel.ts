export type AssistantCompanionSurface = "pointer" | "touch";

export type AssistantEffort = {
  id: string;
  label: string;
  note: string;
};

export type AssistantModelOption = {
  id: string;
  label: string;
  efforts: readonly AssistantEffort[];
  noEffortReason?: string;
};

export type AssistantHarnessOption = {
  id: string;
  label: string;
  vendorLabel: string;
  statusLabel: string;
  installed: boolean;
  models: readonly AssistantModelOption[];
};

export type AssistantSelection = {
  harnessId: string;
  modelId: string;
  effortId?: string;
};

export type ResolvedAssistantSelection = {
  harness: AssistantHarnessOption;
  model: AssistantModelOption;
  effort?: AssistantEffort;
};

export function selectionForHarness(
  harness: AssistantHarnessOption
): AssistantSelection {
  const model = harness.models[0];
  if (!model) {
    return { harnessId: harness.id, modelId: "" };
  }
  const effort = model.efforts.at(-1);
  return {
    harnessId: harness.id,
    modelId: model.id,
    ...(effort ? { effortId: effort.id } : {}),
  };
}

export function initialAssistantSelection(
  catalog: readonly AssistantHarnessOption[],
  requested?: AssistantSelection
): AssistantSelection | null {
  if (requested && resolveAssistantSelection(catalog, requested)) {
    return requested;
  }
  const harness = catalog[0];
  return harness ? selectionForHarness(harness) : null;
}

export function resolveAssistantSelection(
  catalog: readonly AssistantHarnessOption[],
  selection: AssistantSelection | null
): ResolvedAssistantSelection | null {
  if (!selection) return null;
  const harness = catalog.find((item) => item.id === selection.harnessId);
  const model = harness?.models.find((item) => item.id === selection.modelId);
  if (!harness || !model) return null;
  const effort = model.efforts.find((item) => item.id === selection.effortId);
  return { harness, model, ...(effort ? { effort } : {}) };
}

export function selectionForModel(
  selection: AssistantSelection,
  model: AssistantModelOption
): AssistantSelection {
  const effort = model.efforts.at(-1);
  return {
    harnessId: selection.harnessId,
    modelId: model.id,
    ...(effort ? { effortId: effort.id } : {}),
  };
}

export function assistantConsequence(
  resolved: ResolvedAssistantSelection | null,
  attachmentCount: number
): string {
  if (!resolved) return "Choose a harness and model to send.";
  if (!resolved.harness.installed) {
    return `${resolved.harness.label} is not installed — install it or pick another harness.`;
  }
  const attached =
    attachmentCount === 0
      ? ""
      : `, and the ${attachmentCount} ${attachmentCount === 1 ? "thing" : "things"} attached,`;
  return `${resolved.harness.label} sends what you ask${attached} to ${resolved.harness.vendorLabel}.`;
}

export function assistantWorkingLine(
  resolved: ResolvedAssistantSelection | null
): string | null {
  if (!resolved) return null;
  return [
    resolved.harness.label,
    resolved.model.label,
    resolved.effort ? `${resolved.effort.label} effort` : null,
    "working",
  ]
    .filter(Boolean)
    .join(" · ");
}
