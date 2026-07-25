import { tempDir } from '@centraid/test-kit/temp-dir';
/*
 * Condition/data cursor sources: consented read → row-content dedup →
 * delivered elements. Stub bridge; the committed position is handed in by the
 * engine, so these tests pin that a reader never reports a position ahead of
 * what it actually returned.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { VaultBridge } from '@centraid/app-engine';
import { readConditionCursor, readDataCursor } from './condition.js';
import type { ConditionTrigger } from '../manifest/manifest.js';

const TRIGGER: ConditionTrigger = {
  kind: 'condition',
  entity: 'business.invoice',
  where: [{ column: 'due_at', op: 'within-next-days', value: 3 }],
};

function bridgeReturning(rowsByCall: Record<string, unknown>[][]): {
  bridge: VaultBridge;
  reads: number;
} {
  const state = { reads: 0 };
  const bridge: VaultBridge = async (call) => {
    if (call.op !== 'read') return { ok: false, code: 'VAULT_ERROR', error: 'unexpected op' };
    const rows = rowsByCall[Math.min(state.reads, rowsByCall.length - 1)] ?? [];
    state.reads += 1;
    return { ok: true, result: { rows, receiptId: `r${state.reads}` } };
  };
  return { bridge, reads: state.reads };
}

/*
 * The cursor-source readers hold no state of their own: the engine hands them
 * the committed position and commits whatever they return — so what they
 * return may never run ahead of what they delivered.
 */
describe('readConditionCursor', () => {
  const read = (
    rows: Record<string, unknown>[],
    positionJson: string | undefined,
    now: Date,
    limit = 50,
  ): ReturnType<typeof readConditionCursor> =>
    readConditionCursor({
      automationRef: 'billing/invoice-watch',
      trigger: TRIGGER,
      purpose: 'dpv:Billing',
      vault: async (call) =>
        call.op === 'read'
          ? { ok: true, result: { rows } }
          : { ok: false, code: 'VAULT_ERROR', error: 'unexpected op' },
      ...(positionJson !== undefined ? { positionJson } : {}),
      limit,
      now,
    });

  const invoiceA = { invoice_id: 'a', status: 'sent', due_at: '2026-07-05' };
  const invoiceB = { invoice_id: 'b', status: 'sent', due_at: '2026-07-06' };

  it('gives every delivery occurrence its own position so a re-entry fires again', async () => {
    const first = await read([invoiceA], undefined, new Date(1_000));
    expect(first.elements).toHaveLength(1);

    // Still matching, already delivered: suppressed by content hash.
    const quiet = await read([invoiceA], first.positionJson, new Date(2_000));
    expect(quiet.elements).toEqual([]);
    expect(quiet.positionJson).toBe(first.positionJson);

    // It leaves the window (paid) — the hash is forgotten…
    const empty = await read([], quiet.positionJson, new Date(3_000));
    expect(empty.positionJson).toBe('[]');

    // …so the next cycle re-enters with the SAME content and fires again,
    // under a position the host has not already receipted a run for.
    const reentry = await read([invoiceA], empty.positionJson, new Date(4_000));
    expect(reentry.elements).toHaveLength(1);
    expect(reentry.elements[0]?.position).not.toBe(first.elements[0]?.position);
    expect(reentry.elements[0]?.payload).toEqual(invoiceA);
  });

  it('leaves matches beyond the cap unseen instead of counting them skipped', async () => {
    const capped = await read([invoiceA, invoiceB], undefined, new Date(1_000), 1);

    expect(capped.elements.map((element) => element.payload)).toEqual([invoiceA]);
    // The surplus row is still sitting in the vault — it is not a gap.
    expect(capped.skipped).toBe(0);
    expect(capped.gapReason).toBeUndefined();
    expect(JSON.parse(capped.positionJson ?? '[]')).toHaveLength(1);

    const rest = await read([invoiceA, invoiceB], capped.positionJson, new Date(2_000), 1);
    expect(rest.elements.map((element) => element.payload)).toEqual([invoiceB]);
  });

  it('throws a consent deny rather than reporting an empty window', async () => {
    await expect(
      readConditionCursor({
        automationRef: 'billing/invoice-watch',
        trigger: TRIGGER,
        purpose: 'dpv:Billing',
        vault: async () => ({ ok: false, code: 'VAULT_CONSENT', error: 'deny (receipt r1)' }),
        limit: 50,
        now: new Date(1_000),
      }),
    ).rejects.toThrow(/VAULT_CONSENT/);
    await expect(
      readConditionCursor({
        automationRef: 'not-a-ref',
        trigger: TRIGGER,
        purpose: 'dpv:Billing',
        vault: async () => ({ ok: true, result: { rows: [] } }),
        limit: 50,
        now: new Date(1_000),
      }),
    ).rejects.toThrow(/invalid ref/);
  });
});

