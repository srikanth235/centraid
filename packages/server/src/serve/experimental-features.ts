/*
 * Experimental feature gate — the v0 early-feedback door.
 *
 * Automations and connectors ship in the release binary but are OFF by
 * default: a gateway that has not opted in does not advertise their
 * capabilities, does not mount their routes, and does not start their
 * background work. Turning a feature off later leaves its durable data
 * (automation definitions, connector credentials, run history) intact —
 * the gate hides surface, it never deletes state.
 *
 * Resolution mirrors Resource mode (#521/#528): operator env wins, then the
 * durable gateway prefs the shell writes, then the host's build option, else
 * off. `CENTRAID_EXPERIMENTAL`, when SET, is authoritative for every feature
 * (listed → on, unlisted → off) — the same "env wins over both" contract as
 * `CENTRAID_RESOURCE_MODE`. Changes apply on the next serve boot.
 */

export type ExperimentalFeature = "automations" | "connectors";

export const EXPERIMENTAL_FEATURES: readonly ExperimentalFeature[] = [
  "automations",
  "connectors",
] as const;

/** Device-prefs keys — runtime wins (docs/config-ownership.md). */
export const EXPERIMENTAL_FEATURE_PREF_KEYS: Record<
  ExperimentalFeature,
  string
> = {
  automations: "gateway.experimental.automations",
  connectors: "gateway.experimental.connectors",
};

export const EXPERIMENTAL_ENV_VAR = "CENTRAID_EXPERIMENTAL";

/** The resolved per-feature gate the rest of boot reads. */
export type ExperimentalFeatureSet = Record<ExperimentalFeature, boolean>;

export interface ExperimentalResolution {
  features: ExperimentalFeatureSet;
  /**
   * Env tokens that named no known feature — surfaced so boot can log a
   * warning instead of silently ignoring a typo'd `CENTRAID_EXPERIMENTAL`.
   */
  unknownEnvTokens: string[];
}

function isExperimentalFeature(value: string): value is ExperimentalFeature {
  return (EXPERIMENTAL_FEATURES as readonly string[]).includes(value);
}

/**
 * Resolve the effective experimental gate. Per feature: env (when the var is
 * set at all) > durable prefs (boolean, garbage dropped) > host option >
 * off. Off is the v0 default — a fresh gateway exposes neither surface.
 */
export function resolveExperimentalFeatures(input: {
  env?: NodeJS.ProcessEnv;
  prefs?: Record<string, unknown>;
  options?: Partial<ExperimentalFeatureSet>;
}): ExperimentalResolution {
  const env = input.env ?? process.env;
  const raw = env[EXPERIMENTAL_ENV_VAR];
  const unknownEnvTokens: string[] = [];
  if (raw !== undefined) {
    const enabled = new Set<ExperimentalFeature>();
    for (const token of raw
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean)) {
      if (isExperimentalFeature(token)) enabled.add(token);
      else unknownEnvTokens.push(token);
    }
    return {
      features: {
        automations: enabled.has("automations"),
        connectors: enabled.has("connectors"),
      },
      unknownEnvTokens,
    };
  }
  const resolveOne = (feature: ExperimentalFeature): boolean => {
    const pref = input.prefs?.[EXPERIMENTAL_FEATURE_PREF_KEYS[feature]];
    if (typeof pref === "boolean") return pref;
    const option = input.options?.[feature];
    if (typeof option === "boolean") return option;
    return false;
  };
  return {
    features: {
      automations: resolveOne("automations"),
      connectors: resolveOne("connectors"),
    },
    unknownEnvTokens,
  };
}
