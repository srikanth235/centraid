// The outbox consent story (issue #306): an agent stages an external write
// as an inert artifact (risk low); deciding is the owner's act on the thing
// itself; "always allow" mints a standing (actor, verb, target) grant that
// approves the next matching item at staging time; the drain record is the
// executor's receipt. Nothing here touches the network — that's the
// gateway-side executor's job, behind the allowWrites lane.

import { beforeEach, describe, expect, test } from 'vitest';
import {
  bootstrapVault,
  createGrant,
  enrollAgent,
  enrollDevice,
  type BootstrapResult,
} from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import { registerOutboxCommands } from './outbox.js';
import type { Credential, InvokeOutcome } from '../gateway/types.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;
let agent: Credential;

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerOutboxCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
  const enrolled = enrollAgent(db, { name: 'gmail-send', modelRef: 'model-x' });
  const device = enrollDevice(db, boot.ownerPartyId, 'agent-host');
  createGrant(db, {
    granteePartyId: enrolled.partyId,
    purposeConceptId: boot.concepts['dpv:ServiceProvision'] as string,
    grantedByPartyId: boot.ownerPartyId,
    scopes: [{ schema: 'outbox', verbs: 'act' }],
  });
  agent = {
    kind: 'agent',
    agentId: enrolled.agentId,
    deviceId: device.deviceId,
    deviceKey: device.deviceKey,
  };
  db.vault
    .prepare(
      `INSERT INTO sync_connection (connection_id, kind, label, principal, status, trust, created_at)
       VALUES ('conn-1', 'pull.gmail', 'personal', NULL, 'active', 'staged', ?)`,
    )
    .run(new Date().toISOString());
});

function stageInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'pull.gmail',
    label: 'personal',
    verb: 'gmail.send',
    target: 'ravi@example.com',
    artifact: { to: 'ravi@example.com', subject: 'Hi', body: 'See you at 6.' },
    request: {
      method: 'POST',
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      headers: { authorization: 'Bearer {{connection:access_token}}' },
      body: '{"raw":"…"}',
    },
    ...overrides,
  };
}

function invoke(cred: Credential, command: string, input: Record<string, unknown>): InvokeOutcome {
  return gw.invoke(cred, { command, input });
}

function itemRow(itemId: string): Record<string, unknown> {
  return db.vault.prepare('SELECT * FROM outbox_item WHERE item_id = ?').get(itemId) as Record<
    string,
    unknown
  >;
}

describe('outbox.stage', () => {
  test('an agent stages an inert pending item; the artifact and request persist', () => {
    const outcome = invoke(agent, 'outbox.stage', stageInput());
    expect(outcome.status).toBe('executed');
    if (outcome.status !== 'executed') return;
    const out = outcome.output as { item_id: string; status: string };
    expect(out.status).toBe('pending');
    const row = itemRow(out.item_id);
    expect(row.status).toBe('pending');
    expect(row.actor_kind).toBe('ai_agent');
    expect(row.verb).toBe('gmail.send');
    expect(JSON.parse(String(row.artifact_json)).subject).toBe('Hi');
    // Placeholders, never tokens — the request row is injectable, not armed.
    expect(String(row.request_json)).toContain('{{connection:access_token}}');
  });

  test('staging toward an unknown connection fails — no orphan artifacts', () => {
    const outcome = invoke(agent, 'outbox.stage', stageInput({ label: 'nope' }));
    expect(outcome.status).toBe('failed');
    const n = db.vault.prepare('SELECT count(*) AS n FROM outbox_item').get() as { n: number };
    expect(n.n).toBe(0);
  });
});

