/*
 * Unified agent-turn primitive.
 *
 * Both chat and builder share this entry point. It dispatches to a
 * `RunnerBackend` from the registry (`./registry.ts`) based on the user's
 * persisted `agent.runner.kind` pref:
 *
 * Since issue #479 every kind uses the same transport — the generic ACP
 * client over JSON-RPC stdio. They differ only in what is spawned:
 *
 *   - `codex` / `claude-code` → their first-party ACP adapter, which drives
 *     the user's `codex` / `claude` CLI underneath
 *   - `gemini` / `qwen` / `opencode` / `grok` / `kimi` / `acp` → the CLI
 *     itself, with its own ACP flag or subcommand
 *
 * Every backend emits the same `TurnStreamEvent` shape, so callers don't
 * need to know which one ran a given turn. The returned `adapterSessionId`
 * (codex thread id / claude session id / ACP session id) is opaque —
 * round-trip it on the next turn via `prevSessionId` to resume.
 */

import type { TurnConfig, TurnInput, TurnResult } from '@centraid/app-engine';
import { RUNNER_BACKENDS } from './registry.js';

// The turn-driver contract (`ToolContext`, `TurnInput/Config/Result`)
// now lives in `@centraid/app-engine` so the backend-agnostic run engine can
// speak it. Re-exported here so this package's modules + back-compat
// consumers keep importing them from `@centraid/agent-runtime`.
export type { ToolContext, TurnInput, TurnConfig, TurnResult } from '@centraid/app-engine';

export async function runTurn(input: TurnInput, config: TurnConfig): Promise<TurnResult> {
  const backend = RUNNER_BACKENDS[config.prefs.kind];
  if (!backend) {
    throw new Error(`unknown runner kind: ${String(config.prefs.kind)}`);
  }
  return backend.runTurn(input, config);
}
