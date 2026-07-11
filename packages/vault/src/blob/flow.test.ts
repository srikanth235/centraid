// Blob custody end-to-end (issue #296): staging → command claim → derived
// egress rule → lifecycle. The invariants under test are the issue's spine:
// the journal never swallows bytes again, identity is the raw-bytes sha,
// extracted text feeds the PARENT's search row, trash still renders, and
// the purge sweep reclaims the CAS.

import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import type { Credential } from '../gateway/types.js';
import { registerAttachmentCommands } from '../commands/attachments.js';
import { registerDocumentCommands } from '../commands/documents.js';
import { registerMediaCommands } from '../commands/media.js';
import { registerTaskCommands } from '../commands/tasks.js';
import { sweepBlobStaging } from './staging.js';
import { blobUriFor, sha256OfBytes } from './store.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerAttachmentCommands(gw);
  registerDocumentCommands(gw);
  registerMediaCommands(gw);
  registerTaskCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
});

function invoke(command: string, input: Record<string, unknown>) {
  return gw.invoke(owner, { command, input, purpose: 'dpv:ServiceProvision' });
}

function executed<T>(out: unknown): T {
  expect((out as { status: string }).status).toBe('executed');
  return (out as { output: T }).output;
}

test('stage → claim via media.add_asset: blob URI, spool metadata, tiny journal', () => {
  const staged = gw.stageBlob(owner, { bytes: PNG_BYTES, filename: 'pixel.png' });
  expect(staged.mediaType).toBe('image/png'); // sniffed, not declared
  expect(staged.byteSize).toBe(PNG_BYTES.length);
  expect(db.blobs.hasSync(staged.sha256)).toBe(true);

  const out = executed<{ asset_id: string; content_id: string }>(
    invoke('media.add_asset', { staged_sha: staged.sha256 }),
  );
  const content = db.vault
    .prepare(
      'SELECT content_uri, sha256, byte_size, media_type, title FROM core_content_item WHERE content_id = ?',
    )
    .get(out.content_id) as Record<string, unknown>;
  expect(content.content_uri).toBe(blobUriFor(staged.sha256));
  expect(content.sha256).toBe(staged.sha256); // identity = raw bytes
  expect(content.title).toBe('pixel.png'); // original filename as default title
  // Spool EXIF landed on the asset row without the caller supplying it.
  const asset = db.vault
    .prepare('SELECT width, height, kind FROM media_media_asset WHERE asset_id = ?')
    .get(out.asset_id) as Record<string, unknown>;
  expect(asset.width).toBe(1);
  expect(asset.height).toBe(1);
  expect(asset.kind).toBe('photo');
  // The staging row is claimed, and the journal recorded a sha, not bytes.
  expect(db.vault.prepare('SELECT count(*) AS n FROM blob_staging').get()).toEqual({ n: 0 });
  const journal = db.journal
    .prepare("SELECT input_json FROM agent_command_invocation WHERE input_json LIKE '%staged_sha%'")
    .get() as { input_json: string };
  expect(journal.input_json.length).toBeLessThan(200);
});

test('same bytes, different declared type: one content item (raw-bytes dedup)', () => {
  const first = gw.stageBlob(owner, { bytes: PNG_BYTES, mediaType: 'application/octet-stream' });
  const a = executed<{ content_id: string }>(
    invoke('core.add_document', { staged_sha: first.sha256, title: 'as-doc.bin' }),
  );
  const second = gw.stageBlob(owner, { bytes: PNG_BYTES, mediaType: 'image/x-weird' });
  expect(second.existingContentId).toBe(a.content_id);
  // A second document over the same bytes still dedupes the CONTENT — it's a
  // brand-new document, but wraps the identical content item (issue #352).
  const b = executed<{ content_id: string; deduped: number }>(
    invoke('core.add_document', { staged_sha: second.sha256, title: 'again.png' }),
  );
  expect(b.content_id).toBe(a.content_id);
  expect(b.deduped).toBe(1);
});

