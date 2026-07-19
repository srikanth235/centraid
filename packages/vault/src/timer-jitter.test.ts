import { expect, test } from 'vitest';
import { jitterDelayMs } from './timer-jitter.js';

test('standing-duty jitter stays inside its bounded window (#456 I6)', () => {
  expect(jitterDelayMs(1_000, () => 0)).toBe(900);
  expect(jitterDelayMs(1_000, () => 0.5)).toBe(1_000);
  expect(jitterDelayMs(1_000, () => 1)).toBe(1_100);
});
