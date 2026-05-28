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
 * runtime-core) because it's a tiny utility and the only consumer is
 * `serve()`'s prefs loader.
 */

import type { OpenAICompatProvider } from '@centraid/agent-runtime';

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
