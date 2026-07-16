import { beforeEach, expect, test } from 'vitest';
import { openVaultDb, type VaultDb } from '../db.js';
import { promoteStagedBlob } from '../blob/promote.js';
import { stageBlobBytes } from '../blob/staging.js';
import {
  completeEnrichmentLease,
  enrichmentQueueDepth,
  leaseNextEnrichmentRequest,
  queueDeviceEnrichmentRequest,
  queueMissingDeviceEnrichmentBacklog,
  releaseEnrichmentLease,
  releaseExpiredEnrichmentLeases,
} from './leases.js';

let db: VaultDb;
const T0 = '2026-07-15T00:00:00.000Z';

beforeEach(() => {
  db = openVaultDb();
  queueDeviceEnrichmentRequest(db.vault, {
    requestId: 'poster-1',
    entityType: 'core.content_item',
    entityId: 'video-1',
    capability: 'poster',
    contributionVariant: 'poster',
    requestedAt: T0,
  });
  queueDeviceEnrichmentRequest(db.vault, {
    requestId: 'transcript-1',
    entityType: 'core.content_item',
    entityId: 'audio-1',
    capability: 'transcript',
    contributionVariant: 'transcript',
    requestedAt: '2026-07-15T00:00:01.000Z',
  });
});

test('capability matching leases only compatible work and reports queue depth', () => {
  expect(enrichmentQueueDepth(db.vault, T0)).toEqual({ total: 2, available: 2, leased: 0 });
  const transcript = leaseNextEnrichmentRequest(db.vault, {
    deviceId: 'phone',
    capabilities: ['transcript'],
    now: T0,
    ttlMs: 60_000,
    token: 'phone-token',
  });
  expect(transcript).toMatchObject({
    requestId: 'transcript-1',
    capability: 'transcript',
    deviceId: 'phone',
    token: 'phone-token',
    attempt: 1,
  });
  expect(enrichmentQueueDepth(db.vault, T0)).toEqual({ total: 2, available: 1, leased: 1 });
  expect(
    leaseNextEnrichmentRequest(db.vault, {
      deviceId: 'browser',
      capabilities: ['embedding'],
      now: T0,
      token: 'unused',
    }),
  ).toBeNull();
});

test('one atomic claim excludes a second device until TTL, then expired work re-enters', () => {
  const first = leaseNextEnrichmentRequest(db.vault, {
    deviceId: 'laptop-a',
    capabilities: ['poster'],
    now: T0,
    ttlMs: 30_000,
    token: 'token-a',
  });
  expect(first?.requestId).toBe('poster-1');
  expect(
    leaseNextEnrichmentRequest(db.vault, {
      deviceId: 'laptop-b',
      capabilities: ['poster'],
      now: '2026-07-15T00:00:29.999Z',
      token: 'token-b-early',
    }),
  ).toBeNull();

  const reclaimed = leaseNextEnrichmentRequest(db.vault, {
    deviceId: 'laptop-b',
    capabilities: ['poster'],
    now: '2026-07-15T00:00:30.000Z',
    ttlMs: 30_000,
    token: 'token-b',
  });
  expect(reclaimed).toMatchObject({
    requestId: 'poster-1',
    deviceId: 'laptop-b',
    token: 'token-b',
    attempt: 2,
  });
});

