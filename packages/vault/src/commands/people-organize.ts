// governance: allow-repo-hygiene file-size-limit one cohesive People channel + merge/undo command contract whose validation, normalization, revision snapshots, and registration must stay reviewable together
// Issue #630 People organization contract: normalized contact channels,
// duplicate warnings, and durable merge/undo. Party rows are never destroyed
// by a merge; the source profile is tombstoned and an explicit merge edge
// preserves identity for sync/import provenance.

import type { Gateway } from "../gateway/gateway.js";
import type { CommandDefinition, HandlerCtx } from "../gateway/types.js";
import {
  loadEntityRevision,
  markEntityRevisionUndone,
  recordEntityRevision,
} from "./entity-revisions.js";
import { queueProviderWriteback } from "./provider-writeback.js";

type ChannelKind = "phone" | "email" | "address" | "handle";

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

interface MergeSnapshot {
  sourceDeletedAt: string | null;
  sourcePurgeAt: string | null;
  sourceChannels: ChannelRow[];
}

const STRING = { type: "string", minLength: 1 } as const;
const PERSON_LIVE_SQL = `SELECT count(*) AS n FROM people_profile
  WHERE party_id = :party_id AND deleted_at IS NULL`;

export function normalizeContactChannel(
  kind: ChannelKind,
  rawValue: string
): string {
  const value = rawValue.trim();
  if (kind === "email") {
    const normalized = value.toLocaleLowerCase("en-US");
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized) ||
      normalized.length > 320
    )
      throw new Error("enter a valid email address");
    return normalized;
  }
  if (kind === "phone") {
    // Align with normalizeHandle("tel"): keep a leading + and strip every
    // separator (spaces, parens, dots, dashes) without inventing a second
    // digit-only dialect that disagreed on international prefixes.
    const prefix = value.startsWith("+") ? "+" : "";
    const digits = value.replace(/[\s().-]/gu, "").replace(/^\+/u, "");
    if (!/^\d{7,15}$/u.test(digits))
      throw new Error("enter a phone number with 7 to 15 digits");
    return `${prefix}${digits}`;
  }
  if (kind === "handle") {
    const normalized = value.replace(/^@/u, "").toLocaleLowerCase("en-US");
    if (
      normalized.length < 2 ||
      normalized.length > 100 ||
      !/^[\p{L}\p{N}._:@/-]+$/u.test(normalized)
    )
      throw new Error("enter a valid handle");
    return normalized;
  }
  const normalized = value
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("en-US");
  if (normalized.length < 3 || normalized.length > 500)
    throw new Error("enter a complete address");
  return normalized;
}

function channelById(ctx: HandlerCtx, channelId: string): ChannelRow {
  const row = ctx.db
    .prepare("SELECT * FROM social_contact_channel WHERE channel_id = ?")
    .get(channelId) as ChannelRow | undefined;
  if (!row) throw new Error("contact channel not found");
  return row;
}

