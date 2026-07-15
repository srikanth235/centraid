import { describe, expect, test, vi } from 'vitest';

import {
  forgetReplicaIdentity,
  listRememberedReplicaIdentities,
  prepareRememberedReplicaIdentity,
  purgeReplicaIdentityStorage,
  purgeRememberedReplicaIdentities,
  rememberReplicaIdentity,
  retryTerminalReplicaPurges,
  type ReplicaIdentityInventory,
  type ReplicaIdentityInventoryEntry,
} from './storage-manifest.js';
import { TerminalReplicaPurgeRetryLoop } from './terminal-purge-retry.js';
import type { ReplicaIdentity } from './types.js';
import type { ReplicaWorkerRequest, ReplicaWorkerResponse } from './worker-protocol.js';
import type { ReplicaWorkerLike } from './worker-client.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value);
    },
    removeItem: (key: string): void => {
      values.delete(key);
    },
  };
}

type MemoryStorage = ReturnType<typeof memoryStorage>;

function memoryInventory(): ReplicaIdentityInventory & {
  values: Map<string, ReplicaIdentityInventoryEntry>;
} {
  const values = new Map<string, ReplicaIdentityInventoryEntry>();
  return {
    values,
    async activate(identity) {
      const key = `${identity.gatewayId}\u0000${identity.vaultId}`;
      if (values.get(key)?.state === 'terminal-pending') return false;
      values.set(key, {
        ...structuredClone(identity),
        state: 'remembered',
        purgeAttempts: 0,
        retryAt: 0,
      });
      return true;
    },
    async markTerminal(identity) {
      const key = `${identity.gatewayId}\u0000${identity.vaultId}`;
      const existing = values.get(key);
      values.set(key, {
        ...structuredClone(identity),
        state: 'terminal-pending',
        purgeAttempts: existing?.state === 'terminal-pending' ? existing.purgeAttempts : 0,
        retryAt: existing?.state === 'terminal-pending' ? existing.retryAt : 0,
      });
    },
    async deferTerminal(identity, failedAt, baseDelayMs, maxDelayMs) {
      const key = `${identity.gatewayId}\u0000${identity.vaultId}`;
      const attempts = (values.get(key)?.purgeAttempts ?? 0) + 1;
      values.set(key, {
        ...structuredClone(identity),
        state: 'terminal-pending',
        purgeAttempts: attempts,
        retryAt: failedAt + Math.min(baseDelayMs * 2 ** Math.min(attempts - 1, 10), maxDelayMs),
      });
    },
    async remove(identity) {
      values.delete(`${identity.gatewayId}\u0000${identity.vaultId}`);
    },
    async list() {
      return [...values.values()].map((identity) => structuredClone(identity));
    },
  };
}

class SuccessfulPurgeWorker implements ReplicaWorkerLike {
  readonly #messages = new Set<(event: MessageEvent<ReplicaWorkerResponse>) => void>();
  readonly #errors = new Set<(event: ErrorEvent) => void>();

