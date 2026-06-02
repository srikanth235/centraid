/*
 * Shared OpenClaw embedded-agent turn helper.
 *
 * The per-app chat runner (`openclaw-chat-runner.ts`) and the automation fire's
 * dispatchers (`openclaw-fire.ts`) both bottom out in the same call:
 * `api.runtime.agent.runEmbeddedAgent(...)`. This module owns what they share —
 * the SDK-derived param/result/config types, the centraid defaults every turn
 * uses, and pulling the assistant text out of a finished run — so the call
 * sites can't drift on the wire shape.
 *
 * Deliberately NOT here: the chat streaming-event translation (chat-only, so
 * sharing it dedups nothing) and the `ctx.agent` JSON coercion (shared
 * cross-package — it lives in `@centraid/conversation-engine` as
 * `coerceAgentAnswer`).
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

// Derive the embedded-agent param/result/config types from the installed SDK so
// we don't depend on non-exported symbols (e.g. `OpenClawConfig`).
export type RunEmbeddedAgent = OpenClawPluginApi['runtime']['agent']['runEmbeddedAgent'];
export type EmbeddedParams = Parameters<RunEmbeddedAgent>[0];
export type EmbeddedResult = Awaited<ReturnType<RunEmbeddedAgent>>;
export type EmbeddedConfig = NonNullable<EmbeddedParams['config']>;

/**
 * Run one embedded-agent turn with centraid's shared defaults applied. Centraid
 * is never the user's canonical agent — `isCanonicalWorkspace: false` gives
 * `bootstrapMode = "limited"` (AGENTS.md / SOUL.md / USER.md loading skipped) —
 * and always sends a full prompt. A caller overrides either by setting the
 * field explicitly (its value wins via the spread).
 */
export function runEmbeddedTurn(
  api: OpenClawPluginApi,
  params: EmbeddedParams,
): ReturnType<RunEmbeddedAgent> {
  return api.runtime.agent.runEmbeddedAgent({
    isCanonicalWorkspace: false,
    promptMode: 'full',
    ...params,
  });
}

/** Pull the assistant text out of a finished embedded run. */
export function payloadText(result: EmbeddedResult): string {
  return (result.payloads ?? [])
    .filter((p) => !p.isReasoning && typeof p.text === 'string')
    .map((p) => p.text ?? '')
    .join('')
    .trim();
}
