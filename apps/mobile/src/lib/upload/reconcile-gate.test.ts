import { describe, expect, it } from 'vitest';

import { reconcileGate } from './reconcile-gate';

describe('reconcileGate', () => {
  it('proceeds whenever there are transfers, session or not', () => {
    expect(reconcileGate({ hasTransfers: true, hasFollowups: false, hasSession: false })).toBe(
      true,
    );
    expect(reconcileGate({ hasTransfers: true, hasFollowups: false, hasSession: true })).toBe(true);
  });

  it('replays follow-ups only when a session can execute them', () => {
    expect(reconcileGate({ hasTransfers: false, hasFollowups: true, hasSession: true })).toBe(true);
    expect(reconcileGate({ hasTransfers: false, hasFollowups: true, hasSession: false })).toBe(
      false,
    );
  });

  it('does nothing when the queue is idle', () => {
    expect(reconcileGate({ hasTransfers: false, hasFollowups: false, hasSession: true })).toBe(
      false,
    );
    expect(reconcileGate({ hasTransfers: false, hasFollowups: false, hasSession: false })).toBe(
      false,
    );
  });
});
