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

// Harness console data. Centraid runs the user's installed
// harness CLIs in place; the gateway reports which are runnable on its
// host. This maps that snapshot into the HarnessesStatusDTO the
// SettingsHarnessesScreen renders.
//
// The snapshot is a LIST (`{ harnesses: [...] }`), one entry per harness kind the
// gateway registers — it used to be `codex*`/`claude*` field pairs matched
// against a local 2-row table, which meant a harness the gateway grew was
// invisible here until this file was edited too. Nothing below enumerates
// harness kinds locally any more: the gateway's list drives the cards, the
// model-prefs read, and the pickers alike.
//
// Model selection moved off desktop-local settings and onto the gateway
// prefs store (`GET/PUT /_centraid-user/prefs`) so every client sharing a
// gateway sees the same picks. Keys are `model.<harnessKind>.<slot>` where
// `<slot>` is `default` (the harness's own default) or one of the
// `ModelSubsystem`s (`assistant` | `ask` | `builder` | `automations`). A
// missing/empty value falls through to the next tier server-side.
//
// Harness selection is per subsystem the same way: `harness.<subsystem>` pins
// one register to a harness, and `harness.kind` is the DEFAULT harness
// every unpinned subsystem inherits. Same fall-through rule — a
// missing/empty pin resolves server-side, so this module only ever sends
// explicit pins and deletes.

type Snap = Awaited<ReturnType<typeof getHarnessesStatus>>;

/**
 * Resolve stale/open harness preference strings onto a harness actually reported
 * by this gateway. Settings still renders every open kind from the wire; turn
 * pickers must not POST a kind absent from that same snapshot.
 */
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

/**
 * Card accents, keyed by the kinds this build happens to recognise. Purely
 * cosmetic — a harness whose kind is missing here (a newer gateway's) still
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

/** The harness every unpinned subsystem falls back to when prefs name none. */
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

/**
 * The per-subsystem harness pin shares the canonical harness namespace; the
 * daemon config seeder writes only its declared launch keys.
 */
function harnessPrefKey(subsystem: ModelSubsystem): string {
  return `harness.${subsystem}`;
}

function harnessLadderPrefKey(subsystem: ModelSubsystem): string {
  return `harness.ladder.${subsystem}`;
}

/** Pull the explicit `harness.<subsystem>` pins out of the raw prefs snapshot. */
function readHarnessPrefs(
  prefs: Record<string, unknown>
): Partial<Record<ModelSubsystem, HarnessKind>> {
  const byKey: Partial<Record<ModelSubsystem, HarnessKind>> = {};
  for (const s of SUBSYSTEMS) {
    const v = prefs[harnessPrefKey(s)];
    // Any non-empty string counts as a pin. This used to check against a
    // closed pair, which would have silently dropped a pin onto a harness
    // kind this build predates — the gateway is what resolves a pin, and it
    // treats an unknown one as "inherit" anyway.
    if (typeof v === "string" && v) byKey[s] = v;
  }
  return byKey;
}

/** Read ordered ladder membership written as an array (or legacy JSON text). */
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

/**
 * Pull every `model.<kind>.<slot>` string out of the raw prefs snapshot, for
 * each kind the gateway reported. Driven by the gateway's list rather than a
 * local table so a new harness's saved models are read, not stranded.
 */
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

/**
 * One wire entry → one card. Every displayed string comes from the gateway
 * (`label`, `version`, `hint`), so a harness kind this build has never heard of
 * still renders a complete, honest card — only the accent falls back.
 */
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
    // The gateway's install hint IS the "why not" for an unavailable harness —
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
  // Trust the persisted kind as-is (the gateway validated it on write and
  // resolves it on read); only an absent/blank value falls back.
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

/** Switch the DEFAULT harness — the harness every unpinned subsystem inherits. */
export async function activateHarness(kind: HarnessKind): Promise<boolean> {
  try {
    await saveUserPrefs({ "harness.kind": kind });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pin one subsystem to a harness ('' clears the key, so the subsystem
 * inherits the default harness again — the same `'' → null` delete convention
 * the model setters use).
 */
export async function setSubsystemHarness(
  subsystem: ModelSubsystem,
  kind: HarnessKind | ""
): Promise<boolean> {
  try {
    await saveUserPrefs({ [harnessPrefKey(subsystem)]: kind || null });
    return true;
  } catch {
    return false;
  }
}

export function setSubsystemHarnessLadder(
  subsystem: ModelSubsystem,
  kinds: HarnessKind[]
): void {
  void saveUserPrefs({
    [harnessLadderPrefKey(subsystem)]: kinds.length > 0 ? kinds : null,
  });
}

/** Persist this harness's default model ('' clears the key, falling through to the harness default). */
export function setHarnessModel(kind: HarnessKind, modelId: string): void {
  void saveUserPrefs({ [modelPrefKey(kind, "default")]: modelId || null });
}

/** Persist this harness's per-subsystem model override ('' clears the key, falling through to the default model). */
export function setSubsystemModel(
  kind: HarnessKind,
  subsystem: ModelSubsystem,
  modelId: string
): void {
  void saveUserPrefs({ [modelPrefKey(kind, subsystem)]: modelId || null });
}

export function setHarnessConfigPin(
  kind: HarnessKind,
  category: string,
  value: string
): void {
  void saveUserPrefs({
    [configPrefKey(kind, "default", category)]: value || null,
  });
}

export function setSubsystemConfigPin(
  kind: HarnessKind,
  subsystem: ModelSubsystem,
  category: string,
  value: string
): void {
  void saveUserPrefs({
    [configPrefKey(kind, subsystem, category)]: value || null,
  });
}