  postMessage(request: ReplicaWorkerRequest): void {
    const response: ReplicaWorkerResponse =
      request.op === 'open'
        ? {
            id: request.id,
            ok: true,
            result: { mode: 'opfs-sahpool', cursor: null, schemaEpoch: null },
          }
        : { id: request.id, ok: true, result: undefined };
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

  terminate(): void {}
}

const first: ReplicaIdentity = { gatewayId: 'gateway-a', vaultId: 'vault-1' };
const second: ReplicaIdentity = { gatewayId: 'gateway-a', vaultId: 'vault-2' };
const inactive: ReplicaIdentity = { gatewayId: 'gateway-b', vaultId: 'vault-3' };

describe('remembered replica manifest', () => {
  test('deduplicates identities and forgets only the exact gateway/vault scope', () => {
    const storage = memoryStorage();
    rememberReplicaIdentity(first, storage);
    rememberReplicaIdentity(first, storage);
    rememberReplicaIdentity(second, storage);

    expect(listRememberedReplicaIdentities(storage)).toEqual([first, second]);
    forgetReplicaIdentity(first, storage);
    expect(listRememberedReplicaIdentities(storage)).toEqual([second]);
  });

  test('targeted purge reaches dormant identities on an inactive gateway', async () => {
    const storage = memoryStorage();
    for (const identity of [first, second, inactive]) rememberReplicaIdentity(identity, storage);
    const purgeIdentity = vi.fn().mockResolvedValue(undefined);

    await purgeRememberedReplicaIdentities((identity) => identity.gatewayId === 'gateway-b', {
      storage,
      purgeIdentity,
    });

    expect(purgeIdentity).toHaveBeenCalledExactlyOnceWith(inactive);
    expect(listRememberedReplicaIdentities(storage)).toEqual([first, second]);
  });

  test('retains failed scopes so a later lifecycle event can retry cleanup', async () => {
    const storage = memoryStorage();
    rememberReplicaIdentity(first, storage);

    await expect(
      purgeRememberedReplicaIdentities(() => true, {
        storage,
        purgeIdentity: vi.fn().mockRejectedValue(new Error('OPFS busy')),
      }),
    ).rejects.toThrow('One or more replica scopes remain');
    expect(listRememberedReplicaIdentities(storage)).toEqual([first]);
  });

  test('authoritative inventory survives localStorage clearing for inactive cleanup', async () => {
    const storage = memoryStorage();
    const inventory = memoryInventory();
    expect(await prepareRememberedReplicaIdentity(inactive, { storage, inventory })).toBe(true);
    storage.values.clear();
    const purgeIdentity = vi.fn().mockResolvedValue(undefined);

    await purgeRememberedReplicaIdentities((identity) => identity.gatewayId === 'gateway-b', {
      storage,
      inventory,
      purgeIdentity,
    });

    expect(purgeIdentity).toHaveBeenCalledExactlyOnceWith(inactive);
    expect(await inventory.list()).toEqual([]);
  });

  test('retries a durably selected inactive scope after inventory discovery fails', async () => {
    vi.useFakeTimers();
    try {
      const storage = memoryStorage();
      const inventory = memoryInventory();
      await prepareRememberedReplicaIdentity(inactive, { storage, inventory });
      storage.values.clear();
      vi.spyOn(inventory, 'list').mockRejectedValueOnce(new Error('IDB read interrupted'));
      const purgeIdentity = vi.fn().mockResolvedValue(undefined);
      const options = {
        storage,
        inventory,
        purgeIdentity,
        retryBaseDelayMs: 10,
        purgeSelector: { kind: 'gateway' as const, gatewayId: inactive.gatewayId },
      };

      // Lifecycle dispatch deliberately does not surface async failures. The
      // selector must remain durable for a fresh browser-lifetime retry loop.
      await purgeRememberedReplicaIdentities(
        (identity) => identity.gatewayId === inactive.gatewayId,
        options,
      ).catch(() => undefined);
      expect(purgeIdentity).not.toHaveBeenCalled();

      const reloaded = new TerminalReplicaPurgeRetryLoop(options);
      reloaded.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(purgeIdentity).toHaveBeenCalledExactlyOnceWith(inactive);
      expect(await inventory.list()).toEqual([]);
      reloaded.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test('refuses durable mode when the authoritative inventory cannot persist', async () => {
    const inventory: ReplicaIdentityInventory = {
      activate: vi.fn().mockRejectedValue(new Error('IDB denied')),
      markTerminal: vi.fn().mockRejectedValue(new Error('IDB denied')),
      deferTerminal: vi.fn().mockRejectedValue(new Error('IDB denied')),
      remove: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    };

    await expect(prepareRememberedReplicaIdentity(first, { inventory })).resolves.toBe(false);
  });

  test('retains inventory when IDB is unavailable during terminal purge', async () => {
    const storage = memoryStorage();
    const inventory = memoryInventory();
    await inventory.activate(first);

    await expect(
      purgeReplicaIdentityStorage(first, {
        storage,
        inventory,
        workerFactory: () => new SuccessfulPurgeWorker(),
      }),
    ).rejects.toThrow('Could not purge replica');
    expect(await inventory.list()).toEqual([
      { ...first, state: 'terminal-pending', purgeAttempts: 1, retryAt: expect.any(Number) },
    ]);
  });

  test('uses the durable terminal hint when the inventory mark fails transiently', async () => {
    const storage = memoryStorage();
    const inventory = memoryInventory();
    await prepareRememberedReplicaIdentity(first, { storage, inventory });
    vi.spyOn(inventory, 'markTerminal').mockRejectedValueOnce(new Error('IDB transaction failed'));
    vi.spyOn(inventory, 'deferTerminal').mockRejectedValueOnce(
      new Error('IDB transaction still failed'),
    );
    const purgeIdentity = vi.fn().mockRejectedValueOnce(new Error('OPFS busy'));

    await expect(
      purgeReplicaIdentityStorage(first, {
        storage,
        inventory,
        purgeIdentity,
        retryBaseDelayMs: 10,
        now: () => 500,
      }),
    ).rejects.toThrow('Could not purge replica');

    purgeIdentity.mockResolvedValue(undefined);
    await expect(
      retryTerminalReplicaPurges({
        storage,
        inventory,
        purgeIdentity,
        retryBaseDelayMs: 10,
        now: () => 500,
      }),
    ).resolves.toBeUndefined();
    expect(purgeIdentity).toHaveBeenCalledTimes(2);
    expect(await inventory.list()).toEqual([]);
  });

  test('does not delete data when neither terminal tracking store can record the request', async () => {
    const storage: MemoryStorage = memoryStorage();
    storage.setItem = () => {
      throw new Error('localStorage denied');
    };
    const inventory = memoryInventory();
    await inventory.activate(first);
    vi.spyOn(inventory, 'markTerminal').mockRejectedValue(new Error('IDB denied'));
    const purgeIdentity = vi.fn().mockResolvedValue(undefined);

    await expect(
      purgeReplicaIdentityStorage(first, { storage, inventory, purgeIdentity }),
    ).rejects.toThrow('Could not durably schedule replica purge');
    expect(purgeIdentity).not.toHaveBeenCalled();
    expect(await inventory.list()).toEqual([
      { ...first, state: 'remembered', purgeAttempts: 0, retryAt: 0 },
    ]);
  });

  test('retries only terminal rows after backoff and never purges an active remembered scope', async () => {
    const inventory = memoryInventory();
    await inventory.activate(first);
    await inventory.activate(inactive);
    const failedPurge = vi.fn().mockRejectedValue(new Error('OPFS busy'));

    await expect(
      purgeReplicaIdentityStorage(inactive, {
        inventory,
        purgeIdentity: failedPurge,
        now: () => 1_000,
        retryBaseDelayMs: 10,
      }),
    ).rejects.toThrow('Could not purge replica');
    expect(await prepareRememberedReplicaIdentity(inactive, { inventory })).toBe(false);

    const recoveredPurge = vi.fn().mockResolvedValue(undefined);
    await expect(
      retryTerminalReplicaPurges({
        inventory,
        purgeIdentity: recoveredPurge,
        now: () => 1_009,
        retryBaseDelayMs: 10,
      }),
    ).resolves.toBe(1_010);
    expect(recoveredPurge).not.toHaveBeenCalled();

    await expect(
      retryTerminalReplicaPurges({
        inventory,
        purgeIdentity: recoveredPurge,
        now: () => 1_010,
        retryBaseDelayMs: 10,
      }),
    ).resolves.toBeUndefined();
    expect(recoveredPurge).toHaveBeenCalledExactlyOnceWith(inactive);
    expect(await inventory.list()).toEqual([
      { ...first, state: 'remembered', purgeAttempts: 0, retryAt: 0 },
    ]);
  });

  test('automatically resumes terminal cleanup across a fresh retry loop after two failures', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    try {
      const storage = memoryStorage();
      const inventory = memoryInventory();
      await prepareRememberedReplicaIdentity(inactive, { storage, inventory });
      const purgeIdentity = vi
        .fn()
        .mockRejectedValueOnce(new Error('OPFS busy'))
        .mockRejectedValueOnce(new Error('OPFS still busy'))
        .mockResolvedValue(undefined);
      const options = { storage, inventory, purgeIdentity, retryBaseDelayMs: 10 };

      await expect(purgeReplicaIdentityStorage(inactive, options)).rejects.toThrow(
        'Could not purge replica',
      );

      // A new loop models a renderer reload: its startup sweep reads only the
      // fixed-name inventory state, not an in-memory retry closure.
      const reloaded = new TerminalReplicaPurgeRetryLoop(options);
      reloaded.start();
      await vi.advanceTimersByTimeAsync(10);
      expect(purgeIdentity).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(20);
      expect(purgeIdentity).toHaveBeenCalledTimes(3);
      expect(await inventory.list()).toEqual([]);
      expect(listRememberedReplicaIdentities(storage)).toEqual([]);
      reloaded.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
