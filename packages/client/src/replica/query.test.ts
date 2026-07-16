import { describe, expect, test } from 'vitest';

import { OnlineOnlyError, OnlineOnlyGuard } from './errors.js';
import { evaluateReplicaRead, guardReplicaRow } from './query.js';
import {
  REPLICA_SYNTHETIC_PRIMARY_KEY,
  type ReplicaEntitySchema,
  type ReplicaRowEnvelope,
} from './types.js';

const schema: ReplicaEntitySchema = {
  entity: 'core.task',
  primaryKey: 'task_id',
  columns: ['task_id', 'title', 'rank', 'body'],
  hasUnavailableFields: true,
};

function rows(): ReplicaRowEnvelope[] {
  return [
    {
      rowId: 'a',
      values: { task_id: 'a', title: 'A', rank: 1 },
      oversizedFields: ['body'],
      hasUnavailableFields: true,
    },
    {
      rowId: 'b',
      values: { task_id: 'b', title: 'B', rank: 2, body: 'small' },
      oversizedFields: [],
      hasUnavailableFields: true,
    },
  ];
}

describe('replica query evaluation', () => {
  test('replays optimistic effects over new canonical rows before filtering', () => {
    const first = evaluateReplicaRead(
      rows(),
      schema,
      {
        shapeId: 'shape',
        entity: 'core.task',
        where: [{ column: 'rank', op: 'gte', value: 2 }],
        orderBy: { column: 'rank', dir: 'desc' },
      },
      [
        {
          op: 'upsert',
          shapeId: 'shape',
          entity: 'core.task',
          rowId: 'a',
          values: { rank: 3, body: 'predicted' },
        },
      ],
    );
    expect(first.map((row) => row.rowId)).toEqual(['a', 'b']);
    expect(first[0]!.oversizedFields).toEqual([]);

    const rebased = rows();
    rebased[0]!.values.title = 'Canonical changed';
    expect(
      evaluateReplicaRead(rebased, schema, { shapeId: 'shape', entity: 'core.task' }, [
        {
          op: 'upsert',
          shapeId: 'shape',
          entity: 'core.task',
          rowId: 'a',
          values: { rank: 3 },
        },
      ])[0]!.values,
    ).toMatchObject({ title: 'Canonical changed', rank: 3 });
  });

  test('accepts numeric primary keys and skips a legacy malformed optimistic record', () => {
    const numericSchema: ReplicaEntitySchema = {
      entity: 'core.task',
      primaryKey: 'task_id',
      columns: ['task_id', 'title'],
    };
    const canonical: ReplicaRowEnvelope[] = [
      {
        rowId: '1',
        values: { task_id: 1, title: 'Canonical' },
        oversizedFields: [],
        hasUnavailableFields: false,
      },
    ];
    const result = evaluateReplicaRead(
      canonical,
      numericSchema,
      { shapeId: 'shape', entity: 'core.task' },
      [
        {
          op: 'upsert',
          shapeId: 'shape',
          entity: 'core.task',
          rowId: '1',
          values: { task_id: 1, title: 'Optimistic' },
        },
        {
          op: 'upsert',
          shapeId: 'shape',
          entity: 'core.task',
          rowId: '1',
          values: { poisoned_column: 'ignored' },
        },
      ],
    );
    expect(result[0]?.values).toEqual({ task_id: 1, title: 'Optimistic' });
  });

  test('reruns an unknown column online instead of compiling caller text locally', () => {
    expect(() =>
      evaluateReplicaRead(rows(), schema, {
        shapeId: 'shape',
        entity: 'core.task',
        where: [{ column: 'title) OR 1=1 --', op: 'eq', value: 'x' }],
      }),
    ).toThrow(OnlineOnlyError);
  });

  test('reruns mixed TEXT/NUMERIC predicates online instead of guessing SQLite affinity', () => {
    expect(() =>
      evaluateReplicaRead(rows(), schema, {
        shapeId: 'shape',
        entity: 'core.task',
        where: [{ column: 'title', op: 'ne', value: 1 }],
      }),
    ).toThrow(OnlineOnlyError);
  });

  test('uses canonical UTF-8 BINARY text comparison and ordering', () => {
    const unicode = rows();
    unicode[0]!.values.title = '\u{10000}';
    unicode[1]!.values.title = '\uE000';
    expect(
      evaluateReplicaRead(unicode, schema, {
        shapeId: 'shape',
        entity: 'core.task',
        orderBy: { column: 'title' },
      }).map((row) => row.rowId),
    ).toEqual(['b', 'a']);

    unicode[0]!.values.title = 'Alpha';
    unicode[1]!.values.title = 'alpha';
    expect(
      evaluateReplicaRead(unicode, schema, {
        shapeId: 'shape',
        entity: 'core.task',
        where: [{ column: 'title', op: 'eq', value: 'alpha' }],
      }).map((row) => row.rowId),
    ).toEqual(['b']);
  });

  test('breaks ORDER BY ties by exposed scalar primary key before applying LIMIT', () => {
    const tied = rows();
    tied.reverse();
    tied[0]!.values.rank = 1;
    tied[1]!.values.rank = 1;
    expect(
      evaluateReplicaRead(tied, schema, {
        shapeId: 'shape',
        entity: 'core.task',
        orderBy: { column: 'rank', dir: 'desc' },
        limit: 1,
      }).map((row) => row.rowId),
    ).toEqual(['a']);
  });

  test('reruns tied ordering online when the real primary key stays opaque', () => {
    const opaqueSchema: ReplicaEntitySchema = {
      ...schema,
      primaryKey: REPLICA_SYNTHETIC_PRIMARY_KEY,
      columns: [...schema.columns, REPLICA_SYNTHETIC_PRIMARY_KEY],
    };
    const tied = rows().map((row) => ({
      ...row,
      values: {
        ...row.values,
        rank: 1,
        [REPLICA_SYNTHETIC_PRIMARY_KEY]: `opaque-${row.rowId}`,
      },
    }));
    expect(() =>
      evaluateReplicaRead(tied, opaqueSchema, {
        shapeId: 'shape',
        entity: 'core.task',
        orderBy: { column: 'rank' },
        limit: 1,
      }),
    ).toThrow(OnlineOnlyError);
  });

  test('keeps online-only state sticky when handler code catches field access', () => {
    const guard = new OnlineOnlyGuard();
    const guarded = guardReplicaRow(rows()[0]!, guard);
    expect(guarded.title).toBe('A');
    try {
      void guarded.body;
    } catch (error) {
      expect(error).toBeInstanceOf(OnlineOnlyError);
    }
    expect(guard.required).toBe(true);
    expect(() => guard.assertLocal()).toThrow(OnlineOnlyError);
  });

  test('spreading a row with unavailable fields forces transparent online rerun', () => {
    const guard = new OnlineOnlyGuard();
    const guarded = guardReplicaRow(rows()[0]!, guard);
    expect(() => ({ ...guarded })).toThrow(OnlineOnlyError);
    expect(guard.required).toBe(true);
  });
});