function duplicatePartyIds(
  ctx: HandlerCtx,
  partyId: string,
  kind: ChannelKind,
  normalized: string
): string[] {
  return (
    ctx.db
      .prepare(
        `SELECT DISTINCT party_id FROM social_contact_channel
          WHERE kind = ? AND normalized_value = ? AND party_id <> ?
          ORDER BY party_id`
      )
      .all(kind, normalized, partyId) as Array<{ party_id: string }>
  ).map((row) => row.party_id);
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
        ctx,
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

const MERGE_PEOPLE: CommandDefinition = {
  name: "people.merge_people",
  ownerSchema: "people",
  inputSchema: {
    type: "object",
    required: ["source_party_id", "target_party_id"],
    additionalProperties: false,
    properties: {
      source_party_id: STRING,
      target_party_id: STRING,
    },
  },
  outputSchema: {
    type: "object",
    required: ["merge_id", "revision_id", "undo_until"],
    properties: {
      merge_id: STRING,
      revision_id: STRING,
      undo_until: STRING,
    },
  },
  preconditions: [],
  postconditions: [],
  idempotency: "once",
  risk: "low",
  handler: (ctx) => {
    const input = ctx.input as {
      source_party_id: string;
      target_party_id: string;
    };
    if (input.source_party_id === input.target_party_id)
      throw new Error("choose two different people");
    const source = ctx.db
      .prepare(
        `SELECT deleted_at, purge_at FROM people_profile
          WHERE party_id = ? AND deleted_at IS NULL`
      )
      .get(input.source_party_id) as
      | { deleted_at: string | null; purge_at: string | null }
      | undefined;
    const target = ctx.db
      .prepare(
        "SELECT 1 AS x FROM people_profile WHERE party_id = ? AND deleted_at IS NULL"
      )
      .get(input.target_party_id);
    if (!source || !target) throw new Error("both people must be active");
    const sourceChannels = ctx.db
      .prepare(
        "SELECT * FROM social_contact_channel WHERE party_id = ? ORDER BY channel_id"
      )
      .all(input.source_party_id) as unknown as ChannelRow[];
    const snapshot: MergeSnapshot = {
      sourceDeletedAt: source.deleted_at,
      sourcePurgeAt: source.purge_at,
      sourceChannels,
    };
    const revision = recordEntityRevision(ctx, {
      entityType: "people.merge",
      entityId: input.source_party_id,
      operation: "merge",
      snapshot,
    });
    for (const channel of sourceChannels) {
      const collision = ctx.db
        .prepare(
          `SELECT 1 AS x FROM social_contact_channel
            WHERE party_id = ? AND kind = ? AND normalized_value = ?`
        )
        .get(input.target_party_id, channel.kind, channel.normalized_value);
      if (collision) {
        ctx.db
          .prepare("DELETE FROM social_contact_channel WHERE channel_id = ?")
          .run(channel.channel_id);
      } else {
        ctx.db
          .prepare(
            "UPDATE social_contact_channel SET party_id = ?, updated_at = ? WHERE channel_id = ?"
          )
          .run(input.target_party_id, ctx.now, channel.channel_id);
      }
      ctx.wrote("social.contact_channel", channel.channel_id);
    }
    ctx.db
      .prepare(
        "UPDATE people_profile SET deleted_at = ?, purge_at = NULL WHERE party_id = ?"
      )
      .run(ctx.now, input.source_party_id);
    const mergeId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO people_merge
          (merge_id, source_party_id, target_party_id, revision_id, merged_at, undone_at)
         VALUES (?, ?, ?, ?, ?, NULL)`
      )
      .run(
        mergeId,
        input.source_party_id,
        input.target_party_id,
        revision.revisionId,
        ctx.now
      );
    ctx.wrote("people.profile", input.source_party_id);
    ctx.wrote("people.merge", mergeId);
    return {
      merge_id: mergeId,
      revision_id: revision.revisionId,
      undo_until: revision.undoUntil,
    };
  },
};

const UNDO_MERGE: CommandDefinition = {
  name: "people.undo_merge",
  ownerSchema: "people",
  inputSchema: {
    type: "object",
    required: ["source_party_id"],
    additionalProperties: false,
    properties: { source_party_id: STRING, revision_id: STRING },
  },
  outputSchema: {
    type: "object",
    required: ["source_party_id"],
    properties: { source_party_id: STRING },
  },
  preconditions: [],
  postconditions: [],
  idempotency: "once",
  risk: "low",
  handler: (ctx) => {
    const input = ctx.input as {
      source_party_id: string;
      revision_id?: string;
    };
    const revision = loadEntityRevision<MergeSnapshot>(ctx, {
      entityType: "people.merge",
      entityId: input.source_party_id,
      revisionId: input.revision_id,
    });
    ctx.db
      .prepare(
        `UPDATE people_profile SET deleted_at = ?, purge_at = ?
          WHERE party_id = ?`
      )
      .run(
        revision.snapshot.sourceDeletedAt,
        revision.snapshot.sourcePurgeAt,
        input.source_party_id
      );
    for (const row of revision.snapshot.sourceChannels)
      restoreChannel(ctx, row);
    ctx.db
      .prepare(
        "UPDATE people_merge SET undone_at = ? WHERE source_party_id = ? AND undone_at IS NULL"
      )
      .run(ctx.now, input.source_party_id);
    markEntityRevisionUndone(ctx, revision.revisionId);
    ctx.wrote("people.profile", input.source_party_id);
    ctx.wrote("people.merge", input.source_party_id);
    return { source_party_id: input.source_party_id };
  },
};

export function registerPeopleOrganizeCommands(gateway: Gateway): void {
  gateway.registerCommand(SAVE_CHANNEL);
  gateway.registerCommand(DELETE_CHANNEL);
  gateway.registerCommand(UNDO_CHANNEL);
  gateway.registerCommand(MERGE_PEOPLE);
  gateway.registerCommand(UNDO_MERGE);
}
