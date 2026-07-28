/*
 * The engine's pure support surface: how a write-ahead receipt is re-read
 * after a crash, and how one automation's triggers become cursor
 * registrations.
 */

import { describe, expect, it } from 'vitest';

import type { Manifest } from '../manifest/manifest.js';
import type { Row } from '../scaffold/app.js';
import {
  cursorIdentity,
  readPendingBatch,
  registrationsFor,
  retentionKeysFor,
  scheduleExpr,
} from './cursor-engine-support.js';

function row(ref: string, triggers: Manifest['triggers']): Row {
  const [ownerApp, id] = ref.split('/') as [string, string];
  return {
    id,
    ownerApp,
    ref,
    name: id,
    dir: `/tmp/${id}`,
    enabled: true,
    triggers,
    manifest: {
      name: id,
      version: '0.1.0',
      enabled: true,
      prompt: 'test',
      triggers,
      requires: {},
      history: { keep: 'all' },
      generated: { by: 'test', at: '2026-01-01T00:00:00.000Z' },
    },
  };
}

describe(readPendingBatch, () => {
  it('round-trips a receipt including per-element watermarks', () => {
    const pending = {
      targetPositionJson: '"p3"',
      elements: [
        {
          position: 'p2',
          occurredAt: 2,
          payload: { a: 1 },
          positionJson: '"p2"',
        },
        { position: 'p3', occurredAt: 3 },
      ],
      acknowledged: ['p2'],
      skipped: 1,
      windowFrom: 1,
      windowTo: 9,
      gapReason: 'scheduler_gap',
    };

    expect(readPendingBatch(JSON.stringify(pending))).toStrictEqual(pending);
  });

  it.each([
    ['no receipt', undefined],
    ['empty string', ''],
    ['unparseable json', '{oops'],
    ['a json scalar', '7'],
    ['a json array', '[1,2]'],
    ['null', 'null'],
    ['a missing elements array', '{"acknowledged":[]}'],
    ['a missing acknowledged array', '{"elements":[]}'],
    ['an element that is not an object', '{"elements":[3],"acknowledged":[]}'],
    ['an element without a position', '{"elements":[{"occurredAt":1}],"acknowledged":[]}'],
    [
      'an element whose occurredAt is not finite',
      '{"elements":[{"position":"a","occurredAt":null}],"acknowledged":[]}',
    ],
  ])('reads %s as no pending batch at all', (_label, raw) => {
    // A half-written receipt must not be mistaken for a partially delivered
    // batch — the engine re-reads the source instead.
    expect(readPendingBatch(raw)).toBeUndefined();
  });

  it('normalizes a receipt whose scalar metadata is junk', () => {
    const parsed = readPendingBatch(
      JSON.stringify({
        targetPositionJson: 5,
        elements: [{ position: 'a', occurredAt: 1 }],
        acknowledged: ['a', 7],
        skipped: -3,
        windowFrom: 'nope',
        gapReason: 4,
      }),
    );

    expect(parsed).toStrictEqual({
      elements: [{ position: 'a', occurredAt: 1 }],
      acknowledged: ['a'],
      skipped: 0,
    });
  });
});

describe(registrationsFor, () => {
  it('collapses every cron trigger into one registration at the first cron index', () => {
    const registrations = registrationsFor(
      row('a/multi', [
        { kind: 'data', entities: ['core.party'] },
        { kind: 'cron', expr: '0 8 * * *' },
        { kind: 'cron', expr: '*/30 * * * *' },
      ]),
    );

    expect(registrations).toStrictEqual([
      {
        ref: 'a/multi',
        triggerIndex: 0,
        trigger: { kind: 'data', entities: ['core.party'] },
      },
      {
        ref: 'a/multi',
        triggerIndex: 1,
        trigger: { kind: 'cron', expr: '0 8 * * *' },
        cronExprs: ['0 8 * * *', '*/30 * * * *'],
        cronSchedules: [{ expr: '0 8 * * *' }, { expr: '*/30 * * * *' }],
      },
    ]);
  });

  it('rejects a loop-sensitive entity before anything registers', () => {
    expect(() =>
      registrationsFor(row('bad/loop', [{ kind: 'condition', entity: 'turns' }])),
    ).toThrow(/loop-sensitive runtime table/u);
  });
});

describe(retentionKeysFor, () => {
  it('names every declared trigger slot, disabled rows included', () => {
    const disabled = {
      ...row('b/off', [{ kind: 'cron', expr: '0 8 * * *' }]),
      enabled: false,
    };

    expect(
      retentionKeysFor([
        row('a/two', [
          { kind: 'cron', expr: '0 8 * * *' },
          { kind: 'data', entities: ['core.party'] },
        ]),
        disabled,
        row('c/none', []),
      ]),
    ).toStrictEqual([
      { automationId: 'a/two', triggerIndex: 0 },
      { automationId: 'a/two', triggerIndex: 1 },
      { automationId: 'b/off', triggerIndex: 0 },
    ]);
  });
});

describe('scheduleExpr and cursorIdentity', () => {
  it('gates each kind on its declared cadence and keys events by account shape', () => {
    expect(scheduleExpr({ kind: 'cron', expr: '0 8 * * *' })).toBe('0 8 * * *');
    expect(scheduleExpr({ kind: 'condition', entity: 'business.invoice' })).toBe('*/5 * * * *');
    expect(scheduleExpr({ kind: 'data', entities: ['core.party'] })).toBe('* * * * *');
    expect(
      scheduleExpr({
        kind: 'event',
        connectorKind: 'pull.gmail',
        event: 'new-message',
      }),
    ).toBe('*/5 * * * *');
    // A webhook has no cadence — it is doorbell-driven only.
    expect(scheduleExpr({ kind: 'webhook', id: 'h', secretHash: 'a'.repeat(64) })).toBeUndefined();

    expect(cursorIdentity({ kind: 'data', entities: ['core.party'] })).toBe('data');
    expect(
      cursorIdentity({
        kind: 'event',
        connectorKind: 'pull.gmail',
        event: 'new-message',
        filter: { label: 'inbox' },
      }),
    ).toBe('event:pull.gmail:new-message:{"label":"inbox"}');
  });
});
