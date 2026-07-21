/*
 * What an ACP session advertises about itself, and the two things we pin on
 * it: the permission mode and the model.
 *
 * Session wire shapes (verified against the public ACP spec):
 *   - handshake: `initialize` { protocolVersion: 1, clientCapabilities,
 *     clientInfo } → { protocolVersion, agentCapabilities: { loadSession,
 *     promptCapabilities }, ... }.
 *   - session: `session/new` { cwd, mcpServers } → { sessionId };
 *     `session/load` { sessionId, cwd, mcpServers } replays history via
 *     `session/update` then resolves null (only when the agent advertised
 *     `loadSession`).
 *
 * Model selection (verified against `@agentclientprotocol/sdk` 1.2.1's
 * generated schema, not guessed): ACP has no per-prompt model field. An agent
 * instead advertises `configOptions` on the `session/new` / `session/load`
 * RESULT, and the client pins one with the `session/set_config_option`
 * request `{ sessionId, configId, value }`
 * (`AGENT_METHODS.session_set_config_option`). The model selector is the
 * option whose `id` is `"model"` or whose `category` is `"model"`; its
 * `options` are `{ value, name }` pairs (or groups of them) carrying CONCRETE
 * provider model ids. We only ever echo values the agent itself offered, so
 * no provider ids are hardcoded here. When the agent advertises no model
 * option, or offers nothing matching the request, we emit a `notice` rather
 * than silently ignoring the pin.
 */

import type { TurnStreamEvent } from '@centraid/app-engine';
import { isObject } from './content.js';

/** Wire method for pinning a session config option (e.g. the model). */
export const SET_CONFIG_OPTION = 'session/set_config_option';
/** Wire method for selecting a session mode (e.g. claude's `bypassPermissions`). */
export const SET_MODE = 'session/set_mode';

/** The slice of the `initialize` result this client reads. */
export interface InitializeResult {
  agentCapabilities?: {
    loadSession?: unknown;
    promptCapabilities?: unknown;
    mcpCapabilities?: { http?: unknown; sse?: unknown; acp?: unknown };
  };
}

export interface SessionConfigOption {
  id?: unknown;
  category?: unknown;
  type?: unknown;
  currentValue?: unknown;
  options?: unknown;
}

export interface SessionModes {
  currentModeId?: unknown;
  availableModes?: unknown;
}

export interface SessionSetupResult {
  sessionId?: unknown;
  configOptions?: unknown;
  modes?: SessionModes | null;
}

export function readConfigOptions(result: SessionSetupResult | undefined): SessionConfigOption[] {
  const raw = result?.configOptions;
  return Array.isArray(raw) ? raw.filter(isObject) : [];
}

/** Does the agent advertise `modeId` among its available session modes? */
export function modeAvailable(modes: SessionModes | undefined, modeId: string): boolean {
  if (!modes) return false;
  if (modes.currentModeId === modeId) return true;
  const list = modes.availableModes;
  if (!Array.isArray(list)) return false;
  return list.some((m) => isObject(m) && m.id === modeId);
}

/** One concrete model the agent offers on its `model` select option. */
export interface OfferedModel {
  value: string;
  name?: string;
}

/** The agent's model selector, identified by id or semantic category. */
function findModelOption(options: SessionConfigOption[]): SessionConfigOption | undefined {
  return options.find((o) => o.id === 'model' || o.category === 'model');
}

/** Flatten `SessionConfigSelectOptions` — either a flat list or groups of one. */
function flattenSelectOptions(raw: unknown): OfferedModel[] {
  if (!Array.isArray(raw)) return [];
  const out: OfferedModel[] = [];
  for (const entry of raw) {
    if (!isObject(entry)) continue;
    if (Array.isArray(entry.options)) {
      out.push(...flattenSelectOptions(entry.options));
      continue;
    }
    if (typeof entry.value === 'string') {
      out.push({
        value: entry.value,
        ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
      });
    }
  }
  return out;
}

/**
 * The concrete models an agent advertises on its `model` config option, plus
 * the option's `currentValue` (its own default selection). Empty when the
 * agent exposes no model selector — which is how a kind that picks its own
 * model per session yields an empty catalog rather than a fabricated one.
 *
 * This is the enumeration counterpart to `pinModel`: same option lookup, but
 * it reports the whole offered set instead of matching one request against it.
 * Both stay here so "what is the model option, and what does it offer" lives
 * in exactly one place.
 */
export function readOfferedModels(configOptions: SessionConfigOption[]): {
  models: OfferedModel[];
  currentValue?: string;
} {
  const option = findModelOption(configOptions);
  if (!option) return { models: [] };
  return {
    models: flattenSelectOptions(option.options),
    ...(typeof option.currentValue === 'string' ? { currentValue: option.currentValue } : {}),
  };
}

/**
 * Match a requested model against what the agent offers. Exact `value` wins,
 * then a case-insensitive `name`, then a substring on either — so a
 * capability-tier alias like `opus` still finds `claude-opus-4-5-20251101`
 * without this module ever naming a concrete model id.
 */
function matchModelValue(
  offered: Array<{ value: string; name?: string }>,
  wanted: string,
): string | undefined {
  const needle = wanted.trim().toLowerCase();
  if (!needle) return undefined;
  const exact = offered.find((o) => o.value === wanted);
  if (exact) return exact.value;
  const byName = offered.find(
    (o) => o.value.toLowerCase() === needle || o.name?.toLowerCase() === needle,
  );
  if (byName) return byName.value;
  const partial = offered.find(
    (o) =>
      o.value.toLowerCase().includes(needle) || (o.name?.toLowerCase().includes(needle) ?? false),
  );
  return partial?.value;
}

/**
 * Pin the caller's model through `session/set_config_option`, and report the
 * model actually in effect (for the usage stamp). Emits a `notice` when the
 * agent exposes no model selector or offers nothing matching.
 */
export async function pinModel(args: {
  request: <T = unknown>(method: string, params: unknown) => Promise<T>;
  emit: (event: TurnStreamEvent) => void;
  sessionId: string;
  configOptions: SessionConfigOption[];
  requested?: string;
  resolveModel?: (model: string) => string;
}): Promise<string | undefined> {
  const option = findModelOption(args.configOptions);
  const current = typeof option?.currentValue === 'string' ? option.currentValue : undefined;

  if (!args.requested) return current;

  if (!option) {
    args.emit({
      type: 'notice',
      level: 'info',
      code: 'model_unsupported',
      message: `This runner picks its own model — the selected model (${args.requested}) was ignored.`,
    });
    return current;
  }

  const wanted = args.resolveModel ? args.resolveModel(args.requested) : args.requested;
  const value = matchModelValue(flattenSelectOptions(option.options), wanted);
  if (!value) {
    args.emit({
      type: 'notice',
      level: 'warn',
      code: 'model_not_offered',
      message:
        `This runner doesn’t offer the selected model (${args.requested}) — ` +
        `it used its own default instead.`,
    });
    return current;
  }
  if (value === current) return current;

  try {
    await args.request(SET_CONFIG_OPTION, {
      sessionId: args.sessionId,
      configId: option.id,
      value,
    });
    return value;
  } catch {
    // The agent rejected the pin (stale option list, provider hiccup). The
    // turn is still runnable on its default — say so instead of failing it.
    args.emit({
      type: 'notice',
      level: 'warn',
      code: 'model_not_offered',
      message:
        `This runner refused the selected model (${args.requested}) — ` +
        `it used its own default instead.`,
    });
    return current;
  }
}
