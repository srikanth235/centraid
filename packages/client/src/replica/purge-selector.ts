import type { ReplicaIdentity } from './types.js';

const PURGE_SELECTOR_KEY = 'centraid.replica.purge-selectors.v1';

type ManifestStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type ReplicaPurgeSelector =
  | ({ kind: 'identity' } & ReplicaIdentity)
  | { kind: 'gateway'; gatewayId: string }
  | { kind: 'inactive-vaults'; gatewayId: string; activeVaultId?: string };

export function listReplicaPurgeSelectors(
  storage: ManifestStorage | undefined,
): ReplicaPurgeSelector[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(PURGE_SELECTOR_KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    const unique = new Map<string, ReplicaPurgeSelector>();
    for (const value of parsed) {
      if (validSelector(value)) unique.set(selectorKey(value), value);
    }
    return [...unique.values()];
  } catch {
    return [];
  }
}

export function rememberReplicaPurgeSelector(
  selector: ReplicaPurgeSelector,
  storage: ManifestStorage | undefined,
): boolean {
  if (!storage) return false;
  const selectors = listReplicaPurgeSelectors(storage);
  if (!selectors.some((item) => selectorKey(item) === selectorKey(selector))) {
    selectors.push(structuredClone(selector));
  }
  if (!writeSelectors(storage, selectors)) return false;
  return listReplicaPurgeSelectors(storage).some(
    (item) => selectorKey(item) === selectorKey(selector),
  );
}

export function forgetReplicaPurgeSelector(
  selector: ReplicaPurgeSelector,
  storage: ManifestStorage | undefined,
): boolean {
  if (!storage) return true;
  const key = selectorKey(selector);
  const remaining = listReplicaPurgeSelectors(storage).filter((item) => selectorKey(item) !== key);
  if (!writeSelectors(storage, remaining)) return false;
  return !listReplicaPurgeSelectors(storage).some((item) => selectorKey(item) === key);
}

export function replicaPurgeSelectorMatches(
  selector: ReplicaPurgeSelector,
  identity: ReplicaIdentity,
): boolean {
  switch (selector.kind) {
    case 'identity':
      return selector.gatewayId === identity.gatewayId && selector.vaultId === identity.vaultId;
    case 'gateway':
      return selector.gatewayId === identity.gatewayId;
    case 'inactive-vaults':
      return (
        selector.gatewayId === identity.gatewayId && selector.activeVaultId !== identity.vaultId
      );
  }
}

function writeSelectors(storage: ManifestStorage, selectors: ReplicaPurgeSelector[]): boolean {
  try {
    if (selectors.length === 0) storage.removeItem(PURGE_SELECTOR_KEY);
    else storage.setItem(PURGE_SELECTOR_KEY, JSON.stringify(selectors));
    return true;
  } catch {
    return false;
  }
}

function validSelector(value: unknown): value is ReplicaPurgeSelector {
  if (!value || typeof value !== 'object') return false;
  const selector = value as Partial<ReplicaPurgeSelector>;
  if (typeof selector.gatewayId !== 'string' || selector.gatewayId.length === 0) return false;
  if (selector.kind === 'gateway') return true;
  if (selector.kind === 'identity') {
    return typeof selector.vaultId === 'string' && selector.vaultId.length > 0;
  }
  return (
    selector.kind === 'inactive-vaults' &&
    (selector.activeVaultId === undefined || typeof selector.activeVaultId === 'string')
  );
}

function selectorKey(selector: ReplicaPurgeSelector): string {
  switch (selector.kind) {
    case 'identity':
      return `identity\u0000${selector.gatewayId}\u0000${selector.vaultId}`;
    case 'gateway':
      return `gateway\u0000${selector.gatewayId}`;
    case 'inactive-vaults':
      return `inactive-vaults\u0000${selector.gatewayId}\u0000${selector.activeVaultId ?? ''}`;
  }
}
