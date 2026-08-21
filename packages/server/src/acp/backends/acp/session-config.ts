/*
 * What an ACP session advertises about itself, and the category-keyed
 * configuration pins we apply to it.
 *
 * Session wire shapes (verified against the public ACP spec):
 *   - handshake: `initialize` { protocolVersion: 1, clientCapabilities,
 *     clientInfo } → { protocolVersion, agentCapabilities: { loadSession,
 *     promptCapabilities }, ... }.
 *   - session: `session/new` { cwd, mcpServers } → { sessionId };
 *     `session/load` { sessionId, cwd, mcpServers } replays history via
 *     `session/update` then resolves null (only when the harness advertised
 *     `loadSession`).
 *
 * Config selection (verified against the pinned `@agentclientprotocol/sdk` 1.3.0's
 * generated schema, not guessed): ACP has no per-prompt model field. A harness
 * instead advertises `configOptions` on the `session/new` / `session/load`
 * RESULT, and the client pins one with the `session/set_config_option`
 * request `{ sessionId, configId, value }`
 * (`AGENT_METHODS.session_set_config_option`). The model selector is the
 * option whose `id` is `"model"` or whose `category` is `"model"`; its
 * `options` are `{ value, name }` pairs (or groups of them) carrying CONCRETE
 * provider model ids. We only ever echo values the harness itself offered, so
 * no provider ids are hardcoded here. Options are identified by semantic
 * `category`, never adapter-specific ids (`reasoning_effort` vs `effort`).
 * When the harness advertises no requested category, or offers nothing matching
 * the request, we emit a `notice` rather than silently ignoring the pin.
 */

