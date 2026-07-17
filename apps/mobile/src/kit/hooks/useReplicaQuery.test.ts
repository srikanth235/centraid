import { describe, expect, test, vi } from 'vitest';
import type { ReplicaReadWireResult } from '@centraid/client/replica/native';
import { mapReplicaRows } from './useReplicaQuery';

// The hook drags in the ReplicaProvider's native module chain (op-sqlite,
// expo-network); stub it so the pure mapper can be exercised under node.
vi.mock('../replica/ReplicaProvider', () => ({
  useReplica: () => ({ ready: false, online: false }),
}));

const wire = (
  rows: Array<{ rowId: string; values: Record<string, unknown> }>,
): ReplicaReadWireResult => ({ rows }) as unknown as ReplicaReadWireResult;

describe('mapReplicaRows', () => {
  test('projects values with the row id and preserves order', () => {
    const mapped = mapReplicaRows(
      wire([
        { rowId: 'r1', values: { title: 'A' } },
        { rowId: 'r2', values: { title: 'B' } },
      ]),
    );
    expect(mapped).toEqual([
      { title: 'A', __rowId: 'r1' },
      { title: 'B', __rowId: 'r2' },
    ]);
  });

  test('empty and undefined results both yield an empty array', () => {
    expect(mapReplicaRows(undefined)).toEqual([]);
    expect(mapReplicaRows(wire([]))).toEqual([]);
  });

  test('is a pure transform of the underlying result — the memo identity anchor', () => {
    // The hook holds `useMemo(() => mapReplicaRows(result), [result])`; the
    // stability guarantee only holds if the same result maps to equal rows and
    // the mapper never mutates its input (a fresh array every render was the bug).
    const result = wire([{ rowId: 'r1', values: { n: 1 } }]);
    const first = mapReplicaRows(result);
    const second = mapReplicaRows(result);
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(result.rows).toHaveLength(1);
  });
});
