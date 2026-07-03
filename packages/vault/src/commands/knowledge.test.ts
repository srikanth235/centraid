import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import type { Credential } from '../gateway/types.js';
import { registerKnowledgeCommands } from './knowledge.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerKnowledgeCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
});

function invoke(command: string, input: Record<string, unknown>) {
  return gw.invoke(owner, { command, input, purpose: 'dpv:ServiceProvision' });
}

function createNotebook(name: string, parent?: string): string {
  const outcome = invoke('knowledge.create_notebook', {
    name,
    ...(parent ? { parent_notebook_id: parent } : {}),
  });
  expect(outcome.status).toBe('executed');
  return (outcome as { output: { notebook_id: string } }).output.notebook_id;
}

function createNote(input: Record<string, unknown>): { note_id: string; body_content_id: string } {
  const outcome = invoke('knowledge.create_note', input);
  expect(outcome.status).toBe('executed');
  return (outcome as { output: { note_id: string; body_content_id: string } }).output;
}

test('create_note stores the body as a canonical content item and defaults to plain', () => {
  const { note_id, body_content_id } = createNote({
    title: 'Packing list',
    body_text: 'Sunscreen & sandals',
  });
  const note = db.vault.prepare('SELECT * FROM knowledge_note WHERE note_id = ?').get(note_id);
  expect(note).toMatchObject({
    title: 'Packing list',
    format: 'plain',
    pinned: 0,
    body_content_id,
    author_party_id: boot.ownerPartyId,
  });
  const content = db.vault
    .prepare('SELECT media_type, content_uri FROM core_content_item WHERE content_id = ?')
    .get(body_content_id) as { media_type: string; content_uri: string };
  expect(content.media_type).toBe('text/plain');
  expect(decodeURIComponent(content.content_uri.split(',')[1] ?? '')).toBe('Sunscreen & sandals');
});

test('create_note dedupes identical bodies on sha256', () => {
  const first = createNote({ title: 'One', body_text: 'same words' });
  const second = createNote({ title: 'Two', body_text: 'same words' });
  expect(second.body_content_id).toBe(first.body_content_id);
  const n = db.vault.prepare('SELECT count(*) AS n FROM core_content_item').get() as { n: number };
  expect(n.n).toBe(1);
});

test('create_note files into a notebook at the end; a missing notebook is refused', () => {
  const nb = createNotebook('Travel');
  const a = createNote({ title: 'A', body_text: 'a', notebook_id: nb });
  const b = createNote({ title: 'B', body_text: 'b', notebook_id: nb });
  const placements = db.vault
    .prepare(
      'SELECT note_id, position FROM knowledge_note_placement WHERE notebook_id = ? ORDER BY position',
    )
    .all(nb) as { note_id: string; position: number }[];
  expect(placements.map((p) => p.note_id)).toEqual([a.note_id, b.note_id]);
  expect(placements[1]!.position).toBeGreaterThan(placements[0]!.position);

  const orphan = invoke('knowledge.create_note', {
    title: 'Lost',
    body_text: 'x',
    notebook_id: 'no-such-notebook',
  });
  expect(orphan.status).toBe('failed');
  if (orphan.status === 'failed') expect(orphan.predicate).toContain('notebook_exists_if_given');
});

test('edit_note updates only the fields sent; a body edit re-points the reference', () => {
  const { note_id, body_content_id } = createNote({
    title: 'Draft',
    body_text: 'v1',
    format: 'markdown',
  });
  const outcome = invoke('knowledge.edit_note', { note_id, body_text: 'v2', pinned: 1 });
  expect(outcome.status).toBe('executed');
  const note = db.vault
    .prepare('SELECT title, format, pinned, body_content_id FROM knowledge_note WHERE note_id = ?')
    .get(note_id) as { title: string; format: string; pinned: number; body_content_id: string };
  expect(note).toMatchObject({ title: 'Draft', format: 'markdown', pinned: 1 });
  expect(note.body_content_id).not.toBe(body_content_id);
  const media = db.vault
    .prepare('SELECT media_type FROM core_content_item WHERE content_id = ?')
    .get(note.body_content_id) as { media_type: string };
  expect(media.media_type).toBe('text/markdown'); // inherits the note's format
});

test('edit_note on an unknown note is refused by precondition', () => {
  const outcome = invoke('knowledge.edit_note', { note_id: 'ghost', title: 'New' });
  expect(outcome.status).toBe('failed');
  if (outcome.status === 'failed') expect(outcome.predicate).toContain('note_exists');
});

test('move_note refiles, is single-placement, and omitting notebook_id unfiles', () => {
  const travel = createNotebook('Travel');
  const work = createNotebook('Work');
  const { note_id } = createNote({ title: 'Itinerary', body_text: 'x', notebook_id: travel });

  const moved = invoke('knowledge.move_note', { note_id, notebook_id: work });
  expect(moved.status).toBe('executed');
  const placements = db.vault
    .prepare('SELECT notebook_id FROM knowledge_note_placement WHERE note_id = ?')
    .all(note_id) as { notebook_id: string }[];
  expect(placements).toEqual([{ notebook_id: work }]);

  const unfiled = invoke('knowledge.move_note', { note_id });
  expect(unfiled.status).toBe('executed');
  const none = db.vault
    .prepare('SELECT count(*) AS n FROM knowledge_note_placement WHERE note_id = ?')
    .get(note_id) as { n: number };
  expect(none.n).toBe(0);

  const badTarget = invoke('knowledge.move_note', { note_id, notebook_id: 'no-such-notebook' });
  expect(badTarget.status).toBe('failed');
});

