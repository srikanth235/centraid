import { createIndexedDbReplicaIdentityInventory } from './identity-inventory.js';
import { replicaIntentDatabaseName } from './key.js';
import {
  forgetReplicaPurgeSelector,
  listReplicaPurgeSelectors,
  rememberReplicaPurgeSelector,
  replicaPurgeSelectorMatches,
  type ReplicaPurgeSelector,
} from './purge-selector.js';
import type { ReplicaIdentity } from './types.js';
import { ReplicaWorkerClient, type ReplicaWorkerFactory } from './worker-client.js';

const MANIFEST_KEY = 'centraid.replica.remembered.v1';
const TERMINAL_MANIFEST_KEY = 'centraid.replica.terminal-pending.v1';
const DEFAULT_PURGE_RETRY_BASE_MS = 5_000;
const DEFAULT_PURGE_RETRY_MAX_MS = 5 * 60_000;

type ManifestStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface ReplicaStoragePurgeOptions {
  storage?: ManifestStorage;
  workerFactory?: ReplicaWorkerFactory;
  indexedDbFactory?: IDBFactory;
  /** Test seam for the authoritative global durable-scope inventory. */
  inventory?: ReplicaIdentityInventory;
  /** Test seam; production always uses the OPFS + IDB purge below. */
  purgeIdentity?: (identity: ReplicaIdentity) => Promise<void>;
  /** Test seam for durable retry deadlines. */
  now?: () => number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  /** Durable lifecycle selector retried if authoritative identity discovery fails. */
  purgeSelector?: ReplicaPurgeSelector;
}

export interface ReplicaIdentityInventoryEntry extends ReplicaIdentity {
  state: 'remembered' | 'terminal-pending';
  purgeAttempts: number;
  retryAt: number;
}

export interface ReplicaIdentityInventory {
  activate(identity: ReplicaIdentity): Promise<boolean>;
  markTerminal(identity: ReplicaIdentity): Promise<void>;
  deferTerminal(
    identity: ReplicaIdentity,
    failedAt: number,
    baseDelayMs: number,
    maxDelayMs: number,
  ): Promise<void>;
  remove(identity: ReplicaIdentity): Promise<void>;
  list(): Promise<ReplicaIdentityInventoryEntry[]>;
}

/** Durable, non-secret inventory used to wipe replica scopes that are not open. */
export function listRememberedReplicaIdentities(
  storage: ManifestStorage | undefined = durableStorage(),
): ReplicaIdentity[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(MANIFEST_KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    const unique = new Map<string, ReplicaIdentity>();
    for (const item of parsed) {
      if (!validIdentity(item)) continue;
      unique.set(identityKey(item), item);
    }
    return [...unique.values()];
  } catch {
    return [];
  }
}

export function rememberReplicaIdentity(
  identity: ReplicaIdentity,
  storage: ManifestStorage | undefined = durableStorage(),
): void {
  if (!storage) return;
  const identities = listRememberedReplicaIdentities(storage);
  if (!identities.some((item) => sameIdentity(item, identity))) identities.push(identity);
  writeManifest(storage, identities);
}

export function forgetReplicaIdentity(
  identity: ReplicaIdentity,
  storage: ManifestStorage | undefined = durableStorage(),
): void {
  if (!storage) return;
  writeManifest(
    storage,
    listRememberedReplicaIdentities(storage).filter((item) => !sameIdentity(item, identity)),
  );
}

/**
 * Register a durable scope before OPFS or its per-scope IDB is opened. If the
 * authoritative global IDB cannot persist and read back the row, callers must
 * use memory-only storage for the whole scope.
 */
