import type { CentraidAgentStatusEntry } from "../../../centraid-api.js";
import {
  getAgentsStatus,
  getUserPrefs,
  saveUserPrefs,
} from "../../../gateway-client.js";
import type {
  AgentRunnerKind,
  AgentsStatusDTO,
  ModelSubsystem,
} from "../../screen-contracts.js";

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
 * Resolve stale/open runner preference strings onto a runner actually reported
 * by this gateway. Settings still renders every open kind from the wire; turn
 * pickers must not POST a kind absent from that same snapshot.
 */
export function resolveReportedRunnerKind(
  status: AgentsStatusDTO,
  requested: AgentRunnerKind | null | undefined,
  subsystem: ModelSubsystem
): AgentRunnerKind {
  const reported = new Set(status.cards.map((card) => card.kind));
  const candidates = [
    requested,
    status.subsystemRunnerByKey[subsystem],
    status.selectedKind,
    status.cards[0]?.kind,
  ];
  return (
    candidates.find(
      (candidate): candidate is AgentRunnerKind =>
        typeof candidate === "string" && reported.has(candidate)
    ) ??
    requested ??
    status.subsystemRunnerByKey[subsystem] ??
    status.selectedKind
  );
}

/**
 * Card accents, keyed by the kinds this build happens to recognise. Purely
 * cosmetic — an agent whose kind is missing here (a newer gateway's) still
 * renders, just on the neutral accent. This map must never gate what the
 * console shows; the gateway's list is the source of truth for that.
 */
const ACCENT_BY_KIND: Record<string, string> = {
  codex: "var(--c-teal)",
  "claude-code": "var(--c-violet)",
  gemini: "var(--c-indigo)",
  qwen: "var(--c-amber)",
  opencode: "var(--c-teal)",
  grok: "var(--c-rose)",
  kimi: "var(--c-violet)",
  copilot: "var(--c-indigo)",
  cursor: "var(--c-teal)",
  kilo: "var(--c-violet)",
  cline: "var(--c-forest)",
  goose: "var(--c-ochre)",
  auggie: "var(--c-teal)",
  vibe: "var(--c-rose)",
  droid: "var(--c-amber)",
  pi: "var(--c-ochre)",
  acp: "var(--c-slate)",
};
const DEFAULT_ACCENT = "var(--c-slate)";

/** The runner every unpinned subsystem falls back to when prefs name none. */
const FALLBACK_KIND: AgentRunnerKind = "codex";

const SUBSYSTEMS: readonly ModelSubsystem[] = [
  "assistant",
  "ask",
  "builder",
  "automations",
];

function modelPrefKey(
  kind: AgentRunnerKind,
  slot: "default" | ModelSubsystem
): string {
  return `model.${kind}.${slot}`;
}

function configPrefKey(
  kind: AgentRunnerKind,
  slot: "default" | ModelSubsystem,
  category: string
): string {
  return `config.${kind}.${slot}.${category}`;
}

/**
 * The per-subsystem runner pin. NOT under `agent.runner.*` — the daemon's
 * config seeder owns that whole namespace and nulls every key it knows on
 * boot, so a pin parked there would evaporate on restart.
 */
function runnerPrefKey(subsystem: ModelSubsystem): string {
  return `runner.${subsystem}`;
}

function runnerLadderPrefKey(subsystem: ModelSubsystem): string {
  return `runner.ladder.${subsystem}`;
}

/** Pull the explicit `runner.<subsystem>` pins out of the raw prefs snapshot. */
function readRunnerPrefs(
  prefs: Record<string, unknown>
): Partial<Record<ModelSubsystem, AgentRunnerKind>> {
  const byKey: Partial<Record<ModelSubsystem, AgentRunnerKind>> = {};
  for (const s of SUBSYSTEMS) {
    const v = prefs[runnerPrefKey(s)];
    // Any non-empty string counts as a pin. This used to check against a
    // closed pair, which would have silently dropped a pin onto a runner
    // kind this build predates — the gateway is what resolves a pin, and it
    // treats an unknown one as "inherit" anyway.
    if (typeof v === "string" && v) byKey[s] = v;
  }
  return byKey;
}

