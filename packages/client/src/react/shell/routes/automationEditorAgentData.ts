import type { AgentsStatusDTO, AutomationEditorData } from '../../screen-contracts.js';

export type AutomationAgentEditorData = Pick<
  AutomationEditorData,
  'agentRunners' | 'defaultModel' | 'defaultRunnerKind'
>;

function catalogDefaultModel(status: AgentsStatusDTO, kind: string): string | null {
  const scoped = status.subsystemModelByKind[kind]?.automations;
  if (scoped) return scoped;
  const saved = status.savedModelByKind[kind];
  if (saved) return saved;
  return (
    status.cards.find((card) => card.kind === kind)?.models.find((model) => model.default)?.id ??
    null
  );
}

/** Dynamic gateway runner/model catalog plus the effective automations pins. */
export function buildAutomationAgentEditorData(status: AgentsStatusDTO): AutomationAgentEditorData {
  const defaultRunnerKind = status.subsystemRunnerByKey.automations ?? status.selectedKind;
  return {
    agentRunners: status.cards.map((card) => ({
      accent: card.accent,
      connected: card.connected,
      defaultModel: catalogDefaultModel(status, card.kind),
      kind: card.kind,
      label: card.title,
      models: card.models,
    })),
    defaultModel: catalogDefaultModel(status, defaultRunnerKind),
    defaultRunnerKind,
  };
}
