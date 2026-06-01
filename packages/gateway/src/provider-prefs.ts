/*
 * Parse `agent.runner.provider.*` keys out of the user_prefs blob.
 *
 * Returns the synchronous, secret-free portion of the provider config.
 * The API key lives in a `SecretsProvider` and is spliced in by the
 * caller — keeping the parse step host-agnostic means tests + the
 * daemon + the Electron embed all share it.
 *
 * The string-pref reader mirrors the previous helper in the desktop's
 * `local-runtime.ts`. Kept in-package (rather than reused from
 * app-engine) because it's a tiny utility and the only consumer is
 * `serve()`'s prefs loader.
 */

import type { OpenAICompatProvider } from '@centraid/agent-runtime';
import type { SecretsProvider } from './secrets.js';

export function parseProviderPrefs(
  prefs: Record<string, unknown>,
): Omit<OpenAICompatProvider, 'apiKey'> | undefined {
  const id = readStringPref(prefs, 'agent.runner.provider.id');
  const baseUrl = readStringPref(prefs, 'agent.runner.provider.baseUrl');
  if (!id || !baseUrl) return undefined;
  const name = readStringPref(prefs, 'agent.runner.provider.name') ?? id;
  const wireRaw = readStringPref(prefs, 'agent.runner.provider.wireApi');
  const wireApi: 'chat' | 'responses' | undefined =
    wireRaw === 'chat' || wireRaw === 'responses' ? wireRaw : undefined;
  const envKey = readStringPref(prefs, 'agent.runner.provider.envKey');
  return {
    id,
    name,
    baseUrl,
    ...(wireApi ? { wireApi } : {}),
    ...(envKey ? { envKey } : {}),
  };
}

function readStringPref(prefs: Record<string, unknown>, key: string): string | undefined {
  const v = prefs[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Parse the provider prefs, then splice in the API key from the injected
 * `SecretsProvider` (skipped when the provider declares no `envKey`).
 * Returns the full `OpenAICompatProvider` the chat runner / automation
 * runner expect, or `undefined` when no provider is configured.
 */
export async function resolveProvider(
  prefs: Record<string, unknown>,
  secrets: SecretsProvider,
): Promise<OpenAICompatProvider | undefined> {
  const base = parseProviderPrefs(prefs);
  if (!base) return undefined;
  if (!base.envKey) return base;
  const apiKey = await secrets.getProviderApiKey();
  return apiKey ? { ...base, apiKey } : base;
}
