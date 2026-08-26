import type { CentraidHarnessStatusEntry } from "../../../centraid-api.js";
import {
  getHarnessesStatus,
  getUserPrefs,
  saveUserPrefs,
} from "../../../gateway-client.js";
import type {
  HarnessKind,
  HarnessesStatusDTO,
  ModelSubsystem,
} from "../../screen-contracts.js";

// Harness console: map the gateway's `{ harnesses: [...] }` list into
// HarnessesStatusDTO. Never enumerate kinds locally — a new gateway harness
// must still render. Prefs: `model.<kind>.<slot>`, `harness.<subsystem>`,
// `harness.kind` default. Empty pins fall through server-side.

type Snap = Awaited<ReturnType<typeof getHarnessesStatus>>;

/** Map a stored pin onto a kind this gateway actually reported. */
export function resolveReportedHarnessKind(
  status: HarnessesStatusDTO,
  requested: HarnessKind | null | undefined,
  subsystem: ModelSubsystem
): HarnessKind {
  const reported = new Set(status.cards.map((card) => card.kind));
  const candidates = [
    requested,
    status.subsystemHarnessByKey[subsystem],
    status.selectedKind,
    status.cards[0]?.kind,
  ];
  return (
    candidates.find(
      (candidate): candidate is HarnessKind =>
        typeof candidate === "string" && reported.has(candidate)
    ) ??
    requested ??
    status.subsystemHarnessByKey[subsystem] ??
    status.selectedKind
  );
}

/** Cosmetic only — never gate which harnesses render. Unknown kinds get the default. */
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

const FALLBACK_KIND: HarnessKind = "codex";

const SUBSYSTEMS: readonly ModelSubsystem[] = [
  "assistant",
  "ask",
  "builder",
  "automations",
];

function modelPrefKey(
  kind: HarnessKind,
  slot: "default" | ModelSubsystem
): string {
  return `model.${kind}.${slot}`;
}

function configPrefKey(
  kind: HarnessKind,
  slot: "default" | ModelSubsystem,
  category: string
): string {
  return `config.${kind}.${slot}.${category}`;
}

function harnessPrefKey(subsystem: ModelSubsystem): string {
  return `harness.${subsystem}`;
}

function harnessLadderPrefKey(subsystem: ModelSubsystem): string {
  return `harness.ladder.${subsystem}`;
}

function readHarnessPrefs(
  prefs: Record<string, unknown>
): Partial<Record<ModelSubsystem, HarnessKind>> {
  const byKey: Partial<Record<ModelSubsystem, HarnessKind>> = {};
  for (const s of SUBSYSTEMS) {
    const v = prefs[harnessPrefKey(s)];
    // Any non-empty string is a pin. A closed set would drop future kinds.
    if (typeof v === "string" && v) byKey[s] = v;
  }
  return byKey;
}

function readHarnessLadderPrefs(
  prefs: Record<string, unknown>
): Partial<Record<ModelSubsystem, HarnessKind[]>> {
  const byKey: Partial<Record<ModelSubsystem, HarnessKind[]>> = {};
  for (const subsystem of SUBSYSTEMS) {
    const raw = prefs[harnessLadderPrefKey(subsystem)];
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
      (value, index): value is HarnessKind =>
        typeof value === "string" &&
        value.length > 0 &&
        decoded.indexOf(value) === index
    );
    if (kinds.length > 0) byKey[subsystem] = kinds;
  }
  return byKey;
}

/** Driven by the gateway's list — a new harness's saved models must still read. */
function readModelPrefs(
  prefs: Record<string, unknown>,
  kinds: readonly HarnessKind[]
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
  harnesses: readonly CentraidHarnessStatusEntry[]
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
  for (const harness of harnesses) {
    const categories = new Set(
      (harness.capabilities?.configOptions ?? [])
        .map((option) => option.category)
        .filter((category) => category !== "model")
    );
    const defaults: Record<string, string> = {};
    const subs: Partial<Record<ModelSubsystem, Record<string, string>>> = {};
    for (const category of categories) {
      const defaultValue =
        prefs[configPrefKey(harness.kind, "default", category)];
      if (typeof defaultValue === "string" && defaultValue)
        defaults[category] = defaultValue;
      for (const subsystem of SUBSYSTEMS) {
        const value = prefs[configPrefKey(harness.kind, subsystem, category)];
        if (typeof value !== "string" || !value) continue;
        (subs[subsystem] ??= {})[category] = value;
      }
    }
    defaultByKind[harness.kind] = defaults;
    subsystemByKind[harness.kind] = subs;
  }
  return { defaultByKind, subsystemByKind };
}

