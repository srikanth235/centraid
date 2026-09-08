// governance: allow-repo-hygiene file-size-limit one command pack per domain is the vault contract (registered as a unit, read wholesale); social owns the whole conversation loop, so it is large by design.
// Social domain commands (§07): the domain resolves raw addresses to parties
// (never a duplicate person per channel) and owns conversation state. The
// message state machine — draft → sent → delivered → read | failed — moves
// outbound only via social.send_message, the highest-risk command in the
// model: risk=high, so apps and agents park for owner confirmation while the
// owner acts directly. Sending marks state; transport is a projection-side
// concern (the gateway keeps no byte custody and opens no sockets).

import type { Gateway } from "../gateway/gateway.js";
import type { CommandDefinition, HandlerCtx } from "../gateway/types.js";
import { sha256Hex } from "../ids.js";
import { bindContactReach } from "./contact-reach.js";
import { assertTextBodyWithinBudget } from "./inline-body-guard.js";

/** The acting party: the caller's own party, else the vault owner (apps). */
function actorPartyId(ctx: HandlerCtx): string {
  if (ctx.identity.partyId) return ctx.identity.partyId;
  const owner = ctx.db
    .prepare("SELECT self_party_id FROM core_vault LIMIT 1")
    .get() as { self_party_id: string | null } | undefined;
  if (!owner?.self_party_id) throw new Error("vault has no owner");
  return owner.self_party_id;
}

/** `:scheme` as the channel axis names it — `tel` is `phone` on a channel. */
const REACH_KIND_OF_SCHEME_SQL = `CASE :scheme WHEN 'tel' THEN 'phone' ELSE :scheme END`;

