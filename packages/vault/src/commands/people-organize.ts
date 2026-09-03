// governance: allow-repo-hygiene file-size-limit one cohesive People channel command contract whose validation, normalization, revision snapshots, and registration must stay reviewable together

import type { Gateway } from "../gateway/gateway.js";
import type { CommandDefinition, HandlerCtx } from "../gateway/types.js";
import type { ChannelKind } from "./contact-reach.js";
import { duplicatePartyIds, normalizeContactChannel } from "./contact-reach.js";
import {
  loadEntityRevision,
  markEntityRevisionUndone,
  recordEntityRevision,
} from "./entity-revisions.js";
import { queueProviderWriteback } from "./provider-writeback.js";

const STRING = { type: "string", minLength: 1 } as const;
const PERSON_LIVE_SQL = `SELECT count(*) AS n FROM people_profile
  WHERE party_id = :party_id AND deleted_at IS NULL`;

interface ChannelRow {
  channel_id: string;
  party_id: string;
  kind: ChannelKind;
  label: string | null;
  value: string;
  normalized_value: string;
  is_preferred: number;
  provenance_json: string | null;
  created_at: string;
  updated_at: string;
}

function channelById(ctx: HandlerCtx, channelId: string): ChannelRow {
  const row = ctx.db
    .prepare("SELECT * FROM social_contact_channel WHERE channel_id = ?")
    .get(channelId) as ChannelRow | undefined;
  if (!row) throw new Error("contact channel not found");
  return row;
}

function recordChannelRevision(ctx: HandlerCtx, row: ChannelRow) {
  return recordEntityRevision(ctx, {
    entityType: "people.channel",
    entityId: row.channel_id,
    operation: "edit",
    snapshot: row,
  });
}

