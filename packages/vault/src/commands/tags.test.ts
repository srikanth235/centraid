import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import type { Credential } from '../gateway/types.js';
import { registerDocumentCommands } from './documents.js';
import { registerMediaCommands } from './media.js';
import { LABELS_SCHEME_URI, registerTagCommands } from './tags.js';

const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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
  registerTagCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
});

function invoke(command: string, input: Record<string, unknown>) {
  return gw.invoke(owner, { command, input, purpose: 'dpv:ServiceProvision' });
}

function addDocument(): string {
  const outcome = invoke('core.add_document', {
    data_uri: 'data:text/plain;charset=utf-8,hello',
    title: 'Lease',
  });
  expect(outcome.status).toBe('executed');
  return (outcome as { output: { document_id: string } }).output.document_id;
}

function addAsset(): string {
  const outcome = invoke('media.add_asset', { data_uri: PIXEL });
  expect(outcome.status).toBe('executed');
  return (outcome as { output: { asset_id: string } }).output.asset_id;
}

test('tag_entity bootstraps the labels scheme and lands a live core.tag', () => {
  const documentId = addDocument();
  const outcome = invoke('core.tag_entity', {
    target_type: 'core.document',
    target_id: documentId,
    label: 'Taxes',
  });
  expect(outcome.status).toBe('executed');
  const scheme = db.vault
    .prepare('SELECT scheme_id FROM core_concept_scheme WHERE uri = ?')
    .get(LABELS_SCHEME_URI) as { scheme_id: string };
  expect(scheme).toBeDefined();
  const tag = db.vault
    .prepare(
      `SELECT t.tag_id FROM core_tag t
         JOIN core_concept c ON c.concept_id = t.concept_id
        WHERE t.target_type = 'core.document' AND t.target_id = ? AND c.notation = 'taxes'`,
    )
    .get(documentId);
  expect(tag).toBeDefined();
});

/** Count only LABELS-scheme tags — core.add_document also files one
 * folders-scheme tag on every document (documents.ts), which is a separate
 * single-tag mechanism these tests must not conflate with. */
function countLabelTags(targetType: string, targetId: string): number {
  return (
    db.vault
      .prepare(
        `SELECT count(*) AS n FROM core_tag t
           JOIN core_concept c ON c.concept_id = t.concept_id
           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
          WHERE t.target_type = ? AND t.target_id = ? AND s.uri = ?`,
      )
      .get(targetType, targetId, LABELS_SCHEME_URI) as { n: number }
  ).n;
}

test('tagging is additive and multi-label — core.tag stays multi-valued', () => {
  const documentId = addDocument();
  invoke('core.tag_entity', { target_type: 'core.document', target_id: documentId, label: 'Taxes' });
  invoke('core.tag_entity', {
    target_type: 'core.document',
    target_id: documentId,
    label: 'Important',
  });
  expect(countLabelTags('core.document', documentId)).toBe(2);
});

test('re-tagging the same label is idempotent (case/whitespace insensitive identity)', () => {
  const documentId = addDocument();
  const a = invoke('core.tag_entity', {
    target_type: 'core.document',
    target_id: documentId,
    label: 'Taxes',
  });
  const b = invoke('core.tag_entity', {
    target_type: 'core.document',
    target_id: documentId,
    label: '  taxes  ',
  });
  expect(a.status).toBe('executed');
  expect(b.status).toBe('executed');
  expect(countLabelTags('core.document', documentId)).toBe(1);
});

test('untag_entity removes exactly the named label, leaving others intact', () => {
  const assetId = addAsset();
  invoke('core.tag_entity', { target_type: 'media.media_asset', target_id: assetId, label: 'Trip' });
  invoke('core.tag_entity', {
    target_type: 'media.media_asset',
    target_id: assetId,
    label: 'Beach',
  });
  const outcome = invoke('core.untag_entity', {
    target_type: 'media.media_asset',
    target_id: assetId,
    label: 'Trip',
  });
  expect(outcome.status).toBe('executed');
  const remaining = db.vault
    .prepare(
      `SELECT c.notation FROM core_tag t JOIN core_concept c ON c.concept_id = t.concept_id
        WHERE t.target_type = ? AND t.target_id = ?`,
    )
    .all('media.media_asset', assetId) as { notation: string }[];
  expect(remaining.map((r) => r.notation)).toEqual(['beach']);
});

test('untag_entity on a label never applied fails loudly', () => {
  const assetId = addAsset();
  const outcome = invoke('core.untag_entity', {
    target_type: 'media.media_asset',
    target_id: assetId,
    label: 'Nope',
  });
  expect(outcome.status).not.toBe('executed');
});

test('tag_entity refuses an unknown/trashed target', () => {
  const missing = invoke('core.tag_entity', {
    target_type: 'core.document',
    target_id: 'does-not-exist',
    label: 'Taxes',
  });
  expect(missing.status).not.toBe('executed');

  const documentId = addDocument();
  invoke('core.trash_document', { document_id: documentId });
  const trashed = invoke('core.tag_entity', {
    target_type: 'core.document',
    target_id: documentId,
    label: 'Taxes',
  });
  expect(trashed.status).not.toBe('executed');
});

test('tag_entity refuses a target type outside the allow-list', () => {
  const outcome = invoke('core.tag_entity', {
    target_type: 'core.party',
    target_id: boot.ownerPartyId,
    label: 'VIP',
  });
  expect(outcome.status).not.toBe('executed');
});

test('labels are already readable through the standard entity read path (no new query needed)', () => {
  const documentId = addDocument();
  invoke('core.tag_entity', { target_type: 'core.document', target_id: documentId, label: 'Taxes' });
  // The exact three-read pattern an app-plane query already uses for the
  // flags-scheme star (photos/queries/library.js) works verbatim for labels.
  const scheme = gw.read(owner, {
    entity: 'core.concept_scheme',
    where: [{ column: 'uri', op: 'eq', value: LABELS_SCHEME_URI }],
    purpose: 'dpv:ServiceProvision',
  }).rows[0] as { scheme_id: string };
  const concepts = gw.read(owner, {
    entity: 'core.concept',
    where: [{ column: 'scheme_id', op: 'eq', value: scheme.scheme_id }],
    purpose: 'dpv:ServiceProvision',
  }).rows;
  const tags = gw.read(owner, {
    entity: 'core.tag',
    where: [
      { column: 'target_type', op: 'eq', value: 'core.document' },
      { column: 'target_id', op: 'eq', value: documentId },
    ],
    purpose: 'dpv:ServiceProvision',
  }).rows;
  const labelIds = new Set(tags.map((t) => t.concept_id));
  const labels = concepts.filter((c) => labelIds.has(c.concept_id)).map((c) => c.pref_label);
  expect(labels).toEqual(['Taxes']);
});