export async function prepareRememberedReplicaIdentity(
  identity: ReplicaIdentity,
  options: Pick<ReplicaStoragePurgeOptions, 'indexedDbFactory' | 'inventory' | 'storage'> = {},
): Promise<boolean> {
  const inventory = inventoryFor(options);
  if (!inventory) return false;
  try {
    const storage = options.storage ?? durableStorage();
    if (listTerminalPurgeHints(storage).some((item) => sameIdentity(item, identity))) {
      await inventory.markTerminal(identity);
      return false;
    }
    if (!(await inventory.activate(identity))) return false;
    const confirmed = (await inventory.list()).some(
      (item) => sameIdentity(item, identity) && item.state === 'remembered',
    );
    if (!confirmed) return false;
    rememberReplicaIdentity(identity, options.storage ?? durableStorage());
    return true;
  } catch {
    return false;
  }
}

/** Remove the authoritative row only after all per-scope storage is gone. */
export async function unregisterRememberedReplicaIdentity(
  identity: ReplicaIdentity,
  options: Pick<ReplicaStoragePurgeOptions, 'indexedDbFactory' | 'inventory' | 'storage'> = {},
): Promise<void> {
  const inventory = inventoryFor(options);
  if (inventory) await inventory.remove(identity);
  const storage = options.storage ?? durableStorage();
  if (!forgetTerminalPurgeHint(identity, storage)) {
    throw new Error('Could not confirm removal of the terminal replica retry marker');
  }
  forgetReplicaIdentity(identity, storage);
}

/** Persist terminal intent before any destructive storage operation starts. */
export async function markReplicaIdentityTerminal(
  identity: ReplicaIdentity,
  options: Pick<ReplicaStoragePurgeOptions, 'indexedDbFactory' | 'inventory' | 'storage'> = {},
): Promise<boolean> {
  const hintTracked = rememberTerminalPurgeHint(identity, options.storage ?? durableStorage());
  const inventory = inventoryFor(options);
  if (!inventory) return hintTracked;
  try {
    await inventory.markTerminal(identity);
    return true;
  } catch (error) {
    if (hintTracked) return true;
    throw error;
  }
}

/** Move a failed terminal purge onto a durable, capped exponential deadline. */
export async function deferTerminalReplicaPurge(
  identity: ReplicaIdentity,
  options: Pick<
    ReplicaStoragePurgeOptions,
    'indexedDbFactory' | 'inventory' | 'now' | 'retryBaseDelayMs' | 'retryMaxDelayMs'
  > = {},
): Promise<void> {
  const inventory = inventoryFor(options);
  if (!inventory) return;
  await inventory.deferTerminal(
    identity,
    (options.now ?? Date.now)(),
    positiveDelay(options.retryBaseDelayMs, DEFAULT_PURGE_RETRY_BASE_MS),
    positiveDelay(options.retryMaxDelayMs, DEFAULT_PURGE_RETRY_MAX_MS),
  );
}

/**
 * Remove OPFS + IndexedDB for an identity without relying on an open shell
 * session. This is what lets inactive gateway removal and consent downgrade
 * clean scopes left dormant by a renderer restart.
 */
