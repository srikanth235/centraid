import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, createGrant, enrollApp, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import { migrate, VAULT_MIGRATIONS } from '../schema/migrate.js';
import type { Credential } from '../gateway/types.js';
import { registerKnowledgeCommands } from './knowledge.js';
import { registerLinkCommands } from './links.js';
import { registerTaskCommands } from './tasks.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerLinkCommands(gw);
  registerTaskCommands(gw);
  registerKnowledgeCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
});

function invoke(cred: Credential, command: string, input: Record<string, unknown>) {
  return gw.invoke(cred, { command, input, purpose: 'dpv:ServiceProvision' });
}

function addTask(title: string): string {
  const out = invoke(owner, 'schedule.add_task', { title });
  expect(out.status).toBe('executed');
  return (out as { output: { task_id: string } }).output.task_id;
}

function addNote(title: string): string {
  const out = invoke(owner, 'knowledge.create_note', { title, body_text: `${title} body` });
  expect(out.status).toBe('executed');
  return (out as { output: { note_id: string } }).output.note_id;
}

function liveLink(linkId: string) {
  return db.vault
    .prepare('SELECT valid_to, asserted_by FROM core_link WHERE link_id = ?')
    .get(linkId) as { valid_to: string | null; asserted_by: string } | undefined;
}

test('link_entities asserts a typed relation between two canonical rows', () => {
  const noteId = addNote('Trip planning');
  const taskId = addTask('Book flights');
  const out = invoke(owner, 'core.link_entities', {
    from_type: 'knowledge.note',
    from_id: noteId,
    to_type: 'schedule.task',
    to_id: taskId,
    relation: 'references',
  });
  expect(out.status).toBe('executed');
  const { link_id } = (out as { output: { link_id: string } }).output;
  const row = liveLink(link_id);
  expect(row).toMatchObject({ valid_to: null, asserted_by: 'owner' });
});

test('an unknown relation notation is refused by precondition — vocabulary, never caller-invented', () => {
  const noteId = addNote('A');
  const taskId = addTask('B');
  const out = invoke(owner, 'core.link_entities', {
    from_type: 'knowledge.note',
    from_id: noteId,
    to_type: 'schedule.task',
    to_id: taskId,
    relation: 'my-cool-relation',
  });
  expect(out.status).toBe('failed');
  if (out.status === 'failed') expect(out.predicate).toContain('relation_in_scheme');
});

test('an identical live link is refused; after unlink the relation may be asserted again', () => {
  const noteId = addNote('A');
  const taskId = addTask('B');
  const input = {
    from_type: 'knowledge.note',
    from_id: noteId,
    to_type: 'schedule.task',
    to_id: taskId,
    relation: 'about',
  };
  const first = invoke(owner, 'core.link_entities', input);
  expect(first.status).toBe('executed');
  const dup = invoke(owner, 'core.link_entities', input);
  expect(dup.status).toBe('failed');
  if (dup.status === 'failed') expect(dup.predicate).toContain('no_identical_live_link');

  const linkId = (first as { output: { link_id: string } }).output.link_id;
  expect(invoke(owner, 'core.unlink_entities', { link_id: linkId }).status).toBe('executed');
  const again = invoke(owner, 'core.link_entities', input);
  expect(again.status).toBe('executed');
});

test('unlink is temporal: the row survives with valid_to set, never deleted', () => {
  const noteId = addNote('A');
  const taskId = addTask('B');
  const out = invoke(owner, 'core.link_entities', {
    from_type: 'knowledge.note',
    from_id: noteId,
    to_type: 'schedule.task',
    to_id: taskId,
    relation: 'references',
  });
  const linkId = (out as { output: { link_id: string } }).output.link_id;
  expect(invoke(owner, 'core.unlink_entities', { link_id: linkId }).status).toBe('executed');
  const row = liveLink(linkId);
  expect(row).toBeDefined();
  expect(row?.valid_to).not.toBeNull();
});

test('linking to a missing endpoint, an unknown entity, itself, or another link is refused', () => {
  const noteId = addNote('A');
  const ghost = invoke(owner, 'core.link_entities', {
    from_type: 'knowledge.note',
    from_id: noteId,
    to_type: 'schedule.task',
    to_id: 'no-such-task',
    relation: 'references',
  });
  expect(ghost.status).toBe('failed');
  if (ghost.status === 'failed') expect(ghost.reason).toContain('no schedule.task');

  const unknown = invoke(owner, 'core.link_entities', {
    from_type: 'knowledge.note',
    from_id: noteId,
    to_type: 'not.an-entity',
    to_id: 'x',
    relation: 'references',
  });
  expect(unknown.status).toBe('failed');
  if (unknown.status === 'failed') expect(unknown.reason).toContain('unknown entity');

  const self = invoke(owner, 'core.link_entities', {
    from_type: 'knowledge.note',
    from_id: noteId,
    to_type: 'knowledge.note',
    to_id: noteId,
    relation: 'about',
  });
  expect(self.status).toBe('failed');
  if (self.status === 'failed') expect(self.reason).toContain('cannot link to itself');

  const taskId = addTask('T');
  const real = invoke(owner, 'core.link_entities', {
    from_type: 'knowledge.note',
    from_id: noteId,
    to_type: 'schedule.task',
    to_id: taskId,
    relation: 'references',
  });
  const realLinkId = (real as { output: { link_id: string } }).output.link_id;
  const meta = invoke(owner, 'core.link_entities', {
    from_type: 'knowledge.note',
    from_id: noteId,
    to_type: 'core.link',
    to_id: realLinkId,
    relation: 'about',
  });
  expect(meta.status).toBe('failed');
  if (meta.status === 'failed') expect(meta.reason).toContain('links do not link links');
});

