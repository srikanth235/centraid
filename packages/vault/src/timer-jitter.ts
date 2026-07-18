/** Spread standing duties so many mounted vaults do not wake and fsync together. */
export function jitterDelayMs(
  delayMs: number,
  random: () => number = Math.random,
  spread = 0.1,
): number {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return Math.max(0, delayMs);
  const bounded = Math.min(0.5, Math.max(0, spread));
  return Math.max(1, Math.round(delayMs * (1 - bounded + random() * bounded * 2)));
}
