import type { AsstUsageDTO } from "../screen-contracts.js";

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatUsageLabel(u: AsstUsageDTO | undefined): string | null {
  if (!u) return null;
  const parts: string[] = [];
  if (u.inputTokens) parts.push(`↑${formatTokens(u.inputTokens)}`);
  if (u.outputTokens) parts.push(`↓${formatTokens(u.outputTokens)}`);
  let label = parts.join(" ");
  if (typeof u.costUsd === "number") {
    label += `${label ? " · " : ""}${u.estimated ? "~" : ""}${formatCost(u.costUsd)}`;
  }
  return label || null;
}

export function formatUsageTitle(
  u: AsstUsageDTO | undefined
): string | undefined {
  if (!u) return undefined;
  const parts: string[] = [];
  if (u.inputTokens !== undefined)
    parts.push(`${u.inputTokens.toLocaleString()} tokens in`);
  if (u.outputTokens !== undefined)
    parts.push(`${u.outputTokens.toLocaleString()} tokens out`);
  if (typeof u.costUsd === "number") {
    parts.push(`${formatCost(u.costUsd)}${u.estimated ? " (estimated)" : ""}`);
  }
  if (u.model) parts.push(u.model);
  if (u.effort) parts.push(`${u.effort} effort`);
  return parts.length ? parts.join(" · ") : undefined;
}