function capabilityChips(
  caps: CentraidHarnessStatusEntry["capabilities"]
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
  entry: CentraidHarnessStatusEntry
): HarnessesStatusDTO["cards"][number] {
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
    // Silence, not refusal — capabilities not reported yet.
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
  kind: HarnessKind,
  defaultByKind: Record<string, string>,
  subsystemByKind: Record<string, Partial<Record<ModelSubsystem, string>>>,
  defaultConfigPinsByKind: Record<string, Record<string, string>>,
  subsystemConfigPinsByKind: Record<
    string,
    Partial<Record<ModelSubsystem, Record<string, string>>>
  >,
  subsystemHarnessByKey: Partial<Record<ModelSubsystem, HarnessKind>>,
  subsystemHarnessLadders: Partial<Record<ModelSubsystem, HarnessKind[]>>
): HarnessesStatusDTO {
  const harnesses = status.harnesses ?? [];
  return {
    anyLoading: harnesses.some((a) => a.modelsStatus === "loading"),
    cards: harnesses.map(toCard),
    savedModelByKind: defaultByKind,
    subsystemModelByKind: subsystemByKind,
    defaultConfigPinsByKind,
    subsystemConfigPinsByKind,
    diagnosticsJson: JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        harnesses: harnesses.map((harness) => ({
          kind: harness.kind,
          available: harness.available,
          version: harness.version,
          minVersion: harness.minVersion,
          capabilities: harness.capabilities,
        })),
      },
      null,
      2
    ),
    subsystemHarnessByKey,
    subsystemHarnessLadders,
    selectedKind: kind,
  };
}

export async function loadHarnesses(opts?: {
  refresh?: boolean;
}): Promise<HarnessesStatusDTO> {
  const [status, prefs] = await Promise.all([
    getHarnessesStatus(opts).catch(() => ({ harnesses: [] }) as Snap),
    getUserPrefs().catch(() => ({}) as Record<string, unknown>),
  ]);
  const kindRaw = prefs["harness.kind"];
  // Trust the persisted kind; only absent/blank falls back.
  const selectedKind =
    typeof kindRaw === "string" && kindRaw
      ? (kindRaw as HarnessKind)
      : FALLBACK_KIND;
  const { defaultByKind, subsystemByKind } = readModelPrefs(
    prefs,
    (status.harnesses ?? []).map((a) => a.kind)
  );
  const config = readConfigPrefs(prefs, status.harnesses ?? []);
  return toDTO(
    status,
    selectedKind,
    defaultByKind,
    subsystemByKind,
    config.defaultByKind,
    config.subsystemByKind,
    readHarnessPrefs(prefs),
    readHarnessLadderPrefs(prefs)
  );
}

/**
 * One writer. Refusal returns the gateway's own text; success is `null`.
 * Never `void saveUserPrefs` — a refused pick must not sit as if kept.
 */
export type PrefWriteResult = string | null;

async function writePrefs(
  patch: Record<string, string | string[] | null>
): Promise<PrefWriteResult> {
  try {
    await saveUserPrefs(patch);
    return null;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function activateHarness(
  kind: HarnessKind
): Promise<PrefWriteResult> {
  return writePrefs({ "harness.kind": kind });
}

/** `''` clears the pin (`'' → null`) so the subsystem inherits the default. */
export async function setSubsystemHarness(
  subsystem: ModelSubsystem,
  kind: HarnessKind | ""
): Promise<PrefWriteResult> {
  return writePrefs({ [harnessPrefKey(subsystem)]: kind || null });
}

export async function setSubsystemHarnessLadder(
  subsystem: ModelSubsystem,
  kinds: HarnessKind[]
): Promise<PrefWriteResult> {
  return writePrefs({
    [harnessLadderPrefKey(subsystem)]: kinds.length > 0 ? kinds : null,
  });
}

export async function setHarnessModel(
  kind: HarnessKind,
  modelId: string
): Promise<PrefWriteResult> {
  return writePrefs({ [modelPrefKey(kind, "default")]: modelId || null });
}

export async function setSubsystemModel(
  kind: HarnessKind,
  subsystem: ModelSubsystem,
  modelId: string
): Promise<PrefWriteResult> {
  return writePrefs({ [modelPrefKey(kind, subsystem)]: modelId || null });
}

export async function setHarnessConfigPin(
  kind: HarnessKind,
  category: string,
  value: string
): Promise<PrefWriteResult> {
  return writePrefs({
    [configPrefKey(kind, "default", category)]: value || null,
  });
}

export async function setSubsystemConfigPin(
  kind: HarnessKind,
  subsystem: ModelSubsystem,
  category: string,
  value: string
): Promise<PrefWriteResult> {
  return writePrefs({
    [configPrefKey(kind, subsystem, category)]: value || null,
  });
}
