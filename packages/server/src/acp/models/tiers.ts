import type { HarnessModel } from "@centraid/server/engine";

import type { HarnessKind } from "../types.js";

export type CapabilityTier = "smart" | "balanced" | "fast";

export const HARNESS_TIERS: Partial<
  Record<HarnessKind, readonly HarnessModel[]>
> = {
  "claude-code": [
    { id: "smart", name: "Most capable", default: true },
    { id: "balanced", name: "Balanced" },
    { id: "fast", name: "Fastest" },
  ],
};

const CLAUDE_TIER_ALIAS: Record<CapabilityTier, string> = {
  smart: "opus",
  balanced: "sonnet",
  fast: "haiku",
};

export function resolveClaudeModel(model: string): string {
  return CLAUDE_TIER_ALIAS[model as CapabilityTier] ?? model;
}
