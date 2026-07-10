import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import type { Credential } from '../gateway/types.js';
import { CIRCLE_SCHEME_URI, registerPeopleCommands } from './people.js';

const FLAGS_SCHEME_URI = 'https://centraid.dev/schemes/flags';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerPeopleCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
});

function invoke(command: string, input: Record<string, unknown>) {
  return gw.invoke(owner, { command, input, purpose: 'dpv:ServiceProvision' });
}

function out<T = Record<string, unknown>>(o: ReturnType<typeof invoke>): T {
  expect(o.status).toBe('executed');
  return (o as { output: T }).output;
}

function addPerson(input: Record<string, unknown> = {}): string {
  const o = invoke('people.add_person', { display_name: 'Maya Chen', cadence_days: 14, ...input });
  return out<{ party_id: string }>(o).party_id;
}

function createCircle(name: string): string {
  return out<{ circle_id: string }>(invoke('people.create_circle', { name })).circle_id;
}

/** The circles-scheme concept this person is currently filed under, if any. */
function circleOf(partyId: string): string | undefined {
  return (
    db.vault
      .prepare(
        `SELECT t.concept_id AS id FROM core_tag t
           JOIN core_concept c ON c.concept_id = t.concept_id
           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
          WHERE t.target_type = 'core.party' AND t.target_id = ? AND s.uri = ?`,
      )
      .get(partyId, CIRCLE_SCHEME_URI) as { id: string } | undefined
  )?.id;
}

function starCount(partyId: string): number {
  return (
    db.vault
      .prepare(
        `SELECT count(*) AS n FROM core_tag t
           JOIN core_concept c ON c.concept_id = t.concept_id
           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
          WHERE t.target_type = 'core.party' AND t.target_id = ?
            AND s.uri = ? AND c.notation = 'starred'`,
      )
      .get(partyId, FLAGS_SCHEME_URI) as { n: number }
  ).n;
}

test('add_person mints a canonical person party plus its 1:1 profile', () => {
  const partyId = addPerson({ role: 'Product designer · SF', avatar_color: '#7C5BD9' });
  const party = db.vault
    .prepare('SELECT kind, display_name FROM core_party WHERE party_id = ?')
    .get(partyId);
  expect(party).toMatchObject({ kind: 'person', display_name: 'Maya Chen' });
  const profile = db.vault
    .prepare('SELECT role, avatar_color, cadence_days FROM people_profile WHERE party_id = ?')
    .get(partyId);
  expect(profile).toMatchObject({
    role: 'Product designer · SF',
    avatar_color: '#7C5BD9',
    cadence_days: 14,
  });
});

test('add_person files into a circle when given, and refuses an unknown one', () => {
  const work = createCircle('Work');
  const partyId = addPerson({ circle_id: work });
  expect(circleOf(partyId)).toBe(work);
  const bad = invoke('people.add_person', {
    display_name: 'Ghost',
    cadence_days: 30,
    circle_id: 'nope',
  });
  expect(bad.status).toBe('failed');
  if (bad.status === 'failed') expect(bad.predicate).toContain('circle_exists_if_given');
});

test('edit_person revises the name and profile fields', () => {
  const partyId = addPerson();
  expect(
    invoke('people.edit_person', {
      party_id: partyId,
      display_name: 'Maya C.',
      role: 'Design lead',
      met: 'Ceramics class, 2019',
    }).status,
  ).toBe('executed');
  const party = db.vault
    .prepare('SELECT display_name FROM core_party WHERE party_id = ?')
    .get(partyId) as { display_name: string };
  expect(party.display_name).toBe('Maya C.');
  const profile = db.vault
    .prepare('SELECT role, met FROM people_profile WHERE party_id = ?')
    .get(partyId) as { role: string; met: string };
  expect(profile).toMatchObject({ role: 'Design lead', met: 'Ceramics class, 2019' });
});

test('set_cadence updates the keep-in-touch interval', () => {
  const partyId = addPerson();
  expect(invoke('people.set_cadence', { party_id: partyId, cadence_days: 7 }).status).toBe(
    'executed',
  );
  const profile = db.vault
    .prepare('SELECT cadence_days FROM people_profile WHERE party_id = ?')
    .get(partyId) as { cadence_days: number };
  expect(profile.cadence_days).toBe(7);
});

