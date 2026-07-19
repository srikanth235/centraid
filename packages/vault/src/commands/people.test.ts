import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, createGrant, enrollApp, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import type { Credential } from '../gateway/types.js';
import { LIST_SCHEME_URI, registerPeopleCommands } from './people.js';
import { registerPartyCommands } from './parties.js';

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
  registerPartyCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
});

function invoke(command: string, input: Record<string, unknown>) {
  return gw.invoke(owner, { command, input, purpose: 'dpv:ServiceProvision' });
}

function out<T = Record<string, unknown>>(o: ReturnType<typeof invoke>): T {
  expect(o.status, JSON.stringify(o)).toBe('executed');
  return (o as { output: T }).output;
}

function addPerson(input: Record<string, unknown> = {}): string {
  const o = invoke('people.add_person', { display_name: 'Maya Chen', cadence_days: 14, ...input });
  return out<{ party_id: string }>(o).party_id;
}

function createList(name: string): string {
  return out<{ list_id: string }>(invoke('people.create_list', { name })).list_id;
}

/** The lists-scheme concept this person is currently filed under, if any. */
function listOf(partyId: string): string | undefined {
  return (
    db.vault
      .prepare(
        `SELECT t.concept_id AS id FROM core_tag t
           JOIN core_concept c ON c.concept_id = t.concept_id
           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
          WHERE t.target_type = 'core.party' AND t.target_id = ? AND s.uri = ?`,
      )
      .get(partyId, LIST_SCHEME_URI) as { id: string } | undefined
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

test('add_person files into a list when given, and refuses an unknown one', () => {
  const work = createList('Work');
  const partyId = addPerson({ list_id: work });
  expect(listOf(partyId)).toBe(work);
  const bad = invoke('people.add_person', {
    display_name: 'Ghost',
    cadence_days: 30,
    list_id: 'nope',
  });
  expect(bad.status).toBe('failed');
  if (bad.status === 'failed') expect(bad.predicate).toContain('list_exists_if_given');
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
    .prepare(
      `SELECT c.pref_label AS kind, a.body_text
         FROM core_activity i
         JOIN core_concept c ON c.concept_id = i.kind_concept_id
         JOIN core_link l ON l.from_type = 'core.activity' AND l.from_id = i.activity_id
         LEFT JOIN knowledge_annotation a
           ON a.target_type = 'core.activity' AND a.target_id = i.activity_id
        WHERE l.to_type = 'core.party' AND l.to_id = ? AND l.valid_to IS NULL`,
    )
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

test('move_person re-files into one list and un-lists when omitted', () => {
  const partyId = addPerson();
  const close = createList('Close');
  const family = createList('Family');
  expect(invoke('people.move_person', { party_id: partyId, list_id: close }).status).toBe(
    'executed',
  );
  expect(listOf(partyId)).toBe(close);
  expect(invoke('people.move_person', { party_id: partyId, list_id: family }).status).toBe(
    'executed',
  );
  expect(listOf(partyId)).toBe(family);
  // Exactly one list tag survives a re-file.
  const tags = db.vault
    .prepare(
      `SELECT count(*) AS n FROM core_tag t JOIN core_concept c ON c.concept_id = t.concept_id
         JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
        WHERE t.target_id = ? AND s.uri = ?`,
    )
    .get(partyId, LIST_SCHEME_URI) as { n: number };
  expect(tags.n).toBe(1);
  expect(invoke('people.move_person', { party_id: partyId }).status).toBe('executed');
  expect(listOf(partyId)).toBeUndefined();
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
      db.vault.prepare('SELECT status FROM schedule_task WHERE task_id = ?').get(taskId) as {
        status: string;
      }
    ).status;
  expect(doneOf()).toBe('needs-action');
  expect(invoke('people.toggle_task', { task_id: taskId }).status).toBe('executed');
  expect(doneOf()).toBe('completed');
  expect(invoke('people.toggle_task', { task_id: taskId }).status).toBe('executed');
  expect(doneOf()).toBe('needs-action');
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

test('birthdays have one writer: core_party.birth_date and the People row never disagree (issue #441 A2.3)', () => {
  const partyId = addPerson();
  const birthDateOf = () =>
    (
      db.vault.prepare('SELECT birth_date FROM core_party WHERE party_id = ?').get(partyId) as {
        birth_date: string | null;
      }
    ).birth_date;
  const rowMonthDay = () =>
    (
      db.vault
        .prepare(
          "SELECT month_day FROM people_important_date WHERE party_id = ? AND label LIKE '%birthday%'",
        )
        .get(partyId) as { month_day: string } | undefined
    )?.month_day;

  // Direction 1 — add_important_date writes through to the party spine. No year
  // is known, so birth_date is stored year-less (ISO 8601 --MM-DD).
  const dateId = out<{ date_id: string }>(
    invoke('people.add_important_date', {
      party_id: partyId,
      label: 'Birthday',
      month_day: '08-12',
    }),
  ).date_id;
  expect(birthDateOf()).toBe('--08-12');
  expect(rowMonthDay()).toBe('08-12');
  expect(birthDateOf()?.slice(-5)).toBe(rowMonthDay());

  // Direction 2 — update_party's birth_date refreshes the People row's MM-DD,
  // and a known full date is preserved with its year on the party side.
  expect(invoke('core.update_party', { party_id: partyId, birth_date: '1990-03-04' }).status).toBe(
    'executed',
  );
  expect(birthDateOf()).toBe('1990-03-04');
  expect(rowMonthDay()).toBe('03-04');
  expect(birthDateOf()?.slice(-5)).toBe(rowMonthDay());

  // Direction 1 again — re-adding/adjusting the birthday preserves the known
  // year already on the party and only moves MM-DD.
  out<{ date_id: string }>(
    invoke('people.add_important_date', {
      party_id: partyId,
      label: 'Birthday',
      month_day: '12-25',
    }),
  );
  expect(birthDateOf()).toBe('1990-12-25');
  expect(birthDateOf()?.slice(-5)).toBe('12-25');

  // The original People row moved too — never two disagreeing MM-DDs.
  expect(
    (
      db.vault
        .prepare('SELECT month_day FROM people_important_date WHERE date_id = ?')
        .get(dateId) as { month_day: string }
    ).month_day,
  ).toBe('12-25');
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
    .prepare(
      `SELECT p.display_name AS name, p.kind AS party_kind, c.pref_label AS kind,
              c.notation
         FROM core_link l
         JOIN core_party p ON p.party_id = l.to_id
         JOIN core_concept c ON c.concept_id = l.relation_concept_id
        WHERE l.from_type = 'core.party' AND l.from_id = ?
          AND l.to_type = 'core.party' AND l.valid_to IS NULL`,
    )
    .get(partyId);
  expect(rel).toMatchObject({
    name: 'Miso',
    party_kind: 'animal',
    kind: 'Cat',
    notation: 'people-cat-cat',
  });
});

test('gifts add as an idea and toggle to given and back', () => {
  const partyId = addPerson();
  const giftId = out<{ gift_id: string }>(
    invoke('people.add_gift', { party_id: partyId, text: 'Handmade mug set' }),
  ).gift_id;
  const stateOf = () =>
    (
      db.vault.prepare('SELECT status FROM schedule_task WHERE task_id = ?').get(giftId) as {
        status: string;
      }
    ).status;
  expect(stateOf()).toBe('needs-action');
  expect(
    db.vault
      .prepare(
        `SELECT c.notation FROM core_link l
          JOIN core_concept c ON c.concept_id = l.relation_concept_id
         WHERE l.from_type = 'schedule.task' AND l.from_id = ?
           AND l.to_type = 'core.party' AND l.to_id = ? AND l.valid_to IS NULL`,
      )
      .get(giftId, partyId),
  ).toMatchObject({ notation: 'gift-for' });
  const given = invoke('people.toggle_gift', { gift_id: giftId });
  expect(given.status, JSON.stringify(given)).toBe('executed');
  expect(stateOf()).toBe('completed');
  const reopened = invoke('people.toggle_gift', { gift_id: giftId });
  expect(reopened.status, JSON.stringify(reopened)).toBe('executed');
  expect(stateOf()).toBe('needs-action');
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
    .prepare(
      'SELECT from_party, to_party, amount_minor, settled_at FROM tally_obligation WHERE obligation_id = ?',
    )
    .get(debtId) as {
    from_party: string;
    to_party: string;
    amount_minor: number;
    settled_at: string | null;
  };
  expect(row).toMatchObject({
    from_party: partyId,
    to_party: boot.ownerPartyId,
    amount_minor: 4000,
    settled_at: null,
  });
  expect(invoke('people.settle_debt', { debt_id: debtId }).status).toBe('executed');
  const again = invoke('people.settle_debt', { debt_id: debtId });
  expect(again.status).toBe('failed');
  if (again.status === 'failed') expect(again.predicate).toContain('debt_open');
});

test('the installed People grant can write an obligation and read it through Tally', () => {
  const partyId = addPerson();
  const app = enrollApp(db, { name: 'people' });
  createGrant(db, {
    appId: app.appId,
    purposeConceptId: boot.concepts['dpv:ServiceProvision'] as string,
    grantedByPartyId: boot.ownerPartyId,
    scopes: [
      { schema: 'people', verbs: 'read+act' },
      { schema: 'tally', table: 'obligation', verbs: 'read' },
    ],
  });
  const appCredential: Credential = {
    kind: 'app',
    appId: app.appId,
    signingKey: app.signingKey,
  };
  const added = gw.invoke(appCredential, {
    command: 'people.add_debt',
    input: { party_id: partyId, direction: 'owed', amount_minor: 7250, reason: 'Train fare' },
    purpose: 'dpv:ServiceProvision',
  });
  expect(added.status).toBe('executed');
  const debtId = (added as { output: { debt_id: string } }).output.debt_id;
  expect(
    gw
      .read(appCredential, {
        entity: 'tally.obligation',
        where: [{ column: 'obligation_id', op: 'eq', value: debtId }],
        purpose: 'dpv:ServiceProvision',
      })
      .rows.map((row) => row.obligation_id),
  ).toContain(debtId);
});
test('lists create with unique names, rename, and delete only when empty', () => {
  const work = createList('Work');
  const twin = invoke('people.create_list', { name: 'Work' });
  expect(twin.status).toBe('failed');
  if (twin.status === 'failed') expect(twin.predicate).toContain('name_unused');
  expect(invoke('people.rename_list', { list_id: work, name: 'Colleagues' }).status).toBe(
    'executed',
  );
  const partyId = addPerson({ list_id: work });
  const nonEmpty = invoke('people.delete_list', { list_id: work });
  expect(nonEmpty.status).toBe('failed');
  if (nonEmpty.status === 'failed') {
    expect(nonEmpty.predicate).toBe('This list still has people in it — move them out first.');
  }
  expect(invoke('people.move_person', { party_id: partyId }).status).toBe('executed');
  expect(invoke('people.delete_list', { list_id: work }).status).toBe('executed');
});

test('journal entries attach to the owner party', () => {
  const o = invoke('people.add_journal_entry', {
    mood: '😄',
    text: 'Long call with Aisha.',
    entry_date: '2026-07-04',
  });
  expect(o.status).toBe('executed');
  const entry = db.vault
    .prepare(
      `SELECT n.author_party_id, n.title, n.created_at
         FROM knowledge_note n
         JOIN core_tag t ON t.target_type = 'knowledge.note' AND t.target_id = n.note_id
         JOIN core_concept c ON c.concept_id = t.concept_id
         JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
        WHERE s.uri = 'https://centraid.dev/schemes/people-journal'`,
    )
    .get() as { author_party_id: string; title: string; created_at: string };
  expect(entry).toMatchObject({
    author_party_id: boot.ownerPartyId,
    title: 'People journal · 😄',
    created_at: '2026-07-04T12:00:00.000Z',
  });
});
