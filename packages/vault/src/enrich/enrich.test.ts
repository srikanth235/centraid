// The enrichment spine, vault side (issue #299 phases 1–5 plumbing):
// derived data lands as ontology rows through the staging spine, attribution
// is injected server-side and owner assertions are terminal, the owner's
// auto-publish trust is what lets captions land without a review click, and
// the agent content primitive only ever spells derivatives.

import { beforeEach, describe, expect, test } from 'vitest';
import {
  bootstrapVault,
  createGrant,
  enrollAgent,
  enrollDevice,
  type BootstrapResult,
} from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import { registerDocumentCommands } from '../commands/documents.js';
import { registerEnrichCommands } from '../commands/enrich.js';
import { registerMediaCommands } from '../commands/media.js';
import { registerSyncCommands } from '../commands/sync.js';
import type { Credential } from '../gateway/types.js';
import { readEnrichSettings, updateEnrichSettings } from '../host.js';
import { VISION_SCHEME_URI } from '../schema/enrich.js';
import { hexHamming, encodeVector, decodeVector, cosine, scanEmbeddings } from './similarity.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;
let agent: Credential;
let agentPartyId: string;

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerDocumentCommands(gw);
  registerEnrichCommands(gw);
  registerMediaCommands(gw);
  registerSyncCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
  const enrolled = enrollAgent(db, { name: 'photo-captioner', modelRef: 'tier:fast' });
  agentPartyId = enrolled.partyId;
  const device = enrollDevice(db, boot.ownerPartyId, 'agent-host');
  createGrant(db, {
    granteePartyId: enrolled.partyId,
    purposeConceptId: boot.concepts['dpv:ServiceProvision'] as string,
    grantedByPartyId: boot.ownerPartyId,
    scopes: [
      { schema: 'sync', verbs: 'act' },
      { schema: 'core', verbs: 'read+act' },
      { schema: 'media', verbs: 'read' },
      { schema: 'knowledge', verbs: 'read' },
      { schema: 'enrich', verbs: 'act' },
    ],
  });
  agent = {
    kind: 'agent',
    agentId: enrolled.agentId,
    deviceId: device.deviceId,
    deviceKey: device.deviceKey,
  };
});

function invoke(cred: Credential, command: string, input: Record<string, unknown>) {
  return gw.invoke(cred, { command, input, purpose: 'dpv:ServiceProvision' });
}

function output<T>(outcome: unknown): T {
  return (outcome as { output: T }).output;
}

/** Stage a pixel + claim it as a photo; returns asset + content ids. */
function addPhoto(phash?: string): { assetId: string; contentId: string } {
  const staged = gw.stageBlob(owner, { bytes: PNG_BYTES, filename: 'pixel.png' });
  const out = output<{ asset_id: string; content_id: string }>(
    invoke(owner, 'media.add_asset', {
      staged_sha: staged.sha256,
      ...(phash ? { phash } : {}),
    }),
  );
  return { assetId: out.asset_id, contentId: out.content_id };
}

describe('v10 schema', () => {
  test('phash sidecar, machine schemes, enrich tables', () => {
    expect(() =>
      db.vault.prepare('SELECT phash FROM media_asset_phash LIMIT 1').all(),
    ).not.toThrow();
    const schemes = db.vault
      .prepare('SELECT uri FROM core_concept_scheme WHERE uri LIKE ?')
      .all('urn:centraid:%') as { uri: string }[];
    expect(schemes.map((s) => s.uri).sort()).toEqual([
      'urn:centraid:doctype',
      'urn:centraid:vision',
    ]);
    expect(() => db.vault.prepare('SELECT 1 FROM enrich_embedding').all()).not.toThrow();
    expect(() => db.vault.prepare('SELECT 1 FROM enrich_request').all()).not.toThrow();
  });

  test('vault_hamming is registered and near-dup SQL works', () => {
    expect(hexHamming('ff00', 'ff01')).toBe(1);
    expect(hexHamming('ff00', 'ff0')).toBeNull();
    const row = db.vault.prepare("SELECT vault_hamming('deadbeef', 'deadbee0') AS d").get() as {
      d: number;
    };
    expect(row.d).toBe(4); // f ^ 0 = 4 bits
    addPhoto('a1b2c3d4e5f60708');
    const near = db.vault
      .prepare('SELECT asset_id FROM media_asset_phash WHERE vault_hamming(phash, ?) <= 2')
      .all('a1b2c3d4e5f60709') as { asset_id: string }[];
    expect(near.length).toBe(1);
  });
});