test('log_interaction records the touch and stamps last_contacted_at (clears overdue)', () => {
  const partyId = addPerson();
  expect(
    (
      db.vault
        .prepare('SELECT last_contacted_at FROM people_profile WHERE party_id = ?')
        .get(partyId) as { last_contacted_at: string | null }
    ).last_contacted_at,
  ).toBeNull();
  const o = invoke('people.log_interaction', {
    party_id: partyId,
    kind: 'Call',
    text: 'Sunday catch-up',
  });
  expect(o.status).toBe('executed');
  const profile = db.vault
    .prepare('SELECT last_contacted_at FROM people_profile WHERE party_id = ?')
    .get(partyId) as { last_contacted_at: string | null };
  expect(profile.last_contacted_at).not.toBeNull();
  const interaction = db.vault
    .prepare('SELECT kind, body_text FROM people_interaction WHERE party_id = ?')
    .get(partyId);
  expect(interaction).toMatchObject({ kind: 'Call', body_text: 'Sunday catch-up' });
});

test('star/unstar are the canonical flags-scheme tag on the party (idempotent)', () => {
  const partyId = addPerson();
  expect(invoke('people.star_person', { party_id: partyId }).status).toBe('executed');
  expect(invoke('people.star_person', { party_id: partyId }).status).toBe('executed');
  expect(starCount(partyId)).toBe(1);
  // One vocabulary across the vault: the concept carries the Favorite altLabel.
  const concept = db.vault
    .prepare(
      `SELECT c.alt_labels_json FROM core_concept c
         JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
        WHERE s.uri = ? AND c.notation = 'starred'`,
    )
    .get(FLAGS_SCHEME_URI) as { alt_labels_json: string };
  expect(JSON.parse(concept.alt_labels_json)).toContain('Favorite');
  expect(invoke('people.unstar_person', { party_id: partyId }).status).toBe('executed');
  expect(starCount(partyId)).toBe(0);
});

test('move_person re-files into one circle and un-circles when omitted', () => {
  const partyId = addPerson();
  const close = createCircle('Close');
  const family = createCircle('Family');
  expect(invoke('people.move_person', { party_id: partyId, circle_id: close }).status).toBe(
    'executed',
  );
  expect(circleOf(partyId)).toBe(close);
  expect(invoke('people.move_person', { party_id: partyId, circle_id: family }).status).toBe(
    'executed',
  );
  expect(circleOf(partyId)).toBe(family);
  // Exactly one circle tag survives a re-file.
  const tags = db.vault
    .prepare(
      `SELECT count(*) AS n FROM core_tag t JOIN core_concept c ON c.concept_id = t.concept_id
         JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
        WHERE t.target_id = ? AND s.uri = ?`,
    )
    .get(partyId, CIRCLE_SCHEME_URI) as { n: number };
  expect(tags.n).toBe(1);
  expect(invoke('people.move_person', { party_id: partyId }).status).toBe('executed');
  expect(circleOf(partyId)).toBeUndefined();
});

test('add_note lands an annotation on the party (searchable owner memo)', () => {
  const partyId = addPerson();
  expect(
    invoke('people.add_note', { party_id: partyId, text: 'Loves ceramics — ask about the studio.' })
      .status,
  ).toBe('executed');
  const note = db.vault
    .prepare(
      `SELECT body_text FROM knowledge_annotation WHERE target_type = 'core.party' AND target_id = ?`,
    )
    .get(partyId) as { body_text: string };
  expect(note.body_text).toContain('ceramics');
});

test('tasks add and toggle done', () => {
  const partyId = addPerson();
  const taskId = out<{ task_id: string }>(
    invoke('people.add_task', { party_id: partyId, text: 'Send the studio rec' }),
  ).task_id;
  const doneOf = () =>
    (
      db.vault.prepare('SELECT done FROM people_task WHERE task_id = ?').get(taskId) as {
        done: number;
      }
    ).done;
  expect(doneOf()).toBe(0);
  expect(invoke('people.toggle_task', { task_id: taskId }).status).toBe('executed');
  expect(doneOf()).toBe(1);
  expect(invoke('people.toggle_task', { task_id: taskId }).status).toBe('executed');
  expect(doneOf()).toBe(0);
});

