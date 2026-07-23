import { describe, expect, it } from 'vitest';
import boardQuery from '@centraid/blueprints/apps/tasks/queries/board';
import type {
  ReplicaReadWireResult,
  ReplicaRowEnvelope,
  ReplicaSearchWireResult,
} from '../../replica/types.js';
import type { ShellReplicaReadRequest } from '../../replica/shell-session.js';
import {
  buildInlineCtx,
  createOnlineGuard,
  runInlineQuery,
  type InlineReplicaSession,
} from './inlineQueryCtx.js';

const cursor = { epoch: 'e1', seq: 7 };
const dependency = { shapeId: 'tasks/board', entity: 'schedule.task' };

function envelope(
  values: Record<string, unknown>,
  extra?: Partial<ReplicaRowEnvelope>,
): ReplicaRowEnvelope {
  return {
    rowId: String(values.task_id ?? Math.random()),
    values: values as ReplicaRowEnvelope['values'],
    oversizedFields: [],
    hasUnavailableFields: false,
    ...extra,
  };
}

const OPEN_TASKS = [
  { task_id: 'b', status: 'needs-action', title: 'Second', due_at: null, priority: 0 },
  { task_id: 'a', status: 'needs-action', title: 'First', due_at: '2026-07-22', priority: 1 },
];

/** A replica-session double: seeded open tasks; everything else empty. */
function seededSession(overrides?: Partial<InlineReplicaSession>): InlineReplicaSession {
  return {
    async read(_appId: string, request: ShellReplicaReadRequest): Promise<ReplicaReadWireResult> {
      const statusClause = (request.where ?? []).find((clause) => clause.column === 'status');
      const statusValue = statusClause?.value;
      const wantsOpen =
        request.entity === 'schedule.task' &&
        Array.isArray(statusValue) &&
        (statusValue as string[]).includes('needs-action');
      return {
        rows: wantsOpen ? OPEN_TASKS.map((task) => envelope(task)) : [],
        cursor,
        dependency,
      };
    },
    async search(): Promise<ReplicaSearchWireResult> {
      return { rows: [], cursor, dependency };
    },
    ...overrides,
  };
}

describe('inlineQueryCtx', () => {
  it('runs the real board query against the local replica and projects tasks', async () => {
    const result = (await runInlineQuery(
      { default: boardQuery },
      { session: seededSession(), appId: 'tasks', input: { limit: 500 }, isOnline: () => false },
    )) as { open: Array<{ task_id: string; title: string }>; vaultDenied?: unknown };

    expect(result.vaultDenied).toBeUndefined();
    expect(result.open).toHaveLength(2);
    // due-first sort: the dated task leads the undated one.
    expect(result.open.map((t) => t.title)).toEqual(['First', 'Second']);
  });

  it('resolves mentions to {cards:[]} offline and never rejects', async () => {
    const guard = createOnlineGuard();
    const ctx = buildInlineCtx(
      { session: seededSession(), appId: 'tasks', isOnline: () => false },
      guard,
    ) as { vault: { resolve(): Promise<{ cards: unknown[] }> } };
    await expect(ctx.vault.resolve()).resolves.toEqual({ cards: [] });
    expect(guard.error).toBeNull();
  });

  it('marks the online-only guard when a query reads an undisclosed field', async () => {
    const undisclosed = seededSession({
      async read(): Promise<ReplicaReadWireResult> {
        return {
          rows: [
            envelope({ task_id: 'x', status: 'needs-action' }, { hasUnavailableFields: true }),
          ],
          cursor,
          dependency,
        };
      },
    });
    // board reads `.title`/`.due_at` which are undisclosed here → guard fires →
    // runInlineQuery rejects with the fallback code.
    await expect(
      runInlineQuery({ default: boardQuery }, { session: undisclosed, appId: 'tasks', input: {} }),
    ).rejects.toMatchObject({ code: 'ONLINE_ONLY' });
  });
});
