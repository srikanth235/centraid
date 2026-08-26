/*
 * Experimental gate — OFF unless opted in; hides surface, never deletes
 * state. Resolution mirrors Resource mode (#521/#528): env > durable prefs >
 * host option > off; a SET `CENTRAID_EXPERIMENTAL` is authoritative.
 */

export type ExperimentalFeature = "automations" | "connectors";

export const EXPERIMENTAL_FEATURES: readonly ExperimentalFeature[] = [
  "automations",
  "connectors",
] as const;

/** Pref keys — runtime wins (docs/config-ownership.md). */
export const EXPERIMENTAL_FEATURE_PREF_KEYS: Record<
  ExperimentalFeature,
  string
> = {
  automations: "gateway.experimental.automations",
  connectors: "gateway.experimental.connectors",
};

export const EXPERIMENTAL_ENV_VAR = "CENTRAID_EXPERIMENTAL";

export type ExperimentalFeatureSet = Record<ExperimentalFeature, boolean>;

export interface ExperimentalResolution {
  features: ExperimentalFeatureSet;
  /** Surfaced so boot can log typos. */
  unknownEnvTokens: string[];
}

function isExperimentalFeature(value: string): value is ExperimentalFeature {
  return (EXPERIMENTAL_FEATURES as readonly string[]).includes(value);
}

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
