import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, createGrant, enrollApp, type BootstrapResult } from '../bootstrap.js';
import { registerKnowledgeCommands } from '../commands/knowledge.js';
import { registerLinkCommands } from '../commands/links.js';
import { registerMediaCommands } from '../commands/media.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from './gateway.js';
import type { Credential } from './types.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const PURPOSE = 'dpv:ServiceProvision';

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerLinkCommands(gw);
  registerKnowledgeCommands(gw);
  registerMediaCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
});

function invoke(cred: Credential, command: string, input: Record<string, unknown>) {
  return gw.invoke(cred, { command, input, purpose: PURPOSE });
}

function addNote(title: string): string {
  const out = invoke(owner, 'knowledge.create_note', { title, body_text: `${title} body` });
  expect(out.status).toBe('executed');
  return (out as { output: { note_id: string } }).output.note_id;
}

function addPhoto(title: string): string {
  const out = invoke(owner, 'media.add_asset', { data_uri: PNG, title });
  expect(out.status).toBe('executed');
  return (out as { output: { asset_id: string } }).output.asset_id;
}

test('the owner resolves cards for any known entity; unknown types come back as unknown', () => {
  const noteId = addNote('Trip');
  const assetId = addPhoto('Beach');
  const { cards, receiptId } = gw.resolveRefs(owner, {
    refs: [
      { type: 'knowledge.note', id: noteId },
      { type: 'media.media_asset', id: assetId },
      { type: 'not.an-entity', id: 'x' },
      { type: 'knowledge.note', id: 'no-such-note' },
    ],
    purpose: PURPOSE,
  });
  expect(receiptId).toBeTruthy();
  expect(cards).toHaveLength(4);
  expect(cards[0]).toMatchObject({ status: 'live', title: 'Trip' });
  expect(cards[1]).toMatchObject({ status: 'live', title: 'Beach' });
  expect(cards[1]?.thumbnail_content_id).toBeTruthy();
  expect(cards[2]?.status).toBe('unknown');
  expect(cards[3]?.status).toBe('missing');
});

test('a trashed media asset resolves as trashed, not missing', () => {
  const assetId = addPhoto('Doomed');
  expect(invoke(owner, 'media.delete_asset', { asset_id: assetId }).status).toBe('executed');
  const { cards } = gw.resolveRefs(owner, {
    refs: [{ type: 'media.media_asset', id: assetId }],
    purpose: PURPOSE,
  });
  expect(cards[0]?.status).toBe('trashed');
});

test('resolvable-if-linked: an app renders a foreign entity ONLY through a live link to something it reads', () => {
  const noteId = addNote('Has a photo');
  const assetId = addPhoto('Linked photo');
  const app = enrollApp(db, { name: 'notes-app' });
  const appCred: Credential = { kind: 'app', appId: app.appId, signingKey: app.signingKey };
  // The app reads knowledge (its own domain) — media is deliberately absent.
  createGrant(db, {
    appId: app.appId,
    purposeConceptId: boot.concepts['dpv:ServiceProvision'] ?? '',
    grantedByPartyId: boot.ownerPartyId,
    scopes: [
      { schema: 'knowledge', verbs: 'read' },
      { schema: 'core', table: 'link', verbs: 'read' },
    ],
  });

  // Before any link exists, the foreign asset is a denied card.
  const before = gw.resolveRefs(appCred, {
    refs: [{ type: 'media.media_asset', id: assetId }],
    purpose: PURPOSE,
  });
  expect(before.cards[0]?.status).toBe('denied');

  // The owner links note → asset (the shell-picker flow); now the same
  // ref resolves for the app, because the link's other end is readable.
  const linked = invoke(owner, 'core.link_entities', {
    from_type: 'knowledge.note',
    from_id: noteId,
    to_type: 'media.media_asset',
    to_id: assetId,
    relation: 'references',
  });
  expect(linked.status).toBe('executed');
  const after = gw.resolveRefs(appCred, {
    refs: [{ type: 'media.media_asset', id: assetId }],
    purpose: PURPOSE,
  });
  expect(after.cards[0]).toMatchObject({ status: 'live', title: 'Linked photo' });

  // Unlink ends the authorization along with the relationship.
  const linkId = (linked as { output: { link_id: string } }).output.link_id;
  expect(invoke(owner, 'core.unlink_entities', { link_id: linkId }).status).toBe('executed');
  const ended = gw.resolveRefs(appCred, {
    refs: [{ type: 'media.media_asset', id: assetId }],
    purpose: PURPOSE,
  });
  expect(ended.cards[0]?.status).toBe('denied');
});

test('hard-deleting a linked endpoint leaves a tombstone card for the survivor side', () => {
  const noteId = addNote('Doomed note');
  const assetId = addPhoto('Survivor');
  invoke(owner, 'core.link_entities', {
    from_type: 'knowledge.note',
    from_id: noteId,
    to_type: 'media.media_asset',
    to_id: assetId,
    relation: 'references',
  });
  expect(invoke(owner, 'knowledge.delete_note', { note_id: noteId }).status).toBe('executed');
  const { cards } = gw.resolveRefs(owner, {
    refs: [{ type: 'knowledge.note', id: noteId }],
    purpose: PURPOSE,
  });
  expect(cards[0]?.status).toBe('missing'); // the tombstone
});
