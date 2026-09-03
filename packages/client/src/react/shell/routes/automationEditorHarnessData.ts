import type {
  HarnessesStatusDTO,
  AutomationEditorData,
} from "../../screen-contracts.js";

export type AutomationHarnessEditorData = Pick<
  AutomationEditorData,
  "harnesses" | "defaultModel" | "defaultHarnessKind"
>;

function catalogDefaultModel(
  status: HarnessesStatusDTO,
  kind: string
): string | null {
  const scoped = status.subsystemModelByKind[kind]?.automations;
  if (scoped) return scoped;
  const saved = status.savedModelByKind[kind];
  if (saved) return saved;
  return (
    status.cards
      .find((card) => card.kind === kind)
      ?.models.find((model) => model.default)?.id ?? null
  );
}

export function buildAutomationHarnessEditorData(
  status: HarnessesStatusDTO
): AutomationHarnessEditorData {
  const defaultHarnessKind =
    status.subsystemHarnessByKey.automations ?? status.selectedKind;
  return {
    harnesses: status.cards.map((card) => ({
      accent: card.accent,
      connected: card.connected,
      defaultModel: catalogDefaultModel(status, card.kind),
      kind: card.kind,
      label: card.title,
      models: card.models,
    })),
    defaultModel: catalogDefaultModel(status, defaultHarnessKind),
    defaultHarnessKind,
  };
}
