/*
 * Pure staged-rollout math for desktop auto-updates (issue #468, I5/I6).
 *
 * Admit when `bucket < elapsed / window`. The bucket is a stable per-install
 * id in [0, 1) — re-rolling per check would turn every poll into an
 * independent coin flip and make the ramp meaningless.
 *
 * Fail-open (I6): missing/unparseable release metadata and manual checks
 * admit. Fail-closed only on negative elapsed (clock skew).
 *
 * Electron/updater wiring lives in `update-rollout.ts`. The existing
 * dist-mtime poller in `update-watcher.ts` stays for the unpackaged dev loop.
 */

/** Default rollout window: 72 hours (I5). */
export const ROLLOUT_WINDOW_MS = 72 * 60 * 60 * 1000;

export interface ShouldAdmitUpdateInput {
  /** Stable per-install bucket in [0, 1). */
  bucket: number;
  /** Epoch ms when the release was published. Missing/NaN → fail-open admit. */
  releasedAtMs?: number | null;
  nowMs: number;
  /** Override window; defaults to {@link ROLLOUT_WINDOW_MS}. */
  windowMs?: number;
  /** Manual "check for updates" always admits (I6). */
  manualCheck?: boolean;
}

/**
 * Whether this install should receive the update under the time-ramp policy.
 *
 * - `manualCheck` → admit
 * - missing/non-finite `releasedAtMs` → admit (fail-open)
 * - `nowMs < releasedAtMs` → deny (fail-closed clock skew)
 * - else admit when `bucket < min(1, elapsed / windowMs)`
 */
export function shouldAdmitUpdate(input: ShouldAdmitUpdateInput): boolean {
  if (input.manualCheck) return true;
  const releasedAtMs = input.releasedAtMs;
  if (releasedAtMs == null || !Number.isFinite(releasedAtMs)) return true;

  const elapsed = input.nowMs - releasedAtMs;
  if (elapsed < 0) return false;

  const windowMs =
    typeof input.windowMs === 'number' && Number.isFinite(input.windowMs) && input.windowMs > 0
      ? input.windowMs
      : ROLLOUT_WINDOW_MS;

  const fraction = Math.min(1, elapsed / windowMs);
  return input.bucket < fraction;
}

/**
 * Map a stable install id to a bucket in [0, 1) via FNV-1a 32-bit.
 * Deterministic across runs for the same id.
 */
export function stableBucketId(installId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < installId.length; i++) {
    hash ^= installId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // >>> 0 forces unsigned 32-bit; divide by 2^32 for [0, 1).
  return (hash >>> 0) / 0x1_0000_0000;
}
