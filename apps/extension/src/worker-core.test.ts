import { describe, expect, it } from 'vitest';
import {
  approvalBadgeForState,
  approvalBadgeText,
  isLockerFillMessage,
  shouldCaptureContextMenu,
} from './worker-core.js';

describe('approvalBadgeText', () => {
  it('clears empty counts and caps at 99', () => {
    expect(approvalBadgeText(0)).toBe('');
    expect(approvalBadgeText(undefined)).toBe('');
    expect(approvalBadgeText(3)).toBe('3');
    expect(approvalBadgeText(150)).toBe('99');
  });
});

describe('approvalBadgeForState', () => {
  it('clears when unpaired or locked', () => {
    expect(approvalBadgeForState({ paired: false, locked: false, count: 2 })).toBe('');
    expect(approvalBadgeForState({ paired: true, locked: true, count: 2 })).toBe('');
  });

  it('shows bang when unreachable but still paired', () => {
    expect(approvalBadgeForState({ paired: true, locked: false, unreachable: true })).toBe('!');
  });

  it('shows the count when healthy', () => {
    expect(approvalBadgeForState({ paired: true, locked: false, count: 4 })).toBe('4');
  });
});

describe('isLockerFillMessage / shouldCaptureContextMenu', () => {
  it('detects locker fill messages', () => {
    expect(isLockerFillMessage({ type: 'locker:fill' })).toBe(true);
    expect(isLockerFillMessage({ type: 'status' })).toBe(false);
    expect(isLockerFillMessage(null)).toBe(false);
  });

  it('only captures the quick-task menu on a tab with a URL', () => {
    expect(
      shouldCaptureContextMenu({ menuItemId: 'centraid-quick-task', tabUrl: 'https://x' }),
    ).toBe(true);
    expect(shouldCaptureContextMenu({ menuItemId: 'other', tabUrl: 'https://x' })).toBe(false);
    expect(shouldCaptureContextMenu({ menuItemId: 'centraid-quick-task' })).toBe(false);
  });
});
