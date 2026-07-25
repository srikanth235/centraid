import { tempDirSync } from '@centraid/test-kit/temp-dir';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeJournalDbProvider } from '../stores/gateway-db.js';
import { AutomationTriggerStore } from './trigger-store.js';

function store(): AutomationTriggerStore {
  return new AutomationTriggerStore(
    makeJournalDbProvider(join(tempDirSync('centraid-trigger-store-'), 'journal.db')),
  );
}

describe('AutomationTriggerStore', () => {
  it('upserts independent per-trigger cursors and removes stale automations', () => {
    const subject = store();
    subject.putCursor({
      automationId: 'mail/digest',
      triggerIndex: 0,
      sourceKind: 'cron',
      positionJson: '100',
      pendingJson: '{"targetPositionJson":"200","acknowledged":[]}',
      skipped: 3,
      gapReason: 'scheduler_gap',
      updatedAt: 200,
    });
    subject.putCursor({
      automationId: 'mail/digest',
      triggerIndex: 1,
      sourceKind: 'webhook',
      positionJson: '7',
      updatedAt: 201,
    });
    subject.putCursor({
      automationId: 'old/gone',
      triggerIndex: 0,
      sourceKind: 'data',
      updatedAt: 1,
    });

    expect(subject.getCursor('mail/digest', 0)).toMatchObject({
      sourceKind: 'cron',
      positionJson: '100',
      pendingJson: '{"targetPositionJson":"200","acknowledged":[]}',
      skipped: 3,
      gapReason: 'scheduler_gap',
    });
    expect(subject.getCursor('mail/digest', 1)).toMatchObject({
      sourceKind: 'webhook',
      positionJson: '7',
    });
    expect(subject.deleteCursorsNotIn(['mail/digest'])).toBe(1);
    expect(subject.getCursor('old/gone', 0)).toBeUndefined();
  });

  it('deduplicates ingress, exposes bounded backlog metadata, and prunes retention', () => {
    const subject = store();
    const first = subject.appendIngress({
      source: 'webhook',
      sourceKey: 'hook-1',
      deliveryId: 'delivery-1',
      receivedAt: 100,
      payloadJson: '{"n":1}',
      expiresAt: 500,
    });
    const duplicate = subject.appendIngress({
      source: 'webhook',
      sourceKey: 'hook-1',
      deliveryId: 'delivery-1',
      receivedAt: 101,
      payloadJson: '{"n":999}',
      expiresAt: 500,
    });
    const second = subject.appendIngress({
      source: 'webhook',
      sourceKey: 'hook-1',
      deliveryId: 'delivery-2',
      receivedAt: 200,
      payloadJson: '{"n":2}',
      expiresAt: 900,
    });

    expect(first.inserted).toBe(true);
    expect(duplicate).toEqual({ inserted: false, id: first.id });
    expect(second.id).toBeGreaterThan(first.id);
    expect(subject.ingressBoundsAfter('hook-1', 0)).toEqual({
      count: 2,
      latestId: second.id,
    });
    expect(subject.listIngressAfter('hook-1', 0, 1)).toEqual([
      expect.objectContaining({ id: first.id, payloadJson: '{"n":1}' }),
    ]);
    expect(subject.pruneIngress(600)).toBe(1);
    expect(subject.listIngressAfter('hook-1', 0, 10)).toEqual([
      expect.objectContaining({ id: second.id }),
    ]);
  });
});
