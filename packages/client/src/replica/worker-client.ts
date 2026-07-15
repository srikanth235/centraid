import {
  OnlineOnlyError,
  OnlineOnlyGuard,
  ReplicaClosedError,
  ReplicaProtocolError,
  ReplicaRebootstrapRequiredError,
  type RebootstrapReason,
} from './errors.js';
import { replicaDatabaseName } from './key.js';
import { guardReplicaRow } from './query.js';
import type {
  ReplicaWorkerRequest,
  ReplicaWorkerResponse,
  ReplicaWorkerResults,
  SerializedReplicaError,
} from './worker-protocol.js';
import type {
  ApplyChangesResult,
  OptimisticMutation,
  ReplicaChangeBatch,
  ReplicaCursor,
  ReplicaIdentity,
  ReplicaReadRequest,
  ReplicaReadResult,
  ReplicaReadWireResult,
  ReplicaSearchRequest,
  ReplicaSearchWireResult,
  ReplicaSnapshot,
  ReplicaShape,
  ReplicaStatus,
  ReplicaWorkerOpenOptions,
} from './types.js';

export interface ReplicaWorkerLike {
  postMessage(message: ReplicaWorkerRequest): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<ReplicaWorkerResponse>) => void,
  ): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent<ReplicaWorkerResponse>) => void,
  ): void;
  removeEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  terminate(): void;
}

export type ReplicaWorkerFactory = () => ReplicaWorkerLike;

interface PendingRpc {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

export class ReplicaWorkerClient {
  readonly #worker: ReplicaWorkerLike;
  readonly #pending = new Map<number, PendingRpc>();
  #nextId = 1;
  #closed = false;

  private constructor(worker: ReplicaWorkerLike) {
    this.#worker = worker;
    worker.addEventListener('message', this.onMessage);
    worker.addEventListener('error', this.onError);
  }

  static async create(
    identity: ReplicaIdentity,
    remember: boolean,
    factory: ReplicaWorkerFactory = defaultWorkerFactory,
  ): Promise<{ client: ReplicaWorkerClient; status: ReplicaStatus }> {
    const options: ReplicaWorkerOpenOptions = {
      dbName: await replicaDatabaseName(identity),
      vaultId: identity.vaultId,
      remember,
    };
    return this.connect(options, factory);
  }

  /** Open the named durable scope fail-closed, solely to remove it. */
  static async createForPurge(
    identity: ReplicaIdentity,
    factory: ReplicaWorkerFactory = defaultWorkerFactory,
  ): Promise<ReplicaWorkerClient> {
    const { client } = await this.connect(
      {
        dbName: await replicaDatabaseName(identity),
        vaultId: identity.vaultId,
        remember: true,
        purgeOnly: true,
      },
      factory,
    );
    return client;
  }

  static async connect(
    options: ReplicaWorkerOpenOptions,
    factory: ReplicaWorkerFactory,
  ): Promise<{ client: ReplicaWorkerClient; status: ReplicaStatus }> {
    const client = new ReplicaWorkerClient(factory());
    try {
      const status = await client.rpc('open', options);
      return { client, status };
    } catch (error) {
      client.dispose(error);
      throw error;
    }
  }

  status(): Promise<ReplicaStatus> {
    return this.rpc('status', undefined);
  }

  catalog(): Promise<ReplicaShape[]> {
    return this.rpc('catalog', undefined);
  }

  bootstrap(snapshot: ReplicaSnapshot): Promise<ReplicaCursor> {
    return this.rpc('bootstrap', snapshot);
  }

  applyChanges(batch: ReplicaChangeBatch): Promise<ApplyChangesResult> {
    return this.rpc('apply-changes', batch);
  }

  async read(
    request: ReplicaReadRequest,
    mutations: OptimisticMutation[] = [],
    guard: OnlineOnlyGuard = new OnlineOnlyGuard(),
  ): Promise<ReplicaReadResult> {
    try {
      const result = await this.readWire(request, mutations);
      return {
        rows: result.rows.map((row) => guardReplicaRow(row, guard)),
        receiptId: `replica:${result.cursor.epoch}:${result.cursor.seq}`,
        dependency: result.dependency,
      };
    } catch (error) {
      if (error instanceof OnlineOnlyError) guard.mark(error);
      throw error;
    }
  }

  /** Structured-cloneable rows for shell → iframe RPC; guard them in the iframe. */
  readWire(
    request: ReplicaReadRequest,
    mutations: OptimisticMutation[] = [],
  ): Promise<ReplicaReadWireResult> {
    return this.rpc('read', { request, mutations });
  }

  /** Structured-cloneable local search rows for shell → iframe RPC. */
  searchWire(
    request: ReplicaSearchRequest,
    mutations: OptimisticMutation[] = [],
  ): Promise<ReplicaSearchWireResult> {
    return this.rpc('search', { request, mutations });
  }

  wipe(): Promise<undefined> {
    return this.rpc('wipe', undefined);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.rpc('close', undefined).finally(() => this.dispose(new ReplicaClosedError()));
  }

  async purge(): Promise<void> {
    if (this.#closed) return;
    await this.rpc('purge', undefined).finally(() => this.dispose(new ReplicaClosedError()));
  }

  private rpc<Op extends keyof ReplicaWorkerResults>(
    op: Op,
    payload: Extract<ReplicaWorkerRequest, { op: Op }>['payload'],
  ): Promise<ReplicaWorkerResults[Op]> {
    if (this.#closed) return Promise.reject(new ReplicaClosedError());
    const id = this.#nextId++;
    return new Promise<ReplicaWorkerResults[Op]>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      // eslint-disable-next-line unicorn/require-post-message-target-origin -- (#406) Worker.postMessage has no targetOrigin overload; governance: allow-no-unjustified-suppressions Web Worker API false positive
      this.#worker.postMessage({ id, op, payload } as ReplicaWorkerRequest);
    });
  }

  private readonly onMessage = (event: MessageEvent<ReplicaWorkerResponse>): void => {
    const pending = this.#pending.get(event.data.id);
    if (!pending) return;
    this.#pending.delete(event.data.id);
    if (event.data.ok) pending.resolve(event.data.result);
    else pending.reject(deserializeError(event.data.error));
  };

  private readonly onError = (event: ErrorEvent): void => {
    this.dispose(event.error ?? new Error(event.message));
  };

  private dispose(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#worker.removeEventListener('message', this.onMessage);
    this.#worker.removeEventListener('error', this.onError);
    this.#worker.terminate();
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function defaultWorkerFactory(): ReplicaWorkerLike {
  return new Worker(new URL('sqlite-worker.js', import.meta.url), {
    type: 'module',
    name: 'centraid-replica',
  });
}

function deserializeError(error: SerializedReplicaError): Error {
  if (error.code === 'ONLINE_ONLY') return new OnlineOnlyError(error.reason ?? error.message);
  if (error.code === 'REPLICA_REBOOTSTRAP_REQUIRED') {
    return new ReplicaRebootstrapRequiredError(
      (error.reason as RebootstrapReason | undefined) ?? 'not-bootstrapped',
    );
  }
  if (error.code === 'REPLICA_PROTOCOL_ERROR') return new ReplicaProtocolError(error.message);
  const result = new Error(error.message);
  result.name = error.name;
  return result;
}
