import { describe, expect, test } from 'vitest';

const importFixture = (relativePath: string) => import(relativePath);

describe('Agenda pending intent presentation', () => {
  test('settles only the exact terminal intent and ignores unrelated changes', async () => {
    const { settlePendingChange, trackPendingOutcome } = await importFixture(
      '../apps/agenda/pending.ts',
    );
    const state = {
      pendingIds: new Set(),
      pendingCancelIds: new Set(),
      pendingByIntent: new Map(),
    };
    trackPendingOutcome(state, 'event-a', 'cancel', {
      status: 'parked',
      intentId: 'intent-a',
    });
    trackPendingOutcome(state, 'event-b', 'reschedule', {
      status: 'queued',
      intentId: 'intent-b',
    });

    expect(
      settlePendingChange(state, {
        source: 'vault-replica',
        entity: 'core.event',
        rowId: 'unrelated',
      }),
    ).toBe(false);
    expect([...state.pendingIds]).toEqual(['event-a', 'event-b']);

    expect(
      settlePendingChange(state, {
        source: 'overlay',
        intentId: 'intent-a',
        intentState: 'denied',
      }),
    ).toBe(true);
    expect([...state.pendingIds]).toEqual(['event-b']);
    expect([...state.pendingCancelIds]).toEqual([]);
  });

  test('retains exact managed settlement but clears parked legacy chips on a relevant doorbell', async () => {
    const { reconcilePendingChange, trackPendingOutcome } = await importFixture(
      '../apps/agenda/pending.ts',
    );
    const state = {
      pendingIds: new Set(),
      pendingCancelIds: new Set(),
      pendingByIntent: new Map(),
    };
    trackPendingOutcome(state, 'event-legacy', 'cancel', {
      status: 'parked',
      invocationId: 'invocation-legacy',
    });

    expect(reconcilePendingChange(state, { entity: 'core.event' }, true)).toBe(false);
    expect([...state.pendingIds]).toEqual(['event-legacy']);
    expect(reconcilePendingChange(state, { entity: 'core.event' }, false)).toBe(true);
    expect([...state.pendingIds]).toEqual([]);
    expect([...state.pendingCancelIds]).toEqual([]);
  });
});