describe('the enrichment staging path', () => {
  test('captions stage as drafts by default; owner trust flips to auto-publish; FTS finds the photo caption', () => {
    const { assetId } = addPhoto();
    const rows = [
      {
        entity_type: 'knowledge.annotation',
        external_id: `${assetId}:caption`,
        payload: {
          target_type: 'media.media_asset',
          target_id: assetId,
          body: 'Two kids building a sandcastle at the beach',
        },
      },
    ];
    const staged = invoke(agent, 'sync.stage_rows', {
      kind: 'enrichment.vision',
      label: 'photos',
      rows,
    });
    expect(staged.status).toBe('executed');
    const stagedOut = output<{ connection_id: string; published?: unknown }>(staged);
    expect(stagedOut.published).toBeUndefined(); // default trust = staged
    expect(
      (db.vault.prepare('SELECT count(*) AS n FROM knowledge_annotation').get() as { n: number }).n,
    ).toBe(0);

    // The agent proposing to widen its own trust PARKS (risk high).
    const proposal = invoke(agent, 'sync.set_connection_trust', {
      connection_id: stagedOut.connection_id,
      trust: 'auto-publish',
    });
    expect(proposal.status).toBe('parked');
    // The owner flips it directly.
    const flip = invoke(owner, 'sync.set_connection_trust', {
      connection_id: stagedOut.connection_id,
      trust: 'auto-publish',
    });
    expect(flip.status).toBe('executed');

    // Same rows again: the draft batch dedup skips nothing (nothing landed),
    // and this time the batch auto-publishes in the same command.
    const again = invoke(agent, 'sync.stage_rows', {
      kind: 'enrichment.vision',
      label: 'photos',
      rows,
    });
    expect(again.status).toBe('executed');
    const published = output<{ published: { created: number } }>(again).published;
    expect(published.created).toBe(1);

    // Attribution is the ENRICHER's agent party, injected server-side.
    const annotation = db.vault
      .prepare('SELECT author_party_id, body_text FROM knowledge_annotation WHERE target_id = ?')
      .get(assetId) as { author_party_id: string; body_text: string };
    expect(annotation.author_party_id).toBe(agentPartyId);

    // FTS: "search photos by what's in them" via the caption.
    const hits = gw.search(owner, {
      entity: 'knowledge.annotation',
      query: 'sandcastle',
      purpose: 'dpv:ServiceProvision',
    }) as { rows: unknown[] };
    expect(hits.rows.length).toBe(1);

    // Idempotency: unchanged caption re-stages as skip (external-id map).
    const third = invoke(agent, 'sync.stage_rows', {
      kind: 'enrichment.vision',
      label: 'photos',
      rows,
    });
    expect(output<{ staged: { skip: number } }>(third).staged.skip).toBe(1);

    // A model upgrade (changed caption) updates the enricher's OWN row.
    const upgraded = [
      {
        ...rows[0]!,
        payload: { ...rows[0]!.payload, body: 'Kids at the beach with a red bucket' },
      },
    ];
    invoke(agent, 'sync.stage_rows', {
      kind: 'enrichment.vision',
      label: 'photos',
      rows: upgraded,
    });
    const after = db.vault
      .prepare('SELECT body_text FROM knowledge_annotation WHERE target_id = ?')
      .all(assetId) as { body_text: string }[];
    expect(after.length).toBe(1);
    expect(after[0]!.body_text).toContain('red bucket');
  });

  test('machine tags carry confidence and never overwrite an owner-asserted tag', () => {
    const { assetId } = addPhoto();
    const stagedConn = invoke(agent, 'sync.stage_rows', {
      kind: 'enrichment.vision',
      label: 'photos',
      rows: [
        {
          entity_type: 'core.tag',
          external_id: `${assetId}:tag:beach`,
          payload: {
            target_type: 'media.media_asset',
            target_id: assetId,
            label: 'Beach',
            confidence: 0.92,
          },
        },
      ],
    });
    const connectionId = output<{ connection_id: string }>(stagedConn).connection_id;
    invoke(owner, 'sync.set_connection_trust', {
      connection_id: connectionId,
      trust: 'auto-publish',
    });
    invoke(agent, 'sync.stage_rows', {
      kind: 'enrichment.vision',
      label: 'photos',
      rows: [
        {
          entity_type: 'core.tag',
          external_id: `${assetId}:tag:beach`,
          payload: {
            target_type: 'media.media_asset',
            target_id: assetId,
            label: 'Beach',
            confidence: 0.92,
          },
        },
      ],
    });
    const tag = db.vault
      .prepare(
        `SELECT t.confidence, t.tagged_by_party_id, c.notation, s.uri FROM core_tag t
           JOIN core_concept c ON c.concept_id = t.concept_id
           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
          WHERE t.target_id = ?`,
      )
      .get(assetId) as {
      confidence: number;
      tagged_by_party_id: null;
      notation: string;
      uri: string;
    };
    expect(tag.uri).toBe(VISION_SCHEME_URI);
    expect(tag.notation).toBe('beach');
    expect(tag.confidence).toBeCloseTo(0.92);
    expect(tag.tagged_by_party_id).toBeNull(); // machine tag, never a person

    // The owner asserts the same concept: convert to an owner tag.
    db.vault
      .prepare('UPDATE core_tag SET tagged_by_party_id = ?, confidence = NULL WHERE target_id = ?')
      .run(boot.ownerPartyId, assetId);
    // The enricher re-runs with a different confidence — terminal, skipped.
    invoke(agent, 'sync.stage_rows', {
      kind: 'enrichment.vision',
      label: 'photos',
      rows: [
        {
          entity_type: 'core.tag',
          external_id: `${assetId}:tag:beach-2`,
          payload: {
            target_type: 'media.media_asset',
            target_id: assetId,
            label: 'Beach',
            confidence: 0.5,
          },
        },
      ],
    });
    const after = db.vault
      .prepare('SELECT confidence, tagged_by_party_id FROM core_tag WHERE target_id = ?')
      .get(assetId) as { confidence: number | null; tagged_by_party_id: string };
    expect(after.tagged_by_party_id).toBe(boot.ownerPartyId);
    expect(after.confidence).toBeNull();
  });

  test('face proposals land unconfirmed; confirm/reject is the owner loop; confirmed regions are immune', () => {
    const { assetId } = addPhoto();
    const conn = invoke(agent, 'sync.stage_rows', {
      kind: 'enrichment.vision',
      label: 'photos',
      rows: [
        {
          entity_type: 'media.face_region',
          external_id: `${assetId}:face:0`,
          payload: { asset_id: assetId, bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.3 }, confidence: 0.8 },
        },
      ],
    });
    const connectionId = output<{ connection_id: string }>(conn).connection_id;
    invoke(owner, 'sync.set_connection_trust', {
      connection_id: connectionId,
      trust: 'auto-publish',
    });
    invoke(agent, 'sync.stage_rows', {
      kind: 'enrichment.vision',
      label: 'photos',
      rows: [
        {
          entity_type: 'media.face_region',
          external_id: `${assetId}:face:0`,
          payload: { asset_id: assetId, bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.3 }, confidence: 0.8 },
        },
      ],
    });
    const region = db.vault
      .prepare('SELECT region_id, confirmed_by_party_id FROM media_face_region WHERE asset_id = ?')
      .get(assetId) as { region_id: string; confirmed_by_party_id: null };
    expect(region.confirmed_by_party_id).toBeNull();

    const confirmed = invoke(owner, 'media.confirm_face', {
      region_id: region.region_id,
      party_id: boot.ownerPartyId,
    });
    expect(confirmed.status).toBe('executed');

    // A re-run proposing a different box no longer touches the region.
    invoke(agent, 'sync.stage_rows', {
      kind: 'enrichment.vision',
      label: 'photos',
      rows: [
        {
          entity_type: 'media.face_region',
          external_id: `${assetId}:face:0`,
          payload: { asset_id: assetId, bbox: { x: 0.9, y: 0.9, w: 0.1, h: 0.1 }, confidence: 0.3 },
        },
      ],
    });
    const after = db.vault
      .prepare('SELECT bbox_json, confidence FROM media_face_region WHERE region_id = ?')
      .get(region.region_id) as { bbox_json: string; confidence: number };
    expect(JSON.parse(after.bbox_json).x).toBeCloseTo(0.1);
    expect(after.confidence).toBeCloseTo(0.8);

    const rejected = invoke(owner, 'media.reject_face', { region_id: region.region_id });
    expect(rejected.status).toBe('executed');
    expect(
      (db.vault.prepare('SELECT count(*) AS n FROM media_face_region').get() as { n: number }).n,
    ).toBe(0);
  });

  test('album proposals stay staged for review; publish creates the collection and top-ups never remove', () => {
    const a = addPhoto();
    const b = addPhoto(); // same bytes dedupe to one asset — use ids we have
    const staged = invoke(owner, 'sync.stage_rows', {
      kind: 'enrichment.cluster',
      label: 'trips',
      rows: [
        {
          entity_type: 'core.collection',
          external_id: 'trip:2026-06-goa',
          payload: {
            name: 'Goa, June 2026',
            members: [
              { target_type: 'media.media_asset', target_id: a.assetId },
              { target_type: 'media.media_asset', target_id: b.assetId },
            ],
          },
        },
      ],
    });
    const batchId = output<{ batch_id: string }>(staged).batch_id;
    expect(
      (db.vault.prepare('SELECT count(*) AS n FROM core_collection').get() as { n: number }).n,
    ).toBe(0);
    const published = invoke(owner, 'sync.publish_batch', { batch_id: batchId });
    expect(published.status).toBe('executed');
    const entries = db.vault
      .prepare(
        `SELECT count(*) AS n FROM core_collection_entry e
           JOIN core_collection c ON c.collection_id = e.collection_id
          WHERE c.name = 'Goa, June 2026'`,
      )
      .get() as { n: number };
    expect(entries.n).toBe(1); // deduped photo = one distinct asset
  });

  test('filing proposals update title + folder tag and never mint documents', () => {
    const staged = gw.stageBlob(owner, {
      bytes: Buffer.from('scan scan scan'),
      filename: 'scan_001.txt',
    });
    const doc = output<{ content_id: string }>(
      invoke(owner, 'core.add_document', { staged_sha: staged.sha256, title: 'scan_001' }),
    );
    const stagedBatch = invoke(owner, 'sync.stage_rows', {
      kind: 'enrichment.doctype',
      label: 'docs',
      rows: [
        {
          entity_type: 'core.content_item',
          external_id: `${doc.content_id}:filing`,
          payload: {
            content_id: doc.content_id,
            title: 'Home insurance policy 2026',
            folder: 'Insurance',
          },
        },
        {
          entity_type: 'core.content_item',
          external_id: 'missing:filing',
          payload: { content_id: 'does-not-exist', title: 'nope' },
        },
      ],
    });
    const batchId = output<{ batch_id: string }>(stagedBatch).batch_id;
    const published = output<{ created: number; updated: number; failed: number }>(
      invoke(owner, 'sync.publish_batch', { batch_id: batchId }),
    );
    expect(published.updated).toBe(1);
    expect(published.failed).toBe(1); // the missing doc refused to create
    const item = db.vault
      .prepare('SELECT title FROM core_content_item WHERE content_id = ?')
      .get(doc.content_id) as { title: string };
    expect(item.title).toBe('Home insurance policy 2026');
    const folder = db.vault
      .prepare(
        `SELECT c.pref_label FROM core_tag t
           JOIN core_concept c ON c.concept_id = t.concept_id
          WHERE t.target_id = ? AND t.target_type = 'core.content_item'`,
      )
      .get(doc.content_id) as { pref_label: string };
    expect(folder.pref_label).toBe('Insurance');
  });
});

