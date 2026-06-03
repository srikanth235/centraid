/*
 * Codex provider routing — point a spawned codex process at an
 * OpenAI-compatible endpoint via `-c key=value` overrides.
 *
 * `codexProviderOverrideArgs` renders overrides that layer on top of the
 * user's real `~/.codex/config.toml` (honored by `codex exec` and
 * `app-server` since codex-cli 0.128.0, our pinned minimum). Layering — rather
 * than redirecting `CODEX_HOME` to a generated home — preserves everything in
 * the user's real home, including their `[mcp_servers.*]`, so centraid "rides
 * on top of the user's codex".
 *
 * The sole caller today is the in-process mock-LLM server that drives
 * automation/tool-dispatch runs (`run-automation-cli-spawn.ts`,
 * `host-tools.ts`): codex is pointed at the loopback mock endpoint. The
 * bearer token never appears in the overrides — it flows through the child
 * env under `envKey`.
 */

/**
 * Inputs for a codex `-c` model-provider override. A minimal local shape
 * (not the user-facing runner prefs) — just what the override args need.
 */
export interface CodexProviderOverride {
  /** Slug used as the `[model_providers.<id>]` table key. */
  id: string;
  /** Display name written into the toml's `name` field. */
  name: string;
  /** Base URL the endpoint exposes. */
  baseUrl: string;
  /** OpenAI wire format; defaults to `responses` (the only format codex 0.128+ accepts). */
  wireApi?: 'chat' | 'responses';
  /** Env var name codex reads the bearer token from. Omit for keyless endpoints. */
  envKey?: string;
}

/**
 * Build `-c key=value` config-override args that route a spawned codex
 * process's model calls through `p`, layered on top of the user's real
 * `~/.codex/config.toml` so their `[mcp_servers.*]` stay reachable.
 *
 * Each value is rendered as a TOML basic string (via `tomlString`) so
 * codex's override parser treats it unambiguously as a string — bare URLs
 * and ids would otherwise hit its TOML-value fast path and misparse.
 *
 * The API key is never emitted here — it flows via the child env under
 * `envKey`. Exported for unit tests.
 */
export function codexProviderOverrideArgs(p: CodexProviderOverride): string[] {
  const ns = `model_providers.${tomlBareOrQuotedKey(p.id)}`;
  const args = [
    '-c',
    `model_provider=${tomlString(p.id)}`,
    '-c',
    `${ns}.name=${tomlString(p.name)}`,
    '-c',
    `${ns}.base_url=${tomlString(p.baseUrl)}`,
    // codex 0.128+ rejects `wire_api = "chat"`; `responses` is the default.
    '-c',
    `${ns}.wire_api=${tomlString(p.wireApi ?? 'responses')}`,
  ];
  if (p.envKey) args.push('-c', `${ns}.env_key=${tomlString(p.envKey)}`);
  return args;
}

function tomlString(s: string): string {
  // TOML basic strings: double-quoted, with \", \\, and the standard
  // escape set. Control characters (< 0x20, plus 0x7f) get \uXXXX.
  let out = '"';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (ch === '"' || ch === '\\') out += '\\' + ch;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += '\\u' + code.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

function tomlBareOrQuotedKey(s: string): string {
  // TOML bare keys accept A-Za-z0-9_- only; anything else needs to be
  // wrapped as a quoted key to remain valid TOML.
  return /^[A-Za-z0-9_-]+$/.test(s) ? s : tomlString(s);
}
