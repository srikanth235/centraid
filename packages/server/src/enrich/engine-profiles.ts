// Engine profiles (#807) bind a CAPABILITY to an ENGINE, named once so the
// policy cascade, derivation stamps and Settings refer to one choice by id.
//
// THE BUILT-IN PROFILE IS DERIVED, NEVER STORED: computed from the capability registry on every read, so no migration can let it drift from the shipped engine. Its id repeats across capabilities on purpose — profile identity is (capability, id). EGRESS IS LIKEWISE COMPUTED, never declared by a profile.
//
// WHERE THEY LIVE: gateway prefs under `enrich.profile.<id>`, one writer per path (docs/config-ownership.md); the vault stores which profile PRODUCED a value, never the binding.

import type { EnrichEgressClass } from "@centraid/vault";
import { BUILT_IN_PROFILE } from "@centraid/vault";

import type { EnrichLane } from "../automation/fire/enrich-gate.js";
import { isHarnessKind } from "../engine/conversation/turn.js";
import type { HarnessKind } from "../engine/conversation/turn.js";
import {
  ENRICH_CAPABILITIES,
  capabilityContract,
} from "./capability-registry.js";

export const ENGINE_PROFILE_PREFS_PREFIX = "enrich.profile.";

export function engineProfilePrefsKey(id: string): string {
  return `${ENGINE_PROFILE_PREFS_PREFIX}${id}`;
}

export function isBuiltInProfileId(id: string): boolean {
  return id === BUILT_IN_PROFILE;
}

/** A prefs key suffix AND a durable derivation-stamp value. */
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export type EngineProfileEngine =
  | { readonly kind: "built-in" }
  | {
      readonly kind: "delegate";
      readonly harness: HarnessKind;
      readonly model?: string;
      readonly configPins?: Readonly<Record<string, string>>;
      readonly promptRev?: string;
    };

export interface EngineProfile {
  readonly id: string;
  readonly label: string;
  readonly capability: string;
  readonly engine: EngineProfileEngine;
  /** Computed from `engine`, never read from stored input. */
  readonly egress: EnrichEgressClass;
  readonly builtIn: boolean;
  /** Without it a delegate profile with no shipped variant looks live while the built-in engine runs. */
  readonly delegateCapable: boolean;
}

/** Absent ⇒ `gateway`: assuming the cheaper lane assumes consent. */
export type CapabilityLaneResolver = (capability: string) => EnrichLane;

export interface EngineProfileReadOptions {
  readonly laneFor?: CapabilityLaneResolver;
}

export function laneEgress(lane: EnrichLane): EnrichEgressClass {
  return lane === "device" ? "on-device" : "gateway";
}

/** A property of the harness ROSTER, not a definition. */
export function delegateEgress(_harness: HarnessKind): EnrichEgressClass {
  return "provider";
}

export function engineProfileEgress(
  profile: Pick<EngineProfile, "capability" | "engine">,
  options: EngineProfileReadOptions = {}
): EnrichEgressClass {
  if (profile.engine.kind === "delegate")
    return delegateEgress(profile.engine.harness);
  const lane = options.laneFor?.(profile.capability) ?? "gateway";
  return laneEgress(lane);
}

/** Structural refusals, not defaults, so no policy row or hand-edited pref can reach them (#807 Q3). */
const DELEGATE_REFUSALS: Readonly<Record<string, string>> = {
  faces:
    'The "faces" capability has no delegate profile: face recognition is ' +
    "biometric identification, and Centraid never sends face imagery or face " +
    "embeddings to a third-party provider. It runs on the built-in engine only.",
};

export function capabilityAllowsDelegate(capability: string): boolean {
  return DELEGATE_REFUSALS[capability] === undefined;
}

export function delegateRefusalReason(capability: string): string | undefined {
  return DELEGATE_REFUSALS[capability];
}

export function builtInProfileFor(
  capability: string,
  options: EngineProfileReadOptions = {}
): EngineProfile | undefined {
  const contract = capabilityContract(capability);
  if (!contract) return undefined;
  return {
    id: BUILT_IN_PROFILE,
    label: `Built-in (${contract.id})`,
    capability: contract.id,
    engine: { kind: "built-in" },
    egress: engineProfileEgress(
      { capability: contract.id, engine: { kind: "built-in" } },
      options
    ),
    builtIn: true,
    delegateCapable: contract.delegateCapable,
  };
}

export function builtInProfiles(
  options: EngineProfileReadOptions = {}
): EngineProfile[] {
  return ENRICH_CAPABILITIES.map((contract) =>
    builtInProfileFor(contract.id, options)!
  );
}

interface StoredEngineProfile {
  capability?: unknown;
  label?: unknown;
  harness?: unknown;
  model?: unknown;
  configPins?: unknown;
  promptRev?: unknown;
}

function parseStored(value: unknown): StoredEngineProfile | undefined {
  let raw: unknown = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return undefined;
  return raw as StoredEngineProfile;
}

function readConfigPins(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const pins: Record<string, string> = {};
  for (const [category, pin] of Object.entries(
    value as Record<string, unknown>
  ))
    if (typeof pin === "string" && pin) pins[category] = pin;
  return pins;
}