describe('outbox.decide', () => {
  test('the decision is owner-only, even for an actor holding an outbox act scope', () => {
    const staged = invoke(agent, 'outbox.stage', stageInput());
    if (staged.status !== 'executed') throw new Error('stage failed');
    const itemId = (staged.output as { item_id: string }).item_id;
    const refused = invoke(agent, 'outbox.decide', { item_id: itemId, decision: 'approve' });
    expect(refused.status).toBe('failed');
    if (refused.status === 'failed') expect(refused.reason).toContain('owner');
    expect(itemRow(itemId).status).toBe('pending');
  });

  test('discard ends the item with no egress state; receipted like any act', () => {
    const staged = invoke(agent, 'outbox.stage', stageInput());
    if (staged.status !== 'executed') throw new Error('stage failed');
    const itemId = (staged.output as { item_id: string }).item_id;
    const outcome = invoke(owner, 'outbox.decide', { item_id: itemId, decision: 'discard' });
    expect(outcome.status).toBe('executed');
    const row = itemRow(itemId);
    expect(row.status).toBe('discarded');
    expect(row.decided_at).toBeTruthy();
    expect(row.drained_at).toBeNull();
  });

  test('edit-then-send: the decision may replace the artifact and request', () => {
    const staged = invoke(agent, 'outbox.stage', stageInput());
    if (staged.status !== 'executed') throw new Error('stage failed');
    const itemId = (staged.output as { item_id: string }).item_id;
    const outcome = invoke(owner, 'outbox.decide', {
      item_id: itemId,
      decision: 'approve',
      artifact: { to: 'ravi@example.com', subject: 'Hi (edited)', body: 'See you at 7.' },
      request: {
        method: 'POST',
        url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
        body: '{"raw":"edited"}',
      },
    });
    expect(outcome.status).toBe('executed');
    const row = itemRow(itemId);
    expect(row.status).toBe('approved');
    expect(JSON.parse(String(row.artifact_json)).subject).toBe('Hi (edited)');
    expect(JSON.parse(String(row.request_json)).body).toBe('{"raw":"edited"}');
  });

  test('an edit that replaces only one half is refused — artifact and request move together (issue #308 A5)', () => {
    const staged = invoke(agent, 'outbox.stage', stageInput());
    if (staged.status !== 'executed') throw new Error('stage failed');
    const itemId = (staged.output as { item_id: string }).item_id;
    const artifactOnly = invoke(owner, 'outbox.decide', {
      item_id: itemId,
      decision: 'approve',
      artifact: { to: 'ravi@example.com', subject: 'Hi (edited)', body: 'See you at 7.' },
    });
    expect(artifactOnly.status).toBe('failed');
    if (artifactOnly.status === 'failed') expect(artifactOnly.reason).toContain('TOGETHER');
    // The item is untouched — still pending, original halves intact.
    const row = itemRow(itemId);
    expect(row.status).toBe('pending');
    expect(JSON.parse(String(row.artifact_json)).subject).toBe('Hi');
    const requestOnly = invoke(owner, 'outbox.decide', {
      item_id: itemId,
      decision: 'approve',
      request: { method: 'POST', url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send' },
    });
    expect(requestOnly.status).toBe('failed');
  });

  test('a decided item cannot be re-decided', () => {
    const staged = invoke(agent, 'outbox.stage', stageInput());
    if (staged.status !== 'executed') throw new Error('stage failed');
    const itemId = (staged.output as { item_id: string }).item_id;
    invoke(owner, 'outbox.decide', { item_id: itemId, decision: 'discard' });
    const again = invoke(owner, 'outbox.decide', { item_id: itemId, decision: 'approve' });
    expect(again.status).toBe('failed');
    if (again.status === 'failed') expect(again.predicate).toContain('item_is_pending');
  });
});

describe('standing grants (issue #306 phase 3)', () => {
  test('always-allow mints the (actor, verb, target) rule; the next matching item auto-approves', () => {
    const first = invoke(agent, 'outbox.stage', stageInput());
    if (first.status !== 'executed') throw new Error('stage failed');
    const firstId = (first.output as { item_id: string }).item_id;
    const decided = invoke(owner, 'outbox.decide', {
      item_id: firstId,
      decision: 'approve',
      always_allow: true,
    });
    expect(decided.status).toBe('executed');
    const grantId = (decided as { output?: { grant_id?: string } }).output?.grant_id;
    expect(grantId).toBeTruthy();

    // Same actor, same verb, same target → approved at staging time.
    const second = invoke(agent, 'outbox.stage', stageInput());
    if (second.status !== 'executed') throw new Error('stage failed');
    const out = second.output as { item_id: string; status: string; grant_id?: string };
    expect(out.status).toBe('approved');
    expect(out.grant_id).toBe(grantId);

    // Different target → back to pending; the grant is scoped, not a blanket.
    const other = invoke(agent, 'outbox.stage', stageInput({ target: 'meera@example.com' }));
    if (other.status !== 'executed') throw new Error('stage failed');
    expect((other.output as { status: string }).status).toBe('pending');
  });

  test('a revoked grant stops matching', () => {
    const first = invoke(agent, 'outbox.stage', stageInput());
    if (first.status !== 'executed') throw new Error('stage failed');
    const decided = invoke(owner, 'outbox.decide', {
      item_id: (first.output as { item_id: string }).item_id,
      decision: 'approve',
      always_allow: true,
    });
    const grantId = (decided as { output?: { grant_id?: string } }).output?.grant_id as string;
    const revoked = invoke(owner, 'outbox.revoke_grant', { grant_id: grantId });
    expect(revoked.status).toBe('executed');
    const next = invoke(agent, 'outbox.stage', stageInput());
    if (next.status !== 'executed') throw new Error('stage failed');
    expect((next.output as { status: string }).status).toBe('pending');
  });

  test('revocation retro-invalidates: approved-but-undrained items park back to pending (issue #308 A8)', () => {
    const first = invoke(agent, 'outbox.stage', stageInput());
    if (first.status !== 'executed') throw new Error('stage failed');
    const decided = invoke(owner, 'outbox.decide', {
      item_id: (first.output as { item_id: string }).item_id,
      decision: 'approve',
      always_allow: true,
    });
    const grantId = (decided as { output?: { grant_id?: string } }).output?.grant_id as string;
    // Two more matching items auto-approve at staging; neither has drained.
    const second = invoke(agent, 'outbox.stage', stageInput());
    const third = invoke(agent, 'outbox.stage', stageInput());
    if (second.status !== 'executed' || third.status !== 'executed') throw new Error('stage failed');
    const revoked = invoke(owner, 'outbox.revoke_grant', { grant_id: grantId });
    expect(revoked.status).toBe('executed');
    // All three: the always-allow decision stamped the grant onto the first
    // item too, so every approved-but-undrained rider of the rule reparks.
    expect((revoked as { output?: { reparked?: number } }).output?.reparked).toBe(3);
    for (const outcome of [first, second, third]) {
      const row = itemRow((outcome.output as { item_id: string }).item_id);
      expect(row.status).toBe('pending');
      expect(row.decided_at).toBeNull();
      expect(row.grant_id).toBeNull();
      expect(String(row.note)).toContain('revoked');
    }
  });

  test('a drained item is history — revocation leaves sent items sent', () => {
    const first = invoke(agent, 'outbox.stage', stageInput());
    if (first.status !== 'executed') throw new Error('stage failed');
    const firstId = (first.output as { item_id: string }).item_id;
    const decided = invoke(owner, 'outbox.decide', {
      item_id: firstId,
      decision: 'approve',
      always_allow: true,
    });
    const grantId = (decided as { output?: { grant_id?: string } }).output?.grant_id as string;
    invoke(owner, 'outbox.record_result', { item_id: firstId, disposition: 'sent', status_code: 200 });
    const revoked = invoke(owner, 'outbox.revoke_grant', { grant_id: grantId });
    expect(revoked.status).toBe('executed');
    expect((revoked as { output?: { reparked?: number } }).output?.reparked).toBe(0);
    expect(itemRow(firstId).status).toBe('sent');
  });
});

describe('outbox.repark (issue #308 A7)', () => {
  test('an approved item parks back to pending; owner-plane only', () => {
    const staged = invoke(agent, 'outbox.stage', stageInput());
    if (staged.status !== 'executed') throw new Error('stage failed');
    const itemId = (staged.output as { item_id: string }).item_id;
    invoke(owner, 'outbox.decide', { item_id: itemId, decision: 'approve' });
    // The staging actor cannot repark its own item.
    const forged = invoke(agent, 'outbox.repark', { item_id: itemId, note: 'nope' });
    expect(forged.status).toBe('failed');
    const real = invoke(owner, 'outbox.repark', {
      item_id: itemId,
      note: 'approval expired undrained after 24h — approve again to send',
    });
    expect(real.status).toBe('executed');
    const row = itemRow(itemId);
    expect(row.status).toBe('pending');
    expect(row.decided_at).toBeNull();
    expect(String(row.note)).toContain('expired');
    // A pending item cannot repark — the precondition holds the line.
    const again = invoke(owner, 'outbox.repark', { item_id: itemId });
    expect(again.status).toBe('failed');
  });
});

describe('outbox.record_result', () => {
  test('only an approved item drains; the record is owner-plane-only', () => {
    const staged = invoke(agent, 'outbox.stage', stageInput());
    if (staged.status !== 'executed') throw new Error('stage failed');
    const itemId = (staged.output as { item_id: string }).item_id;
    // Pending items never drain.
    const early = invoke(owner, 'outbox.record_result', { item_id: itemId, disposition: 'sent' });
    expect(early.status).toBe('failed');
    invoke(owner, 'outbox.decide', { item_id: itemId, decision: 'approve' });
    // The staging actor cannot mark its own item drained.
    const forged = invoke(agent, 'outbox.record_result', {
      item_id: itemId,
      disposition: 'sent',
    });
    expect(forged.status).toBe('failed');
    const real = invoke(owner, 'outbox.record_result', {
      item_id: itemId,
      disposition: 'sent',
      status_code: 200,
    });
    expect(real.status).toBe('executed');
    const row = itemRow(itemId);
    expect(row.status).toBe('sent');
    expect(row.drained_at).toBeTruthy();
    expect(JSON.parse(String(row.result_json)).status_code).toBe(200);
  });
});