test('an app may only assert links between endpoints its grant lets it READ', () => {
  const noteId = addNote('A');
  const taskId = addTask('B');
  const app = enrollApp(db, { name: 'linker' });
  const appCred: Credential = { kind: 'app', appId: app.appId, signingKey: app.signingKey };
  const purposeId = boot.concepts['dpv:ServiceProvision'] ?? '';

  // Grant: act on both link commands, read on knowledge only — schedule is
  // deliberately NOT covered, so the to-endpoint fails the readable rule.
  createGrant(db, {
    appId: app.appId,
    purposeConceptId: purposeId,
    grantedByPartyId: boot.ownerPartyId,
    scopes: [
      { schema: 'core', table: 'link_entities', verbs: 'act' },
      { schema: 'core', table: 'unlink_entities', verbs: 'act' },
      { schema: 'core', table: 'link', verbs: 'read' },
      { schema: 'knowledge', verbs: 'read' },
    ],
  });
  const denied = invoke(appCred, 'core.link_entities', {
    from_type: 'knowledge.note',
    from_id: noteId,
    to_type: 'schedule.task',
    to_id: taskId,
    relation: 'references',
  });
  expect(denied.status).toBe('failed');
  if (denied.status === 'failed') {
    expect(denied.reason).toContain('grant does not cover read of schedule.task');
  }

  // A second grant widens read to schedule — now the same assertion lands,
  // stamped as app-asserted.
  createGrant(db, {
    appId: app.appId,
    purposeConceptId: purposeId,
    grantedByPartyId: boot.ownerPartyId,
    scopes: [{ schema: 'schedule', verbs: 'read' }],
  });
  const allowed = invoke(appCred, 'core.link_entities', {
    from_type: 'knowledge.note',
    from_id: noteId,
    to_type: 'schedule.task',
    to_id: taskId,
    relation: 'references',
  });
  expect(allowed.status).toBe('executed');
  const linkId = (allowed as { output: { link_id: string } }).output.link_id;
  expect(liveLink(linkId)).toMatchObject({ valid_to: null, asserted_by: 'app' });
});

test('hard-deleting an endpoint end-dates its live links via the gateway sweep', () => {
  const noteId = addNote('Doomed');
  const taskId = addTask('Survivor');
  const out = invoke(owner, 'core.link_entities', {
    from_type: 'knowledge.note',
    from_id: noteId,
    to_type: 'schedule.task',
    to_id: taskId,
    relation: 'references',
  });
  const linkId = (out as { output: { link_id: string } }).output.link_id;

  expect(invoke(owner, 'knowledge.delete_note', { note_id: noteId }).status).toBe('executed');
  const row = liveLink(linkId);
  expect(row).toBeDefined(); // ended, not erased
  expect(row?.valid_to).not.toBeNull();

  // The sweep stamped provenance for the end-dated link like any write.
  const prov = db.journal
    .prepare(
      `SELECT count(*) AS n FROM consent_provenance
        WHERE entity_type = 'core.link' AND entity_id = ?`,
    )
    .get(linkId) as { n: number };
  expect(prov.n).toBeGreaterThan(0);
});

test('backlinks are a reverse read of the same table', () => {
  const noteA = addNote('A');
  const noteB = addNote('B');
  const taskId = addTask('T');
  invoke(owner, 'core.link_entities', {
    from_type: 'knowledge.note',
    from_id: noteA,
    to_type: 'schedule.task',
    to_id: taskId,
    relation: 'references',
  });
  invoke(owner, 'core.link_entities', {
    from_type: 'knowledge.note',
    from_id: noteB,
    to_type: 'schedule.task',
    to_id: taskId,
    relation: 'about',
  });
  const backlinks = gw.read(owner, {
    entity: 'core.link',
    where: [
      { column: 'to_type', op: 'eq', value: 'schedule.task' },
      { column: 'to_id', op: 'eq', value: taskId },
      { column: 'valid_to', op: 'is-null' },
    ],
    purpose: 'dpv:ServiceProvision',
  });
  expect(backlinks.rows).toHaveLength(2);
});

