import type { ProviderAuditEvent } from '@centraid/backup';
import type { InventorySource } from './backup-provider-observability.js';

export interface DriftSummary {
  count: number;
  sample: string[];
}

export interface InventoryAttestationDrift {
  providerOnly: DriftSummary;
  bucketOnly: DriftSummary;
  metadataMismatch: DriftSummary;
}

export interface StoreReconciliationState {
  configured: boolean;
  source: InventorySource | 'not-configured' | 'unavailable';
  providerAttested: boolean;
  /** Total objects/bytes the provider still holds, including soft-deleted custody. */
  objectCount: number;
  bytes: number;
  liveObjectCount: number;
  softDeletedCount: number;
  softDeletedBytes: number;
  missing: DriftSummary;
  orphans: DriftSummary;
  attestationDrift?: InventoryAttestationDrift;
  attestationError?: string;
  error?: string;
}

export interface BackupReconciliationState {
  checkedAt: string;
  mode: 'scheduled' | 'bucket';
  status: 'ok' | 'degraded' | 'error';
  backup: StoreReconciliationState;
  cas: StoreReconciliationState;
  walGaps: DriftSummary;
  walCoverage: {
    earliestTickMs: number | null;
    latestTickMs: number | null;
    spanDays: number | null;
    segmentCount: number;
    markerCount: number;
  };
  snapshots: {
    live: number;
    pruned: number;
    recent: Array<{
      seq: number;
      totalBytes: number;
      objectCount: number;
      createdAt: number;
      prunedAt: number | null;
      format: string;
    }>;
  };
  audit: {
    source: 'provider' | 'unavailable';
    eventCount: number;
    recent: ProviderAuditEvent[];
    error?: string;
  };
}

const SAMPLE_LIMIT = 25;

export function driftSummary(values: Iterable<string>): DriftSummary {
  const rows = [...new Set(values)].sort();
  return { count: rows.length, sample: rows.slice(0, SAMPLE_LIMIT) };
}

export function unavailableStore(configured: boolean, error?: string): StoreReconciliationState {
  return {
    configured,
    source: configured ? 'unavailable' : 'not-configured',
    providerAttested: false,
    objectCount: 0,
    bytes: 0,
    liveObjectCount: 0,
    softDeletedCount: 0,
    softDeletedBytes: 0,
    missing: driftSummary([]),
    orphans: driftSummary([]),
    ...(error ? { error } : {}),
  };
}

export function failedReconciliation(
  checkedAt: string,
  mode: BackupReconciliationState['mode'],
  error: string,
): BackupReconciliationState {
  return {
    checkedAt,
    mode,
    status: 'error',
    backup: unavailableStore(true, error),
    cas: unavailableStore(false),
    walGaps: driftSummary([]),
    walCoverage: {
      earliestTickMs: null,
      latestTickMs: null,
      spanDays: null,
      segmentCount: 0,
      markerCount: 0,
    },
    snapshots: { live: 0, pruned: 0, recent: [] },
    audit: { source: 'unavailable', eventCount: 0, recent: [] },
  };
}