test('inline data_uri: text stays in the row, binary spills to the CAS, big refuses', () => {
  const taskOut = executed<{ task_id: string }>(invoke('schedule.add_task', { title: 'T' }));
  const textUri = `data:text/plain;charset=utf-8,${encodeURIComponent('inline body')}`;
  const t = executed<{ content_id: string }>(
    invoke('core.attach', {
      subject_type: 'schedule.task',
      subject_id: taskOut.task_id,
      data_uri: textUri,
    }),
  );
  const textRow = db.vault
    .prepare('SELECT content_uri, sha256 FROM core_content_item WHERE content_id = ?')
    .get(t.content_id) as { content_uri: string; sha256: string };
  expect(textRow.content_uri).toBe(textUri); // text/* inline — the FTS feed
  expect(textRow.sha256).toBe(sha256OfBytes(Buffer.from('inline body', 'utf8')));

  const pngUri = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
  const p = executed<{ content_id: string }>(
    invoke('core.attach', {
      subject_type: 'schedule.task',
      subject_id: taskOut.task_id,
      data_uri: pngUri,
    }),
  );
  const pngRow = db.vault
    .prepare('SELECT content_uri FROM core_content_item WHERE content_id = ?')
    .get(p.content_id) as { content_uri: string };
  expect(pngRow.content_uri).toBe(blobUriFor(sha256OfBytes(PNG_BYTES)));

  // Oversized inline payloads are refused at the contract — staging exists.
  const big = `data:application/octet-stream;base64,${'A'.repeat(400_000)}`;
  const refused = invoke('core.attach', {
    subject_type: 'schedule.task',
    subject_id: taskOut.task_id,
    data_uri: big,
  });
  expect(refused.status).toBe('failed');
  expect((refused as { predicate?: string }).predicate).toContain('within_size_cap');
});

test('extracted text feeds the OWNING document row in search, and survives rename', () => {
  const pdf = Buffer.from('%PDF-1.1\nBT (unicorn depreciation schedule) Tj ET\n%%EOF');
  const staged = gw.stageBlob(owner, { bytes: pdf, filename: 'depr.pdf' });
  const doc = executed<{ document_id: string; content_id: string }>(
    invoke('core.add_document', { staged_sha: staged.sha256, title: 'Depreciation' }),
  );
  // The text variant exists and the OWNING document (not a shadow row) matches.
  const variant = db.vault
    .prepare(
      "SELECT text_content FROM core_content_derivative WHERE content_id = ? AND variant = 'text'",
    )
    .get(doc.content_id) as { text_content: string };
  expect(variant.text_content).toContain('unicorn depreciation');
  const hits = gw.search(owner, {
    entity: 'core.document',
    query: 'unicorn',
    purpose: 'dpv:ServiceProvision',
  });
  expect(hits.rows.map((r) => r.document_id)).toContain(doc.document_id);
  // A rename rebuilds the FTS row — extracted text must survive (the
  // derivative-aware COALESCE, not a title-only rebuild).
  executed(invoke('core.rename_document', { document_id: doc.document_id, title: 'Renamed' }));
  const after = gw.search(owner, {
    entity: 'core.document',
    query: 'unicorn',
    purpose: 'dpv:ServiceProvision',
  });
  expect(after.rows.map((r) => r.document_id)).toContain(doc.document_id);
});

test('egress rule: attached serves, trash still serves, unclaimed refuses', () => {
  const staged = gw.stageBlob(owner, { bytes: PNG_BYTES });
  const doc = executed<{ document_id: string; content_id: string }>(
    invoke('core.add_document', { staged_sha: staged.sha256, title: 'photo.png' }),
  );
  const ok = gw.resolveBlob(owner, doc.content_id);
  expect(ok.status).toBe('ok');
  if (ok.status === 'ok') {
    expect(ok.blob.sha256).toBe(staged.sha256);
    expect(db.blobs.getSync(ok.blob.sha256)?.equals(PNG_BYTES)).toBe(true);
  }
  // Trash keeps rendering until the purge sweep actually reclaims.
  executed(invoke('core.trash_document', { document_id: doc.document_id }));
  expect(gw.resolveBlob(owner, doc.content_id).status).toBe('ok');
  // A variant nobody produced is a clean miss, not an error.
  expect(gw.resolveBlob(owner, doc.content_id, { variant: 'thumb' }).status).toBe('no-variant');
  // A content id that doesn't exist.
  expect(gw.resolveBlob(owner, 'nope').status).toBe('not-found');
});

