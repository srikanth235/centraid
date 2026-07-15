import { describe, expect, test } from 'vitest';

import { OnlineOnlyError, OnlineOnlyGuard } from './errors.js';
import { ReplicaWorkerClient, type ReplicaWorkerLike } from './worker-client.js';
import type { ReplicaWorkerRequest, ReplicaWorkerResponse } from './worker-protocol.js';

class FakeWorker implements ReplicaWorkerLike {
  readonly requests: ReplicaWorkerRequest[] = [];
  terminated = false;
  readonly #messages = new Set<(event: MessageEvent<ReplicaWorkerResponse>) => void>();
  readonly #errors = new Set<(event: ErrorEvent) => void>();

  constructor(private readonly respond: (request: ReplicaWorkerRequest) => ReplicaWorkerResponse) {}

  postMessage(request: ReplicaWorkerRequest): void {
    this.requests.push(request);
    const response = this.respond(request);
    queueMicrotask(() => {
      const event = new MessageEvent<ReplicaWorkerResponse>('message', { data: response });
      for (const listener of this.#messages) listener(event);
    });
  }

  addEventListener(
    type: 'message' | 'error',
    listener:
      | ((event: MessageEvent<ReplicaWorkerResponse>) => void)
      | ((event: ErrorEvent) => void),
  ): void {
    if (type === 'message') {
      this.#messages.add(listener as (event: MessageEvent<ReplicaWorkerResponse>) => void);
    } else {
      this.#errors.add(listener as (event: ErrorEvent) => void);
    }
  }

  removeEventListener(
    type: 'message' | 'error',
    listener:
      | ((event: MessageEvent<ReplicaWorkerResponse>) => void)
      | ((event: ErrorEvent) => void),
  ): void {
    if (type === 'message') {
      this.#messages.delete(listener as (event: MessageEvent<ReplicaWorkerResponse>) => void);
    } else {
      this.#errors.delete(listener as (event: ErrorEvent) => void);
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}

function success(request: ReplicaWorkerRequest): ReplicaWorkerResponse {
  if (request.op === 'open') {
    return {
      id: request.id,
      ok: true,
      result: { mode: 'memory', cursor: null, schemaEpoch: null },
    };
  }
  if (request.op === 'read') {
    return {
      id: request.id,
      ok: true,
      result: {
        cursor: { epoch: 'epoch-1', seq: 7 },
        dependency: { shapeId: 'shape', entity: 'core.note' },
        rows: [
          {
            rowId: 'note-1',
            values: { note_id: 'note-1', title: 'Local' },
            oversizedFields: ['body'],
            hasUnavailableFields: false,
          },
        ],
      },
    };
  }
  if (request.op === 'search') {
    return {
      id: request.id,
      ok: true,
      result: {
        cursor: { epoch: 'epoch-1', seq: 7 },
        dependency: { shapeId: 'shape', entity: 'core.note' },
        rows: [
          {
            rowId: 'note-2',
            values: { note_id: 'note-2', title: 'Search result', _rank: -0.5 },
            oversizedFields: [],
            hasUnavailableFields: false,
          },
        ],
      },
    };
  }
  return { id: request.id, ok: true, result: undefined };
}

describe('ReplicaWorkerClient', () => {
  test('opens an injected worker and wraps unavailable fields with a sticky guard', async () => {
    const worker = new FakeWorker(success);
    const { client, status } = await ReplicaWorkerClient.connect(
      { dbName: '/centraid-replica-deadbeef.sqlite3', vaultId: 'vault', remember: false },
      () => worker,
    );
    expect(status.mode).toBe('memory');
    const guard = new OnlineOnlyGuard();
    const result = await client.read({ shapeId: 'shape', entity: 'core.note' }, [], guard);
    expect(result.receiptId).toBe('replica:epoch-1:7');
    expect(result.rows[0]!.title).toBe('Local');
    expect(() => result.rows[0]!.body).toThrow(OnlineOnlyError);
    expect(guard.required).toBe(true);
    await client.close();
    expect(worker.terminated).toBe(true);
  });

  test('marks the caller guard when the worker needs an unavailable filter field', async () => {
    const worker = new FakeWorker((request) => {
      if (request.op === 'open') return success(request);
      if (request.op === 'read') {
        return {
          id: request.id,
          ok: false,
          error: {
            name: 'OnlineOnlyError',
            message: 'online only',
            code: 'ONLINE_ONLY',
            reason: 'oversized field body is required by a filter',
          },
        };
      }
      return success(request);
    });
    const { client } = await ReplicaWorkerClient.connect(
      { dbName: '/centraid-replica-deadbeef.sqlite3', vaultId: 'vault', remember: false },
      () => worker,
    );
    const guard = new OnlineOnlyGuard();
    await expect(
      client.read(
        {
          shapeId: 'shape',
          entity: 'core.note',
          where: [{ column: 'body', op: 'eq', value: 'needle' }],
        },
        [],
        guard,
      ),
    ).rejects.toBeInstanceOf(OnlineOnlyError);
    expect(guard.required).toBe(true);
    await client.purge();
    expect(worker.requests.at(-1)?.op).toBe('purge');
  });

  test('exposes clone-safe row envelopes for the shell-to-iframe boundary', async () => {
    const worker = new FakeWorker(success);
    const { client } = await ReplicaWorkerClient.connect(
      { dbName: '/centraid-replica-deadbeef.sqlite3', vaultId: 'vault', remember: false },
      () => worker,
    );
    const result = await client.readWire({ shapeId: 'shape', entity: 'core.note' });
    expect(structuredClone(result).rows[0]).toEqual({
      rowId: 'note-1',
      values: { note_id: 'note-1', title: 'Local' },
      oversizedFields: ['body'],
      hasUnavailableFields: false,
    });
    await client.close();
  });

  test('sends clone-safe search requests and optimistic overlays to the worker', async () => {
    const worker = new FakeWorker(success);
    const { client } = await ReplicaWorkerClient.connect(
      { dbName: '/centraid-replica-deadbeef.sqlite3', vaultId: 'vault', remember: false },
      () => worker,
    );
    const result = await client.searchWire(
      { shapeId: 'shape', entity: 'core.note', query: 'search' },
      [
        {
          op: 'upsert',
          shapeId: 'shape',
          entity: 'core.note',
          rowId: 'note-2',
          values: { title: 'Search result' },
        },
      ],
    );

    expect(structuredClone(result).rows[0]?.values).toEqual({
      note_id: 'note-2',
      title: 'Search result',
      _rank: -0.5,
    });
    expect(worker.requests.at(-1)).toMatchObject({
      op: 'search',
      payload: {
        request: { shapeId: 'shape', entity: 'core.note', query: 'search' },
        mutations: [{ op: 'upsert', rowId: 'note-2' }],
      },
    });
    await client.close();
  });

  test('opens terminal cleanup in fail-closed persistent-only mode', async () => {
    const worker = new FakeWorker((request) => {
      if (request.op === 'open') {
        return {
          id: request.id,
          ok: true,
          result: { mode: 'opfs-sahpool', cursor: null, schemaEpoch: null },
        };
      }
      return success(request);
    });
    const client = await ReplicaWorkerClient.createForPurge(
      { gatewayId: 'gateway', vaultId: 'vault' },
      () => worker,
    );

    expect(worker.requests[0]).toMatchObject({
      op: 'open',
      payload: { remember: true, purgeOnly: true, vaultId: 'vault' },
    });
    await client.purge();
    expect(worker.requests.at(-1)?.op).toBe('purge');
  });
});
