// The demo register (issue #290 phase 1): scenario data enters through the
// normal command pipeline but stays separable forever — seed.demo provenance,
// vault-side seed registry, invisible to the automation plane, purgeable in
// one receipted act.

import { beforeEach, describe, expect, test } from 'vitest';
import { registerTaskCommands } from '../commands/tasks.js';
import {
  bootstrapVault,
  createGrant,
  enrollAgent,
  enrollApp,
  enrollDevice,
  type BootstrapResult,
} from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { uuidv7 } from '../ids.js';
import { createGateway, Gateway } from './gateway.js';
import type { Credential, InvokeOutcome } from './types.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

function agentCredential(): Credential {
  const agent = enrollAgent(db, { name: 'automation', modelRef: 'model-x' });
  const device = enrollDevice(db, boot.ownerPartyId, 'agent-host');
  createGrant(db, {
    granteePartyId: agent.partyId,
    purposeConceptId: boot.concepts['dpv:ServiceProvision'] as string,
    grantedByPartyId: boot.ownerPartyId,
    scopes: [{ schema: 'schedule', table: 'task', verbs: 'read' }],
  });
  return {
    kind: 'agent',
    agentId: agent.agentId,
    deviceId: device.deviceId,
    deviceKey: device.deviceKey,
  };
}

function addTask(title: string, demo: boolean): InvokeOutcome {
  return gw.invoke(owner, {
    command: 'schedule.add_task',
    input: { title },
    purpose: 'dpv:ServiceProvision',
    ...(demo ? { demo: { appId: 'tasks' } } : {}),
  });
}

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerTaskCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
});

describe('demo register', () => {
  test('owner demo invoke executes, stamps seed.demo provenance, registers the row', () => {
    const outcome = addTask('Water the demo plants', true);
    expect(outcome.status).toBe('executed');
    const taskId = (outcome as { output: { task_id: string } }).output.task_id;
    const prov = db.journal
      .prepare(
        `SELECT prov_activity, used_json FROM consent_provenance
          WHERE entity_type = 'schedule.task' AND entity_id = ?`,
      )
      .get(taskId) as { prov_activity: string; used_json: string };
    expect(prov.prov_activity).toBe('seed.demo');
    expect(JSON.parse(prov.used_json)).toMatchObject({
      command: 'schedule.add_task',
      app: 'tasks',
    });
    const seed = db.vault
      .prepare(
        `SELECT app_id FROM consent_seed_row WHERE target_type = 'schedule.task' AND target_id = ?`,
      )
      .get(taskId) as { app_id: string };
    expect(seed.app_id).toBe('tasks');
  });

  test('non-owner demo invoke is a receipted deny', () => {
    const app = enrollApp(db, { name: 'tasks' });
    createGrant(db, {
      appId: app.appId,
      purposeConceptId: boot.concepts['dpv:ServiceProvision'] as string,
      grantedByPartyId: boot.ownerPartyId,
      scopes: [{ schema: 'schedule', verbs: 'act' }],
    });
    const cred: Credential = { kind: 'app', appId: app.appId, signingKey: app.signingKey };
    const outcome = gw.invoke(cred, {
      command: 'schedule.add_task',
      input: { title: 'sneaky' },
      purpose: 'dpv:ServiceProvision',
      demo: { appId: 'tasks' },
    });
    expect(outcome.status).toBe('denied');
    expect((outcome as { reason: string }).reason).toMatch(/owner-only/);
    const rows = db.vault.prepare('SELECT count(*) AS n FROM consent_seed_row').get() as {
      n: number;
    };
    expect(rows.n).toBe(0);
  });

  test('a plain owner invoke keeps command provenance and stays unregistered', () => {
    const outcome = addTask('Real task', false);
    expect(outcome.status).toBe('executed');
    const taskId = (outcome as { output: { task_id: string } }).output.task_id;
    const prov = db.journal
      .prepare(
        `SELECT prov_activity FROM consent_provenance WHERE entity_type = 'schedule.task' AND entity_id = ?`,
      )
      .get(taskId) as { prov_activity: string };
    expect(prov.prov_activity).toBe('command.schedule.add_task');
    const rows = db.vault.prepare('SELECT count(*) AS n FROM consent_seed_row').get() as {
      n: number;
    };
    expect(rows.n).toBe(0);
  });
});

