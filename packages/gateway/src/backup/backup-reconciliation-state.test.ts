// Reconciliation state pure helpers (issue #545 B7).

import { expect, test } from 'vitest';
import {
  driftSummary,
  failedReconciliation,
  unavailableStore,
} from './backup-reconciliation-state.js';

test('driftSummary dedupes, sorts, and caps the sample at 25', () => {
  expect(driftSummary([])).toEqual({ count: 0, sample: [] });
  expect(driftSummary(['b', 'a', 'b'])).toEqual({ count: 2, sample: ['a', 'b'] });
  const many = Array.from({ length: 40 }, (_, i) => `k${String(i).padStart(2, '0')}`);
  const summary = driftSummary(many);
  expect(summary.count).toBe(40);
  expect(summary.sample).toHaveLength(25);
  expect(summary.sample[0]).toBe('k00');
});

test('unavailableStore marks not-configured vs unavailable', () => {
  expect(unavailableStore(false)).toMatchObject({
    configured: false,
    source: 'not-configured',
    providerAttested: false,
    objectCount: 0,
    missing: { count: 0 },
    orphans: { count: 0 },
  });
  expect(unavailableStore(true, 'boom')).toMatchObject({
    configured: true,
    source: 'unavailable',
    error: 'boom',
  });
});

test('failedReconciliation builds an error shell with empty cas/wal/audit', () => {
  const state = failedReconciliation('2026-07-25T00:00:00.000Z', 'scheduled', 'provider down');
  expect(state).toMatchObject({
    checkedAt: '2026-07-25T00:00:00.000Z',
    mode: 'scheduled',
    status: 'error',
    backup: { configured: true, source: 'unavailable', error: 'provider down' },
    cas: { configured: false, source: 'not-configured' },
    walGaps: { count: 0 },
    snapshots: { live: 0, pruned: 0, recent: [] },
    audit: { source: 'unavailable', eventCount: 0, recent: [] },
  });
});
