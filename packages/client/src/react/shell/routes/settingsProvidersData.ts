import { getAgentsStatus, getUserPrefs, saveUserPrefs } from '../../../gateway-client.js';
import type { AgentRunnerKind, AgentsStatusDTO, ModelSubsystem } from '../../screen-contracts.js';

// Providers (agents) console data — ports the vanilla app-settings.ts agent
// status derivation. Centraid runs the user's installed coding-agent CLIs in
// place; the gateway reports which are runnable on its host. This maps that
// snapshot into the AgentsStatusDTO the SettingsProvidersScreen renders.
//
// Model selection moved off desktop-local settings and onto the gateway
// prefs store (`GET/PUT /_centraid-user/prefs`) so every client sharing a
// gateway sees the same picks. Keys are `model.<runnerKind>.<slot>` where
// `<slot>` is `default` (the runner's own default) or one of the
// `ModelSubsystem`s (`assistant` | `ask` | `builder` | `automations`). A
// missing/empty value falls through to the next tier server-side.

type Snap = Awaited<ReturnType<typeof getAgentsStatus>>;

const RUNNER_META = [
  { kind: 'codex', title: 'Codex', bin: 'codex', accent: '#10b981' },
  { kind: 'claude-code', title: 'Claude Code', bin: 'claude', accent: '#a855f7' },
] as const;

const SUBSYSTEMS: readonly ModelSubsystem[] = ['assistant', 'ask', 'builder', 'automations'];

function modelPrefKey(kind: AgentRunnerKind, slot: 'default' | ModelSubsystem): string {
  return `model.${kind}.${slot}`;
}

/** Pull every `model.<kind>.<slot>` string out of the raw prefs snapshot. */
function readModelPrefs(prefs: Record<string, unknown>): {
  defaultByKind: Record<string, string>;
  subsystemByKind: Record<string, Partial<Record<ModelSubsystem, string>>>;
} {
  const defaultByKind: Record<string, string> = {};
  const subsystemByKind: Record<string, Partial<Record<ModelSubsystem, string>>> = {};
  for (const r of RUNNER_META) {
    const d = prefs[modelPrefKey(r.kind, 'default')];
    if (typeof d === 'string' && d) defaultByKind[r.kind] = d;
    const subs: Partial<Record<ModelSubsystem, string>> = {};
    for (const s of SUBSYSTEMS) {
      const v = prefs[modelPrefKey(r.kind, s)];
      if (typeof v === 'string' && v) subs[s] = v;
    }
    subsystemByKind[r.kind] = subs;
  }
  return { defaultByKind, subsystemByKind };
}

function toDTO(
  status: Snap,
  kind: AgentRunnerKind,
  defaultByKind: Record<string, string>,
  subsystemByKind: Record<string, Partial<Record<ModelSubsystem, string>>>,
): AgentsStatusDTO {
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
      const modelsStatus =
        r.kind === 'codex' ? status.codexModelsStatus : status.claudeModelsStatus;
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
    savedModelByKind: defaultByKind,
    subsystemModelByKind: subsystemByKind,
    selectedKind: kind,
  };
}

export async function loadProviders(opts?: {
  refresh?: boolean;
  refreshTools?: boolean;
}): Promise<AgentsStatusDTO> {
  const [status, prefs] = await Promise.all([
    getAgentsStatus(opts).catch(() => ({ codexAvailable: false, claudeAvailable: false }) as Snap),
    getUserPrefs().catch(() => ({}) as Record<string, unknown>),
  ]);
  const kindRaw = prefs['agent.runner.kind'];
  const { defaultByKind, subsystemByKind } = readModelPrefs(prefs);
  return toDTO(
    status,
    kindRaw === 'claude-code' ? 'claude-code' : 'codex',
    defaultByKind,
    subsystemByKind,
  );
}

export async function activateRunner(kind: AgentRunnerKind): Promise<boolean> {
  await saveUserPrefs({ 'agent.runner.kind': kind });
  return true;
}

/** Persist this agent's default model ('' clears the key, falling through to the backend default). */
export function setAgentModel(kind: AgentRunnerKind, modelId: string): void {
  void saveUserPrefs({ [modelPrefKey(kind, 'default')]: modelId || null });
}

/** Persist this agent's per-subsystem model override ('' clears the key, falling through to the default model). */
export function setSubsystemModel(
  kind: AgentRunnerKind,
  subsystem: ModelSubsystem,
  modelId: string,
): void {
  void saveUserPrefs({ [modelPrefKey(kind, subsystem)]: modelId || null });
}
