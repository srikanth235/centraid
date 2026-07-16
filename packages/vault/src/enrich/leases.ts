// Device enrichment work leases (issue #414 D11).
//
// Routes authenticate/advertise devices; this module is the vault-local,
// synchronous queue primitive they call. Claim is one atomic UPDATE with a
// scalar SELECT, so two gateway connections cannot receive the same job.
// Expiry is availability: a vanished device needs no cleanup tick before a
// second device can claim the row. Completion is token + device bound and an
// already-completed duplicate is a harmless `false`.

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { DerivativeVariant } from '../blob/derivatives.js';

export const ENRICHMENT_CAPABILITIES = [
  'previews',
  'poster',
  'pdfText',
  'ocr',
  'transcript',
  'embedding',
] as const;
export type EnrichmentCapability = (typeof ENRICHMENT_CAPABILITIES)[number];

export const DEFAULT_ENRICHMENT_LEASE_TTL_MS = 10 * 60 * 1000;
export const MIN_ENRICHMENT_LEASE_TTL_MS = 30 * 1000;
export const MAX_ENRICHMENT_LEASE_TTL_MS = 60 * 60 * 1000;

export interface EnrichmentLease {
  requestId: string;
  entityType: string;
  entityId: string | null;
  reason: 'search-miss' | 'on-view' | 'manual';
  detail: string | null;
  capability: EnrichmentCapability;
  contributionVariant: DerivativeVariant | null;
  deviceId: string;
  token: string;
  expiresAt: string;
  attempt: number;
}

/** Stable source pointer carried in a device job's opaque detail field. */
export interface DeviceEnrichmentSource {
  contentId: string;
  sha256: string;
  mediaType: string;
}

interface WantedDerivative {
  capability: EnrichmentCapability;
  variant: DerivativeVariant;
}

interface LeaseRow {
  request_id: string;
  entity_type: string;
  entity_id: string | null;
  reason: EnrichmentLease['reason'];
  detail: string | null;
  required_capability: EnrichmentCapability;
  contribution_variant: DerivativeVariant | null;
  lease_device_id: string;
  lease_token: string;
  lease_expires_at: string;
  lease_attempts: number;
}

function iso(value: string | Date | undefined): string {
  const date = value instanceof Date ? value : value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error('invalid lease clock');
  return date.toISOString();
}

function ttl(value: number | undefined): number {
  const requested = value ?? DEFAULT_ENRICHMENT_LEASE_TTL_MS;
  if (!Number.isFinite(requested)) throw new Error('lease ttl must be finite');
  return Math.min(MAX_ENRICHMENT_LEASE_TTL_MS, Math.max(MIN_ENRICHMENT_LEASE_TTL_MS, requested));
}

function knownCapabilities(values: readonly EnrichmentCapability[]): EnrichmentCapability[] {
  return [...new Set(values)].filter((value) =>
    (ENRICHMENT_CAPABILITIES as readonly string[]).includes(value),
  );
}

function leaseOf(row: LeaseRow): EnrichmentLease {
  return {
    requestId: row.request_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    reason: row.reason,
    detail: row.detail,
    capability: row.required_capability,
    contributionVariant: row.contribution_variant,
    deviceId: row.lease_device_id,
    token: row.lease_token,
    expiresAt: row.lease_expires_at,
    attempt: row.lease_attempts,
  };
}

