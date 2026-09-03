// governance: allow-repo-hygiene file-size-limit the outbox lifecycle is one closed set validating each other's risk and state invariants (#306)

import type { Gateway } from "../gateway/gateway.js";
import type { CommandDefinition, HandlerCtx } from "../gateway/types.js";
import { sha256Hex } from "../ids.js";
import { resolveEntity } from "../schema/tables.js";
import { partyForReach } from "./contact-reach.js";

function ownerPartyId(ctx: HandlerCtx): string {
  const owner = ctx.db
    .prepare("SELECT self_party_id FROM core_vault LIMIT 1")
    .get() as { self_party_id: string | null } | undefined;
  if (!owner?.self_party_id) throw new Error("vault has no owner");
  return owner.self_party_id;
}

function partyForAddress(ctx: HandlerCtx, value: string): string | null {
  return partyForReach(ctx.db, null, value, ctx.now);
}

const REQUEST_SCHEMA = {
  type: "object",
  required: ["method", "url"],
  additionalProperties: false,
  properties: {
    method: { type: "string", enum: ["POST", "PUT", "PATCH", "DELETE"] },
    url: { type: "string", minLength: 1 },
    headers: { type: "object" },
    body: { type: "string" },
  },
} as const;

const STAGE: CommandDefinition = {
  name: "outbox.stage",
  ownerSchema: "outbox",
  inputSchema: {
    type: "object",
    required: ["kind", "label", "verb", "target", "artifact", "request"],
    additionalProperties: false,
    properties: {
      kind: { type: "string", minLength: 1 },
      label: { type: "string", minLength: 1 },
      verb: { type: "string", minLength: 1 },
      target: { type: "string", minLength: 1 },
      artifact: { type: "object" },
      request: REQUEST_SCHEMA,
      subject_type: { type: "string", minLength: 1 },
      subject_id: { type: "string", minLength: 1 },
      recipient_party_id: { type: "string", minLength: 1 },
    },
  },
  outputSchema: {
    type: "object",
    required: ["item_id", "status"],
    properties: {
      item_id: { type: "string" },
      status: { type: "string" },
      grant_id: { type: "string" },
    },
  },
  preconditions: [],
  postconditions: [
    {
      name: "item_staged",
      sql: `SELECT count(*) AS n FROM outbox_item WHERE item_id = :item_id AND status IN ('pending','approved')`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "once",
  risk: "low",
  handler: stageItem,
};

function stageItem(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    kind: string;
    label: string;
    verb: string;
    target: string;
    artifact: Record<string, unknown>;
    request: {
      method: string;
      url: string;
      headers?: Record<string, string>;
      body?: string;
    };
    subject_type?: string;
    subject_id?: string;
    recipient_party_id?: string;
  };
  const connection = ctx.db
    .prepare(
      "SELECT connection_id FROM sync_connection WHERE kind = ? AND label = ?"
    )
    .get(input.kind, input.label) as { connection_id: string } | undefined;
  if (!connection) {
    throw new Error(
      `no connection (${input.kind}, ${input.label}) — an outbox item drains through an existing connection's credential`
    );
  }
  if ((input.subject_type === undefined) !== (input.subject_id === undefined)) {
    throw new Error("subject_type and subject_id come together or not at all");
  }
  if (input.subject_type && input.subject_id) {
    const ref = resolveEntity(input.subject_type, ctx.db);
    if (!ref)
      throw new Error(
        `subject_type names unknown entity "${input.subject_type}"`
      );
    const pkRow = ctx.db
      .prepare(`PRAGMA table_info(${JSON.stringify(ref.physical)})`)
      .all() as {
      name: string;
      pk: number;
    }[];
    const pk = pkRow.find((r) => r.pk === 1)?.name;
    if (!pk) throw new Error(`no primary key on ${ref.physical}`);
    const live = ctx.db
      .prepare(`SELECT 1 AS x FROM "${ref.physical}" WHERE "${pk}" = ?`)
      .get(input.subject_id);
    if (!live)
      throw new Error(`no ${input.subject_type} with id ${input.subject_id}`);
  }
  let recipientPartyId = input.recipient_party_id ?? null;
  if (recipientPartyId) {
    const live = ctx.db
      .prepare("SELECT 1 AS x FROM core_party WHERE party_id = ?")
      .get(recipientPartyId);
    if (!live) throw new Error(`no core.party with id ${recipientPartyId}`);
  } else {
    recipientPartyId = partyForAddress(ctx, input.target);
  }
  const grant = ctx.db
    .prepare(
      `SELECT grant_id FROM outbox_grant
        WHERE actor_id = ? AND verb = ? AND target = ? AND revoked_at IS NULL`
    )
    .get(ctx.identity.callerId, input.verb, input.target) as
    | { grant_id: string }
    | undefined;
  const itemId = ctx.newId();
  const status = grant ? "approved" : "pending";
  ctx.db
    .prepare(
      `INSERT INTO outbox_item
         (item_id, connection_id, actor_id, actor_kind, verb, target,
          target_type, target_id, recipient_party_id, artifact_json, request_json,
          status, grant_id, staged_at, decided_at, drained_at, result_json, published_message_id, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`
    )
    .run(
      itemId,
      connection.connection_id,
      ctx.identity.callerId,
      ctx.identity.provAgentKind,
      input.verb,
      input.target,
      input.subject_type ?? null,
      input.subject_id ?? null,
      recipientPartyId,
      JSON.stringify(input.artifact),
      JSON.stringify(input.request),
      status,
      grant?.grant_id ?? null,
      ctx.now,
      grant ? ctx.now : null
    );
  ctx.wrote("outbox.item", itemId);
  ctx.cite({
    claim: grant
      ? `outbox item auto-approved by standing grant (${input.verb} → ${input.target})`
      : `outbox item staged for owner decision (${input.verb} → ${input.target})`,
    entityType: "outbox.item",
    entityId: itemId,
  });
  return {
    item_id: itemId,
    status,
    ...(grant ? { grant_id: grant.grant_id } : {}),
  };
}

const DECIDE: CommandDefinition = {
  name: "outbox.decide",
  ownerSchema: "outbox",
  inputSchema: {
    type: "object",
    required: ["item_id", "decision"],
    additionalProperties: false,
    properties: {
      item_id: { type: "string", minLength: 1 },
      decision: { type: "string", enum: ["approve", "discard"] },
      artifact: { type: "object" },
      request: REQUEST_SCHEMA,
      always_allow: { type: "boolean" },
      note: { type: "string" },
    },
  },
  outputSchema: {
    type: "object",
    required: ["item_id", "status"],
    properties: {
      item_id: { type: "string" },
      status: { type: "string" },
      grant_id: { type: "string" },
    },
  },
  preconditions: [
    {
      name: "item_is_pending",
      sql: `SELECT count(*) AS n FROM outbox_item WHERE item_id = :item_id AND status = 'pending'`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "item_decided",
      sql: `SELECT count(*) AS n FROM outbox_item WHERE item_id = :item_id AND status IN ('approved','discarded')`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "once",
  risk: "medium",
  handler: decideItem,
};

function decideItem(ctx: HandlerCtx): Record<string, unknown> {
  requireOwner(ctx, "the outbox decision is the owner's (issue #306 Tier 3)");
  const input = ctx.input as {
    item_id: string;
    decision: "approve" | "discard";
    artifact?: Record<string, unknown>;
    request?: Record<string, unknown>;
    always_allow?: boolean;
    note?: string;
  };
  if ((input.artifact === undefined) !== (input.request === undefined)) {
    throw new Error(
      "an edited outbox item replaces artifact and request TOGETHER — editing one half lets the approved artifact diverge from the wire request (issue #308 A5)"
    );
  }
  const item = ctx.db
    .prepare("SELECT actor_id, verb, target FROM outbox_item WHERE item_id = ?")
    .get(input.item_id) as
    | { actor_id: string; verb: string; target: string }
    | undefined;
  if (!item) throw new Error(`no outbox item ${input.item_id}`);
  let grantId: string | undefined;
  if (input.decision === "approve" && input.always_allow === true) {
    const existing = ctx.db
      .prepare(
        `SELECT grant_id FROM outbox_grant
          WHERE actor_id = ? AND verb = ? AND target = ? AND revoked_at IS NULL`
      )
      .get(item.actor_id, item.verb, item.target) as
      | { grant_id: string }
      | undefined;
    grantId = existing?.grant_id;
    if (!grantId) {
      grantId = ctx.newId();
      ctx.db
        .prepare(
          `INSERT INTO outbox_grant (grant_id, actor_id, verb, target, created_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, NULL)`
        )
        .run(grantId, item.actor_id, item.verb, item.target, ctx.now);
      ctx.wrote("outbox.grant", grantId);
    }
  }
  const status = input.decision === "approve" ? "approved" : "discarded";
  ctx.db
    .prepare(
      `UPDATE outbox_item
          SET status = ?, decided_at = ?,
              artifact_json = coalesce(?, artifact_json),
              request_json = coalesce(?, request_json),
              grant_id = coalesce(?, grant_id),
              note = coalesce(?, note)
        WHERE item_id = ?`
    )
    .run(
      status,
      ctx.now,
      input.artifact ? JSON.stringify(input.artifact) : null,
      input.request ? JSON.stringify(input.request) : null,
      grantId ?? null,
      input.note ?? null,
      input.item_id
    );
  ctx.wrote("outbox.item", input.item_id);
  ctx.cite({
    claim:
      input.decision === "approve"
        ? `owner approved outbox item (${item.verb} → ${item.target})${grantId ? " and minted a standing grant" : ""}`
        : `owner discarded outbox item (${item.verb} → ${item.target}) — no egress`,
    entityType: "outbox.item",
    entityId: input.item_id,
  });
  return {
    item_id: input.item_id,
    status,
    ...(grantId ? { grant_id: grantId } : {}),
  };
}

const RECORD_RESULT: CommandDefinition = {
  name: "outbox.record_result",
  ownerSchema: "outbox",
  inputSchema: {
    type: "object",
    required: ["item_id", "disposition"],
    additionalProperties: false,
    properties: {
      item_id: { type: "string", minLength: 1 },
      disposition: { type: "string", enum: ["sent", "failed"] },
      status_code: { type: "integer" },
      detail: { type: "string" },
    },
  },
  outputSchema: {
    type: "object",
    required: ["item_id", "status"],
    properties: { item_id: { type: "string" }, status: { type: "string" } },
  },
  preconditions: [
    {
      name: "item_is_approved",
      sql: `SELECT count(*) AS n FROM outbox_item WHERE item_id = :item_id AND status = 'approved'`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "item_drained",
      sql: `SELECT count(*) AS n FROM outbox_item WHERE item_id = :item_id AND status IN ('sent','failed') AND drained_at IS NOT NULL`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "once",
  risk: "low",
  handler: recordResult,
};

function recordResult(ctx: HandlerCtx): Record<string, unknown> {
  requireOwner(ctx, "only the executor (owner plane) records drains");
  const input = ctx.input as {
    item_id: string;
    disposition: "sent" | "failed";
    status_code?: number;
    detail?: string;
  };
  ctx.db
    .prepare(
      `UPDATE outbox_item SET status = ?, drained_at = ?, result_json = ? WHERE item_id = ?`
    )
    .run(
      input.disposition,
      ctx.now,
      JSON.stringify({
        ...(input.status_code === undefined
          ? {}
          : { status_code: input.status_code }),
        ...(input.detail === undefined ? {} : { detail: input.detail }),
      }),
      input.item_id
    );
  ctx.wrote("outbox.item", input.item_id);
  let messageId: string | null = null;
  if (input.disposition === "sent") {
    messageId = publishSentMessage(ctx, input.item_id);
    if (messageId) {
      ctx.db
        .prepare(
          "UPDATE outbox_item SET published_message_id = ? WHERE item_id = ?"
        )
        .run(messageId, input.item_id);
      ctx.cite({
        claim: "sent artifact published into the social spine",
        entityType: "social.message",
        entityId: messageId,
      });
    }
  }
  return {
    item_id: input.item_id,
    status: input.disposition,
    ...(messageId ? { message_id: messageId } : {}),
  };
}

function publishSentMessage(ctx: HandlerCtx, itemId: string): string | null {
  const item = ctx.db
    .prepare(
      `SELECT connection_id, verb, target, artifact_json, recipient_party_id
         FROM outbox_item WHERE item_id = ?`
    )
    .get(itemId) as
    | {
        connection_id: string;
        verb: string;
        target: string;
        artifact_json: string;
        recipient_party_id: string | null;
      }
    | undefined;
  if (!item) return null;
  const artifact = JSON.parse(item.artifact_json) as Record<string, unknown>;
  const bodyText =
    typeof artifact.body === "string"
      ? artifact.body
      : typeof artifact.text === "string"
        ? artifact.text
        : null;
  if (bodyText === null) return null;

  const existing = ctx.db
    .prepare("SELECT message_id FROM social_message WHERE external_id = ?")
    .get(`outbox:${itemId}`) as { message_id: string } | undefined;
  if (existing) return existing.message_id;

  const owner = ownerPartyId(ctx);
  const subject =
    typeof artifact.subject === "string" ? artifact.subject : null;

  const sha = sha256Hex(bodyText);
  let contentId = (
    ctx.db
      .prepare("SELECT content_id FROM core_content_item WHERE sha256 = ?")
      .get(sha) as { content_id: string } | undefined
  )?.content_id;
  if (!contentId) {
    contentId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO core_content_item
           (content_id, media_type, content_uri, sha256, byte_size, title, language, creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
         VALUES (?, 'text/plain', ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?)`
      )
      .run(
        contentId,
        `data:text/plain;charset=utf-8,${encodeURIComponent(bodyText)}`,
        sha,
        Buffer.byteLength(bodyText, "utf8"),
        subject,
        owner,
        ctx.now
      );
    ctx.wrote("core.content_item", contentId);
  }

  const externalRef = `outbox:${item.connection_id}:${item.target}`;
  const channel = /mail/u.test(item.verb) ? "email" : "dm";
  let threadId = (
    ctx.db
      .prepare("SELECT thread_id FROM social_thread WHERE external_ref = ?")
      .get(externalRef) as { thread_id: string } | undefined
  )?.thread_id;
  if (threadId) {
    ctx.db
      .prepare(
        "UPDATE social_thread SET last_message_at = ? WHERE thread_id = ?"
      )
      .run(ctx.now, threadId);
  } else {
    threadId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO social_thread (thread_id, channel, subject, external_ref, created_at, last_message_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(threadId, channel, subject, externalRef, ctx.now, ctx.now);
    ctx.wrote("social.thread", threadId);
  }

  const recipient =
    item.recipient_party_id ?? partyForAddress(ctx, item.target);
  ensureParticipant(ctx, threadId, owner, null);
  ensureParticipant(ctx, threadId, recipient, recipient ? null : item.target);

  const messageId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO social_message
         (message_id, thread_id, sender_party_id, sender_handle, sent_at, body_content_id, in_reply_to_id, delivery, external_id)
       VALUES (?, ?, ?, NULL, ?, ?, NULL, 'sent', ?)`
    )
    .run(messageId, threadId, owner, ctx.now, contentId, `outbox:${itemId}`);
  ctx.wrote("social.message", messageId);
  return messageId;
}

function ensureParticipant(
  ctx: HandlerCtx,
  threadId: string,
  partyId: string | null,
  handle: string | null
): void {
  if (!partyId && !handle) return;
  const present = partyId
    ? ctx.db
        .prepare(
          "SELECT 1 AS x FROM social_thread_participant WHERE thread_id = ? AND party_id = ?"
        )
        .get(threadId, partyId)
    : ctx.db
        .prepare(
          "SELECT 1 AS x FROM social_thread_participant WHERE thread_id = ? AND party_id IS NULL AND handle = ?"
        )
        .get(threadId, handle);
  if (present) return;
  const tpId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO social_thread_participant (tp_id, thread_id, party_id, handle, joined_at, muted, last_read_at)
       VALUES (?, ?, ?, ?, ?, 0, NULL)`
    )
    .run(tpId, threadId, partyId, handle, ctx.now);
  ctx.wrote("social.thread_participant", tpId);
}

const REVOKE_GRANT: CommandDefinition = {
  name: "outbox.revoke_grant",
  ownerSchema: "outbox",
  inputSchema: {
    type: "object",
    required: ["grant_id"],
    additionalProperties: false,
    properties: { grant_id: { type: "string", minLength: 1 } },
  },
  outputSchema: {
    type: "object",
    required: ["grant_id"],
    properties: { grant_id: { type: "string" } },
  },
  preconditions: [
    {
      name: "grant_is_live",
      sql: `SELECT count(*) AS n FROM outbox_grant WHERE grant_id = :grant_id AND revoked_at IS NULL`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "grant_revoked",
      sql: `SELECT count(*) AS n FROM outbox_grant WHERE grant_id = :grant_id AND revoked_at IS NOT NULL`,
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      name: "no_approved_items_ride_the_grant",
      sql: `SELECT count(*) AS n FROM outbox_item WHERE grant_id = :grant_id AND status = 'approved'`,
      column: "n",
      op: "eq",
      value: 0,
    },
  ],
  idempotency: "once",
  risk: "low",
  handler: (ctx) => {
    requireOwner(ctx, "only the owner revokes standing outbox grants");
    const input = ctx.input as { grant_id: string };
    ctx.db
      .prepare("UPDATE outbox_grant SET revoked_at = ? WHERE grant_id = ?")
      .run(ctx.now, input.grant_id);
    ctx.wrote("outbox.grant", input.grant_id);
    const undrained = ctx.db
      .prepare(
        `SELECT item_id FROM outbox_item WHERE grant_id = ? AND status = 'approved'`
      )
      .all(input.grant_id) as { item_id: string }[];
    if (undrained.length > 0) {
      ctx.db
        .prepare(
          `UPDATE outbox_item
              SET status = 'pending', decided_at = NULL, grant_id = NULL,
                  staged_at = ?,
                  note = 'standing grant revoked before drain — awaiting a fresh decision'
            WHERE grant_id = ? AND status = 'approved'`
        )
        .run(ctx.now, input.grant_id);
      for (const item of undrained) ctx.wrote("outbox.item", item.item_id);
      ctx.cite({
        claim: `standing grant revoked; ${undrained.length} approved-but-undrained item(s) parked back to pending`,
        entityType: "outbox.grant",
        entityId: input.grant_id,
      });
    }
    return { grant_id: input.grant_id, reparked: undrained.length };
  },
};

const REPARK: CommandDefinition = {
  name: "outbox.repark",
  ownerSchema: "outbox",
  inputSchema: {
    type: "object",
    required: ["item_id"],
    additionalProperties: false,
    properties: {
      item_id: { type: "string", minLength: 1 },
      note: { type: "string" },
    },
  },
  outputSchema: {
    type: "object",
    required: ["item_id", "status"],
    properties: { item_id: { type: "string" }, status: { type: "string" } },
  },
  preconditions: [
    {
      name: "item_is_approved",
      sql: `SELECT count(*) AS n FROM outbox_item WHERE item_id = :item_id AND status = 'approved'`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "item_back_to_pending",
      sql: `SELECT count(*) AS n FROM outbox_item WHERE item_id = :item_id AND status = 'pending' AND decided_at IS NULL`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "once",
  risk: "low",
  handler: (ctx) => {
    requireOwner(
      ctx,
      "only the executor (owner plane) reparks stale approvals"
    );
    const input = ctx.input as { item_id: string; note?: string };
    ctx.db
      .prepare(
        `UPDATE outbox_item
            SET status = 'pending', staged_at = ?, decided_at = NULL,
                grant_id = NULL, note = coalesce(?, note)
          WHERE item_id = ?`
      )
      .run(ctx.now, input.note ?? null, input.item_id);
    ctx.wrote("outbox.item", input.item_id);
    ctx.cite({
      claim: `approved outbox item parked back to pending${input.note ? ` — ${input.note}` : ""}`,
      entityType: "outbox.item",
      entityId: input.item_id,
    });
    return { item_id: input.item_id, status: "pending" };
  },
};

function requireOwner(ctx: HandlerCtx, refusal: string): void {
  if (ctx.identity.kind !== "owner-device") throw new Error(refusal);
}

export function registerOutboxCommands(gateway: Gateway): void {
  gateway.registerCommand(STAGE);
  gateway.registerCommand(DECIDE);
  gateway.registerCommand(RECORD_RESULT);
  gateway.registerCommand(REVOKE_GRANT);
  gateway.registerCommand(REPARK);
}
