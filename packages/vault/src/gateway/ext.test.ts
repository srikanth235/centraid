// The ext band (issue #286 phase 2): app-declared tables INSIDE vault.db.
// What must hold: the gateway applies + diffs DDL from specs (never the
// app); consent scopes on `ext.<appId>` gate app reads and the typed write
// trio; links/tags/search/export/vault_sql treat ext rows like canonical
// ones; drafts are scratch copies; uninstall retains, purge deletes.

import { beforeEach, describe, expect, test } from 'vitest';
import { bootstrapVault, createGrant, enrollApp, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { registerLinkCommands } from '../commands/links.js';
import { registerPartyCommands } from '../commands/parties.js';
import { canonicalSpecJson, validateExtSpecs, type ExtTableSpec } from '../schema/ext.js';
import { listVaultEntities, resolveEntity } from '../schema/tables.js';
import { buildAssistantContext } from './assistant-context.js';
import { createGateway, Gateway } from './gateway.js';
import { exportVault, importVaultExport } from './portability.js';
import { GatewayError, type Credential } from './types.js';

const PURPOSE = 'dpv:ServiceProvision';
const APP = 'gym-log';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

function specs(): ExtTableSpec[] {
  return [
    {
      name: 'workout',
      columns: [
        { name: 'workout_id', type: 'text', primaryKey: true },
        { name: 'party_id', type: 'text', references: 'core.party' },
        { name: 'kind', type: 'text', notNull: true, default: 'run' },
        { name: 'notes', type: 'text' },
        { name: 'reps', type: 'integer' },
      ],
      indexes: [{ columns: ['party_id'] }],
      searchable: ['notes'],
    },
    {
      name: 'gear',
      columns: [
        { name: 'gear_id', type: 'text', primaryKey: true },
        { name: 'workout_id', type: 'text', references: `ext.${APP}.workout` },
        { name: 'label', type: 'text' },
      ],
    },
  ];
}

function appCred(): { cred: Credential; grantId: string } {
  const app = enrollApp(db, { name: APP, origin: 'generated' });
  const purpose = db.vault
    .prepare(`SELECT concept_id FROM core_concept WHERE notation = ?`)
    .get(PURPOSE) as { concept_id: string };
  const grantId = createGrant(db, {
    appId: app.appId,
    purposeConceptId: purpose.concept_id,
    grantedByPartyId: boot.ownerPartyId,
    scopes: [{ schema: `ext.${APP}`, verbs: 'read+act' }],
  });
  return { cred: { kind: 'app', appId: app.appId, signingKey: app.signingKey }, grantId };
}

beforeEach(() => {
  db = openVaultDb({});
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerPartyCommands(gw);
  registerLinkCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
});

describe('spec validation', () => {
  test('refuses missing pk, bad names, unknown types, foreign ext refs', () => {
    const ok = () => true;
    expect(() =>
      validateExtSpecs(APP, [{ name: 'x', columns: [{ name: 'a', type: 'text' }] }], ok),
    ).toThrow(/exactly one primaryKey/);
    expect(() =>
      validateExtSpecs(
        APP,
        [{ name: 'Bad-Name', columns: [{ name: 'a', type: 'text', primaryKey: true }] }],
        ok,
      ),
    ).toThrow(/invalid table name/);
    expect(() =>
      validateExtSpecs(
        APP,
        [
          {
            name: 'x',
            columns: [
              { name: 'a', type: 'text', primaryKey: true },
              { name: 'b', type: 'text', references: 'ext.other-app.t' },
            ],
          },
        ],
        ok,
      ),
    ).toThrow(/stay within app/);
  });
});

describe('apply + the write trio', () => {
  test('apply creates tables, registry rows and the typed commands', () => {
    const outcome = gw.applyAppExt(owner, APP, specs());
    expect(outcome.created.sort()).toEqual(['gear', 'workout']);
    expect(resolveEntity(`ext.${APP}.workout`, db.vault)?.physical).toBe('ext_gym_log_workout');
    expect(listVaultEntities(db.vault)).toContain(`ext.${APP}.workout`);
    const names = gw.discover(owner).map((c) => c.name);
    expect(names).toContain(`ext.${APP}.insert`);

    // The assistant's map shows the band: DDL, the ext note, the commands.
    const context = buildAssistantContext(db);
    expect(context).toContain('ext_gym_log_workout');
    expect(context).toContain('App extension tables');
    expect(context).toContain(`ext.${APP}.insert`);

    // vault_sql reads it like any table.
    const sql = gw.sql(owner, { sql: `SELECT count(*) AS n FROM ext_gym_log_workout` });
    expect(sql.rows[0]?.n).toBe(0);
  });

  test('an app with an ext scope inserts, updates, reads and deletes; unknown columns refuse', () => {
    gw.applyAppExt(owner, APP, specs());
    const { cred } = appCred();
    const ins = gw.invoke(cred, {
      command: `ext.${APP}.insert`,
      input: { table: 'workout', values: { kind: 'lift', notes: 'heavy day', reps: 5 } },
      purpose: PURPOSE,
    });
    expect(ins.status).toBe('executed');
    const id = (ins as { output: { id: string } }).output.id;

    const upd = gw.invoke(cred, {
      command: `ext.${APP}.update`,
      input: { table: 'workout', id, set: { reps: 8 } },
      purpose: PURPOSE,
    });
    expect(upd.status).toBe('executed');

    const read = gw.read(cred, { entity: `ext.${APP}.workout`, purpose: PURPOSE });
    expect(read.rows).toHaveLength(1);
    expect(read.rows[0]?.reps).toBe(8);

    const bad = gw.invoke(cred, {
      command: `ext.${APP}.insert`,
      input: { table: 'workout', values: { nope: 1 } },
      purpose: PURPOSE,
    });
    expect(bad.status).toBe('failed');
    expect((bad as { reason: string }).reason).toMatch(/unknown column "nope"/);

    const del = gw.invoke(cred, {
      command: `ext.${APP}.delete`,
      input: { table: 'workout', id },
      purpose: PURPOSE,
    });
    expect(del.status).toBe('executed');
    expect(gw.read(cred, { entity: `ext.${APP}.workout`, purpose: PURPOSE }).rows).toHaveLength(0);
  });

  test('an app without the scope is denied; another app cannot write the band', () => {
    gw.applyAppExt(owner, APP, specs());
    const stranger = enrollApp(db, { name: 'other-app', origin: 'generated' });
    const cred: Credential = {
      kind: 'app',
      appId: stranger.appId,
      signingKey: stranger.signingKey,
    };
    expect(() => gw.read(cred, { entity: `ext.${APP}.workout`, purpose: PURPOSE })).toThrow(
      GatewayError,
    );
    const write = gw.invoke(cred, {
      command: `ext.${APP}.insert`,
      input: { table: 'workout', values: {} },
      purpose: PURPOSE,
    });
    expect(write.status).toBe('denied');
  });

  test('ext rows link and tag like canonical entities; deleting sweeps links', () => {
    gw.applyAppExt(owner, APP, specs());
    const party = gw.invoke(owner, {
      command: 'core.add_party',
      input: { display_name: 'Rahul' },
      purpose: PURPOSE,
    }) as { output: { party_id: string } };
    const ins = gw.invoke(owner, {
      command: `ext.${APP}.insert`,
      input: { table: 'workout', values: { party_id: party.output.party_id, kind: 'row' } },
      purpose: PURPOSE,
    }) as { output: { id: string } };
    const link = gw.invoke(owner, {
      command: 'core.link_entities',
      input: {
        from_type: `ext.${APP}.workout`,
        from_id: ins.output.id,
        to_type: 'core.party',
        to_id: party.output.party_id,
        relation: 'references',
      },
      purpose: PURPOSE,
    });
    expect(link.status).toBe('executed');

    const del = gw.invoke(owner, {
      command: `ext.${APP}.delete`,
      input: { table: 'workout', id: ins.output.id },
      purpose: PURPOSE,
    });
    expect(del.status).toBe('executed');
    const live = db.vault
      .prepare(`SELECT count(*) AS n FROM core_link WHERE valid_to IS NULL AND from_type = ?`)
      .get(`ext.${APP}.workout`) as { n: number };
    expect(live.n).toBe(0); // the dangling-link duty end-dated it
  });

  test('search works over a searchable ext column (owner and granted app)', () => {
    gw.applyAppExt(owner, APP, specs());
    gw.invoke(owner, {
      command: `ext.${APP}.insert`,
      input: { table: 'workout', values: { notes: 'tempo intervals on the bridge' } },
      purpose: PURPOSE,
    });
    const hits = gw.search(owner, {
      entity: `ext.${APP}.workout`,
      query: 'tempo bridge',
      purpose: PURPOSE,
    });
    expect(hits.rows).toHaveLength(1);
    expect(String(hits.rows[0]?._snippet)).toContain('⟦');
  });
});

describe('diffing', () => {
  test('added column + dropped table apply; changed column shape refuses', () => {
    gw.applyAppExt(owner, APP, specs());
    gw.invoke(owner, {
      command: `ext.${APP}.insert`,
      input: { table: 'workout', values: { notes: 'keep me' } },
      purpose: PURPOSE,
    });

    const next = specs().filter((s) => s.name === 'workout');
    next[0]?.columns.push({ name: 'duration_s', type: 'integer' });
    const outcome = gw.applyAppExt(owner, APP, next);
    expect(outcome.altered).toEqual(['workout']);
    expect(outcome.dropped).toEqual(['gear']);
    const rows = gw.sql(owner, { sql: 'SELECT notes, duration_s FROM ext_gym_log_workout' });
    expect(rows.rows[0]?.notes).toBe('keep me'); // data survives the diff

    const bad = specs().filter((s) => s.name === 'workout');
    const kind = bad[0]?.columns.find((c) => c.name === 'kind');
    if (kind) kind.type = 'integer';
    expect(() => gw.applyAppExt(owner, APP, bad)).toThrow(/changed shape/);
  });

  test('canonicalSpecJson is order-stable for the fields that matter', () => {
    const a: ExtTableSpec = {
      name: 't',
      columns: [{ name: 'id', type: 'text', primaryKey: true }],
      searchable: ['b', 'a'],
    };
    const b: ExtTableSpec = {
      name: 't',
      columns: [{ name: 'id', type: 'text', primaryKey: true }],
      searchable: ['a', 'b'],
    };
    expect(canonicalSpecJson(a)).toBe(canonicalSpecJson(b));
  });
});

describe('drafts', () => {
  test('seed copies live rows; draft writes stay scratch; drop discards', () => {
    gw.applyAppExt(owner, APP, specs());
    gw.invoke(owner, {
      command: `ext.${APP}.insert`,
      input: { table: 'workout', values: { notes: 'live row' } },
      purpose: PURPOSE,
    });

    gw.seedAppExtDraft(owner, APP, specs());
    const draft = gw.read(owner, { entity: `extdraft.${APP}.workout`, purpose: PURPOSE });
    expect(draft.rows).toHaveLength(1); // seeded from live

    // Re-seeding is idempotent: rows survive; a schema edit diff-applies.
    const evolved = specs();
    evolved[0]?.columns.push({ name: 'mood', type: 'text' });
    const again = gw.seedAppExtDraft(owner, APP, evolved);
    expect(again.altered).toEqual(['workout']);
    expect(
      gw.read(owner, { entity: `extdraft.${APP}.workout`, purpose: PURPOSE }).rows,
    ).toHaveLength(1);
    // An explicit reset re-snapshots from live.
    gw.seedAppExtDraft(owner, APP, specs(), { reset: true });

    gw.invoke(owner, {
      command: `ext.${APP}.insert`,
      input: { table: 'workout', values: { notes: 'draft only' }, band: 'draft' },
      purpose: PURPOSE,
    });
    expect(
      gw.read(owner, { entity: `extdraft.${APP}.workout`, purpose: PURPOSE }).rows,
    ).toHaveLength(2);
    expect(gw.read(owner, { entity: `ext.${APP}.workout`, purpose: PURPOSE }).rows).toHaveLength(
      1,
    ); // live untouched

    gw.dropAppExtDraft(owner, APP);
    expect(resolveEntity(`extdraft.${APP}.workout`, db.vault)).toBeUndefined();
  });

  test('a draft with a NEW table publishes as a live DDL diff', () => {
    gw.applyAppExt(owner, APP, specs());
    const next = [
      ...specs(),
      {
        name: 'plan',
        columns: [{ name: 'plan_id', type: 'text' as const, primaryKey: true }],
      },
    ];
    gw.seedAppExtDraft(owner, APP, next);
    // Publish = apply the draft's specs to the live band + drop the draft.
    const outcome = gw.applyAppExt(owner, APP, next);
    expect(outcome.created).toEqual(['plan']);
    gw.dropAppExtDraft(owner, APP);
    expect(resolveEntity(`ext.${APP}.plan`, db.vault)).toBeDefined();
    expect(resolveEntity(`extdraft.${APP}.plan`, db.vault)).toBeUndefined();
  });
});

describe('uninstall and purge', () => {
  test('retain keeps rows but deregisters commands; purge drops everything', () => {
    gw.applyAppExt(owner, APP, specs());
    gw.invoke(owner, {
      command: `ext.${APP}.insert`,
      input: { table: 'workout', values: { notes: 'survives uninstall' } },
      purpose: PURPOSE,
    });

    gw.retainAppExt(owner, APP);
    expect(gw.discover(owner).map((c) => c.name)).not.toContain(`ext.${APP}.insert`);
    // The rows are still the owner's — reachable via SQL.
    const kept = gw.sql(owner, { sql: 'SELECT count(*) AS n FROM ext_gym_log_workout' });
    expect(kept.rows[0]?.n).toBe(1);

    // Re-apply (reinstall) revives band + commands over the same data.
    gw.applyAppExt(owner, APP, specs());
    expect(gw.discover(owner).map((c) => c.name)).toContain(`ext.${APP}.insert`);
    expect(
      gw.read(owner, { entity: `ext.${APP}.workout`, purpose: PURPOSE }).rows,
    ).toHaveLength(1);

    const purge = gw.purgeAppExt(owner, APP);
    expect(purge.purged.sort()).toEqual(['gear', 'workout']);
    expect(resolveEntity(`ext.${APP}.workout`, db.vault)).toBeUndefined();
    expect(() => gw.sql(owner, { sql: 'SELECT * FROM ext_gym_log_workout' })).toThrow();
  });

  test('the band surface is owner-only', () => {
    const { cred } = appCred();
    expect(() => gw.applyAppExt(cred, APP, specs())).toThrow(/owner/);
    expect(() => gw.purgeAppExt(cred, APP)).toThrow(/owner/);
  });
});

describe('export / import', () => {
  test('ext rows round-trip: tables recreated from specs, rows and hash intact', () => {
    gw.applyAppExt(owner, APP, specs());
    gw.invoke(owner, {
      command: `ext.${APP}.insert`,
      input: { table: 'workout', values: { notes: 'portable' } },
      purpose: PURPOSE,
    });
    const { artifact } = exportVault(db, {
      kind: 'owner-device',
      callerId: boot.deviceId,
      provAgentKind: 'owner',
      partyId: boot.ownerPartyId,
      riskCeiling: 'owner',
      mayAct: true,
    });
    expect(Object.keys(artifact.tables)).toContain(`ext.${APP}.workout`);

    const fresh = openVaultDb({});
    const { imported } = importVaultExport(fresh, artifact);
    expect(imported).toBeGreaterThan(0);
    const rows = fresh.vault.prepare('SELECT notes FROM ext_gym_log_workout').all() as {
      notes: string;
    }[];
    expect(rows).toEqual([{ notes: 'portable' }]);
    fresh.close();
  });
});