const SAVE_CHANNEL: CommandDefinition = {
  name: "people.save_contact_channel",
  ownerSchema: "social",
  inputSchema: {
    type: "object",
    required: ["party_id", "kind", "value"],
    additionalProperties: false,
    properties: {
      channel_id: STRING,
      party_id: STRING,
      kind: { type: "string", enum: ["phone", "email", "address", "handle"] },
      label: { type: "string", maxLength: 100 },
      value: { type: "string", minLength: 1, maxLength: 500 },
      preferred: { type: "boolean" },
      provenance: { type: "object" },
    },
  },
  outputSchema: {
    type: "object",
    required: ["channel_id", "normalized_value", "duplicate_party_ids"],
    properties: {
      channel_id: STRING,
      normalized_value: STRING,
      duplicate_party_ids: { type: "array", items: STRING },
      revision_id: STRING,
      undo_until: STRING,
    },
  },
  preconditions: [
    {
      name: "person_live",
      sql: PERSON_LIVE_SQL,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [],
  idempotency: "idempotent",
  risk: "low",
  handler: (ctx) => {
    const input = ctx.input as {
      channel_id?: string;
      party_id: string;
      kind: ChannelKind;
      label?: string;
      value: string;
      preferred?: boolean;
      provenance?: Record<string, unknown>;
    };
    const normalized = normalizeContactChannel(input.kind, input.value);
    const existing = input.channel_id
      ? channelById(ctx, input.channel_id)
      : undefined;
    if (existing && existing.party_id !== input.party_id)
      throw new Error("contact channel belongs to another person");
    const collision = ctx.db
      .prepare(
        `SELECT channel_id FROM social_contact_channel
          WHERE party_id = ? AND kind = ? AND normalized_value = ?
            AND channel_id <> ?`
      )
      .get(input.party_id, input.kind, normalized, input.channel_id ?? "");
    if (collision) throw new Error("this contact channel is already saved");
    const revision = existing
      ? recordChannelRevision(ctx, existing)
      : undefined;
    if (input.preferred) {
      ctx.db
        .prepare(
          `UPDATE social_contact_channel SET is_preferred = 0, updated_at = ?
            WHERE party_id = ? AND kind = ?`
        )
        .run(ctx.now, input.party_id, input.kind);
    }
    const channelId = input.channel_id ?? ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO social_contact_channel
          (channel_id, party_id, kind, label, value, normalized_value,
           is_preferred, provenance_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET kind = excluded.kind,
           label = excluded.label, value = excluded.value,
           normalized_value = excluded.normalized_value,
           is_preferred = excluded.is_preferred,
           provenance_json = excluded.provenance_json,
           updated_at = excluded.updated_at`
      )
      .run(
        channelId,
        input.party_id,
        input.kind,
        input.label ?? null,
        input.value.trim(),
        normalized,
        input.preferred ? 1 : 0,
        input.provenance ? JSON.stringify(input.provenance) : null,
        existing?.created_at ?? ctx.now,
        ctx.now
      );
    ctx.wrote("social.contact_channel", channelId);
    if (input.kind === "email" || input.kind === "phone") {
      queueProviderWriteback(ctx, "core.party", input.party_id, [
        input.kind === "email" ? "emailAddresses" : "phoneNumbers",
      ]);
    }
    return {
      channel_id: channelId,
      normalized_value: normalized,
      duplicate_party_ids: duplicatePartyIds(
        ctx.db,
        input.party_id,
        input.kind,
        normalized
      ),
      ...(revision
        ? {
            revision_id: revision.revisionId,
            undo_until: revision.undoUntil,
          }
        : {}),
    };
  },
};

const DELETE_CHANNEL: CommandDefinition = {
  name: "people.delete_contact_channel",
  ownerSchema: "social",
  inputSchema: {
    type: "object",
    required: ["channel_id"],
    additionalProperties: false,
    properties: { channel_id: STRING },
  },
  outputSchema: {
    type: "object",
    required: ["channel_id", "revision_id", "undo_until"],
    properties: {
      channel_id: STRING,
      revision_id: STRING,
      undo_until: STRING,
    },
  },
  preconditions: [],
  postconditions: [],
  idempotency: "once",
  risk: "low",
  handler: (ctx) => {
    const { channel_id: channelId } = ctx.input as { channel_id: string };
    const row = channelById(ctx, channelId);
    const revision = recordEntityRevision(ctx, {
      entityType: "people.channel",
      entityId: channelId,
      operation: "delete",
      snapshot: row,
    });
    ctx.db
      .prepare("DELETE FROM social_contact_channel WHERE channel_id = ?")
      .run(channelId);
    ctx.wrote("social.contact_channel", channelId);
    if (row.kind === "email" || row.kind === "phone") {
      queueProviderWriteback(ctx, "core.party", row.party_id, [
        row.kind === "email" ? "emailAddresses" : "phoneNumbers",
      ]);
    }
    return {
      channel_id: channelId,
      revision_id: revision.revisionId,
      undo_until: revision.undoUntil,
    };
  },
};

function restoreChannel(ctx: HandlerCtx, row: ChannelRow): void {
  ctx.db
    .prepare(
      `INSERT OR REPLACE INTO social_contact_channel
        (channel_id, party_id, kind, label, value, normalized_value,
         is_preferred, provenance_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.channel_id,
      row.party_id,
      row.kind,
      row.label,
      row.value,
      row.normalized_value,
      row.is_preferred,
      row.provenance_json,
      row.created_at,
      ctx.now
    );
  ctx.wrote("social.contact_channel", row.channel_id);
  if (row.kind === "email" || row.kind === "phone") {
    queueProviderWriteback(ctx, "core.party", row.party_id, [
      row.kind === "email" ? "emailAddresses" : "phoneNumbers",
    ]);
  }
}

const UNDO_CHANNEL: CommandDefinition = {
  name: "people.undo_contact_channel",
  ownerSchema: "social",
  inputSchema: {
    type: "object",
    required: ["channel_id"],
    additionalProperties: false,
    properties: { channel_id: STRING, revision_id: STRING },
  },
  outputSchema: {
    type: "object",
    required: ["channel_id"],
    properties: { channel_id: STRING },
  },
  preconditions: [],
  postconditions: [],
  idempotency: "once",
  risk: "low",
  handler: (ctx) => {
    const input = ctx.input as { channel_id: string; revision_id?: string };
    const revision = loadEntityRevision<ChannelRow>(ctx, {
      entityType: "people.channel",
      entityId: input.channel_id,
      revisionId: input.revision_id,
    });
    restoreChannel(ctx, revision.snapshot);
    markEntityRevisionUndone(ctx, revision.revisionId);
    return { channel_id: input.channel_id };
  },
};

export function registerPeopleOrganizeCommands(gateway: Gateway): void {
  gateway.registerCommand(SAVE_CHANNEL);
  gateway.registerCommand(DELETE_CHANNEL);
  gateway.registerCommand(UNDO_CHANNEL);
}