describe('automation-plane exclusion', () => {
  test('agent reads never see seeded rows; owner reads do', () => {
    addTask('Demo errand', true);
    addTask('Real errand', false);
    const agent = agentCredential();
    const agentRows = gw.read(agent, {
      entity: 'schedule.task',
      purpose: 'dpv:ServiceProvision',
    }).rows;
    expect(agentRows).toHaveLength(1);
    expect(agentRows[0]?.title).toBe('Real errand');
    const ownerRows = gw.read(owner, {
      entity: 'schedule.task',
      purpose: 'dpv:ServiceProvision',
    }).rows;
    expect(ownerRows).toHaveLength(2);
  });

  test('the change feed skips seed.demo provenance', () => {
    const bootstrap = gw.changes(owner, {
      entities: ['schedule.task'],
      purpose: 'dpv:ServiceProvision',
      cursor: null,
    });
    addTask('Demo change', true);
    addTask('Real change', false);
    const pull = gw.changes(owner, {
      entities: ['schedule.task'],
      purpose: 'dpv:ServiceProvision',
      cursor: bootstrap.cursor,
    });
    expect(pull.changes).toHaveLength(1);
    expect(pull.changes[0]?.activity).toBe('command.schedule.add_task');
  });
});

describe('demo purge', () => {
  test('purge deletes seeded rows, empties the registry, and receipts counts', () => {
    addTask('Demo one', true);
    addTask('Demo two', true);
    addTask('Keep me', false);
    expect(gw.demoStatus(owner)).toEqual([{ appId: 'tasks', rows: 2 }]);
    const result = gw.purgeDemo(owner);
    expect(result.purged).toBe(2);
    expect(result.blocked).toHaveLength(0);
    const left = db.vault.prepare('SELECT title FROM schedule_task').all() as {
      title: string;
    }[];
    expect(left.map((r) => r.title)).toEqual(['Keep me']);
    expect(gw.demoStatus(owner)).toEqual([]);
    const receipt = db.journal
      .prepare(`SELECT detail_json FROM consent_receipt WHERE receipt_id = ?`)
      .get(result.receiptId) as { detail_json: string };
    expect(JSON.parse(receipt.detail_json)).toMatchObject({ purged: 2 });
    const purgeProv = db.journal
      .prepare(`SELECT count(*) AS n FROM consent_provenance WHERE prov_activity = 'seed.purge'`)
      .get() as { n: number };
    expect(purgeProv.n).toBe(2);
  });

  test('purge is scoped per app when asked', () => {
    addTask('Tasks demo', true);
    gw.invoke(owner, {
      command: 'schedule.add_task',
      input: { title: 'Agenda demo' },
      purpose: 'dpv:ServiceProvision',
      demo: { appId: 'agenda' },
    });
    const result = gw.purgeDemo(owner, 'agenda');
    expect(result.purged).toBe(1);
    expect(gw.demoStatus(owner)).toEqual([{ appId: 'tasks', rows: 1 }]);
  });

  test('a row held by non-demo data is reported blocked, not force-deleted', () => {
    // A demo task that a real (non-demo) subtask still references.
    const parent = addTask('Demo parent', true);
    const parentId = (parent as { output: { task_id: string } }).output.task_id;
    db.vault
      .prepare(
        `INSERT INTO schedule_task (task_id, owner_party_id, title, description, status, priority, due_at, completed_at, effort_min, parent_task_id, rrule)
         VALUES (?, ?, 'Real child', NULL, 'needs-action', 0, NULL, NULL, NULL, ?, NULL)`,
      )
      .run(uuidv7(), boot.ownerPartyId, parentId);
    const result = gw.purgeDemo(owner);
    expect(result.purged).toBe(0);
    expect(result.blocked).toEqual([{ entityType: 'schedule.task', entityId: parentId }]);
    // Still registered — a later purge (after the owner deletes the child) succeeds.
    expect(gw.demoStatus(owner)).toEqual([{ appId: 'tasks', rows: 1 }]);
  });

  test('purge is owner-only', () => {
    expect(() => gw.purgeDemo(agentCredential())).toThrow(/only the owner/);
  });
});
