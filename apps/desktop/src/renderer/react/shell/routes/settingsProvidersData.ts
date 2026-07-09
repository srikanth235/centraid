import { getAgentsStatus, getUserPrefs, saveUserPrefs } from '../../../gateway-client.js';
import type { AgentRunnerKind, AgentsStatusDTO } from '../../bridge.js';

// Providers (agents) console data — ports the vanilla app-settings.ts agent
// status derivation. Centraid runs the user's installed coding-agent CLIs in
// place; the gateway reports which are runnable on its host. This maps that
// snapshot into the AgentsStatusDTO the SettingsProvidersScreen renders.

type Snap = Awaited<ReturnType<typeof getAgentsStatus>>;

const RUNNER_META = [
  { kind: 'codex', title: 'Codex', bin: 'codex', accent: '#10b981' },
  { kind: 'claude-code', title: 'Claude Code', bin: 'claude', accent: '#a855f7' },
] as const;

function toDTO(status: Snap, kind: AgentRunnerKind, modelMap: Record<string, string>): AgentsStatusDTO {
  return {
    anyLoading: [
      status.codexModelsStatus,
      status.claudeModelsStatus,
      status.codexToolsStatus,
      status.claudeToolsStatus,
    ].some((s) => s === 'loading'),
    cards: RUNNER_META.map((r) => {
      const available = r.kind === 'codex' ? status.codexAvailable : status.claudeAvailable;
      const ver = r.kind === 'codex' ? status.codexVersion : status.claudeVersion;
      const models = (r.kind === 'codex' ? status.codexModels : status.claudeModels) ?? [];
      const tools = (r.kind === 'codex' ? status.codexTools : status.claudeTools) ?? [];
      const modelsStatus = r.kind === 'codex' ? status.codexModelsStatus : status.claudeModelsStatus;
      const toolsStatus = r.kind === 'codex' ? status.codexToolsStatus : status.claudeToolsStatus;
      return {
        accent: r.accent,
        connected: available,
        kind: r.kind,
        models: models.map((m) => ({ default: m.default, id: m.id, name: m.name, tier: m.tier })),
        modelsLoading: modelsStatus === 'loading' && models.length === 0,
        subtitle: available ? (ver ?? `${r.bin} · detected`) : `${r.bin} CLI not found on PATH`,
        title: r.title,
        tools: tools.map((t) => ({
          description: t.description,
          hasArgs: t.inputSchema !== undefined,
          name: t.name,
          server: t.server,
          source: t.source,
        })),
        toolsLoading: toolsStatus === 'loading' && tools.length === 0,
      };
    }),
    savedModelByKind: modelMap,
    selectedKind: kind,
  };
}

export async function loadProviders(opts?: {
  refresh?: boolean;
  refreshTools?: boolean;
}): Promise<AgentsStatusDTO> {
  const [status, kindRaw, modelMap] = await Promise.all([
    getAgentsStatus(opts).catch(() => ({ codexAvailable: false, claudeAvailable: false }) as Snap),
    getUserPrefs()
      .then((p) => p['agent.runner.kind'])
      .catch(() => undefined),
    window.CentraidApi.getSettings()
      .then((s) => s.chatModelByRunner)
      .catch(() => undefined),
  ]);
  return toDTO(status, kindRaw === 'claude-code' ? 'claude-code' : 'codex', modelMap ?? {});
}

export async function activateRunner(kind: AgentRunnerKind): Promise<boolean> {
  await saveUserPrefs({ 'agent.runner.kind': kind });
  return true;
}

export function setAgentModel(kind: AgentRunnerKind, modelId: string): void {
  void window.CentraidApi.saveSettings({ chatModelByRunner: { [kind]: modelId } });
}
