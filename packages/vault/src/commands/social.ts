// Social domain commands (§07): the domain resolves raw addresses to parties
// (never a duplicate person per channel) and owns conversation state. The
// message state machine — draft → sent → delivered → read | failed — moves
// outbound only via social.send_message, the highest-risk command in the
// model: risk=high, so apps and agents park for owner confirmation while the
// owner acts directly. Sending marks state; transport is a projection-side
// concern (the gateway keeps no byte custody and opens no sockets).

import type { Gateway } from '../gateway/gateway.js';
import type { CommandDefinition, HandlerCtx } from '../gateway/types.js';
import { sha256Hex } from '../ids.js';

/** The acting party: the caller's own party, else the vault owner (apps). */
function actorPartyId(ctx: HandlerCtx): string {
  if (ctx.identity.partyId) return ctx.identity.partyId;
  const owner = ctx.db.prepare('SELECT owner_party_id FROM core_vault LIMIT 1').get() as
    | { owner_party_id: string | null }
    | undefined;
  if (!owner?.owner_party_id) throw new Error('vault has no owner');
  return owner.owner_party_id;
}

const RESOLVE_IDENTITY: CommandDefinition = {
  name: 'social.resolve_identity',
  ownerSchema: 'social',
  inputSchema: {
    type: 'object',
    required: ['party_id', 'scheme', 'value'],
    additionalProperties: false,
    properties: {
      party_id: { type: 'string', minLength: 1 },
      scheme: { type: 'string', enum: ['email', 'tel', 'handle'] },
      value: { type: 'string', minLength: 1 },
      label: { type: 'string' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['party_id'],
    properties: {
      party_id: { type: 'string' },
      participants_resolved: { type: 'integer' },
      messages_resolved: { type: 'integer' },
    },
  },
  preconditions: [
    {
      name: 'party_exists',
      sql: 'SELECT count(*) AS n FROM core_party WHERE party_id = :party_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      // A handle already bound to a *different* party is an identity fork.
      name: 'handle_not_claimed_elsewhere',
      sql: `SELECT count(*) AS n FROM core_party_identifier
             WHERE scheme = :scheme AND value = :value AND party_id != :party_id`,
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  postconditions: [
    {
      name: 'identifier_bound',
      sql: `SELECT count(*) AS n FROM core_party_identifier
             WHERE scheme = :scheme AND value = :value AND party_id = :party_id`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: resolveIdentity,
};

function resolveIdentity(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { party_id: string; scheme: string; value: string; label?: string };
  const existing = ctx.db
    .prepare('SELECT identifier_id FROM core_party_identifier WHERE scheme = ? AND value = ?')
    .get(input.scheme, input.value) as { identifier_id: string } | undefined;
  if (!existing) {
    const identifierId = ctx.newId();
    const hasPrimary = ctx.db
      .prepare(
        'SELECT 1 AS x FROM core_party_identifier WHERE party_id = ? AND scheme = ? AND is_primary = 1',
      )
      .get(input.party_id, input.scheme);
    ctx.db
      .prepare(
        `INSERT INTO core_party_identifier (identifier_id, party_id, scheme, value, label, is_primary, verified_at, valid_from, valid_to)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
      )
      .run(
        identifierId,
        input.party_id,
        input.scheme,
        input.value,
        input.label ?? null,
        hasPrimary ? 0 : 1,
        ctx.now,
      );
    ctx.wrote('core.party_identifier', identifierId);
  }
  // Backfill identity without rewriting the messages (§03 social.message):
  // the raw handle stays for audit; the party reference is what resolution adds.
  const participants = ctx.db
    .prepare(
      'UPDATE social_thread_participant SET party_id = ? WHERE handle = ? AND party_id IS NULL',
    )
    .run(input.party_id, input.value);
  const messages = ctx.db
    .prepare(
      'UPDATE social_message SET sender_party_id = ? WHERE sender_handle = ? AND sender_party_id IS NULL',
    )
    .run(input.party_id, input.value);
  ctx.cite({
    claim: `handle ${input.scheme}:${input.value} resolved to one identity across threads`,
    entityType: 'core.party',
    entityId: input.party_id,
  });
  return {
    party_id: input.party_id,
    participants_resolved: Number(participants.changes),
    messages_resolved: Number(messages.changes),
  };
}

const DRAFT_MESSAGE: CommandDefinition = {
  name: 'social.draft_message',
  ownerSchema: 'social',
  inputSchema: {
    type: 'object',
    required: ['body_text'],
    additionalProperties: false,
    properties: {
      body_text: { type: 'string', minLength: 1 },
      thread_id: { type: 'string', minLength: 1 },
      recipient_party_id: { type: 'string', minLength: 1 },
      channel: { type: 'string', enum: ['sms', 'email', 'dm', 'group'] },
      subject: { type: 'string' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['message_id', 'thread_id'],
    properties: {
      message_id: { type: 'string' },
      thread_id: { type: 'string' },
      body_content_id: { type: 'string' },
    },
  },
  preconditions: [
    {
      // Either an existing thread or a recipient to open one with.
      name: 'thread_or_recipient_exists',
      sql: `SELECT (CASE
              WHEN :thread_id IS NOT NULL THEN (SELECT count(*) FROM social_thread WHERE thread_id = :thread_id)
              WHEN :recipient_party_id IS NOT NULL THEN (SELECT count(*) FROM core_party WHERE party_id = :recipient_party_id)
              ELSE 0 END) AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'message_is_draft',
      sql: `SELECT count(*) AS n FROM social_message WHERE message_id = :message_id AND delivery = 'draft'`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'medium',
  handler: draftMessage,
};

function draftMessage(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    body_text: string;
    thread_id?: string;
    recipient_party_id?: string;
    channel?: string;
    subject?: string;
  };
  const sender = actorPartyId(ctx);
  let threadId = input.thread_id ?? null;
  if (!threadId) {
    threadId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO social_thread (thread_id, channel, subject, external_ref, created_at, last_message_at)
         VALUES (?, ?, ?, NULL, ?, NULL)`,
      )
      .run(threadId, input.channel ?? 'dm', input.subject ?? null, ctx.now);
    ctx.wrote('social.thread', threadId);
    // A self-thread (owner messaging themselves — a note to self) is one
    // participant, not a UNIQUE(thread_id, party_id) collision.
    for (const partyId of new Set([sender, input.recipient_party_id as string])) {
      const tpId = ctx.newId();
      ctx.db
        .prepare(
          `INSERT INTO social_thread_participant (tp_id, thread_id, party_id, handle, joined_at, muted)
           VALUES (?, ?, ?, NULL, ?, 0)`,
        )
        .run(tpId, threadId, partyId, ctx.now);
      ctx.wrote('social.thread_participant', tpId);
    }
  }
  // Rent the bytes, own the reference (P2): identical bodies dedupe on sha256.
  const bodyBytes = Buffer.from(input.body_text, 'utf8');
  const sha = sha256Hex(input.body_text);
  let contentId: string;
  const existingContent = ctx.db
    .prepare('SELECT content_id FROM core_content_item WHERE sha256 = ?')
    .get(sha) as { content_id: string } | undefined;
  if (existingContent) {
    contentId = existingContent.content_id;
  } else {
    contentId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO core_content_item
           (content_id, media_type, content_uri, sha256, byte_size, title, language, creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
         VALUES (?, 'text/plain', ?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, ?)`,
      )
      .run(
        contentId,
        `data:text/plain;charset=utf-8,${encodeURIComponent(input.body_text)}`,
        sha,
        bodyBytes.length,
        sender,
        ctx.now,
      );
    ctx.wrote('core.content_item', contentId);
  }
  const messageId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO social_message
         (message_id, thread_id, sender_party_id, sender_handle, sent_at, body_content_id, in_reply_to_id, delivery, external_id)
       VALUES (?, ?, ?, NULL, ?, ?, NULL, 'draft', NULL)`,
    )
    .run(messageId, threadId, sender, ctx.now, contentId);
  ctx.wrote('social.message', messageId);
  ctx.cite({
    claim: `draft composed in thread ${threadId}; sending stays behind its own command`,
    entityType: 'social.thread',
    entityId: threadId,
  });
  return { message_id: messageId, thread_id: threadId, body_content_id: contentId };
}

const SEND_MESSAGE: CommandDefinition = {
  name: 'social.send_message',
  ownerSchema: 'social',
  inputSchema: {
    type: 'object',
    required: ['message_id'],
    additionalProperties: false,
    properties: { message_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['message_id', 'delivery'],
    properties: { message_id: { type: 'string' }, delivery: { type: 'string' } },
  },
  preconditions: [
    {
      // Only drafts send: sent/delivered/read/failed are provider-sync states.
      name: 'message_is_draft',
      sql: `SELECT count(*) AS n FROM social_message WHERE message_id = :message_id AND delivery = 'draft'`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'message_sent',
      sql: `SELECT count(*) AS n FROM social_message WHERE message_id = :message_id AND delivery = 'sent'`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'high',
  handler: sendMessage,
};

function sendMessage(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { message_id: string };
  const message = ctx.db
    .prepare('SELECT thread_id FROM social_message WHERE message_id = ?')
    .get(input.message_id) as { thread_id: string } | undefined;
  if (!message) throw new Error('message vanished between check and execute');
  ctx.db
    .prepare(`UPDATE social_message SET delivery = 'sent', sent_at = ? WHERE message_id = ?`)
    .run(ctx.now, input.message_id);
  ctx.db
    .prepare('UPDATE social_thread SET last_message_at = ? WHERE thread_id = ?')
    .run(ctx.now, message.thread_id);
  ctx.wrote('social.message', input.message_id);
  ctx.cite({
    claim: `draft ${input.message_id} released for delivery`,
    entityType: 'social.message',
    entityId: input.message_id,
  });
  return { message_id: input.message_id, delivery: 'sent' };
}

const UPDATE_CARD: CommandDefinition = {
  name: 'social.update_card',
  ownerSchema: 'social',
  inputSchema: {
    type: 'object',
    required: ['party_id'],
    additionalProperties: false,
    properties: {
      party_id: { type: 'string', minLength: 1 },
      nickname: { type: 'string' },
      note: { type: 'string' },
      favorite: { type: 'integer', minimum: 0, maximum: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['card_id'],
    properties: { card_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'party_exists',
      sql: 'SELECT count(*) AS n FROM core_party WHERE party_id = :party_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'card_decorates_party',
      sql: 'SELECT count(*) AS n FROM social_contact_card WHERE party_id = :party_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: updateCard,
};

function updateCard(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    party_id: string;
    nickname?: string;
    note?: string;
    favorite?: number;
  };
  const existing = ctx.db
    .prepare('SELECT card_id FROM social_contact_card WHERE party_id = ?')
    .get(input.party_id) as { card_id: string } | undefined;
  let cardId: string;
  if (existing) {
    cardId = existing.card_id;
    ctx.db
      .prepare(
        `UPDATE social_contact_card SET
           nickname = COALESCE(?, nickname),
           note = COALESCE(?, note),
           favorite = COALESCE(?, favorite),
           vcard_rev = ?
         WHERE card_id = ?`,
      )
      .run(input.nickname ?? null, input.note ?? null, input.favorite ?? null, ctx.now, cardId);
  } else {
    cardId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO social_contact_card (card_id, party_id, nickname, org_title, related_org_party_id, note, favorite, vcard_rev)
         VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        cardId,
        input.party_id,
        input.nickname ?? null,
        input.note ?? null,
        input.favorite ?? 0,
        ctx.now,
      );
  }
  ctx.wrote('social.contact_card', cardId);
  return { card_id: cardId };
}

const MARK_THREAD_READ: CommandDefinition = {
  name: 'social.mark_thread_read',
  ownerSchema: 'social',
  inputSchema: {
    type: 'object',
    required: ['thread_id', 'read_at'],
    additionalProperties: false,
    properties: {
      thread_id: { type: 'string', minLength: 1 },
      read_at: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['thread_id'],
    properties: { thread_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'thread_exists',
      sql: 'SELECT count(*) AS n FROM social_thread WHERE thread_id = :thread_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'owner_cursor_stamped',
      sql: `SELECT count(*) AS n FROM social_thread_participant tp
             WHERE tp.thread_id = :thread_id AND tp.last_read_at = :read_at
               AND tp.party_id = (SELECT owner_party_id FROM core_vault LIMIT 1)`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  // Opening a thread re-stamps the cursor with a newer instant every time —
  // repeated marks are the normal case, not a replay to refuse.
  idempotency: 'idempotent',
  risk: 'low',
  handler: markThreadRead,
};

function markThreadRead(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { thread_id: string; read_at: string };
  const owner = ctx.db.prepare('SELECT owner_party_id FROM core_vault LIMIT 1').get() as {
    owner_party_id: string;
  };
  // The owner reads their own inbox: a missing participant row means the
  // owner simply hasn't spoken in this thread yet — joining as a silent
  // participant keeps the projection true (drafting later reuses the row).
  const existing = ctx.db
    .prepare('SELECT tp_id FROM social_thread_participant WHERE thread_id = ? AND party_id = ?')
    .get(input.thread_id, owner.owner_party_id) as { tp_id: string } | undefined;
  if (existing) {
    ctx.db
      .prepare('UPDATE social_thread_participant SET last_read_at = ? WHERE tp_id = ?')
      .run(input.read_at, existing.tp_id);
    ctx.wrote('social.thread_participant', existing.tp_id);
  } else {
    const tpId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO social_thread_participant (tp_id, thread_id, party_id, handle, joined_at, muted, last_read_at)
         VALUES (?, ?, ?, NULL, ?, 0, ?)`,
      )
      .run(tpId, input.thread_id, owner.owner_party_id, ctx.now, input.read_at);
    ctx.wrote('social.thread_participant', tpId);
  }
  return { thread_id: input.thread_id };
}

/** Register the social domain's commands on a gateway. */
export function registerSocialCommands(gateway: Gateway): void {
  gateway.registerCommand(RESOLVE_IDENTITY);
  gateway.registerCommand(DRAFT_MESSAGE);
  gateway.registerCommand(SEND_MESSAGE);
  gateway.registerCommand(UPDATE_CARD);
  gateway.registerCommand(MARK_THREAD_READ);
}
