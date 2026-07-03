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
import type { Credential, InvokeOutcome } from '../gateway/types.js';
import { uuidv7 } from '../ids.js';
import { registerSocialCommands } from './social.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;
let raviId: string;

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerSocialCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
  raviId = uuidv7();
  const now = new Date().toISOString();
  db.vault
    .prepare(
      `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at, ontology_version)
       VALUES (?, 'person', 'Ravi Kumar', ?, ?, '1.1')`,
    )
    .run(raviId, now, now);
});

function draft(body = 'Invoice attached — due in 14 days.'): {
  messageId: string;
  threadId: string;
} {
  const outcome = gw.invoke(owner, {
    command: 'social.draft_message',
    input: {
      body_text: body,
      recipient_party_id: raviId,
      channel: 'email',
      subject: 'Invoice 2026-014',
    },
    purpose: 'dpv:ServiceProvision',
  });
  if (outcome.status !== 'executed') throw new Error(`draft failed: ${JSON.stringify(outcome)}`);
  const output = outcome.output as { message_id: string; thread_id: string };
  return { messageId: output.message_id, threadId: output.thread_id };
}

test('draft_message opens a thread with both participants and a draft-state message', () => {
  const { messageId, threadId } = draft();
  const message = db.vault
    .prepare('SELECT delivery, sender_party_id FROM social_message WHERE message_id = ?')
    .get(messageId);
  expect(message).toMatchObject({ delivery: 'draft', sender_party_id: boot.ownerPartyId });
  const participants = db.vault
    .prepare('SELECT count(*) AS n FROM social_thread_participant WHERE thread_id = ?')
    .get(threadId) as { n: number };
  expect(participants.n).toBe(2);
});

test('identical draft bodies dedupe onto one content_item (P2: sha256 identity)', () => {
  const first = draft('same words');
  // New thread, same body text.
  const second = draft('same words');
  const firstBody = db.vault
    .prepare('SELECT body_content_id FROM social_message WHERE message_id = ?')
    .get(first.messageId) as { body_content_id: string };
  const secondBody = db.vault
    .prepare('SELECT body_content_id FROM social_message WHERE message_id = ?')
    .get(second.messageId) as { body_content_id: string };
  expect(secondBody.body_content_id).toBe(firstBody.body_content_id);
});

test('send_message: owner sends directly; draft → sent; thread last_message_at set', () => {
  const { messageId, threadId } = draft();
  const outcome = gw.invoke(owner, {
    command: 'social.send_message',
    input: { message_id: messageId },
    purpose: 'dpv:Billing',
  });
  expect(outcome.status).toBe('executed');
  const message = db.vault
    .prepare('SELECT delivery FROM social_message WHERE message_id = ?')
    .get(messageId);
  expect(message).toMatchObject({ delivery: 'sent' });
  const thread = db.vault
    .prepare('SELECT last_message_at FROM social_thread WHERE thread_id = ?')
    .get(threadId) as { last_message_at: string | null };
  expect(thread.last_message_at).not.toBeNull();
});

test('send_message refuses a non-draft (state machine holds)', () => {
  const { messageId } = draft();
  gw.invoke(owner, {
    command: 'social.send_message',
    input: { message_id: messageId },
    purpose: 'dpv:Billing',
  });
  const again = gw.invoke(owner, {
    command: 'social.send_message',
    input: { message_id: messageId },
    purpose: 'dpv:Billing',
  });
  expect(again.status).toBe('failed');
  if (again.status === 'failed') expect(again.predicate).toContain('message_is_draft');
});