test('create_notebook orders siblings and refuses a missing parent', () => {
  const first = createNotebook('Alpha');
  const second = createNotebook('Beta');
  const rows = db.vault
    .prepare('SELECT notebook_id, sort_order FROM knowledge_notebook ORDER BY sort_order')
    .all() as { notebook_id: string; sort_order: number }[];
  expect(rows.map((r) => r.notebook_id)).toEqual([first, second]);

  const child = createNotebook('Alpha / Nested', first);
  const childRow = db.vault
    .prepare('SELECT parent_notebook_id FROM knowledge_notebook WHERE notebook_id = ?')
    .get(child) as { parent_notebook_id: string | null };
  expect(childRow.parent_notebook_id).toBe(first);

  const orphan = invoke('knowledge.create_notebook', {
    name: 'Lost',
    parent_notebook_id: 'no-such-notebook',
  });
  expect(orphan.status).toBe('failed');
  if (orphan.status === 'failed') expect(orphan.predicate).toContain('parent_exists_if_given');
});

test('create_note writes provenance for the note', () => {
  const { note_id } = createNote({ title: 'Receipted', body_text: 'x' });
  const prov = db.journal
    .prepare(
      `SELECT count(*) AS n FROM consent_provenance
        WHERE entity_type='knowledge.note' AND entity_id=? AND prov_activity='command.knowledge.create_note'`,
    )
    .get(note_id) as { n: number };
  expect(prov.n).toBe(1);
});

test('delete_note removes the note, its placements and edges', () => {
  const notebook = createNotebook('Journal');
  const { note_id, body_content_id } = createNote({
    title: 'Ephemeral',
    body_text: 'gone tomorrow',
    notebook_id: notebook,
  });
  const outcome = invoke('knowledge.delete_note', { note_id });
  expect(outcome.status).toBe('executed');
  const note = db.vault
    .prepare('SELECT count(*) AS n FROM knowledge_note WHERE note_id = ?')
    .get(note_id) as { n: number };
  expect(note.n).toBe(0);
  const placements = db.vault
    .prepare('SELECT count(*) AS n FROM knowledge_note_placement WHERE note_id = ?')
    .get(note_id) as { n: number };
  expect(placements.n).toBe(0);
  // The body was rented by this note alone, so its bytes soft-delete.
  const body = db.vault
    .prepare('SELECT deleted_at FROM core_content_item WHERE content_id = ?')
    .get(body_content_id) as { deleted_at: string | null };
  expect(body.deleted_at).not.toBeNull();
  const again = invoke('knowledge.delete_note', { note_id });
  expect(again.status).toBe('failed');
});

test('delete_note keeps a body another note still rents (sha256 dedup)', () => {
  const first = createNote({ title: 'One', body_text: 'shared words' });
  const second = createNote({ title: 'Two', body_text: 'shared words' });
  expect(second.body_content_id).toBe(first.body_content_id);
  const outcome = invoke('knowledge.delete_note', { note_id: first.note_id });
  expect(outcome.status).toBe('executed');
  expect((outcome as { output: { body_released: number } }).output.body_released).toBe(0);
  const body = db.vault
    .prepare('SELECT deleted_at FROM core_content_item WHERE content_id = ?')
    .get(first.body_content_id) as { deleted_at: string | null };
  expect(body.deleted_at).toBeNull();
});

test('rename_notebook updates the name and refuses a collision with a sibling', () => {
  const a = createNotebook('Recipes');
  createNotebook('Travel');
  expect(invoke('knowledge.rename_notebook', { notebook_id: a, name: 'Cooking' }).status).toBe(
    'executed',
  );
  const row = db.vault
    .prepare('SELECT name FROM knowledge_notebook WHERE notebook_id = ?')
    .get(a) as { name: string };
  expect(row.name).toBe('Cooking');
  // Renaming onto another notebook's name is a receipted refusal.
  expect(invoke('knowledge.rename_notebook', { notebook_id: a, name: 'Travel' }).status).toBe(
    'failed',
  );
  // Renaming to its own current name is an idempotent no-op.
  expect(invoke('knowledge.rename_notebook', { notebook_id: a, name: 'Cooking' }).status).toBe(
    'executed',
  );
});

test('delete_notebook unfiles member notes without destroying them; children block it', () => {
  const parent = createNotebook('Projects');
  const child = createNotebook('Archive', parent);
  const { note_id } = createNote({ title: 'Plan', body_text: 'v1', notebook_id: child });

  // A notebook with children is refused until they go first.
  expect(invoke('knowledge.delete_notebook', { notebook_id: parent }).status).toBe('failed');

  const outcome = invoke('knowledge.delete_notebook', { notebook_id: child });
  expect(outcome.status).toBe('executed');
  expect((outcome as { output: { notes_unfiled: number } }).output.notes_unfiled).toBe(1);
  // The note survives, unfiled; the notebook and its placements are gone.
  const note = db.vault
    .prepare('SELECT count(*) AS n FROM knowledge_note WHERE note_id = ?')
    .get(note_id) as { n: number };
  expect(note.n).toBe(1);
  const placements = db.vault
    .prepare('SELECT count(*) AS n FROM knowledge_note_placement WHERE note_id = ?')
    .get(note_id) as { n: number };
  expect(placements.n).toBe(0);
  // Now childless, the parent deletes cleanly; a re-delete is refused.
  expect(invoke('knowledge.delete_notebook', { notebook_id: parent }).status).toBe('executed');
  expect(invoke('knowledge.delete_notebook', { notebook_id: parent }).status).toBe('failed');
});
