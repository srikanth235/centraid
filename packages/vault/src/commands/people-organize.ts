// governance: allow-repo-hygiene file-size-limit one cohesive People channel command contract whose validation, normalization, revision snapshots, and registration must stay reviewable together
// Issue #630 People organization contract: normalized contact channels and
// duplicate warnings. Party identity merge is NOT forked here — folding a
// duplicate person is `core.merge_party` (issue #290), the single ontology
// primitive that re-points every FK and deletes the merged party.

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

export function registerPeopleOrganizeCommands(gateway: Gateway): void {
  gateway.registerCommand(SAVE_CHANNEL);
  gateway.registerCommand(DELETE_CHANNEL);
  gateway.registerCommand(UNDO_CHANNEL);
}