/** Queue a device-eligible request without widening the owner command. */
export function queueDeviceEnrichmentRequest(
  vault: DatabaseSync,
  input: {
    requestId: string;
    entityType: string;
    entityId?: string;
    reason?: 'search-miss' | 'on-view' | 'manual';
    detail?: string;
    capability: EnrichmentCapability;
    contributionVariant?: DerivativeVariant;
    requestedAt?: string | Date;
  },
): void {
  if (!(ENRICHMENT_CAPABILITIES as readonly string[]).includes(input.capability)) {
    throw new Error(`unknown enrichment capability: ${input.capability}`);
  }
  vault
    .prepare(
      `INSERT INTO enrich_request
         (request_id, entity_type, entity_id, reason, detail, required_capability,
          contribution_variant, requested_at, drained_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      input.requestId,
      input.entityType,
      input.entityId ?? null,
      input.reason ?? 'manual',
      input.detail ?? null,
      input.capability,
      input.contributionVariant ?? null,
      iso(input.requestedAt),
    );
}

const DEVICE_DERIVATIVE_RULES: readonly {
  matches(mediaType: string): boolean;
  sqlPredicate: string;
  wanted: readonly WantedDerivative[];
}[] = [
  {
    matches: (mediaType) => mediaType.startsWith('video/'),
    sqlPredicate: "media_type LIKE 'video/%'",
    wanted: [
      { capability: 'poster', variant: 'poster' },
      { capability: 'transcript', variant: 'transcript' },
    ],
  },
  {
    matches: (mediaType) => mediaType.startsWith('audio/'),
    sqlPredicate: "media_type LIKE 'audio/%'",
    wanted: [{ capability: 'transcript', variant: 'transcript' }],
  },
  {
    matches: (mediaType) => mediaType === 'application/pdf',
    sqlPredicate: "media_type = 'application/pdf'",
    wanted: [{ capability: 'pdfText', variant: 'text' }],
  },
];

function wantedDerivatives(mediaType: string): readonly WantedDerivative[] {
  const type = mediaType.toLowerCase();
  return DEVICE_DERIVATIVE_RULES.find((rule) => rule.matches(type))?.wanted ?? [];
}

function missingDerivativeSql(wanted: WantedDerivative): string {
  return `(NOT EXISTS (
    SELECT 1 FROM core_content_derivative d
     WHERE d.content_id = core_content_item.content_id AND d.variant = '${wanted.variant}'
  ) AND NOT EXISTS (
    SELECT 1 FROM enrich_request r
     WHERE r.entity_type = 'core.content_item'
       AND r.entity_id = core_content_item.content_id
       AND r.required_capability = '${wanted.capability}'
       AND r.contribution_variant = '${wanted.variant}' AND r.drained_at IS NULL
  ))`;
}

const DEVICE_BACKLOG_SQL = DEVICE_DERIVATIVE_RULES.map(
  (rule) => `(${rule.sqlPredicate} AND (${rule.wanted.map(missingDerivativeSql).join(' OR ')}))`,
).join(' OR ');

/**
 * Queue only the device rungs one claimed content item still lacks. The
 * opaque detail is intentionally self-contained: a worker needs the parent
 * sha to submit `variant_of`, while the entity id remains the canonical
 * content id used by the backstop and UI.
 */
export function queueMissingDeviceEnrichmentRequests(
  vault: DatabaseSync,
  input: DeviceEnrichmentSource & {
    newId(): string;
    requestedAt?: string | Date;
  },
): string[] {
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new Error('device work source needs sha256');
  const queued: string[] = [];
  const hasDerivative = vault.prepare(
    'SELECT 1 AS present FROM core_content_derivative WHERE content_id = ? AND variant = ?',
  );
  const hasOpenRequest = vault.prepare(
    `SELECT 1 AS present FROM enrich_request
      WHERE entity_type = 'core.content_item' AND entity_id = ?
        AND required_capability = ? AND contribution_variant = ?
        AND drained_at IS NULL`,
  );
  const source: DeviceEnrichmentSource = {
    contentId: input.contentId,
    sha256: input.sha256,
    mediaType: input.mediaType,
  };
  for (const wanted of wantedDerivatives(input.mediaType)) {
    if (hasDerivative.get(input.contentId, wanted.variant)) continue;
    if (hasOpenRequest.get(input.contentId, wanted.capability, wanted.variant)) continue;
    const requestId = input.newId();
    queueDeviceEnrichmentRequest(vault, {
      requestId,
      entityType: 'core.content_item',
      entityId: input.contentId,
      reason: 'manual',
      detail: JSON.stringify(source),
      capability: wanted.capability,
      contributionVariant: wanted.variant,
      ...(input.requestedAt ? { requestedAt: input.requestedAt } : {}),
    });
    queued.push(requestId);
  }
  return queued;
}

/**
 * Bounded standing backfill for libraries created before a capable device
 * was paired. Re-running is idempotent over open jobs and existing variants.
 */
export function queueMissingDeviceEnrichmentBacklog(
  vault: DatabaseSync,
  input: { newId(): string; requestedAt?: string | Date; limit?: number },
): string[] {
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));
  const rows = vault
    .prepare(
      `SELECT content_id, sha256, media_type
         FROM core_content_item
        WHERE deleted_at IS NULL AND sha256 IS NOT NULL
          AND (${DEVICE_BACKLOG_SQL})
        ORDER BY content_id
        LIMIT ?`,
    )
    .all(limit) as { content_id: string; sha256: string; media_type: string }[];
  const queued: string[] = [];
  for (const row of rows) {
    queued.push(
      ...queueMissingDeviceEnrichmentRequests(vault, {
        contentId: row.content_id,
        sha256: row.sha256,
        mediaType: row.media_type,
        newId: input.newId,
        ...(input.requestedAt ? { requestedAt: input.requestedAt } : {}),
      }),
    );
  }
  return queued;
}

/** Atomically claim the oldest compatible available/expired request. */
export function leaseNextEnrichmentRequest(
  vault: DatabaseSync,
  input: {
    deviceId: string;
    capabilities: readonly EnrichmentCapability[];
    now?: string | Date;
    ttlMs?: number;
    token?: string;
  },
): EnrichmentLease | null {
  const capabilities = knownCapabilities(input.capabilities);
  if (!input.deviceId || capabilities.length === 0) return null;
  const now = iso(input.now);
  const expiresAt = new Date(Date.parse(now) + ttl(input.ttlMs)).toISOString();
  const token = input.token ?? randomUUID();
  const placeholders = capabilities.map(() => '?').join(',');
  const row = vault
    .prepare(
      `UPDATE enrich_request
          SET lease_device_id = ?, lease_token = ?, lease_expires_at = ?,
              lease_attempts = lease_attempts + 1
        WHERE request_id = (
          SELECT request_id FROM enrich_request
           WHERE drained_at IS NULL
             AND required_capability IN (${placeholders})
             AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
           ORDER BY requested_at, request_id
           LIMIT 1
        )
        RETURNING request_id, entity_type, entity_id, reason, detail,
          required_capability, contribution_variant, lease_device_id,
          lease_token, lease_expires_at, lease_attempts`,
    )
    .get(input.deviceId, token, expiresAt, ...capabilities, now) as LeaseRow | undefined;
  return row ? leaseOf(row) : null;
}

/**
 * Finish a still-live lease only after its typed derivative exists. A buggy
 * client that reports completion before contribution loses ownership so the
 * job can be retried; duplicate/wrong/expired completion remains a no-op.
 */
export function completeEnrichmentLease(
  vault: DatabaseSync,
  input: {
    requestId: string;
    deviceId: string;
    token: string;
    now?: string | Date;
  },
): boolean {
  const now = iso(input.now);
  const changed = vault
    .prepare(
      `UPDATE enrich_request
          SET drained_at = ?, lease_device_id = NULL, lease_token = NULL,
              lease_expires_at = NULL
        WHERE request_id = ? AND drained_at IS NULL
          AND lease_device_id = ? AND lease_token = ? AND lease_expires_at > ?
          AND entity_type = 'core.content_item' AND contribution_variant IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM core_content_derivative d
             WHERE d.content_id = enrich_request.entity_id
               AND d.variant = enrich_request.contribution_variant
          )`,
    )
    .run(now, input.requestId, input.deviceId, input.token, now).changes;
  if (Number(changed) === 1) return true;
  // A matching live owner that simply failed to contribute must not pin the
  // job until TTL. Wrong tokens/devices cannot release somebody else's work.
  vault
    .prepare(
      `UPDATE enrich_request
          SET lease_device_id = NULL, lease_token = NULL, lease_expires_at = NULL
        WHERE request_id = ? AND drained_at IS NULL
          AND lease_device_id = ? AND lease_token = ? AND lease_expires_at > ?
          AND contribution_variant IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM core_content_derivative d
             WHERE d.content_id = enrich_request.entity_id
               AND d.variant = enrich_request.contribution_variant
          )`,
    )
    .run(input.requestId, input.deviceId, input.token, now);
  return false;
}

/** Voluntarily return one live lease to the pool (conditions changed). */
export function releaseEnrichmentLease(
  vault: DatabaseSync,
  input: { requestId: string; deviceId: string; token: string },
): boolean {
  const changed = vault
    .prepare(
      `UPDATE enrich_request
          SET lease_device_id = NULL, lease_token = NULL, lease_expires_at = NULL
        WHERE request_id = ? AND drained_at IS NULL
          AND lease_device_id = ? AND lease_token = ?`,
    )
    .run(input.requestId, input.deviceId, input.token).changes;
  return Number(changed) === 1;
}

/** Clear expired ownership for automation/backstop readers that only see NULL. */
export function releaseExpiredEnrichmentLeases(
  vault: DatabaseSync,
  now: string | Date = new Date(),
): number {
  const changed = vault
    .prepare(
      `UPDATE enrich_request
          SET lease_device_id = NULL, lease_token = NULL, lease_expires_at = NULL
        WHERE drained_at IS NULL AND lease_expires_at <= ?`,
    )
    .run(iso(now)).changes;
  return Number(changed);
}

/** Close expired/unowned typed jobs whose gateway backstop filled the rung. */
export function drainSatisfiedEnrichmentRequests(
  vault: DatabaseSync,
  now: string | Date = new Date(),
): number {
  const at = iso(now);
  const changed = vault
    .prepare(
      `UPDATE enrich_request
          SET drained_at = ?, lease_device_id = NULL, lease_token = NULL,
              lease_expires_at = NULL
        WHERE drained_at IS NULL
          AND entity_type = 'core.content_item' AND contribution_variant IS NOT NULL
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
          AND EXISTS (
            SELECT 1 FROM core_content_derivative d
             WHERE d.content_id = enrich_request.entity_id
               AND d.variant = enrich_request.contribution_variant
          )`,
    )
    .run(at, at).changes;
  return Number(changed);
}

export function enrichmentQueueDepth(
  vault: DatabaseSync,
  now: string | Date = new Date(),
): { total: number; available: number; leased: number } {
  const row = vault
    .prepare(
      `SELECT count(*) AS total,
              sum(CASE WHEN lease_expires_at IS NULL OR lease_expires_at <= ? THEN 1 ELSE 0 END) AS available,
              sum(CASE WHEN lease_expires_at > ? THEN 1 ELSE 0 END) AS leased
         FROM enrich_request
        WHERE drained_at IS NULL AND required_capability IS NOT NULL`,
    )
    .get(iso(now), iso(now)) as { total: number; available: number | null; leased: number | null };
  return { total: row.total, available: row.available ?? 0, leased: row.leased ?? 0 };
}