export async function purgeReplicaIdentityStorage(
  identity: ReplicaIdentity,
  options: ReplicaStoragePurgeOptions = {},
): Promise<void> {
  let terminalTracked = false;
  let terminalTrackingFailure: unknown;
  try {
    terminalTracked = await markReplicaIdentityTerminal(identity, options);
  } catch (error) {
    terminalTrackingFailure = error;
  }
  if (!terminalTracked) {
    throw new AggregateError(
      terminalTrackingFailure ? [terminalTrackingFailure] : [],
      `Could not durably schedule replica purge ${identity.gatewayId}/${identity.vaultId}`,
    );
  }

  const failures: unknown[] = [];
  try {
    if (options.purgeIdentity) {
      await options.purgeIdentity(identity);
    } else {
      const client = await ReplicaWorkerClient.createForPurge(identity, options.workerFactory);
      await client.purge();
    }
  } catch (error) {
    failures.push(error);
  }

  const factory = options.indexedDbFactory ?? availableIndexedDb();
  if (!options.purgeIdentity) {
    if (!factory) {
      failures.push(new Error('IndexedDB is unavailable for confirmed replica outbox purge'));
    } else {
      try {
        await deleteIndexedDb(factory, await replicaIntentDatabaseName(identity));
      } catch (error) {
        failures.push(error);
      }
    }
  }

  if (failures.length === 0) {
    try {
      await unregisterRememberedReplicaIdentity(identity, options);
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    if (terminalTrackingFailure) failures.push(terminalTrackingFailure);
    if (terminalTracked) {
      try {
        await deferTerminalReplicaPurge(identity, options);
      } catch (error) {
        failures.push(error);
      }
    }
    throw new AggregateError(
      failures,
      `Could not purge replica ${identity.gatewayId}/${identity.vaultId}`,
    );
  }
}

/**
 * Retry only inventory rows already marked terminal. Remembered rows are never
 * inferred to be stale, so warm inactive scopes remain available by default.
 * Returns the next absolute retry deadline, if any terminal rows remain.
 */
export async function retryTerminalReplicaPurges(
  options: ReplicaStoragePurgeOptions = {},
): Promise<number | undefined> {
  const storage = options.storage ?? durableStorage();
  const discoveryFailures: unknown[] = [];
  for (const selector of listReplicaPurgeSelectors(storage)) {
    try {
      await purgeRememberedReplicaIdentities(
        (identity) => replicaPurgeSelectorMatches(selector, identity),
        { ...options, purgeSelector: selector },
      );
    } catch (error) {
      discoveryFailures.push(error);
    }
  }
  const hints = listTerminalPurgeHints(storage);
  const inventory = inventoryFor(options);
  if (!inventory) {
    if (
      hints.length > 0 ||
      discoveryFailures.length > 0 ||
      listReplicaPurgeSelectors(storage).length > 0
    ) {
      throw new Error('Replica terminal inventory is temporarily unavailable');
    }
    return undefined;
  }
  for (const identity of hints) await inventory.markTerminal(identity);
  const now = (options.now ?? Date.now)();
  const due = (await inventory.list()).filter(
    (entry) => entry.state === 'terminal-pending' && entry.retryAt <= now,
  );
  for (const entry of due) {
    await purgeReplicaIdentityStorage(bareIdentity(entry), options).catch(() => undefined);
  }
  const remaining = (await inventory.list()).filter((entry) => entry.state === 'terminal-pending');
  if (discoveryFailures.length > 0 || listReplicaPurgeSelectors(storage).length > 0) {
    throw new AggregateError(discoveryFailures, 'Replica purge discovery remains pending');
  }
  if (remaining.length === 0) return undefined;
  return Math.min(...remaining.map((entry) => entry.retryAt));
}

/** Purge every remembered identity selected from the durable manifest. */
export async function purgeRememberedReplicaIdentities(
  matches: (identity: ReplicaIdentity) => boolean,
  options: ReplicaStoragePurgeOptions = {},
): Promise<void> {
  const storage = options.storage ?? durableStorage();
  if (options.purgeSelector && !rememberReplicaPurgeSelector(options.purgeSelector, storage)) {
    throw new Error('Could not durably schedule remembered replica discovery');
  }
  if (options.purgeSelector && !inventoryFor(options)) {
    throw new Error('Replica identity inventory is temporarily unavailable');
  }
  const identities = (await durableReplicaIdentities(options)).filter(matches);
  const failures: unknown[] = [];
  for (const identity of identities) {
    try {
      await purgeReplicaIdentityStorage(identity, options);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'One or more replica scopes remain');
  if (options.purgeSelector && !forgetReplicaPurgeSelector(options.purgeSelector, storage)) {
    throw new Error('Could not confirm remembered replica discovery completion');
  }
}

async function durableReplicaIdentities(
  options: ReplicaStoragePurgeOptions,
): Promise<ReplicaIdentity[]> {
  const unique = new Map<string, ReplicaIdentity>();
  for (const identity of listRememberedReplicaIdentities(options.storage ?? durableStorage())) {
    unique.set(identityKey(identity), bareIdentity(identity));
  }
  for (const identity of listTerminalPurgeHints(options.storage ?? durableStorage())) {
    unique.set(identityKey(identity), bareIdentity(identity));
  }
  const inventory = inventoryFor(options);
  if (inventory) {
    for (const identity of await inventory.list()) {
      unique.set(identityKey(identity), bareIdentity(identity));
    }
  }
  return [...unique.values()];
}

function durableStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function availableIndexedDb(): IDBFactory | undefined {
  try {
    return typeof indexedDB === 'undefined' ? undefined : indexedDB;
  } catch {
    return undefined;
  }
}

function inventoryFor(
  options: Pick<ReplicaStoragePurgeOptions, 'indexedDbFactory' | 'inventory'>,
): ReplicaIdentityInventory | undefined {
  if (options.inventory) return options.inventory;
  const factory = options.indexedDbFactory ?? availableIndexedDb();
  return factory ? createIndexedDbReplicaIdentityInventory(factory) : undefined;
}

function writeManifest(storage: ManifestStorage, identities: ReplicaIdentity[]): void {
  try {
    if (identities.length === 0) storage.removeItem(MANIFEST_KEY);
    else storage.setItem(MANIFEST_KEY, JSON.stringify(identities));
  } catch {
    /* Storage denial means no durable replica can be inventoried here. */
  }
}

function listTerminalPurgeHints(storage: ManifestStorage | undefined): ReplicaIdentity[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(TERMINAL_MANIFEST_KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    const unique = new Map<string, ReplicaIdentity>();
    for (const item of parsed) {
      if (validIdentity(item)) unique.set(identityKey(item), bareIdentity(item));
    }
    return [...unique.values()];
  } catch {
    return [];
  }
}

function rememberTerminalPurgeHint(
  identity: ReplicaIdentity,
  storage: ManifestStorage | undefined,
): boolean {
  if (!storage) return false;
  const pending = listTerminalPurgeHints(storage);
  if (!pending.some((item) => sameIdentity(item, identity))) pending.push(bareIdentity(identity));
  if (!writeTerminalPurgeHints(storage, pending)) return false;
  return listTerminalPurgeHints(storage).some((item) => sameIdentity(item, identity));
}

function forgetTerminalPurgeHint(
  identity: ReplicaIdentity,
  storage: ManifestStorage | undefined,
): boolean {
  if (!storage) return true;
  const remaining = listTerminalPurgeHints(storage).filter((item) => !sameIdentity(item, identity));
  if (!writeTerminalPurgeHints(storage, remaining)) return false;
  return !listTerminalPurgeHints(storage).some((item) => sameIdentity(item, identity));
}

function writeTerminalPurgeHints(storage: ManifestStorage, identities: ReplicaIdentity[]): boolean {
  try {
    if (identities.length === 0) storage.removeItem(TERMINAL_MANIFEST_KEY);
    else storage.setItem(TERMINAL_MANIFEST_KEY, JSON.stringify(identities));
    return true;
  } catch {
    return false;
  }
}

function deleteIndexedDb(factory: IDBFactory, name: string): Promise<void> {
  const request = factory.deleteDatabase(name);
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve());
    request.addEventListener('error', () =>
      reject(request.error ?? new Error(`Could not delete IndexedDB ${name}`)),
    );
    request.addEventListener('blocked', () => reject(new Error(`IndexedDB ${name} is still open`)));
  });
}

function validIdentity(value: unknown): value is ReplicaIdentity {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<ReplicaIdentity>;
  return (
    typeof item.gatewayId === 'string' &&
    item.gatewayId.length > 0 &&
    typeof item.vaultId === 'string' &&
    item.vaultId.length > 0
  );
}

function bareIdentity({ gatewayId, vaultId }: ReplicaIdentity): ReplicaIdentity {
  return { gatewayId, vaultId };
}

function positiveDelay(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function sameIdentity(left: ReplicaIdentity, right: ReplicaIdentity): boolean {
  return left.gatewayId === right.gatewayId && left.vaultId === right.vaultId;
}

function identityKey(identity: ReplicaIdentity): string {
  return `${identity.gatewayId}\u0000${identity.vaultId}`;
}