test('agent send parks (risk=high > medium ceiling); owner approval releases it', () => {
  const { messageId } = draft();
  const agent = enrollAgent(db, { name: 'assistant', modelRef: 'model-x' });
  const device = enrollDevice(db, boot.ownerPartyId, 'agent-host');
  createGrant(db, {
    granteePartyId: agent.partyId,
    purposeConceptId: boot.concepts['dpv:Billing'] as string,
    grantedByPartyId: boot.ownerPartyId,
    scopes: [{ schema: 'social', verbs: 'read+act' }],
  });
  const cred: Credential = {
    kind: 'agent',
    agentId: agent.agentId,
    deviceId: device.deviceId,
    deviceKey: device.deviceKey,
  };
  const parked: InvokeOutcome = gw.invoke(cred, {
    command: 'social.send_message',
    input: { message_id: messageId },
    purpose: 'dpv:Billing',
  });
  expect(parked.status).toBe('parked');
  if (parked.status !== 'parked') return;
  // The pause between draft and send is gateway state (§10).
  const still = db.vault
    .prepare('SELECT delivery FROM social_message WHERE message_id = ?')
    .get(messageId);
  expect(still).toMatchObject({ delivery: 'draft' });
  const released = gw.confirm(owner, parked.invocationId, true);
  expect(released.status).toBe('executed');
  const sent = db.vault
    .prepare('SELECT delivery FROM social_message WHERE message_id = ?')
    .get(messageId);
  expect(sent).toMatchObject({ delivery: 'sent' });
});