describe('readDataCursor', () => {
  const DATA_TRIGGER = { kind: 'data', entities: ['core.transaction'] } as const;

  function feed(changes: Record<string, unknown>[], cursor: string) {
    const requests: Array<{ cursor: string | null; limit: number }> = [];
    const vault: VaultBridge = async (call) => {
      if (call.op !== 'changes') return { ok: false, code: 'VAULT_ERROR', error: 'unexpected op' };
      requests.push({
        cursor: (call.payload.cursor as string | null) ?? null,
        limit: call.payload.limit as number,
      });
      return { ok: true, result: { changes, cursor } };
    };
    return { vault, requests };
  }

  it('bootstraps at the watermark without firing', async () => {
    const { vault, requests } = feed([], 'p1');

    const result = await readDataCursor({
      automationRef: 'studio/reconciler',
      trigger: DATA_TRIGGER,
      purpose: 'dpv:Billing',
      vault,
      limit: 50,
      now: new Date(1_000),
    });

    expect(result.elements).toEqual([]);
    expect(result.positionJson).toBe('"p1"');
    expect(requests).toEqual([{ cursor: null, limit: 50 }]);
  });

  it('delivers every entry it advances past and never pulls more than the cap', async () => {
    const changes = [
      { provId: 'p2', entity: 'core.transaction', entityId: 't1' },
      { provId: 'p3', entity: 'core.transaction', entityId: 't2' },
    ];
    const { vault, requests } = feed(changes, 'p3');

    const result = await readDataCursor({
      automationRef: 'studio/reconciler',
      trigger: DATA_TRIGGER,
      purpose: 'dpv:Billing',
      vault,
      positionJson: '"p1"',
      limit: 2,
      now: new Date(5_000),
    });

    // The feed's watermark is its last returned row, so committing it is only
    // honest when every returned row is delivered.
    expect(requests).toEqual([{ cursor: 'p1', limit: 2 }]);
    expect(result.elements).toEqual([
      { position: 'p2', occurredAt: 5_000, payload: changes[0], positionJson: '"p2"' },
      { position: 'p3', occurredAt: 5_000, payload: changes[1], positionJson: '"p3"' },
    ]);
    expect(result.positionJson).toBe('"p3"');
    expect(result.skipped).toBe(0);
  });

  it('synthesizes a delivery position but no watermark for an id-less entry', async () => {
    const { vault } = feed([{ entity: 'core.transaction', entityId: 't1' }], 'p9');

    const result = await readDataCursor({
      automationRef: 'studio/reconciler',
      trigger: DATA_TRIGGER,
      purpose: 'dpv:Billing',
      vault,
      positionJson: '"p1"',
      limit: 50,
      now: new Date(5_000),
    });

    expect(result.elements[0]?.position).toMatch(/:0$/);
    expect(result.elements[0]?.positionJson).toBeUndefined();
  });

  it('throws a denied pull and rejects a malformed ref', async () => {
    await expect(
      readDataCursor({
        automationRef: 'studio/reconciler',
        trigger: DATA_TRIGGER,
        purpose: 'dpv:Billing',
        vault: async () => ({ ok: false, code: 'VAULT_CONSENT', error: 'deny (receipt r1)' }),
        limit: 50,
        now: new Date(1_000),
      }),
    ).rejects.toThrow(/VAULT_CONSENT/);
    await expect(
      readDataCursor({
        automationRef: 'nope',
        trigger: DATA_TRIGGER,
        purpose: 'dpv:Billing',
        vault: async () => ({ ok: true, result: { changes: [], cursor: 'p1' } }),
        limit: 50,
        now: new Date(1_000),
      }),
    ).rejects.toThrow(/invalid ref/);
  });
});