test('completion is device/token/TTL bound and duplicate completion is a no-op', () => {
  const lease = leaseNextEnrichmentRequest(db.vault, {
    deviceId: 'phone',
    capabilities: ['transcript'],
    now: T0,
    ttlMs: 60_000,
    token: 'right-token',
  })!;
  expect(
    completeEnrichmentLease(db.vault, {
      requestId: lease.requestId,
      deviceId: 'phone',
      token: 'wrong-token',
      now: '2026-07-15T00:00:20.000Z',
    }),
  ).toBe(false);
  db.vault
    .prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, created_at)
       VALUES ('audio-1', 'audio/mpeg', 'blob:audio', ?, 10, ?)`,
    )
    .run('c'.repeat(64), T0);
  db.vault
    .prepare(
      `INSERT INTO core_content_derivative
         (derivative_id, content_id, variant, media_type, byte_size, text_content, created_at)
       VALUES ('transcript-row', 'audio-1', 'transcript', 'text/plain', 5, 'hello', ?)`,
    )
    .run(T0);
  expect(
    completeEnrichmentLease(db.vault, {
      requestId: lease.requestId,
      deviceId: 'phone',
      token: 'right-token',
      now: '2026-07-15T00:00:20.000Z',
    }),
  ).toBe(true);
  expect(
    completeEnrichmentLease(db.vault, {
      requestId: lease.requestId,
      deviceId: 'phone',
      token: 'right-token',
      now: '2026-07-15T00:00:21.000Z',
    }),
  ).toBe(false);
  expect(enrichmentQueueDepth(db.vault, T0)).toEqual({ total: 1, available: 1, leased: 0 });
});

test('completion without the promised derivative releases the buggy client lease', () => {
  const lease = leaseNextEnrichmentRequest(db.vault, {
    deviceId: 'buggy-phone',
    capabilities: ['poster'],
    now: T0,
    ttlMs: 60_000,
    token: 'buggy-token',
  })!;
  expect(
    completeEnrichmentLease(db.vault, {
      requestId: lease.requestId,
      deviceId: 'buggy-phone',
      token: 'buggy-token',
      now: '2026-07-15T00:00:10.000Z',
    }),
  ).toBe(false);
  expect(
    (
      db.vault
        .prepare('SELECT lease_device_id FROM enrich_request WHERE request_id = ?')
        .get(lease.requestId) as { lease_device_id: string | null }
    ).lease_device_id,
  ).toBeNull();
});

test('voluntary release and expiry cleanup make backstop-visible NULL leases', () => {
  const lease = leaseNextEnrichmentRequest(db.vault, {
    deviceId: 'desktop',
    capabilities: ['poster'],
    now: T0,
    ttlMs: 30_000,
    token: 'desktop-token',
  })!;
  expect(
    releaseEnrichmentLease(db.vault, {
      requestId: lease.requestId,
      deviceId: 'desktop',
      token: 'desktop-token',
    }),
  ).toBe(true);
  expect(
    (
      db.vault
        .prepare('SELECT lease_device_id FROM enrich_request WHERE request_id = ?')
        .get(lease.requestId) as { lease_device_id: string | null }
    ).lease_device_id,
  ).toBeNull();

  leaseNextEnrichmentRequest(db.vault, {
    deviceId: 'desktop',
    capabilities: ['poster'],
    now: T0,
    ttlMs: 30_000,
    token: 'second-token',
  });
  expect(releaseExpiredEnrichmentLeases(db.vault, '2026-07-15T00:00:30.000Z')).toBe(1);
  expect(enrichmentQueueDepth(db.vault, '2026-07-15T00:00:30.000Z')).toEqual({
    total: 2,
    available: 2,
    leased: 0,
  });
});

test('claiming video automatically queues its missing poster and transcript', () => {
  const vault = openVaultDb();
  const staged = stageBlobBytes(vault, {
    bytes: Buffer.from('video bytes'),
    mediaType: 'video/mp4',
    filename: 'clip.mp4',
  });
  let id = 0;
  const promoted = promoteStagedBlob(
    {
      vault: vault.vault,
      now: T0,
      newId: () => `generated-${++id}`,
      wrote: () => undefined,
      creatorPartyId: null,
    },
    staged.sha256,
  );
  const rows = vault.vault
    .prepare(
      `SELECT required_capability, contribution_variant, detail
         FROM enrich_request ORDER BY required_capability`,
    )
    .all() as {
    required_capability: string;
    contribution_variant: string;
    detail: string;
  }[];
  expect(rows.map((row) => [row.required_capability, row.contribution_variant])).toEqual([
    ['poster', 'poster'],
    ['transcript', 'transcript'],
  ]);
  expect(JSON.parse(rows[0]!.detail)).toEqual({
    contentId: promoted.contentId,
    sha256: staged.sha256,
    mediaType: 'video/mp4',
  });
});

test('standing backfill discovers an old video and vanished ownership returns at TTL', () => {
  const vault = openVaultDb();
  const oldSha = 'b'.repeat(64);
  vault.vault
    .prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, created_at)
       VALUES ('old-video', 'video/webm', ?, ?, 42, ?)`,
    )
    .run(`blob:sha256:${oldSha}`, oldSha, T0);
  let id = 0;
  const queued = queueMissingDeviceEnrichmentBacklog(vault.vault, {
    newId: () => `backfill-${++id}`,
    requestedAt: T0,
  });
  expect(queued).toHaveLength(2);
  const first = leaseNextEnrichmentRequest(vault.vault, {
    deviceId: 'vanished-phone',
    capabilities: ['poster'],
    now: T0,
    ttlMs: 30_000,
    token: 'vanished-token',
  });
  expect(first?.requestId).toBe('backfill-1');
  expect(
    leaseNextEnrichmentRequest(vault.vault, {
      deviceId: 'night-laptop',
      capabilities: ['poster'],
      now: '2026-07-15T00:00:30.000Z',
      token: 'replacement-token',
    }),
  ).toMatchObject({ requestId: 'backfill-1', deviceId: 'night-laptop', attempt: 2 });
});

test('bounded backfill skips satisfied rows instead of starving later content', () => {
  const vault = openVaultDb();
  const insertContent = vault.vault.prepare(
    `INSERT INTO core_content_item
       (content_id, media_type, content_uri, sha256, byte_size, created_at)
     VALUES (?, 'video/mp4', ?, ?, 42, ?)`,
  );
  insertContent.run('a-satisfied', `blob:sha256:${'a'.repeat(64)}`, 'a'.repeat(64), T0);
  insertContent.run('b-missing', `blob:sha256:${'b'.repeat(64)}`, 'b'.repeat(64), T0);
  const derivative = vault.vault.prepare(
    `INSERT INTO core_content_derivative
       (derivative_id, content_id, variant, sha256, media_type, byte_size, text_content, created_at)
     VALUES (?, 'a-satisfied', ?, ?, ?, 1, ?, ?)`,
  );
  derivative.run('done-poster', 'poster', 'c'.repeat(64), 'image/png', null, T0);
  derivative.run('done-transcript', 'transcript', null, 'text/plain', 'done', T0);

  let id = 0;
  expect(
    queueMissingDeviceEnrichmentBacklog(vault.vault, {
      newId: () => `fair-${++id}`,
      requestedAt: T0,
      limit: 1,
    }),
  ).toEqual(['fair-1', 'fair-2']);
  expect(
    vault.vault.prepare('SELECT DISTINCT entity_id FROM enrich_request ORDER BY entity_id').all(),
  ).toEqual([{ entity_id: 'b-missing' }]);
});