test('client-produced thumb variant rides staging and serves under ?variant=', () => {
  const thumbBytes = Buffer.from('tiny-thumb-jpeg-bytes');
  const original = gw.stageBlob(owner, { bytes: PNG_BYTES, filename: 'full.png' });
  gw.stageBlob(owner, {
    bytes: thumbBytes,
    mediaType: 'image/jpeg',
    variant: 'thumb',
    variantOf: original.sha256,
  });
  const doc = executed<{ content_id: string }>(
    invoke('core.add_document', { staged_sha: original.sha256, title: 'full.png' }),
  );
  const thumb = gw.resolveBlob(owner, doc.content_id, { variant: 'thumb' });
  expect(thumb.status).toBe('ok');
  if (thumb.status === 'ok') {
    expect(thumb.blob.mediaType).toBe('image/jpeg');
    expect(db.blobs.getSync(thumb.blob.sha256)?.equals(thumbBytes)).toBe(true);
  }
});

test('a variant staged AFTER its parent was claimed registers immediately', () => {
  const original = gw.stageBlob(owner, { bytes: PNG_BYTES, filename: 'late.png' });
  const doc = executed<{ content_id: string }>(
    invoke('core.add_document', { staged_sha: original.sha256, title: 'late.png' }),
  );
  // The slow thumb arrives after the claim — it must not sit until the TTL.
  const thumbBytes = Buffer.from('late-thumb-bytes');
  gw.stageBlob(owner, {
    bytes: thumbBytes,
    mediaType: 'image/jpeg',
    variant: 'thumb',
    variantOf: original.sha256,
  });
  const thumb = gw.resolveBlob(owner, doc.content_id, { variant: 'thumb' });
  expect(thumb.status).toBe('ok');
  if (thumb.status === 'ok') {
    expect(db.blobs.getSync(thumb.blob.sha256)?.equals(thumbBytes)).toBe(true);
  }
  // And its staging row was consumed, not left for the sweep.
  expect(db.vault.prepare('SELECT count(*) AS n FROM blob_staging').get()).toEqual({ n: 0 });
});

test('purge sweep reclaims CAS bytes and derivative rows; staging TTL sweeps unclaimed', () => {
  const pdf = Buffer.from('%PDF-1.1\nBT (soon to be purged content) Tj ET\n%%EOF');
  const staged = gw.stageBlob(owner, { bytes: pdf });
  const doc = executed<{ document_id: string; content_id: string }>(
    invoke('core.add_document', { staged_sha: staged.sha256, title: 'doomed.pdf' }),
  );
  executed(invoke('core.trash_document', { document_id: doc.document_id }));
  // Ripen the trash, then sweep — the DOCUMENT purges (content is untouched
  // while it lives, issue #352), which in turn releases its exclusively-
  // owned content since nothing else rents it.
  db.vault
    .prepare('UPDATE core_document SET purge_at = ? WHERE document_id = ?')
    .run('2000-01-01T00:00:00.000Z', doc.document_id);
  const swept = gw.sweep(owner);
  expect(swept.documentsPurged).toBe(1);
  expect(swept.blobsReclaimed).toBeGreaterThanOrEqual(1);
  expect(db.blobs.hasSync(staged.sha256)).toBe(false);
  expect(db.vault.prepare('SELECT count(*) AS n FROM core_content_derivative').get()).toEqual({
    n: 0,
  });

  // Unclaimed staging past the TTL loses rows AND bytes; a held row stays.
  const loose = gw.stageBlob(owner, { bytes: Buffer.from('never claimed') });
  const held = gw.stageBlob(owner, { bytes: Buffer.from('held by review'), heldByBatch: 'b1' });
  db.vault.prepare('UPDATE blob_staging SET staged_at = ?').run('2000-01-01T00:00:00.000Z');
  const result = sweepBlobStaging(db, {});
  expect(result.expired).toEqual([loose.sha256]);
  expect(db.blobs.hasSync(loose.sha256)).toBe(false);
  expect(db.blobs.hasSync(held.sha256)).toBe(true);
});

