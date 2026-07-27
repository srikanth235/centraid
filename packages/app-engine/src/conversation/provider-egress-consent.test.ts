import { expect, test } from 'vitest';
import { ConversationStore } from './store.js';
import { newProvider } from './store-test-fixtures.js';
import { ProviderEgressConsentStore } from './provider-egress-consent.js';

test('consent is isolated by conversation, provider, source, and ladder subsystem', () => {
  const provider = newProvider();
  const conversations = new ConversationStore(provider);
  const first = conversations.createConversation({ kind: 'chat', userId: 'u1', appId: 'app-one' });
  const second = conversations.createConversation({
    kind: 'chat',
    userId: 'u1',
    appId: 'app-one',
  });
  const consent = new ProviderEgressConsentStore(provider);

  consent.grant(first.id, 'codex', 'direct', undefined, 1_000);
  expect(consent.has(first.id, 'codex', 'assistant')).toBe(true);
  expect(consent.has(first.id, 'claude-code', 'assistant')).toBe(false);
  expect(consent.has(second.id, 'codex', 'assistant')).toBe(false);
  consent.revoke(first.id, 'codex', 1_001);
  expect(consent.has(first.id, 'codex', 'assistant')).toBe(false);

  consent.grant(first.id, 'codex', 'ladder', 'assistant', 1_002);
  consent.grant(first.id, 'codex', 'ladder', 'automations', 1_003);
  consent.grant(first.id, 'codex', 'direct', undefined, 1_004);
  consent.grant(second.id, 'codex', 'direct', undefined, 1_005);
  consent.revokeLadderProvider('codex', 'assistant', 1_006);

  // Removing one lane neither revokes the same provider's other ladder lane
  // nor overwrites/revokes a direct conversation grant.
  expect(consent.has(first.id, 'codex', 'assistant')).toBe(true);
  expect(consent.has(first.id, 'codex', 'automations')).toBe(true);
  expect(consent.has(second.id, 'codex', 'assistant')).toBe(true);
  expect(
    provider()
      .prepare(
        `SELECT source, subsystem, revoked_at
           FROM conversation_provider_consent
          WHERE conversation_id = ? AND runner_kind = ?
          ORDER BY source, subsystem`,
      )
      .all(first.id, 'codex'),
  ).toEqual([
    { source: 'direct', subsystem: '', revoked_at: null },
    { source: 'ladder', subsystem: 'assistant', revoked_at: 1_006 },
    { source: 'ladder', subsystem: 'automations', revoked_at: null },
  ]);

  consent.revoke(first.id, 'codex', 1_007);
  expect(consent.has(first.id, 'codex', 'assistant')).toBe(false);
  expect(consent.has(first.id, 'codex', 'automations')).toBe(false);
  expect(consent.has(second.id, 'codex', 'automations')).toBe(true);
});

test('ladder consent requires the authorizing subsystem', () => {
  const provider = newProvider();
  const conversations = new ConversationStore(provider);
  const conversation = conversations.createConversation({
    kind: 'chat',
    userId: 'u1',
    appId: 'app-one',
  });
  const consent = new ProviderEgressConsentStore(provider);

  expect(() => consent.grant(conversation.id, 'codex', 'ladder')).toThrow(
    'ladder provider consent requires a subsystem',
  );
});

test('a stale ladder row cannot authorize a runner removed while its vault was dormant', () => {
  const provider = newProvider();
  const conversations = new ConversationStore(provider);
  const conversation = conversations.createConversation({
    kind: 'chat',
    userId: 'u1',
    appId: 'app-one',
  });
  let member = true;
  const consent = new ProviderEgressConsentStore(
    provider,
    (kind, subsystem) => member && kind === 'codex' && subsystem === 'assistant',
  );
  consent.grant(conversation.id, 'codex', 'ladder', 'assistant', 1_000);
  expect(consent.has(conversation.id, 'codex', 'assistant')).toBe(true);
  member = false;
  expect(consent.has(conversation.id, 'codex', 'assistant')).toBe(false);

  // A separately approved direct grant remains valid after ladder removal.
  consent.grant(conversation.id, 'codex', 'direct', undefined, 1_001);
  expect(consent.has(conversation.id, 'codex', 'assistant')).toBe(true);
});
