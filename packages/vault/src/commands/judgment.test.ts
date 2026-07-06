// The learning loop (issue #310 C1, rule R08): corrections are recorded,
// the owner distills a standing judgment, the contract stage vetoes the
// next matching call, and revocation lifts it — learning as rows,
// auditable and revocable, end to end through typed commands.

import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, createGrant, enrollAgent, enrollDevice, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import type { Credential } from '../gateway/types.js';
import { registerJudgmentCommands } from './judgment.js';
import { registerTallyCommands } from './tally.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;
let agent: Credential;
let me: string;

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerJudgmentCommands(gw);
  registerTallyCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
  me = boot.ownerPartyId;
  const enrolled = enrollAgent(db, { name: 'assistant', modelRef: 'model-x' });
  const device = enrollDevice(db, boot.ownerPartyId, 'agent-host');
  createGrant(db, {
    granteePartyId: enrolled.partyId,
    purposeConceptId: boot.concepts['dpv:ServiceProvision'] as string,
    grantedByPartyId: boot.ownerPartyId,
    scopes: [
      { schema: 'agent', verbs: 'act' },
      { schema: 'tally', verbs: 'read+act' },
      { schema: 'core', verbs: 'read+act' },
      { schema: 'social', verbs: 'read+act' },
    ],
  });
  agent = {
    kind: 'agent',
    agentId: enrolled.agentId,
    deviceId: device.deviceId,
    deviceKey: device.deviceKey,
  };
});

function invoke(cred: Credential, command: string, input: Record<string, unknown>) {
  return gw.invoke(cred, { command, input, purpose: 'dpv:ServiceProvision' });
}
function out<T = Record<string, unknown>>(o: ReturnType<typeof invoke>): T {
  expect(o.status).toBe('executed');
  return (o as { output: T }).output;
}

test('record_correction validates the target and stamps the acting party', () => {
  const bad = invoke(owner, 'agent.record_correction', {
    target_type: 'no.such',
    target_id: 'x',
    after: { fixed: true },
  });
  expect(bad.status).toBe('failed');
  const ghost = invoke(owner, 'agent.record_correction', {
    target_type: 'core.party',
    target_id: 'ghost',
    after: { fixed: true },
  });
  expect(ghost.status).toBe('failed');

  const cid = out<{ correction_id: string }>(
    invoke(owner, 'agent.record_correction', {
      target_type: 'core.party',
      target_id: me,
      before: { display_name: 'Pria' },
      after: { display_name: 'Priya' },
      reason: 'misspelled by import',
    }),
  ).correction_id;
  const row = db.vault
    .prepare('SELECT corrected_by_party_id, reason FROM agent_correction WHERE correction_id = ?')
    .get(cid) as { corrected_by_party_id: string; reason: string };
  expect(row.corrected_by_party_id).toBe(me);
  expect(row.reason).toBe('misspelled by import');
});

test('the full loop: distilled judgment vetoes the command, revocation lifts it', () => {
  const cid = out<{ correction_id: string }>(
    invoke(owner, 'agent.record_correction', {
      target_type: 'core.party',
      target_id: me,
      after: { note: 'stop auto-adding friends' },
    }),
  ).correction_id;

  // Distillation is owner-only — the agent's attempt refuses.
  const refused = invoke(agent, 'agent.distill_judgment', {
    subject_scope: 'tally',
    rule: { veto_command: 'tally.add_friend' },
  });
  expect(refused.status).toBe('failed');

  const jid = out<{ judgment_id: string }>(
    invoke(owner, 'agent.distill_judgment', {
      subject_scope: 'tally',
      rule: { veto_command: 'tally.add_friend' },
      correction_id: cid,
    }),
  ).judgment_id;

  // The veto fires on the very next matching call (rule R08).
  const vetoed = invoke(owner, 'tally.add_friend', { name: 'Anyone' });
  expect(vetoed.status).toBe('failed');
  if (vetoed.status === 'failed') expect(vetoed.reason).toContain('judgment');

  // Revocation is rows too — the command works again.
  out(invoke(owner, 'agent.revoke_judgment', { judgment_id: jid }));
  expect(invoke(owner, 'tally.add_friend', { name: 'Anyone' }).status).toBe('executed');
});