const RESOLVE_IDENTITY: CommandDefinition = {
  name: "social.resolve_identity",
  ownerSchema: "social",
  inputSchema: {
    type: "object",
    required: ["party_id", "scheme", "value"],
    additionalProperties: false,
    properties: {
      party_id: { type: "string", minLength: 1 },
      scheme: { type: "string", enum: ["email", "tel", "handle"] },
      value: { type: "string", minLength: 1 },
      label: { type: "string" },
    },
  },
  outputSchema: {
    type: "object",
    required: ["party_id"],
    properties: {
      party_id: { type: "string" },
      participants_resolved: { type: "integer" },
      messages_resolved: { type: "integer" },
    },
  },
  preconditions: [
    {
      name: "party_exists",
      sql: "SELECT count(*) AS n FROM core_party WHERE party_id = :party_id",
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      // A handle bound to a DIFFERENT party is an identity fork. Asked of
      // BOTH stores: reach lives in channels, claimed handles in the
      // register, and half the forks hide in whichever is not consulted.
      name: "handle_not_claimed_elsewhere",
      sql: `SELECT (
              (SELECT count(*) FROM core_party_identifier
                WHERE scheme = :scheme AND value = :value
                  AND party_id != :party_id)
              + (SELECT count(*) FROM social_contact_channel
                  WHERE kind = ${REACH_KIND_OF_SCHEME_SQL} AND value = :value
                    AND party_id != :party_id)
            ) AS n`,
      column: "n",
      op: "eq",
      value: 0,
    },
  ],
  postconditions: [
    {
      name: "identifier_bound",
      sql: `SELECT (
              (SELECT count(*) FROM core_party_identifier
                WHERE scheme = :scheme AND value = :value
                  AND party_id = :party_id)
              + (SELECT count(*) FROM social_contact_channel
                  WHERE kind = ${REACH_KIND_OF_SCHEME_SQL} AND value = :value
                    AND party_id = :party_id)
            ) AS n`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "idempotent",
  risk: "low",
  handler: resolveIdentity,
};

function resolveIdentity(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    party_id: string;
    scheme: string;
    value: string;
    label?: string;
  };
  // Email and phone are REACH and bind as channels; a claimed handle is an
  // identity KEY in the register (#883). One call decides which.
  const channelId = bindContactReach(ctx.db, {
    channelId: ctx.newId(),
    partyId: input.party_id,
    scheme: input.scheme,
    value: input.value,
    label: input.label ?? null,
    provenanceJson: JSON.stringify({ source: "social.resolve_identity" }),
    now: ctx.now,
  });
  if (channelId === null) {
    const existing = ctx.db
      .prepare(
        "SELECT identifier_id FROM core_party_identifier WHERE scheme = ? AND value = ?"
      )
      .get(input.scheme, input.value) as { identifier_id: string } | undefined;
    if (!existing) {
      const identifierId = ctx.newId();
      const hasPrimary = ctx.db
        .prepare(
          "SELECT 1 AS x FROM core_party_identifier WHERE party_id = ? AND scheme = ? AND is_primary = 1"
        )
        .get(input.party_id, input.scheme);
      ctx.db
        .prepare(
          `INSERT INTO core_party_identifier (identifier_id, party_id, scheme, value, label, is_primary, verified_at, valid_from, valid_to)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)`
        )
        .run(
          identifierId,
          input.party_id,
          input.scheme,
          input.value,
          input.label ?? null,
          hasPrimary ? 0 : 1,
          ctx.now
        );
      ctx.wrote("core.party_identifier", identifierId);
    }
  } else ctx.wrote("social.contact_channel", channelId);
  // Backfill identity without rewriting the messages: the raw handle stays
  // for audit.
  const participants = ctx.db
    .prepare(
      "UPDATE social_thread_participant SET party_id = ? WHERE handle = ? AND party_id IS NULL"
    )
    .run(input.party_id, input.value);
  const messages = ctx.db
    .prepare(
      "UPDATE social_message SET sender_party_id = ? WHERE sender_handle = ? AND sender_party_id IS NULL"
    )
    .run(input.party_id, input.value);
  ctx.cite({
    claim: `handle ${input.scheme}:${input.value} resolved to one identity across threads`,
    entityType: "core.party",
    entityId: input.party_id,
  });
  return {
    party_id: input.party_id,
    participants_resolved: Number(participants.changes),
    messages_resolved: Number(messages.changes),
  };
}

const DRAFT_MESSAGE: CommandDefinition = {
  name: "social.draft_message",
  ownerSchema: "social",
  inputSchema: {
    type: "object",
    required: ["body_text"],
    additionalProperties: false,
    properties: {
      body_text: { type: "string", minLength: 1 },
      thread_id: { type: "string", minLength: 1 },
      recipient_party_id: { type: "string", minLength: 1 },
      channel: { type: "string", enum: ["sms", "email", "dm", "group"] },
      subject: { type: "string" },
    },
  },
  outputSchema: {
    type: "object",
    required: ["message_id", "thread_id"],
    properties: {
      message_id: { type: "string" },
      thread_id: { type: "string" },
      body_content_id: { type: "string" },
    },
  },
  preconditions: [
    {
      // Either an existing thread or a recipient to open one with.
      name: "thread_or_recipient_exists",
      sql: `SELECT (CASE
              WHEN :thread_id IS NOT NULL THEN (SELECT count(*) FROM social_thread WHERE thread_id = :thread_id)
              WHEN :recipient_party_id IS NOT NULL THEN (SELECT count(*) FROM core_party WHERE party_id = :recipient_party_id)
              ELSE 0 END) AS n`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "message_is_draft",
      sql: `SELECT count(*) AS n FROM social_message WHERE message_id = :message_id AND delivery = 'draft'`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "once",
  risk: "medium",
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
         VALUES (?, ?, ?, NULL, ?, NULL)`
      )
      .run(threadId, input.channel ?? "dm", input.subject ?? null, ctx.now);
    ctx.wrote("social.thread", threadId);
    // A self-thread is one participant, not a UNIQUE collision.
    for (const partyId of new Set([
      sender,
      input.recipient_party_id as string,
    ])) {
      const tpId = ctx.newId();
      ctx.db
        .prepare(
          `INSERT INTO social_thread_participant (tp_id, thread_id, party_id, handle, joined_at, muted)
           VALUES (?, ?, ?, NULL, ?, 0)`
        )
        .run(tpId, threadId, partyId, ctx.now);
      ctx.wrote("social.thread_participant", tpId);
    }
  }
  // Rent the bytes, own the reference (P2): identical bodies dedupe on sha256.
  // text/plain stays inline forever (the FTS trigger reads content_uri
  // in-transaction, no CAS redirect possible) — refuse rather than let an
  // unbounded draft body bloat vault.db (#367).
  assertTextBodyWithinBudget(input.body_text, "text/plain");
  const bodyBytes = Buffer.from(input.body_text, "utf8");
  const sha = sha256Hex(input.body_text);
  let contentId: string;
  const existingContent = ctx.db
    .prepare("SELECT content_id FROM core_content_item WHERE sha256 = ?")
    .get(sha) as { content_id: string } | undefined;
  if (existingContent) {
    contentId = existingContent.content_id;
  } else {
    contentId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO core_content_item
           (content_id, media_type, content_uri, sha256, byte_size, title, language, creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
         VALUES (?, 'text/plain', ?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, ?)`
      )
      .run(
        contentId,
        `data:text/plain;charset=utf-8,${encodeURIComponent(input.body_text)}`,
        sha,
        bodyBytes.length,
        sender,
        ctx.now
      );
    ctx.wrote("core.content_item", contentId);
  }
  const messageId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO social_message
         (message_id, thread_id, sender_party_id, sender_handle, sent_at, body_content_id, in_reply_to_id, delivery, external_id)
       VALUES (?, ?, ?, NULL, ?, ?, NULL, 'draft', NULL)`
    )
    .run(messageId, threadId, sender, ctx.now, contentId);
  ctx.wrote("social.message", messageId);
  ctx.cite({
    claim: `draft composed in thread ${threadId}; sending stays behind its own command`,
    entityType: "social.thread",
    entityId: threadId,
  });
  return {
    message_id: messageId,
    thread_id: threadId,
    body_content_id: contentId,
  };
}

const SEND_MESSAGE: CommandDefinition = {
  name: "social.send_message",
  ownerSchema: "social",
  inputSchema: {
    type: "object",
    required: ["message_id"],
    additionalProperties: false,
    properties: { message_id: { type: "string", minLength: 1 } },
  },
  outputSchema: {
    type: "object",
    required: ["message_id", "delivery"],
    properties: {
      message_id: { type: "string" },
      delivery: { type: "string" },
    },
  },
  preconditions: [
    {
      // Only drafts send: sent/delivered/read/failed are provider-sync states.
      name: "message_is_draft",
      sql: `SELECT count(*) AS n FROM social_message WHERE message_id = :message_id AND delivery = 'draft'`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "message_sent",
      sql: `SELECT count(*) AS n FROM social_message WHERE message_id = :message_id AND delivery = 'sent'`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "once",
  // Tier 3 semantic egress (#306): structure cannot verify a send, so it
  // parks for every non-owner caller.
  risk: "high",
  confirm: true,
  handler: sendMessage,
};

function sendMessage(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { message_id: string };
  const message = ctx.db
    .prepare("SELECT thread_id FROM social_message WHERE message_id = ?")
    .get(input.message_id) as { thread_id: string } | undefined;
  if (!message) throw new Error("message vanished between check and execute");
  ctx.db
    .prepare(
      `UPDATE social_message SET delivery = 'sent', sent_at = ? WHERE message_id = ?`
    )
    .run(ctx.now, input.message_id);
  ctx.db
    .prepare("UPDATE social_thread SET last_message_at = ? WHERE thread_id = ?")
    .run(ctx.now, message.thread_id);
  ctx.wrote("social.message", input.message_id);
  ctx.cite({
    claim: `draft ${input.message_id} released for delivery`,
    entityType: "social.message",
    entityId: input.message_id,
  });
  return { message_id: input.message_id, delivery: "sent" };
}

// There is deliberately no card command (#883): the role line and nickname
// belong to `people.edit_person`, the note to `people.add_note`, the favourite
// to `people.star_person`. A second writer is how two copies disagree.

const MARK_THREAD_READ: CommandDefinition = {
  name: "social.mark_thread_read",
  ownerSchema: "social",
  inputSchema: {
    type: "object",
    required: ["thread_id", "read_at"],
    additionalProperties: false,
    properties: {
      thread_id: { type: "string", minLength: 1 },
      read_at: { type: "string", minLength: 1 },
    },
  },
  outputSchema: {
    type: "object",
    required: ["thread_id"],
    properties: { thread_id: { type: "string" } },
  },
  preconditions: [
    {
      name: "thread_exists",
      sql: "SELECT count(*) AS n FROM social_thread WHERE thread_id = :thread_id",
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "owner_cursor_stamped",
      sql: `SELECT count(*) AS n FROM social_thread_participant tp
             WHERE tp.thread_id = :thread_id AND tp.last_read_at = :read_at
               AND tp.party_id = (SELECT self_party_id FROM core_vault LIMIT 1)`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  // Opening a thread re-stamps the cursor with a newer instant every time —
  // repeated marks are the normal case, not a replay to refuse.
  idempotency: "idempotent",
  risk: "low",
  handler: markThreadRead,
};

function markThreadRead(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { thread_id: string; read_at: string };
  const owner = ctx.db
    .prepare("SELECT self_party_id FROM core_vault LIMIT 1")
    .get() as {
    self_party_id: string;
  };
  // The owner reads their own inbox: a missing participant row means the
  // owner simply hasn't spoken in this thread yet — joining as a silent
  // participant keeps the projection true (drafting later reuses the row).
  const existing = ctx.db
    .prepare(
      "SELECT tp_id FROM social_thread_participant WHERE thread_id = ? AND party_id = ?"
    )
    .get(input.thread_id, owner.self_party_id) as { tp_id: string } | undefined;
  if (existing) {
    ctx.db
      .prepare(
        "UPDATE social_thread_participant SET last_read_at = ? WHERE tp_id = ?"
      )
      .run(input.read_at, existing.tp_id);
    ctx.wrote("social.thread_participant", existing.tp_id);
  } else {
    const tpId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO social_thread_participant (tp_id, thread_id, party_id, handle, joined_at, muted, last_read_at)
         VALUES (?, ?, ?, NULL, ?, 0, ?)`
      )
      .run(tpId, input.thread_id, owner.self_party_id, ctx.now, input.read_at);
    ctx.wrote("social.thread_participant", tpId);
  }
  return { thread_id: input.thread_id };
}

export function registerSocialCommands(gateway: Gateway): void {
  gateway.registerCommand(RESOLVE_IDENTITY);
  gateway.registerCommand(DRAFT_MESSAGE);
  gateway.registerCommand(SEND_MESSAGE);
  gateway.registerCommand(MARK_THREAD_READ);
}
