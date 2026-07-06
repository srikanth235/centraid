// The one-shot pull consent story (issue #290 phase 3): an agent stages
// parsed rows freely (risk low), but PUBLISHING them exceeds every agent's
// ceiling and parks for the owner — the pause between draft and send.

import { beforeEach, expect, test } from 'vitest';
import {
  bootstrapVault,
  createGrant,
  enrollAgent,
  enrollDevice,
  type BootstrapResult,
} from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import { registerSyncCommands } from './sync.js';
import type { Credential } from '../gateway/types.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;
let agent: Credential;

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerSyncCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
  const enrolled = enrollAgent(db, { name: 'gmail-pull', modelRef: 'model-x' });
  const device = enrollDevice(db, boot.ownerPartyId, 'agent-host');
  createGrant(db, {
    granteePartyId: enrolled.partyId,
    purposeConceptId: boot.concepts['dpv:ServiceProvision'] as string,
    grantedByPartyId: boot.ownerPartyId,
    scopes: [{ schema: 'sync', verbs: 'act' }],
  });
  agent = {
    kind: 'agent',
    agentId: enrolled.agentId,
    deviceId: device.deviceId,
    deviceKey: device.deviceKey,
  };
});

const ROWS = [
  {
    entity_type: 'core.event',
    external_id: 'gcal-evt-1',
    payload: {
      uid: 'gcal-evt-1',
      summary: 'Flight to Goa',
      description: null,
      dtstart: '2026-07-18T04:30:00Z',
      dtend: null,
      startTz: null,
      rrule: null,
      status: 'confirmed',
    },
  },
];

test('agent stages freely; publish parks; owner approval lands the rows', () => {
  const staged = gw.invoke(agent, {
    command: 'sync.stage_rows',
    input: { kind: 'pull.gcal', label: 'srikanth@crowdshakti.com', rows: ROWS },
    purpose: 'dpv:ServiceProvision',
  });
  expect(staged.status).toBe('executed');
  const batchId = (staged as { output: { batch_id: string } }).output.batch_id;

  // Nothing landed — staging is reviewable state.
  expect(
    (db.vault.prepare('SELECT count(*) AS n FROM core_event').get() as { n: number }).n,
  ).toBe(0);

  const publish = gw.invoke(agent, {
    command: 'sync.publish_batch',
    input: { batch_id: batchId },
    purpose: 'dpv:ServiceProvision',
  });
  expect(publish.status).toBe('parked'); // high > agent ceiling medium

  const confirmed = gw.confirm(
    owner,
    (publish as { invocationId: string }).invocationId,
    true,
  );
  expect(confirmed.status).toBe('executed');
  expect((confirmed as { output: { created: number } }).output.created).toBe(1);
  const event = db.vault
    .prepare('SELECT summary FROM core_event WHERE ical_uid = ?')
    .get('gcal-evt-1') as { summary: string };
  expect(event.summary).toBe('Flight to Goa');
  // The map recorded the pull's identity — a re-stage skips.
  const again = gw.invoke(agent, {
    command: 'sync.stage_rows',
    input: { kind: 'pull.gcal', label: 'srikanth@crowdshakti.com', rows: ROWS },
    purpose: 'dpv:ServiceProvision',
  });
  expect((again as { output: { staged: { skip: number } } }).output.staged.skip).toBe(1);
});

test('owner denial keeps the vault untouched; the draft survives for later', () => {
  const staged = gw.invoke(agent, {
    command: 'sync.stage_rows',
    input: { kind: 'pull.gcal', label: 'work', rows: ROWS },
    purpose: 'dpv:ServiceProvision',
  });
  const batchId = (staged as { output: { batch_id: string } }).output.batch_id;
  const publish = gw.invoke(agent, {
    command: 'sync.publish_batch',
    input: { batch_id: batchId },
    purpose: 'dpv:ServiceProvision',
  });
  const denied = gw.confirm(owner, (publish as { invocationId: string }).invocationId, false);
  expect(denied.status).toBe('denied');
  expect(
    (db.vault.prepare('SELECT count(*) AS n FROM core_event').get() as { n: number }).n,
  ).toBe(0);
  const batch = db.vault
    .prepare('SELECT status FROM sync_import_batch WHERE batch_id = ?')
    .get(batchId) as { status: string };
  expect(batch.status).toBe('draft');
});

test('an unpublishable entity type is refused at staging time', () => {
  const outcome = gw.invoke(agent, {
    command: 'sync.stage_rows',
    input: {
      kind: 'pull.x',
      label: 'x',
      rows: [{ entity_type: 'locker.item', external_id: 'e1', payload: {} }],
    },
    purpose: 'dpv:ServiceProvision',
  });
  expect(outcome.status).toBe('failed');
  expect((outcome as { reason: string }).reason).toMatch(/no publisher/);
});

test('the owner publishes directly — no parking above their ceiling', () => {
  const staged = gw.invoke(owner, {
    command: 'sync.stage_rows',
    input: { kind: 'pull.gcal', label: 'mine', rows: ROWS },
    purpose: 'dpv:ServiceProvision',
  });
  const batchId = (staged as { output: { batch_id: string } }).output.batch_id;
  const publish = gw.invoke(owner, {
    command: 'sync.publish_batch',
    input: { batch_id: batchId },
    purpose: 'dpv:ServiceProvision',
  });
  expect(publish.status).toBe('executed');
});
