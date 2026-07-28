import type { ProviderAuditEvent, ProviderPolicy, SnapshotRow } from './provider.js';

export interface RegistryTarget {
  id: string;
  name: string;
  status: 'active' | 'deleted';
  currentGeneration: number;
  createdAt: string;
  deletedAt: string | null;
  purgedAt: string | null;
}

export interface Registry {
  targets: Record<string, RegistryTarget>;
  snapshots: Record<string, SnapshotRow[]>;
  idempotency: Record<string, Record<string, SnapshotRow>>;
  nextSeq: Record<string, number>;
  policies: Record<string, ProviderPolicy>;
  events: Record<string, ProviderAuditEvent[]>;
}

export function emptyRegistry(): Registry {
  return {
    targets: {},
    snapshots: {},
    idempotency: {},
    nextSeq: {},
    policies: {},
    events: {},
  };
}
