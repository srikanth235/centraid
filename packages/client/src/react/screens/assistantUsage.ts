// Per-turn usage/cost formatting for the assistant transcript (issue #420,
// Wave 2). Two paths feed the "this turn cost X" line:
//   • Reloaded from the ledger — the gateway froze the exact `costUsd` at write
//     time (packages/app-engine/src/model-pricing.ts) and ships it on the turn.
//   • Live-streamed — the `usage` event carries only token counts + model, so
//     we compute a CLIENT-SIDE ESTIMATE here. It is deliberately a mirror of the
//     server price table (a snapshot; may drift). The estimate is replaced by
//     the authoritative frozen cost the moment the turn is reloaded from the
//     ledger, so it is only ever shown for the few seconds a turn is live.
// The client cannot import @centraid/app-engine (node-side), so the small table
// is duplicated here on purpose — keep it in sync with model-pricing.ts.

import type { AsstUsageDTO } from '../screen-contracts.js';

interface Price {
  inputPerMtok: number;
  outputPerMtok: number;
}

// USD per million tokens, longest-prefix wins. Mirrors model-pricing.ts (input/
// output rates only — cache tokens aren't in the live `usage` event).
const PRICE_TABLE: ReadonlyArray<readonly [string, Price]> = [
  ['claude-opus', { inputPerMtok: 15, outputPerMtok: 75 }],
  ['claude-sonnet', { inputPerMtok: 3, outputPerMtok: 15 }],
  ['claude-haiku', { inputPerMtok: 0.8, outputPerMtok: 4 }],
  ['gpt-5-codex', { inputPerMtok: 1.25, outputPerMtok: 10 }],
  ['gpt-5-mini', { inputPerMtok: 0.25, outputPerMtok: 2 }],
  ['gpt-5', { inputPerMtok: 1.25, outputPerMtok: 10 }],
];

function priceFor(model: string | undefined): Price | undefined {
  if (!model) return undefined;
  const id = model.trim().toLowerCase().split('/').at(-1) ?? '';
  let best: Price | undefined;
  let bestLen = -1;
  for (const [prefix, price] of PRICE_TABLE) {
    if (id.startsWith(prefix) && prefix.length > bestLen) {
      best = price;
      bestLen = prefix.length;
    }
  }
  return best;
}

/** Client-side USD estimate for a live turn, or `undefined` when unpriced. */
export function estimateCostUsd(
  model: string | undefined,
  usage: { inputTokens?: number; outputTokens?: number },
): number | undefined {
  const price = priceFor(model);
  if (!price) return undefined;
  return (
    ((usage.inputTokens ?? 0) / 1_000_000) * price.inputPerMtok +
    ((usage.outputTokens ?? 0) / 1_000_000) * price.outputPerMtok
  );
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** A compact "↑1.2k ↓340 · $0.004" label, or `null` when there's nothing to show. */
export function formatUsageLabel(u: AsstUsageDTO | undefined): string | null {
  if (!u) return null;
  const parts: string[] = [];
  if (u.inputTokens) parts.push(`↑${formatTokens(u.inputTokens)}`);
  if (u.outputTokens) parts.push(`↓${formatTokens(u.outputTokens)}`);
  let label = parts.join(' ');
  if (typeof u.costUsd === 'number') {
    label += `${label ? ' · ' : ''}${u.estimated ? '~' : ''}${formatCost(u.costUsd)}`;
  }
  return label || null;
}

/** A verbose tooltip: "1,203 in · 340 out · $0.004 (estimated)". */
export function formatUsageTitle(u: AsstUsageDTO | undefined): string | undefined {
  if (!u) return undefined;
  const parts: string[] = [];
  if (u.inputTokens !== undefined) parts.push(`${u.inputTokens.toLocaleString()} tokens in`);
  if (u.outputTokens !== undefined) parts.push(`${u.outputTokens.toLocaleString()} tokens out`);
  if (typeof u.costUsd === 'number') {
    parts.push(`${formatCost(u.costUsd)}${u.estimated ? ' (estimated)' : ''}`);
  }
  if (u.model) parts.push(u.model);
  return parts.length ? parts.join(' · ') : undefined;
}