test('resolve_identity binds a handle and backfills unresolved participants and senders', () => {
  // An imported thread where Ravi is only a raw address.
  const threadId = uuidv7();
  const now = new Date().toISOString();
  db.vault
    .prepare(`INSERT INTO social_thread (thread_id, channel, created_at) VALUES (?, 'email', ?)`)
    .run(threadId, now);
  db.vault
    .prepare(
      `INSERT INTO social_thread_participant (tp_id, thread_id, party_id, handle, muted)
       VALUES (?, ?, NULL, 'ravi@example.com', 0)`,
    )
    .run(uuidv7(), threadId);
  const contentId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO core_content_item (content_id, media_type, content_uri, sha256, byte_size, created_at)
       VALUES (?, 'text/plain', 'file:///m1', 'aa11', 5, ?)`,
    )
    .run(contentId, now);
  db.vault
    .prepare(
      `INSERT INTO social_message (message_id, thread_id, sender_party_id, sender_handle, sent_at, body_content_id, delivery)
       VALUES (?, ?, NULL, 'ravi@example.com', ?, ?, 'delivered')`,
    )
    .run(uuidv7(), threadId, now, contentId);

  const outcome = gw.invoke(owner, {
    command: 'social.resolve_identity',
    input: { party_id: raviId, scheme: 'email', value: 'ravi@example.com' },
    purpose: 'dpv:ServiceProvision',
  });
  expect(outcome.status).toBe('executed');
  if (outcome.status !== 'executed') return;
  expect(outcome.output).toMatchObject({ participants_resolved: 1, messages_resolved: 1 });
  const message = db.vault
    .prepare('SELECT sender_party_id, sender_handle FROM social_message WHERE thread_id = ?')
    .get(threadId);
  // Identity backfilled; the raw handle stays for audit.
  expect(message).toMatchObject({ sender_party_id: raviId, sender_handle: 'ravi@example.com' });
});

test('resolve_identity refuses a handle claimed by a different party (no identity forks)', () => {
  gw.invoke(owner, {
    command: 'social.resolve_identity',
    input: { party_id: raviId, scheme: 'email', value: 'ravi@example.com' },
    purpose: 'dpv:ServiceProvision',
  });
  const other = uuidv7();
  const now = new Date().toISOString();
  db.vault
    .prepare(
      `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at, ontology_version)
       VALUES (?, 'person', 'Impostor', ?, ?, '1.1')`,
    )
    .run(other, now, now);
  const outcome = gw.invoke(owner, {
    command: 'social.resolve_identity',
    input: { party_id: other, scheme: 'email', value: 'ravi@example.com' },
    purpose: 'dpv:ServiceProvision',
  });
  expect(outcome.status).toBe('failed');
  if (outcome.status === 'failed')
    expect(outcome.predicate).toContain('handle_not_claimed_elsewhere');
});

test('update_card upserts decoration without touching identity', () => {
  const first = gw.invoke(owner, {
    command: 'social.update_card',
    input: { party_id: raviId, nickname: 'Rav', favorite: 1 },
    purpose: 'dpv:ServiceProvision',
  });
  expect(first.status).toBe('executed');
  const second = gw.invoke(owner, {
    command: 'social.update_card',
    input: { party_id: raviId, note: 'met at the wedding' },
    purpose: 'dpv:ServiceProvision',
  });
  expect(second.status).toBe('executed');
  const card = db.vault
    .prepare('SELECT nickname, note, favorite FROM social_contact_card WHERE party_id = ?')
    .get(raviId);
  expect(card).toMatchObject({ nickname: 'Rav', note: 'met at the wedding', favorite: 1 });
  const cards = db.vault.prepare('SELECT count(*) AS n FROM social_contact_card').get() as {
    n: number;
  };
  expect(cards.n).toBe(1);
});

test('a self-thread (note to self) drafts with one participant and sends', () => {
  const outcome = gw.invoke(owner, {
    command: 'social.draft_message',
    input: {
      body_text: 'Buy stamps before Friday.',
      recipient_party_id: boot.ownerPartyId,
      channel: 'dm',
    },
    purpose: 'dpv:ServiceProvision',
  });
  expect(outcome.status).toBe('executed');
  const output = (outcome as { output: { message_id: string; thread_id: string } }).output;
  // The owner appears once — not a UNIQUE(thread_id, party_id) collision.
  const participants = db.vault
    .prepare('SELECT party_id FROM social_thread_participant WHERE thread_id = ?')
    .all(output.thread_id) as { party_id: string }[];
  expect(participants).toEqual([{ party_id: boot.ownerPartyId }]);
  const sent = gw.invoke(owner, {
    command: 'social.send_message',
    input: { message_id: output.message_id },
    purpose: 'dpv:ServiceProvision',
  });
  expect(sent.status).toBe('executed');
});

test('mark_thread_read stamps only the owner cursor and moves it forward', () => {
  const { threadId } = draft();
  const first = gw.invoke(owner, {
    command: 'social.mark_thread_read',
    input: { thread_id: threadId, read_at: '2026-07-03T10:00:00Z' },
    purpose: 'dpv:ServiceProvision',
  });
  expect(first.status).toBe('executed');
  const rows = db.vault
    .prepare('SELECT party_id, last_read_at FROM social_thread_participant WHERE thread_id = ?')
    .all(threadId) as { party_id: string; last_read_at: string | null }[];
  const ravi = rows.find((r) => r.party_id === raviId);
  expect(ravi?.last_read_at ?? null).toBeNull(); // only the owner reads their inbox
  const mine = rows.find((r) => r.party_id !== raviId);
  expect(mine?.last_read_at).toBe('2026-07-03T10:00:00Z');

  const again = gw.invoke(owner, {
    command: 'social.mark_thread_read',
    input: { thread_id: threadId, read_at: '2026-07-03T11:30:00Z' },
    purpose: 'dpv:ServiceProvision',
  });
  expect(again.status).toBe('executed');
  const later = db.vault
    .prepare(
      'SELECT last_read_at FROM social_thread_participant WHERE thread_id = ? AND party_id = ?',
    )
    .get(threadId, mine?.party_id ?? '') as { last_read_at: string };
  expect(later.last_read_at).toBe('2026-07-03T11:30:00Z');

  const ghost = gw.invoke(owner, {
    command: 'social.mark_thread_read',
    input: { thread_id: 'no-such-thread', read_at: '2026-07-03T10:00:00Z' },
    purpose: 'dpv:ServiceProvision',
  });
  expect(ghost.status).toBe('failed');
});
