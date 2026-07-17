// The Vault Atlas Browse backend (issue #441 Part B, B3): read side + the
// journalled write trio. Proves the acceptance criteria for Browse —
// keyset pagination stability, unknown-table rejection, sealed mask on read +
// refusal on write, machinery read-only behind an unlock flag, polymorphic
// dependents via the A1 registry, delete blocked by engine FKs, and the hard
// requirement: a Browse write lands in the replica change log AND records
// operator provenance.

import { afterEach, beforeEach, expect, test } from 'vitest';
import { bootstrapVault, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import type { Credential, InvokeOutcome } from '../gateway/types.js';
import { readReplicaChanges } from '../replica/change-log.js';
import { registerAtlasCommands } from './atlas.js';
import {
  browseColumns,
  browseRow,
  browseRows,
  browseTableList,
  BrowseError,
} from '../schema/atlas-browse.js';
import { browseDependents, browseRefSearch } from '../schema/atlas-browse-refs.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerAtlasCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
});

afterEach(() => {
  db.close();
});

function invoke(command: string, input: Record<string, unknown>): InvokeOutcome {
  return gw.invoke(owner, { command, input, purpose: 'dpv:ServiceProvision' });
}

function addParty(id: string, name: string): string {
  const now = new Date().toISOString();
  const out = invoke('atlas.insert_row', {
    table: 'core.party',
    values: {
      party_id: id,
      kind: 'person',
      display_name: name,
      created_at: now,
      updated_at: now,
      ontology_version: '1.3',
    },
  });
  expect(out.status).toBe('executed');
  return id;
}

let tagSeq = 0;
/** Attach a core_tag (a POLYMORPHIC pointer) directly onto a party. */
function tagParty(partyId: string, label: string): void {
  const now = new Date().toISOString();
  const schemeId = `sch-${tagSeq}`;
  const conceptId = `con-${tagSeq}`;
  tagSeq += 1;
  db.vault
    .prepare(
      `INSERT INTO core_concept_scheme (scheme_id, uri, title, version) VALUES (?, ?, ?, '1')`,
    )
    .run(schemeId, `urn:tags:${schemeId}`, 'Tags');
  db.vault
    .prepare(
      `INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label) VALUES (?, ?, ?, ?)`,
    )
    .run(conceptId, schemeId, label.toLowerCase(), label);
  db.vault
    .prepare(
      `INSERT INTO core_tag (tag_id, target_type, target_id, concept_id, tagged_at)
       VALUES (?, 'core.party', ?, ?, ?)`,
    )
    .run(`tag-${conceptId}`, partyId, conceptId, now);
}

// --- read: table picker + column metadata --------------------------------

test('browseTableList classifies packs and flags machinery bands', () => {
  const tables = browseTableList(db.vault);
  const party = tables.find((t) => t.logical === 'core.party');
  expect(party?.packKind).toBe('ontology');
  expect(party?.machinery).toBe(false);
  expect(party?.singlePk).toBe(true);
  const blob = tables.find((t) => t.logical === 'blob.custody_state');
  expect(blob?.machinery).toBe(true);
  // Composite-pk table honestly reports it (tally_expense_split).
  const split = tables.find((t) => t.logical === 'tally.expense_split');
  expect(split?.singlePk).toBe(false);
});

test('browseColumns carries type, notnull, pk, FK target, sealed flag + display heuristic', () => {
  const party = browseColumns(db.vault, 'core.party');
  expect(party.displayField).toBe('display_name');
  const kind = party.columns.find((c) => c.name === 'kind');
  expect(kind?.notnull).toBe(true);
  const pk = party.columns.find((c) => c.name === 'party_id');
  expect(pk?.pk).toBe(1);

  const ident = browseColumns(db.vault, 'core.party_identifier');
  const fk = ident.columns.find((c) => c.name === 'party_id');
  expect(fk?.fkTable).toBe('core_party');
  expect(fk?.fkLogical).toBe('core.party');

  const locker = browseColumns(db.vault, 'locker.item');
  expect(locker.columns.find((c) => c.name === 'password')?.sealed).toBe(true);
  expect(locker.columns.find((c) => c.name === 'title')?.sealed).toBe(false);
});

test('unknown tables are rejected, never turned into SQL', () => {
  expect(() => browseColumns(db.vault, 'nope.table')).toThrow(BrowseError);
  expect(() => browseRows(db.vault, { table: 'core.bogus' })).toThrow(BrowseError);
  const out = invoke('atlas.insert_row', { table: 'nope.table', values: { x: 1 } });
  expect(out.status).toBe('failed');
});

