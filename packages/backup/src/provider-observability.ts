import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FsObjectStore } from './object-store.js';
import {
  BackupProviderError,
  type ProviderAuditEvent,
  type ProviderAuditPage,
  type ProviderAuditQuery,
  type ProviderInventoryObject,
  type ProviderInventoryPage,
  type ProviderInventoryQuery,
  type ProviderPolicyDeclaration,
} from './provider.js';

export const MIN_POLICY_RPO_SECONDS = 30;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;

function invalid(message: string): never {
  throw BackupProviderError.of('invalid_request', message);
}

function positiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return invalid(`${field} must be a positive number`);
  }
  return value;
}

/** Runtime validation shared by reference and fake providers. */
export function validateProviderPolicy(input: unknown): ProviderPolicyDeclaration {
  if (!input || typeof input !== 'object') return invalid('policy must be an object');
  const value = input as Record<string, unknown>;
  const rpoSeconds = positiveNumber(value.rpoSeconds, 'rpoSeconds');
  if (!Number.isInteger(rpoSeconds)) return invalid('rpoSeconds must be an integer');
  if (rpoSeconds < MIN_POLICY_RPO_SECONDS) {
    throw BackupProviderError.of(
      'policy_unmet',
      `rpoSeconds cannot be lower than ${MIN_POLICY_RPO_SECONDS}`,
      { field: 'rpoSeconds', minimum: MIN_POLICY_RPO_SECONDS, requested: rpoSeconds },
    );
  }
  const casAck = value.casAck;
  if (casAck !== 'receipt' && casAck !== 'replicated') {
    return invalid('casAck must be "receipt" or "replicated"');
  }
  return {
    rpoSeconds,
    snapshotIntervalHours: positiveNumber(value.snapshotIntervalHours, 'snapshotIntervalHours'),
    verifyEveryDays: positiveNumber(value.verifyEveryDays, 'verifyEveryDays'),
    casAck,
  };
}

function pageLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    return invalid(`limit must be an integer from 1 to ${MAX_PAGE_SIZE}`);
  }
  return value;
}

function sinceValue(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0)
    return invalid('since must be an epoch-second integer');
  return value;
}

function decodeCursor(cursor: string, label: string): string {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!decoded) return invalid(`${label} cursor is invalid`);
    return decoded;
  } catch {
    return invalid(`${label} cursor is invalid`);
  }
}

function encodeCursor(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

export function paginateInventory(
  rows: ProviderInventoryObject[],
  query: ProviderInventoryQuery,
): ProviderInventoryPage {
  if (query.store !== 'backup' && query.store !== 'cas') {
    return invalid('store must be "backup" or "cas"');
  }
  const since = sinceValue(query.since);
  const afterKey = query.cursor ? decodeCursor(query.cursor, 'inventory') : undefined;
  const eligible = [...rows]
    .sort((a, b) => a.key.localeCompare(b.key))
    .filter(
      (row) =>
        (afterKey === undefined || row.key > afterKey) &&
        (since === undefined || row.storedAt >= since),
    );
  const limit = pageLimit(query.limit);
  const objects = eligible.slice(0, limit);
  return {
    store: query.store,
    objects,
    nextCursor:
      eligible.length > objects.length && objects.length > 0
        ? encodeCursor(objects[objects.length - 1]!.key)
        : null,
  };
}

export function paginateAuditEvents(
  rows: ProviderAuditEvent[],
  query: ProviderAuditQuery = {},
): ProviderAuditPage {
  const since = sinceValue(query.since);
  const offsetText = query.cursor ? decodeCursor(query.cursor, 'audit') : '0';
  const offset = Number(offsetText);
  if (!Number.isInteger(offset) || offset < 0) return invalid('audit cursor is invalid');
  const eligible = rows
    .map((event, index) => ({ event, index }))
    .filter(({ event, index }) => index >= offset && (since === undefined || event.at >= since));
  const selected = eligible.slice(0, pageLimit(query.limit));
  return {
    events: selected.map(({ event }) => event),
    nextCursor:
      eligible.length > selected.length && selected.length > 0
        ? encodeCursor(String(selected[selected.length - 1]!.index + 1))
        : null,
  };
}

export async function inventoryFromFilesystem(
  root: string,
  state: ProviderInventoryObject['state'],
  query: ProviderInventoryQuery,
): Promise<ProviderInventoryPage> {
  const store = new FsObjectStore(root);
  const rows: ProviderInventoryObject[] = [];
  for await (const listed of store.list('')) {
    const stat = await fs.stat(path.join(root, ...listed.key.split('/')));
    rows.push({
      key: listed.key,
      sizeBytes: listed.size,
      etagOrHash: '',
      storedAt: Math.floor(stat.mtimeMs / 1000),
      state,
    });
  }
  const page = paginateInventory(rows, query);
  for (const object of page.objects) {
    const hash = createHash('sha256');
    for await (const chunk of store.getStream(object.key)) hash.update(chunk);
    object.etagOrHash = hash.digest('hex');
  }
  return page;
}