describe('core.set_extracted_text', () => {
  test('writes the text derivative and the PARENT document becomes searchable', () => {
    const staged = gw.stageBlob(owner, { bytes: PNG_BYTES, filename: 'scanned.png' });
    const doc = output<{ content_id: string }>(
      invoke(owner, 'core.add_document', { staged_sha: staged.sha256, title: 'scan' }),
    );
    const set = invoke(agent, 'core.set_extracted_text', {
      content_id: doc.content_id,
      text: 'Warranty expires 2027-03-01 for the espresso machine',
    });
    expect(set.status).toBe('executed');
    const hits = gw.search(owner, {
      entity: 'core.content_item',
      query: 'espresso',
      purpose: 'dpv:ServiceProvision',
    }) as { rows: { id: string }[] };
    expect(hits.rows.length).toBe(1);
    // Re-extraction replaces in place (re-derivable).
    invoke(agent, 'core.set_extracted_text', {
      content_id: doc.content_id,
      text: 'better OCR text',
    });
    const derivatives = db.vault
      .prepare(
        `SELECT count(*) AS n FROM core_content_derivative WHERE content_id = ? AND variant = 'text'`,
      )
      .get(doc.content_id) as { n: number };
    expect(derivatives.n).toBe(1);
  });
});

describe('agent content access (the #296 §7 seam)', () => {
  test('text and thumb variants serve size-bounded; originals are structurally unreachable; every fetch receipts', async () => {
    const original = gw.stageBlob(owner, { bytes: PNG_BYTES, filename: 'photo.png' });
    gw.stageBlob(owner, {
      bytes: Buffer.from('tiny-thumb-bytes'),
      mediaType: 'image/jpeg',
      variant: 'thumb',
      variantOf: original.sha256,
    });
    const asset = output<{ content_id: string }>(
      invoke(owner, 'media.add_asset', { staged_sha: original.sha256 }),
    );

    const thumb = await gw.contentForAgent(agent, {
      contentId: asset.content_id,
      variant: 'thumb',
    });
    expect(thumb.status).toBe('ok');
    if (thumb.status === 'ok' && thumb.kind === 'bytes') {
      expect(Buffer.from(thumb.base64, 'base64').toString()).toBe('tiny-thumb-bytes');
      expect(thumb.mediaType).toBe('image/jpeg');
    }

    // Originals are not a spelling this surface has.
    await expect(
      gw.contentForAgent(agent, { contentId: asset.content_id, variant: 'original' }),
    ).rejects.toThrow(/derivatives egress, never originals/);

    // The text variant reads the derivative row.
    invoke(agent, 'core.set_extracted_text', { content_id: asset.content_id, text: 'hello text' });
    const text = await gw.contentForAgent(agent, { contentId: asset.content_id, variant: 'text' });
    expect(text.status).toBe('ok');
    if (text.status === 'ok' && text.kind === 'text') expect(text.text).toBe('hello text');

    // A missing variant is a clean miss.
    const preview = await gw.contentForAgent(agent, {
      contentId: asset.content_id,
      variant: 'preview',
    });
    expect(preview.status).toBe('no-variant');

    // The size cap refuses oversized variants.
    const tooSmallCap = await gw.contentForAgent(agent, {
      contentId: asset.content_id,
      variant: 'thumb',
      maxBytes: 4,
    });
    expect(tooSmallCap.status).toBe('too-large');

    // Every fetch (allow AND deny) wrote an agent-content receipt.
    const receipts = db.journal
      .prepare(`SELECT count(*) AS n FROM consent_receipt WHERE detail_json LIKE '%agent-content%'`)
      .get() as { n: number };
    expect(receipts.n).toBeGreaterThanOrEqual(4);
  });
});

