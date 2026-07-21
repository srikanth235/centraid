import { describe, expect, it } from 'vitest';
import { ROLLOUT_WINDOW_MS, shouldAdmitUpdate, stableBucketId } from './update-rollout-core.js';

const T0 = 1_700_000_000_000;

describe('shouldAdmitUpdate (I5/I6)', () => {
  it('admits manual checks regardless of bucket/elapsed', () => {
    expect(
      shouldAdmitUpdate({
        bucket: 0.99,
        releasedAtMs: T0,
        nowMs: T0,
        manualCheck: true,
      }),
    ).toBe(true);
  });

  it('fails open on missing or unparseable release metadata', () => {
    expect(shouldAdmitUpdate({ bucket: 0.9, nowMs: T0 })).toBe(true);
    expect(shouldAdmitUpdate({ bucket: 0.9, releasedAtMs: null, nowMs: T0 })).toBe(true);
    expect(shouldAdmitUpdate({ bucket: 0.9, releasedAtMs: Number.NaN, nowMs: T0 })).toBe(true);
  });

  it('fails closed on negative elapsed (clock skew)', () => {
    expect(
      shouldAdmitUpdate({
        bucket: 0,
        releasedAtMs: T0 + 60_000,
        nowMs: T0,
      }),
    ).toBe(false);
  });

  it('admits when bucket is below the elapsed/window fraction', () => {
    const half = T0 + ROLLOUT_WINDOW_MS / 2;
    expect(
      shouldAdmitUpdate({
        bucket: 0.25,
        releasedAtMs: T0,
        nowMs: half,
      }),
    ).toBe(true);
    expect(
      shouldAdmitUpdate({
        bucket: 0.75,
        releasedAtMs: T0,
        nowMs: half,
      }),
    ).toBe(false);
  });

  it('admits everyone once the full window has elapsed', () => {
    const end = T0 + ROLLOUT_WINDOW_MS;
    expect(
      shouldAdmitUpdate({
        bucket: 0.999,
        releasedAtMs: T0,
        nowMs: end,
      }),
    ).toBe(true);
  });

  it('admits nobody at the instant of release (fraction 0)', () => {
    expect(
      shouldAdmitUpdate({
        bucket: 0,
        releasedAtMs: T0,
        nowMs: T0,
      }),
    ).toBe(false);
  });

  it('respects a custom windowMs', () => {
    const windowMs = 1000;
    expect(
      shouldAdmitUpdate({
        bucket: 0.4,
        releasedAtMs: T0,
        nowMs: T0 + 500,
        windowMs,
      }),
    ).toBe(true);
    expect(
      shouldAdmitUpdate({
        bucket: 0.6,
        releasedAtMs: T0,
        nowMs: T0 + 500,
        windowMs,
      }),
    ).toBe(false);
  });
});

describe('stableBucketId', () => {
  it('returns a value in [0, 1)', () => {
    for (const id of ['a', 'install-1', 'xxxxxxxx', '']) {
      const b = stableBucketId(id);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(1);
    }
  });

  it('is stable for the same install id', () => {
    expect(stableBucketId('desk-42')).toBe(stableBucketId('desk-42'));
  });

  it('differs across distinct ids (usually)', () => {
    // Extremely unlikely collision for these two strings.
    expect(stableBucketId('alpha')).not.toBe(stableBucketId('beta'));
  });
});

describe('ROLLOUT_WINDOW_MS', () => {
  it('is 72 hours', () => {
    expect(ROLLOUT_WINDOW_MS).toBe(72 * 60 * 60 * 1000);
  });
});