/** Total and SILENT: `validateEngineProfilePatch` is where refusals speak. */
function toProfile(
  id: string,
  value: unknown,
  options: EngineProfileReadOptions
): EngineProfile | undefined {
  if (!PROFILE_ID_PATTERN.test(id) || isBuiltInProfileId(id)) return undefined;
  const stored = parseStored(value);
  if (!stored) return undefined;
  const capability = stored.capability;
  if (typeof capability !== "string") return undefined;
  const contract = capabilityContract(capability);
  if (!contract) return undefined;
  if (!isHarnessKind(stored.harness)) return undefined;
  if (!capabilityAllowsDelegate(capability)) return undefined;
  const pins = readConfigPins(stored.configPins);
  const engine: EngineProfileEngine = {
    kind: "delegate",
    harness: stored.harness,
    ...(typeof stored.model === "string" && stored.model
      ? { model: stored.model }
      : {}),
    ...(pins && Object.keys(pins).length > 0 ? { configPins: pins } : {}),
    ...(typeof stored.promptRev === "string" && stored.promptRev
      ? { promptRev: stored.promptRev }
      : {}),
  };
  return {
    id,
    label: typeof stored.label === "string" && stored.label ? stored.label : id,
    capability,
    engine,
    egress: engineProfileEgress({ capability, engine }, options),
    builtIn: false,
    delegateCapable: contract.delegateCapable,
  };
}

export function userEngineProfiles(
  prefs: Record<string, unknown>,
  options: EngineProfileReadOptions = {}
): EngineProfile[] {
  const profiles: EngineProfile[] = [];
  for (const key of Object.keys(prefs).sort()) {
    if (!key.startsWith(ENGINE_PROFILE_PREFS_PREFIX)) continue;
    const profile = toProfile(
      key.slice(ENGINE_PROFILE_PREFS_PREFIX.length),
      prefs[key],
      options
    );
    if (profile) profiles.push(profile);
  }
  return profiles;
}

export function listEngineProfiles(
  prefs: Record<string, unknown>,
  options: EngineProfileReadOptions = {}
): EngineProfile[] {
  return [...builtInProfiles(options), ...userEngineProfiles(prefs, options)];
}

/** `capability` disambiguates the built-in, whose id repeats. */
export function readEngineProfile(
  prefs: Record<string, unknown>,
  id: string,
  capability?: string,
  options: EngineProfileReadOptions = {}
): EngineProfile | undefined {
  if (isBuiltInProfileId(id))
    return capability ? builtInProfileFor(capability, options) : undefined;
  return toProfile(id, prefs[engineProfilePrefsKey(id)], options);
}

export function engineProfilesForCapability(
  prefs: Record<string, unknown>,
  capability: string,
  options: EngineProfileReadOptions = {}
): EngineProfile[] {
  return listEngineProfiles(prefs, options).filter(
    (profile) => profile.capability === capability
  );
}

/** The ONLY writer-side gate, deliberately stricter than the reader: everything the reader would silently drop is refused out loud. */
export function validateEngineProfilePatch(
  patch: Record<string, unknown>
): string | undefined {
  for (const key of Object.keys(patch)) {
    if (!key.startsWith(ENGINE_PROFILE_PREFS_PREFIX)) continue;
    const value = patch[key];
    if (value === null || value === undefined) continue;
    const reason = rejectionFor(
      key.slice(ENGINE_PROFILE_PREFS_PREFIX.length),
      value
    );
    if (reason) return reason;
  }
  return undefined;
}

function rejectionFor(id: string, value: unknown): string | undefined {
  if (isBuiltInProfileId(id))
    return `Cannot write engine profile "${id}": the built-in profile of each capability is derived from the shipped engine and cannot be overridden.`;
  if (!PROFILE_ID_PATTERN.test(id))
    return `Cannot write engine profile "${id}": a profile id must be lower-case letters, digits and dashes (64 characters or fewer).`;
  const stored = parseStored(value);
  if (!stored)
    return `Cannot write engine profile "${id}": the value must be a JSON object describing the profile.`;
  if ("egress" in (stored as Record<string, unknown>))
    return `Cannot write engine profile "${id}": the egress class is computed from the engine and is not settable.`;
  const capability = stored.capability;
  if (typeof capability !== "string" || !capability)
    return `Cannot write engine profile "${id}": a profile must name the capability it implements.`;
  if (!capabilityContract(capability))
    return `Cannot write engine profile "${id}": "${capability}" is not a capability this gateway carries a contract for.`;
  if (stored.harness === undefined)
    return `Cannot write engine profile "${id}": a profile must name the harness that runs it.`;
  if (!isHarnessKind(stored.harness))
    return `Cannot write engine profile "${id}": "${String(stored.harness)}" is not a harness this gateway can run.`;
  const refusal = delegateRefusalReason(capability);
  if (refusal) return `Cannot write engine profile "${id}": ${refusal}`;
  if (stored.label !== undefined && typeof stored.label !== "string")
    return `Cannot write engine profile "${id}": the label must be text.`;
  if (stored.model !== undefined && typeof stored.model !== "string")
    return `Cannot write engine profile "${id}": the model must be the id the harness offered, as text.`;
  if (stored.promptRev !== undefined && typeof stored.promptRev !== "string")
    return `Cannot write engine profile "${id}": the prompt revision must be text.`;
  if (
    stored.configPins !== undefined &&
    readConfigPins(stored.configPins) === undefined
  )
    return `Cannot write engine profile "${id}": config pins must be an object of category to pinned value.`;
  return undefined;
}