import { methods } from "@agentclientprotocol/sdk";
import type {
  AgentRequestMethod,
  AgentRequestParamsByMethod,
  AgentRequestResponsesByMethod,
  LoadSessionResponse,
  NewSessionResponse,
  ResumeSessionResponse,
  SessionCapabilities,
  SessionConfigOption,
  SessionConfigSelectOption,
  SessionConfigSelectOptions,
  SessionModeState,
  SessionNotification,
  SendRequestOptions,
  SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";

import type { TurnStreamEvent } from "@centraid/server/engine";

/** Wire method for pinning a session config option (e.g. the model). */
export const SET_CONFIG_OPTION = methods.agent.session.setConfigOption;
/** Wire method for selecting a session mode (e.g. claude's `bypassPermissions`). */
export const SET_MODE = methods.agent.session.setMode;

export type {
  SessionCapabilities,
  SessionConfigOption,
  SessionModeState,
} from "@agentclientprotocol/sdk";

/** SDK response types that carry a config-option snapshot. */
export type SessionConfigResponse =
  | NewSessionResponse
  | LoadSessionResponse
  | ResumeSessionResponse
  | SetSessionConfigOptionResponse;

/** SDK-owned built-in request pairing, usable through timeout decorators. */
export type AcpBuiltinRequest = <Method extends AgentRequestMethod>(
  method: Method,
  params: AgentRequestParamsByMethod[Method],
  options?: SendRequestOptions
) => Promise<AgentRequestResponsesByMethod[Method]>;

/** True when the harness advertises a structured session capability object. */
export function hasSessionCapability(
  caps: SessionCapabilities | undefined,
  key: keyof SessionCapabilities
): boolean {
  if (!caps) return false;
  const v = caps[key];
  // Spec: `{}` means supported; omit/null means not.
  return v !== undefined && v !== null;
}

export function readConfigOptions(
  result: SessionConfigResponse | undefined
): SessionConfigOption[] {
  return result?.configOptions ?? [];
}

/**
 * Read a `config_option_update` session notification.
 *
 * Schema-verified against `@agentclientprotocol/sdk`'s generated
 * `ConfigOptionUpdate`: the notification carries exactly one field,
 * `configOptions`, documented as "The full set of configuration options and
 * their current values". There is NO singular option shape in the schema, so
 * the result REPLACES the tracked set — an option missing from an update is
 * gone, not retained from an earlier snapshot.
 */
export function readConfigOptionUpdate(
  params: SessionNotification
): SessionConfigOption[] | undefined {
  const update = params.update;
  if (update.sessionUpdate !== "config_option_update") return undefined;
  return update.configOptions;
}

/** The `currentValue` the session advertises for one semantic category. */
export function readCurrentConfigValue(
  options: SessionConfigOption[],
  category: string
): string | undefined {
  const option = findConfigOption(options, category);
  return typeof option?.currentValue === "string"
    ? option.currentValue
    : undefined;
}

/** Does the harness advertise `modeId` among its available session modes? */
export function modeAvailable(
  modes: SessionModeState | undefined,
  modeId: string
): boolean {
  if (!modes) return false;
  if (modes.currentModeId === modeId) return true;
  return modes.availableModes.some((mode) => mode.id === modeId);
}

/** One concrete value the harness offers on a select config option. */
export type OfferedConfigValue = SessionConfigSelectOption;

/** Semantic alias for model catalog callers, sourced from the SDK schema. */
export type OfferedModel = SessionConfigSelectOption;

/** Find one config selector by ACP semantic category. */
export function findConfigOption(
  options: SessionConfigOption[],
  category: string
): SessionConfigOption | undefined {
  return options.find(
    (option) =>
      option.category === category ||
      // ACP's model option historically shipped with id="model" before the
      // semantic category field became universal. This is the one spec-level
      // compatibility alias; thought_level remains category-only.
      (category === "model" && option.id === "model")
  );
}

/** Flatten `SessionConfigSelectOptions` — either a flat list or groups of one. */
export function flattenSelectOptions(
  raw: SessionConfigSelectOptions
): OfferedConfigValue[] {
  const out: OfferedConfigValue[] = [];
  for (const entry of raw) {
    if ("options" in entry) {
      out.push(...entry.options);
      continue;
    }
    out.push(entry);
  }
  return out;
}

/**
 * The concrete models a harness advertises on its `model` config option, plus
 * the option's `currentValue` (its own default selection). Empty when the
 * harness exposes no model selector — which is how a kind that picks its own
 * model per session yields an empty catalog rather than a fabricated one.
 *
 * This is the enumeration counterpart to `pinModel`: same option lookup, but
 * it reports the whole offered set instead of matching one request against it.
 * Both stay here so "what is the model option, and what does it offer" lives
 * in exactly one place.
 */
export function readOfferedModels(configOptions: SessionConfigOption[]): {
  models: OfferedConfigValue[];
  currentValue?: string;
} {
  const option = findConfigOption(configOptions, "model");
  if (!option || option.type !== "select") return { models: [] };
  return {
    models: flattenSelectOptions(option.options),
    currentValue: option.currentValue,
  };
}

/**
 * Match a requested model against what the harness offers. Exact `value` wins,
 * then a case-insensitive `name`, then a substring on either — so a
 * capability-tier alias like `opus` still finds `claude-opus-4-5-20251101`
 * without this module ever naming a concrete model id.
 */
function matchModelValue(
  offered: OfferedConfigValue[],
  wanted: string
): string | undefined {
  const needle = wanted.trim().toLowerCase();
  if (!needle) return undefined;
  const exact = offered.find((o) => o.value === wanted);
  if (exact) return exact.value;
  const byName = offered.find(
    (o) => o.value.toLowerCase() === needle || o.name?.toLowerCase() === needle
  );
  if (byName) return byName.value;
  const partial = offered.find(
    (o) =>
      o.value.toLowerCase().includes(needle) ||
      (o.name?.toLowerCase().includes(needle) ?? false)
  );
  return partial?.value;
}

/**
 * Pin the caller's model through `session/set_config_option`, and report the
 * model actually in effect (for the usage stamp). Emits a `notice` when the
 * harness exposes no model selector or offers nothing matching.
 */
export async function pinModel(args: {
  request: AcpBuiltinRequest;
  emit: (event: TurnStreamEvent) => void;
  sessionId: string;
  configOptions: SessionConfigOption[];
  requested?: string;
  resolveModel?: (model: string) => string;
}): Promise<string | undefined> {
  const option = findConfigOption(args.configOptions, "model");
  const current =
    typeof option?.currentValue === "string" ? option.currentValue : undefined;

  if (!args.requested) return current;

  if (!option || option.type !== "select") {
    // User explicitly picked a model — surface as warn so the composer notice
    // is hard to miss (model switch reliability).
    args.emit({
      type: "notice",
      level: "warn",
      code: "model_unsupported",
      message: `This harness picks its own model — the selected model (${args.requested}) was ignored.`,
    });
    return current;
  }

  const wanted = args.resolveModel
    ? args.resolveModel(args.requested)
    : args.requested;
  const value = matchModelValue(flattenSelectOptions(option.options), wanted);
  if (!value) {
    args.emit({
      type: "notice",
      level: "warn",
      code: "model_not_offered",
      message:
        `This harness doesn’t offer the selected model (${args.requested}) — ` +
        `it used its own default instead.`,
    });
    return current;
  }
  if (value === current) return current;

  try {
    const result = await args.request(SET_CONFIG_OPTION, {
      sessionId: args.sessionId,
      configId: option.id,
      value,
    });
    // D4 confirmation: a RESOLVED `session/set_config_option` IS the harness
    // confirming the pin — the spec's result echo is optional. Only an echo
    // that CONTRADICTS the request leaves the active value unknown.
    const echoed = readCurrentConfigValue(readConfigOptions(result), "model");
    if (echoed !== undefined && echoed !== value) {
      args.emit({
        type: "notice",
        level: "warn",
        code: "model_unconfirmed",
        message:
          `This harness accepted the selected model (${args.requested}) but reported ` +
          `a different active model, so Centraid will record the model as unknown.`,
      });
      return undefined;
    }
    return value;
  } catch {
    // The harness rejected the pin (stale option list, provider hiccup). The
    // turn is still runnable on its default — say so instead of failing it.
    args.emit({
      type: "notice",
      level: "warn",
      code: "model_not_offered",
      message:
        `This harness refused the selected model (${args.requested}) — ` +
        `it used its own default instead.`,
    });
    return current;
  }
}

/**
 * Pin ACP's well-known `thought_level` category after the model. Values are
 * adapter vocabulary and therefore exact/case-insensitive only — unlike model
 * aliases, effort values are never substring-translated.
 */
export async function pinThoughtLevel(args: {
  request: AcpBuiltinRequest;
  emit: (event: TurnStreamEvent) => void;
  sessionId: string;
  configOptions: SessionConfigOption[];
  requested?: string;
}): Promise<string | undefined> {
  const option = findConfigOption(args.configOptions, "thought_level");
  const current =
    typeof option?.currentValue === "string" ? option.currentValue : undefined;
  if (!args.requested) return current;
  if (!option || option.type !== "select") {
    args.emit({
      type: "notice",
      level: "warn",
      code: "thought_level_unsupported",
      message: `This harness does not advertise an effort control — the selected effort (${args.requested}) was ignored.`,
    });
    return current;
  }

  const needle = args.requested.trim().toLowerCase();
  const selected = flattenSelectOptions(option.options).find(
    (entry) =>
      entry.value === args.requested ||
      entry.value.toLowerCase() === needle ||
      entry.name?.toLowerCase() === needle
  )?.value;
  if (!selected) {
    args.emit({
      type: "notice",
      level: "warn",
      code: "thought_level_not_offered",
      message: `This harness does not offer the selected effort (${args.requested}) for its active model — it used its own default instead.`,
    });
    return current;
  }
  if (selected === current) return current;

  try {
    const result = await args.request(SET_CONFIG_OPTION, {
      sessionId: args.sessionId,
      configId: option.id,
      value: selected,
    });
    // Same D4 rule as `pinModel`: the resolved RPC confirms the request; only
    // a contradicting echo makes the active value unknown.
    const echoed = readCurrentConfigValue(
      readConfigOptions(result),
      "thought_level"
    );
    if (echoed !== undefined && echoed !== selected) {
      args.emit({
        type: "notice",
        level: "warn",
        code: "thought_level_unconfirmed",
        message: `The harness accepted the effort request but reported a different active effort, so Centraid will record effort as unknown.`,
      });
      return undefined;
    }
    return selected;
  } catch {
    args.emit({
      type: "notice",
      level: "warn",
      code: "thought_level_not_offered",
      message: `This harness refused the selected effort (${args.requested}) — it used its own default instead.`,
    });
    return current;
  }
}
