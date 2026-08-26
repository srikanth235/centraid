// Dispatch by `harness.kind` (#479); session ids are opaque — pass back
// as `prevSessionId`.

import type {
  TurnConfig,
  TurnInput,
  TurnResult,
} from "@centraid/server/engine";

import { HARNESSES } from "./registry.js";

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
