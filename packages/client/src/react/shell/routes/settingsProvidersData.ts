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
//
// Runner selection is per subsystem the same way: `runner.<subsystem>` pins
// one register to a runner, and `agent.runner.kind` is the DEFAULT agent
// every unpinned subsystem inherits. Same fall-through rule — a
// missing/empty pin resolves server-side, so this module only ever sends
// explicit pins and deletes.

type Snap = Awaited<ReturnType<typeof getAgentsStatus>>;

const RUNNER_META = [
  { kind: 'codex', title: 'Codex', bin: 'codex', accent: '#10b981' },
  { kind: 'claude-code', title: 'Claude Code', bin: 'claude', accent: '#a855f7' },
] as const;

const SUBSYSTEMS: readonly ModelSubsystem[] = ['assistant', 'ask', 'builder', 'automations'];

function modelPrefKey(kind: AgentRunnerKind, slot: 'default' | ModelSubsystem): string {
  return `model.${kind}.${slot}`;
}

/**
 * The per-subsystem runner pin. NOT under `agent.runner.*` — the daemon's
 * config seeder owns that whole namespace and nulls every key it knows on
 * boot, so a pin parked there would evaporate on restart.
 */
function runnerPrefKey(subsystem: ModelSubsystem): string {
  return `runner.${subsystem}`;
}

/** Pull the explicit `runner.<subsystem>` pins out of the raw prefs snapshot. */
function readRunnerPrefs(
  prefs: Record<string, unknown>,
): Partial<Record<ModelSubsystem, AgentRunnerKind>> {
  const byKey: Partial<Record<ModelSubsystem, AgentRunnerKind>> = {};
  for (const s of SUBSYSTEMS) {
    const v = prefs[runnerPrefKey(s)];
    // Only a known kind counts as a pin — anything else (absent, empty,
    // or junk) means "inherit the default agent", which is what the
    // gateway's own resolution does with it.
    if (v === 'codex' || v === 'claude-code') byKey[s] = v;
  }
  return byKey;
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
  subsystemRunnerByKey: Partial<Record<ModelSubsystem, AgentRunnerKind>>,
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
    subsystemRunnerByKey,
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
    readRunnerPrefs(prefs),
  );
}

/** Switch the DEFAULT agent — the runner every unpinned subsystem inherits. */
export async function activateRunner(kind: AgentRunnerKind): Promise<boolean> {
  await saveUserPrefs({ 'agent.runner.kind': kind });
  return true;
}

/**
 * Pin one subsystem to a runner ('' clears the key, so the subsystem
 * inherits the default agent again — the same `'' → null` delete convention
 * the model setters use).
 */
export function setSubsystemRunner(subsystem: ModelSubsystem, kind: AgentRunnerKind | ''): void {
  void saveUserPrefs({ [runnerPrefKey(subsystem)]: kind || null });
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
