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

export const SET_CONFIG_OPTION = methods.agent.session.setConfigOption;
export const SET_MODE = methods.agent.session.setMode;

export type {
  SessionCapabilities,
  SessionConfigOption,
  SessionModeState,
} from "@agentclientprotocol/sdk";

export type SessionConfigResponse =
  | NewSessionResponse
  | LoadSessionResponse
  | ResumeSessionResponse
  | SetSessionConfigOptionResponse;

export type AcpBuiltinRequest = <Method extends AgentRequestMethod>(
  method: Method,
  params: AgentRequestParamsByMethod[Method],
  options?: SendRequestOptions
) => Promise<AgentRequestResponsesByMethod[Method]>;

export function hasSessionCapability(
  caps: SessionCapabilities | undefined,
  key: keyof SessionCapabilities
): boolean {
  if (!caps) return false;
  const v = caps[key];
  return v !== undefined && v !== null;
}

export function readConfigOptions(
  result: SessionConfigResponse | undefined
): SessionConfigOption[] {
  return result?.configOptions ?? [];
}

export function readConfigOptionUpdate(
  params: SessionNotification
): SessionConfigOption[] | undefined {
  const update = params.update;
  if (update.sessionUpdate !== "config_option_update") return undefined;
  return update.configOptions;
}

export function readCurrentConfigValue(
  options: SessionConfigOption[],
  category: string
): string | undefined {
  const option = findConfigOption(options, category);
  return typeof option?.currentValue === "string"
    ? option.currentValue
    : undefined;
}

export function modeAvailable(
  modes: SessionModeState | undefined,
  modeId: string
): boolean {
  if (!modes) return false;
  if (modes.currentModeId === modeId) return true;
  return modes.availableModes.some((mode) => mode.id === modeId);
}

export type OfferedConfigValue = SessionConfigSelectOption;

export type OfferedModel = SessionConfigSelectOption;

export function findConfigOption(
  options: SessionConfigOption[],
  category: string
): SessionConfigOption | undefined {
  return options.find(
    (option) =>
      option.category === category ||
      (category === "model" && option.id === "model")
  );
}

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