test('important dates: a birthday auto-creates its reminder; toggle flips it', () => {
  const partyId = addPerson();
  const dateId = out<{ date_id: string }>(
    invoke('people.add_important_date', {
      party_id: partyId,
      label: 'Birthday',
      month_day: '08-12',
    }),
  ).date_id;
  const reminderOf = () =>
    (
      db.vault
        .prepare('SELECT reminder_on FROM people_important_date WHERE date_id = ?')
        .get(dateId) as { reminder_on: number }
    ).reminder_on;
  expect(reminderOf()).toBe(1);
  expect(invoke('people.toggle_reminder', { date_id: dateId }).status).toBe('executed');
  expect(reminderOf()).toBe(0);
  // A non-birthday date defaults to no reminder unless asked.
  const anniv = out<{ date_id: string }>(
    invoke('people.add_important_date', {
      party_id: partyId,
      label: 'Anniversary',
      month_day: '09-20',
    }),
  ).date_id;
  expect(
    (
      db.vault
        .prepare('SELECT reminder_on FROM people_important_date WHERE date_id = ?')
        .get(anniv) as { reminder_on: number }
    ).reminder_on,
  ).toBe(0);
});

test('relationships add with an optional pet species', () => {
  const partyId = addPerson();
  expect(
    invoke('people.add_relationship', {
      party_id: partyId,
      name: 'Miso',
      kind: 'Cat',
      pet: 'cat',
    }).status,
  ).toBe('executed');
  const rel = db.vault
    .prepare('SELECT name, kind, pet FROM people_relationship WHERE party_id = ?')
    .get(partyId);
  expect(rel).toMatchObject({ name: 'Miso', kind: 'Cat', pet: 'cat' });
});

test('gifts add as an idea and toggle to given and back', () => {
  const partyId = addPerson();
  const giftId = out<{ gift_id: string }>(
    invoke('people.add_gift', { party_id: partyId, text: 'Handmade mug set' }),
  ).gift_id;
  const stateOf = () =>
    (
      db.vault.prepare('SELECT state FROM people_gift WHERE gift_id = ?').get(giftId) as {
        state: string;
      }
    ).state;
  expect(stateOf()).toBe('idea');
  expect(invoke('people.toggle_gift', { gift_id: giftId }).status).toBe('executed');
  expect(stateOf()).toBe('given');
  expect(invoke('people.toggle_gift', { gift_id: giftId }).status).toBe('executed');
  expect(stateOf()).toBe('idea');
});

test('debts add in minor units and settle (a settled debt refuses re-settling)', () => {
  const partyId = addPerson();
  const debtId = out<{ debt_id: string }>(
    invoke('people.add_debt', {
      party_id: partyId,
      direction: 'owed',
      amount_minor: 4000,
      reason: 'Concert ticket',
    }),
  ).debt_id;
  const row = db.vault
    .prepare('SELECT direction, amount_minor, settled_at FROM people_debt WHERE debt_id = ?')
    .get(debtId) as { direction: string; amount_minor: number; settled_at: string | null };
  expect(row).toMatchObject({ direction: 'owed', amount_minor: 4000, settled_at: null });
  expect(invoke('people.settle_debt', { debt_id: debtId }).status).toBe('executed');
  const again = invoke('people.settle_debt', { debt_id: debtId });
  expect(again.status).toBe('failed');
  if (again.status === 'failed') expect(again.predicate).toContain('debt_open');
});

test('circles create with unique names, rename, and delete only when empty', () => {
  const work = createCircle('Work');
  const twin = invoke('people.create_circle', { name: 'Work' });
  expect(twin.status).toBe('failed');
  if (twin.status === 'failed') expect(twin.predicate).toContain('name_unused');
  expect(invoke('people.rename_circle', { circle_id: work, name: 'Colleagues' }).status).toBe(
    'executed',
  );
  const partyId = addPerson({ circle_id: work });
  const nonEmpty = invoke('people.delete_circle', { circle_id: work });
  expect(nonEmpty.status).toBe('failed');
  if (nonEmpty.status === 'failed') {
    expect(nonEmpty.predicate).toBe('This circle still has people in it — move them out first.');
  }
  expect(invoke('people.move_person', { party_id: partyId }).status).toBe('executed');
  expect(invoke('people.delete_circle', { circle_id: work }).status).toBe('executed');
});

test('journal entries attach to the owner party', () => {
  const o = invoke('people.add_journal_entry', {
    mood: '😄',
    text: 'Long call with Aisha.',
    entry_date: '2026-07-04',
  });
  expect(o.status).toBe('executed');
  const entry = db.vault
    .prepare('SELECT owner_party_id, mood, entry_date FROM people_journal_entry LIMIT 1')
    .get() as { owner_party_id: string; mood: string; entry_date: string };
  expect(entry).toMatchObject({
    owner_party_id: boot.ownerPartyId,
    mood: '😄',
    entry_date: '2026-07-04',
  });
});
