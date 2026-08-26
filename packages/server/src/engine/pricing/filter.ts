// LiteLLM catalog filter (#445): Claude + GPT/Codex text families only.
// NO concrete model ids — provider tags + generic stems.

import type { PricingCatalog, PricingEntry } from "./types.js";

const KEPT_FIELDS = [
  "input_cost_per_token",
  "output_cost_per_token",
  "cache_read_input_token_cost",
  "cache_creation_input_token_cost",
  "cache_creation_input_token_cost_above_1hr",
  "litellm_provider",
] as const;

// Text-completion families: mode gate + modality exclusion.
const CLAUDE_STEM = /claude/u;
const OPENAI_TEXT_STEM = /gpt|codex/u;
const OPENAI_NON_TEXT = /image|audio|realtime|tts|transcribe|whisper/u;
const OPENAI_TEXT_MODES = new Set(["chat", "responses"]);

function keep(id: string, entry: Record<string, unknown>): boolean {
  const provider = entry.litellm_provider;
  if (typeof entry.input_cost_per_token !== "number") return false;
  const lower = id.toLowerCase();
  if (provider === "anthropic") return CLAUDE_STEM.test(lower);
  if (provider === "openai") {
    if (lower.startsWith("ft:")) return false; // fine-tunes: not a base model id
    if (lower.includes("/")) return false; // dimension-prefixed image variants
    if (OPENAI_NON_TEXT.test(lower)) return false;
    if (!OPENAI_TEXT_STEM.test(lower)) return false;
    return OPENAI_TEXT_MODES.has(String(entry.mode));
  }
  return false;
}

function pickFields(entry: Record<string, unknown>): PricingEntry {
  const out: Record<string, unknown> = {};
  for (const f of KEPT_FIELDS) {
    if (entry[f] !== undefined) out[f] = entry[f];
  }
  return out as PricingEntry;
}

export function filterLiteLLM(raw: Record<string, unknown>): PricingCatalog {
  const out: PricingCatalog = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    if (keep(id, entry)) out[id] = pickFields(entry);
  }
  return out;
}