// --- read: keyset pagination ---------------------------------------------

function addScheme(id: string, title: string): void {
  const out = invoke('atlas.insert_row', {
    table: 'core.concept_scheme',
    values: { scheme_id: id, uri: `urn:scheme:${id}`, title, version: '1' },
  });
  expect(out.status).toBe('executed');
}

/** Walk every page of a keyset paginated read into one ordered id list. */
function paginateAll(
  params: { table: string; orderBy?: string; dir?: 'asc' | 'desc' },
  idCol: string,
  pageSize: number,
): string[] {
  const seen: string[] = [];
  let after: string | undefined;
  for (let guard = 0; guard < 200; guard += 1) {
    const page = browseRows(db.vault, { ...params, limit: pageSize, ...(after ? { after } : {}) });
    for (const row of page.rows) seen.push(row[idCol] as string);
    if (!page.nextCursor) break;
    after = page.nextCursor;
  }
  return seen;
}

test('keyset pagination is stable — every row once, in order, matching a full read', () => {
  for (const id of ['s01', 's02', 's03', 's04', 's05', 's06', 's07']) addScheme(id, `Scheme ${id}`);
  // The full (single-page) order is ground truth; a small-page walk must
  // reproduce it exactly — no duplicates across boundaries, no dropped rows.
  const full = browseRows(db.vault, { table: 'core.concept_scheme', limit: 100 });
  expect(full.nextCursor).toBeNull();
  const fullIds = full.rows.map((r) => r['scheme_id'] as string);
  const paged = paginateAll({ table: 'core.concept_scheme' }, 'scheme_id', 2);
  expect(paged).toEqual(fullIds);
  expect(new Set(paged).size).toBe(paged.length);
  for (const id of ['s01', 's04', 's07']) expect(paged).toContain(id);
});

test('keyset pagination over a non-key orderBy stays stable with ties', () => {
  // A shared title on several rows forces the pk tiebreaker to carry the order.
  addScheme('a1', 'Zed');
  addScheme('a2', 'Zed');
  addScheme('a3', 'Zed');
  addScheme('a4', 'Amy');
  const full = browseRows(db.vault, { table: 'core.concept_scheme', orderBy: 'title', limit: 100 });
  const fullIds = full.rows.map((r) => r['scheme_id'] as string);
  const paged = paginateAll({ table: 'core.concept_scheme', orderBy: 'title' }, 'scheme_id', 2);
  expect(paged).toEqual(fullIds);
  expect(new Set(paged).size).toBe(paged.length);
  // The three tied 'Zed' rows are contiguous and ordered by their pk tiebreaker.
  const zeds = paged.filter((id) => ['a1', 'a2', 'a3'].includes(id));
  expect(zeds).toEqual(['a1', 'a2', 'a3']);
});

// --- read: sealed masking -------------------------------------------------

test('sealed columns read as a placeholder, never plaintext', () => {
  const now = new Date().toISOString();
  db.vault
    .prepare(
      `INSERT INTO locker_item (item_id, type, title, password, compromised, created_at, updated_at)
       VALUES ('L1','login','GitHub','hunter2',0,?,?)`,
    )
    .run(now, now);
  const single = browseRow(db.vault, 'locker.item', 'L1');
  expect(single.row['password']).toBe('«sealed»');
  expect(single.row['title']).toBe('GitHub');
  const page = browseRows(db.vault, { table: 'locker.item' });
  expect(page.rows[0]!['password']).toBe('«sealed»');
});

// --- write: sealed refusal + machinery lock -------------------------------

test('a write to a sealed column is refused', () => {
  const now = new Date().toISOString();
  db.vault
    .prepare(
      `INSERT INTO locker_item (item_id, type, title, compromised, created_at, updated_at)
       VALUES ('L2','login','GitHub',0,?,?)`,
    )
    .run(now, now);
  const out = invoke('atlas.update_row', {
    table: 'locker.item',
    id: 'L2',
    set: { password: 'newsecret' },
  });
  expect(out.status).toBe('failed');
  expect((out as { reason: string }).reason).toMatch(/sealed/);
});

test('machinery bands are read-only unless explicitly unlocked', () => {
  const locked = invoke('atlas.insert_row', {
    table: 'blob.custody_state',
    values: { content_id: 'c1' },
  });
  expect(locked.status).toBe('failed');
  expect((locked as { reason: string }).reason).toMatch(/machinery/);

  // With the unlock flag the guard is passed; the write then fails (or not) on
  // the table's OWN constraints — the point is it is no longer machinery-blocked.
  const unlocked = invoke('atlas.insert_row', {
    table: 'blob.custody_state',
    values: { content_id: 'c1' },
    unlockMachinery: true,
  });
  if (unlocked.status === 'failed') {
    expect((unlocked as { reason: string }).reason).not.toMatch(/machinery/);
  }
});

