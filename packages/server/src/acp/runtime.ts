/*
 * Unified harness-turn primitive.
 *
 * Both chat and builder share this entry point. It dispatches to a
 * `HarnessSpec` from the registry (`./registry.ts`) based on the user's
 * persisted `harness.kind` pref:
 *
 * Since #479 every kind uses the same transport — the generic ACP
 * client over JSON-RPC stdio. They differ only in what is spawned:
 *
 *   - `codex` / `claude-code` → their first-party ACP adapter, which drives
 *     the user's `codex` / `claude` CLI underneath
 *   - every other kind (`gemini`, `qwen`, `opencode`, `grok`, `kimi`,
 *     `copilot`, `cursor`, `kilo`, `cline`, `goose`, `auggie`, `vibe`,
 *     `droid`, custom `acp`) → the CLI itself, with its own ACP flag,
 *     subcommand, or dedicated ACP binary
 *
 * Every harness emits the same `TurnStreamEvent` shape, so callers don't
 * need to know which one ran a given turn. The returned `harnessSessionId`
 * (codex thread id / claude session id / ACP session id) is opaque —
 * round-trip it on the next turn via `prevSessionId` to resume.
 */

import type {
  TurnConfig,
  TurnInput,
  TurnResult,
} from "@centraid/server/engine";

import { HARNESSES } from "./registry.js";

// The turn-driver contract (`ToolContext`, `TurnInput/Config/Result`) lives
// in `@centraid/server/engine` so the harness-agnostic run engine can speak
// it. Re-exported here so this package's modules and consumers keep importing
// them from `@centraid/server/acp`.
export type {
  ToolContext,
  TurnInput,
  TurnConfig,
  TurnResult,
} from "@centraid/server/engine";

export async function runTurn(
  input: TurnInput,
  config: TurnConfig
): Promise<TurnResult> {
  const harness = HARNESSES[config.prefs.kind];
  if (!harness) {
    throw new Error(`unknown harness kind: ${String(config.prefs.kind)}`);
  }
  return harness.runTurn(input, config);
}
