/*
 * LiteLLM catalog filter (issue #445).
 *
 * The upstream catalog is ~3k entries across every provider and modality
 * (chat, image, audio, embeddings). This reduces it to the families centraid
 * actually runs — Anthropic Claude and OpenAI GPT/Codex text models — keeping
 * only the per-token price fields `cost.ts` reads. The SAME function produces
 * the committed snapshot (dev refresh script) and the gateway warmer's live
 * table, so the offline fallback and the fresh fetch are byte-comparable.
 *
 * No concrete model ids appear here — families are matched by provider tag +
 * generic stem (`claude`, `gpt`, `codex`), so this file needs no directive
 * waiver (see .governance no-hardcoded-model-ids).
 */

import type { PricingCatalog, PricingEntry } from './types.js';

/** Price fields carried into the filtered snapshot. */
const KEPT_FIELDS = [
  'input_cost_per_token',
  'output_cost_per_token',
  'cache_read_input_token_cost',
  'cache_creation_input_token_cost',
  'cache_creation_input_token_cost_above_1hr',
  'litellm_provider',
] as const;

// Text-completion families. Anthropic ships only Claude; OpenAI's tag also
// covers image/audio/tts/realtime, so a chat/responses mode gate plus a
// modality exclusion keeps this to the models that bill on prompt tokens.
const CLAUDE_STEM = /claude/;
const OPENAI_TEXT_STEM = /gpt|codex/;
const OPENAI_NON_TEXT = /image|audio|realtime|tts|transcribe|whisper/;
const OPENAI_TEXT_MODES = new Set(['chat', 'responses']);

function keep(id: string, entry: Record<string, unknown>): boolean {
  const provider = entry.litellm_provider;
  // A priceable text model must at least bill for input tokens.
  if (typeof entry.input_cost_per_token !== 'number') return false;
  const lower = id.toLowerCase();
  if (provider === 'anthropic') return CLAUDE_STEM.test(lower);
  if (provider === 'openai') {
    if (lower.startsWith('ft:')) return false; // fine-tunes: not a base model id
    if (lower.includes('/')) return false; // dimension-prefixed image variants
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

/**
 * Reduce a raw LiteLLM catalog to the centraid-relevant families with only
 * the per-token price fields kept. Non-object entries and the leading
 * `sample_spec` metadata row are skipped.
 */
export function filterLiteLLM(raw: Record<string, unknown>): PricingCatalog {
  const out: PricingCatalog = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    if (keep(id, entry)) out[id] = pickFields(entry);
  }
  return out;
}