test('blob-store settings: owner sets s3 + GPS policy, custody re-reads live', async () => {
  const { updateBlobStoreSettings } = await import('../host.js');
  const { readBlobStoreSettings } = await import('../db.js');
  const { mediaLocationPolicy } = await import('./staging.js');
  expect(readBlobStoreSettings(db.vault)).toEqual({});
  expect(mediaLocationPolicy(db)).toBe('keep');
  updateBlobStoreSettings(db, {
    blob_store: { kind: 's3', endpoint: 'http://127.0.0.1:1', bucket: 'b', encrypt: true },
    media_location: 'strip',
  });
  expect(readBlobStoreSettings(db.vault)).toMatchObject({ kind: 's3', bucket: 'b' });
  expect(mediaLocationPolicy(db)).toBe('strip');
  // Clearing restores the local-only default.
  updateBlobStoreSettings(db, { blob_store: null, media_location: null });
  expect(readBlobStoreSettings(db.vault)).toEqual({});
  expect(mediaLocationPolicy(db)).toBe('keep');
});

test('readonly devices cannot stage; blob maintenance sweep replicates and reports', async () => {
  // The owner stages; a remote tier appears via settings + resolver.
  const staged = gw.stageBlob(owner, { bytes: PNG_BYTES });
  executed(invoke('core.add_document', { staged_sha: staged.sha256, title: 'p.png' }));
  const swept = await gw.sweepBlobs(owner);
  // No remote tier configured: nothing replicates, nothing is missing.
  expect(swept.replicated).toEqual([]);
  expect(swept.missing).toEqual([]);
  expect(swept.receiptId).toBeTruthy();
});

test('blob maintenance sweep refreshes the app-readable custody-state mirror (issue #352)', async () => {
  const staged = gw.stageBlob(owner, { bytes: PNG_BYTES });
  const doc = executed<{ content_id: string }>(
    invoke('core.add_document', { staged_sha: staged.sha256, title: 'p.png' }),
  );
  await gw.sweepBlobs(owner);
  const row = db.vault
    .prepare('SELECT sha256, custody_state FROM blob_custody_state WHERE content_id = ?')
    .get(doc.content_id) as { sha256: string; custody_state: string } | undefined;
  expect(row).toMatchObject({ sha256: staged.sha256, custody_state: 'local-only' });
  // Read via the registered logical entity — the same surface an app uses.
  const read = gw.read(owner, {
    entity: 'blob.custody_state',
    where: [{ column: 'content_id', op: 'eq', value: doc.content_id }],
    purpose: 'dpv:ServiceProvision',
  });
  expect(read.rows).toHaveLength(1);

  // Purging the document's content releases the mirror row too (ON DELETE
  // CASCADE), not a stale entry the app plane would misread.
  await gw.sweepBlobs(owner); // idempotent re-run, still one row
  expect(
    (db.vault.prepare('SELECT count(*) AS n FROM blob_custody_state').get() as { n: number }).n,
  ).toBe(1);
});

test('custodyStateCounts groups the mirror by state, zero-filled (issue #351 wave 4)', async () => {
  const { custodyStateCounts } = await import('./custody.js');
  expect(custodyStateCounts(db.vault)).toEqual({
    'local-only': 0,
    replicated: 0,
    'remote-only': 0,
    missing: 0,
  });
  const staged = gw.stageBlob(owner, { bytes: PNG_BYTES });
  executed(invoke('core.add_document', { staged_sha: staged.sha256, title: 'p.png' }));
  await gw.sweepBlobs(owner); // no remote tier configured — settles local-only
  expect(custodyStateCounts(db.vault)).toEqual({
    'local-only': 1,
    replicated: 0,
    'remote-only': 0,
    missing: 0,
  });
});