/** Read ordered ladder membership written as an array (or legacy JSON text). */
function readRunnerLadderPrefs(
  prefs: Record<string, unknown>
): Partial<Record<ModelSubsystem, AgentRunnerKind[]>> {
  const byKey: Partial<Record<ModelSubsystem, AgentRunnerKind[]>> = {};
  for (const subsystem of SUBSYSTEMS) {
    const raw = prefs[runnerLadderPrefKey(subsystem)];
    let decoded: unknown = raw;
    if (typeof raw === "string") {
      try {
        decoded = JSON.parse(raw) as unknown;
      } catch {
        decoded = [];
      }
    }
    if (!Array.isArray(decoded)) continue;
    const kinds = decoded.filter(
      (value, index): value is AgentRunnerKind =>
        typeof value === "string" &&
        value.length > 0 &&
        decoded.indexOf(value) === index
    );
    if (kinds.length > 0) byKey[subsystem] = kinds;
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
  kinds: readonly AgentRunnerKind[]
): {
  defaultByKind: Record<string, string>;
  subsystemByKind: Record<string, Partial<Record<ModelSubsystem, string>>>;
} {
  const defaultByKind: Record<string, string> = {};
  const subsystemByKind: Record<
    string,
    Partial<Record<ModelSubsystem, string>>
  > = {};
  for (const kind of kinds) {
    const d = prefs[modelPrefKey(kind, "default")];
    if (typeof d === "string" && d) defaultByKind[kind] = d;
    const subs: Partial<Record<ModelSubsystem, string>> = {};
    for (const s of SUBSYSTEMS) {
      const v = prefs[modelPrefKey(kind, s)];
      if (typeof v === "string" && v) subs[s] = v;
    }
    subsystemByKind[kind] = subs;
  }
  return { defaultByKind, subsystemByKind };
}

function readConfigPrefs(
  prefs: Record<string, unknown>,
  agents: readonly CentraidAgentStatusEntry[]
): {
  defaultByKind: Record<string, Record<string, string>>;
  subsystemByKind: Record<
    string,
    Partial<Record<ModelSubsystem, Record<string, string>>>
  >;
} {
  const defaultByKind: Record<string, Record<string, string>> = {};
  const subsystemByKind: Record<
    string,
    Partial<Record<ModelSubsystem, Record<string, string>>>
  > = {};
  for (const agent of agents) {
    const categories = new Set(
      (agent.capabilities?.configOptions ?? [])
        .map((option) => option.category)
        .filter((category) => category !== "model")
    );
    const defaults: Record<string, string> = {};
    const subs: Partial<Record<ModelSubsystem, Record<string, string>>> = {};
    for (const category of categories) {
      const defaultValue =
        prefs[configPrefKey(agent.kind, "default", category)];
      if (typeof defaultValue === "string" && defaultValue)
        defaults[category] = defaultValue;
      for (const subsystem of SUBSYSTEMS) {
        const value = prefs[configPrefKey(agent.kind, subsystem, category)];
        if (typeof value !== "string" || !value) continue;
        (subs[subsystem] ??= {})[category] = value;
      }
    }
    defaultByKind[agent.kind] = defaults;
    subsystemByKind[agent.kind] = subs;
  }
  return { defaultByKind, subsystemByKind };
}

/**
 * One wire entry → one card. Every displayed string comes from the gateway
 * (`label`, `version`, `hint`), so a runner kind this build has never heard of
 * still renders a complete, honest card — only the accent falls back.
 */
function capabilityChips(
  caps: CentraidAgentStatusEntry["capabilities"]
): string[] {
  if (!caps?.reachable) {
    return caps?.reason ? [`probe failed`] : [];
  }
  const chips: string[] = [];
  if (caps.mcpHttp) chips.push("vault");
  else chips.push("no vault HTTP");
  if (caps.resume || caps.loadSession)
    chips.push(caps.resume ? "resume" : "load");
  if (caps.modelConfigurable) chips.push("models");
  if (caps.configOptions?.some((option) => option.category === "thought_level"))
    chips.push("effort");
  if (caps.usageUpdateObserved) chips.push("context");
  if (caps.locationsObserved) chips.push("file refs");
  if (caps.additionalDirectories) chips.push("scoped folders");
  if (caps.authRequired) chips.push("sign-in needed");
  if (caps.promptImage) chips.push("images");
  return chips;
}

function toCard(
  entry: CentraidAgentStatusEntry
): AgentsStatusDTO["cards"][number] {
  const models = entry.models ?? [];
  const caps = entry.capabilities;
  const chips = capabilityChips(caps);
  const breakerStates = (entry.health ?? []).flatMap((health) =>
    health.state === "closed"
      ? []
      : [{ failureClass: health.failureClass, state: health.state } as const]
  );
  for (const breaker of breakerStates) {
    chips.push(`${breaker.failureClass} ${breaker.state}`);
  }
  return {
    accent: ACCENT_BY_KIND[entry.kind] ?? DEFAULT_ACCENT,
    connected: entry.available,
    sessionReady:
      entry.available && caps?.reachable === true && caps.authRequired !== true,
    // Installed, but the gateway has not (yet) reported capabilities for it.
    // That is silence, not a refusal — see `sessionProbePending`.
    ...(entry.available && caps === undefined
      ? { sessionProbePending: true }
      : {}),
    ...(entry.available &&
    !(caps?.reachable === true && caps.authRequired !== true)
      ? {
          fallbackBlockedReason: caps?.authRequired
            ? "sign-in required"
            : (caps?.reason ??
              (caps === undefined
                ? "capability probe has not reported yet"
                : "session readiness has not succeeded")),
        }
      : {}),
    kind: entry.kind,
    models: models.map((m) => ({
      default: m.default,
      id: m.id,
      name: m.name,
      tier: m.tier,
    })),
    modelsLoading: entry.modelsStatus === "loading" && models.length === 0,
    ...(caps?.configOptions ? { configOptions: caps.configOptions } : {}),
    ...(caps?.additionalDirectories ? { additionalDirectories: true } : {}),
    ...(caps?.modelConfigurable ? { modelConfigurable: true } : {}),
    ...(caps?.promptImage || caps?.promptAudio || caps?.promptEmbeddedContext
      ? { supportsAttachments: true }
      : {}),
    ...(caps?.usageUpdateObserved ? { supportsContext: true } : {}),
    // The gateway's install hint IS the "why not" for an unavailable agent —
    // more useful than the old locally-composed "<bin> not found on PATH",
    // which this client could only write for binaries it knew about.
    subtitle: entry.available
      ? (entry.version ?? `${entry.label} · detected`)
      : (entry.hint ?? `${entry.label} CLI not found`),
    title: entry.label,
    ...(chips.length ? { capabilityChips: chips } : {}),
    ...(caps && !caps.mcpHttp && caps.reachable
      ? { vaultUnavailable: true }
      : {}),
    ...(caps?.authRequired ? { authRequired: true } : {}),
    ...(breakerStates.length ? { breakerStates } : {}),
  };
}

function toDTO(
  status: Snap,
  kind: AgentRunnerKind,
  defaultByKind: Record<string, string>,
  subsystemByKind: Record<string, Partial<Record<ModelSubsystem, string>>>,
  defaultConfigPinsByKind: Record<string, Record<string, string>>,
  subsystemConfigPinsByKind: Record<
    string,
    Partial<Record<ModelSubsystem, Record<string, string>>>
  >,
  subsystemRunnerByKey: Partial<Record<ModelSubsystem, AgentRunnerKind>>,
  subsystemRunnerLadders: Partial<Record<ModelSubsystem, AgentRunnerKind[]>>
): AgentsStatusDTO {
  const agents = status.agents ?? [];
  return {
    anyLoading: agents.some((a) => a.modelsStatus === "loading"),
    cards: agents.map(toCard),
    savedModelByKind: defaultByKind,
    subsystemModelByKind: subsystemByKind,
    defaultConfigPinsByKind,
    subsystemConfigPinsByKind,
    diagnosticsJson: JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        agents: agents.map((agent) => ({
          kind: agent.kind,
          available: agent.available,
          version: agent.version,
          minVersion: agent.minVersion,
          capabilities: agent.capabilities,
        })),
      },
      null,
      2
    ),
    subsystemRunnerByKey,
    subsystemRunnerLadders,
    selectedKind: kind,
  };
}

