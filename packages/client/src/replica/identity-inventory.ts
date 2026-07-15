import type {
  ReplicaIdentityInventory,
  ReplicaIdentityInventoryEntry,
} from './storage-manifest.js';
import type { ReplicaIdentity } from './types.js';

const INVENTORY_DATABASE = 'centraid-replica-inventory-v1';
const INVENTORY_STORE = 'scopes';
const INVENTORY_VERSION = 2;

type ReplicaInventoryRow = ReplicaIdentityInventoryEntry & { key: string };

export function createIndexedDbReplicaIdentityInventory(
  factory: IDBFactory,
): ReplicaIdentityInventory {
  return {
    async activate(identity) {
      const db = await openInventory(factory);
      try {
        const tx = db.transaction(INVENTORY_STORE, 'readwrite');
        const store = tx.objectStore(INVENTORY_STORE);
        const existing = (await requestResult(store.get(identityKey(identity)))) as
          | ReplicaIdentityInventoryEntry
          | undefined;
        if (existing?.state === 'terminal-pending') {
          await transactionDone(tx);
          return false;
        }
        store.put(inventoryRow(identity, 'remembered', 0, 0));
        await transactionDone(tx);
        return true;
      } finally {
        db.close();
      }
    },
    async markTerminal(identity) {
      const db = await openInventory(factory);
      try {
        const tx = db.transaction(INVENTORY_STORE, 'readwrite');
        const store = tx.objectStore(INVENTORY_STORE);
        const existing = (await requestResult(store.get(identityKey(identity)))) as
          | ReplicaIdentityInventoryEntry
          | undefined;
        store.put(
          existing?.state === 'terminal-pending'
            ? inventoryRow(identity, 'terminal-pending', existing.purgeAttempts, existing.retryAt)
            : inventoryRow(identity, 'terminal-pending', 0, 0),
        );
        await transactionDone(tx);
      } finally {
        db.close();
      }
    },
    async deferTerminal(identity, failedAt, baseDelayMs, maxDelayMs) {
      const db = await openInventory(factory);
      try {
        const tx = db.transaction(INVENTORY_STORE, 'readwrite');
        const store = tx.objectStore(INVENTORY_STORE);
        const existing = (await requestResult(store.get(identityKey(identity)))) as
          | ReplicaIdentityInventoryEntry
          | undefined;
        const attempts = (existing?.purgeAttempts ?? 0) + 1;
        const delay = Math.min(baseDelayMs * 2 ** Math.min(attempts - 1, 10), maxDelayMs);
        store.put(inventoryRow(identity, 'terminal-pending', attempts, failedAt + delay));
        await transactionDone(tx);
      } finally {
        db.close();
      }
    },
    async remove(identity) {
      const db = await openInventory(factory);
      try {
        const tx = db.transaction(INVENTORY_STORE, 'readwrite');
        tx.objectStore(INVENTORY_STORE).delete(identityKey(identity));
        await transactionDone(tx);
      } finally {
        db.close();
      }
    },
    async list() {
      const db = await openInventory(factory);
      try {
        const tx = db.transaction(INVENTORY_STORE, 'readonly');
        const rows = (await requestResult(
          tx.objectStore(INVENTORY_STORE).getAll(),
        )) as ReplicaInventoryRow[];
        await transactionDone(tx);
        return rows.filter(validInventoryEntry).map(stripInventoryKey);
      } finally {
        db.close();
      }
    },
  };
}

async function openInventory(factory: IDBFactory): Promise<IDBDatabase> {
  const request = factory.open(INVENTORY_DATABASE, INVENTORY_VERSION);
  request.addEventListener('upgradeneeded', () => {
    // v0 has no migration contract: rebuild the inventory when its fresh
    // record shape changes instead of carrying an upgrade ladder.
    for (const name of Array.from(request.result.objectStoreNames)) {
      request.result.deleteObjectStore(name);
    }
    request.result.createObjectStore(INVENTORY_STORE, { keyPath: 'key' });
  });
  return requestResult(request);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () =>
      reject(request.error ?? new Error('IndexedDB request failed')),
    );
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve());
    transaction.addEventListener('error', () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed')),
    );
    transaction.addEventListener('abort', () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted')),
    );
  });
}

function validInventoryEntry(value: unknown): value is ReplicaInventoryRow {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<ReplicaInventoryRow>;
  return (
    typeof item.key === 'string' &&
    typeof item.gatewayId === 'string' &&
    item.gatewayId.length > 0 &&
    typeof item.vaultId === 'string' &&
    item.vaultId.length > 0 &&
    (item.state === 'remembered' || item.state === 'terminal-pending') &&
    Number.isInteger(item.purgeAttempts) &&
    (item.purgeAttempts ?? -1) >= 0 &&
    typeof item.retryAt === 'number' &&
    Number.isFinite(item.retryAt) &&
    item.retryAt >= 0
  );
}

function inventoryRow(
  identity: ReplicaIdentity,
  state: ReplicaIdentityInventoryEntry['state'],
  purgeAttempts: number,
  retryAt: number,
): ReplicaInventoryRow {
  return { key: identityKey(identity), ...identity, state, purgeAttempts, retryAt };
}

function stripInventoryKey({
  gatewayId,
  vaultId,
  state,
  purgeAttempts,
  retryAt,
}: ReplicaInventoryRow): ReplicaIdentityInventoryEntry {
  return { gatewayId, vaultId, state, purgeAttempts, retryAt };
}

function identityKey(identity: ReplicaIdentity): string {
  return `${identity.gatewayId}\u0000${identity.vaultId}`;
}