test('the v3 migration backfills relation notations into a pre-existing vault', () => {
  // Simulate a vault seeded before the new notations existed.
  db.vault
    .prepare(
      `DELETE FROM core_concept WHERE notation IN ('references', 'attachment-of')
        AND scheme_id = (SELECT scheme_id FROM core_concept_scheme WHERE uri = 'urn:duaility:relations')`,
    )
    .run();
  db.vault.exec('PRAGMA user_version = 2');
  migrate(db.vault, VAULT_MIGRATIONS);
  const n = db.vault
    .prepare(
      `SELECT count(*) AS n FROM core_concept c
        JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
       WHERE s.uri = 'urn:duaility:relations' AND c.notation IN ('references', 'attachment-of')`,
    )
    .get() as { n: number };
  expect(n.n).toBe(2);
});

// ---------- Standoff anchors (issue #282) ----------

const SELECTOR = { exact: 'Priya Menon', prefix: 'paperwork with ', suffix: ' today.', start: 21 };

function anchorOf(linkId: string) {
  return db.vault
    .prepare('SELECT anchor_id, selector_json FROM core_link_anchor WHERE link_id = ?')
    .get(linkId) as { anchor_id: string; selector_json: string } | undefined;
}

function linkNoteToTask(selector?: Record<string, unknown>): string {
  const noteId = addNote('Anchored');
  const taskId = addTask('Target');
  const out = invoke(owner, 'core.link_entities', {
    from_type: 'knowledge.note',
    from_id: noteId,
    to_type: 'schedule.task',
    to_id: taskId,
    relation: 'references',
    ...(selector ? { selector } : {}),
  });
  expect(out.status).toBe('executed');
  return (out as { output: { link_id: string } }).output.link_id;
}

test('link_entities with a selector writes the anchor atomically with the link', () => {
  const linkId = linkNoteToTask(SELECTOR);
  const anchor = anchorOf(linkId);
  expect(anchor).toBeDefined();
  expect(JSON.parse(anchor?.selector_json ?? '{}')).toEqual(SELECTOR);
});

test('a malformed selector is refused at the input schema, link unwritten', () => {
  const noteId = addNote('A');
  const taskId = addTask('B');
  const out = invoke(owner, 'core.link_entities', {
    from_type: 'knowledge.note',
    from_id: noteId,
    to_type: 'schedule.task',
    to_id: taskId,
    relation: 'references',
    selector: { exact: '', prefix: '', suffix: '', start: -1 },
  });
  expect(out.status).not.toBe('executed');
  const n = db.vault.prepare('SELECT count(*) AS n FROM core_link_anchor').get() as { n: number };
  expect(n.n).toBe(0);
});

test('anchor_link upserts the one anchor a link carries — a re-baseline moves it in place', () => {
  const linkId = linkNoteToTask(SELECTOR);
  const first = anchorOf(linkId);
  const moved = { ...SELECTOR, start: 40, prefix: 'met ' };
  const out = invoke(owner, 'core.anchor_link', { link_id: linkId, selector: moved });
  expect(out.status).toBe('executed');
  const after = anchorOf(linkId);
  expect(after?.anchor_id).toBe(first?.anchor_id); // moved, not multiplied
  expect(JSON.parse(after?.selector_json ?? '{}')).toEqual(moved);
  const n = db.vault.prepare('SELECT count(*) AS n FROM core_link_anchor').get() as { n: number };
  expect(n.n).toBe(1);
});

test('anchor_link can attach an anchor to a link created without one (re-anchor an orphaned edge)', () => {
  const linkId = linkNoteToTask();
  expect(anchorOf(linkId)).toBeUndefined();
  const out = invoke(owner, 'core.anchor_link', { link_id: linkId, selector: SELECTOR });
  expect(out.status).toBe('executed');
  expect((out as { output: { anchor_id?: string } }).output.anchor_id).toBeTruthy();
  expect(anchorOf(linkId)).toBeDefined();
});

test('anchor_link without a selector clears the anchor — the edge demotes to strip-only', () => {
  const linkId = linkNoteToTask(SELECTOR);
  const out = invoke(owner, 'core.anchor_link', { link_id: linkId });
  expect(out.status).toBe('executed');
  expect(anchorOf(linkId)).toBeUndefined();
  expect(liveLink(linkId)?.valid_to).toBeNull(); // the judgment is untouched
});

test('an ended link takes no new locator', () => {
  const linkId = linkNoteToTask(SELECTOR);
  expect(invoke(owner, 'core.unlink_entities', { link_id: linkId }).status).toBe('executed');
  const out = invoke(owner, 'core.anchor_link', { link_id: linkId, selector: SELECTOR });
  expect(out.status).toBe('failed');
  if (out.status === 'failed') expect(out.predicate).toContain('link_live');
});

test('a link_anchor is not a linkable endpoint — locators are not entities', () => {
  const linkId = linkNoteToTask(SELECTOR);
  const anchor = anchorOf(linkId);
  const noteId = addNote('Meta');
  const out = invoke(owner, 'core.link_entities', {
    from_type: 'knowledge.note',
    from_id: noteId,
    to_type: 'core.link_anchor',
    to_id: anchor?.anchor_id ?? '',
    relation: 'about',
  });
  expect(out.status).toBe('failed');
  if (out.status === 'failed') expect(out.reason).toContain('links do not link links');
});