// --- write: journalled path (replica + provenance) — THE hard requirement --

test('a Browse write lands in the replica change log and records operator provenance', () => {
  const out = invoke('atlas.insert_row', {
    table: 'core.concept_scheme',
    values: { scheme_id: 'S1', uri: 'urn:atlas:test', title: 'Test Scheme', version: '1' },
  });
  expect(out.status).toBe('executed');

  // Replica visibility: a replica pulled after the edit sees it.
  const page = readReplicaChanges(db.vault);
  const change = page.changes.find(
    (c) => c.entity === 'core.concept_scheme' && c.rowId === 'S1' && c.op === 'insert',
  );
  expect(change).toBeDefined();

  // Operator provenance: agent_kind='owner', a distinguishable atlas activity.
  const prov = db.journal
    .prepare(
      `SELECT prov_activity, agent_kind FROM consent_provenance
        WHERE entity_type = 'core.concept_scheme' AND entity_id = 'S1'`,
    )
    .get() as { prov_activity: string; agent_kind: string } | undefined;
  expect(prov?.agent_kind).toBe('owner');
  expect(prov?.prov_activity).toBe('command.atlas.insert_row');
});

test('STRICT NOT NULL / CHECK violations surface as a clean failure, not a crash', () => {
  const out = invoke('atlas.insert_row', {
    table: 'core.party',
    values: { party_id: 'bad', display_name: 'No Kind' }, // missing NOT NULL kind/timestamps
  });
  expect(out.status).toBe('failed');
});

// --- dependents: engine FKs + polymorphic registry ------------------------

test('dependents count polymorphic mechanisms via the registry, not only engine FKs', () => {
  addParty('p1', 'Ravi');
  // A core_tag on the party — a POLYMORPHIC pointer invisible to PRAGMA.
  tagParty('p1', 'Family');

  const deps = browseDependents(db.vault, 'core.party', 'p1');
  const poly = deps.dependents.find((d) => d.mechanism === 'poly' && d.via.startsWith('core_tag.'));
  expect(poly).toBeDefined();
  expect(poly?.count).toBe(1);
});

test('a delete with engine-FK dependents is blocked, with the dependent payload', () => {
  addParty('p2', 'Asha');
  const now = new Date().toISOString();
  db.vault
    .prepare(
      `INSERT INTO core_party_identifier (identifier_id, party_id, scheme, value, is_primary, valid_from)
       VALUES ('id1','p2','email','asha@example.com',1,?)`,
    )
    .run(now);

  const deps = browseDependents(db.vault, 'core.party', 'p2');
  expect(deps.hasEngineDependents).toBe(true);
  const fk = deps.dependents.find(
    (d) => d.mechanism === 'fk' && d.via === 'core_party_identifier.party_id',
  );
  expect(fk?.count).toBe(1);

  const out = invoke('atlas.delete_row', { table: 'core.party', id: 'p2' });
  expect(out.status).toBe('failed');
});

test('a clean delete removes the row and sweeps its polymorphic pointers', () => {
  addParty('p3', 'Meera');
  tagParty('p3', 'Work');
  expect(browseDependents(db.vault, 'core.party', 'p3').dependents.length).toBeGreaterThan(0);

  const out = invoke('atlas.delete_row', { table: 'core.party', id: 'p3' });
  expect(out.status).toBe('executed');
  // The row is gone…
  expect(() => browseRow(db.vault, 'core.party', 'p3')).toThrow(BrowseError);
  // …and its tag was swept, not left dangling (issue #441 A1 hygiene).
  const tags = db.vault
    .prepare(
      `SELECT COUNT(*) AS n FROM core_tag WHERE target_type = 'core.party' AND target_id = 'p3'`,
    )
    .get() as { n: number };
  expect(tags.n).toBe(0);
});

// --- FK reference-picker search -------------------------------------------

test('browseRefSearch returns {id, display} hits from a FK target table', () => {
  addParty('p4', 'Ravi Kumar');
  addParty('p5', 'Sunita');
  const hits = browseRefSearch(db.vault, 'core.party', 'Ravi');
  expect(hits).toHaveLength(1);
  expect(hits[0]).toEqual({ id: 'p4', display: 'Ravi Kumar' });
  // Empty query lists rows by display field.
  expect(browseRefSearch(db.vault, 'core.party', '').length).toBeGreaterThanOrEqual(2);
});
