/*
 * Condition-trigger evaluation: consented read → row-content dedup → fire
 * decision. Stub bridge, real cursor persistence in the per-app
 * runtime.sqlite (the same `automation_state` KV `ctx.state` uses, under
 * the reserved `__trigger:` prefix).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { VaultBridge } from '@centraid/app-engine';
import { evaluateConditionTrigger } from './condition.js';
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

describe('evaluateConditionTrigger', () => {
  let appsDir: string;

  beforeEach(async () => {
    appsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-cond-'));
    await fs.mkdir(path.join(appsDir, 'studio'), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(appsDir, { recursive: true, force: true });
  });

  const evaluate = (
    bridge: VaultBridge,
  ): ReturnType<typeof evaluateConditionTrigger> =>
    evaluateConditionTrigger({
      automationRef: 'studio/invoice-chaser',
      trigger: TRIGGER,
      triggerIndex: 0,
      purpose: 'dpv:Billing',
      appsDir,
      vault: bridge,
    });

  it('fires on unseen rows, suppresses unchanged ones, refires on change and re-entry', async () => {
    const invoiceA = { invoice_id: 'a', status: 'sent', due_at: '2026-07-05' };
    const invoiceB = { invoice_id: 'b', status: 'sent', due_at: '2026-07-06' };

    // First sight of A: fire.
    const { bridge: b1 } = bridgeReturning([[invoiceA]]);
    const first = await evaluate(b1);
    expect(first).toMatchObject({ fire: true, matched: 1 });
    expect(first.rows).toEqual([invoiceA]);

    // Same match set: no fire.
    const { bridge: b2 } = bridgeReturning([[invoiceA]]);
    expect((await evaluate(b2)).fire).toBe(false);

    // B enters the window: fire with ONLY the fresh row.
    const { bridge: b3 } = bridgeReturning([[invoiceA, invoiceB]]);
    const third = await evaluate(b3);
    expect(third.fire).toBe(true);
    expect(third.rows).toEqual([invoiceB]);

    // A changes (a reschedule) while B stays: the changed row is a new event.
    const movedA = { ...invoiceA, due_at: '2026-07-07' };
    const { bridge: b4 } = bridgeReturning([[movedA, invoiceB]]);
    const fourth = await evaluate(b4);
    expect(fourth.fire).toBe(true);
    expect(fourth.rows).toEqual([movedA]);

    // Both leave the window (paid): nothing to fire, cursor empties…
    const { bridge: b5 } = bridgeReturning([[]]);
    expect((await evaluate(b5)).fire).toBe(false);

    // …so a re-entry (next billing cycle, same content) fires again.
    const { bridge: b6 } = bridgeReturning([[movedA]]);
    const sixth = await evaluate(b6);
    expect(sixth.fire).toBe(true);
    expect(sixth.rows).toEqual([movedA]);
  });

  it('a receipted deny evaluates to no-fire with the reason surfaced', async () => {
    const deny: VaultBridge = async () => ({
      ok: false,
      code: 'VAULT_CONSENT',
      error: 'deny (receipt r1): no active grant for purpose dpv:Billing',
    });
    const evaluation = await evaluate(deny);
    expect(evaluation.fire).toBe(false);
    expect(evaluation.reason).toContain('VAULT_CONSENT');
  });
});
