export const ROLLOUT_WINDOW_MS = 72 * 60 * 60 * 1000;

export interface ShouldAdmitUpdateInput {
  bucket: number;
  releasedAtMs?: number | null;
  nowMs: number;
  windowMs?: number;
  manualCheck?: boolean;
}

export function shouldAdmitUpdate(input: ShouldAdmitUpdateInput): boolean {
  if (input.manualCheck) return true;
  const releasedAtMs = input.releasedAtMs;
  if (releasedAtMs == null || !Number.isFinite(releasedAtMs)) return true;

  const elapsed = input.nowMs - releasedAtMs;
  if (elapsed < 0) return false;

  const windowMs =
    typeof input.windowMs === "number" &&
    Number.isFinite(input.windowMs) &&
    input.windowMs > 0
      ? input.windowMs
      : ROLLOUT_WINDOW_MS;

  const fraction = Math.min(1, elapsed / windowMs);
  return input.bucket < fraction;
}

export function stableBucketId(installId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < installId.length; i++) {
    hash ^= installId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}
