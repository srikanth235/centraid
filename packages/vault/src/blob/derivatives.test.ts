import { beforeEach, describe, expect, test } from 'vitest';
import { bootstrapVault, type BootstrapResult } from '../bootstrap.js';
import { registerDocumentCommands } from '../commands/documents.js';
import { registerEnrichCommands } from '../commands/enrich.js';
import { registerMediaCommands } from '../commands/media.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, type Gateway } from '../gateway/gateway.js';
import type { Credential } from '../gateway/types.js';
import { scanEmbeddings } from '../enrich/similarity.js';
import {
  DERIVATIVE_REGISTRY,
  DERIVATIVE_VARIANTS,
  validateDerivativeContribution,
} from './derivatives.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerDocumentCommands(gw);
  registerMediaCommands(gw);
  registerEnrichCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
});

function invoke(command: string, input: Record<string, unknown>) {
  return gw.invoke(owner, { command, input, purpose: 'dpv:ServiceProvision' });
}

function output<T>(result: unknown): T {
  expect((result as { status: string }).status).toBe('executed');
  return (result as { output: T }).output;
}

describe('derivative registry and validation', () => {
  test('declares every protocol variant and its backstop/storage invariant', () => {
    expect(DERIVATIVE_VARIANTS).toEqual([
      'thumb',
      'preview',
      'poster',
      'text',
      'transcript',
      'embedding',
      'phash',
    ]);
    expect(DERIVATIVE_REGISTRY.poster).toMatchObject({ storage: 'cas', backstop: 'none' });
    expect(DERIVATIVE_REGISTRY.text).toMatchObject({ storage: 'inline' });
    expect(DERIVATIVE_REGISTRY.embedding).toMatchObject({ backstop: 'optional-model' });
  });

  test('accepts bounded canonical payloads and rejects malformed contributions', () => {
    expect(
      validateDerivativeContribution({ variant: 'poster', bytes: PNG, mediaType: 'image/png' }),
    ).toMatchObject({ storage: 'cas', width: 1, height: 1 });
    expect(
      validateDerivativeContribution({
        variant: 'embedding',
        bytes: Buffer.from('{"vector":[1,0.5],"model":"tiny"}'),
      }).textContent,
    ).toBe('{"model":"tiny","vector":[1,0.5]}');
    expect(() =>
      validateDerivativeContribution({
        variant: 'poster',
        bytes: Buffer.from('not an image'),
        mediaType: 'image/jpeg',
      }),
    ).toThrow(/plausible decodable dimensions/);
    expect(() =>
      validateDerivativeContribution({ variant: 'phash', bytes: Buffer.from('ABCDEF') }),
    ).toThrow(/lowercase hexadecimal/);
    expect(() =>
      validateDerivativeContribution({
        variant: 'embedding',
        bytes: Buffer.from('{"model":"m","vector":[null]}'),
      }),
    ).toThrow(/finite numbers/);
  });
});

test('device text wins over ingest extraction and transcript feeds both document/content FTS', () => {
  const original = gw.stageBlob(owner, {
    bytes: Buffer.from('%PDF-1.1\nBT (cheap gateway words only) Tj ET\n%%EOF'),
    filename: 'talk.pdf',
  });
  gw.stageBlob(owner, {
    bytes: Buffer.from('pdf.js found the decisive narwhal clause'),
    mediaType: 'text/plain',
    variant: 'text',
    variantOf: original.sha256,
  });
  const doc = output<{ content_id: string; document_id: string }>(
    invoke('core.add_document', { staged_sha: original.sha256, title: 'Talk' }),
  );
  const text = db.vault
    .prepare(
      `SELECT sha256, text_content FROM core_content_derivative
        WHERE content_id = ? AND variant = 'text'`,
    )
    .get(doc.content_id) as { sha256: string | null; text_content: string };
  expect(text).toEqual({ sha256: null, text_content: 'pdf.js found the decisive narwhal clause' });
  expect(
    gw
      .search(owner, {
        entity: 'core.document',
        query: 'narwhal',
        purpose: 'dpv:ServiceProvision',
      })
      .rows.map((row) => row.document_id),
  ).toContain(doc.document_id);

  gw.stageBlob(owner, {
    bytes: Buffer.from('speaker explains the cobalt launch sequence'),
    mediaType: 'text/plain',
    variant: 'transcript',
    variantOf: original.sha256,
  });
  expect(
    gw
      .search(owner, {
        entity: 'core.content_item',
        query: 'cobalt',
        purpose: 'dpv:ServiceProvision',
      })
      .rows.map((row) => row.content_id),
  ).toContain(doc.content_id);
});

