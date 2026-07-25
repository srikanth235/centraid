import { AutomationTriggerStore, makeJournalDbProvider } from '@centraid/app-engine';
import { tempDirSync } from '@centraid/test-kit/temp-dir';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Manifest } from '../manifest/manifest.js';
import type { Row } from '../scaffold/app.js';
import {
  VaultCursorEngine,
  assertTriggerCursorAllowed,
  type TriggerCursorFireInput,
} from './cursor-engine.js';

function row(ref: string, triggers: Manifest['triggers']): Row {
  const [ownerApp, id] = ref.split('/') as [string, string];
  const manifest: Manifest = {
    name: id,
    version: '0.1.0',
    enabled: true,
    prompt: 'test',
    triggers,
    requires: {},
    history: { keep: 'all' },
    generated: { by: 'test', at: '2026-01-01T00:00:00.000Z' },
  };
  return {
    id,
    ownerApp,
    ref,
    name: id,
    dir: `/tmp/${id}`,
    enabled: true,
    triggers,
    manifest,
  };
}

function store(): AutomationTriggerStore {
  return new AutomationTriggerStore(
    makeJournalDbProvider(join(tempDirSync('centraid-cursor-engine-'), 'journal.db')),
  );
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('VaultCursorEngine', () => {
  it('collapses a cron restart gap to the latest instant and persists before fire', async () => {
    const cursors = store();
    cursors.putCursor({
      automationId: 'clock/minutely',
      triggerIndex: 0,
      sourceKind: 'cron',
      positionJson: JSON.stringify(Date.UTC(2026, 0, 1, 8, 0)),
      updatedAt: Date.UTC(2026, 0, 1, 8, 0),
    });
    const fired: TriggerCursorFireInput[] = [];
    const at = new Date(Date.UTC(2026, 0, 1, 8, 5));
    const engine = new VaultCursorEngine({
      store: cursors,
      now: () => at,
      fire: vi.fn(),
      fireCursor: (input) => {
        expect(cursors.getCursor(input.automationRef, input.triggerIndex)?.positionJson).toBe(
          JSON.stringify(at.getTime()),
        );
        fired.push(input);
      },
    });
    await engine.reconcile([row('clock/minutely', [{ kind: 'cron', expr: '* * * * *' }])]);

    engine.tick();
    await settle();

    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      sourceKind: 'cron',
      skipped: 4,
      gapReason: 'scheduler_gap',
      element: { occurredAt: at.getTime() },
    });
  });

  it('caps every source uniformly and records the skipped gap once', async () => {
    const cursors = store();
    const fired: TriggerCursorFireInput[] = [];
    const engine = new VaultCursorEngine({
      store: cursors,
      catchUpCap: 2,
      fire: vi.fn(),
      readCursor: async () => ({
        elements: [
          { position: '1', occurredAt: 1 },
          { position: '2', occurredAt: 2 },
        ],
        positionJson: '"watermark-5"',
        skipped: 3,
        gapReason: 'provider_catch_up_cap',
      }),
      fireCursor: (input) => void fired.push(input),
      now: () => new Date(Date.UTC(2026, 0, 1, 8, 0)),
    });
    await engine.reconcile([
      row('mail/watch', [{ kind: 'data', entities: ['core.party'], every: '* * * * *' }]),
    ]);

    expect(fired.map((entry) => entry.element.position)).toEqual(['1', '2']);
    expect(fired.every((entry) => entry.skipped === 3)).toBe(true);
    expect(cursors.getCursor('mail/watch', 0)).toMatchObject({
      positionJson: '"watermark-5"',
      skipped: 3,
      gapReason: 'provider_catch_up_cap',
    });
  });

  it('drains durable webhook ingress on restart bootstrap', async () => {
    const cursors = store();
    const fired: string[] = [];
    const trigger = {
      kind: 'webhook' as const,
      id: 'hook-id',
      secretHash: 'a'.repeat(64),
    };
    const engine = new VaultCursorEngine({
      store: cursors,
      fire: vi.fn(),
      readCursor: async ({ cursor }) => ({
        elements: cursor ? [] : [{ position: '9', occurredAt: 9, payload: { hello: true } }],
        positionJson: '9',
      }),
      fireCursor: (input) => void fired.push(input.element.position),
    });

    await engine.reconcile([row('hooks/receive', [trigger])]);

    expect(fired).toEqual(['9']);
    expect(cursors.getCursor('hooks/receive', 0)?.positionJson).toBe('9');
  });

  it('drains a webhook delivery that arrives after the initial cursor bootstrap', async () => {
    const cursors = store();
    const pending: Array<{ position: string; occurredAt: number }> = [];
    const fired: string[] = [];
    const trigger = {
      kind: 'webhook' as const,
      id: 'hook-id',
      secretHash: 'a'.repeat(64),
    };
    const engine = new VaultCursorEngine({
      store: cursors,
      nudgeDelayMs: 0,
      fire: vi.fn(),
      readCursor: async () => ({
        elements: pending.splice(0),
        positionJson: pending.length ? pending.at(-1)?.position : '0',
      }),
      fireCursor: (input) => void fired.push(input.element.position),
    });
    await engine.reconcile([row('hooks/receive', [trigger])]);
    pending.push({ position: '10', occurredAt: 10 });

    engine.nudgeIngress('hook-id');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));

    expect(fired).toEqual(['10']);
  });

  it('keeps an event trigger registered when its provider is unavailable at bootstrap', async () => {
    const onError = vi.fn();
    const engine = new VaultCursorEngine({
      fire: vi.fn(),
      readCursor: async () => {
        throw new Error('account needs auth');
      },
      onError,
    });

    await expect(
      engine.reconcile([
        row('mail/watch', [
          {
            kind: 'event',
            connectorKind: 'pull.gmail',
            event: 'new-message',
          },
        ]),
      ]),
    ).resolves.toMatchObject({ added: ['mail/watch'] });

    expect(await engine.list()).toEqual(['mail/watch']);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'mail/watch');
  });

  it('rejects loop-sensitive runtime entities at registration', async () => {
    const denied = {
      kind: 'condition' as const,
      entity: 'trigger_ingress',
    };
    expect(() => assertTriggerCursorAllowed(denied)).toThrow(/loop-sensitive runtime table/);
    const engine = new VaultCursorEngine({ fire: vi.fn() });
    await expect(engine.reconcile([row('bad/loop', [denied])])).rejects.toThrow(
      /loop-sensitive runtime table/,
    );
  });
});