export async function loadProviders(opts?: {
  refresh?: boolean;
}): Promise<AgentsStatusDTO> {
  const [status, prefs] = await Promise.all([
    getAgentsStatus(opts).catch(() => ({ agents: [] }) as Snap),
    getUserPrefs().catch(() => ({}) as Record<string, unknown>),
  ]);
  const kindRaw = prefs["agent.runner.kind"];
  // Trust the persisted kind as-is (the gateway validated it on write and
  // resolves it on read); only an absent/blank value falls back.
  const selectedKind =
    typeof kindRaw === "string" && kindRaw
      ? (kindRaw as AgentRunnerKind)
      : FALLBACK_KIND;
  const { defaultByKind, subsystemByKind } = readModelPrefs(
    prefs,
    (status.agents ?? []).map((a) => a.kind)
  );
  const config = readConfigPrefs(prefs, status.agents ?? []);
  return toDTO(
    status,
    selectedKind,
    defaultByKind,
    subsystemByKind,
    config.defaultByKind,
    config.subsystemByKind,
    readRunnerPrefs(prefs),
    readRunnerLadderPrefs(prefs)
  );
}

/** Switch the DEFAULT agent — the runner every unpinned subsystem inherits. */
export async function activateRunner(kind: AgentRunnerKind): Promise<boolean> {
  try {
    await saveUserPrefs({ "agent.runner.kind": kind });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pin one subsystem to a runner ('' clears the key, so the subsystem
 * inherits the default agent again — the same `'' → null` delete convention
 * the model setters use).
 */
export async function setSubsystemRunner(
  subsystem: ModelSubsystem,
  kind: AgentRunnerKind | ""
): Promise<boolean> {
  try {
    await saveUserPrefs({ [runnerPrefKey(subsystem)]: kind || null });
    return true;
  } catch {
    return false;
  }
}

export function setSubsystemRunnerLadder(
  subsystem: ModelSubsystem,
  kinds: AgentRunnerKind[]
): void {
  void saveUserPrefs({
    [runnerLadderPrefKey(subsystem)]: kinds.length > 0 ? kinds : null,
  });
}

/** Persist this agent's default model ('' clears the key, falling through to the backend default). */
export function setAgentModel(kind: AgentRunnerKind, modelId: string): void {
  void saveUserPrefs({ [modelPrefKey(kind, "default")]: modelId || null });
}

/** Persist this agent's per-subsystem model override ('' clears the key, falling through to the default model). */
export function setSubsystemModel(
  kind: AgentRunnerKind,
  subsystem: ModelSubsystem,
  modelId: string
): void {
  void saveUserPrefs({ [modelPrefKey(kind, subsystem)]: modelId || null });
}

export function setAgentConfigPin(
  kind: AgentRunnerKind,
  category: string,
  value: string
): void {
  void saveUserPrefs({
    [configPrefKey(kind, "default", category)]: value || null,
  });
}

export function setSubsystemConfigPin(
  kind: AgentRunnerKind,
  subsystem: ModelSubsystem,
  category: string,
  value: string
): void {
  void saveUserPrefs({
    [configPrefKey(kind, subsystem, category)]: value || null,
  });
}