test('poster stays CAS-backed while phash and embedding stay inline', () => {
  const original = gw.stageBlob(owner, {
    bytes: Buffer.from('video original bytes'),
    mediaType: 'video/mp4',
    filename: 'clip.mp4',
  });
  const poster = gw.stageBlob(owner, {
    bytes: PNG,
    mediaType: 'image/png',
    variant: 'poster',
    variantOf: original.sha256,
    validateDerivative: true,
  });
  gw.stageBlob(owner, {
    bytes: Buffer.from('0123456789abcdef'),
    variant: 'phash',
    variantOf: original.sha256,
  });
  const embedding = gw.stageBlob(owner, {
    bytes: Buffer.from('{"model":"edge-v1","vector":[1,0,0.25]}'),
    variant: 'embedding',
    variantOf: original.sha256,
  });
  expect(db.blobs.hasSync(embedding.sha256)).toBe(false);
  expect(db.blobTransfers.state.outbox(embedding.sha256)).toBeNull();
  const asset = output<{ asset_id: string; content_id: string }>(
    invoke('media.add_asset', { staged_sha: original.sha256, kind: 'video' }),
  );
  const rows = db.vault
    .prepare(
      `SELECT variant, sha256, text_content FROM core_content_derivative
        WHERE content_id = ? ORDER BY variant`,
    )
    .all(asset.content_id) as {
    variant: string;
    sha256: string | null;
    text_content: string | null;
  }[];
  expect(rows).toEqual([
    {
      variant: 'embedding',
      sha256: null,
      text_content: '{"model":"edge-v1","vector":[1,0,0.25]}',
    },
    { variant: 'phash', sha256: null, text_content: '0123456789abcdef' },
    { variant: 'poster', sha256: poster.sha256, text_content: null },
  ]);
  const semantic = scanEmbeddings(db.vault, 'edge-v1', [1, 0, 0.25]);
  expect(semantic[0]).toMatchObject({
    entityType: 'core.content_item',
    entityId: asset.content_id,
  });
  expect(semantic[0]?.score).toBeCloseTo(1);
  const served = gw.resolveBlob(owner, asset.content_id, { variant: 'poster' });
  expect(served.status).toBe('ok');
  const phash = db.vault
    .prepare('SELECT phash FROM media_asset_phash WHERE asset_id = ?')
    .get(asset.asset_id) as { phash: string };
  expect(phash.phash).toBe('0123456789abcdef');
});

test('typed staging slots do not collide when contributions reuse identical bytes', () => {
  const first = gw.stageBlob(owner, {
    bytes: Buffer.from('first video'),
    mediaType: 'video/mp4',
  });
  const second = gw.stageBlob(owner, {
    bytes: Buffer.from('second video'),
    mediaType: 'video/mp4',
  });
  for (const parent of [first.sha256, second.sha256]) {
    gw.stageBlob(owner, {
      bytes: PNG,
      mediaType: 'image/png',
      variant: 'poster',
      variantOf: parent,
      validateDerivative: true,
    });
  }
  const sharedWords = Buffer.from('the same contribution can fill two typed slots');
  gw.stageBlob(owner, {
    bytes: sharedWords,
    variant: 'text',
    variantOf: first.sha256,
  });
  gw.stageBlob(owner, {
    bytes: sharedWords,
    variant: 'transcript',
    variantOf: first.sha256,
  });

  const firstAsset = output<{ content_id: string }>(
    invoke('media.add_asset', { staged_sha: first.sha256, kind: 'video' }),
  );
  const secondAsset = output<{ content_id: string }>(
    invoke('media.add_asset', { staged_sha: second.sha256, kind: 'video' }),
  );
  const slots = db.vault
    .prepare(
      `SELECT content_id, variant, sha256, text_content
         FROM core_content_derivative
        WHERE content_id IN (?, ?)
        ORDER BY content_id, variant`,
    )
    .all(firstAsset.content_id, secondAsset.content_id) as {
    content_id: string;
    variant: string;
    sha256: string | null;
    text_content: string | null;
  }[];
  expect(slots.filter((row) => row.variant === 'poster')).toHaveLength(2);
  expect(
    new Set(slots.filter((row) => row.variant === 'poster').map((row) => row.sha256)).size,
  ).toBe(1);
  expect(
    slots
      .filter((row) => row.content_id === firstAsset.content_id && row.text_content)
      .map((row) => row.variant),
  ).toEqual(['text', 'transcript']);
});

test('late contribution publication rolls its staging slot back when association fails', () => {
  const original = gw.stageBlob(owner, {
    bytes: Buffer.from('video whose poster will fail once'),
    mediaType: 'video/mp4',
  });
  const asset = output<{ content_id: string }>(
    invoke('media.add_asset', { staged_sha: original.sha256, kind: 'video' }),
  );
  db.vault.exec(`CREATE TRIGGER fail_poster_association
    BEFORE INSERT ON core_content_derivative
    WHEN NEW.variant = 'poster'
    BEGIN SELECT RAISE(ABORT, 'injected association failure'); END`);

  expect(() =>
    gw.stageBlob(owner, {
      bytes: PNG,
      mediaType: 'image/png',
      variant: 'poster',
      variantOf: original.sha256,
      validateDerivative: true,
    }),
  ).toThrow(/injected association failure/);
  expect(
    db.vault
      .prepare('SELECT count(*) AS n FROM blob_staging WHERE variant_of = ?')
      .get(original.sha256),
  ).toEqual({ n: 0 });
  expect(
    db.vault
      .prepare('SELECT count(*) AS n FROM core_content_derivative WHERE content_id = ?')
      .get(asset.content_id),
  ).toEqual({ n: 0 });
});
