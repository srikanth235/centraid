import { getAgentsStatus, getUserPrefs, saveUserPrefs } from '../../../gateway-client.js';
import type { AgentRunnerKind, AgentsStatusDTO, ModelSubsystem } from '../../screen-contracts.js';
import type { CentraidAgentStatusEntry } from '../../../centraid-api.js';

// Providers (agents) console data. Centraid runs the user's installed
// coding-agent CLIs in place; the gateway reports which are runnable on its
// host. This maps that snapshot into the AgentsStatusDTO the
// SettingsProvidersScreen renders.
//
// The snapshot is a LIST (`{ agents: [...] }`), one entry per runner kind the
// gateway registers — it used to be `codex*`/`claude*` field pairs matched
// against a local 2-row table, which meant a runner the gateway grew was
// invisible here until this file was edited too. Nothing below enumerates
// runner kinds locally any more: the gateway's list drives the cards, the
// model-prefs read, and the pickers alike.
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

/**
 * Card accents, keyed by the kinds this build happens to recognise. Purely
 * cosmetic — an agent whose kind is missing here (a newer gateway's) still
 * renders, just on the neutral accent. This map must never gate what the
 * console shows; the gateway's list is the source of truth for that.
 */
const ACCENT_BY_KIND: Record<string, string> = {
  codex: '#10b981',
  'claude-code': '#a855f7',
  gemini: '#3b82f6',
  qwen: '#f59e0b',
  opencode: '#0ea5e9',
  grok: '#e11d48',
  kimi: '#8b5cf6',
  acp: '#64748b',
};
const DEFAULT_ACCENT = '#64748b';

/** The runner every unpinned subsystem falls back to when prefs name none. */
const FALLBACK_KIND: AgentRunnerKind = 'codex';

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
    // Any non-empty string counts as a pin. This used to check against a
    // closed pair, which would have silently dropped a pin onto a runner
    // kind this build predates — the gateway is what resolves a pin, and it
    // treats an unknown one as "inherit" anyway.
    if (typeof v === 'string' && v) byKey[s] = v;
  }
  return byKey;
}

/**
 * Pull every `model.<kind>.<slot>` string out of the raw prefs snapshot, for
 * each kind the gateway reported. Driven by the gateway's list rather than a
 * local table so a new runner's saved models are read, not stranded.
 */
function readModelPrefs(
  prefs: Record<string, unknown>,
  kinds: readonly AgentRunnerKind[],
): {
  defaultByKind: Record<string, string>;
  subsystemByKind: Record<string, Partial<Record<ModelSubsystem, string>>>;
} {
  const defaultByKind: Record<string, string> = {};
  const subsystemByKind: Record<string, Partial<Record<ModelSubsystem, string>>> = {};
  for (const kind of kinds) {
    const d = prefs[modelPrefKey(kind, 'default')];
    if (typeof d === 'string' && d) defaultByKind[kind] = d;
    const subs: Partial<Record<ModelSubsystem, string>> = {};
    for (const s of SUBSYSTEMS) {
      const v = prefs[modelPrefKey(kind, s)];
      if (typeof v === 'string' && v) subs[s] = v;
    }
    subsystemByKind[kind] = subs;
  }
  return { defaultByKind, subsystemByKind };
}

/**
 * One wire entry → one card. Every displayed string comes from the gateway
 * (`label`, `version`, `hint`), so a runner kind this build has never heard of
 * still renders a complete, honest card — only the accent falls back.
 */
function toCard(entry: CentraidAgentStatusEntry): AgentsStatusDTO['cards'][number] {
  const models = entry.models ?? [];
  return {
    accent: ACCENT_BY_KIND[entry.kind] ?? DEFAULT_ACCENT,
    connected: entry.available,
    kind: entry.kind,
    models: models.map((m) => ({ default: m.default, id: m.id, name: m.name, tier: m.tier })),
    modelsLoading: entry.modelsStatus === 'loading' && models.length === 0,
    // The gateway's install hint IS the "why not" for an unavailable agent —
    // more useful than the old locally-composed "<bin> not found on PATH",
    // which this client could only write for binaries it knew about.
    subtitle: entry.available
      ? (entry.version ?? `${entry.label} · detected`)
      : (entry.hint ?? `${entry.label} CLI not found`),
    title: entry.label,
  };
}

function toDTO(
  status: Snap,
  kind: AgentRunnerKind,
  defaultByKind: Record<string, string>,
  subsystemByKind: Record<string, Partial<Record<ModelSubsystem, string>>>,
  subsystemRunnerByKey: Partial<Record<ModelSubsystem, AgentRunnerKind>>,
): AgentsStatusDTO {
  const agents = status.agents ?? [];
  return {
    anyLoading: agents.some((a) => a.modelsStatus === 'loading'),
    cards: agents.map(toCard),
    savedModelByKind: defaultByKind,
    subsystemModelByKind: subsystemByKind,
    subsystemRunnerByKey,
    selectedKind: kind,
  };
}

export async function loadProviders(opts?: { refresh?: boolean }): Promise<AgentsStatusDTO> {
  const [status, prefs] = await Promise.all([
    getAgentsStatus(opts).catch(() => ({ agents: [] }) as Snap),
    getUserPrefs().catch(() => ({}) as Record<string, unknown>),
  ]);
  const kindRaw = prefs['agent.runner.kind'];
  // Trust the persisted kind as-is (the gateway validated it on write and
  // resolves it on read); only an absent/blank value falls back.
  const selectedKind =
    typeof kindRaw === 'string' && kindRaw ? (kindRaw as AgentRunnerKind) : FALLBACK_KIND;
  const { defaultByKind, subsystemByKind } = readModelPrefs(
    prefs,
    (status.agents ?? []).map((a) => a.kind),
  );
  return toDTO(status, selectedKind, defaultByKind, subsystemByKind, readRunnerPrefs(prefs));
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
