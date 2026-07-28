import type { InlineAppModule } from '@centraid/blueprints/apps/inline-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReplicaInvalidation } from '../../replica/types.js';
import { installInlineCentraid, type InstallInlineCentraidOptions } from './centraid-inline.js';

const { doFetch, readJson } = vi.hoisted(() => ({
  doFetch: vi.fn<typeof import('../../gateway-client-core.js').doFetch>(),
  readJson: vi.fn<(response: Response, operation: string) => Promise<unknown>>(),
}));
// vitest hoists vi.mock above imports at run time, so declaration order here is
// only for the linter's import-first rule.
vi.mock(import('../../gateway-client-core.js') as Promise<unknown>, () => ({
  auth: vi.fn<typeof import('../../gateway-client-core.js').auth>(async () => ({
    baseUrl: 'https://gw.test',
    token: 'tok',
  })),
  authHeaders: (token: string | undefined, ct?: string) => ({
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(ct ? { 'Content-Type': ct } : {}),
  }),
  doFetch,
  readJson,
}));

type Session = NonNullable<InstallInlineCentraidOptions['session']>;

function fakeSession(overrides?: Partial<Session>): Session & {
  writes: unknown[];
  subscribers: Array<(inv: readonly ReplicaInvalidation[]) => void>;
} {
  const writes: unknown[] = [];
  const subscribers: Array<(inv: readonly ReplicaInvalidation[]) => void> = [];
  return {
    writes,
    subscribers,
    read: vi.fn<Session['read']>(async () => ({
      rows: [],
      cursor: { epoch: 'e', seq: 1 },
      dependency: { shapeId: 's', entity: 'x' },
    })),
    search: vi.fn<Session['search']>(async () => ({
      rows: [],
      cursor: { epoch: 'e', seq: 1 },
      dependency: { shapeId: 's', entity: 'x' },
    })),
    write: vi.fn<Session['write']>(async (_appId, input) => {
      writes.push(input);
      return {
        intentId: (input as { intentId?: string }).intentId ?? 'gen-1',
        status: 'executed',
        output: { task_id: 't1' },
      };
    }),
    subscribe: vi.fn<Session['subscribe']>((_appId, _deps, listener) => {
      subscribers.push(listener);
      return () => {
        const i = subscribers.indexOf(listener);
        if (i >= 0) subscribers.splice(i, 1);
      };
    }),
    ...overrides,
  } as Session & {
    writes: unknown[];
    subscribers: Array<(inv: readonly ReplicaInvalidation[]) => void>;
  };
}

function client(target: { centraid?: unknown }): {
  read: <T>(o: { query: string; input?: Record<string, unknown> }) => Promise<T>;
  write: <T>(o: {
    action: string;
    input?: Record<string, unknown>;
    intentId?: string;
  }) => Promise<T>;
  onChange: (cb: (d: { tables?: string[] }) => void) => () => void;
} {
  return target.centraid as never;
}

const noQueries: InlineAppModule['queries'] = {};

describe(installInlineCentraid, () => {
  beforeEach(() => {
    doFetch.mockReset();
    readJson.mockReset();
  });

  it('forwards a caller intentId verbatim into session.write', async () => {
    const session = fakeSession();
    const target: { centraid?: unknown } = {};
    installInlineCentraid({
      appId: 'tasks',
      session,
      queries: noQueries,
      target,
    });
    const outcome = await client(target).write<{
      status: string;
      invocationId: string;
    }>({
      action: 'set-status',
      input: { task_id: 't1' },
      intentId: 'intent-xyz',
    });
    expect(session.writes).toStrictEqual([
      {
        action: 'set-status',
        input: { task_id: 't1' },
        intentId: 'intent-xyz',
      },
    ]);
    expect(outcome.status).toBe('executed');
    expect(outcome.invocationId).toBe('intent-xyz');
  });

  it('runs the local query module for a read', async () => {
    const session = fakeSession();
    const queries: InlineAppModule['queries'] = {
      board: {
        default: async ({ input }) => ({
          open: [{ task_id: 'a' }],
          limit: input?.limit,
        }),
      },
    };
    const target: { centraid?: unknown } = {};
    installInlineCentraid({
      appId: 'tasks',
      session,
      queries,
      target,
      isOnline: () => true,
    });
    const res = await client(target).read<{ open: unknown[]; limit: unknown }>({
      query: 'board',
      input: { limit: 5 },
    });
    expect(res.open).toHaveLength(1);
    expect(res.limit).toBe(5);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('falls back to the gateway query route only on ONLINE_ONLY', async () => {
    doFetch.mockResolvedValue(new Response('{}'));
    readJson.mockResolvedValue({ open: ['from-gateway'] });
    const session = fakeSession();
    const onlineOnly = Object.assign(new Error('needs online'), {
      code: 'ONLINE_ONLY',
    });
    const queries: InlineAppModule['queries'] = {
      board: {
        default: () => {
          throw onlineOnly;
        },
      },
    };
    const target: { centraid?: unknown } = {};
    installInlineCentraid({
      appId: 'tasks',
      session,
      queries,
      target,
      isOnline: () => true,
    });
    const res = await client(target).read<{ open: unknown[] }>({
      query: 'board',
    });
    expect(res.open).toStrictEqual(['from-gateway']);
    expect(doFetch).toHaveBeenCalledWith(
      'https://gw.test',
      '/centraid/tasks/queries/board',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('does NOT fall back for a non-fallback error', async () => {
    const session = fakeSession();
    const queries: InlineAppModule['queries'] = {
      board: {
        default: () => {
          throw new Error('plain boom');
        },
      },
    };
    const target: { centraid?: unknown } = {};
    installInlineCentraid({ appId: 'tasks', session, queries, target });
    await expect(client(target).read({ query: 'board' })).rejects.toThrow('plain boom');
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('maps replica invalidations to the kit change-feed shape via onChange', () => {
    const session = fakeSession();
    const target: { centraid?: unknown } = {};
    installInlineCentraid({
      appId: 'tasks',
      session,
      queries: noQueries,
      target,
    });
    const seen: Array<{ tables?: string[] }> = [];
    client(target).onChange((detail) => seen.push(detail));
    session.subscribers[0]?.([
      {
        shapeId: 's',
        entity: 'schedule.task',
        source: 'canonical',
      } as ReplicaInvalidation,
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.tables).toStrictEqual(['schedule.task']);
  });

  it('restores the previous window.centraid on teardown', () => {
    const session = fakeSession();
    const target: { centraid?: unknown } = { centraid: 'prior' };
    const teardown = installInlineCentraid({
      appId: 'tasks',
      session,
      queries: noQueries,
      target,
    });
    expect(target.centraid).not.toBe('prior');
    teardown();
    expect(target.centraid).toBe('prior');
  });
});