describe('phase-5 surfaces', () => {
  test('embeddings upsert + cosine scan; request queue records and reads back', () => {
    const { assetId } = addPhoto();
    const up = invoke(agent, 'enrich.upsert_embedding', {
      entity_type: 'media.media_asset',
      entity_id: assetId,
      model: 'stub-embedder-v1',
      vector: [1, 0, 0],
    });
    expect(up.status).toBe('executed');
    invoke(agent, 'enrich.upsert_embedding', {
      entity_type: 'media.media_asset',
      entity_id: assetId,
      model: 'stub-embedder-v1',
      vector: [0.9, 0.1, 0],
    });
    expect(
      (db.vault.prepare('SELECT count(*) AS n FROM enrich_embedding').get() as { n: number }).n,
    ).toBe(1); // upsert, not append
    const hits = scanEmbeddings(db.vault, 'stub-embedder-v1', [1, 0, 0], { limit: 5 });
    expect(hits[0]!.entityId).toBe(assetId);
    expect(hits[0]!.score).toBeGreaterThan(0.9);
    expect(cosine(decodeVector(encodeVector([1, 2, 3])), Float32Array.from([1, 2, 3]))).toBeCloseTo(
      1,
    );

    const req = invoke(owner, 'enrich.request_enrichment', {
      entity_type: 'media.media_asset',
      reason: 'search-miss',
      detail: 'sunset over the lake',
    });
    expect(req.status).toBe('executed');
    const open = db.vault
      .prepare('SELECT reason, detail FROM enrich_request WHERE drained_at IS NULL')
      .all() as { reason: string; detail: string }[];
    expect(open.length).toBe(1);
    expect(open[0]!.reason).toBe('search-miss');
  });
});

describe('enrich settings', () => {
  test('default is local; updates persist; junk refused', () => {
    expect(readEnrichSettings(db)).toEqual({ photos: 'local', docs: 'local' });
    updateEnrichSettings(db, { photos: 'model' });
    expect(readEnrichSettings(db)).toEqual({ photos: 'model', docs: 'local' });
    updateEnrichSettings(db, { photos: null, docs: 'off' });
    expect(readEnrichSettings(db)).toEqual({ photos: 'local', docs: 'off' });
    expect(() => updateEnrichSettings(db, { docs: 'sometimes' as never })).toThrow(
      /must be one of/,
    );
  });
});
